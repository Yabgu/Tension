// The entry surface: the host calls the module's boot export, the shell resumes
// the root continuation, and `main` is where a person puts the first breakpoint
// of a session. `_start_game` is the engine's entry and stays what it is —
// this measures it, and changes nothing.
import { print } from "../../../../tension-framework";

export async function main(): i32 {
  print("main body"); // @stop
  return 0;
}

export function _start_game(): void {}
