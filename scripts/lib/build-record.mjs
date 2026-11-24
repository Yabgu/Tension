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
// The thing that builds. For a runtime binary that is the cargo step — so
// `scripts/build-native.mjs` (release) calls {@link writeRuntimeRecord} right
// after `cargo build`, and the debug binary's writer is the same function, called
// by the step that builds it (`rebuild.mjs`'s `runtime: cargo build (dev)`).
// `--check` only ever **reads**.
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
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
 * Writes the record beside a runtime binary. Called by the build that produced it.
 *
 * `profile` is in the record because the same sources with different features or
 * a different profile are different artifacts, and a reader asking about
 * `target/release` should not be answered with `target/debug`'s provenance.
 */
export function writeRuntimeRecord(repo, profile, binaryPath) {
  const { hash, files } = runtimeInputDigest(repo);
  const record = {
    format: 1,
    inputs: hash,
    inputFiles: files,
    inputsDescription: "tension-core/src/**/*.rs, tension-res/src/**/*.zig, Cargo.toml, build.rs",
    profile,
    artifact: binaryPath,
    built: new Date().toISOString(),
  };
  writeFileSync(recordPath(binaryPath), `${JSON.stringify(record, null, 2)}\n`);
  return record;
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
