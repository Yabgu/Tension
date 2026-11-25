// The record a build writes beside its artifact: **what it was built from.**
//
// Second half of I86. The rebuild chain's two rows above the guests —
// `compiler: src → dist` and `runtime: src → <profile>` — were mtime comparisons,
// and DL36 is the argument against them: five guest artifacts had moved while a
// check read "0 bytes moved", because a timestamp cannot say *which sources*
// produced a file, only when it was touched. The guests got content records in
// DL36 (`scripts/lib/toolchain.mjs`, `buildRecordPath`); this is the same
// discipline for the runtime binary and for the compiler's bundle.
//
// # The canonical form
//
// Files sorted by repo-relative POSIX path; for each, `<path>\0<sha256>\n`; then
// sha256 over that stream. A rename changes it, an edit changes it, and order is
// fixed so two machines agree. **No mtime is anywhere in it.**
//
// # Who writes it
//
// **The build, and only the build** (DL42, I100). `tension-core/build.rs` writes
// `<profile>/tension-core.build.json` on every run, whatever produced the run — a
// bare `cargo build`, `cargo build --release`, or a wrapper that calls cargo. It
// used to be written here instead, by `scripts/build-native.mjs` (release) and by
// `rebuild.mjs`'s dev step, and the gap that left is the whole reason for the move:
// a bare `cargo build --release` produced a *current* binary beside a record naming
// older sources, so `--check` reported STALE for a tree that was in fact built.
// Three rounds in a row hit it (DL41 §7).
//
// `--check` only ever **reads**. Nothing in this file writes a record any more.
//
// # One definition, and why the shape changed
//
// The canonical aggregate form below is still what the *aggregate* means, and the
// Rust side computes the same one. But the check no longer depends on two languages
// agreeing about it: the record carries **one sha256 per input file**, and
// {@link verifyRuntimeRecord} compares those. A per-file digest is one algorithm
// (`sha256 of these bytes`) with no canonical form to disagree about, so a
// divergence in the aggregate can only ever mislabel a row, never hide staleness.
//
// # The compiler's bundle
//
// `dist/assemblyscript.js` lives in the compiler checkout, which is its own
// repository: its record is written by *its* build (`scripts/build.js`) using
// *its* `scripts/lib/build-record.mjs`, so the digest's definition travels with
// the tree it describes. `rebuild.mjs` imports that module from the checkout it is
// verifying rather than keeping a second copy of the canonical form — two copies
// is how a record and its check come to disagree.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The record beside a built artifact: `<artifact>.build.json`. */
export function recordPath(artifact) {
  return `${artifact}.build.json`;
}

/**
 * The runtime binary's inputs, relative to the repo.
 *
 * Every `.rs` under `tension-core/src`, plus the manifest and the build script: those three
 * are what compile into `target/<profile>/tension-core`, and the manifest decides
 * features, so leaving it out would call a binary current after a feature change.
 * Every `.zig` under `tension-res/src` is linked statically through `build.rs`, so it is an
 * input of the binary as surely as the Rust is.
 */
export const RUNTIME_INPUTS = {
  dirs: [["tension-core/src", (name) => name.endsWith(".rs")], ["tension-res/src", (name) => name.endsWith(".zig")]],
  files: ["tension-core/Cargo.toml", "tension-core/build.rs"],
};

/** Canonical digest of the runtime's inputs: `{ hash, files }`. */
export function runtimeInputDigest(repo) {
  const entries = [];
  for (const [dir, include] of RUNTIME_INPUTS.dirs) {
    const root = join(repo, dir);
    if (!existsSync(root)) continue;
    const walk = (rel) => {
      for (const entry of readdirSync(join(repo, rel), { withFileTypes: true })) {
        const childRel = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(childRel);
        else if (entry.isFile() && include(entry.name)) entries.push(childRel);
      }
    };
    walk(dir);
  }
  for (const file of RUNTIME_INPUTS.files) {
    if (existsSync(join(repo, file))) entries.push(file);
  }
  entries.sort();
  const stream = createHash("sha256");
  for (const rel of entries) {
    const digest = createHash("sha256").update(readFileSync(join(repo, rel))).digest("hex");
    stream.update(`${rel}\0${digest}\n`);
  }
  return { hash: stream.digest("hex"), files: entries.length };
}

/**
 * Verifies the record the **build** wrote beside `binary` (DL42, I100).
 *
 * Three answers, in the order that makes the message useful:
 *
 * 1. no record → the build did not run since this hook existed, or the record was
 *    deleted: STALE either way, and said so rather than assumed current;
 * 2. a record whose input *set* is not the set on disk → a file that the binary was
 *    not built from, or one it was built from that has since gone;
 * 3. a per-file digest that moved → the binary predates that file, and the file is
 *    named. This is the answer a round cannot fake: it reads content, and a `touch`
 *    or a checkout changes no digest.
 *
 * Returns `{ ok, hash, files, reason }`. `hash` is the record's own aggregate, for
 * the row's label — verification is per file, so nothing depends on it agreeing
 * with a second implementation of the canonical form.
 */
export function verifyRuntimeRecord(repo, artifact) {
  const record = readBuildRecord(artifact);
  if (record === null) {
    return { ok: false, hash: null, files: 0, reason: "no build record beside the binary" };
  }
  if (!Array.isArray(record.files) || record.files.length === 0) {
    // A `format: 1` record: an aggregate with no per-file digests, written by the
    // wrapper this round removed. It cannot be verified, only believed, so it is
    // reported as needing a rebuild rather than read as current.
    return {
      ok: false,
      hash: record.inputs ?? null,
      files: record.inputFiles ?? 0,
      reason: "record predates per-file digests (rebuild: it is written by the build now)",
    };
  }
  const expected = new Map(record.files.map((entry) => [entry.path, entry.sha256]));
  const { files } = runtimeInputDigest(repo);
  const current = [];
  for (const [dir, include] of RUNTIME_INPUTS.dirs) {
    const root = join(repo, dir);
    if (!existsSync(root)) continue;
    const walk = (rel) => {
      for (const entry of readdirSync(join(repo, rel), { withFileTypes: true })) {
        const childRel = `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(childRel);
        else if (entry.isFile() && include(entry.name)) current.push(childRel);
      }
    };
    walk(dir);
  }
  for (const file of RUNTIME_INPUTS.files) {
    if (existsSync(join(repo, file))) current.push(file);
  }
  current.sort();
  for (const rel of current) {
    if (!expected.has(rel)) {
      return {
        ok: false,
        hash: record.inputs,
        files,
        reason: `built before ${rel} was added`,
      };
    }
  }
  const present = new Set(current);
  for (const rel of expected.keys()) {
    if (!present.has(rel)) {
      return { ok: false, hash: record.inputs, files, reason: `${rel} is gone but the binary was built from it` };
    }
  }
  for (const rel of current) {
    const digest = createHash("sha256").update(readFileSync(join(repo, rel))).digest("hex");
    if (digest !== expected.get(rel)) {
      return { ok: false, hash: record.inputs, files, reason: `built before ${rel} changed` };
    }
  }
  return { ok: true, hash: record.inputs, files: record.inputFiles ?? current.length, reason: "current" };
}

/** The record beside `artifact`, or `null` when there is none or it is unreadable. */
export function readBuildRecord(artifact) {
  const path = recordPath(artifact);
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}
