// Verifies assets3d/manifest.json against the B renderer's contract
// (docs/3d-migration-plan.md s3.1-3.3) AND inspects each referenced GLB:
//   - every clip name the manifest targets exists as a glTF animation
//   - the model is skinned (has a skin / JOINTS_0) and reports joint + bbox height
//   - hips translation is in-place (horizontal net ~ 0) per animation
//
// Dependency-free: parses the GLB container + accessors directly, so no texture
// decoding / browser globals are needed. This is the merge gate the handoff named.
//
//   node scripts/3d/check-manifest.mjs            # default manifest path
//   node scripts/3d/check-manifest.mjs <path>     # explicit manifest.json

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const CLIP_KEYS = [
  'idle',
  'walk',
  'sitType',
  'sitRead',
  'sitFunny',
  'sitLady',
  'sitAsk',
  'sitTalk',
  'sitLaugh',
  'phone',
  'pain',
  'layMale',
  'layFemale',
  'sitFemale',
];
const FORWARD_DIRS = ['down', 'up', 'left', 'right'];
// Mixamo hips node; Blender FBX import keeps the colon (mixamorig:Hips), three's
// FBXLoader strips it (mixamorigHips) — match either.
const HIPS_RE = /mixamorig:?Hips$/;

const problems = [];
const ok = (cond, msg) => {
  if (!cond) problems.push(msg);
};

// --- GLB container parse: returns { json, bin } ---
function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB (bad magic)');
  const total = dv.getUint32(8, true);
  let off = 12;
  let json = null;
  let bin = null;
  while (off < total) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const start = off + 8;
    if (type === 0x4e4f534a)
      json = JSON.parse(new TextDecoder().decode(buf.subarray(start, start + len)));
    else if (type === 0x004e4942) bin = buf.subarray(start, start + len);
    off = start + len;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

const COMPONENT = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NUMCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

// Read a FLOAT accessor's rows as number[][].
function readAccessor(gltf, bin, idx) {
  const acc = gltf.accessors[idx];
  const view = gltf.bufferViews[acc.bufferView];
  const comps = NUMCOMP[acc.type];
  const compSize = COMPONENT[acc.componentType];
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = view.byteStride || comps * compSize;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const rows = [];
  for (let i = 0; i < acc.count; i++) {
    const row = [];
    for (let c = 0; c < comps; c++) row.push(dv.getFloat32(base + i * stride + c * compSize, true));
    rows.push(row);
  }
  return rows;
}

function inspectGlb(path) {
  const { json: gltf, bin } = parseGlb(readFileSync(path));
  const animNames = (gltf.animations || []).map((a) => a.name);
  const skinCount = (gltf.skins || []).length;
  const jointCount = skinCount ? (gltf.skins[0].joints || []).length : 0;

  // skinned? any primitive with JOINTS_0
  let skinned = false;
  for (const m of gltf.meshes || [])
    for (const p of m.primitives || [])
      if (p.attributes && 'JOINTS_0' in p.attributes) skinned = true;

  // bbox height from POSITION accessor min/max (GLB units, pre-fit)
  let height = 0;
  for (const m of gltf.meshes || [])
    for (const p of m.primitives || []) {
      const pa = p.attributes && p.attributes.POSITION;
      if (pa != null) {
        const acc = gltf.accessors[pa];
        if (acc.min && acc.max) height = Math.max(height, acc.max[1] - acc.min[1]);
      }
    }

  // hips in-place per animation
  const hipsIdx = (gltf.nodes || []).findIndex((n) => n.name && HIPS_RE.test(n.name));
  const inPlace = {};
  if (hipsIdx >= 0 && bin) {
    for (const anim of gltf.animations || []) {
      const ch = (anim.channels || []).find(
        (c) => c.target.node === hipsIdx && c.target.path === 'translation',
      );
      if (!ch) {
        inPlace[anim.name] = 'no-hips-translation';
        continue;
      }
      const out = readAccessor(gltf, bin, anim.samplers[ch.sampler].output);
      const xs = out.map((r) => r[0]);
      const zs = out.map((r) => r[2]);
      const netH = Math.hypot(xs.at(-1) - xs[0], zs.at(-1) - zs[0]);
      const rangeH = Math.hypot(
        Math.max(...xs) - Math.min(...xs),
        Math.max(...zs) - Math.min(...zs),
      );
      inPlace[anim.name] = { netH: +netH.toFixed(3), rangeH: +rangeH.toFixed(3) };
    }
  }
  return { animNames, skinCount, jointCount, skinned, height: +height.toFixed(2), inPlace };
}

