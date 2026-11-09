// tension-framework/assembly/2d/canvas.ts — the `tension::2d` session, as an
// object.
//
// A `Canvas` is one open handle: the GPU device, the offscreen target and the
// capability's one session, plus the verbs that act on them. It owns nothing
// else — no scene, no record buffer, no frame loop. The scene layer
// (`tileset.ts`, `composite.ts`, `isometric-world.ts`) turns game state into
// records; this turns a Canvas into a place to draw them.
//
// ## Errors
//
// Every method returns the verb's `i32` unchanged — a negative errno is the
// refusal, and the framework neither translates it nor invents a `Result`.
// That is `audio.ts`'s and `ogre/index.ts`'s contract, and it is the one a game
// author debugging a black screen needs: the number the adapter produced, not
// a category.
//
// `lastError()` is the *last* number observed, not an accumulating log. A
// successful call clears it. There is no `last_error` verb in 2D — the header
// has none — so this is the only record of a refusal that a method could not
// return (see `readInfo`).
//
// ## An invalid handle refuses locally
//
// `open` answering 0 or an errno is a normal outcome (no GPU, a bad size, a
// session already open). A `Canvas` wrapping it is still usable as an object:
// every method refuses with `-EINVAL` without calling a verb, so a game that
// forgets to check `isValid()` gets a clean refusal instead of an adapter
// error about handle 0. `close()` is the exception — it returns 0, because
// closing a thing that was never open is not a failure.
//
// ## Static buffers, and why they are safe
//
// Two verbs take a destination the guest writes: `submit` reads a 12-byte
// header the caller must lay out, and `info` writes a 24-byte record. Both use
// a module-level static block rather than allocating per call. 2D is a
// capacity-1 capability — a second `open` is `-EBUSY` (`tension_2d.h:52-54`) —
// so two Canvases never talk to one adapter at once, and neither `submit` nor
// `info` is re-entrant (`info` is `REENTRANT_READONLY`: it may run inside a
// callback, but nothing else in this class runs there).
//
// ## What is deliberately not here
//
// No animation, no swapchain management, no auto-`present`, no scene graph. A
// canvas is fixed for the handle's life; a resize is `close()` then
// `Canvas.open()` (`tension_2d.h:59-61`).

import { resReadFile } from "../res";
// The host's window API: `windowedOrOffscreen` creates the window the canvas
// presents to, and `displaysToWindow` reports whether it ended up with one.
import * as platform from "../platform";
import {
  ERR_INVAL,
  ERR_NOENT,
  frameBytes,
  INFO_SIZE,
  OPEN_OFFSCREEN,
  OPEN_WINDOWED,
  PIPE_PRESET_MIN,
  TEX_RGBA8,
} from "./constants";
import { HEADER_SIZE, Info, Rgba, SpriteRecord, SubmitHeader } from "./types";
import {
  closeRaw,
  infoRaw,
  openRaw,
  presentRaw,
  screenshotRaw,
  setPipelineRaw,
  setTextureRaw,
  submitRaw,
  textureLoadRaw,
} from "./verbs";

/** The `submit` header block. See "Static buffers" above. */
const SUBMIT_HEADER: usize = memory.data(<i32>HEADER_SIZE, 4);
/** The `info` destination block. Re-entrant read, single writer. */
const INFO_BUFFER: usize = memory.data(<i32>INFO_SIZE, 4);

export class Canvas {
  /** The adapter's handle: > 0 open, 0 refused. Never changes for a Canvas. */
  handle: i32;
  /** The size `open` was asked for — not a query of the device. */
  width: i32;
  height: i32;
  /** The last errno observed; 0 after a success. */
  private err: i32 = 0;
  /** Set by `close()`, so a second `close` does not call the verb. */
  private closed: bool = false;
  /** Whether this canvas presents to a window (opened with `OPEN_WINDOWED`). */
  private shows: bool = false;

