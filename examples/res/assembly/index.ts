// examples/res/assembly/index.ts — resource demo game.
//
// Compiled by `asc` to a wasm module that imports `tension::io` and
// `tension::res` from the host. Every path below is answered from the pak
// loaded with `tension-core --res game.tns`, never from the kernel filesystem.

import {
  print,
  resList,
  resReadText,
  resStat,
  ResFile,
  RES_SEEK_SET,
  RES_SEEK_END,
} from "tension-framework";

/// The generator in pack.sh writes data/large.bin as a deterministic keystream,
/// bit-exact with the one below. It is deliberately *not* compressible: that
/// File has to span more chunks than the runtime's per-open cache holds, and a
/// repeating pattern would collapse under the packer's compression threshold
/// (DESIGN.md §8.4) and silently end that coverage.
function patternByte(offset: i32): i32 {
  let x: u32 = (<u32>offset) * 747796405 + 2891336453;
  x ^= x >>> 15;
  x = x * 2246822519;
  x ^= x >>> 13;
  return <i32>(x & 0xFF);
}

function patternOk(buf: Uint8Array, base: i32): bool {
  for (let i = 0; i < buf.length; i++) {
    if (<i32>buf[i] != patternByte(base + i)) return false;
  }
  return true;
}

/// data/compressed.bin is zeros, so its check is the trivial one.
function zerosOk(buf: Uint8Array): bool {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] != 0) return false;
  }
  return true;
}

/// `stored` / `compressed` is the packer's per-File decision, and the guest can
/// see it through stat's flags bit 0 (`ResEntry.isCompressed`). The *method id*
/// (8 = Deflate) is a Stream Header fact, which the guest API does not carry.
function storedLabel(path: string): string {
  const st = resStat(path);
  return st != null && st.isCompressed ? "compressed" : "stored";
}

export function _start_game(): void {
  print("pak root: " + resList("/").join(" "));
  const intro = resReadText("text/intro.txt");
  if (intro !== null) print(intro);

  const f = ResFile.open("data/level1.bin");
  if (f !== null) {
    const head = new Uint8Array(16);
    const n = f.read(head);
    f.seek(-4, RES_SEEK_END);
    print("read " + n.toString() + " header bytes, size " + f.size().toString());
    f.close();
  }

  // data/large.bin is 20 MiB in a volume whose Buffers are 2048 bytes: about
  // 10600 chunks, well past the runtime's per-open chunk cache (DESIGN.md
  // §8.3, MAX_FILE_CHUNKS = 4096). It is also incompressible, so the packer
  // stores it (§8.4) and that chunking is real — this File is never cached, so
  // a full read would be O(N^2) in chain walks. These spot reads are the point
  // of the example: they land in different chunks, one of them straddles a
  // chunk boundary, and each is answered from the right bytes.
  const big = ResFile.open("data/large.bin");
  if (big !== null) {
    const size = big.size();
    print("large.bin: size " + size.toString() + " " + storedLabel("data/large.bin"));

    // Chunk 0: the File's own header tables plus the first slice of payload.
    const head = new Uint8Array(16);
    const n0 = big.read(head);
    print(
      "large.bin: first " +
        n0.toString() +
        " bytes pattern " +
        (patternOk(head, 0) ? "ok" : "MISMATCH"),
    );

    // A read inside chunk 1 (chunk 0 ends a little under 2048 in file offsets,
    // because the File's header tables are counted in its Buffer).
    big.seek(2047, RES_SEEK_SET);
    const quad = new Uint8Array(4);
    big.read(quad);
    print(
      "large.bin: bytes 2047..2050 = " +
        quad[0].toString() +
        " " +
        quad[1].toString() +
        " " +
        quad[2].toString() +
        " " +
        quad[3].toString() +
        " pattern " +
        (patternOk(quad, 2047) ? "ok" : "MISMATCH"),
    );

    // One read that spans a chunk boundary: chunk 0 carries its header tables
    // plus the rest of its Buffer's payload, so the first boundary falls in
    // this 512-byte window. A reader that mishandled the crossing (a gap, a
    // repeated run, a stale chunk) would show it here as a pattern mismatch.
    big.seek(1792, RES_SEEK_SET);
    const window = new Uint8Array(512);
    const nw = big.read(window);
    print(
      "large.bin: cross-boundary window 1792.." +
        (1792 + nw).toString() +
        " pattern " +
        (patternOk(window, 1792) ? "ok" : "MISMATCH"),
    );

    // Far into the File, and the last byte.
    const mid = new Uint8Array(16);
    const midAt = size / 2;
    big.seek(midAt, RES_SEEK_SET);
    big.read(mid);
    print(
      "large.bin: 16 bytes at " +
        midAt.toString() +
        " pattern " +
        (patternOk(mid, midAt) ? "ok" : "MISMATCH"),
    );

    big.seek(-1, RES_SEEK_END);
    const last = new Uint8Array(1);
    big.read(last);
    print(
      "large.bin: last byte " +
        last[0].toString() +
        " pattern " +
        (patternOk(last, size - 1) ? "ok" : "MISMATCH"),
    );
    big.close();
  }

  // data/compressed.bin is 2 MiB of zeros: Deflate takes it to a couple of
  // kilobytes, so the wrapped File fits the chunk cache and its reads are
  // cheap — the other end of the packer's per-File decision. The guest reads
  // expanded bytes, and the size it sees is the expanded size.
  const cmp = ResFile.open("data/compressed.bin");
  if (cmp !== null) {
    const csize = cmp.size();
    print(
      "compressed.bin: size " +
        csize.toString() +
        " " +
        storedLabel("data/compressed.bin"),
    );
    // Each read reports how many bytes came back: a decompressing reader that
    // silently returned nothing would otherwise pass a pattern check on a
    // zero-initialized buffer.
    const head = new Uint8Array(16);
    const cn0 = cmp.read(head);
    print(
      "compressed.bin: first " +
        cn0.toString() +
        " bytes pattern " +
        (cn0 == 16 && zerosOk(head) ? "ok" : "MISMATCH"),
    );

    const mid = new Uint8Array(16);
    const midAt = csize / 2;
    cmp.seek(midAt, RES_SEEK_SET);
    const cn1 = cmp.read(mid);
    print(
      "compressed.bin: 16 bytes at " +
        midAt.toString() +
        " read " +
        cn1.toString() +
        " pattern " +
        (cn1 == 16 && zerosOk(mid) ? "ok" : "MISMATCH"),
    );

    cmp.seek(-1, RES_SEEK_END);
    const last = new Uint8Array(1);
    const cn2 = cmp.read(last);
    print(
      "compressed.bin: last byte " +
        last[0].toString() +
        " read " +
        cn2.toString() +
        " pattern " +
        (cn2 == 1 && zerosOk(last) ? "ok" : "MISMATCH"),
    );
    cmp.close();
  }
}
