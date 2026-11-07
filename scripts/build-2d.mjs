#!/usr/bin/env node
// scripts/build-2d.mjs — build libtension_2d.so.
//
// Four steps, in order, because each one's output is the next one's input:
//
//   1. `tension-shadergen`'s `emit` binary writes the preset's GLSL. The shaders
//      are generated, never checked in: a hand-written .vert beside a generator
//      is the drift this whole crate exists to prevent.
//   2. `compile_spirv` (tension-shadergen) compiles them to Vulkan SPIR-V with
//      Naga. Naga, not glslangValidator: a capability's build should not depend
//      on a system binary, and it is the same library the runtime compiler uses.
//   3. The modules are embedded as a C header, because the adapter compiles its
//      pipeline once and must not shell out to a compiler at run time.
//   4. The DSO is linked against SDL3 and nothing else.
//
// Mirrors scripts/build-input.mjs, including the DT_NEEDED print at the end: a
// reviewer should be able to see the dependency surface without asking.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = 'build-2d';
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = here;
const src = join(repo, 'tension-2d');
const out = join(src, 'build');
const WIN = process.platform === 'win32';

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (result.error) return null;
  return result;
}

function pkgConfig(args) {
  return run('pkg-config', args);
}

function findSdl3() {
  const probe = pkgConfig(['--exists', 'sdl3']);
  if (probe && probe.status === 0) {
    const cflags = pkgConfig(['--cflags', 'sdl3']);
    const libs = pkgConfig(['--libs', 'sdl3']);
    if (cflags?.status === 0 && libs?.status === 0) {
      const version = pkgConfig(['--modversion', 'sdl3']);
      console.log(`${RUNNER}: SDL3 ${version?.stdout.trim() ?? ''} via pkg-config`);
      return {
        cflags: cflags.stdout.trim().split(/\s+/).filter(Boolean),
        libs: libs.stdout.trim().split(/\s+/).filter(Boolean),
      };
    }
  }
  for (const prefix of [process.env.TENSION_SDL3_PREFIX, '/usr/local', '/usr'].filter(Boolean)) {
    if (!existsSync(join(prefix, 'include', 'SDL3', 'SDL.h'))) continue;
    console.log(`${RUNNER}: SDL3 at ${prefix} (headers, no pkg-config)`);
    return { cflags: [`-I${join(prefix, 'include')}`], libs: [`-L${join(prefix, 'lib')}`, '-lSDL3'] };
  }
  return null;
}

const sdl = findSdl3();
if (!sdl) {
  die('SDL3 not found. Install it (Arch: pacman -S sdl3 · Debian: apt install libsdl3-dev),\n' +
      '  or set TENSION_SDL3_PREFIX.');
}

const cxx = process.env.CXX ?? (WIN ? 'g++' : 'c++');
const cxxProbe = run(cxx, ['--version']);
if (!cxxProbe || cxxProbe.status !== 0) die(`${cxx} not found on PATH.`);

// The shader compiler: tension-shadergen's `compile_spirv`, built once here and
// reused for every stage. It is Rust and pure, so there is no version probe and
// no system package to be missing.
const buildCompiler = run('cargo', [
  'build', '--quiet',
  '--manifest-path', join(repo, 'tension-shadergen', 'Cargo.toml'),
  '--bin', 'compile_spirv',
]);
if (!buildCompiler || buildCompiler.status !== 0) {
  console.error(buildCompiler?.stdout ?? '', buildCompiler?.stderr ?? '');
  die('building compile_spirv failed');
}
const compileSpirv = join(repo, 'tension-shadergen', 'target', 'debug', 'compile_spirv');
if (!existsSync(compileSpirv)) die(`expected ${compileSpirv} after the build`);

/// GLSL file -> SPIR-V file. Stage is `vert` or `frag`.
function toSpirv(input, stage) {
  const result = run(compileSpirv, ['--stage', stage, '--in', input, '--out', `${input}.spv`]);
  if (!result || result.status !== 0) {
    console.error(result?.stdout ?? '', result?.stderr ?? '');
    die(`compile_spirv failed on ${input}`);
  }
}

mkdirSync(out, { recursive: true });
const shaders = join(out, 'shaders');
mkdirSync(shaders, { recursive: true });

// ── 1. generate the GLSL ─────────────────────────────────────────────────────
const emit = run('cargo', [
  'run', '--quiet',
  '--manifest-path', join(repo, 'tension-shadergen', 'Cargo.toml'),
  '--bin', 'emit',
  '--', '--out', shaders,
]);
if (!emit || emit.status !== 0) {
  console.error(emit?.stdout ?? '', emit?.stderr ?? '');
  die('tension-shadergen emit failed');
}
console.log(`${RUNNER}: generated ${join(shaders, 'default_2d.vert')} and .frag`);

