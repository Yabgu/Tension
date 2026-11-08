// Generate the session runtime's constants and `asc` flags from session.json,
// and the guest's view of the arena manifest from the host's own source.
//
<<<<<<< HEAD
// One source of truth, two derivations (`docs/build.md` §1):
=======
// One source of truth, two derivations (`tension-ogre/DESIGN.md` §10):
>>>>>>> origin/main
//
//   assembly/runtime/layout.ts        the arena constants the guest sends in the
//                                     TLV, and the layout hash it is compiled
//                                     against (committed: it is source the AS
//                                     build compiles, and the Rust cross-check
//                                     test reads it)
//   build/session.asconfig.json       the `asc` flags, as an asconfig the
//                                     fixture's build passes with --config
//                                     (build/ is ignored, so this is regenerated)
//
// Nothing here is hand-edited, and the generator refuses rather than emits when
// a number violates the relation the session enforces at open.
//
// This replaces `tension-framework/build.sh`, which did the same work through a
// Python heredoc. Python is not a dependency of this repository, and `python3`
// does not exist on Windows — the shell script only ever ran on the platforms
// that spell it that way. Node is already required by everything else here.
//
// Usage: node scripts/gen-session.mjs [--hash <value>]
//   --hash  the layout hash this build expects, as printed by
//           `tension-core layout-hash`. When given it must equal session.json's,
//           which is how the Rust build and the AS build are kept in step: the
//           Rust side produces the value, the AS side consumes it, and a
//           disagreement stops the build instead of shipping a guest the host
//           will refuse at session_open.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const framework = join(repo, 'tension-framework');

const PAGE = 64 * 1024;

function fail(why) {
  // Non-zero, nothing emitted, the offending number named (§10).
  console.error(`gen-session: session.json refused: ${why}`);
  process.exit(1);
}

function parseArgs(argv) {
  let expectedHash = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--hash') {
      expectedHash = argv[++i];
      if (!expectedHash) {
        console.error('gen-session: --hash needs a value');
        process.exit(2);
      }
    } else {
      console.error(`gen-session: unknown argument '${arg}'`);
      process.exit(2);
    }
  }
  return { expectedHash };
}

// ── session.json ────────────────────────────────────────────────────────────

function loadSession(path, expectedHash) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`);
  }

  const required = [
    'abi_version', 'layout_hash', 'arena_size', 'max_arena_size',
    'ring_capacities', 'initial_pages', 'maximum_pages',
  ];
  const missing = required.filter((key) => !(key in cfg));
  if (missing.length) {
    fail(`missing key(s): ${missing.sort().join(', ')}`);
  }

  const arena = cfg.arena_size;
  const ceiling = cfg.max_arena_size;

  // C1, and the two relations the flags imply. Arena sizes must be 16-byte
  // aligned because the region band's offsets are, and a live arena below the
  // layout floor is refused by session_open (C4) — the generator cannot know
  // the floor, so it states the rule rather than guessing the number.
  if (arena <= 0 || ceiling <= 0) {
    fail('arena_size and max_arena_size must be positive');
  }
  if (arena % 16 !== 0) {
    fail(`arena_size ${arena} is not 16-byte aligned`);
  }
  if (ceiling % 16 !== 0) {
    fail(`max_arena_size ${ceiling} is not 16-byte aligned`);
  }
  if (arena > ceiling) {
    fail(`arena_size ${arena} exceeds max_arena_size ${ceiling} (C1)`);
  }

  const caps = cfg.ring_capacities;
  // 0.6.0a: the AI family (10-12) appended after FRAME, so this chunk has 13.
  if (!Array.isArray(caps) || caps.length !== 13) {
    fail(`ring_capacities has ${Array.isArray(caps) ? caps.length : 'no'} entries; ` +
         'this chunk has 13 classes');
  }
  if (!caps.every((c) => Number.isInteger(c) && c > 0)) {
    fail('every ring capacity must be a positive integer');
  }

  const initial = cfg.initial_pages;
  const maximum = cfg.maximum_pages;
  if (initial * PAGE <= ceiling) {
    fail(`initial_pages ${initial} (${initial * PAGE} bytes) does not leave room ` +
         `above memoryBase ${ceiling}: the guest needs a heap`);
  }
  if (initial > maximum) {
    fail(`initial_pages ${initial} exceeds maximum_pages ${maximum}`);
  }
  if (maximum > 65536) {
    fail(`maximum_pages ${maximum} exceeds the wasm32 ceiling of 65536`);
  }

  // The Rust build's value, when it was passed: the AS side consumes it, so a
  // disagreement is refused here rather than at session_open.
  if (expectedHash) {
    if (Number(expectedHash) !== cfg.layout_hash) {
      fail(`layout hash ${expectedHash} does not match session.json's ` +
           `${cfg.layout_hash}: re-run the generator after the arena shape ` +
           'changes, and update session.json deliberately');
    }
  }

  return cfg;
}

