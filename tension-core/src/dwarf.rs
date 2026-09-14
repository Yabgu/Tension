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

// --------------------------------------------------------------- LEB128 ---

fn uleb(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let mut b = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            b |= 0x80;
        }
        out.push(b);
        if v == 0 {
            break;
        }
    }
}

fn sleb(out: &mut Vec<u8>, mut v: i64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        let done = (v == 0 && b & 0x40 == 0) || (v == -1 && b & 0x40 != 0);
        out.push(if done { b } else { b | 0x80 });
        if done {
            break;
        }
    }
}

// ---------------------------------------------------------- wasm reader ---

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Reader<'a> {
    fn new(b: &'a [u8], i: usize) -> Self {
        Self { b, i }
    }

    fn u8(&mut self) -> Option<u8> {
        let v = *self.b.get(self.i)?;
        self.i += 1;
        Some(v)
    }

    fn uleb(&mut self) -> Option<u64> {
        let (mut r, mut s) = (0u64, 0u32);
        loop {
            let x = self.u8()?;
            r |= ((x & 0x7f) as u64) << s;
            if x & 0x80 == 0 {
                return Some(r);
            }
            s += 7;
            if s > 62 {
                return None;
            }
        }
    }

    fn name(&mut self) -> Option<String> {
        let n = self.uleb()? as usize;
        let end = self.i.checked_add(n)?;
        let s = self.b.get(self.i..end)?;
        self.i = end;
        Some(String::from_utf8_lossy(s).into_owned())
    }
}

/// One `(params, results)` function type, as valtype bytes.
type FuncType = (Vec<u8>, Vec<u8>);

/// One function body's local declarations: `(count, valtype)` groups.
type LocalDecls = Vec<(u32, u8)>;

/// A body's `[start, end)` file offsets.
type BodyRange = (usize, usize);

/// A local in index order: name, index, value type (None when undescribable).
pub type LocalInfo = (String, u32, Option<ValType>);

/// A wasm value type we can describe to a debugger. Everything else (`v128`,
/// reference types) has no DWARF base type here and is left undescribed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ValType {
    I32,
    I64,
    F32,
    F64,
}

impl ValType {
    fn from_byte(b: u8) -> Option<ValType> {
        match b {
            0x7f => Some(ValType::I32),
            0x7e => Some(ValType::I64),
            0x7d => Some(ValType::F32),
            0x7c => Some(ValType::F64),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            ValType::I32 => "i32",
            ValType::I64 => "i64",
            ValType::F32 => "f32",
            ValType::F64 => "f64",
        }
    }

    /// `DW_AT_encoding`: signed integer or IEEE float.
    fn encoding(self) -> u8 {
        match self {
            ValType::I32 | ValType::I64 => 0x05,
            ValType::F32 | ValType::F64 => 0x04,
        }
    }

    fn byte_size(self) -> u8 {
        match self {
            ValType::I32 | ValType::F32 => 4,
            ValType::I64 | ValType::F64 => 8,
        }
    }
}

/// What the synthesizer must learn from the guest module itself.
pub struct Layout {
    /// File offset of the code section payload: DWARF address 0.
    pub code_payload_start: usize,
    /// Payload size; also the exclusive end of the address space.
    pub code_payload_size: usize,
    /// Body content `[start, end)` in file offsets, one per defined function.
    pub bodies: Vec<BodyRange>,
    /// Body local declarations `(count, valtype)`, parallel to `bodies`.
    pub body_decls: Vec<LocalDecls>,
    /// Functions declared in the import section; the index space starts there.
    pub imported_funcs: u32,
    /// `name` section function names by function index.
    pub names: Vec<(u32, String)>,
    /// `name` section local names: function index, local index, name.
    pub local_names: Vec<(u32, u32, String)>,
    /// Function type indices from the function section, one per defined function.
    pub func_types: Vec<u32>,
    /// Function types from the type section: `(params, results)` as valtype bytes.
    pub types: Vec<FuncType>,
}

