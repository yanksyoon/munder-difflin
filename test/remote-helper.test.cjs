'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { FrameDecoder, encodeFrame, PROTOCOL_VERSION } = loadTs('src/shared/remoteProtocol.ts');
const { isSafeRemoteCommand } = loadTs('src/remote/remoteHelper.ts');
const helper = path.resolve(__dirname, '..', 'out/remote/remote/remoteHelper.js');

function waitForMessages(decoder, child, predicates, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const found = new Array(predicates.length);
    const timer = setTimeout(() => reject(new Error('timed out waiting for remote helper message')), timeout);
    const onData = (chunk) => {
      let messages;
      try { messages = decoder.push(chunk); } catch (e) { clearTimeout(timer); reject(e); return; }
      for (const message of messages) {
        for (let i = 0; i < predicates.length; i++) {
          if (!found[i] && predicates[i](message)) { found[i] = message; break; }
        }
      }
      if (found.filter(Boolean).length === predicates.length) { clearTimeout(timer); child.stdout.off('data', onData); resolve(found); }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`remote helper exited before response: ${code}`));
    });
  });
}


test('remote helper starts an allowlisted command and streams output', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-remote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [helper], {
    cwd: root,
    env: { ...process.env, MUNDER_REMOTE_ROOT: root, MUNDER_REMOTE_ALLOW_COMMANDS: 'printf' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGTERM'));
  const decoder = new FrameDecoder();
  const helloWait = waitForMessages(decoder, child, [(m) => m.requestId === 'h1']);
  child.stdin.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'request', requestId: 'h1', op: 'hello', payload: {} }));
  const [hello] = await helloWait;
  assert.equal(hello.op, 'hello_ack');
  assert.deepEqual(hello.payload.capabilities, ['list', 'start', 'attach', 'input', 'resize', 'signal', 'close', 'snapshot']);
  assert.equal(Object.hasOwn(hello.payload, 'root'), false, 'absolute host paths stay out of handshake');

  const sessionWait = waitForMessages(decoder, child, [
    (m) => m.requestId === 's1',
    (m) => m.op === 'output' && m.sessionId === 's1',
    (m) => m.op === 'exit' && m.sessionId === 's1'
  ]);
  child.stdin.write(encodeFrame({
    protocol: PROTOCOL_VERSION, type: 'request', requestId: 's1', op: 'start',
    payload: { sessionId: 's1', cwd: root, command: 'printf', args: ['remote-ok'] }
  }));
  const [started, output, exited] = await sessionWait;
  assert.equal(started.op, 'start');
  assert.equal(started.sessionId, 's1');
  assert.equal(Buffer.from(output.payload.data, 'base64').toString(), 'remote-ok');
  assert.equal(exited.payload.exitCode, 0);

  const snapshotWait = waitForMessages(decoder, child, [(m) => m.requestId === 'snap1']);
  child.stdin.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'request', requestId: 'snap1', op: 'snapshot', sessionId: 's1', payload: { sinceSeq: 0 } }));
  const [snapshot] = await snapshotWait;
  assert.equal(snapshot.op, 'snapshot');
  assert.equal(snapshot.sessionId, 's1');
  const events = snapshot.payload.events;
  assert.ok(Array.isArray(events), 'snapshot must replay buffered events');
  assert.equal(events[0].op, 'output');
  assert.equal(Buffer.from(events[0].payload.data, 'base64').toString(), 'remote-ok');
  assert.equal(events[events.length - 1].op, 'exit');
  assert.equal(snapshot.payload.session, null);
});

test('remote helper refuses shell interpreters even if configured', () => {
  assert.equal(isSafeRemoteCommand('sh', ['sh']), false);
  assert.equal(isSafeRemoteCommand('bash', ['bash']), false);
});

