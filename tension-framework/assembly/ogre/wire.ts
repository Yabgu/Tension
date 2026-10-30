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

/** A Vec3 as a value — **12 bytes**: no pad, no fourth coordinate. */
export struct Vec3fValue {
  x: f32 = 0;
  y: f32 = 0;
  z: f32 = 0;
}

/** A quaternion as a value — 16 bytes, `w` last. Fills a 16-byte slot on its own. */
export struct QuatfValue {
  x: f32 = 0;
  y: f32 = 0;
  z: f32 = 0;
  w: f32 = 0;
}

// ── Transform record padding: the rule ────────────────────────────────
//
// **No transform record carries a pad.** All three are tight: `MotionUpdate` and
// `BoneUpdate` are 48 bytes with the transform at 8/20/36, and `Renderable` is
// 56 with it at 16/28/44.
//
// The pads these records used to carry were there to land a 16-byte unit on a
// 16-byte boundary. Measured, nothing here needs one:
//
//   - every leaf is an `f32` (align 4), so no offset is forced;
//   - the adapter copies each record with one `memcpy` into a packed host
//     struct (`tension-ogre/src/scene.cpp`), so it never performs an aligned
//     load of the wire bytes;
//   - the guest is WASM, where an unaligned load is slower at worst, never a
//     fault.
//
// The rule, stated once:
//
//   Padding is added when a smaller field precedes a larger one that needs
//   stricter alignment — a `u8` before an `f32` on a target that demands it, or
//   a `u64` at an odd offset. Padding is never added for uniformity ("all
//   records should be N-byte shaped"), convention ("this is the wire's slot
//   size"), or "16-byte slots" as a shape preference.
//
// Note what the rule does **not** say: "or a host reader needs it". A host
// reader pins *offsets*, not padding — `scene.cpp` reads the three
// adapter-visible records at whatever offsets they have, and a changed offset is
// a coordinated change on both sides, not a reason to keep a pad.
//
// No record below contains a `u8`-adjacent-to-`f32` or an odd-offset `u64`, so
// none needs padding today. If a future field does, pad that field explicitly
// and say why here — the reason is the alignment arithmetic, never the shape.

// --- refs ------------------------------------------------------------------

// --- records ---------------------------------------------------------------

/** A scene node, 72 bytes: the transform is inline at 24, alignment 8 (the
 * trailing `reserved` u64). */
@unmanaged
export struct SceneNode {
  nodeId: u32 = 0;
  parentId: u32 = 0;
  flags: u32 = 0;
  childCount: u32 = 0;
  nameOffset: u32 = 0;
  nameLength: u32 = 0;
  position: Vec3fValue = {}; //  24, 12 bytes — the header's six words end here
  rotation: QuatfValue = {}; // 36, 16 bytes
  scale: Vec3fValue = {}; //    52, 12 bytes — ends the transform at 64
  reserved: u64 = 0;

  /// A node at a place, with the identity rotation and unit scale `at` sets.
  /// `parentId` stays 0: hierarchy is refused in this chunk, and a factory that
  /// quietly set a parent would be the wrong kind of helpful.
  ///
  /// **The rotation and scale are set here, not in the declaration.** The value
  /// twins default to zero, and a field initializer cannot carry values
  /// (`= { w: 1 }` is refused by name), so a bare `new SceneNode()` now has a
  /// zero quaternion and zero scale where the flat declaration gave identity
  /// and unit. Every construction in this tree goes through `at`.
  static at(x: f32 = 0, y: f32 = 0, z: f32 = 0): SceneNode {
    const node = new SceneNode();
    node.position.x = x;
    node.position.y = y;
    node.position.z = z;
    node.rotation.w = 1;
    node.scale.x = 1;
    node.scale.y = 1;
    node.scale.z = 1;
    return node;
  }
}

/** A light, 88 bytes. */
@unmanaged
export struct LightRecord {
  lightId: u32 = 0;
  kind: u32 = 0;
  flags: u32 = 0;
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
  positionX: f32 = 0;
  positionY: f32 = 0;
  positionZ: f32 = 0;
  nameOffset: u32 = 0;
  nameLength: u32 = 0;
  reserved: u64 = 0;

  /// A directional light: a colour, an intensity, and the direction the light
  /// travels in. No position — a directional light is everywhere.
  static directional(r: f32, g: f32, b: f32, intensity: f32, dx: f32, dy: f32,
                     dz: f32): LightRecord {
    const light = new LightRecord();
    light.kind = LIGHT_DIRECTIONAL;
    light.colourR = r;
    light.colourG = g;
    light.colourB = b;
    light.intensity = intensity;
    light.directionX = dx;
    light.directionY = dy;
    light.directionZ = dz;
    return light;
  }

  /// A point light at a place. `range` of 0 is no attenuation.
  static point(r: f32, g: f32, b: f32, intensity: f32, x: f32, y: f32, z: f32,
               range: f32 = 0): LightRecord {
    const light = new LightRecord();
    light.kind = LIGHT_POINT;
    light.colourR = r;
    light.colourG = g;
    light.colourB = b;
    light.intensity = intensity;
    light.positionX = x;
    light.positionY = y;
    light.positionZ = z;
    light.range = range;
    return light;
  }
}

