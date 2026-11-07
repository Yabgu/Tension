cmake_minimum_required(VERSION 3.20)
project(tension_ogre C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(TENSION_OGRE_ROOT ${CMAKE_CURRENT_SOURCE_DIR})
set(TENSION_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/..)

set(OGRE_NEXT_PREFIX "${TENSION_ROOT}/third_party/ogre-next-install" CACHE PATH "OGRE-Next installation prefix")
set(TENSION_RES_DIR "${TENSION_ROOT}/tension-res" CACHE PATH "tension-res directory")

if(NOT DEFINED TENSION_OGRE_BACKEND)
    set(TENSION_OGRE_BACKEND "ogre")
endif()

# Where the media and the render-system plugins are, keyed on what is actually
# on disk rather than on one platform's install layout. The prefix is not always
# a real Ogre install: it can also be the flat `packages/ogre-next-*` payload,
# where `lib/`, `include/` and `Media/` sit at the root. A real install puts the
# media under `share/OGRE-Next/Media` and the plugins under `lib/OGRE-Next`
# (Unix) or `bin/` and `bin/Release` (Windows). Getting this wrong is not a
# build failure — it is a runtime "no valid template shader files" — so it is
# decided here, once, from the tree.
if(EXISTS "${OGRE_NEXT_PREFIX}/Media/Hlms")
    set(OGRE_MEDIA_DIR "${OGRE_NEXT_PREFIX}/Media")
elseif(EXISTS "${OGRE_NEXT_PREFIX}/share/OGRE-Next/Media/Hlms")
    set(OGRE_MEDIA_DIR "${OGRE_NEXT_PREFIX}/share/OGRE-Next/Media")
else()
    set(OGRE_MEDIA_DIR "${OGRE_NEXT_PREFIX}/Media")
endif()

set(OGRE_PLUGIN_DIR "${OGRE_NEXT_PREFIX}/bin")
if(EXISTS "${OGRE_NEXT_PREFIX}/lib/OGRE-Next")
    set(OGRE_PLUGIN_DIR "${OGRE_NEXT_PREFIX}/lib/OGRE-Next")
endif()
if(EXISTS "${OGRE_NEXT_PREFIX}/bin/Release")
    set(OGRE_PLUGIN_DIR "${OGRE_NEXT_PREFIX}/bin/Release")
endif()

set(SOURCES
    src/config.cpp
    src/status.cpp
    src/scene.cpp
    src/loader.cpp
    src/mounts.cpp
    src/adapter.cpp
)

if(TENSION_OGRE_BACKEND STREQUAL "ogre")
    list(APPEND SOURCES
        src/backend_ogre.cpp
        src/hlms_tension_skin.cpp
    )
else()
    list(APPEND SOURCES
        src/backend_none.cpp
    )
endif()

add_library(tension_ogre SHARED ${SOURCES})

# Target output name: libtension_ogre
set_target_properties(tension_ogre PROPERTIES
    OUTPUT_NAME "tension_ogre"
    PREFIX "lib"
)

target_include_directories(tension_ogre PRIVATE
    ${TENSION_OGRE_ROOT}/include
    ${TENSION_OGRE_ROOT}/src
    ${TENSION_ROOT}/tension-core/include
    ${TENSION_RES_DIR}/include
)

target_compile_definitions(tension_ogre PRIVATE
    TENSION_OGRE_BACKEND="${TENSION_OGRE_BACKEND}"
    TENSION_OGRE_MEDIA_DIR="${OGRE_MEDIA_DIR}"
    TENSION_OGRE_PLUGIN_DIR="${OGRE_PLUGIN_DIR}"
)

if(MSVC)
    target_compile_options(tension_ogre PRIVATE /W3 /utf-8 /EHsc /bigobj /D_CRT_SECURE_NO_WARNINGS)
else()
    target_compile_options(tension_ogre PRIVATE -Wall -Wextra -fPIC)
endif()

# Find tension_res static archive
find_library(TENSION_RES_LIB
    NAMES tension_res libtension_res
    PATHS "${TENSION_RES_DIR}/zig-out/lib"
    NO_DEFAULT_PATH
)
if(NOT TENSION_RES_LIB)
    message(FATAL_ERROR "tension_res library not found in ${TENSION_RES_DIR}/zig-out/lib")
endif()

target_link_libraries(tension_ogre PRIVATE ${TENSION_RES_LIB})

if(TENSION_OGRE_BACKEND STREQUAL "ogre")
    target_include_directories(tension_ogre SYSTEM PRIVATE
        ${OGRE_NEXT_PREFIX}/include
        ${OGRE_NEXT_PREFIX}/include/OGRE-Next
        ${OGRE_NEXT_PREFIX}/include/OGRE-Next/Hlms/Common
        ${OGRE_NEXT_PREFIX}/include/OGRE-Next/Hlms/Unlit
        ${OGRE_NEXT_PREFIX}/include/OGRE-Next/Hlms/Pbs
    )

    if(WIN32)
        list(APPEND CMAKE_FIND_LIBRARY_SUFFIXES ".dll.a" ".a")
    endif()

    find_library(OGRE_NEXT_MAIN_LIB NAMES OgreNextMain libOgreNextMain PATHS "${OGRE_NEXT_PREFIX}/lib" "${OGRE_NEXT_PREFIX}/lib/Release" NO_DEFAULT_PATH)
    find_library(OGRE_NEXT_HLMS_UNLIT_LIB NAMES OgreNextHlmsUnlit libOgreNextHlmsUnlit PATHS "${OGRE_NEXT_PREFIX}/lib" "${OGRE_NEXT_PREFIX}/lib/Release" NO_DEFAULT_PATH)
    find_library(OGRE_NEXT_HLMS_PBS_LIB NAMES OgreNextHlmsPbs libOgreNextHlmsPbs PATHS "${OGRE_NEXT_PREFIX}/lib" "${OGRE_NEXT_PREFIX}/lib/Release" NO_DEFAULT_PATH)

    if(NOT OGRE_NEXT_MAIN_LIB OR NOT OGRE_NEXT_HLMS_UNLIT_LIB OR NOT OGRE_NEXT_HLMS_PBS_LIB)
        message(FATAL_ERROR "Could not find OGRE-Next libraries in ${OGRE_NEXT_PREFIX}/lib")
    endif()

    target_link_libraries(tension_ogre PRIVATE
        ${OGRE_NEXT_MAIN_LIB}
        ${OGRE_NEXT_HLMS_UNLIT_LIB}
        ${OGRE_NEXT_HLMS_PBS_LIB}
    )
endif()

if(WIN32)
    target_link_libraries(tension_ogre PRIVATE ntdll ws2_32 user32 gdi32)
else()
    target_link_libraries(tension_ogre PRIVATE pthread dl)
endif()

# The in-tree Ogre-Next lives outside the loader's default search path, and its
# sonames are identical to a distro package's, so which one a process gets is
# decided by the search path. All of them are relative to the DSO's own
# directory:
#   $ORIGIN                                     a self-contained drop
#   $ORIGIN/<payload sibling>                   the platform payload package
#   $ORIGIN/../../third_party/ogre-next-install/lib   this repository's build tree
#
# The middle one cannot be written down here. The payload lives in
# `packages/ogre-<platform>-<arch>/lib` and its Ogre-Next sibling in
# `packages/ogre-next-<platform>-<arch>/lib`, so the relative spelling depends on
# the platform suffix, which this file does not know. It used to be spelled
# `$ORIGIN/../../ogre-next/lib` — correct only for the pre-payload layout, where
# the two directories had no suffix. Against the payload it resolved to
# `packages/ogre-next/lib`, a stale leftover of that older build, and glibc takes
# the first rpath hit without checking whether it is current. The result was an
# adapter that loaded an Ogre-Next built before FreeImage was removed and died on
# `libfreeimage.so.3` — while the build and every test passed, because both of
# those reach the DSO through a different rpath entry.
#
# So scripts/build-native.mjs computes the directory from the paths it actually
# wrote and passes it in. TENSION_OGRE_RPATH_EXTRA is `;`-separated and each
# entry is appended to `$ORIGIN/`.
#
# `--disable-new-dtags` emits DT_RPATH rather than DT_RUNPATH on purpose:
# DT_RPATH is consulted *before* LD_LIBRARY_PATH and DT_RUNPATH after, and the
# in-tree libraries must win. `--exclude-libs,ALL` keeps the static
# tension_res archive's ~120 exported symbols out of this DSO's dynamic table —
# the adapter's own entry points are the ones that must be visible to dlopen.
#
# Windows needs none of this: the post-build step copies Ogre's DLLs beside the
# adapter and tension-core loads it with LOAD_WITH_ALTERED_SEARCH_PATH.
set(TENSION_OGRE_RPATH_EXTRA "" CACHE STRING
    "Extra $ORIGIN-relative library directories for the payload layout (';'-separated)")

if(UNIX)
    set(_tension_ogre_rpath "$ORIGIN")
    foreach(_tension_ogre_extra IN LISTS TENSION_OGRE_RPATH_EXTRA)
        if(NOT _tension_ogre_extra STREQUAL "")
            string(APPEND _tension_ogre_rpath ":$ORIGIN/${_tension_ogre_extra}")
        endif()
    endforeach()
    # The build-tree install. Kept last and unconditional: it is what makes
    # `tension-ogre/build/libtension_ogre.so` load without LD_LIBRARY_PATH, which
    # is how the C++ and Rust suites run the adapter.
    string(APPEND _tension_ogre_rpath ":$ORIGIN/../../third_party/ogre-next-install/lib")
    message(STATUS "tension-ogre rpath: ${_tension_ogre_rpath}")

    set_target_properties(tension_ogre PROPERTIES
        INSTALL_RPATH "${_tension_ogre_rpath}"
        BUILD_WITH_INSTALL_RPATH TRUE
        LINK_FLAGS "-Wl,--disable-new-dtags,--exclude-libs,ALL"
    )
endif()

# Post-build step: stage the adapter where the Rust tests look for it. The
# `libtension_ogre.so` name is deliberate — the DSO's loader looks for that
# soname on every platform, and Windows LoadLibrary does not care about the
# extension. Also copy OGRE-Next's own DLLs beside it: the adapter imports
# them, the loaders use LOAD_WITH_ALTERED_SEARCH_PATH, and this directory is
# then self-contained (no PATH edits to run the tests or the host).
add_custom_command(TARGET tension_ogre POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${TENSION_OGRE_ROOT}/build"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "$<TARGET_FILE:tension_ogre>" "${TENSION_OGRE_ROOT}/build/$<TARGET_FILE_NAME:tension_ogre>"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "$<TARGET_FILE:tension_ogre>" "${TENSION_OGRE_ROOT}/build/libtension_ogre.so"
)

if(TENSION_OGRE_BACKEND STREQUAL "ogre")
    file(GLOB OGRE_RUNTIME_DLLS "${OGRE_NEXT_PREFIX}/bin/*.dll" "${OGRE_NEXT_PREFIX}/bin/Release/*.dll")
    if(OGRE_RUNTIME_DLLS)
        add_custom_command(TARGET tension_ogre POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different ${OGRE_RUNTIME_DLLS} "${TENSION_OGRE_ROOT}/build"
        )
    endif()
endif()

# ── unit tests ──────────────────────────────────────────────────────────────
#
# The loader's worker reads bytes and the backend is a mock, the config decoder
# is pure parsing: none of these need OGRE, and `loader_test` links the same
# static archive the adapter does. Built only when asked (`npm test`), so a
# plain build stays a build.
option(TENSION_OGRE_BUILD_TESTS "Build the adapter's unit tests" OFF)
if(TENSION_OGRE_BUILD_TESTS)
    add_executable(config_test src/config.cpp tests/config_test.cpp)
    target_include_directories(config_test PRIVATE
        ${TENSION_OGRE_ROOT}/include ${TENSION_OGRE_ROOT}/src)

    add_executable(scene_test src/scene.cpp tests/scene_test.cpp)
    target_include_directories(scene_test PRIVATE
        ${TENSION_OGRE_ROOT}/include ${TENSION_OGRE_ROOT}/src)

    add_executable(loader_test src/loader.cpp src/mounts.cpp tests/loader_test.cpp)
    target_include_directories(loader_test PRIVATE
        ${TENSION_OGRE_ROOT}/include ${TENSION_OGRE_ROOT}/src
        ${TENSION_RES_DIR}/include)
    target_link_libraries(loader_test PRIVATE ${TENSION_RES_LIB})
    if(WIN32)
        target_link_libraries(loader_test PRIVATE ntdll)
    else()
        target_link_libraries(loader_test PRIVATE pthread)
    endif()

    foreach(test_target config_test scene_test loader_test)
        if(MSVC)
            target_compile_options(${test_target} PRIVATE /W3 /utf-8 /EHsc /bigobj /D_CRT_SECURE_NO_WARNINGS)
        else()
            target_compile_options(${test_target} PRIVATE -Wall -Wextra)
        endif()
        set_target_properties(${test_target} PROPERTIES
            RUNTIME_OUTPUT_DIRECTORY "${TENSION_OGRE_ROOT}/build/tests")
    endforeach()
endif()
