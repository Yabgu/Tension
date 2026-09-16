#!/usr/bin/env bash
# End-to-end verification of the resource stack.
#
#   1. pack assets/ + the generated large asset -> game.tns
#   2. re-read game.tns with the independent ECMA-208 reader
#   3. pack again and compare the two volumes byte for byte
#   4. run the game through tension-core and check its stdout
#
# Exit 0 only when every step passes.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
packer="${TENSION_PACK:-$here/../../tension-res/zig-out/bin/tension-pack}"
core="${TENSION_CORE:-$here/../../tension-core/target/debug/tension-core}"
cd "$here"

step() { printf '\n== %s ==\n' "$1"; }

step "1. pack assets/ + the generated large asset -> game.tns"
# pack.sh regenerates build/large.bin (20 MiB, pattern 0..63) and packs a temp
# tree that combines it with the committed assets/; it reports the size so the
# checks below do not have to repeat the constant.
./pack.sh | tee /tmp/tension-pack.log
large_bytes="$(sed -n 's/^large\.bin: \([0-9]*\) bytes generated.*/\1/p' /tmp/tension-pack.log)"
compressed_bytes="$(sed -n 's/^compressed\.bin: \([0-9]*\) bytes generated.*/\1/p' /tmp/tension-pack.log)"
[ -n "$large_bytes" ] || { echo "pack.sh did not report the generated size" >&2; exit 1; }
[ -n "$compressed_bytes" ] || { echo "pack.sh did not report the compressible size" >&2; exit 1; }

step "2. independent reader on game.tns"
python3 verify/verify.py game.tns text/intro.txt --raw > /tmp/tension-intro.txt
cmp /tmp/tension-intro.txt assets/text/intro.txt
echo "--- first three lines of text/intro.txt as the independent reader reads it ---"
head -3 /tmp/tension-intro.txt

# data/level1.bin is 4096 bytes in a 2048-byte Buffer, so its payload spans
# Buffers (13.12, 13.13). The independent reader walks the continuation chain
# and accumulates the File's bytes; they must match the source exactly.
python3 verify/verify.py game.tns data/level1.bin --raw > /tmp/tension-level1.bin
cmp /tmp/tension-level1.bin assets/data/level1.bin
echo "chunked data/level1.bin (4096 B) read through its continuation chain: byte-identical"

# data/large.bin is the generated 20 MiB File: ~10600 chunks in this volume, so
# the runtime reads it uncached (DESIGN.md §8.3). The independent reader walks
# the whole chain and its bytes must match the generated source exactly.
python3 verify/verify.py game.tns data/large.bin --raw > /tmp/tension-large.bin
cmp /tmp/tension-large.bin build/large.bin
echo "chunked data/large.bin (${large_bytes} B, stored) read through its continuation chain: byte-identical"

# data/compressed.bin is stored as a Deflate stream (STREAM FORMAT 2,
# COMPRESS TYPE 8): the reader decodes it with Python's zlib and its expanded
# bytes must match the generated source. The method id and the expanded size
# come from the Stream Header, not from any convention of ours.
python3 verify/verify.py game.tns data/compressed.bin --raw > /tmp/tension-compressed.bin
cmp /tmp/tension-compressed.bin build/compressed.bin
echo "compressed data/compressed.bin (${compressed_bytes} B expanded by the independent reader): byte-identical"

step "3. reproducibility: pack again and compare"
./pack.sh game2.tns >/dev/null
cmp game.tns game2.tns && echo "game.tns and game2.tns are byte-identical"
rm -f game2.tns

step "4. run the game through tension-core"
if [ ! -f build/game.wasm ]; then
  echo "build/game.wasm is missing; run \`npm run build\` first" >&2
  exit 1
fi
"$core" --res game.tns build/game.wasm | tee /tmp/tension-game-out.txt
grep -q "pak root: data/ text/ textures/" /tmp/tension-game-out.txt
grep -q "TensionCore resource demo" /tmp/tension-game-out.txt
grep -q "read 16 header bytes, size 4096" /tmp/tension-game-out.txt

# The demo's large-File readback: the size it reports is the size pack.sh
# generated, the chunk-crossing read returns the generator's bytes at absolute
# offsets, and no read reported a pattern mismatch.
grep -q "large.bin: size $large_bytes stored" /tmp/tension-game-out.txt
grep -qE "large.bin: bytes 2047\.\.2050 = [0-9]+ [0-9]+ [0-9]+ [0-9]+ pattern ok" /tmp/tension-game-out.txt
grep -q "large.bin: cross-boundary window 1792..2304 pattern ok" /tmp/tension-game-out.txt
grep -q "large.bin: 16 bytes at $((large_bytes / 2)) pattern ok" /tmp/tension-game-out.txt
grep -qE "large.bin: last byte [0-9]+ pattern ok" /tmp/tension-game-out.txt
grep -q "compressed.bin: size $compressed_bytes compressed" /tmp/tension-game-out.txt
grep -q "compressed.bin: first 16 bytes pattern ok" /tmp/tension-game-out.txt
grep -q "compressed.bin: 16 bytes at $((compressed_bytes / 2)) read 16 pattern ok" /tmp/tension-game-out.txt
grep -qE "compressed.bin: last byte [0-9]+ read 1 pattern ok" /tmp/tension-game-out.txt
! grep -q "MISMATCH" /tmp/tension-game-out.txt

echo
echo "verify.sh: all checks passed"
