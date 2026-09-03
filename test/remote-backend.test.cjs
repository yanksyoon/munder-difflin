'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const loadTs = require('./load-ts.cjs');
const { PROTOCOL_VERSION } = loadTs('src/shared/remoteProtocol.ts');
const { RemoteBackend } = loadTs('src/main/remoteBackend.ts');

function fakeTransport() {
  const transport = new EventEmitter();
  transport.requests = [];
  transport.connected = false;
  transport.closed = false;
  transport.connect = async () => {
    transport.connected = true;
    return { payload: { protocol: PROTOCOL_VERSION, capabilities: ['list', 'start', 'attach', 'input', 'resize', 'signal', 'close', 'snapshot'] } };
  };
  transport.request = async (op, payload, sessionId) => {
    transport.requests.push({ op, payload, sessionId });
    if (op === 'list') {
      return { protocol: PROTOCOL_VERSION, type: 'response', requestId: 'r', op: 'list', payload: { sessions: [] } };
    }
    if (op === 'start') {
      const id = payload.sessionId || 's1';
      return { protocol: PROTOCOL_VERSION, type: 'response', requestId: 'r', sessionId: id, op: 'start', payload: { session: { id, cwd: payload.cwd, command: payload.command, pid: 42, seq: 0 } } };
    }
    return { protocol: PROTOCOL_VERSION, type: 'response', requestId: 'r', sessionId, op, payload: {} };
  };
  transport.close = () => { transport.closed = true; };
  transport.onEvent = (cb) => { transport.eventCb = cb; return () => {}; };
  transport.onClose = (cb) => { transport.closeCb = cb; return () => {}; };
  return transport;
}

test('RemoteBackend maps sessions to logical ids and replays snapshot', async () => {
  const outputs = [];
  const exits = [];
  const rawEvents = [];
  const transport = fakeTransport();
  const backend = new RemoteBackend({
    host: 'work', helperPath: '/opt/munder/remote-helper.js',
    transport, handlers: {
      onRawEvent: (message) => rawEvents.push(message.op),
      onOutput: (id, text) => outputs.push([id, text]),
      onExit: (id, code) => exits.push([id, code])
    }
  });
  await backend.connect();
  assert.ok(backend.connected());
  assert.deepEqual(transport.requests[0].op, 'list');

  const { logicalId, session } = await backend.startSession({ cwd: '/home/ubuntu', command: 'printf', args: ['hi'] });
  assert.equal(logicalId, 'remote:s1');
  assert.equal(session.command, 'printf');
  assert.deepEqual(backend.sessionsList().map((s) => s.id), ['s1']);

  transport.eventCb({ protocol: PROTOCOL_VERSION, type: 'event', sessionId: 's1', seq: 0, op: 'output', payload: { data: Buffer.from('héllo').toString('base64') } });
  assert.deepEqual(outputs, [['remote:s1', 'héllo']]);
  assert.deepEqual(rawEvents, ['output']);

  await backend.snapshot('s1', 0);
  assert.deepEqual(transport.requests[transport.requests.length - 1], { op: 'snapshot', payload: { sinceSeq: 0 }, sessionId: 's1' });

  transport.eventCb({ protocol: PROTOCOL_VERSION, type: 'event', sessionId: 's1', seq: 1, op: 'exit', payload: { exitCode: 0 } });
  assert.deepEqual(exits, [['remote:s1', 0]]);
  assert.deepEqual(backend.sessionsList(), []);

  await backend.fsList('.');
  assert.deepEqual(transport.requests[transport.requests.length - 1], { op: 'fs_list', payload: { path: '.' }, sessionId: undefined });
  await backend.gitLog();
  assert.deepEqual(transport.requests[transport.requests.length - 1], { op: 'git_log', payload: {}, sessionId: undefined });

  backend.disconnect();
  assert.equal(transport.closed, true);
});

test('RemoteBackend rejects malformed helper sessions', async () => {
  const transport = fakeTransport();
  transport.request = async (op, payload) => {
    if (op === 'list') return { protocol: PROTOCOL_VERSION, type: 'response', requestId: 'r', op: 'list', payload: { sessions: [{ id: 'ok', cwd: '/x', command: 'claude', pid: 1, seq: 0 }, { id: 'bad' }] } };
    if (op === 'start') return { protocol: PROTOCOL_VERSION, type: 'response', requestId: 'r', op: 'start', payload: { session: { id: 'bad' } } };
    return { protocol: PROTOCOL_VERSION, type: 'response', requestId: 'r', op, payload: {} };
  };
  const backend = new RemoteBackend({ host: 'work', helperPath: '/opt/munder/remote-helper.js', transport });
  await backend.connect();
  assert.deepEqual(backend.sessionsList().map((s) => s.id), ['ok']);
  await assert.rejects(backend.startSession({ cwd: '/x', command: 'claude' }), /invalid session/);
});
