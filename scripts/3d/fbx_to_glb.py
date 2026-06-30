# Mixamo FBX -> one GLB with merged, named animation clips.
# Run headless:
#   blender --background --python scripts/3d/fbx_to_glb.py -- \
#     --char  webview-ui/public/assets/characters3d/Remy.fbx \
#     --out   webview-ui/public/assets3d/characters/remy.glb \
#     --anim  idle=webview-ui/public/assets/characters3d/idle.fbx \
#     --anim  walk=webview-ui/public/assets/characters3d/walking.fbx \
#     --anim  typing=webview-ui/public/assets/characters3d/typing.fbx
#
# Why this shape: every Mixamo character shares the standard 65/67-bone rig, so the
# SAME idle/walk/typing FBX retargets onto any character mesh by bone name. Adding a
# new character = one more invocation with a different --char (same --anim set).
#
# Output clips are named after the left side of each --anim (idle/walk/typing); the
# B renderer's manifest maps those names to the frozen clip vocabulary
# (idle/walk/sitType/sitRead). See docs/3d-migration-plan.md s3.1-3.3.

import bpy
import sys
import os
import re


def iter_fcurves(action):
    # Blender <=4.3 exposed action.fcurves directly; 4.4+ slotted actions hide them under
    # layers -> strips -> channelbags. Yield fcurves either way.
    legacy = getattr(action, "fcurves", None)
    if legacy is not None and len(legacy):
        for fc in legacy:
            yield fc
        return
    for layer in getattr(action, "layers", []):
        for strip in getattr(layer, "strips", []):
            for cbag in getattr(strip, "channelbags", []):
                for fc in cbag.fcurves:
                    yield fc


def retarget_action_bone_names(action, char_arm):
    # Mixamo gives each downloaded asset its own bone namespace (mixamorig:, mixamorig9:, ...),
    # so an animation authored for one character will NOT drive a different character whose bones
    # use another namespace — the clip then bakes out static (T-pose). Rewrite the action's bone
    # references to the character's actual bone names, matched by the namespace-stripped suffix
    # (Hips, LeftArm, ... are identical across the standard Mixamo rig). No-op when namespaces
    # already match (e.g. character + animations from the same download set).
    suffix = lambda n: n.split(":")[-1]
    char_by_suffix = {suffix(b.name): b.name for b in char_arm.data.bones}
    pat = re.compile(r'pose\.bones\["([^"]+)"\]')
    for fc in iter_fcurves(action):
        m = pat.search(fc.data_path)
        if not m:
            continue
        old = m.group(1)
        new = char_by_suffix.get(suffix(old))
        if new and new != old:
            fc.data_path = fc.data_path.replace('["%s"]' % old, '["%s"]' % new)


def log(msg):
    print(f"[fbx_to_glb] {msg}", flush=True)


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    char = None
    out = None
    anims = []  # list of (name, path)
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--char":
            char = argv[i + 1]; i += 2
        elif a == "--out":
            out = argv[i + 1]; i += 2
        elif a == "--anim":
            name, _, path = argv[i + 1].partition("=")
            anims.append((name, path)); i += 2
        else:
            i += 1
    if not char or not out or not anims:
        raise SystemExit("usage: -- --char C.fbx --out O.glb --anim name=A.fbx [--anim ...]")
    return char, out, anims


def ensure_fbx_addon():
    # FBX import lives in a bundled addon; enable it if the operator is missing.
    if not hasattr(bpy.ops.import_scene, "fbx"):
        try:
            bpy.ops.preferences.addon_enable(module="io_scene_fbx")
        except Exception as e:
            log(f"could not enable io_scene_fbx: {e}")


def clean_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for coll in (bpy.data.actions, bpy.data.armatures, bpy.data.meshes, bpy.data.objects, bpy.data.materials):
        for b in list(coll):
            if b.users == 0:
                coll.remove(b)


def import_fbx(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=os.path.abspath(path))
    return [o for o in bpy.data.objects if o not in before]


def find_armature(objs):
    return next((o for o in objs if o.type == "ARMATURE"), None)


def main():
    char_path, out_path, anims = parse_args()
    ensure_fbx_addon()
    clean_scene()

    # --- character (skin + skeleton) ---
    log(f"import character {char_path}")
    char_objs = import_fbx(char_path)
    char_arm = find_armature(char_objs)
    if char_arm is None:
        raise SystemExit("no armature in character FBX")
    # Drop any T-pose actions that shipped with the character mesh.
    if char_arm.animation_data:
        char_arm.animation_data.action = None
    char_arm.animation_data_create()
    # Clear stray NLA tracks if any.
    for t in list(char_arm.animation_data.nla_tracks):
        char_arm.animation_data.nla_tracks.remove(t)

    # --- animations: extract each action, push onto a named NLA track on char_arm ---
    for name, path in anims:
        log(f"import anim {name} <- {path}")
        anim_objs = import_fbx(path)
        anim_arm = find_armature(anim_objs)
        if anim_arm is None or not anim_arm.animation_data or not anim_arm.animation_data.action:
            raise SystemExit(f"no action found in {path}")
        action = anim_arm.animation_data.action
        action.name = name
        action.use_fake_user = True
        retarget_action_bone_names(action, char_arm)
        start = int(action.frame_range[0])
        track = char_arm.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, start, action)
        # Remove the helper armature + any meshes/empties it imported.
        for o in anim_objs:
            bpy.data.objects.remove(o, do_unlink=True)

    # Make sure no active action shadows the NLA tracks at export time.
    char_arm.animation_data.action = None

    # --- export one GLB, one glTF animation per NLA track ---
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    log(f"export {out_path}")
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(out_path),
        export_format="GLB",
        export_yup=True,
        use_selection=False,
        export_apply=False,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_skins=True,
        export_morph=False,
        export_cameras=False,
        export_lights=False,
    )
    log("done")


main()
