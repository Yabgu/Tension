# Bug: the in-core IWI decoder refuses valid files read from a `.tns` volume

**Status:** open defect on `main`, isolated but not fixed. Found 2026-11-16 by a
fresh agent whose gate run is recorded in
`docs/plan/handoff-to-compiler-round.md` ("Fresh-agent machine addendum").
**Blocks:** nothing in the threading work. It fails three 2D example suites.
**Not on `ui-threading`:** `git diff --stat origin/main..HEAD -- tension-core/src/render2d/`
is empty — the threading branch never touched this path.

## The symptom

Three suites fail with the same refusal:

```
box-physics:      texture_load -> -38
stiff-boxes:      ERROR: Failed to load texture from resource volume: -38
starter template: texture_load /sprites.iwi -> -38 (is assets/sprites.iwi still there?)
```

and the renderer names the reason:

```
ERROR 2d: texture_load refused (iwi: only 3- and 4-component colour is supported at v1)
```

`-38` is `-ENOSYS`: "a valid IWI this build cannot serve" (not `-EINVAL`,
"broken IWI"). The decoder therefore believes the file is well-formed but has a
component count it will not upload.

## What has been ruled out

**The files on disk are valid.** Measured byte by byte, not assumed:

- `packages/cli/templates/starter/assets/sprites.iwi` — 128×32, **3 components**,
  12,342 bytes (60-byte header + 128·32·3).
- `examples/2d/stiff-boxes/assets/textures/boxes.iwi` — 1024×1024,
  **4 components**, 4,194,364 bytes (60-byte header + 1024·1024·4), magic `IWI1`,
  `metaBytes` 0, storage flags/stride 0, payload encoding all-zero (`raw`),
  colour class integer — every capability check `decode_iwi` applies before the
  component-count one is satisfied.

Both counts (3 and 4) are inside the accepted `3..=4` range, so a correct read of
either header cannot produce this message.

**The decoder logic is sound in isolation.** All 11 `render2d::iwi` unit tests
pass, including `decodes_rgba_passthrough`, `expands_rgb_to_opaque_rgba`,
`a_sixteen_bit_component_is_unsupported` and `a_shifted_component_is_refused`.
Run: `cargo test --lib --no-default-features --features audio,render2d-core iwi`.

**The message fires after a successful parse.** In `decode_iwi`
(`tension-core/src/render2d/iwi.rs`) the component-count check is the *last* of
six policies, reached only after `iwi_parse_structural` returns `STATUS_OK` and
after the storage-flags, payload-encoding, bit-width and component-class checks
all pass. So the buffer handed to the decoder parses cleanly and reports a
component count outside `3..=4`.

**The DSO path reads `.tns` volumes correctly.** The `tension-framework` font
specimen packs `assets/ui.*.iwi` into a `.tns` and loads them through the
C++ bisect DSO — and passes (26,684 lit pixels). So the *container* and the
volume read are not broadly broken; the divergence is on the in-core Rust side.

**Therefore:** the corruption is in the in-core path between reading a `.tns`
volume and `decode_iwi` — the bytes the Rust decoder receives are not the bytes
on disk. The three suites all load through `--res <volume>`; `hello-sprites`,
`isometric*` and the specimen pass, so it is not every volume read.

## What is left to determine (next round)

The isolation above narrows it to the in-core `res` read → `decode_iwi` handoff.
Open questions:

1. **Reproduce at the boundary.** Read one failing volume through the in-core
   reader and dump the first 36 bytes of the returned buffer; compare against the
   source file. That distinguishes "wrong length/offset" from "right length,
   wrong contents".
2. **Regression or pre-existing?** The IWI authority migration is `5b1a171`
   (`feat(format): adopt ImageViewer's IwiFile as the one .iwi authority`). Run
   the same three suites at its parent to see whether the migration introduced
   it.
3. **Why these three and not the others?** Compare the volume the failing suites
   pack (starter: 1 texture; stiff-boxes: 1 texture; box-physics: no `.iwi` asset
   on disk at all) against a passing one. `box-physics` having no source texture
   is itself a lead — it may be loading a texture the volume never carried.
4. **Chunked vs single-chunk payloads.** The `.tns` profile chunks stream payloads
   with a uniform `p` and zero filler (`tension-res/DESIGN.md`); a 1 MiB+ IWI
   spans many chunks. A read that mishandles chunk stitching would produce a
   well-formed-looking header prefix with garbage after it — consistent with what
   is observed.

## Why it was not fixed in the round that found it

The round's mandate was the gate re-run and an honest record. This defect is on
`main`, unrelated to the threading branch, and a fix belongs on a branch with its
own gate run. Guessing at it under a "make the gate green" instruction is exactly
the habituation `docs/backlog/gate-configuration-audit.md` warns about.
