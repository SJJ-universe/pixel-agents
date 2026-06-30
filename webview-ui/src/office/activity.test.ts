import { describe, expect, it } from 'vitest';

import {
  getActivityText,
  getFuelColor,
  IDLE_ACTIVITY_TEXT,
  PERMISSION_ACTIVITY_TEXT,
  WAITING_INPUT_ACTIVITY_TEXT,
} from './activity.js';
import type { ToolActivity } from './types.js';

const tool = (status: string, done = false, permissionWait = false): ToolActivity => ({
  toolId: status,
  status,
  done,
  permissionWait,
});

describe('getActivityText', () => {
  it('permission bubble wins over everything', () => {
    expect(getActivityText(1, {}, true, 'permission', false)).toBe(PERMISSION_ACTIVITY_TEXT);
  });

  it('idle-waiting shows the dedicated label; finished-turn falls through to Idle', () => {
    expect(getActivityText(1, {}, false, 'waiting', true)).toBe(WAITING_INPUT_ACTIVITY_TEXT);
    expect(getActivityText(1, {}, false, 'waiting', false)).toBe(IDLE_ACTIVITY_TEXT);
  });

  it('returns the latest non-done tool status, or last status while active', () => {
    expect(
      getActivityText(1, { 1: [tool('Reading a.ts'), tool('Running bash')] }, true, null, false),
    ).toBe('Running bash');
    expect(getActivityText(1, { 1: [tool('Editing x', true)] }, true, null, false)).toBe(
      'Editing x',
    );
    expect(getActivityText(1, { 1: [tool('Editing x', true)] }, false, null, false)).toBe(
      IDLE_ACTIVITY_TEXT,
    );
  });

  it('a tool awaiting permission reports Needs approval', () => {
    expect(getActivityText(1, { 1: [tool('Bash', false, true)] }, true, null, false)).toBe(
      PERMISSION_ACTIVITY_TEXT,
    );
  });
});

describe('getFuelColor', () => {
  it('escalates green → yellow → orange → red by ratio', () => {
    const colors = [0.1, 0.7, 0.92, 0.99].map(getFuelColor);
    expect(new Set(colors).size).toBe(4); // four distinct thresholds
  });
});
