# convert-kenney-anim.py — the animation half of the Kenney pipeline (chunk 13a).
#
#     blender --background --python tests/convert-kenney-anim.py -- \
#         <character.fbx> <animation.fbx> <output-dir>
#
# `convert-kenney.py` converts a rigged *mesh*; this converts a rigged mesh
# **plus one animation clip** into a skeleton whose `<animations>` element
# carries the clip, which OgreMeshTool then turns into a skeleton binary OGRE
# can play. Verified end to end in 13a: `run.fbx`'s 16-frame cycle comes out as
# one animation with 25 tracks (14 of them deforming bones), OGRE-Next 3.0's
# `SkeletonInstance::getAnimation(name)` plays it (`setEnabled`/`setLoop`/
# `addTime`), the hips turn 83.2 degrees in 30 frames, and one full duration
# later the pose is bit-identical to frame 0.
#
# Three findings are baked into this script; each was measured, and each is a
# reason io_ogre's defaults do not work:
#
#   1. **io_ogre exports animations from NLA tracks only** ("NLA required, lone
#      actions not supported", `ogre/skeleton.py`). An assigned active action
#      exports *nothing* — and worse, with no NLA track at all the exporter
#      falls back to sampling the scene timeline into an animation it names
#      "my_animation" over `scene.frame_start..frame_end`.
#   2. With the clip on an NLA track (the documented way), the export comes out
#      **empty**: the exporter's driver assigns `animation_data.action = action`
#      with no `action_slot`, and Blender 5.2's slotted actions evaluate nothing
#      without a bound slot — so the sampled tracks are flat,
#      `animationFound` is False, and `<animations/>` is written with no
#      children. Measured twice; the addon predates the slot model.
#   3. So the working path is the exporter's *other* branch: **no NLA tracks,
#      the clip assigned to the armature with its slot bound, and the scene's
#      frame range set to the clip's own range**. The writer samples "the
#      timeline", the timeline is the clip, and the animation lands.
#
# The clip's name in the export is therefore "my_animation" (the fallback
# branch's fixed name) whatever the action was called. The binary keeps it.
#
# The mesh half of the export is unchanged from `convert-kenney.py`: v1 mesh
# XML, `EX_V2_MESH_TOOL_VERSION='v1'` (and remember the mesh binary needs
# `OgreMeshTool -V 1.10`, while the skeleton takes no version flag).

import os
import sys

import addon_utils
import bpy


def enable_io_ogre() -> None:
    if not addon_utils.check("io_ogre")[1]:
        addon_utils.enable("io_ogre", default_set=True, persistent=True)
    print("convert-kenney-anim.py: io_ogre enabled")


def show(stage: str) -> None:
    print("--- %s" % stage)
    for obj in bpy.context.scene.objects:
        action = None
        if obj.animation_data and obj.animation_data.action:
            action = obj.animation_data.action.name
        print("  %-18s %-10s action=%s" % (obj.name, obj.type, action))
    for act in bpy.data.actions:
        print("  action \"%s\" frames %.0f..%.0f"
              % (act.name, act.frame_range[0], act.frame_range[1]))


def main() -> int:
    argv = sys.argv
    if "--" not in argv:
        print("usage: blender --background --python convert-kenney-anim.py -- "
              "<character.fbx> <animation.fbx> <output-dir>")
        return 2
    args = argv[argv.index("--") + 1:]
    if len(args) != 3:
        print("convert-kenney-anim.py: expected exactly <character.fbx> <animation.fbx> <out-dir>")
        return 2
    character, animation, outdir = (os.path.abspath(a) for a in args)
    for path in (character, animation):
        if not os.path.isfile(path):
            print("convert-kenney-anim.py: no such file: %s" % path)
            return 2
    os.makedirs(outdir, exist_ok=True)

    # 1. an empty scene, then the addon (the factory reset unloads it — 12a).
    bpy.ops.wm.read_factory_settings(use_empty=True)
    enable_io_ogre()

    # 2. the character, then the clip into the same scene. The clip imports its
    #    own copy of the rig; the bone sets must be identical for the retarget.
    bpy.ops.import_scene.fbx(filepath=character)
    character_arm = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"][0]
    bpy.ops.import_scene.fbx(filepath=animation)
    clip_arms = [o for o in bpy.context.scene.objects
                 if o.type == "ARMATURE" and o is not character_arm]
    if not clip_arms:
        print("convert-kenney-anim.py: the clip FBX imported no armature — nothing to retarget")
        return 1
    clip_arm = clip_arms[0]
    character_bones = set(b.name for b in character_arm.data.bones)
    clip_bones = set(b.name for b in clip_arm.data.bones)
    print("convert-kenney-anim.py: %d character bones, %d clip bones, identical: %s"
          % (len(character_bones), len(clip_bones), character_bones == clip_bones))
    if character_bones != clip_bones:
        print("convert-kenney-anim.py: the rigs differ — retargeting by name is not safe")
        return 1

    # 3. pick the clip's action: the multi-frame one, not the 1-frame bind pose.
    clip_action = None
    for act in bpy.data.actions:
        if act.frame_range[1] > 2.0 and act is not clip_arm.animation_data.action:
            clip_action = act
    if clip_action is None:
        print("convert-kenney-anim.py: no multi-frame action in the clip FBX")
        return 1
    print("convert-kenney-anim.py: retargeting \"%s\" (frames %.0f..%.0f) onto %s"
          % (clip_action.name, clip_action.frame_range[0], clip_action.frame_range[1],
             character_arm.name))

    # 4. the working shape (finding 3): no NLA, the action assigned *with its
    #    slot*, and the scene range set to the clip's.
    if character_arm.animation_data is None:
        character_arm.animation_data_create()
    ad = character_arm.animation_data
    while len(ad.nla_tracks):
        ad.nla_tracks.remove(ad.nla_tracks[0])
    ad.action = clip_action
    if hasattr(ad, "action_slot"):
        ad.action_slot = clip_action.slots[0]
    bpy.context.scene.frame_start = int(clip_action.frame_range[0])
    bpy.context.scene.frame_end = int(clip_action.frame_range[1])
    bpy.context.scene.frame_step = 1
    bpy.data.objects.remove(clip_arm, do_unlink=True)
    show("after retarget")

    # 5. the export. The poll needs an active object (removing the clip armature
    #    cleared it — measured: "poll() failed, context is incorrect").
    bpy.context.view_layer.objects.active = character_arm
    bpy.ops.object.select_all(action="SELECT")
    stem = os.path.splitext(os.path.basename(character))[0]
    result = bpy.ops.ogre.export(
        filepath=os.path.join(outdir, stem + ".scene"),
        EX_MESH=True, EX_MESH_OVERWRITE=True, EX_EXPORT_XML_DELETE=False,
        EX_SCENE=False, EX_SELECTED_ONLY=True, EX_V2_MESH_TOOL_VERSION="v1",
        EX_ARMATURE_ANIMATION=True,
    )
    print("convert-kenney-anim.py: export -> %s" % (result,))

    # 6. report what landed, so a silent drop is loud.
    skeleton_xml = os.path.join(outdir, stem + ".skeleton.xml")
    if os.path.isfile(skeleton_xml):
        text = open(skeleton_xml, encoding="utf-8").read()
        has_animations = "<animation " in text or "<animation>" in text
        print("convert-kenney-anim.py: %s carries animations: %s (%d bytes)"
              % (os.path.basename(skeleton_xml), has_animations, len(text)))
    else:
        print("convert-kenney-anim.py: no skeleton XML was written")
    print("convert-kenney-anim.py: output dir: %s" % sorted(os.listdir(outdir)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
