#!/usr/bin/env node
// Project a `scripts/test.mjs --jobs 1` log onto the gate that decides whether a
// commit may land.
//
// ## Why a projection, and not a log diff
//
// Two runs of this suite over *one unchanged tree* differ by thousands of lines:
// wall times, cargo's interleaving, /tmp directory names, cache states, and any
// genuinely nondeterministic example report (`docs/build.md` has the measured
// figure). A byte diff is therefore not a gate — it is a gate that is always
// red, which is the same as no gate. What is stable is a small set of facts, and
// this file is the definition of that set, written down once so it is not
// re-litigated per commit.
//
// ## The four sections
//
//   suites       every `==> starting <title>`, in the order the runner started
//                them. A suite that stops running is a gate failure even if the
//                rest pass.
//   verdicts     every `==> <title>: PASSED|FAILED|SKIPPED`, in order.
//   cargo        one line per `test result:` — what libtest reports after a
//                binary's tests — canonicalised to counts, plus the totals.
//                **This is the figure to cite.** Counting `test name ... ok`
//                lines instead undercounts, because a suite's stdout and stderr
//                are merged asynchronously and the guest's own output sometimes
//                lands mid-line (`... -> 0test name ... ok`). Measured: two runs
//                of the `core` suite on one tree differ by three *names* that
//                way, while the `test result:` lines are identical.
//   warnings     every compiler warning, as (message, location) with a count,
//                sorted. Locations are allowed to shift when lines move — a
//                gate compares the list and explains the shifts; a changed
//                count or a new message is the thing to notice.
//
// ## Residual differences
//
// Anything outside those four sections (prose from a suite, sample values in an
// example's report, cargo's "Blocking waiting" lines) is residual. The report
// enumerates it by hand when a projection diff does not explain a difference;
// this script only refuses to bury it in a big diff.
//
// ## Usage
//
//   node scripts/test.mjs --jobs 1 > /tmp/gate.log 2>&1
//   node scripts/project-gate.mjs /tmp/gate.log            # the projection
//   node scripts/project-gate.mjs --diff a.proj b.proj     # compare two
//
// `--diff` exits 1 when the suites, verdicts or cargo sections differ — the
// hard sections — and 0 when only warnings differ, which are printed either way
// so the shift is in the record rather than in someone's memory. Either
// argument may be a raw gate log instead of a projection.
//
// Reading a file rather than re-running anything is deliberate: the projection
// of a log is a pure function of that log, so a gate report can be recomputed
// from the artefact months later, and two people reading the same log get the
// same projection.

import { readFileSync } from 'node:fs';

// A suite's stdout and stderr are merged as they arrive, so a log line from the
// runtime can land at the front of a cargo line. Stripped before matching only;
// the projection never prints a normalised line as if it were the raw one.
const STAMP = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s?/g;

const HEADER = /^==> starting (.+)$/;
const VERDICT = /^==> (.+?): (PASSED|FAILED)$/;
const SKIPPED = /^==> (.+?): SKIPPED(?: — (.*))?$/;
const BANNER = /^----- (.+?) \([\d.]+s\) -----$/;
const RESULT = /test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/;
// `warning:` or `warning[unused_mut]:`, possibly behind an interleaved log line.
const WARNING = /(?:^|\s)warning(?:\[([^\]]+)\])?:\s?(.*)$/;
const LOCATION = /-->\s+(\S+?:\d+:\d+)/;
// Cargo's own per-unit tally (`... generated 8 warnings (run cargo fix ...)`).
// It repeats the diagnostics counted above it, so counting both would say a
// crate has twice the warnings it has. The number to cite is the diagnostics.
const SUMMARY = /generated \d+ warnings?/;

const normalise = (line) => line.replace(STAMP, '');

