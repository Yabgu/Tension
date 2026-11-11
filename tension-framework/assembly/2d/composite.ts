// tension-framework/assembly/2d/composite.ts — a character that is several
// records.
//
// A modular character is N sprites drawn at one world position, sharing a sort
// key and a group id, ordered among themselves by `z`. The adapter's comparator
// sorts by `(sort_key, group_id, z)`, so "these three layers belong to one
// character" is expressed entirely by those three fields — the scene graph needs
// no notion of a parent.
//
// The reason for `zTable` rather than one `z` per layer: a character faces two
// ways, and the *order reverses*. Facing back, the backpack is nearest the
// camera; facing front, the body is. Setting a facing selects a column of the
// table, so the same three sprites become either view without rebuilding the
// record set.
//
// Eight columns because the table is indexed by facing and a facing is a small
// enum, not because eight views are drawn today: entries beyond the ones you use
// are zero and cost nothing.

import { RecordBuffer } from "./buffers";
import { Frame, FACINGS } from "./types";
import { Tileset } from "./tileset";

class Layer {
  name: string;
  frame: Frame;
  /** One z per facing. */
  z: u8[];

  constructor(name: string, frame: Frame, z: u8[]) {
    this.name = name;
    this.frame = frame;
    this.z = z;
  }
}

export class Composite {
  /** Shared by every layer; the adapter groups on it. */
  groupId: u16;
  /** Shared by every layer; this is the character's depth in the world. */
  sortKey: u32;
  /** Which column of the z tables is in force. */
  facing: u8;

  private layers: Layer[];

  private constructor(groupId: u16, sortKey: u32) {
    this.groupId = groupId;
    this.sortKey = sortKey;
    this.facing = 0;
    this.layers = [];
  }

  static create(groupId: u16, sortKey: u32): Composite {
    return new Composite(groupId, sortKey);
  }

  /**
   * Add a layer by tileset frame name. `zTable` is one z per facing; a table
   * shorter than `FACINGS` is legal and reads 0 past its end, which is the
   * right default for "this layer has no depth of its own in that view".
   *
   * Returns false when the name is not in the tileset — the caller's frame
   * lookup failed and a silent skip would be a character missing a limb.
   */
  addLayer(atlas: Tileset, frameName: string, zTable: u8[]): bool {
    const frame = atlas.frameNamed(frameName);
    if (!frame.isValid()) return false;
    this.layers.push(new Layer(frameName, frame, zTable));
    return true;
  }

  /** Same, from a frame that was never named. Silently ignores an invalid frame. */
  addFrame(frame: Frame, zTable: u8[]): bool {
    if (!frame.isValid()) return false;
    this.layers.push(new Layer("", frame, zTable));
    return true;
  }

  /** Which column of every z table is in force. Clamped to `FACINGS`. */
  setFacing(facing: u8): void {
    this.facing = <u8>min<i32>(<i32>facing, FACINGS - 1);
  }

  layerCount(): i32 {
    return this.layers.length;
  }

  /** The z a layer would write for the current facing (0 past the table's end). */
  zOf(index: i32): u8 {
    const table = this.layers[index].z;
    return <i32>this.facing < table.length ? table[<i32>this.facing] : 0;
  }

  /**
   * Append this composite's records to `into`, positioned at (`x`,`y`). Returns
   * how many were appended.
   *
   * **No index parameter.** The buffer carries its own count, so the offset a
   * caller used to track beside the pointer — `emitTo(out, n, …)` where `n` had
   * to agree with everything written so far — is the buffer's business now. That
   * agreement was never checked, and a composite emitted at the wrong `index`
   * drew a character over another one.
   */
  emitInto(into: RecordBuffer, x: i32, y: i32): u32 {
    for (let i: i32 = 0; i < this.layers.length; i++) {
      into.pushFrame(x, y, this.layers[i].frame, this.sortKey, this.groupId, this.zOf(i));
    }
    return <u32>this.layers.length;
  }

  /** `emitInto` — the standalone use, when no world owns the buffer. */
  emit(into: RecordBuffer, x: i32, y: i32): u32 {
    return this.emitInto(into, x, y);
  }
}
