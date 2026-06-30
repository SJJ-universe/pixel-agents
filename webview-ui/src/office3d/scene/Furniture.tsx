// Furniture rendering. Each placed item is EITHER a real 3D model (Kenney
// Furniture Kit GLB, CC0 — when the manifest declares one for that type) or,
// as a fallback, the same 2D pixel sprite as the 2D office mapped onto an
// upright camera-facing plane (2.5D). Models are auto-fit + recentered to the
// item's tile footprint and rotated by a per-type yaw from the manifest, so no
// per-model magic numbers live in code — only facing, which is data.

import { Billboard, useGLTF } from '@react-three/drei';
import { Component, type ReactNode, Suspense, useEffect, useMemo } from 'react';
import * as THREE from 'three';

import { getColorizedSprite } from '../../office/colorize.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { getCatalogEntry, getOrientationInGroup } from '../../office/layout/furnitureCatalog.js';
import type { SpriteData } from '../../office/types.js';
import { TILE_SIZE } from '../../office/types.js';
import type { AssetManifest } from '../manifest.js';
import { buildSpriteTexture } from '../textures.js';

interface FurnitureProps {
  officeState: OfficeState;
  manifest: AssetManifest | null;
  /** assets3d base URL (trailing slash) — model paths resolve beneath it. */
  base: string;
}

// Match the 2D sprite→world scale of CHARACTERS so furniture and people read at
// one scale (the 2D look). A character GLB is fit to ~1.6 world for a 32px-tall
// sprite, so 1 sprite px = 1.6/32 world. (Using 1/TILE_SIZE made a 32px desk 2.0
// world — taller than the person, so desks towered and seats looked detached.)
// ponytail: hardcoded to the manifest's heightWorld (1.6); thread it through if
// that ever changes.
const PX_TO_WORLD = 1.6 / 32;
// Surface items (PC, mug…) sit on a desk; lift their billboard so the bottom
// rests near the desk top instead of on the floor.
const DESK_SURFACE_Y = 0.55;

interface SpriteItem {
  kind: 'sprite';
  uid: string;
  sprite: SpriteData;
  /** World center X/Z (footprint-centered). */
  cx: number;
  cz: number;
  /** World Y of the plane center (bottom anchored to floor or desk surface). */
  cy: number;
  /** Plane size in world units. */
  w: number;
  h: number;
  mirrored: boolean;
}

interface ModelItem {
  kind: 'model';
  uid: string;
  url: string;
  cx: number;
  cz: number;
  /** Target world height the model is scaled to (human-relative). */
  hWorld: number;
  yawDeg: number;
  yOff: number;
  /** Sprite shown while the GLB loads or if it fails to load. */
  fallback: SpriteItem;
}

// Fallback target height (world units) for a furniture model the manifest leaves
// unsized. Chairs/desks land ~half the 1.6-tall character so people read clearly.
const DEFAULT_FURNITURE_HWORLD = 0.7;

type Item = SpriteItem | ModelItem;

/** One textured, camera-facing plane (the 2.5D fallback look). */
function FurnitureSprite({ item }: { item: SpriteItem }) {
  const tex = useMemo(() => {
    const t = buildSpriteTexture(item.sprite);
    if (item.mirrored) {
      t.wrapS = THREE.RepeatWrapping;
      t.repeat.x = -1;
      t.offset.x = 1;
    }
    return t;
  }, [item.sprite, item.mirrored]);
  useEffect(() => () => tex.dispose(), [tex]);

  return (
    <Billboard follow lockX lockZ position={[item.cx, item.cy, item.cz]}>
      <mesh castShadow>
        <planeGeometry args={[item.w, item.h]} />
        <meshBasicMaterial map={tex} transparent alphaTest={0.5} side={THREE.DoubleSide} />
      </mesh>
    </Billboard>
  );
}

/** A real GLB, auto-fit to the item's footprint and recentered so its bbox
 *  center sits on the footprint center and its base rests on the floor. Suspends
 *  while loading. The cloned scene shares the cached geometry/materials — never
 *  disposed (that would evict the drei cache for the other instances). */
