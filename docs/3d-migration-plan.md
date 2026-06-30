# Pixel Agents → 3D 전환 플랜 (병렬 A/B 분리판)

> 대상 독자: 이 작업을 이어받는 **다른 에이전트/개발자**. 이 문서 하나로 컨텍스트 없이 착수 가능하도록 작성됨.
> 작성 기준 코드: `webview-ui/src/office/**` (2026-06 시점). 루트 `CLAUDE.md`의 아키텍처 설명과 함께 읽을 것.

---

## 0. 한 줄 요약

`pixel-agents`는 **게임이 아니라 시각화 레이어**다. 실행 중인 Claude Code 에이전트를 캐릭터로 보여준다.
시뮬레이션(상태/길찾기/좌석/FSM)은 전부 `OfficeState`(`webview-ui/src/office/engine/officeState.ts`)에 있고 **그래픽과 완전히 분리**돼 있다.
따라서 **백엔드·시뮬레이션은 한 줄도 건드리지 않고, 렌더러(`OfficeCanvas` Canvas2D)만 three.js로 교체**한다. Mixamo 캐릭터는 그 렌더러가 그리는 에셋일 뿐이다.

**Unity는 쓰지 않는다.** VS Code 웹뷰/브라우저 SPA 안에서 돌아야 하고, 그 순간 훅→에이전트 상태 파이프라인 전체를 버리게 된다. 이미 React 19가 있으니 `three` + `@react-three/fiber`(r3f) + `@react-three/drei`를 웹뷰 안에서 쓴다.

---

## 1. 목표 / 비목표

**목표**

- 2D 픽셀 사무실을 3D 씬으로 교체. 캐릭터 = Mixamo 휴머노이드(GLB) + 애니메이션 클립.
- 기존 UX 기능 보존: 캐릭터 선택/포커스, 좌석 재배정, 우클릭 이동, 카메라 follow, 말풍선(permission/waiting), 이름표, 스폰/디스폰 연출, 서브에이전트.
- **시뮬레이션 코드(`office/engine`, `office/layout`, `server/`, `core/`) 무변경.**

**비목표 (이번 범위 아님, `ponytail:`로 뒤로 미룸)**

- 레이아웃 에디터의 3D 편집(가구를 3D로 배치/회전하는 편집 UI). 에디터는 당분간 2D 캔버스 유지 또는 비활성.
- 전기제품 auto-ON 발광 연출(2D의 `rebuildFurnitureInstances` 효과). 1차에선 정적 모델만.
- 바닥/벽 per-tile 색상(`tileColors`) 정밀 재현. 1차엔 단색/단일 텍스처.
- 캐릭터 리타게팅 툴. **같은 Mixamo 스켈레톤**만 쓰면 불필요.

---

## 2. 아키텍처: 무엇을 재사용하고 무엇을 교체하나

```
[교체 안 함]  server/ · core/ · transport · useExtensionMessages · OfficeState · characters.ts(FSM)
                                  │  (매 프레임 이 객체를 "읽기만" 한다)
                                  ▼
[교체 함]     OfficeCanvas.tsx (Canvas2D)  ──►  Office3D.tsx (r3f, three.js)
              renderer.ts / sprites/                Office3D는 OfficeState를 구독해
              spriteData.ts (픽셀)                  3D 메시/애니메이션으로 그린다
```

`OfficeState`가 매 프레임 보유하는, B가 **읽기 전용**으로 소비할 데이터(이미 존재함, 그대로 씀):

