// `tension.config.json`: one reader, one set of defaults, one set of refusals.
//
// The schema in `../schema/tension.config.json` is the contract an editor reads.
// This file is the enforcement, written by hand and deliberately not generated
// from it, because the CLI has to work before `npm install` has produced
// anything and a schema validator would be its first dependency.
//
// The two must agree about every key, default and range. A key that appears in
// one and not the other is the failure this pair invites, so the property list
// here is the schema's `properties` in the same order, and `test/config.test.mjs`
// checks the agreement mechanically rather than by eye.

import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readJson } from './util.js';

/** File the CLI reads, in the project root. */
export const CONFIG_FILE = 'tension.config.json';

/** The renderers this version can drive. Order is the order help prints. */
export const RENDERERS = ['2d', 'ogre'];

/** Capability adapters this version knows about. Empty in practice today. */
export const CAPABILITIES = ['input'];

/**
 * Every default, in one object.
 *
 * `window.title` is absent on purpose: its default is the project's own name,
 * which is only known once package.json has been read.
 */
export const DEFAULTS = {
  entry: 'src/main.ts',
  renderer: '2d',
  window: { width: 1280, height: 720 },
  memory: { initialPages: 200 },
  capabilities: [],
};

/** The largest window any backend accepts (`tension-ogre`'s config validation). */
export const MAX_WINDOW_DIMENSION = 16384;

/** The wasm32 page ceiling. */
export const MAX_PAGES = 65536;

/**
 * A config file that is present but not usable. Carries every problem found.
 *
 * The message names all of them, not a count: a caller that catches this and
 * prints `error.message` — a test, an editor plugin, a future JSON-RPC front
 * end — should not have to know to walk `problems` to learn what is wrong.
 */
export class ConfigError extends Error {
  constructor(path, problems) {
    super(`${path}: ${problems.map((p) => `${p.where}: ${p.message}`).join('; ')}`);
    this.path = path;
    this.problems = problems;
  }
}

/** `a` → `b` edit distance, bounded: stops as soon as it exceeds `limit`. */
function distance(a, b, limit = 3) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current.push(value);
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

