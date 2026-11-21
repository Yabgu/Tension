// One worker thread in the conformance pool: take a case index, run it, post the
// row back. It holds no state the runner does not also hold, so a worker that
// dies costs the case it was running and nothing else.
//
// The classification itself is `lib/cases.js` — the same module the serial path
// imports — so `--workers 1` and `--workers 8` cannot disagree about what a
// verdict means.

import { parentPort, workerData } from "node:worker_threads";

import { runCase } from "./cases.js";

parentPort.on("message", (message) => {
  if (message.type === "stop") {
    parentPort.close();
    return;
  }
  const { index, testCase } = message;
  let result;
  try {
    result = runCase(workerData.context, testCase);
  } catch (error) {
    result = {
      ...testCase,
      verdict: "error",
      reason: "harness-error",
      detail: String(error && error.message ? error.message : error).split("\n")[0],
      breakpoint: null,
    };
  }
  parentPort.postMessage({ type: "result", index, result });
});
