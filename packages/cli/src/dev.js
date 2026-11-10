// `tension dev`: build, run, watch, restart.
//
// **The restart is kill-and-respawn, not hot reload.** The host process owns a
// window, an SDL event loop and a wasm instance; reloading a guest inside it
// would mean tearing all three down and rebuilding them, which is what
// respawning the process already does. The CLI is the layer that owns process
// lifetime, so it is the layer that owns the restart — the runtime keeps taking
// one .wasm and running it to completion, which is the property everything else
// about it is built on.
//
// The consequence is stated in the template's README rather than hidden: **a
// restart loses state**. There is no snapshot primitive yet; when there is, that
// is when "hot reload" starts to mean something.

import { spawn, spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import { basename, join } from 'node:path';
import { buildOnce } from './build.js';
import { hostArgs, hostEnv } from './project.js';
import { step, warn } from './util.js';

/** How long after the last change a rebuild waits. Editors write in bursts. */
const DEBOUNCE_MS = 150;

/** How long a freshly finished build suppresses events from its own writes. */
const SETTLE_MS = 400;

/** How long a host gets to exit on SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2000;

/** The exact invocation, for `--build-only` and for the log. */
export function commandLine(ctx, options) {
  const { before, after } = hostArgs(ctx.config, ctx.paths, ctx.rt, options);
  // Quoted through the same helper the restart loop uses: this line is printed
  // for a human to paste back into a shell, and an unquoted `--title=My Game`
  // is two argv elements on every platform, not one.
  return [ctx.rt.host, ...before, ctx.paths.wasm, ...after].map(quote).join(' ');
}

/**
 * Paths a rebuild must not react to.
 *
 * `src/graph.generated.ts` is the important one: the build writes into `src/`,
 * and a watcher that reacted to its own output would rebuild forever. The rest
 * are the directories a build or an editor churns.
 */
function ignored(path) {
  if (!path) return true;
  const normal = path.split('\\').join('/');
  if (normal.endsWith('.generated.ts')) return true;
  if (normal.includes('/node_modules/') || normal.includes('/.git/')) return true;
  if (normal.includes('/build/') || normal.includes('/dist/')) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stop a host process and do not return until it is gone. */
async function stopHost(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') {
    // SIGTERM is not a thing a Windows process receives; `taskkill /T` takes the
    // children too, which matters because a game may have spawned none today
    // and will once audio and physics use helper threads.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    // `taskkill` returns once the signal is delivered, which is not the same as
    // the process being gone — and the caller's next act is to spawn the next
    // host. Waiting for the exit is what keeps two windows from overlapping,
    // and it is the same bound the POSIX path uses below.
    await Promise.race([
      new Promise((resolve) => {
        // Checked *inside* the promise: an exit between `taskkill` and this
        // line has already fired the event, and a listener added afterwards
        // would never hear it — costing the full grace period on every save.
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', resolve);
      }),
      sleep(KILL_GRACE_MS),
    ]);
    return;
  }

  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timeout = sleep(KILL_GRACE_MS).then(() => 'timeout');
  if ((await Promise.race([exited, timeout])) === 'timeout') {
    child.kill('SIGKILL');
    await exited;
  }
}

/**
 * The dev loop.
 *
 * Returns a promise that resolves when the loop ends (Ctrl-C, `--no-watch` and
 * the game exiting, or a failed first build under `--build-only`).
 */
export async function dev(ctx, options = {}) {
  const opts = {
    headless: Boolean(options.headless),
    watch: options.watch !== false,
    buildOnly: Boolean(options.buildOnly),
    debug: Boolean(options.debug),
    extra: options.extra ?? [],
  };

  const state = {
    child: null,
    building: false,
    pending: null,
    settleUntil: 0,
    stopping: false,
    // Set while a restart is killing the old host on purpose. The host exits
    // *cleanly* on SIGTERM (it closes the window and returns 0), so a signal
    // check alone would report every save as "the game closed".
    restarting: false,
  };

  /** Start a host and return it. */
  function startHost() {
    const { before, after } = hostArgs(ctx.config, ctx.paths, ctx.rt, opts);
    const args = [...before, ctx.paths.wasm, ...after];
    step(`tension: ${basename(ctx.rt.host)} ${args.map(quote).join(' ')}`);

    const child = spawn(ctx.rt.host, args, {
      cwd: ctx.projectDir,
      env: hostEnv(ctx.rt),
      // The game owns the terminal: its `print` and the host's log lines are the
      // output the author is looking at, and neither is the CLI's to filter.
      stdio: 'inherit',
    });
    state.child = child;

    child.on('error', (error) => {
      step(`tension: cannot start the host: ${error.message}`);
      state.child = null;
    });
    child.on('exit', (code, signal) => {
      const wasCurrent = state.child === child;
      if (wasCurrent) state.child = null;
      // A restart kills the child on purpose; reporting that as "the game
      // exited" would make every save look like a crash.
      if (!wasCurrent || state.stopping || state.restarting) return;
      if (signal === 'SIGTERM' || signal === 'SIGKILL') return;
      if (opts.watch) {
        step(code === 0
          ? 'tension: the game closed. Watching for changes; Ctrl-C to stop.'
          : `tension: the game exited with ${code}. Watching for changes; Ctrl-C to stop.`);
      }
    });
    return child;
  }

  /** Build, then restart if the build succeeded. */
  async function rebuild(reason) {
    if (state.building) {
      state.pending = state.pending ?? reason;
      return;
    }
    state.building = true;
    state.pending = null;
    try {
      step(`tension: ${reason}`);
      const result = buildOnce(ctx, { debug: opts.debug });
      if (!result.ok) {
        // The last good build stays on screen. Killing the window because a
        // save had a type error would make the dev loop punish the common case.
        step('tension: build failed — the running game is unchanged; fix the error and save');
        return;
      }
      state.restarting = true;
      await stopHost(state.child);
      state.child = null;
      state.restarting = false;
      if (!opts.buildOnly) startHost();
    } finally {
      state.building = false;
      state.settleUntil = Date.now() + SETTLE_MS;
    }
    if (state.pending) {
      const pending = state.pending;
      state.pending = null;
      await rebuild(pending);
    }
  }

  // ── the first build ───────────────────────────────────────────────────────
  step(`tension: ${ctx.pkg.name} — ${ctx.config.renderer}, ` +
    `${ctx.config.window.width}x${ctx.config.window.height}` +
    `${opts.headless ? ', headless' : ''}`);
  const first = buildOnce(ctx, { debug: opts.debug });
  if (!first.ok) {
    // `--build-only` asked one question and got its answer; a watcher would be
    // the CLI ignoring the flag. `--no-watch` is the same: nothing to supervise.
    if (opts.buildOnly || !opts.watch) return 1;
    // A project that has never built is the normal state after `git clone` and
    // a half-written file. Watch, and start the game when it compiles.
    step('tension: the first build failed; watching for changes');
  } else if (opts.buildOnly) {
    step(`tension: ${commandLine(ctx, opts)}`);
    return 0;
  } else {
    startHost();
  }
  state.settleUntil = Date.now() + SETTLE_MS;

  if (!opts.watch) {
    // Without a watcher there is nothing to supervise: wait for the game to
    // close and hand its exit code back, so `tension dev --no-watch` is usable
    // in a script.
    if (!state.child) return 1;
    return await new Promise((resolve) => {
      const child = state.child;
      child.on('exit', (code, signal) => resolve(signal ? 0 : (code ?? 0)));
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
          state.stopping = true;
          stopHost(child).then(() => resolve(0));
        });
      }
    });
  }

  // ── the watcher ───────────────────────────────────────────────────────────
  const targets = [ctx.paths.srcDir];
  if (ctx.paths.assetsDir) targets.push(ctx.paths.assetsDir);
  // The config sits in the project root, which cannot be watched recursively
  // without also watching node_modules and the build output; watch it by name.
  const configTargets = [ctx.configPath].filter(Boolean);

  const watchers = [];
  let timer = null;
  let lastReason = '';

  const schedule = (path, event) => {
    if (Date.now() < state.settleUntil) return;
    if (path && ignored(path)) return;
    lastReason = path
      ? `${basename(path) || path} ${event === 'rename' ? 'appeared or moved' : 'changed'}`
      : 'a source changed';
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      rebuild(lastReason);
    }, DEBOUNCE_MS);
  };

  for (const target of targets) {
    try {
      watchers.push(watch(target, { recursive: true }, (event, file) => {
        schedule(file ? join(target, file) : target, event);
      }));
    } catch (error) {
      warn(`cannot watch ${target}: ${error.message}`);
    }
  }
  for (const target of configTargets) {
    try {
      watchers.push(watch(target, (event) => schedule(target, event)));
    } catch (error) {
      warn(`cannot watch ${target}: ${error.message}`);
    }
  }

  if (!watchers.length) {
    warn('nothing could be watched; the game will not restart on save');
  } else {
    const watched = targets.map((t) => basename(t)).concat(['tension.config.json']);
    step(`tension: watching ${watched.join(', ')} — Ctrl-C to stop`);
  }

  // ── shutdown ──────────────────────────────────────────────────────────────
  return await new Promise((resolve) => {
    const shutdown = async (code = 0) => {
      state.stopping = true;
      clearTimeout(timer);
      for (const watcher of watchers) {
        try { watcher.close(); } catch { /* already closed */ }
      }
      await stopHost(state.child);
      resolve(code);
    };
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => { shutdown(0); });
    }
    // Nothing else resolves the promise: the loop runs until a signal. A game
    // that closes on its own leaves the watcher running, which is the point.
  });
}

/** Quote an argv element for the printed command line, when it needs it. */
function quote(value) {
  if (/^[\w\-./=:+@]+$/.test(value)) return value;
  // The line is printed for a human to paste back into a shell, so it has to be
  // spelled in *this* platform's shell. Single quotes are a POSIX escape that
  // cmd.exe passes through literally; a Windows path also carries backslashes,
  // which is why the shared test above does not include them.
  if (process.platform === 'win32') return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
