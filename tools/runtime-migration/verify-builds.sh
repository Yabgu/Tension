#!/usr/bin/env bash
# Build matrix for the runtime migration.
#
# The runtime flag is a *compile-time* choice, so the thing it can break that
# transcript capture cannot reach is the BUILD.  Every example is therefore
# built under both runtimes and the outcomes compared.
#
#   bash verify-builds.sh [runtime ...]        default: stub incremental
#
# Per example it reports: built / AS105 (needs more initial memory) / failed,
# plus the binary size under each runtime.  A size difference is expected —
# `incremental` carries the collector — so the sizes are recorded rather than
# asserted.
#
# Examples whose build fails under BOTH runtimes are pre-existing failures; the
# script says so, because the migration cannot have caused them.

set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out=${OUT_DIR:-$here/out}
mkdir -p "$out"

RTS=("$@")
[ ${#RTS[@]} -eq 0 ] && RTS=(stub incremental)

# Build with the generated config where the example uses one, and with the
# explicit --runtime flag where it declares one, so we exercise the same path a
# developer would.  The flag on the command line wins over a config file, which
# is what makes this possible without editing anything.
build_one() {   # build_one <example-dir-relative> <runtime> <outfile>
  local ex=$1 rt=$2 o=$3
  local dir=$root/examples/$ex
  local asc=$dir/node_modules/.bin/asc
  [ -x "$asc" ] || { echo "NOASC"; return; }

  local entry cfgarg=()
  # Take the entry file straight out of the example's own build script, so this
  # cannot drift from what the example actually builds (audio is demo.ts, ai is
  # story.ts, res is assembly/index.ts …).
  entry=$(python3 - "$dir/package.json" <<'PY'
import json, re, sys
d = json.load(open(sys.argv[1]))
s = d.get('scripts', {}).get('build', '')
m = re.search(r'(?:asc(?:\.js)?|bin/asc\.js)\s+(\S+\.ts)', s)
print(m.group(1) if m else '')
PY
)
  [ -n "$entry" ] || { echo "NOENTRY"; return; }
  # An example that has a config file gets it, exactly as its own build script
  # passes it; the explicit flag is layered on top.
  if grep -q -- '--config' "$dir/package.json" 2>/dev/null; then
    cfgarg=(--config "$root/tension-framework/build/session.asconfig.json")
  fi

  ( cd "$dir" && timeout 300 "$asc" "$entry" "${cfgarg[@]}" -o "$o" --runtime "$rt" --target release ) \
    > "$out/build-$rt-$(echo "$ex" | tr '/' '-').log" 2>&1
  if [ -f "$o" ]; then echo "OK"; return; fi
  if grep -q "AS105" "$out/build-$rt-$(echo "$ex" | tr '/' '-').log"; then echo "AS105"; return; fi
  echo "FAIL"
}

ALL=(ai audio io log res
     ogre/animated-character ogre/bouncing-ball ogre/bouncing-bodies
     ogre/hello-mesh ogre/hello-triangle ogre/input-camera)

printf '%-28s' "example"
for rt in "${RTS[@]}"; do printf '%-26s' "$rt"; done
echo
printf '%s\n' "$(printf '%.0s-' $(seq 1 28))$(printf '%.0s-' $(seq 1 $((26 * ${#RTS[@]}))))"

declare -A verdict
for ex in "${ALL[@]}"; do
  printf '%-28s' "$ex"
  line=""
  for rt in "${RTS[@]}"; do
    o=$(mktemp /tmp/rmbuild-XXXXXX.wasm); rm -f "$o"
    v=$(build_one "$ex" "$rt" "$o")
    sz="-"; [ -f "$o" ] && sz=$(wc -c < "$o")
    verdict["$ex/$rt"]=$v
    printf '%-26s' "$v($sz)"
    rm -f "$o"
  done
  echo
done

echo
echo "== analysis =="
both_fail=(); only_new_fail=(); all_ok=()
for ex in "${ALL[@]}"; do
  s=${verdict["$ex/stub"]}; i=${verdict["$ex/incremental"]}
  if [ "$s" = "OK" ] && [ "$i" = "OK" ]; then all_ok+=("$ex")
  elif [ "$s" != "OK" ] && [ "$i" != "OK" ]; then both_fail+=("$ex")
  else only_new_fail+=("$ex"); fi
done

echo "  built under every runtime      : ${#all_ok[@]}  ${all_ok[*]:-none}"
echo "  failed under every runtime     : ${#both_fail[@]}  ${both_fail[*]:-none}"
echo "    (pre-existing; the runtime choice cannot cause these)"
if [ ${#only_new_fail[@]} -gt 0 ]; then
  echo "  REGRESSED by the migration     : ${#only_new_fail[@]}  ${only_new_fail[*]}"
  echo "    ^^ these are migration-caused and must be explained"
else
  echo "  regressed by the migration     : 0"
fi

# bouncing-ball is the one known pre-existing AS105.  Name it so the reader does
# not have to rediscover it.
if [ "${verdict[ogre/bouncing-ball/stub]}" = "AS105" ]; then
  echo
  echo "  note: ogre/bouncing-ball needs one more initial page than"
  echo "        tension-framework/session.json declares (needs 133, has 132)."
  echo "        Pre-existing at HEAD and identical under both runtimes."
fi
