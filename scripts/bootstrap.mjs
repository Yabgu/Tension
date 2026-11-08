#!/usr/bin/env node
// Build Ogre-Next from the pinned submodule.
//
// Builds `third_party/ogre-next` into `third_party/ogre-next-build` and installs
// it into `third_party/ogre-next-install`, from where the adapter build picks it
// up. It builds **without FreeImage**: the codec, its submodule and its install
// tree are gone, and the one translation unit OGRE compiles unconditionally is
// emptied by the patch step below.
//
// Why in-tree: the distro package's RenderSystem_Vulkan.so carries no DT_NEEDED
// for glslang — upstream's link line never names it — so the plugin cannot load
// there. Building from source is where that can be fixed: the Linux branch below
// hands OGRE's FindVulkan the glslang library in place of the shaderc_combined it
// wants. The flag set mirrors the AUR PKGBUILD, minus what we do not use.
//
// This is a port of `third_party/bootstrap.sh`, kept line for line in behaviour:
// the same checks, the same refusals, the same flags. It is a Node script so the
// build needs one toolchain on every platform rather than bash on some of them.
//
// Usage: node scripts/bootstrap.mjs [--force]

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIN, baseEnv, capture, need, run, toolchainReport, ucrt64Bin, which } from './lib/toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const THIRD = join(ROOT, 'third_party');

const SRC = join(THIRD, 'ogre-next');
const BUILD = join(THIRD, 'ogre-next-build');
const INSTALL = join(THIRD, 'ogre-next-install');
const PATCH = join(THIRD, 'patches', 'ogre-no-freeimage-codec.patch');

/// Every patch this project applies to the pinned Ogre-Next tree, in order.
///
/// Each entry names the files it touches, which is what `git checkout --`
/// reverts after the build: reverting the whole submodule would discard any
/// other local edit, so the list is explicit and narrow. `marker` is the proof
/// the patch is in the tree — checked in the file itself after applying, never
/// trusted from patch's exit status (see applyOgrePatch).
const OGRE_PATCHES = [
  {
    file: PATCH,
    label: 'OGRE_NO_FREEIMAGE',
    marker: '#if !OGRE_NO_FREEIMAGE',
    verifyIn: 'OgreMain/src/OgreFreeImageCodec2.cpp',
    touches: ['OgreMain/src/OgreFreeImageCodec2.cpp'],
  },
  {
    file: join(THIRD, 'patches', 'ogre-external-surface.patch'),
    label: 'external_surface',
    marker: 'adoptExternalSurface',
    verifyIn: 'RenderSystems/Vulkan/src/OgreVulkanWindow.cpp',
    touches: [
      'RenderSystems/Vulkan/include/OgreVulkanWindow.h',
      'RenderSystems/Vulkan/src/OgreVulkanWindow.cpp',
      'RenderSystems/Vulkan/src/Windowing/Android/OgreVulkanAndroidWindow.cpp',
      'RenderSystems/Vulkan/src/OgreVulkanRenderSystem.cpp',
      'RenderSystems/Vulkan/src/Windowing/X11/OgreVulkanXcbWindow.cpp',
      'RenderSystems/Vulkan/src/Windowing/win32/OgreVulkanWin32Window.cpp',
    ],
  },
];

const FORCE = process.argv.includes('--force');
for (const arg of process.argv.slice(2)) {
  if (arg !== '--force') {
    console.error(`bootstrap: unknown argument '${arg}' (want --force)`);
    process.exit(2);
  }
}

function say(message = '') {
  console.log(message === '' ? '' : `bootstrap: ${message}`);
}

function die(message) {
  console.error(`bootstrap: ${message}`);
  process.exit(1);
}

function nproc() {
  return String(Math.max(1, availableParallelism()));
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/// First file under `root` whose basename satisfies `match` (case-insensitive).
function findMatching(root, match) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findMatching(path, match);
      if (found) return found;
    } else if (match(entry.name.toLowerCase())) {
      return path;
    }
  }
  return null;
}

// 1. The submodules have to be there — initialise them on a fresh clone.
function initSubmodule(dir, name) {
  if (existsSync(join(dir, 'CMakeLists.txt'))) return;
  say(`third_party/${name} is empty; initialising the submodule`);
  run('git', ['-C', ROOT, 'submodule', 'update', '--init', '--recursive', `third_party/${name}`]);
}

