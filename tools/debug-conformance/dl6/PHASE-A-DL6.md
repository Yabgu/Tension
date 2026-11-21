# Phase A — the A/B that settles DL5's claim

## What was claimed

DL5's report said: *"`wrong-line` is 0 — `class_method` passes on a capable
engine WITHOUT DL3's patch"*, and treated the patch as redundant on Linux.

That could not have been true. Every artifact DL5 measured was built at
`a82c1536`, and `a82c1536` is a child of `fix/dwarf-conformance` @ `6424085e`
plus the cherry-picked patch `0f771d74`. Both of DL5's "capable engine" runs
therefore measured a **patched** compiler. There was no unpatched reference.

## The A/B

| side | commit | `dist/assemblyscript.js` sha256 |
|---|---|---|
| unpatched | `41b8721b` (`main`, detached worktree `~/work/TensionScript-a2-main`) | `66e6932e6d0621f63be0d085d4ff83b35ca5d639341d0f54fdf5bbc275bbd9de` |
| patched | `a82c1536` (`fix/dwarf-prologue`) | `6202020ea805f88079f110c41be7ed20d3663a0b7614fc3e9718ff61409ed827` |

The two differ, so the experiment happened. `dist/asc.js` is byte-identical on
both sides (`cc8f13ff…`) — hashing it would have "proved" the wrong thing, which
is the trap the brief names.

Both sides were installed into `Tension/node_modules/@yabgu_gm/tensionscript/dist/`
and the 24 artifacts rebuilt with `--force`; the sha256 of the installed
`assemblyscript.js` was printed by each run (see the tables above) and the
resulting artifact hashes are in `artifacts-unpatched.sha256` and
`artifacts-a82c1536.sha256` — **all 24 differ**, which is the second proof the
compiler changed.

Engine: `tension-core/target/release/tension-core`, rebuilt 2026-11-21T22:14,
`async backend: continuations`, `stale: false`. `--workers 8`.

## Result

    unpatched  41b8721b    59 pass / 17 no-source / 6 wrong-line     (23 fail)
    patched    a82c1536    71 pass / 11 no-source / 0 wrong-line     (11 fail)

**12 cases differ, and every one of them is a failure → pass:**

| case | unpatched | patched |
|---|---|---|
| `async_statement_before_await` | wrong-line (12, expected 11) | pass |
| `class_method` | wrong-line (14, expected 13) | pass |
| `schedule_order.transcript#1` | wrong-line (148, expected 147) | pass |
| `schedule_order.transcript#3` | wrong-line (155, expected 154) | pass |
| `schedule_order.transcript#5` | wrong-line (162, expected 161) | pass |
| `schedule_order.transcript#7` | wrong-line (169, expected 168) | pass |
| `main_policy.transcript#1` | no-source | pass |
| `fallback_loop.transcript#1` | no-source | pass |
| `main_step_replaced.transcript#1` | no-source | pass |
| `schedule_order.transcript#9` | no-source | pass |
| `thread_count.transcript#1` | no-source (stopped at 78) | pass |
| `spawn_refusals.transcript#1` | no-source | pass |

No pass regressed.

## Verdict

**DL5's claim is withdrawn.** `class_method` is `wrong-line` unpatched and
`pass` patched: the patch is load-bearing, and by twelve cases rather than the
one DL3 measured.

The 6 `wrong-line` cases are all off by exactly one line, which is the
slide-forward signature W3 described: with nothing flagged
`DW_LNS_set_prologue_end`, the row naming the first statement of a function is
treated as prologue and lldb moves the breakpoint to the next row naming a
different line. All 6 are a first statement of some function.

The unpatched baseline is therefore **59 / 17 / 6**, not DL5's 71 / 11. Every
"recovered" number in DL5's report is a patched-compiler number.

## Reproducing it

```bash
# the unpatched reference compiler, without touching the working tree
cd ~/work/TensionScript-a2
git worktree add ../TensionScript-a2-main 41b8721b --detach
cd ../TensionScript-a2-main
ln -s ../TensionScript-a2/node_modules node_modules
ln -s ../TensionScript-a2/third_party/binaryen-out third_party/binaryen-out
cp ../TensionScript-a2/dist/binaryen.js dist/binaryen.js
PATH=$HOME/emsdk:$HOME/emsdk/upstream/emscripten:$PATH node scripts/build
sha256sum dist/assemblyscript.js          # 66e6932e…

# install it, rebuild the 24 debug artifacts, run the 82 cases
cd ~/work/Tension
cp ../TensionScript-a2-main/dist/*.js ../TensionScript-a2-main/dist/*.json \
   node_modules/@yabgu_gm/tensionscript/dist/
TENSIONSCRIPT=$PWD/node_modules/@yabgu_gm/tensionscript/bin/tensionscript.js \
  node scripts/build-test-programs.mjs --debug --force
TENSION_CORE=tension-core/target/release/tension-core \
  node tools/debug-conformance/runner.js --no-build --workers 8 \
  --json tools/debug-conformance/dl6/ab-unpatched.json
```

`third_party/binaryen-out` is 1.4 GB and built out of tree, so the worktree
points at the main checkout's copy rather than rebuilding it. The worktree was
removed after the measurement; the recipe above is the whole of it.