test('remote helper refuses commands and directories outside policy', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-remote-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'md-remote-outside-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const child = spawn(process.execPath, [helper], {
    cwd: root,
    env: { ...process.env, MUNDER_REMOTE_ROOT: root, MUNDER_REMOTE_ALLOW_COMMANDS: 'printf' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill('SIGTERM'));
  const decoder = new FrameDecoder();
  const helloWait = waitForMessages(decoder, child, [(m) => m.requestId === 'h1']);
  child.stdin.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'request', requestId: 'h1', op: 'hello', payload: {} }));
  await helloWait;
  const badCommandWait = waitForMessages(decoder, child, [(m) => m.requestId === 'bad-command']);
  child.stdin.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'request', requestId: 'bad-command', op: 'start', payload: { cwd: root, command: 'bash', args: [] } }));
  const [badCommand] = await badCommandWait;
  assert.equal(badCommand.type, 'response');
  assert.equal(badCommand.op, 'error');
  const badCwdWait = waitForMessages(decoder, child, [(m) => m.requestId === 'bad-cwd']);
  child.stdin.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'request', requestId: 'bad-cwd', op: 'start', payload: { cwd: outside, command: 'printf', args: [] } }));
  const [badCwd] = await badCwdWait;
  assert.equal(badCwd.type, 'response');
  assert.equal(badCwd.op, 'error');

  const sessionErrorWait = waitForMessages(decoder, child, [(m) => m.requestId === 'missing-input']);
  child.stdin.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'request', requestId: 'missing-input', op: 'input', sessionId: 'nope', payload: { data: 'x' } }));
  const [sessionError] = await sessionErrorWait;
  assert.equal(sessionError.op, 'error');
  assert.equal(sessionError.sessionId, 'nope', 'session errors must carry the session id');
});

test('snapshot replay is byte-bounded, never exceeds the frame, and reports eviction gaps', async (t) => {
  const { RemoteHelper } = loadTs('src/remote/remoteHelper.ts');
  const { FrameDecoder, encodeFrame, MAX_FRAME_BYTES } = loadTs('src/shared/remoteProtocol.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-remote-cap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { PassThrough } = require('node:stream');
  const output = new PassThrough();
  output._write = function (chunk, _enc, cb) { this.emit('frame', chunk); cb(); };
  const helper = new RemoteHelper({ root, commands: ['printf'], output, maxBufferedBytes: 16 * 1024, maxSnapshotBytes: 16 * 1024 });
  const frames = [];
  output.on('frame', (chunk) => frames.push(chunk));

  // 40 x 16KiB args = 640KiB of output: reliably multiple PTY events.
  const args = Array(40).fill('x'.repeat(16 * 1024));
  helper.handle({ protocol: PROTOCOL_VERSION, type: 'request', requestId: 'r1', op: 'start', payload: { sessionId: 'cap1', cwd: root, command: 'printf', args } });
  await new Promise((resolve) => setTimeout(resolve, 400));

  helper.handle({ protocol: PROTOCOL_VERSION, type: 'request', requestId: 'snap', op: 'snapshot', sessionId: 'cap1', payload: { sinceSeq: 0 } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const dec = new FrameDecoder();
  let snapshot = null;
  for (const frame of frames) {
    for (const message of dec.push(frame)) {
      if (message.requestId === 'snap') snapshot = message;
    }
  }
  assert.ok(snapshot, 'snapshot response expected');
  assert.equal(snapshot.op, 'snapshot');
  const payload = snapshot.payload;
  assert.ok(Array.isArray(payload.events));
  assert.ok(payload.events.length > 0, 'at least the latest event survives replay');
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') < MAX_FRAME_BYTES, 'snapshot must never exceed the frame cap');
  assert.doesNotThrow(() => encodeFrame(snapshot), 'snapshot must encode without frame-too-large');
  assert.ok(payload.startSeq > 0, `evicted history must surface a startSeq gap, got ${payload.startSeq}`);
  assert.equal(payload.truncated, true, 'evicted history must be flagged truncated');
});
