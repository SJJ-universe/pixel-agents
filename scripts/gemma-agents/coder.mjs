// Real code-editing multi-agent runner for pixel-agents.
//
// Unlike runner.mjs (which only generates activity LABELS), this harness gives each
// Gemma agent REAL tools — read/write files and run commands, all jailed to one
// workspace folder — and runs an OpenAI tool-calling loop so the agents actually
// build software. Every real tool call emits the same office events runner.mjs does,
// so the 3D office visualizes genuine work (write→typing, read→reading, run→bash).
//
// Flow: 총괄 plans (submit_plan) → 아키텍트/백엔드/프론트엔드 implement in parallel
//       → 테스터 runs tests & fixes → 총괄 writes SUMMARY.md.
//
// Run:  npm run coder            (key + model from .env / Desktop/openR.env)
//   or  TASK="build X" WORKSPACE_DIR=/path node scripts/gemma-agents/coder.mjs
//   self-check (no API): node scripts/gemma-agents/coder.mjs --selftest
//
// Env: OPENROUTER_API_KEY (or scripts/gemma-agents/.env, or ~/Desktop/openR.env bare key)
//      GEMMA_MODEL (default google/gemma-4-26b-a4b-it)
//      TASK (what to build)   WORKSPACE_DIR (default ~/Desktop/gemma-workspace)
//      PORT (7777)   ALLOW_RUN (1)   MAX_STEPS (14)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(os.homedir(), 'Desktop');

// ── key + config ─────────────────────────────────────────────────────────────
// Load NAME=value lines from scripts/.env first (model/agents/port live there).
for (const line of readLines(path.join(HERE, '.env'))) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
function readLines(p) {
  try {
    return fs
      .readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#'));
  } catch {
    return [];
  }
}
// Key: env → scripts/.env (already applied above) → Desktop/openR.env (bare key file).
function loadKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const raw = fs.readFileSync(path.join(DESKTOP, 'openR.env'), 'utf8').trim();
    if (raw.includes('='))
      return (raw.match(/OPENROUTER_API_KEY\s*=\s*(.+)/)?.[1] ?? '')
        .trim()
        .replace(/^["']|["']$/g, '');
    if (raw.startsWith('sk-or-')) return raw; // bare key
  } catch {
    /* none */
  }
  return undefined;
}

const KEY = loadKey();
const MODEL = process.env.GEMMA_MODEL || 'google/gemma-4-26b-a4b-it';
const PORT = Number(process.env.PORT || 7777);
let WORKSPACE = path.resolve(process.env.WORKSPACE_DIR || path.join(DESKTOP, 'gemma-workspace'));
const ALLOW_RUN = process.env.ALLOW_RUN !== '0';
const MAX_STEPS = Math.max(4, Number(process.env.MAX_STEPS || 14));
const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS || 60000);
const TASK =
  process.env.TASK ||
  '간단한 Node.js CLI 할 일 관리 앱(todo)을 만든다: add/list/done 명령, JSON 파일에 저장, README와 최소 테스트 포함.';

