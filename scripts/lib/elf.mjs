// Just enough ELF to read a library's search path, and to say what it names.
//
// ## Why this exists instead of `readelf`
//
// The packaging recipe has to answer one question about every shared library it
// ships — *does its RUNPATH name a directory outside the payload?* — and it has
// to answer it on machines that are not the build machine, in a step that must
// not silently pass. `readelf` is in binutils, which is present wherever a C++
// toolchain is, but "present wherever a C++ toolchain is" is an assumption, and
// a check that degrades to a no-op when its tool is missing is not a check.
//
// So the audit reads the file directly: `PT_DYNAMIC`, the tags, and the string
// table. It needs no tool, returns the same answer on every platform, and the
// repair step (`patchelf`, when there is one) is verified by the same reader
// that found the problem.
//
// ## What it parses, and what it refuses
//
// ELF32/ELF64 in either byte order — the arithmetic is the same — although the
// only class exercised by a build in this tree is ELF64 little-endian, which is
// every Ogre payload platform here. Anything that is not an ELF object throws
// rather than answering: a library the audit cannot read is a library the audit
// cannot clear, and the caller turns that into a build failure.
//
// Only the two tags the loader consults are exposed:
//
//   DT_RPATH   (15)  searched *before* `LD_LIBRARY_PATH`
//   DT_RUNPATH (29)  searched *after* it
//
// That distinction is not academic here: `tension-ogre/CMakeLists.txt` links
// with `--disable-new-dtags` on purpose, because the payload's own Ogre-Next
// must win over whatever `LD_LIBRARY_PATH` a terminal happens to carry. A
// rewrite that silently converted DT_RPATH to DT_RUNPATH would reverse that
// precedence and reintroduce the stale-library bug the flag was added for. So
// `rpathKind` is reported and preserved.

import { closeSync, openSync, readSync, statSync } from 'node:fs';

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NULL = 0;
const DT_STRTAB = 5;
const DT_RPATH = 15;
const DT_RUNPATH = 29;

/// Read `size` bytes at `offset`.
function readAt(fd, offset, size) {
  const buffer = Buffer.alloc(size);
  const read = readSync(fd, buffer, 0, size, offset);
  if (read !== size) throw new Error(`short read at ${offset} (${read} of ${size} bytes)`);
  return buffer;
}

/// A NUL-terminated string from `buffer`, starting at `offset`.
function cstring(buffer, offset) {
  if (offset < 0 || offset >= buffer.length) return null;
  const end = buffer.indexOf(0, offset);
  return buffer.toString('latin1', offset, end === -1 ? buffer.length : end);
}

/**
 * What a shared object's dynamic section says about where to find libraries.
 *
 * @param {string} path
 * @returns {{
 *   bits: 32|64,
 *   rpathKind: 'RPATH'|'RUNPATH'|null,
 *   runpath: string|null,
 *   needed: string[],
 * }}
 */
export function readElfDynamic(path) {
  const fd = openSync(path, 'r');
  try {
    const ident = readAt(fd, 0, 16);
    if (ident[0] !== 0x7f || ident[1] !== 0x45 || ident[2] !== 0x4c || ident[3] !== 0x46) {
      throw new Error(`${path}: not an ELF object`);
    }
    const elf64 = ident[4] === 2;
    if (!elf64 && ident[4] !== 1) throw new Error(`${path}: unknown ELF class ${ident[4]}`);
    const little = ident[5] === 1;
    if (!little && ident[5] !== 2) throw new Error(`${path}: unknown ELF data encoding`);

    const u16 = (buffer, offset) =>
      little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
    const u32 = (buffer, offset) =>
      little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
    const u64 = (buffer, offset) =>
      little ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);

    const header = readAt(fd, 0, elf64 ? 64 : 52);
    const phoff = elf64 ? Number(u64(header, 0x20)) : u32(header, 0x1c);
    const phentsize = u16(header, elf64 ? 0x36 : 0x2a);
    const phnum = u16(header, elf64 ? 0x38 : 0x2c);

    // The program headers: the segment table that maps virtual addresses (what
    // the dynamic section stores) onto file offsets (what `readSync` needs).
    const phdrs = readAt(fd, phoff, phentsize * phnum);
    const segments = [];
    let dynamic = null;
    for (let index = 0; index < phnum; index++) {
      const base = index * phentsize;
      const type = u32(phdrs, base);
      if (elf64) {
        segments.push({
          type,
          offset: Number(u64(phdrs, base + 0x08)),
          vaddr: Number(u64(phdrs, base + 0x10)),
          filesz: Number(u64(phdrs, base + 0x20)),
        });
        if (type === PT_DYNAMIC) {
          dynamic = segments[segments.length - 1];
        }
      } else {
        segments.push({
          type,
          offset: u32(phdrs, base + 0x04),
          vaddr: u32(phdrs, base + 0x08),
          filesz: u32(phdrs, base + 0x10),
        });
        if (type === PT_DYNAMIC) dynamic = segments[segments.length - 1];
      }
    }
    if (!dynamic) throw new Error(`${path}: no PT_DYNAMIC (is it linked statically?)`);

    const entries = readAt(fd, dynamic.offset, dynamic.filesz);
    const entrySize = elf64 ? 16 : 8;
    const tags = [];
    for (let offset = 0; offset + entrySize <= entries.length; offset += entrySize) {
      const tag = elf64 ? Number(u64(entries, offset)) : u32(entries, offset);
      const value = elf64 ? Number(u64(entries, offset + 8)) : u32(entries, offset + 4);
      if (tag === DT_NULL) break;
      tags.push({ tag, value });
    }

    const strtabTag = tags.find((entry) => entry.tag === DT_STRTAB);
    if (!strtabTag) throw new Error(`${path}: no DT_STRTAB`);
    // `DT_STRTAB` is a virtual address; find the segment that contains it and
    // convert, rather than assuming it is the second segment.
    const strtabSegment = segments.find(
      (segment) => segment.type === PT_LOAD &&
        strtabTag.value >= segment.vaddr &&
        strtabTag.value < segment.vaddr + segment.filesz,
    );
    if (!strtabSegment) throw new Error(`${path}: DT_STRTAB is in no PT_LOAD segment`);
    const strtabFileOffset = strtabSegment.offset + (strtabTag.value - strtabSegment.vaddr);
    // The table cannot be larger than the file; reading the tail is enough and
    // bounds the allocation.
    const strtab = readAt(fd, strtabFileOffset, statSync(path).size - strtabFileOffset);

    const runpathTag = tags.find((entry) => entry.tag === DT_RUNPATH);
    const rpathTag = tags.find((entry) => entry.tag === DT_RPATH);
    const pathTag = runpathTag ?? rpathTag ?? null;

    return {
      bits: elf64 ? 64 : 32,
      rpathKind: runpathTag ? 'RUNPATH' : rpathTag ? 'RPATH' : null,
      runpath: pathTag ? cstring(strtab, pathTag.value) : null,
      needed: tags
        .filter((entry) => entry.tag === 1 /* DT_NEEDED */)
        .map((entry) => cstring(strtab, entry.value)),
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * The search path's entries, split the way the loader splits them.
 *
 * `$ORIGIN` and `$LIB` are kept verbatim: they are the point of the audit, not
 * something to resolve here — a path that resolves is not the same as a path
 * that is relocatable.
 */
export function runpathEntries(dynamic) {
  if (!dynamic.runpath) return [];
  return dynamic.runpath.split(':').filter((entry) => entry !== '');
}
