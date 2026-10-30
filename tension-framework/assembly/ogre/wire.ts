// The OGRE capability's wire, as the guest sees it.
//
// Same rules as the session runtime's `wire.ts`: every type is `@unmanaged`
// with its fields in declared order, so a `changetype<T>(offset)` is a view and
// the field order is the wire order. The transform records nest the plain-struct
// twins (`Vec3fValue`, `QuatfValue`) — a *plain* struct is stored inline, so the
// nesting is bytes in the record rather than a reference — and everything else
// stays scalar, so a matrix, if one is ever wanted, is sixteen floats.
//
// Padding is spelled out only where something depends on it: an alignment need,
// or a host reader's fixed offset. See the rule below for which records carry
// pads and why.
//
// **These field layouts are defined here, for the first time.** The design note
// (§5.1) defers the capability catalogue's *field sets* until the OGRE version
// pin and extends the manifest then; chunk 1's manifest still holds the nine
// protocol types, so nothing here moves `layoutHash`. What is fixed is the
// sizes, and they are asserted on the *C++* side (`tension-ogre/src/scene.h`,
// 116 `static_assert`s against `#pragma pack(1)`) and documented above each
// declaration here. The guest's own per-record offset table was deleted on
// 2026-10-30 — it restated the same literals in a second language without a
// second source of truth. What the guest still asserts at startup is the two
// moving tables and the contract constants (`assertOgreWireOffsets`).
//
// Alignment is a *placement* rule, not something offsetof can check. Every leaf
// in these records is an `f32` (align 4), so nothing here is forced to a 16-byte
// boundary by the compiler: the transform offsets are simply where the
// declarations put them, and no record carries a pad.

import { REGION_RESOURCE } from "../runtime/wire";
import { regionOffset } from "../runtime/arena";

// --- the value types -------------------------------------------------------

// The two shapes the transform records nest. As plain structs, a field whose type
// is one of these is **inline** — 12 or 16 bytes of the record's body rather than
// a 4-byte reference (0.11.0's struct flip). That is what lets `position:
// Vec3fValue` be the position, which is the whole point of §3 of the engine
// adoption plan.
//
// These are the only math types left. `Vec2f`, `Vec3f`, `Vec3f16`, `Vec4f`,
// `Quatf`, `Colourf` and `Mat4f` were declared here and used by nothing: no field
// nested them, no guest imported them, and the only `offsetof` that named them
// compared them against themselves. They went on 2026-10-30 — see the wire
// workaround inventory in `tension-ogre/DESIGN.md`. If a raw-bytes view of a
// transform record is ever wanted (`changetype<...>(ptr)`), that is when a second
// `@unmanaged` declaration earns its place, alongside a check that the two agree.
//
// `Vec3fValue` is a pure Vec3 — 12 bytes, no fourth coordinate, and no pad:
// nothing in these records needs a 16-byte boundary. `QuatfValue` is 16 bytes
// because a quaternion has four components, not because 16 is a slot size.
//
// **Never nested inside each other.** A plain struct inside a plain struct is
// refused by name (SROA flattening is deferred), so these are leaves. Every
// record that carries one is `@unmanaged`, which is the supported shape.
//
// What keeps them honest is the record-level check: `ogreMotionOffsetsProblem`
// and `ogreBoneOffsetsProblem` assert where each twin lands in the two records
// the guest writes every frame.

// --- the record declarations ------------------------------------------------
//
// **The 11 records below are generated.** `schema/ogre.json` is the single
// source; `tools/codegen/generate.mjs` emits them here and, from the same
// field lists, the adapter's C++ header. A guest field that moves and a host
// field that does not is therefore a compile error on the host side (the
// generated `static_assert`s) rather than a silent misread at run time.
//
// `codegen --check` in `test.sh` fails when the committed files and the schema
// disagree, so the schema cannot drift from what is compiled.
//
// What the generator emits: `@unmanaged struct` for the wire records (a
// pointer view over arena bytes) and a plain `struct` for the two value twins
// (`Vec3fValue`, `QuatfValue`), which are stored inline inside those records.
// The static constructors live on the types and are emitted with them.
//
// The padding rule that used to be argued at length here is now enforced by
// construction: the generator computes every offset from field widths, and the
// host asserts each one.
import {
  Vec3fValue,
  QuatfValue,
  SceneNode,
  LightRecord,
  CameraRecord,
  Material,
  Resource,
  Renderable,
  MotionUpdate,
  BoneUpdate,
  Job,
} from "./generated/ogre.generated";

