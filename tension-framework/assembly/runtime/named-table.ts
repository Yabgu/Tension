// A bounded, name-keyed table: a linear scan over names, no hashing.
//
// ## Why this exists, and why it is not a workaround
//
// `Map<string, V>` cannot be a GC type yet: `MapEntry<K,V>` is `@unmanaged` and stores
// `K`/`V` in a packed linear block addressed by `changetype<usize>` (11 arithmetic sites in
// `map.ts` alone), so a reference key or value has no representation in it. A program that
// uses one therefore stays on the pointer ABI, and one such `Map` in a program holds the
// whole program there — which, in the 2D guest, was the last thing standing between 141
// classes and a GC-uniform build.
//
// The two registries in this framework are **bounded name→object tables**, and at those sizes
// a linear scan is the right data structure on its own merits, not a substitute for a better
// one:
//
// - `Tileset.named` — one entry per *named* frame, i.e. per atlas region an app refers to by
//   name. The 2D guest registers 0–4; the editor's atlas registers 24. Both are written from
//   an atlas manifest, so the count is bounded by the asset.
// - `Logger.registry` — one entry per logger name, i.e. per module that logs. The guest
//   creates 3; the editor 9. A logger name is a source-code literal, so the count is bounded
//   by the source.
//
// At tens of entries `Map`'s hash-plus-bucket-chase costs *more* than comparing against a
// linear array of strings — the hash walks every byte of the key, and the table fits in a
// handful of cache lines. So this is a data-structure choice with a measurement behind it,
// and the measurement is the entry count, not a benchmark of a path that never executes.
//
// ## What it does not do
//
// No deletion, because neither caller deletes: an atlas's named frames and a module's loggers
// are registered once and live for the process. Adding `delete` would need a tombstone or a
// compaction policy, and inventing one for callers that do not need it is how a "small
// helper" grows into a worse `Map`.
export class NamedTable<T> {
  /** Names in insertion order, parallel to {@link values}. */
  private names: Array<string> = new Array<string>(0);
  /** Values in insertion order, parallel to {@link names}. */
  private values: Array<T> = new Array<T>(0);

  /** The number of registered names. */
  get size(): i32 {
    return this.names.length;
  }

  /** The position of `name`, or `-1`. */
  private indexOf(name: string): i32 {
    const names = this.names;
    for (let i = 0, n = names.length; i < n; ++i) {
      // `==` on two strings is the compiler's compare (GC11 replaced it under `--wasmGc`),
      // so this is a byte-wise compare either way and not a pointer identity test.
      if (unchecked(names[i]) == name) return i;
    }
    return -1;
  }

  /** Whether `name` is registered. */
  has(name: string): bool {
    return this.indexOf(name) >= 0;
  }

  /**
   * Registers `name`, or replaces the value already under it.
   *
   * Replacing rather than appending matters for `Tileset`: a manifest that defines the same
   * frame twice should leave the last one visible, which is what `Map#set` did.
   */
  set(name: string, value: T): void {
    const at = this.indexOf(name);
    if (at >= 0) {
      // Indexed assignment, not `unchecked(...) = value`: `unchecked` yields a value, not an
      // assignable location, and `TS2540` is what that looks like (measured).
      this.values[at] = value;
      return;
    }
    this.names.push(name);
    this.values.push(value);
  }

  /**
   * The value under `name`.
   *
   * **Aborts when absent**, matching `Map#get` in this tree: a `get` for a missing key is a
   * caller bug, and the abort is how it surfaces. A caller that expects absence asks `has`
   * first — both call sites do.
   */
  get(name: string): T {
    const at = this.indexOf(name);
    assert(at >= 0, "NamedTable#get: no entry for the name");
    return unchecked(this.values[at]);
  }

  /** The name at `index`, for iteration in insertion order. */
  nameAt(index: i32): string {
    return unchecked(this.names[index]);
  }

  /** The value at `index`, for iteration in insertion order. */
  valueAt(index: i32): T {
    return unchecked(this.values[index]);
  }
}
