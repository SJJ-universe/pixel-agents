// Bridges the 2D pixel art into the 3D scene: the same colorize pipeline the 2D
// renderer uses produces SpriteData, getCachedSprite rasterizes it to a canvas,
// and we wrap that canvas in a THREE.CanvasTexture. Nearest filtering + no
// mipmaps keeps the crisp pixel look (docs/3d-migration-plan: map fidelity).

import * as THREE from 'three';

import { getColorizedFloorSprite } from '../office/floorTiles.js';
import { getCachedSprite } from '../office/sprites/spriteCache.js';
import type { ColorValue, OfficeLayout, SpriteData } from '../office/types.js';
import { TILE_SIZE, TileType } from '../office/types.js';

// Neutral colorize params: s=0 → grayscale passthrough of the source pattern.
const DEFAULT_FLOOR_COLOR: ColorValue = { h: 0, s: 0, b: 0, c: 0 };

function pixelTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  // Floor plane is rotated so canvas row 0 should map to world z=0 (no V flip).
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * One CanvasTexture for the whole floor: each FLOOR_* tile is colorized through
 * the 2D pipeline (per-tile tileColors) and composited into a cols*16 × rows*16
 * canvas. WALL/VOID tiles stay transparent — the wall meshes cover them. Returns
 * null for an empty layout or when nothing was drawn (caller keeps a solid color).
 */
export function buildFloorTexture(layout: OfficeLayout): THREE.CanvasTexture | null {
  const { cols, rows, tiles, tileColors } = layout;
  if (cols <= 0 || rows <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = cols * TILE_SIZE;
  canvas.height = rows * TILE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = false;

  let drew = false;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const tile = tiles[idx];
      if (tile < TileType.FLOOR_1 || tile > TileType.FLOOR_9) continue; // skip WALL/VOID
      const color = tileColors?.[idx] ?? DEFAULT_FLOOR_COLOR;
      const tileCanvas = getCachedSprite(getColorizedFloorSprite(tile, color), 1);
      ctx.drawImage(tileCanvas, c * TILE_SIZE, r * TILE_SIZE);
      drew = true;
    }
  }
  if (!drew) return null;
  const tex = pixelTexture(canvas);
  // The floor plane is rotated -90° about X, which maps canvas row 0 to world
  // z=rows (not z=0) when flipY=false — i.e. the painted rooms render Z-mirrored,
  // floating off into the empty corner while the furniture/characters (positioned
  // by col/row directly) stay put. flipY=true puts data row r at world z=r so the
  // colored floor sits exactly under the room it belongs to.
  tex.flipY = true;
  tex.needsUpdate = true;
  return tex;
}

/** CanvasTexture from a single sprite (furniture/wall), alpha preserved. The
 *  cached canvas is shared; each caller gets its own lightweight texture view. */
export function buildSpriteTexture(sprite: SpriteData): THREE.CanvasTexture {
  const tex = pixelTexture(getCachedSprite(sprite, 1));
  tex.flipY = true; // upright billboard: keep sprite top at the top
  return tex;
}

// Neutral office-floor tint for the base ground (warm low-saturation gray).
const BASE_GROUND_TILE: ColorValue = { h: 32, s: 10, b: -34, c: -45 };

/**
 * One repeating office-floor tile for the base ground under the whole map, so the
 * VOID/work area reads as a continuous office floor (with the colored rooms as
 * zones on top and the walls sitting on it) instead of a flat dark slab. Reuses a
 * 2D floor pattern colorized to a neutral tone; tiles 1:1 with the grid.
 */
export function buildBaseGroundTexture(cols: number, rows: number): THREE.CanvasTexture {
  const tex = pixelTexture(getCachedSprite(getColorizedFloorSprite(1, BASE_GROUND_TILE), 1));
  tex.flipY = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(cols, rows);
  return tex;
}
