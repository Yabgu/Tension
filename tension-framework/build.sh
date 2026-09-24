#!/usr/bin/env bash
# Generate the session runtime's constants and `asc` flags from session.json.
#
# One source of truth, two derivations (`tension-ogre/DESIGN.md` §10):
#
#   assembly/runtime/layout.ts        the arena constants the guest sends in the
#                                     TLV, and the layout hash it is compiled
#                                     against (committed: it is source the AS
#                                     build compiles, and the Rust cross-check
#                                     test reads it)
#   build/session.asconfig.json       the `asc` flags, as an asconfig the
#                                     fixture's build passes with --config
#                                     (build/ is ignored, so this is regenerated)
#
# Nothing here is hand-edited, and the generator refuses rather than emits when
# a number violates the relation the session enforces at open.
#
# Flag rules (§10): --importMemory, --memoryBase = max_arena_size, page counts
# for --initialMemory / --maximumMemory, --exportTable, --runtime stub.
# --noExportMemory is forbidden (F2) — the framework never sets it — and
# --lowMemoryLimit likewise.
#
# One more, learned by building: `--exportStart __start`. AssemblyScript 0.28
# emits a `start` *section* by default, and tension-core refuses a module that
# has one — a start section runs guest code at instantiation, before the session
# has verified the arena. `--exportStart` turns it into an export the host calls
# after verification instead, which is the order the design wanted in the first
# place. The alternative — relaxing the host's check — would cost the ordering
# guarantee for every guest; this costs a flag.
#
# Usage: build.sh [--hash <value>]
#   --hash  the layout hash this build expects, as printed by
#           `tension-core layout-hash`. When given it must equal session.json's,
#           which is how the Rust build and the AS build are kept in step: the
#           Rust side produces the value, the AS side consumes it, and a
#           disagreement stops the build instead of shipping a guest the host
#           will refuse at session_open.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

expected_hash=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hash) expected_hash="${2:?--hash needs a value}"; shift 2 ;;
    *) echo "build.sh: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

mkdir -p "$here/build" "$here/assembly/runtime"

python3 - "$here/session.json" "$here/assembly/runtime/layout.ts" \
         "$here/build/session.asconfig.json" "$expected_hash" <<'PY'
import json
import sys

source, layout_ts, asconfig, expected_hash = sys.argv[1:5]

with open(source) as fh:
    cfg = json.load(fh)

PAGE = 64 * 1024


def fail(why):
    # Non-zero, nothing emitted, the offending number named (§10).
    print(f"build.sh: session.json refused: {why}", file=sys.stderr)
    raise SystemExit(1)


required = {
    "abi_version", "layout_hash", "arena_size", "max_arena_size",
    "ring_capacities", "initial_pages", "maximum_pages",
}
missing = required - set(cfg)
if missing:
    fail(f"missing key(s): {', '.join(sorted(missing))}")

arena, ceiling = cfg["arena_size"], cfg["max_arena_size"]

# C1, and the two relations the flags imply. Arena sizes must be 16-byte
# aligned because the region band's offsets are, and a live arena below the
# layout floor is refused by session_open (C4) — the generator cannot know the
# floor, so it states the rule rather than guessing the number.
if arena <= 0 or ceiling <= 0:
    fail("arena_size and max_arena_size must be positive")
if arena % 16 != 0:
    fail(f"arena_size {arena} is not 16-byte aligned")
if ceiling % 16 != 0:
    fail(f"max_arena_size {ceiling} is not 16-byte aligned")
if arena > ceiling:  # C1
    fail(f"arena_size {arena} exceeds max_arena_size {ceiling} (C1)")

caps = cfg["ring_capacities"]
if len(caps) != 10:
    fail(f"ring_capacities has {len(caps)} entries; this chunk has 10 classes")
if any(not isinstance(c, int) or c <= 0 for c in caps):
    fail("every ring capacity must be a positive integer")

initial, maximum = cfg["initial_pages"], cfg["maximum_pages"]
if initial * PAGE <= ceiling:
    fail(f"initial_pages {initial} ({initial * PAGE} bytes) does not leave room "
         f"above memoryBase {ceiling}: the guest needs a heap")
if initial > maximum:
    fail(f"initial_pages {initial} exceeds maximum_pages {maximum}")
if maximum > 65536:
    fail(f"maximum_pages {maximum} exceeds the wasm32 ceiling of 65536")

# The Rust build's value, when it was passed: the AS side consumes it, so a
# disagreement is refused here rather than at session_open.
if expected_hash:
    if int(expected_hash, 0) != cfg["layout_hash"]:
        fail(f"layout hash {expected_hash} does not match session.json's "
             f"{cfg['layout_hash']}: re-run the generator after the arena shape "
             f"changes, and update session.json deliberately")

# The import module name AssemblyScript emits is `env` (F1): the session
# defines the memory under both `env::memory` and `session::memory`, so this is
# the spelling the toolchain's `--importMemory` produces.
layout = f"""// Generated by tension-framework/build.sh from session.json — do not edit.
//
// The arena constants this guest is compiled against: what it sends in the
// session TLV, and the layout hash the session compares against its own. The
// Rust side's `arena::layout_hash()` is the authority for the hash; the
// cross-check test in tension-core reads this file and fails loudly if the two
// ever disagree.
//
// Memory flags this file implies (also generated, as an asconfig):
//   --importMemory --memoryBase {ceiling} \\
//   --initialMemory {initial} --maximumMemory {maximum} \\
//   --exportTable --runtime stub
// `--noExportMemory` is forbidden (F2) and `--lowMemoryLimit` likewise.

export const ABI_VERSION: u32 = {cfg["abi_version"]};
export const LAYOUT_HASH: u32 = {cfg["layout_hash"]};
/** The live arena this guest asks for (bytes). */
export const ARENA_SIZE: u32 = {arena};
/** The ceiling, and therefore the guest's `--memoryBase`. */
export const MAX_ARENA_SIZE: u32 = {ceiling};
export const MEMORY_BASE: u32 = {ceiling};
export const INITIAL_PAGES: u32 = {initial};
export const MAXIMUM_PAGES: u32 = {maximum};
export const CLASS_COUNT: u32 = 10;
/** Per-class ring capacities, in class-id order. */
export const RING_CAPACITIES: u32[] = [{", ".join(str(c) for c in caps)}];
"""

asconfig_doc = {
    "options": {
        "runtime": "stub",
        "target": "release",
        "importMemory": True,
        "memoryBase": ceiling,
        "initialMemory": initial,
        "maximumMemory": maximum,
        "exportTable": True,
        # See the header: a start *section* is refused by the host, so the
        # runtime's initializer is exported for the host to call after it has
        # verified the arena.
        "exportStart": "__start",
    }
}

with open(layout_ts, "w") as fh:
    fh.write(layout)
with open(asconfig, "w") as fh:
    json.dump(asconfig_doc, fh, indent=2)
    fh.write("\n")

print(f"==> wrote {layout_ts}")
print(f"==> wrote {asconfig}")
PY

echo "==> asc flags for a session guest:"
printf '    importMemory=true memoryBase=%s initialMemory=%s maximumMemory=%s exportTable=true runtime=stub\n' \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["max_arena_size"])' "$here/session.json")" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["initial_pages"])' "$here/session.json")" \
  "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["maximum_pages"])' "$here/session.json")"
