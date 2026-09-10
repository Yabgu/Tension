// Guest-side bindings for the Tension host ABI (`tension::io`).
//
// The guest imports these functions from the host under the wasm module
// name `tension::io`; tension-core implements them. The compiled game never
// touches the terminal directly. Strings cross the boundary as UTF-8 bytes:
//
//   print(ptr, len)          write exactly `len` UTF-8 bytes at `ptr` to
//                            stdout (no newline appended — the SDK owns the
//                            line terminator)
//   read_line(ptr, cap)      read one line (terminator stripped):
//                            cap <= 0 probes the next line's byte length
//                            without consuming it; cap > 0 consumes the
//                            line, writes min(cap, len) bytes, returns len.
//                            -1 on EOF, 0 for an empty line.
//   arg_count() -> i32       number of extra CLI args passed to the game
//   arg(i, ptr, cap) -> i32  write arg i as UTF-8; returns byte count (-1
//                            OOB); cap == 0 probes the size without writing
//
// Because the wrappers below probe the exact size before consuming, the
// guest never requests a partial line, so UTF-8 codepoint-boundary
// truncation cannot occur in the decode path — a consequence of the
// read_line contract, not a separate fix.

@external("tension::io", "print")
declare function hostPrint(ptr: usize, len: i32): void;

@external("tension::io", "read_line")
declare function hostReadLine(ptr: usize, cap: i32): i32;

@external("tension::io", "arg_count")
declare function hostArgCount(): i32;

@external("tension::io", "arg")
declare function hostArg(i: i32, ptr: usize, cap: i32): i32;

/** Write text to stdout with no trailing newline. */
export function write(text: string): void {
  const bytes = String.UTF8.encode(text);
  hostPrint(changetype<usize>(bytes), bytes.byteLength);
}

/** Write a line to stdout (appends a newline). */
export function print(text: string): void {
  write(text);
  write("\n");
}

/** Read one line from stdin (trailing newline stripped). Returns null at
 *  EOF and "" for an empty line. */
export function readLine(): string | null {
  const need = hostReadLine(0, 0); // probe: non-consuming size query
  if (need < 0) return null; // EOF
  if (need == 0) return ""; // empty line
  const buf = new ArrayBuffer(need);
  const n = hostReadLine(changetype<usize>(buf), need);
  return n < 0 ? null : String.UTF8.decodeUnsafe(changetype<usize>(buf), n);
}

/** Number of extra CLI arguments passed to the game. */
export function argCount(): i32 {
  return hostArgCount();
}

/** The i-th extra CLI argument, or "" when out of range. */
export function arg(i: i32): string {
  const need = hostArg(i, 0, 0); // probe size with cap == 0
  if (need < 0) return "";
  const buf = new ArrayBuffer(need == 0 ? 1 : need);
  const n = hostArg(i, changetype<usize>(buf), need);
  if (n < 0) return "";
  return String.UTF8.decodeUnsafe(changetype<usize>(buf), n);
}
