# Backlog: guest-rejectable close

**Status:** backlog, not a plan, and explicitly out of Pass 2 and Pass 3 scope.
Recorded so the decision is a design rather than a surprise when an editor asks
for an unsaved-changes dialog.

## The default, and what it cannot do

`tension dev` runs the app and stops when the window closes
(`docs/build.md`, "What `tension dev` does, and when it stops"). That default is
right: a supervisor outliving the app it supervises looks like a hang.

What it cannot express is **"wait, I have unsaved work"**. The host latches the
close request —

```rust
// tension-core/src/platform.rs:2060-2072
// Latched, not an edge.
```

— and once latched, the window closes. A guest that wanted to ask a question
first has no channel, no vote and no veto. There is no verb for "the user asked
to close", and no return value that means "keep running".

## The shape it would need

A two-phase close, in the same family as the capability `init`/`shutdown`
handshake already in the tree:

1. **The host stops closing and asks.** On `CloseRequested`, the host does not set
   `window_closed`; it posts an event of its own — call it `CLOSE_REQUESTED` —
   into the guest's queue, and stops pumping the close.
2. **The guest answers.** Either `platform.ack_close()` (close now) or
   `platform.reject_close()` (keep running), or the application's own verb pair.
   A guest that never answers is closed anyway after a bounded wait, because a
   framework whose default is "a hung guest can prevent the window from closing"
   is worse than the problem it solves.
3. **The latch becomes a state machine.** `window_closed: bool` gains an
   intermediate state — `CloseRequested` — because the current field cannot
   represent "asked and not yet answered". Every reader of that field has to be
   audited: the host loop's break, `present`'s refusal, the 2D device's `Canceled`
   path, and `AppShell.run`'s question.

## Constraints, each a fact about the current code

- **`present` refuses after a close.** `render2d/device.rs` returns
  `Render2dError::Canceled` once the window has closed, and the editor's loop
  treats `-125` as an exit reason. A rejectable close means `present` must
  distinguish "closed" from "close requested", or a guest that rejects would stop
  presenting and never draw again.
- **The latch exists to prevent a per-frame error loop.** Its comment says so:
  without latching, every frame after the user quits would log a failure. The
  state machine has to preserve that property; it is the reason the field is a
  bool today rather than an event queue.
- **Timing: the guest must answer from a place it is still running.** A guest
  blocked inside `present` cannot answer, so the request has to arrive where the
  guest's loop reads input — which is the same place `closeRequested` is read
  today (`tension-framework/assembly/app/shell.ts`).
- **A nested guest's close is the outer guest's decision.** If a sandboxed guest
  could reject, then closing the editor with a game running would need a
  three-way answer. The rule to state when this is built: the outer guest's
  close wins, and the nested run is stopped (Pass 2's shutdown criteria).

## What it is not

- **Not a modal dialog.** The host does not draw anything; it asks and waits. The
  dialog, if any, is the guest's UI, which is the only layer that knows what is
  unsaved.
- **Not a veto.** A bounded wait means a guest can delay a close, not prevent it
  forever.

## Related

- `docs/build.md` — the dev command's lifetime, which is where the default lives.
- `tension-core/src/platform.rs:2060-2072` — the latch this would replace.
- `docs/backlog/buffer-rendering.md` — the other shape recorded before it is
  needed.
