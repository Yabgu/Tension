// The session verbs, as raw imports plus the thin typed wrappers.
//
// The wrappers return the host's errno unchanged: a negative value is a
// refusal, and which one it is (`-EINVAL` for a config the session refused,
// `-EBADF` when the session is not open, `-EBUSY` from inside a callback,
// `-EIO` after a fault) is the caller's to interpret. `./index` is the
// ergonomic layer on top; this file is deliberately the ABI and nothing else.

import { Subscription } from "./wire";

/** `session::open(cfg_ptr, cfg_len) -> 0 | -EINVAL`. */
@external("session", "open")
declare function openRaw(cfgPtr: usize, cfgLen: u32): i32;

/** `session::close() -> 0`. Idempotent. */
@external("session", "close")
declare function closeRaw(): i32;

/** `session::wait(timeout_ms)`: deliveries, 0 on timeout, or an errno. */
@external("session", "wait")
declare function waitRaw(timeoutMs: i32): i32;

/** `session::drain(class)`: deliveries for one class, never blocking. */
@external("session", "drain")
declare function drainRaw(class_: u32): i32;

/** `session::subscribe(sub_ptr) -> 0 | -EINVAL`. */
@external("session", "subscribe")
declare function subscribeRaw(subPtr: usize): i32;

/** `session::unsubscribe(class) -> 0 | -EINVAL`. */
@external("session", "unsubscribe")
declare function unsubscribeRaw(class_: u32): i32;

/** `session::pending()`: deferred submissions waiting to be applied. */
@external("session", "pending")
declare function pendingRaw(): i32;

/**
 * Open the session with a config the caller built.
 *
 * `cfgPtr` must point at the encoded bytes (`ConfigBuilder.toBytes`) and
 * `cfgLen` at their length. The session reads them during this call — the
 * arena's rendezvous — so the buffer must stay alive until it returns, which
 * for a `ConfigBuilder`'s own `ArrayBuffer` is automatic.
 */
export function open(cfgPtr: usize, cfgLen: u32): i32 {
  return openRaw(cfgPtr, cfgLen);
}

export function close(): i32 {
  return closeRaw();
}

/** Block until an event, a fault, a shutdown, or the timeout. */
export function wait(timeoutMs: i32): i32 {
  return waitRaw(timeoutMs);
}

/** One class, no blocking: the epoch restricted to `class_`. */
export function drain(class_: u32): i32 {
  return drainRaw(class_);
}

/** Subscribe `class_` with `sub`'s mode. The record may live anywhere. */
export function subscribe(sub: Subscription): i32 {
  return subscribeRaw(changetype<usize>(sub));
}

export function unsubscribe(class_: u32): i32 {
  return unsubscribeRaw(class_);
}

export function pending(): i32 {
  return pendingRaw();
}
