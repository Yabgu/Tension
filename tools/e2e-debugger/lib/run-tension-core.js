// Spawn `tension-core` with a deadline and capture both streams.
//
// A guest is a real program: an OGRE example can keep a window open, and a
// broken guest can loop. The deadline is enforced by killing the process, and
// that outcome is reported as "still running", not as a pass with a footnote.

import { spawn } from "node:child_process";

import { libraryPath } from "./resolve.js";

/**
 * @param {{
 *   binary: string,
 *   args: string[],
 *   cwd: string,
 *   timeoutMs: number,
 *   env?: Record<string, string>,
 * }} options
 * @returns {Promise<{timedOut: boolean, code: number|null, signal: string|null,
 *                    stdout: string, stderr: string}>}
 */
export function runTensionCore({ binary, args, cwd, timeoutMs, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LD_LIBRARY_PATH: libraryPath(),
        ...env,
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut, code, signal, stdout, stderr });
    };

    child.on("error", (error) => {
      stderr += `\n[e2e] could not spawn ${binary}: ${error.message}\n`;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/// The `--flag` named by a host rejection. Used so a failure message points at
/// the launch.json line to fix, not at a wall of usage text.
export function unknownFlagIn(stderr) {
  for (const line of stderr.split("\n")) {
    const lower = line.toLowerCase();
    const rejected =
      lower.includes("unknown option") ||
      lower.includes("unknown flag") ||
      lower.includes("unrecognized") ||
      lower.includes("unexpected argument");
    if (!rejected) continue;
    const quoted = line.match(/`([^`]+)`/);
    return quoted ? quoted[1] : line.trim();
  }
  return null;
}

/// Did the host stop because the guest it was given is not there? This is the
/// success condition for launch mode: the flags were accepted and only the
/// deliberately-missing file ended the run.
export function reportsMissingGuest(stderr) {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("does not exist") ||
    lower.includes("no such file") ||
    lower.includes("file not found") ||
    lower.includes("failed to load")
  );
}
