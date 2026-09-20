# hello-triangle

The smallest complete Tension game: one mesh, one material, one camera, one
object on screen — and, with a window, a screenshot to prove it. It is the
front door to the OGRE capability: everything it does is a documented verb, and
the file is written to be read top to bottom.

What it shows, in order: opening a session, loading a mesh through the job
queue, submitting an Unlit material, a camera and a renderable, waiting on the
renderer's own frame counter, and reading a frame back out of the window.

## Run it

```sh
cd examples/ogre/hello-triangle
./run.sh                          # opens a 640x480 window, and prints a summary
TENSION_OGRE_HEADLESS=1 ./run.sh  # structural only: no display needed
```

A window is the default, because this is the example a reader runs first and a
window a human is looking at should be readable at a glance. With no `DISPLAY`
and no `WAYLAND_DISPLAY` there is nothing to open one on, so `./run.sh` prints
`no display available; falling back to renderer=null` and runs the structural
path instead — exit 0 either way. (`tension-ogre/tests/run.sh` keeps the
opposite default: CI has no display, and headless is the shape CI needs.)

`./run.sh` builds what it can (the OGRE adapter, the guest, its dependencies)
and needs `tension-core` already built — it says so if it is missing.

Windowed prints one line: the frames it rendered, and the pixels the mesh
actually put on screen.

```
rendered 35 frames, 288 non-background pixels, mean rgb 229/51/51
```

Headless prints one line too, and says the same thing about the scene:

```
renderer=null: no pixels to read; submitted 1 object
```

## Where the SDK surface is documented

`tension-framework/assembly/ogre/index.ts` — the verbs, the wrappers, and the
record types each one takes; `tension-framework/assembly/ogre/wire.ts` — the
exact byte layout of every record, with the offsets pinned by a check the guest
can run (`assertOgreWireOffsets`), and the factories this example builds its
records with (`CameraRecord.perspective`, `Material.unlit`, `Renderable.at`).
`tension-ogre/DESIGN.md` is the design record behind both.
