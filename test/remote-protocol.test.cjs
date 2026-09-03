'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  FrameDecoder,
  encodeFrame,
  isRemoteMessage
} = loadTs('src/shared/remoteProtocol.ts');

test('remote protocol round-trips partial and coalesced frames', () => {
  const first = { protocol: PROTOCOL_VERSION, type: 'request', requestId: 'r1', op: 'hello', payload: {} };
  const second = { protocol: PROTOCOL_VERSION, type: 'event', sessionId: 's1', seq: 2, op: 'output', payload: { data: 'hello' } };
  const bytes = Buffer.concat([encodeFrame(first), encodeFrame(second)]);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(bytes.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(bytes.subarray(3)), [first, second]);
});

test('remote protocol rejects malformed, unknown, and oversized frames', () => {
  const decoder = new FrameDecoder();
  assert.throws(() => decoder.push(Buffer.concat([Buffer.from([0, 0, 0, 5]), Buffer.from('hello')])), /invalid JSON/);
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(MAX_FRAME_BYTES + 1);
  assert.throws(() => decoder.push(oversized), /frame too large/);
  assert.equal(isRemoteMessage({ protocol: PROTOCOL_VERSION, type: 'event', sessionId: 's1', seq: 0, op: 'output' }), true);
  assert.equal(isRemoteMessage({ protocol: 999, type: 'event', op: 'output' }), false);
  assert.equal(isRemoteMessage({ protocol: PROTOCOL_VERSION, type: 'event', op: 'run-shell' }), false);
});
