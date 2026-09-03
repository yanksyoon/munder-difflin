import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import {
  FrameDecoder, encodeFrame, PROTOCOL_VERSION, REQUIRED_REMOTE_CAPABILITIES, type RemoteMessage
} from '../shared/remoteProtocol';

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const BLOCKED_COMMANDS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'env', 'busybox', 'xargs', 'find', 'node', 'npm', 'python', 'python3', 'perl', 'ruby', 'ssh', 'sudo', 'curl', 'wget']);
const MAX_SESSIONS = 16;

export interface RemoteHelperOptions {
  root?: string;
  commands?: string[];
  output?: NodeJS.WritableStream;
}

interface Session {
  id: string;
  cwd: string;
  command: string;
  proc: pty.IPty;
  seq: number;
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
  private readonly sessions = new Map<string, Session>();

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
            this.send({ protocol: PROTOCOL_VERSION, type: 'event', sessionId: id, seq: session.seq++, op: 'output', payload: { data: Buffer.from(chunk).toString('base64') } });
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
        this.send({ protocol: PROTOCOL_VERSION, type: 'event', sessionId: id, seq: session.seq++, op: 'exit', payload: { exitCode, signal } });
      });
      this.send({ protocol: PROTOCOL_VERSION, type: 'response', requestId: request.requestId, sessionId: id, op: 'start', payload: { session: this.sessionInfo(session) } });
    } catch (error) {
      this.send(errorMessage(request, error instanceof Error ? error.message : String(error)));
    }
  }

  stop(): void {
    for (const session of this.sessions.values()) {
      try { session.proc.kill(); } catch { /* already exited */ }
    }
    this.sessions.clear();
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
      for (const message of decoder.push(chunk)) helper.handle(message);
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