// Re-exported so every existing `import { SceneNode } from "../ogre/wire"`
// keeps working; the names are the same, the declarations moved.
export {
  Vec3fValue,
  QuatfValue,
  SceneNode,
  LightRecord,
  CameraRecord,
  Material,
  Resource,
  Renderable,
  MotionUpdate,
  BoneUpdate,
  Job,
};

// --- constants -------------------------------------------------------------

export const JOB_PENDING: u32 = 0;
export const JOB_LOADING: u32 = 1;
export const JOB_DONE: u32 = 2;
export const JOB_FAILED: u32 = 3;
export const JOB_CANCELLED: u32 = 4;
/** Not one of the five states: a slot `releaseJob` freed. A stale id reports
 * this rather than the next job's state, because ids are never reused. */
export const JOB_RELEASED: u32 = 5;

export const RES_MESH: u32 = 0;
export const RES_TEXTURE: u32 = 1;
export const RES_SHADER: u32 = 2;
export const RES_FONT: u32 = 3;

/** A mesh resource that carries a skeleton, in the `Resource` record's `flags`
 * (DESIGN.md §5.1). The resource's `size` carries the *bone count* for these,
 * where other resources carry bytes. */
export const RES_RIGGED: u32 = 1;

export const RES_STATE_REQUESTED: u32 = 0;
export const RES_STATE_LOADING: u32 = 1;
export const RES_STATE_READY: u32 = 2;
export const RES_STATE_FAILED: u32 = 3;
export const RES_STATE_UNLOADED: u32 = 4;

export const MAT_HLMS_PBS: u32 = 0;
export const MAT_HLMS_UNLIT: u32 = 1;
export const MAT_HLMS_CUSTOM: u32 = 2;

export const SHADER_VERTEX: u32 = 0;
export const SHADER_FRAGMENT: u32 = 1;
export const SHADER_COMPUTE: u32 = 2;

export const SHADER_SOURCE_GLSL: u32 = 0;
export const SHADER_SOURCE_SPIRV: u32 = 1;

export const LIGHT_DIRECTIONAL: u32 = 0;
export const LIGHT_POINT: u32 = 1;
export const LIGHT_SPOT: u32 = 2;

export const BUFFER_VERTEX: u32 = 0;
export const BUFFER_INDEX: u32 = 1;
export const BUFFER_INSTANCE: u32 = 2;
export const BUFFER_STORAGE: u32 = 3;
export const BUFFER_UNIFORM: u32 = 4;
export const BUFFER_SKIN: u32 = 5;

export const BUFFER_USAGE_STATIC: u32 = 0;
export const BUFFER_USAGE_DYNAMIC: u32 = 1;
export const BUFFER_USAGE_STREAM: u32 = 2;

/** One `Resource`, 48 bytes: what the session reports into `RESOURCE`. The
 * renderer's own record is the region's first entry, and its `seq` is the
 * frame counter `frameCount()` reads. */
export const RESOURCE_SIZE: u32 = 48;

// --- reading a resource record ---------------------------------------------
//
// These live next to the offsets they read rather than in `index.ts` with the
// verbs, because `mesh.ts` needs the state read and cannot import `index.ts`
// (which re-exports `mesh.ts`) without a cycle. `index.ts` re-exports this
// file, so `ogre.frameCount()` and `ogre.resourceState(id)` are the same calls
// either way — and the record's field offsets have one spelling.

