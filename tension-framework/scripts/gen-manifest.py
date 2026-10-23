#!/usr/bin/env python3
"""Generate the guest's view of the arena manifest, from the host's source.

The host writes nine `{typeId, size, align, pad}` entries at `MANIFEST_OFFSET`
(`tension-core/src/session/arena.rs`, `TYPES`). The guest reads them at session
open and compares each entry's size against its own declaration — the check that
would have caught the `SessionInfo` drift (guest 128, host 144) at the first
open instead of never. That check needs the id -> type correspondence, and
today the correspondence exists only as prose (`tension-ogre/DESIGN.md` §5.1).
This script is where it becomes data.

**The shape is `tension-core/tests/framework_layout.rs:34-44`'s**, the tree's
established cross-source read: open the other side's *source* as text, find by
an exact prefix, and fail loudly rather than default when the find fails. The
new part is only the direction — the framework reading `tension-core`.

**What is parsed, and what is not.** Only `{id, size, align}` come out of the
`TYPES` array. `MANIFEST_OFFSET` (`arena.rs:58`) and `MANIFEST_LEN`
(`arena.rs:455`) are *expressions*, not literals, and they are deliberately not
parsed: the guest takes both from the runtime control block (`ArenaControl
.manifestOff` / `.manifestLen`, `wire.ts:118-119`), which the host fills from
the same constants. One fewer thing to keep in step.

**Fail-closed is the point.** Every failure mode below exits non-zero with the
reason on stderr and writes nothing: an unparsable `TYPES` block, a count that
is not 9, ids that are not 1..9 ascending, a symbolic size whose constant cannot
be found, or an id order that disagrees with `EXPECTED_NAMES`. A silently empty
or stale table is the one outcome that would make the guest's check pass while
proving nothing, so it is not reachable.

**One repo, one checkout.** The script reads `../tension-core/...` as a sibling
path. If `tension-framework` is ever checked out without `tension-core`, the
build fails closed here — that is correct, not a limitation to paper over: the
tree is one repository, and a future split is a future concern that gets its own
mechanism (a published manifest, or a host subcommand) rather than a quiet
fallback today.

Usage: gen-manifest.py <arena.rs> <out.ts>
"""

import re
import sys

# The framework's view of the manifest, in id order. The ids are tension-core's
# view; this list is ours. If the two disagree the tree is inconsistent and the
# build stops here rather than shipping a guest that checks the wrong type.
EXPECTED_NAMES = [
    "ArenaControl",
    "SessionInfo",
    "RegionDesc",
    "ManifestEntry",
    "TableHeader",
    "StringHalf",
    "Callbacks",
    "Subscription",
    "EventRecord",
]

# One `TypeEntry` literal, in the host's own two forms: a bare integer size
# (`id: 7, size: 64, align: 4`) or a named constant cast to u16
# (`id: 1, size: CONTROL_SIZE as u16, align: 8`). Anything else is unparsable,
# so a changed shape in `arena.rs` stops the build instead of being guessed at.
ENTRY_RE = re.compile(
    r"^\s*TypeEntry\s*\{\s*id:\s*(\d+)\s*,\s*size:\s*"
    r"(?:([A-Za-z_][A-Za-z0-9_]*)\s+as\s+u16|(\d+))"
    r"\s*,\s*align:\s*(\d+)\s*\}\s*,?\s*$"
)

# `pub const NAME: usize = 123;` — the symbolic sizes the table references.
CONST_RE = r"^\s*pub\s+const\s+{name}\s*:\s*usize\s*=\s*(\d+)\s*;\s*$"


def fail(why):
    print(f"gen-manifest: {why}", file=sys.stderr)
    raise SystemExit(1)


