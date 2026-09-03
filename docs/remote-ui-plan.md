# Remote Mac UI to SSH development host

## Status

This is a design and implementation plan for running the Munder Difflin Electron UI on a
Mac while the agent PTYs and hive run on a remote development host reached through SSH.
It is intentionally separate from the upstream repository's local-only MVP.

## Implemented first slice

The `remote-ui-plan` branch now contains the first tested vertical slice:

- `src/shared/remoteProtocol.ts`: versioned 4-byte length-prefixed JSON frames with
  partial/coalesced input handling and envelope validation.
- `src/remote/remoteHelper.ts`: a stdio helper that owns bounded `node-pty` sessions,
  enforces an explicit remote root and executable allowlist, rejects shell interpreters,
  and streams base64 PTY output.
- `src/main/sshRemote.ts`: an OpenSSH transport with fixed helper argv, request
  correlation, handshake timeout cleanup, and event delivery.
- `src/main/index.ts` and `src/preload/index.ts`: typed `remote:*` IPC methods kept
  separate from local `pty:*` handlers.
- `RemoteConnectionSettings`: a Connections-panel surface for saving a target, connecting,
  starting an allowlisted provider, viewing output, sending input, and closing sessions.
- `docs/remote-setup.md`: host bootstrap, Mac setup, SSH rules, and smoke tests.

This is a remote-terminal slice. Remote hive/roster/floor reconciliation, reconnect replay,
remote file/git operations, and remote agent avatars remain follow-up work.

## Findings

- The current product is an Electron desktop app. Its main process owns `node-pty`,
  filesystem/git access, the hive, and Unix-domain hook sockets.
- `SPEC.md` explicitly says: "Not a remote dashboard. Local sessions only. No web access,
  no auth." It also lists "Remote agents over SSH" as out of scope.
- The current renderer-to-main IPC only reaches the machine running Electron. SSH port
  forwarding alone cannot make local `tmux`, `node-pty`, files, hooks, or hive paths refer
  to a remote host.
- The current development host is the machine running this investigation (`work`, Ubuntu
  22.04, user `ubuntu`). It has Node.js, npm, git, and tmux available. The existing
  Munder Difflin runtime is not installed yet, so the remote helper still needs a controlled
  bootstrap and agent/provider setup.
- The repository contains local loopback HTTP services for integrations and telemetry,
  but these are not a remote UI protocol and must not be exposed directly.

## Goal and non-goals

### Goal

The signed/native Mac UI should display and control agents running on one or more remote
Linux development hosts over the user's existing SSH access. The remote host should keep
agent credentials, project files, PTYs, hooks, hive state, and provider processes local to
that host.

### Non-goals for the first version

- No public web dashboard or unauthenticated TCP listener.
- No remote renderer execution, X11 forwarding, or Electron over SSH.
- No remote secrets sent to the Mac renderer.
- No arbitrary shell command execution through a generic SSH endpoint.
- No multi-user control plane; begin with one SSH identity and one authorized OS user.
- No attempt to make the existing local IPC protocol Internet-safe by exposing it.

## Recommended architecture

```text
Mac
  Electron renderer
       | typed contextBridge / IPC
  Electron main
       | SSH child process using OpenSSH config + agent
       | one framed stdin/stdout control stream
       v
Remote development host
  fixed Munder Difflin remote helper
       | owns PTYs, tmux/agent sessions, hooks, hive, files, git
  Claude/Codex/etc. processes
```

Keep the current local backend. Add a backend/transport interface so the UI can select
`local` or `ssh-remote` without changing renderer semantics. The remote helper is the
only component that may access remote PTYs and project files.

### Transport

Use OpenSSH as the authentication and encrypted transport layer. The Mac main process
starts a fixed helper command through SSH, for example:

```text
ssh -T <host-alias> -- /absolute/path/to/munder-difflin-remote --stdio
```

