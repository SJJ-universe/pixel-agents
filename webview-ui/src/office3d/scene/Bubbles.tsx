// Head-mounted speech bubble + info panel for a character, as a screen-space
// drei <Html> overlay. Mirrors the 2D ToolOverlay: permission/waiting bubble,
// team role line, activity text, folder name, token fuel gauge, and a close (×)
// button. State is read imperatively each frame and pushed to the DOM only on
// change — no per-frame React renders (docs/3d-migration-plan.md §B5).

import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';

import {
  BUBBLE_FADE_DURATION_SEC,
  MAX_CONTEXT_TOKENS,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
} from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import {
  getActivityText,
  getFuelColor,
  IDLE_ACTIVITY_TEXT,
  WAITING_INPUT_ACTIVITY_TEXT,
} from '../../office/activity.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import type { ToolActivity } from '../../office/types.js';

interface HeadBubbleProps {
  id: number;
  officeState: OfficeState;
  /** World-space head height to anchor the overlay above. */
  headY: number;
  alwaysShowLabels: boolean;
  agentTools: Record<number, ToolActivity[]>;
  subagentCharacters: SubagentCharacter[];
  onCloseAgent: (id: number) => void;
  /** Live UI multiplier on bubble size (Office3D label −/+ control). */
  labelScale: number;
}

// office3d/** is whitelisted for inline colors (see webview-ui/eslint.config.js).
const PERMISSION_BG = '#f5a623';
const WAITING_COLOR = '#44cc44';
const LABEL_BG = 'rgba(20,20,32,0.85)';
const LABEL_FG = '#e6e6f0';
const FOLDER_FG = '#9a9ab0';
const GAUGE_BG = '#2a2a3a';
const GAUGE_W = 48;
const GAUGE_H = 4;

/** Resolve the activity line, including the sub-agent label path (2D parity). */
function activityFor(
  id: number,
  ch: {
    isActive: boolean;
    bubbleType: 'permission' | 'waiting' | null;
    waitingAwaitingInput?: boolean;
    isSubagent: boolean;
  },
  agentTools: Record<number, ToolActivity[]>,
  subs: SubagentCharacter[],
): string {
  if (ch.bubbleType === 'waiting' && ch.waitingAwaitingInput) return WAITING_INPUT_ACTIVITY_TEXT;
  if (ch.isSubagent) {
    if (ch.bubbleType === 'permission') return '승인 필요';
    return subs.find((s) => s.id === id)?.label ?? '하위 작업';
  }
  return getActivityText(
    id,
    agentTools,
    ch.isActive,
    ch.bubbleType,
    ch.waitingAwaitingInput ?? false,
  );
}