/** A camera, 80 bytes. */
@unmanaged
export struct CameraRecord {
  cameraId: u32 = 0;
  flags: u32 = 0;
  fovY: f32 = 1;
  aspect: f32 = 1;
  nearClip: f32 = 0.1;
  farClip: f32 = 1000;
  positionX: f32 = 0;
  positionY: f32 = 0;
  positionZ: f32 = 0;
  rotationX: f32 = 0;
  rotationY: f32 = 0;
  rotationZ: f32 = 0;
  rotationW: f32 = 1;
  viewportWidth: u32 = 0;
  viewportHeight: u32 = 0;
  reserved: u64 = 0;
  reserved2: u64 = 0;

  /// A perspective camera looking down its own -Z (an OGRE camera's default),
  /// which is why the rotation is left at the identity the field defaults to.
  /// The viewport stays 0 x 0, which means the window's whole size.
  static perspective(fovY: f32, aspect: f32, near: f32, far: f32, x: f32 = 0,
                     y: f32 = 0, z: f32 = 0): CameraRecord {
    const camera = new CameraRecord();
    camera.fovY = fovY;
    camera.aspect = aspect;
    camera.nearClip = near;
    camera.farClip = far;
    camera.positionX = x;
    camera.positionY = y;
    camera.positionZ = z;
    return camera;
  }
}

/** A material, 200 bytes: eight texture slots from 72. */
@unmanaged
export struct Material {
  materialId: u32 = 0;
  kind: u32 = 0;
  flags: u32 = 0;
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
  // Eight TextureSlots, 16 bytes each, from offset 72.
  slot0Resource: u32 = 0; slot0Sampler: u32 = 0; slot0Flags: u32 = 0; slot0Uv: u32 = 0;
  slot1Resource: u32 = 0; slot1Sampler: u32 = 0; slot1Flags: u32 = 0; slot1Uv: u32 = 0;
  slot2Resource: u32 = 0; slot2Sampler: u32 = 0; slot2Flags: u32 = 0; slot2Uv: u32 = 0;
  slot3Resource: u32 = 0; slot3Sampler: u32 = 0; slot3Flags: u32 = 0; slot3Uv: u32 = 0;
  slot4Resource: u32 = 0; slot4Sampler: u32 = 0; slot4Flags: u32 = 0; slot4Uv: u32 = 0;
  slot5Resource: u32 = 0; slot5Sampler: u32 = 0; slot5Flags: u32 = 0; slot5Uv: u32 = 0;
  slot6Resource: u32 = 0; slot6Sampler: u32 = 0; slot6Flags: u32 = 0; slot6Uv: u32 = 0;
  slot7Resource: u32 = 0; slot7Sampler: u32 = 0; slot7Flags: u32 = 0; slot7Uv: u32 = 0;

  /// An Unlit material: a diffuse colour and nothing else, which is the
  /// simplest thing a mesh can be drawn with — no lights, no texture slots.
  static unlit(r: f32, g: f32, b: f32, a: f32 = 1.0): Material {
    const material = new Material();
    material.kind = MAT_HLMS_UNLIT;
    material.diffuseR = r;
    material.diffuseG = g;
    material.diffuseB = b;
    material.diffuseA = a;
    material.opacity = a;
    return material;
  }

  /// A PBS material: physically based, and *black* until the scene has a light
  /// rig, which is why the examples use `unlit`. Here so the surface is
  /// complete rather than half-documented.
  static pbs(r: f32, g: f32, b: f32, roughness: f32 = 0.5, metalness: f32 = 0.0,
             a: f32 = 1.0): Material {
    const material = new Material();
    material.kind = MAT_HLMS_PBS;
    material.diffuseR = r;
    material.diffuseG = g;
    material.diffuseB = b;
    material.diffuseA = a;
    material.roughness = roughness;
    material.metalness = metalness;
    material.opacity = a;
    return material;
  }
}

/** A resource the session reports into `RESOURCE`, 48 bytes. */
@unmanaged
export struct Resource {
  resourceId: u32 = 0;
  kind: u32 = 0;
  state: u32 = 0;
  flags: u32 = 0;
  size: u32 = 0;
  nameOffset: u32 = 0;
  nameLength: u32 = 0;
  error: i32 = 0;
  refs: u32 = 0;
  /// Implicitly 4 bytes of padding here: `seq` is a `u64` and the compiler
  /// aligns it to 40. The explicit pad that used to sit here was a no-op --
  /// measured 2026-10-30, same offset and size with and without it.
  seq: u64 = 0;
}

