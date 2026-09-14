//! The source-map v3 side: a purpose-built JSON reader and the mappings
//! (base64 VLQ) decoder.

/// One source-map segment: wasm file offset -> source line/column.
pub(crate) struct Seg {
    pub(crate) addr: u32,
    pub(crate) file: u32,
    pub(crate) line: u32,
    pub(crate) col: u32,
}

pub(crate) struct SourceMap {
    pub(crate) sources: Vec<String>,
    pub(crate) segments: Vec<Seg>,
}

pub(crate) const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_val(c: u8) -> Option<i64> {
    B64.iter().position(|x| *x == c).map(|p| p as i64)
}

/// Decode one comma-free group of base64 VLQ digits.
pub(crate) fn vlq(s: &str) -> Result<Vec<i64>, String> {
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
pub(crate) fn parse_mappings(mappings: &str, source_count: usize) -> Result<Vec<Seg>, String> {
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

    /// Read 4 hex digits following a consumed `\u` escape.
    fn hex4(&mut self) -> Result<u32, String> {
        let h = self.b.get(self.i..self.i + 4).ok_or("short u-escape")?;
        let h = std::str::from_utf8(h).map_err(|_| "bad u-escape")?;
        let n = u32::from_str_radix(h, 16).map_err(|_| "bad hex")?;
        self.i += 4;
        Ok(n)
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
                        // JSON escapes carry UTF-16 code units: a high
                        // surrogate must be followed by a `\uXXXX` low
                        // surrogate, and together they form one code point.
                        let n = self.hex4()?;
                        let c = if (0xD800..=0xDBFF).contains(&n) {
                            if self.b.get(self.i..self.i + 2) == Some(&b"\\u"[..]) {
                                self.i += 2;
                                let lo = self.hex4()?;
                                if !(0xDC00..=0xDFFF).contains(&lo) {
                                    return Err(format!(
                                        "high surrogate \\u{n:04x} not followed by a low surrogate"
                                    ));
                                }
                                char::from_u32(0x10000 + ((n - 0xD800) << 10) + (lo - 0xDC00))
                                    .expect("surrogate pair combines into a valid scalar")
                            } else {
                                return Err(format!("unpaired high surrogate \\u{n:04x}"));
                            }
                        } else if (0xDC00..=0xDFFF).contains(&n) {
                            return Err(format!("unpaired low surrogate \\u{n:04x}"));
                        } else {
                            char::from_u32(n).expect("non-surrogate code unit is a valid scalar")
                        };
                        out.push(c);
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
pub(crate) fn parse_source_map(json: &str) -> Result<SourceMap, String> {
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