// ── 2. compile them to SPIR-V ────────────────────────────────────────────────
for (const [file, stage] of [['default_2d.vert', 'vert'], ['default_2d.frag', 'frag']]) {
  const input = join(shaders, file);
  toSpirv(input, stage);
}
console.log(`${RUNNER}: SPIR-V written (Naga)`);

// ── 2b. the graph path ──────────────────────────────────────────────────────
//
// `tension-core graph emit-default` parses, validates and lowers the graph
// blob, writing the GLSL and the comparator's key table. Compiling it here and
// comparing the result to the preset's SPIR-V is the claim Part 3 rests on: the
// graph path is not "another shader that happens to work", it is the same
// modules by construction, and the build fails if they ever diverge.
const graphDir = join(out, 'graph');
mkdirSync(graphDir, { recursive: true });
const emitGraph = run('cargo', [
  'run', '--quiet',
  '--manifest-path', join(repo, 'tension-core', 'Cargo.toml'),
  '--bin', 'tension-core',
  '--', 'graph', 'emit-default', '--out', graphDir,
]);
if (!emitGraph || emitGraph.status !== 0) {
  console.error(emitGraph?.stdout ?? '', emitGraph?.stderr ?? '');
  die('tension-core graph emit-default failed');
}
console.log(`${RUNNER}: ${emitGraph.stdout.trim().split('\n')[0]}`);

const GRAPHS = ['default_2d', 'default_2d_scaled'];
// The first guest pipe id (TENSION_2D_PIPE_GUEST_MIN). `default_2d` keeps 100
// because the previous slice pinned it; the scaled pipeline takes the next.
const PIPE_IDS = { default_2d: 100, default_2d_scaled: 101 };

for (const name of GRAPHS) {
  for (const [file, stage] of [[`${name}.graph.vert`, 'vert'], [`${name}.graph.frag`, 'frag']]) {
    const input = join(graphDir, file);
    toSpirv(input, stage);
  }
}

// `default_2d` must still be the *same modules* as the hand-written preset —
// that assertion was this compiler's acceptance test and it does not get to
// weaken because a second pipeline arrived. `default_2d_scaled` has no preset to
// compare against; that absence is the point of it.
for (const [preset, graph] of [
  ['default_2d.vert.spv', 'default_2d.graph.vert.spv'],
  ['default_2d.frag.spv', 'default_2d.graph.frag.spv'],
]) {
  const a = readFileSync(join(shaders, preset));
  const b = readFileSync(join(graphDir, graph));
  if (!a.equals(b)) {
    die(`${preset} and ${graph} differ — the graph and the preset have drifted`);
  }
}
console.log(`${RUNNER}: default_2d SPIR-V is byte-identical to the preset's`);

// And the scaled pipeline must *differ* from the preset, or the graph that is
// supposed to prove the compiler general compiled to nothing at all.
{
  const preset = readFileSync(join(shaders, 'default_2d.vert.spv'));
  const scaled = readFileSync(join(graphDir, 'default_2d_scaled.graph.vert.spv'));
  if (preset.equals(scaled)) {
    die('default_2d_scaled compiled to the preset byte for byte — the graph had no effect');
  }
}
console.log(`${RUNNER}: default_2d_scaled SPIR-V differs from the preset, as it must`);

// The blobs the smoke test loads live beside it, and are written here so they
// cannot drift from the artifacts this DSO was built with: a stale .t2dg would
// make `set_pipeline` answer -ENOSYS for a graph the build had just compiled.
const testDir = join(src, 'tests');
mkdirSync(testDir, { recursive: true });
for (const name of GRAPHS) {
  copyFileSync(join(graphDir, `${name}.t2dg`), join(testDir, `${name}.t2dg`));
}
console.log(`${RUNNER}: wrote ${GRAPHS.length} blobs to ${testDir}`);

// ── 3. embed ─────────────────────────────────────────────────────────────────
function emitArray(name, path) {
  const bytes = readFileSync(path);
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = [...bytes.subarray(i, i + 16)].map((b) => `0x${b.toString(16).padStart(2, '0')}`);
    lines.push(`    ${slice.join(', ')},`);
  }
  return `static const unsigned char ${name}[] = {\n${lines.join('\n')}\n};\n` +
         `static const unsigned long ${name}Len = ${bytes.length}ul;\n`;
}

/// FNV-1a 64, matching `pipeline::Graph::hash` in Rust byte for byte.
function fnv1a(bytes) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash;
}

