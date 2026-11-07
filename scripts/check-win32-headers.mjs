#!/usr/bin/env node
// Guard the checked-in Win32 overlay against upstream drift.
//
// Ogre-Next generates OgreVulkanBuildSettings.h from a template at configure
// time. A cross-compile of the Win32 translation units cannot use the Linux
// build tree's copy (it selects the XCB backend), so
// `third_party/patches/win32-headers/OgreVulkanBuildSettings.h` carries a
// checked-in Win32 answer.
//
// A checked-in copy of a generated file goes stale the moment the template
// changes — and it goes stale *silently*: a symbol upstream adds would simply
// stay undefined here, which compiles, links, and leaves a backend quietly
// missing. So the symbol set is compared mechanically, both directions:
//
//   * every #cmakedefine in the template must be mentioned in the overlay
//   * every symbol the overlay mentions must still exist in the template
//
// Usage: node scripts/check-win32-headers.mjs
// Runs as the `win32-headers` suite in `npm test`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './lib/toolchain.mjs';

const repo = REPO;

const TEMPLATE = join(repo, 'third_party', 'ogre-next', 'CMake', 'Templates',
                      'OgreVulkanBuildSettings.h.in');
const OVERLAY = join(repo, 'third_party', 'patches', 'win32-headers',
                     'OgreVulkanBuildSettings.h');

/// The `OGRE_*` names a `#cmakedefine` line declares.
function templateSymbols(text) {
  const found = new Set();
  for (const line of text.split('\n')) {
    const match = /^\s*#cmakedefine\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (match) found.add(match[1]);
  }
  return found;
}

/// The `OGRE_*` names the overlay mentions, defined or not. A `/* #undef X */`
/// counts: that is how the overlay records a symbol it deliberately leaves off,
/// and recording it is the point — a silent omission is the failure this guards.
function overlaySymbols(text) {
  const found = new Set();
  for (const line of text.split('\n')) {
    const defined = /^\s*#define\s+(OGRE_VULKAN_[A-Za-z0-9_]*)/.exec(line);
    if (defined) { found.add(defined[1]); continue; }
    const undef = /^\s*\/\*\s*#undef\s+(OGRE_VULKAN_[A-Za-z0-9_]*)\s*\*\//.exec(line);
    if (undef) found.add(undef[1]);
  }
  return found;
}

function fail(lines) {
  console.error('check-win32-headers: FAIL');
  for (const line of lines) console.error(`  ${line}`);
  process.exit(1);
}

if (!existsSync(TEMPLATE)) {
  fail([`missing upstream template: ${TEMPLATE}`,
        '  the ogre-next submodule moved or is not checked out']);
}
if (!existsSync(OVERLAY)) {
  fail([`missing overlay: ${OVERLAY}`]);
}

const tmpl = templateSymbols(readFileSync(TEMPLATE, 'utf8'));
const over = overlaySymbols(readFileSync(OVERLAY, 'utf8'));

if (tmpl.size === 0) {
  fail([`no #cmakedefine symbols found in ${TEMPLATE}`,
        '  the template changed shape; this check no longer measures anything']);
}

const missing = [...tmpl].filter((symbol) => !over.has(symbol)).sort();
const stale = [...over].filter((symbol) => !tmpl.has(symbol)).sort();

if (missing.length > 0 || stale.length > 0) {
  const lines = [];
  if (missing.length > 0) {
    lines.push('upstream declares symbol(s) the overlay does not mention:');
    for (const symbol of missing) lines.push(`    ${symbol}`);
    lines.push('  Each stays undefined in a Win32 cross-compile, which compiles');
    lines.push('  and links but silently drops the feature the symbol gates.');
  }
  if (stale.length > 0) {
    lines.push('the overlay mentions symbol(s) upstream no longer declares:');
    for (const symbol of stale) lines.push(`    ${symbol}`);
    lines.push('  Upstream renamed or removed them; the overlay is stale.');
  }
  lines.push(`  template: ${TEMPLATE}`);
  lines.push(`  overlay:  ${OVERLAY}`);
  fail(lines);
}

const on = [...over].sort();
console.log(`check-win32-headers: OK — ${on.length} symbol(s) tracked, template and overlay agree`);
console.log(`  template: ${TEMPLATE}`);
console.log(`  overlay:  ${OVERLAY}`);
