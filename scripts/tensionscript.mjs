#!/usr/bin/env node
// The repo's one way to run the TensionScript compiler.
//
// `npm run build` inside an example used to spell the compiler as a bare
// `tensionscript`. That is a **PATH lookup**, and npm's PATH for a script is the
// ancestor `node_modules/.bin` directories followed by the shell's own — so with
// no root install it reached whatever else was on the machine. Measured on this
// one: a global `@yabgu_gm/tensionscript` 0.11.0 at `~/.local/bin/tensionscript`,
// which compiled the framework's current sources into ten parse errors that named
// the framework rather than the compiler. A bare name cannot be made to fail
// closed, because the fallback is outside this repository.
//
// So every guest build names this script instead, and the resolution is
// `requireCompiler()` — the repo root only, with the provenance of the tarball
// asserted (`scripts/lib/toolchain.mjs`). The compiler's own arguments are passed
// through untouched: this only chooses *which* compiler runs.
//
//   node ../../scripts/tensionscript.mjs game.ts -o build/game.wasm

import { spawnSync } from 'node:child_process';

import { CompilerError, compilerInvocation, resolveCompiler } from './lib/toolchain.mjs';

let resolved;
try {
  resolved = resolveCompiler();
} catch (error) {
  if (error instanceof CompilerError) {
    process.stderr.write(`tensionscript: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

// One line, on stderr, every build: which compiler ran, and whether it was proven
// to be the vendored pin. "It compiled" is not evidence of *which* compiler
// compiled it, and that distinction is the whole point of the resolver.
process.stderr.write(
  resolved.version === null
    ? `tensionscript: ${resolved.bin}\n`
    : `tensionscript: ${resolved.version} from ${resolved.bin} (vendored ${resolved.tarball})\n`,
);

const invocation = compilerInvocation(resolved.bin);
const result = spawnSync(invocation.command, [...invocation.prefix, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: invocation.shell,
});

if (result.error) {
  process.stderr.write(`tensionscript: ${result.error.message}\n`);
  process.exit(1);
}
// Signal-terminated children report `status: null`; `128+n` is the shell's
// convention and keeps a caller's `$?` test meaningful either way.
process.exit(result.status === null ? 128 + (result.signal === 'SIGTERM' ? 15 : 1) : result.status);
