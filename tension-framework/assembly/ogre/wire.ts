// The OGRE capability's wire, as the guest sees it.
//
// Same rules as the session runtime's `wire.ts`: every type is `@unmanaged`
// with scalar fields in declared order and its padding spelled out, so a
// `changetype<T>(offset)` is a view and the field order is the wire order. No
// nested types — an `@unmanaged` class holding another class holds a *reference*
// to it, which is the one thing a wire record must not do — so a `Transformf`
// is twelve floats and a `Mat4f` is sixteen.
//
// **These field layouts are defined here, for the first time.** The design note
// (§5.1) defers the capability catalogue's *field sets* until the OGRE version
// pin and extends the manifest then; chunk 1's manifest still holds the nine
// protocol types, so nothing here moves `layoutHash`. What is fixed is the
// sizes, and `checkOgreWireOffsets` proves them the same way the runtime's
// check proves its own: `offsetof<T>("lastField")` plus that field's width plus
// the trailing reserved words, never `sizeof<T>()`.
//
// Alignment is a *placement* rule, not something offsetof can check: AS aligns
// an `@unmanaged` record to its widest scalar field, so a `Vec4f` or a `Mat4f`
// must sit at a 16-byte offset in whatever record contains it. The container
// layouts below do that, and the sizes are what the check pins.

// --- math ------------------------------------------------------------------

/** Two floats, 8 bytes. */
@unmanaged
export class Vec2f {
  x: f32 = 0;
  y: f32 = 0;
}

/** Three floats, 12 bytes. */
@unmanaged
export class Vec3f {
  x: f32 = 0;
  y: f32 = 0;
  z: f32 = 0;
}

/** A `Vec3f` padded to 16 bytes: the alignment a `Vec4f` has, without a w. */
@unmanaged
export class Vec3f16 {
  x: f32 = 0;
  y: f32 = 0;
  z: f32 = 0;
  pad: f32 = 0;
}

/** Four floats, 16 bytes, align 16. */
@unmanaged
export class Vec4f {
  x: f32 = 0;
  y: f32 = 0;
  z: f32 = 0;
  w: f32 = 0;
}

/** A quaternion, xyzw, 16 bytes, align 16. */
@unmanaged
export class Quatf {
  x: f32 = 0;
  y: f32 = 0;
  z: f32 = 0;
  w: f32 = 0;
}

/** Linear RGBA, 16 bytes, align 16. */
@unmanaged
export class Colourf {
  r: f32 = 0;
  g: f32 = 0;
  b: f32 = 0;
  a: f32 = 0;
}

/** A 4x4 matrix, column-major, 64 bytes, align 16. */
@unmanaged
export class Mat4f {
  m00: f32 = 0; m01: f32 = 0; m02: f32 = 0; m03: f32 = 0;
  m10: f32 = 0; m11: f32 = 0; m12: f32 = 0; m13: f32 = 0;
  m20: f32 = 0; m21: f32 = 0; m22: f32 = 0; m23: f32 = 0;
  m30: f32 = 0; m31: f32 = 0; m32: f32 = 0; m33: f32 = 0;
}

/** Position, rotation, uniform scale — 48 bytes, align 16. */
@unmanaged
export class Transformf {
  positionX: f32 = 0;
  positionY: f32 = 0;
  positionZ: f32 = 0;
  pad0: f32 = 0;
  rotationX: f32 = 0;
  rotationY: f32 = 0;
  rotationZ: f32 = 0;
  rotationW: f32 = 1;
  scaleX: f32 = 1;
  scaleY: f32 = 1;
  scaleZ: f32 = 1;
  pad1: f32 = 0;
}

/** An axis-aligned box, 32 bytes, align 16. */
@unmanaged
export class Aabbf {
  minX: f32 = 0;
  minY: f32 = 0;
  minZ: f32 = 0;
  pad0: f32 = 0;
  maxX: f32 = 0;
  maxY: f32 = 0;
  maxZ: f32 = 0;
  pad1: f32 = 0;
}

// --- refs ------------------------------------------------------------------

/** A UTF-8 string in the `STRING` region, 8 bytes. */
@unmanaged
export class StringRef {
  offset: u32 = 0;
  length: u32 = 0;
}

/** Bytes in the `BUFFER_POOL` region, 8 bytes. */
@unmanaged
export class BufferRef {
  offset: u32 = 0;
  length: u32 = 0;
}

// --- records ---------------------------------------------------------------

