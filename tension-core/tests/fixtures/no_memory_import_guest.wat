;; A guest that imports the session's verbs but declares no memory at all.
;;
;; This is F2's first load-time check, and it is also the reason that check can
;; be one line: every session guest must import the arena the session owns —
;; there is no second, guest-provided memory (DESIGN.md §4) — so a guest that
;; speaks the session protocol without bringing an arena is refused before the
;; module is instantiated, with the fix named. The message is this check's
;; (specific: "imports `session::*` but declares no memory import"); the general
;; rule lives in `Session::create_from_module`, which refuses *any* guest here
;; that declares no memory import.
(module
  (import "session" "open" (func $open (param i32 i32) (result i32)))
  (func (export "_start_game")
    (drop (call $open (i32.const 0) (i32.const 0)))
  )
)