impl Layout {
    pub fn parse(wasm: &[u8]) -> Result<Layout, String> {
        if wasm.len() < 8 || wasm[0..4] != [0x00, b'a', b's', b'm'] {
            return Err("not a wasm module".into());
        }
        let mut out = Layout {
            code_payload_start: 0,
            code_payload_size: 0,
            bodies: Vec::new(),
            body_decls: Vec::new(),
            imported_funcs: 0,
            names: Vec::new(),
            local_names: Vec::new(),
            func_types: Vec::new(),
            types: Vec::new(),
        };
        let mut found_code = false;
        let mut r = Reader::new(wasm, 8);
        while r.i < wasm.len() {
            let id = r.u8().ok_or("truncated section id")?;
            let size = r.uleb().ok_or("truncated section size")? as usize;
            let payload = r.i;
            let end = payload.checked_add(size).ok_or("section size overflow")?;
            if end > wasm.len() {
                return Err(format!("section {id} extends past end of module"));
            }
            match id {
                1 => out.types = read_types(&wasm[payload..end])?,
                2 => out.imported_funcs = count_imported_funcs(&wasm[payload..end])?,
                3 => out.func_types = read_function_types(&wasm[payload..end])?,
                10 => {
                    found_code = true;
                    out.code_payload_start = payload;
                    out.code_payload_size = size;
                    (out.bodies, out.body_decls) = code_bodies(&wasm[payload..end], payload)?;
                }
                0 => {
                    let mut c = Reader::new(wasm, payload);
                    let name = c.name().ok_or("malformed custom section name")?;
                    if name == "name" {
                        read_name_subsections(
                            &wasm[c.i..end],
                            &mut out.names,
                            &mut out.local_names,
                        )?;
                    }
                }
                _ => {}
            }
            r.i = end;
        }
        if !found_code {
            return Err("module has no code section".into());
        }
        Ok(out)
    }

    /// Name of the function defined by body `i`, if the guest kept names.
    pub fn name_for_body(&self, body: usize) -> Option<&str> {
        let want = self.imported_funcs + body as u32;
        self.names
            .iter()
            .find(|(idx, _)| *idx == want)
            .map(|(_, n)| n.as_str())
    }

    /// A guest local in index order: the function's parameters first, then
    /// the body's declarations. `name` is what `asc --debug` kept in the
    /// `name` section (subsection 2) when present, else a fallback.
    ///
    /// Names can lie beyond the declared local count (binaryen renames SSA
    /// values), so they are looked up per index instead of iterated.
    pub fn locals_for_body(&self, body: usize) -> Vec<LocalInfo> {
        let func = self.imported_funcs + body as u32;
        let mut out = Vec::new();

        let param_types = self
            .func_types
            .get(body)
            .and_then(|t| self.types.get(*t as usize))
            .map(|(params, _)| params.as_slice())
            .unwrap_or(&[]);
        for (i, &byte) in param_types.iter().enumerate() {
            let name = self
                .local_name(func, i as u32)
                .unwrap_or_else(|| format!("param{i}"));
            out.push((name, i as u32, ValType::from_byte(byte)));
        }

        let mut index = param_types.len() as u32;
        for &(count, byte) in self.body_decls.get(body).map(Vec::as_slice).unwrap_or(&[]) {
            for _ in 0..count {
                let name = self
                    .local_name(func, index)
                    .unwrap_or_else(|| format!("local{index}"));
                out.push((name, index, ValType::from_byte(byte)));
                index += 1;
            }
        }
        out
    }

    fn local_name(&self, func: u32, index: u32) -> Option<String> {
        self.local_names
            .iter()
            .find(|(f, i, _)| *f == func && *i == index)
            .map(|(_, _, n)| n.clone())
    }

    /// Absolute directory guest sources are relative to.
    pub fn comp_dir(roots: &[PathBuf], wasm: &Path) -> String {
        for root in roots {
            if root.is_dir() {
                return root.display().to_string();
            }
        }
        let dir = wasm
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        // `build/game.wasm` sits one level below the project sources live in.
        if dir.file_name().and_then(|n| n.to_str()) == Some("build") {
            if let Some(parent) = dir.parent() {
                if !parent.as_os_str().is_empty() {
                    return parent.display().to_string();
                }
            }
        }
        dir.display().to_string()
    }
}

fn count_imported_funcs(sec: &[u8]) -> Result<u32, String> {
    let mut r = Reader::new(sec, 0);
    let n = r.uleb().ok_or("truncated import count")?;
    let mut funcs = 0u32;
    for _ in 0..n {
        r.name().ok_or("truncated import module")?;
        r.name().ok_or("truncated import name")?;
        match r.u8().ok_or("truncated import kind")? {
            0x00 => {
                r.uleb().ok_or("truncated function type index")?;
                funcs += 1;
            }
            0x01 => {
                r.u8().ok_or("truncated table element type")?;
                read_limits(&mut r)?;
            }
            0x02 => read_limits(&mut r)?,
            0x03 => {
                r.u8().ok_or("truncated global type")?;
                r.u8().ok_or("truncated global mutability")?;
            }
            k => return Err(format!("unknown import kind {k:#x}")),
        }
    }
    Ok(funcs)
}

/// Type section: one `(params, results)` per function type, as valtype bytes.
fn read_types(sec: &[u8]) -> Result<Vec<FuncType>, String> {
    let mut r = Reader::new(sec, 0);
    let n = r.uleb().ok_or("truncated type count")?;
    let mut out = Vec::new();
    for _ in 0..n {
        let form = r.u8().ok_or("truncated type form")?;
        if form != 0x60 {
            return Err(format!("type form {form:#x} is not a function type"));
        }
        let np = r.uleb().ok_or("truncated param count")? as usize;
        let mut params = Vec::new();
        for _ in 0..np {
            params.push(r.u8().ok_or("truncated param type")?);
        }
        let nr = r.uleb().ok_or("truncated result count")? as usize;
        let mut results = Vec::new();
        for _ in 0..nr {
            results.push(r.u8().ok_or("truncated result type")?);
        }
        out.push((params, results));
    }
    Ok(out)
}

