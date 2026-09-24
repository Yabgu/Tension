// The session runtime: the ergonomic layer over the seven verbs.
//
// Everything below `./session` is the ABI; this is the layer a game uses. The
// important shape is what a session guest's life looks like:
//
//   const callbacks = makeCallbacks(onBatch, onEvent);
//   const cfg = ConfigBuilder.forThisBuild(callbacks);
//   if (RuntimeSession.open(cfg) != 0) return;
//   while (!done) {
//     const delivered = RuntimeSession.wait(-1);
//     // ...
//   }
//   RuntimeSession.close();
//
// **The class is `RuntimeSession`, not `Session`.** `assembly/ai.ts` already
// exports a `Session` (a chat session), and two modules exporting one name
// through a barrel makes TypeScript drop *both* from `export *` — silently, so
// a game would fail to import either. The runtime's is named for what it is.
//
// **After a callback trap the session is FAULTED.** Every verb then refuses
// with `-EBADF`, because FAULTED is not a state any operation runs in
// (`DESIGN.md` §8): the verb that *discovered* the trap returns `-EIO`, and
// everything after it returns `-EBADF`. The guest's move is to close the
// session and open it again — `RuntimeSession.recover` is that, and it loses
// nothing:
// a deferred submission was copied when the callback called the verb, so it
// belongs to the session and survives the fault (R7). It is applied at the
// first epoch of the reopened session.

import { Callbacks, Subscription, STATE_FAULTED, CALLBACKS_SIZE } from "./wire";
import { ctrl } from "./arena";
import { STATE_READY } from "./wire";
import { ConfigBuilder } from "./config";
import * as verbs from "./session";

export * from "./wire";
export * from "./arena";
export * from "./config";
export * from "./callbacks";
export * from "./layout";
export { verbs };

/** Whether the session is FAULTED: every verb will refuse with `-EBADF`. */
export function isFaulted(): bool {
  return ctrl().state == STATE_FAULTED;
}

/** Whether the session is open and usable. */
export function isReady(): bool {
  return ctrl().state == STATE_READY;
}

/**
 * The seven verbs, once each.
 *
 * `open` takes the config and (optionally) the callbacks record: it writes the
 * record's address and length into the config before encoding it, so the two
 * cannot disagree. The config's buffer is allocated inside this call and stays
 * alive for its duration, which is all the session needs — it reads the bytes
 * *during* `session::open`, on this thread.
 */
export class RuntimeSession {
  static open(cfg: ConfigBuilder, callbacks: Callbacks | null = null): i32 {
    if (callbacks != null) {
      cfg.callbacks(changetype<usize>(callbacks), CALLBACKS_SIZE);
    }
    const bytes = cfg.toBytes();
    return verbs.open(changetype<usize>(bytes), <u32>bytes.byteLength);
  }

  static close(): i32 {
    return verbs.close();
  }

  /** Block up to `timeoutMs` (`< 0` indefinitely, `0` never). */
  static wait(timeoutMs: i32): i32 {
    return verbs.wait(timeoutMs);
  }

  /** One class, never blocking. */
  static drain(class_: u32): i32 {
    return verbs.drain(class_);
  }

  static subscribe(sub: Subscription): i32 {
    return verbs.subscribe(sub);
  }

  static unsubscribe(class_: u32): i32 {
    return verbs.unsubscribe(class_);
  }

  static pending(): i32 {
    return verbs.pending();
  }

  /**
   * Recover from a fault: close, then open again with the same config.
   *
   * Returns 0 when there was nothing to recover from (the session is not
   * FAULTED), the close's result when the reopen was not needed, and the open's
   * errno otherwise. The caller must pass the config it opened with — the
   * session never remembered it, and the fault did not change the arena's
   * shape.
   *
   * What survives: deferred submissions (R7), and the disabled slot from the
   * trap (which stays disabled for the session's lifetime, so the guest should
   * assume that slot is gone and use the other one, or none).
   */
  static recover(cfg: ConfigBuilder, callbacks: Callbacks | null = null): i32 {
    if (!isFaulted()) return 0;
    const closed = RuntimeSession.close();
    if (closed != 0) return closed;
    return RuntimeSession.open(cfg, callbacks);
  }
}
