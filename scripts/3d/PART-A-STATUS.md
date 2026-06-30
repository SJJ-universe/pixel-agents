# Part A (3D 에셋) — 상태 / 인수인계

대상: 이 작업을 이어받는 에이전트·B 역할·머지 담당.
기준: `docs/3d-migration-plan.md`의 **Part A**. 단, 아래 "계약 변경"대로 B의 실제 구현이 플랜과 달라 그에 맞춰 수행함.

---

## 0. 한 줄 결론

사용자가 받아온 Mixamo 에셋(Remy + idle/walking/typing)은 **B의 3D 렌더러(`officeRenderer3d.ts`)에 그대로 렌더 가능**하다. 정적·통합·시각 3중 검사 **모두 PASS**. GLB 변환·매니페스트는 B가 안 쓰므로 **만들지 않음(YAGNI)**.

## 1. 계약 변경 — 플랜 vs 실제 (중요)

B가 플랜의 r3f/GLB/매니페스트 설계를 버리고 **three.js 직접 + 원본 FBX 로드**로 구현함. 실제 계약은 `webview-ui/src/office/engine3d/officeRenderer3d.ts`다.

| 항목        | 플랜(docs)                    | B의 실제 구현 = 진짜 계약                                                               |
| ----------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| 렌더러      | r3f + drei, `src/office3d/**` | three 직접, `src/office/engine3d/officeRenderer3d.ts` + `components/OfficeCanvas3D.tsx` |
| 에셋 포맷   | FBX→**GLB** 변환              | **원본 FBX 직접** (`FBXLoader`)                                                         |
| 에셋 경로   | `public/assets3d/`            | `public/assets/characters3d/`                                                           |
| 매니페스트  | `manifest.json` 소비          | **안 읽음** (파일명 4개 하드코딩)                                                       |
| 클립        | idle/walk/sitType/sitRead(4)  | idle/walk/type(3) — read 분기 없음                                                      |
| 스케일/방향 | 매니페스트 노브               | 런타임 자동 (`templateScale`=bbox기반, `BASE_YAW`=π)                                    |

B가 하드코딩으로 기대하는 파일 (경로·이름 고정, 바꾸면 깨짐):

```
public/assets/characters3d/Remy.fbx     ← 스킨 캐릭터(템플릿). animations 무시, 메시+스켈레톤만 사용
public/assets/characters3d/idle.fbx     ← animations[0] → 'idle'
public/assets/characters3d/walking.fbx  ← animations[0] → 'walk'
public/assets/characters3d/typing.fbx   ← animations[0] → 'type'
```

## 2. 검증된 사실 (3중 검사)

| 검사 항목                                  | 방법                  | 결과                                                             |
| ------------------------------------------ | --------------------- | ---------------------------------------------------------------- |
| 각 애니 `animations[0]` 존재               | `inspect-fbx.mjs`     | PASS — idle/walk/typing 모두 1개                                 |
| walking In-Place (키프레임 Hips net)       | `inspect-fbx.mjs`     | PASS — 수평 net=0                                                |
| 애니 본 ⊆ Remy 스켈레톤                    | `inspect-fbx.mjs`     | PASS — 52본 전부 일치, `missingInRemy: []`                       |
| 클립이 복제 스켈레톤에 **바인딩·구동**     | `check-animation.mjs` | PASS — idle/walk/type 모두 본 회전 변화, 언바운드 0              |
| walking 런타임 In-Place (보간 포함 풀루프) | `check-animation.mjs` | PASS — 런타임 netHoriz=0                                         |
| 스케일 정합                                | 측정                  | PASS — bbox.y=378 → templateScale 0.0045 → 월드 높이 **1.7타일** |
| typing 좌식 여부                           | 측정                  | 좌식 확정 — 엉덩이 0.93→0.52, 머리 1.49→1.04 (책상 의미 일치)    |

본 이름은 `mixamorigHips` 식(콜론 없음)으로 캐릭터·애니 전부 동일. 표준 Mixamo 리그(67본).

## 3. 러너블 체크 (재현 명령)

