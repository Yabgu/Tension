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
// or a host reader's fixed offset. See the rule above `Transformf` for which
// records carry pads and why.
//
// **These field layouts are defined here, for the first time.** The design note
// (§5.1) defers the capability catalogue's *field sets* until the OGRE version
// pin and extends the manifest then; chunk 1's manifest still holds the nine
// protocol types, so nothing here moves `layoutHash`. What is fixed is the
// sizes, and `assertOgreWireOffsets` proves them the same way the runtime's
// check proves its own: `offsetof<T>("lastField")` plus that field's width plus
// the trailing reserved words, never `sizeof<T>()`.
//
// Alignment is a *placement* rule, not something offsetof can check. Every leaf
// in these records is an `f32` (align 4), so the 16-byte offsets in the transform
// records come from explicit pad fields, not from alignment -- measured, and the
// reason `pad0: u64` is load-bearing in `MotionUpdate`/`BoneUpdate`.

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
// workaround inventory in `docs/roadmap.md`. If a raw-bytes view of a transform
// record is ever wanted (`changetype<...>(ptr)`), that is when a second
// `@unmanaged` declaration earns its place, alongside a check that the two agree.
//
// `Vec3fValue` is a pure Vec3 — 12 bytes, no fourth coordinate — so the 16-byte
// slot-filling pad lives on the **record**, as `pad1`/`pad2`, where the slot
// structure belongs. `QuatfValue` is 16 bytes on its own; a quaternion fills its
// slot naturally.
//
// **Never nested inside each other.** A plain struct inside a plain struct is
// refused by name (SROA flattening is deferred), so these are leaves. Every
// record that carries one is `@unmanaged`, which is the supported shape.
//
// What keeps them honest is the record-level check: `ogreMotionOffsetsProblem`
// and `ogreWireOffsetsProblem` assert where each twin lands in the records the
// adapter reads.

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
// **Renderable, MotionUpdate and BoneUpdate keep their explicit pads.** The
// adapter reads those three at literal byte offsets 16 / 32 / 48
// (`tension-ogre/src/scene.cpp:460`, `:472`, `:484` — one `read_transform(r, 16,
// 32, 48, …)` call per decoder), and the sizes are the tables' strides
// (`scene.h:39`, `:49`, `:67`). That is an external contract: the guest cannot
// move those offsets without the adapter moving with it.
//
// **Transformf and Aabbf have no host reader** — zero occurrences in
// `tension-ogre/`; their only consumers are the `offsetof` assertions below.
// Their pads were uniformity, so they are gone and both records are tight.
//
// The rule, stated once:
//
//   Padding is added when a smaller field precedes a larger one that needs
//   stricter alignment — a `u8` before an `f32` on a target that demands it, or
//   a `u64` at an odd offset — **or** when an external reader depends on a fixed
//   offset. Padding is never added for uniformity ("all records should be
//   N-byte shaped"), convention ("this is the wire's slot size"), or "16-byte
//   slots" as a shape preference.
//
// Neither tight record has a field that needs padding, and neither contains a
// `u8`-adjacent-to-`f32` or an odd-offset `u64` sequence. Measured 2026-10-30:
// every leaf is `f32` at 4-byte alignment (`Vec3fValue` sizeof 12 / align 4,
// `QuatfValue` sizeof 16 / align 4), and every field lands on a 4-byte multiple.
// If a future field does need padding, pad that field explicitly and say why
// here — the reason is the alignment arithmetic, never the shape.

/** Position, rotation, uniform scale — 40 bytes (tight: no host reader). */
@unmanaged
export struct Transformf {
  position: Vec3fValue = {}; //  0, 12 bytes
  rotation: QuatfValue = {}; // 12, 16 bytes — `QuatfValue` is 4-byte aligned
  scale: Vec3fValue = {}; //    28, 12 bytes — ends the record at 40
}

/** An axis-aligned box — 24 bytes (tight: no host reader). */
@unmanaged
export struct Aabbf {
  min: Vec3fValue = {}; //  0, 12 bytes
  max: Vec3fValue = {}; // 12, 12 bytes — ends the record at 24
}

// --- refs ------------------------------------------------------------------

// --- records ---------------------------------------------------------------

/** A scene node, 80 bytes: `transform` at 24, alignment 16. */
@unmanaged
export struct SceneNode {
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

