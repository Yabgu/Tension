// examples/game.ts — first TensionCore demo.
//
// Compiled by `asc` (AssemblyScript) to a wasm module that imports the
// tension::io ABI from the host. The game never touches the terminal; it
// *requests* I/O from tension-core. That is the interpreter contract.

import { print, readLine, argCount, arg } from "tension-framework";

export function _start_game(): void {
  print("=== TensionCore demo game ===");
  print("Arguments passed to the game:");

  let n = argCount();
  print("  count = " + n.toString());

  for (let i = 0; i < n; i++) {
    print("  arg[" + i.toString() + "] = \"" + arg(i) + "\"");
  }

  print("");
  print("Say something and press enter:");
  let line = readLine();
  if (line !== null) print("You said: " + line);
  else print("(input closed)");
  print("--- end ---");
}
