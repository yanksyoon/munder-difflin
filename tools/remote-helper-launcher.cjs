#!/usr/bin/env node
'use strict';

const path = require('node:path');

if (!process.env.MUNDER_REMOTE_ROOT) {
  console.error('MUNDER_REMOTE_ROOT is required');
  process.exit(2);
}
if (!process.env.MUNDER_REMOTE_ALLOW_COMMANDS) {
  console.error('MUNDER_REMOTE_ALLOW_COMMANDS is required');
  process.exit(2);
}

const { runRemoteHelper } = require(path.resolve(__dirname, '../out/remote/remote/remoteHelper.js'));
runRemoteHelper();