/** The `RESOURCE` region's first byte. */
export function getResourceBase(): usize {
  return regionOffset(REGION_RESOURCE);
}

/** The renderer's frame counter: the first `Resource` record's `seq`, which the
 * adapter writes every publish — no verb, no event, just the region. */
export function frameCount(): u64 {
  return load<u64>(getResourceBase() + RESOURCE_SEQ_OFFSET);
}

/** Any resource's `state`: `RES_STATE_REQUESTED`, `_LOADING`, `_READY`,
 * `_FAILED`, `_UNLOADED` — or 0 for an id that is not in the region.
 *
 * The read a guest that **builds** a mesh needs: `MeshBuilder` hands back an id
 * before the mesh exists (the render thread makes it on its next pass), and a
 * renderable submitted against a resource that is not `READY` yet is refused
 * and skipped. `MeshBuilder.build` waits on this; a guest that took the
 * non-blocking form waits on it itself.
 */
export function resourceState(resourceId: u32): u32 {
  if (resourceId == 0) return 0;
  const record = getResourceBase() + <usize>(resourceId - 1) * RESOURCE_SIZE;
  return load<u32>(record + RESOURCE_STATE_OFFSET);
}

/**
 * Whether a mesh resource carries a skeleton.
 *
 * The loader records what it saw when it realised the mesh — the v1 -> v2
 * conversion is what knows whether a rig survived, and nothing on the guest
 * side can look inside the file. A rigged mesh also puts its **bone count** in
 * the record's `size`, where other resources put bytes.
 */
export function isRigged(resourceId: u32): bool {
  return (resourceFlags(resourceId) & RES_RIGGED) != 0;
}

/** How many bones a rigged mesh has, or 0 for anything that is not one. */
export function boneCount(resourceId: u32): u32 {
  if (resourceId == 0) return 0;
  const record = getResourceBase() + <usize>(resourceId - 1) * RESOURCE_SIZE;
  if ((load<u32>(record + RESOURCE_FLAGS_OFFSET) & RES_RIGGED) == 0) return 0;
  return load<u32>(record + RESOURCE_SIZE_OFFSET);
}

function resourceFlags(resourceId: u32): u32 {
  if (resourceId == 0) return 0;
  const record = getResourceBase() + <usize>(resourceId - 1) * RESOURCE_SIZE;
  return load<u32>(record + RESOURCE_FLAGS_OFFSET);
}

/** A `Resource` record's `seq`, in bytes from the record's start. */
export const RESOURCE_SEQ_OFFSET: u32 = 40;

/** A `Resource` record's `state` — `RES_STATE_*`, the field that says whether
 * a resource can be used yet — in bytes from the record's start. */
export const RESOURCE_STATE_OFFSET: u32 = 8;

/** Its `flags` (bit 0 is `RES_RIGGED`) and its `size` (a rigged mesh's bone
 * count), in bytes from the record's start. */
export const RESOURCE_FLAGS_OFFSET: u32 = 12;
export const RESOURCE_SIZE_OFFSET: u32 = 16;

/** One `Job`, in bytes — the stride of the `JOB` region's table. */
export const JOB_SIZE: u32 = 64;

// --- the submission sub-tables ---------------------------------------------
//
// SCENE holds three tables end to end (DESIGN.md §5.1): 1024 `SceneNode`s,
// then 512 `CameraRecord`s, then 1024 `LightRecord`s. MATERIAL and RENDERABLE
// hold one table each. The split is the capability catalogue's business rather
// than the protocol's, so it does not move `layoutHash` — which is exactly why
// `assertSubmissionRegions` exists: the arithmetic below is the only thing
// keeping the guest's idea of a slot and the adapter's in step.

export const SCENE_NODE_COUNT: u32 = 1024;
export const SCENE_CAMERA_COUNT: u32 = 512;
export const SCENE_LIGHT_COUNT: u32 = 1024;

