# Getting started

Tension runs a WebAssembly guest written in TensionScript. The runtime owns the
loop, the window and the memory arena; a guest owns the game. This page is the
shortest path from an empty directory to a running program.

## Create a project

```sh
npx create-tension-app my-game
cd my-game
npm install
npm run dev
```

`npm run dev` builds the guest, packs the assets, and opens a window. Save a
source file and it rebuilds and restarts.

## The smallest guest

A guest exports `_start_game`. Everything else is optional: no session, no
renderer, no window.

```ts runnable
import { print } from "tension-framework";

export function _start_game(): void {
  print("hello from the docs");
  print("2 + 2 = " + (2 + 2).toString());
}
```

Press **Run** to see what this program prints. The output was captured when this
documentation was built, from the same source you are reading, on the same
runtime that is showing it to you.

That is not a trick. A guest has no clock and no source of randomness the host
does not provide, so a guest program is a function of its inputs. Running it
again would produce those exact bytes.

## Talking to the host

A guest reaches the engine only through a capability. `tension::io` is the one
every guest has:

```ts runnable
import { arg, argCount, print } from "tension-framework";

export function _start_game(): void {
  print("arguments: " + argCount().toString());
  for (let i = 0; i < argCount(); i++) {
    print("  " + i.toString() + ": " + arg(i));
  }
}
```

Everything after the guest's `.wasm` on the runtime's command line is handed to
the guest verbatim, which is what `arg` returns.

## Opening a window

The window is the guest's to create. The runtime has no window flag: an
application that wants one asks for it, and the size it asks for is the size it
gets.

This is the shape `tension init` writes, cut down to the parts that matter:

```ts
import {
  Bytes, Canvas, ConfigBuilder, Frame, FrameStep, RuntimeSession, Scene, Sprite,
} from "tension-framework";

// The host drives a guest only when it exports both of these, and refuses half an
// adoption at load. Only the entry module's exports reach the wasm, so this line
// is what adopting the loop looks like.
export { __taskWake, __taskResume, __taskFail, _game_running } from "tension-framework";

class Bouncer implements FrameStep {
  private sprites: Sprite[];
  constructor(sprites: Sprite[]) { this.sprites = sprites; }

  step(): void {                       // once per frame, before the scene commits
    for (let i = 0; i < this.sprites.length; i++) this.sprites[i].x += 3.0;
  }
}

export function _start_game(): void {
  RuntimeSession.open(ConfigBuilder.forThisBuild());
  const request = windowRequest();
  const canvas = Canvas.windowedOrOffscreen(request.width, request.height, request.title);
  if (!canvas.isValid()) return;

  const pipe = canvas.pipelineGraph(Bytes.ofArray(DEFAULT_2D_BLOB));
  const texture = canvas.loadTextureFromRes("/sprites.iwi");
  canvas.bindTexture(pipe, 0, texture);

  const scene = Scene.create(request.width, request.height, 8);
  const sprites: Sprite[] = [];
  for (let i = 0; i < 4; i++) {
    const sprite = scene.spawn(new Frame(0, <u16>(i * 32), 0, 32, 32));
    sprite.moveTo(<f32>(i * 96), 64.0);
    sprites.push(sprite);
  }

  // step, commit, present, yield — and `0` means "until the window closes".
  scene.run(canvas, pipe, new Bouncer(sprites), 0);
}
```

`windowedOrOffscreen` opens a window when the machine has a display and falls
back to an offscreen target when it does not, so the same guest runs on a
developer's desktop and in CI.

**`step` is a class rather than a closure** because a closure over a stack local
cannot be called on this toolchain — it traps at `call_indirect` with
`uninitialized element`. An interface method dispatches through a table entry the
class installs at definition, and works. The state lives in fields, which is what
a game wants anyway.

**Nothing here builds a record.** `Scene` owns the record buffer and packs it once
per frame from the nodes whose properties changed; `run` does the commit, the
present and the yield to the host. Time is the guest's too: `Time.deltaTime()` is
exactly `1/60` and `Time.now()` counts frames, so a program with the same inputs
draws the same frames — which is what lets this page record the output of a
program instead of describing it.

## Where to read next

- **Architecture** — who owns the loop, the arena and the teardown.
- **The session** — the seven verbs, the epoch, and the memory layout.
- **Modules** — the renderers and the input layer.
- **Reference** — every import, generated from the source that registers it.
