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
./run.sh                              # headless: no display needed
TENSION_OGRE_WINDOW_TEST=1 ./run.sh   # GL3+: a real window, and a screenshot
```

`./run.sh` builds what it can (the OGRE adapter, the guest, its dependencies)
and needs `tension-core` already built — it says so if it is missing.

Headless prints one line:

```
renderer=null: no pixels to read; submitted 1 object
```

Windowed prints the screenshot's summary:

```
rendered 34 frames, 72 non-background pixels, mean rgb 229/51/51
```

## Where the SDK surface is documented

`tension-framework/assembly/ogre/index.ts` — the verbs, the wrappers, and the
record types each one takes; `tension-framework/assembly/ogre/wire.ts` — the
exact byte layout of every record, with the offsets pinned by a check the guest
can run (`assertOgreWireOffsets`). `tension-ogre/DESIGN.md` is the design
record behind both.
