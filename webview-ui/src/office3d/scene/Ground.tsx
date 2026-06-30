// Floor plane + wall instances, plus floor-level pointer interaction (seat
// reassign / send-to-seat / right-click walk). All interaction reuses existing
// OfficeState methods — no logic is reimplemented (docs/3d-migration-plan.md §B4, §B7).
//
// Map fidelity: the floor is textured with the SAME colorized 2D floor art
// (buildFloorTexture) and walls are tinted per-tile with the 2D wall color math
// (wallColorToHex), so the 3D environment matches the pixel office.

import { Instance, Instances } from '@react-three/drei';
import { type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';

import type { OfficeState } from '../../office/engine/officeState.js';
import type { ColorValue } from '../../office/types.js';
import { TileType } from '../../office/types.js';
import { transport } from '../../transport/index.js';
import { WALL_COLOR_3D, WALL_HEIGHT_WORLD } from '../constants3d.js';
import { buildFloorTexture } from '../textures.js';

// 2D wallColorToHex can resolve to pure black (the default wall color has b=-100
// → lightness 0). A flat black box reads as a hole, so floor the lightness: the
// wall becomes a dark divider that still carries the layout's hue/saturation.
const _wc = new THREE.Color();
function wall3DColor(tc: ColorValue): string {
  const l = Math.max(0.22, Math.min(0.85, 0.5 + tc.b / 200));
  const h = (((tc.h % 360) + 360) % 360) / 360;
  return `#${_wc.setHSL(h, Math.min(1, tc.s / 100), l).getHexString()}`;
}

interface GroundProps {
  officeState: OfficeState;
}

/** Mirror of OfficeCanvas's saveAgentSeats payload (excludes sub-agents). */
function saveSeats(os: OfficeState): void {
  const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {};
  for (const ch of os.characters.values()) {
    if (ch.isSubagent) continue;
    seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId };
  }
  transport.send({ type: 'saveAgentSeats', seats });
}

export function Ground({ officeState }: GroundProps) {
  const layout = officeState.getLayout();
  const cols = layout.cols;
  const rows = layout.rows;
  const sig = `${cols}x${rows}:${layout.layoutRevision ?? 0}:${layout.tiles.length}`;

  // Per-tile wall color (2D Colorize math); falls back to the flat 3D wall color.
  const walls = useMemo(() => {
    const out: Array<{ c: number; r: number; color: string }> = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        if (layout.tiles[idx] !== TileType.WALL) continue;
        const tc = layout.tileColors?.[idx];
        out.push({ c, r, color: tc ? wall3DColor(tc) : WALL_COLOR_3D });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Floor art texture (assets load before layoutLoaded per the documented order,
  // so floor sprites are present by the time this sig is meaningful).
  const floorTex = useMemo(() => buildFloorTexture(layout), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => floorTex?.dispose(), [floorTex]);

  const handleFloorClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const sel = officeState.selectedAgentId;
    if (sel === null) return;
    const selCh = officeState.characters.get(sel);
    if (!selCh) return;
    if (selCh.isSubagent) {
      officeState.selectedAgentId = null;
      officeState.cameraFollowId = null;
      return;
    }
    const col = Math.floor(e.point.x);
    const row = Math.floor(e.point.z);
    const seatId = officeState.getSeatAtTile(col, row);
    if (seatId) {
      const seat = officeState.seats.get(seatId);
      if (seat) {
        if (selCh.seatId === seatId) {
          officeState.sendToSeat(sel);
          officeState.selectedAgentId = null;
          officeState.cameraFollowId = null;
          return;
        }
        if (!seat.assigned) {
          officeState.reassignSeat(sel, seatId);
          saveSeats(officeState);
          officeState.selectedAgentId = null;
          officeState.cameraFollowId = null;
          return;
        }
      }
    }
    // Clicked empty floor — deselect.
    officeState.selectedAgentId = null;
    officeState.cameraFollowId = null;
  };

  const handleFloorContext = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const sel = officeState.selectedAgentId;
    if (sel === null) return;
    officeState.walkToTile(sel, Math.floor(e.point.x), Math.floor(e.point.z));
  };

  return (
    <group>
      {/* Invisible interaction plane spanning the whole grid: carries click /
          right-click-walk raycasting so empty (VOID) tiles still respond, but is
          not drawn — the old tan base-ground slab is gone, so the painted rooms
          read as a floating diorama on the scene background. */}
      <mesh
        rotation-x={-Math.PI / 2}
        position={[cols / 2, -0.02, rows / 2]}
        onClick={handleFloorClick}
        onContextMenu={handleFloorContext}
      >
        <planeGeometry args={[cols, rows]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* Colored room art on top; transparent where there is no FLOOR tile. */}
      {floorTex && (
        <mesh receiveShadow rotation-x={-Math.PI / 2} position={[cols / 2, 0, rows / 2]}>
          <planeGeometry args={[cols, rows]} />
          <meshStandardMaterial map={floorTex} transparent alphaTest={0.5} />
        </mesh>
      )}

      {walls.length > 0 && (
        <Instances limit={walls.length} castShadow receiveShadow>
          <boxGeometry args={[1, WALL_HEIGHT_WORLD, 1]} />
          <meshStandardMaterial />
          {walls.map((w, i) => (
            <Instance
              key={i}
              position={[w.c + 0.5, WALL_HEIGHT_WORLD / 2, w.r + 0.5]}
              color={w.color}
            />
          ))}
        </Instances>
      )}
    </group>
  );
}
