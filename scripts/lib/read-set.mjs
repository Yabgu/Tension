// The trees a guest compile reads, and a digest of each: **the dependency half of a
// build record.**
//
// DL46 taught the record to see a rename of its own *entry* — `record.source === rel` —
// because `git mv` keeps the mtime and a skip test that cannot see the entry path is
// wrong. DL49 is the same lesson one layer out: the record states `source`, `compiler`
// and `flags`, and DL47 renamed `tension-framework/assembly/*.ts` → `.ten`, which is
// none of the three. The skip fired, 18 debug artifacts were never rebuilt, and the
// `guests: … 70 of 70 current` row was true as stated and false as meant.
//
// # Why a per-tree digest is enough
//
// The artifact's bytes are a function of everything the compiler read. The question a
// skip test needs answered is only "could anything this build read have changed?", and
// the honest cheap answer is a digest of each tree a build can reach. It is
// **conservative on purpose**: a change anywhere in a tree rebuilds every build that
// reads that tree, which costs time and never costs correctness. The alternative — a
// per-file graph — would rebuild less and needs the resolver's own rules restated in a
// second place, which is how a build and its check come to disagree.
//
// The two trees, and the *only* reason the split matters:
//
//   std         `~lib/…`, shipped inside the compiler package. **Every** build reads it:
//               the runtime is always linked. So a std change legitimately rebuilds all.
//   framework   `tension-framework/assembly/…`, reached by relative import. Only 20 of
//               the 35 programs read it. One combined digest would rebuild all 35 for a
//               framework edit, which is over-invalidation and would make this round's
//               own gate ("only the records whose builds read that tree") false.
//
// # What "reads" means, and how it is known
//
// The compiler does not report its resolution (`cli/options.json` has no trace flag), so
// the read set is derived by a **static walk of the entry's import literals**, which is
// exact for this corpus because TensionScript imports are string literals. A specifier
// that cannot be classified is treated as reading *both* trees: an unknown import is a
// reason to rebuild, never a reason to skip.
//
// This walk is validated against ground truth rather than trusted: a `--debug` artifact
// lists every file it read in `.debug_line`, so `scripts/check-read-set.mjs` compares the
// walk's answer with the artifact's for all 35 debug builds.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { GUEST_EXTENSIONS } from "./guest-extensions.mjs";

/** Where each tree lives, given the compiler's resolved bundle path. */
export function treeRoots(repo, compilerAbsolute) {
  // `<pkg>/dist/<bundle>` → `<pkg>/std/assembly`, the copy the compile actually reads.
  // Not the checkout's `std/`: `--check`'s `compiler: std mirror` row exists precisely
  // because those are two directories, and only the installed one is read.
  const pkg = compilerAbsolute ? resolve(dirname(compilerAbsolute), "..") : null;
  return {
    std: pkg ? join(pkg, "std", "assembly") : null,
    framework: join(repo, "tension-framework", "assembly"),
  };
}

/**
 * The digest of one tree, or null when the tree is absent.
 *
 * The canonical form is `build-record.mjs`'s, so the two agree by construction: files
 * sorted by **repo-relative POSIX path**, and for each `<path>\0<sha256>\n` fed to one
 * sha256. A rename changes it (the path is in the stream), an edit changes it, and no
 * mtime appears anywhere.
 *
 * `.d.ts` is included: a declaration is read for types and a change to one can change a
 * compile's result. `.ts` is included for the same reason `std` is still `.ts` — the
 * compiler's own sources are TypeScript and a guest that reads one reads its bytes.
 */
export function treeDigest(root, repo) {
  if (root === null || !existsSync(root)) return null;
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (GUEST_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) || entry.name.endsWith(".d.ts")) {
        files.push(full);
      }
    }
  };
  walk(root);
  const rows = files.map((file) => {
    const rel = (repo ? relative(repo, file) : relative(dirname(root), file)).split(sep).join("/");
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
    return { rel, digest };
  });
  rows.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const stream = rows.map((row) => `${row.rel}\0${row.digest}\n`).join("");
  return createHash("sha256").update(stream).digest("hex");
}

