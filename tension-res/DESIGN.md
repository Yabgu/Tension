# Tension resource format — design note

Status: **phase 9f in progress — see §12.**
Based on: **ECMA-208, System-Independent Data Format (SIDF)**, 1st
edition, December 1994, for reference only. This project implements
a profile of the field, buffer, file, and stream framing defined
in that standard, extended with a private content convention for
the directory tree (§5.5, §6.7). It is not a full ECMA-208
implementation and makes no claim of ECMA-208 conformance.

The specification is not distributed with this project; spec/README.md
records the edition this design was written against, how to obtain it,
and the checksums that identify it, so a local copy can be verified as
the same edition. This project is not affiliated with, endorsed by, or
certified by Ecma International. Ecma® is a registered trademark of Ecma
International. References to ECMA-208 are for interoperability
description only.

Nothing in this project uses ECMA-335, PE32, CLI metadata, .NET
tooling, or any private container format. The container is a
profile of SIDF as described above.

---

## 1. Scope

A Tension Volume — the pack, informally — is a single volume whose structure
follows the framing defined in ECMA-208 (a Volume, Buffers, File Sets, Files,
Streams), extended with one private content convention for the directory tree
(§5.5, §6.7). It is optionally part of a Volume Set. Volume files use the
`.tns` extension. The packer (`tension-pack`, `tension_res_pack`)
writes it; the runtime reads it; an independent reader (Python, §12) verifies
its structural framing.

## 2. Structures used

The structures below are the ECMA-208 constructs this profile uses. Every
field, table, and framing rule below is implemented per the cited section; the
extensions we add are listed separately in §5.5 and §6.7 and are not spec
structures.

