;; A guest that calls every `tension::threads` verb and traps unless each one
;; answers `-ENOTSUP`.
;;
;; This is the stub's own assertion. The module has no memory and no session: it
;; needs neither to link, and importing a memory would put it through F2's
;; load-time memory checks, which are not what this fixture is about. What it
;; proves is the two things a stub can get wrong — an unresolved import (the
;; run dies at instantiation, before `_start_game`) and a verb that answers
;; something other than the documented errno (`unreachable`, so the run fails
;; and the test says which).
;;
;; `-95` is `-ENOTSUP`, spelled out rather than named: this file is a guest, and
;; a guest has no headers. `-ENOSYS` (-38) is deliberately absent — no verb in
;; this surface can ask for the parallel half, so no path returns it.
(module
  (import "tension::threads" "self"       (func $self       (result i32)))
  (import "tension::threads" "context_of" (func $context_of (param i32) (result i32)))
  (import "tension::threads" "spawn"      (func $spawn      (param i32 i32) (result i32)))
  (import "tension::threads" "join"       (func $join       (param i32 i32) (result i32)))
  (import "tension::threads" "post"       (func $post       (param i32 i32) (result i32)))
  (import "tension::threads" "await_task" (func $await_task (param i32 i32) (result i32)))

  (func (export "_start_game")
    (block $wrong
      (br_if $wrong (i32.ne (call $self) (i32.const -95)))
      (br_if $wrong (i32.ne (call $context_of (i32.const 1)) (i32.const -95)))
      (br_if $wrong (i32.ne (call $spawn (i32.const 0) (i32.const 0)) (i32.const -95)))
      (br_if $wrong (i32.ne (call $join (i32.const 1) (i32.const 0)) (i32.const -95)))
      (br_if $wrong (i32.ne (call $post (i32.const 1) (i32.const 0)) (i32.const -95)))
      (br_if $wrong (i32.ne (call $await_task (i32.const 1) (i32.const 0)) (i32.const -95)))
      (return))
    ;; A verb answered something other than -ENOTSUP: the surface exists but the
    ;; contract it documents does not hold.
    (unreachable))
)
