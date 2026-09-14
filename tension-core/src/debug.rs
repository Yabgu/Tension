//! Guest debug-info support for the `--debug` flag.
//!
//! `Config::debug_info(true)` is the whole host-side lever. With it, wasmtime
//! registers the compiled guest with the platform debugger through the GDB JIT
//! interface, and lldb (which loads such images — `plugin.jit-loader.gdb.enable`
//! is on by default) lists the guest as a `JIT(0x…)` image whose sections
//! include relocatable DWARF (`.debug_info`, `.debug_line`, …) and
//! `.wasmtime.engine`. Without `--debug` no registration happens at all:
//! breaking on `wasmtime_jit_debug::gdb_jit_int::register_gdb_jit_image` is
//! reached with the flag and never without it.
//!
//! What that buys depends on the guest, and for an AssemblyScript guest the
//! host has to supply the missing half: `asc` (AssemblyScript 0.28) emits no
//! DWARF — only a `name` custom section and, with `--sourceMap`, a
//! `sourceMappingURL`. Rather than leave the guest's source unrepresentable,
//! the host **synthesizes DWARF for it from the source map** before handing the
//! module to wasmtime (see `dwarf.rs`), so under `--debug` an ordinary source
//! breakpoint resolves:
//!
//! ```text
//! frame #0: 0x… JIT(0x…)`game/_start_game at game.ts:11:8
//! ```
//!
//! A guest that already ships DWARF (a C or Rust guest) is passed through
//! untouched and is source-debuggable the same way.
//!
//! Whether that was possible is a property of the guest, so this module reports
//! what the guest actually carries at startup: the diagnosis shows up at launch
//! instead of at the first breakpoint that never hits.
//!
//! The section walk is hand-rolled on purpose — a diagnostic does not earn a
//! dependency.

use std::path::{Path, PathBuf};

use crate::leb::read_uleb;

/// What a debugger can see of a guest, according to its custom sections.
pub struct GuestDebugInfo {
    /// A `.debug_*` section is present: a source-level debugger can use it.
    pub dwarf: bool,
    /// The `name` section is present: guest functions can still be *named*,
    /// even with no DWARF. Verified against lldb 22 — the names survive into
    /// the JIT image as `wasm[0]::function[N]::<module>/<name>`, which is
    /// enough for a function breakpoint (not for a source line).
    pub names: bool,
    /// The `sourceMappingURL` value, if present: the source map the host
    /// synthesizes DWARF from under `--debug`. Without it the guest's wasm
    /// addresses carry no path back to `game.ts`.
    pub source_map: Option<String>,
}

/// Scan the guest's section headers for the custom sections a debugger cares
/// about.
///
/// Malformed input reports "nothing known" rather than an error: this is
/// diagnostics, and the loader raises the real error a moment later.
pub fn probe(path: &Path) -> GuestDebugInfo {
    let mut info = GuestDebugInfo {
        dwarf: false,
        names: false,
        source_map: None,
    };
    let Ok(bytes) = std::fs::read(path) else {
        return info;
    };
    if bytes.len() < 8 || &bytes[..4] != b"\0asm" {
        return info;
    }

    // Sections run from byte 8: `id: u8`, `size: LEB128`, `payload`.
    let mut p = 8usize;
    while p < bytes.len() {
        let id = bytes[p];
        p += 1;
        let Some(size) = read_uleb(&bytes, &mut p) else {
            break;
        };
        let Some(end) = p.checked_add(size).filter(|end| *end <= bytes.len()) else {
            break;
        };
        // Custom sections are the only ones a debugger's data lives in.
        if id == 0 {
            let mut q = p;
            if let Some(name_len) = read_uleb(&bytes, &mut q) {
                if let Some(name_end) = q.checked_add(name_len).filter(|e| *e <= end) {
                    let name = &bytes[q..name_end];
                    if name.starts_with(b".debug_") {
                        info.dwarf = true;
                    } else if name == b"name" {
                        info.names = true;
                    } else if name == b"sourceMappingURL" {
                        // The payload after the name is a wasm string: LEB
                        // length, then the URL's bytes.
                        let mut r = name_end;
                        if let Some(len) = read_uleb(&bytes, &mut r) {
                            let stop = r.saturating_add(len).min(end);
                            if stop > r {
                                info.source_map =
                                    Some(String::from_utf8_lossy(&bytes[r..stop]).into_owned());
                            }
                        }
                    }
                }
            }
        }
        p = end;
    }
    info
}

