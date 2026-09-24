;; A guest that imports a memory but does not re-export it as `memory`.
;;
;; This is F2's second load-time check. The wasm type system is happy with this
;; module and the host cannot survive it: `tension::io` (and the resource ABI
;; beside it) reaches guest memory through `Instance::get_export("memory")`, and
;; the host code on that path is an `.expect(...)`. Without the re-export the
;; first print would panic and abort the process with a Rust backtrace instead
;; of a diagnostic, so the run checks at load time and bails with the line the
;; module has to add: `(export "memory" (memory 0))`.
;;
;; The import is spelled `env::memory` here on purpose: both spellings resolve
;; to the one arena (F1), and the check must not depend on which was used.
(module
  (import "env" "memory" (memory 136 512))
  (func (export "_start_game"))
)
