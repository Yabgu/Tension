#!/usr/bin/env node
// Phase B/C measurement: ask lldb for a breakpoint on one source line, and
// record exactly where it bound.
//
//   node phase-b-measure.mjs --guest <wasm> --file <name.ts> --line <n> \
//                            [--out result.json] [--lldb <path>] [--host <exe>] \
//                            [--host-arg <a> ...]
//
// Everything is compared inside ONE lldb run, because the JIT image's load
// address changes between runs: the breakpoint's bound PC and the line table's
// row addresses are only comparable when they come from the same process.
//
// The question, stated so it can fail: did the stop land on a row whose source
// line is the requested one, or on some other row?

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const args = { hostArg: [] };
  for (let i = 0; i < argv.length; ++i) {
    const a = argv[i];
    if (a === '--guest') args.guest = argv[++i];
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--line') args.line = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--lldb') args.lldb = argv[++i];
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--host-arg') args.hostArg.push(argv[++i]);
    else if (a === '--symbol-path') args.symbolPath = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.guest || !args.file || !Number.isFinite(args.line)) {
    throw new Error('--guest, --file and --line are required');
  }
  return args;
}

const DRIVER = String.raw`
import lldb, json

REQUESTED_LINE = __LINE__
FILE_NAME = __FILE__
out = {"requestedLine": REQUESTED_LINE, "file": FILE_NAME}

dbg = lldb.debugger
target = dbg.GetSelectedTarget()
process = target.GetProcess()

def fname(le):
    try:
        return le.GetFileSpec().GetFilename() or ""
    except Exception:
        return ""

out["state"] = process.GetState()
out["stopped"] = process.GetState() == lldb.eStateStopped
out["stop"] = None
if out["stopped"]:
    th = process.GetSelectedThread()
    fr = th.GetFrameAtIndex(0)
    le = fr.GetLineEntry()
    out["stop"] = {
        "pc": fr.GetPC(),
        "pc_hex": "0x%x" % fr.GetPC(),
        "function": fr.GetFunctionName() or "",
        "file": fname(le) if le and le.IsValid() else "",
        "line": (le.GetLine() or 0) if le and le.IsValid() else 0,
        "column": (le.GetColumn() or 0) if le and le.IsValid() else 0,
        "hit_breakpoint": th.GetStopReason() == lldb.eStopReasonBreakpoint,
    }

bps = []
for i in range(target.GetNumBreakpoints()):
    bp = target.GetBreakpointAtIndex(i)
    locs = []
    for j in range(bp.GetNumLocations()):
        loc = bp.GetLocationAtIndex(j)
        addr = loc.GetAddress()
        le = addr.GetLineEntry() if addr and addr.IsValid() else None
        locs.append({
            "resolved": bool(loc.IsResolved()),
            "load_address": addr.GetLoadAddress(target) if addr and addr.IsValid() else 0,
            "line": (le.GetLine() or 0) if le and le.IsValid() else 0,
        })
    bps.append({"id": bp.GetID(), "num_locations": bp.GetNumLocations(), "locations": locs})
out["breakpoints"] = bps

# The registered line table for this file, in the order lldb holds it.
rows = []
jit = None
for i in range(target.GetNumModules()):
    m = target.GetModuleAtIndex(i)
    name = m.GetFileSpec().GetFilename() or ""
    if not name.startswith("JIT("):
        continue
    jit = {"name": name, "num_compile_units": m.GetNumCompileUnits()}
    for c in range(m.GetNumCompileUnits()):
        cu = m.GetCompileUnitAtIndex(c)
        for k in range(cu.GetNumLineEntries()):
            le = cu.GetLineEntryAtIndex(k)
            if not le or not le.IsValid():
                continue
            if fname(le) != FILE_NAME:
                continue
            rows.append({
                "addr": le.GetStartAddress().GetLoadAddress(target),
                "line": le.GetLine() or 0,
                "column": le.GetColumn() or 0,
                "cu": c,
            })
out["jit"] = jit
out["rowCountForFile"] = len(rows)

# Only the window around the requested line matters; send it and the stop PC's
# neighbourhood so the caller can tell "exact row" from "the next row".
requested_rows = [r for r in rows if r["line"] == REQUESTED_LINE]
out["requestedLineRows"] = [
    {"addr_hex": "0x%x" % r["addr"], "line": r["line"], "column": r["column"]} for r in requested_rows
]

stop = out["stop"]
if stop is not None:
    pc = stop["pc"]
    at = None
    for idx, r in enumerate(rows):
        if r["addr"] == pc:
            at = idx
            break
    if at is None:
        out["stopRowIndex"] = None
        out["stopRow"] = None
        out["rowAfterStopRow"] = None
    else:
        out["stopRowIndex"] = at
        out["stopRow"] = {"addr_hex": "0x%x" % rows[at]["addr"], "line": rows[at]["line"], "column": rows[at]["column"], "cu": rows[at]["cu"]}
        nxt = rows[at + 1] if at + 1 < len(rows) else None
        out["rowAfterStopRow"] = (
            {"addr_hex": "0x%x" % nxt["addr"], "line": nxt["line"], "column": nxt["column"]} if nxt else None
        )
        # The row that follows the requested line's last row — the slide target.
        req_indexes = [i for i, r in enumerate(rows) if r["line"] == REQUESTED_LINE]
        if req_indexes:
            last = req_indexes[-1]
            after = rows[last + 1] if last + 1 < len(rows) else None
            out["rowAfterRequestedLine"] = (
                {"addr_hex": "0x%x" % after["addr"], "line": after["line"], "column": after["column"]}
                if after
                else None
            )
        else:
            out["rowAfterRequestedLine"] = None

print("@@JSON " + json.dumps(out))
`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lldb =
    args.lldb ??
    'C:\\work\\Tension\\tools\\e2e-debugger\\node_modules\\@debugmcp\\codelldb-win32-x64\\lldb\\bin\\lldb.exe';
  const host = args.host ?? 'C:\\work\\Tension\\tension-core\\target\\release\\tension-core.exe';
  const guestPath = path.resolve(args.guest);
  // Absolute too: the host resolves `--symbol-path` against its own cwd.
  const symbolPath = path.resolve(args.symbolPath ?? path.dirname(guestPath));

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-measure-'));
  const driverPath = path.join(workDir, 'driver.py');  fs.writeFileSync(
    driverPath,
    DRIVER.replace('__LINE__', String(args.line)).replace('__FILE__', JSON.stringify(args.file)),
  );

  const cmdsPath = path.join(workDir, 'lldb.cmds');
  const lines = [
    'settings set plugin.jit-loader.gdb.enable on',
    `settings set target.debug-file-search-paths "${symbolPath}"`,
    `breakpoint set -f "${args.file}" -l ${args.line}`,
    'run',
    `script exec(open(r'${driverPath}').read())`,
    'quit',
  ];
  fs.writeFileSync(cmdsPath, `${lines.join('\n')}\n`);

  const result = spawnSync(
    lldb,
    ['-b', '-s', cmdsPath, '--', host, '--debug', '--symbol-path', symbolPath, guestPath, ...args.hostArg],
    { encoding: 'utf8', cwd: symbolPath, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const marker = raw.split(/\r?\n/).find((l) => l.startsWith('@@JSON '));
  if (!marker) {
    const tail = raw.trim().split(/\r?\n/).slice(-15).join('\n');
    throw new Error(`no driver output (exit ${result.status}):\n${tail}`);
  }  const observed = JSON.parse(marker.slice('@@JSON '.length));

  // Classify. Every address here is from the same run.
  const stop = observed.stop;
  let verdict = 'no stop';
  if (!stop) {
    verdict = 'no stop';
  } else if (!stop.hit_breakpoint) {
    verdict = 'stopped, not at a breakpoint';
  } else if (stop.line === args.line) {
    verdict = 'exact';
  } else {
    const requested = observed.requestedLineRows ?? [];
    const slideTarget = observed.rowAfterRequestedLine;
    const landedOnRequestedRow = requested.some((r) => r.addr_hex === stop.pc_hex);
    if (landedOnRequestedRow) verdict = 'exact address, wrong reported line';
    else if (slideTarget && slideTarget.addr_hex === stop.pc_hex) verdict = `slid to next row (line ${slideTarget.line})`;
    else verdict = `slid elsewhere (line ${stop.line})`;
  }

  const summary = {
    guest: path.basename(guestPath),
    guestPath,
    file: args.file,
    requestedLine: args.line,
    verdict,
    breakpointLocations: observed.breakpoints?.[0]?.num_locations ?? 0,
    breakpointResolved: (observed.breakpoints?.[0]?.locations ?? []).filter((l) => l.resolved).length,
    stop: stop
      ? {
          pc_hex: stop.pc_hex,
          line: stop.line,
          column: stop.column,
          function: stop.function,
        }
      : null,
    requestedLineRows: observed.requestedLineRows ?? [],
    stopRow: observed.stopRow ?? null,
    rowAfterStopRow: observed.rowAfterStopRow ?? null,
    rowAfterRequestedLine: observed.rowAfterRequestedLine ?? null,
    rowCountForFile: observed.rowCountForFile ?? 0,
    jit: observed.jit ?? null,
  };

  if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
}

main();
