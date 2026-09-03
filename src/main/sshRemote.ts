import { spawn as spawnProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isAbsolute } from 'node:path';
import {
  FrameDecoder, encodeFrame, PROTOCOL_VERSION, REQUIRED_REMOTE_CAPABILITIES, RemoteProtocolError,
  type RemoteMessage, type RemoteOperation
} from '../shared/remoteProtocol';

type RemoteChild = EventEmitter & {
  stdin: { write(data: Buffer): boolean; end(): void };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill(signal?: NodeJS.Signals | number): boolean;
};
type SpawnRemoteProcess = (file: string, args: string[], options: {
  stdio: ['pipe', 'pipe', 'pipe']; windowsHide: boolean;
}) => RemoteChild;

export interface SshRemoteOptions {
  host: string;
  helperPath: string;
  requestTimeoutMs?: number;
  spawn?: SpawnRemoteProcess;
}

export interface RemoteEventHandler {
  (message: RemoteMessage): void;
}

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const HELPER_RE = /^\/[A-Za-z0-9._/+-]+$/;

function validateOptions(options: SshRemoteOptions): void {
  if (!HOST_RE.test(options.host)) throw new Error('invalid SSH host alias');
  if (!isAbsolute(options.helperPath) || !HELPER_RE.test(options.helperPath)) {
    throw new Error('invalid remote helper path');
  }
}

export class SshRemoteTransport {
  private child: RemoteChild | null = null;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<string, { op: string; resolve: (message: RemoteMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly events = new Set<RemoteEventHandler>();
  private readonly closeEvents = new Set<(error?: Error) => void>();
  private nextRequest = 0;
  private closed = false;

  constructor(private readonly options: SshRemoteOptions) {
    validateOptions(options);
  }

  connect(): Promise<RemoteMessage> {
    if (this.child) return Promise.reject(new Error('SSH transport is already connected'));
    this.closed = false;
    const spawn = this.options.spawn ?? ((file, args, spawnOptions) => spawnProcess(file, args, spawnOptions) as unknown as RemoteChild);
    let child: RemoteChild;
    try {
      child = spawn('ssh', ['-T', this.options.host, '--', this.options.helperPath, '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const message of this.decoder.push(chunk)) this.receive(message);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on('data', () => { /* stderr is intentionally not protocol data */ });
    child.once('error', (error: Error) => this.fail(error));
    child.once('close', (code: number | null, signal?: NodeJS.Signals) => {
      const error = this.closed ? undefined : new Error(`SSH remote helper exited (${code ?? signal ?? 'unknown'})`);
      this.child = null;
      this.failPending(error ?? new Error('SSH transport closed'));
      for (const callback of this.closeEvents) callback(error);
    });
    return this.request('hello', {}).then((hello) => {
      const payload = hello.payload as { protocol?: unknown; capabilities?: unknown } | undefined;
      const capabilities = Array.isArray(payload?.capabilities) ? payload.capabilities : [];
      if (hello.op !== 'hello_ack' || payload?.protocol !== PROTOCOL_VERSION
        || !REQUIRED_REMOTE_CAPABILITIES.every((capability) => capabilities.includes(capability))) {
        throw new Error('remote helper protocol/capability mismatch');
      }
      return hello;
    }).catch((error) => {
      this.close();
      throw error;
    });
  }

  request(op: Exclude<RemoteOperation, 'hello_ack' | 'output' | 'exit' | 'hook_event' | 'error'>, payload: unknown, sessionId?: string): Promise<RemoteMessage> {
    const child = this.child;
    if (!child || this.closed) return Promise.reject(new Error('SSH transport is not connected'));
    const requestId = `r-${++this.nextRequest}-${randomUUID()}`;
    const message: RemoteMessage = { protocol: PROTOCOL_VERSION, type: 'request', requestId, sessionId, op, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(`remote request timed out: ${op}`);
        // A timed-out request means the stream is no longer trustworthy. Abort
        // it rather than allowing a stalled SSH child and an unbounded queue to
        // survive behind the UI.
        this.close();
        reject(error);
      }, this.options.requestTimeoutMs ?? 15_000);
      // Register before writing: a peer can answer synchronously in the same
      // event-loop turn (and a real helper can be faster than the next tick).
      this.pending.set(requestId, { op, resolve, reject, timer });
      try {
        if (!child.stdin.write(encodeFrame(message))) throw new Error('SSH stdin backpressure');
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onEvent(callback: RemoteEventHandler): () => void {
    this.events.add(callback);
    return () => this.events.delete(callback);
  }

  onClose(callback: (error?: Error) => void): () => void {
    this.closeEvents.add(callback);
    return () => this.closeEvents.delete(callback);
  }

  close(): void {
    const child = this.child;
    this.closed = true;
    this.child = null;
    this.failPending(new Error('SSH transport closed'));
    if (!child) return;
    try { child.stdin.end(); } catch { /* already closed */ }
    try { child.kill(); } catch { /* already closed */ }
  }

  private receive(message: RemoteMessage): void {
    if (message.type === 'response') {
      const id = message.requestId;
      if (!id) return;
      const item = this.pending.get(id);
      if (!item) return;
      this.pending.delete(id);
      clearTimeout(item.timer);
      if (message.op === 'error') {
        const payload = message.payload as { message?: unknown } | undefined;
        item.reject(new Error(typeof payload?.message === 'string' ? payload.message : 'remote request failed'));
      } else {
        const expected = item.op === 'hello' ? 'hello_ack' : item.op === 'ping' ? 'pong' : item.op;
        if (message.op !== expected) item.reject(new Error(`unexpected remote response: ${message.op}`));
        else item.resolve(message);
      }
      return;
    }
    for (const callback of this.events) callback(message);
  }

  private fail(error: Error): void {
    this.failPending(error);
    try { this.child?.kill(); } catch { /* already closed */ }
  }

  private failPending(error: Error): void {
    for (const [, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
}

export { RemoteProtocolError };
