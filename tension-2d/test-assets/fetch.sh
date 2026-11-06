#!/usr/bin/env bash
# fetch.sh — copy the 2D test assets from the asset host into this directory.
#
# The assets are LimeZu's *Modern exteriors* and *Modern interiors* packs. They
# are somebody else's licensed work, so they are **not in this repository**:
# `tension-2d/test-assets/` is gitignored, and this script is the only thing
# under it that is committed. Anyone with SSH access to the host can re-create
# the tree; anyone without it cannot run the isometric example, which is the
# correct trade for not vendoring 60 MB of third-party art.
#
#   ./fetch.sh                 # everything the example needs
#   ./fetch.sh --tileset       # just the exteriors tileset
#   ./fetch.sh --characters    # just the character layers
#
# Uses rsync when both ends have it and falls back to `tar` over ssh otherwise
# (the development host has no rsync, which is why the fallback exists rather
# than being theoretical). Set ASSET_HOST to point at a different machine:
#
#   ASSET_HOST=user@host ./fetch.sh
#
# SPDX-License-Identifier: MIT
set -euo pipefail

HOST="${ASSET_HOST:-root@192.168.2.122}"
ROOT="/mnt/sda1/assets/itch.io/LimeZu"

EXTERIORS="${ROOT}/Modern exteriors - RPG Tileset [16X16]/modernexteriors-win/Modern_Exteriors_16x16"
CHARACTERS="${ROOT}/Modern interiors - RPG Tileset [16X16]/moderninteriors-win/2_Characters/Character_Generator"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
want_tileset=1
want_characters=1

for arg in "$@"; do
  case "${arg}" in
    --tileset)    want_characters=0 ;;
    --characters) want_tileset=0 ;;
    -h|--help)    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "fetch: unknown argument '${arg}'" >&2; exit 2 ;;
  esac
done

# copy <remote-dir> <local-dir> — rsync if both ends have it, else tar.
copy() {
  local remote="$1" local_dir="$2"
  mkdir -p "${local_dir}"
  if command -v rsync >/dev/null 2>&1 && ssh -o BatchMode=yes "${HOST}" 'command -v rsync >/dev/null'; then
    echo "fetch: rsync ${remote}/"
    rsync -a --info=progress2 "${HOST}:${remote}/" "${local_dir}/"
  else
    echo "fetch: tar over ssh ${remote}/"
    ssh -o BatchMode=yes "${HOST}" "cd \"${remote}\" && tar cf - ." | tar xf - -C "${local_dir}"
  fi
}

echo "fetch: host ${HOST}"

if [ "${want_tileset}" = 1 ]; then
  copy "${EXTERIORS}" "${here}/modernexteriors"
fi

if [ "${want_characters}" = 1 ]; then
  # The three modular layers the composite test uses. `Accessories` holds the
  # backpack; `Bodies`, `Hairstyles` and `Outfits` are the other two plus the
  # outfit set the scene does not use but a reader will want to see.
  for layer in Bodies Hairstyles Outfits Accessories; do
    copy "${CHARACTERS}/${layer}/16x16" "${here}/characters/${layer}"
  done
fi

echo "fetch: done — $(du -sh "${here}" | cut -f1) in ${here}"
