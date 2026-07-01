// Gemma agent runner for pixel-agents.
//
// pixel-agents itself never calls an LLM — it only VISUALIZES agent activity.
// This runner is the "agent" side: it runs N Gemma-powered loops (via OpenRouter)
// and streams the SAME events pixel-agents understands (agentCreated / agentToolStart
// / agentToolsClear) over Server-Sent Events. The dev webview client
// (webview-ui/src/devGemmaBridge.ts) forwards them into the office, so the
// characters type/read while Gemma "works" and wander between turns.
//
// Run:  OPENROUTER_API_KEY=sk-or-... node scripts/gemma-agents/runner.mjs
//   or put OPENROUTER_API_KEY / GEMMA_MODEL in scripts/gemma-agents/.env
// Then open the dev server (localhost:5173) and toggle 3D.
//
// Env: OPENROUTER_API_KEY (required for real Gemma; falls back to canned tasks if absent)
//      GEMMA_MODEL  (default google/gemma-4-26b-a4b-it — lightweight Gemma 4, ~4B active)
//      AGENTS (default 7)   PORT (default 7777)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── tiny .env loader (no dependency) ─────────────────────────────────────────
for (const line of readEnvFile(path.join(HERE, '.env'))) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
function readEnvFile(p) {
  try {
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'));
  } catch {
    return [];
  }
}

const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.GEMMA_MODEL || 'google/gemma-4-26b-a4b-it';
const AGENTS = Math.max(1, Number(process.env.AGENTS || 7));
const PORT = Number(process.env.PORT || 7777);
// Host: 127.0.0.1 locally (no LAN exposure); a deploy host sets HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';
// When set, the runner also serves a built office SPA from this dir (single-host
// live deploy: one service serves the page AND the /events stream, same origin,
// key stays in Node). Defaults to the repo's vite build output if it exists.
const STATIC_DIR = process.env.STATIC_DIR
  ? path.resolve(process.env.STATIC_DIR)
  : path.resolve(HERE, '../../dist/webview');
const SERVE_STATIC = fs.existsSync(path.join(STATIC_DIR, 'index.html'));

// ── live task state (driven by the 총괄 chat at /command) ─────────────────────
// Until the user gives a task the agents just idle/wander; a command assigns work
// and every agent's activity becomes contextual to it. Replaces the old "random
// activity" behaviour so the chat actually controls what the team does.
let currentTask = null; // string | null — the natural-language task from chat
let assignments = {}; // { [roleName]: one-line assignment }
let planning = false; // true while 총괄 is breaking down a command (debounce)
// Reporting arc: agents post progress to the chat as they work, and 총괄 posts a
// mid-progress note (after ~1 round) and a final 완료 보고 (after ~2 rounds), then
// the team returns to idle. `taskEpoch` bumps on every new task/reset so in-flight
// turns from a replaced task self-cancel instead of double-reporting.
let taskEpoch = 0;
let turnsInTask = 0; // completed agent work-turns since the current task began
let round1Reported = false;
let finalReported = false;

if (!KEY) {
  console.warn('[gemma] OPENROUTER_API_KEY not set — using canned activities (no real Gemma).');
  console.warn('[gemma] Set it: OPENROUTER_API_KEY=sk-or-... node scripts/gemma-agents/runner.mjs');
} else {
  console.log(
    `[gemma] model=${MODEL}  agents=${AGENTS}  (역할: 총괄/아키텍트/백엔드/프론트엔드/리뷰어/테스터/데브옵스)`,
  );
}

