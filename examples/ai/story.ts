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
//   const signal: Task<i32> = rt.stream(session.handle());
//   await signal;
//   const n: i32 = rt.classify(signal);
//
// `n > 0` is an unread byte count (AI_READY), `n == 0` is the end of the
// generation (AI_DONE), `n < 0` is an error (AI_ERROR, or a lost signal). The
// **delivered class** decides, never the payload.
//
// Two steps, not one: an `async` accessor would return *its own* task, and
// awaiting that parks the wrapper, not the caller — the two-layer composition
// `rt.frame` was fixed for (0.7.0a). `rt.stream` is a stamped handle, so
// `await` parks this task on `(AI family, session)` directly, and `classify`
// reads the record the await filled without parking anything.
//
// There is no `session.state()` in the loop and no yield loop around it: the
// task parks on `(AI family, session handle)` and the host's loop wakes it when
// the completion is posted. That is the whole point of the change — zero polls,
// zero yields.
//
// ## Why there is one async function and no driver
//
// 0.7.0b moved this guest onto the host-owned loop. `_start_game` opens the
// session, creates the model session and starts `run`; it does not pump. The
// turn loop and the stream loop are **one** function, not two: `converse()` was
// an `async` helper, and `await converse(session)` parked *converse's* task —
// completing it would leave `run` on the ready queue, which the host loop never
// drains (pipeline-notes: an awaitable accessor returns a stamped handle, never
// an async wrapper). One function, so every `await` parks the task the host is
// waking.
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
import { Task } from "~lib/task";
// The std's task machine: the table the push path parks in (0.7.0a).
import { __taskBindTable } from "~lib/task-rt";

// The host's wake entry. Re-exported because the linker drops an export the
// guest never names, and the host resolves `__taskWake` by name at load.
export { __taskWake } from "~lib/task-rt";

const SYSTEM_PROMPT =
  "You narrate a terse, atmospheric text adventure. Reply in at most two sentences.";

/// The whole conversation, as one task (0.7.0b).
///
/// Flattened from `converse` + `repl`: every `await` here parks **this** task, so
/// the host's wake resumes the loop itself. No `async` helper sits between
/// `_start_game` and the stream, and there is no `rt.runReady()` in the file.
///
/// No `break`, no `continue`: the transform refuses both in a lowered body, so
/// the loop conditions and flags carry every exit.
async function run(session: Session): void {
  // Typed at their declaration and declared before the first await: a local that
  // survives a park must be (the transform's documented limit).
  let running: bool = true;
  let text: string = "";
  let streaming: bool = true;
  let n: i32 = 0;
  let cleared: bool = false;
  // `handle` is a name the state struct reserves, so the awaited signal is
  // `signal`.
  let signal: Task<i32> = rt.streamTask(session.handle());

  while (running) {
    print("");
    write("you> ");
    text = nextLine().trim();

    if (text.length == 0) {
      // An empty line (or closed stdin) is not a turn. Closed stdin is detected
      // below by `readLine` returning null, which the helper turned into "".
    } else if (text == "/quit") {
      running = false;
    } else if (text == "/reset") {
      cleared = session.reset();
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
        write("ai> ");
        streaming = true;
        while (streaming) {
          // Parks on `(AI family, session handle)`; the host's loop delivers the
          // wake the backend posted, and `classify` reads the record it filled.
          signal = rt.stream(session.handle());
          await signal;
          n = rt.classify(signal);
          if (n < 0) {
            // AI_ERROR, or a signal the runtime reported as lost. The backend's
            // own reason, if it had one, is already in the reply buffer.
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
    }

    // stdin closed: the helper yields "", but a genuinely null read means the
    // conversation is over rather than that the player pressed enter.
    if (text.length == 0 && isStdinClosed()) running = false;
  }

  session.close();
  print("--- end ---");
  finished = true;
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

/// 1 while the guest wants the host to drive it (0.7.0a). Cleared only after the
/// conversation is closed, so the host's exit cannot cut the closing line off.
let finished: bool = false;

export function _game_running(): i32 {
  return finished ? 0 : 1;
}

export function _start_game(): void {
  // Bind the completion classes to their families — including the AI family —
  // before any await can park. Idempotent; `init` calls it too.
  rt.start();
  // The table the push path parks slots in (0.7.0a); one task parks at a time.
  __taskBindTable(8);

  // The stream needs a **session**: the completions arrive through the arena's
  // posting face, which only exists once one is open. The AI verbs themselves
  // work without it, but `await` cannot.
  const callbacks = rt.callbacks();
  const opened = RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks);
  if (opened != 0) {
    print("ai: the session refused to open (" + opened.toString() + ")");
    finished = true;
    return;
  }

  print("=== TensionCore AI demo ===");

  if (argCount() < 1) {
    print("usage: tension-core ai/build/story.wasm <model.gguf>");
    print("(the host requires a model key; the headless fallback ignores its value)");
    RuntimeSession.close();
    finished = true;
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
    finished = true;
    return;
  }
  // Non-null from here, and the assertion lives in synchronous code.
  const session: Session = created!;

  session.add(AiRole.System, SYSTEM_PROMPT);
  print("Commands: /reset, /cancel, /quit");

  // A floating task: it runs to the first `await` — the first reply's stream —
  // and parks there. From here the host owns the loop; the entry returns.
  run(session);
}
