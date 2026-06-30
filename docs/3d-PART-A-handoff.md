# PART A handoff — what B actually needs (corrects the prototype assumption)

> For the agent/developer owning PART A (asset pipeline). B (the r3f renderer) is
> **built, contract-conformant, and merged**. This note unblocks the join (§7 of
> `3d-migration-plan.md`). Read alongside that plan; this only corrects course.

## What went wrong

`PART-A-STATUS.md` treats `webview-ui/src/office/engine3d/officeRenderer3d.ts`
as "the real contract" and concludes raw FBX is enough (GLB/manifest = "YAGNI").
**That file no longer exists.** It was an early vanilla-three.js _prototype_ that
loaded FBX directly; it was replaced by the contract renderer in
`webview-ui/src/office3d/**` (PART B), which loads **GLB via `useGLTF`** and reads
**`webview-ui/public/assets3d/manifest.json`** — exactly per §3.1.

Net effect today: B fetches `assets3d/manifest.json`, gets 404, and every agent
renders as a **fallback capsule**. The Mixamo character never appears. The four
`.fbx` under `public/assets/characters3d/` are committed but referenced by nothing.

`useGLTF` is GLTFLoader-only — it **cannot parse `.fbx`**. So raw FBX is doubly
unusable: wrong location _and_ wrong format.

## What A must produce (then B auto-upgrades with ZERO code changes)

1. **One GLB per character** under `webview-ui/public/assets3d/` (e.g.
   `assets3d/characters/remy.glb`), with the locomotion clips **merged onto the
   character's skeleton** (so `gltf.animations` contains them). You currently have
   them as separate files: `Remy.fbx` (skin, T-pose only), `idle.fbx`,
   `walking.fbx`, `typing.fbx`. Merge `idle`/`walking`/`typing` onto Remy in ONE
   GLB. One character is enough — B falls back missing palettes to palette 0.

2. **`webview-ui/public/assets3d/manifest.json`** (§3.1 schema — B's TS types in
   `webview-ui/src/office3d/manifest.ts` match it 1:1). Concretely:

   ```jsonc
   {
     "version": 1,
     "characterRig": {
       "heightWorld": 1.6, // B scales the model to this height (~tiles)
       "forwardDir": "up", // SEE NOTE below — verify in a viewer
       "clips": {
         // standard key -> the ACTUAL clip name in the GLB
         "idle": "Idle",
         "walk": "Walk",
         "sitType": "Typing",
         "sitRead": "Typing", // reuse Typing; B also auto-falls sitRead->sitType
       },
     },
     "characters": [
       { "palette": 0, "model": "characters/remy.glb" }, // path RELATIVE to assets3d/
     ],
     // furniture / environment are OPTIONAL — omit them and B keeps its box/plane fallbacks
   }
   ```

   The 4 clip keys `idle / walk / sitType / sitRead` are a **frozen vocabulary** —
   keep them exactly; only the right-hand clip names vary.

3. **Normalize during conversion** (§3.2, §5): **meters**, **Y-up**, **in-place**
   (strip root motion — the simulation drives position; root motion fights it).
   Origin at the feet (y=0) so the model stands on the floor.

### `forwardDir` note

B applies `yaw = DIR_YAW[dir]` and corrects for the model's authored facing via
`forwardDir`. In B's coords **+Z = Direction.DOWN**. The old prototype found Remy
facing **−Z** at rest (it rotated by π), which is **`"up"`**. Use `"up"` first; if
the character faces backward in the viewer/app, try `"down"`. This is the ONE knob
to tune at join time — no code change, manifest only.

## Conversion (pick one; leave the script in `scripts/3d/` for reproducibility)

- **gltf-transform CLI** (`npx @gltf-transform/cli`): convert each FBX → glb, then
  merge the three animation clips' tracks onto the Remy skeleton into one glb;
  rename clips; verify single skeleton.
- **Blender headless** (`blender --background --python convert.py`): import the 4
  FBX (apply the 100× / Z-up correction on import), push idle/walk/typing as NLA
  actions on Remy's armature, name them, export glTF Binary (in-place, +Y up).

## Verify (the §A4 gate — do this BEFORE declaring done)

- `node scripts/3d/check-manifest.mjs` (§A4) — manifest valid, referenced files
  exist, 4 clip keys present.
- **Load the produced GLB through `GLTFLoader`** (or any glТF viewer, e.g.
  <https://gltf-viewer.donmccurdy.com>) and confirm the **4 clips play in-place**.
  Do NOT validate with `FBXLoader` — B never uses it; an FBX-load PASS proves
  nothing about whether B can render the asset.

When `check-manifest.mjs` passes and the GLB shows clips in a glTF viewer, B will
render the real character on next dev reload — no B edits. Retire or re-point the
FBX-based checkers (`inspect-fbx.mjs`, `check-animation.mjs`), which validate the
defunct FBX-direct path.