Prefer a fixed absolute helper path and a dedicated remote account. Do not interpolate
user prompt text, paths, or provider commands into a shell command. If the helper is
installed under a controlled path, configure the SSH account's authorized command or
restricted shell as an additional boundary.

The helper should communicate only over stdin/stdout. Reserve stderr for diagnostics and
never treat shell text as protocol data. SSH host-key verification must use the user's
normal `known_hosts`; never set `StrictHostKeyChecking=no`.

### Framed protocol

Use length-prefixed UTF-8 JSON frames (or another explicitly framed binary envelope), not
newline-delimited JSON. Every message includes:

```json
{
  "protocol": 1,
  "type": "request | response | event",
  "request_id": "client-generated-id",
  "session_id": "remote-session-id",
  "seq": 42,
  "op": "hello | list | start | attach | input | resize | signal | close | snapshot",
  "payload": {}
}
```

Required MVP operations/events:

- `hello` / `hello_ack`: protocol version, helper version, capabilities, host identity,
  limits, and supported providers.
- `list`: remote sessions and authoritative hive/agent metadata.
- `start` / `attach`: create or attach to an agent PTY by stable session ID.
- `input`: write bounded input to a session.
- `resize`: update PTY dimensions.
- `signal` / `close`: interrupt or terminate a session with an explicit policy.
- `output`: PTY bytes, encoded as base64 or a binary frame, with monotonically increasing
  sequence numbers.
- `hook_event`: structured lifecycle events for avatar state.
- `exit` / `error`: terminal state and machine-readable failure reason.
- `snapshot`: replay current session/hive state after reconnect.
- `ping` / `pong`: heartbeat and dead-connection detection.

Bound frame size, output buffering, input rate, and the number of sessions. Use request IDs
for idempotency. Use session IDs plus output sequence numbers for deduplication and replay.

## Remote helper responsibilities

1. Start under the remote user and validate its own version/configuration.
2. Own PTY creation and lifecycle. It may use `node-pty` or the existing tmux backend,
   but the choice stays remote.
3. Install/point hooks at a remote Unix socket owned by the helper/hive.
4. Keep the hive and its authoritative registry on the remote host.
5. Enforce allowed project roots, executable/provider allowlists, environment filtering,
   resource limits, and per-session authorization.
6. Reap orphaned sessions when the SSH client disappears, subject to an explicit
   `detach`/`keep-alive` policy.
7. Never return provider secrets or unrestricted filesystem data to the client.
8. Emit structured audit events without logging prompts, tokens, or raw PTY output by
   default.

For the first implementation, package the helper as a small Node executable using the
same shared protocol types as the Electron main process. Do not make the entire Electron
application a server.

## Mac application changes

1. Introduce an `AgentBackend` interface covering list/start/attach/input/resize/signal,
   output, hook events, snapshots, and close.
2. Adapt the existing local `PtyManager`/`HiveManager` path to that interface.
3. Add an `SshRemoteBackend` in the Electron main process. It owns the SSH child process,
   protocol parser, heartbeat, request timeout, backpressure, and reconnect state.
4. Keep all remote transport handling out of the renderer. Extend the preload bridge only
   with typed backend-neutral operations.
5. Add a target picker/settings model containing SSH host alias, helper path/version,
   selected project roots, and detach policy. Display the host alias and verified SSH
   connection state in the UI.
6. Make remote hive state authoritative. The UI must not locally edit `registry.json`,
   `tasks.json`, memory, or mailboxes; it sends typed operations and consumes snapshots.
7. Mark stale sessions during disconnect. On reconnect, perform `hello`, then `list` and
   `snapshot`, discard duplicate events by sequence number, and show conflicts instead of
   silently replaying unsafe actions.
8. Keep local mode as the default and fallback. A remote capability mismatch must not
   silently start a local agent in the wrong project.

## Security requirements

