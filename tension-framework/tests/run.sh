#!/usr/bin/env bash
# Build the framework's fixtures and run them against tension-core.
#
# Two fixtures, one pipeline (`tension-ogre/DESIGN.md` §10):
#
#   guest-open.ts   the session runtime alone: open, close, print OK;
#   guest-ogre.ts   the capability ABI end to end: a mesh load, a JOB_DONE
#                   delivery, and a job resolved from the event;
#   guest-verlet.ts the solver capability: velocity Verlet from a guest, checked
#                   against a closed form (chunk 6a's P0, which is what settled
#                   the stale claim in `tension-solver/GUEST_ABI.md` §7);
#   guest-physics-units.ts the physics layer's pieces (8b): quaternion recovery,
#                   the impulse formula against hand computation, the bias rule,
#                   a free body's spin, the linear model's invariants, and
#                   MotionBatch.setPose's offsets.
#   guest-anim-parser.ts the animation runtime archive parser (18a): skeleton v2 and
#                   animation v7 archives parsed against expectations taken from
#                   the format's own runtime, with the three format traps checked. It
#                   needs no capability — the fixtures are compiled in, and the
#                   only host surface it touches is `print`.
#   guest-anim-eval.ts the animation evaluator: sampling, blending, local-to-model
#                   and the rest pose over the same archive fixtures, against
#                   reference values taken from the format's own runtime. A plain
#                   module like the parser — no capability needed.
#   guest-log.ts    the guest logger: every level, both `tension::io` log imports,
#                   and the UTF-8 byte-length path a non-ASCII message exercises.
#                   A plain module — the records go to the host's stderr, which
#                   the runner prints.
#   guest-callbacks.ts         the callback record as the host accepts it: a
#                   plain handler carries a zero environment word, so
#                   `makeCallbacks` takes it, and the slots an absent or
#                   present handler leaves behind are what the ABI says.
#   guest-callbacks-guard.ts   the other half: a handler carrying a non-zero
#                   environment word is refused with a named abort, because the
#                   host cannot deliver an environment to a callback it invokes
#                   itself. A refusal fixture — it aborts, and the runner checks
#                   for the guard's message rather than for `OK`.
#
# Steps, in the order the design fixes them:
#
#   1. the generator derives layout.ts and the asc flags from session.json, with
#      the layout hash `tension-core layout-hash` prints — a disagreement stops
#      the build instead of shipping a guest the host will refuse;
#   2. `asc` compiles each fixture with those flags;
#   3. `tension-core` runs them. The ogre fixture needs `--capability` pointed at
#      the stub adapter, which cargo builds into its own OUT_DIR.
#
# A fixture's contract is "prints OK, exit 0". A trap is a failure with a
# distinct signature, and so is a non-zero exit.
#
# Usage: run.sh [path-to-tension-core] [path-to-stub-adapter]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Whether a fixture's compile failed because the installed tensionscript's std
# predates 0.6.1. The missing symbol differs per fixture (`__taskResume` for the
# ones that export it, `__taskFail` for guest-drop, `__taskRegistered` for the
# creation guard), so the test is on the *shape* of the error rather than one
# name: a missing `__task*` export is the old std, and anything else is a real
# failure that must not be skipped.
old_stdlib_error() {
  grep -q "no exported member '__task" "$1" 2>/dev/null
}

root="$(cd "$here/.." && pwd)"
core="${1:-$root/../tension-core/target/debug/tension-core}"

if [ ! -x "$core" ]; then
  echo "run.sh: no interpreter at $core — build it with:" >&2
  echo "        cargo build --manifest-path $root/../tension-core/Cargo.toml --no-default-features" >&2
  exit 2
fi

