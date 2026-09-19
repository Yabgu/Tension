;; tension-solver phase-4 fixture: the guest side of `source: "wasm"`.
;;
;; The bridge convention (P4's simplest workable shape):
;;
;;   deriv_buf_in()  -> the wasm address where the host writes the input
;;                      state y before each `_derivative` call.
;;   deriv_buf_out() -> the wasm address where this module leaves the
;;                      derivative f(t, y) for the host to read back.
;;
;; Both addresses point into this module's own linear memory. They are
;; not allocated by any function: the module and the host simply agree
;; that the two regions exist (64 KiB each, non-overlapping) and use
;; them by convention. The host trampoline copies y in, calls
;; `_derivative` with the two wasm addresses, and copies the output
;; back out; the module never sees a host pointer, and the host never
;; reads wasm memory except through these two regions. That copy-in /
;; call / copy-out pattern is deliberate: P4 proves the mechanism, not
;; zero-copy, and 64 KiB fixed buffers keep the fixture honest about
;; its limit (P5 can generalize with an allocator export if needed).
;;
;; `_derivative` implements f(t, y) = -y, elementwise, matching the
;; Rust RHS the earlier phase tests use, so the wasm path and the
;; direct path are comparable arithmetic-for-arithmetic.
(module
  ;; 3 pages = 192 KiB: buf_in at 1024 (64 KiB), buf_out at 66560
  ;; (64 KiB) — the last byte used is 132095, so two pages (128 KiB)
  ;; would not have been enough; the phase brief's "2 pages" arithmetic
  ;; fell 1024 bytes short of its own suggested addresses.
  (memory (export "memory") 3)

  (func (export "_derivative")
        (param $y_ptr i32)
        (param $len i32)
        (param $t f64)
        (param $dy_ptr i32)
        (param $dy_cap i32)
        (result i32)
    (local $i i32)
    (local $v f64)
    (block $done
      (loop $loop
        (br_if $done (i32.ge_s (local.get $i) (local.get $len)))
        (local.set $v
          (f64.load
            (i32.add (local.get $y_ptr)
                     (i32.mul (local.get $i) (i32.const 8)))))
        (f64.store
          (i32.add (local.get $dy_ptr)
                   (i32.mul (local.get $i) (i32.const 8)))
          (f64.neg (local.get $v)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)))
    (i32.const 0))

  (func (export "deriv_buf_in") (result i32)
    (i32.const 1024))

  (func (export "deriv_buf_out") (result i32)
    (i32.const 66560))
)