| 소스                                                            | 타입                                      | 3D에서 쓰임                             |
| --------------------------------------------------------------- | ----------------------------------------- | --------------------------------------- |
| `officeState.getCharacters()`                                   | `Character[]`                             | 캐릭터 메시 1개/엔티티                  |
| `Character.x, .y`                                               | sprite px (중심)                          | 월드 좌표 = `x/16, y/16` (XZ 평면)      |
| `Character.dir`                                                 | `Direction`(0~3)                          | yaw 회전                                |
| `Character.state`                                               | `idle/walk/type`                          | 애니메이션 클립 선택                    |
| `Character.currentTool`                                         | `string\|null`                            | type일 때 read vs typing 클립 분기      |
| `Character.palette` (0~5), `.hueShift`(deg)                     |                                           | 캐릭터 모델/머티리얼 색                 |
| `Character.bubbleType`                                          | `permission/waiting/null`                 | 머리 위 말풍선 빌보드                   |
| `Character.matrixEffect`, `.matrixEffectTimer`                  | spawn/despawn                             | 스폰/디스폰 트랜지션                    |
| `Character.isSubagent`, `.teamName`, `.agentName`               |                                           | 이름표/라벨                             |
| `officeState.getLayout()`                                       | `OfficeLayout{cols,rows,tiles,furniture}` | 바닥/벽/가구 배치                       |
| `officeState.seats`                                             | `Map<string,Seat>`                        | 좌석 위치(디버그/배치 보조)             |
| `officeState.selectedAgentId / hoveredAgentId / cameraFollowId` |                                           | 선택 하이라이트/카메라                  |
| `officeState.update(dt)`                                        |                                           | **B가 매 프레임 호출**(시뮬레이션 진행) |

상호작용도 기존 메서드를 그대로 호출(중복 구현 금지):
`dismissBubble`, `reassignSeat`, `sendToSeat`, `walkToTile`, `getSeatAtTile`, 그리고 `transport.send({type:'saveAgentSeats',...})`.

> 검증된 상수: `TILE_SIZE=16`, `WALK_SPEED_PX_PER_SEC=48`(=3 tile/s), `ZOOM_MIN=1 ZOOM_MAX=10`, `CHARACTER_HIT_HEIGHT=24`.
> 방향: `Direction.DOWN=0, LEFT=1, RIGHT=2, UP=3`. 상태: `CharacterState.IDLE/WALK/TYPE`.

---

## 3. 계약 (THE CONTRACT) — A/B 독립의 핵심, 착수 전 동결할 것

A와 B는 **이 3가지에만 합의하면 서로를 전혀 보지 않아도 된다.** 변경 시 양쪽 합의 필수.

### 3.1 에셋 매니페스트 스키마 (A가 생산, B가 소비)

위치: `webview-ui/public/assets3d/manifest.json` (Vite `public/`이라 dev에서 `/assets3d/...`로 자동 서빙됨)

```jsonc
{
  "version": 1,
  "characterRig": {
    "heightWorld": 1.5, // 모델 키를 월드 1.5유닛(≈1.5타일)로 스케일. B가 scale 자동계산
    "forwardDir": "down", // 중립 포즈에서 모델이 바라보는 방향(=Direction.DOWN). yaw 보정 기준
    "clips": {
      // GLB 안 AnimationClip의 "실제 이름"을 표준 키에 매핑
      "idle": "Idle",
      "walk": "Walk",
      "sitType": "SitType",
      "sitRead": "SitRead",
    },
  },
  "characters": [
    // palette 인덱스(0~5) → 캐릭터 GLB. 누락 인덱스는 B가 0번으로 폴백
    { "palette": 0, "model": "characters/char_0.glb" },
    // ... 최대 6개
  ],
  "furniture": {
    // PlacedFurniture.type(문자열) → GLB. 누락 type은 B가 박스 폴백
    "DESK_FRONT": { "model": "furniture/desk.glb", "yaw0": "front" },
    "CHAIR_FRONT": { "model": "furniture/chair.glb", "yaw0": "front" },
    // ...
  },
  "environment": {
    "wallModel": "env/wall_1x1.glb", // 1x1타일 벽 유닛. null이면 B가 박스
    "floorTexture": "env/floor.png", // null이면 B가 단색 머티리얼
  },
}
```

**표준 클립 키(4종)는 고정 어휘다. 이름을 바꾸지 말 것:** `idle`, `walk`, `sitType`, `sitRead`.
A는 모든 캐릭터 GLB에 이 4개 클립을 **한 스켈레톤에 머지**해서 넣고, 실제 트랙 이름을 위 `clips`에 적는다.

### 3.2 좌표 / 방향 규약 (양쪽 공통)

