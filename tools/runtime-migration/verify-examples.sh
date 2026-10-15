#!/usr/bin/env bash
# Example-transcript acceptance test for the runtime migration.
#
# Plan section 9's real gate: every example must produce a *byte-identical*
# transcript under `incremental` to the one it produced under `stub`.  This
# script captures transcripts; compare-runs.sh does the comparison.
#
#   bash verify-examples.sh <label> [example ...]
#
# `<label>` names the capture set (e.g. `stub`, `incremental`) and becomes part
# of each output filename.  With no examples named, the default set runs.
#
# Set RUNTIME=<rt> to pin the AssemblyScript runtime for the build.  It works by
# taking the example's own `build` script, swapping whichever `--runtime` it
# names for the requested one, running that, and then running the example with
# `--no-build` so the host-side argument composition still comes from
# run-example.mjs.  Without RUNTIME the example builds itself as it always does.
#
# That override exists because the capture must hold everything except the
# runtime constant: re-running only one side after an unrelated edit would
# compare two different trees and prove nothing.
#
# Output: $OUT_DIR/<label>-<example>.txt plus a manifest listing what ran, what
# exited non-zero, and what was skipped.  Nothing is interpreted here; the
# comparison is separate so a capture can be inspected by hand.
#
# An example is SKIPPED, not failed, when a prerequisite is absent (a model
# file, an audio device, a packed volume).  The manifest says which and why, so
# a thin run is visible rather than silently green.

set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
label=${1:?usage: verify-examples.sh <label> [example ...]}
shift || true

out=${OUT_DIR:-$here/out}
mkdir -p "$out"

# The default set: every example that runs on a bare Linux host.
#
# The six OGRE examples are NOT here.  They need the OGRE adapter to load, and on
# this host it cannot: tension-ogre/build/libtension_ogre.so -> libfreeimage.so.3
# -> libjxrglue.so.0, and the system jxrlib (Arch 1.4.4) does not export the
# WMPAlloc symbol that freeimage was built against.  That is an environment gap
# predating this work, not a property of the runtime.  OGRE guests are covered by
# verify-builds.sh (they must build) and by the deferred Windows run (which must
# reproduce their transcripts).
DEFAULT=(
  io
  log
  res
  audio
)
EXAMPLES=("$@")
[ ${#EXAMPLES[@]} -eq 0 ] && EXAMPLES=("${DEFAULT[@]}")

manifest=$out/$label.manifest.txt
: > "$manifest"
say() { echo "$@" | tee -a "$manifest"; }

say "# runtime-migration example transcripts"
say "# label   : $label"
say "# date    : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
say "# platform: $(uname -s -r -m)"
say "# node    : $(node --version 2>/dev/null || echo MISSING)"
say ""

# What runtime the generated framework config currently names.  This is the
# thing under test, so it is recorded next to the transcripts.
cfg=$root/tension-framework/build/session.asconfig.json
if [ -f "$cfg" ]; then
  say "# framework session.asconfig.json runtime: $(python3 -c "
import json,sys
print(json.load(open(sys.argv[1]))['options']['runtime'])" "$cfg" 2>/dev/null || echo unreadable)"
fi
for p in "$root"/examples/*/package.json "$root"/examples/ogre/*/package.json; do
  ex=${p#$root/examples/}; ex=${ex%/package.json}
  if grep -q -- '--runtime' "$p" 2>/dev/null; then
    say "# explicit --runtime in $ex: $(grep -o -- '--runtime [a-z]*' "$p" | sort -u | tr '\n' ' ')"
  fi
done
say ""

for ex in "${EXAMPLES[@]}"; do
  dir=$root/examples/$ex
  if [ ! -d "$dir" ]; then
    say "SKIP  $ex  (no such example)"
    continue
  fi
  if [ ! -d "$dir/node_modules" ]; then
    say "SKIP  $ex  (node_modules absent; run npm install)"
    continue
  fi

  log=$out/$label-$ex.txt
  # Example names contain a slash for the ogre ones; flatten for filenames.
  log=$out/$label-$(echo "$ex" | tr '/' '-').txt

  say "RUN   $ex  -> $log"
  # OGRE examples go headless: the migration is about the guest's memory, not
  # about a window, and a window is not available over a non-graphical session.
  # The guest's own output is unaffected by which renderer shape is chosen.
  (
    cd "$dir" || exit 1
    if [ -n "${RUNTIME:-}" ]; then
      # Build with the requested runtime, then let run-example.mjs run it
      # without rebuilding — so its argument composition is still exercised.
      # The build's own output goes to a separate log, not into the transcript:
      # it contains the runtime name and would differ by construction.
      script=$(python3 -c "
import json,sys
print(json.load(open('package.json'))['scripts']['build'])")
      patched=$(printf '%s' "$script" | sed -E "s/--runtime [a-z]+/--runtime $RUNTIME/")
      {
        echo "# build: $patched"
        eval "$patched" || echo "# BUILD FAILED"
        echo "# --- run ---"
      } > "$out/build-$label-$(echo "$ex" | tr '/' '-').log" 2>&1
      TENSION_OGRE_HEADLESS=1 timeout 300 npm start --silent -- --no-build 2>&1
    else
      TENSION_OGRE_HEADLESS=1 timeout 300 npm start --silent 2>&1
    fi
    echo "___EXIT=$?___"
  ) > "$log" 2>&1

  rc=$(sed -n 's/^___EXIT=\([0-9]*\)___$/\1/p' "$log" | tail -1)
  # drop the sentinel line from the transcript so it does not participate in
  # the byte comparison
  sed -i '/^___EXIT=[0-9]*___$/d' "$log"
  say "      exit=$rc  bytes=$(wc -c < "$log" | tr -d ' ')  lines=$(wc -l < "$log" | tr -d ' ')"
  [ "${rc:-1}" != "0" ] && say "      NON-ZERO EXIT — see $log"
done

say ""
say "# done.  compare with: bash compare-runs.sh <labelA> <labelB>"
