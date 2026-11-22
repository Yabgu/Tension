;; The smallest shared-memory guest that says something about the *host*: it
;; imports the host's shared memory, does two atomic RMWs, asks for the executor
;; count, spawns one real worker thread, and prints one line from each side.
(module
  (import "env" "memory" (memory 1 64 shared))
  (import "env" "__executorCount" (func $count (result i32)))
  (import "env" "__startThread" (func $start (param i32) (result i32)))
  (import "tension::io" "print" (func $print (param i32 i32)))
  (export "memory" (memory 0))

  (data (i32.const 128) "main: atomic 0+7+35 = 42 ok|")
  (data (i32.const 160) "main: atomic WRONG|")
  (data (i32.const 176) "main: executorCount = 3 ok|")
  (data (i32.const 208) "main: executorCount WRONG|")
  (data (i32.const 240) "worker: atomic rmw.add over shared memory ok|")
  (data (i32.const 288) "worker: WRONG|")

  (func (export "__arenaInit") (param i32 i32))
  (func (export "__workerArenaBase") (param i32) (result i32) (i32.const 16))
  (func (export "__workerArenaSize") (param i32) (result i32) (i32.const 4096))

  ;; Each worker bumps word 4 atomically; the first one to do it wins the print.
  (func (export "__workerMain") (param $id i32) (result i32)
    (if (i32.eq (i32.atomic.rmw.add (i32.const 4) (i32.const 1)) (i32.const 0))
      (then (call $print (i32.const 240) (i32.const 45)))
      (else (call $print (i32.const 288) (i32.const 14))))
    (i32.const 0))

  (func (export "_start_game")
    ;; word 0 starts at 0; two RMW adds must land on 42.
    (drop (i32.atomic.rmw.add (i32.const 0) (i32.const 7)))
    (drop (i32.atomic.rmw.add (i32.const 0) (i32.const 35)))
    (if (i32.eq (i32.atomic.load (i32.const 0)) (i32.const 42))
      (then (call $print (i32.const 128) (i32.const 28)))
      (else (call $print (i32.const 160) (i32.const 19))))
    ;; --executors 2: main plus two workers.
    (if (i32.eq (call $count) (i32.const 3))
      (then (call $print (i32.const 176) (i32.const 27)))
      (else (call $print (i32.const 208) (i32.const 26))))
    ;; spawn worker 1; 0 is the contract's success.
    (drop (call $start (i32.const 1)))))
