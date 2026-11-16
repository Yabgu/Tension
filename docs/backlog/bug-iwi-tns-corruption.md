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

---

# Correction, same day: this is the stale DSO, not an in-core defect

**Status changed: WITHDRAWN as an in-core `.tns`/`decode_iwi` defect.** The
symptom was real; the attribution above was wrong. Recorded rather than deleted,
because a wrong diagnosis in the record is itself a datum.

## What the re-run showed

After the fix that rebuilt the DSO, the full gate went from **22/26 to 25/26**,
and the three suites named above — `box-physics`, `stiff-boxes`,
`starter template` — **all passed**, without any change to `tension-core`. Since
the decoder was not touched, "the in-core decoder is broken" cannot be the
explanation, and a passing suite is not evidence that it was ever true.

## The mechanism, established

Two facts chain it:

1. **The stale DSO predates the IWI authority migration.** It was built
   2026-11-09 23:26; `5b1a171` (*"adopt ImageViewer's IwiFile as the one .iwi
   authority"*) landed **2026-11-15 18:51**. So that artifact contains the
   *pre-adoption* C++ IWI reader, not ImageViewer's.
2. **That pre-adoption reader carried this exact message.** At `5b1a171^`,
   `tension-2d/reference/texture.cpp` matches `3- and 4-component` — the string
   this entry was built around. It is not Rust-only after all; it was moved from
   C++ to Rust by the migration, and both spellings existed in the tree's history.

So the suites were refusing valid IWIs **inside the stale DSO**, via the old C++
reader, and the refusal text was identical to the in-core one because the in-core
one was ported from it.

## Why the first run used the DSO and the second did not

The example suites' `findCore()` (`examples/2d/*/test.mjs`) prefers the **release**
profile and falls back to debug:

```
for (const profile of ['release', 'debug']) { ... }
```

- **First run:** no release binary existed. The debug binary is built by the gate's
  `Preparing` step with `--no-default-features`, i.e. **without** the in-core 2D
  renderer, so `--capability <stale DSO>` was genuinely loaded and its old reader
  refused the file.
- **Second run:** a release binary existed (built during the env-var work, with
  `render2d-core`). It was preferred, the in-core renderer answered
  `tension::2d` itself, the DSO was skipped, and the current reader accepted the
  files. Confirmed independently: with the DSO removed from disk entirely,
  `box-physics` still passes against the debug binary that carries the in-core
  renderer.

**This is a gate-reproducibility defect in its own right**, and a new shape:
*whether a 2D example suite exercises the in-core renderer or a DSO depends on
which cargo profile happens to exist in `target/`.* Two runs of one unchanged tree
can therefore disagree on the renderer under test. Filed as **gate finding 11** in
`docs/backlog/gate-configuration-audit.md`.

## What this entry is now

- **Not** an in-core decoder defect. Nothing in `tension-core/src/render2d/iwi.rs`
  needs changing on the evidence available.
- **A second instance of finding 8** (a stale artifact silently preferred), reached
  through a different door: the DSO was loaded not by `TENSION_2D_LIB` but by the
  example suites' own `existsSync` test.
- The finding-8 fix closes the `test-framework` path; the example suites'
  `capabilityArgs = existsSync(dso) ? ['--capability', dso] : []` has **no**
  staleness check and is the remaining hole of the same shape. Proposed: the same
  rule, applied there — refuse a DSO older than the sources it was built from, and
  prefer the in-core renderer when the binary carries it.