export function HeadBubble({
  id,
  officeState,
  headY,
  alwaysShowLabels,
  agentTools,
  subagentCharacters,
  onCloseAgent,
  labelScale,
}: HeadBubbleProps) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const roleRef = useRef<HTMLDivElement>(null);
  const activityRef = useRef<HTMLDivElement>(null);
  const folderRef = useRef<HTMLDivElement>(null);
  const gaugeRef = useRef<HTMLDivElement>(null);
  const gaugeFillRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastSig = useRef('');

  useFrame(() => {
    const ch = officeState.characters.get(id);
    const bubbleEl = bubbleRef.current;
    const panelEl = panelRef.current;
    if (!ch || !bubbleEl || !panelEl) return;

    const isSelected = officeState.selectedAgentId === id;
    const isHovered = officeState.hoveredAgentId === id;
    const isSub = ch.isSubagent;
    const kind = ch.bubbleType ?? 'none';

    // ── Bubble (permission "…" / waiting dot) — opacity updated every frame ──
    // A finished turn (waiting && !awaitingInput) shows ONLY the checkmark.
    const isDone = kind === 'waiting' && !ch.waitingAwaitingInput;
    // Full panel (role/folder/gauge/×) shows on hover/select/always-labels.
    const fullPanel =
      (alwaysShowLabels || isSelected || isHovered) && !(isDone && !isSelected && !isHovered);
    // Compact "[doing X]" bubble shows whenever the agent is actively working,
    // even when not selected — the 3D equivalent of the 2D character animating.
    const hasActiveTool = agentTools[id]?.some((t) => !t.done) ?? false;
    const activity =
      fullPanel || hasActiveTool ? activityFor(id, ch, agentTools, subagentCharacters) : '';
    const compactActivity =
      !fullPanel && hasActiveTool && activity !== '' && activity !== IDLE_ACTIVITY_TEXT;
    const panelVisible = fullPanel || compactActivity;

    // role/folder/gauge/× are full-panel only; the compact bubble is task-only.
    // Show the lead's role name when it has one (Gemma roles), else the 'LEAD' tag
    // (real Claude team leads carry no agentName) — keeps both paths working.
    const roleLabel =
      fullPanel && ch.teamName ? (ch.isTeamLead ? ch.agentName || 'LEAD' : ch.agentName || '') : '';
    const folder = fullPanel ? (ch.folderName ?? '') : '';
    const totalTokens = ch.inputTokens + ch.outputTokens;
    const showGauge = fullPanel && !!ch.teamName && totalTokens > 0;
    const ratio = totalTokens / MAX_CONTEXT_TOKENS;
    const showClose = isSelected && !isSub;

    const sig = `${kind}|${panelVisible ? 1 : 0}|${roleLabel}|${activity}|${folder}|${showGauge ? ratio.toFixed(3) : ''}|${showClose ? 1 : 0}`;
    if (sig !== lastSig.current) {
      lastSig.current = sig;

      // Bubble shape
      if (kind === 'permission') {
        bubbleEl.textContent = '…';
        bubbleEl.style.display = 'block';
        bubbleEl.style.background = PERMISSION_BG;
        bubbleEl.style.color = '#1e1e2e';
        bubbleEl.style.width = 'auto';
        bubbleEl.style.height = 'auto';
        bubbleEl.style.borderRadius = '8px';
        bubbleEl.style.padding = '0 6px';
      } else if (kind === 'waiting') {
        bubbleEl.textContent = '';
        bubbleEl.style.display = 'block';
        bubbleEl.style.background = WAITING_COLOR;
        bubbleEl.style.width = '10px';
        bubbleEl.style.height = '10px';
        bubbleEl.style.padding = '0';
        bubbleEl.style.borderRadius = '50%';
      } else {
        bubbleEl.style.display = 'none';
      }

      // Panel
      panelEl.style.display = panelVisible ? 'flex' : 'none';
      if (panelVisible) {
        const roleEl = roleRef.current;
        if (roleEl) {
          roleEl.style.display = roleLabel ? 'block' : 'none';
          roleEl.textContent = roleLabel;
          roleEl.style.color = ch.isTeamLead ? TEAM_LEAD_COLOR : TEAM_ROLE_COLOR;
          roleEl.style.fontWeight = ch.isTeamLead ? '700' : '400';
        }
        if (activityRef.current) {
          activityRef.current.textContent = activity;
          activityRef.current.style.fontStyle = isSub ? 'italic' : 'normal';
        }
        if (folderRef.current) {
          folderRef.current.style.display = folder ? 'block' : 'none';
          folderRef.current.textContent = folder;
        }
        if (gaugeRef.current) gaugeRef.current.style.display = showGauge ? 'block' : 'none';
        if (showGauge && gaugeFillRef.current) {
          gaugeFillRef.current.style.width = `${Math.min(ratio * 100, 100)}%`;
          gaugeFillRef.current.style.background = getFuelColor(ratio);
        }
        if (closeRef.current) closeRef.current.style.display = showClose ? 'block' : 'none';
      }
    }

    // Waiting bubble fades as its timer runs down.
    if (kind === 'waiting') {
      bubbleEl.style.opacity = String(Math.min(1, ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC));
    } else if (kind === 'permission') {
      bubbleEl.style.opacity = '1';
    }
  });

  return (
    <Html position={[0, headY, 0]} center distanceFactor={undefined} zIndexRange={[10, 0]}>
      <div
        style={{
          pointerEvents: 'none',
          userSelect: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '3px',
          fontFamily: 'inherit',
          fontSize: '11px',
          lineHeight: '14px',
          // Anchor the bottom (nearest the head) and scale upward so the −/+
          // control resizes labels in place without drifting off the character.
          transform: `translateY(-100%) scale(${labelScale})`,
          transformOrigin: 'bottom center',
        }}
      >
        <div ref={bubbleRef} style={{ display: 'none', fontWeight: 700, textAlign: 'center' }} />
        <div
          ref={panelRef}
          style={{
            display: 'none',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1px',
            background: LABEL_BG,
            color: LABEL_FG,
            padding: '2px 6px',
            borderRadius: '3px',
            whiteSpace: 'nowrap',
            maxWidth: '220px',
          }}
        >
          <div ref={roleRef} style={{ display: 'none', lineHeight: '12px' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <div
              ref={activityRef}
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '190px' }}
            />
            <button
              ref={closeRef}
              onClick={(e) => {
                e.stopPropagation();
                onCloseAgent(id);
              }}
              title="Close agent"
              style={{
                display: 'none',
                pointerEvents: 'auto',
                cursor: 'pointer',
                background: 'transparent',
                border: 'none',
                color: LABEL_FG,
                fontWeight: 700,
                padding: '0 2px',
                lineHeight: '12px',
              }}
            >
              ×
            </button>
          </div>
          <div
            ref={folderRef}
            style={{ display: 'none', fontSize: '9px', color: FOLDER_FG, lineHeight: '11px' }}
          />
          <div
            ref={gaugeRef}
            style={{
              display: 'none',
              width: GAUGE_W,
              height: GAUGE_H,
              background: GAUGE_BG,
              marginTop: '1px',
            }}
          >
            <div
              ref={gaugeFillRef}
              style={{ width: '0%', height: '100%', background: WAITING_COLOR }}
            />
          </div>
        </div>
      </div>
    </Html>
  );
}