# The stub adapter cargo built. `--capability` needs a path, so this looks for
# the newest one under the interpreter's target directory unless given one.
if [ $# -ge 2 ]; then
  stub="$2"
else
  stub="$(ls -t "$root"/../tension-core/target/debug/build/tension-core-*/out/libtension_ogre_stub.so 2>/dev/null | head -1 || true)"
fi
if [ -z "$stub" ] || [ ! -f "$stub" ]; then
  echo "run.sh: no ogre stub adapter found — build it with:" >&2
  echo "        cargo build --manifest-path $root/../tension-core/Cargo.toml --no-default-features" >&2
  exit 2
fi

hash="$("$core" layout-hash)"
echo "==> generating the runtime's constants (layout hash $hash)"
bash "$root/build.sh" --hash "$hash"

mkdir -p "$root/build"
run_fixture() {
  local entry="$1" out="$2"
  shift 2
  echo "==> compiling $entry"
  ( cd "$root" && ./node_modules/.bin/tensionscript "tests/$entry" \
      --config build/session.asconfig.json -o "build/$out" )
  echo "==> running $out"
  set +e
  local stdout
  stdout="$("$core" "$@" "$root/build/$out" 2>"$root/build/$out.err")"
  local status=$?
  set -e
  echo "    stdout: $stdout"
  if [ "$status" -ne 0 ]; then
    echo "run.sh: $entry: the interpreter exited $status; stderr:" >&2
    cat "$root/build/$out.err" >&2
    exit 1
  fi
  case "$stdout" in
    *OK*) echo "    == $entry: OK" ;;
    *) echo "run.sh: $entry: the guest did not print OK" >&2; cat "$root/build/$out.err" >&2; exit 1 ;;
  esac
}

# A fixture that is not a session guest: it imports nothing but `tension::io`
# (for `print`) and defines its own memory, so it is compiled without the
# session's flags and run with no capability. The host treats a module as a
# session guest only when it imports from the `session` namespace, which is the
# distinction this pair of runners makes explicit rather than accidental.
run_plain_fixture() {
  local entry="$1" out="$2"
  echo "==> compiling $entry (plain module: no session, no capability)"
  ( cd "$root" && ./node_modules/.bin/tensionscript "tests/$entry" \
      --runtime incremental --target release -o "build/$out" )
  echo "==> running $out"
  set +e
  local stdout
  stdout="$("$core" "$root/build/$out" 2>"$root/build/$out.err")"
  local status=$?
  set -e
  local line
  while IFS= read -r line; do echo "    $line"; done <<< "$stdout"
  if [ "$status" -ne 0 ]; then
    echo "run.sh: $entry: the interpreter exited $status; stderr:" >&2
    cat "$root/build/$out.err" >&2
    exit 1
  fi
  case "$stdout" in
    *OK*) echo "    == $entry: OK" ;;
    *) echo "run.sh: $entry: the guest did not print OK" >&2; cat "$root/build/$out.err" >&2; exit 1 ;;
  esac
}

# The AI stream's controls. Unlike the other session fixtures this one takes a
# *guest* argument (the model path, which the stub ignores), so it needs its own
# runner: everything before the wasm is a host flag, everything after is the
# guest's `args`. Run twice — once normally (controls 2-4: coalescing, done vs
# an empty chunk, the ring invariant) and once with the adapter stalling
# (control 1: a parked stream woken by an error post).
run_ai_fixture() {
  local mode="${1:-}" env_prefix="${2:-}"
  local args=("$root/build/guest-ai-stream.wasm" "models/unused.gguf")
  [ -n "$mode" ] && args+=("$mode")
  echo "==> running guest-ai-stream.wasm${mode:+ ($mode)}"
  set +e
  local stdout
  stdout="$(cd "$root" && env $env_prefix "$core" "${args[@]}" 2>"$root/build/guest-ai-stream.err")"
  local status=$?
  set -e
  local line
  while IFS= read -r line; do echo "    $line"; done <<< "$stdout"
  if [ "$status" -ne 0 ]; then
    echo "run.sh: guest-ai-stream ($mode): exited $status; stderr:" >&2
    cat "$root/build/guest-ai-stream.err" >&2
    exit 1
  fi
  # Every control line must have measured PASS, not merely compiled.
  if printf '%s' "$stdout" | grep -q "FAIL"; then
    echo "run.sh: guest-ai-stream ($mode): a control FAILED" >&2
    exit 1
  fi
  case "$stdout" in
    *OK*) echo "    == guest-ai-stream${mode:+ ($mode)}: OK" ;;
    *) echo "run.sh: guest-ai-stream ($mode): the guest did not print OK" >&2; exit 1 ;;
  esac
}

