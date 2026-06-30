#!/usr/bin/env bash
# Convert every Mixamo character FBX in characters3d/ into a GLB with the shared
# idle/walking/typing clips merged on, then (re)generate assets3d/manifest.json.
#
# All Mixamo characters share one skeleton, so the same 3 animation FBX retarget
# onto any character. To add characters: drop <Name>.fbx in characters3d/ and run
# this — it auto-discovers every character FBX (anything except the 3 animation
# files) and writes them all into the manifest. The 3D renderer then spreads
# agents across ALL models by id (office3d/manifest.ts modelUrlForAgent).
set -euo pipefail

ROOT="C:/Users/SJ/Desktop/pixel-agents"
SRC="$ROOT/webview-ui/public/assets/characters3d"
OUTDIR="$ROOT/webview-ui/public/assets3d/characters"
MANIFEST="$ROOT/webview-ui/public/assets3d/manifest.json"
BLENDER="/c/Program Files/Blender Foundation/Blender 5.0/blender"
PY="$ROOT/scripts/3d/fbx_to_glb.py"

mkdir -p "$OUTDIR"

# Texture-only GLB shrink (resize → 1024px + WebP): ~10x smaller while geometry,
# skeleton and animation stay byte-identical (verified). Runs on each freshly
# built GLB only — never re-optimizes (WebP-on-WebP would degrade). ABSOLUTE
# paths required: gltf-transform resolves relatives against npx's cwd, not ours.
optimize_glb() {
  local f="$1" mid="$1.tmp.glb"
  if npx -y @gltf-transform/cli resize "$f" "$mid" --width 1024 --height 1024 >/dev/null 2>&1 \
     && npx -y @gltf-transform/cli webp "$mid" "$f" --quality 80 >/dev/null 2>&1; then
    rm -f "$mid"
    echo "     optimized ($(stat -c%s "$f" | awk '{printf "%.1fMB", $1/1048576}'))"
  else
    rm -f "$mid"; echo "     OPTIMIZE FAILED (kept full-size)"
  fi
}

# Animation FBX are shared inputs, not characters.
is_anim() { case "$(echo "$1" | tr '[:upper:]' '[:lower:]')" in idle|walking|typing|reading|sitting_funny|sitting_lady|asking_question|sitting_talking|sitting_laughing|talking_on_phone|pain_gesture|male_laying|female_laying|female_sitting) return 0;; *) return 1;; esac; }

# The two FIXED role characters (always seated in a room, never wander). They are
# kept OUT of the agent skin spread (manifest.characters) and emitted under
# fixedCharacters instead. The webview binds them by role: lead→orchestrator,
# devops→devops (office3d/manifest.ts roleModel + setTeamInfo pinning).
is_fixed() { case "$1" in medea|ch19) return 0;; *) return 1;; esac; }
role_for() { case "$1" in medea) echo orchestrator;; ch19) echo devops;; *) echo "";; esac; }
# Fixed seat (tile col,row + facing) per role — tune to taste; the renderer pins
# the matching agent here. facing: down|up|left|right.
pos_for()  { case "$1" in
  medea) echo '"col": 14, "row": 13, "facing": "down"';;
  ch19)  echo '"col": 8,  "row": 19, "facing": "up"';;
  *) echo '"col": 1, "row": 1, "facing": "down"';; esac; }

# Mixamo characters are male or female; the gendered motion pools differ
# (office3d/clip.ts). Add new names here as characters are added.
gender_for() { case "$1" in mouse|steve|pete|ch19) echo male;; *) echo female;; esac; }

# Shared clip set merged onto every character. Optional clips: present → used;
# absent → the renderer falls back (loader.ts resolveAction). idle/walk/typing
# are required; the rest are added if the FBX exists.
ANIM_ARGS=(--anim idle="$SRC/idle.fbx" --anim walk="$SRC/walking.fbx" --anim typing="$SRC/typing.fbx")
CLIPS='"idle": "idle", "walk": "walk", "sitType": "typing"'
SITREAD_CLIP="typing"
if [ -f "$SRC/reading.fbx" ]; then ANIM_ARGS+=(--anim reading="$SRC/reading.fbx"); SITREAD_CLIP="reading"; fi
CLIPS="$CLIPS, \"sitRead\": \"$SITREAD_CLIP\""
add_clip() { local key="$1" file="$2"; if [ -f "$SRC/$file" ]; then ANIM_ARGS+=(--anim "$key=$SRC/$file"); CLIPS="$CLIPS, \"$key\": \"$key\""; fi; }
add_clip sitFunny  sitting_funny.fbx
add_clip sitLady   sitting_lady.fbx
add_clip sitAsk    asking_question.fbx
add_clip sitTalk   sitting_talking.fbx
add_clip sitLaugh  sitting_laughing.fbx
add_clip phone     talking_on_phone.fbx
add_clip pain      pain_gesture.fbx
add_clip layMale   male_laying.fbx
add_clip layFemale female_laying.fbx
add_clip sitFemale female_sitting.fbx

