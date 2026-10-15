#!/usr/bin/env bash
# Compare two capture sets from verify-examples.sh, example by example.
#
#   bash compare-runs.sh <labelA> <labelB>
#
# Every example must be byte-identical between the two runs.  Two classes of
# token are non-deterministic by nature and are normalised before the
# comparison, because they are properties of the clock and the temp directory,
# not of the runtime:
#
#   * ISO-8601 timestamps     2026-10-15T18:41:21.159Z
#   * mktemp directory names  /tmp/tmp.pgne57vTvL/
#
# Normalisation is reported per example, never silent: an example is called
# IDENTICAL only if it matches byte-for-byte *or* matched after N normalised
# tokens, and the count is printed.  A difference that survives normalisation is
# a real difference and fails.  Raw bytes are compared first, so an example that
# needs no normalisation says so.

set -u
here=$(cd "$(dirname "$0")" && pwd)
out=${OUT_DIR:-$here/out}
a=${1:?usage: compare-runs.sh <labelA> <labelB>}
b=${2:?usage: compare-runs.sh <labelA> <labelB>}

same=0; norm=0; diff=0; missing=0
printf '%-26s %-9s %-9s %s\n' "example" "$a" "$b" "result"
printf '%s\n' "----------------------------------------------------------------------"

for fa in "$out"/$a-*.txt; do
  [ -f "$fa" ] || continue
  base=$(basename "$fa" .txt)
  ex=${base#$a-}
  fb=$out/$b-$ex.txt
  if [ ! -f "$fb" ]; then
    printf '%-26s %-9s %-9s MISSING\n' "$ex" "$(wc -c < "$fa")" "-"
    missing=$((missing+1)); continue
  fi

  if cmp -s "$fa" "$fb"; then
    printf '%-26s %-9s %-9s IDENTICAL (byte-for-byte)\n' "$ex" "$(wc -c < "$fa")" "$(wc -c < "$fb")"
    same=$((same+1)); continue
  fi

  # Normalise the two non-deterministic token classes and count substitutions.
  na=$out/.norm-$a-$ex; nb=$out/.norm-$b-$ex
  python3 - "$fa" "$na" "$fb" "$nb" <<'PY'
import re, sys
TS  = re.compile(rb'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z')
TMP = re.compile(rb'/tmp/tmp\.[A-Za-z0-9]{8,}/')
counts = {}
for src, dst in ((sys.argv[1], sys.argv[2]), (sys.argv[3], sys.argv[4])):
    data = open(src, 'rb').read()
    data, n_ts = TS.subn(b'<TS>', data)
    data, n_tmp = TMP.subn(b'<TMPDIR>/', data)
    open(dst, 'wb').write(data)
    counts[src] = (n_ts, n_tmp)
open(sys.argv[2] + '.counts', 'w').write(
    f"{counts[sys.argv[1]][0]} {counts[sys.argv[1]][1]} "
    f"{counts[sys.argv[3]][0]} {counts[sys.argv[3]][1]}")
PY
  read -r ts_a tmp_a ts_b tmp_b < "$na.counts"

  if cmp -s "$na" "$nb"; then
    printf '%-26s %-9s %-9s IDENTICAL after normalising %s timestamp(s), %s temp path(s)\n' \
      "$ex" "$(wc -c < "$fa")" "$(wc -c < "$fb")" "$((ts_a + tmp_a))" "$((ts_a + tmp_a))"
    norm=$((norm+1))
  else
    printf '%-26s %-9s %-9s DIFFERS (survives normalisation)\n' "$ex" "$(wc -c < "$fa")" "$(wc -c < "$fb")"
    diff=$((diff+1))
    python3 - "$na" "$nb" <<'PY'
import sys
la = open(sys.argv[1], 'rb').read().split(b'\n')
lb = open(sys.argv[2], 'rb').read().split(b'\n')
for i in range(max(len(la), len(lb))):
    x = la[i] if i < len(la) else b'<absent>'
    y = lb[i] if i < len(lb) else b'<absent>'
    if x != y:
        print(f'    line {i+1} (normalised):')
        print(f'      {sys.argv[1]}: {x[:130]!r}')
        print(f'      {sys.argv[2]}: {y[:130]!r}')
        break
PY
  fi
  rm -f "$na" "$nb" "$na.counts" "$nb.counts"
done

echo
echo "byte-identical=$same  identical-after-normalising=$norm  differs=$diff  missing=$missing"
if [ "$diff" -eq 0 ] && [ "$missing" -eq 0 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; fi
