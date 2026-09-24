;; A2c's R7 fixture: queued work survives a trapping callback.
;;
;; The callback calls `echo::add` — a verb with neither flag, so the session
;; refuses it inside a callback with -EBUSY, which the guest records and ignores
;; — then queues two deferrable submissions, then traps.
;;
;; The trap ends the epoch with -EIO, and the queue is *not* cleared: what the
;; callback deferred belongs to the session, not to the callback. The host
;; reports how many submissions are still pending after the guest returns, which
;; is what this fixture makes observable from a process-level test: the guest
;; itself cannot wait again without closing and re-opening (a FAULTED session
;; refuses every verb with -EBADF), and the host does not open sessions twice.
(module
  (import "session" "memory" (memory 132 512))
  (export "memory" (memory 0))

  (import "session" "subscribe" (func $subscribe (param i32) (result i32)))
  (import "session" "wait" (func $wait (param i32) (result i32)))
  (import "echo" "note_deferred" (func $note (param i32 i32) (result i32)))
  (import "echo" "add" (func $add (param i32 i32) (result i32)))

  (type $batch_t (func (param i32 i32 i32) (result i32)))
  (func $batch (type $batch_t) (param $class i32) (param $ptr i32) (param $count i32) (result i32)
    ;; A verb with neither flag, called where it may not be.
    (i32.store (i32.const 8396804) (call $add (i32.const 3) (i32.const 4)))
    ;; Two deferrable submissions.
    (drop (call $note (i32.const 0) (i32.const 7)))
    (drop (call $note (i32.const 1) (i32.const 7)))
    ;; And the trap.
    (unreachable))

  (table 4 funcref)
  (elem (i32.const 1) $batch)
  (export "table" (table 0))

  (data (i32.const 8392704) "\04\00\00\00\02\00\00\00\00\00\00\00\00\00\00\00")

  (func (export "_start_game")
    (if (i32.ne (call $subscribe (i32.const 8392704)) (i32.const 0)) (then unreachable))
    ;; The trapping epoch: -EIO, and the guest observes the refusal of the
    ;; non-deferrable verb it tried first.
    (if (i32.ne (call $wait (i32.const 1000)) (i32.const -5)) (then unreachable))
    (if (i32.ne (i32.load (i32.const 8396804)) (i32.const -16)) (then unreachable))
    ;; A second wait is refused: the session is FAULTED, which is -EBADF.
    (if (i32.ne (call $wait (i32.const 10)) (i32.const -9)) (then unreachable))
  )
)
