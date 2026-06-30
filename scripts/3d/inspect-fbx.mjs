/**
 * Part A — FBX asset inspector / validator.
 *
 * Parses the Mixamo FBX assets through the SAME loader the 3D renderer uses
 * (three FBXLoader) and reports the facts that B's `officeRenderer3d.ts`
 * silently assumes:
 *   1. each animation file exposes animations[0]          (else the clip is undefined → freeze)
 *   2. walking is IN-PLACE (no Hips XZ root motion)        (else the avatar slides off its tile)
 *   3. animation bone/track names match Remy's skeleton    (else AnimationMixer can't bind)
 *
 * Pure Node, no extra deps — imports three from the repo's hoisted node_modules.
 * Run:  node scripts/3d/inspect-fbx.mjs
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// --- headless shims so FBXLoader.parse() runs without a DOM ---
// Remy.fbx carries embedded textures; three's texture/image path touches
// window/document. We only need geometry+skeleton+animations, so neutralise
// texture loading at the three prototype level (no DOM access, no throw).
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => 'blob:stub'; // parseImage() embedded-texture blobs
  globalThis.URL.revokeObjectURL = () => {};
}
const THREE = await import('three');
THREE.ImageLoader.prototype.load = function () {
  return {};
};
THREE.TextureLoader.prototype.load = function () {
  return new THREE.Texture();
};

const { FBXLoader } = await import('../../node_modules/three/examples/jsm/loaders/FBXLoader.js');

const here = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = join(here, '..', '..', 'webview-ui', 'public', 'assets', 'characters3d');

const FILES = {
  Remy: 'Remy.fbx', // skinned character template (mesh + skeleton)
  idle: 'idle.fbx',
  walking: 'walking.fbx',
  typing: 'typing.fbx',
};

/** Parse one FBX via three's loader, tolerating texture-creation failures. */
function parseFbx(path) {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new FBXLoader();
  return loader.parse(ab, path);
}

/** Collect bone names from a parsed object's first SkinnedMesh, or all Bone nodes. */
function collectBones(obj) {
  const fromSkin = [];
  const fromBoneNodes = new Set();
  obj.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) {
      for (const b of o.skeleton.bones) fromSkin.push(b.name);
    }
    if (o.isBone) fromBoneNodes.add(o.name);
  });
  return { fromSkin, fromBoneNodes: [...fromBoneNodes] };
}

/** Analyse a position track: per-axis min/max/range + net displacement. */
function analysePositionTrack(track) {
  const v = track.values; // [x,y,z, x,y,z, ...]
  const n = v.length / 3;
  const stat = (off) => {
    let min = Infinity,
      max = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = v[i * 3 + off];
      if (x < min) min = x;
      if (x > max) max = x;
    }
    return { min, max, range: max - min, net: v[(n - 1) * 3 + off] - v[off] };
  };
  return { frames: n, x: stat(0), y: stat(1), z: stat(2) };
}

const report = { assetDir: ASSET_DIR, files: {}, problems: [] };
const round = (x) => Math.round(x * 100) / 100;