function FurnitureModel({ item }: { item: ModelItem }) {
  const gltf = useGLTF(item.url);
  const obj = useMemo(() => {
    const c = gltf.scene.clone(true);
    c.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    // Scale to a human-relative target HEIGHT (not the tile footprint, which is
    // generous and made furniture tower over the characters). Kenney models are
    // consistently proportioned, so height scaling keeps them mutually consistent.
    const size = new THREE.Box3().setFromObject(c).getSize(new THREE.Vector3());
    c.scale.setScalar(item.hWorld / (size.y || 1));
    c.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(c);
    const ctr = box.getCenter(new THREE.Vector3());
    c.position.x -= ctr.x; // bbox center-XZ → local origin (yaw spins in place)
    c.position.z -= ctr.z;
    c.position.y -= box.min.y; // base → y=0
    return c;
  }, [gltf.scene, item.hWorld]);

  return (
    <group
      position={[item.cx, item.yOff, item.cz]}
      rotation-y={THREE.MathUtils.degToRad(item.yawDeg)}
    >
      <primitive object={obj} />
    </group>
  );
}

/** Falls back to the sprite billboard if a furniture GLB fails to load. */
class ModelBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.warn('[Office3D] furniture model failed to load; using sprite', err);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function Furniture({ officeState, manifest, base }: FurnitureProps) {
  const layout = officeState.getLayout();
  const furnitureMap = manifest?.furniture;
  const sig = `${layout.furniture.length}:${layout.cols}x${layout.rows}:${layout.layoutRevision ?? 0}:${!!furnitureMap}`;

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const f of layout.furniture) {
      const entry = getCatalogEntry(f.type);
      if (!entry) continue;
      // Colorize exactly as the 2D layoutToFurnitureInstances does (shared cache).
      let sprite = entry.sprite;
      if (f.color) {
        const { h, s, b, c } = f.color;
        sprite = getColorizedSprite(
          `furn-${f.type}-${h}-${s}-${b}-${c}-${f.color.colorize ? 1 : 0}`,
          entry.sprite,
          f.color,
        );
      }
      const mirrored = !!entry.mirrorSide && getOrientationInGroup(f.type) === 'left';
      const w = (sprite[0]?.length ?? TILE_SIZE) * PX_TO_WORLD;
      const h = sprite.length * PX_TO_WORLD;
      const yBase = entry.canPlaceOnSurfaces ? DESK_SURFACE_Y : 0;
      // Seats are derived from the chair's footprint MINUS the top backgroundTiles
      // rows (the chair-back, which a character sits in front of). Anchor seating
      // furniture to that seat region so it lands where the character actually
      // sits — not the whole-footprint center. Non-seating keeps footprint center.
      const bg = entry.category === 'chairs' ? (entry.backgroundTiles ?? 0) : 0;
      const cx = f.col + entry.footprintW / 2;
      const cz = f.row + bg + (entry.footprintH - bg) / 2;
      const fallback: SpriteItem = {
        kind: 'sprite',
        uid: f.uid,
        sprite,
        cx,
        cz,
        cy: yBase + h / 2,
        w,
        h,
        mirrored,
      };

      const model = furnitureMap?.[f.type];
      if (model) {
        out.push({
          kind: 'model',
          uid: f.uid,
          url: base + model.model,
          cx,
          cz,
          hWorld: model.hWorld ?? DEFAULT_FURNITURE_HWORLD,
          yawDeg: model.yawDeg ?? 0,
          yOff: model.yOff ?? 0,
          fallback,
        });
      } else {
        out.push(fallback);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, base]);

  return (
    <group>
      {items.map((it) =>
        it.kind === 'model' ? (
          <ModelBoundary key={it.uid} fallback={<FurnitureSprite item={it.fallback} />}>
            <Suspense fallback={<FurnitureSprite item={it.fallback} />}>
              <FurnitureModel item={it} />
            </Suspense>
          </ModelBoundary>
        ) : (
          <FurnitureSprite key={it.uid} item={it} />
        ),
      )}
    </group>
  );
}