/** A scene node, 80 bytes: `transform` at 24, alignment 16. */
@unmanaged
export class SceneNode {
  nodeId: u32 = 0;
  parentId: u32 = 0;
  flags: u32 = 0;
  childCount: u32 = 0;
  nameOffset: u32 = 0;
  nameLength: u32 = 0;
  // 24: the transform, exactly where the header's six words end.
  transformX: f32 = 0;
  transformY: f32 = 0;
  transformZ: f32 = 0;
  transformPad: f32 = 0;
  rotationX: f32 = 0;
  rotationY: f32 = 0;
  rotationZ: f32 = 0;
  rotationW: f32 = 1;
  scaleX: f32 = 1;
  scaleY: f32 = 1;
  scaleZ: f32 = 1;
  scalePad: f32 = 0;
  reserved: u64 = 0;
}

/** A light, 96 bytes. */
@unmanaged
export class LightRecord {
  lightId: u32 = 0;
  kind: u32 = 0;
  flags: u32 = 0;
  private pad0: u32 = 0;
  colourR: f32 = 1;
  colourG: f32 = 1;
  colourB: f32 = 1;
  colourA: f32 = 1;
  intensity: f32 = 1;
  range: f32 = 0;
  spotInner: f32 = 0;
  spotOuter: f32 = 0;
  directionX: f32 = 0;
  directionY: f32 = -1;
  directionZ: f32 = 0;
  directionPad: f32 = 0;
  positionX: f32 = 0;
  positionY: f32 = 0;
  positionZ: f32 = 0;
  positionPad: f32 = 0;
  nameOffset: u32 = 0;
  nameLength: u32 = 0;
  reserved: u64 = 0;
}

/** A camera, 80 bytes. */
@unmanaged
export class CameraRecord {
  cameraId: u32 = 0;
  flags: u32 = 0;
  fovY: f32 = 1;
  aspect: f32 = 1;
  nearClip: f32 = 0.1;
  farClip: f32 = 1000;
  positionX: f32 = 0;
  positionY: f32 = 0;
  positionZ: f32 = 0;
  positionPad: f32 = 0;
  rotationX: f32 = 0;
  rotationY: f32 = 0;
  rotationZ: f32 = 0;
  rotationW: f32 = 1;
  viewportWidth: u32 = 0;
  viewportHeight: u32 = 0;
  reserved: u64 = 0;
  reserved2: u64 = 0;
}

/** One texture unit of a material, 16 bytes. */
@unmanaged
export class TextureSlot {
  resourceId: u32 = 0;
  sampler: u32 = 0;
  flags: u32 = 0;
  uvSet: u32 = 0;
}

/** A material, 208 bytes: eight texture slots from 80. */
@unmanaged
export class Material {
  materialId: u32 = 0;
  kind: u32 = 0;
  flags: u32 = 0;
  private pad0: u32 = 0;
  diffuseR: f32 = 1;
  diffuseG: f32 = 1;
  diffuseB: f32 = 1;
  diffuseA: f32 = 1;
  specularR: f32 = 1;
  specularG: f32 = 1;
  specularB: f32 = 1;
  specularA: f32 = 1;
  emissiveR: f32 = 0;
  emissiveG: f32 = 0;
  emissiveB: f32 = 0;
  emissiveA: f32 = 0;
  roughness: f32 = 1;
  metalness: f32 = 0;
  opacity: f32 = 1;
  private pad1: f32 = 0;
  // Eight TextureSlots, 16 bytes each, from offset 80.
  slot0Resource: u32 = 0; slot0Sampler: u32 = 0; slot0Flags: u32 = 0; slot0Uv: u32 = 0;
  slot1Resource: u32 = 0; slot1Sampler: u32 = 0; slot1Flags: u32 = 0; slot1Uv: u32 = 0;
  slot2Resource: u32 = 0; slot2Sampler: u32 = 0; slot2Flags: u32 = 0; slot2Uv: u32 = 0;
  slot3Resource: u32 = 0; slot3Sampler: u32 = 0; slot3Flags: u32 = 0; slot3Uv: u32 = 0;
  slot4Resource: u32 = 0; slot4Sampler: u32 = 0; slot4Flags: u32 = 0; slot4Uv: u32 = 0;
  slot5Resource: u32 = 0; slot5Sampler: u32 = 0; slot5Flags: u32 = 0; slot5Uv: u32 = 0;
  slot6Resource: u32 = 0; slot6Sampler: u32 = 0; slot6Flags: u32 = 0; slot6Uv: u32 = 0;
  slot7Resource: u32 = 0; slot7Sampler: u32 = 0; slot7Flags: u32 = 0; slot7Uv: u32 = 0;
}

