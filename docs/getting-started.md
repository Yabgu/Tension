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

```ts
import { Canvas, ConfigBuilder, print, RuntimeSession } from "tension-framework";
import { windowRequest } from "tension-framework/assembly/platform";

export function _start_game(): void {
  RuntimeSession.open(ConfigBuilder.forThisBuild());
  const request = windowRequest();
  const canvas = Canvas.windowedOrOffscreen(request.width, request.height, request.title);
  if (!canvas.isValid()) {
    print("no canvas: " + canvas.lastError().toString());
    return;
  }
  // ... submit records and present, frame by frame
}
```

`windowedOrOffscreen` opens a window when the machine has a display and falls
back to an offscreen target when it does not, so the same guest runs on a
developer's desktop and in CI.

## Where to read next

- **Architecture** — who owns the loop, the arena and the teardown.
- **The session** — the seven verbs, the epoch, and the memory layout.
- **Modules** — the renderers and the input layer.
- **Reference** — every import, generated from the source that registers it.
