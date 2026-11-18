/**
 * @fileoverview A deterministic ustar writer, for the vendored compiler tarball.
 *
 * **Why this exists.** `npm pack` is not reproducible across platforms. The same
 * commit, packed on Linux and on Windows, produces tarballs that differ by ~1.6 KB
 * even though every member's path, size and content is identical — the delta is
 * tar/gzip metadata. That breaks the vendoring scheme in the one place it cannot
 * afford to break: the root `package-lock.json` records the tarball's sha512, so a
 * committed lockfile is valid on exactly one platform and every other machine
 * fails with `EINTEGRITY`:
 *
 *     npm error sha512-J1IFTJfj0sgG… integrity checksum failed when using sha512:
 *       wanted sha512-J1IFTJfj0sgG… but got sha512-w9wt1kqwCK/…
 *
 * The fix is to make the bytes a function of the *contents* and nothing else, so
 * two machines that pack the same commit produce the same file and the pin is
 * honest everywhere.
 *
 * **What is normalised**, and why each field is here rather than left to npm:
 *
 *   mtime            0 — the packing time is the one field guaranteed to differ
 *   uid / gid        0 — the packing user's ids are machine state
 *   uname / gname    empty — same, and they leak a login name into a public file
 *   mode             dirs 0755, members named by the package's `bin` 0755,
 *                    everything else 0644 — decided from committed metadata, never
 *                    from the packed mode (NTFS has no execute bit, so reading it
 *                    baked the packing platform into the artifact)
 *   pax headers      dropped — a pax `x` entry is a second, unnormalised record of
 *                    path and mtime, and its presence is itself platform-dependent
 *   member order     preserved — the order `npm pack` emitted, so the file list
 *                    stays reviewable against `package.json`'s `files`
 *
 * **Why the shipped artifact is a `.tar` and not a `.tgz`.** Canonicalising the tar
 * made the archive identical on Linux and Windows; the gzip wrapper did not become
 * identical, because Node's bundled zlib differs between those builds and emits
 * different deflate output for the same input. The architect measured both
 * canonical tarballs decompressing to byte-identical raw streams that still hashed
 * differently. Shipping the uncompressed stream removes the only remaining variable,
 * and npm installs a `file:` `.tar` happily (measured on that machine).
 *
 * **Why a hand-written writer and not `tar`.** A `tar` subprocess means GNU tar on
 * Linux and bsdtar on Windows, whose normalisation flags differ (`--mtime`,
 * `--owner`, `--format`). Writing 512-byte headers here is ~100 lines and has no
 * platform behaviour at all. Node's `zlib.gzipSync` already writes MTIME 0 in the
 * gzip header (measured: two gzips a second apart are byte-identical), so the
 * compression step needs nothing but the default.
 *
 * **The tar format is npm's own** — octal fields with a trailing space and NUL,
 * `ustar\0` + `00`, empty uid/gid/uname/gname for zero — so `npm pack`'s payload and
 * this writer agree field for field. `test-deterministic-tar.mjs` asserts exactly
 * that against the committed artifact, which is what makes "the repack changes
 * nothing but the metadata" a measurement rather than a hope.
 */

import { gunzipSync, gzipSync } from 'node:zlib';

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

/** Typeflags this module understands. Anything else is refused, not guessed at. */
const TYPE_FILE = 0x30; // '0'
const TYPE_PAX = 0x78; // 'x' extended header for the next entry
const TYPE_PAX_GLOBAL = 0x67; // 'g'
const TYPE_DIR = 0x35; // '5'

const zeros = Buffer.alloc(NAME_MAX);

function readString(buf, offset, length) {
  const end = buf.indexOf(0, offset);
  const stop = end === -1 || end > offset + length ? offset + length : end;
  return buf.toString('utf8', offset, stop);
}

