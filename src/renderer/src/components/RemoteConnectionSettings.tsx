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
  const decoders = useRef(new Map<string, TextDecoder>());

  const refresh = async (): Promise<void> => {
    const result = await window.cth.remoteList();
    if (!result.ok) { setNote(result.error ?? 'remote list failed'); return; }
    const listed = (result.response?.payload as { sessions?: RemoteSession[] } | undefined)?.sessions;
    setSessions(Array.isArray(listed) ? listed : []);
  };

  useEffect(() => {
    const offEvent = window.cth.onRemoteEvent((message: RemoteMessage) => {
      if (!message.sessionId) return;
      if (message.op === 'output') {
        const data = (message.payload as { data?: unknown } | undefined)?.data;
        if (typeof data === 'string') {
          try {
            const decoder = decoders.current.get(message.sessionId!) ?? (() => { const next = new TextDecoder(); decoders.current.set(message.sessionId!, next); return next; })();
            const text = decodeBase64(data, decoder);
            setOutput((prev) => ({
              ...prev,
              [message.sessionId!]: ((prev[message.sessionId!] ?? '') + text).slice(-1_000_000)
            }));
          } catch { setNote('invalid remote output'); }
        }
      } else if (message.op === 'exit') {
        const decoder = decoders.current.get(message.sessionId);
        const tail = decoder?.decode() ?? '';
        if (tail) setOutput((prev) => ({ ...prev, [message.sessionId!]: (prev[message.sessionId!] ?? '') + tail }));
        decoders.current.delete(message.sessionId);
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
    try { await window.cth.updateConfig({ remoteTarget: { host: host.trim(), helperPath: helperPath.trim() } }); }
    catch { /* connection remains usable; persistence can be retried next time */ }
    setNote('connected');
    await refresh();
  };

  const disconnect = async (): Promise<void> => {
    await window.cth.remoteDisconnect();
    setConnected(false); setSessions([]); setSelected(null); setNote('disconnected');
  };

  const start = async (): Promise<void> => {
    const result = await window.cth.remoteStart({ cwd: cwd.trim(), command: command.trim() });
    if (!result.ok) { setNote(result.error ?? 'start failed'); return; }
    const session = (result.response?.payload as { session?: RemoteSession } | undefined)?.session;
    if (session) { setSessions((prev) => [...prev, session]); setSelected(session.id); }
    setNote('remote session started');
  };

  const sendInput = async (): Promise<void> => {
    if (!selected || !input) return;
    const result = await window.cth.remoteInput(selected, input + '\r');
    if (!result.ok) setNote(result.error ?? 'input failed'); else setInput('');
  };

  const closeSession = async (id: string): Promise<void> => {
    const result = await window.cth.remoteClose(id);
    if (!result.ok) { setNote(result.error ?? 'close failed'); return; }
    setSessions((prev) => prev.filter((session) => session.id !== id));
    if (selected === id) setSelected(null);
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
        <PixelButton variant="secondary" size="sm" onClick={() => void disconnect()} disabled={!connected}>Disconnect</PixelButton>
        <span style={{ fontSize: 12, color: connected ? 'var(--cth-mint)' : 'var(--cth-ink-500)', alignSelf: 'center' }}>{connected ? 'connected' : 'not connected'}</span>
      </div>
      {connected && <>
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
              <PixelButton variant="destructive" size="sm" onClick={() => void closeSession(session.id)}>Close</PixelButton>
            </div>
            {selected === session.id && <>
              <pre style={{ margin: 0, padding: 8, minHeight: 80, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', background: 'var(--cth-paper-200)', color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}>{output[session.id] ?? ''}</pre>
              <div style={{ display: 'flex', gap: 6 }}><input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void sendInput(); }} placeholder="send input" style={inputStyle} /><PixelButton variant="primary" size="sm" onClick={() => void sendInput()}>Send</PixelButton></div>
            </>}
          </div>
        ))}
      </>}
      {note && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{note}</span>}
    </div>
  );
}