/** Parse a gate log into the four sections. Pure: same log, same projection. */
export function project(log) {
  const suites = [];
  const verdicts = [];
  const cargo = [];
  const warnings = new Map(); // `${location}\0${message}` -> { message, location, count }
  let suite = null;
  let pending = null; // a warning whose `-->` has not been read yet

  const flush = () => {
    if (!pending) return;
    const key = `${pending.location ?? ''}\0${pending.message}`;
    const entry = warnings.get(key);
    if (entry) entry.count++;
    else warnings.set(key, { ...pending, count: 1 });
    pending = null;
  };

  for (const raw of log.split(/\r?\n/)) {
    const line = normalise(raw);

    const banner = line.match(BANNER);
    if (banner) { flush(); suite = banner[1]; continue; }

    const header = line.match(HEADER);
    if (header) { flush(); suites.push(header[1]); continue; }

    const skipped = line.match(SKIPPED);
    if (skipped) { flush(); verdicts.push(`${skipped[1]}: SKIPPED`); continue; }

    const verdict = line.match(VERDICT);
    if (verdict) { flush(); verdicts.push(`${verdict[1]}: ${verdict[2]}`); continue; }

    const result = line.match(RESULT);
    if (result) {
      flush();
      cargo.push({
        suite: suite ?? '(no banner)',
        ok: result[1] === 'ok',
        passed: Number(result[2]),
        failed: Number(result[3]),
        ignored: Number(result[4]),
      });
      continue;
    }

    const warning = line.match(WARNING);
    if (warning) {
      flush();
      const text = warning[2] ?? '';
      if (SUMMARY.test(text)) continue;
      const message = text.trim().replace(/\s+/g, ' ');
      const inline = message.match(LOCATION);
      pending = inline
        ? { message: message.slice(0, inline.index).trim(), location: inline[1] }
        : { message, location: null };
      if (inline) flush(); // the location was on the warning line itself
      continue;
    }

    const location = line.match(LOCATION);
    if (location && pending) { pending.location = location[1]; flush(); continue; }
    // A blank line or a non-diagnostic line means the diagnostic block ended.
    if (pending && line.trim() === '') flush();
  }
  flush();

  const rows = [...warnings.values()]
    .map((w) => ({ message: w.message, location: w.location ?? '(none)', count: w.count }))
    .sort((a, b) => {
      if (a.location !== b.location) return a.location < b.location ? -1 : 1;
      if (a.message === b.message) return 0;
      return a.message < b.message ? -1 : 1;
    });

  return { suites, verdicts, cargo, warnings: rows };
}

/** The canonical text. Sorted where nothing else fixes an order. */
export function render(p) {
  const out = [];
  const total = (key) => p.cargo.reduce((n, r) => n + r[key], 0);

  out.push('gate-projection v1');
  out.push(`suites: ${p.suites.length}`);
  p.suites.forEach((title, i) => out.push(`  ${String(i + 1).padStart(2)}. ${title}`));

  out.push(`verdicts: ${p.verdicts.length}`);
  p.verdicts.forEach((v, i) => out.push(`  ${String(i + 1).padStart(2)}. ${v}`));

  out.push(`cargo-result-lines: ${p.cargo.length}`);
  p.cargo.forEach((r, i) => out.push(`  ${String(i + 1).padStart(2)}. ` +
    `${r.ok ? 'ok ' : 'BAD'} passed=${r.passed} failed=${r.failed} ignored=${r.ignored}`));
  out.push(`cargo-total: passed=${total('passed')} failed=${total('failed')} ` +
    `ignored=${total('ignored')}`);

  out.push(`warnings: ${p.warnings.reduce((n, w) => n + w.count, 0)} ` +
    `(${p.warnings.length} distinct)`);
  for (const w of p.warnings) out.push(`  ${w.count}x ${w.location}  ${w.message}`);
  return `${out.join('\n')}\n`;
}

/** Line-by-line comparison of two projections, split into hard and soft. */
export function compare(before, after) {
  const hard = [];
  const soft = [];
  const section = (left, right, name) => {
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if (left[i] === right[i]) continue;
      hard.push(`${name} ${i + 1}: -${left[i] ?? '(absent)'}  +${right[i] ?? '(absent)'}`);
    }
  };
  section(before.suites, after.suites, 'suite');
  section(before.verdicts, after.verdicts, 'verdict');

  const cargoText = (p) => p.cargo.map((r) => `${r.ok ? 'ok ' : 'BAD'} ` +
    `passed=${r.passed} failed=${r.failed} ignored=${r.ignored}`);
  section(cargoText(before), cargoText(after), 'cargo-result');

  const warningText = (p) => p.warnings.map((w) => `${w.count}x ${w.location}  ${w.message}`);
  for (const line of diffLines(warningText(before), warningText(after))) soft.push(line);
  return { hard, soft };
}

