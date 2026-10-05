@echo off
setlocal enabledelayedexpansion

rem -------------------------------------------------------------------------
rem Tension - Windows build (MSVC x64 + Ninja).
rem
rem   tension-res    Zig static archive       -> tension-res\zig-out
rem   tension-ogre   OGRE-Next DSO adapter    -> tension-ogre\build\libtension_ogre.dll
rem   tension-core   Rust host                -> tension-core\target\release\tension-core.exe
rem
rem Needs on PATH: cargo, zig (0.16.x), cmake, ninja, and an MSVC x64
rem environment - run this from an "x64 Native Tools Command Prompt", or let
rem this script find and call vcvars64.bat. OGRE-Next must already be installed
rem at third_party\ogre-next-install (third_party\README.md documents the
rem bootstrap).
rem
rem The host is built with the audio feature only. The default `ai` feature
rem adds a vendored llama.cpp C++ build that needs libclang for bindgen; set
rem AI=1 to opt in.
rem -------------------------------------------------------------------------

set "ROOT=%~dp0"
cd /d "%ROOT%"

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

if not defined VCINSTALLDIR (
    set "PF86=%ProgramFiles(x86)%"
    set "VSWHERE=!PF86!\Microsoft Visual Studio\Installer\vswhere.exe"
    if exist "!VSWHERE!" (
        for /f "usebackq tokens=*" %%i in (`"!VSWHERE!" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
        if defined VSDIR if exist "!VSDIR!\VC\Auxiliary\Build\vcvars64.bat" call "!VSDIR!\VC\Auxiliary\Build\vcvars64.bat"
    )
)
if not defined VCINSTALLDIR (
    echo [ERROR] no Visual Studio x64 environment.
    echo         Run this from an "x64 Native Tools Command Prompt for VS",
    echo         or install the "Desktop development with C++" workload.
    exit /b 1
)

rem WinGet installs zig without a shim on PATH; look where it keeps it before
rem declaring the toolchain missing.
where zig >nul 2>&1
if errorlevel 1 (
    for /d %%d in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\zig.zig_*") do (
        for /d %%e in ("%%d\zig-*") do (
            if exist "%%e\zig.exe" set "PATH=%%e;!PATH!"
        )
    )
)

rem tension-core/build.rs compiles the solver's Fortran core, its C shim, and
rem the adapter fixtures with gfortran/gcc/ar; MSYS2's UCRT64 toolchain has
rem them. Append it, do not prepend - it also ships cmake/ninja, and the ones
rem already on PATH are the ones this script should use.
where gfortran >nul 2>&1
if errorlevel 1 (
    for %%d in ("C:\msys64\ucrt64\bin" "C:\msys64\mingw64\bin") do (
        if exist "%%~d\gfortran.exe" set "PATH=!PATH!;%%~d"
    )
)

for %%t in (cargo zig cmake ninja gfortran gcc ar) do (
    where %%t >nul 2>&1 || (echo [ERROR] %%t is not on PATH. & exit /b 1)
)
if not exist "third_party\ogre-next-install\lib\OgreNextMain.lib" (
    echo [ERROR] OGRE-Next is not installed at third_party\ogre-next-install.
    echo         Build it first; third_party\README.md documents the bootstrap.
    exit /b 1
)

echo [1/3] tension-res
pushd tension-res
rem The MSVC host links this archive with link.exe, so it must be built for the
rem msvc ABI (tension-core/build.rs passes the same flag) - a default-ABI
rem build produces a MinGW archive link.exe rejects with LNK1143.
zig build -Doptimize=ReleaseSafe -Dtarget=x86_64-windows-msvc || (popd & exit /b 1)
popd

echo [2/3] tension-ogre
cmake -S tension-ogre -B tension-ogre\build-cmake -G Ninja -DCMAKE_BUILD_TYPE=Release || exit /b 1
cmake --build tension-ogre\build-cmake || exit /b 1

echo [3/3] tension-core
set "FEATURES=--no-default-features --features audio"
if defined AI set "FEATURES=--features ai"
pushd tension-core
cargo build --release %FEATURES% || (popd & exit /b 1)
popd

echo.
echo Build complete:
echo   tension-ogre\build\libtension_ogre.dll
echo   tension-core\target\release\tension-core.exe
endlocal
