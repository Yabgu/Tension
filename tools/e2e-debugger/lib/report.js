// Pass / skip / fail bookkeeping and the output shape.
//
// Two rules the format enforces:
//   * a skip always prints `skipped [<mode>] <example> — <reason>` on stdout,
//     so a run that skipped half its inputs says so in its own output;
//   * failures go to stderr as well as the summary, so `--check 2>&1 | tail`
//     shows what broke.

const MODE_ORDER = ["launch", "smoke", "debug"];

/// The one line a reader needs from a process's output. Engine diagnostics come
/// after a block of `[tension-core] debug:` chatter, so the first non-empty line
/// is usually noise; prefer the sentence that says what went wrong.
export function firstLineOf(text) {
  const lines = String(text)
    .split("\n")
    .filter((entry) => entry.trim().length > 0);
  const diagnostic = lines.find((entry) => /^\s*(Error|error|FAILURE)\b/.test(entry));
  const chosen = diagnostic ?? lines[0];
  return chosen ? chosen.trim().slice(0, 200) : "(no output)";
}

export function createReport() {
  const results = [];

  return {
    pass(mode, example, detail = "") {
      results.push({ mode, example, status: "pass", detail });
    },
    skip(mode, example, reason) {
      if (!reason) throw new Error(`${mode}/${example}: a skip needs a reason`);
      results.push({ mode, example, status: "skip", reason });
      console.log(`skipped [${mode}] ${example} — ${reason}`);
    },
    fail(mode, example, reason) {
      if (!reason) throw new Error(`${mode}/${example}: a failure needs a reason`);
      results.push({ mode, example, status: "fail", reason });
      console.error(`FAIL [${mode}] ${example} — ${reason}`);
    },
    /// A case that could not be attributed to one example (nothing to run at
    /// all). Counted as a skip so the summary stays honest, printed once.
    skipAll(mode, reason) {
      results.push({ mode, example: "(all)", status: "skip", reason });
      console.log(`skipped [${mode}] (all) — ${reason}`);
    },

    results,
    count(mode, status) {
      return results.filter((entry) => entry.mode === mode && entry.status === status).length;
    },
    failures() {
      return results.filter((entry) => entry.status === "fail");
    },

    summary() {
      const lines = [];
      for (const mode of MODE_ORDER) {
        const entries = results.filter((entry) => entry.mode === mode);
        if (entries.length === 0) {
          lines.push(`${mode.padEnd(6)} not run`);
          continue;
        }
        const pass = this.count(mode, "pass");
        const skip = this.count(mode, "skip");
        const fail = this.count(mode, "fail");
        lines.push(`${mode.padEnd(6)} pass=${pass} skip=${skip} fail=${fail}`);
      }
      const fail = this.failures().length;
      lines.push("");
      lines.push(
        fail === 0
          ? `e2e: ${results.length} case(s), 0 failure(s)`
          : `e2e: ${results.length} case(s), ${fail} failure(s)`
      );
      return lines.join("\n");
    },
  };
}
