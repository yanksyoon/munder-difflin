import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  FrameDecoder, encodeFrame, PROTOCOL_VERSION, REQUIRED_REMOTE_CAPABILITIES, type RemoteMessage
} from '../shared/remoteProtocol';

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const BLOCKED_COMMANDS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'env', 'busybox', 'xargs', 'find', 'node', 'npm', 'python', 'python3', 'perl', 'ruby', 'ssh', 'sudo', 'curl', 'wget']);
const MAX_SESSIONS = 16;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 1000;
const MAX_BUFFERED_EVENTS = 2048;
const MAX_BUFFERED_SESSIONS = 64;

export interface RemoteHelperOptions {
  root?: string;
  commands?: string[];
  output?: NodeJS.WritableStream;
  /** Byte cap for a single session's replay buffer (default 1 MiB). */
  maxBufferedBytes?: number;
  /** Byte cap for one snapshot response (default 1 MiB). */
  maxSnapshotBytes?: number;
}

interface Session {
  id: string;
  cwd: string;
  command: string;
  proc: pty.IPty;
  seq: number;
}

interface EventBuffer {
  startSeq: number;
  events: RemoteMessage[];
  bytes: number;
}

function payloadOf(message: RemoteMessage): Record<string, unknown> {
  return message.payload && typeof message.payload === 'object'
    ? message.payload as Record<string, unknown>
    : {};
}

function errorMessage(request: RemoteMessage, message: string): RemoteMessage {
  return {
    protocol: PROTOCOL_VERSION,
    type: 'response',
    requestId: request.requestId,
    sessionId: request.sessionId,
    op: 'error',
    payload: { code: 'invalid_request', message }
  };
}

export function isSafeRemoteCommand(command: unknown, allowed: readonly string[]): command is string {
  return typeof command === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(command)
    && !BLOCKED_COMMANDS.has(command)
    && allowed.includes(command);
}

