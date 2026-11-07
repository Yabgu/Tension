# Guard discipline — checks that establish correctness, not presence

Promoted from `docs-contradictions.md` because the instance list is longer than
an entry should be. This is a class-level defect, not a bug report.

## The rule

> **A guard must derive its expected value from the single source of truth and
> compare.** `existsSync`, presence checks, and hardcoded literals that mirror a
> source all fail silently the moment the source moves.

The source of truth is whichever file the consumer is actually compiled or run
against:

| what is being checked | source of truth |
| --- | --- |
| `tensionscript` version | `tension-framework/package.json` + `package-lock.json` |
| Ogre-Next build flags | `third_party/ogre-next-build/CMakeCache.txt` |
| adapter ABI version | `tension-core/include/tension_adapter.h` |
| binary freshness | `packages/build-stamp.json` via `scripts/build-stamp.mjs` |
| Win32 overlay symbols | `CMake/Templates/OgreVulkanBuildSettings.h.in` |

A guard that asks "does this exist?" answers a question nobody asked. The
question is always "is this the one the build expects?".

## Why it matters more than an ordinary bug

Every instance below produced a *green* signal while the tree was wrong. A
presence check cannot fail loudly, because the condition it tests — something is
there — is almost always true after the first successful build. The failure
surfaces later, in a different component, with a symptom that names the wrong
subsystem.

## Instances

### 1. `scripts/bootstrap.mjs:229-234` — install presence, not flag divergence

`let installed = mediaOk && mainLib !== ''` decides "nothing to do" from whether
an Ogre-Next install exists. A change to `OGRE_CONFIG_ENABLE_FREEIMAGE` (or any
other configure flag) does not invalidate it, so the old install is kept and the
new flag is silently ignored.

Observed: `npm run bootstrap` reported "already exists — nothing to do", exit 0,
while `CMakeCache.txt` still said `OGRE_CONFIG_ENABLE_FREEIMAGE:BOOL=ON` and the
installed `RenderSystem_Vulkan.so.4.0` still listed `NEEDED libfreeimage.so.3`.
Documented as `docs-contradictions.md` #6.

*Correction:* stamp the configure flag set beside the install (the way
`writeStamp` already works for the adapters) and reconfigure on divergence.

### 2. `scripts/build-framework.mjs:46` — compiler exists, not declared version

```js
if (!existsSync(compiler)) { npm(['install', ...]); }
```

A stale `tensionscript` satisfies this forever.

Observed: `@acakar/tensionscript 0.7.1` installed 2026-10-21, while
`package.json` declared `@yabgu_gm/tensionscript@^0.13.2` and the lock had
recorded 0.13.2 since 2026-11-04. The facade's source began using `@managed`
struct field defaults on 2026-10-23, which 0.7.1 rejects with
`TS1109: Expression expected` and `TS1206: Decorators are not valid here`. 40
parse errors per example, 4 of 18 examples failing, and the Ogre guest fixtures
unbuildable — all from a two-month-old binary. Cleared by one `npm install`.

### 3. `scripts/build-examples.mjs:126` — dependency link exists, not version

```js
const wired = existsSync(join(dir, 'node_modules', '@yabgu_gm', 'tension-core'));
if (!wired) { npm(['install', ...]); }
```

The comment above it shows the author was reaching for this exact distinction —
"a tree installed before these packages existed has a node_modules and no link
to them" — but checks the link's existence rather than its version. Same defect
as #2, one level down: a tree with the package present at the wrong version
passes.

### 4-8. Test scripts check binaries by existence, not freshness

`scripts/build-stamp.mjs` exists precisely to answer "was this binary built from
the current sources", and `scripts/run-example.mjs:35` is the one caller of
`staleness()`. Every test script instead does `existsSync`:

- `scripts/test-ozz.mjs:27` (core binary), `:31` (adapter), `:45` (compiler)
- `scripts/test-ogre.mjs:37` (core), `:44`/`:49` (DSO), `:103` (compiler)
- `scripts/test-input.mjs:93` (compiler)
- `scripts/test-input-edge.mjs:47-48` (compiler — no guard at all: it spawns
  whatever `npmBin()` returned, so an absent compiler is a spawn error rather
  than a clear message)
- `scripts/test-framework.mjs`, `scripts/test-2d.mjs`, `scripts/run-2d-example.mjs`
  (same shape)

A stale binary passes every one of them. That is how an adapter built against
adapter ABI 5 kept being loaded by a host at ABI 6 during the v6 work — it was
caught only because the DSO's own version check refused it at `dlopen`, which is
the *right* kind of guard arriving by luck.

### 9. ABI version mirrored as literals in three tests

`tension-core/tests/ogre_smoke.rs:306`, `tension-core/tests/session_smoke.rs:192`,
and `tension-core/tests/ogre_surface.rs` each held `TENSION_ADAPTER_ABI_VERSION`
as a number. All three said `5` after the ABI became `6`. `ogre_smoke`'s
assertion compared against the literal, so it tested the number rather than the
stub, under a comment claiming it tested "the current ABI".

Fixed in `f812072`: all three now parse `#define TENSION_ADAPTER_ABI_VERSION`
out of `tension-core/include/tension_adapter.h`, following the pattern
`framework_layout.rs` already used for `TENSION_ADAPTER_LAYOUT_HASH`.

## Guards in this tree that are already correct, and why

Worth naming so the shape is copyable:

- `scripts/check-win32-headers.mjs` — compares the overlay's symbol set against
  the upstream template **in both directions** and fails on drift either way.
  Derives, does not restate.
- `scripts/build-native.mjs` `auditLinkage()` — reads `ldd`/`readelf` output from
  the built artifact rather than trusting the build's exit code.
- `scripts/build-native.mjs` `auditSdlSourceReferences()` / `auditSdlLinkage()` —
  scan the actual tree and the actual ELF `NEEDED` lists.
- `framework_layout.rs` — parses the layout hash from the header.
- `tension-2d/src/adapter.cpp:412` — checks `core->abi_version` at load. It did
  not, until ABI v6; the omission is what made a stale 2D DSO undetectable.

## Applying the rule

For a **version**: read both sides and compare. Never `existsSync`.
For a **flag set**: read the generated config (`CMakeCache.txt`,
`OgreBuildSettings.h`) and compare against what the script passes.
For a **binary**: call `staleness()` from `build-stamp.mjs`.
For a **mirrored constant**: parse the source of truth at test time.

If a guard cannot derive the expected value, it is not a guard — it is a
comment that runs.
