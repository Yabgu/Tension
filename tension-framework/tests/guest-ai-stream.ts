// tension-framework/tests/guest-ai-stream.ts — the AI stream's controls.
//
// Four negative controls, each printing what it measured. `run.sh` runs it
// twice: once against a normal generation (controls 2-4), and once with
// `TENSION_AI_STUB_STALL_MS` set (control 1), where the adapter produces
// nothing and posts AI_ERROR from a thread after a delay.
//
// The contract under test is the one the wrapper promises:
//
//   AI_READY  -> unread byte count, always > 0
//   AI_DONE   -> 0
//   AI_ERROR  -> -EIO
//
// decided by the **delivered class**, never by the payload.
//
// This guest awaits `rt.streamTask` rather than `rt.stream` on purpose: the
// controls need the record's class, and `rt.stream` returns only the classified
// i32. The classification the wrapper performs is asserted separately (control
// 3 checks that a DONE carries class AI_DONE *and* payload 0, which is what
// makes `0` mean done rather than "an empty chunk").

import { arg, argCount, print } from "../assembly/io";
import {
  CLASS_AI_DONE,
  CLASS_AI_ERROR,
  CLASS_AI_READY,
  ConfigBuilder,
  RuntimeSession,
  rt
} from "../assembly/runtime";
import { AiConfig, AiRole, Session } from "../assembly/ai";
import { Task } from "~lib/task";
import { __taskBindTable } from "~lib/task-rt";
export { __taskWake, __taskResume, __taskFail } from "~lib/task-rt";

/// Whether this run is the stalled-stream control.
let stallMode: bool = false;
/// The REPL-shaped driver's exit flag.
let finished: bool = false;
/// Observations, printed once at the end so the runner can assert on them.
let readyWakes: i32 = 0;
let firstReadyPayload: i32 = 0;
let sawDone: bool = false;
let sawError: bool = false;
let errorClass: i32 = -1;
let dropped: i32 = -1;
let bytes: i32 = 0;

/// Control 1: the stream produces nothing, then an error arrives.
async function stalled(session: Session): void {
  // Ask for a generation the adapter stalls: it appends nothing and settles
  // nothing, so there is no completion to find — only its delayed error post can
  // wake the parked task. (`generate` is what arms the stall; a guest that never
  // called it would park on a session no producer knows about.)
  session.add(AiRole.User, "stall");
  if (!session.generate()) {
    print("C1 FAIL: generate refused");
    finished = true;
    return;
  }

  let cls: i32 = 0;
  let payload: i32 = 0;
  const task: Task<i32> = rt.streamTask(session.handle());
  payload = await task;
  cls = task._record.class_;

  if (cls == CLASS_AI_ERROR) {
    sawError = true;
    errorClass = cls;
    print("C1 stall: woke with class AI_ERROR, payload " + payload.toString());
  } else {
    print("C1 FAIL: woke with class " + cls.toString() + ", payload " + payload.toString());
  }
  finished = true;
}

/// Controls 2-4: a normal generation.
async function streaming(session: Session): void {
  session.add(AiRole.User, "controls");
  if (!session.generate()) {
    print("FAIL: generate refused");
    finished = true;
    return;
  }

  // Declared before the first park, typed: the transform's rules.
  let cls: i32 = 0;
  let payload: i32 = 0;
  let streaming: bool = true;
  while (streaming) {
    const task: Task<i32> = rt.streamTask(session.handle());
    payload = await task;
    cls = task._record.class_;

    if (cls == CLASS_AI_READY) {
      // Control 2: how many wakes a burst produced, and how much one of them
      // brought back. The stub appends four pieces; a coalescing host posts one
      // READY, and `read()` drains everything the pieces added.
      readyWakes++;
      if (firstReadyPayload == 0) firstReadyPayload = payload;
      const chunk: string = session.read();
      bytes += chunk.length;
    } else if (cls == CLASS_AI_DONE) {
      // Control 3: done is a *class*, and its payload is 0 — never a
      // zero-length READY, which the host cannot post (it signals only after an
      // append) and which the guest would otherwise read as data.
      sawDone = true;
      if (payload != 0) print("C3 FAIL: AI_DONE carried payload " + payload.toString());
      streaming = false;
    } else {
      // Any other class here — AI_ERROR, or a foreign one — is a failure of the
      // control, not of the stream.
      print("FAIL: unexpected class " + cls.toString() + " payload " + payload.toString());
      streaming = false;
    }
  }

  // Control 4: the ring invariant. Coalescing leaves at most one record per
  // session outstanding, so a healthy stream never drops — the AI classes'
  // `dropped` counters must still be 0.
  dropped = rt.aiDropped();
  finished = true;
}

export function _start_game(): void {
  rt.start();
  __taskBindTable(16);

  const callbacks = rt.callbacks();
  const opened = RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks);
  if (opened != 0) {
    print("FAIL: session refused to open (" + opened.toString() + ")");
    return;
  }

  // The model path is the guest's first argument; the stub ignores its value.
  if (argCount() < 1) {
    print("FAIL: no model path");
    RuntimeSession.close();
    return;
  }
  if (argCount() > 1 && arg(1) == "stall") stallMode = true;

  const cfg = new AiConfig().modelPath(arg(0)).contextSize(512).maxTokens(64);
  const created: Session | null = Session.create(cfg);
  if (created === null) {
    print("FAIL: session_create refused");
    RuntimeSession.close();
    return;
  }
  const session: Session = created!;

  if (stallMode) {
    stalled(session);
  } else {
    streaming(session);
  }

  reportOnFinish(session);
}

export function _game_running(): i32 {
  return finished ? 0 : 1;
}

async function reportOnFinish(session: Session): void {
  while (!finished) {
    await rt.frame();
  }

  if (stallMode) {
    print(stallMode && sawError && errorClass == CLASS_AI_ERROR
      ? "C1 stall: PASS"
      : "C1 stall: FAIL");
  } else {
    // C2: exactly one wake for a four-piece burst.
    print("C2 coalescing: readyWakes=" + readyWakes.toString() +
          " firstPayload=" + firstReadyPayload.toString() +
          " bytesRead=" + bytes.toString() +
          (readyWakes == 1 ? ": PASS" : ": FAIL"));
    // C3: the terminal was a class, with a zero payload.
    print("C3 done-vs-empty: sawDone=" + (sawDone ? "yes" : "no") +
          (sawDone ? ": PASS" : ": FAIL"));
    // C4: nothing dropped.
    print("C4 ring: dropped=" + dropped.toString() + (dropped == 0 ? ": PASS" : ": FAIL"));
  }

  session.close();
  print("OK");
}
