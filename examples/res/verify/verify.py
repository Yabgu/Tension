#!/usr/bin/env python3
"""verify.py - an independent ECMA-208 (SIDF) reader.

Clean-room statement
--------------------
This reader was written from the ECMA-208 1st edition (December 1994) text
alone: the Field Identifier structure from Annex A, the Field Data Length
structure from Annex B, Field Table framing from 10.5, the Resynchronization
Pattern from 6.23 (#A55A), the Field Identifiers from the Annex C tables, and
the Buffer/File structure from 10.6 and 13.x, and the File Continuation
Header Field Table from 13.13 for Files whose payload spans Buffers. It neither imports nor consults
the Zig implementation (tension-res/src/*.zig) or the fixture generator, and
every constant below carries the section it came from.

Honest limitation: the author of this script also wrote the packer, so this is
not a *blind* second implementation. What it does prove is narrower and still
worth having - the volume parses with a reader written from the specification
in a different language, sharing no code and no constants with the Zig side.

Usage:
    python3 verify.py <pak> [path-inside-pak] [--raw]

Prints the parsed volume summary and, when a name is given, extracts that File
and writes its bytes to stdout. Files are located by their PATH NAME (13.15.1),
which this volume records as the basename: the directory hierarchy lives inside
a Stream payload and is deliberately opaque here. Exit 0 on success, 1 on any
conformance failure.
"""

import sys
import zlib

RESYNC = b"\xA5\x5A"  # 6.23: the two-byte Byte Sequence #A55A

# ---- Annex C field identifiers (spec text, Annex C tables) -----------------
FID_NULL = 0x00  # Annex A.2.1: the NULL Field
FID_OFFSET_TO_END = 0x01  # 13.1
FID_SOURCE_NAME = 0x02  # 13.7
FID_SOURCE_OS = 0x03  # 13.7
FID_BUFFER_HEADER = 0x05  # 13.4
FID_BUFFER_SIZE = 0x06  # 13.7 / 13.4
FID_BUFFER_SEQUENCE = 0x07  # 13.4
FID_BUFFER_ADDRESS = 0x08  # 13.4
FID_FILE_HEADER = 0x09  # 13.12
FID_FILE_CHUNK_SIZE = 0x0B  # 13.12
FID_SOURCE_DIRECTORY_HEADER = 0x0C  # 13.15.4.1
FID_SOURCE_DIRECTORY_TRAILER = 0x0D  # Annex D: closes Source directory File Data
FID_SOURCE_FILE_HEADER = 0x0E  # 13.15.5.1
FID_SOURCE_FILE_TRAILER = 0x0F  # 13.15.5.2
FID_UNUSED_IN_THIS_BUFFER = 0x8000  # 13.4: length of unused Blank Space
FID_NAME_SPACE = 0x11  # 13.15.1 / 13.14
FID_PATH_NAME = 0x12  # 13.15.1 / 13.14
FID_CHARACTERISTICS = 0x13  # 13.15.2
FID_STREAM_HEADER = 0x1D  # 13.15.7.1
FID_STREAM_TRAILER = 0x1E  # 13.15.7.2
FID_STREAM_SIZE = 0x20  # 13.15.7.1
FID_STREAM_COMPRESS_TYPE = 0x8005  # 13.15.7.1 (Figure/Annex C)
FID_STREAM_EXPANDED_SIZE = 0x8006  # 13.15.7.1
FID_FILE_TYPE = 0x70  # 13.12
FID_STREAM_TYPE = 0x2B  # 13.15.7.1
FID_STREAM_FORMAT = 0x2C  # 13.15.7.1
FID_PATH_FULLY_QUALIFIED = 0x50  # 13.14
FID_BUFFER_TYPE = 0x60  # 13.4
FID_FILE_INFORMATION = 0x813F  # 13.14
FID_FILE_CONTINUATION_HEADER = 0x8001  # 13.13, Figure 26
FID_FILE_SET_HEADER = 0x808004  # 13.7
FID_FILE_SET_TRAILER = 0x808009  # 13.9
FID_SECTOR_SIZE = 0x80800E  # 10.1
FID_BLANK_SPACE = 0x808019  # 13.3
FID_VOLUME_HEADER = 0x808000  # 13.1
FID_DATA_STREAM_SIZE = 0x81F2FB  # 13.14
FID_PARENT = 0x81F0FD  # 13.14

