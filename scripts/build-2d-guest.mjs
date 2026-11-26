#!/usr/bin/env node
// scripts/build-2d-guest.mjs — build a tension-2d example's guest.
//
// Two steps, because a guest cannot read a file at run time:
//
//   1. turn the `default_2d` graph blob into a TypeScript literal it can carry
//      (`src/graph.generated.ts`), read from the same .t2dg the build compiled
//      the adapter against;
//   2. compile the guest with TensionScript.
//
// Step 1 is the reason this script exists rather than a plain `tensionscript`
// line in package.json. The blob is the adapter's identity for a pipeline: the
// DSO embeds the modules for one hash, and a guest that sends different bytes
// gets `-ENOSYS` from `set_pipeline` because the hash is not in its table. So
// the bytes here must be the bytes the adapter was built with, and generating
// them from the checked-in .t2dg is how that stays true without anyone copying
// hex by hand.
//
// Usage: node scripts/build-2d-guest.mjs [--example <dir>]

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompilerError, resolveCompiler, spawnForm } from './lib/toolchain.mjs';
import { renderGraphBlobModule } from '../packages/cli/src/graph-blob.js';
import { spawn } from './lib/proc.mjs';

const RUNNER = 'build-2d-guest';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function die(message) {
  console.error(`${RUNNER}: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
let exampleDir = process.cwd();
let debug = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--example') exampleDir = resolve(argv[++i]);
  // `--debug` also emits a source map, which is what `launch.json` needs: the
  // map is the only thing that links a wasm instruction back to a `main.ten`
  // line. Without it a breakpoint in a 2D example lands in wasm.
  else if (argv[i] === '--debug') debug = true;
}
if (!existsSync(join(exampleDir, 'package.json'))) die(`no package.json in ${exampleDir}`);

// ── 1. the graph blob ───────────────────────────────────────────────────────
//
// `tension-2d/tests/default_2d.t2dg` is written by `scripts/build-2d.mjs` from
// `tension-core graph emit-default`, which is the same emission the adapter's
// embedded table comes from. Using that file rather than a copy keeps the guest
// and the DSO on one blob.
const blobPath = join(repo, 'tension-2d', 'tests', 'default_2d.t2dg');
if (!existsSync(blobPath)) {
  die(
    `missing ${blobPath}\n` +
      `  Run \`node scripts/build-2d.mjs\` first: it emits the blob and builds the\n` +
      `  adapter whose hash table this guest's set_pipeline call has to match.`,
  );
}

const blob = readFileSync(blobPath);
// Shared with `packages/cli/src/build.js`: the rows and the `u8[]` shape are the
// same file shape from both producers, and only the provenance comment differs.
const generated = renderGraphBlobModule({
  blob,
  generator: 'scripts/build-2d-guest.mjs',
  provenance: [
    `The \`default_2d\` graph blob, ${blob.length} bytes, from`,
    `${relative(repo, blobPath).split('\\').join('/')}. The adapter embeds the modules for this blob's`,
    'FNV-1a hash; a guest that sends other bytes gets -ENOSYS from set_pipeline.',
  ],
});

const outPath = join(exampleDir, 'src', 'graph.generated.ts');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, generated);
console.log(`${RUNNER}: ${blob.length} bytes -> ${relative(exampleDir, outPath)}`);

// ── 2. the guest ────────────────────────────────────────────────────────────
//
// The repo pins TensionScript **once**, at the root, and `requireCompiler`
// (`scripts/lib/toolchain.mjs`) is the only answer: the root `.bin`, with the
// installed copy asserted to be the tarball `.packs/manifest.json` names.
//
// **There is no bare `'tensionscript'` candidate here any more.** It was a PATH
// lookup, and measured on this machine a PATH lookup finds a *global* 0.11.0 shim
// at `~/.local/bin/tensionscript` — which is exactly how an example gets compiled
// by a compiler the tree stopped pinning four releases ago, and reports the
// resulting parse errors against the framework's source. A missing compiler is a
// setup step, and `requireCompiler` names both commands that fix it.
let compiler;
try {
  compiler = resolveCompiler(exampleDir);
} catch (error) {
  if (error instanceof CompilerError) die(error.message);
  throw error;
}
// The invocation, not a path: it already names the launcher and whether it needs
// a shell (`{ command, prefix, shell }`), so nothing here re-decides the platform.
const probeForm = spawnForm(compiler, ['--version']);
const probe = spawn(probeForm.command, probeForm.args, { shell: probeForm.shell });
if (!probe || probe.status !== 0) {
  die(`the resolved compiler ${compiler.path} does not answer --version`);
}
console.log(`${RUNNER}: ${compiler.path} (${probe.stdout.trim()})`);

// `--config` is the session config, not a preference: the guest imports its
// memory and the arena starts at address 0, which is what makes `guest_read`
// legal for a capability. A guest built without it exports its own memory, the
// session still opens, and every verb that touches guest memory answers
// -EBADF.
//
// An example may carry its own `asconfig.json` beside `package.json`, and
// hello-sprites does: the shared one declares `initialMemory: 133`, which is
// enough for a guest that never holds a frame but not for one that allocates
// 921 600 bytes for a 640x360 screenshot plus a 196 682-byte atlas. The
// example's copy is the shared file with only that number raised, so the arena
// geometry — and therefore the layout hash — is unchanged.
const localConfig = join(exampleDir, 'asconfig.json');
const config = existsSync(localConfig)
  ? localConfig
  : join(repo, 'tension-framework', 'build', 'session.asconfig.json');
if (!existsSync(config)) {
  die(`missing ${config}\n  Run \`node scripts/build-framework.mjs\` first.`);
}
console.log(`${RUNNER}: config ${relative(repo, config)}`);

mkdirSync(join(exampleDir, 'build'), { recursive: true });
const entry = join(exampleDir, 'src', 'main.ten');
const out = join(exampleDir, 'build', 'game.wasm');
const compileFlags = debug ? ['--debug', '--sourceMap'] : [];
const compileForm = spawnForm(compiler, [entry, '--config', config, ...compileFlags, '-o', out]);
const compile = spawn(compileForm.command, compileForm.args,
                      { cwd: exampleDir, shell: compileForm.shell });
if (!compile || compile.status !== 0) {
  console.error(compile?.stdout ?? '', compile?.stderr ?? '');
  die('the guest did not compile');
}
// A `--debug` build is only worth anything if the compiler actually emitted
// DWARF, so say so rather than let someone set a breakpoint in `main.ten` and
// wonder. Measured: `tensionscript` 0.13.2 emits no `.debug_info` for these
// guests with the exact flag set that does produce one for `examples/io`, and
// the cause is not isolated. The flags are correct; the compiler is silent.
if (debug) {
  const wasm = readFileSync(out);
  if (wasm.includes(Buffer.from('.debug_info')) || wasm.includes(Buffer.from('.debug_line'))) {
    console.log(`${RUNNER}: DWARF present — a breakpoint in src/main.ts will resolve`);
  } else {
    console.log(
      `${RUNNER}: asked for --debug --sourceMap, but the wasm carries no DWARF; a\n` +
        `  breakpoint will land in wasm rather than in src/main.ts. Measured with\n` +
        `  tensionscript 0.13.2 — the same flags do emit DWARF for examples/io, so this\n` +
        `  is a compiler gap for these guests, not a missing flag. See docs/debugging.md.`,
    );
  }
}
console.log(`${RUNNER}: ${relative(exampleDir, out)} (${readFileSync(out).length} bytes)`);
