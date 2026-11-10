#!/usr/bin/env node
// Compile and run every `ts runnable` block, and record what it prints.
//
// **Why a recorded transcript and not live execution.** The runtime instantiates
// exactly one wasm module per process, and no capability spawns a process, so a
// guest cannot run another guest. There is no `run_guest` import to call.
//
// That would be a fatal limitation for any other engine. Here it is not, because
// **a guest has no clock**: the host contributes no wall time and no entropy the
// guest did not ask for, so a guest program is a function of its inputs. Running
// it at build time and replaying those bytes is not a mock — it is the same
// answer, computed once. The viewer says "verified" and it is telling the truth.
//
// The build step is also a documentation test: a block that does not compile, or
// that crashes, fails this script and therefore the asset build. A docs page
// cannot claim a program prints something it does not print.
//
// Usage:  node tools/run-examples.mjs [--docs <docs.bin>] [--out <transcripts.bin>]

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BLOCK_FLAG, KIND } from './lib/format.mjs';
import { readDocs } from './lib/read-docs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repo = resolve(appDir, '..', '..');

/** A runnable block that outlives this is a hang, not a slow program. */
const RUN_TIMEOUT_MS = 10_000;
/** A guest that allocates without bound must not take the build down with it. */
const MAX_OUTPUT_BYTES = 64 * 1024;

