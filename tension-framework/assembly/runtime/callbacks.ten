// Building the `Callbacks` record a guest registers at `session_open`.
//
// The two slots are function-*table* indices, not function references, and AS
// function values are not indices: a function reference points at the
// function's table-index word (that is the word AS's own `call_indirect` sites
// load through), so the index is the i32 the reference addresses. This is the
// one place in the runtime that knows that representation.
//
// `--exportTable` is what makes the indices resolvable at all: without it the
// module exports no `table`, and `session_open` refuses a record that names a
// slot. The generated asconfig sets it.

import { Callbacks, CALLBACKS_SIZE, CALLBACK_SLOTS } from "./wire";
import { ABI_VERSION } from "./layout";

/**
 * The table index of a function reference. See this file's header: the index is
 * the i32 the reference points at, which is how the solver bindings read their
 * callbacks too.
 *
 * A reference that carries an environment is refused here, because the host
 * cannot deliver it. A function value that captures `this` keeps the captured
 * receiver in its environment word -- the word after the index, at the target's
 * pointer size -- and the compiler hands that word to the callee at each of the
 * guest's own indirect call sites. The host has no such site: `session_open`
 * resolves the table entry and calls it directly, so the handler would read
 * whatever its environment global last held, i.e. someone else's receiver
 * rather than none at all. Refusing is the safe answer, and it is the answer
 * the day this framework wants bound handlers: a guest binds them itself, with
 * an explicit `this` parameter or a function that closes over what it needs.
 * The word is zero for every function value that does not capture, so an
 * ordinary handler is unaffected.
 */
function callbackIndex(fn: usize): u32 {
  assert(load<usize>(fn, sizeof<usize>()) == 0,
    "makeCallbacks: a handler that captures `this` cannot be called by the host");
  return <u32>load<i32>(fn);
}

/** What `onBatch` receives: the class, the first record's address, how many. */
export type OnBatch = (class_: u32, ptr: u32, count: u32) => i32;
/** What `onEvent` receives: the class and one record's address. */
export type OnEvent = (class_: u32, ptr: u32) => i32;

/**
 * Allocate a `Callbacks` record in the guest's heap and fill it in.
 *
 * A null handler leaves its slot 0, which the ABI defines as "absent" — the
 * session then skips that slot's invocations entirely (the records are still
 * published into the ring, and the guest reads them when it likes).
 *
 * The allocation is sized from the wire constant, which the manifest also
 * publishes: `manifestProblem()` compares this record's `sizeof` against the
 * host's entry at open, so the two cannot drift silently.
 */
export function makeCallbacks(onBatch: OnBatch | null = null, onEvent: OnEvent | null = null): Callbacks {
  const record = changetype<Callbacks>(heap.alloc(CALLBACKS_SIZE));
  record.abiVersion = <u16>ABI_VERSION;
  record.slotCount = CALLBACK_SLOTS;
  record.flags = 0;
  record.onBatch = onBatch != null ? callbackIndex(changetype<usize>(onBatch)) : 0;
  record.onEvent = onEvent != null ? callbackIndex(changetype<usize>(onEvent)) : 0;
  // The reserved words are the session's to check, not to guess: zero them, so
  // a record that came from an allocator that reused memory still looks like
  // the build that made it.
  record.reserved0 = 0;
  record.reserved1 = 0;
  record.reserved2 = 0;
  record.reserved3 = 0;
  record.reserved4 = 0;
  record.reserved5 = 0;
  return record;
}
