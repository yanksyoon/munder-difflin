# Remote setup: Mac UI and SSH development host

## Current scope

This fork adds the first remote transport slice:

- `src/shared/remoteProtocol.ts` defines a versioned, length-prefixed protocol.
- `src/remote/remoteHelper.ts` runs allowlisted remote PTYs over stdin/stdout.
- `src/main/sshRemote.ts` starts the helper through OpenSSH and correlates requests.
- `remote:*` Electron IPC methods expose connect, list, start, attach, input, resize,
  signal, close, and event/status delivery without changing local `pty:*` behavior.

This slice is intentionally not a public web dashboard. It does not expose a TCP port,
move secrets to the Mac, or merge remote sessions into the existing local floor/hive
reconciliation yet. The next integration step is to make the renderer's terminal/floor
consume the remote backend without treating remote paths as local paths.

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
