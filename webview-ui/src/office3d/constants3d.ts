// 3D-only constants. Kept separate from the shared `webview-ui/src/constants.ts`
// so the 3D renderer (PART B of docs/3d-migration-plan.md) never collides with
// the 2D codebase on merge. The 2D renderer must not import from here.

import { Direction } from '../office/types.js';

/**
 * Master flag for the default renderer. App.tsx exposes a runtime toggle button
 * regardless, but this is the boot default and the single rollback switch.
 * Kept `false` until the 3D path is stable enough to be the default.
 */
export const RENDER_3D_DEFAULT = false;

// ── Coordinate / direction contract (docs/3d-migration-plan.md §3.2) ──────────
// 1 tile = 1 world unit. Floor is the XZ plane, +Y is up.
// World position of a character = (ch.x / TILE_SIZE, 0, ch.y / TILE_SIZE).
// yaw assumes the model's neutral pose faces Direction.DOWN (+Z). A model that
// faces another way is corrected via manifest.characterRig.forwardDir.
export const DIR_YAW: Record<Direction, number> = {
  [Direction.DOWN]: 0,
  [Direction.UP]: Math.PI,
  [Direction.LEFT]: Math.PI / 2,
  [Direction.RIGHT]: -Math.PI / 2,
};

/** forwardDir string (manifest) → the Direction the raw model faces at yaw 0. */
export const FORWARD_DIR_TO_DIRECTION: Record<string, Direction> = {
  down: Direction.DOWN,
  up: Direction.UP,
  left: Direction.LEFT,
  right: Direction.RIGHT,
};

// ── Character rig ─────────────────────────────────────────────────────────────
/** Fallback model height (world units) when the manifest omits heightWorld. */
export const DEFAULT_CHARACTER_HEIGHT_WORLD = 1.5;
/** Crossfade duration (seconds) when switching animation clips. */
export const CLIP_FADE_SEC = 0.2;
/** Position smoothing factor toward the simulation's reported world position. */
export const CHARACTER_POSITION_LERP = 0.35;
/** Yaw smoothing factor toward the target facing. */
export const CHARACTER_YAW_LERP = 0.3;
/** Seconds a resting character holds one neutral pose before cycling to the next
 *  in the gender pool (lounge / seated rest). */
export const REST_CYCLE_SEC = 4;

/** The lounge (right sofa room) starts at this tile column — everything at or
 *  right of it is the lounge, where the neutral motion pool is allowed to play.
 *  Left of it is the workspace (desks). The dividing wall is at col 10. */
export const LOUNGE_MIN_COL = 11;

// ── Camera (docs/3d-migration-plan.md §6 B6) ──────────────────────────────────
/** Fixed isometric/diorama offset direction from the look-at target. Normalized
 *  at use; magnitude is set by the framing distance. ~35° elevation. */
export const ISO_CAMERA_DIR: readonly [number, number, number] = [1, 1.1, 1];
/** Extra multiplier on the fitted frustum half-size, for breathing room. */
export const CAMERA_FRAME_PADDING = 1.15;
/** Ortho camera base half-height before the per-frame zoom divide. */
export const CAMERA_BASE_HALF_HEIGHT = 8;

// ── First-person walkthrough camera ───────────────────────────────────────────
/** Eye height (world units ≈ tiles) for the first-person camera. */
export const FP_EYE_HEIGHT = 1.5;
/** Walk speed in world units / second (Shift = ×2 run). */
export const FP_MOVE_SPEED = 4.5;
/** Field of view (degrees) for the first-person perspective camera. */
export const FP_FOV = 70;

// ── Environment fallbacks (no manifest / no model) ────────────────────────────
export const SCENE_BG_COLOR = '#1e1e2e';
export const FLOOR_COLOR_3D = '#2a2a3e';
/** Solid floor under the whole map footprint; VOID/gap tiles show this instead
 *  of the colored floor texture's transparent (→ black) texels. */
export const BASE_GROUND_COLOR_3D = '#37343f';
export const WALL_COLOR_3D = '#3a3a5c';
export const WALL_HEIGHT_WORLD = 1.0;
export const DESK_COLOR_3D = '#6b5b4b';
export const CHAIR_COLOR_3D = '#4b5b6b';
export const FURNITURE_COLOR_3D = '#55556b';
export const FALLBACK_AVATAR_COLOR = '#c8c8d0';

/** Per-palette tint for fallback capsule avatars, so distinct agents read as
 *  distinct even before real character models exist. Indexed by Character.palette. */
export const FALLBACK_PALETTE_COLORS: readonly string[] = [
  '#e06c75', // 0 red
  '#98c379', // 1 green
  '#61afef', // 2 blue
  '#e5c07b', // 3 yellow
  '#c678dd', // 4 magenta
  '#56b6c2', // 5 cyan
];