function emitKeyTable(path) {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/));
  const rows = lines
    .map(([offset, dtype, scale]) => `    {${offset}, ${dtype}, ${Number(scale).toFixed(1)}f},`)
    .join('\n');
  return (
    `// The comparator's key list, read from the graph's make_tuple(...) and\n` +
    `// emitted by tension-core graph emit-default. The third column is the\n` +
    `// factor a mul key applies, 1.0 for a plain load_field.\n` +
        `#define TENSION_2D_SORT_KEY_COUNT ${lines.length}\n` +
    `static const struct { unsigned short offset; unsigned char dtype; float scale; } kSortKeys[] = {\n` +
    `${rows}\n};\n`
  );
}

const header =
  `// Generated by scripts/build-2d.mjs — do not edit.\n` +
  `// Source: tension-shadergen's emit binary and tension-core's graph lowering,\n` +
  `// compiled by Naga (tension-shadergen/src/bin/compile_spirv.rs).\n` +
  `#ifndef TENSION_2D_SHADERS_SPV_H\n#define TENSION_2D_SHADERS_SPV_H\n\n` +
  emitArray('kSpriteVertSpv', join(shaders, 'default_2d.vert.spv')) +
  `\n` +
  emitArray('kSpriteFragSpv', join(shaders, 'default_2d.frag.spv')) +
  `\n` +
  GRAPHS.map((name) => {
    const id = name.replace(/-/g, '_');
    return emitArray(`kGraph_${id}_Vert`, join(graphDir, `${name}.graph.vert.spv`)) +
      `\n` +
      emitArray(`kGraph_${id}_Frag`, join(graphDir, `${name}.graph.frag.spv`));
  }).join('\n') +
  `\n` +
  `// The graphs this DSO can draw, identified by the FNV-1a hash of their blob.\n` +
  `// A blob whose hash is not here is -ENOSYS: there is no runtime compiler.\n` +
  `struct Tension2dGraphPipe {\n` +
  `    unsigned long long hash;\n` +
  `    unsigned int pipe_id;\n` +
  `    const unsigned char *vs;\n` +
  `    unsigned long vs_len;\n` +
  `    const unsigned char *fs;\n` +
  `    unsigned long fs_len;\n` +
  `};\n` +
  `#define TENSION_2D_GRAPH_PIPE_COUNT ${GRAPHS.length}\n` +
  `static const struct Tension2dGraphPipe kGraphPipes[] = {\n` +
  GRAPHS.map((name) => {
    const id = name.replace(/-/g, '_');
    const hash = fnv1a(readFileSync(join(graphDir, `${name}.t2dg`)));
    return `    {0x${hash.toString(16).padStart(16, '0')}ull, ${PIPE_IDS[name]}, ` +
      `kGraph_${id}_Vert, kGraph_${id}_VertLen, kGraph_${id}_Frag, kGraph_${id}_FragLen},`;
  }).join('\n') +
  `\n};\n` +
  emitKeyTable(join(graphDir, 'default_2d.keys.txt')) +
  `\n#endif\n`;
writeFileSync(join(out, 'shaders_spv.h'), header);
console.log(`${RUNNER}: embedded ${join(out, 'shaders_spv.h')}`);

// ── 4. link the DSO ──────────────────────────────────────────────────────────
// -std=c++17 matches the other adapters. No SDL_shadercross: v1 targets Linux
// with SPIR-V produced at build time (DESIGN.md §8.1).
const args = [
  '-std=c++17', '-O2', '-fPIC', '-Wall', '-Wextra',
  `-I${join(src, 'include')}`,
  `-I${join(src, 'src')}`,
  `-I${out}`,
  `-I${join(repo, 'tension-core', 'include')}`,
  ...sdl.cflags,
  join(src, 'src', 'adapter.cpp'),
  join(src, 'src', 'render.cpp'),
  join(src, 'src', 'texture.cpp'),
  '-shared',
  '-o', join(out, WIN ? 'libtension_2d.dll' : 'libtension_2d.so'),
  ...sdl.libs,
  ...(WIN ? [] : ['-lpthread']),
];

const link = run(cxx, args);
if (link.stdout.trim()) console.log(link.stdout.trim());
if (link.stderr.trim()) process.stderr.write(link.stderr);
if (link.status !== 0) die('link failed');

console.log(`${RUNNER}: built ${join(out, WIN ? 'libtension_2d.dll' : 'libtension_2d.so')}`);

// The dependency surface, printed so nobody has to ask.
if (!WIN) {
  const needed = run('objdump', ['-p', join(out, 'libtension_2d.so')]);
  if (needed?.status === 0) {
    const lines = needed.stdout.split('\n').filter((l) => l.includes('NEEDED'));
    console.log(`${RUNNER}: DT_NEEDED`);
    for (const line of lines) console.log(`  ${line.trim()}`);
  }
}