function readOctal(buf, offset, length) {
  const text = readString(buf, offset, length).trim();
  if (!text) return 0;
  const value = parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/** `key=value\n` records out of a pax extended header's payload. */
function readPaxRecords(data) {
  const out = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = parseInt(data.toString('utf8', offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.toString('utf8', space + 1, offset + length - 1); // trailing \n
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return out;
}

/**
 * Read a gzipped tar into `[{ name, mode, type, data }]`.
 *
 * A pax extended header (`x`) is applied to the entry that follows it and then
 * dropped — its `path` and `mtime` take precedence over the header's own, which is
 * how a long path is carried. A global header (`g`) is dropped outright. Directory
 * entries are kept so a package that ships empty directories still round-trips.
 */
export function readTarGz(buffer) {
  return readTar(gunzipSync(buffer));
}

/**
 * Read an **uncompressed** tar into `[{ name, mode, type, data }]`.
 *
 * The artifact this tree ships is a plain `.tar` — see `writeTar` for why
 * compression had to go — so this is the reader the vendoring and the tests use for
 * anything they produced themselves. `readTarGz` remains for one job: reading what
 * `npm pack` hands back, which is still a `.tgz`.
 */
export function readTar(tar) {
  const entries = [];
  let offset = 0;
  let pendingPax = null;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker

    const name = readString(header, 0, NAME_MAX);
    const prefix = readString(header, 345, PREFIX_MAX);
    const size = readOctal(header, 124, 12);
    const type = header[156];
    const bodyStart = offset + BLOCK;
    const body = tar.subarray(bodyStart, bodyStart + size);
    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === TYPE_PAX) {
      pendingPax = readPaxRecords(body);
      continue;
    }
    if (type === TYPE_PAX_GLOBAL) {
      continue;
    }

    // A pax path wins over the header's, and may exceed the 100-byte field.
    let fullName = prefix ? `${prefix}/${name}` : name;
    if (pendingPax && pendingPax.path) fullName = pendingPax.path;
    pendingPax = null;

    entries.push({
      name: fullName,
      mode: readOctal(header, 100, 8),
      uid: readOctal(header, 108, 8),
      gid: readOctal(header, 116, 8),
      type,
      data: Buffer.from(body),
    });
  }
  return entries;
}

/** Octal in the field layout npm's own tar writer uses: digits, space, NUL. */
function writeOctal(header, value, offset, length) {
  const digits = length - 2;
  const text = Math.max(0, value).toString(8).padStart(digits, '0');
  if (text.length > digits) {
    throw new Error(`value ${value} does not fit in ${digits} octal digits`);
  }
  header.write(text, offset, digits, 'latin1');
  header.write(' ', offset + digits, 1, 'latin1');
  header.writeUInt8(0, offset + digits + 1);
}

/**
 * One 512-byte header. Numeric fields that mean "nothing" are written the way npm
 * writes them — an all-NUL field for zero uid/gid, not `"000000 "` — because the
 * point of this writer is to be indistinguishable from `npm pack` on the platform
 * where `npm pack` is already reproducible.
 */
function writeHeader({ name, mode, size, type }) {
  const header = Buffer.alloc(BLOCK, 0);

  let nameField = name;
  let prefixField = '';
  if (Buffer.byteLength(name) > NAME_MAX) {
    // ustar's own answer to a long path: split at a `/` so the tail fits `name`
    // and the head fits `prefix`. No pax header, which is the whole point.
    const slash = name.lastIndexOf('/', NAME_MAX);
    if (slash <= 0 || Buffer.byteLength(name.slice(slash + 1)) > NAME_MAX ||
        Buffer.byteLength(name.slice(0, slash)) > PREFIX_MAX) {
      throw new Error(`path too long for ustar without pax headers: ${name}`);
    }
    nameField = name.slice(slash + 1);
    prefixField = name.slice(0, slash);
  }

  header.write(nameField, 0, NAME_MAX, 'utf8');
  writeOctal(header, mode & 0o7777, 100, 8);
  // npm leaves uid/gid entirely NUL when they are zero; match it.
  header.writeUInt8(0, 108);
  header.writeUInt8(0, 116);
  writeOctal(header, size, 124, 12);
  writeOctal(header, 0, 136, 12); // mtime 0: the reproducibility field
  header.fill(0x20, 148, 156); // checksum placeholder: eight spaces
  header.writeUInt8(type, 156);
  header.write('ustar', 257, 5, 'latin1');
  header.writeUInt8(0, 262);
  header.write('00', 263, 2, 'latin1');
  // uname/gname stay all-NUL: empty, which is what npm writes for a pack.
  writeOctal(header, 0, 329, 8); // devmajor
  writeOctal(header, 0, 337, 8); // devminor
  if (prefixField) header.write(prefixField, 345, PREFIX_MAX, 'utf8');

  let checksum = 0;
  for (let i = 0; i < BLOCK; i++) checksum += header[i];
  header.write(checksum.toString(8).padStart(6, '0'), 148, 6, 'latin1');
  header.writeUInt8(0, 154);
  header.writeUInt8(0x20, 155);

  return header;
}

/**
 * The members a package's `bin` field names, as tar member paths.
 *
 * **This, and not the input mode, decides which members are executable.** The
 * first version of this module normalised "anything with an execute bit to 0755",
 * which reads the *filesystem* rather than the package: NTFS has no execute bit, so
 * on Windows nothing looked executable and the compiler's bin entry was written
 * 0644 against Linux's 0755. One header field, 1,606 bytes of compressed
 * difference, and `EINTEGRITY` on every install from the committed lockfile.
 *
 * `package.json`'s `bin` is metadata: identical on every platform by construction,
 * because it is committed. That is the only input this decision may have.
 *
 * `prefix` is the directory the pack root sits under — `package/` for an npm
 * tarball, `''` for one whose members are already relative.
 */
export function executableMembers(binField, prefix = 'package/') {
  const names = new Set();
  if (!binField) return names;
  const entries = typeof binField === 'string'
    ? [binField]
    : Object.values(binField);
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry) continue;
    // `bin` entries are written `./bin/tensionscript.js` or `bin/tensionscript.js`
    // by different tools and both mean the same member.
    const relative = entry.replace(/^[.][\\/]/, '').split(/[\\/]+/).join('/');
    names.add(`${prefix}${relative}`);
  }
  return names;
}

