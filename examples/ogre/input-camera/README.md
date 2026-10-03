# input-camera

A camera you can fly, driven by Tension's own input capability: **WASD** moves,
the **mouse** turns (yaw and pitch, clamped), **escape** quits.

## What it demonstrates

The whole input path, end to end:

```
SDL  ->  tension-input (a DSO)  ->  the session  ->  the guest  ->  ogre  ->  screen
```

Nothing in it uses OGRE's input handling or its tutorial framework. The renderer
is handed one camera record per frame; where that camera is comes entirely from
`tension::input`.

The window handle is the guest-mediated exchange `INPUT.md` §3 Q1 describes:
`ogre.windowHandle()` answers the XID of the renderer's window, and the guest
hands it to `input.attachToken(handle, Kind.X11Window, token)`. Neither
capability learns the other exists — the guest is the mediator.

It is also the only example that loads **two** capabilities: `run.sh` exports
`TENSION_EXTRA_CAPABILITY` (the input DSO), which `examples/ogre/run.sh` turns
into a second `--capability` for the host.

## The controls

- **W / A / S / D** — move in the facing plane (the pitch does not lift the walk)
- **mouse** — turn: left/right is yaw, up/down is pitch, clamped to ±77° so the
  camera cannot roll over
- **escape** — quit (the camera's final position is printed)

## Build and run

```sh
./run.sh                            # a window; needs a display
TENSION_OGRE_HEADLESS=1 ./run.sh    # refuses: no window means no input to attach
```

`run.sh` builds whatever is missing first: the interpreter, the OGRE adapter,
the input capability (via `tension-input/build.sh`), the framework's generated
session config, and this example's own dependencies (`npm install`, `asc`).

## What to look for

- Twelve coloured markers in a 4×3 grid, alternating orange and blue, with a
  dark grey background — the scene is about *motion*, not rendering.
- **W** should carry the camera forward, **S** back, **A/D** sideways; the
  movement is relative to where the camera looks, so turning first changes
  where "forward" goes.
- Moving the mouse should turn the camera smoothly, without drift: the mouse
  delta is reset per frame by the capability's state record, so a still mouse
  means a still camera.
- Releasing every key should stop the camera immediately — held keys come from
  the state record, not from a queue of events that could repeat.

## If something is wrong

- **Keys do nothing** — the input window must hold focus. On Wayland the
  compositor decides; the capability asks for focus when it attaches, and on an
  X11/XWayland session (what OGRE-Next 3.0 uses) the ask is granted. If it was
  not, click the window once.
- **The camera turns but does not move** — check that the terminal running
  `run.sh` is not eating the keys; WASD are read from the state record, which
  is global to the window, not from the event ring.
- **It refuses immediately with "no window handle arrived"** — the renderer
  never brought a window up; check the adapter's log lines above it.