// Catastrophic command guard (run_cmd is real shell exec — keep the obvious feet-guns out).
const DENY =
  /\brm\s+-rf\s+[~/]|\brmdir\s+\/s|\bdel\s+\/[sq]|format\s|mkfs|shutdown|reboot|:\(\)\s*\{|curl[^|]*\|\s*(sh|bash)|>\s*\/dev\/sd/i;

// ── workspace jail ───────────────────────────────────────────────────────────
function jail(p) {
  const resolved = path.resolve(WORKSPACE, p || '.');
  const rel = path.relative(WORKSPACE, resolved);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return resolved;
}
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n…(${s.length - n} more chars)` : s);

// Serialize writes so concurrent agents never interleave on the same file.
let writeChain = Promise.resolve();
function writeMutex(fn) {
  const p = writeChain.then(fn);
  writeChain = p.catch(() => {});
  return p;
}

// ── tools (executed in Node, jailed to WORKSPACE) ────────────────────────────
const FILE_TOOLS = [
  tool(
    'read_file',
    'Read a UTF-8 text file in the workspace.',
    { path: str('relative file path') },
    ['path'],
  ),
  tool(
    'list_dir',
    'List files/dirs under a workspace path (default ".").',
    { path: str('relative dir path') },
    [],
  ),
  tool(
    'write_file',
    'Create or overwrite a UTF-8 text file in the workspace.',
    { path: str('relative file path'), content: str('full file contents') },
    ['path', 'content'],
  ),
  tool(
    'run_cmd',
    'Run a shell command in the workspace (install deps, run tests, build).',
    { cmd: str('shell command') },
    ['cmd'],
  ),
  tool(
    'finish',
    'Call when your assigned task is complete.',
    { summary: str('what you accomplished') },
    ['summary'],
  ),
];
const PLAN_TOOL = tool(
  'submit_plan',
  'Submit the work breakdown for the team.',
  {
    subtasks: {
      type: 'array',
      description: '2–5 file-scoped subtasks',
      items: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            enum: ['아키텍트', '백엔드', '프론트엔드'],
            description: 'which teammate does this',
          },
          title: str('short title'),
          files: {
            type: 'array',
            items: { type: 'string' },
            description: 'files this subtask owns',
          },
          detail: str('concrete instructions'),
        },
        required: ['role', 'title', 'detail'],
      },
    },
  },
  ['subtasks'],
);
function tool(name, description, props, required) {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties: props, required } },
  };
}
function str(description) {
  return { type: 'string', description };
}

async function executeTool(name, args) {
  try {
    if (name === 'read_file') return clip(fs.readFileSync(jail(args.path), 'utf8'), 8000);
    if (name === 'list_dir') {
      const dp = jail(args.path || '.');
      if (!fs.existsSync(dp)) return '(missing)';
      return (
        fs
          .readdirSync(dp, { withFileTypes: true })
          .map((d) => (d.isDirectory() ? d.name + '/' : d.name))
          .join('\n') || '(empty)'
      );
    }
    if (name === 'write_file') {
      const fp = jail(args.path);
      await writeMutex(() => {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, args.content ?? '');
      });
      return `wrote ${args.path} (${(args.content ?? '').length} bytes)`;
    }
    if (name === 'run_cmd') {
      if (!ALLOW_RUN) return 'run_cmd disabled (set ALLOW_RUN=1)';
      if (DENY.test(args.cmd || '')) return 'refused: command matches deny-list';
      try {
        const out = execSync(args.cmd, {
          cwd: WORKSPACE,
          timeout: RUN_TIMEOUT_MS,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return clip(out || '(no output)', 4000);
      } catch (e) {
        return clip(
          `exit ${e.status ?? '?'}\n${e.stdout ?? ''}\n${e.stderr ?? e.message ?? ''}`,
          4000,
        );
      }
    }
    if (name === 'finish') return `FINISH: ${args.summary ?? ''}`;
    return `unknown tool ${name}`;
  } catch (e) {
    return `error: ${e.message}`.slice(0, 500);
  }
}

// Map a tool call to the office's animation vocabulary + a Korean status label.
function toolType(name) {
  return name === 'read_file' || name === 'list_dir'
    ? 'Read'
    : name === 'run_cmd'
      ? 'Bash'
      : 'Edit';
}
function label(name, a) {
  if (name === 'read_file') return `${a.path ?? ''} 읽는 중`;
  if (name === 'list_dir') return `${a.path ?? '.'} 살펴보는 중`;
  if (name === 'write_file') return `${a.path ?? ''} 작성하는 중`;
  if (name === 'run_cmd') return `${(a.cmd ?? '').slice(0, 28)} 실행하는 중`;
  if (name === 'submit_plan') return `작업 분배하는 중`;
  if (name === 'finish') return `마무리하는 중`;
  return `${name} 하는 중`;
}

// ── OpenRouter chat ──────────────────────────────────────────────────────────
async function chat(messages, tools) {
  const body = { model: MODEL, max_tokens: 1200, temperature: 0.3, messages };
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.warn(
      `[coder] OpenRouter ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`,
    );
    return null;
  }
  return (await r.json()).choices?.[0]?.message ?? null;
}
const safeParse = (s) => {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
};

// ── roles + SSE office bus (same event shapes as runner.mjs) ──────────────────
const TEAM_NAME = 'Gemma 개발팀';
const ROLES = [
  { id: 1, name: '총괄', lead: true },
  { id: 2, name: '아키텍트', lead: false },
  { id: 3, name: '백엔드', lead: false },
  { id: 4, name: '프론트엔드', lead: false },
  { id: 5, name: '리뷰어', lead: false },
  { id: 6, name: '테스터', lead: false },
  { id: 7, name: '데브옵스', lead: false },
];
const roleById = (id) => ROLES.find((r) => r.id === id);
const idByName = (name) => ROLES.find((r) => r.name === name)?.id;
const teamInfoFor = (id) => ({
  type: 'agentTeamInfo',
  id,
  teamName: TEAM_NAME,
  agentName: roleById(id).name,
  isTeamLead: roleById(id).lead,
  leadAgentId: 1,
  teamUsesTmux: false,
});

const clients = new Set();
const liveAgents = new Set();
let running = true;
let seq = 0;

function send(res, msg) {
  res.write(`data: ${JSON.stringify(msg)}\n\n`);
}
function broadcast(msg) {
  for (const res of clients) send(res, msg);
}
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
    return res.end('ok');
  }
  if (req.url !== '/events') {
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
  for (const id of liveAgents) {
    send(res, { type: 'agentCreated', id });
    send(res, teamInfoFor(id));
  }
  req.on('close', () => clients.delete(res));
});

// ── agent tool-loop ──────────────────────────────────────────────────────────
function agentSystem(roleName) {
  return [
    `너는 소프트웨어 팀의 "${roleName}" 담당 AI 엔지니어다.`,
    `작업 폴더(워크스페이스) 안에서만 도구로 파일을 읽고/쓰고, 필요하면 명령을 실행해 실제로 코드를 만든다.`,
    `경로는 항상 워크스페이스 기준 상대경로로. 다 끝내면 반드시 finish를 호출한다.`,
    `간결하게 행동으로 답하고, 한 번에 하나의 도구를 호출한다.`,
  ].join(' ');
}

async function runAgentTask(id, taskText, tools = FILE_TOOLS) {
  const role = roleById(id);
  const messages = [
    { role: 'system', content: agentSystem(role.name) },
    { role: 'user', content: taskText },
  ];
  for (let step = 0; step < MAX_STEPS && running; step++) {
    const msg = await chat(messages, tools);
    if (!msg) break;
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) break; // model answered with text → treat as done
    let finished = false;
    for (const c of calls) {
      const args = safeParse(c.function.arguments);
      const toolId = `coder-${id}-${++seq}`;
      broadcast({
        type: 'agentToolStart',
        id,
        toolId,
        status: label(c.function.name, args),
        toolName: toolType(c.function.name),
      });
      const result = await executeTool(c.function.name, args);
      broadcast({ type: 'agentToolDone', id, toolId });
      messages.push({ role: 'tool', tool_call_id: c.id, content: String(result) });
      if (c.function.name === 'finish') finished = true;
    }
    if (finished) break;
  }
  broadcast({ type: 'agentToolsClear', id });
  broadcast({ type: 'agentStatus', id, status: 'waiting', awaitingInput: false });
}

// Agents with no task this phase: idle in the office so they wander.
function idle(id) {
  broadcast({ type: 'agentToolsClear', id });
  broadcast({ type: 'agentStatus', id, status: 'waiting', awaitingInput: false });
}

// ── orchestration ────────────────────────────────────────────────────────────
// 총괄 produces file-scoped subtasks via the submit_plan tool. Shared by the full
// run and --dry-plan.
async function plan() {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  const ls = await executeTool('list_dir', { path: '.' });
  const planMsg = await chat(
    [
      {
        role: 'system',
        content: `너는 개발팀 "총괄"이다. 아래 작업을 아키텍트/백엔드/프론트엔드가 병렬로 진행하도록 2~5개의 파일 단위 서브태스크로 나눠 submit_plan으로 제출하라. 서브태스크끼리 같은 파일을 건드리지 않게 분담하라.`,
      },
      { role: 'user', content: `작업: ${TASK}\n\n현재 워크스페이스 파일:\n${ls}` },
    ],
    [PLAN_TOOL],
  );
  const planCall = (planMsg?.tool_calls || []).find((c) => c.function.name === 'submit_plan');
  const subtasks = planCall ? safeParse(planCall.function.arguments).subtasks : null;
  if (!Array.isArray(subtasks) || !subtasks.length) {
    console.warn('[coder] no plan returned — falling back to single 백엔드 subtask');
    return [{ role: '백엔드', title: '전체 구현', detail: TASK, files: [] }];
  }
  return subtasks;
}

async function orchestrate() {
  for (const r of ROLES) {
    liveAgents.add(r.id);
    broadcast({ type: 'agentCreated', id: r.id });
    broadcast(teamInfoFor(r.id));
  }
  ROLES.forEach((r) => r.id !== 1 && idle(r.id));

  // PLAN (총괄 character types while planning).
  console.log(`[coder] planning task in ${WORKSPACE}`);
  const planToolId = `coder-1-${++seq}`;
  broadcast({
    type: 'agentToolStart',
    id: 1,
    toolId: planToolId,
    status: '작업 분배하는 중',
    toolName: 'Edit',
  });
  const subtasks = await plan();
  broadcast({ type: 'agentToolDone', id: 1, toolId: planToolId });
  console.log(`[coder] plan: ${subtasks.map((s) => `${s.role}:${s.title}`).join(' | ')}`);
  broadcast({ type: 'agentToolsClear', id: 1 });

  // BUILD — each subtask runs on its role's character, in parallel.
  let nextWorker = 2; // round-robin if a role repeats / is unknown
  await Promise.all(
    subtasks.map((s) => {
      let id = idByName(s.role);
      if (!id || id === 1) id = ((nextWorker++ - 2) % 3) + 2;
      const taskText = `작업: ${TASK}\n\n너의 서브태스크: ${s.title}\n상세: ${s.detail}\n담당 파일: ${(s.files || []).join(', ') || '자유'}\n워크스페이스에서 실제로 파일을 만들어라.`;
      return runAgentTask(id, taskText);
    }),
  );

  // VERIFY — 테스터 runs/builds and fixes; 데브옵스 idles unless needed.
  console.log('[coder] verifying');
  await runAgentTask(
    idByName('테스터'),
    `작업: ${TASK}\n\n워크스페이스에 만들어진 코드를 확인하라. package.json이 있으면 \`npm install\` 후 \`npm test\`(없으면 \`node\`로 직접 실행)로 동작을 검증하고, 실패하면 파일을 고쳐라. 끝나면 finish.`,
  );

  // SUMMARY — 총괄 writes SUMMARY.md.
  await runAgentTask(
    1,
    `작업: ${TASK}\n\n팀이 워크스페이스에 만든 결과물을 list_dir/read_file로 확인하고, 무엇이 만들어졌는지 한국어로 SUMMARY.md에 정리해 write_file로 저장한 뒤 finish.`,
  );

  console.log(`[coder] done. Workspace: ${WORKSPACE}`);
  console.log('[coder] office stays live (Ctrl+C to exit).');
}