/// Function section: one type index per function, in index space (imports first).
fn read_function_types(sec: &[u8]) -> Result<Vec<u32>, String> {
    let mut r = Reader::new(sec, 0);
    let n = r.uleb().ok_or("truncated function count")?;
    let mut out = Vec::new();
    for _ in 0..n {
        out.push(r.uleb().ok_or("truncated function type index")? as u32);
    }
    Ok(out)
}

fn read_limits(r: &mut Reader) -> Result<(), String> {
    let flags = r.uleb().ok_or("truncated limits flags")?;
    r.uleb().ok_or("truncated limits minimum")?;
    if flags & 0x01 != 0 {
        r.uleb().ok_or("truncated limits maximum")?;
    }
    Ok(())
}

/// Body content ranges in file offsets plus each body's local declarations;
/// `base` is the section payload offset.
fn code_bodies(sec: &[u8], base: usize) -> Result<(Vec<BodyRange>, Vec<LocalDecls>), String> {
    let mut r = Reader::new(sec, 0);
    let n = r.uleb().ok_or("truncated function count")?;
    let mut out = Vec::new();
    let mut decls = Vec::new();
    for _ in 0..n {
        let size = r.uleb().ok_or("truncated body size")? as usize;
        let start = r.i;
        let end = start.checked_add(size).ok_or("body size overflow")?;
        if end > sec.len() {
            return Err("function body extends past the code section".into());
        }
        // The body opens with its local-declaration groups; the rest is code.
        let mut b = Reader::new(sec, start);
        let groups = b.uleb().ok_or("truncated local declaration count")?;
        let mut body_decls = Vec::new();
        for _ in 0..groups {
            let count = b.uleb().ok_or("truncated local count")? as u32;
            let ty = b.u8().ok_or("truncated local type")?;
            body_decls.push((count, ty));
        }
        out.push((base + start, base + end));
        decls.push(body_decls);
        r.i = end;
    }
    Ok((out, decls))
}

/// `name` section subsections 1 and 2: function names and local names.
fn read_name_subsections(
    sec: &[u8],
    names: &mut Vec<(u32, String)>,
    local_names: &mut Vec<(u32, u32, String)>,
) -> Result<(), String> {
    let mut r = Reader::new(sec, 0);
    while r.i < sec.len() {
        let id = r.u8().ok_or("truncated name subsection id")?;
        let size = r.uleb().ok_or("truncated name subsection size")? as usize;
        let end = r.i.checked_add(size).ok_or("name subsection overflow")?;
        if end > sec.len() {
            return Err("name subsection extends past its section".into());
        }
        if id == 1 {
            let mut c = Reader::new(sec, r.i);
            let n = c.uleb().ok_or("truncated function name count")?;
            for _ in 0..n {
                let idx = c.uleb().ok_or("truncated function index")? as u32;
                let name = c.name().ok_or("truncated function name")?;
                names.push((idx, name));
            }
        } else if id == 2 {
            let mut c = Reader::new(sec, r.i);
            let n = c.uleb().ok_or("truncated local name function count")?;
            for _ in 0..n {
                let func = c.uleb().ok_or("truncated local name function index")? as u32;
                let m = c.uleb().ok_or("truncated local name count")?;
                for _ in 0..m {
                    let idx = c.uleb().ok_or("truncated local index")? as u32;
                    let name = c.name().ok_or("truncated local name")?;
                    local_names.push((func, idx, name));
                }
            }
        }
        r.i = end;
    }
    Ok(())
}

// ------------------------------------------------------------ source map ---

/// One source-map segment: wasm file offset -> source line/column.
pub struct Seg {
    pub addr: u32,
    pub file: u32,
    pub line: u32,
    pub col: u32,
}

