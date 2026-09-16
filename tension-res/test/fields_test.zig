//! Field-layer tests, phase 2a: hand-authored byte arrays against the
//! normative text, plus the cross-check of Annex C's declared field widths
//! against the widths Annex A's FID bit structure implies.
//!
//! The `spec_fixed` / `spec_non_fixed` tables below are generated from the
//! pinned standard's Annex C by tools/extract_spec.py. They exist so that a
//! FID's implied width is never taken on trust from the code: the test makes
//! the two normative sources disagree loudly if they ever do.

const std = @import("std");
const res = @import("../src/root.zig");
const fields = res.fields;
const testing = std.testing;

pub const SpecFixed = struct { name: []const u8, fid: fields.Fid, bytes: u32 };
pub const SpecNonFixed = struct { name: []const u8, fid: fields.Fid, kind: []const u8 };

// --- BEGIN GENERATED: Annex C field facts (tools/extract_spec.py) ---
//
// Every field the normative Annex C declares with a fixed data length,
// and every field it declares Variable or Bit Data. `fields.fixedLen`
// must reproduce the fixed widths and return null for the others;
// `known_fid_variable_annex_c_fixed` lists the FIDs whose bit structure
// (Annex A) implies a variable data part while Annex C declares a fixed
// length — recorded as an explicit, cited exception, never silently.

pub const spec_fixed = [_]SpecFixed{
    .{ .name = "ACCESS TIME", .fid = .{ .code = 0x44, .len = 1 }, .bytes = 16 },
    .{ .name = "ARCHIVE TIME", .fid = .{ .code = 0x54, .len = 1 }, .bytes = 16 },
    .{ .name = "BUFFER TYPE", .fid = .{ .code = 0x60, .len = 1 }, .bytes = 1 },
    .{ .name = "CLOSE TIME", .fid = .{ .code = 0x80F402, .len = 3 }, .bytes = 16 },
    .{ .name = "CREATION TIME", .fid = .{ .code = 0x64, .len = 1 }, .bytes = 16 },
    .{ .name = "CREATOR NAME SPACE", .fid = .{ .code = 0x81F2FC, .len = 3 }, .bytes = 4 },
    .{ .name = "DELETED FLAG", .fid = .{ .code = 0x81F0FE, .len = 3 }, .bytes = 1 },
    .{ .name = "DELTA BASE TIME", .fid = .{ .code = 0x8044, .len = 2 }, .bytes = 16 },
    .{ .name = "EXPIRATION TIME", .fid = .{ .code = 0x80F404, .len = 3 }, .bytes = 16 },
    .{ .name = "FILE SET ID", .fid = .{ .code = 0x8072, .len = 2 }, .bytes = 4 },
    .{ .name = "FILE SET TIME", .fid = .{ .code = 0x80F403, .len = 3 }, .bytes = 16 },
    .{ .name = "FILE TYPE", .fid = .{ .code = 0x70, .len = 1 }, .bytes = 1 },
    .{ .name = "FORMAT NAME", .fid = .{ .code = 0x8052, .len = 2 }, .bytes = 4 },
    .{ .name = "FORMAT VERSION", .fid = .{ .code = 0x8062, .len = 2 }, .bytes = 4 },
    .{ .name = "MODIFIED TIME", .fid = .{ .code = 0x74, .len = 1 }, .bytes = 16 },
    .{ .name = "PARENT", .fid = .{ .code = 0x81F0FD, .len = 3 }, .bytes = 1 },
    .{ .name = "PATH FULLY QUALIFIED", .fid = .{ .code = 0x50, .len = 1 }, .bytes = 1 },
    .{ .name = "POSIX FILE ID", .fid = .{ .code = 0x80F210, .len = 3 }, .bytes = 4 },
    .{ .name = "POSIX FILE MODE", .fid = .{ .code = 0x80F203, .len = 3 }, .bytes = 4 },
    .{ .name = "POSIX FILE SYSTEM ID", .fid = .{ .code = 0x80F20F, .len = 3 }, .bytes = 4 },
    .{ .name = "POSIX GROUP ID", .fid = .{ .code = 0x80F204, .len = 3 }, .bytes = 4 },
    .{ .name = "POSIX NUMBER OF LINKS", .fid = .{ .code = 0x80F20D, .len = 3 }, .bytes = 4 },
    .{ .name = "POSIX OWNER ID", .fid = .{ .code = 0x80F209, .len = 3 }, .bytes = 4 },
    .{ .name = "POSIX RDEVICE", .fid = .{ .code = 0x80F20E, .len = 3 }, .bytes = 4 },
    .{ .name = "STREAM TYPE SEQUENCE", .fid = .{ .code = 0x61, .len = 1 }, .bytes = 2 },
    .{ .name = "TOTAL STREAM SIZE", .fid = .{ .code = 0x81F2FA, .len = 3 }, .bytes = 4 },
    .{ .name = "VOLUME HEADER WRITE COUNT", .fid = .{ .code = 0x80F104, .len = 3 }, .bytes = 2 },
    .{ .name = "VOLUME SET SEQUENCE", .fid = .{ .code = 0x80F100, .len = 3 }, .bytes = 2 },
    .{ .name = "VOLUME SET TIME", .fid = .{ .code = 0x80F400, .len = 3 }, .bytes = 16 },
    .{ .name = "VOLUME SIZE", .fid = .{ .code = 0x80F201, .len = 3 }, .bytes = 4 },
    .{ .name = "VOLUME TIME", .fid = .{ .code = 0x80F401, .len = 3 }, .bytes = 16 },
};