# 13.15.4 / 13.15.5: Source directory and Source file File Types
FILE_TYPE_SOURCE_DIRECTORY = 3
FILE_TYPE_FILE = 4


class ConformanceError(Exception):
    """A structure did not match what the specification requires."""


class Field:
    __slots__ = ("fid", "data", "bits", "raw_len")

    def __init__(self, fid, data, bits, raw_len):
        self.fid = fid
        self.data = data
        self.bits = bits  # Annex B.3: Bit Data carries its value in the length part
        self.raw_len = raw_len

    def uint(self):
        return int.from_bytes(self.data, "little") if self.data else 0

    def __repr__(self):
        return "Field(0x%X, %r, bits=%r)" % (self.fid, self.data[:8], self.bits)


def read_fid(buf, pos):
    """Annex A: 1- to 4-byte Field Identifiers.

    A.2: b7 == 0 -> 1-byte; b6 == 0 -> variable data length, else the data
    length is 2^(b2..b0) and the Data Length part is omitted.
    A.3: b7b6 == 10 and the second byte's b7 == 0 -> 2-byte.
    A.4: Case A - b7b6 == 10 with the second byte's b7 == 1 (3-byte);
         Case B - b7b6 == 11, 3-byte when the third byte's b7 == 0, else 4-byte.
    """
    if pos >= len(buf):
        raise ConformanceError("FID runs past the end of the image")
    b0 = buf[pos]
    if b0 & 0x80 == 0:  # 1-byte
        return b0, pos + 1
    b1 = buf[pos + 1] if pos + 1 < len(buf) else None
    if b1 is None:
        raise ConformanceError("truncated 2-byte FID")
    if b0 & 0x40 == 0:  # b7b6 == 10
        if b1 & 0x80 == 0:  # 2-byte
            return (b0 << 8) | b1, pos + 2
        b2 = buf[pos + 2] if pos + 2 < len(buf) else None
        if b2 is None:
            raise ConformanceError("truncated 3-byte FID")
        return (b0 << 16) | (b1 << 8) | b2, pos + 3  # Case A
    b2 = buf[pos + 2] if pos + 2 < len(buf) else None
    if b2 is None:
        raise ConformanceError("truncated 3-byte FID")
    if b2 & 0x80 == 0:  # Case B, 3-byte
        return (b0 << 16) | (b1 << 8) | b2, pos + 3
    if pos + 3 >= len(buf):
        raise ConformanceError("truncated 4-byte FID")
    return (b0 << 24) | (b1 << 16) | (b2 << 8) | buf[pos + 3], pos + 4


def fid_is_fixed_length(fid, first, second=None):
    """Annex A: which FIDs carry their data length in the FID itself."""
    if first & 0x80 == 0:  # 1-byte
        return bool(first & 0x40), (first & 0x07) if first & 0x40 else None
    if second is None:
        return False, None
    if second & 0x80 == 0:  # 2-byte: second byte's b6
        return bool(second & 0x40), (second & 0x07) if second & 0x40 else None
    if second & 0x70 == 0x70:  # 3-byte Case A, fixed form (A.4)
        return True, second & 0x07
    return False, None  # variable length: a Data Length part follows


