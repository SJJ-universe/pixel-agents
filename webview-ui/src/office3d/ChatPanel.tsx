// 총괄(lead) chat — top-right overlay. The user types a natural-language task; it
// POSTs to the Gemma runner's /command, where the lead plans + assigns it, and the
// agents' on-screen activity becomes contextual to that task (instead of random).
// The lead's reply arrives over the same SSE stream as a `chatReply` event (the
// runner broadcasts it; devGemmaBridge re-dispatches it as a window 'message'), so
// every connected viewer stays in sync. Only mounted in the Gemma-demo / dev build,
// where the runner backend exists. office3d/** is inline-color whitelisted.

import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from 'react';

import { isGemmaDemo } from '../runtime.js';

const CMD_URL = isGemmaDemo ? '/command' : 'http://127.0.0.1:7777/command';

const BG = '#1e1e2e';
const BORDER = '#3a3a5c';
const FG = '#e6e6f0';
const LEAD_BG = '#2a2a44';
const USER_BG = '#394066';
const MUTED = '#9a9ab8';

interface Msg {
  from: 'user' | 'lead';
  text: string;
}

export function ChatPanel() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Lead replies come over the SSE bridge as window 'message' { type:'chatReply' }.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; text?: string } | undefined;
      const text = d?.text;
      if (d?.type === 'chatReply' && typeof text === 'string') {
        setMessages((m) => [...m, { from: 'lead', text }]);
        setBusy(false);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setMessages((m) => [...m, { from: 'user', text }]);
    setInput('');
    setBusy(true);
    fetch(CMD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {
      setMessages((m) => [...m, { from: 'lead', text: '러너에 연결할 수 없습니다.' }]);
      setBusy(false);
    });
    // The reply is appended by the chatReply listener above (keeps all viewers in sync).
  };

  return (
    <div style={panelStyle} onPointerDown={(e) => e.stopPropagation()}>
      <div style={headerStyle}>총괄 채팅 — 작업을 자연어로 지시하세요</div>
      <div ref={logRef} style={logStyle}>
        {messages.length === 0 && (
          <div style={{ color: MUTED, fontSize: 11, lineHeight: 1.5 }}>
            예: "할 일 관리 웹앱 만들어줘", "로그인 버그 고쳐줘". 총괄이 팀에 분배하면 캐릭터들이 그
            작업을 시작합니다. 지시 전에는 자유롭게 대기합니다.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={m.from === 'user' ? userMsgStyle : leadMsgStyle}>
            <span style={{ color: MUTED, fontSize: 10 }}>{m.from === 'user' ? '나' : '총괄'}</span>
            <div>{m.text}</div>
          </div>
        ))}
        {busy && <div style={{ color: MUTED, fontSize: 11 }}>총괄이 분배 중…</div>}
      </div>
      <form onSubmit={submit} style={{ display: 'flex', gap: 4 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="작업 지시…"
          style={inputStyle}
        />
        <button type="submit" disabled={busy} style={sendStyle}>
          보내기
        </button>
      </form>
    </div>
  );
}

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 44,
  right: 8,
  width: 300,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 8,
  background: BG,
  border: `2px solid ${BORDER}`,
  color: FG,
  fontSize: 12,
};
const headerStyle: CSSProperties = { fontWeight: 700, fontSize: 11, opacity: 0.85 };
const logStyle: CSSProperties = {
  maxHeight: 240,
  minHeight: 60,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  paddingRight: 2,
};
const leadMsgStyle: CSSProperties = { background: LEAD_BG, padding: '4px 6px', lineHeight: 1.4 };
const userMsgStyle: CSSProperties = { background: USER_BG, padding: '4px 6px', lineHeight: 1.4 };
const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: BG,
  border: `2px solid ${BORDER}`,
  color: FG,
  fontSize: 12,
  padding: '4px 6px',
};
const sendStyle: CSSProperties = {
  cursor: 'pointer',
  background: BORDER,
  border: 'none',
  color: FG,
  fontWeight: 700,
  fontSize: 12,
  padding: '4px 8px',
};
