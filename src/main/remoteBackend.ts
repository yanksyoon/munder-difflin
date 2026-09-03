import { SshRemoteTransport, type SshRemoteOptions } from './sshRemote';
import type { RemoteMessage } from '../shared/remoteProtocol';

export interface RemoteSessionInfo {
  id: string;
  cwd: string;
  command: string;
  pid: number;
  seq: number;
}

export function isRemoteSessionInfo(value: unknown): value is RemoteSessionInfo {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<RemoteSessionInfo>;
  return typeof session.id === 'string' && session.id.length > 0
    && typeof session.cwd === 'string'
    && typeof session.command === 'string'
    && typeof session.pid === 'number'
    && typeof session.seq === 'number';
}

export interface RemoteBackendHandlers {
  /** Decoded PTY output for a logical session id (`remote:<sessionId>`). */
  onOutput?: (logicalId: string, text: string) => void;
  onExit?: (logicalId: string, exitCode: number, signal?: number) => void;
  /** Every raw helper event (output, exit, hook_event) before per-kind routing. */
  onRawEvent?: (message: RemoteMessage) => void;
  onHookEvent?: (message: RemoteMessage) => void;
  onStatus?: (connected: boolean, error?: string) => void;
}

export interface RemoteBackendOptions extends SshRemoteOptions {
  handlers?: RemoteBackendHandlers;
  /** Test seam: inject a transport instead of constructing one. */
  transport?: SshRemoteTransport;
}

/**
 * Session registry + terminal adapter for the SSH remote helper.
 *
 * Remote sessions live only in the helper; this backend gives them stable
 * logical ids (`remote:<sessionId>`) so the existing terminal subscription
 * model can consume their bytes without pretending they are local PTYs.
 * Remote state is deliberately kept out of `PtyManager` and `pty:list`.
 */
export class RemoteBackend {
  private readonly transport: SshRemoteTransport;
  private readonly handlers: RemoteBackendHandlers;
  private readonly sessions = new Map<string, RemoteSessionInfo>();
  private readonly closeHandlers = new Set<() => void>();
  private connectedFlag = false;

  constructor(options: RemoteBackendOptions) {
    this.transport = options.transport ?? new SshRemoteTransport(options);
    this.handlers = options.handlers ?? {};
    this.transport.onEvent((message) => this.onEvent(message));
    this.transport.onClose((error) => {
      this.connectedFlag = false;
      this.sessions.clear();
      this.handlers.onStatus?.(false, error?.message);
    });
  }

  static logicalId(sessionId: string): string {
    return `remote:${sessionId}`;
  }

  static rawSessionId(logicalId: string): string {
    return logicalId.startsWith('remote:') ? logicalId.slice('remote:'.length) : logicalId;
  }

  connected(): boolean {
    return this.connectedFlag;
  }

  sessionsList(): RemoteSessionInfo[] {
    return [...this.sessions.values()];
  }

  async connect(): Promise<unknown> {
    const hello = await this.transport.connect();
    this.connectedFlag = true;
    await this.refresh();
    return hello.payload;
  }

  disconnect(): void {
    this.connectedFlag = false;
    this.transport.close();
  }

  async refresh(): Promise<void> {
    const response = await this.transport.request('list', {});
    const payload = response.payload as { sessions?: RemoteSessionInfo[] } | undefined;
    const listed = Array.isArray(payload?.sessions) ? payload.sessions : [];
    this.sessions.clear();
    for (const session of listed) {
      if (isRemoteSessionInfo(session)) this.sessions.set(RemoteBackend.logicalId(session.id), session);
    }
  }

  async startSession(input: {
    sessionId?: string; cwd: string; command: string; args?: string[]; cols?: number; rows?: number;
  }): Promise<{ logicalId: string; session: RemoteSessionInfo }> {
    const response = await this.transport.request('start', input);
    const payload = response.payload as { session?: unknown } | undefined;
    const session = payload?.session;
    if (!isRemoteSessionInfo(session)) throw new Error('remote start returned an invalid session');
    const logicalId = RemoteBackend.logicalId(session.id);
    this.sessions.set(logicalId, session);
    return { logicalId, session };
  }

  async attach(sessionId: string): Promise<void> {
    const response = await this.transport.request('attach', { sessionId }, sessionId);
    const payload = response.payload as { session?: unknown } | undefined;
    const session = payload?.session;
    if (isRemoteSessionInfo(session)) this.sessions.set(RemoteBackend.logicalId(session.id), session);
  }

  async snapshot(sessionId: string, sinceSeq?: number): Promise<RemoteMessage> {
    return this.transport.request('snapshot', sinceSeq === undefined ? {} : { sinceSeq }, sessionId);
  }

  async write(sessionId: string, data: string): Promise<void> {
    await this.transport.request('input', { data }, sessionId);
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.transport.request('resize', { cols, rows }, sessionId);
  }

  async signal(sessionId: string, signal: string): Promise<void> {
    await this.transport.request('signal', { signal }, sessionId);
  }

  async close(sessionId: string): Promise<void> {
    await this.transport.request('close', {}, sessionId);
    this.sessions.delete(RemoteBackend.logicalId(sessionId));
  }

  private onEvent(message: RemoteMessage): void {
    this.handlers.onRawEvent?.(message);
    if (!message.sessionId) return;
    const logicalId = RemoteBackend.logicalId(message.sessionId);
    if (message.op === 'output') {
      const data = (message.payload as { data?: unknown } | undefined)?.data;
      if (typeof data !== 'string') return;
      try {
        this.handlers.onOutput?.(logicalId, Buffer.from(data, 'base64').toString('utf8'));
      } catch { /* invalid base64 already rejected by transport */ }
      return;
    }
    if (message.op === 'exit') {
      const payload = message.payload as { exitCode?: unknown; signal?: unknown } | undefined;
      this.sessions.delete(logicalId);
      this.handlers.onExit?.(logicalId, typeof payload?.exitCode === 'number' ? payload.exitCode : 0,
        typeof payload?.signal === 'number' ? payload.signal : undefined);
      return;
    }
    this.handlers.onHookEvent?.(message);
  }
}
