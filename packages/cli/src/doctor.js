// `tension doctor`: one screen that says whether this machine can run this
// project, and what to install when it cannot.
//
// It exists because every failure this CLI can produce is an *environment*
// failure — a binary that is not there, a library the loader cannot find, a
// compiler of the wrong version — and the runtime's own messages for those are
// either a bare `exec` error or a `dlopen` line three frames deep. The doctor
// is the place that turns one into the other.
//
// It never loads a renderer and never opens a window: it reads paths, versions
// and loader tables, so it is safe to run on a headless box and safe to paste
// into a bug report.

import { basename, join } from 'node:path';
import { compiler, framework, repoRoot, runtime } from './project.js';
import { capture, exists, step, SUFFIX } from './util.js';

/** `ok`, `warn`, `fail`, printed as a mark and a colour-free word. */
const MARK = { ok: '  ok  ', warn: ' warn ', fail: ' FAIL ' };

function line(mark, label, value) {
  step(`${MARK[mark]} ${label.padEnd(22)} ${value}`);
}

function section(title) {
  step(`\n${title}`);
  step('-'.repeat(Math.max(title.length, 40)));
}

/**
 * Run the checks and print the report. Returns a process exit code: 1 when a
 * check failed, 0 otherwise (`warn` is not a failure — a machine with no display
 * is a perfectly good null-renderer machine).
 */
