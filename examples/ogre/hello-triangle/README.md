# hello-triangle

A triangle on screen, built out of nothing: three positions written into the
guest's own memory and handed to the renderer as a mesh. There is no file, no
job and no loader here — `MeshBuilder.triangle` is the whole of the asset
pipeline, and it is the shortest path from an idea to pixels this SDK has. What
it produces is an ordinary resource id, so every other verb treats it exactly
as it treats a loaded mesh.

## Run it

```sh
cd examples/ogre/hello-triangle
./run.sh                          # opens a 640x480 window, and prints a summary
TENSION_OGRE_HEADLESS=1 ./run.sh  # structural only: no display needed
```

A window is the default. With no `DISPLAY` and no `WAYLAND_DISPLAY` there is
nothing to open one on, so `./run.sh` prints
`no display available; falling back to renderer=null` and runs the structural
path instead — exit 0 either way. (`tension-ogre/tests/run.sh` keeps the
opposite default: CI has no display.)

`./run.sh` builds what it can (the OGRE adapter, the guest, its dependencies)
and needs `tension-core` already built — it says so if it is missing.

Windowed prints one line: the frames it rendered, and the pixels the triangle
actually put on screen.

```
rendered 342 frames, 42050 non-background pixels, mean rgb 229/51/51
```

Headless prints one line too, and says the same thing about the scene:

```
renderer=null: no pixels to read; submitted 1 object
```

`hello-mesh` is the sibling example: the same records, a barrel off disk.

## Where the SDK surface is documented

`tension-framework/assembly/ogre/index.ts` — the verbs, the wrappers, and the
record types each one takes; `tension-framework/assembly/ogre/mesh.ts` —
`MeshBuilder`, and what `create_mesh` requires of the bytes it is given;
`tension-framework/assembly/ogre/wire.ts` — the exact byte layout of every
record and of the regions the guest writes into, with the offsets pinned by a
check the guest can run (`assertOgreWireOffsets`). `tension-ogre/DESIGN.md` §5.1
is the design record behind all of it, including the measured construction
sequence a mesh built this way needs.
