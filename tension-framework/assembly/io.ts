// Guest-side bindings for the Tension host ABI (`tension::io`).
//
// The host (tension-core) exports these functions as WASM imports under the
// module name `tension::io`. The compiled game imports them and never touches
// the terminal directly. Strings cross the boundary as UTF-8 bytes:
//
//   print(ptr, len)         write `len` UTF-8 bytes at `ptr` to stdout
//   read_line(ptr, cap)     read a line into the buffer; returns byte count,
//                           or -1 on EOF
//   arg_count() -> i32      number of extra CLI args passed to the game
//   arg(i, ptr, cap) -> i32 write arg i as UTF-8; returns byte count (-1 OOB),
//                           cap == 0 probes the size without writing
//
// The wrappers below translate UTF-8 <-> AssemblyScript `string`.

@external("tension::io", "print")
declare function hostPrint(ptr: usize, len: i32): void;

@external("tension::io", "read_line")
declare function hostReadLine(ptr: usize, cap: i32): i32;

@external("tension::io", "arg_count")
declare function hostArgCount(): i32;

@external("tension::io", "arg")
declare function hostArg(i: i32, ptr: usize, cap: i32): i32;

const NEWLINE: string = "\n";

/** Write a line to stdout (appends a newline). */
export function print(text: string): void {
  let bytes = String.UTF8.encode(text);
  hostPrint(changetype<usize>(bytes), bytes.byteLength);
  let nl = String.UTF8.encode(NEWLINE);
  hostPrint(changetype<usize>(nl), 1);
}

/** Read one line from stdin (trailing newline stripped). Returns "" on EOF. */
export function readLine(): string {
  const cap = 1024;
  let buf = new ArrayBuffer(cap);
  let n = hostReadLine(changetype<usize>(buf), cap);
  if (n < 0) return "";
  return String.UTF8.decodeUnsafe(changetype<usize>(buf), n);
}

/** Number of extra CLI arguments passed to the game. */
export function argCount(): i32 {
  return hostArgCount();
}

/** The i-th extra CLI argument, or "" when out of range. */
export function arg(i: i32): string {
  let need = hostArg(i, 0, 0); // probe size with cap == 0
  if (need < 0) return "";
  let buf = new ArrayBuffer(need == 0 ? 1 : need);
  let n = hostArg(i, changetype<usize>(buf), need);
  if (n < 0) return "";
  return String.UTF8.decodeUnsafe(changetype<usize>(buf), n);
}