/** Set difference on lines, both directions, so a moved location is visible. */
function diffLines(left, right) {
  const l = new Map();
  const r = new Map();
  for (const line of left) l.set(line, (l.get(line) ?? 0) + 1);
  for (const line of right) r.set(line, (r.get(line) ?? 0) + 1);
  const out = [];
  for (const [line, n] of l) {
    const m = r.get(line) ?? 0;
    for (let i = 0; i < n - m; i++) out.push(`-${line}`);
  }
  for (const [line, n] of r) {
    const m = l.get(line) ?? 0;
    for (let i = 0; i < n - m; i++) out.push(`+${line}`);
  }
  return out;
}

/** Re-read a rendered projection, so `--diff` accepts its own output. */
export function asProjection(text) {
  const p = { suites: [], verdicts: [], cargo: [], warnings: [] };
  let section = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('suites:')) { section = 'suites'; continue; }
    if (line.startsWith('verdicts:')) { section = 'verdicts'; continue; }
    if (line.startsWith('cargo-result-lines:')) { section = 'cargo'; continue; }
    if (line.startsWith('cargo-total:')) { section = null; continue; }
    if (line.startsWith('warnings:')) { section = 'warnings'; continue; }
    if (line.startsWith('gate-projection') || line.trim() === '') continue;

    const row = line.match(/^\s+\d+\. (.*)$/);
    if (section === 'suites' && row) { p.suites.push(row[1]); continue; }
    if (section === 'verdicts' && row) { p.verdicts.push(row[1]); continue; }
    if (section === 'cargo' && row) {
      const c = row[1].match(/^(ok |BAD) passed=(\d+) failed=(\d+) ignored=(\d+)$/);
      if (!c) throw new Error(`project-gate: unreadable cargo row: ${row[1]}`);
      p.cargo.push({
        ok: c[1].trim() === 'ok',
        passed: Number(c[2]), failed: Number(c[3]), ignored: Number(c[4]),
      });
      continue;
    }
    if (section === 'warnings') {
      const w = line.match(/^\s+(\d+)x (\S+)  (.*)$/);
      if (w) p.warnings.push({ count: Number(w[1]), location: w[2], message: w[3] });
    }
  }
  return p;
}

// ── the command line ───────────────────────────────────────────────────────

function main(argv) {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write('usage: node scripts/project-gate.mjs <gate.log>\n' +
      '       node scripts/project-gate.mjs --diff <before.proj> <after.proj>\n' +
      '       node scripts/test.mjs --jobs 1 > gate.log 2>&1\n');
    return argv.length === 0 ? 2 : 0;
  }

  const read = (path) => (path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8'));
  const parse = (text) => (text.startsWith('gate-projection v1')
    ? asProjection(text)
    : project(text));

  if (argv[0] === '--diff') {
    const [beforePath, afterPath] = argv.slice(1).filter((a) => !a.startsWith('-'));
    if (!beforePath || !afterPath) {
      process.stderr.write('project-gate: --diff needs two files\n');
      return 2;
    }
    const before = parse(read(beforePath));
    const after = parse(read(afterPath));
    const { hard, soft } = compare(before, after);

    process.stdout.write(`gate-diff: ${beforePath} -> ${afterPath}\n`);
    if (!hard.length && !soft.length) {
      process.stdout.write('  identical in all four sections\n');
      return 0;
    }
    for (const line of hard) process.stdout.write(`  HARD ${line}\n`);
    for (const line of soft) process.stdout.write(`  soft ${line}\n`);
    if (hard.length) {
      process.stdout.write(`  ${hard.length} hard difference(s): a suite, verdict or ` +
        `cargo result changed\n`);
      return 1;
    }
    process.stdout.write(`  ${soft.length} warning difference(s): a location may move when ` +
      `lines do — explain each\n`);
    return 0;
  }

  const path = argv.find((a) => !a.startsWith('-')) ?? '-';
  process.stdout.write(render(project(read(path))));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
