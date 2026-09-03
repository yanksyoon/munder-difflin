'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('remote transport is reachable only through explicit main/preload seams', () => {
  const main = read('src/main/index.ts');
  const preload = read('src/preload/index.ts');
  for (const op of ['connect', 'disconnect', 'list', 'refresh', 'start', 'attach', 'snapshot', 'input', 'resize', 'signal', 'close']) {
    assert.match(main, new RegExp(`remote:${op}`), `main missing remote:${op}`);
    assert.match(preload, new RegExp(`remote${op[0].toUpperCase()}${op.slice(1)}`), `preload missing remote${op}`);
  }
  assert.match(main, /new RemoteBackend/);
  assert.match(main, /pty:data:\$\{logicalId\}/);
  assert.doesNotMatch(main, /ptyManager\.spawn\(.*remote/i);
});

test('remote setup documents the actual SSH and host bootstrap contract', () => {
  const docs = read('docs/remote-setup.md');
  assert.match(docs, /npm rebuild node-pty/);
  assert.match(docs, /MUNDER_REMOTE_ROOT/);
  assert.match(docs, /MUNDER_REMOTE_ALLOW_COMMANDS/);
  assert.match(docs, /StrictHostKeyChecking=no/);
  assert.match(docs, /remote-helper-launcher/);
});