/** A shader, 40 bytes: source bytes live in the `STRING` region. */
@unmanaged
export class ShaderRecord {
  shaderId: u32 = 0;
  stage: u32 = 0;
  sourceKind: u32 = 0;
  flags: u32 = 0;
  byteOffset: u32 = 0;
  byteLength: u32 = 0;
  entryOffset: u32 = 0;
  entryLength: u32 = 0;
  reserved: u64 = 0;
}

/** A request the guest writes into `RESOURCE_REQ`, 40 bytes. */
@unmanaged
export class ResourceReq {
  kind: u32 = 0;
  state: u32 = 0;
  priority: i32 = 0;
  flags: u32 = 0;
  nameOffset: u32 = 0;
  nameLength: u32 = 0;
  requestedSeq: u64 = 0;
  reserved: u64 = 0;
}

/** A resource the session reports into `RESOURCE`, 48 bytes. */
@unmanaged
export class Resource {
  resourceId: u32 = 0;
  kind: u32 = 0;
  state: u32 = 0;
  flags: u32 = 0;
  size: u32 = 0;
  nameOffset: u32 = 0;
  nameLength: u32 = 0;
  error: i32 = 0;
  refs: u32 = 0;
  private pad0: u32 = 0;
  seq: u64 = 0;
}

/** A GPU buffer the adapter describes, 48 bytes. */
@unmanaged
export class Buffer {
  bufferId: u32 = 0;
  kind: u32 = 0;
  usage: u32 = 0;
  flags: u32 = 0;
  size: u32 = 0;
  stride: u32 = 0;
  dataOffset: u32 = 0;
  private pad0: u32 = 0;
  bytes: u64 = 0;
  reserved: u64 = 0;
}

/** A drawable, 64 bytes: its transform is inline at 16. */
@unmanaged
export class Renderable {
  renderableId: u32 = 0;
  materialId: u32 = 0;
  meshResourceId: u32 = 0;
  flags: u32 = 0;
  positionX: f32 = 0;
  positionY: f32 = 0;
  positionZ: f32 = 0;
  positionPad: f32 = 0;
  rotationX: f32 = 0;
  rotationY: f32 = 0;
  rotationZ: f32 = 0;
  rotationW: f32 = 1;
  scaleX: f32 = 1;
  scaleY: f32 = 1;
  scaleZ: f32 = 1;
  scalePad: f32 = 0;
}

/**
 * One entry of the motion table, 64 bytes (chunk 4): a renderable's whole
 * transform and nothing else. The table lives at the start of `BUFFER_POOL`,
 * the guest writes it, and `ogre::submit_motion(count)` names how much of it is
 * live — one call per frame instead of one per body.
 *
 * **Flat fields, like every other record here.** An AssemblyScript field whose
 * type is a class is a *reference*: `position: Vec3f` would be a 4-byte pointer
 * and this record would not be 64 bytes. The `Transformf` layout is written out
 * instead, at the offsets `Renderable`'s inline transform already uses
 * (16/32/48), so the two read the same way — and `pad0` is what puts them
 * there, because a record holding a `Quatf` aligns that `Quatf` to 16.
 */
@unmanaged
export class MotionUpdate {
  renderableId: u32 = 0;
  flags: u32 = 0;
  pad0: u64 = 0;
  positionX: f32 = 0;
  positionY: f32 = 0;
  positionZ: f32 = 0;
  pad1: f32 = 0;
  rotationX: f32 = 0;
  rotationY: f32 = 0;
  rotationZ: f32 = 0;
  rotationW: f32 = 1;
  scaleX: f32 = 1;
  scaleY: f32 = 1;
  scaleZ: f32 = 1;
  pad2: f32 = 0;
}

/** One job, 64 bytes: what the session reports into `JOB`. */
@unmanaged
export class Job {
  jobId: u32 = 0;
  state: u32 = 0;
  kind: u32 = 0;
  flags: u32 = 0;
  priority: i32 = 0;
  resourceId: u32 = 0;
  progress: f32 = 0;
  error: i32 = 0;
  nameOffset: u32 = 0;
  nameLength: u32 = 0;
  seq: u64 = 0;
  reserved: u64 = 0;
  reserved2: u64 = 0;
}

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