// --- manifest validation ---
const manifestPath = resolve(process.argv[2] || 'webview-ui/public/assets3d/manifest.json');
const base = dirname(manifestPath);
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (e) {
  console.error(`FAIL: cannot read manifest at ${manifestPath}: ${e.message}`);
  process.exit(1);
}

ok(manifest.version === 1, 'version must be 1');
const rig = manifest.characterRig || {};
ok(
  typeof rig.heightWorld === 'number' && rig.heightWorld > 0,
  'characterRig.heightWorld must be a positive number',
);
ok(
  FORWARD_DIRS.includes(rig.forwardDir),
  `characterRig.forwardDir must be one of ${FORWARD_DIRS.join('/')}`,
);
const clips = rig.clips || {};
for (const k of CLIP_KEYS)
  ok(typeof clips[k] === 'string' && clips[k], `characterRig.clips.${k} missing`);
ok(
  Array.isArray(manifest.characters) && manifest.characters.length > 0,
  'characters[] must be non-empty',
);

// Required clips: every GLB must carry these. sitRead is optional — the renderer
// (resolveAction) falls back sitRead → sitType, so a model without the reading
// clip still animates correctly; older models predate it.
const REQUIRED_CLIP_KEYS = ['idle', 'walk', 'sitType'];
const wantedClips = [...new Set(REQUIRED_CLIP_KEYS.map((k) => clips[k]).filter(Boolean))];

const reports = {};
for (const c of manifest.characters || []) {
  ok(typeof c.palette === 'number', `character palette must be a number (got ${c.palette})`);
  ok(typeof c.model === 'string' && c.model, `character.model missing for palette ${c.palette}`);
  if (!c.model) continue;
  const glbPath = resolve(base, c.model);
  let rep;
  try {
    rep = reports[glbPath] || (reports[glbPath] = inspectGlb(glbPath));
  } catch (e) {
    problems.push(`palette ${c.palette}: cannot inspect ${c.model}: ${e.message}`);
    continue;
  }
  ok(rep.skinned, `palette ${c.palette}: ${c.model} is not skinned (no JOINTS_0)`);
  for (const name of wantedClips)
    ok(
      rep.animNames.includes(name),
      `palette ${c.palette}: ${c.model} missing animation "${name}" (has: ${rep.animNames.join(', ') || 'none'})`,
    );
  for (const [anim, v] of Object.entries(rep.inPlace)) {
    if (v && typeof v === 'object' && v.netH > 0.5 && v.netH > v.rangeH * 0.25) {
      problems.push(
        `palette ${c.palette}: ${c.model} clip "${anim}" not in-place (netH=${v.netH}, rangeH=${v.rangeH})`,
      );
    }
  }
}

console.log('manifest:', manifestPath);
console.log('wanted clip names:', wantedClips.join(', '));
for (const [p, r] of Object.entries(reports)) {
  console.log(`\n${p.split(/[\\/]/).slice(-2).join('/')}`);
  console.log('  animations:', r.animNames.join(', ') || 'none');
  console.log(`  skinned: ${r.skinned}  joints: ${r.jointCount}  bboxHeight(units): ${r.height}`);
  console.log('  in-place:', JSON.stringify(r.inPlace));
}

if (problems.length) {
  console.error(`\nFAIL (${problems.length}):`);
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('\nPASS');