# A fixture whose contract is a **refusal**, not `OK`: the callback guard stops
# it before it can register a handler that carries an environment. The runner
# asserts the signature rather than the exit alone -- a non-zero exit, the
# guard's own message on stderr, and no `OK` -- because "the guest aborted" is
# only evidence when it aborted for the right reason.
run_guard_fixture() {
  local entry="$1" out="$2"
  echo "==> compiling $entry (plain module: no session, no capability)"
  ( cd "$root" && ./node_modules/.bin/tensionscript "tests/$entry" \
      --runtime incremental --target release -o "build/$out" )
  echo "==> running $out (expecting the guard's abort)"
  set +e
  local stdout
  stdout="$("$core" "$root/build/$out" 2>"$root/build/$out.err")"
  local status=$?
  set -e
  local err
  err="$(cat "$root/build/$out.err")"
  local guard_msg
  guard_msg='makeCallbacks: a handler that captures `this` cannot be called by the host'
  if [ "$status" -eq 0 ]; then
    echo "run.sh: $entry: the interpreter exited 0 — the guard did not refuse" >&2
    printf '%s\n' "$err" >&2
    exit 1
  fi
  case "$stdout" in
    *OK*) echo "run.sh: $entry: the fixture printed OK — it was supposed to be refused" >&2; exit 1 ;;
  esac
  case "$err" in
    *"$guard_msg"*) echo "    == $entry: refused by the guard (exit $status)" ;;
    *)
      echo "run.sh: $entry: the abort was not the guard's message; stderr:" >&2
      printf '%s\n' "$err" >&2
      exit 1
      ;;
  esac
}

run_fixture guest-open.ts guest-open.wasm
run_fixture guest-ogre.ts guest-ogre.wasm --capability "$stub"
run_fixture guest-verlet.ts guest-verlet.wasm
run_fixture guest-physics-units.ts guest-physics-units.wasm
run_plain_fixture guest-anim-parser.ts guest-anim-parser.wasm
run_plain_fixture guest-anim-eval.ts guest-anim-eval.wasm
run_plain_fixture guest-log.ts guest-log.wasm
run_plain_fixture guest-callbacks.ts guest-callbacks.wasm
run_guard_fixture guest-callbacks-guard.ts guest-callbacks-guard.wasm
echo "==> compiling guest-ai-stream.ts"
# Host-driven since 0.7.0d-pre: it exports `__taskWake`/`__taskResume` and lets
# the executor drive it, so it needs a std that has them. Against the published
# 0.6.0 the two controls below cannot run at all — reported as a SKIP with the
# reason, never as a pass and never as a hard failure.
if ( cd "$root" && ./node_modules/.bin/tensionscript tests/guest-ai-stream.ts \
      --config build/session.asconfig.json -o build/guest-ai-stream.wasm ) >build/guest-ai-stream.compile 2>&1; then
  run_ai_fixture "" ""
  run_ai_fixture "stall" "TENSION_AI_STUB_STALL_MS=50"
elif old_stdlib_error build/guest-ai-stream.compile; then
  echo "    == guest-ai-stream (and stall): SKIP — the installed tensionscript has no push-path std (needs >= 0.6.1)"
else
  cat build/guest-ai-stream.compile >&2
  echo "run.sh: guest-ai-stream: compile failed for a reason other than the missing std" >&2
  exit 1
fi

# The push path (0.7.0a): a guest that exports `__taskWake` and `_game_running`,
# so the host owns the loop. `--post-test-events` queues the JOB_DONE records
# before the guest runs; what this proves is the part that is new — the guest
# parks, the host matches `(family, key)` to the task id, and `__taskWake`
# resumes it, with no `__taskTick` call from the guest.
echo "==> compiling guest-push.ts"
( cd "$root" && ./node_modules/.bin/tensionscript tests/guest-push.ts \
    --config build/session.asconfig.json -o build/guest-push.wasm )
