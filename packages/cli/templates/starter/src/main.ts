// src/main.ts — four sprites bouncing inside the window.
//
// Every Tension app has this shape:
//
//   1. open the session        — nothing that touches guest memory works before it
//   2. ask for a window        — the runtime has no window flag; the guest owns it
//   3. set the pipeline        — the blob the adapter was built against
//   4. load the atlas          — out of the packed volume, mounted at "/"
//   5. present frames          — until the window closes
//
// The numbers are deliberately editable: change SPEED, save, and `tension dev`
// rebuilds and restarts the game on its own.

import {
  Bytes,
  Canvas,
  ConfigBuilder,
  Frame,
  print,
  RecordBuffer,
  RuntimeSession,
} from "tension-framework";
// `platform` is imported by path because the barrel does not re-export it: it is
// the host's window bus, not a capability, and a guest that only wants a canvas
// should not have its import list grow by one.
import { windowInfo, windowRequest } from "tension-framework/assembly/platform";
import { DEFAULT_2D_BLOB } from "./graph.generated";

// ── the numbers worth changing ──────────────────────────────────────────────

/// Cell size in the atlas, and the size of one sprite on screen.
const CELL: u32 = 32;

/// How many sprites bounce. The atlas has four cells.
const SPRITES: i32 = 4;

/// Pixels per frame. **Change this first** — the restart loop is easiest to see
/// as a sprite that suddenly moves further.
const SPEED: i32 = 3;

/// Frames an offscreen run draws before it stops. A windowed run has no budget:
/// it ends when the window does.
///
/// A bound rather than "until closed" so that a headless machine, or a CI job
/// that was handed `--headless` by mistake, runs a bounded job instead of
/// spinning until something kills it.
const HEADLESS_FRAMES: i32 = 240;

// ── the volume ──────────────────────────────────────────────────────────────

/// The atlas, as the volume presents it. `assets/` is packed at the volume's
/// root, so `assets/sprites.iwi` is `/sprites.iwi` at run time.
const SHEET: string = "/sprites.iwi";

function fail(what: string): void {
  print("starter: " + what);
  // A guest exits non-zero by trapping; there is no exit code to set.
  assert(false, what);
}

