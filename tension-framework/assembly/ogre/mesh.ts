// A mesh built out of the guest's own memory: `ogre::create_mesh` (chunk 5.5).
//
// Everything else in this SDK names a resource the loader made out of a file.
// This is the other door: the guest writes a vertex buffer and an index buffer
// into `BUFFER_POOL`, names them, and gets back a resource id that works
// wherever a loaded mesh's id works — `submitRenderable`, `isRigged`, the
// resource record, `boneCount`.
//
// The window is `PROCEDURAL_BASE`..`PROCEDURAL_CAPACITY`, past the motion and
// bone tables, and both arrays live in it. The caller decides where, as long as
// they do not overlap; `MeshBuilder` writes the vertices first and the indices
// directly after them, which is the arrangement the examples use.
//
// What the adapter requires, and what it refuses, is worth knowing before using
// this (DESIGN.md §5.1):
//
//   * **position is the only required element.** A constant-colour Unlit draw
//     renders identically with position alone and with position+normal+uv — the
//     probe measured the same 10,368 pixels either way — so a vertex carries
//     the elements `format` names and no more. A lit material wants
//     `VF_NORMAL`; a textured one wants `VF_UV`.
//   * **indices are 16-bit**, and the window's 512 KiB is why that is enough
//     rather than a limit to work around: ~43,000 vertices fit, so no index
//     can need 32 bits.
//   * **every index is checked against the vertex count**, and the whole call
//     is refused (`-EINVAL`, with the index and the count logged) rather than
//     handed to the GPU. A guest that gets that refusal has a bug worth fixing,
//     not a mesh worth drawing.

import {
  PROCEDURAL_BASE,
  PROCEDURAL_CAPACITY,
  RES_STATE_FAILED,
  RES_STATE_READY,
  TOPO_TRIANGLE_LIST,
  VF_POSITION,
  resourceState,
} from "./wire";
import { REGION_BUFFER_POOL } from "../runtime/wire";
import { regionOffset } from "../runtime/arena";
import { RuntimeSession } from "../runtime";

/**
 * How many frames `build` and `triangleBlocking` wait for the render thread
 * before giving up: sixty, which is one second at 60 Hz.
 *
 * A guest cannot truly yield, so this is a spin with the session's own frame
 * wait inside it — and that wait is not decoration: the resource record is
 * written by an epoch, and epochs run when the guest pumps the session, so a
 * loop without a wait inside it would poll a record nobody ever updates.
 */
const BUILD_ATTEMPTS: u32 = 60;
/** The delay between those attempts: one frame at the default rate. */
const BUILD_YIELD_MS: i32 = 16;

/**
 * `ogre::create_mesh(vbOffset, vbBytes, format, ibOffset, ibBytes, topology)`:
 * the new resource id (> 0) or a negative errno.
 *
 * The offsets are **arena** offsets — the addresses the guest wrote at, which
 * is what `regionOffset(REGION_BUFFER_POOL) + PROCEDURAL_BASE + n` produces.
 * The id comes back before the mesh exists: only the render thread may make an
 * OGRE object, so it is built on that thread's next pass, and a guest that
 * submits a renderable with the id in the same frame is drawn from that frame.
 */
@external("ogre", "create_mesh")
declare function createMeshRaw(vbOffset: u32, vbBytes: u32, format: u32, ibOffset: u32,
                               ibBytes: u32, topology: u32): i32;

/** Where the procedural window starts: `BUFFER_POOL`'s first byte plus the
 * motion table and the bone table. Read from the layout at runtime. */
export function getProceduralBase(): usize {
  return regionOffset(REGION_BUFFER_POOL) + PROCEDURAL_BASE;
}

export class MeshBuilder {
  /**
   * The **non-blocking** form: copy the two arrays the caller already has and
   * return the resource id at once. The mesh does not exist yet — the render
   * thread builds it on its next pass — so a renderable that names the id in
   * the same frame is refused and skipped. Reach for this when the guest has
   * something else to do before it draws (and pair it with `resourceState`),
   * and for `build` when it does not.
   *
   * Returns the resource id, or a negative errno — `-EINVAL` for an empty
   * array and `-ENOSPC` for a mesh that does not fit the window, both of which
   * are cheaper to hear about here than after writing past the end of a region.
   */
  static fromBuffers(vertices: Float32Array, indices: Uint16Array, format: i32): i32 {
    const vertexBytes = vertices.length * 4;
    const indexBytes = indices.length * 2;
    if (vertexBytes == 0 || indexBytes == 0) return -22; // -EINVAL: nothing to build
    if (vertexBytes + indexBytes > <i32>PROCEDURAL_CAPACITY) return -28; // -ENOSPC: the window is full

    const verticesAt = getProceduralBase();
    const indicesAt = verticesAt + vertexBytes;
    // `dataStart`, not `changetype<usize>`: an *ArrayBuffer*'s pointer is its
    // data (what `writeBytes` relies on), while a TypedArray's is its object —
    // copying from there writes the array's header into the window.
    memory.copy(verticesAt, vertices.dataStart, <usize>vertexBytes);
    memory.copy(indicesAt, indices.dataStart, <usize>indexBytes);
    return createMeshRaw(<u32>verticesAt, <u32>vertexBytes, <u32>format, <u32>indicesAt,
                         <u32>indexBytes, TOPO_TRIANGLE_LIST);
  }

