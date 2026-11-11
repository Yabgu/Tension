// `tension::res.mount`: the guest-facing side of the host's one mount table.
//
// The point of the verb is that a mounted volume becomes visible to **every**
// reader at once, so this fixture mounts once and then reads the same bytes two
// ways: through `resReadFile` at the prefixed path, and through `resStat`. It also
// pins the refusals, because a mount that can be made twice or under a nonsense
// name is a namespace that cannot be reasoned about.
//
// The volume is the runner's: it packs a scratch directory with one known file
// and passes its path as `--mount=<path>`. The positive half — that the bytes
// really are the ones packed — needs a volume, and a guest cannot make one.

import { arg, argCount, print } from "../assembly/io";
import { EEXIST, resMount, resReadText, resStat } from "../assembly/res";
import { ConfigBuilder, RuntimeSession } from "../assembly/runtime";

let failures: i32 = 0;

function check(ok: bool, what: string): void {
  if (!ok) {
    failures++;
    print("  FAIL: " + what);
  }
}

/// The `--mount=<path>` argument the runner passes.
function mountArg(): string {
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--mount=")) return value.slice(8);
  }
  return "";
}

export function _start_game(): void {
  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    print("FAIL: the session did not open");
    return;
  }

  const volume = mountArg();
  check(volume.length > 0, "the runner passed --mount=<volume>");
  if (volume.length == 0) {
    RuntimeSession.close();
    return;
  }

  // Nothing is mounted yet, so a prefixed read misses. This is the assertion
  // that makes the one after it mean something.
  check(resReadText("fixtures/hello.txt") == null, "the volume is not visible before the mount");

  const mounted = resMount("fixtures", volume);
  check(mounted >= 0, "resMount answers a mount index (got " + mounted.toString() + ")");

  // Through the prefixed path, which is the whole contract: the guest's own
  // reader sees the volume the adapter would too.
  const text = resReadText("fixtures/hello.txt");
  check(text != null, "resReadText resolves inside the mount");
  if (text != null) check(text! == "hello from a mounted volume", "and the bytes are the packed ones");

  const stat = resStat("fixtures/hello.txt");
  check(stat != null, "resStat resolves inside the mount too");

  // The prefix is a name, not a path: `fixtures-old/x` must not resolve into
  // the mount under `fixtures`.
  check(resReadText("fixtures-old/hello.txt") == null, "a longer prefix is a different name");

  // Refusals.
  check(resMount("fixtures", volume) == EEXIST, "a duplicate prefix is -EEXIST");
  check(resMount("", volume) < 0, "an empty prefix is refused");
  check(resMount("/leading", volume) < 0, "a leading slash is refused");
  check(resMount("trailing/", volume) < 0, "a trailing slash is refused");
  check(resMount("missing", "/nonexistent/volume.tns") < 0, "a missing file is refused");

  RuntimeSession.close();
  if (failures != 0) {
    print("resmount: " + failures.toString() + " check(s) failed");
    return;
  }
  print("resmount: one mount serves every reader, and the prefix rules hold");
  print("OK");
}