/// The `--debug` startup report, on stderr like every other host event.
///
/// It prints the lldb commands for what was actually passed, so the flag and
/// the session cannot drift apart. The recipe below is the one exercised by
/// hand against lldb 22 (see the module comment): the guest shows up as a
/// `JIT(0x…)` image, and its functions are reachable by regex.
pub fn report(guest: &Path, info: &GuestDebugInfo, symbol_paths: &[PathBuf]) {
    eprintln!("[tension-core] debug: guest {}", guest.display());

    if info.dwarf {
        eprintln!("[tension-core] debug:   DWARF: present — passed through as-is");
    } else {
        eprintln!("[tension-core] debug:   DWARF: none — `asc` writes `name` + `sourceMappingURL` only");
        eprintln!("[tension-core] debug:   the host synthesizes it from the source map, so `game.ts`");
        eprintln!("[tension-core] debug:   line breakpoints resolve against this guest");
        if !info.names {
            eprintln!("[tension-core] debug:   (no `name` section either, so guest functions are anonymous)");
        }
    }

    match info.source_map.as_deref() {
        Some(url) => {
            // The URL is written relative to the guest's own directory.
            let resolved = guest.parent().unwrap_or(Path::new(".")).join(url);
            let mark = if resolved.exists() {
                "found"
            } else {
                "MISSING — run `npm run build:debug`"
            };
            eprintln!("[tension-core] debug:   source map: {url} ({mark})");
        }
        None => eprintln!("[tension-core] debug:   source map: none — run `npm run build:debug`"),
    }

    for path in symbol_paths {
        eprintln!("[tension-core] debug:   symbol path: {}", path.display());
    }

    // The module/function hint keeps the example's own naming, which is what
    // `asc` derives from the source path: `<dir>/<file>.ts` -> `<dir>/<export>`.
    let hint = guest
        .file_stem()
        .map(|stem| format!("{}/", stem.to_string_lossy()))
        .unwrap_or_default();
    let source_hint = guest
        .file_stem()
        .map(|stem| format!("{}.ts", stem.to_string_lossy()))
        .unwrap_or_default();
    eprintln!("[tension-core] debug:   lldb: settings set plugin.jit-loader.gdb.enable on");
    for path in symbol_paths {
        eprintln!(
            "[tension-core] debug:   lldb: settings set target.debug-file-search-paths {}",
            path.display()
        );
    }
    eprintln!("[tension-core] debug:   lldb: image list                     # guest is JIT(0x...)");
    eprintln!(
        "[tension-core] debug:   lldb: breakpoint set -f {source_hint} -l <line>   # source line"
    );
    eprintln!(
        "[tension-core] debug:   lldb: breakpoint set -r '{hint}'   # or by function name"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A custom section: id 0, LEB size, LEB name length, name, payload.
    fn custom(name: &str, payload: &[u8]) -> Vec<u8> {
        let mut body = vec![name.len() as u8];
        body.extend_from_slice(name.as_bytes());
        body.extend_from_slice(payload);
        let mut out = vec![0u8, body.len() as u8];
        out.extend_from_slice(&body);
        out
    }

    fn guest(sections: &[Vec<u8>]) -> Vec<u8> {
        let mut out = b"\0asm\x01\0\0\0".to_vec();
        for section in sections {
            out.extend_from_slice(section);
        }
        out
    }

    /// `probe` reads a path, so the tests need a real file. The temp dir keeps
    /// the workspace clean; the name is unique per test via the byte pointer.
    fn probe_bytes(bytes: &[u8]) -> GuestDebugInfo {
        let path = std::env::temp_dir().join(format!(
            "tension-debug-probe-{}-{:p}.wasm",
            std::process::id(),
            bytes.as_ptr()
        ));
        std::fs::write(&path, bytes).expect("scratch write");
        let info = probe(&path);
        let _ = std::fs::remove_file(&path);
        info
    }

    #[test]
    fn reads_the_io_example_guest_shape() {
        // What `asc` actually emits: a `name` section plus a source map.
        let bytes = guest(&[
            custom("name", b"\x01\x02\x00\x00"),
            custom("sourceMappingURL", b"\x0f./game.wasm.map"),
        ]);
        let info = probe_bytes(&bytes);
        assert!(!info.dwarf, "`asc` emits no DWARF");
        assert!(info.names, "`asc` does emit the name section");
        assert_eq!(info.source_map.as_deref(), Some("./game.wasm.map"));
    }

    #[test]
    fn detects_debug_sections() {
        let info = probe_bytes(&guest(&[custom(".debug_info", &[0, 0, 0, 0])]));
        assert!(info.dwarf);
        assert!(!info.names);
        assert_eq!(info.source_map, None);
    }

    #[test]
    fn ignores_non_custom_sections() {
        // A type section (id 1) whose payload happens to look like a name, and
        // nothing else: no custom section is present, so nothing is claimed.
        let mut bytes = b"\0asm\x01\0\0\0".to_vec();
        bytes.extend_from_slice(&[
            1, 0x0c, 0x0c, b'.', b'd', b'e', b'b', b'u', b'g', b'_', b'i', b'n', b'f', b'o',
        ]);
        let info = probe_bytes(&bytes);
        assert!(!info.dwarf);
        assert!(!info.names);
        assert_eq!(info.source_map, None);
    }

    #[test]
    fn malformed_input_is_reported_as_unknown_not_panicked() {
        // Not wasm at all.
        let info = probe_bytes(b"this is not a wasm module");
        assert!(!info.dwarf);
        assert!(!info.names);
        assert_eq!(info.source_map, None);

        // Truncated: a custom section header promising 5 bytes that are absent.
        let info = probe_bytes(b"\0asm\x01\0\0\0\x00\x05");
        assert!(!info.dwarf);
        assert!(!info.names);
        assert_eq!(info.source_map, None);

        // Truncated mid-name: the size covers the name length but not the name.
        let info = probe_bytes(b"\0asm\x01\0\0\0\x00\x02\x10");
        assert!(!info.dwarf);
        assert!(!info.names);
        assert_eq!(info.source_map, None);

        // Magic only.
        let info = probe_bytes(b"\0asm\x01\0\0\0");
        assert!(!info.dwarf);
        assert!(!info.names);
        assert_eq!(info.source_map, None);
    }
}