```bash
node scripts/3d/inspect-fbx.mjs      # 정적 검증 → fbx-report.json, OVERALL PASS
node scripts/3d/check-animation.mjs  # 통합(바인딩+런타임 in-place) → exit 0 = PASS
```

둘 다 추가 의존성 없음(루트 node_modules의 three 사용). FBXLoader를 헤드리스로 돌리려 `window/URL.createObjectURL/텍스처로더`를 스텁함(파싱 전용, 런타임 무관).

## 4. 열린 항목 — B / 머지 단계 (A 범위 밖, 반드시 처리)

블로커(이게 없으면 3D 화면을 못 봄):

- **view3D 토글 미배선**: `App.tsx`에 `const [view3D]=useState(false)`만 있고 `setView3D(true)` 버튼/단축키가 없음 → 3D 뷰 진입 불가. **B가 토글 UI를 연결**해야 검증·사용 가능. (A는 `App.tsx` 소유 아님 → 손대지 않음)
- **패키지 빌드 시 에셋 복사**: dev(Vite)는 `public/`을 서빙해 `/assets/characters3d/*.fbx`가 뜨지만, 확장(.vsix)/CLI 빌드에서 `esbuild.js`가 `public/assets` → `dist`로 복사하는지 확인 필요. (B 소유 `esbuild.js`)

기능 갭(있으면 좋음 / 2D 대비 후퇴):

- **모든 에이전트가 동일 외형(Remy 1종)**: `makeAvatar`가 단일 템플릿을 복제, `Character.palette`(0~5)/`hueShift`를 안 씀 → 에이전트 구분 불가(2D는 팔레트/색으로 구분). 가장 싼 해결=B가 `makeAvatar`에서 클론 머티리얼에 palette/hueShift 기반 HSL 틴트(약 10줄). 다중 캐릭터 모델까지 원하면 A가 Mixamo 캐릭터 추가 수급(머지서 협의).
- **read/type 미구분**: 2D는 `isReadingTool`로 reading/typing 분기. 3D는 type 단일. 원하면 `reading.fbx` 추가 + B의 `STATE_CLIP`/clip 선택에 tool 분기.
- **의자 메시 없음**: B는 책상 박스만 그림. 좌식 캐릭터(엉덩이 0.52)가 의자 없이 앉은 모양 → CC0 의자 모델 또는 가구 카탈로그 매핑은 후속.

저장소 위생:

- **FBX 30MB가 LFS 없이 커밋 예정**(Remy.fbx 28MB, 현재 untracked). 커밋 전 **Git LFS(`*.fbx`,`*.glb`,텍스처) 도입 권장** — 안 하면 git 히스토리 영구 비대화. `.gitattributes`는 루트 공유 파일이라 팀 결정 필요(미설정 상태로 두면 LFS 필터 미작동).

## 5. 산출물 (A 소유, 충돌 0)

```
scripts/3d/inspect-fbx.mjs      # 정적 FBX 검증기
scripts/3d/check-animation.mjs  # 믹서 바인딩 + 런타임 in-place 통합 체크
scripts/3d/fbx-report.json      # inspect 산출 리포트(증거)
scripts/3d/PART-A-STATUS.md     # 이 문서
webview-ui/public/assets/characters3d/{Remy,idle,walking,typing}.fbx  # 사용자 수급, 검증 완료
```

A는 `webview-ui/src/**`·`package.json`·`esbuild.js`·`App.tsx`를 일절 건드리지 않음.

## 6. 아직 검증 안 한 것 (정직한 한계)

- **실제 WebGL 픽셀 렌더**: node 통합 검사는 믹서가 본을 구동함을 증명하나 GPU 래스터/셰이더/카메라 프레이밍은 미검증. 진짜 픽셀 확인은 view3D 토글 배선(B) 후 standalone(Vite)+헤드리스 브라우저에서 가능. → 머지 게이트로 남김.
- 웹뷰 CSP에서 FBX(blob/wasm) 로드 가부: 확장(F5) 검증 시 확인.
