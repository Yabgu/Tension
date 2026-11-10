# input-camera

A camera you can fly, driven by Tension's own input capability: **WASD** moves,
the **mouse** turns (yaw and pitch, clamped), **escape** quits.

## What it demonstrates

The whole input path, end to end:

```
SDL  ->  the host's pump  ->  the session's event bus  ->  tension-input (a DSO)
     ->  the guest's input.state()  ->  ogre.submitCamera  ->  the screen
```

Nothing in it uses OGRE's input handling or its tutorial framework. The renderer
is handed one camera record per frame; where that camera is comes entirely from
`tension::input`.

**There is no window handle to exchange.** The host owns the window and pumps its
events, and input joins that stream by subscribing (`INPUT.md` §3,
`docs/modules/input.md` §3). `input.attach` still takes the four v6 arguments but
reads only the handle: `kind`/`lo`/`hi` are ignored, and
`ogre.windowHandle()` — a deprecated stub that answers `-ENODEV` under a host
window — is not called here at all.

It is also the only example that loads **two** capabilities: `npm start` exports
`TENSION_EXTRA_CAPABILITY` (the input DSO), which `scripts/run-example.mjs` turns
into a second `--capability` for the host.

## The controls

- **W / A / S / D** — move in the facing plane (the pitch does not lift the walk)
- **mouse** — turn: left/right is yaw, up/down is pitch, clamped to ±77° so the
  camera cannot roll over
- **escape** — quit (the camera's final position is printed)

## Build and run

```sh
npm start                            # a window; needs a display
TENSION_OGRE_HEADLESS=1 npm start    # refuses: no window means no input to attach
```

`npm start` builds whatever is missing first: the interpreter, the OGRE adapter,
the input capability (via `node scripts/build-input.mjs`), the framework's
generated session config, and this example's own dependencies (`npm install`,
`asc`). It refuses to start if the packaged binaries are older than their
sources — that is `npm run build` at the repository root, not a stale checkout.

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

- **Keys do nothing** — the window must hold keyboard focus, and the compositor
  decides that, not the capability. Click the window once. (Motion needs only
  the pointer over the window; keys go to whatever holds focus.)
- **The camera turns but does not move** — check that the terminal running
  `npm start` is not eating the keys; WASD are read from the state record, which
  is global to the window, not from the event ring.
- **It refuses with "input_attach refused (-19)"** — `-ENODEV`: the host owned no
  window when `attach` ran. The example retries for ~10 s of frames; past that,
  the window never came up, so check the adapter's log lines above it.
