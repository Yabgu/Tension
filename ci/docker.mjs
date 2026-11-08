#!/usr/bin/env node
// Tension container tooling: build the development image and run it.
//
// Commands:
//   node ci/docker.mjs build          build the image (OGRE-Next packages in ci/ogre-next-pkg)
//   node ci/docker.mjs test [args]    run `npm test` inside a fresh container
//   node ci/docker.mjs dev [cmd...]   development shell / command; repo bind-mounted at /app
//   node ci/docker.mjs clean          remove the image
//
// Environment:
//   TENSION_IMAGE                 image name (default: tension-dev)
//   TENSION_CONTAINER_RUNTIME     podman (default) or docker
//   TENSION_OGRE_PKG_DIR          dir with built ogre-next-git-*.pkg.tar.zst packages
//                                 (default: $HOME/src/ogre-next-git, an AUR build dir)
//
// A port of `ci/docker.sh`. The container-side command is `npm test` rather than
// `./test.sh`, because that script no longer exists: the suites are Node runners
// now, and the image already carries Node.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const image = process.env.TENSION_IMAGE ?? 'tension-dev';
const pkgDir = join(here, 'ogre-next-pkg');
const runtime = process.env.TENSION_CONTAINER_RUNTIME ?? 'podman';

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const USAGE = `usage: node ci/docker.mjs <command> [args...]

commands:
  build             build the ${image} image from ${here}
  test [args...]    run npm test inside the container (args forwarded)
  dev [cmd...]      run a command (default: bash) in the container with the
                    repository bind-mounted at /app and X available
  clean             remove the ${image} image`;

/// Make sure the OGRE-Next packages are in ci/ogre-next-pkg.
///
/// Prefer what is already there; otherwise copy the latest non-debug package from
/// the AUR build directory named by the environment variable.
function syncPkg(name, pattern, envvar, defaultSrc) {
  const matches = (dir) => {
    if (!existsSync(dir)) return [];
    // The patterns are shell globs — `ogre-next-git-r*.pkg.tar.zst` — so they
    // are translated rather than matched literally.
    const regex = new RegExp('^' +
      pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') +
      '$');
    return readdirSync(dir).filter((entry) => regex.test(entry));
  };

  if (matches(pkgDir).length) {
    console.log(`  ${name}: found in ${pkgDir}`);
    return;
  }

  const src = process.env[envvar] ?? defaultSrc;
  if (!existsSync(src)) {
    die(`${name} package missing. Put a ${pattern} package in ${pkgDir}, ` +
        `or set ${envvar} to a directory containing one (e.g. an AUR build dir).`);
  }
  const candidates = matches(src)
    .map((entry) => ({ entry, mtime: statSync(join(src, entry)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) die(`no ${name} package in ${src}`);

  mkdirSync(pkgDir, { recursive: true });
  copyFileSync(join(src, candidates[0].entry), join(pkgDir, candidates[0].entry));
  console.log(`  ${name}: copied ${candidates[0].entry}`);
}

/// A container run, inheriting stdio so an interactive shell stays interactive.
function runContainer(args) {
  const interactive = process.stdin.isTTY ? '-it' : '-i';
  const result = spawnSync(runtime, ['run', '--rm', interactive, ...args], { stdio: 'inherit' });
  if (result.error) die(`${runtime}: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

const [command = '', ...rest] = process.argv.slice(2);

switch (command) {
  case 'build': {
    console.log(`==> preparing OGRE-Next packages in ${pkgDir}`);
    syncPkg('ogre-next', 'ogre-next-git-r*.pkg.tar.zst', 'TENSION_OGRE_PKG_DIR',
            join(homedir(), 'src', 'ogre-next-git'));
    console.log(`==> building ${image} (context: ${here})`);
    const result = spawnSync(runtime, ['build', '-t', image, here], { stdio: 'inherit' });
    if (result.error) die(`${runtime}: ${result.error.message}`);
    if (result.status !== 0) process.exit(result.status ?? 1);
    console.log('==> done. Next: node ci/docker.mjs test   or   node ci/docker.mjs dev');
    break;
  }

  case 'test':
    // Run as root: under rootless podman, container root maps to the host user,
    // so build artifacts in the mounted repo stay host-owned.
    runContainer(['-v', `${repo}:/app`, '-w', '/app', image, 'npm', 'test', ...rest]);
    break;

  case 'dev': {
    // Run as the image's dev user with keep-id so files written into the mounted
    // repo are owned by the host user — needed for a usable dev loop.
    const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout?.trim();
    const gid = spawnSync('id', ['-g'], { encoding: 'utf8' }).stdout?.trim();
    const uidArgs = ['-u', `${uid}:${gid}`, '-e', 'HOME=/home/dev'];
    if (runtime === 'podman') uidArgs.unshift('--userns=keep-id');
    runContainer([...uidArgs, '-v', `${repo}:/app`, '-w', '/app', image,
                  ...(rest.length ? rest : ['bash'])]);
    break;
  }

  case 'clean': {
    const result = spawnSync(runtime, ['rmi', '-f', image], { stdio: 'inherit' });
    if (result.status !== 0) console.log('(image was already absent)');
    console.log(`removed image: ${image}`);
    break;
  }

  case '-h':
  case '--help':
  case 'help':
  case '':
    console.log(USAGE);
    break;

  default:
    die(`unknown command: ${command}. Run 'node ci/docker.mjs help'.`);
}