- 1 타일 = 1 월드 유닛. 바닥은 **XZ 평면**, **Y가 위**.
- 캐릭터 위치: `world = (ch.x / 16, 0, ch.y / 16)`. (2D의 +y(아래) → 3D의 +z)
- 방향→yaw(중립이 DOWN/+Z를 본다고 가정, 다르면 `forwardDir`로 B가 보정):

  | Direction | yaw          |
  | --------- | ------------ |
  | DOWN(0)   | `0`          |
  | UP(3)     | `Math.PI`    |
  | LEFT(1)   | `+Math.PI/2` |
  | RIGHT(2)  | `-Math.PI/2` |

- 모델 단위 보정: Mixamo는 cm(100배)·Z-up·루트모션을 포함한다. **A가 변환 단계에서 미터·Y-up·in-place로 정규화**해서 내보낸다(§5). B는 추가 보정 안 함, `heightWorld`로 최종 스케일만.

### 3.3 애니메이션 선택 규칙 (B가 구현, A는 클립만 제공)

`getCharacterSprite`(`characters.ts:319`)의 2D 매핑을 1:1로 옮긴다:

```ts
// B: office3d/clip.ts  (단위 테스트로 고정 — 이 파트의 runnable check)
import { CharacterState } from '../office/types.js';
import { isReadingToolName } from '../office/toolUtils.js'; // 재사용, 중복 금지
export type ClipKey = 'idle' | 'walk' | 'sitType' | 'sitRead';
export function selectClip(state: string, tool: string | null): ClipKey {
  if (state === CharacterState.WALK) return 'walk';
  if (state === CharacterState.IDLE) return 'idle';
  return isReadingToolName(tool) ? 'sitRead' : 'sitType'; // TYPE
}
```

> 이 계약(§3.1~3.3)을 동결하면 A와 B는 **합류 전까지 서로의 산출물을 import하지 않는다.**

---

## 4. 파일 소유권 맵 — 충돌 0 보장

| 경로                            | 소유  | 비고                                     |
| ------------------------------- | ----- | ---------------------------------------- |
| `scripts/3d/**`                 | **A** | 변환 스크립트·노트·매니페스트 검증기     |
| `webview-ui/public/assets3d/**` | **A** | GLB/텍스처/`manifest.json` (산출물)      |
| `webview-ui/src/office3d/**`    | **B** | 새 r3f 렌더러 전체(신규 폴더)            |
| `webview-ui/package.json`       | **B** | three/r3f/drei devDep 추가               |
| `webview-ui/src/App.tsx`        | **B** | 렌더러 토글 1줄(§6)                      |
| `esbuild.js`(루트)              | **B** | `public/assets3d` → `dist/assets3d` 복사 |

- **A는 `webview-ui/src/**`·`package.json`·`esbuild.js`를 절대 건드리지 않는다.** 변환 툴은 `npx`로 실행(설치로 package.json 오염 금지).
- **B는 `assets3d/**`·`scripts/3d/**`를 절대 건드리지 않는다.** 에셋이 없으면 폴백 프리미티브로 동작.
- 새 상수는 B가 `office3d/constants3d.ts`에 둔다(공유 `constants.ts` 미수정 → 머지 충돌 회피).
- 권장: 각자 git worktree 1개씩(총 2개). 루트 `CLAUDE.md`의 동시 worktree ≤2~3 한도 안.

---

## 5. PART A — 에셋 파이프라인 (코드 무관, 완전 독립)

**산출물:** `webview-ui/public/assets3d/` 아래 GLB/텍스처 + `manifest.json`. 끝나면 B가 폴백을 실모델로 교체(코드 변경 없이 매니페스트가 채워지는 것만으로 동작).

### A1. 캐릭터 + 애니메이션 수급 (Mixamo)

