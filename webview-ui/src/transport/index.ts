import { isBrowserRuntime, isGemmaDemo } from '../runtime.js';
import { BrowserMockTransport } from './browserMockTransport.js';
import { PostMessageTransport } from './postMessageTransport.js';
import type { MessageTransport } from './types.js';
import { WebSocketTransport } from './webSocketTransport.js';

function createTransport(): MessageTransport {
  if (!isBrowserRuntime) {
    return new PostMessageTransport();
  }
  // Vite dev (no backend) and the Gemma-demo build: pair with browserMock's window
  // 'message' dispatch (which the Gemma SSE bridge also uses) so the office runs
  // without the WebSocket server protocol. Normal production builds use WebSocket.
  if (import.meta.env.DEV || isGemmaDemo) {
    return new BrowserMockTransport();
  }
  // Standalone browser: connect via WebSocket to the same host serving the SPA
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  const ws = new WebSocketTransport(wsUrl);
  ws.connect();
  return ws;
}

/** Singleton transport instance. Import this everywhere instead of vscodeApi. */
export const transport: MessageTransport = createTransport();
export type { MessageTransport } from './types.js';
