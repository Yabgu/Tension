#!/usr/bin/env bash
# Runtime-migration measurement driver.
#
# Compiles the workloads in ../workloads under each AssemblyScript runtime and
# runs them through the available engines. Designed to run either under MSYS2
# on Windows or under bash on Linux, so the same script produces the numbers
# that get compared across platforms.
#
#   bash run-measurements.sh [--stub] [--incremental] [--minimal] [--engines node,wasmtime]
#
# Environment:
#   ASC        path to the compiler's asc.js (or an `asc` on PATH)
#   WTRUNNER   path to the wasmtime-based runner binary
#   OUT_DIR    where the report and per-run JSON land (default: ./out)
#   RUNTIMES   space-separated runtimes (default: stub incremental minimal)
#   ENGINES    node wasmtime (default: whatever is found)
#
# Notes:
#   * Nothing here is Tension-specific: the workloads are ordinary AS modules
#     and the runner supplies only a clock.
#   * `minimal` is included because the migration plan tested it and rejected
#     it; the driver keeps it so the rejection stays reproducible.

set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=${OUT_DIR:-$here/out}
build=$here/build
mkdir -p "$out" "$build"

RUNSP=${RUNSP:-"stub incremental minimal"}
WANT=""
for a in "$@"; do case "$a" in
  --stub) WANT="$WANT stub";;
  --incremental) WANT="$WANT incremental";;
  --minimal) WANT="$WANT minimal";;
  *) ;;
esac; done
[ -n "$WANT" ] && RUNSP="$WANT"

# ── locate node ──────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  for c in "/c/Program Files/nodejs" "$HOME/nodejs"; do
    [ -x "$c/node.exe" ] && export PATH="$c:$PATH"
  done
fi

# ── locate asc ───────────────────────────────────────────────────────────────
if [ -n "${ASC:-}" ] && [ -f "$ASC" ]; then :;
elif command -v asc >/dev/null 2>&1; then ASC=$(command -v asc);
else
  for c in \
    "$root/examples/io/node_modules/@yabgu_gm/tensionscript/bin/asc.js" \
    "$root/examples/log/node_modules/@yabgu_gm/tensionscript/bin/asc.js" \
    "$root/examples/ogre/bouncing-ball/node_modules/@yabgu_gm/tensionscript/bin/asc.js" \
    "$root/tension-framework/node_modules/@yabgu_gm/tensionscript/bin/asc.js"; do
    [ -f "$c" ] && { ASC="$c"; break; }
  done
fi

# ── locate the wasmtime runner ───────────────────────────────────────────────
if [ -z "${WTRUNNER:-}" ]; then
  for c in "$here/wtrunner/target/release/wtrunner.exe" "$here/wtrunner/target/release/wtrunner"; do
    [ -x "$c" ] && { WTRUNNER="$c"; break; }
  done
fi

report=$out/report.txt
: > "$report"
say() { echo "$@" | tee -a "$report"; }

say "=============================================================="
say " runtime-migration measurements"
say " date      : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
say " platform  : $(uname -s -r -m)"
say " node      : $(node --version 2>/dev/null || echo MISSING)"
if [ -n "${ASC:-}" ] && [ -f "$ASC" ]; then
  say " asc       : $ASC"
  say " asc ver   : $(node "$ASC" --version 2>/dev/null | head -1)"
else
  say " asc       : NOT FOUND — set ASC=/path/to/asc.js"
fi
say " runner    : ${WTRUNNER:-not found (wasmtime engine skipped)}"
say " runtimes  : $RUNSP"
say "=============================================================="

# ── compile ──────────────────────────────────────────────────────────────────
compile() {          # compile <workload-basename> <runtime>
  local w=$1 rt=$2 src=$here/workloads/$1.ts wasm=$build/$1-$rt.wasm
  [ -f "$src" ] || { echo "    missing workload $src"; return 1; }
  if [ -f "$wasm" ] && [ "${REBUILD:-0}" != "1" ]; then echo "$wasm"; return 0; fi
  node "$ASC" "$src" -o "$wasm" --runtime "$rt" --target release \
       --exportRuntime --maximumMemory 512 > "$out/compile-$1-$rt.log" 2>&1
  if [ ! -f "$wasm" ]; then
    echo "    COMPILE FAILED ($1/$rt): $(tail -2 "$out/compile-$1-$rt.log" | tr '\n' ' ')" >&2
    return 1
  fi
  echo "$wasm"
}