pub const spec_non_fixed = [_]SpecNonFixed{
    .{ .name = "ATTRIBUTES", .fid = .{ .code = 0x81F2FE, .len = 3 }, .kind = "Variable" },
    .{ .name = "AUTHENTICATION", .fid = .{ .code = 0x8002, .len = 2 }, .kind = "Variable" },
    .{ .name = "BLANK SPACE", .fid = .{ .code = 0x808019, .len = 3 }, .kind = "Variable" },
    .{ .name = "BLOCK MAP", .fid = .{ .code = 0x25, .len = 1 }, .kind = "Variable" },
    .{ .name = "BLOCK SIZE", .fid = .{ .code = 0x24, .len = 1 }, .kind = "Variable" },
    .{ .name = "BUFFER ADDRESS", .fid = .{ .code = 0x08, .len = 1 }, .kind = "Variable" },
    .{ .name = "BUFFER CRC", .fid = .{ .code = 0x8008, .len = 2 }, .kind = "Variable" },
    .{ .name = "BUFFER HEADER", .fid = .{ .code = 0x05, .len = 1 }, .kind = "Variable" },
    .{ .name = "BUFFER OFFSET", .fid = .{ .code = 0x808014, .len = 3 }, .kind = "Variable" },
    .{ .name = "BUFFER SEQUENCE", .fid = .{ .code = 0x07, .len = 1 }, .kind = "Variable" },
    .{ .name = "BUFFER SIZE", .fid = .{ .code = 0x06, .len = 1 }, .kind = "Variable" },
    .{ .name = "CANT COMPRESS DATA", .fid = .{ .code = 0x81EFE6, .len = 3 }, .kind = "Bit Data" },
    .{ .name = "CHAR SPEC", .fid = .{ .code = 0x808040, .len = 3 }, .kind = "Variable" },
    .{ .name = "CHARACTERISTICS", .fid = .{ .code = 0x13, .len = 1 }, .kind = "Variable" },
    .{ .name = "COMPRESS FILE IMMEDIATE", .fid = .{ .code = 0x8116, .len = 2 }, .kind = "Bit Data" },
    .{ .name = "DELTA EXTENT OFFSET", .fid = .{ .code = 0x800A, .len = 2 }, .kind = "Variable" },
    .{ .name = "DELTA EXTENT OLD SIZE", .fid = .{ .code = 0x800B, .len = 2 }, .kind = "Variable" },
    .{ .name = "DEVICE INFO", .fid = .{ .code = 0x808032, .len = 3 }, .kind = "Variable" },
    .{ .name = "DO NOT COMPRESS FILE", .fid = .{ .code = 0x8115, .len = 2 }, .kind = "Bit Data" },
    .{ .name = "EXCLUSION OPTIONS", .fid = .{ .code = 0x29, .len = 1 }, .kind = "Bit Data" },
    .{ .name = "EXECUTE ONLY", .fid = .{ .code = 0x813B, .len = 2 }, .kind = "Bit Data" },
    .{ .name = "FILE CHUNK SIZE", .fid = .{ .code = 0x0B, .len = 1 }, .kind = "Variable" },
    .{ .name = "FILE CONTINUATION HEADER", .fid = .{ .code = 0x8001, .len = 2 }, .kind = "Variable" },
    .{ .name = "FILE HEADER", .fid = .{ .code = 0x09, .len = 1 }, .kind = "Variable" },
    .{ .name = "FILE INFORMATION", .fid = .{ .code = 0x813F, .len = 2 }, .kind = "Variable" },
    .{ .name = "FILE IS INVALID", .fid = .{ .code = 0x80F003, .len = 3 }, .kind = "Bit Data" },
    .{ .name = "FILE MARK INTERVAL", .fid = .{ .code = 0x808028, .len = 3 }, .kind = "Variable" },
    .{ .name = "FILE MARK USAGE", .fid = .{ .code = 0x808020, .len = 3 }, .kind = "Bit Data" },
    .{ .name = "FILE SET ABORTED", .fid = .{ .code = 0x808039, .len = 3 }, .kind = "Bit Data" },
    .{ .name = "FILE SET COMMENT", .fid = .{ .code = 0x80802B, .len = 3 }, .kind = "Variable" },
    .{ .name = "FILE SET CONTINUATION HEADER", .fid = .{ .code = 0x808035, .len = 3 }, .kind = "Variable" },
    .{ .name = "FILE SET HEADER", .fid = .{ .code = 0x808004, .len = 3 }, .kind = "Variable" },
    .{ .name = "FILE SET HEADER LOCATION", .fid = .{ .code = 0x80803C, .len = 3 }, .kind = "Variable" },
    .{ .name = "FILE SET INDEX", .fid = .{ .code = 0x808010, .len = 3 }, .kind = "Variable" },
    .{ .name = "FILE SET INDEX FIELDS", .fid = .{ .code = 0x808034, .len = 3 }, .kind = "Variable" },
    .{ .name = "FILE SET INDEX PRESENT", .fid = .{ .code = 0x80802D, .len = 3 }, .kind = "Bit Data" },
    .{ .name = "FILE SET LABEL", .fid = .{ .code = 0x808005, .len = 3 }, .kind = "Variable" },
    .{ .name = "FILE SET REGID.", .fid = .{ .code = 0x8009, .len = 2 }, .kind = "Variable" },
    .{ .name = "FILE SET SUBINDEX", .fid = .{ .code = 0x808033, .len = 3 }, .kind = "Variable" },
    .{ .name = "FILE SET TRAILER", .fid = .{ .code = 0x808009, .len = 3 }, .kind = "Variable" },
    .{ .name = "FILE SET TRAILER LOCATION", .fid = .{ .code = 0x80803F, .len = 3 }, .kind = "Variable" },
    .{ .name = "FSH PARTITION NUMBER", .fid = .{ .code = 0x80803B, .len = 3 }, .kind = "Variable" },
    .{ .name = "FSH VOLUME SET SEQUENCE", .fid = .{ .code = 0x80803A, .len = 3 }, .kind = "Variable" },
    .{ .name = "FST PARTITION NUMBER", .fid = .{ .code = 0x80803E, .len = 3 }, .kind = "Variable" },
    .{ .name = "FST VOLUME SET SEQUENCE", .fid = .{ .code = 0x80803D, .len = 3 }, .kind = "Variable" },
    .{ .name = "HEADER DEBUG STRING", .fid = .{ .code = 0x81EFFF, .len = 3 }, .kind = "Variable" },
    .{ .name = "HIDDEN", .fid = .{ .code = 0x15, .len = 1 }, .kind = "Bit Data" },
    .{ .name = "INDEXED", .fid = .{ .code = 0x81EFF8, .len = 3 }, .kind = "Bit Data" },
    .{ .name = "INHIBITIONS", .fid = .{ .code = 0x813A, .len = 2 }, .kind = "Bit Data" },
    .{ .name = "NAME POSITIONS", .fid = .{ .code = 0x27, .len = 1 }, .kind = "Variable" },
    .{ .name = "NAME SPACE", .fid = .{ .code = 0x11, .len = 1 }, .kind = "Variable" },
    .{ .name = "NEEDS ARCHIVE", .fid = .{ .code = 0x16, .len = 1 }, .kind = "Bit Data" },
    .{ .name = "NEEDS ARCHIVE CHARACTERISTICS", .fid = .{ .code = 0x2D, .len = 1 }, .kind = "Bit Data" },
    .{ .name = "NEXT OBJECT LOCATION", .fid = .{ .code = 0x808029, .len = 3 }, .kind = "Variable" },
    .{ .name = "NUMBER OF FILE SETS", .fid = .{ .code = 0x808015, .len = 3 }, .kind = "Variable" },
    .{ .name = "NUMBER OF FILES", .fid = .{ .code = 0x808021, .len = 3 }, .kind = "Variable" },
    .{ .name = "OFFSET TO END", .fid = .{ .code = 0x01, .len = 1 }, .kind = "Variable" },
    .{ .name = "ORIGINATING SYSTEM SOFTWARE NAME", .fid = .{ .code = 0x808006, .len = 3 }, .kind = "Variable" },
    .{ .name = "ORIGINATING SYSTEM SOFTWARE TYPE", .fid = .{ .code = 0x808007, .len = 3 }, .kind = "Variable" },
    .{ .name = "ORIGINATING SYSTEM SOFTWARE VERSION", .fid = .{ .code = 0x808008, .len = 3 }, .kind = "Variable" },
    .{ .name = "PARTITION NUMBER", .fid = .{ .code = 0x808012, .len = 3 }, .kind = "Variable" },
    .{ .name = "PATH", .fid = .{ .code = 0x10, .len = 1 }, .kind = "Variable" },
    .{ .name = "PATH NAME", .fid = .{ .code = 0x12, .len = 1 }, .kind = "Variable" },
    .{ .name = "PREV OBJECT LOCATION", .fid = .{ .code = 0x80802A, .len = 3 }, .kind = "Variable" },
    .{ .name = "PURGE", .fid = .{ .code = 0x8136, .len = 2 }, .kind = "Bit Data" },
    .{ .name = "READ ONLY", .fid = .{ .code = 0x17, .len = 1 }, .kind = "Bit Data" },
    .{ .name = "REGISTERED IDENTIFIER", .fid = .{ .code = 0x808043, .len = 3 }, .kind = "Variable" },
    .{ .name = "REMOTE DATA ACCESS", .fid = .{ .code = 0x81EFE7, .len = 3 }, .kind = "Bit Data" },
    .{ .name = "REMOTE DATA INHIBIT", .fid = .{ .code = 0x81EFE8, .len = 3 }, .kind = "Bit Data" },
    .{ .name = "RESOURCE NAME", .fid = .{ .code = 0x808023, .len = 3 }, .kind = "Variable" },
    .{ .name = "RESOURCE NAME SPACE", .fid = .{ .code = 0x808038, .len = 3 }, .kind = "Variable" },
    .{ .name = "RESOURCE TYPE", .fid = .{ .code = 0x808037, .len = 3 }, .kind = "Variable" },
    .{ .name = "SECTOR SIZE", .fid = .{ .code = 0x80800E, .len = 3 }, .kind = "Variable" },
    .{ .name = "SEPARATOR POSITIONS", .fid = .{ .code = 0x28, .len = 1 }, .kind = "Variable" },
    .{ .name = "SHAREABLE", .fid = .{ .code = 0x18, .len = 1 }, .kind = "Bit Data" },
    .{ .name = "SOURCE ALIAS", .fid = .{ .code = 0x808036, .len = 3 }, .kind = "Variable" },
    .{ .name = "SOURCE DIRECTORY", .fid = .{ .code = 0x14, .len = 1 }, .kind = "Bit Data" },
    .{ .name = "SOURCE DIRECTORY HEADER", .fid = .{ .code = 0x0C, .len = 1 }, .kind = "Variable" },
    .{ .name = "SOURCE DIRECTORY TRAILER", .fid = .{ .code = 0x0D, .len = 1 }, .kind = "Variable" },
    .{ .name = "SOURCE FILE HEADER", .fid = .{ .code = 0x0E, .len = 1 }, .kind = "Variable" },
    .{ .name = "SOURCE FILE TRAILER", .fid = .{ .code = 0x0F, .len = 1 }, .kind = "Variable" },
    .{ .name = "SOURCE NAME", .fid = .{ .code = 0x02, .len = 1 }, .kind = "Variable" },
    .{ .name = "SOURCE NAME TYPE", .fid = .{ .code = 0x8009, .len = 2 }, .kind = "Variable" },
    .{ .name = "SOURCE OPERATING SYSTEM", .fid = .{ .code = 0x03, .len = 1 }, .kind = "Variable" },
    .{ .name = "SOURCE OPERATING SYSTEM VERSION", .fid = .{ .code = 0x04, .len = 1 }, .kind = "Variable" },
    .{ .name = "SOURCE VOLUME HEADER", .fid = .{ .code = 0x81EFFC, .len = 3 }, .kind = "Variable" },
    .{ .name = "SOURCE VOLUME TRAILER", .fid = .{ .code = 0x81EFFB, .len = 3 }, .kind = "Variable" },
    .{ .name = "STREAM COMPRESS TYPE", .fid = .{ .code = 0x8005, .len = 2 }, .kind = "Variable" },
    .{ .name = "STREAM CRC", .fid = .{ .code = 0x22, .len = 1 }, .kind = "Variable" },
    .{ .name = "STREAM EXPANDED SIZE", .fid = .{ .code = 0x8006, .len = 2 }, .kind = "Variable" },
    .{ .name = "STREAM FORMAT", .fid = .{ .code = 0x2C, .len = 1 }, .kind = "Variable" },
    .{ .name = "STREAM HEADER", .fid = .{ .code = 0x1D, .len = 1 }, .kind = "Variable" },
    .{ .name = "STREAM IS INVALID", .fid = .{ .code = 0x21, .len = 1 }, .kind = "Bit Data" },
    .{ .name = "STREAM SIZE", .fid = .{ .code = 0x20, .len = 1 }, .kind = "Variable" },
    .{ .name = "STREAM TRAILER", .fid = .{ .code = 0x1E, .len = 1 }, .kind = "Variable" },
    .{ .name = "STREAM TYPE", .fid = .{ .code = 0x2B, .len = 1 }, .kind = "Variable" },
    .{ .name = "SYSTEM", .fid = .{ .code = 0x19, .len = 1 }, .kind = "Bit Data" },
    .{ .name = "TOTAL FILE SET SIZE", .fid = .{ .code = 0x808022, .len = 3 }, .kind = "Variable" },
    .{ .name = "TRANSACTION SET HEADER", .fid = .{ .code = 0x81EFF3, .len = 3 }, .kind = "Variable" },
    .{ .name = "TRANSACTION SET TRAILER", .fid = .{ .code = 0x81EFF2, .len = 3 }, .kind = "Variable" },
    .{ .name = "TRANSACTION SET TYPE", .fid = .{ .code = 0x81EFEE, .len = 3 }, .kind = "Variable" },
    .{ .name = "TRANSACTIONAL", .fid = .{ .code = 0x8135, .len = 2 }, .kind = "Bit Data" },
    .{ .name = "UNUSED IN THIS BUFFER", .fid = .{ .code = 0x8000, .len = 2 }, .kind = "Variable" },
    .{ .name = "VOLUME HEADER", .fid = .{ .code = 0x808000, .len = 3 }, .kind = "Variable" },
    .{ .name = "VOLUME INDEX", .fid = .{ .code = 0x808011, .len = 3 }, .kind = "Variable" },
    .{ .name = "VOLUME INDEX LOCATION", .fid = .{ .code = 0x808042, .len = 3 }, .kind = "Variable" },
    .{ .name = "VOLUME INDEX REQUIRED", .fid = .{ .code = 0x80802F, .len = 3 }, .kind = "Bit Data" },
    .{ .name = "VOLUME LABEL", .fid = .{ .code = 0x808027, .len = 3 }, .kind = "Variable" },
    .{ .name = "VOLUME SET ALIAS", .fid = .{ .code = 0x808041, .len = 3 }, .kind = "Variable" },
    .{ .name = "VOLUME SET LABEL", .fid = .{ .code = 0x808030, .len = 3 }, .kind = "Variable" },
    .{ .name = "VOLUME SUBINDEX", .fid = .{ .code = 0x808031, .len = 3 }, .kind = "Variable" },
    .{ .name = "VOLUME TRAILER", .fid = .{ .code = 0x808003, .len = 3 }, .kind = "Variable" },
};
// --- END GENERATED ---

