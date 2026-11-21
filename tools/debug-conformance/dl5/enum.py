import lldb, json

t = lldb.target
p = t.GetProcess()
out = {"rows": 0, "bad": 0, "all": []}

jit = None
for m in t.module_iter():
    if "JIT(" in str(m.GetFileSpec().fullpath):
        jit = m
        break

base = None
end = None
if jit is not None:
    for s in jit.sections:
        if s.GetName() == "PT_LOAD[0]":
            base = s.GetLoadAddress(t)
            end = base + s.GetByteSize()
out["base"] = base
out["end"] = end
out["base_hex"] = hex(base) if base else None
out["end_hex"] = hex(end) if end else None

# Breakpoint state and where the process actually is.
th = p.GetSelectedThread()
stops = []
for i in range(th.GetNumFrames()):
    fr = th.GetFrameAtIndex(i)
    le = fr.GetLineEntry()
    if i == 0:
        out["pc"] = fr.GetPC()
        out["pc_hex"] = hex(fr.GetPC())
        out["pc_line"] = (str(le.GetFileSpec().basename) + ":" + str(le.GetLine())) if le.IsValid() else None
        out["pc_function"] = str(fr.GetFunctionName()) if fr.GetFunctionName() else None

bps = []
for i in range(t.GetNumBreakpoints()):
    bp = t.GetBreakpointAtIndex(i)
    locs = []
    for j in range(bp.GetNumLocations()):
        loc = bp.GetLocationAtIndex(j)
        a = loc.GetAddress()
        locs.append({
            "addr": a.GetLoadAddress(t),
            "hex": hex(a.GetLoadAddress(t)),
            "resolved": bool(loc.IsResolved()),
        })
    bps.append({"id": bp.GetID(), "locations": locs})
out["breakpoints"] = bps

entries = []
for m in t.module_iter():
    if "JIT(" not in str(m.GetFileSpec().fullpath):
        continue
    for ci in range(m.GetNumCompileUnits()):
        cu = m.GetCompileUnitAtIndex(ci)
        for le in cu:
            if not le.IsValid():
                continue
            addr = le.GetStartAddress().GetLoadAddress(t)
            entries.append((addr, str(le.GetFileSpec().basename), le.GetLine()))

entries.sort()
out["rows"] = len(entries)
nbad = 0
for (addr, file, line) in entries:
    sb = t.ResolveLoadAddress(addr)
    good = bool(sb.IsValid() and sb.GetLineEntry().IsValid())
    if not good:
        nbad += 1
    out["all"].append({"hex": hex(addr), "file": file, "line": line, "ok": good,
                       "off": (addr - base) if base else None})
out["bad"] = nbad

print("@@E " + json.dumps(out))
