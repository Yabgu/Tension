#!/usr/bin/env node
// Build Ogre-Next, and the FreeImage it links, from the pinned submodules.
//
// Builds `third_party/ogre-next` into `third_party/ogre-next-build` and installs
// it into `third_party/ogre-next-install`, from where the adapter build picks it
// up. `third_party/freeimage` is built first and installed into
// `third_party/freeimage-install`; the FreeImage section below explains why OGRE
// cannot be built without it.
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
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WIN, baseEnv, capture, run, toolchainReport, ucrt64Bin } from './lib/toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const THIRD = join(ROOT, 'third_party');

const SRC = join(THIRD, 'ogre-next');
const BUILD = join(THIRD, 'ogre-next-build');
const INSTALL = join(THIRD, 'ogre-next-install');
const FI_SRC = join(THIRD, 'freeimage');
const FI_BUILD = join(THIRD, 'freeimage-build');
const FI_INSTALL = join(THIRD, 'freeimage-install');

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
initSubmodule(FI_SRC, 'freeimage');

// 2. FreeImage, from its own submodule.
//
// This is not a preference, it is how OGRE's build is written. OgreMain's
// CMakeLists seeds BROKEN_FILES_IN_UNITY_BUILD with src/OgreFreeImageCodec2.cpp
// unconditionally, and create_unity_build_files() puts that SEPARATE list back
// into the target even when OGRE_UNITY_BUILD is off — so the translation unit is
// always compiled and linked. OGRE_CONFIG_ENABLE_FREEIMAGE=OFF only clears the
// codec *registration*; it does not take the file out of the target, and the
// adapter decodes every texture through Ogre::Image2::load, so the flag stays ON.
const fiFlags = [
  '-DCMAKE_BUILD_TYPE=Release',
  `-DCMAKE_INSTALL_PREFIX=${FI_INSTALL}`,
  // Shared, not static: the bundled codecs are separate CMake targets, so only
  // the shared library is one self-contained file for OGRE to link.
  '-DBUILD_SHARED_LIBS=ON',
  '-DFREEIMAGE_STATIC=OFF',
  '-DBUILD_TESTS=OFF',
  // No camera RAW: LibRawLite is the only bundled codec under a copyleft
  // licence, and it is compiled into libfreeimage statically. Nothing here reads
  // camera RAW; the switch is safe because the fork keeps the RAW slot in
  // FREE_IMAGE_FORMAT occupied with a stub, so the FIF_* values stay aligned.
  '-DBUILD_LIBRAWLITE=OFF',
];

if (WIN) {
  fiFlags.push('-G', 'Ninja');
  // The Windows build compiles LibTIFF4's tif_win32.c for its wide-char and
  // file-I/O entry points, and that file also defines
  // _TIFFerrorHandler/_TIFFwarningHandler — which
  // Source/FreeImage/PluginTIFF.cpp defines again, deliberately, as no-ops
  // ("in FreeImage warnings and errors are disabled"). MSVC's project files keep
  // the two in separate static libraries; this CMake build links both objects
  // into one DLL, and GNU ld refuses the duplicate:
  //
  //   tif_win32.c:(.data+0x0): multiple definition of `_TIFFerrorHandler';
  //   PluginTIFF.cpp:(.data+0x0): first defined here
  //
  // -fcommon does not help: both are initialized definitions, not tentative
  // ones. The first definition in link order wins, and that is PluginTIFF's
  // no-op pair — the behaviour FreeImage intends.
  fiFlags.push('-DCMAKE_SHARED_LINKER_FLAGS=-Wl,--allow-multiple-definition');
} else {
  // The layout of the distro package this repository was measured against:
  // libfreeimage.so.3 (+ the .so link) and freeimage.pc.
  fiFlags.push('-DFREEIMAGE_LINUX_PACKAGE_LAYOUT=ON');
}

// An install is a build here too: header + library on disk means done — but only
// if it was built from *these* flags. The stamp records the flag set, so changing
// one above rebuilds instead of silently reusing a library that still carries the
// old code. An install that predates the stamp has no recorded flags and so
// counts as stale, which is deliberate.
const fiStamp = join(FI_INSTALL, '.bootstrap-flags');
const fiWantStamp = `${fiFlags.join('\n')}\n`;
const fiLibrary = () => findMatching(FI_INSTALL, (name) =>
  name.startsWith('libfreeimage.so') || name === 'libfreeimage.a' ||
  name === 'freeimage.dll' || name === 'libfreeimage.dll.a');

let fiInstalled = existsSync(join(FI_INSTALL, 'include', 'FreeImage.h')) &&
                  fiLibrary() !== null &&
                  existsSync(fiStamp) &&
                  readFileSync(fiStamp, 'utf8') === fiWantStamp;