  /**
   * The **blocking** form: same door, then wait for the mesh to exist. Returns
   * the resource id once the record says `READY`, `-1` when the wait ran out or
   * the build failed, or a negative errno from the call itself.
   *
   * "Blocking" is bounded and honest about it: sixty attempts, one frame apart,
   * so a second at 60 Hz — a guest cannot truly yield, and a longer wait would
   * be a hang rather than a patience. What it buys is the thing every guest
   * does next: a renderable that names this id is drawn from the first frame,
   * with no poll of its own.
   *
   * The bytes are `ArrayBuffer`s — the shape a guest has when it built the
   * vertex data itself (`MeshBuilder.triangleBlocking` makes them for you).
   */
  static build(vertexBytes: ArrayBuffer, indexBytes: ArrayBuffer, format: i32): i32 {
    return MeshBuilder.settle(MeshBuilder.submit(vertexBytes, indexBytes, format));
  }

  /**
   * One triangle from nine numbers: a three-vertex, three-index mesh, positions
   * only, ready to draw when this returns.
   *
   * No normal and no uv: the probe measured that the renderer needs neither for
   * a constant-colour Unlit draw, and a normal of `(0,0,0)` would be a lie in a
   * mesh that a lit material could later pick up.
   *
   * This is the shape to reach for in an example or a first game; `triangle`
   * and `fromBuffers` are the same mesh without the wait.
   */
  static triangleBlocking(ax: f32, ay: f32, az: f32, bx: f32, by: f32, bz: f32, cx: f32, cy: f32,
                          cz: f32): i32 {
    return MeshBuilder.settle(
      MeshBuilder.triangle(ax, ay, az, bx, by, bz, cx, cy, cz));
  }

  /**
   * One triangle from nine numbers: a three-vertex, three-index mesh, positions
   * only, with the id returned before the mesh exists (`build` is the form that
   * waits). The smallest thing `create_mesh` can be asked for.
   */
  static triangle(ax: f32, ay: f32, az: f32, bx: f32, by: f32, bz: f32, cx: f32, cy: f32,
                  cz: f32): i32 {
    const vertices = new Float32Array(9);
    vertices[0] = ax;
    vertices[1] = ay;
    vertices[2] = az;
    vertices[3] = bx;
    vertices[4] = by;
    vertices[5] = bz;
    vertices[6] = cx;
    vertices[7] = cy;
    vertices[8] = cz;
    const indices = new Uint16Array(3);
    indices[0] = 0;
    indices[1] = 1;
    indices[2] = 2;
    return MeshBuilder.fromBuffers(vertices, indices, VF_POSITION);
  }

  /// The copy the `ArrayBuffer` form needs, kept apart from the wait so the two
  /// public entry points each say what they are: `build` waits, `submit` does
  /// not, and neither does anything the other does not.
  private static submit(vertexBytes: ArrayBuffer, indexBytes: ArrayBuffer, format: i32): i32 {
    const vertexLength = <i32>vertexBytes.byteLength;
    const indexLength = <i32>indexBytes.byteLength;
    if (vertexLength == 0 || indexLength == 0) return -22; // -EINVAL: nothing to build
    if (vertexLength + indexLength > <i32>PROCEDURAL_CAPACITY) return -28; // -ENOSPC: full

    const verticesAt = getProceduralBase();
    const indicesAt = verticesAt + vertexLength;
    memory.copy(verticesAt, changetype<usize>(vertexBytes), <usize>vertexLength);
    memory.copy(indicesAt, changetype<usize>(indexBytes), <usize>indexLength);
    return createMeshRaw(<u32>verticesAt, <u32>vertexLength, <u32>format, <u32>indicesAt,
                         <u32>indexLength, TOPO_TRIANGLE_LIST);
  }

  /// Wait for a freshly created mesh to exist: `READY` returns the id, `FAILED`
  /// and the timeout return `-1`, and anything else (including the `LOADING`
  /// the adapter publishes first) is a reason to keep waiting.
  private static settle(id: i32): i32 {
    if (id <= 0) return id;
    for (let attempt: u32 = 0; attempt < BUILD_ATTEMPTS; attempt++) {
      const state = resourceState(<u32>id);
      if (state == RES_STATE_READY) return id;
      if (state == RES_STATE_FAILED) return -1;
      RuntimeSession.wait(BUILD_YIELD_MS);
    }
    return -1;
  }
}
