/**
 * Runtime detection, provider-agnostic
 *
 * Single source of truth for determining whether the webview is running
 * inside an IDE extension (VS Code, Cursor, Windsurf, etc.) or standalone
 * in a browser.
 */

declare function acquireVsCodeApi(): unknown;

type Runtime = 'vscode' | 'browser';
// Future: 'cursor' | 'windsurf' | 'electron' | etc.

const runtime: Runtime = typeof acquireVsCodeApi !== 'undefined' ? 'vscode' : 'browser';

export const isBrowserRuntime = runtime === 'browser';

/**
 * "Gemma demo" production build (VITE_GEMMA_DEMO=1 at build time). A standalone
 * browser build that, instead of the WebSocket server protocol, runs browserMock
 * for assets and the Gemma SSE bridge (same-origin /events) so a single Node host
 * (scripts/gemma-agents/runner.mjs) can serve the office AND drive it live with the
 * OpenRouter key kept server-side. Statically false in normal builds → the
 * browserMock + bridge code is tree-shaken out of the real app.
 */
export const isGemmaDemo: boolean = import.meta.env.VITE_GEMMA_DEMO === '1';

/**
 * True only under the Playwright e2e harness, which sets `__PIXEL_AGENTS_E2E`
 * via `addInitScript` before any app code runs (so it's set in every frame,
 * including the VS Code webview iframe). Gates test-only diagnostics
 * (window.__pixelAgentsTestHooks message/sound logs, the addAgent wrapper) so
 * they never run, and never grow unbounded, in a real user's session.
 */
export const isE2E: boolean =
  typeof window !== 'undefined' &&
  (window as unknown as { __PIXEL_AGENTS_E2E?: boolean }).__PIXEL_AGENTS_E2E === true;