/** A `Resource` record's `seq`, in bytes from the record's start. */
export const RESOURCE_SEQ_OFFSET: u32 = 40;

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
export const SCENE_NODE_SIZE: u32 = 80;
export const SCENE_CAMERA_COUNT: u32 = 512;
export const SCENE_CAMERA_SIZE: u32 = 80;
export const SCENE_LIGHT_COUNT: u32 = 1024;
export const SCENE_LIGHT_SIZE: u32 = 96;

/** Where the cameras' table starts, in bytes from the region's first node. */
export const SCENE_CAMERA_BASE: u32 = SCENE_NODE_COUNT * SCENE_NODE_SIZE;
/** And the lights' table, after the cameras'. */
export const SCENE_LIGHT_BASE: u32 = SCENE_CAMERA_BASE + SCENE_CAMERA_COUNT * SCENE_CAMERA_SIZE;
/** The bytes SCENE needs for all three tables to fit. */
export const SCENE_TABLE_BYTES: u32 = SCENE_LIGHT_BASE + SCENE_LIGHT_COUNT * SCENE_LIGHT_SIZE;

export const MATERIAL_COUNT: u32 = 256;
export const MATERIAL_SIZE: u32 = 208;
export const RENDERABLE_COUNT: u32 = 2048;
export const RENDERABLE_SIZE: u32 = 64;

// --- the motion table (chunk 4) ---------------------------------------------
//
// One `MotionUpdate` per moving body, written by the guest at the start of
// `BUFFER_POOL` and named in full to `ogre::submit_motion(count)`. The
// capacity is the smaller of what the renderable table can hold and what the
// region has room for: min(2048, 4 MiB / 64).

/** One `MotionUpdate`, in bytes — the table's stride in `BUFFER_POOL`. */
export const MOTION_SIZE: u32 = 64;

/** How many entries the table can hold. */
export const MOTION_CAPACITY: u32 = 2048;

// --- the offset check ------------------------------------------------------

/**
 * The first OGRE wire offset that disagrees with this catalogue, or `null`.
 *
 * Same shape as the runtime's `wireOffsetsProblem`, and for the same reason: a
 * mismatch is a build that will read another field's bytes, and naming the
 * field is the whole diagnostic. Sizes come from the last field's offset plus
 * its width plus the trailing reserved words, because AS's `sizeof` does not
 * report these records the way the wire needs.
 */
/**
 * The motion record's offsets, on their own.
 *
 * Separate from `ogreWireOffsetsProblem` so a guest that uses `MotionBatch`
 * can assert exactly what it depends on, by name, rather than relying on a
 * larger check happening to include it. The layout is the point: the id pair,
 * then the transform at the offsets `Renderable`'s inline one already uses.
 */
function ogreMotionOffsetsProblem(): string | null {
  if (offsetof<MotionUpdate>("pad0") != 8) return "MotionUpdate.pad0";
  if (offsetof<MotionUpdate>("positionX") != 16) return "MotionUpdate.positionX";
  if (offsetof<MotionUpdate>("rotationX") != 32) return "MotionUpdate.rotationX";
  if (offsetof<MotionUpdate>("scaleX") != 48) return "MotionUpdate.scaleX";
  if (offsetof<MotionUpdate>("pad2") + 4 != 64) return "MotionUpdate size";
  return null;
}

/** Whether this build's `MotionUpdate` matches the catalogue. */
export function checkOgreMotionOffsets(): bool {
  return ogreMotionOffsetsProblem() == null;
}

/** `checkOgreMotionOffsets`, as an assertion that names the field that moved. */
export function assertOgreMotionOffsets(): void {
  const problem = ogreMotionOffsetsProblem();
  if (problem != null) {
    assert(false, "the motion record's offsets do not match the catalogue: " + problem);
  }
}

