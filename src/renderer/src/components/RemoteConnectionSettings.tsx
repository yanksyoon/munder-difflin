import { useEffect, useRef, useState } from 'react';
import type { HarnessConfig } from '@/store/config';
import type { RemoteMessage } from '@shared/remoteProtocol';
import { PixelButton } from './PixelButton';

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px 4px', background: 'var(--cth-paper-100)',
  border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none'
};
const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-700)', textTransform: 'uppercase'
};

type RemoteSession = { id: string; cwd: string; command: string; pid: number; seq: number };

const REMOTE_ID_PREFIX = 'remote:';
function logicalId(sessionId: string): string { return `${REMOTE_ID_PREFIX}${sessionId}`; }

function decodeBase64(value: string, decoder: TextDecoder): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return decoder.decode(bytes, { stream: true });
}

/** Small remote terminal surface for the first SSH slice. It deliberately does
 * not write into the local floor roster: remote paths and lifecycle belong to
 * the helper until the full remote AgentBackend lands. */
export function RemoteConnectionSettings({ config }: { config: HarnessConfig }) {
  const target = config.remoteTarget;
  const [host, setHost] = useState(target?.host ?? '');
  const [helperPath, setHelperPath] = useState(target?.helperPath ?? '');
  const [cwd, setCwd] = useState('/home/ubuntu');
  const [command, setCommand] = useState('claude');
  const [input, setInput] = useState('');
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [output, setOutput] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [note, setNote] = useState('');
  const [browsePath, setBrowsePath] = useState('/home/ubuntu');
  const [browseEntries, setBrowseEntries] = useState<{ name: string; directory: boolean }[]>([]);
  const [filePreview, setFilePreview] = useState('');
  const [gitOutput, setGitOutput] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const decoders = useRef(new Map<string, TextDecoder>());
  const lastSeq = useRef(new Map<string, number>());

  const refresh = async (): Promise<void> => {
    const result = await window.cth.remoteRefresh();
    if (!result.ok) { setNote(result.error ?? 'remote list failed'); return; }
    setSessions(result.sessions ?? []);
  };

  /** Replay a session's buffered output so a reconnect never starts blank. */
  const appendOutput = (id: string, event: RemoteMessage, base64: string): void => {
    const seq = event.seq ?? 0;
    const applied = lastSeq.current.get(id);
    if (applied !== undefined && seq <= applied) return; // already seen live or replayed
    lastSeq.current.set(id, seq);
    try {
      const decoder = decoders.current.get(id) ?? (() => { const next = new TextDecoder(); decoders.current.set(id, next); return next; })();
      const text = decodeBase64(base64, decoder);
      setOutput((prev) => ({ ...prev, [id]: ((prev[id] ?? '') + text).slice(-1_000_000) }));
    } catch { setNote('invalid remote output'); }
  };

  const replay = async (sessionId: string): Promise<void> => {
    const result = await window.cth.remoteSnapshot(sessionId);
    if (!result.ok || !result.response) return;
    const payload = result.response.payload as { events?: RemoteMessage[]; startSeq?: number; truncated?: boolean } | undefined;
    const id = logicalId(sessionId);
    // Seed the dedupe watermark with the buffer's first retained seq so live
    // bytes received before replay are never appended twice.
    if (typeof payload?.startSeq === 'number') {
      const current = lastSeq.current.get(id) ?? -1;
      lastSeq.current.set(id, Math.max(current, payload.startSeq - 1));
    }
    for (const event of payload?.events ?? []) {
      if (event.op !== 'output') continue;
      const data = (event.payload as { data?: unknown } | undefined)?.data;
      if (typeof data !== 'string') continue;
      appendOutput(id, event, data);
    }
    if (payload?.truncated) setNote('session output is truncated; earlier events were evicted');
  };

  useEffect(() => {
    const offEvent = window.cth.onRemoteEvent((message: RemoteMessage) => {
      if (!message.sessionId) return;
      const id = logicalId(message.sessionId);
      if (message.op === 'output') {
        const data = (message.payload as { data?: unknown } | undefined)?.data;
        if (typeof data === 'string') appendOutput(id, message, data);
      } else if (message.op === 'exit') {
        const decoder = decoders.current.get(id);
        const tail = decoder?.decode() ?? '';
        if (tail) setOutput((prev) => ({ ...prev, [id]: (prev[id] ?? '') + tail }));
        decoders.current.delete(id);
        lastSeq.current.delete(id);
        setSessions((prev) => prev.filter((session) => session.id !== message.sessionId));
      }
    });
    const offStatus = window.cth.onRemoteStatus((status) => {
      setConnected(status.connected);
      if (!status.connected && status.error) setNote(status.error);
    });
    return () => { offEvent(); offStatus(); };
  }, []);

  const connect = async (): Promise<void> => {
    setNote('connecting…');
    const result = await window.cth.remoteConnect({ host: host.trim(), helperPath: helperPath.trim() });
    if (!result.ok) { setConnected(false); setNote(result.error ?? 'connection failed'); return; }
    setConnected(true);
    setCapabilities(((result.hello as { capabilities?: unknown } | undefined)?.capabilities as string[] | undefined) ?? []);
    try { await window.cth.updateConfig({ remoteTarget: { host: host.trim(), helperPath: helperPath.trim() } }); }
    catch { /* connection remains usable; persistence can be retried next time */ }
    setSessions(result.sessions ?? []);
    for (const session of result.sessions ?? []) { setSelected((prev) => prev ?? session.id); await replay(session.id); }
    setNote('connected — sessions restored');
  };

  const disconnect = async (): Promise<void> => {
    await window.cth.remoteDisconnect();
    setConnected(false); setSessions([]); setSelected(null); setNote('disconnected');
  };

  const start = async (): Promise<void> => {
    const result = await window.cth.remoteStart({ cwd: cwd.trim(), command: command.trim() });
    if (!result.ok) { setNote(result.error ?? 'start failed'); return; }
    if (result.session) { setSessions((prev) => [...prev, result.session!]); setSelected(result.session!.id); }
    setNote('remote session started');
  };

  const sendInput = async (): Promise<void> => {
    if (!selected || !input) return;
    const result = await window.cth.remoteInput(logicalId(selected), input + '\r');
    if (!result.ok) setNote(result.error ?? 'input failed'); else setInput('');
  };

  const closeSession = async (sessionId: string): Promise<void> => {
    const result = await window.cth.remoteClose(logicalId(sessionId));
    if (!result.ok) { setNote(result.error ?? 'close failed'); return; }
    setSessions((prev) => prev.filter((session) => session.id !== sessionId));
    if (selected === sessionId) setSelected(null);
  };

  const browse = async (path?: string): Promise<void> => {
    const next = path ?? browsePath;
    const result = await window.cth.remoteFsList(next === '/home/ubuntu' ? undefined : next);
    if (!result.ok || !result.response) { setNote(result.error ?? 'remote list failed'); return; }
    const payload = result.response.payload as { path?: string; entries?: { name: string; directory: boolean }[] } | undefined;
    setBrowsePath(payload?.path ?? next);
    setBrowseEntries(payload?.entries ?? []);
    setFilePreview('');
  };

  const readFile = async (name: string): Promise<void> => {
    const result = await window.cth.remoteFsRead(`${browsePath}/${name}`);
    if (!result.ok || !result.response) { setNote(result.error ?? 'remote read failed'); return; }
    const payload = result.response.payload as { content?: string } | undefined;
    setFilePreview(payload?.content ?? '');
  };

  const runGit = async (kind: 'status' | 'log'): Promise<void> => {
    const result = kind === 'status' ? await window.cth.remoteGitStatus() : await window.cth.remoteGitLog();
    if (!result.ok || !result.response) { setNote(result.error ?? 'git failed'); return; }
    const payload = result.response.payload as { output?: string } | undefined;
    setGitOutput(payload?.output ?? '');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ ...labelStyle, marginBottom: 6 }}>Remote development host</div>
        <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-700)' }}>
          Connect the Mac UI to the helper running on the work host. SSH remains the only transport; local PTYs are unchanged.
        </div>
      </div>
      <label style={labelStyle}>SSH host alias<input value={host} onChange={(e) => setHost(e.target.value)} placeholder="work" style={inputStyle} /></label>
      <label style={labelStyle}>Absolute helper path<input value={helperPath} onChange={(e) => setHelperPath(e.target.value)} placeholder="/home/ubuntu/bin/munder-remote" style={inputStyle} /></label>
      <div style={{ display: 'flex', gap: 8 }}>
        <PixelButton variant="primary" size="sm" onClick={() => void connect()} disabled={!host.trim() || !helperPath.trim()}>Connect</PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={() => void connect()} disabled={!host.trim() || !helperPath.trim()}>Reconnect</PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={() => void disconnect()} disabled={!connected}>Disconnect</PixelButton>
        <PixelButton variant="ghost" size="sm" onClick={() => void refresh()} disabled={!connected}>Reload sessions</PixelButton>
        <span style={{ fontSize: 12, color: connected ? 'var(--cth-mint)' : 'var(--cth-ink-500)', alignSelf: 'center' }}>{connected ? 'connected' : 'not connected'}</span>
      </div>
      {connected && <>
        <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />
        {capabilities.length > 0 && <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>capabilities: {capabilities.join(', ')}</div>}
        <div style={{ ...labelStyle, marginBottom: 2 }}>Remote project browser</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={browsePath} onChange={(e) => setBrowsePath(e.target.value)} style={inputStyle} placeholder="remote path under root" />
          <PixelButton variant="secondary" size="sm" onClick={() => void browse()}>Open</PixelButton>
        </div>
        {browseEntries.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 180, overflow: 'auto', background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', padding: 6 }}>
            {browseEntries.map((entry) => (
              <div key={entry.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <span style={{ color: 'var(--cth-ink-500)' }}>{entry.directory ? '📁' : '📄'}</span>
                <button type="button" onClick={() => { if (entry.directory) void browse(`${browsePath}/${entry.name}`); else void readFile(entry.name); }} style={{ flex: 1, textAlign: 'left', border: 0, background: 'transparent', color: 'var(--cth-ink-900)', cursor: 'pointer', fontFamily: 'var(--cth-font-mono)' }}>{entry.name}</button>
              </div>
            ))}
          </div>
        )}
        {filePreview && <pre style={{ margin: 0, padding: 8, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', background: 'var(--cth-paper-200)', color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-mono)', fontSize: 12 }}>{filePreview}</pre>}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <PixelButton variant="ghost" size="sm" onClick={() => void runGit('status')}>git status</PixelButton>
          <PixelButton variant="ghost" size="sm" onClick={() => void runGit('log')}>git log</PixelButton>
        </div>
        {gitOutput && <pre style={{ margin: 0, padding: 8, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap', background: 'var(--cth-paper-200)', color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-mono)', fontSize: 12 }}>{gitOutput}</pre>}
        <div style={{ height: 1, background: 'var(--cth-ink-300)' }} />
        <div style={{ ...labelStyle, marginBottom: 2 }}>Start remote agent</div>
        <label style={labelStyle}>Project directory<input value={cwd} onChange={(e) => setCwd(e.target.value)} style={inputStyle} /></label>
        <label style={labelStyle}>Allowlisted provider<input value={command} onChange={(e) => setCommand(e.target.value)} style={inputStyle} /></label>
        <PixelButton variant="secondary" size="sm" onClick={() => void start()}>Start remote session</PixelButton>
        <div style={{ ...labelStyle, marginTop: 4 }}>Remote sessions</div>
        {sessions.length === 0 && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>No remote sessions.</span>}
        {sessions.map((session) => (
          <div key={session.id} style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: 8, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" onClick={() => setSelected(session.id)} style={{ flex: 1, textAlign: 'left', border: 0, background: 'transparent', color: 'var(--cth-ink-900)', cursor: 'pointer', fontFamily: 'var(--cth-font-mono)' }}>{session.command} · {session.id.slice(0, 12)}</button>
              <PixelButton variant="ghost" size="sm" onClick={() => { setSelected(session.id); void replay(session.id); }}>Replay</PixelButton>
              <PixelButton variant="destructive" size="sm" onClick={() => void closeSession(session.id)}>Close</PixelButton>
            </div>
            {selected === session.id && <>
              <pre style={{ margin: 0, padding: 8, minHeight: 80, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', background: 'var(--cth-paper-200)', color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}>{output[logicalId(session.id)] ?? ''}</pre>
              <div style={{ display: 'flex', gap: 6 }}><input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void sendInput(); }} placeholder="send input" style={inputStyle} /><PixelButton variant="primary" size="sm" onClick={() => void sendInput()}>Send</PixelButton></div>
            </>}
          </div>
        ))}
      </>}
      {note && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{note}</span>}
    </div>
  );
}