- 캐릭터 모델 최대 6종(palette 0~5에 매핑). 다양성 원하면 6종, 최소 1종(나머지는 B가 hueShift로 색만 변형).
- 클립 4종을 **동일 캐릭터 스켈레톤**으로 다운로드(스켈레톤 공유 → 클립 호환, 리타게팅 불필요):
  - `idle` ← Mixamo "Idle" / "Breathing Idle"
  - `walk` ← "Walking" (**In Place 체크**)
  - `sitType` ← "Typing" (좌식 타이핑)
  - `sitRead` ← 좌식 "Reading"/"Looking" 류(없으면 sitType 재사용)
- 다운로드 옵션: 캐릭터는 스킨 포함 1개, 애니메이션은 **"Without Skin"**으로 받아 용량 절약.
- **반드시 In Place(루트모션 제거).** 위치는 시뮬레이션이 구동하므로 루트모션은 충돌한다.

### A2. FBX → GLB 변환 + 클립 머지

- Mixamo는 FBX, 웹은 GLB. 캐릭터 1개 메시 + 클립 4개를 **하나의 GLB**로 합친다(런타임에 `mixer`로 교체).
- 권장 경로(둘 중 택1):
  - **Blender**: FBX들 임포트 → NLA/Action으로 클립 정리 → 클립명을 `Idle/Walk/SitType/SitRead`로 → glTF(.glb) 익스포트. 임포트 시 100배 스케일·Z-up 보정.
  - **CLI**: `npx @gltf-transform/cli` 로 각 FBX를 glb로 변환 후 애니메이션 트랙을 한 파일에 병합·정리. (FBX 직접 입력이 어려우면 Blender 헤드리스 `blender --background --python convert.py` 사용)
- 정규화 산출 기준(§3.2 충족): 미터 단위, Y-up, in-place, 클립 4종 표준명.
- 변환 스크립트/노트는 `scripts/3d/`에 남긴다(재현성).

### A3. 환경/가구 모델 (Mixamo 아님 — 별도 수급)

- 바닥/벽/책상/의자/모니터/화분 등. **CC0 무료** 우선: Kenney "Furniture Kit", Quaternius, Poly Pizza. 유료 톤업: Synty POLYGON Office.
- 현재 2D 가구 카탈로그의 `type` 문자열(`furniture-catalog.json`의 id, 예 `DESK_FRONT`)에 1:1로 GLB를 매핑해 `manifest.furniture`에 등록.
- 벽은 1x1 타일 유닛 모델 1개면 충분(B가 벽 타일마다 인스턴스). 바닥은 텍스처 1장 or 생략.

### A4. 매니페스트 작성 + 검증 (이 파트의 runnable check)

- `manifest.json`을 §3.1 스키마로 채운다.
- `scripts/3d/check-manifest.mjs` (node, 의존성 0):
  ```js
  // 매니페스트 + 참조 파일 존재 + 클립키 4종 검증. CI/수동 게이트.
  import { readFileSync, existsSync } from 'node:fs';
  import { dirname, join } from 'node:path';
  const root = 'webview-ui/public/assets3d';
  const m = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const need = ['idle', 'walk', 'sitType', 'sitRead'];
  console.assert(
    need.every((k) => m.characterRig?.clips?.[k]),
    'clips 4종 누락',
  );
  console.assert(m.characters?.length >= 1, 'character 최소 1개');
  for (const c of m.characters) console.assert(existsSync(join(root, c.model)), `없음: ${c.model}`);
  for (const [t, f] of Object.entries(m.furniture ?? {}))
    console.assert(existsSync(join(root, f.model)), `없음: ${f.model}`);
  console.log('manifest OK');
  ```
  실행: `node scripts/3d/check-manifest.mjs`. (B에게 넘기기 전 통과 필수.)

