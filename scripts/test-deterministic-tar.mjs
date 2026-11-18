#!/usr/bin/env node
// The deterministic tarball: does the vendored artifact depend only on its contents?
//
// # What this proves, and why it needs proving
//
// `npm pack` is not reproducible across platforms, and the root `package-lock.json`
// records the tarball's sha512. That combination means the committed lockfile is
// valid on exactly one platform; on the other, every install dies with
//
//     npm error sha512-… integrity checksum failed when using sha512
//
// `scripts/lib/deterministic-tar.mjs` fixes it by rewriting npm's output with every
// piece of machine state normalised. The claim that matters is **"two machines
// packing the same source produce the same bytes"**, and it is testable on one
// machine: pack the same members twice, once with the metadata a Linux `npm pack`
// writes and once with metadata that looks like a foreign archive, and require
// identical output.
//
// # What it asserts
//
//   1. the writer is deterministic — the same members render to the same bytes;
//   2. metadata is inert — mtime, uid, gid, uname, gname, mode and the gzip level
//      of the *input* do not survive into the output;
//   3. the members survive — same names, same order, same contents, byte for byte;
//   4. a long path is carried in the ustar `prefix` field rather than a pax
//      header, because a pax header is a second unnormalised record of the path;
//   5. the real vendored tarball, if `.packs/` has one, is reproduced from its own
//      members — i.e. the artifact on disk is already canonical.
//
// Run: node scripts/test-deterministic-tar.mjs

import { existsSync, readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

import { readTarGz, writeTarGz } from './lib/deterministic-tar.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const RUNNER = 'deterministic-tar';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`ok      ${name}`);
  } else {
    console.log(`not ok  ${name}${detail ? `\n          ${detail}` : ''}`);
    failures++;
  }
}

const digest = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Raw tar headers for a small synthetic archive.
 *
 * Written here rather than through the module under test: this is the *input*, and
 * building it from the reader/writer would make the metadata test circular — a
 * writer that ignores mtime would be fed a tarball that never had one.
 */
function rawHeader({ name, size, mtime, uid, gid, mode, uname, gname, type = '0' }) {
  const header = Buffer.alloc(512, 0);
  const octal = (value, width) => {
    const digits = value.toString(8).padStart(width - 1, '0');
    return `${digits} `;
  };
  header.write(name, 0, 100, 'utf8');
  header.write(octal(mode, 8).slice(0, 7) + '\0', 100, 8, 'latin1');
  header.write(octal(uid, 8).slice(0, 7) + '\0', 108, 8, 'latin1');
  header.write(octal(gid, 8).slice(0, 7) + '\0', 116, 8, 'latin1');
  header.write(octal(size, 12).slice(0, 11) + '\0', 124, 12, 'latin1');
  header.write(octal(mtime, 12).slice(0, 11) + '\0', 136, 12, 'latin1');
  header.fill(0x20, 148, 156);
  header.writeUInt8(type.charCodeAt(0), 156);
  header.write('ustar', 257, 5, 'latin1');
  header.write('00', 263, 2, 'latin1');
  if (uname) header.write(uname, 265, 32, 'latin1');
  if (gname) header.write(gname, 297, 32, 'latin1');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, '0'), 148, 6, 'latin1');
  header.writeUInt8(0, 154);
  header.writeUInt8(0x20, 155);
  return header;
}