echo "==> running guest-push.wasm (host-owned loop)"
set +e
push_out="$("$core" --post-test-events "$root/build/guest-push.wasm" 2>"$root/build/guest-push.err")"
push_status=$?
set -e
while IFS= read -r line; do echo "    $line"; done <<< "$push_out"
if [ "$push_status" -ne 0 ]; then
  echo "run.sh: guest-push: exited $push_status; stderr:" >&2
  cat "$root/build/guest-push.err" >&2
  exit 1
fi
case "$push_out" in
  *"PUSH resumed with 2"*) echo "    == guest-push: OK" ;;
  *) echo "run.sh: guest-push: did not resume through __taskWake" >&2; cat "$root/build/guest-push.err" >&2; exit 1 ;;
esac

# The frame clock (0.7.0a): the guest awaits `rt.frame()`, which parks it on
# `(FRAME, 0)`. The host loop's per-iteration frame add is the only thing that
# resolves it — the guest never calls `__taskTick`, and no ring record exists
# for FRAME. The guest stops itself after three frames, so a loop that fails to
# wake it shows up as a timeout, not a hang in CI.
echo "==> compiling guest-frame.ts"
( cd "$root" && ./node_modules/.bin/tensionscript tests/guest-frame.ts \
    --config build/session.asconfig.json -o build/guest-frame.wasm )
echo "==> running guest-frame.wasm (host-owned frame loop)"
set +e
frame_out="$(timeout 60 "$core" "$root/build/guest-frame.wasm" 2>"$root/build/guest-frame.err")"
frame_status=$?
set -e
while IFS= read -r line; do echo "    $line"; done <<< "$frame_out"
if [ "$frame_status" -ne 0 ]; then
  echo "run.sh: guest-frame: exited $frame_status; stderr:" >&2
  cat "$root/build/guest-frame.err" >&2
  exit 1
fi
case "$frame_out" in
  *"FRAME loop finished after 3 frames"*) echo "    == guest-frame: OK" ;;
  *) echo "run.sh: guest-frame: the frame loop did not run to its own exit" >&2; cat "$root/build/guest-frame.err" >&2; exit 1 ;;
esac
# The early-completion table (0.7.0d-pre): `--post-test-events` queues three job
# records before the guest runs, and the guest waits two frames before parking —
# so the record it wants was published with nobody waiting. It must still be
# there when the park arrives. Without the host's table the park waits forever.
echo "==> compiling guest-early.ts"
if ! ( cd "$root" && ./node_modules/.bin/tensionscript tests/guest-early.ts \
        --config build/session.asconfig.json -o build/guest-early.wasm ) >build/guest-early.compile 2>&1; then
  if old_stdlib_error build/guest-early.compile; then
    echo "    == guest-early: SKIP — the installed tensionscript has no __taskResume (needs >= 0.6.1)"
    true
  else
    cat build/guest-early.compile >&2
    echo "run.sh: guest-early: compile failed for a reason other than the missing export" >&2
    exit 1
  fi
else
echo "==> running guest-early.wasm (host-owned loop, completion before park)"
set +e
early_out="$(timeout 60 "$core" --post-test-events "$root/build/guest-early.wasm" 2>"$root/build/guest-early.err")"
early_status=$?
set -e
while IFS= read -r line; do echo "    $line"; done <<< "$early_out"
if [ "$early_status" -ne 0 ]; then
  echo "run.sh: guest-early: exited $early_status; stderr:" >&2
  cat "$root/build/guest-early.err" >&2
  exit 1
fi
case "$early_out" in
  *"EARLY resumed with 6"*) echo "    == guest-early: OK" ;;
  *) echo "run.sh: guest-early: a completion published before the park was lost" >&2; cat "$root/build/guest-early.err" >&2; exit 1 ;;
esac
fi

