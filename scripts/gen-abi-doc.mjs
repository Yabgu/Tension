#!/usr/bin/env node
// Generate the two ABI references from the code that defines them.
//
//   docs/abi/adapter.md   from tension-core/include/tension_adapter.h
//   docs/abi/guest.md     from every import-registration site
//
// ## Why these are generated
//
// An ABI reference that is maintained by hand drifts the moment a slot is
// appended, and the drift is invisible: the prose still reads correctly, the
// offsets are still plausible, and only a reader who checks against the header
// finds out. The header is already the better document — it carries the thread
// rules, the errno contract and the append-only rule in the same place as the
// declarations — so the only thing a companion can add is *tabularity*: which
// slot is at which offset, and which imports a guest can call. Both of those are
// mechanical, so both are generated.
//
// Every claim in the output is derived here, not copied:
//
//   * slot order and signature   — parsed from the struct body
//   * offset                     — computed from the declaration order
//   * "since"                    — the `ABI version N` phrase in the slot's own
//                                  comment, or `—` when the comment does not say
//                                  (a guess would be worse than a blank)
//   * thread rule                — the slot comment's own label
//   * imports                    — `func_wrap` calls in tension-core/src, and the
//                                  `Registration` tables in each adapter
//
// The computed offsets are checked against the header's own `_Static_assert`s
// before anything is written: a generator that silently emits a wrong offset is
// worse than no generator. `scripts/test-abi-docs.mjs` goes one step further and
// compiles a probe that prints `offsetof` for every field.
//
// Usage:
//   node scripts/gen-abi-doc.mjs            write both docs
//   node scripts/gen-abi-doc.mjs --check    exit 1 if either doc is stale
//   node scripts/gen-abi-doc.mjs --stdout   print, write nothing

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO } from './lib/toolchain.mjs';

const HEADER = join(REPO, 'tension-core', 'include', 'tension_adapter.h');
const CORE_SRC = join(REPO, 'tension-core', 'src');
const ADAPTERS = [
  'tension-ogre/src/adapter.cpp',
  // The 2D adapter moved into core in Pass B of the merge; the C++ it came from
  // is kept at `tension-2d/reference/` for the bisect DSO, and that is still the
  // file that declares the ten verb registrations `docs/abi/guest.md` documents.
  // Pass C deletes both, and this entry with them.
  'tension-2d/reference/adapter.cpp',
  'tension-input/src/adapter.cpp',
];
const OUT = join(REPO, 'docs', 'abi');

// ── C parsing ───────────────────────────────────────────────────────────────

/// The body of `typedef struct NAME { ... }`, exclusive of the braces.
function structBody(text, name) {
  const open = text.indexOf(`typedef struct ${name} {`);
  if (open < 0) throw new Error(`no typedef struct ${name} in the header`);
  const start = text.indexOf('{', open);
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated block comment');
      i = end + 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/// Every member, split at statement-level semicolons, each with its comments.
function members(body) {
  const out = [];
  let chunk = '';
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated block comment in a member');
      chunk += body.slice(i, end + 2);
      i = end + 1;
      continue;
    }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ';' && depth === 0) {
      // A comment on the same line belongs to the member that just ended, not
      // to the one that follows: `uint32_t flags; /* reserved */` is a comment
      // about `flags`. Attaching it to `flags` is the difference between a doc
      // that is right and one that is confidently wrong.
      let next = i + 1;
      while (body[next] === ' ' || body[next] === '\t') next += 1;
      if (body[next] === '/' && body[next + 1] === '*') {
        const end = body.indexOf('*/', next + 2);
        if (end < 0) throw new Error('unterminated trailing comment');
        chunk += body.slice(next, end + 2);
        i = end + 1;
      }
      const parsed = parseMember(chunk);
      if (parsed) out.push(parsed);
      chunk = '';
      continue;
    }
    chunk += ch;
  }
  return out;
}

const COMMENT = /\/\*([\s\S]*?)\*\//g;

