# convert-kenney.py — the FBX -> OGRE pipeline's first link (chunk 12).
#
#     blender --background --python tests/convert-kenney.py -- <input.fbx> <output-dir>
#
# What it does, in order:
#
#   1. a factory-empty scene (so the export is exactly what the FBX carries),
#   2. Blender's own FBX importer (`io_scene_fbx`, a core addon),
#   3. select everything the import made and run the blender2ogre exporter
#      (`io_ogre`) with `EX_MESH`, which writes `<object>.mesh.xml` and, for a
#      rigged mesh, `<armature>.skeleton.xml` plus the `<skeletonlink>` element
#      the v1 importer reads.
#
# The mesh-tool version is pinned to **v1** and that is not a detail: the
# adapter imports with `Ogre::v1::MeshSerializer`, and every shipped mesh is
# `[MeshSerializer_v1.100]`. io_ogre's own default is v2; a v2 file is one the
# loader cannot read.
#
# The exporter's last step (XML -> binary) is done by the *converter* it
# detects (OgreXMLConverter, or OgreMeshTool). This script deliberately does
# not rely on it: the XMLs are kept (`EX_EXPORT_XML_DELETE=False`), the
# converter runs with whatever it finds, and the second link is run by the
# caller with the flags this install wants — `OgreMeshTool -v1` for the mesh
# (see the README/DESIGN for the exact command). If no converter is on PATH,
# io_ogre records it as an error and writes the XMLs anyway, which is the case
# this recipe is written for.
#
# The FBX is *not* committed and neither is anything extracted from the zip;
# only the converted `.mesh`/`.skeleton` and this recipe are.

import os
import sys

import addon_utils
import bpy


def enable_io_ogre() -> None:
    """io_ogre ships installed but not enabled: until it is, `bpy.ops.ogre.*`
    does not exist (`AttributeError: could not be found`). Enabling it here,
    per run, keeps the script self-contained and leaves the user's addon
    preferences alone."""
    modules = [m.__name__ for m in addon_utils.modules() if "ogre" in m.__name__.lower()]
    print("convert-kenney.py: io_ogre modules present: %s" % modules)
    if not addon_utils.check("io_ogre")[1]:
        # persistent=True: the addon's own config reads
        # `context.preferences.addons["io_ogre"].preferences`, which only
        # exists once Blender has written the addon into the user's preferences.
        # Enabling it non-persistently registers the operators and leaves the
        # preferences collection empty, and the export then dies with a
        # KeyError inside io_ogre/config.py — measured. This is the one place
        # the script writes outside its output directory: the user's Blender
        # preferences gain one enabled addon.
        addon_utils.enable("io_ogre", default_set=True, persistent=True)
        print("convert-kenney.py: io_ogre enabled (and persisted to Blender prefs)")
    else:
        print("convert-kenney.py: io_ogre already enabled")


def main() -> int:
    argv = sys.argv
    if "--" not in argv:
        print("usage: blender --background --python convert-kenney.py -- <input.fbx> <output-dir>")
        return 2
    args = argv[argv.index("--") + 1:]
    if len(args) != 2:
        print("convert-kenney.py: expected exactly <input.fbx> <output-dir>")
        return 2
    infile, outdir = os.path.abspath(args[0]), os.path.abspath(args[1])
    if not os.path.isfile(infile):
        print("convert-kenney.py: no such file: %s" % infile)
        return 2
    os.makedirs(outdir, exist_ok=True)

    stem = os.path.splitext(os.path.basename(infile))[0]
    print("convert-kenney.py: %s -> %s" % (infile, outdir))

    # 1. an empty scene: nothing of Blender's default cube/light/camera ends up
    #    in the export, so the output is a pure function of the input. This
    #    comes *before* enabling the addon: `read_factory_settings` resets the
    #    addon state too (measured — it unloads io_ogre, and the operator then
    #    does not exist).
    bpy.ops.wm.read_factory_settings(use_empty=True)
    enable_io_ogre()

    # 2. the FBX.
    bpy.ops.import_scene.fbx(filepath=infile)
    objects = sorted(o.name for o in bpy.context.scene.objects)
    print("convert-kenney.py: imported objects: %s" % ", ".join(objects))
    armatures = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    print("convert-kenney.py: %d mesh(es), %d armature(s)" % (len(meshes), len(armatures)))
    for arm in armatures:
        bones = arm.data.bones
        print("convert-kenney.py: armature \"%s\" has %d bones" % (arm.data.name, len(bones)))

    # 3. the export. Every kwarg is an io_ogre operator property; the names are
    #    the ones its own "Export Script" print uses.
    bpy.ops.object.select_all(action="SELECT")
    result = bpy.ops.ogre.export(
        filepath=os.path.join(outdir, stem + ".scene"),
        # XML only, and keep it: the binary step is the caller's, with the
        # flags this install's OgreMeshTool wants.
        EX_MESH=True,
        EX_MESH_OVERWRITE=True,
        EX_EXPORT_XML_DELETE=False,
        EX_SCENE=False,
        EX_SELECTED_ONLY=True,
        # The v1 pin (see the header comment).
        EX_V2_MESH_TOOL_VERSION="v1",
        # NOT optional, despite the name: io_ogre gates the whole skeleton
        # export on ARMATURE_ANIMATION (`ogre/skeleton.py`: `if arm and
        # config.get('ARMATURE_ANIMATION') is True`). Setting it False
        # produces a .mesh.xml whose <skeletonlink> points at a .skeleton.xml
        # that was never written — measured. The model FBX carries no clips
        # (the pack's idle/run/jump are separate files), so this writes a
        # skeleton and no animation tracks either way; walking-stickman poses
        # bones through the bone table (chunk 5b), not through baked animation.
        EX_ARMATURE_ANIMATION=True,
    )
    print("convert-kenney.py: bpy.ops.ogre.export -> %s" % (result,))

    # io_ogre keeps its findings in a report rather than raising.
    try:
        import io_ogre.report as report  # type: ignore

        for line in report.Report.warnings:
            print("convert-kenney.py: WARNING: %s" % line)
        for line in report.Report.errors:
            print("convert-kenney.py: ERROR: %s" % line)
    except Exception as exc:  # pragma: no cover - diagnostics only
        print("convert-kenney.py: could not read the io_ogre report: %s" % exc)

    written = sorted(os.listdir(outdir))
    print("convert-kenney.py: output directory now holds: %s" % ", ".join(written))
    return 0


if __name__ == "__main__":
    sys.exit(main())
