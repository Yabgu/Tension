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

# Same rule as the examples' runner: when the in-tree Ogre-Next exists, the
# adapter was built against it and its libraries must win at load time.
in_tree_lib="$repo/third_party/ogre-next-install/lib"
if [ -d "$in_tree_lib" ]; then
    export LD_LIBRARY_PATH="$in_tree_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

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
"$asc" "$here/guest-jobs.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-jobs.wasm" >/dev/null ||
    fail "guest-jobs.ts did not compile"
"$asc" "$here/guest-triangle.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-triangle.wasm" >/dev/null ||
    fail "guest-triangle.ts did not compile"
"$asc" "$here/guest-motion.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-motion.wasm" >/dev/null ||
    fail "guest-motion.ts did not compile"
"$asc" "$here/guest-hierarchy.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-hierarchy.wasm" >/dev/null ||
    fail "guest-hierarchy.ts did not compile"
"$asc" "$here/guest-skinning.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-skinning.wasm" >/dev/null ||
    fail "guest-skinning.ts did not compile"
"$asc" "$here/guest-skin-matrices.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-skin-matrices.wasm" >/dev/null ||
    fail "guest-skin-matrices.ts did not compile"
"$asc" "$here/guest-skin-deform.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-skin-deform.wasm" >/dev/null ||
    fail "guest-skin-deform.ts did not compile"
"$asc" "$here/guest-skin-noskel.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-skin-noskel.wasm" >/dev/null ||
    fail "guest-skin-noskel.ts did not compile"
"$asc" "$here/guest-render-check.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-render-check.wasm" >/dev/null ||
    fail "guest-render-check.ts did not compile"
"$asc" "$here/guest-procedural.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-procedural.wasm" >/dev/null ||
    fail "guest-procedural.ts did not compile"
"$asc" "$here/guest-physics.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-physics.wasm" >/dev/null ||
    fail "guest-physics.ts did not compile"
"$asc" "$here/guest-angular.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-angular.wasm" >/dev/null ||
    fail "guest-angular.ts did not compile"
"$asc" "$here/guest-light.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-light.wasm" >/dev/null ||
    fail "guest-light.ts did not compile"
"$asc" "$here/guest-resource-errors.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-resource-errors.wasm" >/dev/null ||
    fail "guest-resource-errors.ts did not compile"

# One volume for everything the fixtures load (chunk 11): they share
# tests/resources, pack.sh packs it, and every case below hands the path in as
# the guest's own `--tns=` argument. The cases with nothing to load ignore it.
# And one volume that is deliberately not shared: resources-noskel holds the
# mesh without its .skeleton (chunk 19, 19e-b — the no-skeleton fixture).
bash "$here/pack.sh" "$here/resources" "$out/fixtures.tns" >/dev/null ||
    fail "the fixture volume did not pack"
bash "$here/pack.sh" "$here/resources-noskel" "$out/fixtures-noskel.tns" >/dev/null ||
    fail "the no-skeleton fixture volume did not pack"

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
# The diagnostic names the failure domain whichever renderer was forced:
# GL3+ fails at GLX ("Couldn't open X display"), Vulkan at its XCB support
# ("Malformed resolution string" — an empty display string).
grep -qE "Couldn.t open X display|window|VulkanXcbSupport|resolution" "$out/no-display.err" ||
    fail "no-display: the diagnostic does not name the failure"
echo "== no-display: ok — $stdout"

# Vulkan: the plugin ships with the in-tree install and loads (the adapter
# preloads glslang for it — third_party/README.md). The no-display
# environment keeps this deterministic: the plugin's XCB support fails to
# read a resolution off the empty display string, the window stage is never
# reached, and the guest is told cleanly (the same -EIO shape as the GL3+
# no-display case).
stdout=$(env -u DISPLAY -u WAYLAND_DISPLAY "$core" --capability "$dso" \
    "$out/guest-window.wasm" --renderer=vulkan --expect-fail 2>"$out/vulkan.err") ||
    fail "vulkan: the interpreter exited $? (stderr: $(cat "$out/vulkan.err"))"
echo "$stdout" | grep -q "^FAIL 0 -5" ||
    fail "vulkan: expected 'FAIL 0 -5' (no display: the plugin's XCB support refuses), got: $stdout"
grep -qiE "vulkan|resolution|display" "$out/vulkan.err" ||
    fail "vulkan: the diagnostic does not name the failure"
echo "== vulkan: ok — $stdout"

