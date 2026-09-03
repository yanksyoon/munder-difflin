'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const loadTs = require('./load-ts.cjs');
const { FrameDecoder, encodeFrame, PROTOCOL_VERSION } = loadTs('src/shared/remoteProtocol.ts');
const { SshRemoteTransport } = loadTs('src/main/sshRemote.ts');

function fakeChild(onWrite) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { child.emit('close', null); return true; };
  const decoder = new FrameDecoder();
  child.stdin.on('data', (chunk) => { for (const message of decoder.push(chunk)) onWrite(child, message); });
  return child;
}

test('SSH transport uses fixed helper argv and correlates framed requests', async () => {
  let argv;
  const child = fakeChild((proc, message) => {
    assert.equal(message.op, 'hello');
    proc.stdout.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'response', requestId: message.requestId, op: 'hello_ack', payload: { protocol: PROTOCOL_VERSION, capabilities: ['list', 'start', 'attach', 'input', 'resize', 'signal', 'close', 'snapshot', 'fs_list', 'fs_read', 'git_status', 'git_log'] } }));
  });
  const transport = new SshRemoteTransport({
    host: 'work', helperPath: '/opt/munder-difflin/remote-helper.js',
    spawn: (_file, args, options) => { argv = { file: _file, args, options }; return child; }
  });
  const hello = await transport.connect();
  assert.deepEqual(argv, {
    file: 'ssh',
    args: ['-T', 'work', '--', '/opt/munder-difflin/remote-helper.js', '--stdio'],
    options: { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  });
  assert.deepEqual(hello.payload, { protocol: PROTOCOL_VERSION, capabilities: ['list', 'start', 'attach', 'input', 'resize', 'signal', 'close', 'snapshot', 'fs_list', 'fs_read', 'git_status', 'git_log'] });
  transport.close();
});

test('SSH transport rejects unsafe host aliases and helper paths before spawning', () => {
  let calls = 0;
  const spawn = () => { calls++; return fakeChild(() => {}); };
  assert.throws(() => new SshRemoteTransport({ host: 'work; touch /tmp/pwned', helperPath: '/opt/helper', spawn }), /invalid SSH host/);
  assert.throws(() => new SshRemoteTransport({ host: 'work', helperPath: 'helper', spawn }), /invalid remote helper/);
  assert.equal(calls, 0);
});

test('SSH handshake failure terminates the helper process', async () => {
  let killed = false;
  const child = fakeChild(() => {});
  child.kill = () => { killed = true; return true; };
  const transport = new SshRemoteTransport({
    host: 'work', helperPath: '/opt/munder/remote-helper.js', requestTimeoutMs: 10,
    spawn: () => child
  });
  await assert.rejects(transport.connect(), /timed out/);
  assert.equal(killed, true);
});

test('SSH transport rejects a correlated response for the wrong operation', async () => {
  const child = fakeChild((proc, message) => {
    proc.stdout.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'response', requestId: message.requestId, op: message.op === 'hello' ? 'hello_ack' : 'start', payload: message.op === 'hello' ? { protocol: PROTOCOL_VERSION, capabilities: ['list', 'start', 'attach', 'input', 'resize', 'signal', 'close', 'snapshot', 'fs_list', 'fs_read', 'git_status', 'git_log'] } : {} }));
  });
  const transport = new SshRemoteTransport({ host: 'work', helperPath: '/opt/munder/remote-helper.js', spawn: () => child });
  await transport.connect();
  await assert.rejects(transport.request('list', {}), /unexpected remote response/);
  transport.close();
});

test('SSH transport rejects a helper with an incompatible handshake', async () => {
  const child = fakeChild((proc, message) => {
    proc.stdout.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'response', requestId: message.requestId, op: 'hello_ack', payload: { protocol: 999, capabilities: [] } }));
  });
  const transport = new SshRemoteTransport({ host: 'work', helperPath: '/opt/munder/remote-helper.js', spawn: () => child });
  await assert.rejects(transport.connect(), /protocol\/capability mismatch/);
});

test('SSH transport rejects a correlated response for the wrong session', async () => {
  const child = fakeChild((proc, message) => {
    const payload = message.op === 'hello'
      ? { protocol: PROTOCOL_VERSION, capabilities: ['list', 'start', 'attach', 'input', 'resize', 'signal', 'close', 'snapshot', 'fs_list', 'fs_read', 'git_status', 'git_log'] }
      : {};
    proc.stdout.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'response', requestId: message.requestId, sessionId: message.op === 'hello' ? undefined : 'other', op: message.op === 'hello' ? 'hello_ack' : message.op, payload }));
  });
  const transport = new SshRemoteTransport({ host: 'work', helperPath: '/opt/munder/remote-helper.js', spawn: () => child });
  await transport.connect();
  await assert.rejects(transport.request('input', { data: 'x' }, 's1'), /unexpected remote session/);
  transport.close();
});

test('SSH transport heartbeat closes a stalled helper', async () => {
  let closed = false;
  const responder = fakeChild((proc, message) => {
    if (message.op === 'hello') {
      proc.stdout.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'response', requestId: message.requestId, op: 'hello_ack', payload: { protocol: PROTOCOL_VERSION, capabilities: ['list', 'start', 'attach', 'input', 'resize', 'signal', 'close', 'snapshot', 'fs_list', 'fs_read', 'git_status', 'git_log'] } }));
    }
    // ping is deliberately not answered -> request timeout -> transport.close()
  });
  const transport = new SshRemoteTransport({
    host: 'work', helperPath: '/opt/munder/remote-helper.js', requestTimeoutMs: 15, heartbeatMs: 20,
    spawn: () => responder
  });
  transport.onClose(() => { closed = true; });
  await transport.connect();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(closed, true);
});