initSubmodule(SRC, 'ogre-next');

// 2. Patch the one translation unit OGRE compiles regardless of its options.
//
// `OGRE_CONFIG_ENABLE_FREEIMAGE=OFF` clears the codec *registration* only.
// OgreMain/CMakeLists.txt:403 seeds BROKEN_FILES_IN_UNITY_BUILD with
// src/OgreFreeImageCodec2.cpp unconditionally, and OgreAddTargets.cmake:55
// appends that SEPARATE list to the target's sources — so the file is compiled
// even with the option off, and it includes <FreeImage.h> unguarded. Without
// this patch the build fails at that include (or at link, on a machine that
// still has the header).
//
// The patch adds `#if !OGRE_NO_FREEIMAGE` after OgreStableHeaders.h — the macro
// is defined by OgreConfig.h through that include, so a guard above it would
// read the macro as 0 and not guard anything. See the patch's own header.
//
// Idempotent by construction: a dry run first. If it applies, apply it. If it
// reports the patch as already applied, skip. Anything else is a real failure —
// an upstream upgrade moved the lines — and it is reported with patch's own
// rejected-hunk output, never skipped.
function applyOgrePatch(entry) {
  if (!existsSync(entry.file)) die(`missing ${entry.file}`);
  const target = join(SRC, entry.verifyIn);
  const patchArgs = ['-p1', '-N', '-r', '-', '--forward'];
  const source = readFileSync(entry.file, 'utf8');

  // `spawnSync` directly, not `run()`: `run()` sets `stdio: 'inherit'`, and with
  // an inherited stdin the `input` option is silently ignored. Measured: patch
  // then reads EOF, changes nothing, and **exits 0** — so an exit-code check
  // alone reports a no-op as success. Capture the stream instead, and verify the
  // file afterwards rather than trusting any status.
  const patchBin = which('patch') ?? need('patch', 'install via MSYS2 (pacman -S patch) or Git for Windows');
  const dry = spawnSync(patchBin, [...patchArgs, '--dry-run'], {
    cwd: SRC, encoding: 'utf8', env: baseEnv(), input: source,
  });
  if (dry.error) throw new Error(`patch: ${dry.error.message}`);
  const dryOut = `${dry.stdout ?? ''}${dry.stderr ?? ''}`;

  if (dry.status !== 0) {
    if (/previously applied|already applied|Reversed \(or previously applied\)/i.test(dryOut)) {
      say(`${entry.label}: already in the tree — skipping`);
      return;
    }
    die(`the ${entry.label} patch does not apply — the submodule moved\n` +
        `  patch: ${entry.file}\n` +
        `  target: ${target}\n` +
        `  ${dryOut.trim().split('\n').join('\n  ')}`);
  }

  const applied = spawnSync(patchBin, patchArgs, {
    cwd: SRC, encoding: 'utf8', env: baseEnv(), input: source,
  });
  if (applied.error) throw new Error(`patch: ${applied.error.message}`);
  const appliedOut = `${applied.stdout ?? ''}${applied.stderr ?? ''}`;

  // The status is not the proof; the file is. A patch that reports success and
  // changes nothing is exactly the failure the first version of this function
  // had, and it surfaced two minutes later as a FreeImage.h compile error.
  const guarded = readFileSync(target, 'utf8');
  if (!guarded.includes(entry.marker)) {
    die(`the ${entry.label} patch reported success but its marker is not in the file\n` +
        `  marker: ${entry.marker}\n` +
        `  target: ${target}\n` +
        `  patch:  ${appliedOut.trim().split('\n').join('\n  ')}`);
  }
  say(`${entry.label}: applied`);
}

