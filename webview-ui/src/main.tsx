import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';
import { isBrowserRuntime, isGemmaDemo } from './runtime';

async function main() {
  // browserMock loads assets client-side (no WebSocket server). Used in Vite dev
  // and in the Gemma-demo build, where a single Node host serves the office + SSE.
  const useBrowserMock = isBrowserRuntime && (import.meta.env.DEV || isGemmaDemo);
  if (useBrowserMock) {
    const { initBrowserMock } = await import('./browserMock.js');
    await initBrowserMock();
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // Let the Gemma agent runner drive characters over SSE (no-op if not running).
  if (useBrowserMock) {
    const { connectGemmaBridge } = await import('./devGemmaBridge.js');
    connectGemmaBridge();
  }
}

main().catch(console.error);
