# Deploy the Gemma live office (homepage)

This deploys a public webpage where a team of lightweight **Gemma 4** agents
(via OpenRouter) come to life as animated characters in the pixel office — driven
live, in real time. One Node service serves the page **and** the agent event
stream from the same origin, so the OpenRouter API key never reaches the browser.

```
[ browser ]  ──GET /──>  [ Render Node service: scripts/gemma-agents/runner.mjs ]
     │                         │  serves the built office (dist/webview)
     └──EventSource /events──> │  + streams live Gemma activity (key = server secret)
```

## What runs

- `runner.mjs` in **visual / activity-label mode**: each Gemma agent reports, in
  Korean, what it's "working on" (real Gemma output), and the office animates it
  (typing / reading / wandering). It never runs shell commands — safe to expose.
- The code-**editing** harness (`coder.mjs`) is intentionally **not** deployed: it
  executes model-chosen shell commands and is a local/CLI tool only.

## One-time deploy (Render free tier)

1. Push this branch to GitHub (already under `SJJ-universe/pixel-agents`).
2. Render dashboard → **New** → **Blueprint** → select this repo/branch.
   Render reads `render.yaml` and provisions one web service.
3. When prompted, paste your OpenRouter key into **`OPENROUTER_API_KEY`**
   (the only value marked `sync: false`). This is the one secret; you enter it
   yourself in Render — it is never committed to the repo.
4. **Create** → first build runs `npm install && VITE_GEMMA_DEMO=1 npm run build:gemma-demo`,
   then starts the runner. Open the service URL and toggle **3D**.

Get a key at <https://openrouter.ai/keys>. The default model
`google/gemma-4-26b-a4b-it` is lightweight (~4B active params) and costs pennies;
set `GEMMA_MODEL=google/gemma-4-26b-a4b-it:free` in the dashboard for zero cost
(the free tier may rate-limit with 7 agents — the runner falls back to canned
labels per call, so it never breaks).

## Notes & limits

- **Free tier sleeps** after ~15 min idle; the first visit after a sleep cold-starts
  (~30–60 s). Upgrade the plan or add an uptime pinger if you need it always-warm.
- Any host that runs a persistent Node process works (Railway, Fly.io, a VPS) —
  set the same env: `OPENROUTER_API_KEY`, `HOST=0.0.0.0`, and the platform's `PORT`.
- Run it locally the same way:
  `OPENROUTER_API_KEY=sk-or-... STATIC_DIR=dist/webview npm run build:gemma-demo && node scripts/gemma-agents/runner.mjs`

## Attribution

This is a derivative of [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)
by pablodelucca (MIT — see `LICENSE`). The Gemma agent runner, the live-demo build
flag, and the single-host serving in `scripts/gemma-agents/` are additions on top.
