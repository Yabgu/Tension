// Discover the examples and the artifacts they have built.
//
// An "example" is any directory under `examples/` with a `package.json`,
// recursively (`examples/ogre/hello-triangle`). `node_modules` is skipped: its
// packages carry their own manifests and none of them is an example.

import fs from "node:fs";
import path from "node:path";

import { configRoot, examplesRoot, repoRoot } from "./resolve.js";

/// `.../examples/ogre/hello-triangle` -> `ogre/hello-triangle`.
export function exampleName(dir) {
  return path.relative(examplesRoot, dir).split(path.sep).join("/");
}

function walk(dir, found) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") walk(full, found);
    } else if (entry.name === "package.json") {
      found.push(dir);
    }
  }
}

/// Every example directory, sorted by name.
export function discoverExamples() {
  const found = [];
  walk(examplesRoot, found);
  return found.sort().map((dir) => {
    const packagePath = path.join(dir, "package.json");
    let manifest = {};
    try {
      manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    } catch {
      manifest = {};
    }
    return {
      name: exampleName(dir),
      dir,
      manifest,
      hasBuildDebug: typeof manifest.scripts?.["build:debug"] === "string",
      artifacts: artifacts(dir),
    };
  });
}

/// Every `build/*.wasm` in an example. `build/game.wasm` is not universal: the
/// ai example builds `story.wasm` and the audio example `demo.wasm`.
export function artifacts(dir) {
  const build = path.join(dir, "build");
  let entries;
  try {
    entries = fs.readdirSync(build, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".wasm"))
    .map((entry) => path.join(build, entry.name))
    .sort();
}

/// `config/known-skips.json` as a `name -> reason` map.
///
/// The file is the record of *why* an example cannot participate. A skip that
/// lives only in code drifts; one that lives in a reviewed data file has to be
/// argued for.
export function loadKnownSkips() {
  const file = path.join(configRoot, "known-skips.json");
  const entries = JSON.parse(fs.readFileSync(file, "utf8"));
  const map = new Map();
  for (const entry of entries) {
    if (!entry.example || !entry.reason) {
      throw new Error(`${file}: every entry needs "example" and "reason"`);
    }
    map.set(entry.example, entry.reason);
  }
  return map;
}

/// `config/breakpoints.json`, split into `name -> {file, line}`.
export function loadBreakpoints() {
  const file = path.join(configRoot, "breakpoints.json");
  const entries = JSON.parse(fs.readFileSync(file, "utf8"));
  const map = new Map();
  for (const entry of entries) {
    if (!entry.example || !entry.file || !Number.isInteger(entry.line)) {
      throw new Error(`${file}: every entry needs "example", "file" and an integer "line"`);
    }
    map.set(entry.example, { file: entry.file, line: entry.line });
  }
  return map;
}

export function relativePath(target) {
  return path.relative(repoRoot, target).split(path.sep).join("/");
}