/**
 * The normalised mode for an entry.
 *
 * Directories are 0755; a member named by the package's `bin` is 0755; everything
 * else is 0644. **Never the input's mode** — see {@link executableMembers} for the
 * platform defect that made "anything executable" the wrong question.
 */
function normalisedMode(type, name, executables) {
  if (type === TYPE_DIR) return 0o755;
  return executables.has(name) ? 0o755 : 0o644;
}

/**
 * Write `[{ name, mode, type, data }]` back out as a deterministic gzipped tar.
 *
 * Order is the caller's; contents are copied verbatim; everything in the header
 * that could carry machine state is fixed. The two zero blocks at the end are
 * required by the format and are part of the digest.
 */
export function writeTar(entries, { executables = new Set() } = {}) {
  const chunks = [];
  for (const entry of entries) {
    const type = entry.type ?? TYPE_FILE;
    if (type !== TYPE_FILE && type !== TYPE_DIR) {
      throw new Error(`refusing to write entry type '${String.fromCharCode(type)}': ${entry.name}`);
    }
    const data = type === TYPE_DIR ? Buffer.alloc(0) : entry.data;
    chunks.push(writeHeader({
      name: entry.name,
      mode: normalisedMode(type, entry.name, executables),
      size: data.length,
      type,
    }));
    if (data.length) {
      chunks.push(data);
      const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

/**
 * The same bytes, gzipped. Used by the tests to build the *inputs* a platform's
 * `npm pack` produces — never by the vendoring, which writes `writeTar`'s output
 * directly.
 *
 * **Why the artifact is not compressed.** Canonicalising the tar made the *tar*
 * identical across platforms; the *gzip* was not, because Node's bundled zlib
 * differs between the Windows and Linux builds and emits different deflate streams
 * for identical input. Measured on the real Windows machine: both canonical tarballs
 * decompress to raw tar streams that are byte-identical (`cmp` clean, 10,465,280 B
 * each) and still hash differently (2,118,735 vs 2,120,348 bytes gzipped) — so the
 * remaining difference was the compressor, not the archive.
 *
 * A `.tar` preserves the property by construction instead of by luck, and npm
 * installs one from a `file:` spec (measured there: `added 4 packages`, exit 0). The
 * cost is size in a gitignored directory, which is the cheapest thing in this
 * scheme. Chasing a pinned deflate implementation would be a dependency carried
 * forever to save 8 MB of local disk.
 */
export function writeTarGz(entries, options = {}) {
  // Level 9 because that is what npm's own writer uses: measured on the vendored
  // payload, 10,465,280 bytes compress to exactly 2,118,805 at 9 and 2,142,077 at
  // Node's default 6. Matching it keeps test inputs the size a real `npm pack`
  // produces.
  return gzipSync(writeTar(entries, options), { level: 9 });
}

/**
 * The whole operation `vendor-compiler.mjs` needs: read what `npm pack` produced,
 * write it back with the metadata normalised.
 *
 * Returns the new bytes **and** a summary worth printing — how many entries, and
 * whether anything other than metadata changed. The caller compares the unpacked
 * member list on both sides rather than trusting the writer.
 */
export function repackDeterministic(buffer, options = {}) {
  const entries = readTarGz(buffer);
  return { buffer: writeTar(entries, options), entries };
}