/// One member: a function pointer or a plain field, plus its comment text.
function parseMember(chunk) {
  const comments = [...chunk.matchAll(COMMENT)].map((m) => m[1]);
  const decl = chunk.replace(COMMENT, ' ').replace(/\s+/g, ' ').trim();
  if (decl === '') return null;

  const fn = /^([A-Za-z_]\w*)\s*\(\s*\*\s*(\w+)\s*\)\s*\(([\s\S]*)\)$/.exec(decl);
  if (fn) {
    return {
      kind: 'fn',
      name: fn[2],
      ret: fn[1],
      params: fn[3].trim(),
      comment: cleanComment(comments),
    };
  }
  const field = /^((?:const\s+)?[A-Za-z_]\w*(?:\s*\*+)?)\s*(\w+)$/.exec(decl);
  if (field) {
    return {
      kind: 'field',
      name: field[2],
      type: field[1].replace(/\s*\*+\s*/, ' *').replace(/\s+/g, ' ').trim(),
      comment: cleanComment(comments),
    };
  }
  throw new Error(`unparsed member: ${decl}`);
}

/// A block comment as a paragraph: leading `*` gutters removed, whitespace
/// collapsed, paragraph breaks kept.
function cleanComment(blocks) {
  const text = blocks
    .join('\n\n')
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

/// What a slot's comment states about its thread rule, if it states one.
///
/// Only explicit labels count. A comment that mentions "render thread" while
/// describing something else must not be read as a rule, which is why this
/// matches labelled forms rather than keywords.
function threadRule(comment) {
  // Order matters: "any thread" is the widest claim, so it wins when a comment
  // states both (a slot callable from anywhere is callable from the guest too).
  if (/\bany[- ]thread\b/i.test(comment)) return 'any';
  if (/\bguest thread\b/i.test(comment)) return 'guest';
  if (/\binterpreter thread\b/i.test(comment)) return 'interpreter';
  // Only a stated call site counts. "A render thread tears down its own
  // objects" describes the thread, not a rule for the slot.
  if (/called (?:by|from|on) the (?:adapter's )?render thread/i.test(comment)) return 'render';
  return '—';
}

/// The ABI version a slot's comment says it was appended under.
function sinceVersion(comment) {
  const m = /\bABI\s+(?:version|v)\s*(\d+)/i.exec(comment);
  return m ? m[1] : '—';
}

/// The first paragraph of a comment — the summary, without the rationale.
function summary(comment) {
  const first = comment.split(/\n\s*\n/)[0] ?? '';
  return first.replace(/\s+/g, ' ').trim();
}

const SIZE_ALIGN = {
  uint32_t: [4, 4],
  int32_t: [4, 4],
  uint64_t: [8, 8],
  int64_t: [8, 8],
  float: [4, 4],
  double: [8, 8],
};

function layout(member) {
  if (member.kind === 'fn') return [8, 8];
  const type = member.type.replace(/\s/g, '');
  if (type.endsWith('*')) return [8, 8];
  const known = SIZE_ALIGN[type];
  if (!known) throw new Error(`no layout for ${type} (${member.name})`);
  return known;
}

/// Assign offsets in declaration order. Returns the members with `offset`, and
/// the struct's size.
function withOffsets(list) {
  let at = 0;
  let align = 1;
  for (const member of list) {
    const [size, memberAlign] = layout(member);
    align = Math.max(align, memberAlign);
    at = Math.ceil(at / memberAlign) * memberAlign;
    member.offset = at;
    at += size;
  }
  return { size: Math.ceil(at / align) * align, align };
}

/// The header pins its own shape; a computed offset that disagrees means this
/// model is wrong and nothing should be written.
function checkAgainstAsserts(header, assertions) {
  // Every shape assertion the header makes, in its own words: the expression
  // between `static_assert(` and the message string. The C++ and C11 branches
  // repeat each one, so they are deduplicated on the normalised expression.
  const seen = new Set();
  for (const m of header.matchAll(/(?:static_assert|_Static_assert)\(\s*([\s\S]*?),\s*\n?\s*"/g)) {
    const expression = m[1].replace(/\s+/g, ' ').trim();
    if (!seen.has(expression)) {
      seen.add(expression);
      assertions.push(expression);
    }
  }

  const sizeAssert = /sizeof\(tension_core_api\)\s*\n?\s*==\s*offsetof\(tension_core_api, user\)\s*\+\s*(\d+)\s*\*\s*sizeof\(void \*\)/;
  const m = sizeAssert.exec(header);
  if (!m) throw new Error('the header no longer pins sizeof(tension_core_api); update this check');
  return { slotsAfterUser: Number(m[1]) };
}

// ── the header's prose sections ─────────────────────────────────────────────

/// A `/* ── title ── */`-delimited section of the header.
function section(header, title) {
  const marker = header.indexOf(title);
  if (marker < 0) throw new Error(`no section titled "${title}"`);
  const start = header.indexOf('/*', marker);
  const end = header.indexOf('/* ──', start + 2);
  return header.slice(start, end < 0 ? header.length : end);
}

/// The numbered list in the "what an adapter must not do" section.
function numberedRules(header) {
  const text = section(header, 'what an adapter must not do');
  const rules = [];
  for (const line of text.split('\n')) {
    const start = /^\s*\*\s+(\d+)\.\s+(.*)$/.exec(line);
    if (start) {
      rules.push({ n: Number(start[1]), text: start[2].trim() });
      continue;
    }
    // A rule that wraps continues on the next commented line. Dropping the
    // second half would truncate the rule at its first clause, which reads as
    // a weaker prohibition than the header states.
    const more = /^\s*\*\s+(\S.*)$/.exec(line);
    if (more && rules.length > 0) {
      rules[rules.length - 1].text += ` ${more[1].trim()}`;
    }
  }
  if (rules.length === 0) throw new Error('the "must not do" list parsed as empty');
  return rules;
}

/// The errno lines in the "error codes at this boundary" section.
function errnoTable(header) {
  const text = section(header, 'error codes at this boundary');
  const rows = [];
  for (const line of text.split('\n')) {
    // `0 success (…)`, `-EINVAL malformed argument, …`. The name column carries
    // the symbolic constant, which is what a shim returns in its comment.
    // The header lists no separate symbolic name: the value *is* the name, and
    // the rest of the line is what it means.
    const m = /^\s*\*\s+(0|-E[A-Z]+)\s+(.*)$/.exec(line);
    if (m) rows.push({ value: m[1], meaning: m[2].trim() });
  }
  if (rows.length === 0) throw new Error('the errno table parsed as empty');
  return rows;
}

// ── Rust: guest imports registered by the core ──────────────────────────────

function rustFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...rustFiles(path));
    else if (entry.name.endsWith('.rs')) out.push(path);
  }
  return out;
}

/// The argument list of the call whose `(` is at `open`, as raw text.
function callText(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error('unterminated func_wrap call');
}

/// Split at depth-0 commas, honouring `<>` so `Caller<'_, HostState>` stays one
/// argument. `->` cannot appear inside an angle-bracket group here, so the
/// `>` of a return arrow never decrements below zero in practice; the guard
/// below keeps it from going negative regardless.
function splitArgs(text) {
  const parts = [];
  let depth = 0;
  let angle = 0;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      current += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    if (ch === '<') angle += 1;
    if (ch === '>' && angle > 0) angle -= 1;
    if (ch === ',' && depth === 0 && angle === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

/// Normalise a Rust type as it crosses the boundary into a value type name.
function rustValueType(type) {
  const t = type.replace(/\s+/g, '');
  const map = { u32: 'i32', i32: 'i32', u64: 'i64', i64: 'i64', f32: 'f32', f64: 'f64', '()': 'void' };
  return map[t] ?? t;
}

function coreImports() {
  const imports = [];
  for (const file of rustFiles(CORE_SRC)) {
    const text = readFileSync(file, 'utf8');
    let from = 0;
    for (;;) {
      const at = text.indexOf('func_wrap(', from);
      if (at < 0) break;
      from = at + 1;
      const open = at + 'func_wrap'.length;
      const call = callText(text, open);
      const strings = [...call.matchAll(/"([^"]*)"/g)].slice(0, 2).map((m) => m[1]);
      if (strings.length < 2) continue;
      const line = text.slice(0, at).split('\n').length;

      const pipe = call.indexOf('|');
      if (pipe < 0) continue;
      const close = call.indexOf('|', pipe + 1);
      if (close < 0) continue;
      const params = splitArgs(call.slice(pipe + 1, close))
        .slice(1) // the first parameter is the caller handle, not a wasm argument
        .map((p) => p.replace(/^\s*mut\s+/, '').split(':').slice(1).join(':').trim())
        .filter((p) => p !== '')
        .map(rustValueType);
      const after = call.slice(close + 1);
      const ret = /^\s*->\s*([^{]+)\{/.exec(after);
      imports.push({
        module: strings[0],
        name: strings[1],
        params,
        ret: ret ? rustValueType(ret[1]) : 'void',
        file: relative(REPO, file).split('\\').join('/'),
        line,
      });
    }
  }
  return imports;
}

/// Memory imports are `define(store, "module", "field", memory)` calls rather
/// than `func_wrap`s, so they are collected separately.
function memoryImports() {
  const text = readFileSync(join(CORE_SRC, 'session', 'mod.rs'), 'utf8');
  const found = new Map();
  for (const m of text.matchAll(/\.define\(\s*&mut\s*\*?\s*\w+\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/g)) {
    const key = `${m[1]}::${m[2]}`;
    if (!found.has(key)) {
      found.set(key, {
        module: m[1],
        name: m[2],
        file: 'tension-core/src/session/mod.rs',
        line: text.slice(0, m.index).split('\n').length,
      });
    }
  }
  return [...found.values()];
}

/// The module name an adapter may not register into, and where that is enforced.
function reservedModule() {
  const file = join(CORE_SRC, 'adapter', 'mod.rs');
  const text = readFileSync(file, 'utf8');
  const m = /const RESERVED_MODULE: &str = "([^"]+)";/.exec(text);
  if (!m) return null;
  const use = /if import\.module == RESERVED_MODULE \{/.exec(text);
  return {
    name: m[1],
    file: 'tension-core/src/adapter/mod.rs',
    line: use ? text.slice(0, use.index).split('\n').length : 0,
  };
}

// ── C++: guest imports registered by a capability ───────────────────────────

function cppImports(relPath) {
  const path = join(REPO, relPath);
  const text = readFileSync(path, 'utf8');

  const moduleMatch = /register_import\(\s*core->user\s*,\s*"([^"]+)"/.exec(text);
  if (!moduleMatch) throw new Error(`${relPath}: no register_import module name`);
  const module = moduleMatch[1];

  const verbIds = new Map();
  for (const m of text.matchAll(/constexpr\s+uint32_t\s+(kVerb\w+)\s*=\s*(\d+)\s*;/g)) {
    verbIds.set(m[1], Number(m[2]));
  }

  // The alias table: `const uint32_t i32 = TENSION_VT_I32;`
  const aliases = new Map();
  for (const m of text.matchAll(/const\s+uint32_t\s+(\w+)\s*=\s*(TENSION_VT_\w+)\s*;/g)) {
    aliases.set(m[1], m[2]);
  }
  const arrays = new Map();
  for (const m of text.matchAll(/const\s+uint32_t\s+(\w+)\[\d*\]\s*=\s*\{([^}]*)\}/g)) {
    arrays.set(
      m[1],
      m[2]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .map((token) => aliases.get(token) ?? token),
    );
  }

  const tableStart = text.indexOf('const Registration registrations[] = {');
  if (tableStart < 0) throw new Error(`${relPath}: no Registration table`);
  const tableEnd = text.indexOf('};', tableStart);
  const table = text.slice(tableStart, tableEnd);

  const entry = /\{\s*"([^"]+)"\s*,\s*(\w+)\s*,\s*(\d+)\s*,\s*(\w+)\s*,\s*(\w+)\s*,\s*([^}]+?)\s*\}/g;
  const imports = [];
  for (const m of table.matchAll(entry)) {
    const [, name, paramsName, nparams, , verbName, flags] = m;
    const params = paramsName === 'nullptr' ? [] : arrays.get(paramsName);
    if (params === undefined) throw new Error(`${relPath}: no array ${paramsName} for ${name}`);
    if (params.length !== Number(nparams)) {
      throw new Error(`${relPath}: ${name} declares ${nparams} params, ${paramsName} has ${params.length}`);
    }
    imports.push({
      module,
      name,
      params: params.map((t) => t.replace('TENSION_VT_', '').toLowerCase()),
      ret: 'i32',
      verb: verbIds.get(verbName) ?? null,
      flags: flags === '0' ? [] : flags.split('|').map((f) => f.trim().replace('TENSION_IMPORT_', '')),
      file: relPath,
      line: text.slice(0, tableStart + m.index).split('\n').length,
    });
  }
  if (imports.length === 0) throw new Error(`${relPath}: the Registration table parsed as empty`);
  return imports;
}

// ── rendering ───────────────────────────────────────────────────────────────

const CODE = (s) => `\`${s}\``;

function signature(slot) {
  if (slot.kind === 'field') {
    return slot.type.endsWith('*') ? `${slot.type}${slot.name}` : `${slot.type} ${slot.name}`;
  }
  const params = slot.params
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== 'void')
    .join(', ');
  return `${slot.ret} ${slot.name}(${params || 'void'})`;
}

function slotTable(list) {
  const lines = [
    '| # | offset | slot | signature | thread | since |',
    '|---|---|---|---|---|---|',
  ];
  let index = 0;
  for (const slot of list) {
    if (slot.kind === 'field') {
      lines.push(`| — | ${slot.offset} | ${CODE(slot.name)} | ${CODE(signature(slot))} | — | — |`);
      continue;
    }
    lines.push(
      `| ${index} | ${slot.offset} | ${CODE(slot.name)} | ${CODE(signature(slot))} | ${slot.thread} | ${slot.since} |`,
    );
    index += 1;
  }
  return lines.join('\n');
}

function slotNotes(list) {
  const out = [];
  let index = 0;
  for (const slot of list) {
    const label = slot.kind === 'field' ? slot.name : `${index}. ${slot.name}`;
    if (slot.kind === 'fn') index += 1;
    out.push(slot.summary ? `**${label}** — ${slot.summary}` : `**${label}** — no comment in the header`);

  }
  return out.join('\n\n');
}

function annotate(list) {
  for (const slot of list) {
    slot.thread = threadRule(slot.comment);
    slot.since = sinceVersion(slot.comment);
    slot.summary = summary(slot.comment);
  }
}

function renderAdapterDoc(header, core, coreSize, adapter, adapterSize, rules, errnos, assertions) {
  const version = /#define\s+TENSION_ADAPTER_ABI_VERSION\s+(\d+)u/.exec(header)?.[1];
  if (!version) throw new Error('no TENSION_ADAPTER_ABI_VERSION');

  const lines = [];
  lines.push('# Adapter ABI');
  lines.push('');
  lines.push('<!-- GENERATED by scripts/gen-abi-doc.mjs — do not edit by hand. -->');
  lines.push('<!-- Source of truth: tension-core/include/tension_adapter.h -->');
  lines.push('');
  lines.push(`ABI version **${version}**. \`tension_core_api\` is **${coreSize} bytes**,`);
  lines.push(`\`tension_adapter\` is **${adapterSize} bytes**, on a 64-bit target.`);
  lines.push('');
  lines.push('This page is a projection of the header, not an independent statement of');
  lines.push('the contract. What it projects: the per-slot comments, the thread labels,');
  lines.push('the error codes, "What an adapter must not do", and the shape assertions —');
  lines.push('and the offsets, computed from declaration order. What it does not project:');
  lines.push('the numbered `Rules` block, including rule 11 (append-only within an ABI');
  lines.push('version). Rule 11 and every other rule live in the header and nowhere else.');
  lines.push('If this page and the header disagree, the header is right and this generator');
  lines.push('is wrong. `npm test` runs the drift check.');
  lines.push('');
  lines.push('## `tension_core_api` — what the host provides an adapter');
  lines.push('');
  lines.push(slotTable(core));
  lines.push('');
  lines.push('Thread column: `any` is rule 7 (any thread, no guest memory); `guest` is');
  lines.push('inside a guest-initiated call; `interpreter` is the thread that loads and');
  lines.push('tears down adapters; `—` means the slot\'s own comment does not label it.');
  lines.push('Since column: the version the slot\'s comment says it was appended under, or');
  lines.push('`—` where the comment does not say — a blank is honest, a guess is not.');
  lines.push('');
  lines.push('### Slot notes');
  lines.push('');
  lines.push(slotNotes(core));
  lines.push('');
  lines.push('## `tension_adapter` — what an adapter provides the host');
  lines.push('');
  lines.push(slotTable(adapter));
  lines.push('');
  lines.push('### Slot notes');
  lines.push('');
  lines.push(slotNotes(adapter));
  lines.push('');
  lines.push('## Error codes');
  lines.push('');
  lines.push('| value | meaning |');
  lines.push('|---|---|');
  for (const row of errnos) lines.push(`| ${CODE(row.value)} | ${row.meaning} |`);
  lines.push('');
  lines.push('## What an adapter must not do');
  lines.push('');
  for (const rule of rules) lines.push(`${rule.n}. ${rule.text}`);
  lines.push('');
  if (assertions.length) {
    lines.push('## Shape assertions the header makes');
    lines.push('');
    lines.push('These are the header\'s own `_Static_assert`/`static_assert` expressions,');
    lines.push('deduplicated across its C++ and C11 branches. They compile, so they are');
    lines.push('the one part of this contract the toolchain checks on every build.');
    lines.push('');
    for (const assertion of assertions) lines.push(`- \`${assertion}\``);
    lines.push('');
  }
  return lines.join('\n');
}

function valueCell(params, ret) {
  const join = params.length ? params.join(', ') : 'void';
  return ret === 'void' ? `(${join})` : `(${join}) → ${ret}`;
}

/// One row per (module, import).
///
/// Since the 2D merge a module can be registered twice: `tension::2d` is ten
/// `func_wrap`s in core *and* the ten rows of the pre-port adapter kept at
/// `tension-2d/reference/` for the bisect DSO. Both are real, and a table that
/// lists each verb twice is a table a reader cannot trust. The capability row
/// wins because it carries the verb id and the import flags — the wire contract,
/// which the in-core registration does not spell out — and the module's heading
/// says it lives in both places.
///
/// The counts in the page's own header are computed from this, not from the raw
/// lists, so the number matches the rows a reader can count.
function mergeImports(rawCore, rawCapability) {
  const byKey = new Map();
  for (const entry of rawCore) byKey.set(`${entry.module}:${entry.name}`, entry);
  for (const entry of rawCapability) byKey.set(`${entry.module}:${entry.name}`, entry);
  const merged = [...byKey.values()];
  const core = merged.filter((entry) => entry.verb === undefined);
  const capability = merged.filter((entry) => entry.verb !== undefined);
  // Read from the *raw* lists: after the merge the duplicated rows are gone, so
  // asking the split lists whether a module appears twice cannot answer.
  const coreModules = new Set(rawCore.map((entry) => entry.module));
  const capabilityModules = new Set(rawCapability.map((entry) => entry.module));
  const dualModules = new Set(
    [...coreModules].filter((module) => capabilityModules.has(module)),
  );
  return { core, capability, dualModules };
}

function renderGuestDoc(core, capability, memory, reserved, dualModules) {
  const lines = [];
  lines.push('# Guest ABI');
  lines.push('');
  lines.push('<!-- GENERATED by scripts/gen-abi-doc.mjs — do not edit by hand. -->');
  lines.push('<!-- Sources: every Linker::func_wrap call in tension-core/src, and every');
  lines.push('     Registration table in a capability adapter. -->');
  lines.push('');
  lines.push('Every import a WebAssembly guest can call, grouped by module. These are the');
  lines.push('only things the host offers: a guest that imports anything else fails at');
  lines.push('instantiation, and that failure is the intended one.');
  lines.push('');
  const coreModules = new Set(core.map((e) => e.module));
  const capabilityModules = new Set(capability.map((e) => e.module));
  lines.push(
    `${core.length + capability.length} imports across ${new Set([...coreModules, ...capabilityModules]).size} modules: ` +
      `${core.length} registered by the host in ${coreModules.size} modules, ` +
      `${capability.length} by ${capabilityModules.size} capability adapters.`,
  );
  lines.push('');
  lines.push('A **capability** module is present only when its shared object is loaded');
  lines.push('with `--capability`; the core modules are always present. Signatures are');
  lines.push('written in WebAssembly value types, which is what a guest sees: a Rust');
  lines.push('`u32` and a Rust `i32` are both `i32` here.');
  if (dualModules.size > 0) {
    lines.push('');
    lines.push(
      `A module marked *core, and a capability on the bisect path* (${[...dualModules]
        .map((m) => `\`${m}\``)
        .join(', ')}) is registered by the host in the default build, so it is always`);
    lines.push('present. The same ten imports are also the surface of a capability DSO,');
    lines.push('built from `tension-2d/reference/` for a `--no-default-features` bisect;');
    lines.push('the rows below carry that adapter\'s verb ids and flags, which the in-core');
    lines.push('registration does not spell out.');
  }
  lines.push('');
  lines.push('This page states signatures, not errno contracts. An import that can refuse');
  lines.push('says how in its own shim; the shared codes are in');
  lines.push('[`adapter.md`](adapter.md#error-codes).');
  lines.push('');

  const byModule = new Map();
  for (const entry of [...core, ...capability]) {
    if (!byModule.has(entry.module)) byModule.set(entry.module, []);
    byModule.get(entry.module).push(entry);
  }
  const order = [...byModule.keys()].sort((a, b) => a.localeCompare(b));

  for (const module of order) {
    if (dualModules.has(module)) {
      lines.push(`## \`${module}\` — core, and a capability on the bisect path`);
    } else {
      lines.push(capabilityModules.has(module) ? `## \`${module}\` — capability` : `## \`${module}\``);
    }
    lines.push('');
    const capabilityEntries = byModule.get(module).filter((e) => e.verb !== undefined);
    const hasVerb = capabilityEntries.length > 0;
    lines.push(
      hasVerb
        ? '| import | signature | verb | flags | registered at |'
        : '| import | signature | registered at |',
    );
    lines.push(hasVerb ? '|---|---|---|---|---|' : '|---|---|---|');
    const rows = hasVerb
      ? [...byModule.get(module)].sort((a, b) => (a.verb ?? 0) - (b.verb ?? 0))
      : byModule.get(module);
    for (const entry of rows) {
      const where = `${CODE(`${entry.file}:${entry.line}`)}`;
      const sig = CODE(valueCell(entry.params, entry.ret));
      if (hasVerb) {
        const verb = entry.verb === null || entry.verb === undefined ? '—' : String(entry.verb);
        const flags = entry.flags && entry.flags.length ? entry.flags.join(', ') : '—';
        lines.push(`| ${CODE(entry.name)} | ${sig} | ${verb} | ${flags} | ${where} |`);
      } else {
        lines.push(`| ${CODE(entry.name)} | ${sig} | ${where} |`);
      }
    }
    lines.push('');
    if (reserved && module === reserved.name) {
      lines.push(`The \`${module}\` module is reserved: these verbs are the host's own. An`);
      lines.push(`adapter that tries to register here is refused at load (\`${reserved.file}:${reserved.line}\`).`);
      lines.push('');
    }
  }

  lines.push('## Memory');
  lines.push('');
  lines.push('| import | what it is | registered at |');
  lines.push('|---|---|---|');
  for (const entry of memory) {
    lines.push(
      `| ${CODE(`${entry.module}::${entry.name}`)} | the session arena, under both names the toolchains emit | ${CODE(`${entry.file}:${entry.line}`)} |`,
    );
  }
  lines.push('');
  lines.push('`env::memory` and `session::memory` are the same memory: the session defines');
  lines.push('it under both names so a guest built by either toolchain resolves it. A');
  lines.push('guest without it is refused at load, not at the first call.');
  lines.push('');
  return lines.join('\n');
}