// The strides are **derived**, not hand-kept. They were constants once, and a
// record whose declaration changed without its constant changing wrote past its
// own slot -- measured 2026-10-30, when `Renderable` went 64 -> 56 and the
// untouched `RENDERABLE_SIZE = 64` copied 8 bytes too many. `sizeof` at module
// scope closes that gap by construction.
export const SCENE_NODE_SIZE: u32 = sizeof<SceneNode>();
export const SCENE_CAMERA_SIZE: u32 = sizeof<CameraRecord>();
export const SCENE_LIGHT_SIZE: u32 = sizeof<LightRecord>();

/** Where the cameras' table starts, in bytes from the region's first node. */
export const SCENE_CAMERA_BASE: u32 = SCENE_NODE_COUNT * SCENE_NODE_SIZE;
/** And the lights' table, after the cameras'. */
export const SCENE_LIGHT_BASE: u32 = SCENE_CAMERA_BASE + SCENE_CAMERA_COUNT * SCENE_CAMERA_SIZE;
/** The bytes SCENE needs for all three tables to fit. */
export const SCENE_TABLE_BYTES: u32 = SCENE_LIGHT_BASE + SCENE_LIGHT_COUNT * SCENE_LIGHT_SIZE;

export const MATERIAL_COUNT: u32 = 256;
export const RENDERABLE_COUNT: u32 = 2048;
export const MATERIAL_SIZE: u32 = sizeof<Material>();
export const RENDERABLE_SIZE: u32 = sizeof<Renderable>();

// --- the motion table (chunk 4) ---------------------------------------------
//
// One `MotionUpdate` per moving body, written by the guest at the start of
// `BUFFER_POOL` and named in full to `ogre::submit_motion(count)`. The
// capacity is the smaller of what the renderable table can hold and what the
// region has room for: min(2048, 4 MiB / 64).

/** One `MotionUpdate`, in bytes — the table's stride in `BUFFER_POOL`. */
export const MOTION_SIZE: u32 = 48;

/** How many entries the table can hold. */
export const MOTION_CAPACITY: u32 = 2048;

// --- the bone table (chunk 5b) ----------------------------------------------
//
// A second table of the same stride, past the motion table's 128 KiB:
// `BONE_TABLE_OFFSET` + `BONE_SIZE * BONE_CAPACITY` must fit inside the region
// alongside the motion table, and the arithmetic below is what says so.

/** One `BoneUpdate`, in bytes — the table's stride in `BUFFER_POOL`. */
export const BONE_SIZE: u32 = 48;

/** How many entries the bone table can hold. */
export const BONE_CAPACITY: u32 = 2048;

/** Where the bone table starts, in bytes from `BUFFER_POOL`'s first byte. */
export const BONE_TABLE_OFFSET: u32 = MOTION_SIZE * MOTION_CAPACITY;

// --- the procedural-mesh window (chunk 5.5) ---------------------------------
//
// `ogre::create_mesh` reads vertex and index bytes the guest wrote into
// `BUFFER_POOL` past the bone table. Both arrays live in this window — one
// after the other, in whatever order the guest chooses, as long as each lies
// inside it and they do not overlap — and the window's *size* is what limits a
// mesh built this way: 512 KiB is ~43,000 vertices at 12 bytes each, so a
// 16-bit index reaches every vertex such a mesh can hold. That is why the verb
// takes no index width.

/** Where the procedural-mesh window starts, in bytes from `BUFFER_POOL`'s
 * first byte — past the motion table and the bone table. */
export const PROCEDURAL_BASE: u32 = BONE_TABLE_OFFSET + BONE_SIZE * BONE_CAPACITY;

/** How many bytes of `BUFFER_POOL` the window holds, shared by the vertex and
 * index arrays a single `create_mesh` call names. */
export const PROCEDURAL_CAPACITY: u32 = 512 * 1024;

