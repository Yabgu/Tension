#!/usr/bin/env bash
# Backwards-compatible entry point. **The build is `npm run build`.**
#
# This file used to hold the whole recipe — the toolchain preflight, the cargo
# build, the wire-record codegen, the guest API and the example loop. Those are
# npm scripts now (`build:native`, `build:codegen`, `build:framework`,
# `build:examples`), so there is one entry point whatever you are building, and
# so the native packages under `packages/` are produced by the same command that
# fills them.
#
# Kept because `ci/docker.sh dev ./build.sh` and the CI docs name it. Arguments
# are passed through: `./build.sh` and `npm run build` are the same thing.
#
# Nothing here runs a game — that is demo.sh.
set -euo pipefail
cd "$(dirname "$0")"

exec npm run build "$@"
