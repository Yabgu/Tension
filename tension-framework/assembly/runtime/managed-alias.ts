// The `@managed` + `@abi.alias` fixture, and why it lives outside `wire.ts`.
//
// TensionScript 0.9.0 ships `@managed struct`: GC-owned, C-layout, heap, the
// reference *is* the fields pointer, final. `@abi.alias` names a field for the
// other side of an ABI without moving a byte, and `abiNameOf<T>("field")` reads
// that name — or the field's TypeScript name when it has none.
//
// PR 8 (the `@managed struct` implementation) could not include this fixture:
// 0.8.1 parsed `@abi.alias` on an `@managed` struct but silently ignored it, so
// the only assertion it could have held was the wrong one. 0.9.0 honors the
// alias (measured: `aliases: c_x c_y fallback=x sizeof=16`), and this module is
// the fixture that keeps it measured.
//
// **Why not in `wire.ts`?** Every record there is a frozen host declaration:
// a `changetype<T>(offset)` view whose size and field order the host writes.
// `ManagedAliased` has no host declaration to compare against — no arena
// offset, no manifest entry, no Rust struct. What it verifies is a property of
// the *compiler* (the alias is recorded in type position on a managed struct,
// and `sizeof` reports the C layout), so it sits beside the assertion rather
// than among the wire's records.
//
// Compile-time: `abiNameOf` and `sizeof` fold to constants, so the assertions
// cost nothing at runtime — but they only mean anything in a build that emits
// them, which is why `assertAbiAliases` calls this from `guest-open.ts`'s
// first instructions rather than a module-level statement.

/**
 * A managed struct whose fields carry ABI names.
 *
 * The layout is the C layout reading A fixes: `x` (u32) at 0, `y` (u64) at 8,
 * the trailing padding making 16 bytes — the same shape the 0.9.0 probe
 * measured on the real compiler.
 */
@managed
export struct ManagedAliased {
  x: u32 @abi.alias("c_x");
  y: u64 @abi.alias("c_y");
}

/** A managed struct with no aliases, for the fallback half of the check. */
@managed
struct ManagedPlain {
  x: u32 = 0;
}

/**
 * Assert the alias set on a managed struct.
 *
 * Two-way by construction: an alias is either recorded or it is not, so there
 * is no partial cell to write. Removing one alias makes the assertion abort
 * with that field's name and the alias it expected; that abort is the
 * load-bearing evidence (the same shape as the two `class_` assertions next
 * door, and the reason the diagnostic names both).
 */
export function assertManagedAliases(): void {
  if (abiNameOf<ManagedAliased>("x") != "c_x") {
    assert(false, "ManagedAliased.x does not carry its ABI alias: c_x");
  }
  if (abiNameOf<ManagedAliased>("y") != "c_y") {
    assert(false, "ManagedAliased.y does not carry its ABI alias: c_y");
  }
  // A field with no alias reports its TypeScript name. This is the managed
  // struct's version of the `EventRecord.seq` fallback check: if `abiNameOf`
  // starts returning the alias shape on a managed type, this is where it
  // shows.
  if (abiNameOf<ManagedPlain>("x") != "x") {
    assert(false, "ManagedPlain.x has no alias and must report its TS name");
  }
  // The C layout, not just the names: `u32` at 0 and `u64` at 8 with the
  // struct's alignment is 16 bytes. 0.8.x reported the `usize` base here for
  // records; 0.9.0's `sizeof` is the C-compatible size, and the 0.9.0 probe
  // measured 16.
  if (sizeof<ManagedAliased>() != 16) {
    assert(false, "ManagedAliased is not 16 bytes: u32 at 0, u64 at 8");
  }
}
