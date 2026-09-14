//! DWARF synthesis for AssemblyScript guests.
//!
//! `asc` emits no DWARF: an AssemblyScript `game.wasm` carries only a `name`
//! custom section and a `sourceMappingURL`. Without DWARF, wasmtime still
//! registers the JIT'd guest with a debugger, but nothing maps native code back
//! to `game.ts`, so breakpoints resolve only at wasm-function level.
//!
//! This module rebuilds that mapping from what the guest already carries: the
//! `name` section (function names and, in a `--debug` build, local variable
//! names) and the source map (wasm byte offset -> `.ts` line/column). It
//! appends `.debug_abbrev`, `.debug_info`, `.debug_line` and `.debug_ranges`
//! to a copy of the module held in memory. The file on disk is never touched.
//!
//! Locals: each named function gets a `DW_TAG_variable` child per wasm local
//! (parameters first, then the body's declarations) whose location is the
//! standard WebAssembly DWARF expression `DW_OP_WASM_location 0x00 <index>
//! DW_OP_stack_value`. wasmtime's transform rewrites those through cranelift's
//! value-label ranges into per-address register / stack-slot locations, so
//! `frame variable` in a debugger shows the guest's locals with the names
//! `asc --debug` kept in the `name` section. A local whose live range never
//! starts (optimized away) simply gets no location and drops out.
//!
//! Address convention (measured, not assumed): a guest DWARF code address is a
//! byte offset from the start of the code section payload - address 0 is the
//! first byte of the function-count LEB. Verified against a rustc-built wasm32
//! guest whose line table is known to work with wasmtime: code payload file
//! bytes [123, 200) (size 77), the line table ends at address 0x4d = 77, and
//! the first function body starts at file offset 125, mapping to address 0x02.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

mod encode;
mod source_map;
mod wasm;

use encode::{append_abbrev, append_custom, append_info, append_line};
use source_map::{parse_source_map, Seg, SourceMap};
use wasm::{Layout, Reader};

pub struct Stats {
    pub files: usize,
    pub rows: usize,
    pub functions: usize,
    pub locals: usize,
    pub dropped: usize,
}

/// Copy `wasm` with synthesized `.debug_abbrev`, `.debug_info`, `.debug_line`
/// and `.debug_ranges` appended: line tables for source breakpoints, function
/// DIEs for the call stack, and variable DIEs for locals.
///
/// The first existing entry of `symbol_roots` becomes the compile directory,
/// and so the base for every file-table entry.
pub fn synthesize(
    wasm: &[u8],
    map: &SourceMap,
    symbol_roots: &[PathBuf],
    wasm_path: &Path,
) -> Result<(Vec<u8>, Stats), String> {
    let layout = Layout::parse(wasm)?;
    let comp_dir = Layout::comp_dir(symbol_roots, wasm_path);
    let end_addr = layout.code_payload_size as u32;

    // Source-map offsets are absolute file offsets; DWARF is payload-relative.
    let mut rows: Vec<Seg> = map
        .segments
        .iter()
        .filter_map(|s| {
            s.addr
                .checked_sub(layout.code_payload_start as u32)
                .filter(|addr| *addr <= end_addr)
                .map(|addr| Seg {
                    addr,
                    file: s.file,
                    line: s.line,
                    col: s.col,
                })
        })
        .collect();
    let dropped = map.segments.len() - rows.len();
    rows.sort_by_key(|r| r.addr);
    // Two mappings can share an address at a statement boundary; keep one row
    // so the line program never emits a zero-length advance.
    rows.dedup_by_key(|r| r.addr);

    let mut functions = Vec::new();
    let mut locals = Vec::new();
    for (i, (start, end)) in layout.bodies.iter().enumerate() {
        let name = match layout.name_for_body(i) {
            Some(n) => n,
            None => continue,
        };
        if end <= start {
            continue;
        }
        functions.push((
            name.to_string(),
            (*start - layout.code_payload_start) as u32,
            (*end - layout.code_payload_start) as u32,
        ));
        // Only locals whose value type has a DWARF base type become variable
        // DIEs; the rest are skipped without failing the function.
        locals.push(
            layout
                .locals_for_body(i)
                .into_iter()
                .filter_map(|(n, idx, ty)| ty.map(|t| (n, idx, t)))
                .collect(),
        );
    }

    let module_name = wasm_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("guest.wasm");
    let abbrev = append_abbrev();
    let ranges: Vec<(u32, u32)> = layout
        .bodies
        .iter()
        .filter(|(s, e)| e > s)
        .map(|(s, e)| {
            (
                (*s - layout.code_payload_start) as u32,
                (*e - layout.code_payload_start) as u32,
            )
        })
        .collect();
    let line = append_line(&comp_dir, &map.sources, &rows, &ranges);
    let info = append_info(module_name, &comp_dir, &functions, &locals);
    let mut range_list = Vec::new();
    for (lo, hi) in &ranges {
        range_list.extend_from_slice(&lo.to_le_bytes());
        range_list.extend_from_slice(&hi.to_le_bytes());
    }
    range_list.extend_from_slice(&[0u8; 8]); // end-of-list marker

    let mut out = wasm.to_vec();
    append_custom(&mut out, ".debug_abbrev", &abbrev);
    append_custom(&mut out, ".debug_info", &info);
    append_custom(&mut out, ".debug_line", &line);
    append_custom(&mut out, ".debug_ranges", &range_list);

    let stats = Stats {
        files: map.sources.len(),
        rows: rows.len(),
        functions: functions.len(),
        locals: locals.iter().map(Vec::len).sum(),
        dropped,
    };
    Ok((out, stats))
}



