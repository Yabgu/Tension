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

set(OGRE_MEDIA_DIR "${OGRE_NEXT_PREFIX}/Media")
set(OGRE_PLUGIN_DIR "${OGRE_NEXT_PREFIX}/bin")
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