export function isWithinRemoteRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export class RemoteHelper {
  private readonly root: string;
  private readonly commands: readonly string[];
  private readonly output: NodeJS.WritableStream;
  private readonly maxBufferedBytes: number;
  private readonly maxSnapshotBytes: number;
  private readonly sessions = new Map<string, Session>();
  private readonly buffers = new Map<string, EventBuffer>();
  private stopped = false;

  constructor(options: RemoteHelperOptions = {}) {
    const root = options.root ?? process.env.MUNDER_REMOTE_ROOT;
    if (!root) throw new Error('MUNDER_REMOTE_ROOT is required');
    if (!existsSync(root)) throw new Error('remote root does not exist');
    this.root = realpathSync(root);
    const configuredCommands = options.commands ?? process.env.MUNDER_REMOTE_ALLOW_COMMANDS
      ?.split(',').map((command) => command.trim()).filter(Boolean);
    if (!configuredCommands || configuredCommands.length === 0) throw new Error('MUNDER_REMOTE_ALLOW_COMMANDS is required');
    this.commands = configuredCommands;
    this.output = options.output ?? process.stdout;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? 1024 * 1024;
  }

  private send(message: RemoteMessage): void {
    if (!this.output.write(encodeFrame(message))) {
      this.stop();
      throw new Error('remote output backpressure');
    }
  }

  private respond(request: RemoteMessage, op: RemoteMessage['op'], payload: unknown): void {
    this.send({ protocol: PROTOCOL_VERSION, type: 'response', requestId: request.requestId, sessionId: request.sessionId, op, payload });
  }

  private sessionInfo(session: Session): Record<string, unknown> {
    return { id: session.id, cwd: session.cwd, command: session.command, pid: session.proc.pid, seq: session.seq };
  }

  private recordEvent(sessionId: string, event: RemoteMessage): void {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = { startSeq: event.seq ?? 0, events: [], bytes: 0 };
      this.buffers.set(sessionId, buffer);
    }
    buffer.events.push(event);
    buffer.bytes += Buffer.byteLength(JSON.stringify(event), 'utf8');
    // Bound by count AND bytes so a large-output session cannot balloon memory.
    while ((buffer.events.length > MAX_BUFFERED_EVENTS || buffer.bytes > this.maxBufferedBytes)
      && buffer.events.length > 1) {
      const dropped = buffer.events.shift() as RemoteMessage;
      buffer.bytes -= Buffer.byteLength(JSON.stringify(dropped), 'utf8');
    }
    buffer.startSeq = buffer.events[0]?.seq ?? buffer.startSeq;
    if (this.buffers.size > MAX_BUFFERED_SESSIONS) {
      const oldest = this.buffers.keys().next().value;
      if (oldest !== undefined) this.buffers.delete(oldest);
    }
  }

  private validateCwd(value: unknown): string {
    if (typeof value !== 'string' || !value || !isAbsolute(value)) throw new Error('cwd must be an absolute path');
    if (!existsSync(value)) throw new Error('cwd does not exist');
    const cwd = realpathSync(value);
    if (!isWithinRemoteRoot(this.root, cwd)) throw new Error('cwd is outside the remote root');
    return cwd;
  }

  private validateArgs(value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 64) throw new Error('invalid args');
    return value.map((arg) => {
      if (typeof arg !== 'string' || Buffer.byteLength(arg) > MAX_ARGUMENT_BYTES) throw new Error('invalid arg');
      return arg;
    });
  }

  private validateRelativePath(value: unknown, requireExists = true): { rel: string; abs: string } {
    if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('invalid path');
    const rel = value.startsWith('/') ? value.slice(1) : value;
    const joined = join(this.root, rel);
    if (!isWithinRemoteRoot(this.root, joined)) throw new Error('path escapes remote root');
    // Canonicalize the FULL resolved path so a symlink inside the root cannot
    // redirect the read/git below to a directory outside it.
    const canonical = realpathSync(joined);
    if (!isWithinRemoteRoot(this.root, canonical)) throw new Error('path escapes remote root via symlink');
    if (requireExists && !existsSync(canonical)) throw new Error('path does not exist');
    return { rel, abs: canonical };
  }

  private fsList(request: RemoteMessage): void {
    try {
      const payload = payloadOf(request);
      const dir = typeof payload.path === 'string' && payload.path ? payload.path : '.';
      const { abs } = this.validateRelativePath(dir);
      if (!statSync(abs).isDirectory()) throw new Error('not a directory');
      let listed = readdirSync(abs, { withFileTypes: true })
        .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
        .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
      const truncated = listed.length > MAX_LIST_ENTRIES;
      if (truncated) listed = listed.slice(0, MAX_LIST_ENTRIES);
      this.respond(request, 'fs_list', { path: dir, entries: listed, truncated });
    } catch (error) { this.send(errorMessage(request, error instanceof Error ? error.message : String(error))); }
  }

  private fsRead(request: RemoteMessage): void {
    try {
      const payload = payloadOf(request);
      const path = payload.path;
      if (typeof path !== 'string' || !path) { this.send(errorMessage(request, 'invalid path')); return; }
      const { abs } = this.validateRelativePath(path);
      const fd = openSync(abs, 'r');
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) { this.send(errorMessage(request, 'not a file')); return; }
        // Bounded read: never slurp more than MAX_TEXT_BYTES+1 regardless of what the
        // stat says (the file could have grown between check and read).
        const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
        const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_TEXT_BYTES) { this.send(errorMessage(request, 'file too large')); return; }
        const content = buffer.subarray(0, bytesRead).toString('utf8');
        this.respond(request, 'fs_read', { path, bytes: bytesRead, content });
      } finally {
        closeSync(fd);
      }
    } catch (error) { this.send(errorMessage(request, error instanceof Error ? error.message : String(error))); }
  }

  private gitRun(request: RemoteMessage, op: 'git_status' | 'git_log', cwdRel: string, cwdAbs: string): void {
    try {
      // Read-only, hook-free git: a repository under the root must never be able to
      // execute configured hooks (core.fsmonitor, filters, …) when the user merely
      // browses it. `-c core.fsmonitor=false` disables the fsmonitor hook; the
      // `-c …` pairs below are inert for our fixed subcommands (status/log) but
      // serve as a safety net for any config-extension surface; `--no-optional-locks`
      // stops Git taking advisory locks. Environment is sanitized (no unsafe GIT_*).
      const args = [
        '-c', 'core.fsmonitor=false',
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'filter.lfs.smudge=cat',
        '-c', 'filter.lfs.clean=cat',
        '--no-optional-locks',
        ...(op === 'git_status' ? ['status', '--short', '--branch'] : ['log', '--oneline', '-n', '20'])
      ];
      const gitEnv = { ...process.env };
      delete gitEnv.GIT_DIR;
      delete gitEnv.GIT_WORK_TREE;
      delete gitEnv.GIT_INDEX_FILE;
      delete gitEnv.GIT_EXTERNAL_DIFF;
      delete gitEnv.GIT_OBJECT_DIRECTORY;
      delete gitEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES;
      execFile('git', args, { cwd: cwdAbs, env: gitEnv, timeout: 10_000, maxBuffer: MAX_TEXT_BYTES, windowsHide: true },
        (error, stdout, stderr) => {
          if (this.stopped) return;
          try {
            if (error && error.code !== 1) {
              this.send(errorMessage(request, `git failed: ${(stderr || error.message).slice(0, 2000)}`));
              return;
            }
            this.respond(request, op, { path: cwdRel, output: (stdout + (error ? '\n' + stderr : '')).slice(0, MAX_TEXT_BYTES) });
          } catch (sendError) {
            // Peer disconnected or backpressure while git was finishing; nothing more to do.
          }
        });
    } catch (error) { this.send(errorMessage(request, error instanceof Error ? error.message : String(error))); }
  }

  private git(request: RemoteMessage, op: 'git_status' | 'git_log'): void {
    try {
      const payload = payloadOf(request);
      const dir = typeof payload.path === 'string' && payload.path ? payload.path : '.';
      const { rel, abs } = this.validateRelativePath(dir);
      if (!statSync(abs).isDirectory()) { this.send(errorMessage(request, 'not a directory')); return; }
      this.gitRun(request, op, rel, abs);
    } catch (error) { this.send(errorMessage(request, error instanceof Error ? error.message : String(error))); }
  }

  private start(request: RemoteMessage): void {
    const payload = payloadOf(request);
    const id = typeof payload.sessionId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(payload.sessionId)
      ? payload.sessionId : randomUUID();
    if (this.sessions.has(id)) { this.send(errorMessage(request, 'session already exists')); return; }
    if (this.sessions.size >= MAX_SESSIONS) { this.send(errorMessage(request, 'remote session limit reached')); return; }
    let cwd: string;
    let command: string;
    let args: string[];
    try {
      cwd = this.validateCwd(payload.cwd);
      command = payload.command as string;
      if (!isSafeRemoteCommand(command, this.commands)) throw new Error('command is not allowlisted');
      args = this.validateArgs(payload.args);
      const cols = typeof payload.cols === 'number' && Number.isInteger(payload.cols) ? payload.cols : 100;
      const rows = typeof payload.rows === 'number' && Number.isInteger(payload.rows) ? payload.rows : 30;
      if (cols < 2 || cols > 500 || rows < 1 || rows > 200) throw new Error('invalid terminal size');
      const proc = pty.spawn(command, args, {
        name: 'xterm-256color', cols, rows, cwd,
        env: { ...process.env, TERM: 'xterm-256color' }
      });
      const session: Session = { id, cwd, command, proc, seq: 0 };
      this.sessions.set(id, session);
      proc.onData((data) => {
        if (this.sessions.get(id) !== session) return;
        try {
          // Keep each encoded frame bounded even when a PTY implementation emits a large chunk.
          for (let offset = 0; offset < data.length; offset += 512 * 1024) {
            const chunk = data.slice(offset, offset + 512 * 1024);
            const event: RemoteMessage = { protocol: PROTOCOL_VERSION, type: 'event', sessionId: id, seq: session.seq++, op: 'output', payload: { data: Buffer.from(chunk).toString('base64') } };
            this.recordEvent(id, event);
            this.send(event);
          }
        } catch (error) {
          this.stop();
          process.stderr.write(`[remote-helper] ${error instanceof Error ? error.message : String(error)}\n`);
          process.exitCode = 1;
          try { process.stdin.destroy(); } catch { /* already closed */ }
        }
      });
      proc.onExit(({ exitCode, signal }) => {
        if (this.sessions.get(id) !== session) return;
        this.sessions.delete(id);
        const event: RemoteMessage = { protocol: PROTOCOL_VERSION, type: 'event', sessionId: id, seq: session.seq++, op: 'exit', payload: { exitCode, signal } };
        this.recordEvent(id, event);
        this.send(event);
      });
      this.send({ protocol: PROTOCOL_VERSION, type: 'response', requestId: request.requestId, sessionId: id, op: 'start', payload: { session: this.sessionInfo(session) } });
    } catch (error) {
      this.send(errorMessage(request, error instanceof Error ? error.message : String(error)));
    }
  }

  stop(): void {
    this.stopped = true;
    for (const session of this.sessions.values()) {
      try { session.proc.kill(); } catch { /* already exited */ }
    }
    this.sessions.clear();
    this.buffers.clear();
  }

  handle(request: RemoteMessage): void {
    const payload = payloadOf(request);
    try {
      switch (request.op) {
        case 'hello':
          this.respond(request, 'hello_ack', {
            version: '0.1.0', protocol: PROTOCOL_VERSION,
            capabilities: [...REQUIRED_REMOTE_CAPABILITIES]
          });
          return;
        case 'ping': this.respond(request, 'pong', {}); return;
        case 'list':
          this.respond(request, 'list', { sessions: [...this.sessions.values()].map((session) => this.sessionInfo(session)) });
          return;
        case 'start': this.start(request); return;
        case 'attach': {
          const id = typeof payload.sessionId === 'string' ? payload.sessionId : request.sessionId;
          const session = id ? this.sessions.get(id) : undefined;
          if (!session) { this.send(errorMessage(request, 'session not found')); return; }
          this.respond(request, 'attach', { session: this.sessionInfo(session) });
          return;
        }
        case 'snapshot': {
          const id = typeof payload.sessionId === 'string' ? payload.sessionId : request.sessionId;
          const session = id ? this.sessions.get(id) : undefined;
          const buffer = id ? this.buffers.get(id) : undefined;
          const sinceSeq = typeof payload.sinceSeq === 'number' && Number.isSafeInteger(payload.sinceSeq) && payload.sinceSeq >= 0
            ? payload.sinceSeq : 0;
          const selected = buffer ? buffer.events.filter((event) => (event.seq ?? 0) >= sinceSeq) : [];
          const events: RemoteMessage[] = [];
          let bytes = 0;
          let truncated = !!(buffer && buffer.startSeq > sinceSeq);
          for (const event of selected) {
            const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
            if (bytes + eventBytes > this.maxSnapshotBytes && events.length > 0) { truncated = true; break; }
            events.push(event);
            bytes += eventBytes;
          }
          this.respond(request, 'snapshot', {
            session: session ? this.sessionInfo(session) : null,
            events,
            startSeq: buffer ? buffer.startSeq : sinceSeq,
            truncated
          });
          return;
        }
        case 'input': {
          const session = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
          const data = payload.data;
          if (!session || typeof data !== 'string' || Buffer.byteLength(data) > MAX_INPUT_BYTES) { this.send(errorMessage(request, 'invalid input or session')); return; }
          session.proc.write(data);
          this.respond(request, 'input', {});
          return;
        }
        case 'resize': {
          const session = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
          const cols = payload.cols;
          const rows = payload.rows;
          if (!session || typeof cols !== 'number' || typeof rows !== 'number' || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 200) { this.send(errorMessage(request, 'invalid terminal size or session')); return; }
          session.proc.resize(cols, rows);
          this.respond(request, 'resize', {});
          return;
        }
        case 'signal': {
          const session = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
          const signal = payload.signal;
          if (!session || (signal !== 'SIGINT' && signal !== 'SIGTERM' && signal !== 'SIGHUP')) { this.send(errorMessage(request, 'invalid signal or session')); return; }
          session.proc.kill(signal);
          this.respond(request, 'signal', {});
          return;
        }
        case 'close': {
          const session = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
          if (!session) { this.respond(request, 'close', { alreadyClosed: true }); return; }
          this.sessions.delete(session.id);
          try { session.proc.kill(); } catch { /* already exited */ }
          this.respond(request, 'close', {});
          return;
        }
        case 'fs_list': this.fsList(request); return;
        case 'fs_read': this.fsRead(request); return;
        case 'git_status': this.git(request, 'git_status'); return;
        case 'git_log': this.git(request, 'git_log'); return;
        default: this.send(errorMessage(request, `unsupported operation: ${request.op}`));
      }
    } catch (error) {
      this.send(errorMessage(request, error instanceof Error ? error.message : String(error)));
    }
  }
}

export function runRemoteHelper(): void {
  const helper = new RemoteHelper();
  const decoder = new FrameDecoder();
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      for (const message of decoder.push(chunk)) {
        if (message.type !== 'request') {
          process.stderr.write('[remote-helper] dropped non-request message\n');
          continue;
        }
        helper.handle(message);
      }
    } catch (error) {
      helper.stop();
      process.stderr.write(`[remote-helper] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  });
  process.stdin.on('end', () => helper.stop());
  process.stdin.on('close', () => helper.stop());
}

if (typeof require !== 'undefined' && require.main === module) runRemoteHelper();