function renderLayout(cfg) {
  const ceiling = cfg.max_arena_size;
  const initial = cfg.initial_pages;
  const maximum = cfg.maximum_pages;

<<<<<<< HEAD
  // The import module name TensionScript emits is `env` (F1): the session
=======
  // The import module name AssemblyScript emits is `env` (F1): the session
>>>>>>> origin/main
  // defines the memory under both `env::memory` and `session::memory`, so this
  // is the spelling the toolchain's `--importMemory` produces.
  return `// Generated by scripts/gen-session.mjs from session.json — do not edit.
//
// The arena constants this guest is compiled against: what it sends in the
// session TLV, and the layout hash the session compares against its own. The
// Rust side's \`arena::layout_hash()\` is the authority for the hash; the
// cross-check test in tension-core reads this file and fails loudly if the two
// ever disagree.
//
// Memory flags this file implies (also generated, as an asconfig):
//   --importMemory --memoryBase ${ceiling} \\
//   --initialMemory ${initial} --maximumMemory ${maximum} \\
//   --exportTable --runtime incremental
// \`--noExportMemory\` is forbidden (F2) and \`--lowMemoryLimit\` likewise.

export const ABI_VERSION: u32 = ${cfg.abi_version};
export const LAYOUT_HASH: u32 = ${cfg.layout_hash};
/** The live arena this guest asks for (bytes). */
export const ARENA_SIZE: u32 = ${cfg.arena_size};
/** The ceiling, and therefore the guest's \`--memoryBase\`. */
export const MAX_ARENA_SIZE: u32 = ${ceiling};
export const MEMORY_BASE: u32 = ${ceiling};
export const INITIAL_PAGES: u32 = ${initial};
export const MAXIMUM_PAGES: u32 = ${maximum};
export const CLASS_COUNT: u32 = ${cfg.ring_capacities.length};
/** Per-class ring capacities, in class-id order. */
export const RING_CAPACITIES: u32[] = [${cfg.ring_capacities.join(', ')}];
`;
}