// ── 7-agent parallel software workflow ───────────────────────────────────────
// Contract-first division of labour, chosen to minimise cross-agent waiting:
//   • Orchestrator (lead) decomposes the work, assigns it, and integrates results.
//   • Architect defines interfaces/data models UP FRONT so the next two can run
//     in parallel against a stable contract instead of blocking on each other.
//   • Backend and Frontend build concurrently against that contract.
//   • Reviewer and Tester verify CONTINUOUSLY (every change), not in a final gate,
//     so defects surface while the authors still hold the context.
//   • DevOps keeps build/CI/deploy green so finished work ships without a bottleneck.
// Roles repeat (mod 7) if AGENTS > 7. Agent #1 is always the Orchestrator/lead.
const TEAM_NAME = 'Gemma 개발팀';
const ROLES = [
  {
    name: '총괄',
    lead: true,
    desc: '작업을 잘게 나눠 팀에 분배하고 결과를 통합한다',
    fallback: [
      '스프린트 계획 짜는 중',
      '작업 분배하는 중',
      '브랜치 통합하는 중',
      '팀 병목 푸는 중',
      '로드맵 검토하는 중',
    ],
  },
  {
    name: '아키텍트',
    lead: false,
    desc: '시스템 인터페이스와 데이터 모델, API 계약을 설계한다',
    fallback: [
      'API 계약 설계하는 중',
      '데이터 모델 잡는 중',
      '인터페이스 정의하는 중',
      '아키텍처 검토하는 중',
      '시스템 흐름도 그리는 중',
    ],
  },
  {
    name: '백엔드',
    lead: false,
    desc: '서버 API와 비즈니스 로직을 구현한다',
    fallback: [
      'API 핸들러 작성하는 중',
      '쿼리 최적화하는 중',
      'DB 연결하는 중',
      '인증 구현하는 중',
      '널 버그 고치는 중',
    ],
  },
  {
    name: '프론트엔드',
    lead: false,
    desc: 'UI와 클라이언트 로직을 만든다',
    fallback: [
      '대시보드 만드는 중',
      '폼 스타일링하는 중',
      '상태 연결하는 중',
      '컴포넌트 추가하는 중',
      '레이아웃 버그 고치는 중',
    ],
  },
  {
    name: '리뷰어',
    lead: false,
    desc: '코드 변경을 정확성·보안·회귀 관점에서 리뷰한다',
    fallback: [
      'PR 리뷰하는 중',
      '디프 읽는 중',
      '경쟁 상태 확인하는 중',
      '보안 감사하는 중',
      '리뷰 코멘트 다는 중',
    ],
  },
  {
    name: '테스터',
    lead: false,
    desc: '테스트를 작성·실행하고 버그를 재현한다',
    fallback: [
      '테스트 돌리는 중',
      '유닛 테스트 작성하는 중',
      '버그 재현하는 중',
      '엣지 케이스 점검하는 중',
      '커버리지 보는 중',
    ],
  },
  {
    name: '데브옵스',
    lead: false,
    desc: '빌드·CI/CD·배포 파이프라인을 담당한다',
    fallback: [
      'CI 파이프라인 고치는 중',
      '스테이징 배포하는 중',
      '로그 확인하는 중',
      'Dockerfile 손보는 중',
      '롤아웃 지켜보는 중',
    ],
  },
];
const roleFor = (id) => ROLES[(id - 1) % ROLES.length];
const teamInfoFor = (id) => {
  const role = roleFor(id);
  return {
    type: 'agentTeamInfo',
    id,
    teamName: TEAM_NAME,
    agentName: role.name,
    isTeamLead: role.lead,
    leadAgentId: 1,
    teamUsesTmux: false,
  };
};

// ── SSE fan-out ──────────────────────────────────────────────────────────────
const clients = new Set();
const liveAgents = new Set(); // ids currently "in the office" (for replay on (re)connect)

function send(res, msg) {
  res.write(`data: ${JSON.stringify(msg)}\n\n`);
}
function broadcast(msg) {
  for (const res of clients) send(res, msg);
}
// A line in the 총괄 채팅. `from` is the speaker's role name ('총괄', '백엔드', …);
// the ChatPanel renders it as the message author. (Demo-only event, not AsyncAPI.)
function chat(from, text) {
  broadcast({ type: 'chatReply', from, text });
}
// Return the whole team to idle: drop the task and tell every agent to wander.
// Bumps taskEpoch so any in-flight work turn self-cancels. Used by both the final
// 완료 보고 and the manual "작업 초기화" button.
function clearTask() {
  currentTask = null;
  assignments = {};
  taskEpoch++;
  turnsInTask = 0;
  round1Reported = false;
  finalReported = false;
  for (const id of liveAgents) {
    broadcast({ type: 'agentToolsClear', id });
    broadcast({ type: 'agentStatus', id, status: 'waiting', awaitingInput: false });
  }
}