function ogreWireOffsetsProblem(): string | null {
  // Math: the small ones are pure width, and the two padded ones carry their
  // pad as a field so the container arithmetic below stays honest.
  if (offsetof<Vec2f>("y") != 4 || offsetof<Vec2f>("y") + 4 != 8) return "Vec2f";
  if (offsetof<Vec3f>("z") != 8 || offsetof<Vec3f>("z") + 4 != 12) return "Vec3f";
  if (offsetof<Vec3f16>("pad") != 12 || offsetof<Vec3f16>("pad") + 4 != 16) return "Vec3f16";
  if (offsetof<Vec4f>("w") != 12 || offsetof<Vec4f>("w") + 4 != 16) return "Vec4f";
  if (offsetof<Quatf>("w") != 12 || offsetof<Quatf>("w") + 4 != 16) return "Quatf";
  if (offsetof<Colourf>("a") != 12 || offsetof<Colourf>("a") + 4 != 16) return "Colourf";
  if (offsetof<Mat4f>("m33") != 60 || offsetof<Mat4f>("m33") + 4 != 64) return "Mat4f";
  if (offsetof<Transformf>("rotationX") != 16) return "Transformf.rotationX";
  if (offsetof<Transformf>("scaleX") != 32) return "Transformf.scaleX";
  if (offsetof<Transformf>("pad1") != 44 || offsetof<Transformf>("pad1") + 4 != 48) return "Transformf";
  if (offsetof<Aabbf>("maxX") != 16) return "Aabbf.maxX";
  if (offsetof<Aabbf>("pad1") != 28 || offsetof<Aabbf>("pad1") + 4 != 32) return "Aabbf";

  // Refs.
  if (offsetof<StringRef>("length") != 4 || offsetof<StringRef>("length") + 4 != 8) return "StringRef";
  if (offsetof<BufferRef>("length") != 4 || offsetof<BufferRef>("length") + 4 != 8) return "BufferRef";

  // Records.
  if (offsetof<SceneNode>("transformX") != 24) return "SceneNode.transformX";
  if (offsetof<SceneNode>("reserved") != 72) return "SceneNode.reserved";
  if (offsetof<SceneNode>("reserved") + 8 != 80) return "SceneNode size";
  if (offsetof<LightRecord>("intensity") != 32) return "LightRecord.intensity";
  if (offsetof<LightRecord>("nameOffset") != 80) return "LightRecord.nameOffset";
  if (offsetof<LightRecord>("reserved") + 8 != 96) return "LightRecord size";
  if (offsetof<CameraRecord>("rotationX") != 40) return "CameraRecord.rotationX";
  if (offsetof<CameraRecord>("reserved2") + 8 != 80) return "CameraRecord size";
  if (offsetof<TextureSlot>("uvSet") + 4 != 16) return "TextureSlot size";
  if (offsetof<Material>("slot0Resource") != 80) return "Material.slot0Resource";
  if (offsetof<Material>("slot7Resource") != 192) return "Material.slot7Resource";
  if (offsetof<Material>("slot7Uv") + 4 != 208) return "Material size";
  if (offsetof<ShaderRecord>("reserved") != 32) return "ShaderRecord.reserved";
  if (offsetof<ShaderRecord>("reserved") + 8 != 40) return "ShaderRecord size";
  if (offsetof<ResourceReq>("requestedSeq") != 24) return "ResourceReq.requestedSeq";
  if (offsetof<ResourceReq>("reserved") + 8 != 40) return "ResourceReq size";
  if (offsetof<Resource>("seq") != 40) return "Resource.seq";
  if (offsetof<Resource>("seq") + 8 != 48) return "Resource size";
  if (offsetof<Buffer>("bytes") != 32) return "Buffer.bytes";
  if (offsetof<Buffer>("reserved") + 8 != 48) return "Buffer size";
  if (offsetof<Renderable>("positionX") != 16) return "Renderable.positionX";
  if (offsetof<Renderable>("scalePad") + 4 != 64) return "Renderable size";
  // The motion table's record: the id pair, then the transform at the offsets
  // Renderable's inline one uses. `pad0` is what makes the transform land on
  // 16, and the record end at 64. Checked by `ogreMotionOffsetsProblem` so a
  // guest that uses `MotionBatch` can assert exactly what it depends on.
  const motion_problem = ogreMotionOffsetsProblem();
  if (motion_problem != null) return motion_problem;
  if (offsetof<Job>("priority") != 16) return "Job.priority";
  if (offsetof<Job>("progress") != 24) return "Job.progress";
  if (offsetof<Job>("seq") != 40) return "Job.seq";
  if (offsetof<Job>("reserved2") + 8 != 64) return "Job size";

  return null;
}

/** Whether this build's OGRE wire offsets match the catalogue. */
export function checkOgreWireOffsets(): bool {
  return ogreWireOffsetsProblem() == null;
}

/** `checkOgreWireOffsets`, as an assertion that names the field that moved. */
export function assertOgreWireOffsets(): void {
  const problem = ogreWireOffsetsProblem();
  if (problem != null) {
    assert(false, "the OGRE wire offsets do not match the catalogue: " + problem);
  }
}
