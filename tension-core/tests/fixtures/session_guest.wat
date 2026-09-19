;; tension-core's session smoke guest — the fixture A1's end-to-end test runs.
;;
;; Hand-written, and deliberately small enough to read in one screen.
;;
;; **This module does not call `session_open`.** A1 has no guest SDK yet, so the
;; fixture has no encoder for the config TLV, and the run is started with
;; `--session-open`: the host performs the same open the verb performs, before
;; `_start_game`. That is a test-only convenience and *not* the design's
;; contract — a real guest opens its own session, which is why the flag exists
;; instead of the behaviour being unconditional. The guest-calls-`open` path is
;; covered by `test_verb_path_through_a_guest` in `src/session/mod.rs`, and is
;; re-verified end to end in A2, when the epoch gives a guest a reason to wait.
;;
;; What it does instead is check the arena the session prepared, from the
;; guest's side, and then exercise an adapter:
;;
;;   * the control block's magic, and its `state` field — which reads READY only
;;     because the host's `--session-open` ran;
;;   * `SessionInfo.maxArenaSize`, which is the ceiling the host opened with;
;;   * an adapter import (arithmetic) and one that round-trips bytes through the
;;     host's `guest_read`/`guest_write`;
;;   * `OK` through `tension::io`, which is the output the test can see.
;; It traps on any mismatch, so a wrong answer is a trap rather than a quiet
;; pass.
;;
;; Why `(memory 128 512)`: 128 pages is exactly 8 MiB, which is exactly the
;; default `max_arena_size` — so this module declares *no* byte of its own, and
;; `memoryBase` lands on the memory's end. That is the boundary case of §4.1's
;; relation, which is worth having as a fixture; the cost is that the two
;; scratch buffers below (0x9000, 0x9010) necessarily sit inside the region
;; band, since there is nowhere else. Nothing in chunk 1 refuses that — region
;; *direction* is a table entry today, not an enforcement — but a real guest
;; should declare `memoryBase` plus a heap and keep its own bytes above the
;; boundary. The pattern is written before the round-trip call so the bytes the
;; adapter writes are known to be overwriting something, not landing in a hole.
(module
  (import "session" "memory" (memory 128 512))
  (export "memory" (memory 0))

  (import "echo" "add" (func $add (param i32 i32) (result i32)))
  (import "echo" "roundtrip" (func $roundtrip (param i32 i32) (result i32)))
  (import "tension::io" "print" (func $print (param i32 i32)))

  (func (export "_start_game")
    ;; 1. The control block's magic: 0x414E455241534E54 is "TNSARENA" as eight
    ;;    little-endian bytes, so the u32 at offset 0 is 0x41534E54 and the u32
    ;;    at offset 4 is 0x414E4552. Written by the session before this module
    ;;    was instantiated.
    (if (i64.ne (i64.load (i32.const 0)) (i64.const 0x414e455241534e54))
      (then unreachable))

    ;; 2. The control block's state (offset 0xA0) reads READY: the host's
    ;;    `--session-open` performed the open this fixture does not.
    (if (i32.ne (i32.load (i32.const 0xa0)) (i32.const 1))
      (then unreachable))

    ;; 3. SessionInfo.maxArenaSize (0x100 + 20) is the ceiling the host opened
    ;;    with: the default 8 MiB, which this module's 128 pages provide.
    (if (i32.ne (i32.load (i32.const 0x114)) (i32.const 8388608))
      (then unreachable))

    ;; 4. An adapter import: arguments in, value out.
    (if (i32.ne (call $add (i32.const 3) (i32.const 4)) (i32.const 7))
      (then unreachable))

    ;; 5. A known pattern at 0x9000, then the adapter's memory import: it writes
    ;;    eight bytes there through `guest_write` and reads them back through
    ;;    `guest_read`, so a full round trip must return 8.
    (i64.store (i32.const 0x9000) (i64.const 0xaaaaaaaaaaaaaaaa))
    (if (i32.ne (call $roundtrip (i32.const 0x9000) (i32.const 8)) (i32.const 8))
      (then unreachable))

    ;; 6. Output the test can see. There is no data segment to put it in: this
    ;;    module declares no byte of its own, so the two bytes are stored here.
    (i32.store8 (i32.const 0x9010) (i32.const 79)) ;; 'O'
    (i32.store8 (i32.const 0x9011) (i32.const 75)) ;; 'K'
    (call $print (i32.const 0x9010) (i32.const 2))
  )
)
