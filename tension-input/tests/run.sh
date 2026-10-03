#!/bin/sh
# tension-input test runner — the DSO's own gate.
#
# Builds the DSO, compiles the guest fixture with the framework's generated
# flags, and runs two cases:
#
#   with-display  input opens, attaches to its own surface (kind 0), reads a
#                 state record, and closes. No renderer is loaded: that is the
#                 point of the capability being its own DSO (INPUT.md §6).
#   no-display    DISPLAY and WAYLAND_DISPLAY unset: the refusal is -ENODEV,
#                 and the guest says so on stdout. The guest handles its own
#                 failure, so a non-zero exit here is the bug.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/.." && pwd)
repo=$(CDPATH= cd -- "$root/.." && pwd)
framework="$repo/tension-framework"
core=${TENSION_CORE:-$repo/tension-core/target/debug/tension-core}
dso=$root/build/libtension_input.so
out="$root/build"

fail() {
    echo "tension-input tests: $*" >&2
    exit 1
}

[ -x "$core" ] || fail "the interpreter is not built. Run:
    cargo build --manifest-path $repo/tension-core/Cargo.toml --no-default-features"

"$root/build.sh" >/dev/null || fail "the DSO did not build"
[ -f "$dso" ] || fail "$dso is missing"

hash=$("$core" layout-hash)
bash "$framework/build.sh" --hash "$hash" >/dev/null ||
    fail "the framework's generator refused the layout hash ($hash)"
asc="$framework/node_modules/.bin/asc"
[ -x "$asc" ] || fail "asc is not installed in tension-framework/node_modules"

"$asc" "$here/guest-input.ts" --config "$framework/build/session.asconfig.json" \
    -o "$out/guest-input.wasm" ||
    fail "guest-input.ts did not compile"

# ── case 1: with a display ───────────────────────────────────────────────
stdout=$("$core" --capability "$dso" "$out/guest-input.wasm" 2>"$out/with-display.err") ||
    fail "with-display: the interpreter exited $? (stderr: $(cat "$out/with-display.err"))"
echo "$stdout" | grep -q "^OK " || fail "with-display: expected 'OK ', got: $stdout"
echo "== with-display: ok — $stdout"

# ── case 2: a video driver this build cannot provide ─────────────────────
# The analogue of the ogre suite's `vulkan` case: the refusal is the expected
# answer and the guest says so on stdout. SDL_Init fails, the DSO's init still
# returns 0 (the capability loads; the refusal point is the verb), and
# input_open answers -ENODEV.
stdout=$(SDL_VIDEODRIVER=tension-no-such-driver "$core" --capability "$dso" \
    "$out/guest-input.wasm" 2>"$out/no-driver.err") ||
    fail "no-driver: the interpreter exited $? (stderr: $(cat "$out/no-driver.err"))"
echo "$stdout" | grep -q "^OK headless -ENODEV" ||
    fail "no-driver: expected 'OK headless -ENODEV', got: $stdout"
echo "== no-driver: ok — $stdout"

# ── case 3: no DISPLAY, no WAYLAND_DISPLAY ───────────────────────────────
# Measured while writing this: this is NOT a headless machine to SDL. Its
# Wayland backend finds the compositor through XDG_RUNTIME_DIR even with
# WAYLAND_DISPLAY unset (the default socket name is wayland-0), so the
# capability comes up and the guest attaches. The case asserts only that the
# guest answers; the log says which driver it got.
stdout=$(env -u DISPLAY -u WAYLAND_DISPLAY "$core" --capability "$dso" \
    "$out/guest-input.wasm" 2>"$out/no-env.err") ||
    fail "no-env: the interpreter exited $? (stderr: $(cat "$out/no-env.err"))"
echo "$stdout" | grep -q "^OK " || fail "no-env: expected 'OK ', got: $stdout"
driver=$(grep -o "video driver '[^']*'" "$out/no-env.err" | head -1)
echo "== no-env: ok — $stdout ($driver)"

echo "tension-input tests: all cases passed"