pub struct SourceMap {
    pub sources: Vec<String>,
    pub segments: Vec<Seg>,
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_val(c: u8) -> Option<i64> {
    B64.iter().position(|x| *x == c).map(|p| p as i64)
}

/// Decode one comma-free group of base64 VLQ digits.
fn vlq(s: &str) -> Result<Vec<i64>, String> {
    let mut out = Vec::new();
    let (mut value, mut shift) = (0i64, 0u32);
    let mut open = false;
    for c in s.bytes() {
        let d = b64_val(c).ok_or_else(|| format!("bad base64 digit {c:?}"))?;
        open = true;
        value += (d & 31) << shift;
        if d & 32 != 0 {
            shift += 5;
            if shift > 62 {
                return Err("vlq group too long".into());
            }
        } else {
            let neg = value & 1 == 1;
            value >>= 1;
            out.push(if neg { -value } else { value });
            value = 0;
            shift = 0;
            open = false;
        }
    }
    if open {
        return Err("truncated vlq group".into());
    }
    Ok(out)
}

/// Decode `mappings`. Generated columns are absolute wasm file offsets.
///
/// The source-map spec resets the generated column to 0 at each `;`-separated
/// line group; source line, source column and file index keep accumulating
/// across groups.
pub fn parse_mappings(mappings: &str, source_count: usize) -> Result<Vec<Seg>, String> {
    let mut segs = Vec::new();
    let (mut file, mut line, mut col) = (0i64, 0i64, 0i64);
    for group in mappings.split(';') {
        let mut addr = 0i64;
        for seg in group.split(',') {
            if seg.is_empty() {
                continue;
            }
            let v = vlq(seg)?;
            // A one-field segment carries a generated column and nothing else:
            // it marks code with no source position. Only 2- and 3-field
            // segments are actually malformed.
            if v.len() == 1 {
                addr += v[0];
                if addr < 0 {
                    return Err("negative generated offset".into());
                }
                continue;
            }
            if v.len() < 4 {
                return Err(format!("segment has {} fields, expected 1 or 4", v.len()));
            }
            addr += v[0];
            file += v[1];
            line += v[2];
            col += v[3];
            if addr < 0 {
                return Err("negative generated offset".into());
            }
            if file < 0 || file as usize >= source_count {
                return Err(format!("segment names source {file}, out of range"));
            }
            segs.push(Seg {
                addr: addr as u32,
                file: file as u32,
                // Source maps count lines from zero; DWARF counts from one.
                line: (line + 1) as u32,
                col: col.max(0) as u32,
            });
        }
    }
    Ok(segs)
}

const QUOTE: u8 = 34;
const BSLASH: u8 = 92;

struct Json<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Json<'a> {
    fn new(s: &'a str) -> Self {
        Self {
            b: s.as_bytes(),
            i: 0,
        }
    }

    fn ws(&mut self) {
        while let Some(c) = self.b.get(self.i) {
            if matches!(*c, b' ' | 9 | 10 | 13) {
                self.i += 1;
            } else {
                break;
            }
        }
    }

    fn eat(&mut self, c: u8) -> Result<(), String> {
        self.ws();
        if self.b.get(self.i) == Some(&c) {
            self.i += 1;
            Ok(())
        } else {
            Err(format!("expected {:?} at byte {}", char::from(c), self.i))
        }
    }

    /// Skip a string without materializing it: `sourcesContent` is megabytes.
    fn skip_string(&mut self) -> Result<(), String> {
        self.ws();
        if self.b.get(self.i) != Some(&QUOTE) {
            return Err(format!("expected string at byte {}", self.i));
        }
        self.i += 1;
        while let Some(&c) = self.b.get(self.i) {
            self.i += 1;
            match c {
                QUOTE => return Ok(()),
                BSLASH => self.i += 1,
                _ => {}
            }
        }
        Err("unterminated string".into())
    }

    fn string(&mut self) -> Result<String, String> {
        self.ws();
        if self.b.get(self.i) != Some(&QUOTE) {
            return Err(format!("expected string at byte {}", self.i));
        }
        self.i += 1;
        let mut out = String::new();
        while let Some(&c) = self.b.get(self.i) {
            match c {
                QUOTE => {
                    self.i += 1;
                    return Ok(out);
                }
                BSLASH => {
                    self.i += 1;
                    let e = *self.b.get(self.i).ok_or("truncated escape")?;
                    self.i += 1;
                    if e == 117 {
                        let h = self.b.get(self.i..self.i + 4).ok_or("short u-escape")?;
                        let h = std::str::from_utf8(h).map_err(|_| "bad u-escape")?;
                        let n = u32::from_str_radix(h, 16).map_err(|_| "bad hex")?;
                        self.i += 4;
                        out.push(char::from_u32(n).unwrap_or('?'));
                    } else {
                        out.push(match e {
                            110 => char::from(10u8),
                            116 => char::from(9u8),
                            114 => char::from(13u8),
                            98 => char::from(8u8),
                            102 => char::from(12u8),
                            other => char::from(other),
                        });
                    }
                }
                _ => {
                    let start = self.i;
                    while let Some(&n) = self.b.get(self.i) {
                        if n == QUOTE || n == BSLASH {
                            break;
                        }
                        self.i += 1;
                    }
                    out.push_str(&String::from_utf8_lossy(&self.b[start..self.i]));
                }
            }
        }
        Err("unterminated string".into())
    }

