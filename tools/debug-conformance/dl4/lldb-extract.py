import lldb, json, struct

t = lldb.target
p = t.GetProcess()
out = {"found": None, "regions": 0}

regions = p.GetMemoryRegions()
out["regions"] = regions.GetSize()
err = lldb.SBError()

hits = []
for i in range(regions.GetSize()):
    info = lldb.SBMemoryRegionInfo()
    if not regions.GetMemoryRegionAtIndex(i, info):
        continue
    lo = info.GetRegionBase()
    hi = info.GetRegionEnd()
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
    out["found"] = {"addr": hit, "size": size, "e_type": e_type, "sha_len": len(raw)}
    with open("/tmp/dl4/lldb/jit-object.elf", "wb") as f:
        f.write(raw)
    break

out["hits"] = len(hits)
print("@@J " + json.dumps(out))
