// src/main.ts — four sprites bouncing inside the window.
//
// Every Tension 2D app has this shape:
//
//   1. open the session        — nothing that touches guest memory works before it
//   2. ask for a window        — the runtime has no window flag; the guest owns it
//   3. set the pipeline        — the blob the adapter was built against
//   4. load the atlas          — out of the packed volume, mounted at "/"
//   5. spawn nodes, then run   — the scene draws them; the loop is the host's
//
// Step 5 is the interesting one, and it is two things: a `Scene` you put nodes
// into, and `scene.run`, which hands the frame loop to the host. A game never
// builds a record, never calls `submit`, and never calls `present`.
//
// The numbers are deliberately editable: change SPEED, save, and `tension dev`
// rebuilds and restarts the game on its own.

import {
  Bytes,
  Canvas,
  ConfigBuilder,
  Frame,
  FrameStep,
  print,
  RuntimeSession,
  Scene,
  Sprite,
} from "tension-framework";

// **The line that adopts the host's loop.** The host drives a guest only when it
// exports both `__taskWake` and `_game_running`, and refuses half an adoption at
// load. Only the *entry module's* exports reach the wasm, so the framework cannot
// supply these for you — this is the one line `scene.run` needs, and it is the
// step nothing warns you about if you leave it out: the guest simply returns and
// draws nothing.
export { __taskWake, __taskResume, __taskFail, _game_running } from "tension-framework";

import { windowRequest } from "tension-framework/assembly/platform";
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
/// spinning until something kills it. It is `scene.run`'s last argument: `0`
/// means "no budget", which is what a windowed run passes.
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

// ── the game ────────────────────────────────────────────────────────────────

/// The per-frame update: a class, not a closure.
///
/// `FrameStep` is an interface for a measured reason. A closure that captures a
/// *stack local* cannot be called on this toolchain — it traps at `call_indirect`
/// with `uninitialized element`, synchronously, before any `await` is involved.
/// A method dispatches through a table entry the class installs at definition,
/// and that works. Holding the state in fields is what a game wants anyway.
class Bouncer implements FrameStep {
  private sprites: Sprite[];
  private dx: i32[];
  private dy: i32[];
  private maxX: i32;
  private maxY: i32;

  constructor(sprites: Sprite[], dx: i32[], dy: i32[], width: i32, height: i32) {
    this.sprites = sprites;
    this.dx = dx;
    this.dy = dy;
    this.maxX = width - <i32>CELL;
    this.maxY = height - <i32>CELL;
  }

  /// Called once per frame by `scene.run`, before the scene commits.
  step(): void {
    for (let i = 0; i < this.sprites.length; i++) {
      const s = this.sprites[i];
      s.x += <f32>this.dx[i];
      s.y += <f32>this.dy[i];
      // Position is a property, not a record field: setting it marks the node,
      // and the scene decides what that costs this frame.
      if (s.x < 0.0) { s.x = 0.0; this.dx[i] = -this.dx[i]; }
      if (s.x > <f32>this.maxX) { s.x = <f32>this.maxX; this.dx[i] = -this.dx[i]; }
      if (s.y < 0.0) { s.y = 0.0; this.dy[i] = -this.dy[i]; }
      if (s.y > <f32>this.maxY) { s.y = <f32>this.maxY; this.dy[i] = -this.dy[i]; }
    }
  }
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
  const pipe = canvas.pipelineGraph(Bytes.ofArray(DEFAULT_2D_BLOB));
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

  // ── 5. the scene ──────────────────────────────────────────────────────────
  // A node per sprite. The scene owns the record buffer, and `run` packs it once
  // per frame from whatever changed — nothing here sees a record.
  const scene = Scene.create(request.width, request.height, SPRITES);

  // One `Frame` per cell, built once. A Frame per sprite per frame would be an
  // allocation per frame, and the 2D runtime is explicitly free of those.
  const frames: Frame[] = [
    new Frame(0, <u16>0, <u16>0, <u16>CELL, <u16>CELL),
    new Frame(0, <u16>CELL, <u16>0, <u16>CELL, <u16>CELL),
    new Frame(0, <u16>(2 * <i32>CELL), <u16>0, <u16>CELL, <u16>CELL),
    new Frame(0, <u16>(3 * <i32>CELL), <u16>0, <u16>CELL, <u16>CELL),
  ];

  const sprites: Sprite[] = [];
  const xs: i32[] = [0, 96, 192, 288];
  const ys: i32[] = [0, 64, 128, 192];
  for (let i = 0; i < SPRITES; i++) {
    const sprite = scene.spawn(frames[i]);
    sprite.moveTo(<f32>xs[i], <f32>ys[i]);
    sprites.push(sprite);
  }

  // ── 6. run ────────────────────────────────────────────────────────────────
  // `run` is the whole frame loop — step, commit, present, yield — and it returns
  // immediately, because the host owns the loop from the first `await` onward. It
  // closes the canvas and the session when the loop ends.
  const dx: i32[] = [SPEED, -SPEED, SPEED + 1, -(SPEED + 1)];
  const dy: i32[] = [SPEED + 1, SPEED, -SPEED, -SPEED];
  scene.run(canvas, pipe,
            new Bouncer(sprites, dx, dy, request.width, request.height),
            windowed ? 0 : HEADLESS_FRAMES);
}
