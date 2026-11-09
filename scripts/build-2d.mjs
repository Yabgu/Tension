#!/usr/bin/env node
//
// The renderer lives in `tension-core/src/render2d/` as of Pass B of the merge,
// so nothing here compiles C++ any more. What this script still does is produce
// the artifacts both the build and the parity test read:
//
//   1. `tension-shadergen`'s `emit` binary writes the preset's GLSL. The shaders
//      are generated, never checked in: a hand-written .vert beside a generator
//      is the drift this whole crate exists to prevent.
//   2. `compile_spirv` (tension-shadergen) compiles them to Vulkan SPIR-V with
//      Naga. Naga, not glslangValidator: a renderer's build should not depend on
//      a system binary, and it is the same library the runtime compiler uses.
//   2b. `tension-core graph emit-default` lowers the graph, writes its GLSL, and
//      the GLSL is compiled the same way. The build **fails** if the graph's
//      modules differ from the preset's, which is the claim the whole
//      preset-versus-graph exercise rests on.
//
// The .spv files are what `tension-core/tests/render2d_parity.rs` compares the
// in-core compiler's output against, byte for byte. That is why this script
// still runs even though no binary links its output: it is the C++ build's
// record of what the shaders are, and the port is held to it.
//
// The blobs (`tension-2d/tests/*.t2dg`) are written here too, so a stale blob
// cannot make `set_pipeline` answer `-ENOSYS` for a graph the build just
// compiled.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXE, WIN, baseEnv, which } from './lib/toolchain.mjs';

const RUNNER = 'build-2d';
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = here;
const src = join(repo, 'tension-2d');
const out = join(src, 'build');

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const env = opts.env ?? baseEnv();
  let executable = cmd;
  if (!cmd.includes('/') && !cmd.includes('\\')) {
    executable = which(cmd) ?? cmd;
  }
  const dir = dirname(executable);
  if (dir && existsSync(dir)) {
    env.PATH = `${dir}${delimiter}${env.PATH ?? ''}`;
  }
  const result = spawnSync(executable, args, { encoding: 'utf8', env, ...opts });
  if (result.error) return null;
  return result;
}

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
const compileSpirv = join(repo, 'tension-shadergen', 'target', 'debug', `compile_spirv${EXE}`);
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

console.log(`${RUNNER}: shader modules written to ${shaders} and ${graphDir}`);

// ── 3. the C++ adapter, only when asked ──────────────────────────────────────
//
// The renderer is in core, so the default build links nothing. The DSO survives
// for exactly one purpose: `--no-default-features` produces a binary with no
// `tension::2d` imports at all, and the only way to give that binary a working
// 2D path is to load one. Without this branch the bisect escape hatch would be
// a flag that builds a binary nothing can use.
//
// Sources are `tension-2d/reference/` — the pre-port C++ — plus the embedded
// `shaders_spv.h` this script used to write. That header is regenerated here,
// in this branch only, because nothing else reads it.
const buildCpp = process.argv.includes('--cpp') || process.env.TENSION_RENDER2D === 'cpp';
if (!buildCpp) {
  console.log(`${RUNNER}: in-core build — no C++ adapter linked (pass --cpp for the bisect DSO)`);
  process.exit(0);
}

function findSdl3() {
  const pkg = which('pkg-config');
  if (pkg) {
    const exists = run(pkg, ['--exists', 'sdl3']);
    if (exists && exists.status === 0) {
      const cflags = run(pkg, ['--cflags', 'sdl3']);
      const libs = run(pkg, ['--libs', 'sdl3']);
      if (cflags?.status === 0 && libs?.status === 0) {
        return {
          cflags: cflags.stdout.trim().split(/\s+/).filter(Boolean),
          libs: libs.stdout.trim().split(/\s+/).filter(Boolean),
        };
      }
    }
  }
  for (const prefix of [process.env.TENSION_SDL3_PREFIX, '/usr/local', '/usr'].filter(Boolean)) {
    if (existsSync(join(prefix, 'include', 'SDL3', 'SDL.h'))) {
      return {
        cflags: [`-I${join(prefix, 'include')}`],
        libs: [`-L${join(prefix, 'lib')}`, '-lSDL3'],
      };
    }
  }
  return null;
}

const sdl = findSdl3();
if (!sdl) {
  die('SDL3 not found. Install it (Arch: pacman -S sdl3 · Debian: apt install libsdl3-dev ·\n' +
      '  MSYS2: pacman -S mingw-w64-ucrt-x86_64-sdl3), or set TENSION_SDL3_PREFIX.');
}
const cxx = process.env.CXX ?? (WIN ? 'g++' : 'c++');
const cxxProbe = run(cxx, ['--version']);
if (!cxxProbe || cxxProbe.status !== 0) die(`${cxx} not found on PATH.`);

// The embedded modules, regenerated for this branch only.
function emitArray(name, path) {
  const bytes = readFileSync(path);
  const rows = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = [...bytes.subarray(i, i + 16)].map((b) => `0x${b.toString(16).padStart(2, '0')}`);
    rows.push(`    ${slice.join(', ')},`);
  }
  return `static const unsigned char ${name}[] = {\n${rows.join('\n')}\n};\n` +
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

const keyRows = readFileSync(join(graphDir, 'default_2d.keys.txt'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => line.split(/\s+/))
  .map(([offset, dtype, scale]) => `    {${offset}, ${dtype}, ${Number(scale).toFixed(1)}f},`)
  .join('\n');

writeFileSync(
  join(out, 'shaders_spv.h'),
  `// Generated by scripts/build-2d.mjs --cpp — do not edit.\n` +
  `#ifndef TENSION_2D_SHADERS_SPV_H\n#define TENSION_2D_SHADERS_SPV_H\n\n` +
  emitArray('kSpriteVertSpv', join(shaders, 'default_2d.vert.spv')) + `\n` +
  emitArray('kSpriteFragSpv', join(shaders, 'default_2d.frag.spv')) + `\n` +
  GRAPHS.map((name) => {
    const id = name.replace(/-/g, '_');
    return emitArray(`kGraph_${id}_Vert`, join(graphDir, `${name}.graph.vert.spv`)) + `\n` +
      emitArray(`kGraph_${id}_Frag`, join(graphDir, `${name}.graph.frag.spv`));
  }).join('\n') + `\n` +
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
  `#define TENSION_2D_SORT_KEY_COUNT ${keyRows.split('\n').length}\n` +
  `static const struct { unsigned short offset; unsigned char dtype; float scale; } kSortKeys[] = {\n` +
  `${keyRows}\n};\n\n#endif\n`,
);
console.log(`${RUNNER}: embedded ${join(out, 'shaders_spv.h')}`);

const reference = join(src, 'reference');
const artifact = join(out, WIN ? 'libtension_2d.dll' : 'libtension_2d.so');
const link = run(cxx, [
  '-std=c++17', '-O2', '-g', '-fPIC', '-Wall', '-Wextra',
  `-I${join(src, 'include')}`,
  `-I${reference}`,
  `-I${out}`,
  `-I${join(repo, 'tension-core', 'include')}`,
  ...sdl.cflags,
  join(reference, 'adapter.cpp'),
  join(reference, 'render.cpp'),
  join(reference, 'texture.cpp'),
  '-shared',
  '-o', artifact,
  ...sdl.libs,
  ...(WIN ? [] : ['-lpthread']),
]);
if (link.stdout.trim()) console.log(link.stdout.trim());
if (link.stderr.trim()) process.stderr.write(link.stderr);
if (link.status !== 0) die('link failed');
console.log(`${RUNNER}: built ${artifact} (bisect DSO, from tension-2d/reference/)`);
