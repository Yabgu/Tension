// Enforce the repository's two file conventions: text files are UTF-8, and
// their line endings are LF.
//
// Windows tooling is the source of both violations: npm rewrites
// `package-lock.json` with CRLF when it runs here, an editor copies the
// environment's encoding, and a scaffolded file arrives with a BOM. A repository
// developed on Windows and built on Linux must not carry either, because they
// leak into the places that matter: `sh` refuses a script whose shebang line
// ends in CR ("bad interpreter: /bin/bash^M"), a BOM ahead of `#!` or `#pragma`
// is read as part of the first token, and a diff of the same file on the two
// platforms is noise.
//
// **The one exception is the batch file.** cmd.exe parses labels and `goto` on
// its own line-ending rules and mis-handles a bare LF, so `*.bat` and `*.cmd`
// may be CRLF — and `.gitattributes` checks them out that way. They are still
// required to be UTF-8, and to have no BOM.
//
// Binary formats are never touched. The extension list is what decides, not a
// heuristic on content: a PNG that happens to contain 0x0D 0x0A is still a PNG.
//
// Usage:
//   node scripts/normalize-eol.mjs            rewrite CRLF text files to LF, strip a UTF-8 BOM
//   node scripts/normalize-eol.mjs --check    exit 1 if any text file violates either convention
//
// `--check` is a gate (`npm test` runs it): .gitattributes normalises what git
// handles, but a tool that writes straight to disk — npm rewriting
// package-lock.json on Windows is the measured case — bypasses it until the file
// is staged. `--check` also catches what git cannot: a file that is not UTF-8 at
// all, which the old version of this script skipped in silence.
//
// Two violations are reported but never repaired: a file that is not UTF-8, and
// a bare CR (a 0x0D the author may have meant as a byte rather than an ending).
// Rewriting either would be guessing at the author's intent, so the fixer says
// what is left and exits non-zero instead of claiming success.

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

/// The kinds cmd.exe parses itself, which `.gitattributes` checks out as CRLF.
/// CRLF is allowed there and the fixer leaves those files alone.
const WINDOWS_EOL_EXTENSIONS = new Set(['.bat', '.cmd']);

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
  // The example asset workspace: fetched from the asset host, gitignored, and
  // somebody else's files. Some asset packs ship CRLF in their READMEs and
  // `.tsx`, which is theirs to have; normalising a gitignored tree would also
  // rewrite 70 MB on every check.
  join('tension-2d', 'test-assets'),
];

/// `packages/<name>-<platform>-<arch>/` is a native payload package: the
/// platform-specific half of a `file:` dependency, filled by `build:native`
/// from the OGRE install. Its contents are gitignored build products and carry
/// that install's CRLF, which is why the comment above says they are not ours to
/// normalise. Matched by shape rather than listed by name, because the set
/// depends on which platforms were built.
const PAYLOAD_PACKAGE = /^packages[\\/][a-z0-9-]+-(linux|windows|macos|darwin|win32)-[a-z0-9_]+([\\/]|$)/;

function skipped(relPath) {
  if (PAYLOAD_PACKAGE.test(relPath)) return true;
  return SKIP_PATHS.some((p) => relPath === p || relPath.startsWith(p + '/') ||
                                   relPath.startsWith(p + '\\'));
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

function isText(name) {
  if (TEXT_NAMES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  return dot >= 0 && TEXT_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/// CRLF is the file's convention when cmd.exe is the reader, and nowhere else.
function allowsCrlf(name) {
  return WINDOWS_EOL_EXTENSIONS.has(extensionOf(name));
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/// Why a file failed, in the order the checks run. `fixable` violations are the
/// ones the fixer repairs; the rest need a person.
const violations = [];
const repairable = [];
const clean = [];

function inspect(rel, buffer) {
  const kinds = [];

  // 1. Encoding. A UTF-16 file is reported by name rather than as the wall of
  // mojibake "not valid UTF-8" would describe; both are the same failure to
  // this gate, and neither is a line-ending problem to repair here.
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    kinds.push('UTF-16 LE (not UTF-8)');
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    kinds.push('UTF-16 BE (not UTF-8)');
  } else {
    try {
      utf8.decode(buffer);
    } catch {
      kinds.push('not valid UTF-8');
    }
  }

  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  if (hasBom) kinds.push('UTF-8 BOM');

  // 2. Line endings.
  let crlf = 0;
  let bareCr = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 13) continue;
    if (buffer[i + 1] === 10) crlf++;
    else bareCr++;
  }
  // A bare CR is not a line ending at all, and converting it could destroy a
  // byte the file meant. Reported, never rewritten.
  if (bareCr > 0) kinds.push(`${bareCr} bare CR`);
  const crlfIsWrong = crlf > 0 && !allowsCrlf(rel);
  if (crlfIsWrong) kinds.push(`${crlf} CRLF`);

  if (kinds.length === 0) {
    clean.push(rel);
    return;
  }
  // Only a BOM or a wrong-convention CRLF is safe to rewrite; the encoding
  // failures and bare CRs disqualify the file from repair.
  const unfixable = kinds.some((k) => k === 'not valid UTF-8' || k.endsWith('(not UTF-8)') || k.endsWith('bare CR'));
  if (unfixable) violations.push({ rel, kinds });
  else repairable.push({ rel, kinds, hasBom, crlf: crlfIsWrong });
}

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
    if (statSync(path).size === 0) continue;

    inspect(rel, readFileSync(path));
  }
}

walk(ROOT);

const windowsCrlf = clean.filter((rel) => allowsCrlf(rel));
const summary = `${clean.length} text file(s) checked, all UTF-8 and LF` +
  (windowsCrlf.length ? ` (${windowsCrlf.length} batch file(s) may be CRLF)` : '');

function reportProblems() {
  if (repairable.length > 0) {
    console.error(`normalize-eol: ${repairable.length} text file(s) to repair:`);
    for (const { rel, kinds } of repairable) console.error(`  ${rel}  [${kinds.join(', ')}]`);
  }
  if (violations.length > 0) {
    console.error(`normalize-eol: ${violations.length} text file(s) that a person must fix:`);
    for (const { rel, kinds } of violations) console.error(`  ${rel}  [${kinds.join(', ')}]`);
    console.error('  (not valid UTF-8: re-save the file as UTF-8 without a BOM;' +
      ' bare CR: decide what that byte was meant to be)');
  }
}

if (CHECK) {
  if (repairable.length === 0 && violations.length === 0) {
    console.log(`normalize-eol: ${summary}`);
    process.exit(0);
  }
  reportProblems();
  if (repairable.length > 0) console.error('  fix: node scripts/normalize-eol.mjs');
  process.exit(1);
}

let repaired = 0;
for (const { rel, hasBom, crlf } of repairable) {
  const path = join(ROOT, rel);
  let buffer = readFileSync(path);
  if (hasBom) buffer = buffer.subarray(3);
  let text = buffer.toString('utf8');
  if (crlf) text = text.replace(/\r\n/g, '\n');
  writeFileSync(path, text, 'utf8');
  repaired++;
  console.log(`repaired ${rel}${hasBom ? ' (BOM)' : ''}${crlf ? ' (CRLF→LF)' : ''}`);
}
console.log(`normalize-eol: repaired ${repaired} file(s); ${summary}`);

if (violations.length > 0) {
  reportProblems();
  process.exit(1);
}
