<h1 align="center">Pixel Agents — Live Gemma Office</h1>

<p align="center">
  <img src="webview-ui/public/banner.png" alt="Pixel Agents">
</p>

<h3 align="center">Watch a team of real AI agents work as animated characters in a pixel-art office — live, in your browser.</h3>

<p align="center">
  <a href="https://gemma-pixel-office.onrender.com"><b>▶ Open the live demo →</b> gemma-pixel-office.onrender.com</a>
</p>

<p align="center">
  <sub>Free Render instance — the <b>first load can take 30 s – 2 min</b> while it wakes from sleep (see <a href="#why-the-first-load-is-slow">below</a>). It is instant after that.</sub>
</p>

---

This repository is a fork of [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) that adds a **deployed, self-driving multi-agent office**: seven Gemma agents (a lead plus six specialists) spun up on a server, streaming their activity into the pixel office over Server-Sent Events. It also adds a **3D renderer** so the same office can be viewed as animated 3D characters instead of pixel sprites.

The base project turns any multi-agent AI system into something you can _see_: each agent becomes a character that walks around, sits at a desk, and animates to reflect what it is actually doing — typing when it writes code, reading when it searches files, waiting when it needs your attention. This fork makes that watchable by anyone, with no install, at the link above.

<p align="center">
  <img src="webview-ui/public/Screenshot.jpg" alt="Pixel Agents office" width="720">
</p>

## What this fork adds

