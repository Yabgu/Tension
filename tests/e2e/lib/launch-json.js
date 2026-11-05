// Read VS Code `launch.json` files, which are JSONC: `JSON.parse` rejects the
// comments these files are full of, and Node ships no JSONC parser. The
// stripper below is the minimum that handles what VS Code writes — `//` and
// `/* */` comments and trailing commas — while respecting string literals so a
// `//` inside a path is not mistaken for a comment.

import fs from "node:fs";
import path from "node:path";

/// Remove comments and trailing commas, leaving a string `JSON.parse` accepts.
export function stripJsonc(text) {
  const chars = [...text];
  let out = "";
  let index = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (index < chars.length) {
    const char = chars[index];
    const next = chars[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      index += 1;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }

  // Trailing commas: a `,` followed only by whitespace and then `]` or `}`.
  const cleaned = [...out];
  let result = "";
  for (let position = 0; position < cleaned.length; position += 1) {
    const char = cleaned[position];
    if (char === ",") {
      let lookahead = position + 1;
      while (lookahead < cleaned.length && /\s/.test(cleaned[lookahead])) lookahead += 1;
      if (cleaned[lookahead] === "]" || cleaned[lookahead] === "}") continue;
    }
    result += char;
  }
  return result;
}

export function parseJsonc(text, label = "JSONC") {
  try {
    return JSON.parse(stripJsonc(text));
  } catch (error) {
    throw new Error(`${label}: not valid JSONC after stripping comments: ${error.message}`);
  }
}

/// The configurations declared by an example's `.vscode/launch.json`.
/// `[]` when the example has no launch file — that is a skip, not an error.
export function readLaunchConfigs(exampleDir) {
  const file = path.join(exampleDir, ".vscode", "launch.json");
  if (!fs.existsSync(file)) return [];
  const parsed = parseJsonc(fs.readFileSync(file, "utf8"), file);
  return Array.isArray(parsed.configurations) ? parsed.configurations : [];
}

/// VS Code's `${workspaceFolder}` is the example directory, because that is the
/// folder the example is opened as. This is the only variable the examples use.
export function expand(value, workspaceDir) {
  return String(value).split("${workspaceFolder}").join(workspaceDir);
}

/// Any variable left after expansion. The runner reports these rather than
/// guessing what VS Code would have substituted.
export function unexpandedVariables(value) {
  const matches = String(value).match(/\$\{[^}]+\}/g);
  return matches ?? [];
}

/// The args of one configuration, expanded, and the guest path separated out.
///
/// The guest is the argument ending in `.wasm` that is not itself the value of
/// an option (`--res foo.wasm` would be a resource pak, not the guest).
export function expandArgs(configuration, workspaceDir) {
  const raw = Array.isArray(configuration.args) ? configuration.args : [];
  const args = raw.map((value) => expand(value, workspaceDir));
  let guestIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const previous = args[index - 1];
    if (previous && previous.startsWith("--")) continue;
    if (args[index].endsWith(".wasm")) guestIndex = index;
  }
  return { args, guestIndex };
}

/// Options whose value must exist on disk for the example to start. A missing
/// `--res` pak is a checkout that has not been packed, which is reported as a
/// named skip rather than as a crash.
export const INPUT_FLAGS = ["--res", "--capability", "--symbol-path"];

export function missingDeclaredInput(args) {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (!INPUT_FLAGS.includes(args[index])) continue;
    const value = args[index + 1];
    if (value.startsWith("-")) continue;
    if (!fs.existsSync(value)) return `${args[index]} ${value}`;
  }
  return null;
}