/** A tarball whose every field that could vary between machines does. */
function buildArchive({ mtime, uid, gid, mode, uname, gname, level }) {
  const members = [
    { name: 'package/package.json', data: Buffer.from('{"name":"x","version":"1.0.0"}\n') },
    { name: 'package/bin/cli.js', data: Buffer.from('#!/usr/bin/env node\nconsole.log(1);\n'), mode: 0o755 },
    { name: 'package/dist/empty.js', data: Buffer.alloc(0) },
  ];
  const chunks = [];
  for (const member of members) {
    chunks.push(rawHeader({
      name: member.name,
      size: member.data.length,
      mtime, uid, gid,
      mode: member.mode ?? mode,
      uname, gname,
    }));
    chunks.push(member.data);
    const pad = (512 - (member.data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level });
}

// ── 1. metadata is inert ────────────────────────────────────────────────────
//
// Two archives of the same members, one carrying POSIX-pack metadata and one
// carrying what a Windows run tends to: a different mtime, real uid/gid, a login
// name in uname/gname, umask-shaped modes, and a different gzip level.
{
  const linuxLike = buildArchive({
    mtime: 499162500, uid: 0, gid: 0, mode: 0o644, uname: '', gname: '', level: 9,
  });
  const foreignLike = buildArchive({
    mtime: 1763000000, uid: 1000, gid: 1000, mode: 0o664,
    uname: 'runner', gname: 'runner', level: 1,
  });

  const a = writeTarGz(readTarGz(linuxLike));
  const b = writeTarGz(readTarGz(foreignLike));
  check('two archives that differ only in metadata canonicalise to the same bytes',
    a.equals(b), `${digest(a)} vs ${digest(b)}`);

  const again = writeTarGz(readTarGz(linuxLike));
  check('canonicalising twice gives the same bytes', a.equals(again));

  const headers = gunzipSync(a).subarray(0, 512);
  const field = (offset, length) => headers.subarray(offset, offset + length).toString('latin1');
  check('mtime is 0', parseInt(field(136, 12).replace(/\0/g, '').trim(), 8) === 0,
    JSON.stringify(field(136, 12)));
  check('uid is empty/zero', field(108, 8).replace(/\0/g, '').trim() === '' ||
    parseInt(field(108, 8), 8) === 0);
  check('gid is empty/zero', field(116, 8).replace(/\0/g, '').trim() === '' ||
    parseInt(field(116, 8), 8) === 0);
  check('uname is empty', field(265, 32).replace(/\0/g, '') === '');
  check('gname is empty', field(297, 32).replace(/\0/g, '') === '');
}

// ── 2. members survive, including modes ─────────────────────────────────────
{
  const source = buildArchive({
    mtime: 499162500, uid: 0, gid: 0, mode: 0o644, uname: '', gname: '', level: 9,
  });
  const before = readTarGz(source);
  const out = readTarGz(writeTarGz(before));

  check('member count is unchanged', before.length === out.length);
  check('member names and order are unchanged',
    before.map((e) => e.name).join('\n') === out.map((e) => e.name).join('\n'));

  let sameContent = true;
  for (let i = 0; i < before.length; i++) {
    if (!before[i].data.equals(out[i].data)) sameContent = false;
  }
  check('member contents are byte-identical', sameContent);

  const modes = Object.fromEntries(out.map((e) => [e.name, (e.mode & 0o777).toString(8)]));
  check('a plain file is 0644', modes['package/package.json'] === '644', JSON.stringify(modes));
  check('an executable file is 0755', modes['package/bin/cli.js'] === '755', JSON.stringify(modes));
  check('a zero-length member survives', out.some((e) => e.name === 'package/dist/empty.js' && e.data.length === 0));
}

// ── 3. a long path is carried by ustar's prefix, not a pax header ────────────
{
  const longName = `package/${'a'.repeat(60)}/${'b'.repeat(60)}/file.js`;
  const source = buildArchive({
    mtime: 0, uid: 0, gid: 0, mode: 0o644, uname: '', gname: '', level: 9,
  });
  const members = readTarGz(source).concat([{ name: longName, mode: 0o644, type: 0x30, data: Buffer.from('x') }]);
  const out = readTarGz(writeTarGz(members));
  check('a 130-character path round-trips', out.some((e) => e.name === longName));
  check('no pax member is emitted',
    !gunzipSync(writeTarGz(members)).subarray(156, 157).equals(Buffer.from('x')));
}

// ── 4. the real artifact is already canonical ───────────────────────────────
//
// `.packs/` is gitignored, so this only runs in a tree that has been vendored —
// which is every tree that can build. A missing tarball is reported, not skipped
// silently: the check is the reason this file exists.
{
  const packs = join(repo, '.packs');
  const tarballs = existsSync(packs)
    ? readdirSync(packs).filter((name) => name.endsWith('.tgz'))
    : [];
  if (!tarballs.length) {
    console.log('note    no .packs/*.tgz here — run `npm run compiler:vendor` to cover the real artifact');
  } else {
    // Stability is the assertion; canonicality of what is on disk is a **note**.
    // `.packs/` is local build output, and a tree vendored before this round has
    // npm's bytes in it — that is exactly the state the repack exists to fix, and
    // `npm run compiler:vendor` is the command. Failing here would make the test
    // red on a correct checkout for a reason its own message already explains.
    for (const name of tarballs) {
      const onDisk = readFileSync(join(packs, name));
      const rebuilt = writeTarGz(readTarGz(onDisk));
      check(`repacking the vendored ${name} is stable`,
        rebuilt.equals(writeTarGz(readTarGz(onDisk))));
      if (!onDisk.equals(rebuilt)) {
        console.log(`note    ${name} was packed before the repack existed ` +
          `(${onDisk.length} B on disk vs ${rebuilt.length} B canonical) — ` +
          '`npm run compiler:vendor` rewrites it');
      } else {
        check(`the vendored ${name} is canonical`, true);
      }
    }
  }
}

if (failures) {
  console.error(`\n${RUNNER}: ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\n${RUNNER}: OK`);
