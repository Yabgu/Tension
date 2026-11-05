#!/usr/bin/env node
// Run all test suites across Tension:
//
//   1. codegen            the generated wire records are current
//   2. tension-framework  the guest fixtures against the host
//   3. tension-ogre guest the capability's suite
//   4. tension-input      the input DSO's suite
//   5. tension-core       cargo test
//   6. tension-ogre unit  the adapter's C++ unit tests
//   7. tension-res        zig build test
//
// The order is the dependency order, not a preference. The `ogre_*` integration
// tests in `tension-core` load fixtures the earlier suites build — the framework's
// guest modules (for `ogre_smoke`) and the OGRE suite's compiled guests and packed
// volume — so those run before `cargo test`. A missing fixture is a hard failure
// rather than a skip (`tension-core/tests/support/ci.rs`; opt out with
// TENSION_TEST_ALLOW_SKIP=1), which is what makes this order load-bearing.
//
// Usage:
//   npm test                 run all suites
//   npm test -- --core       run one suite (see SUITES below)
//   npm test -- --list       print the suite names

import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { REPO, WIN } from './lib/toolchain.mjs';
import { inherit } from './lib/proc.mjs';

const repo = REPO;
const node = process.execPath;

// The in-tree Ogre-Next lives outside the loader's default path, and both the
// adapter and the `ogre_*` integration tests need it: the tests spawn the
// interpreter directly rather than through a recipe that sets the environment.
// `test.sh` exported this at the top for the same reason. On Windows the loader
// uses PATH and the adapter is loaded with an altered search path, so the
// directory is added there instead.
const ogreLibs = [
  join(repo, 'third_party', 'ogre-next-install', 'lib'),
  join(repo, 'third_party', 'freeimage-install', 'lib'),
].filter(existsSync);
if (ogreLibs.length) {
  if (WIN) {
    process.env.PATH = `${ogreLibs.join(delimiter)}${delimiter}${process.env.PATH ?? ''}`;
  } else {
    const existing = process.env.LD_LIBRARY_PATH;
    process.env.LD_LIBRARY_PATH = existing
      ? `${ogreLibs.join(delimiter)}${delimiter}${existing}`
      : ogreLibs.join(delimiter);
  }
}

/// Each suite: how to run it, and what it needs first.
const SUITES = {
  // Cheap, and first: a CRLF file breaks the shell scripts and generated
  // artifacts before any suite gets to run.
  eol: {
    title: 'line endings',
    run: () => inherit(node, [join(repo, 'scripts', 'normalize-eol.mjs'), '--check', repo]),
  },
  codegen: {
    title: 'codegen',
    run: () => inherit(node, [
      join(repo, 'tools', 'codegen', 'generate.mjs'),
      '--schema', join(repo, 'schema', 'ogre.json'),
      '--out-ts', join(repo, 'tension-framework', 'assembly', 'ogre', 'generated'),
      '--out-h', join(repo, 'tension-ogre', 'src', 'generated'),
      '--check',
    ]),
  },
  framework: {
    title: 'tension-framework',
    /// The fixtures are guests of the debug host, so it has to exist first. The
    /// build goes through this process's toolchain environment, which is what
    /// puts `zig` on cargo's PATH (cargo's build script runs it by name).
    prepare: () => inherit('cargo', ['build', '--manifest-path', 'tension-core/Cargo.toml',
                                     '--no-default-features']),
    run: () => inherit(node, [join(repo, 'scripts', 'test-framework.mjs')]),
  },
  'ogre-guest': {
    title: 'tension-ogre (guest)',
    run: () => inherit(node, [join(repo, 'scripts', 'test-ogre.mjs')]),
  },
  input: {
    title: 'tension-input',
    run: () => inherit(node, [join(repo, 'scripts', 'test-input.mjs')]),
  },
  core: {
    title: 'tension-core',
    // `ai` is a default feature and pulls a vendored llama.cpp build that needs
    // libclang — a heavy dependency AGENTS.md explicitly excludes from the test
    // suite. The tests therefore run with the same feature set the shipped host
    // is built with, which is also what makes this portable: on a Windows box
    // without libclang the default-feature build fails before a single test
    // runs.
    //
    // Set TENSION_AI=1 to include the ai-gated tests on a machine that has it.
    run: () => inherit('cargo', [
      'test', '--manifest-path', 'tension-core/Cargo.toml',
      ...(process.env.TENSION_AI === '1'
        ? ['--features', 'ai']
        : ['--no-default-features', '--features', 'audio']),
    ]),
  },
  'ogre-unit': {
    title: 'tension-ogre (unit)',
    run: () => inherit(node, [join(repo, 'scripts', 'build-ogre.mjs'), '--test']),
  },
  res: {
    title: 'tension-res',
    run: () => inherit('zig', ['build', 'test'], { cwd: join(repo, 'tension-res') }),
  },
};

const argv = process.argv.slice(2);
if (argv.includes('--list')) {
  for (const name of Object.keys(SUITES)) console.log(name);
  process.exit(0);
}

/// `--core` or `core` selects one suite; anything else is refused rather than
/// silently running everything.
///
/// The filter strips the `--` prefix from *every* argument and keeps what is
/// left, so `--codegen` selects codegen. The first version wrote this as
/// "drop anything starting with `--`", which dropped the only argument it was
/// given and ran all seven suites — a selector that silently means "everything"
/// is worse than one that errors.
const requested = argv
  .filter((arg) => arg !== '--all')
  .map((arg) => arg.replace(/^--/, ''))
  .filter(Boolean);

let order = Object.keys(SUITES);
if (requested.length) {
  const unknown = requested.filter((name) => !(name in SUITES));
  if (unknown.length) {
    console.error(`test: unknown suite(s): ${unknown.join(', ')}`);
    console.error(`      known: ${Object.keys(SUITES).join(', ')}`);
    process.exit(1);
  }
  order = requested;
}

const passed = [];
const failed = [];

for (const name of order) {
  const suite = SUITES[name];
  console.log('\n======================================================================');
  console.log(`==> Running ${suite.title} tests`);
  console.log('======================================================================');

  if (suite.prepare) {
    const prepared = suite.prepare();
    if (prepared.status !== 0) {
      console.log(`==> ${suite.title}: FAILED (preparation)`);
      failed.push(suite.title);
      continue;
    }
  }

  const result = suite.run();
  if (result.status === 0) {
    console.log(`==> ${suite.title}: PASSED`);
    passed.push(suite.title);
  } else {
    console.error(`==> ${suite.title}: FAILED`);
    failed.push(suite.title);
  }
}

console.log('\n======================================================================');
console.log('==> Test Summary');
console.log('======================================================================');
for (const name of passed) console.log(`  [PASS] ${name}`);
for (const name of failed) console.log(`  [FAIL] ${name}`);

if (failed.length) {
  console.error(`==> ${failed.length} test suite(s) failed.`);
  process.exit(1);
}
console.log(`==> All ${passed.length} test suite(s) passed successfully.`);