export function _start_game(): void {
  // ── 1. the session ────────────────────────────────────────────────────────
  // Not optional, and checked before anything else: the verbs reach guest memory
  // through the session, so a guest that skips this still opens a canvas and
  // then answers -EBADF on the first verb that needs the arena.
  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    fail("the session did not open");
  }

  // ── 2. the window ─────────────────────────────────────────────────────────
  // `tension dev` turns tension.config.json into `--window=WxH`, `--title=...`
  // and (for a headless run) `--headless`, and `windowRequest` reads them.
  const request = windowRequest();
  print("starter: " + SPRITES.toString() + " sprites at " + SPEED.toString() +
    " px/frame, " + request.width.toString() + "x" + request.height.toString() +
    (request.headless ? ", headless" : ""));

  // `windowedOrOffscreen` opens the window if it can and falls back to an
  // offscreen target if it cannot. A machine with no display is not an error;
  // `displaysToWindow()` says which one happened.
  const canvas = request.headless
    ? Canvas.open(request.width, request.height)
    : Canvas.windowedOrOffscreen(request.width, request.height, request.title);
  if (!canvas.isValid()) {
    fail("Canvas.open -> " + canvas.lastError().toString());
  }
  const windowed = canvas.displaysToWindow();
  if (!windowed && !request.headless) {
    print("starter: no window available; drawing offscreen");
  }

  // ── 3. the pipeline ───────────────────────────────────────────────────────
  // The blob is compiled in (a guest cannot read a file at run time) and it must
  // be the blob this adapter carries modules for: any other bytes are -ENOSYS
  // here, which is the whole reason `tension dev` emits it from the host.
  const blob = Bytes.ofArray(DEFAULT_2D_BLOB);
  const pipe = canvas.pipelineGraph(blob);
  if (pipe < 0) {
    fail("set_pipeline -> " + pipe.toString() +
      " (the blob does not match this adapter)");
  }

  // ── 4. the atlas ──────────────────────────────────────────────────────────
  // `loadTextureFromRes` is open + read-all + texture_load. It answers -ENOENT
  // when the volume has no such file, which is what a missing `assets/` looks
  // like from in here.
  const texture = canvas.loadTextureFromRes(SHEET);
  if (texture <= 0) {
    fail("texture_load " + SHEET + " -> " + texture.toString() +
      " (is assets/sprites.iwi still there?)");
  }
  if (canvas.bindTexture(pipe, 0, texture) != 0) {
    fail("set_texture -> " + canvas.lastError().toString());
  }

  // ── 5. the sprites ────────────────────────────────────────────────────────
  // One run of records, owned by a `RecordBuffer`: it holds the memory and the
  // count, so `submit` sends exactly what was pushed and nothing here does
  // pointer arithmetic.
  const records = RecordBuffer.create(SPRITES);

  // One `Frame` per cell, built once. A Frame per sprite per frame would be an
  // allocation per frame, and the 2D runtime is explicitly free of those.
  // `Frame` takes u16 fields, so each cell's origin is cast once here rather
  // than at every use. `CELL` stays u32 because the arithmetic below needs it.
  const frames: Frame[] = [
    new Frame(0, <u16>0, <u16>0, <u16>CELL, <u16>CELL),
    new Frame(0, <u16>CELL, <u16>0, <u16>CELL, <u16>CELL),
    new Frame(0, <u16>(2 * <i32>CELL), <u16>0, <u16>CELL, <u16>CELL),
    new Frame(0, <u16>(3 * <i32>CELL), <u16>0, <u16>CELL, <u16>CELL),
  ];

  // Position and velocity, indexed by sprite. Four small arrays rather than a
  // record, because these are the game's own state and never cross a wire.
  const xs: i32[] = [0, 96, 192, 288];
  const ys: i32[] = [0, 64, 128, 192];
  const dx: i32[] = [SPEED, -SPEED, SPEED + 1, -(SPEED + 1)];
  const dy: i32[] = [SPEED + 1, SPEED, -SPEED, -SPEED];

  const width: i32 = request.width;
  const height: i32 = request.height;
  const maxX: i32 = width - <i32>CELL;
  const maxY: i32 = height - <i32>CELL;

  // A windowed run has no budget; an offscreen one has `HEADLESS_FRAMES`.
  let budget: i32 = windowed ? -1 : HEADLESS_FRAMES;
  let drawn: i32 = 0;

  while (budget != 0) {
    records.reset();
    for (let i = 0; i < SPRITES; i++) {
      // The record fills itself, and the buffer is what owns it.
      records.pushFrame(xs[i], ys[i], frames[i], <u32>i, 0, 0);

      xs[i] += dx[i];
      ys[i] += dy[i];
      if (xs[i] < 0) { xs[i] = 0; dx[i] = -dx[i]; }
      if (xs[i] > maxX) { xs[i] = maxX; dx[i] = -dx[i]; }
      if (ys[i] < 0) { ys[i] = 0; dy[i] = -dy[i]; }
      if (ys[i] > maxY) { ys[i] = maxY; dy[i] = -dy[i]; }
    }

    const accepted = canvas.submit(pipe, records, 0);
    if (accepted != SPRITES) {
      fail("submit -> " + accepted.toString() + ", expected " + SPRITES.toString());
    }

    // The close button, asked directly. `present` answers -ECANCELED only when
    // its own pump is the one that drained SDL's quit event, and the host pumps
    // during `RuntimeSession.wait` too — so a loop that owns its lifetime and
    // relies on `present` alone leaves the X doing nothing.
    if (windowInfo().closeRequested) break;

    // `present` answers -ECANCELED once the window is gone: that is the signal
    // to stop, not an error to report.
    if (canvas.present() != 0) break;

    // Paced by the host, one tick per frame. Without this a software driver
    // spins as fast as the CPU allows and the sprites cross the window in a
    // blur — or the whole run finishes before anyone looks at it.
    RuntimeSession.wait(16);
    drawn++;
    if (budget > 0) budget--;
  }

  print("starter: drew " + drawn.toString() + " frames");

  canvas.close();
  RuntimeSession.close();
}