| Structure | Built by us | Citation |
| --- | --- | --- |
| Volume Header Field Table | yes (mandatory) | 13.1 |
| Buffer Header Field Table (BUFFER TYPE #60, BUFFER SIZE #06, BUFFER SEQUENCE #07, BUFFER ADDRESS #08) | yes (mandatory per Buffer) | 13.4, 10.6 |
| File Set Header Field Table (incl. FILE SET INDEX PRESENT) | yes | 13.7 |
| File Set Trailer Field Table | yes | 13.9 |
| File Header Field Table (FILE HEADER #09, FILE CHUNK SIZE #0B, FILE TYPE #70) | yes | 13.12 |
| File Information Field Table (PARENT #81F0FD, PATH FULLY QUALIFIED #50, NAME SPACE #11, PATH NAME #12, timestamps) | yes | 13.14 |
| Path / Characteristics Field Tables (incl. SOURCE DIRECTORY #14) | yes | 13.15.1, 13.15.2 |
| File Set Index / Subindex Field Tables | yes — recorded for interoperability, **not used at runtime** (§5.5) | 13.10, 13.11 |
| Volume Index / Subindex Field Tables | yes — recorded for interoperability, **not used at runtime** | 13.5, 13.6 |
| Streams (Stream Header/Trailer Field Tables) | yes, for the directory index (§5.5 Option A) | 13.15.7 |
| Resynchronization pattern #A55A | yes | 6.23 |
| CRC (ITU Rec. X.25, seed -1) | yes | 9 |
| 12-byte timestamps | yes | 7 |

## 3. Path and name-space policy

- **NS1 (authoritative)**: full relative UTF-8 path. Constraints from the
  spec: bytes #00 and #3A (":") are not allowed; each path element is at
  most 32 characters; case-sensitive; case-retaining (6.15).
- **NS0 (advisory)**: 8.3-safe name for readers that ignore NS1. Constraints:
  members of CS8, at most 12 characters per element with at most one FULL
  STOP and at most 8 characters before / 3 after it; case-insensitive; no
  case retention (6.14).
- The packer emits both where NS0 can be derived losslessly; NS1 is the
  lookup key. *(Open item, phase 2: behaviour for path elements longer than
  32 characters in NS1, and NS0 mangling rule.)*

## 4. Hierarchy and pruning — provisional shape

Directories are files of type *Source directory* (`FILE TYPE` #70, `PARENT`
#81F0FD, `SOURCE DIRECTORY` #14), so the tree is expressed through the
standard's own file typing rather than a private namespace. Child lists and
the lookup structure are the subject of the §5 gate.

---

## 5. Phase 0.5 gate: can the optional index tables serve `(parent, child) → child` lookups?

### 5.1 Question (a) — which optional table can carry such entries?

- **File Set Index Field Table** (marker FID `#808010`), clause 13.10. Its
  iterated entries are per-**File**: `VOLUME SET SEQUENCE` (`#80F100`) →
  `BUFFER ADDRESS` (`#08`) → { `BUFFER OFFSET` (`#808014`), `PARENT`
  (`#81F0FD`), `PATH FULLY QUALIFIED` (`#50`), and per name space { `NAME
  SPACE` (`#11`), `PATH NAME` (`#12`) } } — Figure 24 in 13.10. The entry's
  value is the file's location: "The location of each File is determined by
  its VOLUME SET SEQUENCE, BUFFER ADDRESS, and BUFFER OFFSET" (13.10).
- **File Set Subindex Field Table** (`#808033`), clause 13.11: same entry
  structure, but only for files "previously recorded", and only at the start
  of a Volume Postamble.
- **Volume Index Field Table** (`#808011`, 13.5) and **Volume Subindex Field
  Table** (`#808031`, 13.6): entries are **File Sets** (`FILE SET ID`,
  `FILE SET TIME`, `FILE SET LABEL`, FSH/FST locations), not files. They
  cannot carry per-file keys.

So: in the sense of *holding the data*, the two File Set-level tables can
express (path, parent-flag, location) tuples. In the sense the design needs —
a keyed, searchable table — they cannot (§5.2).

### 5.2 Question (b) — does the spec's ordering support binary search by name?

**No.** Clause 13.10: "The File Set Index lists every File contained in the
File Set, **in the order they are recorded**." The index is a stream of four
nested Iterated Field Sets whose entries are variable-length (Annex B), with
no offset directory into the entries; nothing in the standard orders it by
name. The Volume Index is likewise ordered by the recording order of File Set
Trailers (13.5). A name lookup through the index therefore costs a scan of
the index, which is exactly what the pruning requirement forbids.

**Consequence:** the pruning property (lookup of `a/b/c/d/e/f` touching only
the path components, working set ∝ depth) **cannot be provided by the
standard's optional index tables**. Under the phase-0.5 gate instruction,
implementation stops here; §5.5 lists the choices.

### 5.3 Question (c) — exact byte encoding of key and value

- **Field** = FID + optional Data Length part + optional Data part (10.4,
  Figure 11). A Field's FID and Data Length part must lie within one Buffer
  (10.4).
- **FID** = 1–4 bytes, bit-structured per Annex A: 1-byte (A.2), 2-byte
  (A.3), 3-byte Cases A/B (A.4), 4-byte (A.5). FIDs whose first-byte bits
  b7..b5 are 1 are not defined by the standard and are available for
  registration under ISO/IEC 13800 (A.6).
- **Data Length part** has three formats (Annex B): Direct (b7=0, one byte,
  0–127); Indirect (b7=1, b6..b2=0, b1b0 select 2^N following bytes, low
  byte first, 2–9 bytes total); Bit Data (b7=b6=1, one byte carrying up to
  6 bits, no Data part).
- **Field Table framing** (10.5): the first and last Fields have the same
  FID; the first Field's Data is the Resynchronization Pattern; the last
  Field's Data is CRC or empty and does not appear elsewhere; `OFFSET TO
  END` (`#01`), if present, is the second Field; a computed CRC covers the
  whole table except the last Field. Resynchronization Pattern = two bytes
  `#A55A` (6.23); CRC = ITU Rec. X.25 32-bit, seed -1 (9).
- **The index entry's fields and encoding** are those of Figure 24 (13.10),
  with FID values from Annex C/D: `VOLUME SET SEQUENCE` `#80F100` (ordinal
  of the Volume within the Volume Set, starting at 1 — 4.22), `BUFFER
  ADDRESS` `#08` ("Sector Number of first Sector in Buffer"), `BUFFER OFFSET`
  `#808014` ("Bytes from start of Buffer to File Header"), `PARENT` `#81F0FD`,
  `PATH FULLY QUALIFIED` `#50`, `NAME SPACE` `#11`, `PATH NAME` `#12`.
- **Timestamps**: 12 bytes, fields at RBP 0 (type/time zone, 16-bit), 2
  (year, 16-bit), 4 (month), 5 (day), 6 (hour), 7 (minute), 8 (second), 9
  (centisecond), 10 (hundreds of microseconds), 11 (microseconds); a Year
  of 0 means the timestamp is ignored (clause 7).

### 5.4 Gate result

The standard has **no name-ordered, binary-searchable index**. The gate's
"no such table" condition is met in substance: the index tables are ordered
by recording sequence, not by name, and offer no random access into their
entries. Recorded here with citations before any phase-2 code, as instructed.

### 5.5 Decision — Option A (taken)

**Decision (2026-09-16).** Option A is adopted: directories are Source
directory Files; each directory's sorted child index lives in its own File
Data as a Data-type Stream (13.15 / 13.15.7). Registered FIDs (Option B) are
rejected as a format extension; Implementation Use buffers (Option C) are
rejected as equivalent to A with no advantage; Option D is rejected because it
fails the pruning requirement. The standard's File Set and Volume index tables
are still **written for interoperability only, not used at runtime**.

**This is a content convention on top of ECMA-208 stream payloads, not a
spec-native pruning mechanism.**

Options as presented at the gate (kept for the record):

- **Option A — convention on standard File structures (no new FIDs).**
  Directories are Source directory Files. Each directory's child list lives in
  that File's own File Data as a **Stream** (streams are recorded in File Data
  after the Characteristics Field Table — 13.15; a Stream is Stream Header FT
  + data + Stream Trailer FT — 13.15.7.1/13.15.7.2). `STREAM TYPE` (`#2B`,
  Annex C) is a closed list, so the child list is a **Data stream (type 0)**
  whose *content* is ours — stream content is not defined by the standard
  except for the five formats of 13.15.7.3 (clear data = "a sequence of bytes
  … the same as is available to a user of the Source file" — 13.15.7.4.1).
  Convention: a sorted, chunked child table (name + child location as the
  `(volume, sector, offset)` triple the standard itself uses). No new FIDs,
  no registry; the "extension" is content interpretation only. Lookup cost is
  set by our own chunking, not by the standard index.
- **Option B — registered extension (the standard's own path).**
  Record `REGISTERED IDENTIFIER` (`#808043`, Annex C: 23-byte ISO/IEC 13800
  identifier; allowed in Volume Header, File Set Header, or File Header Field
  Tables, scope = that File) and define new FIDs per Annex A for a *directory
  contents Field Table*, placed in the sanctioned "additional Field Tables"
  slot of Source directory File Data (13.15.4). This is explicitly an
  extension and requires a registration decision.
- **Option C — Implementation Use buffers.** `BUFFER TYPE` `#60` value 0 is
  "Implementation Use" and 10.6 admits implementation-use buffer payloads.
  Still needs an addressing convention per directory.
- **Option D — accept O(scan) lookups** via the standard index only. Fails
  the stated pruning requirement; listed for completeness.

Rationale (as accepted): this keeps the format pure ECMA-208, avoids a
registry dependency, and puts the prunable structure in the one place the
standard deliberately leaves undefined: the content of a file's stream.

### 5.6 Interpretation: Streams in Source directory File Data

Clause 13.15.4 says Source directory File Data "shall consist of at least the
following Field Tables" (Header FT, Path FT, Characteristics FT, Source
directory Trailer FT) and that "if additional Field Tables are to be
associated with the Source directory File Data, they shall be recorded after
the Characteristics Field Table and before the Source directory Trailer Field
Table." Clause 13.15 says more generally that "Any Streams associated with the
File shall be recorded after the Characteristics Field Table, and before the
associated trailer Field Table for their File." Clause 13.15.5 names
"additional Field Tables, such as Stream(s)" — but 13.15.5 is about Source
*file* File Data; the directory case (13.15.4) speaks only of "additional
Field Tables".

**Reading (accepted 2026-09-16):** 13.15.4's "at least the following"
wording, together with the general stream rule in 13.15, permits a Stream in
Source directory File Data; 13.15.5's "such as Stream(s)" is illustrative,
not restrictive.

**Status: reasonable reading, not a mandated one.** The seam is recorded here
so that anyone auditing the format can see it. If later evidence contradicts
this reading, the fallback is documented in §5.5 Option C (Implementation Use
buffers).

---

## 6. Lookup algorithm (phase 0.75)

The question put to this gate: in ECMA-208 (1st ed., Dec 1994), can a reader
address an arbitrary byte offset within a File's data stream, or is stream
reading necessarily sequential?

### 6.1 (a) What the spec defines a Stream to be

- A Stream is "a set of logically related bytes in a File" (13.15.7), and it
  is **not** expressed in Fields: "All data in the Volume, except for Streams
  (see 13.15.6), shall be expressed in Fields" (10.4 — cross-reference
  printed as 13.15.6; Streams are defined in 13.15.7).
- **Framing:** "A Stream consists of a Stream Header Field Table, followed by
  the Stream data, followed by a Stream Trailer Field Table" (13.15.7),
  recorded after the Characteristics Field Table and before the File's
  trailer (13.15, 13.15.5).
- Stream Header Field Table (13.15.7.1, Figure 38): mandatory `STREAM HEADER`
  `#1D`, `STREAM TYPE` `#2B`, `STREAM FORMAT` `#2C`, `STREAM SIZE` `#20`;
  "The STREAM SIZE value shall be the number of bytes of the Stream as
  recorded on the Volume." Optional: `STREAM TYPE SEQUENCE` `#61`, `STREAM
  COMPRESS TYPE` `#8005`, `STREAM EXPANDED SIZE` `#8006`, `BLOCK SIZE` `#24`,
  `BLOCK MAP` `#25`, delta fields.
- Stream Trailer Field Table (13.15.7.2, Figure 39): mandatory `STREAM
  TRAILER` `#1E`; optional `STREAM IS INVALID` `#21`, `STREAM CRC` `#22`.
- **The payload has an explicit length and no internal framing.** Five formats
  exist — clear data, sparse, compressed, delta block, delta extent
  (13.15.7.3) — and for clear data "the number of bytes recorded, and their
  contents, are the same as is available to a user of the Source file"
  (13.15.7.4.1). There is no terminator field inside the payload and no chunk
  table; the recording unit is the Buffer (10.6).

### 6.2 (b) From `BUFFER ADDRESS`/`BUFFER OFFSET` to a byte inside the payload

- What the index's location reaches is the **File Header, not the payload**:
  `BUFFER OFFSET` = "Bytes from start of Buffer to File Header" (Figure 24,
  13.10), and "the location of each File is determined by its VOLUME SET
  SEQUENCE, BUFFER ADDRESS, and BUFFER OFFSET" (13.10). `BUFFER ADDRESS` is
  a sector number counting from the File Set (Sub)Header (Figure 20, 13.4).
- Reaching payload bytes is a **bounded sequential parse of small Field
  Tables** — not a pointer jump, and not a scan either:
  1. File Header Field Table (13.12: recorded "immediately before the File
     Information Field Table"; `FILE HEADER` `#09`, `FILE CHUNK SIZE` `#0B`,
     `FILE TYPE` `#70`).
  2. File Information Field Table (13.14: "immediately after the File Header
     Field Table"; `FILE INFORMATION` `#813F`, `PARENT`, `PATH NAME` …).
  3. File Data (13.15 / 13.15.5): Source file Header FT (`#0E`), Path FT
     (`#10`), Characteristics FT (`#13`), then Streams, then Trailer FT
     (`#0F`) — "If additional Field Tables, **such as Stream(s)**, are to be
     associated with the File data, they shall be recorded after the
     Characteristics Field Table and before the File Trailer Field Table."
  4. Stream Header Field Table (`#1D` …), after which the payload begins
     immediately: "the Data part of the Field shall immediately follow the
     Data Length part if present, or shall follow the FID if the Data Length
     part is omitted" (10.4).
  Every Field carries its FID and (unless fixed) its Data Length (Annex A/B),
  so each table is self-delimiting and the parse is deterministic; for our
  layout the number of tables before the payload is fixed.
- **Cross-buffer caveat.** A File may span Buffers; each later Buffer begins
  with its Buffer Header Field Table and may begin its file data with a File
  Continuation Header Field Table (10.6, Figure 12; 13.13 — `FILE CHUNK SIZE`
  `#0B` = "Bytes of this File contained in this Buffer"). Stream offset →
  physical position is therefore a pure addition only *within* a chunk; across
  a Buffer boundary the chunk sizes (13.12/13.13) must be known, and walking
  them is sequential unless the chunking is uniform or the content carries an
  address table.
- **What the format supplies for jumping:** absolute sector addressing
  (`Sector` / `Sector Number`, 4.16/4.17; "Each Sector of a Volume shall be
  identified by a unique Sector Number", 10.1) and `BUFFER ADDRESS` values
  that are absolute within the File Set. Nothing forbids reading a Buffer or
  Sector at an arbitrary address instead of walking there.

### 6.3 (c) Does the spec constrain seeking within a stream?

**The standard is silent.** No clause forbids or constrains seeking within a
Stream or within a File's data. The only occurrence of "seek" in the document
concerns media file marks (`FILE MARK USAGE`, 10.7, and its Annex C note:
"Interval file marks are intended to provide a seek-performance improvement
mechanism for devices which do not natively support direct seeking …"), i.e.
device positioning, not byte access. Clause 14.3 (receiving system) constrains
only that recorded information be made available to the requesting application
— including information the receiving system "is unable to interpret"
(14.3.1). The standard likewise provides **no stream offset table**: the block
map `#25` of the sparse/delta formats is a presence bitmap ("A bit shall be
set to ONE if its corresponding block of the expanded Stream image is
recorded", 13.15.7.4), not an address table.

### 6.4 Verdict against the gate criterion

- **The first condition is met:** the stream is a byte sequence with a length
  (`STREAM SIZE`, 13.15.7.1; clear data identical to the payload, 13.15.7.4.1).
  Stream reading is therefore not *necessarily* sequential: within a chunk the
  payload is contiguous and directly addressable as `stream_start + k`.
- **The second condition is not supplied by the standard; we supply it.**
  Option A's content convention puts a small, fixed-stride address region at
  the front of each directory's index stream (a slot table plus the chunk
  table), whose values are absolute `(sector, offset, length)` positions — so
  any stream byte is reachable in one extra read even across Buffer
  boundaries.
- Therefore: **proceed to phase 2 with Option A**, with the standard supplying
  the containers, the framing, and absolute sector addressing, and the content
  convention supplying the pruning mechanism (§5.5). Residual interpretation
  risks kept visible for phase 3: (i) a Stream inside a *Source directory*
  File's File Data rests on 13.15.4's "at least the following" list plus the
  general stream rule in 13.15 (13.15.5 names "such as Stream(s)" explicitly
  only for Source file data); (ii) we place the index stream in the directory
  File itself, not in a companion File.

### 6.5 Lookup algorithm (Option A)

**Root.** The packer records the root Source directory File as the first File
Space of the first File Buffer of the File Set; a reader computes that address
from the File Set Header (`BUFFER SIZE`, 13.7) and the first Buffer's sector
boundary. (Interop path, unused at runtime: the root is the first entry of the
File Set Index.)

**Per path component — constant work:**

1. **Reach the parent directory's index stream.** From the directory File's
   location (absolute sector + offset), parse File Header FT → File
   Information FT (confirm directory type via `FILE TYPE`/`PARENT`) → File
   Data Header/Path/Characteristics FTs → Stream Header FT → the first bytes
   of the stream. Bounded: ~6 small Field Tables plus one bounded read.
2. **One slot probe.** The stream's preamble is fixed-stride; the slot for
   `hash(component)` sits at a computed stream offset, so the reader reads
   exactly one slot. It yields the child entry's exact byte range (and, in the
   common case, the child's location).
3. **Read exactly the one child entry** (those bytes only).
4. **Jump to the child.** The entry carries the child's absolute `(volume set
   sequence, sector, buffer offset)`; the reader addresses the child's File
   Header directly and repeats from step 1 for the next component, or stops at
   the final one.

**Contents of the child entry (our stream-content convention):** NS1 name,
kind (file / directory), size, compression method + expanded size for files,
and the child's location triple. The **entry area is sorted by NS1 name**
(deterministic packing, serves `readdir`), while lookup goes through the
fixed-stride slot table, so lookup cost does not depend on entry count.

**Reads per level:** one preamble read, one slot probe, one entry read, plus
the child's small header tables — a constant that does not grow with the
number of entries. Sibling records, sibling listings, and sibling subtrees are
never read. Third-party readers that do not know the convention still see
standard Files and can enumerate everything through the File Set Index we
write.

### 6.6 Probe mechanism and the pruning assertions (decided)

**Layout (Y), confirmed:** one entry per addressable leaf; the slot area is a
fixed-stride array of 16-byte slots; the entry area stays sorted by NS1 name
(it serves `readdir`). Assertion #2 is byte-exact: a lookup reads the slots it
probes and exactly one entry per level — no sibling entry bytes, no sibling
records, no sibling listings.

**Probe mechanism: (ii) sorted-hash binary search — chosen.** The slot area is
sorted by the 64-bit hash of each child's NS1 name; the reader binary-searches
it by reading individual 16-byte slots at computed offsets
(`slot_area_start + 16 × index`), so a probe is a 16-byte logical read and no
block is fetched wholesale on the lookup path.

- **Hash function:** FNV-1a, 64-bit, over the NS1 name bytes (UTF-8),
  offset basis `0xcbf29ce484222325`, prime `0x100000001b3`. Ties are broken by
  the name bytes (byte order), so the slot order is total and stable.
- **Slot record (exactly 16 B):** `hash u64 LE`, `entry_offset u32 LE`
  (from the start of the index stream), `entry_len u32 LE`. Equal-hash runs
  are walked in order and disambiguated by reading the candidate entries
  (expected run length 1 at 100k entries; the run walk is bounded).
- **Packing consequence:** none — no seed search, no retries. The packer
  hashes each child name, sorts by (hash, name), and writes. Deterministic by
  construction, O(N log N) per directory.

**Why not (i) direct-mapped/perfect.** A single-read, zero-collision direct
map is infeasible at realistic directory sizes: expected colliding pairs for
`N` names in `m` slots is `N(N−1)/2m`, so merely making zero collisions
*plausible* for N = 5,000 needs `m ≳ 12.5M` slots — ≈ 200 MB of slot area for
one directory. A two-level perfect scheme (CHD/FKS) fits in O(N) space, but
turns each probe into a bucket-descriptor read plus a slot read and adds a
seed search to the packer, for a measured saving of ~13 × 16 B per level.
Not worth the construction complexity; (ii) is deterministic by construction.

**Thresholds for the phase-4 test (all five assertions stay):**

- **#1 working set bound:** per level in the §6.7 encoding: one index header
  read (32 B), `⌈log2 C⌉ + 1` slot probes at 16 B each plus one 16 B chunk-table
  entry per probe that resolves outside chunk 0 (32 B per probe), one entry
  read (20 B + name) plus its chunk-table entry, and the child File's small
  Field Tables (≈ 0.2 KiB). At C = 5,000: 32 + 14×32 + ~72 + ~200 ≈ 750 B per
  level. For the fixture's deepest path: **assert logical bytes touched for the
  whole `a/b/c/d/e/f` lookup ≤ 64 KiB** (expected ≈ 4–6 KiB);
  `zig build prune-report` prints the actual value.
- **#3 independence from N:** probes per level grow as ⌈log2 C⌉ where C is that
  level's child count — never with the total entry count. Two checks:
  (a) fixtures that scale total entries by adding directories at constant
  fan-out: `bytes(large) − bytes(small) ≤ 256 B`;
  (b) one directory grown 1k → 5k → 100k children — **cumulative Δprobes vs.
  the 1k baseline: 3 at 5k (48 B), 7 at 100k (112 B)**
  (`⌈log2 5000⌉ − ⌈log2 1000⌉ = 13 − 10`; `⌈log2 100000⌉ − ⌈log2 1000⌉ =
  17 − 10`), asserted with ±1 probe slack per level.

**Phase-4 amendments (ruled 2026-09-16).** The five assertions as measured on
the ~112 000-entry fixture: #1 distinct bytes **2 830** (bound 64 KiB) ✔;
#2 sibling-byte intersections **0** over 130 430 sibling ranges ✔; #5 leaf
`f`, 13-byte payload, fnv1a64 `0x86668005CD8C3E24` ✔; #3, #4 as amended below.

- **Working-set metric is bytes read, not pages touched.** Pages are
  informational and bounded by O(log N) for the flat slot area. The byte
  bound (#1) proves the pruning property; the page count describes cache
  behavior, which is not a design constraint at this scale.
- **#3 independence from N (page form, corrected):**

  `pages(large) ≤ pages(small) + (⌈log2 N_large⌉ − ⌈log2 N_small⌉) + 2`

  → 13 ≤ 3 + 10 + 2 = 15 (measured: large 13, small 3,
  `⌈log2 5001⌉ − ⌈log2 7⌉ = 13 − 3 = 10`) ✔. The original "+2 pages" assumed
  page-local binary search, which a flat slot array does not provide; the
  page directory that would provide it was rejected (2026-09-16 ruling) as a
  cache-behavior improvement that is not the design goal — 13 pages × 8 KiB
  = 104 KiB per lookup is negligible here.
- **#4 depth proportionality (amended bound 2 ≤ ratio ≤ 5).** Measured
  distinct-byte ratio depth-6/depth-2 = **4.08** (2 830 / 694). The
  non-uniformity is expected: the root indexes more entries than the child
  directories, so per-level cost is not perfectly uniform.

**Read accounting used above:** a *logical read* is one byte-range request
from the reader (a 16 B slot probe, or one entry read). The test also counts
distinct 8 KiB pages touched; that second number reflects whatever storage
granularity the runtime uses and is reported for information, not asserted.

### 6.7 Index Stream format (final, phase 3)

The child index of a Source directory File is one Stream (STREAM TYPE 0 = Data,
STREAM FORMAT 0 = Clear data — Annex C `#2B`/`#2C`) whose payload is the
structure below. Identification is the content magic plus version: a
directory File whose File Data has no such Stream has no readable children
(§11: `-ENOENT`). All integers are little-endian (6.1). Positions use the
spec's own vocabulary: `buffer_address` per 13.4 (sectors counting from the
File Set (Sub)Header, first buffer = 1, §11.1 ruling 4), `buffer_offset` per
Figure 24 (bytes from the start of that Buffer to the File Header).

**Header — 32 bytes at stream offset 0**

| off | size | field | notes |
| --- | --- | --- | --- |
| 0 | 4 | `magic` u32 | `0x58495354` = bytes `T S I X` in file order (§6.7) |
| 4 | 2 | `format_version` u16 | 1 |
| 6 | 2 | `header_len` u16 | 32 |
| 8 | 4 | `slot_count` u32 | N, one slot per child |
| 12 | 4 | `chunk_count` u32 | M |
| 16 | 4 | `chunk_payload` u32 | p, uniform chunk payload, multiple of 16 |
| 20 | 4 | `slot_area_off` u32 | 32 + 16·M |
| 24 | 4 | `chunk_table_off` u32 | 32 (chunk table is inside chunk 0) |
| 28 | 4 | `entry_area_off` u32 | 32 + 16·M + 16·N |

**Slot area — 16 bytes × N, sorted by `(hash, name)`**

| off | size | field |
| --- | --- | --- |
| 0 | 8 | `hash` u64 — FNV-1a 64 over the child's NS1 name bytes (§6.6) |
| 8 | 4 | `entry_offset` u32 — stream-relative offset of the entry |
| 12 | 4 | `entry_len` u32 — entry record length in bytes |

**Chunk table — 16 bytes × M**

| off | size | field |
| --- | --- | --- |
| 0 | 4 | `stream_offset` u32 — first stream byte in this chunk (= k·p) |
| 4 | 4 | `length` u32 — bytes of stream in this chunk (≤ p; last chunk shorter) |
| 8 | 4 | `buffer_address` u32 — Buffer holding this chunk (13.4 numbering) |
| 12 | 4 | `offset_in_buffer` u32 — bytes from Buffer start to this chunk's first stream byte |

**Entry — 20 bytes + name (no terminator, no alignment padding)**

| off | size | field |
| --- | --- | --- |
| 0 | 1 | `kind` — 0 = file (`FILE TYPE` `#70` value 4), 1 = directory (value 3) |
| 1 | 1 | `flags` — bit0 payload compressed (phase 3: always 0); bits 1–7 reserved, 0 |
| 2 | 2 | `name_len` u16 |
| 4 | 4 | `size` u32 — payload bytes (0 for directories) |
| 8 | 2 | `volume_set_sequence` u16 — 4.22 numbering (1 in single-volume paks) |
| 10 | 4 | `buffer_address` u32 — where the child's File Header begins |
| 14 | 4 | `buffer_offset` u32 — bytes from that Buffer's start |
| 18 | 2 | `compression_method` u16 — PKWARE APPNOTE id (0 = stored) |
| 20 | `name_len` | NS1 name, UTF-8 |

The entry area is written in **name order** (serves `readdir` deterministically);
the slot area is written in **`(hash, name)` order** (serves lookup). Entries
are 20 + name bytes with no padding; `slot.length` is the entry's exact length.

**Chunking rules.** Chunks have a uniform payload `p` (a multiple of 16) except
the final chunk. `p` must satisfy `32 + 16·M ≤ p` so the header and the whole
chunk table live in chunk 0 — that is what makes the first bytes readable
without the mapping (the stream's byte 0 sits immediately after the Stream
Header FT, 10.4). The writer never splits a unit (header, slot, chunk entry,
entry): if the next unit does not fit in the current chunk, the chunk ends and
the unit starts at the next chunk boundary; the skipped bytes are zero filler.
Consequently a reader resolves any read to a single chunk arithmetically
(`chunk = off / p`, checked against `chunk_payload` bounds), never reading two
chunks for one unit, and never needs to search the chunk table.

**Entry-area scan (`readdir`, §7.6).** Listing walks the entry area in stream
order — which is name order, because that is how the packer presents children
(§8.1 invariant 6). The scanner reads the 20-byte entry head, then the name
bytes; both are inside one chunk by the unit rule above. Rather than track the
writer's padding, it recognises filler the way the writer writes it: a
chunk-end filler run is zero, and a real entry always has `name_len ≥ 1`, so an
all-zero 4-byte prefix means "no unit starts here" and the scan resumes at the
next chunk boundary. Filler is therefore never parsed as an entry and never
reported as a child.

**Compression.** Phase 3 is uncompressed only (STREAM FORMAT 0 = Clear data,
`compression_method` = 0 = Stored). This is deliberate: compression is
orthogonal to index structure, and coupling the two would add codec
integration to a phase whose whole point is a settled, testable layout. When a
codec lands, either the whole stream (STREAM FORMAT 2 with `STREAM COMPRESS
TYPE`) or per-file payloads (the entry's `flags`/`compression_method`) carry
it; the index structure itself does not change.

**Probe path (byte accounting per level, N children).**

1. index header: 1 read, 32 B (chunk 0, no mapping needed);
2. binary search over the slot area: `⌈log2 N⌉ + 1` slot reads, 16 B each,
   plus one 16 B chunk-table read for each probe whose chunk is not chunk 0;
3. equal-hash runs are walked in `(hash, name)` order; expected run length 1;
4. the winning entry: 1 read of `20 + name_len` bytes plus one 16 B chunk-table
   read;
5. for a directory child, the walker then reads that File's small Field Tables
   (≈ 0.2 KiB) and recurses.

At N = 5,000 that is ≈ 750 B per level; six levels ≈ 4.5 KiB — three orders of
magnitude below the fixture, and the slot-read count grows as `⌈log2 N⌉ + 1`
(drives §6.6 assertions #1 and #3).

### 6.8 The path walker (phase 4)

**Read interface.** Every byte the walker touches is fetched through
`block.BlockReader`:

```
read(offset: u64, len: usize) -> []const u8  |  error{Invalid, Truncated}
```

A `BlockReader` is a type-erased `{ ctx, read_fn }` pair; `block.SliceReader`
is the trivial implementation over an in-memory pak. The walker stores only the
reader and uses `pak_bytes` **solely for its length** (out-of-image location
checks) — never its contents. That rule is testable: the walk test hands the
walker a decoy image of the correct length and a reader over the real bytes;
the lookup still succeeds.

**Walk algorithm.**

```
init(pak_bytes, reader):
  read the Volume Header FT (sector 0, 13.1)      -> SECTOR SIZE (#80800E)
  fs_header_sector = 1                            (§11.1 layout: the File Set
                                                   Header starts at sector 1)
  read the File Set Header FT (13.7)              -> BUFFER SIZE (#06) and the
                                                     header's consumed length
  first_buffer_sector = fs_header_sector + ceil(fsh.consumed / sector_size)
  read that Buffer's Buffer Header FT (13.4)
  root_file = first_buffer_sector * sector_size + buffer_header.consumed
  root_index = openIndex(root_file)

resolve(path, expect):
  comps = normalize(path)          # '/' separators; "" and "." skipped;
                                   # ".." pops and may not escape root;
                                   # trailing '/' asserts a directory
  view = root_index; loc = root location
  for each component c (last = final):
    e = probe(view, c) or -ENOENT
    if last:
      trailing '/' and e.kind != directory      -> -ENOTDIR
      expect == file and e.kind != file        -> -EISDIR
      expect == directory and e.kind != dir    -> -ENOTDIR
      return Location{kind, size, volume_set_sequence, buffer_address,
                      buffer_offset, compression_method, name}
    if e.kind != directory                      -> -ENOTDIR
    child = (fs_header_sector + e.buffer_address) * sector_size
            + e.buffer_offset                   # §11.1 ruling 4
    view = openIndex(child)

openIndex(file_abs):
  File Header FT (13.12): FILE CHUNK SIZE (#0B), FILE TYPE (#70)
  File Information FT (13.14): PARENT (#81F0FD), PATH FULLY QUALIFIED (#50),
                              NAME SPACE (#11) + PATH NAME (#12)
  then walk File Data table by table to the Stream Header FT:
    SOURCE DIRECTORY HEADER (#0C) / PATH (#10) / CHARACTERISTICS (#13): skip
    STREAM HEADER (#1D): STREAM TYPE 0 (Data) + STREAM FORMAT 0 (Clear data)
      -> the child index begins immediately after this table (10.4)
    SOURCE DIRECTORY TRAILER (#0D): no index Stream -> -ENOENT (§11)
```

**Reads are exact.** The walker never over-reads: fields are fetched FID-byte,
length-byte and data-byte by field, and each parsed unit (table, slot, entry)
is read exactly once. Over-reading would silently pull neighbour bytes into the
working set, which is precisely what assertion #2 forbids — so the pruning
property is a consequence of the read discipline, not of fixture padding.

**Chunk-table reads (the ones §6.7 promises).** With `p = chunk_payload`:

- the index header (32 B) and the chunk table (16·M B) sit in chunk 0 and are
  read directly (no mapping);
- every slot probe whose slot offset is ≥ p reads one 16 B chunk-table entry
  first, then the 16 B slot — the only two reads per probe;
- the winning entry: one chunk-table entry (if ≥ p) plus the entry's
  `20 + name_len` bytes.

**Error semantics** (matching §11's strict VFS):

| condition | error | errno |
| --- | --- | --- |
| missing component, `..`-escape resolved past root | `NotFound` | -2 ENOENT |
| file in a non-final position, trailing `/` on a file, `expect=directory` on a file | `NotDir` | -20 ENOTDIR |
| `expect=file` on a directory | `IsDir` | -21 EISDIR |
| malformed structure, out-of-image location, bad path bytes | `Invalid` | -22 EINVAL |
| input ends inside a structure | `Truncated` | -5 EIO |

An out-of-image location (a corrupted index entry) is rejected before any read
is published, via the `pak_bytes.len` bound — the single use of the parameter.

**Working set (bytes, per path level).** Six small Field Tables (~0.6 KiB
total: File Header, File Information, File Data header, Path, Characteristics,
Stream Header), the index header + chunk table (~0.1–1.1 KiB depending on M),
then `⌈log2 N⌉ + 1` probes (16 B slot + 16 B chunk entry each) and one entry
read (≈ 50 B + 16 B). At N = 100 000: ≈ 620 B of probes + ≈ 1.8 KiB of
structure per level; six levels plus the fixed root region (≈ 2 KiB) ≈
**13–15 KiB**, inside §6.6's 64 KiB bound. Depth-proportional growth is
linear in depth apart from the fixed root cost (§6.6 assertion #4).

**Pages touched — pre-registered expectation.** Distinct 8 KiB pages grow as
`⌈log2 N⌉` for the flat slot array of §6.7: each binary-search probe lands in a
different region of the slot area once `N·16 B` exceeds one page. For the
phase-4 fixtures (`N_small ≈ 7`, `N_large = 5 001` children in the deepest
directory) the difference is therefore expected to be ≈ 10 pages, i.e. **more
than the +2 pages §6.6 assertion #3 allows**. That is a property of the
approved flat slot area, not of the walker; the measurement in phase 4b is
recorded as-is and the §6.6 wording is flagged for a ruling (either "+2"
becomes "+⌈log2 N⌉ slack", or the format gains a page-level first-stage index).

## 7. VFS semantics (phase 5)

The VFS is the runtime surface: read-only, allocation-free, and strict. Nothing
here writes a pak, and every byte it touches is fetched through the walker's
`BlockReader` (§6.8) — the module never holds a pak byte slice at all, so the
rule is structural, not a convention.

### 7.1 Path rules

- POSIX separators; case-sensitive; a leading `/` is optional; the empty path
  is the root directory.
- `.` and `..` resolve lexically in `walk.normalize` (§6.8) — `..` past the
  root is `-EINVAL` and no pak byte is read to resolve either.
- A trailing `/` asserts a directory: on a file `-ENOTDIR`, on a directory
  accepted.
- `-EINVAL` for a NUL byte, for more than 64 components, or a component longer
  than `0xFFFF` bytes.
- Names are NS1 throughout (§3, §6.7). The VFS performs no case folding and no
  namespace fallback: an NS0-only name is not addressable.

### 7.2 Pak set and resolution

`Vfs` holds up to `MAX_PAKS` walkers, in load order. Resolution is first-match:
the first pak that resolves the path answers it; later paks are not consulted
for that path. Two rules keep this honest:

- **No pak loaded is not a special case.** Every path — including `/` —
  returns `-ENOENT`; `readdir` returns `-ENOENT`; nothing is synthesized.
- **Duplicate paths across paks are a load-time error**, not a resolution
  rule, and the loader enforces it: `tension-core` walks every loaded pak once
  (recursively, through `readdir`) and refuses to start when two paks provide
  the same NS1 path — implemented in phase 7 (`check_pak_conflicts`). The check
  is O(total entries) once, and *not* on any lookup path: scanning sibling paks
  per level would multiply the §6.6 working set by the pak count.

### 7.3 fd table

- `MAX_FDS` slots; an fd is a 1-based slot handle, so `0` is never a valid
  handle (an uninitialized fd fails closed with `-EBADF`).
- One cursor per open: two opens of the same file have independent positions.
- `close` is idempotent: it releases the slot and returns 0; closing an
  already-closed in-range handle returns 0 again. Out-of-range handles are
  `-EBADF` for every operation, including `close`.
- Using a closed handle (`read`/`seek`/`tell`/`stat_fd`) is `-EBADF`.
- Table exhaustion is `-EMFILE` (-24, POSIX; an addition to the six codes the
  plan listed, flagged in the phase-5 report).
- A handle carries its own chunk-list cache for multi-chunk Files (§8.3): per
  open, bounded at `MAX_FILE_CHUNKS`, dropped when the handle closes. Two
  handles on the same File never share it.
- Handles are not generation-checked: a handle recycled by a *later* open is
  indistinguishable from the original. The host owns the table and closes what
  it opened; the framework never fabricates an fd.

**Guest fd packing (ruled 2026-09-16).** The host ABI hands the guest
`(pak index << 16) | local fd`, because every pak numbers its own handles from
1 while the guest sees one namespace. That implies two caps, recorded here so
they are not discovered by surprise: **at most 65536 paks** in a set, and
**at most 65535 open fds per pak** (the C ABI's table is smaller still —
`MAX_FDS = 64`). Both are far above any realistic use; if either is ever
approached, the packing scheme needs revision, not a patch.

### 7.4 The stat record (host ABI `out_ptr`)

Twelve bytes, little-endian (6.1): `kind: u32`, `size: u32`, `flags: u32`.

- `kind`: 0 = file, 1 = directory (the `index.Kind` values, §6.7).
- `size`: the payload byte count for a file, 0 for a directory.
- `flags`: bit 0 = the payload is compressed (the entry's `compression_method`
  is not 0, §6.7); bits 1–31 reserved, zero. `stat` reports this from the index
  entry alone, so a compressed file can be stat'ed without opening its stream
  (§11).

`stat_fd` reports the same record for an open handle and must agree with
`stat` byte for byte.

### 7.5 read / seek / tell

- `read(fd, dst) -> n | 0 | -errno`: a short read happens only at end of file;
  `0` means end of file. `-EBADF` for a bad handle, `-EIO` for a payload whose
  stream format or compression method is not supported (§11) — the handle stays
  open and `stat` keeps working for that file only.
- `seek(fd, off, whence) -> pos | -errno` with `whence` 0 = SET, 1 = CUR,
  2 = END (the `RES_SEEK_*` values); anything else is `-EINVAL`. A resulting
  negative position is `-EINVAL`. Seeking past end of file is allowed; a
  subsequent `read` returns 0.
- `tell(fd) -> pos`, `-EBADF` for a bad handle.
- Positions and offsets are 64-bit; a file larger than 4 GiB is not addressable
  in this phase (volume sets are §9).

### 7.6 readdir

`readdir(path, index, name_out, out) -> name_len | 0 (end) | -errno`.

- `index` is the 0-based ordinal of the child **in NS1 byte order**. That order
  is the entry area's own order (§6.7), which the packer guarantees (§8.1
  invariant 6); the VFS neither sorts nor verifies it. A reader given an
  unsorted pak enumerates unsorted — no panic, no miss.
- The returned name is the child's **raw NS1 name**, exactly as packed: no
  suffix, no normalization (ruled 2026-09-16). The record's `kind` carries
  "directory", and a name handed back by `readdir` must round-trip into
  `stat`/`open` unchanged — appending `/` in the VFS would force every caller
  to strip it again. The framework (phase 8) applies the `/` display suffix
  for TS when formatting a listing; the VFS never invents bytes.
- `name_out` follows the `tension::io` `arg` convention: `min(cap, len)` bytes
  are written and the **full** length is returned, so a short buffer is
  signalled by `name_len > cap` and `cap == 0` is a size probe.
- `0` means the index is past the last child (end of listing).
- Enumerating in ascending index order is what the framework does, and it is
  O(1) per step: the VFS keeps a one-entry cursor cache `(pak, directory,
  index, entry-area position)` and resumes from the cached position when the
  caller asks for the next index of the same directory. Any other access
  pattern (repeating an index, going backwards, alternating directories)
  restarts the scan at the entry area's first byte and costs O(index) units —
  correct, just not cached. The cache holds no pak bytes, only an offset.
- Enumeration inside a directory File that has no child-index Stream is
  `-ENOENT` (§11): the directory itself still `stat`s as a directory.
- A path that resolves to a file is `-ENOTDIR`; a malformed path is `-EINVAL`;
  a malformed index Stream is `-EINVAL`/`-EIO`.

### 7.7 Error table (VFS level)

| condition | errno |
| --- | --- |
| missing component, missing pak, directory without a child index | -2 `ENOENT` |
| file in a path position, trailing `/` on a file, `readdir` on a file, `open` through a file | -20 `ENOTDIR` |
| `open` on a directory | -21 `EISDIR` |
| bad handle (closed, out of range, never allocated) | -9 `EBADF` |
| malformed path, malformed structure, `..` escape, bad `whence`, negative position | -22 `EINVAL` |
| input ends inside a structure, unsupported payload codec | -5 `EIO` |
| fd table full | -24 `EMFILE` |

**Error translation (one rule, two layers).** The VFS layer is strict: any
path that does not resolve in a loaded pak — *including every path when no pak
is loaded* — returns `-ENOENT` for `open`/`stat`/`readdir`. The framework layer
translates: `-ENOENT` → `null` for `resStat`/`ResFile.open`, → `[]` for
`resEntries`/`resList`. Strict VFS, lenient framework; the two layers never
disagree.

## 8. Compression mapping (to be completed in phase 2)

Deflate (8) first, ZSTD (93) target, Stored (0) automatic for incompressible
or tiny payloads, LZMA (14) decode-only/deferred. Method ids are the PKWARE
APPNOTE values carried in `STREAM COMPRESS TYPE` (`#8005`, 13.15.7.1), whose
interpretation Annex C leaves to a registered identifier or agreement.

### 8.1 Packer invariants (accumulated; phase 7 must enforce every one)

1. `plan()` for a child index returns `error.InvalidValue` when
   `32 + 16·chunk_count > chunk_payload` — the header and the whole chunk
table must fit in chunk 0 (§6.7), because that is what makes the index's
first bytes readable without the chunk mapping. A packer that ignores this
produces an unreadable index.
2. A unit (header, slot, chunk entry, entry) is never split across a chunk
boundary; the writer ends the chunk early with zero filler instead (§6.7).
3. `chunk_payload` is a multiple of 16 (§6.7).
4. Every File's `buffer_address`/`buffer_offset` is recorded per §11.1
ruling 4 (addresses count from the File Set (Sub)Header, first buffer = 1).
5. Timestamps are the all-zero "ignored" form (clause 7) unless the caller
opts into real mtimes; the volume stays byte-reproducible (§12).
6. Children are presented to `index.write` in **NS1 byte order**. The entry
   area is written in that order, so it *is* the listing order the VFS's
   `readdir` returns (§7.6); a packer that presents unsorted children produces
   an unsorted enumeration that a reader cannot detect without a full scan.

### 8.2 The packer (phase 7)

One implementation (`writer.zig`), two frontends (`tension-pack`, and
`tension-core pack` routed through the C ABI). It is a build-time tool: the
runtime never writes a pak.

**Input and traversal.** A source directory and an output path. Directories
become Source directory Files; regular files become Source file Files;
**symlinks are resolved at pack time** (the target's bytes are packed as a
regular file, so no link ever survives into the pak, and a dangling link is an
error); anything else (fifo, socket, device) is skipped with a warning. Hidden
files are included — the packer has no name filter. Recursion depth is bounded
(64) so a cyclic symlink chain is an errno, not a hang. Directory order is
fixed by sorting every directory's children by **NS1 byte order**
(`std.mem.lessThan`), which is §8.1 invariant 6 and the only ordering the
reader trusts.

**Tree and layout are separate passes.** `walkSource` builds the node tree;
`planLayout` computes every offset, buffer assignment and stream boundary;
`writeLayout` emits bytes. The File Header carries FILE CHUNK SIZE (13.12) and
the File Set Header carries BUFFER SIZE (13.7), so neither can be written
before the layout is known — the generator's two-pass shape (measure, then
write) is therefore structural, not a convenience.

**One File per File Space; Buffers.** A File Space is the File's record
(File Header FT, File Information FT, File Data, trailer). Buffers are
`BUFFER_SIZE` bytes, a multiple of SECTOR, chosen once per pak:

- `BUFFER_SIZE = max(2048, round_up(largest_file_space + buffer_header_len + 14, SECTOR))`.

Placement, in pre-order (root first, then each directory's children in NS1
order, depth-first):

1. a **Source directory File always starts a new Buffer** and is the only File
   in it — its child-index Stream is finalized after the layout pass, so it is
   never packed against a neighbour;
2. leaf Files are packed densely into buffers, in order, and a File Space never
   straddles a Buffer (a File that does not fit starts the next Buffer);
3. the rest of every Buffer is a Blank Space FT (13.3), which is why a Buffer
   always leaves room for it (`+ 14` above).

**BUFFER SIZE is computed, not a flag (13.7).** The packer has no buffer-size
option and `tension-pack` exposes none: every Buffer in a volume is the same
size, and it is derived from the content it must hold. The algorithm, in
order:

1. measure every record with an empty payload (as above) and take
   `for a Source directory File: record_len`
   `for a leaf File: head_len + tail_len + 14`
   — a leaf's *payload* never enters this, because a payload that does not
   fit spans Buffers (§8.3); only the headers of a chunk have to fit;
2. `needed = max(those) + Buffer Header length + 14` (the Blank Space);
3. `buffer_size = 2048` (`MIN_BUFFER`), doubled until it is ≥ `needed`;
4. round up to a whole number of sectors;
5. refuse the volume if the result exceeds `MAX_BUFFER` (16 MiB).

So a tree of small Files gets 2048-byte Buffers, while a tree dominated by one
large *directory* — whose child-index Stream is a single File Space that may
not straddle a Buffer — gets whatever its index needs. That is why the 9e size
tests report the Buffer size they measured instead of assuming one: for an
8 MiB File among small Files it is 2048, and the test tree's 800-child
directory pushes the 20 MiB and 100 MiB cases to 65536.

**A File's recorded location is a *sector* pair, not a Buffer pair.** The
reader reconstructs a File Header's absolute position as
`(1 + BUFFER ADDRESS) * SECTOR + BUFFER OFFSET` (§11.1 ruling 4), so both
fields must be derived from the absolute offset together:
`address = file_off / SECTOR - 1`, `offset = file_off % SECTOR`. Using the
Buffer-relative offset instead folds whole sectors into the wrong field, which
produces a location that is right for the first File in a Buffer (offset < 512)
and wrong for every File after it — a bug that only appears once Files share a
Buffer. `writer.zig` therefore carries the pair on every Node and never
recomputes one field without the other. Flush order is: Volume
Header (sector 0), File Set Header (sector 1), the Buffers in address order,
File Set Trailer, then Blank Space to `image_len = trailer_off + SECTOR`.

**Child-index Stream.** Per directory, children are presented to
`index.write` in NS1 order (§8.1 invariant 6), so the entry area is the
listing order. `chunk_payload` is chosen by the guard of §8.1 invariant 1:

- start at **512** (the minimum; the committed fixture records it), double while `HEADER_LEN + CHUNK_ENTRY_LEN·chunk_count >
  chunk_payload`, stop at the first value that satisfies `plan()`, cap 65536.

Why 512 and not 4096: the committed `minimal.sidf` was written with
`chunk_payload = 512`, that field is part of the Stream's bytes, and phase 7
must reproduce the fixture byte-for-byte (§10). 4096 would change exactly that
one field. The guard, the growth rule and the cap are as specified; only the
starting value differs, and it is a single constant. Chunk physical positions
are patched after layout with `index.setChunkPosition`, and each child entry's
location (entry offset +10/+14, §6.7) is patched with the child's own File
Header position — the generator's placeholders-then-patch sequence, now driven
by the layout instead of by hand.

**File Data.** Directory: SOURCE DIRECTORY HEADER (empty, 13.15.4.1), Path FT,
Characteristics FT (`SOURCE DIRECTORY` bit), Stream Header FT + the index
Stream + Stream Trailer FT, SOURCE DIRECTORY TRAILER (empty, 13.15.4.2).
File: SOURCE FILE HEADER (empty, 13.15.5.1), Path FT, Characteristics FT
(empty), Stream Header FT + payload + Stream Trailer FT, SOURCE FILE TRAILER
(empty, 13.15.5.2). STREAM TYPE 0 (Data) and STREAM FORMAT 0 (Clear data)
throughout — phase 7 writes Stored payloads only (§8).

**Names, and the fields this project does not use.** PATH NAME in both the Path
FT and File Information FT is the **basename** (`assets` for the root, the
child's own name below it), NAME SPACE is 1 (NS1). FILE INFORMATION's PARENT
and PATH FULLY QUALIFIED follow the fixture generator's convention byte-for-
byte: the root records `PARENT = 1, PFQ = 1`, every other File records
`PARENT = 0, PFQ = 0`, and the Path FT does the same for PFQ. The reader in
this project resolves paths through the child index and never consults these
fields; they are recorded for interoperability and for other readers, and they are
not a place for the packer to improvise.

**Determinism.** Sorted traversal, all-zero timestamps (clause 7 "ignored"
form), a fixed File Set ID (`0x54454E53`), fixed labels (`TENSION`, source
`TENSION`, version `0.1.0`), and no filesystem metadata in any field. Two runs
over the same tree produce byte-identical output; the phase-7 test proves it
with `cmp`.

**Signature note.** `writeLayout(tree, layout, image, io) -> PackError!void`
emits into a caller-owned image buffer, not a streaming `std.io.Writer`: the
layout is two-pass and every table is patched in place (OFFSET TO END, FILE
CHUNK SIZE, index chunk positions, entry locations), so a streaming writer
would have to buffer the whole volume anyway. `pack` writes the buffer to disk
in one call.

**Known limitation (recorded, not hidden).** One File per File Space with
uniform Buffers means a pak with a very large asset sizes every Buffer to that
asset. **Files whose File Space exceeds `MAX_BUFFER` (16 MiB) are refused with
`-EINVAL` until multi-chunk File support lands** — single-chunk File Spaces are
what the reader in this project reads, so writing a larger File would produce a
volume it cannot read. Real paks with large assets (video, terrain, audio
streams) will hit this: multi-chunk Files per 10.6/13.12 are the **next storage
work**, not a bug. The spec's remedy is multi-chunk Files (10.6/13.12 File Chunks); the
reader in this project reads a single-chunk File Space, so phase 7 refuses a
File whose File Space exceeds the chosen `BUFFER_SIZE` growth cap
(`MAX_BUFFER = 16 MiB`) with `error.InvalidValue` instead of writing a volume
the reader cannot read. Chunked Files are the next storage work.

### 8.3 Multi-chunk Files (phase 9 — design)

Lifts the 16 MiB single-chunk limit. The standard already defines the
machinery; this section records exactly which parts of it we use, and which we
deliberately do not.

**What may span Buffers.** Leaf payloads — a Source file's Data Stream — when
their File Space exceeds `BUFFER_SIZE`. Source directory Files stay
single-Buffer: a child index Stream is metadata and fits far below any sane
buffer size (a 100 000-child directory is ~2.6 MB, §12b), and keeping
directories whole keeps `openIndex` unchanged on the hot path.

**Continuation framing (13.13).** A File's chunk 0 is its File Header FT
(13.12) with FILE CHUNK SIZE (`#0B`) recording *the bytes of this File in this
Buffer*. If the File does not fit, it continues in the **next Buffer**, whose
content begins with a File Continuation Header FT — recorded, per 13.13,
"within a Buffer, immediately after the Buffer Header Field Table" — carrying
the same FILE CHUNK SIZE Field for that chunk. The chain is therefore
*implicit and sequential*: chunk N+1 is the chunk-bearing Buffer after chunk
N's, and each chunk declares its own length, so chunk sizes need not be
uniform (13.13 places no such requirement, and 13.12's FILE CHUNK SIZE is a
per-File-Space count either way).

**No chunk table, and why.** §8.3's brief suggested an explicit table
("Recommended: put the chunk table in the File's Data Header FT as a Stream,
or store it as a companion File"). We are not doing that: the standard's own
chain is unambiguous and complete for *sequential* access, and any table would
be a structure this project invented — exactly the class of thing §5.4/§5.6
ruled out. The File's total payload size is already recorded (DATA STREAM
SIZE, 13.14), so a reader knows when the chain is finished without a sentinel:

    remaining = DATA STREAM SIZE
    for each chunk-bearing Buffer in order:
        read the chunk's FILE CHUNK SIZE (13.12 for chunk 0, 13.13 after)
        take that many bytes; remaining -= chunk size
        stop when remaining == 0

**Reader impact.** A File location stops being one `(buffer_address,
buffer_offset, size)` triple and becomes a chain:
`{ chunk_count, total_size, first }`, where following the chain means walking
Buffers (each chunk header is ~20 bytes). `Walker.resolve` already produces a
`Location`; it grows a `chunks` field that is `null` for single-chunk Files, so
the existing fast path is untouched — one chunk still resolves in one read.
`Walker.openData` returns the same `DataStream` shape, plus the chain for
multi-chunk Files.

**VFS impact.** `read` maps `file_offset` to `(chunk, offset_in_chunk)` by
walking the chain (cheap: each step is one small header read) and copies across
chunk boundaries when a request spans them. `seek` to an arbitrary offset uses
the same walk; `tell` is unchanged. The walker caches the chunk list of the
File it is currently reading (bounded: `MAX_FILE_CHUNKS = 4096`, i.e. files up
to 4096 × BUFFER_SIZE), so a sequential read touches each chunk header once.
A File with more chunks than that cap still reads correctly — each `read` walks
from the File's first chunk — it just loses the cache; nothing about the format
depends on the cap.

**Cache placement (ruled 2026-09-16).** The walker stays stateless:
`Walker.openData` returns the chain *description* `{chunk_count, total_size,
first}` and never caches. The chunk cache lives on the VFS `Handle`, per §7.3.
Three reasons, recorded because they are easy to get wrong later: (1) §8.3 and
§7.3 already rule the cache per-open, so a walker-side cache would contradict
this document; (2) a stateless walker is testable in isolation, while a cached
one carries hidden state every test must reset; (3) two handles on one File
share nothing by design, and a walker-side cache would break that isolation.
Corollary: the walker holds no reference to any VFS state — the Handle holds
the Walker, never the other way around.

**Reader-guard caveat (9a.5).** The reader-side guard is sufficient, not
necessary: a chunked File whose first chunk lands within ~26 bytes of its
payload total can slip past it. The writer-side guard is the real protection;
the reader guard is defense-in-depth for hand-constructed or third-party paks.

**Cache policy (phase 9, ruled).** The chunk list is cached **per open
handle**, not globally: two opens of the same File have independent caches, and
closing a handle drops its cache (§7.3). The cache is bounded at
`MAX_FILE_CHUNKS = 4096` entries: at 8 KiB Buffers that is ~32 MiB of payload
per File, so any File under ~32 MiB is fully cached after its first chunk walk.
A File with more chunks than the cap still reads correctly — every cold seek
beyond the cached window re-walks the chain from chunk 0, which is a
**documented cost, not a bug** (~20 bytes per chunk header, sequential I/O on
an already-mapped pak). The dominant access pattern (sequential read) touches
each chunk header once either way. A later phase may replace the hard cap with
an LRU window; v1 takes the hard cap because it is bounded, simple, and cannot
grow without limit on a 4 GiB File.

**Implementation (9c).** The cache is a `Handle` field holding the walker's
`ChunkSpan` list — `payload_abs` and `payload_len` per chunk, absolute image
coordinates. It is materialized on the first `read` **or** `seek` of a chunked
File and freed by `close`. A chain longer than `MAX_FILE_CHUNKS` is never
materialized: `read` asks the walker for each chunk it needs (`Walker.locate`,
one walk per chunk crossed), which is the documented cost above — the handle
simply has no cache to hit, and the policy is asserted by a test that packs a
File past the cap. Sequential reads carry a hint (the last chunk index and the
File offset it starts at), so advancing one chunk is arithmetic, not a walker
call; a backwards seek restarts the scan at chunk 0.

**Buffer-fill rule for chunks (found by the past-cap test).** A chunk's Buffer
must either end exactly at its data or leave room for a Blank Space FT (13.3,
14 bytes) — there is no third state, because blank space is how the remainder
of a Buffer is described. So a payload fill that would leave 1..13 bytes stops
short by that amount and puts those bytes in the final chunk, which has room
for them. Without this rule the packer plans a 1..13-byte gap that
`padWithBlankSpace` then refuses; small Files never land in the band, which is
why the bug survived the round-trip tests and surfaced only at 8 MB.

**Chain endings (9e).** Two shapes end a chain, and the walk accepts both.
Either the closing Stream/Source trailers follow the payload in the same File
Space, or the payload ended *exactly* at its Buffer's end and the trailers open
the next chunk — a File Space whose File Continuation Header FT (13.13) is
followed immediately by the STREAM TRAILER FT (13.15.7.2) with no payload in
between (FILE CHUNK SIZE = "bytes of this File contained in this Buffer"; zero
is a value). The packer emits the second shape whenever a chunk fills its
Buffer exactly, which is also why a File that fills a Buffer exactly stays
single-chunk: the exactly-full size is *not* split. The boundary therefore has
three regions, all derived from the packer by the 9e tests rather than
predicted: sizes that leave a Buffer with room for a Blank Space FT stay
single; the band just below the exactly-full size (13 bytes at 2 KiB Buffers)
is split, because the leftover is too small for a Blank Space FT and not zero;
and the exactly-full size is single again.

**Guards removed (9c).** Two interim guards kept phase-8 behaviour while the
reader half did not exist: a writer flag (`allow_multi_chunk`, default off,
refusing any File too large for one Buffer) and a one-line VFS refusal
(`-EINVAL` on opening a chunked File). Both are gone — the packer always chunks
and the VFS always reads a chain; there is no "strict single-chunk mode". The
guard test went with them; the boundary cases it explored (cap−1, cap, cap+1)
belong to the 9e test families.

**Recording convention for FILE CHUNK SIZE.** The standard says "Bytes of this
File contained in this Buffer" (13.12, 13.13) without saying whether the
count includes the File's own Header Field Tables. This project records the
**whole File Space recorded in that Buffer** — headers included — which is what
the committed fixture already does for its single chunk (its FILE CHUNK SIZE is
the File Space length, not the payload length). The reader subtracts the
headers it parses, so both readings are self-consistent; changing it would
break `minimal.sidf` byte-identity, which outranks an unobservable preference.

**Writer impact.** `planLayout` splits a leaf File whose File Space exceeds
`BUFFER_SIZE - continuation_header_len - blank_overhead`: chunk 0 carries the
File Header FT + File Information FT + File Data up to the Buffer's limit, and
each subsequent chunk opens a fresh Buffer with a File Continuation Header FT.
`MAX_BUFFER` stops being a refusal and becomes the point at which a File
switches to the chunked form. The removed invariant is replaced by two:
`chunk_size ≤ BUFFER_SIZE` for every chunk, and
`chunk count ≤ 0xFFFF_FFFF / BUFFER_SIZE` (FILE CHUNK SIZE is a 4-byte count,
13.12) — a File larger than that is still refused, now with a measured limit
rather than a 16 MiB one.

**Determinism.** Chunk boundaries are a pure function of payload size and
`BUFFER_SIZE`: fill each chunk to the Buffer limit, the last chunk takes the
remainder; no rounding, no heuristics, no dependence on file order. Two runs
over the same tree stay byte-identical, and `minimal.sidf` — whose only File is
one chunk — cannot change (§10).

### 8.4 Per-File payload compression (phase 10 — design)

**Scope.** Compression is per-File and decided at pack time. A File's Data
Stream carries the *stored* bytes — the Deflate stream when compressed, the
bytes themselves when stored — and the reader expands them before the guest
sees anything. Directory index streams are never compressed: they are already
small and they are the structure everything else is found through.

**Method ids** are the PKWARE APPNOTE values, as the §8 preamble already says
(and as `STREAM COMPRESS TYPE` `#8005`, 13.15.7.1, is defined to carry): **8 =
Deflate** (implemented), **93 = ZSTD** (reserved, optional second), **0 =
stored**. LZMA (14) stays decode-only/deferred.

**Recorded in both places (ruled 2026-09-16).** A compressed File says so
twice, and the two statements must agree:

* **Stream Header FT (13.15.7.1)** — the spec-native carrier, so a reader that
  knows only the standard can decode without knowing anything of ours:
  `STREAM FORMAT` = 2 (compressed data, 13.15.7.4), `STREAM COMPRESS TYPE`
  (`#8005`) = the PKWARE method id, `STREAM EXPANDED SIZE` (`#8006`) = the
  expanded size.
* **Child-index entry (§6.7)** — the runtime's fast path, so `stat` can report
  "compressed" (flags bit 0) and the guest-visible size without opening the
  stream: `compression_method` (u16) = the same id, flags bit 0 set,
  `size` = the expanded size.

If the two disagree when a File is read — a method present in one place and not
the other, an expanded size that does not match, a stream whose EXpanded SIZE
disagrees with the entry's `size` — the read is `-EIO`. Same
belt-and-suspenders rule as elsewhere: the fast path is never trusted alone.

**Levels are explicit, because determinism depends on them.** Deflate at level
6 — `std.compress.flate.Options.level_6`, the library's `default` — and ZSTD at
level 3 if it is ever added. A library default that moved with a version bump
would change bytes, so the level is pinned in the packer and recorded here.

**Threshold rule.** Compress a File iff

    compressed_len * 10 <= expanded_len * 9     (i.e. it shrinks by > 10%)

and `compressed_len < expanded_len`; otherwise store it with method 0. Both
conditions are checked against the *whole* File, before chunking, so the
decision is a pure function of the payload and the level — never of chunk
boundaries, tree order, or which Buffer the File lands in.

**What the numbers mean, and where they live.**

| Quantity | Field | Section |
| --- | --- | --- |
| method (0, 8, 93) | Data Stream's `STREAM COMPRESS TYPE` (`#8005`) **and** the child-index entry's `compression_method` | 13.15.7.1, §6.7 |
| "this File is compressed" | Data Stream's `STREAM FORMAT` = 2 **and** the entry's flags bit 0 (`FLAG_COMPRESSED`, §7.4) | 13.15.7.4 |
| expanded size | Data Stream's `STREAM EXPANDED SIZE` (`#8006`) **and** the child-index entry's `size` | 13.15.7.1, §6.7 |
| stored (compressed) size | the Data Stream's STREAM SIZE | 13.15.7.1 |
| stored (compressed) size, again | the File Information FT's DATA STREAM SIZE | 13.14 |

A stored File states method 0 in both places and leaves STREAM FORMAT 0, with
no STREAM EXPANDED SIZE — the size it already reports in STREAM SIZE.

The two sizes are therefore both recorded: `stat` and the guest API report the
*expanded* size (an index-entry property), while the stream tables describe the
*stored* bytes the reader has to find and read. `minimal.sidf` is unaffected:
its only File is one 6-byte payload, which cannot shrink by 10%, so it stays
stored — byte-identical, per §10.

**Reader.** `stat` needs nothing new (flags bit 0 is already reported). A read
on a compressed File expands the payload on first use into a per-open buffer of
exactly the expanded size, and every `read`/`seek`/`tell` after that operates on
expanded bytes — so seeks are O(1) once the File is open, at the cost of holding
the expanded File in memory for the life of the handle (freed by `close`, like
the chunk cache §8.3). A decode that fails, ends early, or produces a different
length than the entry's `size` is `-EIO`: no panics on the ABI boundary, and no
partially-decoded bytes are ever returned.

**Known limitation.** A compressed File costs expanded-size memory per open, and
the whole File is decoded before the first byte is served. Streaming decode with
a resumable inflate would remove both; it is deliberately not v1.

#### Resolved (ruled 2026-09-16)

The choice above was (b): the Stream Header carries the facts, the index entry
mirrors them, and a disagreement at read time is `-EIO`. Two consequences came
with the ruling and are settled here:

- **The example's large File stays stored.** It exists to exercise the uncached
  path (about 10,600 chunks against a 4096-chunk cache), and Deflate would take
  its bytes-0..63 pattern down to a few tens of kilobytes, quietly ending that
  coverage. So the 20 MiB asset is generated *incompressible* (a deterministic
  counter-based keystream, still a pure function of the offset, so the volume
  stays byte-reproducible) and is therefore stored, exactly as intended — the
  0..63 detail yields to the purpose. A second, compressible asset
  (`data/compressed.bin`, a couple of MiB) demonstrates compression at scale;
  its compressed form is small enough that the wrapped File stays cached, so its
  reads are cheap.
- **The 9e size tests generate incompressible payloads**, not a packer flag:
  they assert chunk counts above the cache cap, which only holds for payloads
  Deflate cannot shrink. A short repeating pattern would collapse and the tests
  would stop covering the uncached path they exist for. No test-only backdoor
  is added to the packer.

## 9. Volume sets, the size limit, and the ABI memory model

### 9.1 Volume sets and the size limit

Spec-faithful multi-volume split via the Volume Set machinery (4.21, 4.22,
11.2); no extension FIDs; the packer errors with the measured limit instead of
silently capping.

### 9.2 ABI memory model (ruled 2026-09-16)

Two load entry points exist, and the difference is who owns the bytes:

- `tension_res_load(bytes, len, …)` **copies** the blob into a Zig-owned
  buffer (the arena of the original plan). The Rust side may drop its source
  buffer immediately; the handle survives it. Scripts, tests, small paks.
- `tension_res_load_borrowed(bytes, len, …)` **borrows**: Zig keeps only the
  pointer and length. The caller guarantees the bytes outlive the handle.
  The Rust wrapper makes that a type-system guarantee rather than a
  convention: `ResourceSet<'a>` holds the backing bytes (or a `&'a [u8]`)
  alongside the raw handle, and `Drop` frees the handle before the buffer —
  so a borrowed set cannot outlive its source, and a mis-ordered drop is
  impossible.

Why both: the engine path hands over the mapped pak that is already resident,
and copying a 500 MB volume would double the largest resident object in the
process for no benefit. The owned path stays because it is the only safe
choice when the bytes come from a temporary (a `Vec` that will be dropped, a
test fixture on the stack).

Both entry points parse the same way and produce the same handle type; the
only difference is whether `tension_res_free` releases the buffer it serves.
A borrowed handle never touches the caller's memory except to read it, and the
reader gets no write path into the pak at all (§7).

**Build facts the ABI depends on** (found the hard way in phase 6, so they are
written down):

1. The static archive must be built **position-independent** (`.pic = true`).
   The Rust host links a PIE; a non-PIC archive fails with
   `relocation R_X86_64_32S cannot be used against local symbol`.
2. The archive must **bundle compiler-rt** (`lib.bundle_compiler_rt = true`).
   A static library does not get it by default, and the other side's linker is
   `cc`, not `zig` — without it the final link dies on `__zig_probe_stack`.
3. The library's compilation root must be **`src/c_api.zig`**, not
   `src/root.zig`. Zig analyses declarations lazily: a module that merely
   *names* `c_api` emits an archive with no code at all (it links, and every
   symbol is undefined).
4. Rust may reuse this archive freely because it holds only the ABI's 12
   `export fn`s plus what they reach.

Spec-faithful multi-volume split via the Volume Set machinery (4.21, 4.22,
11.2); no extension FIDs; the packer errors with the measured limit instead of
silently capping.

## 10. Verification: the 100k pruning test (to be completed in phase 2)

Fixture, instrumentation, and the five assertions; the #1 and #3 thresholds
are set in §6.6; the independent Python reader is the cross-check.

## 11. Robustness

- Every read is bounds-checked before use; malformed input yields negative
  errno-style codes, never a panic. The resynchronization pattern `#A55A`
  (6.23) is the standard's framing mechanism (10.5) and is used the same way
  when recovering a damaged or foreign region.
- An unknown or unsupported compression method id leaves `stat` working and
  makes `read` return `-EIO` for that File only.
- The VFS's fd table is finite (`MAX_FDS`): exhaustion is `-EMFILE` (-24), an
  addition to the plan's six codes; the record's `flags` bit 0 marks a
  compressed payload (§7.4).
- **Missing paths are strict at the VFS layer.** Any path that does not resolve
  in a loaded pak — every path when no pak is loaded, and any lookup or
  enumeration inside a directory File that has no child-index Stream — returns
  `-ENOENT`. The framework layer translates (`null` for stat/open, `[]` for
  list) per §7, so the two layers never disagree. The reader does not panic and
  does not attempt to reconstruct the lookup from the File Set Index — that
  index is in recording order (13.10), not name order, and cannot be
  binary-searched.

### 11.1 Spec conflicts resolved (ruled 2026-09-16)

1. **Annex A vs Annex C field framing — follow Annex A.** A reader cannot see a
   Data Length part the FID says is not there. Exactly two fields conflict
   (`ATTRIBUTES` `#81F2FE`: Annex A fixed 4 bytes, Annex C "Variable";
   `FILE IS INVALID` `#80F003`: Annex A fixed 1 byte, Annex C "Bit Data"); the
   test asserts the conflict list is exactly those two and fails on a third.
2. **`FILE TYPE` `#70` is mandatory** — per the section text of 13.12;
   Figure 25 is a diagram and the section text is normative.
3. **Resync byte order `A5 5A`** — 6.23 calls it a two-byte *Byte Sequence*,
   so the bytes are written in the order shown.
4. **`BUFFER ADDRESS` counts from the File Set (Sub)Header, first buffer = 1**
   (13.4). *Interop-sensitive:* every position in our own paks is
   self-consistent with this reading, but a third-party pak using a different
   origin would need a compatibility path; revisit if third-party paks appear.
5. **CRC-32 with trailing complement** — the reflected ITU Rec. X.25/IEEE
   CRC-32 (clause 9, seed −1), pinned by
   `crc32("123456789") = 0xCBF43926`.
6. **Index-Stream payload** — the v0 layout in the phase-2 generator was a
   placeholder; §6.7 is the final encoding.

## 12. Verification

`examples/res/verify/verify.py` is an independent ECMA-208 reader written in
Python from the specification text alone — Annex A for Field Identifiers,
Annex B for Data Length, 10.5 for Field Table framing, 6.23 for the
Resynchronization Pattern, 13.1/13.4/13.7 for the Volume, Buffer and File Set
Headers, 13.12/13.14 for the File, and 13.15.x for Path, Characteristics and
Streams. It shares no code and no constants with the Zig implementation, and it
parses a pak by walking Buffers, File Spaces and Streams structurally.
What it proves: the field, buffer, file, and stream framing in the volumes
this project writes is compatible with the corresponding framing defined in
ECMA-208, as interpreted under our profile (§2, §5.5, §6.7). No claim of full
ECMA-208 conformance is made — the directory tree is a content convention, not
a spec structure, and the standard's own index tables are not used at
runtime.
What it does not prove: that a third party can read the *directory tree*,
because the hierarchy is a content convention carried inside a Stream payload
(§5.5, §6.7) rather than a structure the standard defines. A reader that knows
only the standard can extract any File by its PATH NAME and read its Data
Stream; it cannot enumerate a nested namespace without interpreting our
convention.

## 12b. Cost estimate (metadata only)

Assumptions (parameters, not claims): `L` = average NS1 name length = 20 bytes;
10 children per directory on average, so for `N` assets the directory count is
`D ≈ N/10` and the node count ≈ `1.1 N`; timestamps omitted (reproducible
packing); CRC fields empty per 10.5; 64 KiB Buffers; metadata uncompressed
(stream content is clear data, 13.15.7.4.1).

Field-width citations: FIDs are 1–4 bytes (Annex A.1–A.5); the Data Length
part is 1 byte for lengths ≤ 127, 2–9 bytes beyond (Annex B.1, B.2); every
Field Table opens and closes with the same FID, the opener carrying the 2-byte
resync pattern `#A55A` (6.23, 10.5) and the closer CRC-or-empty (clause 9 /
10.5); a timestamp is 12 bytes (clause 7); a Buffer Header Field Table is
mandatory per Buffer (13.4).

**Bounded searches.** Any test that searches for a layout boundary must be
bounded by a step count as well as by its predicate. An unbounded search whose
terminating condition is removed by an unrelated change does not fail — it
writes ever-larger Files until something stops it. Both boundary scans in the
9e size tests carry an explicit step cap and assert that they stopped on a
result rather than on the cap.

**Known artifacts (build tooling, not the format).** Under `zig build test`,
this Zig 0.16 build runner prints a trailing `failed command: …/test
--listen=-` line whenever the test process writes anything to stderr: it is the
verbose-context header for a step that produced stderr output, emitted "no
matter the result" (`lib/compiler/build_runner.zig`, `printErrorMessages`). It
is not a failure — the build exits 0 and reports every test as passing — and
`zig test tests.zig` prints no such line.

**Per asset File** (13.12 File Header FT, 13.14 File Information FT,
13.15/13.15.5 File Data) ≈ **128 B** at L = 20: File Header FT ≈ 16 B
(`#09`, `#0B`, `#70`); File Information FT ≈ 62 B (`#813F`, `#81F2FE`,
`#81F0FD`, `#50`, `#81F2FC`, `#81F2FB`, `#11` + `#12` = 2 + L); File Data
Header FT ≈ 6 B (`#0E`); Path FT ≈ 34 B (`#10`, `#50`, `#11`, `#12` = 2 + L);
Characteristics FT ≈ 6 B (`#13`); Trailer FT ≈ 6 B (`#0F`).

**Per directory File**: the same chain with the directory variants (13.15.4.1
`#0C`, 13.15.4.2 `#0D`) plus its index Stream (13.15.7.1 `#1D`, `#2B`, `#2C`,
`#20` ≈ 18 B; 13.15.7.2 `#1E` ≈ 6 B) — ≈ 128 B + 24 B.

**Per node, parent-side index cost**: one 16-byte slot + one entry ≈ `24 + L`
= 44 B at L = 20 (2 B FID/length overhead, kind/size/flags ≈ 10 B, location
triple `#80F100`/`#08`/`#808014` ≈ 12 B of values plus their FID/length
bytes).

**Per Buffer**: Buffer Header FT ≈ 42 B (13.4: `#05`, `#01`, `#60`, `#06`,
`#07`, `#08`, `#8000`, `#8072`, `#80F403` = 12-byte timestamp); one per memory
Buffer — negligible for metadata (< 0.1 % at 64 KiB).

**Totals** (≈ 0.21 KiB per node; payload excluded):

| assets | nodes | metadata |
| --- | --- | --- |
| 10k | ≈ 11k | ≈ 2.4 MB |
| 100k | ≈ 110k | ≈ 24 MB |
| 1M | ≈ 1.1M | ≈ 240 MB |

**Sanity check: 100k assets ⇒ ≈ 24 MB of metadata** — two orders of magnitude
below the "low-hundreds of MB" target, so the 500 MB stop condition is *not*
triggered and the design proceeds. Known cost, recorded rather than hidden:
the path string is carried twice per File — once in the File Information FT
and once in the Path FT — because both tables are mandatory (13.14, 13.15.1);
at 1M assets that duplication is part of the ≈ 240 MB figure.