# The synchronous async function (0.7.0): a task that never parks. The entry
# claims its slot, the body runs inside its own entry, the terminal frees the
# slot — and the caller's `await` falls through on the already-settled record.
# A four-slot table against twelve tasks is what makes a leaked slot visible: the
# fifth would be refused and return 0, and the sum would be short.
echo "==> compiling guest-sync.ts"
if ! ( cd "$root" && ./node_modules/.bin/tensionscript tests/guest-sync.ts \
        --config build/session.asconfig.json -o build/guest-sync.wasm ) >build/guest-sync.compile 2>&1; then
  if old_stdlib_error build/guest-sync.compile; then
    echo "    == guest-sync: SKIP — the installed tensionscript has no creation guard (needs >= 0.6.1)"
    true
  else
    cat build/guest-sync.compile >&2
    echo "run.sh: guest-sync: compile failed for a reason other than the missing guard" >&2
    exit 1
  fi
else
echo "==> running guest-sync.wasm (host-owned loop, no park at all)"
set +e
sync_out="$(timeout 60 "$core" --post-test-events "$root/build/guest-sync.wasm" 2>"$root/build/guest-sync.err")"
sync_status=$?
set -e
while IFS= read -r line; do echo "    $line"; done <<< "$sync_out"
if [ "$sync_status" -ne 0 ]; then
  echo "run.sh: guest-sync: exited $sync_status; stderr:" >&2
  cat "$root/build/guest-sync.err" >&2
  exit 1
fi
case "$sync_out" in
  *"SYNC 12 synchronous awaits summed 504"*) echo "    == guest-sync: OK" ;;
  *) echo "run.sh: guest-sync: the synchronous path did not complete" >&2; cat "$root/build/guest-sync.err" >&2; exit 1 ;;
esac
fi

# The refused-creation path (0.7.0d-pre): a two-slot table, two tasks holding
# both slots, and a third created while they do. Capacity bounds *live* tasks
# (the slot is claimed at creation), so the third is settled with -ENOSPC before
# its body runs — a refusal with an id, not a park with nowhere to go.
echo "==> compiling guest-enospc.ts"
if ! ( cd "$root" && ./node_modules/.bin/tensionscript tests/guest-enospc.ts \
        --config build/session.asconfig.json -o build/guest-enospc.wasm ) >build/guest-enospc.compile 2>&1; then
  if old_stdlib_error build/guest-enospc.compile; then
    echo "    == guest-enospc: SKIP — the installed tensionscript has no creation guard (needs >= 0.6.1)"
    true
  else
    cat build/guest-enospc.compile >&2
    echo "run.sh: guest-enospc: compile failed for a reason other than the missing guard" >&2
    exit 1
  fi
else
echo "==> running guest-enospc.wasm (host-owned loop, refused creation)"
set +e
enospc_out="$(timeout 60 "$core" --post-test-events "$root/build/guest-enospc.wasm" 2>"$root/build/guest-enospc.err")"
enospc_status=$?
set -e
while IFS= read -r line; do echo "    $line"; done <<< "$enospc_out"
if [ "$enospc_status" -ne 0 ]; then
  echo "run.sh: guest-enospc: exited $enospc_status; stderr:" >&2
  cat "$root/build/guest-enospc.err" >&2
  exit 1
fi
case "$enospc_out" in
  *"ENOSPC third task settled with -28"*) echo "    == guest-enospc: OK" ;;
  *) echo "run.sh: guest-enospc: a refused task creation was not answered with -ENOSPC" >&2; cat "$root/build/guest-enospc.err" >&2; exit 1 ;;
esac
fi

# The chained await (0.7.0): a task parked on another *suspending guest task's*
# record. No producer key, so the host never hears of it — the guest's own
# completion has to wake it. This is the shape that deadlocked when `wake`
# filtered on `slot >= 0`; the fixture prints "got 7" only if the waiter ran.
echo "==> compiling guest-chain.ts"
if ! ( cd "$root" && ./node_modules/.bin/tensionscript tests/guest-chain.ts \
        --config build/session.asconfig.json -o build/guest-chain.wasm ) >build/guest-chain.compile 2>&1; then
  if old_stdlib_error build/guest-chain.compile; then
    echo "    == guest-chain: SKIP — the installed tensionscript has no push-path std (needs >= 0.6.1)"
    true
  else
    cat build/guest-chain.compile >&2
    echo "run.sh: guest-chain: compile failed for a reason other than the missing std" >&2
    exit 1
  fi
