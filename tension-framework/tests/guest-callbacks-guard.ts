// The callback guard, refusing half: a plain module that tries to register a
// handler carrying a non-zero environment word, and must be stopped by
// `makeCallbacks` with a named abort.
//
// The guard exists because the compiler now delivers a captured `this` to an
// arrow function through its environment word (`~env`), and it can only do that
// at an indirect call site **inside the guest**. The host has no such site: at
// `session_open` it resolves the record's table index and calls the entry
// itself, so a handler that expected a receiver would read whatever environment
// global last held — someone else's receiver rather than none at all. Refusing
// at registration is the safe answer, and this fixture is what makes the
// refusal observed rather than assumed.
//
// Why the value is built by hand here: producing one for real takes an arrow
// that captures `this`, and that needs the fork compiler (a capturing arrow is
// a compile error in the published AssemblyScript this suite builds with — see
// `docs/pipeline-notes.md` for how the fork is run). Hand-building the value
// tests the guard's own contract — *any* function value with a non-zero
// environment word is refused — and does it in the pipeline the suite actually
// runs. The assertion below shows the value names a real, resolvable table
// entry, so the only reason it is refused is the environment word.
//
// This fixture **aborts**, by design: its contract is a non-zero exit and the
// guard's message on stderr, which is what `tests/run.sh` checks. It never
// prints `OK`.

import { makeCallbacks, OnBatch } from "../assembly/runtime/callbacks";

/// A real handler, for its table index: the value below reuses it, so the index
/// it names is resolvable.
function onBatch(class_: u32, ptr: u32, count: u32): i32 {
  return 0;
}

export function _start_game(): void {
  // A function value's runtime record is `_index` then `_env`, at the pointer
  // size (`std/assembly/function.ts`). Take the index from a real handler and
  // give it a non-zero environment, which is exactly the shape a capturing
  // arrow has when the compiler materialises it per creation.
  const real = changetype<usize>(onBatch);
  const index = load<u32>(real);
  const size = sizeof<usize>();

  const fake = heap.alloc(2 * size);
  store<u32>(fake, index);
  store<usize>(fake, 1, size);

  // The value names the same table entry as the real handler, so nothing is
  // wrong with it except the environment word.
  assert(load<u32>(fake) == index, "the synthetic value lost its index");
  assert(load<usize>(fake, size) != 0, "the synthetic value lost its environment");

  // Must abort with the guard's message. Nothing after this line runs.
  makeCallbacks(changetype<OnBatch>(fake), null);

  // If this is reached, the guard let an environment-carrying handler through.
  assert(false, "the guard accepted a handler that carries an environment");
}