/// Exactly two fields in the whole specification have an Annex C declaration
/// that contradicts Annex A's bit structure: Annex A makes them FID-fixed
/// (so the Data Length part is absent), while Annex C describes their data as
/// Variable / Bit Data. Framing must follow Annex A — a reader cannot see a
/// Data Length part that the FID says is not there — so these two are listed
/// explicitly and reported as stop-and-report items, never silently accepted.
///   ATTRIBUTES       #81F2FE: Annex A fixed 4 bytes, Annex C "Variable"
///   FILE IS INVALID  #80F003: Annex A fixed 1 byte,  Annex C "Bit Data"
fn isKnownFramingConflict(f: fields.Fid) bool {
    return f.eql(fields.ATTRIBUTES) or f.eql(fields.FILE_IS_INVALID);
}

test "every Annex C fixed width equals the Annex A implied width" {
    var checked: usize = 0;
    for (spec_fixed) |fact| {
        const w = fields.fixedLen(fact.fid);
        if (w == null) {
            std.debug.print("{s} is Fixed,{d} in Annex C but variable-framed in Annex A\n", .{ fact.name, fact.bytes });
            return error.WidthMismatch;
        }
        if (w.? != fact.bytes) {
            std.debug.print("width mismatch for {s}: Annex A says {d}, Annex C says {d}\n", .{ fact.name, w.?, fact.bytes });
            return error.WidthMismatch;
        }
        checked += 1;
    }
    try testing.expect(checked > 10);
}

test "Annex C Variable/Bit Data fields are FID-fixed only in the recorded conflicts" {
    var conflicts: usize = 0;
    for (spec_non_fixed) |fact| {
        if (fields.fixedLen(fact.fid) != null) {
            if (!isKnownFramingConflict(fact.fid)) {
                std.debug.print("{s} is {s} in Annex C but FID-fixed in Annex A\n", .{ fact.name, fact.kind });
                return error.UnrecordedConflict;
            }
            conflicts += 1;
        }
    }
    try testing.expectEqual(@as(usize, 2), conflicts);
}
