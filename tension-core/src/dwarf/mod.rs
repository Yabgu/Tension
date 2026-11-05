//! Does this guest carry DWARF of its own?
//!
//! TensionScript 0.14.0 emits `.debug_abbrev`, `.debug_info`, `.debug_line` and
//! `.debug_ranges` when `--debug` **and** `--sourceMap` are both set. The host
//! no longer builds a line table from a source map for a guest that lacks one:
//! a producer that emits DWARF emits it correctly, and a producer that does not
//! gets a diagnostic telling the user to rebuild, not a silently different
//! guest.
//!
//! So this module is one question and nothing else: does the module already
//! carry the sections a debugger needs? `main` asks it, `debug` reports it.
//!
//! History, because the name outlived the job: this module used to synthesise
//! `.debug_*` from an AssemblyScript source map (`encode.rs`, `source_map.rs`,
//! `wasm.rs`, ~1.3k lines). That fallback was removed once every example
//! produced compiler-emitted DWARF and lldb was measured consuming it through
//! the host.

/// Does `wasm` carry both `.debug_info` and `.debug_line`?
///
/// Policy: a producer that emitted both did the work, and the host must never
/// second-guess it. One section alone is not enough — `.debug_line` without
/// `.debug_info` names no compilation unit, and `.debug_info` without
/// `.debug_line` has no source addresses — so a lone section is reported as
/// "no DWARF", which is what a debugger will find too.
pub fn has_debug_sections(wasm: &[u8]) -> bool {
    if wasm.len() < 8 || wasm[0..4] != [0x00, b'a', b's', b'm'] {
        return false;
    }
    let (mut info, mut line) = (false, false);
    let mut r = Reader::new(wasm, 8);
    while r.i < wasm.len() {
        let id = match r.u8() {
            Some(i) => i,
            None => return false,
        };
        let size = match r.uleb() {
            Some(s) => s as usize,
            None => return false,
        };
        let payload = r.i;
        let end = match payload.checked_add(size) {
            Some(e) if e <= wasm.len() => e,
            _ => return false,
        };
        if id == 0 {
            let mut c = Reader::new(wasm, payload);
            if let Some(name) = c.name() {
                match name.as_str() {
                    ".debug_info" => info = true,
                    ".debug_line" => line = true,
                    _ => {}
                }
            }
        }
        r.i = end;
    }
    info && line
}

/// A cursor over a wasm module's section stream.
///
/// Deliberately minimal — a section header is `id: u8`, `size: LEB128`,
/// `payload` — because the only reader left is the check above. Anything more
/// would be the layout parser this module used to have.
struct Reader<'a> {
    bytes: &'a [u8],
    i: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8], i: usize) -> Self {
        Self { bytes, i }
    }

    fn u8(&mut self) -> Option<u8> {
        let value = *self.bytes.get(self.i)?;
        self.i += 1;
        Some(value)
    }

    fn uleb(&mut self) -> Option<u64> {
        let mut result = 0u64;
        let mut shift = 0u32;
        loop {
            let byte = self.u8()?;
            if shift >= 64 {
                return None;
            }
            result |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(result);
            }
            shift += 7;
        }
    }

    /// A wasm string: LEB length, then that many bytes.
    fn name(&mut self) -> Option<String> {
        let len = self.uleb()? as usize;
        let end = self.i.checked_add(len)?;
        let slice = self.bytes.get(self.i..end)?;
        self.i = end;
        Some(String::from_utf8_lossy(slice).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::has_debug_sections;

    /// A module header plus one custom section with the given name.
    fn module_with(section: &str) -> Vec<u8> {
        let name = section.as_bytes();
        let mut payload = vec![name.len() as u8];
        payload.extend_from_slice(name);
        let mut out = vec![0x00, b'a', b's', b'm', 0x01, 0x00, 0x00, 0x00];
        out.push(0); // custom section
        out.push(payload.len() as u8);
        out.extend_from_slice(&payload);
        out
    }

    #[test]
    fn requires_both_info_and_line() {
        let mut both = module_with(".debug_info");
        both.extend_from_slice(&module_with(".debug_line")[8..]);
        assert!(has_debug_sections(&both));

        assert!(!has_debug_sections(&module_with(".debug_info")));
        assert!(!has_debug_sections(&module_with(".debug_line")));
        assert!(!has_debug_sections(&module_with("name")));
    }

    #[test]
    fn rejects_non_wasm_and_truncated_input() {
        assert!(!has_debug_sections(b""));
        assert!(!has_debug_sections(b"notawasmfile"));
        // Header plus a section that claims more bytes than the file holds.
        assert!(!has_debug_sections(&[0x00, b'a', b's', b'm', 1, 0, 0, 0, 0, 40]));
    }
}