else
echo "==> running guest-chain.wasm (host-owned loop, waiter on a guest record)"
set +e
chain_out="$(timeout 60 "$core" "$root/build/guest-chain.wasm" 2>"$root/build/guest-chain.err")"
chain_status=$?
set -e
while IFS= read -r line; do echo "    $line"; done <<< "$chain_out"
if [ "$chain_status" -ne 0 ]; then
  echo "run.sh: guest-chain: exited $chain_status; stderr:" >&2
  cat "$root/build/guest-chain.err" >&2
  exit 1
fi
case "$chain_out" in
  *"CHAIN outer: got 7"*) echo "    == guest-chain: OK" ;;
  *) echo "run.sh: guest-chain: the waiter on a guest task's record never resumed" >&2; cat "$root/build/guest-chain.err" >&2; exit 1 ;;
esac
fi

# The drop path (0.7.0c): a record the sub-ring refuses must wake its parked
# task with -EIO, not leave it parked. `--post-test-events` queues three job
# records; the guest opens a two-slot ring with no callbacks, so the third is
# dropped by the session, and it parks on exactly that record (job 5). Only the
# host-side fail path can resume it.
echo "==> compiling guest-drop.ts"
# The fixture needs std's `__taskFail`, which lands with 0.6.1. Until the
# dependency floor moves (0.7.0d's release), a tree built against the published
# 0.6.0 cannot compile it: reported as a SKIP naming the reason, never as a pass.
if ! ( cd "$root" && ./node_modules/.bin/tensionscript tests/guest-drop.ts \
        --config build/session.asconfig.json -o build/guest-drop.wasm ) >build/guest-drop.compile 2>&1; then
  if old_stdlib_error build/guest-drop.compile; then
    echo "    == guest-drop: SKIP — the installed tensionscript has no __taskFail (needs >= 0.6.1)"
    echo "==> checking guest-log's records (trace)"
    true
  else
    cat build/guest-drop.compile >&2
    echo "run.sh: guest-drop: compile failed for a reason other than the missing export" >&2
    exit 1
  fi
else
echo "==> running guest-drop.wasm (host-owned loop, forced drop)"
set +e
drop_out="$(timeout 60 "$core" --post-test-events "$root/build/guest-drop.wasm" 2>"$root/build/guest-drop.err")"
drop_status=$?
set -e
while IFS= read -r line; do echo "    $line"; done <<< "$drop_out"
if [ "$drop_status" -ne 0 ]; then
  echo "run.sh: guest-drop: exited $drop_status; stderr:" >&2
  cat "$root/build/guest-drop.err" >&2
  exit 1
fi
case "$drop_out" in
  *"DROP woke with status -5"*) echo "    == guest-drop: OK" ;;
  *) echo "run.sh: guest-drop: a lost completion did not wake with -EIO" >&2; cat "$root/build/guest-drop.err" >&2; exit 1 ;;
esac
fi

echo "==> checking guest-log's records (trace)"
# The compiled fixture's records must reach the host's layout and filter: at
# `trace` every level is present, the structured payload lands in the message
# slot, and a non-ASCII message is whole — which is what pins the UTF-8
# byte-length path in `assembly/io.ts` (a UTF-16 length would truncate it).
trace_err="$("$core" --log-level=trace "$root/build/guest-log.wasm" 2>&1 >/dev/null || true)"
for needle in \
  "TRACE game: trace:" \
  "DEBUG game: debug:" \
  "WARN  game: warn" \
  "FATAL game: fatal" \
  'INFO  game: {"tick":1,"ready":true}' \
  "unicode: héllo wörld ✓"; do
  case "$trace_err" in
    *"$needle"*) : ;;
    *)
      echo "run.sh: guest-log: no record containing: $needle" >&2
      printf '%s\n' "$trace_err" >&2
      exit 1
      ;;
  esac
done
echo "    == guest-log records: OK"
echo "==> all fixtures OK"