if [ -z "${ASC:-}" ] || [ ! -f "${ASC:-/nonexistent}" ]; then
  say ""
  say "No AssemblyScript compiler found; cannot compile workloads."
  say "Set ASC=/path/to/@yabgu_gm/tensionscript/bin/asc.js and re-run."
  exit 2
fi

say ""
say "── binary sizes ──────────────────────────────────────────────"
for w in harness retention probe2 frame2 m5c bigarr scale mintest; do
  line=$(printf '  %-12s' "$w")
  for rt in $RUNSP; do
    wasm=$(compile "$w" "$rt" 2>/dev/null) || { line="$line $(printf '%s=%s' "$rt" FAIL)"; continue; }
    line="$line $(printf '%s=%s' "$rt" "$(wc -c < "$wasm" | tr -d ' ')")"
  done
  say "$line"
done

# ── run one measurement through one engine ───────────────────────────────────
run_node() {         # run_node <tag> <command> <wasm> [args...]
  local tag=$1 cmd=$2 wasm=$3; shift 3
  OUT_JSON=$out/$tag.json node "$here/runners/measure.mjs" "$cmd" "$wasm" "$@" \
    > "$out/$tag.stdout" 2>&1
  if [ -f "$out/$tag.json" ]; then cat "$out/$tag.json"; else echo '{"error":"no output"}'; fi
}

run_wt() {           # run_wt <tag> <wasm> <export> [i32]
  local tag=$1 wasm=$2 fn=$3 arg=${4:-}
  { "$WTRUNNER" "$wasm" "$fn" $arg 2>&1 || true; } | tee "$out/$tag.wt.txt"
}

