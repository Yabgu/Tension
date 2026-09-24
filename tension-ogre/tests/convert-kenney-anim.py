# convert-kenney-anim.py — the animation half of the Kenney pipeline (chunk 13a).
#
#     blender --background --python tests/convert-kenney-anim.py -- \
#         <character.fbx> <clip.fbx> [<clip2.fbx> ...] <output-dir>
#
# One clip or many: every argument but the last is an input (the first is the
# character, the rest are clips) and the last is the output directory, so the
# single-clip form from chunk 13a still works unchanged. Each clip becomes its
# own `<animation>` in one skeleton — the shape the multi-character demo needs,
# where four renderables share one mesh and each plays a different clip.
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
              "<character.fbx> <clip.fbx> [<clip2.fbx> ...] <output-dir>")
        return 2
    args = argv[argv.index("--") + 1:]
    if len(args) < 3:
        print("usage: <character.fbx> <clip.fbx> [<clip2.fbx> ...] <output-dir>")
        return 2
    inputs = [os.path.abspath(a) for a in args[:-1]]
    outdir = os.path.abspath(args[-1])
    character, clips = inputs[0], inputs[1:]
    for path in inputs:
        if not os.path.isfile(path):
            print("convert-kenney-anim.py: no such file: %s" % path)
            return 2
    print("convert-kenney-anim.py: %d clip(s): %s"
          % (len(clips), ", ".join(os.path.basename(c) for c in clips)))
    os.makedirs(outdir, exist_ok=True)

    # 1. an empty scene, then the addon (the factory reset unloads it — 12a).
    bpy.ops.wm.read_factory_settings(use_empty=True)
    enable_io_ogre()

    # 2. the character, then each clip into the same scene. Every clip imports
    #    its own copy of the rig; the bone sets must be identical to retarget.
    bpy.ops.import_scene.fbx(filepath=character)
    character_arm = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"][0]
    character_bones = set(b.name for b in character_arm.data.bones)
    if character_arm.animation_data is None:
        character_arm.animation_data_create()
    ad = character_arm.animation_data
    while len(ad.nla_tracks):
        ad.nla_tracks.remove(ad.nla_tracks[0])
    ad.action = None

    retargeted = []
    for clip_path in clips:
        clip_name = os.path.splitext(os.path.basename(clip_path))[0]
        before = set(bpy.context.scene.objects)
        actions_before = set(bpy.data.actions)
        bpy.ops.import_scene.fbx(filepath=clip_path)
        clip_arms = [o for o in set(bpy.context.scene.objects) - before
                     if o.type == "ARMATURE"]
        if not clip_arms:
            print("convert-kenney-anim.py: %s imported no armature — nothing to retarget"
                  % clip_name)
            return 1
        clip_arm = clip_arms[0]
        clip_bones = set(b.name for b in clip_arm.data.bones)
        print("convert-kenney-anim.py: clip \"%s\": %d bones, identical to the character: %s"
              % (clip_name, len(clip_bones), clip_bones == character_bones))
        if clip_bones != character_bones:
            print("convert-kenney-anim.py: the rigs differ — retargeting by name is not safe")
            return 1

        # The clip's action is the *new* multi-frame one: with several clips in
        # one scene every earlier clip's action is still in `bpy.data.actions`,
        # and a "last multi-frame action wins" loop picks a previous clip's —
        # measured: the first run of this loop built "jump" out of Run's
        # 16-frame action and exported two animations instead of three.
        new_actions = [act for act in set(bpy.data.actions) - actions_before
                       if act.frame_range[1] > 2.0]
        clip_action = new_actions[0] if new_actions else None
        if clip_action is None:
            print("convert-kenney-anim.py: no multi-frame action in %s" % clip_name)
            return 1
        # The action's own name ("Root.001|Root|Run") is what the exporter
        # writes into the XML; the clip's file name is what a reader wants.
        clip_action.name = clip_name

        # 3. The NLA branch, made to sample (13b). io_ogre's driver assigns
        #    `animation_data.action = action` with no slot, and Blender 5.2's
        #    slotted actions evaluate **nothing** until a slot is bound — the
        #    tracks come out flat and `<animations/>` empty (13a's attempt 2,
        #    measured again here: the pose bone stays at identity at every
        #    frame with the slot unbound). The lever is the slot's *target*:
        #    point it at this armature and the driver's plain assignment binds
        #    it by itself. Each clip then becomes its own `<animation>`, which
        #    is the whole reason this branch is worth having.
        for slot in clip_action.slots:
            slot.identifier = "OB" + character_arm.name
            slot.name_display = character_arm.name

        track = ad.nla_tracks.new()
        track.name = clip_name
        strip = track.strips.new(clip_name, int(clip_action.frame_range[0]), clip_action)
        print("convert-kenney-anim.py: clip \"%s\" on NLA track \"%s\", strip frames %.0f..%.0f, "
              "%.0f frames, slot -> OB%s"
              % (clip_name, track.name, strip.frame_start, strip.frame_end,
                 clip_action.frame_range[1] - clip_action.frame_range[0],
                 character_arm.name))
        retargeted.append((clip_name, clip_action, strip.frame_start, strip.frame_end))
        bpy.data.objects.remove(clip_arm, do_unlink=True)

    # The scene range covers every clip (the timeline branch is not used while
    # NLA tracks exist, but a range that named one clip would be a lie).
    bpy.context.scene.frame_start = int(min(r[2] for r in retargeted))
    bpy.context.scene.frame_end = int(max(r[3] for r in retargeted))
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
        import xml.etree.ElementTree as ET

        text = open(skeleton_xml, encoding="utf-8").read()
        root = ET.parse(skeleton_xml).getroot()
        animations = root.find("animations")
        found = list(animations) if animations is not None else []
        print("convert-kenney-anim.py: %s carries %d animation(s) (%d bytes)"
              % (os.path.basename(skeleton_xml), len(found), len(text)))
        for anim in found:
            tracks = anim.findall("tracks/track")
            keys = anim.findall(".//keyframe")
            print("  \"%s\": length %s, tracks %d, keyframes %d"
                  % (anim.get("name"), anim.get("length"), len(tracks), len(keys)))
    else:
        print("convert-kenney-anim.py: no skeleton XML was written")
    print("convert-kenney-anim.py: output dir: %s" % sorted(os.listdir(outdir)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
