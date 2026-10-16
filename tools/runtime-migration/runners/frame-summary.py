#!/usr/bin/env python3
"""Summarise frame-loop repetitions: read the per-rep JSON files and print a
tail distribution. Kept as its own file so the shell driver needs no nested
heredocs."""
import json
import sys
from pathlib import Path

out = Path(sys.argv[1])
rt = sys.argv[2]

rows = []
for f in sorted(out.glob(f"frame-{rt}-*.json")):
    try:
        r = json.load(open(f))["results"]
    except Exception:
        continue
    rows.append(r)

if not rows:
    print(f"  [{rt}] no runs")
    sys.exit(0)

traps = [r for r in rows if r.get("trap")]
ok = [r for r in rows if not r.get("trap")]

if traps:
    print(f"  [{rt}] {len(traps)}/{len(rows)} reps TRAPPED: {traps[0]['trap']}")

if not ok:
    sys.exit(0)

worsts = sorted(r["worst_alloc_ms"] for r in ok)
totals = sorted(r["total_alloc_ms"] for r in ok)
alltop = []
for r in ok:
    alltop.extend(r.get("top_stalls_ms", []))
alltop.sort(reverse=True)

over1 = sum(r.get("over1ms", 0) for r in ok)
over4 = sum(r.get("over4ms", 0) for r in ok)
over16 = sum(r.get("over16ms", 0) for r in ok)
nalloc = 3600 * 100 * len(ok)

print(f"  [{rt}] reps={len(ok)} allocations_timed={nalloc}")
print(f"        worst-across-reps={worsts[-1]:.4f}ms  median-of-worst={worsts[len(worsts)//2]:.4f}ms  best={worsts[0]:.4f}ms")
print(f"        total_alloc median={totals[len(totals)//2]:.2f}ms")
print(f"        stalls>16ms={over16:.0f}  >4ms={over4:.0f}  >1ms={over1:.0f}  (of {nalloc})")
print(f"        top stalls overall (ms): {', '.join(f'{x:.3f}' for x in alltop[:8])}")
print(f"        final heap_pages: {', '.join(str(int(r['heap_pages'])) for r in ok)}")
