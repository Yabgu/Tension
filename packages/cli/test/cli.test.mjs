// The CLI's own checks: the config contract, and what `init` writes.
//
// The first test is the one worth having. `schema/tension.config.json` is what
// an editor reads and `src/config.js` is what the CLI enforces; nothing generates
// one from the other (the CLI must run before `npm install` has produced a
// validator), so the pair can drift in a way no compiler sees. This compares the
// two mechanically — the same discipline `scripts/check-ogre-capacities.mjs`
// applies to the adapter's tables.
//
// Run with:  node --test packages/cli/test/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CAPABILITIES, DEFAULTS, RENDERERS, validateConfig } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'tension.js');
const schema = JSON.parse(readFileSync(join(here, '..', 'schema', 'tension.config.json'), 'utf8'));

/** A throwaway directory, removed when the test finishes. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tension-cli-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── the schema and the validator ────────────────────────────────────────────

test('schema and validator agree about the top-level keys', () => {
  const inSchema = Object.keys(schema.properties).filter((key) => key !== '$schema').sort();

  // The validator's known keys are the ones it refuses to see besides; derive
  // them from behaviour rather than from a second list, so a key added to the
  // validator but not the schema fails here.
  const accepted = [];
  for (const key of ['entry', 'renderer', 'window', 'memory', 'assets', 'capabilities', 'nonsense']) {
    try {
      validateConfig({ [key]: key === 'renderer' ? '2d' : key === 'capabilities' ? [] : {} });
      accepted.push(key);
    } catch (error) {
      if (!error.problems?.some((p) => p.where === key && /Unknown key/.test(p.message))) {
        // Rejected for a type reason (an object where a string belongs) is
        // still "known": the key was recognised.
        accepted.push(key);
      }
    }
  }
  assert.deepEqual(accepted.filter((k) => k !== 'nonsense').sort(), inSchema);
});

test('renderer enum, defaults and limits match the schema', () => {
  const renderer = schema.properties.renderer;
  assert.deepEqual(renderer.enum, RENDERERS);
  assert.equal(renderer.default, DEFAULTS.renderer);

  assert.equal(schema.properties.entry.default, DEFAULTS.entry);

  const window = schema.properties.window.properties;
  assert.equal(window.width.default, DEFAULTS.window.width);
  assert.equal(window.height.default, DEFAULTS.window.height);

  const memory = schema.properties.memory.properties;
  assert.equal(memory.initialPages.default, DEFAULTS.memory.initialPages);

  // The capability enum is the one the validator will accept; a name in one and
  // not the other is a config that validates in the editor and fails here.
  assert.deepEqual(schema.properties.capabilities.items.enum, CAPABILITIES);
});

test('an empty config is the documented default project', () => {
  const config = validateConfig({}, { projectName: 'My Game' });
  assert.equal(config.entry, 'src/main.ts');
  assert.equal(config.renderer, '2d');
  assert.deepEqual(config.window, { width: 1280, height: 720, title: 'My Game' });
  assert.equal(config.memory.initialPages, 200);
  assert.equal(config.assets, null);
  assert.deepEqual(config.capabilities, []);
});

test('a bad renderer is named, with the ones that exist', () => {
  assert.throws(
    () => validateConfig({ renderer: '3d' }),
    (error) => {
      const message = error.problems.map((p) => `${p.where}: ${p.message}`).join('\n');
      assert.match(message, /renderer: Unknown renderer: '3d'/);
      assert.match(message, /2d, ogre/);
      return true;
    },
  );
});

test('every problem is reported at once, not one per run', () => {
  assert.throws(
    () => validateConfig({ renderer: '3d', window: { width: 0 }, capabilities: ['pad'] }),
    (error) => {
      assert.equal(error.problems.length, 3);
      return true;
    },
  );
});

test('a path that climbs out of the project is refused', () => {
  for (const dir of ['../elsewhere', 'assets/../../x', '..\\x']) {
    assert.throws(() => validateConfig({ assets: { dir } }), /climbs out/);
  }
});

test('an unknown key suggests the nearest known one', () => {
  assert.throws(() => validateConfig({ windown: {} }), /did you mean 'window'/);
});

// ── init ────────────────────────────────────────────────────────────────────

test('init scaffolds a project whose config and manifest name it', (t) => {
  const dir = scratch(t);
  const target = join(dir, 'space odyssey');
  execFileSync(process.execPath, [cli, 'init', target], { encoding: 'utf8' });

  const files = readdirSync(target).sort();
  for (const expected of ['package.json', 'tension.config.json', 'README.md', 'src', 'assets']) {
    assert.ok(files.includes(expected), `missing ${expected} in ${files.join(', ')}`);
  }
  // No template keeps its `.tmpl` suffix.
  assert.equal(files.filter((f) => f.endsWith('.tmpl')).length, 0);

  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'space-odyssey', 'the package name is sluga-ised');

  const config = JSON.parse(readFileSync(join(target, 'tension.config.json'), 'utf8'));
  assert.equal(config.window.title, 'Space Odyssey');
  assert.equal(config.renderer, '2d');
  // The scaffold must pass its own validator.
  validateConfig(config, { projectName: pkg.name });
});

test('init refuses a directory that is not empty, and --force overrides it', (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'keep.txt'), 'x');
  assert.throws(
    () => execFileSync(process.execPath, [cli, 'init', dir], { encoding: 'utf8', stdio: 'pipe' }),
    /not empty/,
  );
  execFileSync(process.execPath, [cli, 'init', dir, '--force'], { encoding: 'utf8' });
  assert.ok(readdirSync(dir).includes('package.json'));
});

test('init --template 3d is the Ogre project', (t) => {
  const dir = scratch(t);
  const target = join(dir, 'spinner');
  execFileSync(process.execPath, [cli, 'init', target, '--template', '3d'], { encoding: 'utf8' });
  const config = JSON.parse(readFileSync(join(target, 'tension.config.json'), 'utf8'));
  assert.equal(config.renderer, 'ogre');
  const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['@yabgu_gm/tension-ogre'], 'the ogre template depends on the adapter');
});

test('init names an unknown template rather than scaffolding the default', (t) => {
  const dir = scratch(t);
  assert.throws(
    () => execFileSync(process.execPath, [cli, 'init', join(dir, 'x'), '--template', 'nope'],
      { encoding: 'utf8', stdio: 'pipe' }),
    /Unknown template: 'nope'/,
  );
});

// ── the command surface ─────────────────────────────────────────────────────

test('an unknown command exits non-zero and prints usage', () => {
  assert.throws(
    () => execFileSync(process.execPath, [cli, 'frobnicate'], { encoding: 'utf8', stdio: 'pipe' }),
    (error) => {
      assert.equal(error.status, 2);
      assert.match(error.stderr, /unknown command/);
      return true;
    },
  );
});

test('an unknown option is refused, not ignored', () => {
  assert.throws(
    () => execFileSync(process.execPath, [cli, 'dev', '--watch-everything'], { encoding: 'utf8', stdio: 'pipe' }),
    /unknown option: '--watch-everything'/,
  );
});

// The two watcher flags are the whole of the dev command's lifetime policy, so
// the surface is checked in both directions: accepted by the parser, and
// described in the help. A flag in one place and not the other is either an
// undocumented option or a lie.
test('--watch and --no-watch are known dev options and are documented', (t) => {
  const dir = scratch(t);
  for (const flag of ['--watch', '--no-watch']) {
    // Accepted: the run gets as far as looking for a project, and fails there.
    assert.throws(
      () => execFileSync(process.execPath, [cli, 'dev', flag, '--dir', dir],
        { encoding: 'utf8', stdio: 'pipe' }),
      /no project here/,
    );
  }
  const help = execFileSync(process.execPath, [cli, 'dev', '--help'], { encoding: 'utf8' });
  assert.match(help, /--watch\s+keep watching after the window closes/);
  assert.match(help, /--no-watch\s+build and run once/);
  // The removed flag must be *refused*, not silently accepted: an option that
  // parses and does nothing is exactly what this parser exists to prevent.
  assert.throws(
    () => execFileSync(process.execPath, [cli, 'dev', '--exit-on-close', '--dir', dir],
      { encoding: 'utf8', stdio: 'pipe' }),
    /unknown option: '--exit-on-close'/,
  );
});

test('a directory with no package.json is not a project', (t) => {
  const dir = scratch(t);
  assert.throws(
    () => execFileSync(process.execPath, [cli, 'dev', '--dir', dir], { encoding: 'utf8', stdio: 'pipe' }),
    /no project here/,
  );
});
