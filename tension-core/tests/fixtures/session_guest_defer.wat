;; A2c's deferred-submission fixture: the guest side of "queue in a callback,
;; apply in the next epoch".
;;
;; The host opens the session and registers `onBatch` (`--session-callbacks 1`),
;; and posts three JOB_DONE events (`--post-test-events`).
;;
;; The callback calls `echo::note_deferred` three times. That verb is registered
;; DEFERRABLE, so the session does *not* call it there: it copies the arguments
;; and applies them after the callback returns. The apply writes one byte per
;; submission at the echo adapter's note address, so the fixture's second wait
;; (which is what triggers the apply) can read them back and print their sum.
;;
;; The guest asserts each step, so "OK 3" on stdout is the guest's own report
;; that three deferrable submissions were queued from inside a callback and
;; applied after it.
(module
  (import "session" "memory" (memory 132 512))
  (export "memory" (memory 0))

  (import "session" "subscribe" (func $subscribe (param i32) (result i32)))
  (import "session" "wait" (func $wait (param i32) (result i32)))
  (import "echo" "note_deferred" (func $note (param i32 i32) (result i32)))
  (import "tension::io" "print" (func $print (param i32 i32)))

  ;; The echo adapter's note address (its C file defines the same one).
  ;; Apply writes one byte per submission at NOTED + slot.
  ;; Scratch: 0x802000 (8396800) holds the callback's call count.
  (type $batch_t (func (param i32 i32 i32) (result i32)))
  (func $batch (type $batch_t) (param $class i32) (param $ptr i32) (param $count i32) (result i32)
    (i32.store (i32.const 8396800) (i32.add (i32.load (i32.const 8396800)) (i32.const 1)))
    ;; Three deferrable calls: copied, not run.
    (drop (call $note (i32.const 0) (i32.const 7)))
    (drop (call $note (i32.const 1) (i32.const 7)))
    (drop (call $note (i32.const 2) (i32.const 7)))
    (i32.const 0))

  (table 4 funcref)
  (elem (i32.const 1) $batch)
  (export "table" (table 0))

  ;; The Subscription at 0x801000: class 4 (JOB_DONE), mode 2 (BATCHED).
  (data (i32.const 8392704) "\04\00\00\00\02\00\00\00\00\00\00\00\00\00\00\00")

  (func $digit (param $value i32) (param $at i32)
    (i32.store8 (local.get $at) (i32.add (i32.const 48) (local.get $value))))

  (func (export "_start_game")
    (if (i32.ne (call $subscribe (i32.const 8392704)) (i32.const 0)) (then unreachable))
    ;; The first wait publishes and invokes: the callback queues three.
    (if (i32.ne (call $wait (i32.const 1000)) (i32.const 3)) (then unreachable))
    (if (i32.ne (i32.load (i32.const 8396800)) (i32.const 1)) (then unreachable))
    ;; The second wait is what applies them: nothing to deliver, three applied.
    (if (i32.ne (call $wait (i32.const 10)) (i32.const 0)) (then unreachable))

    ;; "OK " + the sum of the three bytes the apply wrote (8389632..8389635).
    (i32.store8 (i32.const 8397056) (i32.const 79)) ;; 'O'
    (i32.store8 (i32.const 8397057) (i32.const 75)) ;; 'K'
    (i32.store8 (i32.const 8397058) (i32.const 32))
    (call $digit
      (i32.add
        (i32.add (i32.load8_u (i32.const 8389632)) (i32.load8_u (i32.const 8389633)))
        (i32.load8_u (i32.const 8389634)))
      (i32.const 8397059))
    (call $print (i32.const 8397056) (i32.const 4))
  )
)
