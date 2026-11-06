#version 450
// tension-2d/bench/shaders/sprite.frag
//
// The fragment stage: one texture sample, which is what makes the bench a real
// draw rather than a depth of empty work. The texture is 1x1 white, so the
// smoke test can assert non-black pixels without caring about UVs.
//
// Fragment shaders take sampled textures at set 2 (SDL_gpu.h:2705-2715), which
// is why this is set 2 and the vertex storage buffer is set 0.

layout(set = 2, binding = 0) uniform sampler2D uTex;

layout(location = 0) in vec2 vUV;
layout(location = 0) out vec4 fragColor;

void main() {
    fragColor = texture(uTex, vUV);
}