# The 3a acid test: jobs, resources, release and reuse — the guest asserts its
# own results and prints one summary line.
jobs_case() {
    name=$1
    shift
    stdout=$("$core" --capability "$dso" "$out/guest-jobs.wasm" "--tns=$out/fixtures.tns" "$@" 2>"$out/$name.err") ||
        fail "$name: the interpreter exited $? (stderr: $(tail -2 "$out/$name.err"))"
    echo "$stdout" | grep -q "^ACID 5/5 passed" ||
        fail "$name: no 'ACID 5/5 passed' (got: $(echo "$stdout" | tail -2))"
    echo "== $name: ok — $(echo "$stdout" | tail -1)"
}
jobs_case jobs --renderer=null

# Error propagation: what a guest can learn when a resource cannot load. Every
# clause polls a job's terminal state and errno, so a lost error is a failed
# clause rather than a hang — the three failures (not found, present but not a
# mesh, a renderable naming a mesh that never loaded) and one control that
# proves the refusals are specific.
resource_errors_case() {
    name=$1
    shift
    stdout=$("$core" --capability "$dso" "$out/guest-resource-errors.wasm" \
        "--tns=$out/fixtures.tns" "$@" 2>"$out/$name.err") ||
        { rc=$?; echo "$stdout" | sed 's/^/    /'; \
          fail "$name: the interpreter exited $rc (stderr: $(tail -2 "$out/$name.err"))"; }
    echo "$stdout" | sed 's/^/    /'
    echo "$stdout" | grep -qE "^OK$" ||
        fail "$name: no OK line (got: $(echo "$stdout" | tail -2))"
    echo "== $name: ok — $(echo "$stdout" | grep '^RESERR ' | tail -1)"
}
resource_errors_case resource-errors --renderer=null

# The renderer is gone: the render thread failed to start (an unknown
# TENSION_RENDERER), so no job can ever be realised again. A load queued after
# that failure must come back FAILED/-EIO rather than sit in PENDING — the case
# that used to leave the guest, and the executable, waiting forever.
stdout=$(TENSION_RENDERER=bogus "$core" --capability "$dso" \
    "$out/guest-resource-errors.wasm" "--tns=$out/fixtures.tns" \
    --renderer=gl3plus --dead-renderer 2>"$out/resource-errors-dead.err") ||
    fail "resource-errors-dead: the interpreter exited $? (stderr: $(tail -2 "$out/resource-errors-dead.err"))"
echo "$stdout" | grep -q "^RESERR 1 dead-renderer -5" ||
    fail "resource-errors-dead: no 'RESERR 1 dead-renderer -5' (got: $stdout)"
echo "== resource-errors-dead: ok — $(echo "$stdout" | grep '^RESERR ' | tail -1)"

# The 3b acid test: the scene mirror, the submission verbs, and — where there
# is a framebuffer — the pixels. Under renderer=null the first five clauses
# run and the pixel clauses are skipped (the NULL render system has no
# framebuffer to download); under GL3+ all eight do.
triangle_case() {
    name=$1
    shift
    stdout=$("$core" --capability "$dso" "$out/guest-triangle.wasm" "--tns=$out/fixtures.tns" "$@" 2>"$out/$name.err") ||
        fail "$name: the interpreter exited $? (stderr: $(tail -2 "$out/$name.err"))"
    echo "$stdout" | grep -qE "^ACID (5/5 passed \\(structural, renderer=null\\)|8/8 passed)" ||
        fail "$name: no passing ACID line (got: $(echo "$stdout" | tail -2))"
    echo "== $name: ok — $(echo "$stdout" | grep '^ACID ' | tail -1)"
    # The measured pixels, when there are any: the numbers the round reports.
    echo "$stdout" | grep '^pixels: ' | sed 's/^/== '"$name"': /' || true
}
triangle_case triangle --renderer=null

# The chunk-4 acid test: a solver steps once per renderer frame and drives the
# bodies through one submit_motion call per frame. Structural under NULL; the
# pixels and the throughput report need GL3+.
motion_case() {
    name=$1
    shift
    stdout=$("$core" --capability "$dso" "$out/guest-motion.wasm" "--tns=$out/fixtures.tns" "$@" 2>"$out/$name.err") ||
        fail "$name: the interpreter exited $? (stderr: $(tail -2 "$out/$name.err"))"
    echo "$stdout" | grep -qE "^ACID (5/5 passed \\(structural, renderer=null\\)|10/10 passed)" ||
        fail "$name: no passing ACID line (got: $(echo "$stdout" | tail -2))"
    echo "== $name: ok — $(echo "$stdout" | grep '^ACID ' | tail -1)"
    # The measured pixels and the batch's own numbers, for the round's report.
    echo "$stdout" | grep -E '^(baseline|final|report):' | sed 's/^/== '"$name"': /' || true
}
motion_case motion --renderer=null

