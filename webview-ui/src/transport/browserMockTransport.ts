import type { ServerMessage } from '../../../core/src/messages.js';
import type { MessageTransport } from './types.js';

/**
 * Dev-only transport for `npm run dev` (Vite, no backend). Receives the window
 * 'message' events that browserMock dispatches — the same channel
 * PostMessageTransport listens on in VS Code — so the office populates without a
 * server. Sends are no-ops. Real standalone browser builds use WebSocketTransport.
 */
export class BrowserMockTransport implements MessageTransport {
  send(): void {
    // No backend in dev; client messages (webviewReady, saveAgentSeats…) are dropped.
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    const listener = (e: MessageEvent) => handler(e.data as ServerMessage);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }

  dispose(): void {
    // No persistent resources.
  }
}
