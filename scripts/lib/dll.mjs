// Complete a Windows artifact's DLL closure.
//
// A Windows package is only usable if it carries its whole DLL closure: the
// adapter is compiled by MSYS2's g++ against an Ogre built by the same toolchain,
// and the resulting imports reach well past the obvious ones — `zlib1.dll` and
// `libzzip.dll` come from OgreNextMain, the MinGW runtime from every object
// compiled by g++, FreeImage from Ogre's texture codec. Missing one surfaces as
// `LoadLibrary failed with error code 126`, which names no file at all, so the
// closure is computed from the binaries rather than guessed at.
//
// `objdump -p` lists the imports (binutils ships with the compiler the build
// already requires). Anything not found in the payload or MSYS2's UCRT64 bin is a
// Windows system DLL and is left alone.

import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WIN, capture, ucrt64Bin, which } from './toolchain.mjs';

/// Copy every non-system DLL the DLLs in `libDir` depend on, transitively.
///
/// `extraSearch` is where to look besides `libDir` and UCRT64 — typically the
/// FreeImage payload's `bin/` and the MinGW compiler's own directory.
///
/// Returns the names that could not be satisfied anywhere on the search list.
/// A caller should surface those: they are the difference between a package that
/// loads and one that fails 126 three steps later.
export function stageWindowsDependencies(libDir, extraSearch = []) {
  const unresolved = new Set();
  if (!WIN) return unresolved;

  const objdump = which('objdump');
  if (!objdump) throw new Error('objdump not found; it is needed to compute the DLL closure');

  const ucrt = ucrt64Bin();
  const search = [libDir, ...extraSearch, ...(ucrt ? [ucrt] : [])];
  const seen = new Set();
  const queue = readdirSync(libDir).filter((f) => f.toLowerCase().endsWith('.dll'));

  while (queue.length) {
    const dll = queue.shift();
    const key = dll.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const path = join(libDir, dll);
    if (!existsSync(path)) continue;

    // Never silent: an unreadable import list would otherwise read as "this DLL
    // imports nothing", which is exactly how a missing dependency becomes a
    // LoadLibrary error 126 later.
    let listing;
    try {
      listing = capture(objdump, ['-p', path]);
    } catch (error) {
      throw new Error(`could not read the imports of ${path}: ${error.message}`);
    }

    for (const match of listing.matchAll(/DLL Name:\s*(\S+)/g)) {
      const dep = match[1];
      if (seen.has(dep.toLowerCase())) continue;
      const source = search.map((dir) => join(dir, dep)).find(existsSync);
      if (!source) {
        // Not on any search path. It is either a Windows system DLL (fine) or a
        // genuine gap; the caller decides by looking at what is left.
        unresolved.add(dep);
        continue;
      }
      unresolved.delete(dep);
      const target = join(libDir, dep);
      if (!existsSync(target)) cpSync(source, target);
      queue.push(dep);
    }
  }

  return unresolved;
}

/// The DLLs Windows itself provides.
///
/// Presence in the system directory is the real test — a name list rots, and the
/// first one it missed (`USP10.dll`, Uniscribe, reached through HarfBuzz) made a
/// complete package look broken. The regex is only a fallback for the API-set
/// stubs, which live in the system directory under a different prefix and are
/// not always enumerable from the search path.
const SYSTEM_DLL = /^(api-ms-win-|ext-ms-)/i;

/// The unresolved names that are *not* Windows system DLLs.
export function missingSystemFilter(unresolved) {
  const system32 = process.env.SystemRoot ? join(process.env.SystemRoot, 'System32') : null;
  return [...unresolved]
    .filter((name) => !SYSTEM_DLL.test(name))
    .filter((name) => !(system32 && existsSync(join(system32, name))))
    .sort();
}
