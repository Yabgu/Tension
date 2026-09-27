// The guest's skin matrices, on their way to the HlmsPbs subclass (chunk 19
// round 19b).
//
// This is the other half of the skinning story this SDK already tells. The
// `BoneBatch` in `bones.ts` poses OGRE's own `SkeletonInstance` — local TRS per
// bone, applied by OGRE's update, skinned by OGRE's own shader code. This batch
// carries **model-space matrices** computed outside OGRE entirely (ozz's
// evaluator, 16 floats per joint, column-major) into the subclass buffer the
// adapter's `HlmsTensionSkin` binds, where the vertex shader reads them. The
// two paths coexist: a rig drawn by the subclass ignores the skeleton's pose
// once the shader applies matrices, and a rig drawn by plain PBS still needs
// `submit_bones`.
//
// The table lives in the procedural window of `BUFFER_POOL` — records first,
// matrices after them — so nothing in the fixed layout moves and no region
// grows. Each record names a renderable and where its matrices sit.
//
// What this round's shader does with them is deliberately small: it applies the
// **first matrix's translation** as an offset, which is enough to prove the
// bytes made it end to end. Full skinning — every joint, weighted by the mesh's
// blend data — is the next round, and it changes this module not at all: the
// matrices are already here, and only the piece that reads them changes.

import { SKIN_SIZE, SKIN_CAPACITY, SKIN_TABLE_OFFSET, SKIN_DATA_OFFSET, SKIN_DATA_CAPACITY } from "./wire";
import { REGION_BUFFER_POOL } from "../runtime/wire";
import { regionOffset } from "../runtime/arena";

/** `ogre::submit_skin_matrices(count)`: the table's live length, or a negative
 * errno. */
@external("ogre", "submit_skin_matrices")
declare function submitSkinMatricesRaw(count: i32): i32;

/** Where the table starts: `BUFFER_POOL`'s first byte, plus the window base.
 * Read from the layout at runtime rather than baked. */
export function getSkinTableBase(): usize {
  return regionOffset(REGION_BUFFER_POOL) + SKIN_TABLE_OFFSET;
}

/** Where the matrix bytes start, past the table. */
export function getSkinDataBase(): usize {
  return regionOffset(REGION_BUFFER_POOL) + SKIN_DATA_OFFSET;
}

/**
 * One frame's worth of per-renderable matrices, written into the window and
 * sent in one call.
 *
 * `set` writes the whole entry, like `BoneBatch.set`: the matrices a caller
 * passes for an index are the ones that are sent, and a second call for the
 * same index replaces them rather than adding to them.
 *
 * A `Float32Array` of `joints * 16` floats, column-major, is the shape the ozz
 * evaluator's `localToModel` produces — the array can be handed over unchanged.
 */
export class SkinMatrixBatch {
  private base: usize;
  private data: usize;
  private entries: u32 = 0;
  private used: u32 = 0;

  constructor() {
    this.base = getSkinTableBase();
    this.data = getSkinDataBase();
  }

  /** How many entries `commit` would send. */
  count(): u32 {
    return this.entries;
  }

  /** How many matrix bytes the entries written so far hold. */
  bytes(): u32 {
    return this.used;
  }

  /**
   * Write entry `index`: `renderableId` and its `matrices`. Returns false —
   * writing nothing — for an index past the table or a matrix block past the
   * window, so a caller that overruns learns it here rather than from a
   * refused batch.
   */
  set(index: u32, renderableId: u32, matrices: Float32Array): bool {
    if (index >= SKIN_CAPACITY) return false;
    const bytes: u32 = <u32>matrices.length * 4;
    if (this.used + bytes > SKIN_DATA_CAPACITY) return false;
    const at = this.base + <usize>index * SKIN_SIZE;
    store<u32>(at + 0, renderableId);
    store<u32>(at + 4, this.used); // where the matrices sit, window-relative
    store<u32>(at + 8, bytes);
    store<u32>(at + 12, 1); // flags: bit 0 set = the matrices are model-space
    store<u64>(at + 16, 0);
    store<u64>(at + 24, 0);
    memory.copy(this.data + <usize>this.used, changetype<usize>(matrices.dataStart), bytes);
    this.used += bytes;
    if (index + 1 > this.entries) this.entries = index + 1;
    return true;
  }

  /**
   * Send the table. Returns the number of entries the adapter accepted (equal
   * to `count()`), or a negative errno: `-EINVAL` for a count or a size that
   * does not fit, `-ENOENT` for an entry naming a renderable that is not live.
   * In every refusal the whole batch was dropped and no buffer changed.
   *
   * An empty batch is not sent: `commit` with nothing written returns 0 without
   * a call.
   */
  commit(): i32 {
    if (this.entries == 0) return 0;
    const sent = submitSkinMatricesRaw(<i32>this.entries);
    // The window is scratch that the next frame rewrites from the start: the
    // cursor is reset even on a refusal, because a refused batch has already
    // been read.
    this.entries = 0;
    this.used = 0;
    return sent;
  }
}
