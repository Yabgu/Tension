// Normalise line endings to LF across the repository's text files.
//
// Windows tooling is the source: npm rewrites `package-lock.json` with CRLF when
// it runs here, and the editor tools this session used picked CRLF up from the
// environment. A repository that is developed on Windows and built on Linux must
// not carry CRLF, because it leaks into the two places that matter: `sh` refuses
// a script whose shebang line ends in CR ("bad interpreter: /bin/bash^M"), and a
// diff of the same file on the two platforms is noise.
//
// Binary formats are never touched. The extension list is what decides, not a
// heuristic on content: a PNG that happens to contain 0x0D 0x0A is still a PNG.
//
// Usage:
//   node scripts/normalize-eol.mjs            rewrite every CRLF text file to LF
//   node scripts/normalize-eol.mjs --check    exit 1 if any text file is CRLF
//
// `--check` is a gate (`npm test` runs it): .gitattributes normalises what git
// handles, but a tool that writes straight to disk — npm rewriting
// package-lock.json on Windows is the measured case — bypasses it until the file
// is staged.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const ROOT = args.find((arg) => !arg.startsWith('--')) ?? process.cwd();

/// Extensions the repository treats as text.
const TEXT_EXTENSIONS = new Set([
  '.mjs', '.js', '.cjs', '.json', '.ts', '.tsx', '.md', '.markdown',
  '.rs', '.toml', '.c', '.h', '.cc', '.cpp', '.hpp', '.zig', '.f90', '.f95',
  '.yml', '.yaml', '.txt', '.cfg', '.in', '.py', '.wat', '.gitignore',
  '.gitattributes', '.gitmodules', '.sh', '.bat', '.ps1', '.lock',
]);

/// Extensionless files that are text.
const TEXT_NAMES = new Set([
  '.gitignore', '.gitattributes', '.gitmodules', 'LICENSE', 'Makefile',
  'Dockerfile', 'package-lock.json',
]);

/// Directories that are never part of the source tree.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'target', 'zig-out', '.zig-cache', 'build',
  'build-cmake', 'dist', '.tmp', '__pycache__', '.codewhale',
]);

/// Subtrees that are not this repository's to normalise.
///
/// `third_party` covers the pinned submodules *and* their build trees: OGRE's own
/// sources and the files `cmake --install` writes carry CRLF, and AGENTS.md makes
/// that whole tree read-only. The `packages/*-<platform>-<arch>` payloads are
/// build products of that install, so they inherit its line endings.
const SKIP_PATHS = [
  'third_party',
  join('packages', 'dist'),
<<<<<<< HEAD
  // The example asset workspace: fetched from the asset host, gitignored, and
  // somebody else's files. Some asset packs ship CRLF in their READMEs and
  // `.tsx`, which is theirs to have; normalising a gitignored tree would also
  // rewrite 70 MB on every check.
  join('tension-2d', 'test-assets'),
=======
>>>>>>> origin/main
];

function isText(name) {
  if (TEXT_NAMES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  return dot >= 0 && TEXT_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

<<<<<<< HEAD
/// `packages/<name>-<platform>-<arch>/` is a native payload package: the
/// platform-specific half of a `file:` dependency, filled by `build:native`
/// from the OGRE install. Its contents are gitignored build products and carry
/// that install's CRLF, which is why the comment above says they are not ours to
/// normalise. Matched by shape rather than listed by name, because the set
/// depends on which platforms were built.
const PAYLOAD_PACKAGE = /^packages[\\/][a-z0-9-]+-(linux|windows|macos|darwin|win32)-[a-z0-9_]+([\\/]|$)/;

function skipped(relPath) {
  if (PAYLOAD_PACKAGE.test(relPath)) return true;
=======
function skipped(relPath) {
>>>>>>> origin/main
  return SKIP_PATHS.some((p) => relPath === p || relPath.startsWith(p + '/') ||
                                   relPath.startsWith(p + '\\'));
}

const converted = [];
const alreadyLF = [];

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(ROOT, path);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || skipped(rel)) continue;
      walk(path);
      continue;
    }
    if (!entry.isFile() || !isText(entry.name)) continue;
    if (skipped(rel)) continue;

    const size = statSync(path).size;
    if (size === 0) continue;

    const buffer = readFileSync(path);
    if (!buffer.includes(13)) {
      alreadyLF.push(rel);
      continue;
    }

    // A CR not followed by LF is not a line ending; leave the file alone rather
    // than silently rewriting bytes the author meant.
    let crlf = 0;
    let strayCr = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== 13) continue;
      if (buffer[i + 1] === 10) crlf++;
      else strayCr++;
    }
    if (strayCr > 0) {
      console.log(`skipped (${strayCr} bare CR): ${rel}`);
      continue;
    }

    const text = buffer.toString('utf8');
    if (text.includes('\uFFFD')) {
      console.log(`skipped (not valid UTF-8): ${rel}`);
      continue;
    }

    writeFileSync(path, text.replace(/\r\n/g, '\n'), 'utf8');
    converted.push({ rel, crlf });
  }
}

walk(ROOT);

if (CHECK) {
  if (converted.length === 0) {
    console.log(`normalize-eol: ${alreadyLF.length} text file(s) checked, all LF`);
    process.exit(0);
  }
  console.error(`normalize-eol: ${converted.length} text file(s) have CRLF line endings:`);
  for (const { rel, crlf } of converted) console.error(`  ${rel} (${crlf})`);
  console.error('  fix: node scripts/normalize-eol.mjs');
  process.exit(1);
}

console.log(`converted ${converted.length} file(s) to LF`);
for (const { rel, crlf } of converted) console.log(`  ${rel} (${crlf} line endings)`);
if (process.env.VERBOSE) {
  console.log(`already LF: ${alreadyLF.length}`);
}