    fn skip_value(&mut self) -> Result<(), String> {
        self.ws();
        match self.b.get(self.i) {
            Some(&QUOTE) => self.skip_string(),
            Some(&b'{') | Some(&b'[') => {
                let object = self.b[self.i] == b'{';
                let close = if object { b'}' } else { b']' };
                self.i += 1;
                loop {
                    self.ws();
                    if self.b.get(self.i) == Some(&close) {
                        self.i += 1;
                        return Ok(());
                    }
                    if object {
                        self.string()?;
                        self.eat(b':')?;
                    }
                    self.skip_value()?;
                    self.ws();
                    match self.b.get(self.i) {
                        Some(&b',') => self.i += 1,
                        Some(&c) if c == close => {
                            self.i += 1;
                            return Ok(());
                        }
                        _ => return Err("bad container".into()),
                    }
                }
            }
            Some(_) => {
                let start = self.i;
                while let Some(&c) = self.b.get(self.i) {
                    if matches!(c, b',' | b']' | b'}' | b' ' | 9 | 10 | 13) {
                        break;
                    }
                    self.i += 1;
                }
                if self.i == start {
                    return Err(format!("bad value at byte {}", self.i));
                }
                Ok(())
            }
            None => Err("unexpected end of input".into()),
        }
    }
}

/// Read `sources` and `mappings` out of a source-map v3 document.
pub fn parse_source_map(json: &str) -> Result<SourceMap, String> {
    let mut j = Json::new(json);
    let mut sources: Option<Vec<String>> = None;
    let mut mappings: Option<String> = None;
    j.eat(b'{')?;
    loop {
        j.ws();
        if j.b.get(j.i) == Some(&b'}') {
            break;
        }
        let key = j.string()?;
        j.eat(b':')?;
        match key.as_str() {
            "sources" => {
                let mut v = Vec::new();
                j.eat(b'[')?;
                loop {
                    j.ws();
                    if j.b.get(j.i) == Some(&b']') {
                        break;
                    }
                    v.push(j.string()?);
                    j.ws();
                    if j.b.get(j.i) == Some(&b',') {
                        j.i += 1;
                    } else {
                        break;
                    }
                }
                j.eat(b']')?;
                sources = Some(v);
            }
            "mappings" => mappings = Some(j.string()?),
            _ => j.skip_value()?,
        }
        j.ws();
        if j.b.get(j.i) == Some(&b',') {
            j.i += 1;
        }
    }
    let sources = sources.ok_or("source map has no sources")?;
    let mappings = mappings.ok_or("source map has no mappings")?;
    let segments = parse_mappings(&mappings, sources.len())?;
    Ok(SourceMap { sources, segments })
}

// ----------------------------------------------------------- DWARF emit ---

const DW_TAG_COMPILE_UNIT: u64 = 0x11;
const DW_TAG_SUBPROGRAM: u64 = 0x2e;
const DW_TAG_BASE_TYPE: u64 = 0x24;
const DW_TAG_VARIABLE: u64 = 0x34;
const DW_AT_NAME: u64 = 0x03;
const DW_AT_STMT_LIST: u64 = 0x10;
const DW_AT_LOW_PC: u64 = 0x11;
const DW_AT_HIGH_PC: u64 = 0x12;
const DW_AT_COMP_DIR: u64 = 0x1b;
const DW_AT_RANGES: u64 = 0x55;
const DW_AT_EXTERNAL: u64 = 0x3f;
const DW_AT_TYPE: u64 = 0x49;
const DW_AT_LOCATION: u64 = 0x02;
const DW_AT_ENCODING: u64 = 0x3e;
const DW_AT_BYTE_SIZE: u64 = 0x0b;
const DW_FORM_ADDR: u64 = 0x01;
const DW_FORM_STRING: u64 = 0x08;
const DW_FORM_SEC_OFFSET: u64 = 0x17;
const DW_FORM_FLAG_PRESENT: u64 = 0x19;
const DW_FORM_DATA1: u64 = 0x0b;
const DW_FORM_REF4: u64 = 0x13;
const DW_FORM_EXPRLOC: u64 = 0x18;

/// The WebAssembly location operators from DWARF 5's wasm extension, which
/// wasmtime's transform understands: `DW_OP_WASM_location 0x00 <local index>`
/// is the location of a local, and a trailing `DW_OP_stack_value` marks the
/// expression as producing the value itself (what cranelift rewrites into
/// `DW_OP_regN` / `DW_OP_fbreg` per address range).
const DW_OP_WASM_LOCATION: u8 = 0xed;
const DW_OP_STACK_VALUE: u8 = 0x9f;

/// DWARF 4, DWARF32. Wasmtime's transform consumes the shape LLVM emits for
/// wasm; that shape is what all of the above mirrors.
const DWARF_VERSION: u16 = 4;

fn attr(out: &mut Vec<u8>, name: u64, form: u64) {
    uleb(out, name);
    uleb(out, form);
}