/** Every tree's digest, computed once — the caller passes it to every record. */
export function treeDigests(repo, compilerAbsolute) {
  const roots = treeRoots(repo, compilerAbsolute);
  return {
    roots,
    digests: {
      std: treeDigest(roots.std, repo),
      framework: treeDigest(roots.framework, repo),
    },
  };
}

const IMPORT_RE = /\bfrom\s+"([^"]+)"/g;

/**
 * Which trees the compile of `entry` reads: `{ std, framework }`.
 *
 * A static walk of import literals, following the compiler's own resolution order for a
 * relative path (`b.ten`, `b.tension`, `b.ts`, then `b/index.*`) — the same order
 * `readFirstOf` uses in `cli/index.js`, restated here because this runs before any
 * compiler is imported.
 */
export function readTreesFor(entry, roots) {
  const read = { std: true, framework: false };
  const seen = new Set();
  const programsRoot = dirname(dirname(entry)); // .../tests/programs/<folder>/<file>

  const classify = (specifier, fromDir) => {
    if (specifier.startsWith("~lib/")) { read.std = true; return; }
    if (!specifier.startsWith(".")) {
      // A bare package. `tension-framework` is the one this repo uses; anything else is
      // unknown, so rebuild on it rather than assume it touches nothing.
      if (specifier === "tension-framework" || specifier.startsWith("tension-framework/")) read.framework = true;
      else { read.framework = true; read.std = true; }
      return;
    }
    const base = resolve(fromDir, specifier);
    if (inTree(base, roots.framework)) { read.framework = true; return; }
    if (roots.std && inTree(base, roots.std)) { read.std = true; return; }
    // A relative path that stays inside the programs tree: follow it.
    const found = firstOf(base);
    if (found !== null) follow(found);
    // Anything else resolves to a tree we did not model — rebuild rather than skip.
    else if (!inTree(base, programsRoot)) { read.framework = true; read.std = true; }
  };

  const follow = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let text;
    try { text = readFileSync(file, "utf8"); } catch { return; }
    for (const match of text.matchAll(IMPORT_RE)) classify(match[1], dirname(file));
  };

  follow(entry);
  return read;
}

function inTree(path, root) {
  if (!root) return false;
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !rel.includes(`..${sep}`));
}

function firstOf(base) {
  for (const ext of GUEST_EXTENSIONS) {
    const candidate = `${base}${ext}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const ext of GUEST_EXTENSIONS) {
    const candidate = join(base, `index${ext}`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The record's read set: only the trees this build actually read.
 *
 * Only `std` and `framework` are modelled, and the shape carries only what was read, so
 * a record with no `framework` key says "this build never reached that tree" — and a
 * framework change then has no claim on it.
 */
export function readSetFor(entry, digests, roots) {
  const read = readTreesFor(entry, roots);
  const set = {};
  if (read.std && digests.std) set.std = digests.std;
  if (read.framework && digests.framework) set.framework = digests.framework;
  return set;
}

/**
 * Whether a recorded read set still describes this tree.
 *
 * Every key the record names must still match. A **missing** key is not a pass: a record
 * written before this field existed cannot say what it read, so it cannot be trusted to
 * be current — that is what makes the first run after this change rebuild everything
 * once, and it is deliberate rather than incidental.
 */
export function sameReadSet(recorded, current) {
  if (recorded === null || typeof recorded !== "object") return false;
  const keys = Object.keys(current);
  if (keys.length === 0) return false;
  for (const key of keys) {
    if (recorded[key] !== current[key]) return false;
  }
  // A tree the record claims and the walk no longer reaches: the read set narrowed, which
  // only happens when the source changed — and then the source check catches it. Treat it
  // as a mismatch anyway, so the record never describes a read that did not happen.
  for (const key of Object.keys(recorded)) {
    if (!(key in current)) return false;
  }
  return true;
}
