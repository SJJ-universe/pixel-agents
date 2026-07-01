// One rig per Character. The outer group is transformed every frame straight
// from the simulation (no React state). The visual is either the manifest GLB
// (animated, crossfaded) or a primitive fallback — the single load-failure
// branch is the ErrorBoundary below (docs/3d-migration-plan.md §B3).

import { useGLTF } from '@react-three/drei';
import { type ThreeEvent, useFrame } from '@react-three/fiber';
import { Component, type ReactNode, Suspense, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import type { ToolActivity } from '../../office/types.js';
import {
  CharacterState,
  Direction,
  MATRIX_EFFECT_DURATION,
  TILE_SIZE,
} from '../../office/types.js';
import { selectClip } from '../clip.js';
import {
  CHARACTER_YAW_LERP,
  CLIP_FADE_SEC,
  DEFAULT_CHARACTER_HEIGHT_WORLD,
  DIR_YAW,
  FALLBACK_AVATAR_COLOR,
  FALLBACK_PALETTE_COLORS,
  FORWARD_DIR_TO_DIRECTION,
  LOUNGE_MIN_COL,
  REST_CYCLE_SEC,
} from '../constants3d.js';
import {
  buildAvatarActions,
  cloneSkinned,
  crossfadeTo,
  fitSkinnedToHeight,
  lerpAngle,
} from '../loader.js';
import type { AssetManifest, ClipKey } from '../manifest.js';
import {
  fixedCharGenderForRole,
  fixedCharModelUrl,
  fixedRoleFor,
  genderForAgent,
  modelUrlForAgent,
} from '../manifest.js';
import { HeadBubble } from './Bubbles.js';

interface CharacterRigProps {
  id: number;
  officeState: OfficeState;
  manifest: AssetManifest | null;
  /** assets3d base URL (trailing slash). */
  base: string;
  alwaysShowLabels: boolean;
  onSelect: (id: number) => void;
  agentTools: Record<number, ToolActivity[]>;
  subagentCharacters: SubagentCharacter[];
  onCloseAgent: (id: number) => void;
  labelScale: number;
}

const NOSE_COLOR = '#1e1e2e';
// Selection / hover ground ring (office3d/** is inline-color whitelisted).
const SELECT_RING_COLOR = '#ffffff';
const HOVER_RING_COLOR = '#aab4ff';
// Seated nudge toward the camera (+x,+z, the iso "down" direction) so a sitting
// character lands ON the chair/sofa seat instead of behind it — the 3D analog of
// the 2D CHARACTER_SITTING_OFFSET_PX. ~0.7 = normalized x==z component.
const SEAT_OFFSET = 0.15;
const SEAT_AXIS = 0.707;
// Reused scratch vector for the per-frame floor clamp (avoids per-frame allocation).
const clampVec = new THREE.Vector3();

/** Clone a material and rotate its base color hue by `hueShift` degrees. */
function tintMaterial(m: THREE.Material, hueShift: number): THREE.Material {
  const cm = m.clone() as THREE.MeshStandardMaterial;
  if (cm.color) cm.color.offsetHSL(hueShift / 360, 0, 0);
  return cm;
}

/** Renders the manifest GLB, animated from the simulation. Suspends while loading. */
function GltfAvatar({
  id,
  officeState,
  url,
  manifest,
  baseYaw,
  hueShift,
}: {
  id: number;
  officeState: OfficeState;
  url: string;
  manifest: AssetManifest | null;
  baseYaw: number;
  hueShift: number;
}) {
  const gltf = useGLTF(url);
  const cloned = useMemo(() => {
    const c = cloneSkinned(gltf.scene);
    // Palette diversity beyond the 6 base models: rotate every material's hue so
    // repeat-palette agents still read as distinct (2D adjustSprite parity). Clone
    // materials first so we never mutate the shared cached GLTF.
    if (hueShift) {
      c.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map((m) => tintMaterial(m, hueShift))
          : tintMaterial(mesh.material, hueShift);
      });
    }
    return c;
  }, [gltf.scene, hueShift]);
  const height = manifest?.characterRig.heightWorld ?? DEFAULT_CHARACTER_HEIGHT_WORLD;
  const fit = useMemo(() => fitSkinnedToHeight(cloned, height), [cloned, height]);

  // The mixer MUST be rooted at a SkinnedMesh: three's PropertyBinding resolves a
  // bone track (e.g. "mixamorigHips.quaternion") against `root.skeleton.bones`
  // only when the root is the skinned mesh. Rooted higher (the cloned scene or a
  // group) it binds to look-alike tree nodes that don't drive the skin -> the
  // mixer advances but nothing deforms (frozen T-pose). All 7 body parts share
  // one skeleton, so binding through any one of them animates the whole avatar.
  const { mixer, actions, bones, skinned } = useMemo(() => {
    let root: THREE.Object3D = cloned;
    let bones: THREE.Bone[] = [];
    const skinned: THREE.SkinnedMesh[] = [];
    cloned.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh) {
        skinned.push(sm);
        if (root === cloned) {
          root = sm; // bind the mixer to the first skinned mesh
          bones = sm.skeleton.bones;
        }
      }
    });
    const m = new THREE.AnimationMixer(root);
    return { mixer: m, actions: buildAvatarActions(m, gltf.animations, manifest), bones, skinned };
  }, [cloned, gltf.animations, manifest]);
  const currentKey = useRef<ClipKey | null>(null);
  const avatarRef = useRef<THREE.Group>(null);
  // Floor clamp: fast per-frame bone anchor + a cached "geometry hangs below the
  // lowest bone" delta (measured by a subsampled vertex scan, refreshed on clip
  // change and on a timer). Keeps the per-frame cost at ~bone-count while still
  // grounding the actual lowest rendered vertex. See the clamp in useFrame below.
  const floorDelta = useRef(0);
  const floorRecalc = useRef(true);
  const floorTimer = useRef(0);
  // Neutral-pose cycling (lounge / seated rest). Gender + role are resolved per
  // frame below because the role arrives after spawn (setTeamInfo).
  const sitVariant = useRef(0);
  const sitTimer = useRef(0);

  // ponytail: no unmount disposal of the per-instance Skeleton/mixer. The obvious
  // teardown (uncacheRoot + skeleton.dispose) frees a render-created resource, so
  // React StrictMode runs it on MOUNT (setup→cleanup→setup) and uncaches the LIVE
  // root — which froze every avatar (mixer advanced, but no action could bind/run).
  // Dropping it leaks one boneTexture per character despawn — negligible for a few
  // office characters. Upgrade: build the mixer/skeleton inside an effect so the
  // cleanup is symmetric and StrictMode-safe.

  useFrame((_, dt) => {
    const ch = officeState.characters.get(id);
    if (ch) {
      const role = fixedRoleFor(manifest, ch.agentName, ch.isTeamLead);
      const gender = role ? fixedCharGenderForRole(manifest, role) : genderForAgent(manifest, id);
      const inLounge = ch.tileCol >= LOUNGE_MIN_COL;
      const isFixed = !!ch.isFixed;
      // Cycle the gender neutral pool while resting — seated on a lounge sofa, or
      // idling in the lounge. Fixed characters hold one static pose (no cycle).
      const cycling =
        !isFixed &&
        ((ch.state === CharacterState.TYPE && !ch.isActive) ||
          (ch.state === CharacterState.IDLE && inLounge));
      if (cycling) {
        sitTimer.current += dt;
        if (sitTimer.current >= REST_CYCLE_SEC) {
          sitTimer.current = 0;
          sitVariant.current += 1;
        }
      } else {
        sitTimer.current = 0;
      }
      const key: ClipKey = ch.matrixEffect
        ? 'idle'
        : selectClip(ch.state, ch.currentTool, {
            isActive: ch.isActive,
            gender,
            variant: sitVariant.current,
            inLounge,
            isFixed,
          });
      if (key !== currentKey.current) {
        crossfadeTo(actions, currentKey.current, key, CLIP_FADE_SEC);
        currentKey.current = key;
        floorRecalc.current = true; // re-measure the floor delta for the new pose
      }
    }
    mixer.update(dt);

    // Floor clamp: fitSkinnedToHeight anchors the T-pose feet to y=0, but animated
    // poses move the body off that anchor — seated clips (typing/reading) drop the
    // root (sink ~0.7), and reclining/crouched neutral poses (lay*/pain/floor-sits)
    // hang body geometry BELOW the lowest bone. Anchoring the lowest BONE therefore
    // still let the back/side/hip clip through the floor for those poses (measured
    // ~0.05–0.12 below). Ground the lowest actually-rendered VERTEX instead: a cheap
    // per-frame bone anchor plus a cached "geometry hangs below the bone" delta
    // (subsampled scan, refreshed on clip change + on a timer), so no part of the
    // character ever crosses the floor. Skipped while the spawn/despawn scale
    // animates (group scale ≠ 1 distorts the world-Y math). Converges in one frame.
    const g = avatarRef.current;
    if (g && bones.length && !ch?.matrixEffect) {
      g.updateWorldMatrix(true, true);
      // Cheap per-frame anchor: the lowest bone's world-Y.
      let boneMinY = Infinity;
      for (const b of bones) {
        const y = b.matrixWorld.elements[13];
        if (y < boneMinY) boneMinY = y;
      }
      // Refresh the cached geometry-below-bone delta on clip change and ~2×/sec
      // (bounds staleness while the pose animates). One subsampled vertex scan —
      // these are high-poly Mixamo meshes (~8k verts each), so a full per-frame
      // scan is far too costly; sampling ~800/mesh catches the lowest extremity.
      floorTimer.current += dt;
      if (floorRecalc.current || floorTimer.current >= 0.5) {
        floorRecalc.current = false;
        floorTimer.current = 0;
        let vertMinY = Infinity;
        for (const sm of skinned) {
          const nn = sm.geometry.attributes.position.count;
          const st = Math.max(1, Math.floor(nn / 800));
          for (let i = 0; i < nn; i += st) {
            sm.getVertexPosition(i, clampVec);
            clampVec.applyMatrix4(sm.matrixWorld);
            if (clampVec.y < vertMinY) vertMinY = clampVec.y;
          }
        }
        // ≥ 0 when geometry hangs below the bone (the sinking case).
        floorDelta.current = Number.isFinite(vertMinY) ? boneMinY - vertMinY : 0;
      }
      // Ground the lowest VERTEX (bone anchor minus how far geometry hangs below it).
      const lowestVertexY = boneMinY - floorDelta.current;
      if (Number.isFinite(lowestVertexY) && Math.abs(lowestVertexY) > 0.002) {
        g.position.y -= lowestVertexY;
      }
    }
  });

  // baseYaw corrects the model's authored facing so rig yaw == Direction yaw;
  // yOffset drops the feet to y=0 so the character stands on the floor (then the
  // per-frame floor clamp keeps them there across animated poses).
  return (
    <group ref={avatarRef} rotation-y={-baseYaw} scale={fit.scale} position-y={fit.yOffset}>
      <primitive object={cloned} />
    </group>
  );
}

