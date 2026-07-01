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
const LEAD_NAME_FG = '#c9c9ff'; // agent/role name accent on non-user lines

interface Msg {
  /** '나' for the user, otherwise the speaking agent's role name ('총괄', '백엔드', …). */
  from: string;
  text: string;
}

export function ChatPanel() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  // Replies + live progress come over the SSE bridge as window 'message'
  // { type:'chatReply', from, text }. `from` is the role name (defaults to 총괄).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { type?: string; from?: string; text?: string } | undefined;
      const text = d?.text;
      if (d?.type === 'chatReply' && typeof text === 'string') {
        setMessages((m) => [...m, { from: d?.from || '총괄', text }]);
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
    setMessages((m) => [...m, { from: '나', text }]);
    setInput('');
    setBusy(true);
    fetch(CMD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {
      setMessages((m) => [...m, { from: '총괄', text: '러너에 연결할 수 없습니다.' }]);
      setBusy(false);
    });
    // The reply is appended by the chatReply listener above (keeps all viewers in sync).
  };

  // "작업 초기화": stop the current task and return the team to idle. The runner's
  // acknowledgement comes back over SSE as a chatReply (keeps all viewers in sync).
  const reset = () => {
    fetch(CMD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    }).catch(() => {
      setMessages((m) => [...m, { from: '총괄', text: '러너에 연결할 수 없습니다.' }]);
    });
    setBusy(false);
  };

  return (
    <div style={panelStyle} onPointerDown={(e) => e.stopPropagation()}>
      <div style={headerRowStyle}>
        <span style={headerStyle}>총괄 채팅 — 작업을 자연어로 지시하세요</span>
        <button
          type="button"
          onClick={reset}
          title="현재 작업을 멈추고 팀을 대기로"
          style={resetStyle}
        >
          작업 초기화
        </button>
      </div>
      <div ref={logRef} style={logStyle}>
        {messages.length === 0 && (
          <div style={{ color: MUTED, fontSize: 11, lineHeight: 1.5 }}>
            예: "할 일 관리 웹앱 만들어줘", "로그인 버그 고쳐줘". 총괄이 팀에 분배하면 캐릭터들이 그
            작업을 시작하고, 진행 상황과 완료 보고가 여기 올라옵니다. 지시 전에는 자유롭게
            대기합니다.
          </div>
        )}
        {messages.map((m, i) => {
          const mine = m.from === '나';
          return (
            <div key={i} style={mine ? userMsgStyle : leadMsgStyle}>
              <span style={{ color: mine ? MUTED : LEAD_NAME_FG, fontSize: 10, fontWeight: 700 }}>
                {m.from}
              </span>
              <div>{m.text}</div>
            </div>
          );
        })}
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
const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
};
const headerStyle: CSSProperties = { fontWeight: 700, fontSize: 11, opacity: 0.85 };
const resetStyle: CSSProperties = {
  cursor: 'pointer',
  background: 'transparent',
  border: `1px solid ${BORDER}`,
  color: MUTED,
  fontSize: 10,
  padding: '2px 6px',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};
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