/// Abbrev 1: compile unit. Abbrev 2: subprogram. Abbrev 3: subprogram with
/// children. Abbrev 4: base type. Abbrev 5: variable. No `strp`, so no
/// `.debug_str`; type references are `DW_FORM_ref4` within the unit.
fn append_abbrev() -> Vec<u8> {
    let mut a = Vec::new();
    uleb(&mut a, 1);
    uleb(&mut a, DW_TAG_COMPILE_UNIT);
    uleb(&mut a, 1); // has children
    attr(&mut a, DW_AT_NAME, DW_FORM_STRING);
    attr(&mut a, DW_AT_COMP_DIR, DW_FORM_STRING);
    attr(&mut a, DW_AT_STMT_LIST, DW_FORM_SEC_OFFSET);
    // The unit's own extent must be a range list: wasmtime's transform rewrites
    // `DW_AT_ranges` entries to native addresses, but leaves a unit's
    // `DW_AT_low_pc`/`DW_AT_high_pc` untouched - a unit stuck at wasm address 0
    // covers no JIT code, and a debugger cannot map a line-table address back
    // to it.
    attr(&mut a, DW_AT_RANGES, DW_FORM_SEC_OFFSET);
    uleb(&mut a, 0);
    uleb(&mut a, 0);

    uleb(&mut a, 2);
    uleb(&mut a, DW_TAG_SUBPROGRAM);
    uleb(&mut a, 0); // no children
    attr(&mut a, DW_AT_NAME, DW_FORM_STRING);
    attr(&mut a, DW_AT_LOW_PC, DW_FORM_ADDR);
    attr(&mut a, DW_AT_HIGH_PC, DW_FORM_ADDR);
    attr(&mut a, DW_AT_EXTERNAL, DW_FORM_FLAG_PRESENT);
    uleb(&mut a, 0);
    uleb(&mut a, 0);

    // Same subprogram, but with children: the local variable DIEs hang off it.
    uleb(&mut a, 3);
    uleb(&mut a, DW_TAG_SUBPROGRAM);
    uleb(&mut a, 1); // has children
    attr(&mut a, DW_AT_NAME, DW_FORM_STRING);
    attr(&mut a, DW_AT_LOW_PC, DW_FORM_ADDR);
    attr(&mut a, DW_AT_HIGH_PC, DW_FORM_ADDR);
    attr(&mut a, DW_AT_EXTERNAL, DW_FORM_FLAG_PRESENT);
    uleb(&mut a, 0);
    uleb(&mut a, 0);

    uleb(&mut a, 4);
    uleb(&mut a, DW_TAG_BASE_TYPE);
    uleb(&mut a, 0); // no children
    attr(&mut a, DW_AT_NAME, DW_FORM_STRING);
    attr(&mut a, DW_AT_ENCODING, DW_FORM_DATA1);
    attr(&mut a, DW_AT_BYTE_SIZE, DW_FORM_DATA1);
    uleb(&mut a, 0);
    uleb(&mut a, 0);

    uleb(&mut a, 5);
    uleb(&mut a, DW_TAG_VARIABLE);
    uleb(&mut a, 0); // no children
    attr(&mut a, DW_AT_NAME, DW_FORM_STRING);
    attr(&mut a, DW_AT_TYPE, DW_FORM_REF4);
    attr(&mut a, DW_AT_LOCATION, DW_FORM_EXPRLOC);
    uleb(&mut a, 0);
    uleb(&mut a, 0);
    a.push(0);
    a
}

fn cstr(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(s.as_bytes());
    out.push(0);
}

/// Turn an AssemblyScript source-map path into one the symbol root resolves.
/// `asc` writes library sources as `~lib/...`, which no debugger understands.
fn source_path(raw: &str, comp_dir: &Path) -> String {
    if let Some(rest) = raw.strip_prefix("~lib/") {
        let linked = format!("node_modules/{rest}");
        if comp_dir.join(&linked).exists() {
            return linked;
        }
        let std = format!("node_modules/assemblyscript/std/assembly/{rest}");
        if comp_dir.join(&std).exists() {
            return std;
        }
        return linked;
    }
    raw.to_string()
}

