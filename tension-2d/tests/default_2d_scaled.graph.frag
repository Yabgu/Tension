#version 450
// tension-shadergen: preset 1 fragment

layout(location = 0) in vec2 out_uv;
layout(set = 2, binding = 0) uniform sampler2D u_tex;
layout(location = 0) out vec4 fragColor;

void main() {
    fragColor = texture(u_tex, out_uv);
}
