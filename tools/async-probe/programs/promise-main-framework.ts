// An `async main` that never awaits, importing the framework's index.
//
// `tension-framework`'s index re-exports `./2d`, which includes `scene.ts`, and
// `scene.ts` contains an `await`. The compiler latches `hasAwait` from any
// Await node in the program's sources — reachability is not consulted — so this
// build takes the "has an await" branch even though this file has none.
import { print } from "tension-framework";

export async function main(): i32 {
  print("framework index: main ran\n");
  return 1;
}
