// Asset manifest contract (docs/3d-migration-plan.md §3.1). PART A produces
// `webview-ui/public/assets3d/manifest.json`; this module is B's read-only
// consumer. The 4 standard clip keys are a FROZEN vocabulary — do not rename.

export type ClipKey =
  | 'idle'
  | 'walk'
  | 'sitType'
  | 'sitRead'
  | 'sitFunny'
  | 'sitLady'
  | 'sitAsk'
  | 'sitTalk'
  | 'sitLaugh'
  | 'phone'
  | 'pain'
  | 'layMale'
  | 'layFemale'
  | 'sitFemale';

export interface CharacterRigManifest {
  /** Model height scaled to this many world units (≈ tiles). */
  heightWorld: number;
  /** Direction the neutral pose faces: 'down' | 'up' | 'left' | 'right'. */
  forwardDir: string;
  /** Standard clip key → the real AnimationClip name inside the GLB. */
  clips: Record<ClipKey, string>;
}

export interface CharacterEntry {
  /** Palette index 0–5. Missing indices fall back to palette 0. */
  palette: number;
  /** GLB path relative to the assets3d root. */
  model: string;
  /** 'male' | 'female' — drives the gendered seated-rest animation set. */
  gender?: string;
}

export interface FurnitureEntry {
  model: string;
  /** Orientation the model's mesh is authored in: 'front' | 'back' | ... */
  yaw0?: string;
  /** Final Y rotation (degrees) applied so the model faces correctly in the
   *  layout. Tuned per furniture type (the model is recentered to its footprint,
   *  so only facing needs a per-type value). */
  yawDeg?: number;
  /** Extra world-Y nudge (e.g. lift a surface item to the desk top). */
  yOff?: number;
  /** Target world height (≈ tiles) the model is scaled to. Human-relative so
   *  furniture sits at the right size next to the ~1.6-tall characters instead
   *  of being scaled to fill its (generous) tile footprint and burying them. */
  hWorld?: number;
}

/** A role-bound character that is pinned to a fixed seat in a room and never
 *  wanders (orchestrator, devops). Kept out of the agent skin spread. */
export interface FixedCharacterEntry {
  model: string;
  gender?: string;
  /** Fixed tile the character is seated on. */
  col: number;
  row: number;
  /** Facing: 'down' | 'up' | 'left' | 'right'. */
  facing?: string;
}

export interface EnvironmentManifest {
  /** 1×1-tile wall unit GLB. null → B renders a box. */
  wallModel?: string | null;
  /** Floor texture. null → B uses a solid material. */
  floorTexture?: string | null;
}

export interface AssetManifest {
  version: number;
  characterRig: CharacterRigManifest;
  characters: CharacterEntry[];
  /** role ('orchestrator' | 'devops') → fixed seated character. */
  fixedCharacters?: Record<string, FixedCharacterEntry>;
  furniture?: Record<string, FurnitureEntry>;
  environment?: EnvironmentManifest;
}

/** Trailing-slash-normalized assets3d base URL derived from the app base. */
export function assets3dBase(appBase: string): string {
  const b = appBase.endsWith('/') ? appBase : `${appBase}/`;
  return `${b}assets3d/`;
}

/**
 * Fetch + validate the manifest. Returns null on any failure (missing file,
 * bad JSON, missing required fields) so the renderer falls back to primitives.
 * This is the ONLY place that decides "manifest usable or not".
 */
export async function loadManifest(appBase: string): Promise<AssetManifest | null> {
  const url = `${assets3dBase(appBase)}manifest.json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const m = (await res.json()) as Partial<AssetManifest>;
    if (!m || typeof m !== 'object') return null;
    const rig = m.characterRig;
    if (!rig?.clips || !rig.clips.idle || !rig.clips.walk) return null;
    if (!Array.isArray(m.characters)) return null;
    return m as AssetManifest;
  } catch {
    // No assets3d yet (A not merged) or offline — fallback path handles it.
    return null;
  }
}

/**
 * Pick a GLB for an agent. Spreads across ALL manifest models by agent id so
 * distinct agents render as distinct characters — not just the 6 palette skins
 * (the old palette-keyed lookup collapsed palette 5 onto model 0 and never used
 * models beyond the 6th palette). When there are more agents than models the id
 * wraps; the per-agent hueShift tint (applied in CharacterRig) keeps the repeats
 * visually distinct. Returns null when there are no models (→ primitive fallback).
 */
export function modelUrlForAgent(
  manifest: AssetManifest | null,
  base: string,
  agentId: number,
): string | null {
  if (!manifest || manifest.characters.length === 0) return null;
  const n = manifest.characters.length;
  const idx = ((agentId % n) + n) % n;
  return base + manifest.characters[idx].model;
}

/** Gender of the model an agent maps to (same id→model spread as modelUrlForAgent).
 *  Defaults to 'male' when unknown so the seated-rest set is always defined. */
export function genderForAgent(manifest: AssetManifest | null, agentId: number): 'male' | 'female' {
  if (!manifest || manifest.characters.length === 0) return 'male';
  const n = manifest.characters.length;
  const idx = ((agentId % n) + n) % n;
  return manifest.characters[idx].gender === 'female' ? 'female' : 'male';
}

// Role detection for the two fixed characters. The runner labels the lead role
// (총괄/orchestrator) and a devops role (데브옵스/dev.obv); match either language.
const ORCH_RE = /orchestrat|오케스트|총괄/i;
const DEVOPS_RE = /devops|데브옵스|dev[.\s]?obv|운영/i;

/** Map a character (by its team role / lead flag) to a fixed-character role key,
 *  or null if it's an ordinary mobile agent. */
export function fixedRoleFor(
  manifest: AssetManifest | null,
  agentName: string | undefined,
  isTeamLead: boolean | undefined,
): string | null {
  const fc = manifest?.fixedCharacters;
  if (!fc) return null;
  if (fc.orchestrator && (isTeamLead || (agentName != null && ORCH_RE.test(agentName)))) {
    return 'orchestrator';
  }
  if (fc.devops && agentName != null && DEVOPS_RE.test(agentName)) return 'devops';
  return null;
}

/** The fixed-character entry for a role, or null. */
export function fixedCharForRole(
  manifest: AssetManifest | null,
  role: string | null,
): FixedCharacterEntry | null {
  if (!role) return null;
  return manifest?.fixedCharacters?.[role] ?? null;
}

/** Resolved GLB url for a fixed role, or null. */
export function fixedCharModelUrl(
  manifest: AssetManifest | null,
  base: string,
  role: string | null,
): string | null {
  const e = fixedCharForRole(manifest, role);
  return e ? base + e.model : null;
}

/** Gender of a fixed role's model (defaults male). */
export function fixedCharGenderForRole(
  manifest: AssetManifest | null,
  role: string | null,
): 'male' | 'female' {
  return fixedCharForRole(manifest, role)?.gender === 'female' ? 'female' : 'male';
}
