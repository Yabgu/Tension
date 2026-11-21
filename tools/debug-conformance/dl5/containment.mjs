#!/usr/bin/env node
// DL5 phase C: containment of a JIT object's line table in its own CU ranges.
//
// Reads the ELF object wasmtime handed lldb (written by extract-object.py) with
// llvm-dwarfdump, and answers per object:
//
//   rows                    — line-table rows in .debug_line
//   rowsOut              — rows whose address is inside no CU range
//   dupPairs, gaps        — shape of the transformed .debug_ranges
//
// Every address is already a process address — llvm-dwarfdump applies the
// .rela.* entries for a relocatable object — so no relocation is done here.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "/tmp/dl5/obj";
const outPath = process.argv[3] ?? "/tmp/dl5/per-artifact-rows.json";

function dump(file, what) {
  return execFileSync("llvm-dwarfdump", [`--${what}`, file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const files = fs.readdirSync(dir).filter((name) => name.endsWith(".elf")).sort();
const rows = [];
for (const name of files) {
  const file = path.join(dir, name);
  const program = name.replace(/\.elf$/, "");

  const ranges = [];
  for (const line of dump(file, "debug-ranges").split("\n")) {
    const m = /^[0-9a-f]{8} ([0-9a-f]+) ([0-9a-f]+)$/.exec(line.trim());
    if (m) ranges.push([BigInt(`0x${m[1]}`), BigInt(`0x${m[2]}`)]);
  }
  const live = ranges.filter(([lo, hi]) => hi > lo).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const addresses = [];
  for (const line of dump(file, "debug-line").split("\n")) {
    const m = /^0x([0-9a-f]{16})\s+\d+/.exec(line.trim());
    if (m) addresses.push(BigInt(`0x${m[1]}`));
  }

  let i = 0;
  let outside = 0;
  const outsideLines = [];
  for (const address of addresses) {
    while (i < live.length && live[i][1] <= address) ++i;
    const inside = i < live.length && live[i][0] <= address && address < live[i][1];
    if (!inside) {
      ++outside;
      if (outsideLines.length < 5) outsideLines.push(`0x${address.toString(16)}`);
    }
  }

  // Shape of the transformed range list: duplicates and uncovered bytes.
  const seen = new Map();
  for (const [lo, hi] of live) {
    const key = `${lo}:${hi}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let dupPairs = 0;
  for (const count of seen.values()) if (count > 1) dupPairs += count - 1;
  let gaps = 0;
  let gapBytes = 0;
  let prev = null;
  for (const [lo, hi] of live) {
    if (prev !== null && lo > prev) {
      ++gaps;
      gapBytes += Number(lo - prev);
    }
    if (prev === null || hi > prev) prev = hi;
  }

  rows.push({
    program,
    objectBytes: fs.statSync(file).size,
    rows: addresses.length,
    rowsOut: outside,
    rowsOutPct: addresses.length ? Number(((100 * outside) / addresses.length).toFixed(1)) : null,
    rangePairs: ranges.length,
    livePairs: live.length,
    dupPairs,
    gaps,
    gapBytes,
    sampleOutside: outsideLines,
  });
  process.stdout.write(
    `${program.padEnd(24)} rows ${String(addresses.length).padStart(5)}  out ${String(outside).padStart(4)}` +
      ` (${rows.length ? ((100 * outside) / addresses.length).toFixed(1) : "?"}%)  pairs ${String(live.length).padStart(5)}` +
      `  dup ${String(dupPairs).padStart(5)}  gaps ${String(gaps).padStart(4)}\n`
  );
}

fs.writeFileSync(outPath, `${JSON.stringify({ format: "dl5-per-artifact v1", rows }, null, 2)}\n`);
console.log(`\n${files.length} objects -> ${outPath}`);
