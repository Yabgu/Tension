#!/usr/bin/env node
// The end-to-end input measurement: a real device, a real guest.
//
//   node scripts/test-input.mjs --edge            (20 s)
//   EDGE_SECONDS=30 node scripts/test-input.mjs --edge
//
// The probe window ("tension-input", 320x200) appears and takes the pointer.
// While it runs: move the mouse, then press a few keys. The guest prints every
// event the session delivers and a summary at the end.
//
// POSIX/X11-only, like the capability itself: see scripts/build-input.mjs.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, WIN, npmBin } from './lib/toolchain.mjs';
import { fail, inherit, spawn } from './lib/proc.mjs';

export async function run() {
  const RUNNER = 'tension-input edge';

  if (WIN) {
    console.log(`${RUNNER}: SKIPPED — the input capability is POSIX/X11-only today`);
    return;
  }

  const repo = REPO;
  const suite = join(repo, 'tension-input');
  const framework = join(repo, 'tension-framework');
  const out = join(suite, 'build');
  const core = process.env.TENSION_CORE ??
    join(repo, 'tension-core', 'target', 'debug', 'tension-core');
  const dso = join(out, 'libtension_input.so');
  const seconds = process.env.EDGE_SECONDS ?? '20';

  if (!existsSync(core)) {
    fail(RUNNER, 'build the interpreter first: cargo build --manifest-path tension-core/Cargo.toml');
  }

  const built = inherit(process.execPath, [join(repo, 'scripts', 'build-input.mjs')]);
  if (built.status !== 0) fail(RUNNER, 'the DSO did not build');

  const hash = spawn(core, ['layout-hash']).stdout.trim();
  const generated = inherit(process.execPath,
                            [join(repo, 'scripts', 'gen-session.mjs'), '--hash', hash]);
  if (generated.status !== 0) fail(RUNNER, 'the framework generator refused the layout hash');

  const asc = npmBin(framework, 'tensionscript');
  const compiled = spawn(asc, [join(suite, 'tests', 'guest-input.ts'),
                               '--config', join(framework, 'build', 'session.asconfig.json'),
                               '-o', join(out, 'guest-input.wasm')]);
  if (compiled.status !== 0) {
    process.stderr.write(compiled.stdout + compiled.stderr);
    fail(RUNNER, 'guest-input.ts did not compile');
  }

  console.log(`===================================================================
 edge test — the end-to-end input measurement (${seconds} s)
===================================================================
What it does:  the guest opens the input capability, attaches to its own
               window, turns on relative mouse mode, and subscribes to
               INPUT_KEY (class 6) and INPUT_MOUSE (class 7). It then runs
               wait(16) + drain(6) + drain(7) and prints every event the
               session delivers, with a summary at the end.

What you do:   1. watch for a 320x200 window titled 'tension-input'
               2. move the MOUSE SLOWLY for ~5 s
               3. move the MOUSE QUICKLY for ~5 s
               4. press a few KEYS (arrows, WASD) for ~5 s
               5. CLICK a mouse button, then SCROLL the wheel
               6. pause ~5 s between phases so they separate in the output

Expected:      keys as  "KEY   flags=0x… keycode=0x… scancode=N"
               buttons/wheel as  "MOUSE shape=… a=… b=0x… f0=… f1=…"
               motion as the state's accumulated delta ("epochs with
               motion", "accumulated delta"), one per epoch — not one
               event per device sample.
               If the window does not take focus, CLICK IT: keys need
               focus, and on Wayland the compositor decides.
===================================================================`);

  // Replace this process: the probe runs until the guest exits, and a wrapper
  // would have to forward signals to no purpose.
  const result = spawn(core, ['--capability', dso, join(out, 'guest-input.wasm'),
                              '--edge', `--seconds=${seconds}`], { stdio: 'inherit' });
  process.exit(result.status);
}
