//! tension-res — the ECMA-208 (SIDF) resource container for TensionCore.
//!
//! Layering (each module is independently testable and allocates nothing):
//!
//!   errors    error model + the ABI's negative errno values
//!   fields    FID encoding/decoding (Annex A), Data Length formats (Annex B),
//!             Field Table framing (10.5), RLE-free integer codecs (6.1),
//!             CRC-32 (clause 9), resync scanning (6.23), and the FID
//!             constants generated from Annex D
//!   metadata  Volume Header FT (13.1), File Set Header FT (13.7),
//!             Buffer Header FT (13.4), File Header FT (13.12),
//!             File Information FT (13.14), Path FT (13.15.1),
//!             Characteristics FT (13.15.2), Stream Header/Trailer FTs
//!             (13.15.7.1/.2), and the 12-byte Timestamp (clause 7)
//!
//! Later phases add the VFS (fd table, lookup path), the packer, and the C
//! ABI. Nothing here reads the kernel filesystem and nothing panics on
//! malformed input.
pub const errors = @import("errors.zig");
pub const block = @import("block.zig");
pub const fields = @import("fields.zig");
pub const metadata = @import("metadata.zig");
pub const index = @import("index.zig");
pub const walk = @import("walk.zig");
pub const vfs = @import("vfs.zig");
pub const writer = @import("writer.zig");
pub const c_api = @import("c_api.zig");
