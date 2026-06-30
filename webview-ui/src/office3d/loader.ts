// Pure (non-React) three.js helpers for the 3D renderer: per-instance skinned
// clone, scale-to-height fit, clip→action wiring, crossfade, angle lerp.
// Kept JSX-free so fast-refresh treats the component files as component-only.

import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

import type { AssetManifest, ClipKey } from './manifest.js';

const CLIP_KEYS: readonly ClipKey[] = [
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

/** Seated clips fall back to the seated typing pose, then idle. */
const SEATED_CLIPS: ReadonlySet<ClipKey> = new Set<ClipKey>([
  'sitRead',
  'sitFunny',
  'sitLady',
  'sitAsk',
  'sitTalk',
  'sitLaugh',
  'sitFemale',
]);

/** Clone a (possibly skinned) gltf scene for an independent animation instance. */
export function cloneSkinned(scene: THREE.Object3D): THREE.Object3D {
  const copy = cloneSkeleton(scene);
  copy.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });
  return copy;
}

/** Uniform scale that makes `obj`'s bounding-box height equal `targetHeight`. */
export function fitScaleToHeight(obj: THREE.Object3D, targetHeight: number): number {
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  const h = size.y || 1;
  return targetHeight / h;
}

/**
 * Height-fit a (skinned) avatar to `targetHeight` and return the y-offset that
 * drops its feet to y=0.
 *
 * Why not just `fitScaleToHeight`: `Box3.setFromObject` on a SkinnedMesh measures
 * the bind-pose geometry under the *mesh node's* world matrix. Mixamo→glTF keeps
 * its cm scale on the ARMATURE node and the metric in the BONE translations, so
 * the geometry box is off by ~100x and the bbox fit makes the rig giant. The
 * skeleton's bind-pose span reflects the true rendered size, so fit from that.
 * Falls back to the bbox for non-skinned models.
 */
export function fitSkinnedToHeight(
  obj: THREE.Object3D,
  targetHeight: number,
): { scale: number; yOffset: number } {
  let skeleton: THREE.Skeleton | undefined;
  obj.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (!skeleton && sm.isSkinnedMesh && sm.skeleton?.bones?.length) skeleton = sm.skeleton;
  });
  if (!skeleton) return { scale: fitScaleToHeight(obj, targetHeight), yOffset: 0 };

  obj.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let minY = Infinity;
  let maxY = -Infinity;
  for (const bone of skeleton.bones) {
    bone.getWorldPosition(v);
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const span = maxY - minY || 1;
  const scale = targetHeight / span;
  return { scale, yOffset: -minY * scale };
}

/** Build one AnimationAction per standard clip key that exists in the GLB.
 *  Missing sitRead falls back to sitType; any other missing key falls back to idle. */
export function buildAvatarActions(
  mixer: THREE.AnimationMixer,
  animations: THREE.AnimationClip[],
  manifest: AssetManifest | null,
): Partial<Record<ClipKey, THREE.AnimationAction>> {
  const actions: Partial<Record<ClipKey, THREE.AnimationAction>> = {};
  for (const key of CLIP_KEYS) {
    const name = manifest?.characterRig.clips[key];
    const clip = name ? THREE.AnimationClip.findByName(animations, name) : null;
    if (clip) actions[key] = mixer.clipAction(clip);
  }
  return actions;
}

/** Resolve the action to play for a key, applying the documented fallbacks. */
export function resolveAction(
  actions: Partial<Record<ClipKey, THREE.AnimationAction>>,
  key: ClipKey,
): THREE.AnimationAction | undefined {
  if (actions[key]) return actions[key];
  // Seated clips fall back to the seated typing pose, then idle — so a GLB built
  // without the optional seated-variety clips still renders a sitting character.
  // Standing/laying neutrals (phone/pain/lay*) fall back to idle.
  if (SEATED_CLIPS.has(key)) {
    return actions.sitType ?? actions.idle;
  }
  return actions.idle;
}

/** Crossfade from the current action key to the next over `fade` seconds. */
export function crossfadeTo(
  actions: Partial<Record<ClipKey, THREE.AnimationAction>>,
  fromKey: ClipKey | null,
  toKey: ClipKey,
  fade: number,
): void {
  const next = resolveAction(actions, toKey);
  if (!next) return;
  const prev = fromKey ? resolveAction(actions, fromKey) : undefined;
  if (prev && prev !== next) {
    prev.fadeOut(fade);
  }
  next.reset();
  next.setEffectiveWeight(1);
  next.fadeIn(prev && prev !== next ? fade : 0);
  next.play();
}

/** Interpolate angle `a`→`b` by `t`, taking the shortest path around the circle. */
export function lerpAngle(a: number, b: number, t: number): number {
  let diff = (b - a) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}
