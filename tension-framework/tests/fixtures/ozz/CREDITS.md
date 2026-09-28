# ozz runtime archive fixtures — provenance and licence

These are **binary fixtures for the parser tests**, not source. They are `.ozz`
runtime archives written by ozz-animation's own offline tooling (`gltf2ozz`), and
nothing here is generated at test time.

## Where each file came from

From [ozz-animation](https://github.com/guillaumeblanc/ozz-animation) at
`744eb9d` ("Merge branch 'release/0.17.0'"), `media/bin/`:

| file | source in the ozz tree | why it is here |
| --- | --- | --- |
| `skeleton_v2_le.ozz` | `media/bin/versioning/skeleton_v2_le.ozz` | skeleton v2, 67 joints — 68 slots, the padded case |
| `animation_v7_le.ozz` | `media/bin/versioning/animation_v7_le.ozz` | animation v7, the 67-track "run" clip that pairs with it |
| `robot_skeleton.ozz` | `media/bin/robot_skeleton.ozz` | a second paired rig, 18 joints — 20 slots, padded by 2 |
| `robot_animation.ozz` | `media/bin/robot_animation.ozz` | its clip: 14.7 s, 382 timepoints, 955 rotation keys |
| `skeleton_v1_le.ozz` | `media/bin/versioning/skeleton_v1_le.ozz` | **refusal fixture**: a skeleton version the runtime refuses |
| `animation_v6_le.ozz` | `media/bin/versioning/animation_v6_le.ozz` | **refusal fixture**: an animation version the runtime refuses |
| `skeleton_v2_be.ozz` | `media/bin/versioning/skeleton_v2_be.ozz` | **refusal fixture**: a big-endian archive |

ozz-animation is distributed under the **MIT License** (`LICENSE.md` in that
repository: "distributed under the MIT License (MIT). Copyright (c) 2020
Guillaume Blanc"). Its `media/` tree carries no separate licence notice, so the
repository's MIT terms are the ones that apply to the seven files above.

Derived here from ozz's own glTF sample models (checked in under
`media/gltf/khronos/`), converted with the `gltf2ozz` built from the same
revision — the brief's fixture list named these two assets, but ozz ships them
as glTF sources and not as `.ozz` archives:

| file | source | why it is here |
| --- | --- | --- |
| `rigged_simple_skeleton.ozz`, `rigged_simple_animation_0.ozz` | `media/gltf/khronos/rigged_simple.gltf` | 2 joints — 4 slots, padded by 2, the smallest real rig |
| `box_animated_skeleton.ozz`, `box_animated_animation_0.ozz` | `media/gltf/khronos/box_animated.gltf` | 4 joints — 4 slots, **unpadded**: the negative case for the padding rule |

Those four files derive from the Khronos glTF Sample Models, which
`media/gltf/khronos/README.md` credits as donated by Cesium: `box_animated.gltf`
and `rigged_simple.gltf` are **CC BY 4.0**.

## Regenerating the derived four

```sh
git clone --depth 1 https://github.com/guillaumeblanc/ozz-animation.git /tmp/ozz-animation
cmake -S /tmp/ozz-animation -B /tmp/ozz-animation/build -DCMAKE_BUILD_TYPE=Release \
      -Dozz_build_samples=OFF -Dozz_build_tests=OFF -Dozz_build_howtos=OFF -Dozz_build_fbx=OFF
cmake --build /tmp/ozz-animation/build -j
cd /tmp && printf '%s\n' \
  '{ "skeleton": { "filename": "rigged_simple_skeleton.ozz", "import": { "enable": true } },' \
  '  "animations": [ { "clip": "*", "filename": "rigged_simple_animation_*.ozz" } ] }' \
  > cfg.json
/tmp/ozz-animation/build/src/animation/offline/gltf/gltf2ozz \
  --file=/tmp/ozz-animation/media/gltf/khronos/rigged_simple.gltf --config_file=/tmp/cfg.json
```

(`box_animated` the same way.) The archives are little-endian and byte-identical
to what the offline tool produces; the parser tests assert exact values, so a
conversion run with a different ozz version should be expected to change them.
