# hello-mesh

A barrel on screen: a mesh loaded from a file, a material, a camera, and a
screenshot to prove it. It is the front door to the OGRE capability's **resource
path** — the job queue, the worker that reads bytes, the render thread that
turns them into a mesh — and every step in it is a documented verb.

What it shows, in order: opening a session, loading a mesh through the job
queue, submitting an Unlit material, a camera and a renderable, waiting on the
renderer's own frame counter, and reading a frame back out of the window.

`hello-triangle` is the sibling example: it builds a triangle out of the guest's
own memory with `MeshBuilder`, with no file involved.

## Run it

```sh
cd examples/ogre/hello-mesh
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

Windowed prints one line: the frames it rendered, and the pixels the barrel
actually put on screen. It waits for ~340 frames before reading the frame back,
so the window stays up for about six seconds — long enough to look at.

```
rendered 341 frames, 288 non-background pixels, mean rgb 229/51/51
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
