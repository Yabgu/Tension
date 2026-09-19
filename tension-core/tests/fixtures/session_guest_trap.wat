;; A2's fault fixture: the same shape as `session_guest_epoch.wat`, with an
;; `onBatch` that traps.
;;
;; What it proves: the session survives a trapping callback without unwinding
;; the guest's own call — `session_wait` returns `-EIO` to the guest, the
;; session moves to FAULTED with `faultState = FAULT_CALLBACK_TRAP` and
;; `lastError = 0` (the onBatch slot), and that slot is disabled for the rest of
;; the session. The guest then traps itself, which is how a fixture says "the
;; verb failed" to a process-level test: the exit code is non-zero and the
;; diagnostic is on stderr.
(module
  (import "session" "memory" (memory 132 512))
  (export "memory" (memory 0))

  (import "session" "subscribe" (func $subscribe (param i32) (result i32)))
  (import "session" "wait" (func $wait (param i32) (result i32)))

  (type $batch_t (func (param i32 i32 i32) (result i32)))
  (func $batch (type $batch_t) (param $class i32) (param $ptr i32) (param $count i32) (result i32)
    (unreachable))

  (table 4 funcref)
  (elem (i32.const 1) $batch)
  (export "table" (table 0))

  ;; The Subscription: class 4 (JOB_DONE), mode 2 (BATCHED).
  (data (i32.const 8392704) "\04\00\00\00\02\00\00\00\00\00\00\00\00\00\00\00")

  (func (export "_start_game")
    (if (i32.ne (call $subscribe (i32.const 8392704)) (i32.const 0)) (then unreachable))
    ;; The trap is inside this call, so its return value is -EIO; anything else
    ;; means the fault path did not run.
    (if (i32.ne (call $wait (i32.const 1000)) (i32.const -5)) (then unreachable))
    ;; And a second wait must not re-enter the disabled slot: the session is
    ;; FAULTED, so it refuses with -EBADF without calling anything.
    (if (i32.ne (call $wait (i32.const 10)) (i32.const -9)) (then unreachable))
    ;; Reaching here means both refusals were the documented ones.
    (unreachable)) ;; ... but a faulted session is still a failed run.
)
