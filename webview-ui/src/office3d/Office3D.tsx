// 3D renderer entry point (PART B of docs/3d-migration-plan.md). Drop-in
// alternative to <OfficeCanvas>: consumes the same OfficeState, reimplements no
// simulation. Works with zero assets (primitive fallbacks); auto-upgrades to
// real models when A's assets3d/manifest.json lands.

import { Canvas, useFrame } from '@react-three/fiber';
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';

import { MAX_DELTA_TIME_SEC } from '../constants.js';
import type { SubagentCharacter } from '../hooks/useExtensionMessages.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { Direction, type ToolActivity } from '../office/types.js';
import { isGemmaDemo } from '../runtime.js';
import { ChatPanel } from './ChatPanel.js';
import { FORWARD_DIR_TO_DIRECTION, SCENE_BG_COLOR } from './constants3d.js';
import type { AssetManifest } from './manifest.js';
import { assets3dBase, fixedCharForRole, fixedRoleFor, loadManifest } from './manifest.js';
import { type CameraMode, CameraRig } from './scene/CameraRig.js';
import { CharacterRig } from './scene/CharacterRig.js';
import { Furniture } from './scene/Furniture.js';
import { Ground } from './scene/Ground.js';

interface Office3DProps {
  officeState: OfficeState;
  onClick: (agentId: number) => void;
  alwaysShowLabels: boolean;
  /** App base URL (import.meta.env.BASE_URL); assets3d is resolved beneath it. */
  assetBase: string;
  /** Per-agent tool activity (App state, not OfficeState) — drives the label text. */
  agentTools: Record<number, ToolActivity[]>;
  subagentCharacters: SubagentCharacter[];
  onCloseAgent: (id: number) => void;
}

interface SceneRootProps {
  officeState: OfficeState;
  onClick: (agentId: number) => void;
  manifest: AssetManifest | null;
  base: string;
  alwaysShowLabels: boolean;
  agentTools: Record<number, ToolActivity[]>;
  subagentCharacters: SubagentCharacter[];
  onCloseAgent: (id: number) => void;
  labelScale: number;
}

// Head-bubble size control (office3d/** is inline-color whitelisted). Default is
// 1.25× the base so labels read comfortably; the on-screen −/+ adjusts live.
const LABEL_SCALE_DEFAULT = 1.25;
const LABEL_SCALE_MIN = 0.75;
const LABEL_SCALE_MAX = 2.5;
const LABEL_SCALE_STEP = 0.25;
const PANEL_BG = '#1e1e2e';
const PANEL_BORDER = '#3a3a5c';
const PANEL_FG = '#e6e6f0';

/** Lives inside <Canvas>. Drives the simulation once per frame and tracks the
 *  set of live character ids (re-renders only on spawn/despawn). */
function SceneRoot({
  officeState,
  onClick,
  manifest,
  base,
  alwaysShowLabels,
  agentTools,
  subagentCharacters,
  onCloseAgent,
  labelScale,
}: SceneRootProps) {
  // THE single place the simulation advances (mirrors gameLoop's 0.1s cap).
  useFrame((_, dt) => {
    officeState.update(Math.min(dt, MAX_DELTA_TIME_SEC));
  });

  // Pin the two fixed role characters (orchestrator/devops) to their room seats
  // once their team role resolves (arrives after spawn via setTeamInfo). Cheap:
  // skips everything already pinned or without a fixed role.
  useFrame(() => {
    if (!manifest?.fixedCharacters) return;
    for (const ch of officeState.getCharacters()) {
      if (ch.isFixed || ch.isSubagent) continue;
      const role = fixedRoleFor(manifest, ch.agentName, ch.isTeamLead);
      if (!role) continue;
      const e = fixedCharForRole(manifest, role);
      if (!e) continue;
      const dir = FORWARD_DIR_TO_DIRECTION[e.facing ?? 'down'] ?? Direction.DOWN;
      officeState.pinFixedCharacter(ch.id, e.col, e.row, dir);
    }
  });

  const [ids, setIds] = useState<number[]>(() => officeState.getCharacters().map((c) => c.id));
  const sigRef = useRef('');
  useFrame(() => {
    const chars = officeState.getCharacters();
    const sig = chars
      .map((c) => c.id)
      .sort((a, b) => a - b)
      .join(',');
    if (sig !== sigRef.current) {
      sigRef.current = sig;
      setIds(chars.map((c) => c.id));
    }
  });

  return (
    <group>
      <Ground officeState={officeState} />
      <Furniture officeState={officeState} manifest={manifest} base={base} />
      {ids.map((id) => (
        <CharacterRig
          key={id}
          id={id}
          officeState={officeState}
          manifest={manifest}
          base={base}
          alwaysShowLabels={alwaysShowLabels}
          onSelect={onClick}
          agentTools={agentTools}
          subagentCharacters={subagentCharacters}
          onCloseAgent={onCloseAgent}
          labelScale={labelScale}
        />
      ))}
    </group>
  );
}