// ── main ────────────────────────────────────────────────────────────────────

function build() {
  const header = readFileSync(HEADER, 'utf8');
  const assertions = [];
  const pinned = checkAgainstAsserts(header, assertions);

  const coreMembers = members(structBody(header, 'tension_core_api'));
  const core = withOffsets(coreMembers);
  const adapterMembers = members(structBody(header, 'tension_adapter'));
  const adapter = withOffsets(adapterMembers);

  // The header's own assertion is the cross-check on this model.
  const postSlots = coreMembers.filter((m) => m.kind === 'fn').length;
  if (postSlots + 1 !== pinned.slotsAfterUser) {
    throw new Error(
      `the header pins ${pinned.slotsAfterUser} pointer-sized slots after abi_version, ` +
        `which is user + 25 functions; this parse found ${postSlots} functions`,
    );
  }
  const last = coreMembers[coreMembers.length - 1];
  const assertedLast = /offsetof\(tension_core_api,\s*(\w+)\)\s*\+\s*sizeof/.exec(header)?.[1];
  if (assertedLast && assertedLast !== last.name) {
    throw new Error(`the header pins ${assertedLast} as last, this parse ends at ${last.name}`);
  }
  if (postSlots === 26 && core.size !== 224) {
    throw new Error(`computed sizeof(tension_core_api) = ${core.size}, the header pins 224`);
  }

  annotate(coreMembers);
  annotate(adapterMembers);

  const rules = numberedRules(header);
  const errnos = errnoTable(header);

  const rawCore = coreImports();
  const rawCapability = ADAPTERS.flatMap((path) => cppImports(path));
  const { core: coreImportsList, capability: capabilityImports, dualModules } =
    mergeImports(rawCore, rawCapability);
  const memory = memoryImports();

  return {
    adapterDoc: renderAdapterDoc(header, coreMembers, core.size, adapterMembers, adapter.size, rules, errnos, assertions),
    guestDoc: renderGuestDoc(coreImportsList, capabilityImports, memory, reservedModule(), dualModules),
    fields: {
      tension_core_api: coreMembers.map((m) => ({ name: m.name, offset: m.offset })),
      tension_adapter: adapterMembers.map((m) => ({ name: m.name, offset: m.offset })),
    },
    sizes: { tension_core_api: core.size, tension_adapter: adapter.size },
    counts: {
      core: coreImportsList.length,
      capability: capabilityImports.length,
      memory: memory.length,
      modules: new Set([...coreImportsList, ...capabilityImports].map((e) => e.module)).size,
    },
  };
}