// ── tiny static file server (only when SERVE_STATIC) ─────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};
function serveStatic(pathname, res) {
  // Jail to STATIC_DIR; unknown routes fall back to index.html (SPA).
  const safe = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(STATIC_DIR, safe);
  if (!file.startsWith(STATIC_DIR)) file = path.join(STATIC_DIR, 'index.html');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = fs.existsSync(path.join(file, 'index.html'))
      ? path.join(file, 'index.html')
      : path.join(STATIC_DIR, 'index.html');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  // CORS preflight (dev: webview :5173 POSTs JSON to runner :7777, cross-origin).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }
  if (pathname === '/health') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
    return res.end('ok');
  }
  // Natural-language task from the 총괄 chat → plan + assign.
  if (pathname === '/command' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4000) req.destroy(); // cap untrusted payload
    });
    req.on('end', () => {
      let text = '';
      let reset = false;
      try {
        const b = JSON.parse(body);
        text = b.text || '';
        reset = b.reset === true;
      } catch {
        /* ignore malformed body */
      }
      void handleCommand(text, reset).then((result) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(JSON.stringify(result));
      });
    });
    return;
  }
  if (pathname !== '/events') {
    if (SERVE_STATIC) return serveStatic(pathname, res);
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');
  clients.add(res);
  // A page (re)load arrives with an empty office — replay the current roster (and
  // each agent's role) so the characters reappear named; the running loops animate them.
  for (const id of liveAgents) {
    send(res, { type: 'agentCreated', id });
    send(res, teamInfoFor(id));
  }
  req.on('close', () => clients.delete(res));
});
server.listen(PORT, HOST, () => {
  if (SERVE_STATIC) {
    console.log(`[gemma] serving office + SSE on http://${HOST}:${PORT}  (static: ${STATIC_DIR})`);
  } else {
    console.log(`[gemma] SSE on http://${HOST}:${PORT}/events — open localhost:5173 and toggle 3D`);
  }
});

// ── Gemma call ───────────────────────────────────────────────────────────────
const SYSTEM =
  '너는 바쁜 개발 사무실의 AI 소프트웨어 엔지니어다. 지금 무엇을 하는지 한국어로 아주 짧게(최대 6어절) "~하는 중" 형태의 현재 진행형 한 구절로만 답해라. 예: "로그인 폼 고치는 중", "API 문서 읽는 중". 따옴표·마침표·다른 말은 절대 붙이지 마라.';

async function gemmaActivity(id, role, task, assignment) {
  if (!KEY) return pick(role.fallback);
  // With a task: the label is contextual to it. Without: generic role activity.
  const userMsg = task
    ? `팀이 받은 작업: "${task}". 너는 "${role.name}" 담당이고 네가 맡은 부분은 "${assignment || role.desc}". 지금 그 작업을 위해 무엇을 하고 있나?`
    : `너는 소프트웨어 팀의 "${role.name}" 담당이다. ${role.desc}. 지금 무엇을 하고 있나?`;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 24,
        temperature: 1.0,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userMsg },
        ],
      }),
    });
    if (!r.ok)
      throw new Error(`OpenRouter ${r.status} ${await r.text().catch(() => '')}`.slice(0, 120));
    const j = await r.json();
    const text = (j.choices?.[0]?.message?.content ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .split('\n')[0];
    return text || pick(role.fallback);
  } catch (e) {
    console.warn(`[gemma] agent ${id} (${role.name}) call failed: ${e.message}`);
    return pick(role.fallback);
  }
}

// Reading tools → reading animation; everything else → typing. Matches English and
// the Korean activity vocabulary (읽다/검토/리뷰/확인/점검/감사/보다/조회/분석).
const READING =
  /\b(read|reading|review|reviewing|search|searching|look|looking|check|checking|fetch|fetching|inspect|inspecting|analyz|browse|browsing|study|studying)\b|읽|리뷰|검토|확인|점검|감사|보는|조회|분석/i;