/** Capsule + head + facing nose, tinted by palette. Used before/without models. */
function FallbackAvatar({ palette, height }: { palette: number; height: number }) {
  const color =
    FALLBACK_PALETTE_COLORS[palette % FALLBACK_PALETTE_COLORS.length] ?? FALLBACK_AVATAR_COLOR;
  const r = height * 0.16;
  const bodyLen = height * 0.5;
  const bodyCenter = r + bodyLen / 2;
  const headY = r + bodyLen + r * 0.7;
  return (
    <group>
      <mesh castShadow position={[0, bodyCenter, 0]}>
        <capsuleGeometry args={[r, bodyLen, 6, 12]} />
        <meshStandardMaterial color={color} />
      </mesh>
      <mesh castShadow position={[0, headY, 0]}>
        <sphereGeometry args={[r * 0.95, 16, 16]} />
        <meshStandardMaterial color={color} />
      </mesh>
      {/* facing indicator: +Z is Direction.DOWN */}
      <mesh position={[0, headY, r]}>
        <boxGeometry args={[r * 0.5, r * 0.4, r * 0.5]} />
        <meshStandardMaterial color={NOSE_COLOR} />
      </mesh>
    </group>
  );
}

/** The only "model failed → fallback" branch in the renderer. */
class ModelErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.warn('[Office3D] character model failed to load; using fallback', err);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function CharacterRig({
  id,
  officeState,
  manifest,
  base,
  alwaysShowLabels,
  onSelect,
  agentTools,
  subagentCharacters,
  onCloseAgent,
  labelScale,
}: CharacterRigProps) {
  const groupRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const palette = officeState.characters.get(id)?.palette ?? 0;
  const hueShift = officeState.characters.get(id)?.hueShift ?? 0;
  const height = manifest?.characterRig.heightWorld ?? DEFAULT_CHARACTER_HEIGHT_WORLD;
  // Skin url is state so a fixed character can swap to its role model (Medea/Ch19)
  // once the role arrives after spawn; resolved each frame in the loop below.
  const [url, setUrl] = useState<string | null>(() => modelUrlForAgent(manifest, base, id));
  const baseYaw = useMemo(() => {
    const fwd = manifest?.characterRig.forwardDir ?? 'down';
    return DIR_YAW[FORWARD_DIR_TO_DIRECTION[fwd] ?? Direction.DOWN];
  }, [manifest]);

  useFrame(() => {
    const ch = officeState.characters.get(id);
    if (!ch) return;
    // Role-bound skin: a fixed character swaps to Medea/Ch19 once its role resolves.
    const role = fixedRoleFor(manifest, ch.agentName, ch.isTeamLead);
    const want = role
      ? fixedCharModelUrl(manifest, base, role)
      : modelUrlForAgent(manifest, base, id);
    if (want && want !== url) setUrl(want);
    const g = groupRef.current;
    if (!g) return;
    const seat = ch.state === CharacterState.TYPE ? SEAT_OFFSET * SEAT_AXIS : 0;
    g.position.set(ch.x / TILE_SIZE + seat, 0, ch.y / TILE_SIZE + seat);
    // Face the movement direction (ch.dir is set to each path step's heading, so
    // this always tracks travel). Snap faster through a near-reversal so turning a
    // corner doesn't briefly read as walking backward while the body eases around
    // — normal turns stay smooth. (User: "characters sometimes walk backwards".)
    // Seated Mixamo clips (typing/reading/sitting) are authored ~180° from the
    // standing clips, so a seated character would sit with its back to the desk;
    // flip the seated yaw by π so it faces its desk/PC. (User: "sits opposite the PC".)
    const seatedFlip = ch.state === CharacterState.TYPE ? Math.PI : 0;
    const targetYaw = DIR_YAW[ch.dir] + seatedFlip;
    let dYaw = (targetYaw - g.rotation.y) % (Math.PI * 2);
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    g.rotation.y = lerpAngle(
      g.rotation.y,
      targetYaw,
      Math.abs(dYaw) > 2.2 ? 0.7 : CHARACTER_YAW_LERP,
    );
    let s = 1;
    if (ch.matrixEffect === 'spawn') {
      s = Math.min(1, ch.matrixEffectTimer / MATRIX_EFFECT_DURATION);
    } else if (ch.matrixEffect === 'despawn') {
      s = Math.max(0, 1 - ch.matrixEffectTimer / MATRIX_EFFECT_DURATION);
    }
    g.scale.setScalar(s);

    // Selection / hover ground ring (2D outline parity).
    const ring = ringRef.current;
    if (ring) {
      const sel = officeState.selectedAgentId === id;
      const hov = officeState.hoveredAgentId === id;
      ring.visible = sel || hov;
      if (ring.visible) {
        const mat = ring.material as THREE.MeshBasicMaterial;
        mat.color.set(sel ? SELECT_RING_COLOR : HOVER_RING_COLOR);
        mat.opacity = sel ? 0.95 : 0.5;
      }
    }
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    officeState.dismissBubble(id);
    if (officeState.selectedAgentId === id) {
      officeState.selectedAgentId = null;
      officeState.cameraFollowId = null;
    } else {
      officeState.selectedAgentId = id;
      officeState.cameraFollowId = id;
    }
    onSelect(id);
  };

  const fallback = <FallbackAvatar palette={palette} height={height} />;

  return (
    <group
      ref={groupRef}
      onClick={handleClick}
      onPointerOver={(e) => {
        e.stopPropagation();
        officeState.hoveredAgentId = id;
      }}
      onPointerOut={() => {
        if (officeState.hoveredAgentId === id) officeState.hoveredAgentId = null;
      }}
    >
      {/* Selection / hover ground ring (flat, under the feet). */}
      <mesh ref={ringRef} rotation-x={-Math.PI / 2} position-y={0.02} visible={false}>
        <ringGeometry args={[0.34, 0.46, 32]} />
        <meshBasicMaterial
          color={SELECT_RING_COLOR}
          transparent
          opacity={0.95}
          side={THREE.DoubleSide}
        />
      </mesh>
      {url ? (
        <ModelErrorBoundary fallback={fallback}>
          <Suspense fallback={fallback}>
            <GltfAvatar
              id={id}
              officeState={officeState}
              url={url}
              manifest={manifest}
              baseYaw={baseYaw}
              hueShift={hueShift}
            />
          </Suspense>
        </ModelErrorBoundary>
      ) : (
        fallback
      )}
      <HeadBubble
        id={id}
        officeState={officeState}
        headY={height + 0.35}
        alwaysShowLabels={alwaysShowLabels}
        agentTools={agentTools}
        subagentCharacters={subagentCharacters}
        onCloseAgent={onCloseAgent}
        labelScale={labelScale}
      />
    </group>
  );
}
