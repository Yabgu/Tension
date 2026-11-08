#version 450
// tension-shadergen: sprite-batcher vertex stage
// preset 1, layout sprite/world
// record 28 bytes (7 words), alignment 4
//
// One quad per record, read at gl_InstanceIndex.
// Draw with SDL_DrawGPUPrimitives(pass, 6, N, 0, 0).

layout(std430, binding = 0) readonly buffer Records {
    uint r_words[];
};

layout(set = 1, binding = 0) uniform CanvasBlock {
    vec2 u_canvas_half;
    vec2 u_tex_size;
};

layout(location = 0) out vec2 out_uv;

void main() {
    const uint kStride = 7u;
    const uint base = uint(gl_InstanceIndex) * kStride;

    // The six corners: (0,0) (1,0) (1,1) and (0,0) (1,1) (0,1).
    const vec2 kCorners[6] = vec2[6](
        vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0),
        vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0));
    const vec2 corner = kCorners[gl_VertexIndex];

    // record fields, widened to float
    float a_position_x = float(int(r_words[base + 0u]));
    float a_position_y = float(int(r_words[base + 1u]));
    float a_position_w = float((r_words[base + 3u] >> 0u) & 0xFFFFu);
    float a_position_h = float((r_words[base + 3u] >> 16u) & 0xFFFFu);
    float a_texcoord0_x = float((r_words[base + 2u] >> 0u) & 0xFFFFu);
    float a_texcoord0_y = float((r_words[base + 2u] >> 16u) & 0xFFFFu);
    float a_texcoord0_w = float((r_words[base + 3u] >> 0u) & 0xFFFFu);
    float a_texcoord0_h = float((r_words[base + 3u] >> 16u) & 0xFFFFu);

    vec2 px = vec2(a_position_x + corner.x * a_position_w,
                   a_position_y + corner.y * a_position_h);
    vec2 clip = vec2(px.x / u_canvas_half.x - 1.0,
                     1.0 - px.y / u_canvas_half.y);
    gl_Position = vec4(clip, 0.0, 1.0);

    // Pixel src rect -> normalized UV.
    out_uv = vec2(a_texcoord0_x + corner.x * a_texcoord0_w,
                  a_texcoord0_y + corner.y * a_texcoord0_h) / u_tex_size;
}
