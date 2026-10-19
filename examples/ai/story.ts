// examples/ai/story.ts — the tension::ai demo.
//
// The host owns the model; the game owns the conversation. This example shows
// both guest services at once: tension::io for the terminal, tension::ai for
// the model. It opens one chat session and runs a read-eval-print loop.
//
//   tension-core ai/build/story.wasm [model.gguf]
//
// The model path is the game's first argument. It is required: the ABI says
// `session_create` refuses a config with no model key, so even the headless
// fallback is given one (it ignores the value and answers deterministically).
// Without the `ai` cargo feature, this demo therefore runs end-to-end with no
// GGUF file at all — any path will do.
//
// Commands: /reset, /cancel, /quit.
//
// ## The stream, and why the shape below is what it is
//
// A generation runs on the host's own thread. Before 0.6.0b the guest learned
// about it by polling — `while (session.state() == 1) { read(); }` — a busy-wait
// against an API that never yields. Now the host posts a completion
// (AI_READY / AI_DONE / AI_ERROR) through the arena's posting face and the guest
// **parks** on it:
//
//   const n: i32 = await rt.stream(session.handle());
//
// `n > 0` is an unread byte count (AI_READY), `n == 0` is the end of the
// generation (AI_DONE), `n < 0` is an error (AI_ERROR, or a lost signal). The
// **delivered class** decides, never the payload.
//
// There is no `session.state()` in the loop and no yield loop around it: the
// task parks on `(AI family, session handle)` and the driver's `rt.runReady()`
// is what resumes it. That is the whole point of the change — zero polls, zero
// yields.
//
// ## Why `_start_game` still owns a loop
//
// `_start_game` is `() -> ()`: the host binds the entry as
// `get_typed_func::<(), ()>`. A suspended task cannot keep the guest thread
// alive, so the entry starts the REPL as a task and then **drives** it: block on
// the session's own wait (a real condition variable inside the host), then
// resume whatever is ready. This is the shape every async game runs; here the
// "frames" are stream chunks.
//
// ## What the compiler forced (all measured, all in this file's shape)
//
// The async transform refuses, inside a lowered body: `break`, `continue`, a
// `<T>` cast or `as` assertion, a local declared after an `await`, an untyped
// local that crosses one, and a type argument. So the loop conditions carry the
// exits, every local that survives a park is typed at its declaration, and the
// two null-union refinements the REPL needs live in **non-async** code — the
// session is opened in `_start_game` and passed in as a parameter.

import {
  arg,
  argCount,
  ConfigBuilder,
  print,
  readLine,
  RuntimeSession,
  rt,
  write
} from "tension-framework";
import { AiConfig, AiRole, Session } from "tension-framework";

const SYSTEM_PROMPT =
  "You narrate a terse, atmospheric text adventure. Reply in at most two sentences.";

/// Set when the REPL is over, so the driver above it can stop.
let finishing: bool = false;

/// One turn: ask, then read the stream until it ends.
///
/// Pure `await` — no state polling, no yield loop. Every branch is decided by
/// the class the host delivered, which `rt.stream` has already classified.
async function converse(session: Session): void {
  write("ai> ");

  // Typed at its declaration: a local that survives a park must be.
  let n: i32 = 0;
  let streaming: bool = true;
  while (streaming) {
    n = await rt.stream(session.handle());
    if (n < 0) {
      // AI_ERROR, or a signal the runtime reported as lost. The backend's own
      // reason, if it had one, is already in the reply buffer.
      print("");
      print("(generation failed: errno " + n.toString() + ")");
      streaming = false;
    } else if (n == 0) {
      print("");
      streaming = false; // AI_DONE: over, and the reply is fully read
    } else {
      // AI_READY: at least one byte is waiting. `read()` drains everything
      // accumulated — more than `n` if the guest was slow to resume.
      write(session.read());
    }
  }
}

