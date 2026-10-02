#!/usr/bin/env bash
# Tension container tooling: build the dev/CI image and run it.
#
# Commands:
#   ci/docker.sh build          build the image (OGRE-Next packages in ci/ogre-next-pkg)
#   ci/docker.sh test [args]    run ./test.sh inside a fresh container (args forwarded)
#   ci/docker.sh dev [cmd...]   development shell / command; repo bind-mounted at /app
#   ci/docker.sh clean          remove the image
#
# Environment:
#   TENSION_IMAGE                 image name (default: tension-dev)
#   TENSION_CONTAINER_RUNTIME     podman (default) or docker
#   TENSION_OGRE_PKG_DIR          dir with built ogre-next-git-*.pkg.tar.zst packages
#                                 (default: $HOME/src/ogre-next-git, an AUR build dir)
#   TENSION_FREEIMAGE_PKG_DIR     same for freeimage (default: $HOME/src/freeimage)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
image="${TENSION_IMAGE:-tension-dev}"
pkg_dir="$here/ogre-next-pkg"
runtime="${TENSION_CONTAINER_RUNTIME:-podman}"

die() { echo "error: $*" >&2; exit 1; }

usage() {
    cat <<EOF
usage: ci/docker.sh <command> [args...]

commands:
  build             build the $image image from $here
  test [args...]    run ./test.sh inside the container (args forwarded)
  dev [cmd...]      run a command (default: bash) in the container with the
                    repository bind-mounted at /app and X available
  clean             remove the $image image
EOF
}

# Make sure the OGRE-Next / freeimage packages are in ci/ogre-next-pkg.
# Prefer what is already there; otherwise copy the latest non-debug package
# from the AUR build directory ($envvar, defaulting to $default_src).
sync_pkg() {
    local name="$1" pattern="$2" envvar="$3" default_src="$4"
    if ls "$pkg_dir"/$pattern >/dev/null 2>&1; then
        echo "  $name: found in $pkg_dir"
        return
    fi
    local src="${!envvar:-$default_src}" latest
    [ -d "$src" ] || die \
        "$name package missing. Put a $pattern package in $pkg_dir, or set $envvar to a directory containing one (e.g. an AUR build dir)."
    latest="$(ls -t "$src"/$pattern 2>/dev/null | head -n1 || true)"
    [ -n "$latest" ] || die "no $name package in $src"
    mkdir -p "$pkg_dir"
    cp "$latest" "$pkg_dir/"
    echo "  $name: copied $latest"
}

# Interactive flags: only ask for a TTY when stdin is one.
tty_flags=(-i)
[ -t 0 ] && tty_flags=(-it)

cmd_build() {
    echo "==> preparing OGRE-Next packages in $pkg_dir"
    sync_pkg "ogre-next" "ogre-next-git-r*.pkg.tar.zst" \
        TENSION_OGRE_PKG_DIR "$HOME/src/ogre-next-git"
    sync_pkg "freeimage" "freeimage-3*.pkg.tar.zst" \
        TENSION_FREEIMAGE_PKG_DIR "$HOME/src/freeimage"
    echo "==> building $image (context: $here)"
    "$runtime" build -t "$image" "$here"
    echo "==> done. Next: ci/docker.sh test   or   ci/docker.sh dev"
}

cmd_test() {
    # Run as root: under rootless podman, container root maps to the host
    # user, so build artifacts in the mounted repo stay host-owned.
    exec "$runtime" run --rm "${tty_flags[@]}" \
        -v "$repo":/app -w /app \
        "$image" ./test.sh "$@"
}

cmd_dev() {
    # Run as the image's dev user with keep-id so that files written into the
    # mounted repo are owned by the host user (needed for a usable dev loop).
    local uid_args=(-u "$(id -u):$(id -g)" -e HOME=/home/dev)
    [ "$runtime" = "podman" ] && uid_args=(--userns=keep-id "${uid_args[@]}")
    exec "$runtime" run --rm "${tty_flags[@]}" "${uid_args[@]}" \
        -v "$repo":/app -w /app \
        "$image" "${@:-bash}"
}

cmd_clean() {
    "$runtime" rmi -f "$image" || true
    echo "removed image: $image"
}

case "${1:-}" in
    build) shift; cmd_build "$@" ;;
    test)  shift; cmd_test "$@" ;;
    dev)   shift; cmd_dev "$@" ;;
    clean) shift; cmd_clean "$@" ;;
    -h|--help|help|"") usage ;;
    *) die "unknown command: ${1:-}. Run 'ci/docker.sh help'." ;;
esac
