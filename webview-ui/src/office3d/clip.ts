// Animation clip selection. Pure function, unit-tested in clip.test.ts.
//
// Behaviour (user spec):
// - Mobile agents sit at a desk ONLY while actively working; seated work uses
//   exactly two clips — typing (write/edit/bash…) and asking_question (read/
//   review…). [selectClip: TYPE + isActive]
// - When NOT working they wander freely; the plain idle pose is never shown. The
//   full gender-appropriate "neutral" motion pool plays only inside the lounge
//   (the right sofa room). [IDLE + inLounge, and TYPE + !isActive on a sofa]
// - Fixed role characters (orchestrator/devops) are always seated: typing only
//   while working, otherwise a calm static sitting pose. [isFixed]

import { isReadingToolName } from '../office/toolUtils.js';
import { CharacterState } from '../office/types.js';
import type { ClipKey } from './manifest.js';

export interface ClipOpts {
  /** The agent is actively working (live task / real API). */
  isActive?: boolean;
  /** Model gender — picks the neutral motion pool. */
  gender?: 'male' | 'female';
  /** Cycles the neutral pool over time (advanced by the rig on a timer). */
  variant?: number;
  /** The character is inside the lounge (right sofa room) — gate for neutrals. */
  inLounge?: boolean;
  /** Fixed role character (always seated). */
  isFixed?: boolean;
}

// Gender-appropriate neutral motion pools (used only in the lounge / when seated
// resting). Female-tagged + funny/lady go to women; the male-tagged + neutral
// ones to men. Standing (phone/pain) and laying poses are included so "all the
// neutral motions" get used; the rig cycles `variant` through them.
const FEMALE_NEUTRAL: readonly ClipKey[] = [
  'sitFunny',
  'sitLady',
  'sitFemale',
  'sitTalk',
  'sitLaugh',
  'phone',
  'pain',
  'layFemale',
];
const MALE_NEUTRAL: readonly ClipKey[] = [
  'sitRead',
  'sitTalk',
  'sitLaugh',
  'phone',
  'pain',
  'layMale',
];

function neutral(gender: 'male' | 'female', variant: number): ClipKey {
  const pool = gender === 'female' ? FEMALE_NEUTRAL : MALE_NEUTRAL;
  return pool[((variant % pool.length) + pool.length) % pool.length];
}

/** Active seated work → typing (write tools) or asking_question (read tools). */
function workClip(tool: string | null): ClipKey {
  return isReadingToolName(tool) ? 'sitAsk' : 'sitType';
}

export function selectClip(state: string, tool: string | null, opts: ClipOpts = {}): ClipKey {
  const { isActive = true, gender = 'male', variant = 0, inLounge = false, isFixed = false } = opts;

  // Fixed role characters never move: working → typing; idle → calm sitting pose.
  if (isFixed) {
    if (isActive) return workClip(tool);
    return gender === 'female' ? 'sitFemale' : 'sitRead';
  }

  if (state === CharacterState.WALK) return 'walk';

  if (state === CharacterState.TYPE) {
    // A mobile agent is only seated at a desk while working.
    if (isActive) return workClip(tool);
    // Seated but not working (a lounge sofa) → gender neutral pool.
    return neutral(gender, variant);
  }

  // IDLE = stationary between wander moves (the rig plays 'walk' only in the WALK
  // state, i.e. while actually travelling). Inside the lounge, cycle the seated
  // neutral pool; everywhere else stand in the neutral idle pose. (Previously this
  // returned 'walk', so a paused agent walked in place — and right after a work
  // turn it did so ON its chair for up to WANDER_PAUSE_MAX seconds, reading as
  // "stuck walking on the chair". User: idle agents should wander freely and rest
  // in a neutral pose, not march in place.)
  if (inLounge) return neutral(gender, variant);
  return 'idle';
}
