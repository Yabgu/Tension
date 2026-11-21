import lldb, json

# What does lldb hold for the guest's JIT image? Every compile unit, its file
# spec, its line-entry count, and the distinct source files its line table names.
#
# Runs after `run`. The image is found by name prefix `JIT(`.

dbg = lldb.debugger
target = dbg.GetSelectedTarget()
process = target.GetProcess()

out = {"state": process.GetState(), "stop": None, "units": [], "files": {}, "error": None}

if process.GetState() == lldb.eStateStopped:
    th = process.GetSelectedThread()
    fr = th.GetFrameAtIndex(0)
    le = fr.GetLineEntry()
    out["stop"] = {
        "pc_hex": "0x%x" % fr.GetPC(),
        "function": fr.GetFunctionName() or "",
        "file": (le.GetFileSpec().GetFilename() if le and le.IsValid() else ""),
        "line": ((le.GetLine() or 0) if le and le.IsValid() else 0),
        "reason": th.GetStopReason(),
    }

try:
    for i in range(target.GetNumModules()):
        m = target.GetModuleAtIndex(i)
        name = m.GetFileSpec().GetFilename() or ""
        if not name.startswith("JIT("):
            continue
        out["image"] = {"name": name, "num_compile_units": m.GetNumCompileUnits()}
        for c in range(m.GetNumCompileUnits()):
            cu = m.GetCompileUnitAtIndex(c)
            try:
                cu_name = cu.GetFileSpec().GetFilename() or ""
                cu_dir = cu.GetFileSpec().GetDirectory() or ""
            except Exception:
                cu_name, cu_dir = "", ""
            n = cu.GetNumLineEntries()
            unit = {"index": c, "file": cu_name, "dir": cu_dir, "num_line_entries": n, "first_rows": []}
            for k in range(min(n, 3)):
                le = cu.GetLineEntryAtIndex(k)
                if le and le.IsValid():
                    unit["first_rows"].append({
                        "file": le.GetFileSpec().GetFilename() or "",
                        "dir": le.GetFileSpec().GetDirectory() or "",
                        "line": le.GetLine() or 0,
                    })
            # Distinct file names in this unit's line table.
            for k in range(n):
                le = cu.GetLineEntryAtIndex(k)
                if not le or not le.IsValid():
                    continue
                f = le.GetFileSpec().GetFilename() or ""
                out["files"][f] = out["files"].get(f, 0) + 1
            out["units"].append(unit)
except Exception as e:
    out["error"] = "%s: %s" % (type(e).__name__, e)

print("@@JSON " + json.dumps(out))
