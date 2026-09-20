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

import { PROCEDURAL_BASE, PROCEDURAL_CAPACITY, TOPO_TRIANGLE_LIST, VF_POSITION } from "./wire";
import { REGION_BUFFER_POOL } from "../runtime/wire";
import { regionOffset } from "../runtime/arena";

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
   * A triangle list from two arrays the caller already has: the vertex data
   * (interleaved the way `format` says it is) and the 16-bit indices.
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
   * One triangle from nine numbers: a three-vertex, three-index mesh, positions
   * only. The smallest thing `create_mesh` can be asked for, and the one the
   * `hello-triangle` example is built on.
   *
   * No normal and no uv: the probe measured that the renderer needs neither for
   * a constant-colour Unlit draw, and a normal of `(0,0,0)` would be a lie in a
   * mesh that a lit material could later pick up.
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
}