**A 완료 정의(DoD):** `check-manifest.mjs` 통과 + 캐릭터 GLB를 임의 glTF 뷰어(예: https://gltf-viewer.donmccurdy.com)에 올렸을 때 4개 클립이 보이고 in-place로 재생됨.

---

## 6. PART B — r3f 렌더러 (에셋 무관, 플레이스홀더로 선행)

**산출물:** `webview-ui/src/office3d/**` 신규. 에셋이 0개여도 박스/캡슐로 완전 동작. A의 GLB가 들어오면 **자동으로** 실모델 렌더(분기는 "모델 로드 실패 시 폴백" 한 곳).

### B0. 의존성 + 개발 환경

- `cd webview-ui && npm i three @react-three/fiber @react-three/drei` (+ `@types/three` devDep).
- **개발은 웹뷰 CSP 마찰을 피해 standalone에서 먼저:** 루트에서 `npm run build` 후 `npx pixel-agents` 또는 `cd webview-ui && npm run dev`(Vite). 3D 확인 후 확장(F5)에서 최종 검증.
- WebGL은 Electron 웹뷰에서 동작하나 CSP가 막을 수 있음 → §9 참고.

### B1. 컴포넌트 골격

```
office3d/
  Office3D.tsx        // <Canvas> 진입점. App.tsx가 OfficeCanvas 대신 렌더
  scene/
    Ground.tsx        // layout.tiles → 바닥 평면 + 벽 인스턴스(WALL 타일)
    Furniture.tsx     // layout.furniture(PlacedFurniture) → GLB/박스
    Characters.tsx    // officeState.getCharacters() → <CharacterRig/> 다수
    CharacterRig.tsx  // GLB+AnimationMixer. selectClip로 크로스페이드, dir→yaw
    Bubbles.tsx       // drei <Html>/<Billboard> 말풍선·이름표
    CameraRig.tsx     // OrthographicCamera + follow/zoom/pan
  loader.ts           // useGLTF 래퍼 + 폴백 프리미티브
  clip.ts             // selectClip (§3.3) + 단위테스트
  constants3d.ts      // 3D 전용 상수(카메라 각도, lerp 등)
```

### B2. 루프 통합 (가장 중요한 한 줄)

`OfficeCanvas`는 `startGameLoop`에서 `officeState.update(dt)` + `renderFrame`을 돌린다. r3f는 자체 `useFrame` 루프가 있으므로:

```tsx
// Office3D 최상위에서 매 프레임 시뮬레이션 진행 (단 한 곳에서만 호출)
useFrame((_, dt) => officeState.update(Math.min(dt, 0.1))); // 0.1 cap = 기존 gameLoop와 동일
```

나머지 컴포넌트는 `officeState`를 **읽기만** 한다. React state로 끌어올리지 말 것(엔티티 수백 개, 매 프레임 변함 → ref/직접 mutation으로 다룬다. 2D도 동일 철학).

### B3. 캐릭터 (CharacterRig)

- 각 `Character.id`마다 rig 1개. `loader.ts`가 `manifest.characters[palette].model`을 `useGLTF`로 로드, 실패/누락 시 **캡슐 메시 폴백**.
- 매 프레임:
  - `position.set(ch.x/16, 0, ch.y/16)`
  - `rotation.y = DIR_YAW[ch.dir] (+ forwardDir 보정)`
  - 목표 클립 = `selectClip(ch.state, ch.currentTool)`. 바뀌면 `mixer` 크로스페이드(0.2s).
  - `hueShift !== 0`이면 머티리얼 HSL 틴트(2D의 `adjustSprite` 대응). palette별 모델이 있으면 색은 모델 자체로 충분, hueShift만 추가 틴트.
  - `matrixEffect`: `spawn`이면 `scale`을 `matrixEffectTimer/MATRIX_EFFECT_DURATION`로 0→1, `despawn`이면 1→0(또는 디졸브 셰이더는 나중). 효과 중 클립은 idle.
- 스킨드 메시는 인스턴싱 어려움 → 캐릭터는 개별 메시(보통 수~수십 개라 충분). 폴리 낮게 유지.

### B4. 환경 / 가구

- `Ground.tsx`: `layout.cols×rows` 평면 1장 + `tiles[i]===WALL`인 칸에 벽 유닛 인스턴스(`InstancedMesh`로 묶어도 됨). `VOID`는 바닥도 생략. per-tile 색은 1차 보류(`ponytail:` 단색).
- `Furniture.tsx`: `layout.furniture`를 순회, `getCatalogEntry(type)`로 footprint/orientation 취득, `manifest.furniture[type]` 모델(없으면 박스) 배치. 위치 = 타일(col,row)→월드, footprint 중심 정렬. auto-ON 발광은 보류.
  > 주의: `officeState.furniture`(FurnitureInstance, 래스터화 sprite)가 아니라 **`getLayout().furniture`(PlacedFurniture, type 문자열)**를 소비할 것. 후자에 3D가 필요로 하는 `type`이 있다.

### B5. 말풍선 / 이름표 (Bubbles)

- 각 캐릭터 머리 위 `drei <Html>` 또는 `<Billboard>`로:
  - `bubbleType==='permission'` → "..." (호박색). 클릭/클리어까지 유지(상태가 알려줌).
  - `bubbleType==='waiting'` → 체크. `bubbleTimer` 따라 페이드(2D와 동일하게 OfficeState가 타이머 관리, B는 표시만).
  - 이름표: `agentName`/`folderName`/팀 표식. `alwaysShowLabels` 설정 존중(기존 메시지로 들어옴).

### B6. 카메라 (CameraRig)

- `OrthographicCamera` + 고정 아이소 각도(예: 35°). "디오라마" 느낌 유지. (Perspective+OrbitControls도 가능하나 ortho가 2D 감성에 가깝고 follow가 단순.)
- **follow**: `cameraFollowId`가 있으면 그 캐릭터 월드좌표로 카메라 타깃 lerp(기존 `CAMERA_FOLLOW_LERP`/`SNAP_THRESHOLD` 재사용 가능). 없으면 전체 bbox 중심.
- **zoom(1~10)** → `camera.zoom` 매핑. **pan** → 카메라 타깃 XZ 오프셋. 수동 pan 시 `cameraFollowId=null`(기존 규칙 그대로).

### B7. 상호작용 (선택/좌석/이동) — 기존 메서드 재사용, 로직 재구현 금지

`OfficeCanvas`의 마우스 핸들러 의미를 r3f 레이캐스트로 옮긴다:

- 캐릭터 메시 `onClick` → `ch.id`로 `officeState.dismissBubble` → 선택 토글(`selectedAgentId`/`cameraFollowId`) → `onClick(id)`(터미널 포커스). (`handleClick` 그대로 이식)
- 바닥/좌석 클릭(선택 상태에서): 레이캐스트로 타일(col,row) 산출 → `getSeatAtTile` → 자기좌석이면 `sendToSeat`, 빈좌석이면 `reassignSeat` + `transport.send({type:'saveAgentSeats',...})`.
- 우클릭 바닥 → `walkToTile(selectedId, col, row)`.
- 타일 좌표 환산: 레이를 `y=0` 평면과 교차 → `col=floor(hit.x)`, `row=floor(hit.z)`.

### B8. 통합 토글 (App.tsx 1곳)

```tsx
// App.tsx: OfficeCanvas를 감싸는 한 곳만 분기. 롤백 쉬움.
import { RENDER_3D } from './office3d/constants3d.js';
... RENDER_3D ? <Office3D {...props}/> : <OfficeCanvas {...props}/> ...
```

초기엔 `RENDER_3D=false`로 두고 dev에서 켜서 검증. 안정화되면 기본 true.

### B9. Runnable check

- `office3d/clip.test.ts` (vitest): `selectClip`이 (walk→walk, idle→idle, type+Read→sitRead, type+Edit→sitType) 매핑하는지. `npm run test:webview`로 실행.
- 수동 게이트: standalone에서 캐릭터가 폴백 캡슐로라도 N명 보이고, 클릭 선택/카메라 follow/우클릭 이동이 동작.

**B 완료 정의(DoD):** 매니페스트가 비어도(또는 stub) standalone에서 3D 씬이 뜨고, 에이전트 spawn/이동/선택/말풍선이 2D와 동일하게 반영됨.

---

## 7. 합류 (A·B가 만나는 유일한 지점)

1. A가 `assets3d/**` + `manifest.json`(`check-manifest` 통과) 전달.
2. B는 코드 변경 없이 dev 재시작 → `loader.ts` 폴백이 실 GLB로 자동 대체.
3. 미세 조정(공유 튜닝 노브, 코드 수정 최소):
   - 캐릭터 키: `manifest.characterRig.heightWorld`
   - 정면 보정: `manifest.characterRig.forwardDir` (모델이 DOWN을 안 보면 여기만)
   - 클립 이름 불일치: `manifest.characterRig.clips`
4. `esbuild.js`에 `assets3d` 복사 추가(B) → 확장(.vsix)/CLI 패키징 포함. 웹뷰(F5)에서 최종 확인.

> 합류 후에도 코드 vs 데이터가 분리돼 있어, 에셋 교체는 매니페스트만 만지면 된다.

---

## 8. 단계별 체크리스트 (병렬)

**A (에셋)**

- [ ] A1 Mixamo 캐릭터 N종 + 클립 4종(In Place) 다운로드
- [ ] A2 FBX→GLB, 한 스켈레톤에 클립 머지, 단위/Y-up/표준 클립명 정규화
- [ ] A3 환경/가구 CC0 모델 수급, `type` 매핑
- [ ] A4 `manifest.json` 작성 + `check-manifest.mjs` 통과

**B (렌더러)** — A와 무관하게 즉시 시작

- [ ] B0 deps 설치, standalone dev 띄우기
- [ ] B1~B2 골격 + `useFrame`에서 `officeState.update`
- [ ] B3 CharacterRig(폴백 캡슐 → 클립/방향/스폰효과)
- [ ] B4 Ground/Furniture(폴백 박스)
- [ ] B5 Bubbles/이름표
- [ ] B6 CameraRig(follow/zoom/pan)
- [ ] B7 클릭·좌석·우클릭 이동(기존 메서드 호출)
- [ ] B8 App.tsx 토글, B9 테스트
- [ ] (합류) esbuild 복사, 웹뷰 검증

---

## 9. 리스크 / 함정

- **Mixamo 100배·Z-up·루트모션**: A가 변환에서 정규화. In Place 필수.
- **FBX→GLB·클립 머지 누락**: 클립이 따로 놀면 런타임 교체 불가. 반드시 한 GLB·표준 클립명.
- **웹뷰 CSP / WebGL**: VS Code 웹뷰 CSP가 blob/wasm/리소스를 막을 수 있음. dev는 standalone(Vite)에서, 확장 검증 시 `PixelAgentsViewProvider`의 웹뷰 CSP에 필요한 소스 허용. GLB는 같은 오리진(`/assets3d`)이라 대체로 무난.
- **성능**: 스킨드 캐릭터 다수 → 폴리 낮게(Mixamo low-poly + CC0 low-poly). 벽/바닥은 InstancedMesh.
- **상태를 React로 끌어올리지 말 것**: 매 프레임 수백 변경. ref/직접 mutation(2D와 동일).
- **에디터**: 3D에서 레이아웃 편집은 비목표. 편집 진입 시 2D 캔버스로 폴백하거나 버튼 숨김(`ponytail:` 후속).

---

## 10. 부록: 핵심 파일 인덱스 (이식 참조)

| 2D 원본                                              | 핵심 내용             | 3D 대응                                |
| ---------------------------------------------------- | --------------------- | -------------------------------------- |
| `office/engine/officeState.ts`                       | 시뮬레이션 단일 출처  | **재사용(무변경)**, 읽기/`update` 호출 |
| `office/engine/characters.ts:319 getCharacterSprite` | state/tool→스프라이트 | `office3d/clip.ts selectClip`          |
| `office/engine/renderer.ts`                          | Canvas2D 드로잉       | `office3d/scene/**`로 대체             |
| `office/components/OfficeCanvas.tsx`                 | 루프+마우스+카메라    | `Office3D.tsx`+`CameraRig`+`onClick`   |
| `office/sprites/spriteData.ts`                       | 픽셀 캐릭터           | Mixamo GLB                             |
| `office/layout/furnitureCatalog.ts getCatalogEntry`  | 가구 메타             | 그대로 호출(footprint/orientation)     |
| `constants.ts` (TILE_SIZE 등)                        | 공유 상수             | 읽기만, 3D 상수는 `constants3d.ts`     |

```

```