def read_field(buf, pos):
    """One Field: FID, optional Data Length part (Annex B), optional Data."""
    start = pos
    fid, pos = read_fid(buf, pos)
    first = buf[start]
    second = buf[start + 1] if start + 1 < len(buf) else None
    fixed, n = fid_is_fixed_length(fid, first, second)
    if fid == FID_NULL:
        return Field(fid, b"", None, 1), start + 1  # Annex A.2.1: no parts at all
    if fixed:
        size = 1 << n  # A.2: "2N expresses the length of the data"
        data = buf[pos : pos + size]
        if len(data) != size:
            raise ConformanceError("fixed-length Field data runs past the end")
        return Field(fid, data, None, pos + size - start), pos + size
    # Annex B: the Data Length part
    b = buf[pos]
    if b & 0xC0 == 0xC0:  # B.3 Bit Data: the value lives in this byte
        return Field(fid, b"", b & 0x3F, pos + 1 - start), pos + 1
    if b & 0x80 == 0:  # B.1 Direct: 1 byte, 0..127
        size = b & 0x7F
        pos += 1
    else:  # B.2 Indirect: 2^N little-endian bytes carry the length
        if b & 0x7C:
            raise ConformanceError("malformed Indirect Data Length part")
        nbytes = 1 << (b & 0x03)
        size = int.from_bytes(buf[pos + 1 : pos + 1 + nbytes], "little")
        pos += 1 + nbytes
    data = buf[pos : pos + size]
    if len(data) != size:
        raise ConformanceError("Field data runs past the end of the image")
    return Field(fid, data, None, pos + size - start), pos + size


def read_table(buf, pos, expect=None):
    """10.5: a Field Table starts and ends with Fields carrying the same FID;
    the first Field's Data part is the Resynchronization Pattern. OFFSET TO END
    is the second Field when present. Returns (fid, fields, end_pos)."""
    first, pos = read_field(buf, pos)
    if first.data != RESYNC:
        raise ConformanceError(
            "Field Table at %d does not start with the Resynchronization Pattern "
            "(FID 0x%X, data %r)" % (pos, first.fid, first.data)
        )
    if expect is not None and first.fid != expect:
        raise ConformanceError(
            "expected Field Table 0x%X, found 0x%X" % (expect, first.fid)
        )
    fields = []
    fid, new_pos = read_fid(buf, pos)
    if fid == FID_OFFSET_TO_END:  # 10.5: second Field when present
        ote, pos = read_field(buf, pos)
        fields.append(ote)
    while True:
        f, pos = read_field(buf, pos)
        if f.fid == first.fid:  # 10.5: the closing Field
            return first.fid, fields, pos
        fields.append(f)


def find(fields, fid):
    for f in fields:
        if f.fid == fid:
            return f
    return None


def find_all(fields, fid):
    return [f for f in fields if f.fid == fid]


class FileRecord:
    def __init__(self, offset, file_type, name, name_space, data_size, stream):
        self.offset = offset
        self.file_type = file_type
        self.name = name
        self.name_space = name_space
        self.data_size = data_size
        self.stream = stream  # (stream_type, stream_format, payload_bytes) or None

    def __repr__(self):
        kind = {FILE_TYPE_SOURCE_DIRECTORY: "dir", FILE_TYPE_FILE: "file"}.get(
            self.file_type, "type%d" % self.file_type
        )
        return "%s %r (ns=%r, %d bytes)" % (
            kind,
            self.name,
            self.name_space,
            len(self.stream[2]) if self.stream else 0,
        )