function fail(message, detail = []) {
  process.stderr.write(`examples: ${message}\n`);
  for (const line of detail) process.stderr.write(`  ${line}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let docsPath = join(appDir, 'assets', 'docs.bin');
let outPath = join(appDir, 'assets', 'transcripts.bin');
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--docs') docsPath = resolve(argv[++i]);
  else if (argv[i] === '--out') outPath = resolve(argv[++i]);
  else fail(`unknown argument '${argv[i]}'`);
}

let docs;
try {
  docs = readDocs(docsPath);
} catch (error) {
  fail(`cannot read ${relative(repo, docsPath)}: ${error.message}`, [
    'build it first:  node tools/bundle.mjs',
  ]);
}

// ── the toolchain ───────────────────────────────────────────────────────────

const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';

function firstExisting(candidates) {
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

const compiler = firstExisting([
  process.env.TENSIONSCRIPT,
  join(repo, 'tension-framework', 'node_modules', '.bin', `tensionscript${EXE}`),
  join(repo, 'apps', 'docs', 'node_modules', '.bin', `tensionscript${EXE}`),
]);
if (!compiler) {
  fail('no TensionScript compiler found', [
    'looked in tension-framework/node_modules/.bin and apps/docs/node_modules/.bin',
    'run:  npm install   (in tension-framework, or at the repository root)',
  ]);
}

const suffix = `${process.platform}-${process.arch}`;
const host = firstExisting([
  process.env.TENSION_CORE,
  join(repo, 'packages', `core-${suffix}`, 'bin', `tension-core${EXE}`),
]);
if (!host) {
  fail(`no tension-core for ${suffix}`, [
    'build it:  npm run build:native   (at the repository root)',
  ]);
}

const frameworkDir = join(repo, 'tension-framework');
const sessionPath = join(frameworkDir, 'session.json');
if (!existsSync(sessionPath)) fail(`missing ${sessionPath}`);

/**
 * The compile config, from the framework's own session geometry.
 *
 * `memoryBase` must equal `max_arena_size` — it is where the guest's heap starts,
 * and the arena's region band sits below it. A guest compiled against a different
 * geometry is refused at `session_open`, so this is derived, never guessed.
 */
function asconfig(initialPages, { sessionGuest = true } = {}) {
  const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
  if (!sessionGuest) {
    // A guest that imports no `session` module owns its memory: the arena is the
    // session's, and there is none. `memoryBase` is omitted with `importMemory`
    // — there is no imported arena for a heap base to sit above.
    return {
      options: {
        runtime: 'incremental',
        target: 'release',
        optimizeLevel: 2,
        importMemory: false,
      },
    };
  }
  return {
    options: {
      runtime: 'incremental',
      target: 'release',
      optimizeLevel: 2,
      importMemory: true,
      memoryBase: session.max_arena_size,
      initialMemory: Math.max(initialPages, session.initial_pages),
      maximumMemory: session.maximum_pages,
      exportTable: true,
      exportStart: '__start',
    },
  };
}

// ── collect the blocks ──────────────────────────────────────────────────────

const runnable = docs.blocks.filter(
  (block) => block.kind === KIND.code && (block.flags & BLOCK_FLAG.runnable) !== 0,
);

if (!runnable.length) {
  process.stderr.write('examples: no runnable blocks; nothing to record\n');
}

// Each example is compiled in its own directory with `node_modules/tension-framework`
// pointing at the repository's, so `import { print } from "tension-framework"`
// resolves exactly as it does in a real project — no special-casing the import.
const workRoot = mkdtempSync(join(tmpdir(), 'tension-docs-examples-'));
process.on('exit', () => rmSync(workRoot, { recursive: true, force: true }));

const results = [];
let failures = 0;

for (let i = 0; i < runnable.length; i++) {
  const block = runnable[i];
  const page = docs.pages[block.page];
  const source = docs.blockText(block);

  const tag = `${page.path} (block ${block.index})`;
  const dir = join(workRoot, `example-${i}`);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });

  // A symlink, not a copy: the example compiles against the same framework the
  // rest of the tree does, and a copy would be a stale second SDK by tomorrow.
  const link = join(dir, 'node_modules', 'tension-framework');
  try {
    // `junction` is a Windows-only link type; POSIX wants `dir`. Node ignores
    // the type off Windows, but naming the right one keeps `readlink` output
    // honest on both.
    symlinkSync(frameworkDir, link, WIN ? 'junction' : 'dir');
  } catch (error) {
    fail(`cannot link the framework into ${dir}: ${error.message}`);
  }

  mkdirSync(join(dir, 'build'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.ts'), `${source}\n`);

  // **Not named `asconfig.json`.** TensionScript loads a file by that name from
  // the working directory when no `--config` is given, so leaving one there would
  // silently decide the memory model for a build the runner did not mean to
  // configure that way. Both variants are explicit and always passed.
  const sessionConfig = join(dir, 'session.asconfig.json');
  const standaloneConfig = join(dir, 'standalone.asconfig.json');
  const wasmPath = join(dir, 'build', 'game.wasm');
  writeFileSync(sessionConfig, `${JSON.stringify(asconfig(200), null, 2)}\n`);
  writeFileSync(standaloneConfig,
    `${JSON.stringify(asconfig(200, { sessionGuest: false }), null, 2)}\n`);

  /**
   * Compile, then check what kind of guest came out.
   *
   * **The arena belongs to the session, so only a session guest may import its
   * memory** (`tension-core/src/main.rs`: `guest_is_session_guest` is
   * `module.imports().any(|i| i.module() == "session")`, and the arena is created
   * only for one). A `print`-only snippet imports no session module, so a build
   * with `importMemory: true` produces a module whose `env::memory` import
   * nothing defines — it compiles and then refuses to instantiate with
   * "unknown import: env::memory has not been defined".
   *
   * The check is `WebAssembly.Module.imports`, not a grep of the source: what
   * matters is the module the compiler emitted, not what the text looks like.
   */
  const compile = (configPath) => spawnSync(compiler, [
    join(dir, 'src', 'main.ts'),
    '--config', configPath,
    '-o', wasmPath,
  ], { cwd: dir, encoding: 'utf8', timeout: RUN_TIMEOUT_MS });

  let compiled = compile(sessionConfig);

  if (compiled.status === 0) {
    const kinds = WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(wasmPath)));
    if (!kinds.some((entry) => entry.module === 'session')) {
      // A standalone guest — `print` and friends, no arena. Rebuild so it owns
      // its memory, which is the only shape the host can instantiate.
      compiled = compile(standaloneConfig);
      if (compiled.status !== 0) {
        failures++;
        process.stderr.write(`examples: ${tag} does not compile as a standalone guest\n`);
        for (const line of `${compiled.stdout ?? ''}${compiled.stderr ?? ''}`.split('\n').slice(0, 20)) {
          if (line.trim()) process.stderr.write(`  ${line}\n`);
        }
        results.push({ block: block.index, status: 1, stdout: '', exit: compiled.status ?? -1, duration: 0 });
        continue;
      }
    }
  }

  if (compiled.error) fail(`${tag}: the compiler did not run: ${compiled.error.message}`);
  if (compiled.status !== 0) {
    failures++;
    process.stderr.write(`examples: ${tag} does not compile\n`);
    for (const line of `${compiled.stdout ?? ''}${compiled.stderr ?? ''}`.split('\n').slice(0, 20)) {
      if (line.trim()) process.stderr.write(`  ${line}\n`);
    }
    results.push({ block: block.index, status: 1, stdout: '', exit: compiled.status ?? -1, duration: 0 });
    continue;
  }

  const started = Date.now();
  const ran = spawnSync(host, [wasmPath], {
    cwd: dir,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    // No window: a documentation example prints, it does not draw. A block that
    // tried to open one would run offscreen or fail, and either way the point of
    // the transcript is the text.
    env: { ...process.env, SDL_VIDEODRIVER: process.env.SDL_VIDEODRIVER ?? 'offscreen' },
  });
  const duration = Date.now() - started;

  if (ran.error && ran.error.code === 'ETIMEDOUT') {
    failures++;
    process.stderr.write(`examples: ${tag} did not exit within ${RUN_TIMEOUT_MS} ms\n`);
    results.push({ block: block.index, status: 2, stdout: '', exit: -1, duration });
    continue;
  }

  // A guest reports failure by trapping, so a non-zero status is a real failure
  // and not a signal to be tolerated: the docs claim the program works.
  const stdout = (ran.stdout ?? '').slice(0, MAX_OUTPUT_BYTES);
  const status = ran.status === 0 ? 0 : 1;
  if (status !== 0) {
    failures++;
    process.stderr.write(`examples: ${tag} exited ${ran.status}\n`);
    for (const line of `${stdout}${ran.stderr ?? ''}`.split('\n').filter(Boolean).slice(0, 12)) {
      process.stderr.write(`  ${line}\n`);
    }
  } else {
    process.stdout.write(`examples: ${tag} -> ${stdout.split('\n').filter(Boolean).length} line(s)\n`);
  }

  results.push({ block: block.index, status, stdout, exit: ran.status ?? -1, duration });
}

if (failures) {
  fail(`${failures} runnable example(s) failed`, [
    'a documentation example that does not run is a false claim in a page',
    'fix the block, or remove the `runnable` tag',
  ]);
}

// ── the wire ────────────────────────────────────────────────────────────────
//
// `transcripts.bin`, next to `docs.bin` and keyed by block index. A separate
// file because the two are produced by different steps and a viewer may want to
// ship the bundle without the examples.

const MAGIC = 'TNTRN1\u0000\u0000';
const VERSION = 1;
const HEADER_BYTES = 24;
const ENTRY_BYTES = 24;

const chunks = [];
let stringBytes = 0;
const entries = results.map((result) => {
  const buf = Buffer.from(result.stdout, 'utf8');
  const entry = { ...result, offset: stringBytes, length: buf.length };
  chunks.push(buf);
  stringBytes += buf.length;
  return entry;
});

const pad = (4 - (stringBytes % 4)) % 4;
const stringBlob = Buffer.concat([...chunks, Buffer.alloc(pad)]);
const paddedStrings = stringBytes + pad;

const header = Buffer.alloc(HEADER_BYTES);
header.write(MAGIC, 0, 'ascii');
header.writeUInt32LE(VERSION, 8);
header.writeUInt32LE(entries.length, 12);
header.writeUInt32LE(HEADER_BYTES + entries.length * ENTRY_BYTES, 16);
header.writeUInt32LE(paddedStrings, 20);

const table = Buffer.alloc(entries.length * ENTRY_BYTES);
entries.forEach((entry, i) => {
  const at = i * ENTRY_BYTES;
  table.writeUInt32LE(entry.block, at);
  table.writeUInt8(entry.status, at + 4);
  table.writeUInt32LE(entry.offset, at + 8);
  table.writeUInt32LE(entry.length, at + 12);
  table.writeInt32LE(entry.exit, at + 16);
  table.writeUInt32LE(entry.duration, at + 20);
});

const blob = Buffer.concat([header, table, stringBlob]);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, blob);

process.stdout.write(
  `examples: ${entries.length} transcript(s), ${(blob.length / 1024).toFixed(1)} KiB -> ` +
  `${relative(repo, outPath).split('\\').join('/')}\n`,
);
