// Camera rig with two modes:
//  • 'ortho'  — the orthographic diorama (OrbitControls: left/middle-drag pan,
//    wheel zoom, rotation locked) with 2D-style camera-follow.
//  • 'firstperson' — a perspective walkthrough: click to capture the mouse
//    (pointer lock) for look, WASD/arrows to walk at eye height (Shift = run).
// Manual interaction cancels follow (docs/3d-migration-plan.md §B6).

import {
  OrbitControls,
  OrthographicCamera,
  PerspectiveCamera,
  PointerLockControls,
} from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { type ComponentRef, useEffect, useRef } from 'react';
import * as THREE from 'three';

import { CAMERA_FOLLOW_LERP, CAMERA_FOLLOW_SNAP_THRESHOLD, TILE_SIZE } from '../../constants.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import {
  CAMERA_FRAME_PADDING,
  FP_EYE_HEIGHT,
  FP_FOV,
  FP_MOVE_SPEED,
  ISO_CAMERA_DIR,
} from '../constants3d.js';

export type CameraMode = 'ortho' | 'firstperson';

interface CameraRigProps {
  officeState: OfficeState;
  cameraMode: CameraMode;
}

export function CameraRig({ officeState, cameraMode }: CameraRigProps) {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null);
  const camera = useThree((s) => s.camera);
  const ortho = cameraMode === 'ortho';

  // DEV-only: expose the controls on the shared scene handle for e2e framing.
  useEffect(() => {
    if (import.meta.env.DEV) {
      const g = globalThis as { __office3d?: Record<string, unknown> };
      g.__office3d = { ...(g.__office3d ?? {}), controls: controlsRef.current };
    }
  });

  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);

  // Frame the whole layout (ortho only). Re-runs when the default camera swaps in
  // or the viewport resizes.
  useEffect(() => {
    if (!ortho) return;
    const layout = officeState.getLayout();
    const cx = layout.cols / 2;
    const cz = layout.rows / 2;
    const span = Math.max(layout.cols, layout.rows) || 10;
    const dir = new THREE.Vector3(
      ISO_CAMERA_DIR[0],
      ISO_CAMERA_DIR[1],
      ISO_CAMERA_DIR[2],
    ).normalize();
    const dist = span * 2 + 10;
    camera.position.set(cx + dir.x * dist, dir.y * dist, cz + dir.z * dist);
    camera.lookAt(cx, 0, cz);
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const oc = camera as THREE.OrthographicCamera;
      oc.zoom = Math.max(4, Math.min(width, height) / (span * 1.7 * CAMERA_FRAME_PADDING));
      oc.updateProjectionMatrix();
    }
    const controls = controlsRef.current;
    if (controls) {
      controls.target.set(cx, 0, cz);
      controls.update();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, width, height, ortho]);

  useFrame((state) => {
    if (!ortho) return;
    const controls = controlsRef.current;
    if (!controls) return;
    const followId = officeState.cameraFollowId;
    if (followId !== null) {
      const ch = officeState.characters.get(followId);
      if (ch) {
        const tx = ch.x / TILE_SIZE;
        const tz = ch.y / TILE_SIZE;
        const t = controls.target;
        const off = state.camera.position.clone().sub(t);
        const snap = CAMERA_FOLLOW_SNAP_THRESHOLD / TILE_SIZE;
        if (Math.abs(tx - t.x) < snap && Math.abs(tz - t.z) < snap) {
          t.set(tx, 0, tz);
        } else {
          t.set(t.x + (tx - t.x) * CAMERA_FOLLOW_LERP, 0, t.z + (tz - t.z) * CAMERA_FOLLOW_LERP);
        }
        state.camera.position.copy(t).add(off);
      }
    }
    controls.update();
  });

  if (!ortho) return <FirstPersonRig officeState={officeState} />;

  return (
    <>
      <OrthographicCamera makeDefault near={-1000} far={2000} />
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableRotate={false}
        enablePan
        enableZoom
        mouseButtons={{ LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: undefined }}
      />
    </>
  );
}

const UP = new THREE.Vector3(0, 1, 0);

/** Perspective walkthrough: pointer-lock look + WASD/arrow movement at eye height. */
function FirstPersonRig({ officeState }: { officeState: OfficeState }) {
  const camRef = useRef<THREE.PerspectiveCamera>(null);
  const keys = useRef<Record<string, boolean>>({});
  const placed = useRef(false);

  useEffect(() => {
    const set = (v: boolean) => (e: KeyboardEvent) => {
      // ignore typing into inputs; office has none, but be safe
      keys.current[e.code] = v;
    };
    const down = set(true);
    const up = set(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const fwd = useRef(new THREE.Vector3());
  const right = useRef(new THREE.Vector3());

  useFrame((_, dt) => {
    const cam = camRef.current;
    if (!cam) return;
    const layout = officeState.getLayout();
    if (!placed.current) {
      // Start standing just inside the near edge, looking across the office.
      cam.position.set(layout.cols / 2, FP_EYE_HEIGHT, layout.rows - 1.5);
      cam.lookAt(layout.cols / 2, FP_EYE_HEIGHT, layout.rows / 2);
      placed.current = true;
    }
    const k = keys.current;
    const run = k.ShiftLeft || k.ShiftRight ? 2 : 1;
    const step = FP_MOVE_SPEED * run * Math.min(dt, 0.05);
    cam.getWorldDirection(fwd.current);
    fwd.current.y = 0;
    if (fwd.current.lengthSq() > 0) fwd.current.normalize();
    right.current.crossVectors(fwd.current, UP).normalize();
    if (k.KeyW || k.ArrowUp) cam.position.addScaledVector(fwd.current, step);
    if (k.KeyS || k.ArrowDown) cam.position.addScaledVector(fwd.current, -step);
    if (k.KeyD || k.ArrowRight) cam.position.addScaledVector(right.current, step);
    if (k.KeyA || k.ArrowLeft) cam.position.addScaledVector(right.current, -step);
    // Stay at eye height, clamped inside the map footprint (ponytail: no wall
    // collision — you can pass through furniture/walls; add tileMap raycast later).
    cam.position.y = FP_EYE_HEIGHT;
    cam.position.x = Math.max(0.5, Math.min(layout.cols - 0.5, cam.position.x));
    cam.position.z = Math.max(0.5, Math.min(layout.rows - 0.5, cam.position.z));
  });

  return (
    <>
      <PerspectiveCamera ref={camRef} makeDefault near={0.05} far={2000} fov={FP_FOV} />
      <PointerLockControls />
    </>
  );
}