for (const [key, file] of Object.entries(FILES)) {
  const path = join(ASSET_DIR, file);
  const entry = { file, exists: existsSync(path) };
  report.files[key] = entry;
  if (!entry.exists) {
    report.problems.push(`MISSING FILE: ${file}`);
    continue;
  }
  let obj;
  try {
    obj = parseFbx(path);
  } catch (e) {
    entry.parseError = String(e && e.message ? e.message : e);
    report.problems.push(`PARSE FAILED (${file}): ${entry.parseError}`);
    continue;
  }

  const anims = obj.animations ?? [];
  entry.animationCount = anims.length;

  // Skeleton / bone inventory
  const bones = collectBones(obj);
  entry.skinnedBoneCount = bones.fromSkin.length;
  entry.boneNodeCount = bones.fromBoneNodes.length;
  entry.sampleBones = (bones.fromSkin.length ? bones.fromSkin : bones.fromBoneNodes).slice(0, 6);

  // Character template must carry a usable skeleton
  if (key === 'Remy' && bones.fromSkin.length === 0 && bones.fromBoneNodes.length === 0) {
    report.problems.push('Remy.fbx has NO skeleton/bones — cannot animate.');
  }

  // Animation files must expose animations[0]
  if (key !== 'Remy' && anims.length === 0) {
    report.problems.push(
      `${file}: animations[0] MISSING — B's STATE_CLIP['${key}'] will be undefined → freeze.`,
    );
  }

  if (anims.length > 0) {
    const clip = anims[0];
    entry.clip = {
      name: clip.name,
      duration: round(clip.duration),
      trackCount: clip.tracks.length,
    };
    // Track-name prefix sanity (Mixamo uses "mixamorig:")
    const trackNames = clip.tracks.map((t) => t.name);
    entry.clip.sampleTracks = trackNames.slice(0, 4);
    entry.clip.prefixes = [
      ...new Set(trackNames.map((n) => n.split(':')[0]).map((n) => n.split('.')[0])),
    ].slice(0, 4);

    // Root-motion check on the Hips position track
    const hips = clip.tracks.find(
      (t) => /Hips\.position$/i.test(t.name) || /Hips$/i.test(t.name.replace(/\.position$/i, '')),
    );
    const posHips = clip.tracks.find((t) => /Hips/i.test(t.name) && /\.position$/i.test(t.name));
    const target = posHips ?? hips;
    if (target && /\.position$/i.test(target.name)) {
      const a = analysePositionTrack(target);
      entry.hips = {
        track: target.name,
        frames: a.frames,
        xRange: round(a.x.range),
        xNet: round(a.x.net),
        yRange: round(a.y.range),
        yNet: round(a.y.net),
        zRange: round(a.z.range),
        zNet: round(a.z.net),
      };
      // Heuristic: in-place ⇒ tiny net horizontal travel. Compare to bob (yRange)
      // and to character native height (~bone span). Use absolute thresholds in
      // Mixamo native cm units: net horizontal > ~5 units across one loop = root motion.
      const horizNet = Math.hypot(a.x.net, a.z.net);
      const horizRange = Math.hypot(a.x.range, a.z.range);
      entry.hips.horizNet = round(horizNet);
      entry.hips.horizRange = round(horizRange);
      if (key === 'walking' && (horizNet > 5 || horizRange > 30)) {
        report.problems.push(
          `walking.fbx is NOT in-place: Hips horizontal net=${round(horizNet)} range=${round(horizRange)} ` +
            `(z net=${round(a.z.net)}). Avatar will slide. Re-export from Mixamo with "In Place" checked, ` +
            `or strip the Hips XZ translation track.`,
        );
        entry.hips.inPlace = false;
      } else {
        entry.hips.inPlace = true;
      }
    } else {
      entry.hips = {
        note: 'no Hips position track found (likely already in-place / no root track)',
      };
    }
  }
}

// Cross-file bone compatibility: animation track bones ⊆ Remy skeleton bones?
const remyBones = new Set(
  report.files.Remy?.exists ? collectBonesSafe(join(ASSET_DIR, FILES.Remy)) : [],
);
function collectBonesSafe(path) {
  try {
    const o = parseFbx(path);
    const b = collectBones(o);
    return b.fromSkin.length ? b.fromSkin : b.fromBoneNodes;
  } catch {
    return [];
  }
}
if (remyBones.size > 0) {
  for (const key of ['idle', 'walking', 'typing']) {
    const f = report.files[key];
    if (!f?.clip) continue;
    try {
      const o = parseFbx(join(ASSET_DIR, FILES[key]));
      const clip = o.animations[0];
      const animBones = new Set(
        clip.tracks.map((t) => t.name.replace(/\.(position|quaternion|scale)$/i, '')),
      );
      const missing = [...animBones].filter((b) => !remyBones.has(b));
      f.boneCompat = {
        animBoneCount: animBones.size,
        remyBoneCount: remyBones.size,
        missingInRemy: missing.slice(0, 8),
        compatible: missing.length === 0,
      };
      if (missing.length > 0) {
        report.problems.push(
          `${FILES[key]}: ${missing.length} animated bones not found in Remy skeleton (e.g. ${missing.slice(0, 3).join(', ')}). ` +
            `AnimationMixer can't bind these — clip may not drive the avatar.`,
        );
      }
    } catch (e) {
      f.boneCompat = { error: String(e?.message ?? e) };
    }
  }
}

report.ok = report.problems.length === 0;
const outPath = join(here, 'fbx-report.json');
writeFileSync(outPath, JSON.stringify(report, null, 2));

// --- console summary ---
console.log('\n=== FBX INSPECTION REPORT ===');
console.log('asset dir:', ASSET_DIR);
for (const [key, e] of Object.entries(report.files)) {
  console.log(`\n[${key}] ${e.file}  exists=${e.exists}`);
  if (e.parseError) {
    console.log('  parseError:', e.parseError);
    continue;
  }
  if (e.animationCount !== undefined) console.log('  animations:', e.animationCount);
  if (e.skinnedBoneCount !== undefined)
    console.log(
      '  bones (skin/nodes):',
      e.skinnedBoneCount,
      '/',
      e.boneNodeCount,
      '  sample:',
      e.sampleBones?.join(', '),
    );
  if (e.clip) console.log('  clip[0]:', JSON.stringify(e.clip));
  if (e.hips) console.log('  hips:', JSON.stringify(e.hips));
  if (e.boneCompat) console.log('  boneCompat:', JSON.stringify(e.boneCompat));
}
console.log('\n--- PROBLEMS ---');
if (report.problems.length === 0) console.log("  none — assets satisfy B's loader assumptions.");
else report.problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
console.log('\nfull report →', outPath);
console.log('OVERALL:', report.ok ? 'PASS' : 'FAIL');
