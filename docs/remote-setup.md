# Remote setup: Mac UI and SSH development host

## Current scope

This fork adds the SSH remote agent transport plus the Phase 3 session plane:

- `src/shared/remoteProtocol.ts` defines a versioned, length-prefixed protocol.
- `src/remote/remoteHelper.ts` runs allowlisted remote PTYs over stdin/stdout and keeps a
  bounded per-session event buffer for replay.
- `src/main/sshRemote.ts` starts the helper through OpenSSH, correlates requests, validates
  responses/events, and pings a heartbeat so a stalled helper is detected.
- `src/main/remoteBackend.ts` is the session registry + terminal adapter: it maps helper
  sessions to logical ids (`remote:<sessionId>`), validates session metadata, and forwards
  every raw event plus decoded output/exit into the existing terminal channels so the
  renderer can consume remote streams without touching local `pty:*`/restore state.
- `remote:*` Electron IPC methods expose connect, disconnect, list, refresh, start, attach,
  snapshot (replay), input, resize, signal, close, and event/status delivery without
  changing local `pty:*` behavior.
- The Settings → Connections panel adds Reconnect, Reload sessions, and Replay; after a
  reconnect it restores the helper's live sessions and replays their buffered output,
  deduplicated by event sequence so live bytes are never appended twice.
- The helper's per-session replay buffer is byte-bounded (1 MiB default) and snapshots are
  byte-bounded too, so a long-running session can never build a replay response that blows
  the protocol frame limit. Evicted history surfaces a `startSeq` gap and a `truncated`
  flag instead of silently returning nothing.
- The Mac connection runs a 30-second heartbeat ping; a helper that stops answering is
  closed and surfaces a disconnect instead of hanging silently.

This slice is intentionally not a public web dashboard. It does not expose a TCP port or
move secrets to the Mac. Remote agents are not yet merged into the local floor/hive
roster reconciliation; that remains the next phase.

## Architecture

```text
Mac Electron main
  ssh -T <host> -- <fixed-helper-path> --stdio
        | length-prefixed frames over SSH stdin/stdout
        v
work host: remote-helper
  node-pty -> Claude/Codex/etc.
```

SSH provides encryption and authentication. The helper owns the PTY and provider process.
PTY output is base64 inside framed messages. Helper diagnostics go to stderr and never
share the protocol stream.

## Install the remote helper on `work`

Run these commands on the development host. Choose a directory approved for your work
instance; the example uses `/home/ubuntu/munder-difflin`.

```bash
cd /home/ubuntu
git clone https://github.com/yanksyoon/munder-difflin.git munder-difflin
cd /home/ubuntu/munder-difflin
git checkout remote-ui-plan
npm ci --ignore-scripts
npm rebuild node-pty
npm run build:remote
```

`npm rebuild node-pty` is required on the host where the helper runs. The Mac Electron
native module must not be copied to Linux. Verify the helper artifact:

```bash
export MUNDER_REMOTE_ROOT=/home/ubuntu
export MUNDER_REMOTE_ALLOW_COMMANDS=claude,codex,gemini,opencode,crush,pi
node tools/remote-helper-launcher.cjs < /dev/null
```

The last command exits cleanly because stdin is at EOF; it is only an artifact check.
Use `npm run test:remote` for the framed handshake and PTY smoke test. The two
environment variables are mandatory. `MUNDER_REMOTE_ROOT` is an admission policy
for project directories, not a race-resistant OS sandbox: use a least-privilege remote
account and a container/chroot if the remote host is shared or untrusted. Provider argv
is still provider-specific input, so use only the provider commands and arguments you
trust on that host.
`MUNDER_REMOTE_ALLOW_COMMANDS` is the explicit provider executable allowlist. Shell
interpreters (`sh`, `bash`, `zsh`, `dash`, `fish`, and `ksh`) are rejected even if added
to the allowlist. Do not add a shell as a workaround.

For a stable SSH command, create a root-owned or otherwise protected wrapper that sets
those variables and runs the launcher. For example, `/home/ubuntu/bin/munder-remote`:

```sh
#!/bin/sh
set -eu
export MUNDER_REMOTE_ROOT=/home/ubuntu
export MUNDER_REMOTE_ALLOW_COMMANDS=claude,codex,gemini,opencode,crush,pi
exec /usr/bin/node /home/ubuntu/munder-difflin/tools/remote-helper-launcher.cjs
```

Make it executable and ensure the path is readable/executable only by the intended SSH
user where practical:

```bash
chmod 700 /home/ubuntu/bin/munder-remote
```

The helper path must be absolute and contain no shell metacharacters or spaces for the
current SSH transport validation.

## Mac setup

1. Install the signed macOS build from the fork's release page when a remote-capable
   release is published, or build the app from this branch with `npm ci` and `npm run dist:mac`.
2. Ensure the Mac can connect to the work host with normal OpenSSH configuration:

   ```bash
   ssh -T work true
   ```

   Keep normal host-key verification enabled. Do not use `StrictHostKeyChecking=no`.
3. Configure the app's remote target with:
   - SSH host alias: `work`
   - helper path: `/home/ubuntu/bin/munder-remote`
4. Connect and confirm the hello response reports the expected protocol and capabilities.
5. Start a remote provider only from a project directory under `MUNDER_REMOTE_ROOT`.

The Mac does not need the provider CLI or provider credentials for a remote session. Those
stay on `work`. The Mac does need its normal SSH key/agent access. SSH agent forwarding is
not required and should remain disabled.

## Manual protocol smoke test

The helper is a framed stdio service, not an interactive shell. The repository's remote
focused tests exercise the complete helper lifecycle with a disposable PTY:

```bash
npm run test:remote
```

For an actual SSH smoke test, first ensure the Mac SSH alias and wrapper are ready. The
future Electron connection uses this fixed shape (the app constructs it; do not paste
prompts or paths into the SSH command):

```text
ssh -T work -- /home/ubuntu/bin/munder-remote --stdio
```

## Security and lifecycle notes

- Use a least-privilege SSH account and restrict the helper's project root.
- Keep provider credentials and project files on `work`.
- Do not expose the helper on a public TCP socket.
- Do not pass arbitrary shell commands through `remote:start`; commands are executable
  names plus argv and shell executables are rejected.
- Remote `close` terminates the PTY in this first slice. Reconnect/replay/detach semantics
  are not implemented yet.
- Remote state is deliberately separate from local `pty:list` and local hive teardown.