// --- guest skin matrices (chunk 19 round 19b) -------------------------------
//
// The matrices a guest computed for a rig — ozz's evaluator produces them, 16
// floats per joint, column-major — do not go through the `SkeletonInstance` at
// all: they go to the `HlmsPbs` subclass this adapter registers for rigged
// meshes, which carries its own buffer and its own vertex-shader piece.
//
// The batch reuses the procedural window rather than adding a table to the
// fixed layout, so no region grows and the layout hash does not move. A verb
// reads the window synchronously, in the call that names it, so a guest that
// submits skin matrices and builds a procedural mesh in one frame must write
// each one immediately before its own call.

/** One record of the skin-matrix table, in bytes. */
export const SKIN_SIZE: u32 = 32;

/** How many renderables one batch can name. */
export const SKIN_CAPACITY: u32 = 64;

/** Where the table starts: the first byte of the procedural window. */
export const SKIN_TABLE_OFFSET: u32 = PROCEDURAL_BASE;

/** Where the matrices themselves start, past the table. */
export const SKIN_DATA_OFFSET: u32 = SKIN_TABLE_OFFSET + SKIN_SIZE * SKIN_CAPACITY;

/** How many bytes of matrices the window holds: 256 KiB, 4096 joints at 64
 * bytes each — far past the per-renderable ceiling the adapter accepts. */
export const SKIN_DATA_CAPACITY: u32 = 256 * 1024;

// --- vertex formats and topology (chunk 5.5) --------------------------------
//
// `format` is a flags word rather than an enum: a vertex is position, then
// optionally a normal, then optionally a uv, interleaved in that order, and the
// adapter declares exactly the elements the bits name. Position is the only
// element the renderer requires — a constant-colour Unlit draw renders the same
// pixels with position alone as with all three (probe: 10,368 px either way).
// A textured datablock is where `VF_UV` starts to matter; normals are carried
// because a lit path needs them, not because this one does.

/** `F32x3` position bytes. Required — a format without it is refused. */
export const VF_POSITION: u32 = 1 << 0;
/** `F32x3` normal bytes, after the position. */
export const VF_NORMAL: u32 = 1 << 1;
/** `F32x2` uv bytes, after the position (and the normal). */
export const VF_UV: u32 = 1 << 2;

/** `create_mesh`'s `topology`: a triangle list, the only one the adapter
 * declares. Anything else is refused with `-EINVAL`. */
export const TOPO_TRIANGLE_LIST: u32 = 0;

// --- the offset check ------------------------------------------------------

/**
 * The motion record's offsets, on their own.
 *
 * Separate from the wire contract check so a guest that uses `MotionBatch`
 * can assert exactly what it depends on, by name, rather than relying on a
 * larger check happening to include it. The layout is the point: the id pair,
 * then the transform at the offsets `Renderable`'s inline one already uses.
 */
function ogreMotionOffsetsProblem(): string | null {
  // No pads: the transform starts right after the id pair, at 8. The offsets are
  // the adapter's contract (`decode_motion_at`), and `sizeof` catches a field
  // appended after `scale` -- the form that an `offsetof(last) + width` check
  // cannot see.
  if (offsetof<MotionUpdate>("position") + offsetof<Vec3fValue>("x") != 8) {
    return "MotionUpdate.position";
  }
  if (offsetof<MotionUpdate>("rotation") + offsetof<QuatfValue>("x") != 20) {
    return "MotionUpdate.rotation";
  }
  if (offsetof<MotionUpdate>("scale") + offsetof<Vec3fValue>("x") != 36) {
    return "MotionUpdate.scale";
  }
  if (offsetof<MotionUpdate>("scale") + sizeof<Vec3fValue>() != sizeof<MotionUpdate>()) {
    return "MotionUpdate tail";
  }
  if (sizeof<MotionUpdate>() != 48) return "MotionUpdate size";
  return null;
}

/**
 * Assert this build's `MotionUpdate` matches what the adapter reads: the record
 * is a pointer view the guest writes and the adapter decodes at literal offsets,
 * so a moved field is a silent misread rather than an error. Named field first,
 * because that is what the reader needs.
 */
export function assertOgreMotionOffsets(): void {
  const problem = ogreMotionOffsetsProblem();
  if (problem != null) {
    assert(false, "the motion record's offsets do not match the catalogue: " + problem);
  }
}