  /// A node at a place, with the identity rotation and unit scale the fields
  /// already default to. `parentId` stays 0: hierarchy is refused in this
  /// chunk, and a factory that quietly set a parent would be the wrong kind of
  /// helpful.
  static at(x: f32 = 0, y: f32 = 0, z: f32 = 0): SceneNode {
    const node = new SceneNode();
    node.transformX = x;
    node.transformY = y;
    node.transformZ = z;
    return node;
  }
}

/** A light, 96 bytes. */
@unmanaged
export struct LightRecord {
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
  positionPad: f32 = 0;
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

/** A material, 208 bytes: eight texture slots from 80. */
@unmanaged
export struct Material {
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
  private pad0: u32 = 0;
  seq: u64 = 0;
}

/** A drawable, 64 bytes: its transform is inline at 16. */
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
  pad1: f32 = 0; //            28 — fills position to its 16-byte slot
  rotation: QuatfValue = {}; // 32, 16 bytes — already a full slot
  scale: Vec3fValue = {}; //    48, 12 bytes
  pad2: f32 = 0; //            60 — fills scale to its slot; ends the record at 64

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
 * One entry of the motion table, 64 bytes (chunk 4): a renderable's whole
 * transform and nothing else. The table lives at the start of `BUFFER_POOL`,
 * the guest writes it, and `ogre::submit_motion(count)` names how much of it is
 * live — one call per frame instead of one per body.
 *
 * **Nested, one transform read for both records.** `position`/`rotation`/`scale`
 * are the value twins: `position` and `scale` are 12-byte values and `rotation`
 * is 16, laid out in the record's body rather than as 4-byte references — the
 * offsets `Renderable`'s inline transform already uses (16/32/48), each slot
 * completed by an explicit `pad1`/`pad2`.
 *
 * **`pad0: u64` is what puts the transform at 16 — not alignment.** The 16-byte
 * offsets do not come from the quaternion being aligned (`QuatfValue`'s `alignof` is log2 2, i.e.
 * 4-byte; §3.7 of the plan measured this on three compilers). They come from this
 * explicit 8-byte pad ending exactly at 16, plus the 16-byte twins striding
 * naturally after it. **Do not drop `pad0` while nesting:** `Vec3fValue` is
 * align-4, so `position` would land at offset **8** and the adapter's
 * `read_transform(r, 16, 32, 48, …)` would read `flags` as a coordinate without
 * raising anything. Measured 2026-10-29: without it, size 56 and offsets
 * 8/24/40; with it, size 64 and offsets 16/32/48.
 *
 * **Unmanaged: every use is a pointer view.** The idiom is
 * `changetype<MotionUpdate>(base + index * sizeof<MotionUpdate>())` — a view of
 * the arena slot with no header read or written. A use-site `@unmanaged`
 * (`changetype<@unmanaged MotionUpdate>(…)`) is therefore not an improvement but
 * a restatement: the declaration already names the model, and the override emits
 * the same code. Say it once, here.
 *
 * The layout is verified at the record's `pad2` by `ogreMotionOffsetsProblem`,
 * which asserts `offsetof("pad2") + sizeof<f32>() == sizeof<MotionUpdate>()`
 * rather than a copied constant — so a field appended after `pad2` fails the
 * check instead of silently widening the record past the table's stride. The
 * `pad1`/`pad2` fields are **slot-fillers, not value**: each completes a 12-byte
 * `Vec3fValue` to the 16-byte slot its neighbours start on. That is where the
 * padding belongs — on the record, whose slot structure it is — rather than
 * folded into the value type as a phantom fourth coordinate.
 */
@unmanaged
export struct MotionUpdate {
  renderableId: u32 = 0;
  flags: u32 = 0;
  /// Ends exactly at 16 — see the note above. Not optional.
  pad0: u64 = 0;
  position: Vec3fValue = {}; //  16, 12 bytes
  pad1: f32 = 0; //            28 — fills position to its 16-byte slot
  rotation: QuatfValue = {}; // 32, 16 bytes — already a full slot
  scale: Vec3fValue = {}; //    48, 12 bytes
  pad2: f32 = 0; //            60 — fills scale to its slot; ends the record at 64
}

/** One bone pose, 64 bytes — one entry of the bone table (DESIGN.md §5.1,
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
 * The layout is verified at this record's `pad2` by `ogreBoneOffsetsProblem`,
 * asserting `offsetof("pad2") + sizeof<f32>() == sizeof<BoneUpdate>()`.
 * `pad0: u64` is load-bearing here for the reason `MotionUpdate` gives — without
 * it the transform lands at 8 and the adapter reads the ids as coordinates.
 */
@unmanaged
export struct BoneUpdate {
  renderableId: u32 = 0;
  boneIndex: u32 = 0;
  /// Ends exactly at 16 — see `MotionUpdate`'s note. Not optional.
  pad0: u64 = 0;
  position: Vec3fValue = {}; //  16, 12 bytes
  pad1: f32 = 0; //            28 — fills position to its 16-byte slot
  rotation: QuatfValue = {}; // 32, 16 bytes — already a full slot
  scale: Vec3fValue = {}; //    48, 12 bytes
  pad2: f32 = 0; //            60 — fills scale to its slot; ends the record at 64
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

// --- the bone table (chunk 5b) ----------------------------------------------
//
// A second table of the same stride, past the motion table's 128 KiB:
// `BONE_TABLE_OFFSET` + `BONE_SIZE * BONE_CAPACITY` must fit inside the region
// alongside the motion table, and the arithmetic below is what says so.

/** One `BoneUpdate`, in bytes — the table's stride in `BUFFER_POOL`. */
export const BONE_SIZE: u32 = 64;

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
 * Separate from `ogreWireOffsetsProblem` so a guest that uses `MotionBatch`
 * can assert exactly what it depends on, by name, rather than relying on a
 * larger check happening to include it. The layout is the point: the id pair,
 * then the transform at the offsets `Renderable`'s inline one already uses.
 */
function ogreMotionOffsetsProblem(): string | null {
  // `pad0` survives (§3.7.2c): it is what puts the transform at 16.
  if (offsetof<MotionUpdate>("pad0") != 8) return "MotionUpdate.pad0";
  if (offsetof<MotionUpdate>("position") + offsetof<Vec3fValue>("x") != 16) {
    return "MotionUpdate.position";
  }
  // `pad1` fills the material's 12-byte value out to its 16-byte slot, so the
  // rotation starts at 32 — the sum below is the check that it does.
  if (offsetof<MotionUpdate>("pad1") + sizeof<f32>() != offsetof<MotionUpdate>("rotation")) {
    return "MotionUpdate.pad1";
  }
  if (offsetof<MotionUpdate>("rotation") + offsetof<QuatfValue>("x") != 32) {
    return "MotionUpdate.rotation";
  }
  if (offsetof<MotionUpdate>("scale") + offsetof<Vec3fValue>("x") != 48) {
    return "MotionUpdate.scale";
  }
  // Bound to the declaration, not to a hand-copied 64: the record ends at `pad2`,
  // so a field appended after it fails here instead of silently widening the
  // record past the table's stride. (Before the pad moved out of the twin, the
  // end was `scale` + the twin's 16 bytes; with a pure 12-byte value the record
  // needs its own trailing slot-filler, and this is what checks it.)
  if (offsetof<MotionUpdate>("pad2") + sizeof<f32>() != sizeof<MotionUpdate>()) {
    return "MotionUpdate size";
  }
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
  if (offsetof<BoneUpdate>("pad0") != 8) return "BoneUpdate.pad0";
  if (offsetof<BoneUpdate>("position") + offsetof<Vec3fValue>("x") != 16) {
    return "BoneUpdate.position";
  }
  if (offsetof<BoneUpdate>("pad1") + sizeof<f32>() != offsetof<BoneUpdate>("rotation")) {
    return "BoneUpdate.pad1";
  }
  if (offsetof<BoneUpdate>("rotation") + offsetof<QuatfValue>("x") != 32) {
    return "BoneUpdate.rotation";
  }
  if (offsetof<BoneUpdate>("scale") + offsetof<Vec3fValue>("x") != 48) {
    return "BoneUpdate.scale";
  }
  // As for the motion record: the size comes from the declaration. `BONE_SIZE`
  // stays the wire's published stride; this check no longer trusts it.
  if (offsetof<BoneUpdate>("pad2") + sizeof<f32>() != sizeof<BoneUpdate>()) {
    return "BoneUpdate size";
  }
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

function ogreWireOffsetsProblem(): string | null {
  // The math types, `Transformf`, `Aabbf`, the refs, `TextureSlot`,
  // `ShaderRecord`, `ResourceReq` and `Buffer` used to be checked here field by
  // field. They have no host reader, so each assertion compared the declaration
  // against a literal declared beside it — the two moved together and could
  // catch nothing. Removed 2026-10-30; see the wire workaround inventory in
  // `docs/roadmap.md`.

  // The two moving tables. Checked here as well as by their own assertions so a
  // build that forgets to call them still catches a moved field.
  const motion = ogreMotionOffsetsProblem();
  if (motion != null) return motion;
  // The procedural window's start is derived here and written as a literal in
  // the adapter (DESIGN.md §5.1 pins it at 256 KiB); a derivation that drifts
  // from that number would put the guest's bytes where the adapter does not
  // look, so the two are tied together by this.
  if (PROCEDURAL_BASE != 256 * 1024) return "PROCEDURAL_BASE";
  if (PROCEDURAL_CAPACITY == 0) return "PROCEDURAL_CAPACITY";
  // The format bits are a contract with the adapter's element table: the three
  // the adapter declares, in the order it declares them.
  if (VF_POSITION != 1 || VF_NORMAL != 2 || VF_UV != 4) return "VF_ bits";
  if (TOPO_TRIANGLE_LIST != 0) return "TOPO_TRIANGLE_LIST";
  const bone = ogreBoneOffsetsProblem();
  if (bone != null) return bone;

  // Records.
  if (offsetof<SceneNode>("transformX") != 24) return "SceneNode.transformX";
  if (offsetof<SceneNode>("reserved") != 72) return "SceneNode.reserved";
  if (offsetof<SceneNode>("reserved") + 8 != 80) return "SceneNode.reserved end";
  if (sizeof<SceneNode>() != 80) return "SceneNode size";
  if (offsetof<LightRecord>("intensity") != 32) return "LightRecord.intensity";
  if (offsetof<LightRecord>("nameOffset") != 80) return "LightRecord.nameOffset";
  if (offsetof<LightRecord>("reserved") + 8 != 96) return "LightRecord.reserved end";
  if (sizeof<LightRecord>() != 96) return "LightRecord size";
  if (offsetof<CameraRecord>("rotationX") != 40) return "CameraRecord.rotationX";
  if (offsetof<CameraRecord>("reserved2") + 8 != 80) return "CameraRecord.reserved2 end";
  if (sizeof<CameraRecord>() != 80) return "CameraRecord size";
  if (offsetof<Material>("slot0Resource") != 80) return "Material.slot0Resource";
  if (offsetof<Material>("slot7Resource") != 192) return "Material.slot7Resource";
  if (offsetof<Material>("slot7Uv") + 4 != 208) return "Material.slot7Uv end";
  if (sizeof<Material>() != 208) return "Material size";
  if (offsetof<Resource>("seq") != 40) return "Resource.seq";
  if (offsetof<Resource>("seq") + 8 != 48) return "Resource.seq end";
  if (sizeof<Resource>() != 48) return "Resource size";
  // Offset 12 is `nodeId` since chunk 5a — the field that used to be `flags`.
  // The pin is here because the rename is a *semantics* change, and the one
  // thing that must not change with it is where the field sits.
  if (offsetof<Renderable>("nodeId") != 12) return "Renderable.nodeId";
  if (offsetof<Renderable>("position") + offsetof<Vec3fValue>("x") != 16) {
    return "Renderable.position";
  }
  if (offsetof<Renderable>("pad1") + sizeof<f32>() != offsetof<Renderable>("rotation")) {
    return "Renderable.pad1";
  }
  if (offsetof<Renderable>("pad2") + sizeof<f32>() != sizeof<Renderable>()) {
    return "Renderable.pad2 end";
  }
  if (sizeof<Renderable>() != 64) return "Renderable size";
  if (offsetof<Job>("priority") != 16) return "Job.priority";
  if (offsetof<Job>("progress") != 24) return "Job.progress";
  if (offsetof<Job>("seq") != 40) return "Job.seq";
  if (offsetof<Job>("reserved2") + 8 != 64) return "Job.reserved2 end";
  if (sizeof<Job>() != 64) return "Job size";

  return null;
}

/** Assert this build's OGRE wire offsets match the catalogue, naming the field. */
export function assertOgreWireOffsets(): void {
  const problem = ogreWireOffsetsProblem();
  if (problem != null) {
    assert(false, "the OGRE wire offsets do not match the catalogue: " + problem);
  }
}