function renderAsconfig(cfg) {
  const doc = {
    options: {
      // `incremental`, not `stub`.  Stub's allocator is a bump pointer that
      // only frees its topmost block, so every managed allocation is
      // permanent: a guest that creates closures or async state structs grows
      // until it traps.  Measured — see docs/runtime-migration-plan.md §3 and
      // docs/runtime-migration-windows-verification.md.
      runtime: 'incremental',
      target: 'release',
      // `target: release` names a configuration; it does not optimize. Without
      // an explicit level Binaryen runs at -O0, and every field access on a
      // class emits a call to a three-instruction accessor instead of the
      // two-instruction inline load/store it becomes at -O1 and above.
      // Measured (docs/interop-surface-scope.md §2.1): 7 accessor call sites
      // and 335 wasm bytes at -O0, 0 sites and 204 bytes at -O3, on the same
      // source.
      //
      // **2, not 3, and deliberately.** Binaryen's -O3 pipeline aborts on a
      // live in-memory module in `wasm-interpreter.h` (`getSingleValue`); see
      // `docs/known-issues.md` KS-1, which lists the five falsified hypotheses
      // and the upstream report this waits on. All 17 guest fixtures compile
      // clean at -O2, and the cost is small and sometimes negative — measured
      // on this tree: `guest-hierarchy` 39,114 B at -O2 vs 39,606 at -O3,
      // `guest-skinning` 44,900 vs 45,321; the largest regression across the
      // fixtures is +0.54% (`guest-angular`).
      //
      // Raise to 3 when binaryen resolves the live-module assertion, at which
      // point this comment and KS-1 both go.
      optimizeLevel: 2,
      importMemory: true,
      memoryBase: cfg.max_arena_size,
      initialMemory: cfg.initial_pages,
      maximumMemory: cfg.maximum_pages,
      exportTable: true,
      // See the header: a start *section* is refused by the host, so the
      // runtime's initializer is exported for the host to call after it has
      // verified the arena.
      exportStart: '__start',
    },
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// ── the manifest, from the host's `TYPES` block ─────────────────────────────
//
// The host writes nine `{typeId, size, align, pad}` entries at MANIFEST_OFFSET
// (`tension-core/src/session/arena.rs`, `TYPES`). The guest reads them at
// session open and compares each entry's size against its own declaration — the
// check that would have caught the `SessionInfo` drift (guest 128, host 144) at
// the first open instead of never.
//
// **What is parsed, and what is not.** Only `{id, size, align}` come out of the
// `TYPES` array. `MANIFEST_OFFSET` and `MANIFEST_LEN` are *expressions*, not
// literals, and they are deliberately not parsed: the guest takes both from the
// runtime control block, which the host fills from the same constants. One
// fewer thing to keep in step.
//
// **Fail-closed is the point.** Every failure mode exits non-zero with the
// reason on stderr and writes nothing: an unparsable `TYPES` block, a count that
// is not 9, ids that are not 1..9 ascending, a symbolic size whose constant
// cannot be found, or an id order that disagrees with EXPECTED_NAMES. A silently
// empty or stale table is the one outcome that would make the guest's check pass
// while proving nothing, so it is not reachable.

const EXPECTED_NAMES = [
  'ArenaControl',
  'SessionInfo',
  'RegionDesc',
  'ManifestEntry',
  'TableHeader',
  'StringHalf',
  'Callbacks',
  'Subscription',
  'EventRecord',
];

// One `TypeEntry` literal, in the host's own two forms: a bare integer size
// (`id: 7, size: 64, align: 4`) or a named constant cast to u16
// (`id: 1, size: CONTROL_SIZE as u16, align: 8`). Anything else is unparsable,
// so a changed shape in `arena.rs` stops the build instead of being guessed at.
const ENTRY_RE = new RegExp(
  String.raw`^\s*TypeEntry\s*\{\s*id:\s*(\d+)\s*,\s*size:\s*` +
  String.raw`(?:([A-Za-z_][A-Za-z0-9_]*)\s+as\s+u16|(\d+))` +
  String.raw`\s*,\s*align:\s*(\d+)\s*\}\s*,?\s*$`,
);

function manifestFail(why) {
  console.error(`gen-manifest: ${why}`);
  process.exit(1);
}

function renderManifest(arenaPath) {
  let text;
  try {
    text = readFileSync(arenaPath, 'utf8');
  } catch (error) {
    // The sibling checkout is missing. Loud, named, non-zero.
    manifestFail(`cannot read the host's layout source ${arenaPath}: ${error.message}`);
  }

  // The array's extent, so a truncated or duplicated block is caught by the
  // count check below rather than by a partial table.
  const start = /pub\s+const\s+TYPES\s*:\s*\[\s*TypeEntry\s*;\s*(\d+)\s*\]\s*=\s*\[/
    .exec(text);
  if (!start) {
    manifestFail(`${arenaPath}: no \`pub const TYPES: [TypeEntry; N] = [\` block`);
  }
  const declared = Number(start[1]);
  const end = text.indexOf('];', start.index + start[0].length);
  if (end < 0) {
    manifestFail(`${arenaPath}: the TYPES block is not closed with \`];\``);
  }
  const body = text.slice(start.index + start[0].length, end);

  const entries = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = ENTRY_RE.exec(line);
    if (!match) {
      manifestFail(`${arenaPath}: unparsable TYPES line: ${JSON.stringify(line.trim())}`);
    }
    // Group 2 is the symbolic name, group 3 the bare integer; exactly one is
    // present by construction.
    const size = match[2] ? match[2] : match[3];
    entries.push([Number(match[1]), size, Number(match[4])]);
  }

  if (declared !== entries.length) {
    manifestFail(`${arenaPath}: TYPES declares ${declared} entries, ` +
                 `the block holds ${entries.length}`);
  }
  if (entries.length !== EXPECTED_NAMES.length) {
    manifestFail(`${arenaPath}: the manifest has ${entries.length} entries; ` +
                 `this guest expects ${EXPECTED_NAMES.length}`);
  }

  const ids = entries.map((entry) => entry[0]);
  const ascending = Array.from({ length: entries.length }, (_, i) => i + 1);
  if (ids.join(',') !== ascending.join(',')) {
    manifestFail(`${arenaPath}: ids [${ids}] are not 1..${entries.length} ascending`);
  }

  // Resolve a symbolic size against the same file. Exact-name match, so
  // `REGION_DESC_SIZE` cannot pick up `REGION_DESC_SIZE_FIELD`.
  const resolved = [];
  for (const [entryId, size, align] of entries) {
    if (/^\d+$/.test(size)) {
      resolved.push([entryId, Number(size), align]);
      continue;
    }
    const pattern = new RegExp(
      String.raw`^\s*pub\s+const\s+` + size.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      String.raw`\s*:\s*usize\s*=\s*(\d+)\s*;\s*$`,
      'm',
    );
    const found = pattern.exec(text);
    if (!found) {
      manifestFail(`${arenaPath}: no \`pub const ${size}: usize = N;\` for id ${entryId}`);
    }
    resolved.push([entryId, Number(found[1]), align]);
  }

  // The cross-source contract: the ids the host states must be the types this
  // guest declares, in this order. A reorder in either repository stops the
  // build instead of producing a check that compares the wrong pair.
  const pairs = resolved
    .map(([id, size, align], i) => `id ${id} = ${EXPECTED_NAMES[i]} (${size}B, align ${align})`)
    .join(', ');
  console.log(`gen-manifest: ${pairs}`);

  const idList = resolved.map(([id]) => id).join(', ');
  const sizeList = resolved.map(([, size]) => size).join(', ');
  const alignList = resolved.map(([, , align]) => align).join(', ');
  const nameList = EXPECTED_NAMES.map((name) => `"${name}"`).join(', ');

  return `// Generated by scripts/gen-session.mjs from tension-core/src/session/arena.rs
// — do not edit. Re-run the build after the host's TYPES block changes.
//
// The guest's view of the arena manifest the host writes at \`MANIFEST_OFFSET\`:
// one \`{typeId, size, align, pad}\` entry per protocol type, in id order. The
// ids and sizes are the host's (\`arena.rs\`'s \`TYPES\`); the names are this
// guest's, and the generator fails the build if the two disagree about the
// order. \`assembly/runtime/arena.ts\`'s \`manifestProblem()\` is the reader; the
// sizes here are the host's claim, and the guest's own \`sizeof\` is the other
// side of the comparison.
//
// Primitive constant arrays rather than an array of records: this is the shape
// \`layout.ts\` already uses for \`RING_CAPACITIES\`, it folds at compile time, and
// it keeps a module built almost entirely from \`@unmanaged\` views free of nine
// managed allocations at startup.

/** How many types the manifest holds, as this guest expects it. */
export const MANIFEST_ENTRY_COUNT: u32 = ${resolved.length};
/** One entry's wire size, \`{typeId: u16, size: u16, align: u16, pad: u16}\`. */
export const MANIFEST_ENTRY_SIZE: u32 = 8;

/** The host's type ids, in manifest order (1..${resolved.length}). */
export const MANIFEST_TYPE_IDS: u32[] = [${idList}];
/** This guest's name for each id, for the drift diagnostic. */
export const MANIFEST_TYPE_NAMES: string[] = [${nameList}];
/** The host's size for each id, in bytes — the claim the guest checks. */
export const MANIFEST_TYPE_SIZES: u32[] = [${sizeList}];
/** The host's alignment for each id — a manifest consistency input only. */
export const MANIFEST_TYPE_ALIGNS: u32[] = [${alignList}];
`;
}

// ── main ────────────────────────────────────────────────────────────────────

const { expectedHash } = parseArgs(process.argv.slice(2));
const sessionJson = join(framework, 'session.json');
const cfg = loadSession(sessionJson, expectedHash);

const layoutTs = join(framework, 'assembly', 'runtime', 'layout.ts');
const asconfig = join(framework, 'build', 'session.asconfig.json');
mkdirSync(dirname(layoutTs), { recursive: true });
mkdirSync(dirname(asconfig), { recursive: true });

writeFileSync(layoutTs, renderLayout(cfg), 'utf8');
console.log(`==> wrote ${layoutTs}`);
writeFileSync(asconfig, renderAsconfig(cfg), 'utf8');
console.log(`==> wrote ${asconfig}`);

const arena = join(repo, 'tension-core', 'src', 'session', 'arena.rs');
const manifestTs = join(framework, 'assembly', 'runtime', 'manifest.ts');
if (!existsSync(arena)) {
  // One repo, one checkout: the framework reads the host's source, and a
  // checkout without it fails here by design rather than silently emitting a
  // stale table.
  manifestFail(`cannot read the host's layout source ${arena}: no such file`);
}
console.log('==> generating the manifest\'s type table (from tension-core/src/session/arena.rs)');
writeFileSync(manifestTs, renderManifest(arena), 'utf8');
console.log(`gen-manifest: wrote ${manifestTs}`);

console.log('==> asc flags for a session guest:');
console.log(`    importMemory=true memoryBase=${cfg.max_arena_size} ` +
            `initialMemory=${cfg.initial_pages} maximumMemory=${cfg.maximum_pages} ` +
            'exportTable=true runtime=incremental');
