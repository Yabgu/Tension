;; A2c's rejection fixture: a deferred submission that fails when it is applied.
;;
;; The callback queues one deferrable submission whose apply the adapter refuses
;; (a negative slot is the echo adapter's own "fail on purpose"). The session
;; turns that into a SUBMISSION_REJECTED event — the class exists for exactly
;; this second failure mode, where the guest is not inside a call that could
;; receive an errno — and delivers it in the *next* epoch. The guest is
;; subscribed to that class as DIRECT, so its `onEvent` handler is what receives
;; it, and the fixture prints the class and the verb id it saw.
(module
  (import "session" "memory" (memory 132 512))
  (export "memory" (memory 0))

  (import "session" "subscribe" (func $subscribe (param i32) (result i32)))
  (import "session" "wait" (func $wait (param i32) (result i32)))
  (import "echo" "note_deferred" (func $note (param i32 i32) (result i32)))
  (import "tension::io" "print" (func $print (param i32 i32)))

  ;; Scratch at 8396800: +0 the delivered class, +4 the event's `a` (the verb id).
  (type $batch_t (func (param i32 i32 i32) (result i32)))
  (type $event_t (func (param i32 i32) (result i32)))

  (func $batch (type $batch_t) (param $class i32) (param $ptr i32) (param $count i32) (result i32)
    ;; Slot -1: the apply will refuse this one.
    (drop (call $note (i32.const -1) (i32.const 7)))
    (i32.const 0))

  (func $event (type $event_t) (param $class i32) (param $ptr i32) (result i32)
    (i32.store (i32.const 8396800) (local.get $class))
    (i32.store (i32.const 8396804) (i32.load (i32.add (local.get $ptr) (i32.const 16))))
    (i32.const 0))

  (table 4 funcref)
  (elem (i32.const 1) $batch $event)
  (export "table" (table 0))

  ;; Two subscriptions: JOB_DONE batched, SUBMISSION_REJECTED direct.
  (data (i32.const 8392704) "\04\00\00\00\02\00\00\00\00\00\00\00\00\00\00\00")
  (data (i32.const 8392736) "\03\00\00\00\01\00\00\00\00\00\00\00\00\00\00\00")

  (func $digit (param $value i32) (param $at i32)
    (i32.store8 (local.get $at) (i32.add (i32.const 48) (local.get $value))))

  (func (export "_start_game")
    (if (i32.ne (call $subscribe (i32.const 8392704)) (i32.const 0)) (then unreachable))
    (if (i32.ne (call $subscribe (i32.const 8392736)) (i32.const 0)) (then unreachable))
    ;; Epoch 1: the batch of three (the host posts three JOB_DONE events), and
    ;; the callback queues its one failing submission.
    (if (i32.ne (call $wait (i32.const 1000)) (i32.const 3)) (then unreachable))
    ;; Epoch 1's apply ran and failed, so the rejection is already queued: the
    ;; next epoch is the one that delivers it.
    (if (i32.ne (call $wait (i32.const 10)) (i32.const 1)) (then unreachable))
    ;; And it is delivered exactly once.
    (if (i32.ne (call $wait (i32.const 10)) (i32.const 0)) (then unreachable))
    ;; "R <class> <verb id>" at 8397056, printed before the assertions so a
    ;; failed run still shows what the rejection carried.
    (i32.store8 (i32.const 8397056) (i32.const 82)) ;; 'R'
    (i32.store8 (i32.const 8397057) (i32.const 32))
    (call $digit (i32.load (i32.const 8396800)) (i32.const 8397058))
    (i32.store8 (i32.const 8397059) (i32.const 32))
    (call $digit (i32.load (i32.const 8396804)) (i32.const 8397060))
    (call $print (i32.const 8397056) (i32.const 5))

    (if (i32.ne (i32.load (i32.const 8396800)) (i32.const 3)) (then unreachable))
    (if (i32.ne (i32.load (i32.const 8396804)) (i32.const 3)) (then unreachable))
  )
)