/**
 * The bone record's offsets, on their own.
 *
 * The motion record's layout with `boneIndex` where `flags` was, checked
 * separately for the same reason: a guest that poses a rig depends on these
 * fields by name, and the record's size is the table's stride.
 */
function ogreBoneOffsetsProblem(): string | null {
  if (offsetof<BoneUpdate>("position") + offsetof<Vec3fValue>("x") != 8) {
    return "BoneUpdate.position";
  }
  if (offsetof<BoneUpdate>("rotation") + offsetof<QuatfValue>("x") != 20) {
    return "BoneUpdate.rotation";
  }
  if (offsetof<BoneUpdate>("scale") + offsetof<Vec3fValue>("x") != 36) {
    return "BoneUpdate.scale";
  }
  if (offsetof<BoneUpdate>("scale") + sizeof<Vec3fValue>() != sizeof<BoneUpdate>()) {
    return "BoneUpdate tail";
  }
  if (sizeof<BoneUpdate>() != 48) return "BoneUpdate size";
  return null;
}

/** Whether this build's `BoneUpdate` matches the catalogue. */
/** Assert this build's `BoneUpdate` matches the catalogue, naming the field. */
export function assertOgreBoneOffsets(): void {
  const problem = ogreBoneOffsetsProblem();
  if (problem != null) {
    assert(false, "the bone record's offsets do not match the catalogue: " + problem);
  }
}

function ogreWireContractProblem(): string | null {
  // The constants the adapter and this file both derive, and the two moving
  // tables. What is *not* here any more: the per-field `offsetof`/`sizeof`
  // table over the eight records. Those numbers are asserted on the C++ side
  // (`tension-ogre/src/scene.h`, 116 `static_assert`s against `#pragma pack(1)`)
  // and documented above each declaration here, so the guest copy restated the
  // same literals in a second language without a second source of truth.
  // Deleted 2026-10-30; see `tension-ogre/DESIGN.md`, "Wire workaround
  // inventory". The replacement is the OGRE layout hash scoped in
  // `docs/engine-adoption-plan.md`.

  // The two moving tables. Checked here as well as by their own assertions so a
  // build that forgets to call them still catches a moved field: most fixtures
  // call only this entry point.
  const motion = ogreMotionOffsetsProblem();
  if (motion != null) return motion;
  const bone = ogreBoneOffsetsProblem();
  if (bone != null) return bone;

  // The procedural window's start is derived here and written as a literal in
  // the adapter (DESIGN.md §5.1 pins it at 192 KiB); a derivation that drifts
  // from that number would put the guest's bytes where the adapter does not
  // look, so the two are tied together by this.
  // Derived from the two table strides: 48*2048 + 48*2048. The adapter derives
  // the same number from the same constants (scene.h), so the two move together.
  if (PROCEDURAL_BASE != 192 * 1024) return "PROCEDURAL_BASE";
  if (PROCEDURAL_CAPACITY == 0) return "PROCEDURAL_CAPACITY";
  // The format bits are a contract with the adapter's element table: the three
  // the adapter declares, in the order it declares them.
  if (VF_POSITION != 1 || VF_NORMAL != 2 || VF_UV != 4) return "VF_ bits";
  if (TOPO_TRIANGLE_LIST != 0) return "TOPO_TRIANGLE_LIST";

  return null;
}

/**
 * Assert this build's OGRE *contract constants* -- the procedural window's start
 * and the vertex-format bits -- and, through them, the two moving tables.
 *
 * The per-record offset table this used to carry is gone (2026-10-30): those
 * numbers live in `tension-ogre/src/scene.h`'s `static_assert`s and in the doc
 * comment above each declaration here. What remains is what no other side
 * asserts.
 */
export function assertOgreWireOffsets(): void {
  const problem = ogreWireContractProblem();
  if (problem != null) {
    assert(false, "the OGRE wire contract does not match the catalogue: " + problem);
  }
}