# Chunk 5a: a child follows its parent. The adapter composes nothing — OGRE's
# scene graph does — and the pixels are what says so.
hierarchy_case() {
    name=$1
    shift
    stdout=$("$core" --capability "$dso" "$out/guest-hierarchy.wasm" "--tns=$out/fixtures.tns" "$@" 2>"$out/$name.err") ||
        fail "$name: the interpreter exited $? (stderr: $(tail -2 "$out/$name.err"))"
    echo "$stdout" | grep -qE "^ACID (5/5 passed \\(structural, renderer=null\\)|8/8 passed)" ||
        fail "$name: no passing ACID line (got: $(echo "$stdout" | tail -2))"
    echo "== $name: ok — $(echo "$stdout" | grep '^ACID ' | tail -1)"
    echo "$stdout" | grep -E '^(baseline|after):' | sed 's/^/== '"$name"': /' || true
}
hierarchy_case hierarchy --renderer=null

# Chunk 5b: a rigged mesh deforms because its bone was posed. Nothing in the
# fixture submits motion — that is the clause that makes the pixels a claim
# about skinning rather than about a moving object.
skinning_case() {
    name=$1
    shift
    stdout=$("$core" --capability "$dso" "$out/guest-skinning.wasm" "--tns=$out/fixtures.tns" "$@" 2>"$out/$name.err") ||
        fail "$name: the interpreter exited $? (stderr: $(tail -2 "$out/$name.err"))"
    echo "$stdout" | grep -qE "^ACID (6/6 passed \(structural, renderer=null\)|10/10 passed)" ||
        fail "$name: no passing ACID line (got: $(echo "$stdout" | tail -2))"
    echo "== $name: ok — $(echo "$stdout" | grep '^ACID ' | tail -1)"
    echo "$stdout" | grep -E '^(baseline|final|report):' | sed 's/^/== '"$name"': /' || true
}
skinning_case skinning --renderer=null

# The render tripwire (post-chunk-5 audit): every material kind must still put
# pixels on the screen, in its own colour. A material path that stops drawing
# is loud here — in a skinned test it would only look like a rig that did not
# move, which is exactly how a missing Hlms folder hid for two chunks.
render_check_case() {
    name=$1
    shift
    stdout=$("$core" --capability "$dso" "$out/guest-render-check.wasm" "--tns=$out/fixtures.tns" "$@" 2>"$out/$name.err") ||
        fail "$name: the interpreter exited $? (stderr: $(tail -2 "$out/$name.err"))"
    echo "$stdout" | grep -qE "^ACID (4/4 passed \(structural, renderer=null\)|6/6 passed)" ||
        fail "$name: no passing ACID line (got: $(echo "$stdout" | tail -2))"
    echo "== $name: ok — $(echo "$stdout" | grep '^ACID ' | tail -1)"
    echo "$stdout" | grep -E '^(unlit|pbs):' | sed 's/^/== '"$name"': /' || true
}
render_check_case render-check --renderer=null

# Chunk 5.5: a mesh built out of the guest's own memory, with no file involved.
procedural_case() {
    name=$1
    shift
    stdout=$("$core" --capability "$dso" "$out/guest-procedural.wasm" "$@" 2>"$out/$name.err") ||
        fail "$name: the interpreter exited $? (stderr: $(tail -2 "$out/$name.err"))"
    echo "$stdout" | grep -qE "^ACID (5/5 passed \(structural, renderer=null\)|6/6 passed)" ||
        fail "$name: no passing ACID line (got: $(echo "$stdout" | tail -2))"
    echo "== $name: ok — $(echo "$stdout" | grep '^ACID ' | tail -1)"
    echo "$stdout" | grep -E '^triangle:' | sed 's/^/== '"$name"': /' || true
}
procedural_case procedural --renderer=null