export async function doctor(ctx, { headless = false } = {}) {
  let failures = 0;
  let warnings = 0;
  const fail = (label, value) => { failures++; line('fail', label, value); };
  const warn = (label, value) => { warnings++; line('warn', label, value); };

  // ── this machine ─────────────────────────────────────────────────────────
  section('machine');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeMinor = Number(process.versions.node.split('.')[1] ?? 0);
  if (nodeMajor > 20 || (nodeMajor === 20 && nodeMinor >= 13)) {
    line('ok', 'node', `${process.versions.node}`);
  } else {
    fail('node', `${process.versions.node} — this CLI needs >= 20.13 ` +
      '(recursive fs.watch: the dev loop restarts on save)');
  }
  line('ok', 'platform', SUFFIX);
  const repo = repoRoot();
  line(repo ? 'ok' : 'ok', 'source tree', repo ?? 'installed package (no repository)');
  if (process.platform !== 'win32' && !headless) {
    const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
    if (display) line('ok', 'display', display);
    else warn('display', 'no DISPLAY/WAYLAND_DISPLAY — a window will not open; ' +
      '`tension dev --headless` runs offscreen');
  }

  // ── the project ──────────────────────────────────────────────────────────
  section('project');
  line('ok', 'directory', ctx.projectDir);
  line('ok', 'package', `${ctx.pkg.name} ${ctx.pkg.version ?? ''}`.trim());
  if (ctx.configPath) {
    line('ok', 'config', ctx.configPath);
  } else {
    line('warn', 'config', 'no tension.config.json — every key is at its default');
  }
  line('ok', 'entry', ctx.config.entry);
  line('ok', 'renderer', ctx.config.renderer +
    (ctx.config.capabilities.length ? ` + ${ctx.config.capabilities.join(', ')}` : ''));
  line('ok', 'window', `${ctx.config.window.width}x${ctx.config.window.height} ` +
    `"${ctx.config.window.title}"`);
  line('ok', 'memory', `${ctx.config.memory.initialPages} pages ` +
    `(${ctx.config.memory.initialPages * 64} KiB)`);

  if (ctx.paths.assetsDir) {
    if (exists(ctx.paths.assetsDir)) {
      line('ok', 'assets', ctx.paths.assetsDir);
    } else {
      fail('assets', `${ctx.paths.assetsDir} — declared in the config but missing`);
    }
  } else {
    line('ok', 'assets', 'none (no volume is built)');
  }

  // ── the guest SDK ────────────────────────────────────────────────────────
  section('guest sdk');
  let fw = null;
  try {
    fw = framework(ctx.projectDir);
    line('ok', 'tension-framework', `${fw.dir} (${fw.package.version ?? 'unversioned'})`);
    line('ok', 'session.json', `arena ${fw.session.arena_size}, ceiling ` +
      `${fw.session.max_arena_size}, pages ${fw.session.initial_pages}..${fw.session.maximum_pages}`);
  } catch (error) {
    fail('tension-framework', error.message.split('\n')[0]);
  }

  try {
    const asc = compiler(ctx.projectDir);
    line('ok', 'tensionscript', `${asc.version} (${basename(asc.command)}${asc.prefix.length ? ` ${asc.prefix.join(' ')}` : ''})`);
  } catch (error) {
    fail('tensionscript', error.message.split('\n')[0]);
  }

  // ── the runtime ──────────────────────────────────────────────────────────
  section('runtime');
  let rt = null;
  try {
    rt = await runtime(ctx.projectDir, ctx.config, { quiet: true });
    line('ok', 'tension-core', rt.host);
    const version = capture(rt.host, ['--version']);
    if (version.status === 0) line('ok', 'host version', version.stdout.trim());
    else fail('host version', `\`--version\` exited ${version.status}`);

    const loader = loaderReport(rt.host);
    if (loader.missing.length) {
      for (const entry of loader.missing) fail('missing library', entry);
    } else if (loader.checked) {
      line('ok', 'host libraries', 'all resolved');
    }

    // The layout hash is the one number both sides must agree on, and a
    // disagreement is refused at session_open with a TLV complaint. Say it here,
    // where it can be read, instead.
    if (fw) {
      const hash = capture(rt.host, ['layout-hash']);
      if (hash.status === 0) {
        const value = Number(hash.stdout.trim());
        if (value === fw.session.layout_hash) {
          line('ok', 'layout hash', `${value} (host and framework agree)`);
        } else {
          fail('layout hash', `host says ${value}, framework's session.json says ` +
            `${fw.session.layout_hash} — the framework and the host are from different builds`);
        }
      }
    }
  } catch (error) {
    fail('tension-core', error.message.split('\n')[0]);
  }

  if (rt && ctx.config.renderer === 'ogre') {
    section('ogre');
    line('ok', 'adapter', rt.ogre.adapter);
    const adapterLoader = loaderReport(rt.ogre.adapter);
    for (const entry of adapterLoader.missing) fail('missing library', entry);
    if (adapterLoader.checked && !adapterLoader.missing.length) {
      line('ok', 'adapter libraries', 'all resolved');
    }
    for (const [label, dir] of [
      ['ogre-next libs', rt.ogre.ogreNext.libDir],
      ['ogre plugins', rt.ogre.ogreNext.pluginDir],
      ['hlms media', rt.ogre.ogreNext.mediaDir],
    ]) {
      if (exists(dir)) line('ok', label, dir);
      else fail(label, `${dir} — missing`);
    }
    // These are set by `tension dev` and `run.sh`; a hand-run host needs them,
    // so print the values rather than only the directories.
    line('ok', 'TENSION_OGRE_PLUGIN_DIR', rt.env.TENSION_OGRE_PLUGIN_DIR ?? '(unset)');
    line('ok', 'TENSION_OGRE_MEDIA_DIR', rt.env.TENSION_OGRE_MEDIA_DIR ?? '(unset)');
  }

  if (rt && ctx.config.capabilities.length) {
    section('capabilities');
    ctx.config.capabilities.forEach((name, i) => line('ok', name, rt.adapters[i] ?? 'unresolved'));
  }

  // ── the verdict ──────────────────────────────────────────────────────────
  step('');
  if (failures) {
    step(`tension: ${failures} check${failures === 1 ? '' : 's'} failed` +
      `${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}`);
    return 1;
  }
  step(`tension: all checks passed${warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}`);
  return 0;
}

/**
 * `ldd`'s "not found" entries for a binary or shared object.
 *
 * A missing library is the failure this whole command is for: the packaged host
 * links the system's SDL3, and the Ogre libraries carry a RUNPATH into the tree
 * they were built in. Both are invisible until a load, and both surface as a
 * one-line loader error that names a file rather than a package.
 */
function loaderReport(binary) {
  if (process.platform !== 'linux') return { checked: false, missing: [] };
  const result = capture('ldd', [binary]);
  if (result.status !== 0) return { checked: false, missing: [] };
  const missing = [];
  for (const raw of result.stdout.split('\n')) {
    const match = /^\s*(\S+)\s+=>\s+not found/.exec(raw);
    if (match) missing.push(match[1]);
  }
  return { checked: true, missing };
}