/** A drawable, 56 bytes: its transform is inline at 16. */
@unmanaged
export struct Renderable {
  renderableId: u32 = 0;
  materialId: u32 = 0;
  meshResourceId: u32 = 0;
  /// The node this drawable hangs from, or 0 for self-placed at the world root.
  /// This word was `flags` until chunk 5a: nothing wrote it and nothing read it
  /// but the decoder, so the repurposing changed semantics and not shape — no
  /// offset moved and `layoutHash` did not either. With a node, the inline
  /// transform below is *local* to it.
  nodeId: u32 = 0;
  position: Vec3fValue = {}; //  16, 12 bytes
  rotation: QuatfValue = {}; // 28, 16 bytes
  scale: Vec3fValue = {}; //    44, 12 bytes — ends the record at 56

  /// A drawable: a mesh, a material, and a place in the world — the inline
  /// transform this record carries, with the identity rotation it defaults to.
  /// The id is yours to set; it is the guest's own handle, not part of the
  /// shape. `nodeId` stays 0: a drawable that hangs from a node is a different
  /// sentence, and the factory should not guess which one you meant.
  static at(meshResourceId: u32, materialId: u32, x: f32 = 0, y: f32 = 0,
            z: f32 = 0, scale: f32 = 1.0): Renderable {
    const renderable = new Renderable();
    renderable.meshResourceId = meshResourceId;
    renderable.materialId = materialId;
    renderable.position.x = x;
    renderable.position.y = y;
    renderable.position.z = z;
    renderable.rotation.w = 1;
    renderable.scale.x = scale;
    renderable.scale.y = scale;
    renderable.scale.z = scale;
    return renderable;
  }
}

/**
 * One entry of the motion table, 48 bytes (chunk 4): a renderable's whole
 * transform and nothing else. The table lives at the start of `BUFFER_POOL`,
 * the guest writes it, and `ogre::submit_motion(count)` names how much of it is
 * live — one call per frame instead of one per body.
 *
 * **Nested, and tight.** `position`/`rotation`/`scale` are the value twins:
 * 12-byte values either side of the 16-byte quaternion, laid out in the record's
 * body rather than as 4-byte references. The transform starts right after the id
 * pair — at 8 — and the record is 48 bytes, which is the table's stride.
 *
 * **No pads.** An earlier revision put `pad0: u64` in front of the transform to
 * place it at 16, because the 16-byte offsets looked like an alignment
 * requirement. They were not: every leaf is an `f32` (align 4), nothing needs a
 * 16-byte boundary, the adapter `memcpy`s each record into a packed host struct
 * rather than reading it through aligned loads, and the guest is WASM where an
 * unaligned load is merely slower. The pads cost 16 bytes per record and bought
 * nothing, so they went — along with `Renderable`'s, whose record is now 56.
 *
 * **Unmanaged: every use is a pointer view.** The idiom is
 * `changetype<MotionUpdate>(base + index * sizeof<MotionUpdate>())` — a view of
 * the arena slot with no header read or written. A use-site `@unmanaged`
 * (`changetype<@unmanaged MotionUpdate>(…)`) is therefore not an improvement but
 * a restatement: the declaration already names the model, and the override emits
 * the same code. Say it once, here.
 *
 * The layout is verified by `ogreMotionOffsetsProblem`: the transform at
 * 8/20/36, `offsetof("scale") + sizeof<Vec3fValue>()` at the record's end, and
 * `sizeof` exactly 48 — so a field appended after `scale` fails the check
 * instead of silently widening the record past the table's stride.
 */
@unmanaged
export struct MotionUpdate {
  renderableId: u32 = 0;
  flags: u32 = 0;
  position: Vec3fValue = {}; //  8, 12 bytes
  rotation: QuatfValue = {}; // 20, 16 bytes
  scale: Vec3fValue = {}; //    36, 12 bytes — ends the record at 48
}

/** One bone pose, 48 bytes — one entry of the bone table (DESIGN.md §5.1,
 * chunk 5b). Same layout as `MotionUpdate`, with `boneIndex` where the motion
 * record carries `flags`: a rig is posed by naming a renderable *and* a bone
 * inside it, and the transform that follows is the bone's local transform.
 *
 * The table lives in `BUFFER_POOL` after the motion table, so `BONE_TABLE_OFFSET`
 * is an offset *within the region*, not a region.
 *
 * **Unmanaged: every use is a pointer view.** As for `MotionUpdate`, the
 * declaration is where the model is stated; a use-site `@unmanaged` restates it
 * for identical code. The idiom is
 * `changetype<BoneUpdate>(base + index * sizeof<BoneUpdate>())`.
 *
 * The layout is verified by `ogreBoneOffsetsProblem`: the transform at 8/20/36
 * and `sizeof` exactly 48, which is the table's stride.
 */
@unmanaged
export struct BoneUpdate {
  renderableId: u32 = 0;
  boneIndex: u32 = 0;
  position: Vec3fValue = {}; //  8, 12 bytes
  rotation: QuatfValue = {}; // 20, 16 bytes
  scale: Vec3fValue = {}; //    36, 12 bytes — ends the record at 48
}

/** One job, 64 bytes: what the session reports into `JOB`. */
@unmanaged
export struct Job {
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