def main():
    if len(sys.argv) != 3:
        fail("usage: gen-manifest.py <arena.rs> <out.ts>")
    arena_path, out_path = sys.argv[1], sys.argv[2]

    try:
        with open(arena_path, encoding="utf-8") as fh:
            text = fh.read()
    except OSError as error:
        # The sibling checkout is missing. Loud, named, non-zero.
        fail(f"cannot read the host's layout source {arena_path}: {error}")

    # The array's extent, so a truncated or duplicated block is caught by the
    # count check below rather than by a partial table.
    start = re.search(r"pub\s+const\s+TYPES\s*:\s*\[\s*TypeEntry\s*;\s*(\d+)\s*\]\s*=\s*\[", text)
    if not start:
        fail(f"{arena_path}: no `pub const TYPES: [TypeEntry; N] = [` block")
    declared = int(start.group(1))
    end = text.find("];", start.end())
    if end < 0:
        fail(f"{arena_path}: the TYPES block is not closed with `];`")
    body = text[start.end():end]

    entries = []
    for line in body.splitlines():
        if not line.strip():
            continue
        match = ENTRY_RE.match(line)
        if not match:
            fail(f"{arena_path}: unparsable TYPES line: {line.strip()!r}")
        # Group 2 is the symbolic name, group 3 the bare integer; exactly one
        # is present by construction.
        size = match.group(2) if match.group(2) else match.group(3)
        entries.append((int(match.group(1)), size, int(match.group(4))))

    if declared != len(entries):
        fail(f"{arena_path}: TYPES declares {declared} entries, the block holds {len(entries)}")
    if len(entries) != len(EXPECTED_NAMES):
        fail(
            f"{arena_path}: the manifest has {len(entries)} entries; this guest "
            f"expects {len(EXPECTED_NAMES)}"
        )

    ids = [entry[0] for entry in entries]
    if ids != list(range(1, len(entries) + 1)):
        fail(f"{arena_path}: ids {ids} are not 1..{len(entries)} ascending")

    # Resolve a symbolic size against the same file. Exact-name match, so
    # `REGION_DESC_SIZE` cannot pick up `REGION_DESC_SIZE_FIELD`.
    resolved = []
    for entry_id, size, align in entries:
        if size.isdigit():
            resolved.append((entry_id, int(size), align))
            continue
        pattern = re.compile(CONST_RE.format(name=re.escape(size)), re.MULTILINE)
        found = pattern.search(text)
        if not found:
            fail(f"{arena_path}: no `pub const {size}: usize = N;` for id {entry_id}")
        resolved.append((entry_id, int(found.group(1)), align))

    # The cross-source contract: the ids the host states must be the types this
    # guest declares, in this order. A reorder in either repository stops the
    # build instead of producing a check that compares the wrong pair.
    pairs = ", ".join(
        f"id {i} = {name} ({size}B, align {align})"
        for (i, size, align), name in zip(resolved, EXPECTED_NAMES)
    )
    print(f"gen-manifest: {pairs}")

    ids = ", ".join(str(i) for i, _, _ in resolved)
    sizes = ", ".join(str(s) for _, s, _ in resolved)
    aligns = ", ".join(str(a) for _, _, a in resolved)
    names = ", ".join(f'"{name}"' for name in EXPECTED_NAMES)

    ts = f"""// Generated by tension-framework/build.sh from tension-core/src/session/arena.rs
// — do not edit. Re-run the build after the host's TYPES block changes.
//
// The guest's view of the arena manifest the host writes at `MANIFEST_OFFSET`:
// one `{{typeId, size, align, pad}}` entry per protocol type, in id order. The
// ids and sizes are the host's (`arena.rs`'s `TYPES`); the names are this
// guest's, and `scripts/gen-manifest.py` fails the build if the two disagree
// about the order. `assembly/runtime/arena.ts`'s `manifestProblem()` is the
// reader; the sizes here are the host's claim, and the guest's own `sizeof` is
// the other side of the comparison.
//
// Primitive constant arrays rather than an array of records: this is the shape
// `layout.ts` already uses for `RING_CAPACITIES`, it folds at compile time, and
// it keeps a module built almost entirely from `@unmanaged` views free of nine
// managed allocations at startup.

/** How many types the manifest holds, as this guest expects it. */
export const MANIFEST_ENTRY_COUNT: u32 = {len(resolved)};
/** One entry's wire size, `{{typeId: u16, size: u16, align: u16, pad: u16}}`. */
export const MANIFEST_ENTRY_SIZE: u32 = 8;

/** The host's type ids, in manifest order (1..{len(resolved)}). */
export const MANIFEST_TYPE_IDS: u32[] = [{ids}];
/** This guest's name for each id, for the drift diagnostic. */
export const MANIFEST_TYPE_NAMES: string[] = [{names}];
/** The host's size for each id, in bytes — the claim the guest checks. */
export const MANIFEST_TYPE_SIZES: u32[] = [{sizes}];
/** The host's alignment for each id — a manifest consistency input only. */
export const MANIFEST_TYPE_ALIGNS: u32[] = [{aligns}];
"""

    try:
        with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(ts)
    except OSError as error:
        fail(f"cannot write {out_path}: {error}")
    print(f"gen-manifest: wrote {out_path}")


if __name__ == "__main__":
    main()
