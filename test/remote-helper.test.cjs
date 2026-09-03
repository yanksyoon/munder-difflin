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

function waitForMessage(decoder, child, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for remote helper message')), timeout);
    const onData = (chunk) => {
      let messages;
      try { messages = decoder.push(chunk); } catch (e) { clearTimeout(timer); reject(e); return; }
      const found = messages.find(predicate);
      if (found) { clearTimeout(timer); child.stdout.off('data', onData); resolve(found); }
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
  child.stdin.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'request', requestId: 'h1', op: 'hello', payload: {} }));
  const hello = await waitForMessage(decoder, child, (m) => m.requestId === 'h1');
  assert.equal(hello.op, 'hello_ack');
  assert.deepEqual(hello.payload.capabilities, ['list', 'start', 'attach', 'input', 'resize', 'signal', 'close']);
  assert.equal(Object.hasOwn(hello.payload, 'root'), false, 'absolute host paths stay out of handshake');

  child.stdin.write(encodeFrame({
    protocol: PROTOCOL_VERSION, type: 'request', requestId: 's1', op: 'start',
    payload: { sessionId: 's1', cwd: root, command: 'printf', args: ['remote-ok'] }
  }));
  const started = await waitForMessage(decoder, child, (m) => m.requestId === 's1');
  assert.equal(started.op, 'start');
  assert.equal(started.sessionId, 's1');
  const output = await waitForMessage(decoder, child, (m) => m.op === 'output' && m.sessionId === 's1');
  assert.equal(Buffer.from(output.payload.data, 'base64').toString(), 'remote-ok');
  const exited = await waitForMessage(decoder, child, (m) => m.op === 'exit' && m.sessionId === 's1');
  assert.equal(exited.payload.exitCode, 0);
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
  child.stdin.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'request', requestId: 'h1', op: 'hello', payload: {} }));
  await waitForMessage(decoder, child, (m) => m.requestId === 'h1');
  child.stdin.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'request', requestId: 'bad-command', op: 'start', payload: { cwd: root, command: 'bash', args: [] } }));
  const badCommand = await waitForMessage(decoder, child, (m) => m.requestId === 'bad-command');
  assert.equal(badCommand.type, 'response');
  assert.equal(badCommand.op, 'error');
  child.stdin.write(encodeFrame({ protocol: PROTOCOL_VERSION, type: 'request', requestId: 'bad-cwd', op: 'start', payload: { cwd: outside, command: 'printf', args: [] } }));
  const badCwd = await waitForMessage(decoder, child, (m) => m.requestId === 'bad-cwd');
  assert.equal(badCwd.type, 'response');
  assert.equal(badCwd.op, 'error');
});