/// The read-eval-print loop, as a task. No `break`, no `continue`: the loop
/// condition carries the exits.
async function repl(session: Session): void {
  let running: bool = true;
  while (running) {
    print("");
    write("you> ");
    const text: string = nextLine().trim();

    if (text.length == 0) {
      // An empty line (or closed stdin) is not a turn. Closed stdin is detected
      // below by `readLine` returning null, which the helper turned into "".
    } else if (text == "/quit") {
      running = false;
    } else if (text == "/reset") {
      const cleared: bool = session.reset();
      // reset clears the whole history, including the system prompt that makes
      // the model narrate. Restore it, or the next reply comes back from a
      // generic assistant instead of the game's narrator.
      if (cleared) session.add(AiRole.System, SYSTEM_PROMPT);
      print(cleared ? "(history cleared)" : "(cannot reset while generating)");
    } else if (text == "/cancel") {
      print(session.cancel() ? "(cancelled)" : "(nothing in flight)");
    } else {
      session.add(AiRole.User, text);
      if (!session.generate()) {
        print("(generate refused — drain the previous reply or cancel first)");
      } else {
        // Parks until the host posts a signal; the driver below resumes it.
        await converse(session);
      }
    }

    // stdin closed: the helper yields "", but a genuinely null read means the
    // conversation is over rather than that the player pressed enter.
    if (text.length == 0 && isStdinClosed()) running = false;
  }

  session.close();
  print("--- end ---");
  finishing = true;
}

/// Whether the last `readLine` hit end of input. Kept as a separate probe so the
/// async body never has to hold a nullable local across a park.
let stdinClosed: bool = false;

function isStdinClosed(): bool {
  return stdinClosed;
}

/// Reads one line, remembering whether stdin ended. Called from the async body,
/// which is why the null check is here and not there.
function nextLine(): string {
  const line: string | null = readLine();
  stdinClosed = line === null;
  return line === null ? "" : line!;
}

export function _start_game(): void {
  // Bind the completion classes to their families — including the AI family —
  // before any await can park. Idempotent; `init` calls it too.
  rt.start();

  // The stream needs a **session**: the completions arrive through the arena's
  // posting face, which only exists once one is open. The AI verbs themselves
  // work without it (which is why this example ran without a session before
  // 0.6.0b), but `await` cannot.
  const callbacks = rt.callbacks();
  const opened = RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks);
  if (opened != 0) {
    print("ai: the session refused to open (" + opened.toString() + ")");
    return;
  }

  print("=== TensionCore AI demo ===");

  if (argCount() < 1) {
    print("usage: tension-core ai/build/story.wasm <model.gguf>");
    print("(the host requires a model key; the headless fallback ignores its value)");
    RuntimeSession.close();
    return;
  }
  const modelPath: string = arg(0);
  print("model> " + modelPath);

  const cfg = new AiConfig().modelPath(modelPath).contextSize(2048).maxTokens(256).temp(0.8);
  print("loading model (this blocks until the weights are in; a few seconds) ...");
  const created: Session | null = Session.create(cfg);
  if (created === null) {
    print("(session_create failed — the host refused the configuration)");
    RuntimeSession.close();
    return;
  }
  // Non-null from here, and the assertion lives in synchronous code.
  const session: Session = created!;

  session.add(AiRole.System, SYSTEM_PROMPT);
  print("Commands: /reset, /cancel, /quit");

  repl(session); // floating task: runs its synchronous prefix, parks at the first await

  // The driver. `wait(-1)` blocks on the host's condition variable until an
  // event, a fault or a shutdown; `runReady()` resumes what the delivery woke.
  // A task that blocks on stdin (the REPL, between turns) does so *inside* this
  // call — a real wait too, with no generation in flight.
  while (!finishing) {
    // `wait(0)` drains without blocking; `wait(-1)` blocks until an event. The
    // choice is what makes a *chained* resume work: `rt.stream` is a two-layer
    // async composition, so resuming the inner task completes the outer one
    // **during** the tick, and that wake lands in the next tick's queue. Ticking
    // again immediately (no wait) is what carries it; with a bare `wait(-1)`
    // the guest would block with a runnable task and never resume. This is the
    // plan's `timeout = hasRunnable() ? 0 : frameTimeout` shape (§6.3), and it
    // is not a poll: the zero-timeout call never waits.
    RuntimeSession.wait(rt.hasRunnable() ? 0 : -1);
    rt.runReady();
  }

  RuntimeSession.close();
}
