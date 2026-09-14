//! Parsing the guest module: the section walk, code bodies, the `name`
//! section, and everything synthesis needs from all of it.

use std::path::{Path, PathBuf};

use crate::leb;

pub(crate) struct Reader<'a> {
    pub(crate) b: &'a [u8],
    pub(crate) i: usize,
}

impl<'a> Reader<'a> {
    pub(crate) fn new(b: &'a [u8], i: usize) -> Self {
        Self { b, i }
    }

    pub(crate) fn u8(&mut self) -> Option<u8> {
        let v = *self.b.get(self.i)?;
        self.i += 1;
        Some(v)
    }

    pub(crate) fn uleb(&mut self) -> Option<u64> {
        let v = leb::read_uleb(self.b, &mut self.i)?;
        Some(v as u64)
    }

    pub(crate) fn name(&mut self) -> Option<String> {
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
pub(crate) type LocalInfo = (String, u32, Option<ValType>);

/// A wasm value type we can describe to a debugger. Everything else (`v128`,
/// reference types) has no DWARF base type here and is left undescribed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ValType {
    I32,
    I64,
    F32,
    F64,
}

impl ValType {
    pub(crate) fn from_byte(b: u8) -> Option<ValType> {
        match b {
            0x7f => Some(ValType::I32),
            0x7e => Some(ValType::I64),
            0x7d => Some(ValType::F32),
            0x7c => Some(ValType::F64),
            _ => None,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            ValType::I32 => "i32",
            ValType::I64 => "i64",
            ValType::F32 => "f32",
            ValType::F64 => "f64",
        }
    }

    /// `DW_AT_encoding`: signed integer or IEEE float.
    pub(crate) fn encoding(self) -> u8 {
        match self {
            ValType::I32 | ValType::I64 => 0x05,
            ValType::F32 | ValType::F64 => 0x04,
        }
    }

    pub(crate) fn byte_size(self) -> u8 {
        match self {
            ValType::I32 | ValType::F32 => 4,
            ValType::I64 | ValType::F64 => 8,
        }
    }
}

/// What the synthesizer must learn from the guest module itself.
pub(crate) struct Layout {
    /// File offset of the code section payload: DWARF address 0.
    pub(crate) code_payload_start: usize,
    /// Payload size; also the exclusive end of the address space.
    pub(crate) code_payload_size: usize,
    /// Body content `[start, end)` in file offsets, one per defined function.
    pub(crate) bodies: Vec<BodyRange>,
    /// Body local declarations `(count, valtype)`, parallel to `bodies`.
    pub(crate) body_decls: Vec<LocalDecls>,
    /// Functions declared in the import section; the index space starts there.
    pub(crate) imported_funcs: u32,
    /// `name` section function names by function index.
    pub(crate) names: Vec<(u32, String)>,
    /// `name` section local names: function index, local index, name.
    pub(crate) local_names: Vec<(u32, u32, String)>,
    /// Function type indices from the function section, one per defined function.
    pub(crate) func_types: Vec<u32>,
    /// Function types from the type section: `(params, results)` as valtype bytes.
    pub(crate) types: Vec<FuncType>,
}

impl Layout {
    pub(crate) fn parse(wasm: &[u8]) -> Result<Layout, String> {
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
    pub(crate) fn name_for_body(&self, body: usize) -> Option<&str> {
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
    pub(crate) fn locals_for_body(&self, body: usize) -> Vec<LocalInfo> {
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
    pub(crate) fn comp_dir(roots: &[PathBuf], wasm: &Path) -> String {
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