// ── self-check (no API): exercise the real tool executors + jail in a temp dir ─
async function selftest() {
  WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-selftest-'));
  const w = await executeTool('write_file', { path: 'src/a.txt', content: 'hello' });
  console.assert(/wrote src[\\/]a\.txt/.test(w), 'write_file: ' + w);
  console.assert(
    (await executeTool('read_file', { path: 'src/a.txt' })) === 'hello',
    'read_file roundtrip',
  );
  console.assert((await executeTool('list_dir', { path: 'src' })) === 'a.txt', 'list_dir');
  console.assert(
    /escapes workspace/.test(await executeTool('read_file', { path: '../../etc/passwd' })),
    'jail blocks escape',
  );
  console.assert(
    /deny-list/.test(await executeTool('run_cmd', { cmd: 'rm -rf ~/' })),
    'deny-list blocks rm -rf ~',
  );
  console.assert(DENY.test('rm -rf ~/') && !DENY.test('npm test'), 'deny-list precision');
  console.assert(
    toolType('write_file') === 'Edit' &&
      toolType('read_file') === 'Read' &&
      toolType('run_cmd') === 'Bash',
    'tool→anim map',
  );
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  console.log('selftest: OK');
}

// ── entry ────────────────────────────────────────────────────────────────────
if (process.argv.includes('--selftest')) {
  await selftest();
  process.exit(0);
}
if (!KEY) {
  console.error(
    '[coder] OPENROUTER_API_KEY not found (env, scripts/gemma-agents/.env, or ~/Desktop/openR.env).',
  );
  process.exit(1);
}
// --dry-plan: one cheap planning call against a throwaway workspace, print the
// subtasks, exit. No office server, no file builds — just proves the pipeline.
if (process.argv.includes('--dry-plan')) {
  WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-dryplan-'));
  console.log(`[coder] dry-plan  model=${MODEL}  key=${KEY.slice(0, 8)}…`);
  const subtasks = await plan();
  for (const s of subtasks)
    console.log(`  • ${s.role}: ${s.title} — files=[${(s.files || []).join(', ')}]`);
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  process.exit(0);
}
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[coder] model=${MODEL}  workspace=${WORKSPACE}`);
  console.log(`[coder] SSE on http://127.0.0.1:${PORT}/events — open localhost:5173 and toggle 3D`);
  orchestrate().catch((e) => console.error('[coder] fatal:', e));
});

function shutdown() {
  running = false;
  for (const id of liveAgents) broadcast({ type: 'agentClosed', id });
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