  private constructor(handle: i32, width: i32, height: i32) {
    this.handle = handle;
    this.width = width;
    this.height = height;
    // The header's refusals are all negative errnos (`tension_2d.h:44-58`), so
    // this carries the reason. A literal 0 — which the adapter does not
    // produce, but which "no handle" must mean — leaves `err` at 0; every
    // method on it still refuses locally, and `isValid()` is the check that
    // matters.
    if (handle <= 0) this.err = handle;
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Open a canvas at `width` x `height`.
   *
   * Offscreen by default: `present` draws to the target, waits for the GPU, and
   * `screenshot` reads the frame back. That is what the test suites run, and it
   * is why their pixels do not depend on a compositor.
   *
   * A refusal is not an exception: the returned Canvas has `handle <= 0`, every
   * method on it answers `-EINVAL`, and `lastError()` is the errno `open`
   * produced — `-EINVAL` for a size or flag outside what the header allows,
   * `-EBUSY` for a second canvas, `-ENODEV` for no GPU, `-ENOSYS` for an SDL
   * build with no GPU backend, `-EIO`, `-ENOMEM` (`tension_2d.h:44-58`).
   */
  static open(width: i32, height: i32, flags: i32 = OPEN_OFFSCREEN): Canvas {
    const canvas = new Canvas(openRaw(width, height, flags), width, height);
    // Recorded here rather than in `windowedOrOffscreen`: every construction
    // route ends at `open`, and the flags are the only thing that decides it.
    canvas.shows = (flags & OPEN_WINDOWED) != 0;
    return canvas;
  }

  /**
   * Open a canvas that presents to a window of its canvas size.
   *
   * `TENSION_2D_OPEN_WINDOWED` (`tension_2d.h:71-85`) creates the host window
   * **if there is not one already**, claims it for the GPU device, and blits the
   * target into a swapchain on every `present`. This method therefore works
   * either way: a guest that wants a window and does not care how it is made
   * calls this directly; a guest that wants control over DPI, position or a
   * non-default title calls `platform.createWindow` first and then this, and
   * the canvas claims the window already there. (When the guest's window and
   * the canvas disagree on size the swapchain scales — the frame is not
   * cropped; core logs the mismatch at `render2d/device.rs`.)
   *
   * One window, one swapchain: a run that opens a window elsewhere and also
   * opens a canvas windowed claims *that* window rather than making a second
   * one, which is what `platform.hasSurface()` is checked for inside the core's
   * `open_windowed`. The renderer is a presentation path, not a second renderer
   * — the frame is the same frame, so `screenshot` still reads back what was
   * shown.
   *
   * A windowed canvas pumps SDL events during `present`. When the user closes
   * the window, `present` answers `-ECANCELED` once and then draws nothing
   * more; treat that as "stop", not as an error to retry.
   */
  static windowed(width: i32, height: i32, title: string = "Tension"): Canvas {
    // The title only matters when this call is what creates the window; a
    // window the caller already made keeps the title it was created with.
    if (!platform.hasSurface()) {
      Canvas.createGpuWindow(width, height, title);
    }
    return Canvas.open(width, height, OPEN_WINDOWED);
  }

  /**
   * Open a canvas in a window if a window can be had, offscreen if not.
   *
   * The demo/CI shape: "show me the frame, and keep working on a machine with
   * no display". A refused window is **not** a failure here — the canvas falls
   * back to offscreen, `present` writes the target, and `screenshot` still
   * reads the identical frame. Ask `displaysToWindow()` afterwards to say which
   * happened (the examples print "drawing offscreen" for the reader).
   *
   * Only a refused *canvas* is a failure, and the returned `Canvas` carries it
   * as an invalid handle with `lastError()` set, like every other route into
   * `open`.
   */
  static windowedOrOffscreen(width: i32, height: i32, title: string = "Tension"): Canvas {
    if (!platform.hasSurface()) {
      // The refusal is deliberately ignored: the fallback below is the point of
      // this helper, and `Canvas.open` decides from the host's post-attempt
      // state, not from this call's rc.
      Canvas.createGpuWindow(width, height, title);
    }
    const flags: i32 = platform.hasSurface() ? OPEN_WINDOWED : OPEN_OFFSCREEN;
    return Canvas.open(width, height, flags);
  }

  /**
   * Whether this canvas presents to a window.
   *
   * True for a canvas opened with `OPEN_WINDOWED`, false for the offscreen
   * fallback — the answer `windowedOrOffscreen` leaves for a caller that wants
   * to tell the user why no window appeared.
   */
  displaysToWindow(): bool {
    return this.shows;
  }

  /// Create the SDL_GPU window a canvas presents to. `Gpu` and not `Vulkan`:
  /// SDL_GPU claims the window and builds its own surface, so the
  /// `SDL_WINDOW_VULKAN` flag is not needed — and on Windows it would demand a
  /// Vulkan loader this renderer does not use.
  private static createGpuWindow(width: i32, height: i32, title: string): void {
    const config = new platform.WindowConfig();
    config.target = platform.WindowTarget.Gpu;
    config.width = <u32>width;
    config.height = <u32>height;
    config.title = title;
    platform.createWindow(config);
  }

  /** Whether `open` produced a usable handle. */
  isValid(): bool {
    return this.handle > 0 && !this.closed;
  }

  /** The last errno this Canvas observed; 0 when the last accepted call worked. */
  lastError(): i32 {
    return this.err;
  }

  /**
   * Release every texture, pipeline and buffer, the target and the device.
   *
   * Idempotent locally: a second call returns 0 without reaching the adapter,
   * and so does a `close` on a Canvas whose `open` was refused. The host's own
   * teardown is the backstop if a guest never calls this (`tension_2d.h:88-98`).
   */
  close(): i32 {
    if (this.closed || this.handle <= 0) {
      this.closed = true;
      return 0;
    }
    const rc = closeRaw(this.handle);
    this.closed = true;
    this.handle = 0;
    return this.record(rc);
  }

  // --- pipelines -----------------------------------------------------------

  /**
   * A built-in preset, addressed by id — `set_pipeline` with `blob_ptr == 0`.
   *
   * Preset 1 (`default_2d`) is the only one this build compiles; another id in
   * `PIPE_PRESET_MIN..PIPE_PRESET_MAX` is `-ENOSYS`, one outside it `-ENOENT`
   * (`tension_2d.h:108-118`). Returns the `pipe_id` (which equals the preset
   * id), or a negative errno.
   */
  pipeline(preset: i32 = PIPE_PRESET_MIN): i32 {
    if (!this.isValid()) return this.refuse(ERR_INVAL);
    return this.record(setPipelineRaw(this.handle, 0, preset));
  }

  /**
   * A serialized graph blob (`T2DG`) already in guest memory.
   *
   * The bytes must be the ones the DSO was built against: `set_pipeline` hashes
   * them and resolves to the module pair this build compiled from that graph,
   * answering `-ENOSYS` for a graph it did not ship and did not manage to
   * compile through the host. `scripts/build-2d-guest.mjs` emits the blob as a
   * TypeScript literal for exactly this reason.
   */
  pipelineGraph(blob: usize, len: u32): i32 {
    if (!this.isValid()) return this.refuse(ERR_INVAL);
    return this.record(setPipelineRaw(this.handle, i32(blob), i32(len)));
  }

  // --- textures ------------------------------------------------------------

  /**
   * Decode `len` bytes at `bytes` and upload one texture; returns its 1-based
   * id, or a negative errno.
   *
   * The GPU format is not the caller's to name: v1 serves one, RGBA8, and a
   * game that had to pass `TEX_RGBA8` at every call site would be naming a
   * detail it cannot vary. `loadTextureAs` is the visible door for the day a
   * second format exists. It is not deprecated and not called from here.
   *
   * v1 reads **IWI** (`IWI1`) with interleaved 8-bit RGB or RGBA; anything else
   * is `-ENOSYS`, not a guess (`tension_2d.h:216-222`).
   */
  loadTexture(bytes: usize, len: u32): i32 {
    return this.loadTextureAs(bytes, len, TEX_RGBA8);
  }

  /**
   * `loadTexture`, with the target format named. `-EINVAL` for an unknown
   * format, `-ENOSYS` for a container this build does not serve
   * (`tension_2d.h:210-214`).
   */
  loadTextureAs(bytes: usize, len: u32, format: i32): i32 {
    if (!this.isValid()) return this.refuse(ERR_INVAL);
    return this.record(textureLoadRaw(this.handle, i32(bytes), i32(len), format));
  }

  /**
   * Read a file out of the mounted `.tns` and upload it as one texture.
   *
   * This is the loop all three 2D examples hand-code — `ResFile.open(path)`,
   * `readAll()`, `texture_load`, `close()` — in a method, because every example
   * getting it right is not the same as it being right once. Returns the
   * texture id, `-ENOENT` when the path does not resolve, or whatever
   * `texture_load` refused with.
   *
   * The bytes are read whole into a guest buffer and freed when this returns;
   * `texture_load` copies them into the device, so nothing holds the buffer
   * afterwards.
   */
  loadTextureFromRes(path: string): i32 {
    if (!this.isValid()) return this.refuse(ERR_INVAL);
    const bytes = resReadFile(path);
    if (bytes == null) return this.refuse(ERR_NOENT);
    return this.loadTextureAs(bytes.dataStart, <u32>bytes.length, TEX_RGBA8);
  }

  /**
   * Bind a texture to one page of a pipeline's texture array, or to 0.
   *
   * A record's `tex` is the page it samples, so this is what gives `tex` its
   * meaning. `slot` is `0..MAX_ATLAS_PAGES-1`; every page of one pipeline is
   * the same size, and a texture that disagrees is `-EINVAL` rather than
   * resampled (`tension_2d.h:225-241`).
   */
  bindTexture(pipe: i32, slot: i32, texture: i32): i32 {
    if (!this.isValid()) return this.refuse(ERR_INVAL);
    return this.record(setTextureRaw(this.handle, pipe, slot, texture));
  }

  // --- drawing -------------------------------------------------------------

  /**
   * Append `count` records to bucket `bucket` for the next `present`; returns
   * how many were accepted.
   *
   * The 12-byte `tension_2d_submit_hdr` is written here, from `count` and the
   * records' own stride — a caller that could pass a stride could submit
   * records the adapter cannot decode (`types.ts`, `SubmitHeader`). One
   * `guest_read` copies the header and the whole array, so the records must be
   * contiguous in guest memory, which is what `@unmanaged [SpriteRecord *]`
   * says they are.
   *
   * A short bucket answers `-ENOSPC` and the caller splits and re-submits —
   * which is why a count comes back rather than a status. `-EINVAL` for a bad
   * handle or header, `-ENOENT` for an unknown `pipe`.
   *
   * The header block is shared by every Canvas in the module; see "Static
   * buffers" at the top.
   */
  submit(pipe: i32, records: @unmanaged [SpriteRecord *], count: u32, bucket: i32 = 0): i32 {
    if (!this.isValid()) return this.refuse(ERR_INVAL);
    let header = changetype<@unmanaged [SubmitHeader *]>(SUBMIT_HEADER);
    header[0].set(records, count);
    return this.record(submitRaw(this.handle, pipe, i32(SUBMIT_HEADER), bucket));
  }

  /**
   * Draw every bucket recorded since the last `present`, in ascending bucket
   * order, then clear the staging state.
   *
   * `-ECANCELED` means a windowed canvas's window was closed: stop, do not
   * retry (`tension_2d.h:76-78`).
   */
  present(): i32 {
    if (!this.isValid()) return this.refuse(ERR_INVAL);
    return this.record(presentRaw(this.handle));
  }

  // --- reading back --------------------------------------------------------

  /**
   * The capability's 24-byte info record: limits and the canvas size.
   *
   * `canvasWidth`/`canvasHeight` echo the size the handle was opened with, so a
   * caller can size a screenshot buffer without remembering what it asked for.
   *
   * **The one method that cannot return an errno**, because the record is the
   * return value. A refusal — no handle, a short buffer the adapter would
   * refuse — yields a zeroed record: `version == 0`, which no real answer has
   * (the current version is 2), and `lastError()` carries the number. Checking
   * `version` is how a caller tells.
   *
   * `info` is `REENTRANT_READONLY`: it may be called from a callback and never
   * blocks (`tension_2d.h:236-250`).
   */
  readInfo(): Info {
    let out = new Info();
    if (!this.isValid()) {
      this.refuse(ERR_INVAL);
      return out;
    }
    const written = infoRaw(this.handle, u32(INFO_BUFFER), i32(INFO_SIZE));
    if (written < 0) {
      this.refuse(written);
      return out;
    }
    this.err = 0;
    // A field-wise copy, because the compiler refuses the shorter spelling: a
    // view element is an address, and `let got: Info = view[0]` is refused as
    // "initialising an @inline struct local from this expression" at link time
    // (it compiles when the module is built alone, which is why this is
    // written the way the real link requires). Reading each field off the view
    // is still a read through the declaration — no offset is typed here.
    //
    // `let`, not `const`: a `const` view in a scope that also declares an
    // integer `const` crashes the compiler (types.ts documents the repro).
    let view = changetype<@unmanaged [Info *]>(INFO_BUFFER);
    out.version = view[0].version;
    out.maxRecords = view[0].maxRecords;
    out.maxTextures = view[0].maxTextures;
    out.maxPipelines = view[0].maxPipelines;
    out.maxBuckets = view[0].maxBuckets;
    out.flags = view[0].flags;
    out.canvasWidth = view[0].canvasWidth;
    out.canvasHeight = view[0].canvasHeight;
    return out;
  }

  /**
   * Copy the last presented frame into `out` as RGBA8, and return the bytes
   * written (`width * height * 4`).
   *
   * The capacity is checked here, before the verb: a buffer smaller than
   * `frameBytes(width, height)` is `-EINVAL`, not the `-ENOSPC` the adapter
   * would produce, because there is no reason to cross the boundary to learn
   * something this object already knows. `-ENODEV` means nothing has been
   * presented yet; `-EIO` means the download failed
   * (`tension_2d.h:258-268`).
   *
   * Not re-entrant: it waits for the GPU, which no callback may do.
   */
  screenshot(out: @unmanaged [Rgba *], bytes: u32): i32 {
    if (!this.isValid()) return this.refuse(ERR_INVAL);
    const need = frameBytes(this.width, this.height);
    if (need == 0 || bytes < need) return this.refuse(ERR_INVAL);
    return this.record(screenshotRaw(this.handle, u32(<usize>out), i32(bytes)));
  }

  // --- the errno record ----------------------------------------------------

  /** Remember `rc` and return it: every accepted call passes through here. */
  private record(rc: i32): i32 {
    this.err = rc < 0 ? rc : 0;
    return rc;
  }

  /** Refuse locally, without a verb, and remember why. */
  private refuse(rc: i32): i32 {
    this.err = rc;
    return rc;
  }
}