def parse_file_record(buf, pos, buffer_start, buffer_size):
    """A File Space (10.6): File Header FT, File Information FT, File Data.

    Returns (record, resume_pos, next_buffer_start). A File whose Data Stream
    does not fit in one Buffer continues in the next Buffer's File Continuation
    Header Field Table (13.13), which sits immediately after that Buffer's
    Buffer Header Field Table. `next_buffer_start` is the Buffer after the
    File's last chunk, so the volume walk does not re-enter Buffers this File
    consumed.
    """
    start = pos
    fh_fid, fh_fields, pos = read_table(buf, pos, expect=FID_FILE_HEADER)
    if fh_fid != FID_FILE_HEADER:
        raise ConformanceError("a File Space must start with a File Header FT")
    file_type = find(fh_fields, FID_FILE_TYPE)
    if file_type is None:
        raise ConformanceError("13.12: FILE TYPE is mandatory")
    file_type = file_type.uint()
    chunk_size_field = find(fh_fields, FID_FILE_CHUNK_SIZE)  # 13.12
    if chunk_size_field is None:
        raise ConformanceError("13.12: FILE CHUNK SIZE is mandatory in a File Header FT")
    chunk_size = chunk_size_field.uint()

    fi_fid, fi_fields, pos = read_table(buf, pos, expect=FID_FILE_INFORMATION)
    name = find(fi_fields, FID_PATH_NAME)
    name_space = find(fi_fields, FID_NAME_SPACE)
    data_size = find(fi_fields, FID_DATA_STREAM_SIZE)

    # 10.6: a Buffer holds its Buffer Header FT, then File Spaces, then Blank
    # Space. A File Space is therefore delimited by whatever comes next at the
    # structural level - the next File Header FT, a Buffer Header FT, Blank
    # Space or the File Set Trailer - and everything else belongs to this File.
    structural = (
        FID_FILE_HEADER,
        FID_BUFFER_HEADER,
        FID_BLANK_SPACE,
        FID_FILE_SET_TRAILER,
    )
    stream = None
    end_buffer = buffer_start + buffer_size
    while True:
        nxt, _ = read_fid(buf, pos)
        if nxt in structural:
            break
        tstart = pos
        fid, fields, pos = read_table(buf, pos)
        if fid != FID_STREAM_HEADER:
            continue  # Path FT, Characteristics FT, the File's own header/trailer
        stype = find(fields, FID_STREAM_TYPE)
        sformat = find(fields, FID_STREAM_FORMAT)
        ssize = find(fields, FID_STREAM_SIZE)
        if stype is None or sformat is None or ssize is None:
            raise ConformanceError(
                "13.15.7.1: STREAM TYPE, STREAM FORMAT and STREAM SIZE are mandatory"
            )
        # --- the Data Stream, which may span Buffers (10.6, 13.13) ----------
        #
        # FILE CHUNK SIZE is "bytes of this File contained in this Buffer"
        # (13.12, 13.13). The tables a File Space opens with are not bytes of
        # the stream, so this Buffer's share of the payload is the chunk size
        # minus those tables; the bytes follow the Stream Header FT (13.15.7).
        # 13.15.7.4: STREAM FORMAT 2 is compressed data, and 13.15.7.1 makes
        # STREAM COMPRESS TYPE and STREAM EXPANDED SIZE mandatory with it. This
        # reader never consults the project's index convention, so these are the
        # fields that tell it a File is compressed and how big it should become.
        compressed = sformat.uint() == 2
        ctype = find(fields, FID_STREAM_COMPRESS_TYPE)
        expanded_field = find(fields, FID_STREAM_EXPANDED_SIZE)
        if compressed and (ctype is None or expanded_field is None):
            raise ConformanceError(
                "13.15.7.1: a stream with STREAM FORMAT 2 must carry STREAM "
                "COMPRESS TYPE and STREAM EXPANDED SIZE"
            )
        if not compressed and (ctype is not None or expanded_field is not None):
            raise ConformanceError(
                "13.15.7.1: STREAM COMPRESS TYPE / STREAM EXPANDED SIZE are only "
                "meaningful for a compressed stream"
            )

        want = ssize.uint()
        covered = 0
        parts = []
        chunk_start = start
        overhead = pos - chunk_start
        if chunk_size < overhead:
            raise ConformanceError(
                "13.12: FILE CHUNK SIZE %d is smaller than the %d bytes of File "
                "Header and File Data tables this File Space opens with"
                % (chunk_size, overhead)
            )
        take = min(chunk_size - overhead, want)
        if pos + take > len(buf):
            raise ConformanceError("Stream data runs past the end of the image")
        parts.append(buf[pos : pos + take])
        covered += take
        pos += take
        while covered < want:
            # 13.13: the File continues in the next Buffer, whose File
            # Continuation Header FT is recorded immediately after its Buffer
            # Header FT; each continuation carries its own FILE CHUNK SIZE.
            chunk_start = buffer_start + buffer_size
            _bh_fid, _bh_fields, after_bh = read_table(
                buf, chunk_start, expect=FID_BUFFER_HEADER
            )
            _ch_fid, ch_fields, pos = read_table(
                buf, after_bh, expect=FID_FILE_CONTINUATION_HEADER
            )
            cont_size_field = find(ch_fields, FID_FILE_CHUNK_SIZE)
            if cont_size_field is None:
                raise ConformanceError(
                    "13.13: FILE CHUNK SIZE is mandatory in a File Continuation "
                    "Header FT"
                )
            cont_size = cont_size_field.uint()
            # 13.13 records the continuation FT after the *Buffer* Header FT,
            # and the Buffer Header FT belongs to the Buffer, not to any File
            # Space: the chunk's own bytes start at the continuation FT.
            overhead = pos - after_bh
            if cont_size < overhead:
                raise ConformanceError(
                    "13.13: FILE CHUNK SIZE %d is smaller than the %d bytes of "
                    "File Continuation Header this File Space opens with"
                    % (cont_size, overhead)
                )
            take = min(cont_size - overhead, want - covered)
            if take == 0:
                raise ConformanceError(
                    "%r: the chain carries no more payload, but STREAM SIZE "
                    "(13.15.7.1) is still %d bytes short"
                    % (name.data.decode("utf-8", "replace") if name else "?", want - covered)
                )
            if pos + take > len(buf):
                raise ConformanceError("Stream data runs past the end of the image")
            parts.append(buf[pos : pos + take])
            covered += take
            pos += take
            buffer_start += buffer_size
            end_buffer = buffer_start + buffer_size
        # 13.15.7.2: the Data Stream closes with a STREAM TRAILER FT. Either it
        # follows the payload in this File Space, or the payload ended exactly
        # at its Buffer and the trailers open the next chunk - a File
        # Continuation Space holding no bytes of the File (10.6's Figure 12
        # allows File data there of "0+1"). Both shapes are one rule: the
        # trailers come next, with no payload in between.
        nxt, _ = read_fid(buf, pos)
        if nxt != FID_STREAM_TRAILER:
            chunk_start = buffer_start + buffer_size
            _bh_fid, _bh_fields, after_bh = read_table(
                buf, chunk_start, expect=FID_BUFFER_HEADER
            )
            _ch_fid, ch_fields, pos = read_table(
                buf, after_bh, expect=FID_FILE_CONTINUATION_HEADER
            )
            cont_size_field = find(ch_fields, FID_FILE_CHUNK_SIZE)
            if cont_size_field is None:
                raise ConformanceError(
                    "13.13: FILE CHUNK SIZE is mandatory in a File Continuation "
                    "Header FT"
                )
            cont_size = cont_size_field.uint()
            if cont_size - (pos - after_bh) != 0:
                raise ConformanceError(
                    "%r: STREAM SIZE (13.15.7.1) is satisfied, but the next chunk "
                    "still holds %d bytes"
                    % (name.data.decode("utf-8", "replace") if name else "?",
                       cont_size - (pos - after_bh))
                )
            buffer_start += buffer_size
            end_buffer = buffer_start + buffer_size
            nxt, _ = read_fid(buf, pos)
            if nxt != FID_STREAM_TRAILER:
                raise ConformanceError(
                    "13.15.7.2: the last chunk of File %r does not close on a "
                    "STREAM TRAILER FT"
                    % (name.data.decode("utf-8", "replace") if name else "?")
                )
        _trailer_fid, _trailer_fields, pos = read_table(
            buf, pos, expect=FID_STREAM_TRAILER
        )
        payload = b"".join(parts)
        if len(payload) != want:
            raise ConformanceError(
                "%r: STREAM SIZE (13.15.7.1) says %d bytes, the chain carries %d"
                % (name.data.decode("utf-8", "replace") if name else "?", want, len(payload))
            )
        if data_size is not None and data_size.uint() != covered:
            raise ConformanceError(
                "%r: DATA STREAM SIZE (13.14) says %d bytes, the chain carries %d"
                % (name.data.decode("utf-8", "replace") if name else "?",
                   data_size.uint(), covered)
            )
        if compressed:
            # Method 8 is raw Deflate (PKWARE APPNOTE): no zlib wrapper, so the
            # window is -15. The expanded length must match what the Stream
            # Header promised, and STREAM SIZE above already matched the bytes
            # the chain carried.
            label = name.data.decode("utf-8", "replace") if name else "?"
            method = ctype.uint()
            if method != 8:
                raise ConformanceError(
                    "%r: STREAM COMPRESS TYPE %d is not one this reader decodes "
                    "(8 = Deflate)" % (label, method)
                )
            try:
                dec = zlib.decompressobj(-15)
                payload = dec.decompress(payload) + dec.flush()
            except zlib.error as e:
                raise ConformanceError("%r: Deflate decode failed: %s" % (label, e))
            if len(payload) != expanded_field.uint():
                raise ConformanceError(
                    "%r: STREAM EXPANDED SIZE (13.15.7.1) says %d bytes, Deflate "
                    "produced %d" % (label, expanded_field.uint(), len(payload))
                )
        if stream is None:  # the first Stream is the File's Data Stream
            stream = (stype.uint(), sformat.uint(), payload)
    return (
        FileRecord(
            start,
            file_type,
            name.data.decode("utf-8") if name else None,
            name_space.data.decode("ascii", "replace") if name_space else None,
            data_size.uint() if data_size else None,
            stream,
        ),
        pos,
        end_buffer,
    )