const check = process.argv.includes('--check');
const stdout = process.argv.includes('--stdout');
const built = build();

// The field/offset table, for `test-abi-docs.mjs` to compare against a C
// probe's `offsetof` — the doc's numbers are only trustworthy if something
// other than the generator agrees with them.
if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ fields: built.fields, sizes: built.sizes }, null, 2) + '\n');
  process.exit(0);
}

if (stdout) {
  process.stdout.write(built.adapterDoc);
  process.stdout.write('\n─────\n\n');
  process.stdout.write(built.guestDoc);
  process.exit(0);
}

const targets = [
  ['adapter', join(OUT, 'adapter.md'), built.adapterDoc],
  ['guest', join(OUT, 'guest.md'), built.guestDoc],
];

if (check) {
  let stale = 0;
  for (const [name, path, content] of targets) {
    let existing = '';
    try {
      existing = readFileSync(path, 'utf8');
    } catch {
      console.error(`abi-docs: ${relative(REPO, path)} is missing — run npm run docs:abi`);
      stale += 1;
      continue;
    }
    if (existing !== content) {
      const a = existing.split('\n');
      const b = content.split('\n');
      let line = 0;
      while (line < Math.min(a.length, b.length) && a[line] === b[line]) line += 1;
      console.error(
        `abi-docs: ${relative(REPO, path)} is stale at line ${line + 1}\n` +
          `  on disk: ${JSON.stringify(a[line] ?? '<end of file>')}\n` +
          `  from src: ${JSON.stringify(b[line] ?? '<end of file>')}`,
      );
      stale += 1;
    } else {
      console.log(`abi-docs: ${relative(REPO, path)} is current (${name})`);
    }
  }
  if (stale > 0) {
    console.error('abi-docs: run `npm run docs:abi` to regenerate');
    process.exit(1);
  }
  process.exit(0);
}

for (const [, path, content] of targets) {
  writeFileSync(path, content);
  console.log(`wrote ${relative(REPO, path)}`);
}
console.log(
  `abi-docs: ${built.counts.core} core imports, ${built.counts.capability} capability imports, ` +
    `${built.counts.memory} memory imports, ${built.counts.modules} modules`,
);
