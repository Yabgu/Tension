// tension-framework/assembly/2d/canvas.ts — the `tension::2d` session, as an
// object.
//
// A `Canvas` is one open handle: the GPU device, the offscreen target and the
// capability's one session, plus the verbs that act on them. It owns nothing
// else — no scene, no record buffer, no frame loop.
//
// **A game starts at `Scene`, not here.** `scene.ts` is the declarative layer:
// nodes in fixed-size arrays, `commit` that packs the ones that changed and
// submits them, and `run` that drives the whole frame loop. This class is the
// verb surface that layer stands on, and its `submit`/`present` are what
// `Scene.commit` and `Scene.run` call.
//
// Reach for `Canvas` directly in exactly two cases, both of which the examples
// demonstrate: a **one-shot** program that draws a single frame and asserts on
// the pixels (`hello-sprites`, and every pixel suite), and the **wire oracle**
// (`examples/2d/isometric`), which builds records by hand *on purpose* so that a
// lie in the layers above it shows up as a diff. A game with a loop uses
// `Scene`.
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
// Two verbs cross a destination: `submit` reads a 12-byte header and `info`
// writes a 24-byte record. Both use a module-level static block rather than
// allocating per call. 2D is a capacity-1 capability — a second `open` is
// `-EBUSY` (`tension_2d.h:52-54`) — so two Canvases never talk to one adapter at
// once, and neither `submit` nor `info` is re-entrant (`info` is
// `REENTRANT_READONLY`: it may run inside a callback, but nothing else in this
// class runs there).
//
// **The submit header is this class's, not the caller's.** It used to be a
// `(ptr, count)` pair the guest laid out itself, which meant the header and the
// records it described were two values that could disagree. `submit` now takes a
// `RecordBuffer` and writes the header from that buffer's own count, so the
// count in the header is the count of the records behind it by construction.
// The two buffers a guest still owns — records and pixels — are `RecordBuffer`
// and `Pixels`, and neither hands out an address (see `buffers.ts`).
//
// ## What is deliberately not here
//
// No animation, no swapchain management, no auto-`present`. A canvas is fixed for
// the handle's life; a resize is `close()` then `Canvas.open()`
// (`tension_2d.h:59-61`).
//
// **And no scene.** `scene.ts` is the declarative layer — nodes in arrays, a
// `commit` that packs and submits — and it is a separate module that *uses* this
// one. A canvas that owned a scene would make the two impossible to test apart:
// the scene is a pure data structure (`Scene.create(w, h, capacity)`, `pack()`),
// so its retention, culling and ordering are asserted with no GPU in the process
// (`tests/guest-scene.ts`), and this class stays the thing that talks to the
// adapter.

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
import { Bytes } from "../bytes";
import { Pixels, RecordBuffer } from "./buffers";
import { HEADER_SIZE, Info, SubmitHeader } from "./types";
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
    // The refusal is deliberately ignored: the fallback below is the point of
    // this helper, and `Canvas.open` decides from the host's post-attempt
    // state, not from this call's rc.
    Canvas.openWindow(width, height, title);
    const flags: i32 = platform.hasSurface() ? OPEN_WINDOWED : OPEN_OFFSCREEN;
    return Canvas.open(width, height, flags);
  }

  /**
   * Create the host window this app presents to, if there is none.
   *
   * Split out of `windowedOrOffscreen` because the size of the window has to be
   * known *before* anything is laid out, and only the host knows it: a request
   * that cannot fit the display is fitted to the display's work area (the host's
   * `fit_to_work_area`), so a layout computed from the request can be a layout
   * for a window that does not exist. Measured: 1920x1080 requested on a
   * 1920x1080 display opens at 1888x968, because the title bar and borders have
   * to live somewhere.
   *
   * Idempotent — a second call finds the window and creates nothing — so a
   * caller that opened a window itself, or the shell that creates it up front,
   * can still go through `windowedOrOffscreen` afterwards.
   */
  static openWindow(width: i32, height: i32, title: string = "Tension"): void {
    if (platform.windowInfo().width != 0) return;
    Canvas.createGpuWindow(width, height, title);
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
  pipelineGraph(blob: Bytes): i32 {
    if (!this.isValid()) return this.refuse(ERR_INVAL);
    if (blob.isEmpty) return this.refuse(ERR_INVAL);
    return this.record(setPipelineRaw(this.handle, i32(blob.address()), i32(blob.length)));
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
  loadTexture(bytes: Bytes): i32 {
    return this.loadTextureAs(bytes, TEX_RGBA8);
  }

  /**
   * `loadTexture`, with the target format named. `-EINVAL` for an unknown
   * format, `-ENOSYS` for a container this build does not serve
   * (`tension_2d.h:210-214`).
   */
  loadTextureAs(bytes: Bytes, format: i32): i32 {
    if (!this.isValid()) return this.refuse(ERR_INVAL);
    // An empty source is `-EINVAL` at the adapter, and there is no reason to
    // cross the boundary to be told what this object already knows.
    if (bytes.isEmpty) return this.refuse(ERR_INVAL);
    return this.record(textureLoadRaw(this.handle, i32(bytes.address()), i32(bytes.length),
                                      format));
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
    return this.loadTextureAs(Bytes.viewOf(bytes), TEX_RGBA8);
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
   * Append the buffer's records to bucket `bucket` for the next `present`;
   * returns how many were accepted.
   *
   * **`Scene.commit` calls this; a game usually does not.** The scene owns the
   * buffer, decides which records changed and packs them, then hands the whole
   * set here — so a caller that finds itself calling `submit` per frame is
   * rebuilding a record set the scene could have retained.
   *
   * **The count is the buffer's, not a parameter.** `submit(pipe, records, 4)`
   * on a buffer holding ten records used to be a legal call that drew four, and
   * the pointer and its count were two values that could disagree. Now the only
   * way to submit n records is to have pushed n.
   *
   * The 12-byte `tension_2d_submit_hdr` is written here, from that count and the
   * records' own stride — a caller that could pass a stride could submit records
   * the adapter cannot decode (`types.ts`, `SubmitHeader`). One `guest_read`
   * copies the header and the whole array, so the records must be contiguous,
   * which is a property of `RecordBuffer` rather than a promise from a caller.
   *
   * A short bucket answers `-ENOSPC` and the caller splits and re-submits — which
   * is why a count comes back rather than a status. `-EINVAL` for a bad handle or
   * header, `-ENOENT` for an unknown `pipe`.
   *
   * **Not a partial accept.** The adapter's budget is 4096 records summed across
   * every bucket, and a submit that would exceed it is refused whole
   * (`render2d/device.rs:506`, and the C++ reference at `render.cpp:672`). A
   * caller that must draw regardless watches `RecordBuffer.dropped` and pages
   * its own content; it does not get half a frame.
   *
   * The header block is shared by every Canvas in the module; see "Static
   * buffers" at the top.
   */
  submit(pipe: i32, records: RecordBuffer, bucket: i32 = 0): i32 {
    if (!this.isValid()) return this.refuse(ERR_INVAL);
    const count = records.count;
    if (count <= 0) return 0;
    let view = records.view();
    let header = changetype<@unmanaged [SubmitHeader *]>(SUBMIT_HEADER);
    header[0].set(view, <u32>count);
    return this.record(submitRaw(this.handle, pipe, i32(SUBMIT_HEADER), bucket));
  }

  /**
   * Draw every bucket recorded since the last `present`, in ascending bucket
   * order, then clear the staging state.
   *
   * **`Scene.run` calls this once per frame.** A caller driving its own loop
   * calls it itself; nothing else in the 2D path draws.
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
   * Copy the last presented frame into `into` as RGBA8, and return the bytes
   * written (`width * height * 4`).
   *
   * **The size is the destination's.** `Pixels` knows the `width` x `height` it
   * was built for, so the capacity is checked here, before the verb: a `Pixels`
   * smaller than `frameBytes(width, height)` is `-EINVAL`, not the `-ENOSPC` the
   * adapter would produce, because there is no reason to cross the boundary to
   * learn something this object already knows. `-ENODEV` means nothing has been
   * presented yet; `-EIO` means the download failed
   * (`tension_2d.h:258-268`).
   *
   * A guest that passes the wrong-sized `Pixels` gets a refusal rather than a
   * short frame, which is the improvement: the old signature took a byte count
   * beside the pointer, and the two could describe different buffers.
   *
   * Not re-entrant: it waits for the GPU, which no callback may do.
   */
  screenshot(into: Pixels): i32 {
    if (!this.isValid()) return this.refuse(ERR_INVAL);
    const need = frameBytes(this.width, this.height);
    const have = into.byteLength();
    if (need == 0 || have < <i32>need) return this.refuse(ERR_INVAL);
    return this.record(screenshotRaw(this.handle, u32(into.address()), i32(have)));
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