def parse_volume(buf):
    """The whole volume: Volume Header (13.1), File Set Header (13.7), then the
    Buffers (10.6) and the File Set Trailer (13.9)."""
    vh_fid, vh_fields, _ = read_table(buf, 0, expect=FID_VOLUME_HEADER)
    sector_size_field = find(vh_fields, FID_SECTOR_SIZE)
    if sector_size_field is None:
        raise ConformanceError("10.1: SECTOR SIZE is mandatory in the Volume Header")
    sector_size = sector_size_field.uint()
    if sector_size == 0 or (sector_size & (sector_size - 1)) != 0:
        raise ConformanceError("10.1: SECTOR SIZE must be a power of two")

    fsh_fid, fsh_fields, fsh_end = read_table(buf, sector_size, expect=FID_FILE_SET_HEADER)
    buffer_size_field = find(fsh_fields, FID_BUFFER_SIZE)
    if buffer_size_field is None:
        raise ConformanceError("13.7: BUFFER SIZE is mandatory in the File Set Header")
    buffer_size = buffer_size_field.uint()

    # 10.6: the File Set's Buffers follow the File Set Header, one Buffer per
    # Buffer Header FT + its File Spaces + Blank Space.
    pos = ((fsh_end + sector_size - 1) // sector_size) * sector_size
    records = []
    buffers = []
    while pos < len(buf):
        fid, _probe = read_fid(buf, pos)
        if fid != FID_BUFFER_HEADER:
            break  # 13.9: the File Set Trailer (or Blank Space) ends the Buffers
        buffer_start = pos
        bh_fid, bh_fields, after_bh = read_table(buf, pos, expect=FID_BUFFER_HEADER)
        btype = find(bh_fields, FID_BUFFER_TYPE)
        bsize = find(bh_fields, FID_BUFFER_SIZE)
        bseq = find(bh_fields, FID_BUFFER_SEQUENCE)
        baddr = find(bh_fields, FID_BUFFER_ADDRESS)
        unused = find(bh_fields, FID_UNUSED_IN_THIS_BUFFER)  # 13.4
        this_buffer_size = bsize.uint() if bsize else buffer_size
        used_end = pos + this_buffer_size - (unused.uint() if unused else 0)
        buffers.append(
            (
                bseq.uint() if bseq else None,
                baddr.uint() if baddr else None,
                btype.uint() if btype else None,
                this_buffer_size,
                0 if unused is None else unused.uint(),
            )
        )
        q = after_bh
        while q < used_end:
            if q + 1 < len(buf) and buf[q : q + 2] == b"\xA5\x5A":
                break  # Blank Space FT
            record, q, next_buffer = parse_file_record(buf, q, buffer_start, buffer_size)
            records.append(record)
            if next_buffer > pos + this_buffer_size:
                # The File spanned Buffers: its chunks consumed the following
                # Buffer(s), so the walk resumes after the last of them. Those
                # Buffers carry their own Buffer Header FTs (13.4) and are
                # recorded here, because the volume walk will not see them.
                b = pos + this_buffer_size
                while b < next_buffer and b + 2 <= len(buf):
                    _f, _hf, after = read_table(buf, b, expect=FID_BUFFER_HEADER)
                    _bt = find(_hf, FID_BUFFER_TYPE)
                    _bs = find(_hf, FID_BUFFER_SIZE)
                    _bq = find(_hf, FID_BUFFER_SEQUENCE)
                    _ba = find(_hf, FID_BUFFER_ADDRESS)
                    _bu = find(_hf, FID_UNUSED_IN_THIS_BUFFER)
                    buffers.append(
                        (
                            _bq.uint() if _bq else None,
                            _ba.uint() if _ba else None,
                            _bt.uint() if _bt else None,
                            _bs.uint() if _bs else buffer_size,
                            0 if _bu is None else _bu.uint(),
                        )
                    )
                    b += buffer_size
                pos = next_buffer - this_buffer_size
                break
        if q < len(buf) and buf[q : q + 2] == RESYNC:
            fid, fields, q = read_table(buf, q)  # 13.3 Blank Space
            if fid != FID_BLANK_SPACE:
                raise ConformanceError("expected a Blank Space FT, found 0x%X" % fid)
        pos += this_buffer_size

    return {
        "sector_size": sector_size,
        "buffer_size": buffer_size,
        "buffers": buffers,
        "records": records,
    }


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 1
    # --raw: write the File's bytes and nothing else, so a caller can compare
    # them with the source without the volume summary in the way.
    raw = "--raw" in argv
    argv = [a for a in argv if a != "--raw"]
    path = argv[1]
    want = argv[2] if len(argv) > 2 else None
    with open(path, "rb") as fh:
        buf = fh.read()
    try:
        volume = parse_volume(buf)
    except ConformanceError as e:
        print("CONFORMANCE FAILURE: %s" % e, file=sys.stderr)
        return 1

    if not raw:
        print("image            : %s (%d bytes)" % (path, len(buf)))
        print("sector size      : %d (10.1)" % volume["sector_size"])
        print("buffer size      : %d (13.7)" % volume["buffer_size"])
        print("buffers          : %d" % len(volume["buffers"]))
        for seq, addr, btype, size, unused in volume["buffers"]:
            print(
                "  buffer %s: address=%s type=%s size=%d unused=%d"
                % (seq, addr, btype, size, unused)
            )
        print("files            : %d" % len(volume["records"]))
        for r in volume["records"]:
            print("  %s" % r)

    if want is None:
        return 0
    # A File Record carries the File's PATH NAME (13.15.1 / 13.14) - the
    # basename, in this volume's convention. The directory hierarchy lives in
    # the child-index Stream, which is a content convention inside a Stream and
    # deliberately opaque to this reader; so a path is matched by its last
    # component here.
    base = want.rsplit("/", 1)[-1]
    matches = [r for r in volume["records"] if r.name == base]
    if not matches:
        print("no File named %r in the volume" % base, file=sys.stderr)
        return 1
    record = matches[0]
    if record.stream is None:
        print("File %r has no Data Stream" % want, file=sys.stderr)
        return 1
    stype, sformat, payload = record.stream
    if not raw:
        print(
            "stream           : type=%d format=%d size=%d (13.15.7.1)"
            % (stype, sformat, len(payload))
        )
        sys.stdout.flush()
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