// ------------------------------------------------------------ entry point ---

/// `sourceMappingURL` is resolved relative to the module, as in a browser.
fn resolve_map_path(wasm_path: &Path, url: &str) -> PathBuf {
    let p = Path::new(url);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    let base = wasm_path.parent().unwrap_or_else(|| Path::new("."));
    base.join(url)
}

/// Whether the guest is *fully described* by DWARF it already carries.
///
/// Policy: a producer that emitted both `.debug_info` and `.debug_line` did
/// the work, and the host must never second-guess it. One section alone is
/// not enough — `.debug_line` without `.debug_info` names no compilation
/// unit, and `.debug_info` without `.debug_line` has no source addresses —
/// so only the pair short-circuits synthesis. A module with a lone section
/// still goes through the synthesizer.
fn has_debug_sections(wasm: &[u8]) -> bool {
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

/// Read the guest and its source map, and return the augmented module bytes.
///
/// `Unchanged` and `Failed` both mean "load the file as it stands": every
/// shortfall here is a diagnostic inconvenience, never a reason to refuse to
/// run the game. `main` prints the carried reason or error.
pub enum AugmentResult {
    /// Guest already had DWARF or no source map — load unchanged, not an error.
    Unchanged(&'static str), // reason string for the diagnostic
    /// Synthesis succeeded.
    Augmented(Vec<u8>),
    /// Synthesis was attempted but failed.
    Failed(String),
}

pub fn augment(wasm_path: &Path, symbol_roots: &[PathBuf]) -> AugmentResult {
    let wasm = match std::fs::read(wasm_path) {
        Ok(b) => b,
        Err(e) => {
            return AugmentResult::Failed(format!(
                "cannot read {}: {e}",
                wasm_path.display()
            ));
        }
    };
    if has_debug_sections(&wasm) {
        return AugmentResult::Unchanged("guest already carries DWARF; leaving it alone");
    }
    let info = crate::debug::probe(wasm_path);
    let url = match info.source_map {
        Some(u) => u,
        None => {
            return AugmentResult::Unchanged(
                "guest has no sourceMappingURL, so there is no line table to synthesize\n\
                 [tension-core] debug: build it with `--debug --sourceMap` (see examples/io `build:debug`)",
            );
        }
    };
    let map_path = resolve_map_path(wasm_path, &url);
    let json = match std::fs::read_to_string(&map_path) {
        Ok(s) => s,
        Err(e) => {
            return AugmentResult::Failed(format!(
                "cannot read source map {}: {e}",
                map_path.display()
            ));
        }
    };
    let map = match parse_source_map(&json) {
        Ok(m) => m,
        Err(e) => {
            return AugmentResult::Failed(format!("source map {}: {e}", map_path.display()));
        }
    };
    match synthesize(&wasm, &map, symbol_roots, wasm_path) {
        Ok((bytes, stats)) => {
            eprintln!(
                "[tension-core] debug: synthesized DWARF - {} files, {} line rows ({} outside the code section), {} functions, {} locals",
                stats.files, stats.rows, stats.dropped, stats.functions, stats.locals
            );
            AugmentResult::Augmented(bytes)
        }
        Err(e) => AugmentResult::Failed(format!("cannot synthesize DWARF: {e}")),
    }
}


// ----------------------------------------------------------------- tests ---

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::source_map::{parse_mappings, parse_source_map, vlq, B64};
    use super::wasm::{Layout, Reader, ValType};
    use super::*;

    fn u(v: u64) -> Vec<u8> {
        let mut b = Vec::new();
        crate::leb::write_uleb(&mut b, v);
        b
    }

    fn section(id: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![id];
        out.extend(u(payload.len() as u64));
        out.extend_from_slice(payload);
        out
    }

    fn len_prefixed(out: &mut Vec<u8>, s: &[u8]) {
        out.extend(u(s.len() as u64));
        out.extend_from_slice(s);
    }

    /// A custom section: id 0, LEB size, LEB name length, name, payload.
    fn custom(name: &str, payload: &[u8]) -> Vec<u8> {
        let mut body = Vec::new();
        len_prefixed(&mut body, name.as_bytes());
        body.extend_from_slice(payload);
        section(0, &body)
    }

    /// A `sourceMappingURL` custom section whose payload is a wasm string.
    fn url_section(url: &str) -> Vec<u8> {
        let mut payload = u(url.len() as u64);
        payload.extend_from_slice(url.as_bytes());
        custom("sourceMappingURL", &payload)
    }

    /// Base64 VLQ encoding, the inverse of `source_map::vlq`.
    fn vlq_encode(v: i64) -> String {
        let mut u = if v < 0 { ((-v) << 1) | 1 } else { v << 1 } as u64;
        let mut s = String::new();
        loop {
            let mut d = (u & 31) as u8;
            u >>= 5;
            if u != 0 {
                d |= 32;
            }
            s.push(B64[d as usize] as char);
            if u == 0 {
                break;
            }
        }
        s
    }

    /// A module shaped like a guest: one import, one defined function, a name.
    fn synthetic_guest() -> Vec<u8> {
        let mut wasm = vec![0x00, b'a', b's', b'm', 0x01, 0x00, 0x00, 0x00];

        // One function type: `() -> ()`.
        let mut types = u(1);
        types.push(0x60);
        types.extend(u(0)); // params
        types.extend(u(0)); // results
        wasm.extend(section(1, &types));

        let mut imports = u(1);
        len_prefixed(&mut imports, b"env");
        len_prefixed(&mut imports, b"print");
        imports.push(0x00); // function import
        imports.extend(u(0)); // type index
        wasm.extend(section(2, &imports));

        let mut funcs = u(1);
        funcs.extend(u(0)); // defined function 1 uses type 0
        wasm.extend(section(3, &funcs));

        let body = vec![0x00, 0x0b]; // no local declarations, `end`
        let mut code = u(1);
        code.extend(u(body.len() as u64));
        code.extend_from_slice(&body);
        wasm.extend(section(10, &code));

        let mut sub = u(1);
        sub.extend(u(1)); // function index 1: imports occupy index 0
        len_prefixed(&mut sub, b"game/_start_game");
        let mut name_sec = u(4);
        name_sec.extend_from_slice(b"name");
        name_sec.push(1); // subsection 1: function names
        len_prefixed(&mut name_sec, &sub);
        wasm.extend(section(0, &name_sec));

        wasm
    }

    /// Payload of the named custom section, for asserting on emitted DWARF.
    fn custom_payload(wasm: &[u8], want: &str) -> Vec<u8> {
        let mut r = Reader::new(wasm, 8);
        while r.i < wasm.len() {
            let id = r.u8().expect("section id");
            let size = r.uleb().expect("section size") as usize;
            let end = r.i + size;
            if id == 0 {
                let mut c = Reader::new(wasm, r.i);
                if let Some(name) = c.name() {
                    if name == want {
                        return wasm[c.i..end].to_vec();
                    }
                }
            }
            r.i = end;
        }
        panic!("no custom section {want:?}");
    }

    /// Locals: params first (from the function's type), then body declarations,
    /// with `name` subsection 2 applied and fallbacks for the unnamed.
    #[test]
    fn layout_finds_locals_and_names() {
        let mut wasm = vec![0x00, b'a', b's', b'm', 0x01, 0x00, 0x00, 0x00];

        // `(i32, i64) -> ()` as type 0.
        let mut types = u(1);
        types.push(0x60);
        types.push(2);
        types.push(0x7f);
        types.push(0x7e);
        types.push(0);
        wasm.extend(section(1, &types));

        let mut imports = u(1);
        len_prefixed(&mut imports, b"env");
        len_prefixed(&mut imports, b"abort");
        imports.push(0x00);
        imports.extend(u(0));
        wasm.extend(section(2, &imports));

        let mut funcs = u(1);
        funcs.extend(u(0));
        wasm.extend(section(3, &funcs));

        // Body: locals `2 x i32`, `1 x f64`, then `end`.
        let mut body = u(2);
        body.push(2);
        body.push(0x7f);
        body.push(1);
        body.push(0x7c);
        body.push(0x0b);
        let mut code = u(1);
        code.extend(u(body.len() as u64));
        code.extend_from_slice(&body);
        wasm.extend(section(10, &code));

        // Function 1: named; locals 0, 2 and 3 named, 1 and 4 left unnamed.
        let mut fn_names = u(1);
        fn_names.extend(u(1));
        len_prefixed(&mut fn_names, b"game/f");
        let mut loc_names = u(1); // one function
        loc_names.extend(u(1)); // function 1
        loc_names.push(3); // three local names
        loc_names.extend(u(0));
        len_prefixed(&mut loc_names, b"p0");
        loc_names.extend(u(2));
        len_prefixed(&mut loc_names, b"fst");
        loc_names.extend(u(3));
        len_prefixed(&mut loc_names, b"snd");
        let mut name_sec = u(4);
        name_sec.extend_from_slice(b"name");
        name_sec.push(1);
        len_prefixed(&mut name_sec, &fn_names);
        name_sec.push(2);
        len_prefixed(&mut name_sec, &loc_names);
        wasm.extend(section(0, &name_sec));

        let layout = Layout::parse(&wasm).unwrap();
        let locals = layout.locals_for_body(0);
        assert_eq!(
            locals,
            vec![
                ("p0".to_string(), 0, Some(ValType::I32)),
                ("param1".to_string(), 1, Some(ValType::I64)),
                ("fst".to_string(), 2, Some(ValType::I32)),
                ("snd".to_string(), 3, Some(ValType::I32)),
                ("local4".to_string(), 4, Some(ValType::F64)),
            ]
        );
    }

    #[test]
    fn vlq_decodes_signed_and_multibyte_values() {
        assert_eq!(vlq("AAAA").unwrap(), vec![0, 0, 0, 0]);
        assert_eq!(vlq("C").unwrap(), vec![1]);
        assert_eq!(vlq("D").unwrap(), vec![-1]);
        assert_eq!(vlq("2H").unwrap(), vec![123]);
        assert!(vlq("g").is_err(), "a group that never terminates is an error");
    }

    #[test]
    fn json_strings_decode_bmp_escapes() {
        let map = parse_source_map(r#"{"sources":["\u0041.ts"],"mappings":"AAAA"}"#).unwrap();
        assert_eq!(map.sources, vec!["A.ts"]);
    }

    #[test]
    fn json_strings_decode_surrogate_pairs() {
        // U+1F600 GRINNING FACE as a UTF-16 surrogate pair.
        let map = parse_source_map(r#"{"sources":["\ud83d\ude00.ts"],"mappings":"AAAA"}"#).unwrap();
        assert_eq!(map.sources, vec!["\u{1F600}.ts"]);
    }

    #[test]
    fn json_strings_reject_unpaired_surrogates() {
        // A lone high surrogate, a high surrogate paired with a non-low
        // surrogate, and a lone low surrogate: errors, never a panic or a
        // silently substituted replacement character.
        assert!(parse_source_map(r#"{"sources":["\ud83d.ts"],"mappings":"AAAA"}"#).is_err());
        assert!(parse_source_map(r#"{"sources":["\ud83d\u0041"],"mappings":"AAAA"}"#).is_err());
        assert!(parse_source_map(r#"{"sources":["\ude00.ts"],"mappings":"AAAA"}"#).is_err());
    }

    #[test]
    fn json_strings_mix_escaped_and_unescaped_unicode() {
        // `caf\u00e9` next to a literal é, plus a surrogate pair mid-word.
        let map = parse_source_map(
            "{\"sources\":[\"caf\\u00e9é\\ud83d\\ude00x.ts\"],\"mappings\":\"AAAA\"}",
        )
        .unwrap();
        assert_eq!(map.sources, vec!["caféé\u{1F600}x.ts"]);
    }

    #[test]
    fn layout_finds_code_names_and_import_count() {
        let layout = Layout::parse(&synthetic_guest()).unwrap();
        assert_eq!(layout.imported_funcs, 1);
        assert_eq!(layout.bodies.len(), 1);
        assert_eq!(layout.name_for_body(0), Some("game/_start_game"));
        assert!(layout.code_payload_start > 8);
        assert!(layout.code_payload_size > 0);
    }

    #[test]
    fn one_debug_section_is_not_enough_to_skip_synthesis() {
        // Policy: only `.debug_info` *and* `.debug_line` together count as
        // the guest fully describing itself; either one alone still goes
        // through the synthesizer.
        let mut wasm = synthetic_guest();
        wasm.extend(custom(".debug_line", &[0, 0, 0, 0]));
        assert!(!has_debug_sections(&wasm), "a lone .debug_line is not a full description");

        let mut wasm = synthetic_guest();
        wasm.extend(custom(".debug_info", &[0, 0, 0, 0]));
        assert!(!has_debug_sections(&wasm), "a lone .debug_info is not a full description");

        let mut wasm = synthetic_guest();
        wasm.extend(custom(".debug_info", &[0, 0, 0, 0]));
        wasm.extend(custom(".debug_line", &[0, 0, 0, 0]));
        assert!(has_debug_sections(&wasm), "both sections together fully describe the guest");
    }

    #[test]
    fn augment_synthesizes_when_only_one_debug_section_exists() {
        let dir = std::env::temp_dir().join(format!("tension-aug-partial-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut wasm = synthetic_guest();
        wasm.extend(custom(".debug_line", &[0, 0, 0, 0])); // partial DWARF
        wasm.extend(url_section("./partial.wasm.map"));
        std::fs::write(dir.join("partial.wasm"), &wasm).unwrap();
        std::fs::write(
            dir.join("partial.wasm.map"),
            r#"{"version":3,"sources":["game.ts"],"mappings":"AAAA"}"#,
        )
        .unwrap();
        let out = augment(&dir.join("partial.wasm"), &[]);
        assert!(
            matches!(out, AugmentResult::Augmented(_)),
            "a lone .debug_line must not skip synthesis"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn augment_leaves_a_fully_described_guest_alone() {
        let dir = std::env::temp_dir().join(format!("tension-aug-full-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut wasm = synthetic_guest();
        wasm.extend(custom(".debug_info", &[0, 0, 0, 0]));
        wasm.extend(custom(".debug_line", &[0, 0, 0, 0]));
        wasm.extend(url_section("./full.wasm.map"));
        std::fs::write(dir.join("full.wasm"), &wasm).unwrap();
        std::fs::write(
            dir.join("full.wasm.map"),
            r#"{"version":3,"sources":["game.ts"],"mappings":"AAAA"}"#,
        )
        .unwrap();
        let out = augment(&dir.join("full.wasm"), &[]);
        assert!(
            matches!(
                out,
                AugmentResult::Unchanged("guest already carries DWARF; leaving it alone")
            ),
            ".debug_info + .debug_line must skip synthesis"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn source_map_addresses_outside_the_code_section_are_dropped() {
        let wasm = synthetic_guest();
        let layout = Layout::parse(&wasm).unwrap();
        let start = layout.code_payload_start as i64;
        // Two 4-field segments: payload-relative 2 (source line 5) inside the
        // code section, and payload-relative 100 far beyond it. The second
        // must be dropped, not remapped onto a bogus in-range address.
        let mappings = format!(
            "{}AIA,{}AAA",
            vlq_encode(start + 2),
            vlq_encode(100 - 2),
        );
        let map = parse_source_map(&format!(r#"{{"sources":["game.ts"],"mappings":"{mappings}"}}"#)).unwrap();
        let (out, stats) = synthesize(&wasm, &map, &[], Path::new("game.wasm")).unwrap();
        assert_eq!(stats.rows, 1, "only the in-range address becomes a line row");
        assert_eq!(stats.dropped, 1, "the out-of-range address is dropped, not remapped");

        // The line program records source line 5 at payload address 2:
        // set_address 2, advance_line +4 (sleb), copy, end_sequence.
        let line = custom_payload(&out, ".debug_line");
        let seq = [0x00, 0x05, 0x02, 0x02, 0x00, 0x00, 0x00, 0x03, 0x04, 0x01, 0x00, 0x01, 0x01];
        assert!(
            line.windows(seq.len()).any(|w| w == seq.as_slice()),
            "line program records source line 5 at payload address 2"
        );
        let bogus = [0x00, 0x05, 0x02, 0x64, 0x00, 0x00, 0x00]; // set_address 100
        assert!(
            !line.windows(bogus.len()).any(|w| w == bogus.as_slice()),
            "no sequence starts at the dropped address"
        );
    }

    #[test]
    fn local_indices_are_not_offset_by_imported_functions() {
        let mut wasm = vec![0x00, b'a', b's', b'm', 0x01, 0x00, 0x00, 0x00];

        // `(i32) -> ()` as type 0.
        let mut types = u(1);
        types.push(0x60);
        types.push(1);
        types.push(0x7f);
        types.push(0);
        wasm.extend(section(1, &types));

        // Two imported functions occupy indices 0 and 1.
        let mut imports = u(2);
        len_prefixed(&mut imports, b"env");
        len_prefixed(&mut imports, b"abort");
        imports.push(0x00);
        imports.extend(u(0));
        len_prefixed(&mut imports, b"env");
        len_prefixed(&mut imports, b"trace");
        imports.push(0x00);
        imports.extend(u(0));
        wasm.extend(section(2, &imports));

        let mut funcs = u(1);
        funcs.extend(u(0));
        wasm.extend(section(3, &funcs));

        // Body: one declared `i32` local, then `end`.
        let mut body = u(1);
        body.push(1);
        body.push(0x7f);
        body.push(0x0b);
        let mut code = u(1);
        code.extend(u(body.len() as u64));
        code.extend_from_slice(&body);
        wasm.extend(section(10, &code));

        // The defined function is index 2; its locals are named by their own
        // indices, which start at 0 regardless of the imports.
        let mut fn_names = u(1);
        fn_names.extend(u(2));
        len_prefixed(&mut fn_names, b"game/f");
        let mut loc_names = u(1);
        loc_names.extend(u(2));
        loc_names.push(2);
        loc_names.extend(u(0));
        len_prefixed(&mut loc_names, b"arg");
        loc_names.extend(u(1));
        len_prefixed(&mut loc_names, b"tmp");
        let mut name_sec = u(4);
        name_sec.extend_from_slice(b"name");
        name_sec.push(1);
        len_prefixed(&mut name_sec, &fn_names);
        name_sec.push(2);
        len_prefixed(&mut name_sec, &loc_names);
        wasm.extend(section(0, &name_sec));

        let layout = Layout::parse(&wasm).unwrap();
        assert_eq!(layout.imported_funcs, 2);
        assert_eq!(layout.name_for_body(0), Some("game/f"));
        assert_eq!(
            layout.locals_for_body(0),
            vec![
                ("arg".to_string(), 0, Some(ValType::I32)),
                ("tmp".to_string(), 1, Some(ValType::I32)),
            ],
            "locals start at index 0, not at imported_funcs + index"
        );
    }

    #[test]
    fn source_map_reads_sources_and_allows_one_field_segments() {
        let json = r#"{"version":3,"file":"game.wasm","sources":["game.ts","~lib/string.ts"],"names":[],"mappings":"AAAA,IACA,C"}"#;
        let map = parse_source_map(json).unwrap();
        assert_eq!(map.sources, vec!["game.ts".to_string(), "~lib/string.ts".to_string()]);
        // The one-field segment carries a generated column only: no line row.
        assert_eq!(map.segments.len(), 2);
        assert_eq!(map.segments[0].addr, 0);
        assert_eq!(map.segments[0].line, 1, "source-map lines are zero-based");
        assert_eq!(map.segments[1].addr, 4);
        assert_eq!(map.segments[1].line, 2);
    }

    #[test]
    fn mappings_reset_the_generated_column_at_each_line_group() {
        // `C` = +1. First group starts at generated column 1. The second
        // group must start back at 0 — the spec resets the generated column
        // per line — and its second segment is +1 relative to that reset.
        let segs = parse_mappings("CAAA;AACA,CAAA", 1).unwrap();
        assert_eq!(segs.len(), 3);
        assert_eq!(segs[0].addr, 1);
        assert_eq!(segs[1].addr, 0, "generated column resets at each `;` group");
        assert_eq!(segs[2].addr, 1, "within a group the column is still relative");
        // Source lines do not reset: group 2 starts one line further down.
        assert_eq!(segs[0].line, 1);
        assert_eq!(segs[1].line, 2);
        assert_eq!(segs[2].line, 2);
    }

    #[test]
    fn malformed_input_is_an_error_rather_than_a_panic() {
        let mut wasm = synthetic_guest();
        wasm.truncate(wasm.len() - 3);
        assert!(Layout::parse(&wasm).is_err());
        assert!(Layout::parse(&[]).is_err());
        assert!(Layout::parse(&[0x00, b'a', b's', b'm', 1, 0, 0, 0]).is_err());
        assert!(parse_source_map("not json").is_err());
        assert!(parse_source_map(r#"{"sources":["a.ts"],"mappings":"AA"}"#).is_err());
        assert!(parse_source_map(r#"{"sources":["a.ts"]}"#).is_err());
        assert!(parse_source_map(r#"{"mappings":"AAAA"}"#).is_err());
    }

    /// End-to-end synthesis on the real io example, plus a dump for
    /// `llvm-dwarfdump` (writes `<tmp>/tension-synth.wasm`).
    #[test]
    fn io_example_guest_synthesizes_a_line_table() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../examples/io");
        let wasm_path = dir.join("build/game.wasm");
        let map_path = dir.join("build/game.wasm.map");
        if !wasm_path.exists() || !map_path.exists() {
            eprintln!("skipping: build the io example first (npm run build:debug)");
            return;
        }
        let wasm = std::fs::read(&wasm_path).unwrap();
        let map = parse_source_map(&std::fs::read_to_string(&map_path).unwrap()).unwrap();
        let (out, stats) = synthesize(&wasm, &map, std::slice::from_ref(&dir), &wasm_path).unwrap();
        assert!(stats.rows > 0, "the example maps some wasm offsets to lines");
        assert!(stats.functions > 0, "the name section names guest functions");
        assert!(stats.locals > 0, "a --debug build names the guest's locals");
        assert!(out.len() > wasm.len());
        assert!(!has_debug_sections(&wasm), "asc emits no DWARF, hence this module");
        assert!(has_debug_sections(&out));

        // `_start_game`'s locals `n`, `i`, `line` must be variable DIEs with
        // `DW_OP_WASM_location 0x00 <index> DW_OP_stack_value` locations.
        // A variable DIE: abbrev 5, `name\0`, a 4-byte `DW_FORM_ref4` type
        // offset, then `DW_FORM_exprloc` (length + `ed 00 <index> 9f`).
        let info = custom_payload(&out, ".debug_info");
        let die = |name: &str, index: u8| {
            let mut head = vec![0x05]; // abbrev 5: variable
            head.extend_from_slice(name.as_bytes());
            head.push(0);
            info.windows(head.len()).enumerate().any(|(i, w)| {
                w == head.as_slice()
                    && info.get(i + head.len() + 4..i + head.len() + 9)
                        == Some(&[0x04, 0xed, 0x00, index, 0x9f][..])
            })
        };
        assert!(die("n", 0), "variable `n` with local index 0");
        assert!(die("i", 1), "variable `i` with local index 1");
        assert!(die("line", 2), "variable `line` with local index 2");
        std::fs::write(std::env::temp_dir().join("tension-synth.wasm"), &out).unwrap();
    }
}