/// A DWARF v4 line program. `rows` must be sorted ascending by address.
fn append_line(comp_dir: &str, sources: &[String], rows: &[Seg], ranges: &[(u32, u32)]) -> Vec<u8> {
    let mut prologue = vec![
        1,        // minimum_instruction_length
        1,        // maximum_operations_per_instruction
        1,        // default_is_stmt
        (-5i8) as u8, // line_base
        14,       // line_range
        13,       // opcode_base
    ];
    prologue.extend_from_slice(&[0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0]);
    cstr(&mut prologue, comp_dir);
    prologue.push(0); // end of include_directories
    let root = Path::new(comp_dir);
    for s in sources {
        cstr(&mut prologue, &source_path(s, root));
        uleb(&mut prologue, 1); // directory index
        uleb(&mut prologue, 0); // mtime
        uleb(&mut prologue, 0); // length
    }
    prologue.push(0); // end of file_names

    let mut prog = Vec::new();
    // One sequence per function.  wasmtime's `clone_line_program` picks a
    // sequence's function from its *first* row and attributes every following
    // row of that sequence to that same function; a single module-wide
    // sequence would hand every row to one function and drop all the rest.
    // Rows that fall outside every body (padding, LEB headers) are skipped:
    // their addresses have no function to be attributed to.
    for (start, end) in ranges {
        let first = rows.partition_point(|r| r.addr < *start);
        let last = rows.partition_point(|r| r.addr < *end);
        if first >= last {
            continue;
        }
        let seq = &rows[first..last];
        let seq_start = seq[0].addr;
        prog.push(0); // extended opcode
        prog.push(5); // length: opcode + 4-byte address
        prog.push(2); // DW_LNE_set_address
        prog.extend_from_slice(&seq_start.to_le_bytes());

        let (mut pc, mut line, mut file, mut col) = (seq_start, 1u32, 1u32, 0u32);
        for r in seq {
            if r.addr != pc {
                prog.push(2); // DW_LNS_advance_pc
                uleb(&mut prog, (r.addr - pc) as u64);
                pc = r.addr;
            }
            if r.file + 1 != file {
                prog.push(4); // DW_LNS_set_file
                uleb(&mut prog, (r.file + 1) as u64);
                file = r.file + 1;
            }
            if r.line != line {
                prog.push(3); // DW_LNS_advance_line
                sleb(&mut prog, r.line as i64 - line as i64);
                line = r.line;
            }
            if r.col != col {
                prog.push(5); // DW_LNS_set_column
                uleb(&mut prog, r.col as u64);
                col = r.col;
            }
            prog.push(1); // DW_LNS_copy
        }
        prog.extend_from_slice(&[0, 1, 1]); // DW_LNE_end_sequence
    }

    let mut out = Vec::new();
    let unit_length = 2 + 4 + prologue.len() + prog.len();
    out.extend_from_slice(&(unit_length as u32).to_le_bytes());
    out.extend_from_slice(&DWARF_VERSION.to_le_bytes());
    out.extend_from_slice(&(prologue.len() as u32).to_le_bytes());
    out.extend_from_slice(&prologue);
    out.extend_from_slice(&prog);
    out
}

/// One `DW_TAG_subprogram` per defined function the name section knows about,
/// and one `DW_TAG_variable` child per wasm local whose type we can describe.
/// `locals` is parallel to `functions`.
fn append_info(
    module_name: &str,
    comp_dir: &str,
    functions: &[(String, u32, u32)],
    locals: &[Vec<(String, u32, ValType)>],
) -> Vec<u8> {
    let mut cu = Vec::new();
    uleb(&mut cu, 1); // abbrev 1: compile unit
    cstr(&mut cu, module_name);
    cstr(&mut cu, comp_dir);
    cu.extend_from_slice(&0u32.to_le_bytes()); // DW_AT_stmt_list
    cu.extend_from_slice(&0u32.to_le_bytes()); // DW_AT_ranges -> .debug_ranges[0]

    // The unit header precedes the CU DIE; `DW_FORM_ref4` offsets are measured
    // from its first byte, so every base type's unit offset is known up front.
    // Base types are the unit's first children, before the subprograms that
    // reference them.
    let unit_header_len = 4 + 2 + 4 + 1; // length + version + abbrev offset + addr size
    let base_order = [ValType::I32, ValType::I64, ValType::F32, ValType::F64];
    let mut type_offsets = [0usize; 4];
    let mut children = Vec::new();
    let mut offset = unit_header_len + cu.len();
    for (i, ty) in base_order.iter().enumerate() {
        type_offsets[i] = offset;
        let mut die = Vec::new();
        uleb(&mut die, 4); // abbrev 4: base type
        cstr(&mut die, ty.name());
        die.push(ty.encoding());
        die.push(ty.byte_size());
        offset += die.len();
        children.extend_from_slice(&die);
    }

    for ((name, lo, hi), vars) in functions.iter().zip(locals) {
        if vars.is_empty() {
            uleb(&mut children, 2); // abbrev 2: subprogram, no children
            cstr(&mut children, name);
            children.extend_from_slice(&lo.to_le_bytes());
            children.extend_from_slice(&hi.to_le_bytes());
        } else {
            uleb(&mut children, 3); // abbrev 3: subprogram with children
            cstr(&mut children, name);
            children.extend_from_slice(&lo.to_le_bytes());
            children.extend_from_slice(&hi.to_le_bytes());
            for (var_name, index, ty) in vars {
                // `DW_OP_WASM_location 0x00 <local index> DW_OP_stack_value`:
                // the value of wasm local `index`, wherever cranelift holds it.
                let mut expr = vec![DW_OP_WASM_LOCATION, 0x00];
                uleb(&mut expr, *index as u64);
                expr.push(DW_OP_STACK_VALUE);

                uleb(&mut children, 5); // abbrev 5: variable
                cstr(&mut children, var_name);
                children.extend_from_slice(&(type_offsets[type_index(*ty)] as u32).to_le_bytes());
                uleb(&mut children, expr.len() as u64);
                children.extend_from_slice(&expr);
            }
            children.push(0); // end of the subprogram's children
        }
    }
    children.push(0); // end of the compile unit's children

    let mut out = Vec::new();
    let unit_length = 2 + 4 + 1 + cu.len() + children.len();
    out.extend_from_slice(&(unit_length as u32).to_le_bytes());
    out.extend_from_slice(&DWARF_VERSION.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // abbrev offset
    out.push(4); // address_size
    out.extend_from_slice(&cu);
    out.extend_from_slice(&children);
    out
}

/// Position of a `ValType` in the base-type DIE order, for `type_offsets`.
fn type_index(ty: ValType) -> usize {
    match ty {
        ValType::I32 => 0,
        ValType::I64 => 1,
        ValType::F32 => 2,
        ValType::F64 => 3,
    }
}

fn append_custom(out: &mut Vec<u8>, name: &str, payload: &[u8]) {
    // A wasm custom section is: id, size, name length, name, payload - where
    // `size` counts everything after itself.
    let mut sec = Vec::new();
    uleb(&mut sec, name.len() as u64);
    sec.extend_from_slice(name.as_bytes());
    sec.extend_from_slice(payload);
    out.push(0); // custom section id
    uleb(out, sec.len() as u64);
    out.extend_from_slice(&sec);
}

/// What synthesis produced, for the startup diagnostic.
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

/// A producer that emitted `.debug_*` did the work; never second-guess it.
fn has_debug_sections(wasm: &[u8]) -> bool {
    if wasm.len() < 8 || wasm[0..4] != [0x00, b'a', b's', b'm'] {
        return false;
    }
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
                if name.starts_with(".debug_") {
                    return true;
                }
            }
        }
        r.i = end;
    }
    false
}

