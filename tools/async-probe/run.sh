#!/bin/sh
# Reproduce every measurement in AP1-REPORT.md from the committed probe sources.
#
#   sh tools/async-probe/run.sh > transcript.txt
#
# Builds land under $AP1_OUT (default /tmp/ap1); nothing is written inside the
# repository. The compiler is the dist installed at
# node_modules/@yabgu_gm/tensionscript — set explicitly as $TENSIONSCRIPT
# because this checkout's declared pin tarball is not on the machine
# (AP1-REPORT.md §1).
set -u

REPO=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${AP1_OUT:-/tmp/ap1}
cd "$REPO" || exit 1

CORE=$REPO/tension-core/target/release/tension-core
DIST=$REPO/node_modules/@yabgu_gm/tensionscript
SCRIPT=$REPO/scripts/tensionscript.mjs
export TENSIONSCRIPT=$DIST/bin/tensionscript.js

mkdir -p "$OUT/promise"
# `promise-main-framework.ts` resolves `tension-framework` the way the example
# does — through a node_modules directory above the source file. Built from a
# scratch directory with that directory linked in, so no file is added to
# examples/async-on-main.
ln -sfn "$REPO/examples/async-on-main/node_modules" "$OUT/promise/node_modules"

say() { printf '\n== %s\n' "$*"; }

say "engine"
printf '  %s\n' "$("$CORE" --help 2>&1 | grep 'async backend')"
printf '  %s\n' "$(ls -l --time-style=+%F_%T "$CORE" | awk '{print $5" B  "$6}')"

say "C — shared memory, atomics and a worker thread (Linux, --executors 2)"
"$CORE" --executors 2 tools/async-probe/programs/shared-probe.wat 2>&1 | grep -v 'INFO  core: res:'

say "C — the same guest with no pool (--executors 0, the default)"
"$CORE" tools/async-probe/programs/shared-probe.wat 2>&1 | grep -v 'INFO  core: res:'

build() { # build <source> <out> [extra flags…]
  src=$1; out=$2; shift 2
  cp "tools/async-probe/programs/$src" "$OUT/promise/$src"
  ( cd "$OUT/promise" && node "$SCRIPT" "$src" -o "$out" \
      --runtime incremental --target release --exportStart __start "$@" ) >/dev/null 2>&1
  printf '  %-26s %s\n' "$out" \
    "$(wasm-tools print "$OUT/promise/$out" 2>/dev/null | grep -oE 'export "[a-zA-Z$]+"' | tr '\n' ' ')"
}

say "D — Promise builds (no --enable stack-switching), and one stackful control"
build promise-main-framework.ts main-framework-promise.wasm
build promise-main-io-only.ts   main-io-promise.wasm
build promise-main-framework.ts main-framework-stackful.wasm --enable stack-switching

say "D — the owner's example: game.ts, Promise build vs stackful build"
( cd examples/async-on-main \
    && node "$SCRIPT" game.ts -o "$OUT/game-promise.wasm" \
         --runtime incremental --target release --exportStart __start ) >/dev/null 2>&1

printf '  Promise build exports:  '
wasm-tools print "$OUT/game-promise.wasm" 2>/dev/null | grep -oE 'export "[^"]+"' | tr '\n' ' '; echo
printf '  stackful build exports: '
wasm-tools print examples/async-on-main/build/game.wasm 2>/dev/null | grep -oE 'export "[^"]+"' | tr '\n' ' '; echo

# How many call sites does `main` have in each? A count of zero means nothing in
# the module can ever start it.
for w in "$OUT/game-promise" examples/async-on-main/build/game; do
  node -e '
    const { execFileSync } = require("child_process");
    const p = process.argv[1];
    const wat = execFileSync("wasm-tools", ["print", p + ".wasm"], { maxBuffer: 1 << 28 }).toString();
    const name = /export "main" \(func (\$?[^)\s]+)/.exec(wat)[1];
    // A plain substring count: `call <name>` followed by a character that cannot
    // continue an identifier, so `$game/main` does not also match `$game/mainX`.
    let calls = 0;
    for (let i = wat.indexOf("call " + name); i >= 0; i = wat.indexOf("call " + name, i + 1)) {
      const next = wat[i + 5 + name.length] || " ";
      if (!/[A-Za-z0-9_$/.-]/.test(next)) ++calls;
    }
    console.log("  main = " + name + " in " + p.split("/").pop() + ".wasm; call sites = " + calls);
  ' "$w"
done

printf '  _start_game body, Promise build (the program exports it, empty):\n'
node -e '
  const { execFileSync } = require("child_process");
  const wat = execFileSync("wasm-tools", ["print", process.argv[1]], { maxBuffer: 1 << 28 }).toString();
  const idx = /export "_start_game" \(func ([0-9]+)/.exec(wat)[1];
  const body = new RegExp("\\(func \\(;" + idx + ";\\)[^]*?\n  \\)", "m").exec(wat)[0];
  console.log(body.split("\n").map((l) => "    " + l).join("\n"));
' "$OUT/game-promise.wasm"

say "D — what runs (a printed line means main ran; silence means it never did)"
for w in main-framework-promise main-io-promise main-framework-stackful; do
  printf '  --- %s\n' "$w"
  "$CORE" "$OUT/promise/$w.wasm" 2>&1 | grep -vE 'INFO +core: (async backend|res:)' | sed 's/^/      /'
done
