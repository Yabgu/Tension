// `tension::res.res_write`: the sandbox, from the guest's side.
//
// A pak is immutable, so a write lands on the real filesystem under one root the
// host chose (`--write-root`). The rules that matter are refusals, and they are
// what this fixture pins: a path that leaves the root is -EROFS rather than a
// normalized path, and a path that stays is a count.
//
// The positive half — that the bytes really arrive at the file — cannot be
// asserted from in here (the guest cannot read the real filesystem), so the
// runner does it: it passes a scratch `--write-root` and reads the file back
// afterwards.

import { Bytes } from "../assembly/bytes";
import { EROFS, resWriteFile, resWriteText } from "../assembly/res";
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

  RuntimeSession.close();
  if (failures != 0) {
    print("wres: " + failures.toString() + " check(s) failed");
    return;
  }
  print("wres: the write sandbox refuses every way out and counts what it takes");
  print("OK");
}
