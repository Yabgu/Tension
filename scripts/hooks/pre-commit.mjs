// The pre-commit check: a commit that can move an ABI citation must leave the
// generated ABI docs current.
//
// ## The failure this exists for
//
// `docs/abi/guest.md` embeds the source `file:line` of every registration, so
// any edit *above* a registration shifts every row below it. Pass 1 slice 3
// regenerated the page and then added five lines to `main.rs` in the same
// commit: the diff looked complete, `abi-docs` was red on the committed tree,
// and the gate numbers in the message described an intermediate tree. That was
// not a forgotten command — `npm run docs:abi` had run. It was an ordering
// mistake inside one commit, and no amount of care in the commit message
// catches an ordering mistake. A check that runs at the last possible moment
// does.
//
// ## What it reads, and the one case it refuses
//
// The generator compares `docs/abi/*.md` on disk against what the sources on
// disk would produce. It cannot read the index. So if a staged file under
// `tension-core/` also has unstaged changes, the check would be comparing a
// different tree than the one being committed, and a pass would mean nothing.
// That case is refused outright with instructions rather than reported as a
// pass — a check that silently answers a different question is worse than no
// check.
//
// ## Cost
//
// The generator's `--check` is ~0.3 s and touches no compiler. It runs only when
// a staged path is under `tension-core/` or `docs/abi/`, so the ordinary commit
// pays nothing.
//
// `--no-verify` skips it, deliberately: a hook that cannot be bypassed is a hook
// people disable entirely.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const git = (args) => spawnSync('git', args, { encoding: 'utf8' });

// Paths that can move an ABI citation: the Rust that registers imports, the C
// header the adapter table is parsed from, the adapter sources, and the docs
// themselves (a hand-edited generated page is exactly as bad as a stale one).
const WATCHED = [
  /^tension-core\//,
  /^docs\/abi\//,
  /^tension-ogre\/src\//,
  /^tension-input\/src\//,
  /^tension-2d\/reference\//,
];

function main() {
  const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMRD']);
  if (staged.status !== 0) {
    // A hook that fails because git is unhappy would block every commit for a
    // reason unrelated to the check. Report it and let the commit through; the
    // suite is the backstop.
    process.stderr.write(`pre-commit: cannot list staged files: ${staged.stderr.trim()}\n` +
      'pre-commit: the ABI check did not run\n');
    return 0;
  }

  const paths = staged.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const touched = paths.filter((path) => WATCHED.some((pattern) => pattern.test(path)));
  if (!touched.length) return 0;

  // The generator reads the working tree. If the working tree differs from the
  // index for anything it reads, its verdict is about a tree nobody is
  // committing.
  const unstaged = git(['diff', '--name-only', '--'].concat(touched));
  const half = (unstaged.stdout ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  if (half.length) {
    process.stderr.write(
      'pre-commit: refusing — these staged files also have unstaged changes,\n' +
      'pre-commit: so the ABI check would read a different tree than the one\n' +
      'pre-commit: being committed:\n\n' +
      half.map((path) => `  ${path}\n`).join('') +
      '\npre-commit: stage them (`git add <path>`) or stash the rest, then commit again.\n');
    return 1;
  }

  const generator = join(git(['rev-parse', '--show-toplevel']).stdout.trim(),
    'scripts', 'gen-abi-doc.mjs');
  const check = spawnSync(process.execPath, [generator, '--check'], { encoding: 'utf8' });
  if (check.status === 0) return 0;

  const detail = `${check.stdout ?? ''}${check.stderr ?? ''}`.trim();
  process.stderr.write(`${detail}\n\n` +
    'pre-commit: the generated ABI docs are stale. The table embeds `file:line`,\n' +
    'pre-commit: so any edit above a registration moves every row below it.\n' +
    'pre-commit: Regenerate, stage the result, and commit again:\n\n' +
    '  npm run docs:abi && git add docs/abi && git commit ...\n\n' +
    'pre-commit: (`--no-verify` skips this check; the `abi-docs` suite will not.)\n');
  return 1;
}

process.exitCode = main();
