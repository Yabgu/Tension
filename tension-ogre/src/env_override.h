// Configuration from the environment, and the one place that decides whether a
// build may take any.
//
// # Why this is a security boundary, not a convenience
//
// `TENSION_OGRE_PLUGIN_DIR` names a *directory the adapter dlopen()s a render
// system out of*. Whoever can set a variable in a process's environment can
// therefore choose which shared library that process loads — which is code
// execution with the host's privileges, spelled as a path. `TENSION_OGRE_MEDIA_DIR`
// is the same shape one step weaker: a data root Ogre parses (Hlms templates,
// material scripts).
//
// A release build must not have that surface. The requirement is stronger than
// "ignore the variable in release": a runtime rejection leaves the read in the
// binary and trusts a condition the attacker controls the other half of. So the
// read is **compiled out** — in a release build these functions contain no
// `getenv` call and the binary contains no occurrence of the variable's name,
// which is a property you can check (`strings`) rather than argue about.
//
// # What a release build uses instead
//
// The directories the build baked in (`CMakeLists.txt` resolves them from the
// Ogre prefix it linked against, and `scripts/build-ogre.mjs` takes
// `TENSION_OGRE_PREFIX`). That is a path chosen at build time by whoever
// produced the artifact, not one inherited from whatever environment it later
// starts in.
//
// # Why debug keeps it
//
// The dev loop runs the same adapter against a tree that moves: a second Ogre
// build for a probe, a payload layout, an install that has been relocated.
// Debug builds are run by the person building them, on their own machine, and
// the override is what keeps `run-example.mjs` from needing a relink between
// experiments. `TENSION_NO_ENV_OVERRIDES` turns it off in a debug build too,
// which is how the closed path gets measured without a release build.
//
// The shape is the one a Rust host uses for the same reason
// (`#[cfg(debug_assertions)]` around the capability-name lookup in
// `tension-core/src/main.rs`), so the tree has one policy and not two.

#pragma once

#include <cstdlib>

#if !defined(NDEBUG) && !defined(TENSION_NO_ENV_OVERRIDES)
#define TENSION_ENV_OVERRIDES 1
#endif

namespace tension_ogre {
namespace env {

/// A set, non-empty value — or nothing. An empty variable is unset for this
/// purpose: `""` as a directory is never what a caller meant.
inline const char *nonempty(const char *value) {
    return (value != nullptr && *value != '\0') ? value : nullptr;
}

/// The plug-in directory the environment asks for, or `nullptr` when this build
/// takes no configuration from the environment.
inline const char *plugin_dir() {
#if defined(TENSION_ENV_OVERRIDES)
    return nonempty(std::getenv("TENSION_OGRE_PLUGIN_DIR"));
#else
    // Deliberately no `getenv`, and no mention of the name: a release binary
    // that carried the string would invite the reader to think it is read.
    return nullptr;
#endif
}

/// The media root the environment asks for, or `nullptr` when this build takes
/// no configuration from the environment.
inline const char *media_dir() {
#if defined(TENSION_ENV_OVERRIDES)
    return nonempty(std::getenv("TENSION_OGRE_MEDIA_DIR"));
#else
    return nullptr;
#endif
}

} // namespace env
} // namespace tension_ogre
