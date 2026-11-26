// Validates the static read-set walk against ground truth the compiler already wrote.
//
// `scripts/lib/read-set.mjs` decides which trees a build reads by walking import
// literals. That is a *model* of the resolver, and a model is exactly the thing this
// project has paid for trusting. The ground truth is already on disk: a `--debug`
// artifact lists every file it read in `.debug_line`. So this compares, per artifact,
// what the walk predicted with what the compiler's own debug info says it did.
//
// Run: node scripts/check-read-set.mjs [--verbose]
//
// Exit 0 when every debug artifact agrees; 1 with the disagreements named.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";

import { REPO, compilerIdentity } from "./lib/toolchain.mjs";
import { treeDigests, readTreesFor } from "./lib/read-set.mjs";
import { readBuildRecord } from "./lib/build-record.mjs";

const PROGRAMS = join(REPO, "tension-core", "tests", "programs");
const DEBUG = join(PROGRAMS, "build", "debug");
const verbose = process.argv.includes("--verbose");

/** The file paths a `.debug_line` header names — i.e. what the compile actually read. */
function debugLineFiles(file) {
  const b = readFileSync(file);
  const leb = (buf, at) => {
    let result = 0, shift = 0, byte;
    do { byte = buf[at++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    return [result, at];
  };
  let i = 8;
  while (i < b.length) {
    const id = b[i++];
    const [size, afterSize] = leb(b, i);
    const payload = b.subarray(afterSize, afterSize + size);
    i = afterSize + size;
    if (id !== 0) continue;
    const [nameLen, afterNameLen] = leb(payload, 0);
    const name = payload.subarray(afterNameLen, afterNameLen + nameLen).toString("utf8");
    if (name !== ".debug_line") continue;
    const body = payload.subarray(afterNameLen + nameLen, afterNameLen + nameLen + 8192).toString("latin1");
    return [...body.matchAll(/[\x20-\x7e]{6,}/g)].map((m) => m[0]);
  }
  return [];
}

const identity = compilerIdentity();
const { roots } = treeDigests(REPO, identity.absolute);
if (!existsSync(DEBUG)) {
  console.error("check-read-set: no build/debug — run `node scripts/build-test-programs.mjs --debug`");
  process.exit(1);
}

let agree = 0;
const disagree = [];
for (const file of readdirSync(DEBUG).filter((f) => f.endsWith(".wasm")).sort()) {
  const artifact = join(DEBUG, file);
  const record = readBuildRecord(artifact);
  if (!record) { disagree.push(`${file}: no record`); continue; }
  const source = join(PROGRAMS, record.source);
  if (!existsSync(source)) { disagree.push(`${file}: recorded source ${record.source} is absent`); continue; }
  const predicted = readTreesFor(source, roots).framework;
  const actual = debugLineFiles(artifact).some((path) => path.includes("tension-framework"));
  if (predicted === actual) ++agree;
  else disagree.push(`${file}: walk says framework=${predicted}, .debug_line says ${actual}`);
  if (verbose) console.log(`  ${file.padEnd(32)} framework=${predicted} (debug_line: ${actual})`);
}
console.log(
  `check-read-set: ${agree}/${agree + disagree.length} debug artifacts agree with the walk` +
    (disagree.length ? `\n  ${disagree.join("\n  ")}` : ""),
);
process.exit(disagree.length === 0 ? 0 : 1);