export function Office3D({
  officeState,
  onClick,
  alwaysShowLabels,
  assetBase,
  agentTools,
  subagentCharacters,
  onCloseAgent,
}: Office3DProps) {
  const [manifest, setManifest] = useState<AssetManifest | null>(null);
  const [labelScale, setLabelScale] = useState(LABEL_SCALE_DEFAULT);
  const [cameraMode, setCameraMode] = useState<CameraMode>('ortho');
  const base = useMemo(() => assets3dBase(assetBase), [assetBase]);

  useEffect(() => {
    let live = true;
    void loadManifest(assetBase).then((m) => {
      if (live) setManifest(m);
    });
    return () => {
      live = false;
    };
  }, [assetBase]);

  return (
    <div
      className="w-full h-full"
      style={{ background: SCENE_BG_COLOR }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDownCapture={(e) => {
        // Left- or middle-drag pans the camera (OrbitControls). Cancel follow like
        // 2D on a button press — but NOT on wheel-zoom, which should keep following.
        // A left CLICK on a character re-sets follow on release (handleClick), so
        // selection still wins; only a drag actually pans.
        if (e.button === 0 || e.button === 1) officeState.cameraFollowId = null;
      }}
    >
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: true }}
        onCreated={({ scene, camera, gl }) => {
          // DEV-only handle for visual/e2e verification of the 3D scene graph.
          if (import.meta.env.DEV) {
            (globalThis as { __office3d?: unknown }).__office3d = {
              scene,
              camera,
              gl,
              officeState,
            };
          }
        }}
        onPointerMissed={() => {
          officeState.selectedAgentId = null;
          officeState.cameraFollowId = null;
        }}
      >
        <color attach="background" args={[SCENE_BG_COLOR]} />
        {/* Strong hemisphere fill so shadowed areas read as soft, not black. */}
        <hemisphereLight args={['#ffffff', '#52506a', 1.55]} />
        <directionalLight
          castShadow
          position={[10, 24, 9]}
          intensity={1.05}
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-camera-left={-30}
          shadow-camera-right={30}
          shadow-camera-top={30}
          shadow-camera-bottom={-30}
          shadow-camera-near={0.1}
          shadow-camera-far={120}
          shadow-bias={-0.0005}
          shadow-intensity={0.35}
        />
        <SceneRoot
          officeState={officeState}
          onClick={onClick}
          manifest={manifest}
          base={base}
          alwaysShowLabels={alwaysShowLabels}
          agentTools={agentTools}
          subagentCharacters={subagentCharacters}
          onCloseAgent={onCloseAgent}
          labelScale={labelScale}
        />
        <CameraRig officeState={officeState} cameraMode={cameraMode} />
      </Canvas>

      {/* Head-bubble size control. Pixel-toolbar styling to match BottomToolbar. */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 6px',
          background: PANEL_BG,
          border: `2px solid ${PANEL_BORDER}`,
          color: PANEL_FG,
          fontSize: 12,
          userSelect: 'none',
        }}
      >
        <span style={{ opacity: 0.8 }}>Labels</span>
        <button
          type="button"
          title="Smaller labels"
          onClick={() =>
            setLabelScale((s) => Math.max(LABEL_SCALE_MIN, +(s - LABEL_SCALE_STEP).toFixed(2)))
          }
          style={labelBtnStyle}
        >
          −
        </button>
        <span style={{ minWidth: 32, textAlign: 'center' }}>{Math.round(labelScale * 100)}%</span>
        <button
          type="button"
          title="Larger labels"
          onClick={() =>
            setLabelScale((s) => Math.min(LABEL_SCALE_MAX, +(s + LABEL_SCALE_STEP).toFixed(2)))
          }
          style={labelBtnStyle}
        >
          +
        </button>
      </div>

      {/* 총괄 chat — only in the Gemma-demo / dev build, where the runner backend
          (POST /command + SSE) exists to drive the agents from natural language. */}
      {(isGemmaDemo || import.meta.env.DEV) && <ChatPanel />}

      {/* Camera-mode toggle: top-down diorama vs first-person walkthrough. */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          display: 'flex',
          gap: 4,
          padding: '4px',
          background: PANEL_BG,
          border: `2px solid ${PANEL_BORDER}`,
          userSelect: 'none',
        }}
      >
        <button
          type="button"
          onClick={() => setCameraMode('ortho')}
          style={cameraMode === 'ortho' ? camBtnActive : camBtnStyle}
        >
          탑다운
        </button>
        <button
          type="button"
          onClick={() => setCameraMode('firstperson')}
          style={cameraMode === 'firstperson' ? camBtnActive : camBtnStyle}
        >
          1인칭
        </button>
      </div>

      {/* First-person control hint. */}
      {cameraMode === 'firstperson' && (
        <div
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '6px 12px',
            background: PANEL_BG,
            border: `2px solid ${PANEL_BORDER}`,
            color: PANEL_FG,
            fontSize: 12,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          화면을 클릭해 마우스로 둘러보기 · WASD/화살표 이동 · Shift 달리기 · ESC 해제
        </div>
      )}
    </div>
  );
}

const camBtnStyle: CSSProperties = {
  cursor: 'pointer',
  background: 'transparent',
  border: 'none',
  color: PANEL_FG,
  fontWeight: 400,
  fontSize: 12,
  padding: '3px 8px',
};
const camBtnActive: CSSProperties = { ...camBtnStyle, background: PANEL_BORDER, fontWeight: 700 };

const labelBtnStyle: CSSProperties = {
  cursor: 'pointer',
  background: PANEL_BORDER,
  border: 'none',
  color: PANEL_FG,
  fontWeight: 700,
  fontSize: 14,
  lineHeight: '14px',
  width: 22,
  height: 22,
};
