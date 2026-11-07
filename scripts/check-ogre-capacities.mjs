// The ogre table capacities must agree on both sides of the boundary.
//
// They are two independent sets of literals: the adapter's live in
// `tension-ogre/src/scene.h` (C++), the guest SDK's in
// `tension-framework/assembly/ogre/wire.ts` (TensionScript). They agree today
// by inspection, and nothing enforces it — a host count smaller than the
// guest's moves the host's table base and misreads every camera as a node,
// which is silent at run time and wrong in a way no pixel test would name.
//
// This is the guard: parse both files, compare each pair, and fail with both
// paths and both values when they disagree. It is deliberately a parse and not
// a shared schema — a schema that emits both sides is the better shape, but it
// touches codegen, and this check is what makes the drift visible until then.
//
//   node scripts/check-ogre-capacities.mjs
//   node scripts/check-ogre-capacities.mjs --json

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const headerPath = 'tension-ogre/src/scene.h';
const wirePath = 'tension-framework/assembly/ogre/wire.ts';

/// The pairs that must be equal, in the order a reader wants them: the three
/// SCENE sub-tables, then MATERIAL and RENDERABLE, then the three tables that
/// share BUFFER_POOL, then the skin window inside the procedural one.
const PAIRS = [
  ['kNodeCapacity', 'SCENE_NODE_COUNT'],
  ['kCameraCapacity', 'SCENE_CAMERA_COUNT'],
  ['kLightCapacity', 'SCENE_LIGHT_COUNT'],
  ['kMaterialCapacity', 'MATERIAL_COUNT'],
  ['kRenderableCapacity', 'RENDERABLE_COUNT'],
  ['kMotionCapacity', 'MOTION_CAPACITY'],
  ['kBoneCapacity', 'BONE_CAPACITY'],
  ['kProceduralCapacity', 'PROCEDURAL_CAPACITY'],
  ['kSkinCapacity', 'SKIN_CAPACITY'],
  ['kSkinDataCapacity', 'SKIN_DATA_CAPACITY'],
];

/// Every `constexpr uint32_t NAME = <expr>;` in the header, in file order.
function parseHeader(text) {
  const found = new Map();
  const re = /constexpr\s+uint32_t\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);/g;
  for (const match of text.matchAll(re)) {
    const line = text.slice(0, match.index).split('\n').length;
    found.set(match[1], { expr: match[2].trim(), line });
  }
  return found;
}

/// Every `export const NAME: u32 = <expr>;` in the SDK wire file.
function parseWire(text) {
  const found = new Map();
  const re = /export\s+const\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*u32\s*=\s*([^;]+);/g;
  for (const match of text.matchAll(re)) {
    const line = text.slice(0, match.index).split('\n').length;
    found.set(match[1], { expr: match[2].trim(), line });
  }
  return found;
}

/// Evaluate a constant expression whose identifiers are all defined in the same
/// table. Only integer arithmetic survives; anything else is a parse failure
/// rather than a guess, because a guess here is exactly the drift the check
/// exists to catch.
function evaluate(name, table, seen = new Set()) {
  if (seen.has(name)) throw new Error(`${name} is defined in terms of itself (cycle: ${[...seen, name].join(' -> ')})`);
  seen.add(name);
  const entry = table.get(name);
  if (!entry) throw new Error(`${name} is not defined`);

  const substituted = entry.expr.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (ident) => {
    if (!table.has(ident)) {
      throw new Error(`${name} = ${entry.expr} names ${ident}, which this file does not define`);
    }
    return String(evaluate(ident, table, new Set(seen)));
  });

  if (!/^[0-9\s+*()\-]+$/.test(substituted)) {
    throw new Error(`${name} = ${entry.expr} is not an integer constant expression`);
  }
  const value = Function(`"use strict"; return (${substituted});`)();
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} = ${entry.expr} evaluates to ${value}, which is not a capacity`);
  }
  return value;
}

function main() {
  const header = readFileSync(join(repo, headerPath), 'utf8');
  const wire = readFileSync(join(repo, wirePath), 'utf8');
  const headerConsts = parseHeader(header);
  const wireConsts = parseWire(wire);

  const rows = [];
  const problems = [];

  for (const [headerName, wireName] of PAIRS) {
    const headerEntry = headerConsts.get(headerName);
    const wireEntry = wireConsts.get(wireName);

    if (!headerEntry) {
      problems.push(`${headerPath}: no \`constexpr uint32_t ${headerName}\` — renamed or removed?`);
      continue;
    }
    if (!wireEntry) {
      problems.push(`${wirePath}: no \`export const ${wireName}: u32\` — renamed or removed?`);
      continue;
    }

    let headerValue, wireValue;
    try {
      headerValue = evaluate(headerName, headerConsts);
    } catch (error) {
      problems.push(`${headerPath}:${headerEntry.line}: ${error.message}`);
      continue;
    }
    try {
      wireValue = evaluate(wireName, wireConsts);
    } catch (error) {
      problems.push(`${wirePath}:${wireEntry.line}: ${error.message}`);
      continue;
    }

    rows.push({
      header: { name: headerName, line: headerEntry.line, expr: headerEntry.expr, value: headerValue },
      wire: { name: wireName, line: wireEntry.line, expr: wireEntry.expr, value: wireValue },
      agree: headerValue === wireValue,
    });
  }

  for (const row of rows) {
    if (!row.agree) {
      problems.push(
        `${row.header.name} is ${row.header.value} (${headerPath}:${row.header.line}) ` +
        `but ${row.wire.name} is ${row.wire.value} (${wirePath}:${row.wire.line})`,
      );
    }
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ rows, problems }, null, 2));
  } else {
    for (const row of rows) {
      const mark = row.agree ? 'ok  ' : 'FAIL';
      console.log(
        `${mark}  ${row.header.name} = ${row.header.value}` +
        `  ==  ${row.wire.name} = ${row.wire.value}` +
        `   (${headerPath}:${row.header.line} / ${wirePath}:${row.wire.line})`,
      );
    }
    for (const problem of problems) console.error(`ogre-capacities: ${problem}`);
    if (problems.length === 0) {
      console.log(
        `ogre-capacities: ${rows.length} pairs agree between ${headerPath} and ${wirePath}`,
      );
    }
  }

  return problems.length === 0 ? 0 : 1;
}

process.exit(main());
