;; A session guest whose declared memory is far too small for the arena its
;; ceiling implies: 4 pages initial, 8 pages maximum (256 KiB / 512 KiB), where
;; the frozen layout's floor is ~5.96 MiB and the default ceiling is 8 MiB.
;;
;; This module never runs. The session refuses the whole run before
;; instantiation, in `Session::prepare_arena`, naming the disagreement between
;; the ceiling (which is also the guest's `--memoryBase`) and the size the
;; module declares. That check is the belt-and-braces for the one build mistake
;; the wasm type system cannot see: an `asc` invocation whose `--memoryBase` and
;; `--maximumMemory` do not describe this module, which would put the guest's
;; own segments inside the arena.
;;
;; The empty `_start_game` is deliberate: if the refusal ever regresses, this
;; guest runs, prints nothing and exits 0 — and the smoke test fails, which is
;; exactly the signal we want.
(module
  (import "session" "memory" (memory 4 8))
  (export "memory" (memory 0))
  (func (export "_start_game"))
)
