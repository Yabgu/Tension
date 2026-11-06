#version 450
// tension-2d/bench/shaders/sprite.vert
//
// The vertex stage of the sprite-batch pattern DESIGN.md §7 describes: one draw
// call for N sprites, no vertex buffer, the record read straight out of a
// storage buffer at gl_InstanceIndex.
//
// The record is 28 bytes (DESIGN.md §5) and is read as seven u32 words rather
// than through a typed std430 struct. That is deliberate and it is load-bearing:
// a std430 struct lays its members out by the spec's own rules, and the design's
// record is a packed wire format whose source of truth is a schema table, not a
// C declaration. Reading words and shifting is the lowering this design requires
// (§5, "index the buffer by explicit byte offset"), so the bench exercises the
// real decode shape rather than a convenient one.
//
// Field map, 28 bytes = 7 words:
//   w0      x          i32
//   w1      y          i32
//   w2      src_x      u16  | src_y u16 << 16
//   w3      w          u16  | h     u16 << 16
//   w4      tex        u16  | pad   u16 << 16
//   w5      sort_key   u32
//   w6      group_id   u16  | z u8 << 16 | flags u8 << 24

layout(std430, set = 0, binding = 0) readonly buffer Sprites {
    uint words[];
};

layout(location = 0) out vec2 vUV;

// Six corners per instance, two triangles, matching SDL_DrawGPUPrimitives(6, N).
const vec2 kCorners[6] = vec2[6](
    vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
    vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0)
);

// The bench renders to a fixed offscreen target; a real pipeline takes the
// canvas size from the stage descriptor (DESIGN.md §6.2).
const vec2 kHalfCanvas = vec2(960.0, 540.0);

void main() {
    const uint base = uint(gl_InstanceIndex) * 7u;

    const int x = int(words[base + 0u]);
    const int y = int(words[base + 1u]);
    const uint wh = words[base + 3u];
    const float w = float(wh & 0xffffu);
    const float h = float(wh >> 16);

    const vec2 corner = kCorners[gl_VertexIndex];
    const vec2 px = vec2(float(x), float(y)) + corner * vec2(w, h);
    const vec2 clip = vec2(px.x / kHalfCanvas.x - 1.0, 1.0 - px.y / kHalfCanvas.y);

    gl_Position = vec4(clip, 0.0, 1.0);
    vUV = corner;
}
