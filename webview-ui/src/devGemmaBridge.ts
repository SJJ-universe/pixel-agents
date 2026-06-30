// DEV-ONLY bridge: forwards events from the local Gemma agent runner
// (scripts/gemma-agents/runner.mjs, Server-Sent Events on 127.0.0.1:7777) into
// the webview as the same `window` 'message' events the server/browserMock use.
// This lets Gemma-powered agents drive the office characters without exposing the
// OpenRouter key in the browser (the runner makes all LLM calls in Node).
//
// Imported in Vite dev and in the Gemma-demo production build (gated in main.tsx).
// Dev: the runner is a separate process on :7777. Gemma-demo: the runner serves
// this very page, so the stream is same-origin at /events.

import { isGemmaDemo } from './runtime.js';

const SSE_URL = isGemmaDemo ? '/events' : 'http://127.0.0.1:7777/events';
const RECONNECT_MS = 8000;

export function connectGemmaBridge(): void {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;

  const connect = (): void => {
    const es = new EventSource(SSE_URL);
    es.onopen = () => console.log('[gemma-bridge] connected to runner');
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as unknown;
        // Same shape the UI already consumes (ServerMessage); re-dispatch verbatim.
        window.dispatchEvent(new MessageEvent('message', { data }));
      } catch {
        /* ignore malformed frames */
      }
    };
    es.onerror = () => {
      // Runner not up (or dropped) — retry on a calm cadence instead of EventSource's
      // tight built-in loop, so the console isn't spammed while the runner is off.
      es.close();
      setTimeout(connect, RECONNECT_MS);
    };
  };

  connect();
}