if (!fiInstalled || FORCE) {
  if (isDirectory(FI_INSTALL) && existsSync(join(FI_INSTALL, 'include', 'FreeImage.h'))) {
    say('FreeImage is installed but not with this flag set — rebuilding');
  }
  say(`building FreeImage (${FI_BUILD} -> ${FI_INSTALL})`);
  run('cmake', ['-S', FI_SRC, '-B', FI_BUILD, ...fiFlags]);
  run('cmake', ['--build', FI_BUILD, '-j', nproc()]);
  run('cmake', ['--install', FI_BUILD]);
  mkdirSync(FI_INSTALL, { recursive: true });
  writeFileSync(fiStamp, fiWantStamp);
} else {
  say('in-tree FreeImage already installed — reusing it.');
}

if (!existsSync(join(FI_INSTALL, 'include', 'FreeImage.h'))) {
  die(`FreeImage install has no FreeImage.h at ${join(FI_INSTALL, 'include')}`);
}
const fiLib = fiLibrary();
if (!fiLib) die(`FreeImage install has no library under ${FI_INSTALL}`);
const fiLibDir = dirname(fiLib);

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

const extraFlags = [
  `-DFREEIMAGE_HOME=${FI_INSTALL}`,
  `-DCMAKE_PREFIX_PATH=${FI_INSTALL}`,
];

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
    // libOgreNextMain.so records a DT_NEEDED on libfreeimage.so.3, and this
    // install sits outside the loader's default path. Bake the directory in as a
    // RUNPATH so every consumer resolves it without environment help.
    `-DCMAKE_INSTALL_RPATH=${fiLibDir}`,
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
  // ON, not OFF: OFF would leave OGRE with no PNG/JPEG decoder at all, because
  // OGRE_NO_FREEIMAGE skips the codec registration while the codec object is
  // still compiled and linked.
  '-DOGRE_CONFIG_ENABLE_FREEIMAGE=ON',
  '-DOGRE_CONFIG_ENABLE_JSON=ON',
  '-DOGRE_CONFIG_ENABLE_ZIP=ON',
];

console.log(`bootstrap: ${process.platform}/${process.arch} (${toolchainReport()})`);
say(`configuring (${SRC} -> ${BUILD})`);
const started = Date.now();
run('cmake', ['-S', SRC, '-B', BUILD, ...flags, ...extraFlags]);

// FreeImage is required, and the option is a cmake_dependent_option: a probe that
// comes up empty turns the codec off *silently* at configure time. Hold the
// configure to it here instead of discovering a missing texture decoder at run
// time.
const settings = join(BUILD, 'include', 'OgreBuildSettings.h');
if (!existsSync(settings) || !/^#define OGRE_NO_FREEIMAGE 0/m.test(readFileSync(settings, 'utf8'))) {
  die("OGRE's configure did not find FreeImage — the codec is off\n" +
      `  expected FreeImage.h in ${join(FI_INSTALL, 'include')} and a library in ${fiLibDir}\n` +
      `  (-DFREEIMAGE_HOME=${FI_INSTALL} was passed; check the configure output above)`);
}

say(`building with ${nproc()} jobs`);
run('cmake', ['--build', BUILD, '-j', nproc()]);

say(`installing to ${INSTALL}`);
run('cmake', ['--install', BUILD]);

// 4. The Vulkan plugin is what this build is for — a configure that dropped it
// must not read as success. The undefined-glslang check is the measured load
// failure: OGRE loads plugins with RTLD_LAZY | RTLD_LOCAL and these references
// bind eagerly, so an unresolved glslang:: symbol is a plugin that cannot load.
const elapsed = () => Math.round((Date.now() - started) / 1000);
if (vulkanExpected) {
  const vulkanRs = findMatching(INSTALL, (name) => name.startsWith('rendersystem_vulkan.'));
  if (!vulkanRs) {
    die('RenderSystem_Vulkan was not built — the Vulkan render system is off\n' +
        '  the configure did not pick up the flags above; check its output for Vulkan');
  }
  if (!WIN) {
    const undefinedSymbols = spawnSync('nm', ['-D', '--undefined-only', vulkanRs],
                                       { encoding: 'utf8', env: baseEnv() });
    if (undefinedSymbols.status === 0 && /glslang|spvtools/.test(undefinedSymbols.stdout)) {
      die(`${vulkanRs} still has undefined glslang/SPIRV-Tools symbols — it cannot load`);
    }
  }
  say(`done in ${elapsed()}s — ${mainLib || join(INSTALL, 'lib', 'libOgreNextMain.so')}`);
  say(`vulkan render system: ${vulkanRs}`);
} else {
  say(`done in ${elapsed()}s — ${mainLib || join(INSTALL, 'lib', 'libOgreNextMain.so')}`);
}
