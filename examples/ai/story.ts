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

import { arg, argCount, print, readLine, write } from "tension-framework";
import { AiConfig, AiRole, Session } from "tension-framework";

const SYSTEM_PROMPT =
  "You narrate a terse, atmospheric text adventure. Reply in at most two sentences.";

export function _start_game(): void {
  print("=== TensionCore AI demo ===");

  if (argCount() < 1) {
    print("usage: tension-core ai/build/story.wasm <model.gguf>");
    print("(the host requires a model key; the headless fallback ignores its value)");
    return;
  }
  const modelPath = arg(0);
  print("model> " + modelPath);

  const cfg = new AiConfig().modelPath(modelPath).contextSize(2048).maxTokens(256).temp(0.8);
  print("loading model (this blocks until the weights are in; a few seconds) ...");
  const session = Session.create(cfg);
  if (session === null) {
    print("(session_create failed — the host refused the configuration)");
    return;
  }

  session.add(AiRole.System, SYSTEM_PROMPT);
  print("Commands: /reset, /cancel, /quit");

  while (true) {
    print("");
    write("you> ");
    const line = readLine();
    if (line === null) break; // stdin closed

    const text = line.trim();
    if (text.length == 0) continue;
    if (text == "/quit") break;
    if (text == "/reset") {
      print(session.reset() ? "(history cleared)" : "(cannot reset while generating)");
      continue;
    }
    if (text == "/cancel") {
      print(session.cancel() ? "(cancelled)" : "(nothing in flight)");
      continue;
    }

    session.add(AiRole.User, text);
    if (!session.generate()) {
      print("(generate refused — drain the previous reply or cancel first)");
      continue;
    }

    write("ai> ");
    // The host generates on its own thread, so poll: print whatever has
    // arrived, then ask whether it is still working.
    while (session.state() == 1) {
      const chunk = session.read();
      if (chunk.length > 0) write(chunk);
    }
    const tail = session.read(); // final drain once the state flips to idle
    if (tail.length > 0) write(tail);
    print("");
  }

  session.close();
  print("--- end ---");
}
