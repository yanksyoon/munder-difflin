/** Versioned, length-prefixed protocol used by the SSH remote helper. */

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const REQUIRED_REMOTE_CAPABILITIES = ['list', 'start', 'attach', 'input', 'resize', 'signal', 'close', 'snapshot', 'fs_list', 'fs_read', 'git_status', 'git_log'] as const;

export type RemoteMessageType = 'request' | 'response' | 'event';
export type RemoteOperation =
  | 'hello' | 'hello_ack' | 'list' | 'start' | 'attach' | 'input' | 'resize'
  | 'signal' | 'close' | 'snapshot' | 'output' | 'exit' | 'hook_event'
  | 'fs_list' | 'fs_read' | 'git_status' | 'git_log'
  | 'ping' | 'pong' | 'error';

export interface RemoteMessage {
  protocol: number;
  type: RemoteMessageType;
  op: RemoteOperation;
  requestId?: string;
  sessionId?: string;
  seq?: number;
  payload?: unknown;
}

const SESSION_REQUESTS = new Set<RemoteOperation>(['attach', 'input', 'resize', 'signal', 'close', 'snapshot']);
const SESSION_RESPONSES = new Set<RemoteOperation>(['start', 'attach', 'input', 'resize', 'signal', 'close', 'snapshot', 'error']);
const EVENT_OPS = new Set<RemoteOperation>(['output', 'exit', 'hook_event']);

const OPERATIONS = new Set<RemoteOperation>([
  'hello', 'hello_ack', 'list', 'start', 'attach', 'input', 'resize',
  'signal', 'close', 'snapshot', 'output', 'exit', 'hook_event',
  'fs_list', 'fs_read', 'git_status', 'git_log',
  'ping', 'pong', 'error'
]);

export class RemoteProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteProtocolError';
  }
}

export function isRemoteMessage(value: unknown): value is RemoteMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<RemoteMessage>;
  if (message.protocol !== PROTOCOL_VERSION
    || (message.type !== 'request' && message.type !== 'response' && message.type !== 'event')
    || typeof message.op !== 'string'
    || !OPERATIONS.has(message.op as RemoteOperation)) return false;
  if (message.requestId !== undefined && (typeof message.requestId !== 'string' || !message.requestId)) return false;
  if (message.sessionId !== undefined && (typeof message.sessionId !== 'string' || !message.sessionId)) return false;
  if (message.seq !== undefined && (!Number.isSafeInteger(message.seq) || message.seq < 0)) return false;
  // Correlation and stream identity are mandatory at the protocol boundary.
  if ((message.type === 'request' || message.type === 'response') && !message.requestId) return false;
  if (message.type === 'request' && message.sessionId !== undefined && !SESSION_REQUESTS.has(message.op as RemoteOperation)) return false;
  if (message.type === 'response' && message.sessionId !== undefined && !SESSION_RESPONSES.has(message.op as RemoteOperation)) return false;
  if (message.type === 'event') {
    if (!EVENT_OPS.has(message.op as RemoteOperation)) return false;
    if (!message.sessionId || message.seq === undefined) return false;
  }
  return true;
}

export function encodeFrame(message: RemoteMessage): Buffer {
  if (!isRemoteMessage(message)) throw new RemoteProtocolError('invalid message');
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw new RemoteProtocolError('frame too large');
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

/** Accumulates arbitrary stream chunks and returns complete protocol messages. */
export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): RemoteMessage[] {
    if (chunk.length === 0) return [];
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages: RemoteMessage[] = [];
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) throw new RemoteProtocolError('frame too large');
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let value: unknown;
      try { value = JSON.parse(body.toString('utf8')); }
      catch { throw new RemoteProtocolError('invalid JSON'); }
      if (!isRemoteMessage(value)) throw new RemoteProtocolError('invalid message');
      messages.push(value);
    }
    if (this.buffer.length > MAX_FRAME_BYTES + 4) throw new RemoteProtocolError('frame too large');
    return messages;
  }
}
