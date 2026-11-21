import lldb, json, struct

# Extract the ELF object wasmtime handed lldb, so phase C can measure its
# .debug_line /.debug_ranges offline instead of resolving 2000 rows one at a time.
t = lldb.target
p = t.GetProcess()
out = {"found": None}

regions = p.GetMemoryRegions()
err = lldb.SBError()
hits = []
for i in range(regions.GetSize()):
    info = lldb.SBMemoryRegionInfo()
    if not regions.GetMemoryRegionAtIndex(i, info):
        continue
    lo, hi = info.GetRegionBase(), info.GetRegionEnd()
    if hi <= lo or not info.IsReadable():
        continue
    if hi - lo > 512 * 1024 * 1024:
        continue
    pos = lo
    while pos < hi:
        n = min(1024 * 1024, hi - pos)
        data = p.ReadMemory(pos, n, err)
        if err.Success():
            j = 0
            while True:
                j = data.find(b"\x7fELF", j)
                if j < 0:
                    break
                hits.append(pos + j)
                j += 4
        pos += n

for hit in hits:
    hdr = p.ReadMemory(hit, 64, err)
    if not err.Success() or len(hdr) < 64:
        continue
    if bytes(hdr[4:5]) != b"\x02":
        continue
    e_type, e_machine = struct.unpack("<HH", bytes(hdr[16:20]))
    if e_machine != 62:
        continue
    e_shoff = struct.unpack("<Q", bytes(hdr[40:48]))[0]
    e_shentsize, e_shnum = struct.unpack("<HH", bytes(hdr[58:62]))
    size = e_shoff + e_shentsize * e_shnum
    if not (0 < size < 256 * 1024 * 1024):
        continue
    blob = p.ReadMemory(hit, size, err)
    if not err.Success():
        continue
    raw = bytes(blob)
    if b".wasmtime.engine" not in raw:
        continue
    path = "/tmp/dl5/objD/%s.elf" % __import__("os").environ.get("DL5_NAME", "object")
    with open(path, "wb") as f:
        f.write(raw)
    out["found"] = {"addr": hit, "size": size, "path": path}
    break

print("@@J " + json.dumps(out))