function toolFor(activity) {
  return READING.test(activity) ? 'Read' : 'Edit';
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── agent loops ──────────────────────────────────────────────────────────────
let running = true;
let toolSeq = 0;

// 총괄 breaks a natural-language task into one-line assignments per role. Returns
// { reply, assignments }. Robust to non-JSON output (falls back to "everyone on it").
async function planTask(text) {
  if (!KEY) return { reply: `"${text}" 작업을 팀에 분배했습니다.`, assignments: {} };
  const roleList = ROLES.map((r) => r.name).join(', ');
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        temperature: 0.4,
        messages: [
          {
            role: 'system',
            content: `너는 개발팀 "총괄"이다. 사용자의 작업 지시를 받아 팀원에게 한 줄씩 업무를 배분한다. 오직 JSON만 출력하라(다른 텍스트·코드펜스 금지): {"reply":"사용자에게 보내는 한국어 한 문장 확인","assignments":{"역할명":"한 줄 업무"}}. 역할명은 다음 중에서만 고른다: ${roleList}.`,
          },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
    let content = ((await r.json()).choices?.[0]?.message?.content ?? '').replace(
      /```json|```/g,
      '',
    );
    const parsed = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
    return {
      reply: String(parsed.reply || `"${text}" 진행하겠습니다.`),
      assignments:
        parsed.assignments && typeof parsed.assignments === 'object' ? parsed.assignments : {},
    };
  } catch (e) {
    console.warn(`[gemma] planTask failed: ${e.message}`);
    return { reply: `"${text}" 작업을 팀 전원이 진행합니다.`, assignments: {} };
  }
}

// POST /command handler: the lead acknowledges, plans, and assigns. Sets the live
// task so the agent loops switch from idle to working on it. `reset:true` stops the
// current task and returns the team to idle (the "작업 초기화" button).
async function handleCommand(text, reset) {
  if (reset) {
    clearTask();
    const reply = '작업을 초기화했습니다. 팀이 대기 상태로 돌아갑니다.';
    chat('총괄', reply);
    return { reply, assignments: {} };
  }
  const t = (text || '').trim().slice(0, 500); // cap untrusted input (LLM prompt + broadcast)
  if (!t) return { reply: '무엇을 할까요? 작업을 입력하세요.', assignments: {} };
  if (planning)
    return { reply: '총괄이 직전 지시를 처리 중입니다. 잠시 후 다시 시도하세요.', assignments: {} };
  planning = true;
  const toolId = `gemma-1-${++toolSeq}`;
  broadcast({
    type: 'agentToolStart',
    id: 1,
    toolId,
    status: '지시 분석·분배하는 중',
    toolName: 'Edit',
  });
  try {
    const plan = await planTask(t);
    currentTask = t;
    assignments = plan.assignments || {};
    // Start a fresh reporting arc for this task.
    taskEpoch++;
    turnsInTask = 0;
    round1Reported = false;
    finalReported = false;
    chat('총괄', plan.reply);
    return plan;
  } finally {
    broadcast({ type: 'agentToolDone', id: 1, toolId });
    planning = false;
  }
}

// 총괄 writes a short Korean report to the chat: a one-line progress note mid-way,
// and a 2–3 sentence 완료 보고 (results) at the end. Falls back to a canned line
// when there's no API key or the call fails.
async function leadReport(task, phase) {
  const fallback =
    phase === 'final'
      ? `"${task}" 작업 완료. 아키텍처 확정 → 백엔드 API·프론트 UI 구현 → 리뷰·테스트까지 마치고 배포 준비를 끝냈습니다.`
      : `"${task}" 진행 중 — 아키텍처를 확정하고 백엔드·프론트를 병행 구현하며 리뷰·테스트를 동시에 돌리고 있습니다.`;
  if (!KEY) return fallback;
  const who = Object.entries(assignments)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const ask =
    phase === 'final'
      ? `팀이 "${task}" 작업을 끝냈다. 무엇을 완성했는지 결과물을 한국어 2~3문장으로 보고하라.${who ? ` 담당: ${who}.` : ''}`
      : `팀이 "${task}" 작업을 진행 중이다. 지금까지의 진행 상황을 한국어 한 문장으로 요약 보고하라.`;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: phase === 'final' ? 220 : 90,
        temperature: 0.6,
        messages: [
          {
            role: 'system',
            content:
              '너는 개발팀 "총괄"이다. 사용자에게 간결한 한국어 존댓말로 보고한다. 코드펜스·따옴표 없이 평문으로만.',
          },
          { role: 'user', content: ask },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
    const out = ((await r.json()).choices?.[0]?.message?.content ?? '').trim();
    return out || fallback;
  } catch (e) {
    console.warn(`[gemma] leadReport failed: ${e.message}`);
    return fallback;
  }
}

// Called after each completed work-turn. 총괄 reports at two milestones: once all
// agents have worked ~1 round (progress), and again after ~2 rounds (final → idle).
async function maybeReport(task, epoch) {
  if (currentTask !== task || taskEpoch !== epoch) return; // task replaced meanwhile
  if (!round1Reported && turnsInTask >= AGENTS && turnsInTask < AGENTS * 2) {
    round1Reported = true;
    const text = await leadReport(task, 'progress');
    if (currentTask === task && taskEpoch === epoch) chat('총괄', text);
  }
  if (!finalReported && turnsInTask >= AGENTS * 2) {
    finalReported = true;
    const text = await leadReport(task, 'final');
    if (taskEpoch === epoch) {
      chat('총괄', text);
      clearTask(); // work "done" → team returns to idle
    }
  }
}

async function runAgent(id) {
  const role = roleFor(id);
  liveAgents.add(id);
  broadcast({ type: 'agentCreated', id });
  broadcast(teamInfoFor(id)); // name the character with its workflow role
  await sleep(rand(300, 2000)); // stagger so they don't all move in lockstep

  while (running) {
    const task = currentTask;
    if (!task) {
      // No task yet (or it was cleared): idle. Re-affirm 'waiting' so the FSM keeps
      // the character wandering AND so a freshly-connected viewer converges to idle
      // (the /events replay only re-sends roster, not status). Then poll for a task.
      broadcast({ type: 'agentToolsClear', id });
      broadcast({ type: 'agentStatus', id, status: 'waiting', awaitingInput: false });
      await sleep(rand(2500, 4500));
      continue;
    }
    // A work "turn" on the assigned task: 1–3 contextual activities. The
    // `currentTask === task && taskEpoch === epoch` guard lets a new command (or a
    // reset/final report) interrupt between activities.
    const epoch = taskEpoch;
    const assignment = assignments[role.name];
    const acts = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < acts && running && currentTask === task && taskEpoch === epoch; k++) {
      const activity = await gemmaActivity(id, role, task, assignment);
      const toolId = `gemma-${id}-${++toolSeq}`;
      broadcast({
        type: 'agentToolStart',
        id,
        toolId,
        status: activity,
        toolName: toolFor(activity),
      });
      // Real-time progress: post the turn's first activity to the chat, labelled
      // with the role (one line per turn, so 7 agents don't flood the log).
      if (k === 0) chat(role.name, activity);
      await sleep(rand(3500, 8000)); // "working" on it
      broadcast({ type: 'agentToolDone', id, toolId });
    }
    // Count a completed work-turn on this task and let 총괄 report at milestones.
    if (currentTask === task && taskEpoch === epoch) {
      turnsInTask++;
      await maybeReport(task, epoch);
    }
    // Breather between turns → 'waiting' flips isActive=false so the idle-wander AI
    // takes over (neutral motions), then the agent picks the task back up.
    broadcast({ type: 'agentToolsClear', id });
    broadcast({ type: 'agentStatus', id, status: 'waiting', awaitingInput: false });
    await sleep(rand(4000, 9000));
  }
}

for (let id = 1; id <= AGENTS; id++) void runAgent(id);

// ── graceful shutdown ────────────────────────────────────────────────────────
function shutdown() {
  running = false;
  for (const id of liveAgents) broadcast({ type: 'agentClosed', id });
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