// Applied here, not at step 2, and reverted after the install. Two reasons:
//
//   * the early "already installed — nothing to do" exit sits between this point
//     and the build, so a second bootstrap never patches at all and stays a true
//     no-op rather than a patch-and-revert cycle;
//   * AGENTS.md rule 1 keeps third_party/ogre-next read-only, and leaving the
//     guard in its working tree would show the submodule as dirty on every
//     checkout (`git status` reports `m third_party/ogre-next`) for a file no
//     one committed. The patch is applied for the build and taken back after,
//     so the tree a reviewer sees is the one the pin names.
//
// The consequence, stated so it is not a surprise: after a bootstrap the build
// tree's object for this TU was compiled from a patched source that is no longer
// on disk. That is fine for the supported path — AGENTS.md says OGRE is built
// only through `npm run bootstrap`, which patches again before it builds — and a
// direct `cmake --build` on third_party/ogre-next-build is not a supported path.
let ogrePatchApplied = false;
function revertOgrePatch() {
  if (!ogrePatchApplied) return;
  ogrePatchApplied = false;
  if (!existsSync(join(SRC, '.git'))) return;  // a tarball checkout has nothing to restore
  const touched = OGRE_PATCHES.flatMap((entry) => entry.touches);
  spawnSync('git', ['checkout', '--', ...touched], {
    cwd: SRC, encoding: 'utf8', env: baseEnv(),
  });
}
process.on('exit', revertOgrePatch);
process.on('SIGINT', () => { revertOgrePatch(); process.exit(130); });

// 3. Idempotence: an install is a build; don't redo it unless asked.
//
// The layout is platform-dependent: Linux installs the media under
// share/OGRE-Next/ and the library in lib/, while Windows puts Media/ at the
// prefix root and the library in lib/Release (import) and bin/Release (DLL).
// Asking for one platform's spelling made this check answer "not installed" on
// the other, which rebuilt a complete tree from scratch on every run.
const mediaOk = isDirectory(join(INSTALL, 'share', 'OGRE-Next', 'Media')) ||
                isDirectory(join(INSTALL, 'Media'));
const mainLib = findMatching(INSTALL, (name) =>
  /^(lib)?ogrenextmain\.(so|dll|lib|dll\.a)$/.test(name) ||
  /^libogrenextmain\.so\.\d/.test(name)) ?? '';
let installed = mediaOk && mainLib !== '';

// The Vulkan plugin is part of what this install is for, and its absence is not
// "built already, nothing to do". Without this, a tree that has everything
// *except* the Vulkan render system would make this script a no-op.
if (installed && !findMatching(INSTALL, (name) => name.startsWith('rendersystem_vulkan.'))) {
  installed = false;
}
if (installed && !FORCE) {
  say('in-tree Ogre-Next already exists — nothing to do.');
  say('use --force to rebuild.');
  process.exit(0);
}
if (FORCE) say('--force — reconfiguring and rebuilding');

// Library directories to search on a Unix host: pkg-config's glslang libdir
// first, then the usual places.
const unixLibDirs = [];
if (!WIN) {
  const glslangPc = spawnSync('pkg-config', ['--variable=libdir', 'glslang'],
                              { encoding: 'utf8', env: baseEnv() });
  if (glslangPc.status === 0 && glslangPc.stdout.trim()) {
    unixLibDirs.push(glslangPc.stdout.trim());
  }
  unixLibDirs.push(`/usr/lib/${capture('uname', ['-m'])}-linux-gnu`, '/usr/lib64', '/usr/lib', '/usr/local/lib');
}