jget() { python3 -c "
import json,sys
d=json.load(open('$1'))
cur=d
for k in '$2'.split('.'):
    if k=='': continue
    cur = cur[int(k)] if isinstance(cur,list) else cur.get(k)
    if cur is None: break
print('' if cur is None else (json.dumps(cur) if isinstance(cur,(dict,list)) else cur))
" 2>/dev/null; }

# ── the measurements ─────────────────────────────────────────────────────────
say ""
say "── M1-M4: heap growth (node engine) ──────────────────────────"
say "  format: workload: grew_bytes / final_heap_bytes / trap / wall_ms"
for rt in $RUNSP; do
  wasm=$build/harness-$rt.wasm
  [ -f "$wasm" ] || continue
  run_node "m1234-$rt" harness "$wasm" m1_thousand m2_100k_10s m3_1m_100s m4_map_10k_frames > /dev/null
  say "  [$rt]"
  for fn in m1_thousand m2_100k_10s m3_1m_100s m4_map_10k_frames; do
    python3 - "$out/m1234-$rt.json" "$fn" <<'PY' | sed 's/^/    /' | tee -a "$report"
import json,sys
d=json.load(open(sys.argv[1])); r=d["results"].get(sys.argv[2],{})
if r.get("trap"): print(f'{sys.argv[2]:20s} TRAP: {r["trap"]}')
else:
    v=r.get("values",[])
    grew=v[0] if v else None; heap=r.get("heap_bytes")
    print(f'{sys.argv[2]:20s} grew={grew}  heap={heap} ({"" if heap is None else heap//65536}p)  wall={r.get("ms")}ms')
PY
  done
done

if [ -n "${WTRUNNER:-}" ]; then
say ""
say "── M1-M4: heap growth (wasmtime engine) ──────────────────────"
for rt in $RUNSP; do
  wasm=$build/harness-$rt.wasm; [ -f "$wasm" ] || continue
  say "  [$rt]"
  for fn in m1_thousand m2_100k_10s m3_1m_100s m4_map_10k_frames; do
    run_wt "wt-$fn-$rt" "$wasm" "$fn" | sed 's/^/    /' | tee -a "$report"
  done
done
fi

say ""
say "── M5: frame-loop pauses (3600 frames x 100 allocs) ──────────"
REPS=${REPS:-1}
say "  repetitions per runtime: $REPS (set REPS=N for a tail distribution)"
for rt in $RUNSP; do
  wasm=$build/frame2-$rt.wasm; [ -f "$wasm" ] || continue
  for i in $(seq 1 "$REPS"); do
    run_node "frame-$rt-0$i" frame "$wasm" 3600 100 0 > /dev/null
  done
  python3 "$here/runners/frame-summary.py" "$out" "$rt" | tee -a "$report"
done

say ""
say "── M5b: forced full collection vs live set (incremental) ─────"
wasm=$build/m5c-incremental.wasm
if [ -f "$wasm" ]; then
  for n in 50000 200000 600000; do
    run_node "m5c-$n" fullgc "$wasm" "$n" > /dev/null
    python3 - "$out/m5c-$n.json" "$n" <<'PY' | tee -a "$report"
import json,sys
d=json.load(open(sys.argv[1])); r=d["results"]
if r.get("trap"): print(f'  live<={sys.argv[2]:>7} TRAP: {r["trap"]}')
else: print(f'  live<={sys.argv[2]:>7} full_gc={r["full_gc_ms"]:.3f}ms heap={r["heap_pages"]:.0f}p')
PY
  done
fi

say ""
say "── M6/M7: retention probes ───────────────────────────────────"
for rt in $RUNSP; do
  wasm=$build/retention-$rt.wasm; [ -f "$wasm" ] || continue
  run_node "ret-$rt" retention "$wasm" > /dev/null
  python3 - "$out/ret-$rt.json" "$rt" <<'PY' | tee -a "$report"
import json,sys
d=json.load(open(sys.argv[1])); r=d["results"]; rt=sys.argv[2]
def g(k):
    x=r.get(k,{})
    return f'TRAP({x.get("trap")})' if x.get("trap") else x.get("value")
print(f'  [{rt}] R1_intact={g("r1")}/10000  R2_shared={g("r2")}  R3_growth={g("r3")}B  R4_local={g("r4")}')
PY
done

say ""
say "── local-survival shapes p1-p6 (expected 1234,4321,555,3,1,10) ─"
for rt in $RUNSP; do
  wasm=$build/probe2-$rt.wasm; [ -f "$wasm" ] || continue
  run_node "probe-$rt" probe "$wasm" > /dev/null
  python3 - "$out/probe-$rt.json" "$rt" <<'PY' | tee -a "$report"
import json,sys
d=json.load(open(sys.argv[1])); r=d["results"]; rt=sys.argv[2]
parts=[]
for k in ("p1","p2","p3","p4","p5","p6"):
    x=r.get(k,{})
    parts.append(f'{k}={x.get("got","TRAP")}{"ok" if x.get("ok") else " BAD"}')
print(f'  [{rt}] {" ".join(parts)}  pass={d.get("pass")}')
PY
done

say ""
say "── M8: giant-mark-step hypothesis (one big array vs many) ────"
wasm=$build/bigarr-incremental.wasm
if [ -f "$wasm" ]; then
  for spec in "big 200000 0" "many 200000 16" "big 500000 0" "many 500000 16"; do
    set -- $spec
    run_node "ba-$1-$2" bigarr "$wasm" "$1" "$2" "$3" > /dev/null
    python3 - "$out/ba-$1-$2.json" <<'PY' | tee -a "$report"
import json,sys
d=json.load(open(sys.argv[1])); r=d["results"]
if r.get("trap"): print(f'  {r.get("mode","?"):5s} n={r.get("n","?"):>7} TRAP')
else: print(f'  {r["mode"]:5s} n={r["n"]:>7} forced_full_gc={r["forced_full_gc_ms"]:.3f}ms worst_alloc={r["worst_alloc_stall_ms"]:.4f}ms heap={r["heap_pages"]:.0f}p')
PY
  done
fi

say ""
say "── M9: unrooted reclamation, incremental vs stub ─────────────"
for rt in stub incremental; do
  wasm=$build/scale-$rt.wasm; [ -f "$wasm" ] || continue
  run_node "scale-$rt" scale "$wasm" forced 200000 > /dev/null
  python3 - "$out/scale-$rt.json" "$rt" <<'PY' | tee -a "$report"
import json,sys
d=json.load(open(sys.argv[1])); r=d["results"]; rt=sys.argv[2]
if r.get("trap"): print(f'  [{rt}] TRAP: {r["trap"]}')
else: print(f'  [{rt}] live={r["live"]} forced_gc={r["forced_full_gc_ms"]:.3f}ms heap={r["heap_pages"]:.0f}p')
PY
done

say ""
say "=============================================================="
say " per-run JSON and engine logs are in $out"
say " report written to $report"
say "=============================================================="