/// Read the guest and its source map, and return the augmented module bytes.
///
/// `None` means "load the file as it stands". Every failure below is a
/// diagnostic inconvenience, never a reason to refuse to run the game.
pub fn augment(wasm_path: &Path, symbol_roots: &[PathBuf]) -> Option<Vec<u8>> {
    let wasm = match std::fs::read(wasm_path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!(
                "[tension-core] debug: cannot read {}: {e}",
                wasm_path.display()
            );
            return None;
        }
    };
    if has_debug_sections(&wasm) {
        eprintln!("[tension-core] debug: guest already carries DWARF; leaving it alone");
        return None;
    }
    let info = crate::debug::probe(wasm_path);
    let url = match info.source_map {
        Some(u) => u,
        None => {
            eprintln!(
                "[tension-core] debug: guest has no sourceMappingURL, so there is no line table to synthesize\n\
                 [tension-core] debug: build it with `--debug --sourceMap` (see examples/io `build:debug`)"
            );
            return None;
        }
    };
    let map_path = resolve_map_path(wasm_path, &url);
    let json = match std::fs::read_to_string(&map_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "[tension-core] debug: cannot read source map {}: {e}",
                map_path.display()
            );
            return None;
        }
    };
    let map = match parse_source_map(&json) {
        Ok(m) => m,
        Err(e) => {
            eprintln!(
                "[tension-core] debug: source map {}: {e}",
                map_path.display()
            );
            return None;
        }
    };
    match synthesize(&wasm, &map, symbol_roots, wasm_path) {
        Ok((bytes, stats)) => {
            eprintln!(
                "[tension-core] debug: synthesized DWARF - {} files, {} line rows ({} outside the code section), {} functions, {} locals",
                stats.files, stats.rows, stats.dropped, stats.functions, stats.locals
            );
            Some(bytes)
        }
        Err(e) => {
            eprintln!("[tension-core] debug: cannot synthesize DWARF: {e}");
            None
        }
    }
}

// ----------------------------------------------------------------- tests ---

#[cfg(test)]
mod tests {
    use super::*;

    fn u(v: u64) -> Vec<u8> {
        let mut b = Vec::new();
        uleb(&mut b, v);
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
    fn layout_finds_code_names_and_import_count() {
        let layout = Layout::parse(&synthetic_guest()).unwrap();
        assert_eq!(layout.imported_funcs, 1);
        assert_eq!(layout.bodies.len(), 1);
        assert_eq!(layout.name_for_body(0), Some("game/_start_game"));
        assert!(layout.code_payload_start > 8);
        assert!(layout.code_payload_size > 0);
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
