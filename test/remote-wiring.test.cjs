'use strict';

const test = require('node:test');
const loadTs = require('./load-ts.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('remote transport is reachable only through explicit main/preload seams', () => {
  const main = read('src/main/index.ts');
  const preload = read('src/preload/index.ts');
  for (const op of ['connect', 'disconnect', 'list', 'refresh', 'start', 'attach', 'snapshot', 'input', 'resize', 'signal', 'close', 'fsList', 'fsRead', 'gitStatus', 'gitLog']) {
    assert.match(main, new RegExp(`remote:${op}`), `main missing remote:${op}`);
    assert.match(preload, new RegExp(`remote${op[0].toUpperCase()}${op.slice(1)}`), `preload missing remote${op}`);
  }
  assert.match(main, /new RemoteBackend/);
  assert.match(main, /pty:data:\$\{logicalId\}/);
  assert.doesNotMatch(main, /ptyManager\.spawn\(.*remote/i);
});

test('prime-agent is a recognized provider and an allowed remote command', () => {
  const { inferAgentProvider, providerPreset, isAgentProvider, AGENT_PROVIDER_PRESETS } = loadTs('src/shared/agentProvider.ts');
  assert.equal(isAgentProvider('prime-agent'), true);
  assert.equal(inferAgentProvider('prime-agent --model x'), 'prime-agent');
  assert.equal(providerPreset('prime-agent').defaultCommand, 'prime-agent');
  assert.ok(AGENT_PROVIDER_PRESETS.some((p) => p.id === 'prime-agent'));
});


test('the Mac setup script validates the alias and transports remote values safely', () => {
  const setup = read('tools/mac-remote-setup.sh');
  assert.match(setup, /alias_re='\^\[A-Za-z0-9\]\[A-Za-z0-9._:@-\]\*\$'/);
  assert.match(setup, /Invalid SSH alias/);
  assert.match(setup, /Invalid \$v=/, 'remote override validation uses a per-variable die');
  assert.match(setup, /ssh -o BatchMode=yes -o ConnectTimeout=10 -T --/, 'ssh options are terminated with --');
  assert.match(setup, /base64 -d/, 'payload is decoded remotely');
  assert.doesNotMatch(setup, /bash -c \$QUOTED/, 'remote script is not passed via bash -c \$QUOTED');
  assert.match(setup, /\| base64 -d \| bash/, 'remote command is the fixed POSIX pipe');
  assert.match(setup, /REMOTE_B64=/, 'script is base64-encoded');
  assert.match(setup, /__REMOTE_DIR__/, 'placeholders are substituted into the script');
  assert.match(setup, /printf 'export MUNDER_REMOTE_ROOT=%q/, 'wrapper is written with printf %q (decoded values, quoted)');
  assert.doesNotMatch(setup, /QUOTED_SCRIPT/, 'no %q-quoted bash -c form remains');
  assert.doesNotMatch(setup, /ssh -[^ ]* "\$ALIAS"/, 'alias is never passed as an option');
});

test('the Mac setup script rejects unsafe remote HOME and derived paths', () => {
  const setup = read('tools/mac-remote-setup.sh');
  assert.match(setup, /Unsafe remote HOME/);
  assert.match(setup, /case "\$REMOTE_HOME" in/, 'remote HOME is validated before use');
  assert.match(setup, /Unsafe MD_REMOTE_DIR/);
  assert.match(setup, /Unsafe MD_REMOTE_ROOT/);
  assert.doesNotMatch(setup, /REMOTE_HOME=.*unquoted/, '');
});

test('remote setup documents the actual SSH and host bootstrap contract', () => {
  const docs = read('docs/remote-setup.md');
  assert.match(docs, /npm rebuild node-pty/);
  assert.match(docs, /MUNDER_REMOTE_ROOT/);
  assert.match(docs, /MUNDER_REMOTE_ALLOW_COMMANDS/);
  assert.match(docs, /StrictHostKeyChecking=no/);
  assert.match(docs, /remote-helper-launcher/);
  assert.match(docs, /prime-agent/);
  const setupScript = read('tools/mac-remote-setup.sh');
  assert.match(setupScript, /remote-ui-plan/);
  assert.match(setupScript, /prime-agent/);
  assert.match(setupScript, /npm run dev/);
});
