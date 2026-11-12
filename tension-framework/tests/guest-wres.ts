// `tension::res`: the write sandbox and the read-back that makes it useful.
//
// A pak is immutable, so a write lands on the real filesystem under one root the
// host chose (`--write-root`). The rules that matter are refusals, and they are
// what the first half pins: a path that leaves the root is -EROFS rather than a
// normalized path, and a path that stays is a count.
//
// The second half is the round trip. Before `res_open`'s fallback a guest could
// write and never read what it wrote — `res_open` looked in the packed volumes
// only — so an editor could save a document and not load it back. Now the miss
// falls through to the write root, and this asserts it from **in here**: write,
// read, compare, and check that a miss is still -ENOENT.

import { Bytes } from "../assembly/bytes";
import {
  EROFS, resReadText, resSize, resStat, resWriteFile, resWriteText,
} from "../assembly/res";
import { print } from "../assembly/io";
import { ConfigBuilder, RuntimeSession } from "../assembly/runtime";

let failures: i32 = 0;

function check(ok: bool, what: string): void {
  if (!ok) {
    failures++;
    print("  FAIL: " + what);
  }
}

export function _start_game(): void {
  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    print("FAIL: the session did not open");
    return;
  }

  // Inside the root: a count, which is the length
  check(resWriteText("probe/hello.txt", "hello") == 5, "a relative path writes five bytes");
  check(resWriteText("empty.txt", "") == 0, "an empty file is a save, not a failure");

  // The three escapes. Each is a refusal rather than a rewrite.
  check(resWriteFile("../escape.txt", Bytes.ofString("x")) == EROFS, "'..' is -EROFS");
  check(resWriteFile("a/../../b.txt", Bytes.ofString("x")) == EROFS, "an inner '..' is -EROFS");
  check(resWriteFile("/etc/escape.txt", Bytes.ofString("x")) == EROFS, "an absolute path is -EROFS");
  check(resWriteFile("./dot.txt", Bytes.ofString("x")) == EROFS, "'.' is -EROFS");

  // ── read-after-write: the fallback ───────────────────────────────────────
  //
  // `res_open` tries the paks first and falls back to this root on a *miss*, so
  // the write above must be readable now, and the pair must round-trip exactly.
  const body: string = "{\"version\":1,\"nodes\":[1,2,3]}";
  check(resWriteText("saves/scene.json", body) == String.UTF8.byteLength(body),
        "a save writes the document's bytes");
  const back = resReadText("saves/scene.json");
  check(back != null, "the guest reads back what it just saved");
  check(back == body, "and the bytes are identical");
  check(resSize("saves/scene.json") == String.UTF8.byteLength(body),
        "stat reports the saved file's size");
  const st = resStat("saves/scene.json");
  check(st != null && !st!.isDir, "and stat calls it a file");

  // A path nobody wrote is still a miss: the fallback is "not in a pak", not
  // "invent something".
  check(resReadText("saves/nothing-here.json") == null, "a missing file is still null");
  check(resSize("saves/nothing-here.json") == -1, "and size says -1");

  // The sandbox still applies to the read side: a path that leaves the root is
  // refused rather than resolved against the parent of the root.
  check(resReadText("../outside.json") == null, "a read cannot leave the root either");

  RuntimeSession.close();
  if (failures != 0) {
    print("wres: " + failures.toString() + " check(s) failed");
    return;
  }
  print("wres: the write sandbox refuses every way out and counts what it takes");
  print("OK");
}
