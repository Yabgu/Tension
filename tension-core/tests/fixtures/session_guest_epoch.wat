;; A2's epoch fixture: the guest side of one batched delivery.
;;
;; The host does the opening (`--session-callbacks 1`), because A2 has no guest
;; SDK yet — the guest cannot write the config TLV, and it does not need to: it
;; imports the arena, subscribes to JOB_DONE as BATCHED, waits, and prints what
;; its `onBatch` was handed. `--post-test-events` puts three JOB_DONE events in
;; the class queue before `_start_game`, so the wait finds them waiting.
;;
;; The output line is `OK <count> <class> <a> <b>` — the first record's payload
;; fields — with the values printed as single digits, which is all this fixture
;; needs to make the delivery observable from outside the process. The counts
;; and payloads are chosen by `main.rs` to be single digits for exactly this
;; reason.
;;
;; The memory is 132 pages (8.25 MiB): `memoryBase` is 8 MiB, so this module has
;; 256 KiB of its own — the configuration the design expects a guest to have,
;; rather than §13's deliberate boundary case. Everything it needs
;; (the Subscription, the callback's scratch) lives above the boundary.
(module
  (import "session" "memory" (memory 132 512))
  (export "memory" (memory 0))

  (import "session" "subscribe" (func $subscribe (param i32) (result i32)))
  (import "session" "wait" (func $wait (param i32) (result i32)))
  (import "tension::io" "print" (func $print (param i32 i32)))

  ;; Scratch: what the callback saw, at 0x802000 (8396800).
  ;;   +0 class, +4 count, +8 seq, +12 a, +16 b.
  (type $batch_t (func (param i32 i32 i32) (result i32)))
  (func $batch (type $batch_t) (param $class i32) (param $ptr i32) (param $count i32) (result i32)
    (i32.store (i32.const 8396800) (local.get $class))
    (i32.store (i32.const 8396804) (local.get $count))
    (i32.store (i32.const 8396808) (i32.load (local.get $ptr)))
    (i32.store (i32.const 8396812) (i32.load (i32.add (local.get $ptr) (i32.const 16))))
    (i32.store (i32.const 8396816) (i32.load (i32.add (local.get $ptr) (i32.const 20))))
    (i32.const 0))

  (table 4 funcref)
  (elem (i32.const 1) $batch)
  (export "table" (table 0))

  ;; The Subscription at 0x801000 (8392704): class 4 (JOB_DONE), mode 2 (BATCHED).
  (data (i32.const 8392704) "\04\00\00\00\02\00\00\00\00\00\00\00\00\00\00\00")

  ;; A digit (`0`-`9`) into a byte. Every value printed here is a single digit.
  (func $digit (param $value i32) (param $at i32)
    (i32.store8 (local.get $at) (i32.add (i32.const 48) (local.get $value))))

  (func (export "_start_game")
    ;; Subscribe, then wait for the host's three events.
    (if (i32.ne (call $subscribe (i32.const 8392704)) (i32.const 0)) (then unreachable))
    (if (i32.ne (call $wait (i32.const 1000)) (i32.const 3)) (then unreachable))

    ;; "OK <count> <class> <a> <b>" at 0x802100 (8397056).
    (i32.store8 (i32.const 8397056) (i32.const 79)) ;; 'O'
    (i32.store8 (i32.const 8397057) (i32.const 75)) ;; 'K'
    (i32.store8 (i32.const 8397058) (i32.const 32)) ;; ' '
    (call $digit (i32.load (i32.const 8396804)) (i32.const 8397059))
    (i32.store8 (i32.const 8397060) (i32.const 32))
    (call $digit (i32.load (i32.const 8396800)) (i32.const 8397061))
    (i32.store8 (i32.const 8397062) (i32.const 32))
    (call $digit (i32.load (i32.const 8396812)) (i32.const 8397063))
    (i32.store8 (i32.const 8397064) (i32.const 32))
    (call $digit (i32.load (i32.const 8396816)) (i32.const 8397065))
    (call $print (i32.const 8397056) (i32.const 10))
  )
)
