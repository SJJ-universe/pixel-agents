import { describe, expect, it } from 'vitest';

import { setProviderCapabilities } from '../office/toolUtils.js';
import { CharacterState } from '../office/types.js';
import { selectClip } from './clip.js';

// The reading-vs-typing split depends on provider capabilities (which tools are
// "reading"). Seed them the way the runtime does after `providerCapabilities`.
setProviderCapabilities({
  readingTools: ['Read', 'Grep', 'Glob', 'WebFetch'],
  subagentToolNames: ['Task'],
});

describe('selectClip (3D clip selection)', () => {
  it('WALK → walk', () => {
    expect(selectClip(CharacterState.WALK, null)).toBe('walk');
    expect(selectClip(CharacterState.WALK, 'Edit')).toBe('walk');
  });

  it('IDLE outside the lounge → walk (the static idle pose is never shown)', () => {
    expect(selectClip(CharacterState.IDLE, null)).toBe('walk');
    expect(selectClip(CharacterState.IDLE, null, { inLounge: false })).toBe('walk');
  });

  it('IDLE inside the lounge → gender neutral pool', () => {
    expect(
      selectClip(CharacterState.IDLE, null, { inLounge: true, gender: 'female', variant: 0 }),
    ).toBe('sitFunny');
    expect(
      selectClip(CharacterState.IDLE, null, { inLounge: true, gender: 'male', variant: 0 }),
    ).toBe('sitRead');
  });

  it('active work → typing (write tools) or asking_question (read tools)', () => {
    expect(selectClip(CharacterState.TYPE, 'Edit')).toBe('sitType');
    expect(selectClip(CharacterState.TYPE, 'Bash')).toBe('sitType');
    expect(selectClip(CharacterState.TYPE, null)).toBe('sitType');
    expect(selectClip(CharacterState.TYPE, 'Read')).toBe('sitAsk');
    expect(selectClip(CharacterState.TYPE, 'Grep')).toBe('sitAsk');
  });

  it('seated but not working → gender neutral pool, cycled by variant', () => {
    const rest = (gender: 'male' | 'female', variant: number) =>
      selectClip(CharacterState.TYPE, null, { isActive: false, gender, variant });
    expect(rest('female', 0)).toBe('sitFunny');
    expect(rest('female', 1)).toBe('sitLady');
    expect(rest('female', 2)).toBe('sitFemale');
    expect(rest('male', 0)).toBe('sitRead');
    expect(rest('male', 1)).toBe('sitTalk');
  });

  it('fixed role character → typing while working, calm sitting pose otherwise', () => {
    expect(selectClip(CharacterState.TYPE, 'Edit', { isFixed: true, isActive: true })).toBe(
      'sitType',
    );
    expect(selectClip(CharacterState.TYPE, 'Read', { isFixed: true, isActive: true })).toBe(
      'sitAsk',
    );
    expect(
      selectClip(CharacterState.IDLE, null, { isFixed: true, isActive: false, gender: 'female' }),
    ).toBe('sitFemale');
    expect(
      selectClip(CharacterState.IDLE, null, { isFixed: true, isActive: false, gender: 'male' }),
    ).toBe('sitRead');
  });
});
