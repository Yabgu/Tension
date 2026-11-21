#!/bin/bash
# DL5 phase C: per conformance artifact, how many line-table rows fall outside a
# compile unit's ranges.
#
# Two steps per artifact, both cheap:
#   1. lldb runs the guest with a module-regex breakpoint as a keepalive, and the
#      extraction script writes the ELF object wasmtime handed lldb to disk.
#   2. llvm-dwarfdump reads that object's .debug_line and .debug_ranges, and the
#      containment check runs on the numbers — offline, no per-row lldb calls.
#
# The object is what lldb parses, so this is the same question lldb answers when
# it says "unable to resolve a line table file address", just asked once instead
# of 2000 times.
set -u
LLDB=/usr/sbin/lldb
REPO=/home/acakar/work/Tension
ENGINE=${TENSION_CORE:-$REPO/tension-core/target/debug/tension-core}
CONF=$REPO/tension-core/tests/programs/conformance
DBG=$REPO/tension-core/tests/programs/build/debug
OUT=${OUT:-/tmp/dl5/obj}
mkdir -p "$OUT"

for wasm in "$DBG"/*.wasm; do
  name=$(basename "$wasm" .wasm)
  cmds="$OUT/$name.cmds"
  {
    echo 'settings set plugin.jit-loader.gdb.enable on'
    echo "settings set target.debug-file-search-paths \"$CONF\""
    echo "breakpoint set -r '$name/'"
    echo 'run'
    echo "script exec(open(\"$REPO/tools/debug-conformance/dl5/extract-object.py\").read())"
    echo 'quit'
  } > "$cmds"
  ( cd "$DBG" && DL5_NAME="$name" timeout 180 "$LLDB" -b -s "$cmds" -- \
      "$ENGINE" --debug --executors 2 --symbol-path "$CONF" "$(basename "$wasm")" ) \
    > "$OUT/$name.out" 2>&1
  if [ -f "$OUT/$name.elf" ]; then echo "ok $name"; else echo "MISS $name"; fi
done
echo ALLDONE
