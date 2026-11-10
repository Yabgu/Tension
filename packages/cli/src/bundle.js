// `tension build`: everything the project needs, in one directory that runs.
//
// `dist/` is not a copy of `build/`. It carries the host binary, the adapter and
// the Ogre libraries beside it, the volume, and a launcher that sets the
// environment and execs the host — because **the runtime takes a .wasm and no
// app configuration**. Something has to turn the project's config into an argv
// and an environment, and the honest place for that in v1 is a script the CLI
// writes and the user can read.
//
// That script is also why `dist/` is portable only within a platform: the
// binaries come from the project's own installed payloads, so a Linux build
// produces a Linux directory. Cross-building is a release-pass problem and the
// launcher is where its answer will land.

import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { buildOnce } from './build.js';
import { commandLine } from './dev.js';
import { cliVersion } from './project.js';
import { bytes, die, EXE, exists, now, step } from './util.js';

/** The placeholder a generated launcher replaces with its own directory. */
const HERE = '%HERE%';

/**
 * Produce `dist/`.
 *
 * Returns the manifest it wrote, so the command can report sizes from the same
 * data the file records rather than re-walking the tree.
 */
export function bundle(ctx, options = {}) {
  const debug = Boolean(options.debug);
  const distDir = options.outDir ?? ctx.paths.distDir;

  const built = buildOnce(ctx, { debug });
  if (!built.ok) die('the build failed; nothing was written to dist/', [
    'fix the compile error above and run `npm run build` again',
  ]);

  // A wipe, not a merge: a `dist/` that keeps last build's adapter beside this
  // build's host is the "stale binary wins a load" failure with a user interface.
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(join(distDir, 'bin'), { recursive: true });

  const files = [];
  const copy = (from, to) => {
    if (!exists(from)) return null;
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
    files.push({ from, to });
    return to;
  };

  // ── the host ─────────────────────────────────────────────────────────────
  copy(ctx.rt.host, join(distDir, 'bin', basename(ctx.rt.host)));

  // ── the guest and its volume ─────────────────────────────────────────────
  copy(ctx.paths.wasm, join(distDir, 'game.wasm'));
  const hasVolume = Boolean(built.volume);
  if (hasVolume) copy(built.volume.path, join(distDir, basename(built.volume.path)));

  // ── the renderer's libraries, in the layout the loader will ask for ───────
  //
  // The adapter goes to `lib/` and Ogre-Next's shared objects beside it, which
  // is what satisfies the adapter's `$ORIGIN` RPATH entry. The plugins keep
  // their own subdirectory because that is what they expect to be pointed at.
  //
  // `include/` is deliberately not copied: 11 MB of C++ headers that only the
  // adapter's *build* needs, and a shipped game never opens one.
  const libraries = [];
  if (ctx.rt.ogre) {
    copy(ctx.rt.ogre.adapter, join(distDir, 'lib', basename(ctx.rt.ogre.adapter)));

    for (const entry of safeList(ctx.rt.ogre.libDir)) {
      // Shared objects only; the package's `lib/` also holds CMake config.
      if (!/\.(so|so\.[0-9.]+|dylib|dll)$/.test(entry)) continue;
      if (copy(join(ctx.rt.ogre.libDir, entry), join(distDir, 'lib', entry))) {
        libraries.push(`lib/${entry}`);
      }
    }
    for (const entry of safeList(ctx.rt.ogre.ogreNext.libDir)) {
      if (!/\.(so|so\.[0-9.]+|dylib|dll)$/.test(entry)) continue;
      if (copy(join(ctx.rt.ogre.ogreNext.libDir, entry), join(distDir, 'lib', entry))) {
        libraries.push(`lib/${entry}`);
      }
    }
    // Render-system plugins: `lib/OGRE-Next` on Unix, `bin/Release` on Windows.
    const pluginDir = ctx.rt.ogre.ogreNext.pluginDir;
    if (exists(pluginDir)) {
      const target = join(distDir, 'lib', 'OGRE-Next');
      for (const entry of safeList(pluginDir)) {
        if (copy(join(pluginDir, entry), join(target, entry))) {
          libraries.push(`lib/OGRE-Next/${entry}`);
        }
      }
    }
    if (exists(ctx.rt.ogre.ogreNext.mediaDir)) {
      copy(ctx.rt.ogre.ogreNext.mediaDir, join(distDir, 'Media'));
    }
  }

  // ── the invocation, in launcher-relative form ────────────────────────────
  const args = distArgs(ctx, { hasVolume, headless: false });
  const env = distEnv(ctx);

  writeFileSync(join(distDir, 'run.sh'), shellLauncher(env, args));
  chmodSync(join(distDir, 'run.sh'), 0o755);
  writeFileSync(join(distDir, 'run.bat'), batchLauncher(env, args));

  const manifest = {
    manifest: 1,
    name: ctx.pkg.name,
    version: ctx.pkg.version ?? '0.0.0',
    cli: cliVersion(),
    renderer: ctx.config.renderer,
    builtAt: now(),
    host: `bin/${basename(ctx.rt.host)}`,
    guest: 'game.wasm',
    guestBytes: built.wasm,
    assets: hasVolume ? basename(built.volume.path) : null,
    assetsBytes: hasVolume ? built.volume.bytes : 0,
    libraries,
    capabilities: ctx.config.capabilities,
    window: { ...ctx.config.window },
    env,
    // The exact argv the launcher execs, with `%HERE%` standing for `dist/`.
    // Recorded so a bug report has one truth, and so a future `tension doctor`
    // can check a dist/ against the machine it is on.
    argv: args,
    source: {
      entry: ctx.config.entry,
      wasm: commandLine(ctx, { headless: false }),
    },
  };
  writeFileSync(join(distDir, 'tension.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const total = totalBytes(distDir);
  step(`tension: dist/ written (${bytes(total)})`);
  step(`tension:   ${manifest.guest}${hasVolume ? ` + ${manifest.assets}` : ''}, ` +
    `${manifest.host}${libraries.length ? `, ${libraries.length} libraries` : ''}`);
  step(`tension:   run it: ${join(distDir, 'run.sh')}`);
  return manifest;
}

/**
 * The host's argv in dist terms.
 *
 * Built here rather than reusing `hostArgs` because the paths differ: `hostArgs`
 * names absolute project paths, and a launcher that hard-codes the machine it
 * was built on is not distributable. `%HERE%` is substituted by each launcher
 * in its own spelling.
 */
function distArgs(ctx, { hasVolume }) {
  const args = [];
  const guest = `${HERE}/game.wasm`;

  if (hasVolume) args.push('--res', `${HERE}/${basename(ctx.paths.volume)}`);
  if (ctx.rt.ogre) args.push('--capability', `${HERE}/lib/${basename(ctx.rt.ogre.adapter)}`);

  args.push(guest);
  args.push(`--window=${ctx.config.window.width}x${ctx.config.window.height}`);
  args.push(`--title=${ctx.config.window.title}`);

  if (ctx.rt.ogre) {
    if (hasVolume) args.push(`--tns=${HERE}/${basename(ctx.paths.volume)}`);
    args.push('--renderer=gl3plus');
  }
  return args;
}

/** The environment a launcher must set, relative to `dist/`. */
function distEnv(ctx) {
  if (!ctx.rt.ogre) return {};
  return {
    TENSION_OGRE_PLUGIN_DIR: `${HERE}/lib/OGRE-Next`,
    TENSION_OGRE_MEDIA_DIR: `${HERE}/Media`,
    // The loader variable is per platform; the launcher picks it, because the
    // .sh and the .bat are different files for exactly this reason.
    LD_LIBRARY_PATH: `${HERE}/lib`,
    PATH: `${HERE}/lib`,
  };
}

/**
 * A POSIX launcher.
 *
 * `set -eu`, a `here` that survives being invoked through a symlink-free
 * relative path, and `exec` so the game *is* the process the terminal's signals
 * reach — a wrapper that stayed resident would swallow Ctrl-C.
 */
function shellLauncher(env, args) {
  const lines = [
    '#!/bin/sh',
    '# Generated by `tension build` — do not edit; rebuild instead.',
    'set -eu',
    'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    '',
  ];
  if (env.TENSION_OGRE_PLUGIN_DIR) {
    lines.push('export TENSION_OGRE_PLUGIN_DIR="$here/lib/OGRE-Next"');
    lines.push('export TENSION_OGRE_MEDIA_DIR="$here/Media"');
    lines.push('export LD_LIBRARY_PATH="$here/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"');
    lines.push('');
  }
  lines.push(`exec "$here/bin/tension-core" ${args.map(shellArg).join(' ')} "$@"`);
  lines.push('');
  return lines.join('\n');
}

/**
 * A Windows launcher.
 *
 * `%~dp0` ends with a backslash, so paths are built without a leading one. The
 * loader reads `PATH` rather than `LD_LIBRARY_PATH`, and `%*` forwards the
 * game's own arguments — a `.bat` that swallowed them would be a launcher with
 * an opinion about what the game may be told.
 */
function batchLauncher(env, args) {
  const lines = [
    '@echo off',
    'rem Generated by `tension build` -- do not edit; rebuild instead.',
    'setlocal',
    'set "here=%~dp0"',
  ];
  if (env.TENSION_OGRE_PLUGIN_DIR) {
    lines.push('set "TENSION_OGRE_PLUGIN_DIR=%here%lib\\OGRE-Next"');
    lines.push('set "TENSION_OGRE_MEDIA_DIR=%here%Media"');
    lines.push('set "PATH=%here%lib;%PATH%"');
  }
  lines.push(`"%here%bin\\tension-core${EXE}" ${args.map(batchArg).join(' ')} %*`);
  lines.push('exit /b %ERRORLEVEL%');
  lines.push('');
  return lines.join('\r\n');
}

/** Quote one argv element for `/bin/sh`. */
function shellArg(value) {
  if (value.includes(HERE)) {
    // `$here` expands inside double quotes, and nothing else here does.
    return `"${value.replace(HERE, '$here')}"`;
  }
  if (/^[\w\-./=:+@]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote one argv element for `cmd.exe`. */
function batchArg(value) {
  const text = value.replace(`${HERE}/`, '%here%').split('/').join('\\');
  return /^[\w\-=:+@%\\]+$/.test(text) ? text : `"${text}"`;
}

/** `readdirSync` that answers `[]` for a directory that is not there. */
function safeList(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Total bytes under a directory, for the one line that reports the build. */
function totalBytes(dir) {
  let total = 0;
  const walk = (path) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child);
      else {
        try { total += statSync(child).size; } catch { /* vanished mid-walk */ }
      }
    }
  };
  walk(dir);
  return total;
}
