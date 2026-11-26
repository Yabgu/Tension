// **What a guest source may be spelled** — one table, two scripts.
//
// `.tension` is canonical, `.ten` is the short spelling, `.ts` is accepted during a
// deprecation window so a tree that has not renamed yet keeps building. Anything else
// is refused by the compiler **by name**, with this list in the message.
//
// Kept in its own module for the reason `program-aliases.mjs` is: **two scripts need
// it and they must agree.** `scripts/build-test-programs.mjs` discovers sources, and
// `scripts/rebuild.mjs` dates artifacts against them. A copy of this list in each is
// how the build and the check come to disagree about what a program is.
//
// The compiler's own copy of this list is `ENTRY_EXTENSIONS` in TensionScript's
// `cli/index.js`; this one has to be reachable before a compiler is installed (the
// check runs in a tree with no `node_modules`), so the two are stated separately and
// `rebuild.mjs`'s `guests:` row is what would notice if they drifted — it dates every
// artifact against a source this list found.
//
// **Order is meaning.** The first spelling is the one a rename writes and the one the
// deprecation notice names; `.ts` is last because it is the one being retired.

export const GUEST_EXTENSIONS = [".tension", ".ten", ".ts"];

/** The canonical spelling, for messages and for the rename. */
export const GUEST_EXTENSION = GUEST_EXTENSIONS[0];

/** The retired spelling, accepted silently unless a caller asks for the notice. */
export const GUEST_EXTENSION_DEPRECATED = ".ts";

/**
 * The extension `file` is spelled with, or `null`.
 *
 * Longest-first, so a file is never claimed by a suffix of the extension it actually
 * has: `.tension` and `.ten` share a prefix, and a short-circuiting `startsWith` over
 * the table would call `x.ten` a `.tension` file.
 */
export function guestExtensionOf(file) {
  let found = null;
  for (const ext of GUEST_EXTENSIONS) {
    if (file.length > ext.length && file.endsWith(ext)) {
      if (found === null || ext.length > found.length) found = ext;
    }
  }
  return found;
}

/** Whether `file` is a guest source at all. */
export function isGuestSource(file) {
  return guestExtensionOf(file) !== null;
}

/** `file` without its guest extension, or `file` unchanged when it has none. */
export function guestStem(file) {
  const ext = guestExtensionOf(file);
  return ext === null ? file : file.slice(0, file.length - ext.length);
}
