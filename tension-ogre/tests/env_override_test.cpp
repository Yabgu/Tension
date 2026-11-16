// Is configuration from the environment read at all, and does the answer match
// the build type?
//
// One source file, compiled into every configuration, asserting that build's
// own half of the rule in `src/env_override.h`:
//
// * a **debug** build resolves `TENSION_OGRE_PLUGIN_DIR` / `TENSION_OGRE_MEDIA_DIR`,
//   treats an empty value as unset, and returns the baked path otherwise;
// * a **release** build returns nothing even when the variable is set, so the
//   value cannot reach `dlopen` or the archive manager.
//
// The pair is the point. A test that only asserted the release half would pass
// on a tree that had never read the variable in any configuration, and a test
// that only asserted the debug half says nothing about the artifact that ships.
// Run under both build types and the two halves together pin the behaviour.
//
// Pure: no OGRE, no display, no filesystem.

#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "env_override.h"

namespace {

int failures = 0;

void check(const char *what, bool ok) {
    std::printf("  %s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) ++failures;
}

void set_var(const char *name, const char *value) {
#if defined(_WIN32)
    _putenv_s(name, value != nullptr ? value : "");
#else
    if (value != nullptr) {
        setenv(name, value, 1);
    } else {
        unsetenv(name);
    }
#endif
}

bool same(const char *a, const char *b) {
    if (a == nullptr || b == nullptr) return a == b;
    return std::strcmp(a, b) == 0;
}

} // namespace

int main() {
    using namespace tension_ogre::env;

#if defined(TENSION_ENV_OVERRIDES)
    std::printf("debug build: the environment is an accepted source (TENSION_ENV_OVERRIDES)\n");
#else
    std::printf("release build: the environment is not read\n");
#endif

    // ── unset is nothing, in every configuration ──────────────────────────
    set_var("TENSION_OGRE_PLUGIN_DIR", nullptr);
    set_var("TENSION_OGRE_MEDIA_DIR", nullptr);
    check("an unset plugin dir resolves to nothing", plugin_dir() == nullptr);
    check("an unset media dir resolves to nothing", media_dir() == nullptr);

    // ── the variable, where this build reads it ───────────────────────────
    set_var("TENSION_OGRE_PLUGIN_DIR", "/tmp/env-override-probe/plugins");
    set_var("TENSION_OGRE_MEDIA_DIR", "/tmp/env-override-probe/Media");

#if defined(TENSION_ENV_OVERRIDES)
    check("a set plugin dir resolves to its value",
          same(plugin_dir(), "/tmp/env-override-probe/plugins"));
    check("a set media dir resolves to its value",
          same(media_dir(), "/tmp/env-override-probe/Media"));

    // An empty variable is unset: "" as a directory is never what a caller
    // meant, and the adapter would otherwise dlopen("/RenderSystem_GL3Plus.so").
    set_var("TENSION_OGRE_PLUGIN_DIR", "");
    check("an empty plugin dir is unset, not an empty path", plugin_dir() == nullptr);
#else
    check("compiled out: a set plugin dir resolves to nothing", plugin_dir() == nullptr);
    check("compiled out: a set media dir resolves to nothing", media_dir() == nullptr);
    std::printf("refused: compiled out of this release build — the plug-in and media\n"
                "         directories are the ones the build baked in\n");
#endif

    // Restore the environment the caller gave us; a test that leaks a variable
    // into the next binary in the suite is its own bug.
    set_var("TENSION_OGRE_PLUGIN_DIR", nullptr);
    set_var("TENSION_OGRE_MEDIA_DIR", nullptr);

    if (failures == 0) {
        std::printf("\nenv_override: PASS\n");
        return 0;
    }
    std::printf("\nenv_override: FAIL (%d check(s))\n", failures);
    return 1;
}
