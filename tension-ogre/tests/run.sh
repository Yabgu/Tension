#!/bin/sh
# tension-ogre test runner — the hello-window gate.
#
# Builds the adapter (backend=ogre by default), compiles the guest fixture with
# the framework's own generated flags, and runs the cases:
#
#   headless      renderer=null     the CI gate: a real NULL render system, a
#                                   real window object, no display needed
#   no-display    renderer=gl3plus  DISPLAY unset: the caught-exception path
#   vulkan        renderer=vulkan   a renderer this build cannot provide
#   shutdown-only ogre::shutdown before any init
#   windowed      renderer=gl3plus  opt-in, opens a real window:
#                                   TENSION_OGRE_WINDOW_TEST=1 ./tests/run.sh
#
# Every case must exit 0: the guest is expected to handle its own failures
# (`--expect-fail`) and say so on stdout, so a non-zero exit here is the bug.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/.." && pwd)
repo=$(CDPATH= cd -- "$root/.." && pwd)
framework="$repo/tension-framework"
core=${TENSION_CORE:-$repo/tension-core/target/debug/tension-core}
dso=${TENSION_OGRE_DSO:-$root/build/libtension_ogre.so}
out="$root/build"

fail() {
    echo "tension-ogre tests: $*" >&2
    exit 1
}

[ -x "$core" ] || fail "the interpreter is not built. Run:
    cargo build --manifest-path $repo/tension-core/Cargo.toml --no-default-features"

# ── the adapter ──────────────────────────────────────────────────────────
TENSION_OGRE_BACKEND=${TENSION_OGRE_BACKEND:-ogre}
export TENSION_OGRE_BACKEND
"$root/build.sh" >/dev/null || fail "the adapter did not build"
[ -f "$dso" ] || fail "$dso is missing"

# ── the guest's flags come from the framework's generator ────────────────
# One source of truth for the memory relation: the same session.asconfig.json
# every other guest is compiled with, regenerated against this interpreter's
# layout hash.
hash=$("$core" layout-hash)
bash "$framework/build.sh" --hash "$hash" >/dev/null ||
    fail "the framework's generator refused the layout hash ($hash)"
asc="$framework/node_modules/.bin/asc"
[ -x "$asc" ] || fail "asc is not installed in tension-framework/node_modules"

"$asc" "$here/guest-window.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-window.wasm" >/dev/null ||
    fail "guest-window.ts did not compile"

# ── the cases ────────────────────────────────────────────────────────────

# case <name> <expected-stdout-substring> <expected-stderr-substring-or-empty> [args...]
case_run() {
    name=$1
    want_out=$2
    want_err=$3
    shift 3
    stdout=$("$core" --capability "$dso" "$out/guest-window.wasm" "$@" 2>"$out/$name.err") ||
        fail "$name: the interpreter exited $? (stderr: $(cat "$out/$name.err"))"
    echo "$stdout" | grep -qE "$want_out" ||
        fail "$name: stdout has no '$want_out' (got: $stdout)"
    if [ -n "$want_err" ]; then
        grep -q "$want_err" "$out/$name.err" ||
            fail "$name: stderr has no '$want_err'"
    fi
    echo "== $name: ok — $stdout"
}

case_run headless "^OK " 'window "Tension" 1280x720 created' --renderer=null --frames=3

# No display at all: GL3+ throws on the X connection, the backend catches it,
# and the guest is told which stage failed. Before the catch this aborted the
# process with a core dump (DESIGN.md §8.1).
stdout=$(env -u DISPLAY -u WAYLAND_DISPLAY "$core" --capability "$dso" \
    "$out/guest-window.wasm" --renderer=gl3plus --expect-fail 2>"$out/no-display.err") ||
    fail "no-display: the interpreter exited $? (stderr: $(cat "$out/no-display.err"))"
echo "$stdout" | grep -q "^FAIL 0 -5" ||
    fail "no-display: expected 'FAIL 0 -5' (plugin stage: GLX init runs at plugin install), got: $stdout"
grep -q "Couldn.t open X display\|window" "$out/no-display.err" ||
    fail "no-display: the diagnostic does not name the failure"
echo "== no-display: ok — $stdout"

case_run vulkan "^FAIL 0 -38" "" --renderer=vulkan --expect-fail
case_run shutdown-only "^OK shutdown-before-init" "" --shutdown-only

if [ "${TENSION_OGRE_WINDOW_TEST:-0}" = "1" ]; then
    if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
        echo "== windowed: skipped — TENSION_OGRE_WINDOW_TEST=1 but no DISPLAY or WAYLAND_DISPLAY"
    else
        case_run windowed "^OK " "created (OpenGL 3+ Rendering Subsystem)" \
            --renderer=gl3plus --frames=5
    fi
else
    echo "== windowed: skipped — set TENSION_OGRE_WINDOW_TEST=1 to open a real window"
fi

echo "tension-ogre tests: all cases passed"
