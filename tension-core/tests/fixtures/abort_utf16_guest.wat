;; The host's `env.abort` diagnostic, exercised through its UTF-16 decode.
;;
;; AssemblyScript's `stub` runtime traps through `env.abort(msg, file, line,
;; col)`, and both strings are AssemblyScript `String`s in guest memory: a
;; 4-byte little-endian byte length at `ptr - 4`, then UTF-16LE code units.
;; This module is shaped exactly that way without the toolchain — the data
;; segments below *are* the strings — and `_start_game` aborts with them.
;;
;; The strings are chosen for the decode's two hard cases:
;;   msg  "abort probe: emoji 😀 and ünïcode"   a surrogate pair (D83D DE00)
;;        beside BMP non-ASCII (U+00FC ü, U+00EF ï)
;;   file "probe<U+D800>.ts"                     a *lone* surrogate
;; A decode that walks the units one at a time through `char::from_u32` turns
;; the pair into two U+FFFD; the correct decode is one emoji, and a lone
;; surrogate is exactly one U+FFFD. See `tests/abort_utf16.rs`.
(module
  (import "env" "abort" (func $abort (param i32 i32 i32 i32)))
  (memory (export "memory") 1)
  ;; "abort probe: emoji 😀 and ünïcode" — 33 units, 66 bytes.
  (data (i32.const 1024) "\42\00\00\00"
        "\61\00\62\00\6f\00\72\00\74\00\20\00\70\00\72\00\6f\00\62\00\65\00\3a\00\20\00\65\00\6d\00\6f\00\6a\00\69\00\20\00\3d\d8\00\de\20\00\61\00\6e\00\64\00\20\00\fc\00\6e\00\ef\00\63\00\6f\00\64\00\65\00")
  ;; "probe<U+D800>.ts" — 9 units, 18 bytes.
  (data (i32.const 1200) "\12\00\00\00"
        "\70\00\72\00\6f\00\62\00\65\00\00\d8\2e\00\74\00\73\00")
  ;; msg at 1028, file at 1204, line 7, col 1 — as the runtime would pass them.
  (func (export "_start_game")
    (call $abort (i32.const 1028) (i32.const 1204) (i32.const 7) (i32.const 1))
  )
)
