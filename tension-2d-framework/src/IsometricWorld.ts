// tension-2d-framework/src/IsometricWorld.ts — tall sprites, sliced, in depth.
//
// The depth model is one number per record: `sort_key`. A record with a larger
// sort key draws later, so it appears in front. For a top-down or isometric
// scene the number that means "depth" is the bottom edge of what is drawn — the
// ground where the sprite stands — because a sprite's base is what touches the
// floor and what should be occluded or occlude.
//
// That makes tall art a problem. A 32×64 tree has one top edge and two very
// different depths: its crown sits far behind a character standing at its base,
// its trunk in front. One record cannot say that, so `addStatic` writes one
// record per `sliceHeight` band, each sorted by its own bottom edge. The tree
// stops being one sprite and becomes a stack of sprites with a rule.
//
// The rule is:
//
//     slice i covers rows [i*sh, (i+1)*sh)
//     its drawn y  is worldY + i*sh
//     its sort_key is worldY + (i+1)*sh        <- the band's bottom edge
//
// `sliceHeight = 0` means "do not slice": one record, sorted by the sprite's own
// bottom edge. That is the revert lever — unsliced, the whole tree draws at its
// base and the character disappears behind it.
//
// The world does **not** sort. `emit` writes statics first, then actors, and the
// adapter's comparator orders the lot. Sorting here as well would be a second
// implementation of the same rule, and the two would eventually disagree about
// which of two equal keys goes first.

import { Frame, writeRecord } from "./types";
import { Composite } from "./Composite";
import { Tileset } from "./Tileset";

class Pending {
  frame: Frame;
  x: i32;
  y: i32;
  sortKey: u32;
  groupId: u16;
  z: u8;

  constructor(frame: Frame, x: i32, y: i32, sortKey: u32, groupId: u16, z: u8) {
    this.frame = frame;
    this.x = x;
    this.y = y;
    this.sortKey = sortKey;
    this.groupId = groupId;
    this.z = z;
  }
}

class Actor {
  composite: Composite;
  x: i32;
  y: i32;

  constructor(composite: Composite, x: i32, y: i32) {
    this.composite = composite;
    this.x = x;
    this.y = y;
  }
}

export class IsometricWorld {
  private statics: Pending[];
  private actors: Actor[];

  private constructor() {
    this.statics = [];
    this.actors = [];
  }

  static create(): IsometricWorld {
    return new IsometricWorld();
  }

  /**
   * Add a sprite standing at (`x`,`y`) — `y` is its **top** edge, which is what
   * a record's `y` means; the sort keys are computed from the bottom.
   *
   * `frame` comes from a `Tileset`; `atlas` is taken so the signature matches
   * the call site's intent and so a future version can derive `sliceHeight`
   * from the tileset's grid. Returns how many records were written, which is
   * `ceil(h / sliceHeight)` (1 when unsliced, 0 for an empty frame).
   */
  addStatic(atlas: Tileset, frame: Frame, x: i32, y: i32, sliceHeight: u32): u32 {
    if (!frame.isValid()) return 0;     // a lookup that found nothing
    if (!atlas.owns(frame)) return 0;   // a frame from another tileset
    const height = <u32>frame.h;
    if (height == 0) return 0;
    const sh: u32 = sliceHeight == 0 ? height : sliceHeight;

    let offset: u32 = 0;
    let count: u32 = 0;
    while (offset < height) {
      const band: u32 = min<u32>(sh, height - offset);
      // The band's own source rect: same page and column, the rows it covers.
      const bandFrame = new Frame(
        frame.tex,
        frame.srcX,
        <u16>(frame.srcY + <u16>offset),
        frame.w,
        <u16>band,
      );
      const top: i32 = y + <i32>offset;
      // The bottom edge is what depth means. For full bands this is
      // `y + (i+1)*sliceHeight`; for a short last band it is the sprite's own
      // bottom, which is the only answer that stays consistent with the
      // unsliced case.
      const sortKey = <u32>(top + <i32>band);
      this.statics.push(new Pending(bandFrame, x, top, sortKey, 0, 0));
      offset += band;
      count++;
    }
    return count;
  }

  /**
   * Add scenery that must never occlude anything — a floor tile, a sky panel, a
   * backdrop. One record, `sort_key` 0.
   *
   * This is not `addStatic` with a small slice height, and the difference
   * matters: `addStatic` sorts by a band's bottom edge, which is right for
   * anything *standing* on the floor and wrong for the floor itself. The bottom
   * row of a 6x6 ground grid has a bottom edge at y+96; sorted that way it draws
   * after a character standing at y=88 and covers its feet. Nothing on the floor
   * should ever be in front of what stands on it, so the floor's key is the
   * lowest one there is.
   *
   * Returns 1, or 0 for an invalid frame.
   */
  addGround(atlas: Tileset, frame: Frame, x: i32, y: i32): u32 {
    if (!frame.isValid()) return 0;
    if (!atlas.owns(frame)) return 0;
    this.statics.push(new Pending(frame, x, y, 0, 0, 0));
    return 1;
  }

  /** Add a composite at (`x`,`y`); its own `sortKey`/`groupId` travel with it. */
  addActor(composite: Composite, x: i32, y: i32): void {
    this.actors.push(new Actor(composite, x, y));
  }

  /** Records `emit` will write. Size the buffer with this, not with a guess. */
  recordCount(): u32 {
    let n: u32 = <u32>this.statics.length;
    for (let i: i32 = 0; i < this.actors.length; i++) {
      n += <u32>this.actors[i].composite.layerCount();
    }
    return n;
  }

  /**
   * Write every record: statics in the order they were added, then actors. The
   * order is stable across frames, which is what makes two submissions that
   * differ only in source order comparable.
   */
  emit(out: usize): u32 {
    let n: i32 = 0;
    for (let i: i32 = 0; i < this.statics.length; i++) {
      const p = this.statics[i];
      writeRecord(out, n, p.x, p.y, p.frame, p.sortKey, p.groupId, p.z);
      n++;
    }
    for (let i: i32 = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      n += <i32>a.composite.emitTo(out, n, a.x, a.y);
    }
    return <u32>n;
  }
}
