// What one example's run *means*, in four words and one more (DL63).
//
// Extracted from `scripts/run-examples.mjs` so it can be tested without building
// anything: the classifier is the instrument's judgement, and a judgement nothing
// checks is how this project keeps shipping green tables over broken guests.
//
// The words, in the order they are decided:
//
//   hung             no exit before the timeout (SIGKILL after)
//   ran-but-failed   **exit 0, and the transcript says the guest failed** — new in
//                    DL63. Four OGRE examples printed `resources/models/*.mesh did
//                    not load (errno -5)` and exited 0, and read as `ran` for four
//                    rounds.
//   ran              exit 0 and nothing said otherwise
//   refused-by-name  exited non-zero and the output names a refusal
//   needs-display    exited non-zero and the output says there is no display/device
//   failed           exited non-zero and named neither — a crash (DL63)
//
// `ran-but-failed` is **not** a full answer to "did it do any work". It detects a
// guest that *said* it failed; a guest that silently finished early is still `ran`.
// That limit is the census's, and it is stated in the report rather than papered
// over with a guess.

/// Output that is the tree refusing something on purpose. `refused`, `not
/// implemented`, `unavailable`, a capability the build does not have — all of these
/// are the loader or the guest naming a limit, which is a pass for this instrument
/// even though the exit is 1.
export const REFUSAL_SIGNS = [
  'refused',
  // **The host's own sentence** (DL63): `… refusing by name, nothing was run`. The list
  // held `refused` but not `refusing`, so the census could not recognise the one refusal
  // the project prints most — it fell through to whichever word came next.
  'refusing by name',
  'not implemented',
  'not available',
  'requires ',
  'unsupported',
  'did not export',
  'declares `start`',
  'needs a session',
  'no session',
  // **A missing tool, named with how to install it** (DL63). `solver/collision` prints
  // `gnuplot not found. Install it:` and three platform commands; before the `failed` word
  // existed that fell through the old catch-all and read as a refusal by luck. It is one
  // on purpose — the example names what it needs — so the shape is spelled out here
  // rather than left to a fallback.
  'not found. install it',
];

/// The diagnostic a *host* prints when it has no display or no device. Deliberately
/// about the host and not about the example: the same wording comes from SDL and
/// Vulkan, and a list keyed on an example's name would be a hardcoded answer rather
/// than a measurement.
export const DISPLAY_SIGNS = [
  'no available video device',
  'could not initialize',
  'failed to create window',
  'vulkan',
  'x11',
  'wayland',
  'DISPLAY',
  'no display',
  'dri3',
  'egl',
  'surface 0x0',
];

/// A **guest-side** failure in a run that still exited 0 (DL63).
///
/// These are the shapes the tree's own guests and host use:
///
/// - `did not load (errno -5)` — the OGRE examples' own `fail(...)`, the case this
///   class was added for;
/// - `game aborted:` — the host's line when a guest's `_start_game` refused, which
///   is followed by exit 0 in the four measured cases (a defect of its own, named in
///   the report);
/// - `aborted:` and a bare `FAIL ` — the guest's own assertion helpers.
///
/// Kept narrow on purpose: a word like "error" appears in ordinary log lines at
/// `--log-level=debug`, so a broad match would classify healthy runs as failures.
export const GUEST_FAILURE_SIGNS = [
  'did not load (errno',
  'game aborted:',
  'FAIL ',
  'assertion failed',
];

/// The last log-or-error line, for the table's `detail` column.
export function lastDiagnostic(text) {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (/^(Error|error:|ERROR|thread .* panicked|npm error)/.test(line)) return line;
  }
  return lines.length ? lines[lines.length - 1] : '';
}

/// The guest-failure line this run printed, or `null`.
///
/// The **first** match is returned, not the last: the first thing that went wrong
/// names the cause, and a later line is usually a consequence.
export function guestFailure(text) {
  const lower = text.toLowerCase();
  for (const sign of GUEST_FAILURE_SIGNS) {
    const at = lower.indexOf(sign.toLowerCase());
    if (at < 0) continue;
    const lines = text.split('\n');
    let seen = 0;
    for (const line of lines) {
      const trimmed = line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
      const nextSeen = seen + trimmed.length + 1;
      if (nextSeen > at) return trimmed;
      seen = nextSeen;
    }
    return sign;
  }
  return null;
}

/// One run's verdict.
export function classify(status, timedOut, combined) {
  if (timedOut) return 'hung';
  if (status === 0) {
    return guestFailure(combined) === null ? 'ran' : 'ran-but-failed';
  }
  const lower = combined.toLowerCase();
  // Refusal first: a refusal that happens to name a display is still the tree saying
  // no on purpose, and the words are ordered by which fact is more specific.
  if (REFUSAL_SIGNS.some((sign) => lower.includes(sign.toLowerCase()))) return 'refused-by-name';
  if (DISPLAY_SIGNS.some((sign) => lower.includes(sign.toLowerCase()))) return 'needs-display';
  // **Not a refusal just because it is not a display** (DL63). The fallback used to be
  // `refused-by-name`, so `async-io`'s `game aborted: Unexpected 'null'` on fiber read as
  // the tree refusing something on purpose. It is a crash: non-zero, no refusal named, no
  // display named. Calling that a refusal is the same species of untrue green line as
  // calling an empty run `ran`.
  return 'failed';
}

/// **Which backend an artifact was built for**, read from the artifact itself.
///
/// `tension.requires` is a custom section whose text is
/// `backend=<name>\ntarget=<class>\nfeatures=<list>`, and `tension.stackful-backend`
/// carries the same word. Reading the bytes rather than trusting the build request is
/// the point: the table must say what the artifact *is*, not what the census asked for.
/// A guest with neither section was built for continuations (absence means
/// continuation), which is the host's own rule.
export function declaredBackend(bytes) {
  if (!bytes) return 'continuation';
  const text = Buffer.isBuffer(bytes) ? bytes.toString('latin1') : String(bytes);
  let found = null;
  for (const name of ['fiber', 'promise', 'continuation']) {
    // Longest-first would be safer if one name were a prefix of another; none is.
    if (text.includes(`backend=${name}`)) found = name;
  }
  return found ?? 'continuation';
}