# Chunk 6: sixteen spheres in a box, and the state they settle into.
angular_case() {
    name=$1
    shift
    stdout=$("$core" --capability "$dso" "$out/guest-angular.wasm" "--tns=$out/fixtures.tns" "$@" 2>"$out/$name.err") ||
        fail "$name: the interpreter exited $? (stderr: $(tail -2 "$out/$name.err"))"
    echo "$stdout" | grep -qE "^ACID (8/8 passed \(structural, renderer=null\)|11/11 passed)" ||
        fail "$name: no passing ACID line (got: $(echo "$stdout" | tail -2))"
    echo "== $name: ok — $(echo "$stdout" | grep '^ACID ' | tail -1)"
    echo "$stdout" | grep -E '^(2 ok|5 ok|7 ok|8 ok|11 ok):' | sed 's/^/== '"$name"': /' || true
}

physics_case() {
    name=$1
    shift
    stdout=$("$core" --capability "$dso" "$out/guest-physics.wasm" "--tns=$out/fixtures.tns" "$@" 2>"$out/$name.err") ||
        fail "$name: the interpreter exited $? (stderr: $(tail -2 "$out/$name.err"))"
    echo "$stdout" | grep -qE "^ACID (9/9 passed \(structural, renderer=null\)|12/12 passed)" ||
        fail "$name: no passing ACID line (got: $(echo "$stdout" | tail -2))"
    echo "== $name: ok — $(echo "$stdout" | grep '^ACID ' | tail -1)"
    echo "$stdout" | grep -E '^(2 ok|7 ok|9 ok):' | sed 's/^/== '"$name"': /' || true
}
physics_case physics --renderer=null
angular_case angular --renderer=null

# Chunk 10: one directional light through the guest's submitLight, shading a PBS
# surface while an emissive-only surface and an Unlit one in the same frame must
# not move. Structural under NULL (the light is mirrored, the frames run); the
# halves, the profile and the byte-for-byte controls need a framebuffer.
light_case() {
    name=$1
    shift
    stdout=$("$core" --capability "$dso" "$out/guest-light.wasm" "--tns=$out/fixtures.tns" "$@" 2>"$out/$name.err") ||
        fail "$name: the interpreter exited $? (stderr: $(tail -2 "$out/$name.err"))"
    echo "$stdout" | grep -qE "^ACID (4/4 passed \(structural, renderer=null\)|9/9 passed)" ||
        fail "$name: no passing ACID line (got: $(echo "$stdout" | tail -2))"
    # The adapter's own refusals go to the session log: a light the apply path
    # could not realise is a refusal line, and no case may pass with one.
    if grep -q "refused" "$out/$name.err"; then
        fail "$name: the adapter refused something: $(grep 'refused' "$out/$name.err" | head -1)"
    fi
    echo "== $name: ok — $(echo "$stdout" | grep '^ACID ' | tail -1)"
    echo "$stdout" | grep -E '^(3 ok|5 ok|5 band|6 ok|7 ok|8 ok|9 ok):' | sed 's/^/== '"$name"': /' || true
}
light_case light --renderer=null
case_run shutdown-only "^OK shutdown-before-init" "" --shutdown-only

# Chunk 19c: a guest's skin matrices reach the subclass's shader. Windowed
# only: its clauses are pixel clauses, and the NULL renderer has no framebuffer
# to download (`grab` returns null and clause 3 fails by design).
skin_matrices_case() {
    name=$1
    shift
    stdout=$("$core" --capability "$dso" "$out/guest-skin-matrices.wasm" "--tns=$out/fixtures.tns" "$@" 2>"$out/$name.err") ||
        { echo "$stdout" | sed 's/^/    /'; \
          fail "$name: the interpreter exited $? (stderr: $(tail -2 "$out/$name.err"))"; }
    echo "$stdout" | grep -qE "^OK$" ||
        fail "$name: no OK line (got: $(echo "$stdout" | tail -2))"
    echo "== $name: ok — $(echo "$stdout" | grep '^MATRICES ' | tail -1)"
}

# Chunk 19g: skinning deforms rather than merely moving. Windowed only, like
# skin-matrices: its clauses are pixel statistics.
skin_deform_case() {
    name=$1
    shift
    stdout=$("$core" --capability "$dso" "$out/guest-skin-deform.wasm" "--tns=$out/fixtures.tns" "$@" 2>"$out/$name.err") ||
        { rc=$?; echo "$stdout" | sed 's/^/    /'; \
          fail "$name: the interpreter exited $rc (stderr: $(tail -2 "$out/$name.err"))"; }
    echo "$stdout" | sed 's/^/    /'
    echo "$stdout" | grep -qE "^OK$" ||
        fail "$name: no OK line (got: $(echo "$stdout" | tail -2))"
    echo "== $name: ok — $(echo "$stdout" | grep '^DEFORM ' | tail -1)"
}

