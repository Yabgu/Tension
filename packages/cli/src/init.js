// `tension init`: copy a template into a directory and make it this project's.
//
// Two kinds of substitution, and keeping them apart is what makes a template
// readable:
//
//   * `__NAME__`, `__TITLE__`, `__REPO__` — placeholders in a `.tmpl` file,
//     replaced once at scaffold time. A `.tmpl` file loses the suffix when it
//     is written, so the project gets a real `package.json` and never a file
//     ends in `.tmpl`.
//   * everything else is copied byte for byte. A template that rewrote its own
//     source would be a template whose code nobody has read in its final form.
//
// The `file:` dependency specs are the local-first part: this pass validates the
// CLI inside the repository, so a scaffolded project points at
// `<repo>/packages/core` and not at a registry. When the CLI is installed from a
// registry instead, `repoRoot()` is null and the same placeholders become
// version ranges — one branch, named here, rather than a template that only
// works in one of the two worlds.

import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from './project.js';
import { die, exists, npmCommand, run, step } from './util.js';

/**
 * The templates this CLI ships. `2d` is an alias for the starter: the default
 * project and the 2D project are the same thing in v1.
 */
export const TEMPLATES = {
  starter: { dir: 'starter', renderer: '2d', description: 'bouncing sprites, 2D (default)' },
  ogre: { dir: 'ogre', renderer: 'ogre', description: 'a spinning triangle, 3D' },
};

/** The alias table, so `--template 2d` and `--template starter` agree. */
const ALIASES = { '2d': 'starter', '3d': 'ogre', default: 'starter' };

/** Everything a template copies, minus what a build or an install produced. */
function readable(dir) {
  return exists(dir) && statSync(dir).isDirectory();
}

/**
 * `my game` → `my-game`; anything npm would refuse in a package name is folded
 * to a hyphen. A name npm refuses is an `npm install` that fails in a directory
 * the user just created, which reads as the tool being broken.
 */
export function packageName(raw) {
  const slug = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'my-game';
}

/** `my-game` → `My Game`, for the window title. */
export function titleFor(raw) {
  return String(raw)
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'My Game';
}

/** The `file:` spec for a package, or a version range outside a checkout. */
function spec(repo, path, range) {
  if (!repo) return range;
  // Forward slashes: npm accepts them on every platform, and a Windows `file:`
  // spec with backslashes is a parse error rather than a path.
  return `file:${repo.split('\\').join('/')}/${path}`;
}

/**
 * Scaffold a project.
 *
 * Returns the directory written. `options.dir` defaults to the current
 * directory; `options.force` allows a non-empty one.
 */
export function init(options = {}) {
  const templateId = ALIASES[options.template ?? 'default'] ?? options.template;
  const template = TEMPLATES[templateId];
  if (!template) {
    die(`Unknown template: '${options.template}'`, [
      `known templates: ${Object.keys(TEMPLATES).join(', ')}`,
      `aliases: ${Object.keys(ALIASES).join(', ')}`,
    ]);
  }

  const templateDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates', template.dir);
  if (!readable(templateDir)) {
    die(`the '${templateId}' template is missing from this install`, [
      `looked for: ${templateDir}`,
      'reinstall the CLI:  npm install @yabgu_gm/tension',
    ]);
  }

  const targetDir = resolve(options.dir ?? '.');
  const rawName = basename(targetDir);

  if (exists(targetDir)) {
    const entries = readdirSync(targetDir).filter((entry) => entry !== '.git');
    if (entries.length && !options.force) {
      die(`${targetDir} is not empty`, [
        `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} there already: ` +
        `${entries.slice(0, 6).join(', ')}${entries.length > 6 ? ', …' : ''}`,
        'pick an empty directory, or pass --force to write anyway',
      ]);
    }
  }
  mkdirSync(targetDir, { recursive: true });
  step(`tension: scaffolding '${templateId}' into ${targetDir}`);

  const repo = repoRoot();
  const name = packageName(options.name ?? rawName);
  const title = titleFor(options.name ?? rawName);

  const substitutions = {
    __NAME__: name,
    __TITLE__: title,
    __REPO__: repo ? repo.split('\\').join('/') : '',
    // The dependency specs, in one place, so the template's package.json is a
    // list of packages and not a list of escape sequences.
    __DEP_CORE__: spec(repo, 'packages/core', '^0.1.0'),
    __DEP_OGRE__: spec(repo, 'packages/ogre', '^0.1.0'),
    __DEP_OGRE_NEXT__: spec(repo, 'packages/ogre-next', '^0.1.0'),
    __DEP_FRAMEWORK__: spec(repo, 'tension-framework', '^0.1.0'),
    __DEP_CLI__: spec(repo, 'packages/cli', '^0.1.0'),
  };

  const written = [];
  const copyTree = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const source = join(from, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'build' || entry.name === 'dist') continue;
        copyTree(source, join(to, entry.name));
        continue;
      }
      if (entry.name.endsWith('.tmpl')) {
        const text = readFileSync(source, 'utf8');
        const rendered = text.replace(/__[A-Z_]+__/g, (token) =>
          (token in substitutions ? substitutions[token] : token));
        const out = join(to, entry.name.slice(0, -'.tmpl'.length));
        writeFileSync(out, rendered);
        written.push(out);
        continue;
      }
      const out = join(to, entry.name);
      cpSync(source, out);
      // A copied script keeps its mode only if it had one; `run.sh` in a
      // template is documentation until a build writes the real one.
      written.push(out);
    }
  };
  copyTree(templateDir, targetDir);

  // The launcher scripts a template ships (none today) would need their mode;
  // `chmod` on a file that is not a script is harmless, so this is a no-op guard
  // that costs nothing and prevents a silent 644 on a future template.
  for (const file of written) {
    if (file.endsWith('.sh')) {
      try { chmodSync(file, 0o755); } catch { /* a filesystem without modes */ }
    }
  }

  // ── what to do next ───────────────────────────────────────────────────────
  const relative = targetDir === resolve('.') ? '.' : basename(targetDir);
  step('');
  step(`tension: ${written.length} files written`);
  step('tension: next steps');
  if (relative !== '.') step(`  cd ${relative}`);
  step('  npm install');
  step('  npm run dev');
  step('');
  step('  then: npm run build   # a self-contained dist/ with a launcher');

  if (options.install) {
    step('');
    step('tension: installing dependencies…');
    const status = run(npmCommand(), ['install'], {
      cwd: targetDir,
      shell: process.platform === 'win32',
    });
    if (status !== 0) die('npm install failed', 'fix the error above, then run npm run dev');
  }

  return { dir: targetDir, name, title, template: templateId, files: written };
}