- **A live, hosted office** — a single Node service serves the built office _and_ streams live agent events from the same origin. One URL, no setup, nothing to install.
- **Real Gemma agents driving it** — a separate runner talks to `google/gemma-4-26b-a4b-it` via OpenRouter and emits office events (agent created, tool started/finished, waiting, chat reply). The office app itself **never calls an LLM** — it only visualizes events, so the runner is fully swappable.
- **A "총괄" (lead) chat that reports back** — type a task to the lead; it plans and delegates to the specialists, and the chat then fills with live progress (each agent posts what it's working on, labelled by role) and a final completion report from the lead, after which the team returns to idle. A **작업 초기화** button stops the current task at any time.
- **Idle vs. working labels** — every character is always tagged `name · status`: the live activity while busy, or **`쉬는중` (resting)** while idle — so you can read who is who and who is working at a glance.
- **A 3D office renderer** — toggle from pixel sprites to animated 3D Mixamo characters (react-three-fiber), viewed as a top-down diorama or a first-person walkthrough (WASD), with head-mounted speech bubbles and floor-grounded animation.

## The seven agents

| Role                  | Character                       |                                          |
| --------------------- | ------------------------------- | ---------------------------------------- |
| 총괄 (Lead)           | seated, always at the head desk | plans and delegates; driven by your chat |
| 아키텍트 (Architect)  | mobile                          | design / structure work                  |
| 백엔드 (Backend)      | mobile                          | server & data work                       |
| 프론트엔드 (Frontend) | mobile                          | UI work                                  |
| 리뷰어 (Reviewer)     | mobile                          | reviews output                           |
| 테스터 (Tester)       | mobile                          | verifies                                 |
| 데브옵스 (DevOps)     | seated                          | build / deploy                           |

Idle agents wander or rest at a desk; when the lead assigns work, they walk to a seat and animate for the tool they are "running".

## Why the first load is slow

The demo runs on Render's **free tier**, which **spins the service down after ~15 minutes of no traffic**. The next visit has to cold-start the Node process and stream the first batch of events, so the initial page can take roughly **30 seconds to 2 minutes**. This is expected free-tier behavior, not a bug — once it is warm, it stays instant until it goes idle again. (Upgrading the Render plan or adding an external pinger keeps it always-on.)

## How the live office works

```
Your browser  ──GET /──────────────►  built office SPA (dist/webview)
              ◄─SSE /events─────────  live agent events (same origin, no CORS)
              ──POST /command───────►  the 총괄 chat: assign a task to the lead

Server (scripts/gemma-agents/runner.mjs, Node stdlib only)
    │  serves the SPA + streams events + relays the plan, progress & report
    └──HTTPS──►  OpenRouter  ──►  google/gemma-4-26b-a4b-it
```

Key design points:

- **One service, one origin.** The runner serves the SPA and the `/events` stream from the same host, so there is no second server and no CORS. `/health` is the liveness endpoint.
- **The office never sees the API key.** `OPENROUTER_API_KEY` lives only in the server process (a Render secret, `sync: false`). The browser only receives already-rendered office events.
- **Idle is free.** Agents call OpenRouter only while a task is active; with no task they just broadcast a "waiting" heartbeat, so an idle demo spends no tokens. A task auto-ends after the lead's completion report (or when you hit 작업 초기화), which bounds the cost.
- **The app is LLM-agnostic.** The office consumes a small, typed stream of events. The Gemma runner is just one producer — the built-in browser mock or any other driver can replace it without touching the UI.
- **Safe by construction.** The deployed runner is the visual/activity driver only. The separate code-editing harness that can run shell commands is intentionally **not** exposed on the public deploy.

## Run it yourself

```bash
git clone https://github.com/SJJ-universe/pixel-agents.git
cd pixel-agents
npm install            # npm workspaces installs root + server + webview in one shot
```

Set your OpenRouter key (server-side only — never commit it):

```bash
export OPENROUTER_API_KEY=sk-or-...        # Windows PowerShell: $env:OPENROUTER_API_KEY="sk-or-..."
```

**Production-like (what the live site runs):** build the office with the demo flag, then start the runner, then open the port it prints (default `7777`):

```bash
VITE_GEMMA_DEMO=1 npm run build:gemma-demo   # builds the SPA with the same-origin SSE bridge
node scripts/gemma-agents/runner.mjs         # serves office + /events on http://127.0.0.1:7777
```

**Dev with hot reload:** run the Vite dev server and the runner together, then open `http://localhost:5173` and toggle 3D:

```bash
npm run gemma:dev        # Vite dev server + Gemma runner in parallel
```

Environment knobs the runner reads: `OPENROUTER_API_KEY`, `GEMMA_MODEL` (default `google/gemma-4-26b-a4b-it`), `AGENTS` (default `7`), `PORT` (default `7777`), `HOST` (default `127.0.0.1`).

## Deploy your own

This repo ships a [Render Blueprint](render.yaml). In the Render dashboard: **New → Blueprint → pick this repo**. Render reads `render.yaml`, then asks you to fill in the single secret, `OPENROUTER_API_KEY`. It builds with `VITE_GEMMA_DEMO=1 npm run build:gemma-demo` and starts `node scripts/gemma-agents/runner.mjs`. `autoDeploy` is on, so every push to the connected branch redeploys.

## Architecture (base project)

A four-package monorepo with strict layering (`core` depends on nothing; `server` and `webview-ui` depend only on `core`; the VS Code adapter composes `core` + `server`):

- **`core/`** — protocol + interfaces. An [AsyncAPI 3.0](core/asyncapi.yaml) contract is the single source of truth for the wire messages; the TypeScript bindings are generated from it and drift-checked in CI. Defines `HookProvider` (the integration boundary for any AI tool) and `MessageTransport`.
- **`server/`** — Fastify HTTP/WebSocket server and the shared `AgentRuntime` + `AgentStateStore`. Also ships the `npx pixel-agents` standalone CLI.
- **`adapters/vscode/`** — the VS Code extension surface.
- **`webview-ui/`** — the React 19 office. A Canvas 2D pixel renderer and a react-three-fiber **3D renderer** (`webview-ui/src/office3d/`) read from an imperative `OfficeState` game world. One `createTransport()` call is the only place that branches between the VS Code (`postMessage`) and browser (`WebSocket`/SSE) transports.

Adding a new AI tool is a single subdirectory under `server/src/providers/hook/<id>/`. Claude Code is the reference provider; this fork's Gemma runner is a standalone driver that speaks the same office-event shape.

## Tech stack

React 19 · Vite · Canvas 2D · [react-three-fiber](https://github.com/pmndrs/react-three-fiber) + three.js (3D) · Fastify v5 · TypeScript (strict, `erasableSyntaxOnly`) · Vitest + Playwright · Node stdlib runner · OpenRouter (Gemma).

## Credits

- Built on **[pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)** by [pablodelucca](https://github.com/sponsors/pablodelucca) — please support the upstream project.
- Pixel characters based on [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).
- 3D characters are [Mixamo](https://www.mixamo.com/) models, converted to GLB.
- Gemma models by Google, served via [OpenRouter](https://openrouter.ai/).

## License

MIT — same as upstream. See [LICENSE](LICENSE).