# Chunk 19e: the no-skeleton mesh state — a mesh that links a skeleton the
# volume does not carry. Windowed only, like skin-matrices: its clauses are
# pixel counts. Two runs of the same fixture: with identity matrices (the
# mesh must be visible) and without (the state must be accepted as a stump —
# a frame, no SIGSEGV — however wrong the picture is).
noskel_case() {
    name=$1
    shift
    stdout=$("$core" --capability "$dso" "$out/guest-skin-noskel.wasm" "--tns=$out/fixtures-noskel.tns" "$@" 2>"$out/$name.err") ||
        { rc=$?; echo "$stdout" | sed 's/^/    /'; \
          fail "$name: the interpreter exited $rc (stderr: $(tail -2 "$out/$name.err"))"; }
    echo "$stdout" | sed 's/^/    /'
    echo "$stdout" | grep -qE "^OK$" ||
        fail "$name: no OK line (got: $(echo "$stdout" | tail -2))"
    echo "== $name: ok — $(echo "$stdout" | grep '^NOSKEL ' | tail -1)"
}

if [ "${TENSION_OGRE_WINDOW_TEST:-0}" = "1" ]; then
    if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
        echo "== windowed: skipped — TENSION_OGRE_WINDOW_TEST=1 but no DISPLAY or WAYLAND_DISPLAY"
    else
        # Whichever renderer the environment forced (TENSION_RENDERER), a real
        # one created the window: GL3+ by default, Vulkan when forced.
        case_run windowed "^OK " 'created (OpenGL 3+ Rendering Subsystem\|created (Vulkan Rendering Subsystem' \
            --renderer=gl3plus --frames=5
        # The real texture path: GL3+ creates a TextureGpu; the null case above
        # goes through the same code with the NULL render system.
        jobs_case jobs-gl3plus --renderer=gl3plus
        # The same error-propagation clauses on a real renderer.
        resource_errors_case resource-errors-gl3plus --renderer=gl3plus
        # And the visual tier: the same fixture with a framebuffer to read.
        triangle_case triangle-gl3plus --renderer=gl3plus
        # Chunk 4: one body for the pixel clauses, then sixty-four for the
        # batch's own numbers — the same assertions at both sizes.
        motion_case motion-gl3plus --renderer=gl3plus --bodies=1
        motion_case motion-throughput --renderer=gl3plus --bodies=64
        # Chunk 5a: the child's world position is the parent's to decide.
        hierarchy_case hierarchy-gl3plus --renderer=gl3plus
        # Chunk 5b: the rig, not the object.
        skinning_case skinning-gl3plus --renderer=gl3plus
        # Chunk 19c: the guest's matrices, through the subclass's own buffer.
        skin_matrices_case skin-matrices --renderer=gl3plus
        # Chunk 19g: the shape changes, not just the position.
        skin_deform_case skin-deform --renderer=gl3plus
        # Chunk 19e: the no-skeleton state, with matrices and without.
        noskel_case noskel-matrix --renderer=gl3plus
        noskel_case noskel-stump --renderer=gl3plus --mode=stump
        # And the tripwire, on the same window: both material kinds, in colour.
        render_check_case render-check-gl3plus --renderer=gl3plus
        # Chunk 5.5: the triangle the guest built, on a framebuffer.
        procedural_case procedural-gl3plus --renderer=gl3plus
        # Chunk 6: the pile, the floor line, and settled-versus-moving.
        physics_case physics-gl3plus --renderer=gl3plus
        angular_case angular-gl3plus --renderer=gl3plus
        # Chunk 10: the lit surface's halves, the profile, and the regression
        # clauses (an emissive-only and an Unlit surface must not move).
        light_case light-gl3plus --renderer=gl3plus
    fi
else
    echo "== windowed: skipped — set TENSION_OGRE_WINDOW_TEST=1 to open a real window"
    echo "== skin-matrices: skipped — set TENSION_OGRE_WINDOW_TEST=1 (pixel clauses need a window)"
    echo "== noskel: skipped — set TENSION_OGRE_WINDOW_TEST=1 (pixel clauses need a window)"
fi

echo "tension-ogre tests: all cases passed"