# Discover character FBX, splitting agent skins from the fixed role characters.
agents=(); fixed=()
for f in "$SRC"/*.fbx; do
  [ -e "$f" ] || continue
  base=$(basename "$f" .fbx)
  is_anim "$base" && continue
  lower=$(echo "$base" | tr '[:upper:]' '[:lower:]')
  if is_fixed "$lower"; then fixed+=("$base"); else agents+=("$base"); fi
done
IFS=$'\n' agents=($(printf '%s\n' "${agents[@]}" | sort -f)); unset IFS

[ ${#agents[@]} -gt 0 ] || { echo "no agent character FBX found in $SRC"; exit 1; }

# Build every character GLB (agents + fixed; skip if up to date).
for name in "${agents[@]}" "${fixed[@]}"; do
  src="$SRC/$name.fbx"
  lower=$(echo "$name" | tr '[:upper:]' '[:lower:]')
  out="$OUTDIR/$lower.glb"
  if [ -f "$out" ] && [ "$out" -nt "$src" ]; then echo "ok   $name (glb up to date)"; continue; fi
  echo "conv $name -> $lower.glb"
  if "$BLENDER" --background --python "$PY" -- \
       --char "$src" --out "$out" "${ANIM_ARGS[@]}" >/dev/null 2>&1; then
    echo "     built; optimizing"
    optimize_glb "$out"
  else
    echo "     FAILED"; exit 1
  fi
done

# Agent skin entries (the modelUrlForAgent spread).
entries=""
i=0
for name in "${agents[@]}"; do
  lower=$(echo "$name" | tr '[:upper:]' '[:lower:]')
  [ -f "$OUTDIR/$lower.glb" ] || continue
  [ -n "$entries" ] && entries="$entries,"
  entries="$entries"$'\n'"    { \"palette\": $i, \"model\": \"characters/$lower.glb\", \"gender\": \"$(gender_for "$lower")\" }"
  i=$((i + 1))
done

# Fixed role characters (orchestrator / devops) — bound by role, never spread.
fixed_entries=""
for name in "${fixed[@]}"; do
  lower=$(echo "$name" | tr '[:upper:]' '[:lower:]')
  [ -f "$OUTDIR/$lower.glb" ] || continue
  role=$(role_for "$lower")
  [ -z "$role" ] && continue
  [ -n "$fixed_entries" ] && fixed_entries="$fixed_entries,"
  fixed_entries="$fixed_entries"$'\n'"    \"$role\": { \"model\": \"characters/$lower.glb\", \"gender\": \"$(gender_for "$lower")\", $(pos_for "$lower") }"
done

# Furniture model map (Kenney Furniture Kit GLBs, CC0). Baked in here so a
# character rebuild doesn't wipe it — the renderer (office3d/scene/Furniture.tsx)
# auto-fits + recenters each model to its tile footprint, so only `yawDeg`
# (facing) and `yOff` (surface lift) are tuned per furniture type. Types not
# listed here fall back to the 2.5D pixel sprite.
read -r -d '' FURNITURE_JSON <<'FURN' || true
  "furniture": {
    "DESK_FRONT":        { "model": "furniture/kenney/desk.glb",          "yawDeg": 0,   "hWorld": 0.72 },
    "PC_FRONT_OFF":      { "model": "furniture/kenney/computerScreen.glb","yawDeg": 0,   "hWorld": 0.42, "yOff": 0.55 },
    "PC_SIDE":           { "model": "furniture/kenney/computerScreen.glb","yawDeg": -90, "hWorld": 0.42 },
    "CUSHIONED_BENCH":   { "model": "furniture/kenney/chairDesk.glb",     "yawDeg": 180, "hWorld": 0.85 },
    "COFFEE_TABLE":      { "model": "furniture/kenney/tableCoffee.glb",   "yawDeg": 0,   "hWorld": 0.40 },
    "SMALL_TABLE_FRONT": { "model": "furniture/kenney/sideTable.glb",     "yawDeg": 0,   "hWorld": 0.58 },
    "SOFA_FRONT":        { "model": "furniture/kenney/loungeSofa.glb",    "yawDeg": 0,   "hWorld": 0.70 },
    "SOFA_BACK":         { "model": "furniture/kenney/loungeSofa.glb",    "yawDeg": 180, "hWorld": 0.70 },
    "SOFA_SIDE":         { "model": "furniture/kenney/loungeSofa.glb",    "yawDeg": -90, "hWorld": 0.70 },
    "SOFA_SIDE:left":    { "model": "furniture/kenney/loungeSofa.glb",    "yawDeg": 90,  "hWorld": 0.70 },
    "PLANT":             { "model": "furniture/kenney/pottedPlant.glb",   "yawDeg": 0,   "hWorld": 0.80 },
    "PLANT_2":           { "model": "furniture/kenney/plantSmall2.glb",   "yawDeg": 0,   "hWorld": 0.45 },
    "BIN":               { "model": "furniture/kenney/trashcan.glb",      "yawDeg": 0,   "hWorld": 0.60 }
  }
FURN

cat > "$MANIFEST" <<EOF
{
  "version": 1,
  "characterRig": {
    "heightWorld": 1.6,
    "forwardDir": "up",
    "clips": { $CLIPS }
  },
  "characters": [$entries
  ],
  "fixedCharacters": {$fixed_entries
  },
$FURNITURE_JSON
}
EOF

echo "manifest: $i agent characters, ${#fixed[@]} fixed"
node "$ROOT/scripts/3d/check-manifest.mjs"