/** The nearest known key, when one is near enough to be worth naming. */
function nearest(key, known) {
  let best = null;
  let bestDistance = 3;
  for (const candidate of known) {
    const d = distance(key.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best;
}

/** A relative path that stays inside the project. */
function insideProblems(value, where) {
  const problems = [];
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    problems.push({
      where,
      message: `must be relative to the project root, but '${value}' is absolute`,
    });
    return problems;
  }
  // A path that climbs out of the project is not a project file; letting it
  // through would make the template's own tree part of someone else's build.
  // Split on both separators: a Windows-style `..\\` must not slip through a
  // check that only knows about `/`.
  if (value.split(/[\\/]+/).includes('..')) {
    problems.push({ where, message: `must stay inside the project, but '${value}' climbs out` });
  }
  return problems;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Turn a parsed config into the shape the rest of the CLI consumes.
 *
 * Throws `ConfigError` carrying every problem rather than the first, because a
 * config is small and fixing it one refusal at a time is a bad first hour with
 * a new tool.
 */
export function validateConfig(raw, { projectName = 'Tension' } = {}) {
  const problems = [];
  const add = (where, message) => problems.push({ where, message });

  if (!isObject(raw)) {
    throw new ConfigError(CONFIG_FILE, [
      { where: '(root)', message: `must be a JSON object, got ${Array.isArray(raw) ? 'an array' : typeof raw}` },
    ]);
  }

  const known = ['$schema', 'entry', 'renderer', 'window', 'memory', 'assets', 'capabilities'];
  for (const key of Object.keys(raw)) {
    if (known.includes(key)) continue;
    const hint = nearest(key, known);
    add(key, `Unknown key${hint ? ` (did you mean '${hint}'?)` : ''}`);
  }

  const config = {
    entry: DEFAULTS.entry,
    renderer: DEFAULTS.renderer,
    window: { ...DEFAULTS.window, title: projectName },
    memory: { ...DEFAULTS.memory },
    assets: null,
    capabilities: [],
  };

  // ── entry ─────────────────────────────────────────────────────────────────
  if (raw.entry !== undefined) {
    if (typeof raw.entry !== 'string' || raw.entry.length === 0) {
      add('entry', `must be a non-empty string, got ${JSON.stringify(raw.entry)}`);
    } else {
      const pathProblems = insideProblems(raw.entry, 'entry');
      if (pathProblems.length) problems.push(...pathProblems);
      else config.entry = raw.entry;
    }
  }

  // ── renderer ──────────────────────────────────────────────────────────────
  if (raw.renderer !== undefined) {
    if (typeof raw.renderer !== 'string') {
      add('renderer', `must be a string, got ${JSON.stringify(raw.renderer)}`);
    } else if (!RENDERERS.includes(raw.renderer)) {
      // No "did you mean" here: the enum is two words and the list is in the
      // message. A hint that suggests '2d' for '3d' is noise, not help.
      add('renderer', `Unknown renderer: '${raw.renderer}'` +
        ` (expected one of: ${RENDERERS.join(', ')})`);
    } else {
      config.renderer = raw.renderer;
    }
  }

  // ── window ────────────────────────────────────────────────────────────────
  if (raw.window !== undefined) {
    if (!isObject(raw.window)) {
      add('window', `must be an object, got ${JSON.stringify(raw.window)}`);
    } else {
      const windowKnown = ['width', 'height', 'title'];
      for (const key of Object.keys(raw.window)) {
        if (windowKnown.includes(key)) continue;
        const hint = nearest(key, windowKnown);
        add(`window.${key}`, `Unknown key${hint ? ` (did you mean '${hint}'?)` : ''}`);
      }
      for (const [field, limit] of [['width', MAX_WINDOW_DIMENSION], ['height', MAX_WINDOW_DIMENSION]]) {
        if (raw.window[field] === undefined) continue;
        const value = raw.window[field];
        if (!Number.isInteger(value)) {
          add(`window.${field}`, `must be an integer, got ${JSON.stringify(value)}`);
        } else if (value < 1 || value > limit) {
          add(`window.${field}`, `must be between 1 and ${limit}, got ${value}`);
        } else {
          config.window[field] = value;
        }
      }
      if (raw.window.title !== undefined) {
        if (typeof raw.window.title !== 'string' || raw.window.title.length === 0) {
          add('window.title', `must be a non-empty string, got ${JSON.stringify(raw.window.title)}`);
        } else {
          config.window.title = raw.window.title;
        }
      }
    }
  }

  // ── memory ────────────────────────────────────────────────────────────────
  if (raw.memory !== undefined) {
    if (!isObject(raw.memory)) {
      add('memory', `must be an object, got ${JSON.stringify(raw.memory)}`);
    } else {
      for (const key of Object.keys(raw.memory)) {
        if (key === 'initialPages') continue;
        const hint = nearest(key, ['initialPages']);
        add(`memory.${key}`, `Unknown key${hint ? ` (did you mean '${hint}'?)` : ''}`);
      }
      if (raw.memory.initialPages !== undefined) {
        const value = raw.memory.initialPages;
        if (!Number.isInteger(value)) {
          add('memory.initialPages', `must be an integer, got ${JSON.stringify(value)}`);
        } else if (value < 1 || value > MAX_PAGES) {
          add('memory.initialPages', `must be between 1 and ${MAX_PAGES}, got ${value}`);
        } else {
          config.memory.initialPages = value;
        }
      }
    }
  }

  // ── assets ────────────────────────────────────────────────────────────────
  if (raw.assets !== undefined) {
    if (!isObject(raw.assets)) {
      add('assets', `must be an object, got ${JSON.stringify(raw.assets)}`);
    } else {
      for (const key of Object.keys(raw.assets)) {
        if (key === 'dir' || key === 'volume') continue;
        const hint = nearest(key, ['dir', 'volume']);
        add(`assets.${key}`, `Unknown key${hint ? ` (did you mean '${hint}'?)` : ''}`);
      }
      const assets = { dir: 'assets', volume: 'build/assets.tns' };
      for (const field of ['dir', 'volume']) {
        if (raw.assets[field] === undefined) continue;
        const value = raw.assets[field];
        if (typeof value !== 'string' || value.length === 0) {
          add(`assets.${field}`, `must be a non-empty string, got ${JSON.stringify(value)}`);
          continue;
        }
        const pathProblems = insideProblems(value, `assets.${field}`);
        if (pathProblems.length) problems.push(...pathProblems);
        else assets[field] = value;
      }
      config.assets = assets;
    }
  }

  // ── capabilities ──────────────────────────────────────────────────────────
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities)) {
      add('capabilities', `must be an array, got ${JSON.stringify(raw.capabilities)}`);
    } else {
      const seen = new Set();
      for (const entry of raw.capabilities) {
        if (typeof entry !== 'string') {
          add('capabilities', `every entry must be a string, got ${JSON.stringify(entry)}`);
          continue;
        }
        if (!CAPABILITIES.includes(entry)) {
          add('capabilities', `Unknown capability: '${entry}'` +
            ` (expected one of: ${CAPABILITIES.join(', ')})`);
          continue;
        }
        if (seen.has(entry)) {
          add('capabilities', `'${entry}' is listed twice`);
          continue;
        }
        seen.add(entry);
        config.capabilities.push(entry);
      }
    }
  }

  if (problems.length) throw new ConfigError(CONFIG_FILE, problems);
  return config;
}

/**
 * Read and validate a project's config.
 *
 * A missing file is not an error: every key has a default, so a project with no
 * config is a 2D project at 1280x720. `configPath` is still returned so callers
 * can say *which* file would have been read.
 */
export function loadConfig(projectDir, { projectName } = {}) {
  const path = join(projectDir, CONFIG_FILE);
  const raw = readJson(path, 'JSON');
  if (raw === null) {
    const config = validateConfig({}, { projectName });
    return { config, path: null, raw: null, present: false };
  }
  const config = validateConfig(raw, { projectName });
  return { config, path, raw, present: true };
}

/**
 * Absolute paths derived from a config, in one place.
 *
 * Everything the CLI touches is computed here so no command re-derives
 * `build/game.wasm` and gets it wrong.
 */
export function projectPaths(projectDir, config) {
  return {
    projectDir,
    entry: resolve(projectDir, config.entry),
    srcDir: resolve(projectDir, config.entry, '..'),
    buildDir: join(projectDir, 'build'),
    wasm: join(projectDir, 'build', 'game.wasm'),
    asconfig: join(projectDir, 'build', 'asconfig.json'),
    // The emitted 2D graph blob lands here, then becomes src/graph.generated.ts.
    graphDir: join(projectDir, 'build', '.tension'),
    generated: resolve(projectDir, config.entry, '..', 'graph.generated.ts'),
    assetsDir: config.assets ? resolve(projectDir, config.assets.dir) : null,
    volume: config.assets ? resolve(projectDir, config.assets.volume) : null,
    distDir: join(projectDir, 'dist'),
  };
}

/** A path as it reads in output: relative to the project when it is inside it. */
export function display(projectDir, path) {
  if (!path) return '';
  const rel = relative(projectDir, path);
  return rel.startsWith('..') || isAbsolute(rel) ? path : rel.split(sep).join('/');
}
