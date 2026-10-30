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
import { ctrl, manifestProblem } from "./arena";
import { STATE_READY } from "./wire";
import { ConfigBuilder } from "./config";
import * as verbs from "./session";

export * from "./wire";
export * from "./arena";
export * from "./config";
export * from "./callbacks";
export { rt } from "./rt";
export * from "./layout";
export * from "./manifest";
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
    const opened = verbs.open(changetype<usize>(bytes), <u32>bytes.byteLength);
    if (opened != 0) return opened;
    // The session is READY, so the host has written the manifest and no user
    // code has run yet. Every offset this guest computes below this line is
    // only correct if the host and the guest agree about each record's size, so
    // a disagreement stops here rather than surfacing as a field read from the
    // wrong bytes — `SessionInfo`'s 128 vs 144 was exactly that, and it was
    // invisible for a day because the guest's own offset check compared the
    // declaration against a stale hand-copy instead of against the host.
    //
    // `assert`, not an errno: the open *succeeded*, and 44 call sites check its
    // return value with `if (open(cfg) != 0) return;` — an invented error there
    // is a plausible-looking value a caller may still ignore, which is the
    // silent-corruption outcome this check exists to prevent. It is the same
    // shape as `assertLayout`.
    const drift = manifestProblem();
    if (drift != null) {
      assert(false, "the session's manifest does not match this guest's declarations: " + drift);
    }
    return 0;
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
