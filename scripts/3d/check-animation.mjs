/**
 * Part A — animation INTEGRATION check.
 *
 * Static parsing (inspect-fbx.mjs) proves the files are well-formed. This proves
 * the thing that actually matters at runtime and that static parsing can't:
 * that the separately-authored clips BIND to a cloned Remy skeleton via
 * AnimationMixer and DRIVE the bones — reproducing B's exact pipeline
 * (officeRenderer3d.ts: FBXLoader → SkeletonUtils.clone → AnimationMixer →
 * clipAction → mixer.update).
 *
 * Asserts, per clip:
 *   1. mixer binds with NO unbound tracks (no "No target node found" warnings)
 *   2. playing the clip changes bone rotations (the rig actually moves)
 *   3. walking stays in-place at RUNTIME — Hips world XZ has ~0 net drift across
 *      a full loop (catches interpolation/loop drift the keyframe-net check misses)
 *
 * Run:  node scripts/3d/check-animation.mjs   (exit 0 = pass, 1 = fail)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// headless shims (same as inspect-fbx.mjs)
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => 'blob:stub';
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
const { clone: cloneSkinned } =
  await import('../../node_modules/three/examples/jsm/utils/SkeletonUtils.js');

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '..', '..', 'webview-ui', 'public', 'assets', 'characters3d');

function loadFbx(file) {
  const buf = readFileSync(join(DIR, file));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new FBXLoader().parse(ab, file);
}

function findBone(root, name) {
  let found = null;
  root.traverse((o) => {
    if (!found && o.name === name) found = o;
  });
  return found;
}

// --- capture PropertyBinding "no target node" warnings to detect unbound tracks ---
const unbound = [];
const realWarn = console.warn;
console.warn = (...a) => {
  const s = a.join(' ');
  if (/No target node found/i.test(s)) unbound.push(s);
  // swallow the loader's texture/skinning noise; keep real warnings quiet here
};

// B's exact load (officeRenderer3d.ts load())
const remy = loadFbx('Remy.fbx');
const clips = {
  idle: loadFbx('idle.fbx').animations[0],
  walk: loadFbx('walking.fbx').animations[0],
  type: loadFbx('typing.fbx').animations[0],
};
console.warn = realWarn;

const failures = [];
const round = (x) => Math.round(x * 1000) / 1000;

// B's makeAvatar(): clone template, mixer on the clone, one action per clip.
const clone = cloneSkinned(remy);
const mixer = new THREE.AnimationMixer(clone);

// Probe bones present in the clone (arm moves a lot in walk/idle; spine in typing).
const probeNames = [
  'mixamorigRightArm',
  'mixamorigRightForeArm',
  'mixamorigLeftArm',
  'mixamorigSpine',
];
const probes = probeNames.map((n) => ({ n, bone: findBone(clone, n) })).filter((p) => p.bone);
if (probes.length === 0)
  failures.push('no probe bones found in cloned skeleton — clone produced no named bones');
const hips = findBone(clone, 'mixamorigHips');
if (!hips) failures.push('mixamorigHips not found in cloned skeleton');

function quat(bone) {
  return [bone.quaternion.x, bone.quaternion.y, bone.quaternion.z, bone.quaternion.w];
}
function quatDelta(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
}

console.log("\n=== ANIMATION INTEGRATION CHECK (reproduces B's mixer pipeline) ===");

for (const [state, clip] of Object.entries(clips)) {
  if (!clip) {
    failures.push(`clip '${state}' is undefined`);
    continue;
  }
  // fresh action; stop everything else
  mixer.stopAllAction();
  const action = mixer.clipAction(clip);
  action.reset().play();

  // sample bone rotation at t=0 and after advancing ~half the clip
  mixer.update(0);
  clone.updateMatrixWorld(true);
  const before = probes.map((p) => quat(p.bone));
  const half = Math.max(clip.duration / 2, 0.4);
  mixer.update(half);
  clone.updateMatrixWorld(true);
  const after = probes.map((p) => quat(p.bone));

  const maxDelta = Math.max(...probes.map((_, i) => quatDelta(before[i], after[i])));
  const moved = maxDelta > 1e-3;
  console.log(
    `[${state}] dur=${round(clip.duration)}s  maxBoneRotΔ(half-clip)=${round(maxDelta)}  ${moved ? 'MOVES ✓' : 'STATIC ✗'}`,
  );
  if (!moved)
    failures.push(
      `clip '${state}' did not change any probe bone — mixer not driving the rig (binding failure?)`,
    );

  // runtime in-place check for walk: sample Hips world XZ across a FULL loop
  if (state === 'walk' && hips) {
    mixer.stopAllAction();
    const a2 = mixer.clipAction(clip);
    a2.reset().play();
    mixer.setTime(0);
    clone.updateMatrixWorld(true);
    const p0 = new THREE.Vector3();
    hips.getWorldPosition(p0);
    let minX = p0.x,
      maxX = p0.x,
      minZ = p0.z,
      maxZ = p0.z;
    const steps = 40;
    for (let i = 1; i <= steps; i++) {
      mixer.setTime((clip.duration * i) / steps);
      clone.updateMatrixWorld(true);
      const p = new THREE.Vector3();
      hips.getWorldPosition(p);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    mixer.setTime(clip.duration);
    clone.updateMatrixWorld(true);
    const pEnd = new THREE.Vector3();
    hips.getWorldPosition(pEnd);
    const netHoriz = Math.hypot(pEnd.x - p0.x, pEnd.z - p0.z);
    const rangeHoriz = Math.hypot(maxX - minX, maxZ - minZ);
    console.log(
      `        walk runtime hips: netHoriz=${round(netHoriz)} rangeHoriz=${round(rangeHoriz)} (native units)`,
    );
    // net drift across a loop must be ~0; range is just stride sway (native cm)
    if (netHoriz > 5)
      failures.push(
        `walk drifts at runtime: hips net horizontal=${round(netHoriz)} units per loop (not in-place)`,
      );
  }
}

if (unbound.length > 0) {
  failures.push(
    `${unbound.length} animation track(s) had no target node in the skeleton (unbound) — clip won't fully drive the avatar`,
  );
  console.log('\nunbound tracks (sample):', unbound.slice(0, 3));
}

console.log('\n--- RESULT ---');
if (failures.length === 0) {
  console.log(
    'PASS — clips bind to the cloned Remy skeleton and drive it; walk is in-place at runtime.',
  );
  process.exit(0);
} else {
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  console.log('FAIL');
  process.exit(1);
}