- Use normal SSH host-key verification and an SSH agent/key with least privilege.
- Do not enable SSH agent forwarding unless there is a concrete, documented need.
- Use a dedicated remote OS user or restricted account where feasible.
- Allowlist helper path, provider commands, project roots, and environment variables.
- Resolve and validate paths on the remote host; reject traversal and symlink escapes.
- Treat path validation as policy, not an OS sandbox; use a least-privilege account and
  container/chroot where race-resistant confinement is required.
- Never expose the helper on `0.0.0.0`; the MVP should have no public listening port.
- Authenticate every protocol request to a live SSH connection and bind sessions to the
  SSH principal. Add a per-connection nonce/session ID to prevent accidental cross-talk.
- Apply strict frame/message limits, output backpressure, timeouts, and rate limits.
- Redact secrets from errors and diagnostics. Avoid storing raw prompts or PTY bytes in
  logs unless the user explicitly enables them.
- Restrict renderer access to typed, validated IPC. Do not pass SSH command construction
  or credentials through renderer state.
- Treat a compromised remote host as able to observe anything used there; retain a clear
  trust warning in setup documentation.

## Phased implementation

### Phase 0: current development host bootstrap (1--2 days)

- Confirm the approved installation directory and provider/agent CLI setup on the current
  development host.
- Install/verify the supported Node runtime, provider CLIs, `tmux` (if used), and a remote
  harness home under an approved project root.
- Define a versioned helper installation/update path and a health-check command.
- Prove a manually launched helper can echo framed `hello` over `ssh -T`.

### Phase 1: protocol and fake-helper tests (2--3 days)

- Add shared frame encoder/decoder with partial reads, coalesced frames, invalid JSON,
  oversized frames, and EOF tests.
- Add request correlation, sequence handling, heartbeat, timeout, and reconnect tests.
- Build a fake PTY/remote helper so tests do not launch real providers.

### Phase 2: one remote terminal (3--5 days)

- Implement `hello`, `list`, `start`, `attach`, `input`, `resize`, `output`, `exit`, and
  `close`.
- Connect one remote Claude/Codex session to the existing terminal view.
- Verify Unicode/ANSI output, resize, Ctrl-C/interrupt, disconnect, and reconnect.

### Phase 3: remote event plane and hive (3--5 days)

- Forward structured hook events and snapshots.
- Move hive operations to the helper while preserving the existing on-disk data model.
- Add remote agent cards, avatar state, tasks, messages, memory reads, and safe controls.
- Ensure only the helper writes remote hive files and commits.

### Phase 4: product hardening (3--5 days)

- Add onboarding, host verification display, capability mismatch handling, reconnect UX,
  stale-session policy, audit events, and setup diagnostics.
- Test signed macOS packaging, SSH config variants, key-agent behavior, and Linux helper
  packaging.
- Gate the feature behind an explicit `ssh-remote` flag until the acceptance tests pass.

## Acceptance criteria

A user can:

1. Install the signed Munder Difflin app on macOS.
2. Select an SSH host alias whose helper passes the version/capability handshake.
3. See remote agents started on the development host without installing provider CLIs on
   the Mac.
4. Watch ANSI terminal output and avatar state with no visible local/remote mismatch.
5. Send input, resize a terminal, interrupt a process, and close a session remotely.
6. Disconnect/reconnect SSH and recover the authoritative roster and output without
   duplicated output or unsafe duplicate actions.
7. Confirm that project files, hive state, provider credentials, and agent processes remain
   on the development host.
8. Confirm that local mode still works unchanged when no remote target is configured.

## Immediate next actions

1. Confirm the approved installation directory and provider/agent CLI setup on the current
   development host.
2. Decide whether remote sessions should survive closing the Mac app (`detach`) or be
   terminated (`close`) by default.
3. Choose the first provider to support remotely (Claude or Codex) and the remote runtime
   packaging method.
4. Implement Phase 1 protocol tests before touching the renderer.
5. Add a small end-to-end test using a disposable SSH account/container.