/// The first existing path from `names` in `dirs`. The link-time name matters:
/// a runtime-only install's versioned file is what the loader loads, not what
/// the linker accepts.
function linkableLib(names) {
  for (const dir of unixLibDirs) {
    for (const name of names) {
      const path = join(dir, name);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

const extraFlags = [];

// Whether this platform's flag set is supposed to produce the Vulkan render
// system; the post-install check at the bottom holds the build to it.
let vulkanExpected = false;

if (WIN) {
  // The bash script could write `/ucrt64/lib/libglslang.dll.a` because cmake ran
  // inside an MSYS shell, where that path resolves. From Node, cmake is a native
  // Windows process and `/ucrt64/...` is not a path at all — ninja reports
  // "'/ucrt64/lib/libglslang.dll.a', needed by 'bin/RenderSystem_Vulkan.dll',
  // missing and no known rule to make it". Derive the real path from the
  // toolchain instead of spelling it.
  const ucrt = ucrt64Bin();
  if (!ucrt) {
    die('MSYS2 UCRT64 not found; OGRE needs its glslang to build the Vulkan render system');
  }
  const shaderc = join(dirname(ucrt), 'lib', 'libglslang.dll.a')
    .split('\\').join('/');
  if (!existsSync(shaderc)) {
    die(`expected glslang's import library at ${shaderc} (MSYS2 package mingw-w64-ucrt-x86_64-glslang)`);
  }
  extraFlags.push(
    '-G', 'Ninja',
    '-DCMAKE_C_COMPILER=gcc',
    '-DCMAKE_CXX_COMPILER=g++',
    '-DCMAKE_CXX_FLAGS=-U_WIN32_WINNT -D_WIN32_WINNT=0x0600',
    '-DCMAKE_C_FLAGS=-U_WIN32_WINNT -D_WIN32_WINNT=0x0600',
    '-DOGRE_BUILD_RENDERSYSTEM_D3D11=OFF',
    `-DVulkan_SHADERC_LIB_REL=${shaderc}`,
    `-DVulkan_SHADERC_LIB_DBG=${shaderc}`,
  );
  vulkanExpected = true;
} else if (process.platform === 'linux') {
  // OGRE's FindVulkan requires a `shaderc_combined` library — an artifact only
  // the LunarG Vulkan SDK installs — and cmake_dependent_option() then forces the
  // whole Vulkan render system off *silently* when it is missing: the configure
  // exits 0 and the install ships no RenderSystem_Vulkan. Point that variable at
  // glslang instead: it is the library whose symbols RenderSystem_Vulkan calls.
  let glslangInclude = '';
  const pcInclude = spawnSync('pkg-config', ['--variable=includedir', 'glslang'],
                               { encoding: 'utf8', env: baseEnv() });
  const includeCandidates = [
    ...(pcInclude.status === 0 ? [pcInclude.stdout.trim()] : []),
    '/usr/include', '/usr/local/include',
  ].filter(Boolean);
  for (const dir of includeCandidates) {
    if (existsSync(join(dir, 'glslang', 'Public', 'ShaderLang.h'))) {
      glslangInclude = dir;
      break;
    }
  }

  const glslangLib = linkableLib([
    'libglslang.so', 'libglslang.so.16', 'libglslang.so.15', 'libglslang.a',
  ]);
  let shaderLibs = glslangLib ?? '';
  let spirvLibs = null;
  // Where the distro ships glslang as a static archive, SPIRV-Tools has to be
  // named too: glslang's SpvTools object references spvtools:: passes.
  if (glslangLib && glslangLib.endsWith('.a')) {
    const opt = linkableLib(['libSPIRV-Tools-opt.so', 'libSPIRV-Tools-opt.a']);
    const base = linkableLib(['libSPIRV-Tools.so', 'libSPIRV-Tools.a']);
    if (opt && base) {
      spirvLibs = `${opt};${base}`;
      shaderLibs = `${glslangLib};${spirvLibs}`;
    }
  }

  const missing = [];
  if (!glslangLib) missing.push('the glslang library (libglslang.so or libglslang.a)');
  if (!glslangInclude) missing.push('the glslang headers (glslang/Public/ShaderLang.h)');
  if (glslangLib && glslangLib.endsWith('.a') && !spirvLibs) {
    missing.push("SPIRV-Tools (libSPIRV-Tools-opt and libSPIRV-Tools, which glslang's static archive calls into)");
  }
  if (!existsSync('/usr/include/vulkan/vulkan.h')) {
    missing.push('the Vulkan headers (vulkan/vulkan.h, libvulkan-dev)');
  }
  if (!linkableLib(['libvulkan.so'])) {
    missing.push("the Vulkan loader's development files (libvulkan.so, libvulkan-dev)");
  }
  // The XCB window is Linux's only Vulkan window, and upstream links it by bare
  // name, so the -dev packages have to be installed or the plugin will not link.
  if (!linkableLib(['libxcb-randr.so'])) missing.push("xcb-randr's development files (libxcb-randr.so)");
  if (!linkableLib(['libX11-xcb.so'])) missing.push("X11-xcb's development files (libX11-xcb.so)");

  if (missing.length) {
    console.error('bootstrap: the Vulkan render system needs libraries that are not installed:');
    for (const item of missing) console.error(`bootstrap:   ${item}`);
    console.error('bootstrap: install them and run this again, e.g.');
    console.error('bootstrap:   Debian/Ubuntu:  sudo apt install glslang-dev spirv-tools libxcb-randr0-dev libx11-xcb-dev');
    console.error('bootstrap:   Arch:           sudo pacman -S glslang spirv-tools libxcb libx11');
    process.exit(1);
  }

  extraFlags.push(
    `-DVulkan_SHADERC_LIB_REL=${shaderLibs}`,
    `-DVulkan_SHADERC_LIB_DBG=${shaderLibs}`,
    // Always, even when it is /usr/include: FindVulkan leaves this variable as
    // NOTFOUND when it finds nothing, and OGRE's FindVulkan then dies with
    // "Found relative path while evaluating include directories".
    `-DVulkan_SHADERC_INCLUDE_DIR=${glslangInclude}`,
    // The install sits outside the loader's default path, and the plugins
    // (RenderSystem_*.so) have a DT_NEEDED on libOgreNextMain.so themselves.
    // Bake the install's own lib directory in as a RUNPATH so that resolution
    // needs no environment help. Before FreeImage was removed this pointed at
    // the FreeImage install instead, because OgreMain recorded a DT_NEEDED on
    // libfreeimage.so.3; that dependency is gone and no longer needs one.
    `-DCMAKE_INSTALL_RPATH=${join(INSTALL, 'lib')}`,
  );
  vulkanExpected = true;
}
// Other Unix hosts are left alone: Vulkan there needs MoltenVK or another window
// backend, which this build has never produced. vulkanExpected stays false, so
// the check at the bottom does not demand it.

const flags = [
  '-DCMAKE_BUILD_TYPE=Release',
  `-DCMAKE_INSTALL_PREFIX=${INSTALL}`,
  '-DOGRE_BUILD_RENDERSYSTEM_GL3PLUS=ON',
  '-DOGRE_BUILD_RENDERSYSTEM_VULKAN=ON',
  '-DOGRE_BUILD_COMPONENT_HLMS_PBS=ON',
  '-DOGRE_BUILD_COMPONENT_HLMS_UNLIT=ON',
  '-DOGRE_BUILD_COMPONENT_MESHLODGENERATOR=ON',
  '-DOGRE_BUILD_COMPONENT_OVERLAY=ON',
  '-DOGRE_BUILD_COMPONENT_PLANAR_REFLECTIONS=ON',
  '-DOGRE_USE_BOOST=0',
  '-DOGRE_SIMD_NEON=FALSE',
  '-DOGRE_BUILD_SAMPLES2=OFF',
  '-DOGRE_BUILD_TESTS=OFF',
  '-DOGRE_BUILD_TOOLS=ON',
  // Not "install the demos": upstream hangs the Media tree (the Hlms material
  // JSONs and resources2.cfg the adapter reads) off this flag alone.
  '-DOGRE_INSTALL_SAMPLES=ON',
  '-DOGRE_INSTALL_SAMPLES_SOURCE=OFF',
  '-DOGRE_INSTALL_DOCS=0',
  '-DOGRE_CONFIG_THREAD_PROVIDER=std',
  // OFF: FreeImage is not in this tree. The codec object is still compiled (see
  // step 2's patch, which empties it); OFF is what stops OGRE registering it.
  //
  // ON: STBI is the replacement, not an optional extra. With both off Ogre has
  // no image codec at all — no PNG, no JPEG, no TGA — and every texture load
  // through Ogre::Image fails at runtime. `OGRE_CONFIG_ENABLE_STBI` defaults to
  // FALSE upstream (CMakeLists.txt:556), so this has to be stated explicitly;
  // leaving it out is the same as turning it off.
  '-DOGRE_CONFIG_ENABLE_FREEIMAGE=OFF',
  '-DOGRE_CONFIG_ENABLE_STBI=ON',
  '-DOGRE_CONFIG_ENABLE_JSON=ON',
  '-DOGRE_CONFIG_ENABLE_ZIP=ON',
];

if (existsSync(join(BUILD, 'CMakeCache.txt'))) {
  const cache = readFileSync(join(BUILD, 'CMakeCache.txt'), 'utf8');
  if (WIN && cache.includes('cl.exe')) {
    say('cleaning previous MSVC build tree in favor of MinGW GCC');
    rmSync(BUILD, { recursive: true, force: true });
  }
}
if (FORCE && existsSync(BUILD)) {
  say('cleaning build tree (--force)');
  rmSync(BUILD, { recursive: true, force: true });
}

console.log(`bootstrap: ${process.platform}/${process.arch} (${toolchainReport()})`);
say(`configuring (${SRC} -> ${BUILD})`);
const started = Date.now();
run('cmake', ['-S', SRC, '-B', BUILD, ...flags, ...extraFlags]);

// FreeImage must be off and STBI must be on. Both are held to it here.
// `cmake_dependent_option` turns each one off *silently* when its probe comes up
// empty, so a configure on a machine that happens to carry FreeImage.h would
// otherwise put the codec back on without saying so — and the install would then
// ship a libfreeimage DT_NEEDED that this tree no longer vendors. The STBI half
// is the mirror image: it defaults to FALSE upstream, so a dropped flag silently
// leaves the build with no codec at all.
const settings = join(BUILD, 'include', 'OgreBuildSettings.h');
if (!existsSync(settings)) {
  die(`OGRE's configure produced no ${settings}`);
}
const settingsText = readFileSync(settings, 'utf8');
if (!/^#define OGRE_NO_FREEIMAGE 1$/m.test(settingsText)) {
  die('OGRE\'s configure did not disable FreeImage\n' +
      `  expected \`#define OGRE_NO_FREEIMAGE 1\` in ${settings}\n` +
      '  check the configure output above');
}
if (/^#define OGRE_NO_STBI_CODEC 1$/m.test(settingsText)) {
  die('OGRE\'s configure disabled the STBI codec\n' +
      `  found \`#define OGRE_NO_STBI_CODEC 1\` in ${settings}\n` +
      '  STBI is this tree\'s only image codec; without it no PNG/JPEG/TGA loads.');
}

for (const entry of OGRE_PATCHES) applyOgrePatch(entry);
ogrePatchApplied = true;

say(`building with ${nproc()} jobs`);
run('cmake', ['--build', BUILD, '-j', nproc()]);

say(`installing to ${INSTALL}`);
run('cmake', ['--install', BUILD]);

// 4. The Vulkan plugin is what this build is for — a configure that dropped it
// must not read as success, and a plugin that cannot load must not either.
//
// The load test is `ldd -r`, which asks the dynamic loader what it actually
// cannot resolve. The earlier check grepped `nm -D --undefined-only` for
// `glslang`, and that question cannot be answered that way: every reference to
// `glslang::GlslangToSpv` is undefined *in this plugin* by design, because
// `libglslang.so.16` supplies it through a DT_NEEDED entry. Measured on a
// working plugin: 15 such symbols, `ldd -r` clean, `dlopen` fine — so the old
// check failed on a good build. (`ldd -r` also catches the case that matters:
// a sibling library that is not on the plugin's own RUNPATH.)
const elapsed = () => Math.round((Date.now() - started) / 1000);
if (vulkanExpected) {
  const vulkanRs = findMatching(INSTALL, (name) => name.startsWith('rendersystem_vulkan.'));
  if (!vulkanRs) {
    die('RenderSystem_Vulkan was not built — the Vulkan render system is off\n' +
        '  the configure did not pick up the flags above; check its output for Vulkan');
  }
  if (!WIN) {
    const resolved = spawnSync('ldd', ['-r', vulkanRs], { encoding: 'utf8', env: baseEnv() });
    const unresolved = `${resolved.stdout ?? ''}${resolved.stderr ?? ''}`
      .split('\n')
      .filter((line) => /undefined symbol|not found/i.test(line));
    if (unresolved.length) {
      die(`${vulkanRs} cannot load — the loader reports ${unresolved.length} unresolved reference(s)\n` +
          `  ${unresolved.slice(0, 5).join('\n  ')}`);
    }
  }
  say(`done in ${elapsed()}s — ${mainLib || join(INSTALL, 'lib', 'libOgreNextMain.so')}`);
  say(`vulkan render system: ${vulkanRs}`);
} else {
  say(`done in ${elapsed()}s — ${mainLib || join(INSTALL, 'lib', 'libOgreNextMain.so')}`);
}
