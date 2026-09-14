//! The DWARF 4 encoder: abbreviations, the line program, `.debug_info`
//! DIEs, and the custom-section wrapper.

use std::path::Path;

use crate::leb::{write_sleb, write_uleb};

use super::source_map::Seg;
use super::wasm::ValType;

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
    write_uleb(out, name);
    write_uleb(out, form);
}

/// Abbrev 1: compile unit. Abbrev 2: subprogram. Abbrev 3: subprogram with
/// children. Abbrev 4: base type. Abbrev 5: variable. No `strp`, so no
/// `.debug_str`; type references are `DW_FORM_ref4` within the unit.
pub(crate) fn append_abbrev() -> Vec<u8> {
    let mut a = Vec::new();
    write_uleb(&mut a, 1);
    write_uleb(&mut a, DW_TAG_COMPILE_UNIT);
    write_uleb(&mut a, 1); // has children
    attr(&mut a, DW_AT_NAME, DW_FORM_STRING);
    attr(&mut a, DW_AT_COMP_DIR, DW_FORM_STRING);
    attr(&mut a, DW_AT_STMT_LIST, DW_FORM_SEC_OFFSET);
    // The unit's own extent must be a range list: wasmtime's transform rewrites
    // `DW_AT_ranges` entries to native addresses, but leaves a unit's
    // `DW_AT_low_pc`/`DW_AT_high_pc` untouched - a unit stuck at wasm address 0
    // covers no JIT code, and a debugger cannot map a line-table address back
    // to it.
    attr(&mut a, DW_AT_RANGES, DW_FORM_SEC_OFFSET);
    write_uleb(&mut a, 0);
    write_uleb(&mut a, 0);

    write_uleb(&mut a, 2);
    write_uleb(&mut a, DW_TAG_SUBPROGRAM);
    write_uleb(&mut a, 0); // no children
    attr(&mut a, DW_AT_NAME, DW_FORM_STRING);
    attr(&mut a, DW_AT_LOW_PC, DW_FORM_ADDR);
    attr(&mut a, DW_AT_HIGH_PC, DW_FORM_ADDR);
    attr(&mut a, DW_AT_EXTERNAL, DW_FORM_FLAG_PRESENT);
    write_uleb(&mut a, 0);
    write_uleb(&mut a, 0);

    // Same subprogram, but with children: the local variable DIEs hang off it.
    write_uleb(&mut a, 3);
    write_uleb(&mut a, DW_TAG_SUBPROGRAM);
    write_uleb(&mut a, 1); // has children
    attr(&mut a, DW_AT_NAME, DW_FORM_STRING);
    attr(&mut a, DW_AT_LOW_PC, DW_FORM_ADDR);
    attr(&mut a, DW_AT_HIGH_PC, DW_FORM_ADDR);
    attr(&mut a, DW_AT_EXTERNAL, DW_FORM_FLAG_PRESENT);
    write_uleb(&mut a, 0);
    write_uleb(&mut a, 0);

    write_uleb(&mut a, 4);
    write_uleb(&mut a, DW_TAG_BASE_TYPE);
    write_uleb(&mut a, 0); // no children
    attr(&mut a, DW_AT_NAME, DW_FORM_STRING);
    attr(&mut a, DW_AT_ENCODING, DW_FORM_DATA1);
    attr(&mut a, DW_AT_BYTE_SIZE, DW_FORM_DATA1);
    write_uleb(&mut a, 0);
    write_uleb(&mut a, 0);

    write_uleb(&mut a, 5);
    write_uleb(&mut a, DW_TAG_VARIABLE);
    write_uleb(&mut a, 0); // no children
    attr(&mut a, DW_AT_NAME, DW_FORM_STRING);
    attr(&mut a, DW_AT_TYPE, DW_FORM_REF4);
    attr(&mut a, DW_AT_LOCATION, DW_FORM_EXPRLOC);
    write_uleb(&mut a, 0);
    write_uleb(&mut a, 0);
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
pub(crate) fn append_line(comp_dir: &str, sources: &[String], rows: &[Seg], ranges: &[(u32, u32)]) -> Vec<u8> {
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
        write_uleb(&mut prologue, 1); // directory index
        write_uleb(&mut prologue, 0); // mtime
        write_uleb(&mut prologue, 0); // length
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
                write_uleb(&mut prog, (r.addr - pc) as u64);
                pc = r.addr;
            }
            if r.file + 1 != file {
                prog.push(4); // DW_LNS_set_file
                write_uleb(&mut prog, (r.file + 1) as u64);
                file = r.file + 1;
            }
            if r.line != line {
                prog.push(3); // DW_LNS_advance_line
                write_sleb(&mut prog, r.line as i64 - line as i64);
                line = r.line;
            }
            if r.col != col {
                prog.push(5); // DW_LNS_set_column
                write_uleb(&mut prog, r.col as u64);
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
pub(crate) fn append_info(
    module_name: &str,
    comp_dir: &str,
    functions: &[(String, u32, u32)],
    locals: &[Vec<(String, u32, ValType)>],
) -> Vec<u8> {
    let mut cu = Vec::new();
    write_uleb(&mut cu, 1); // abbrev 1: compile unit
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
        write_uleb(&mut die, 4); // abbrev 4: base type
        cstr(&mut die, ty.name());
        die.push(ty.encoding());
        die.push(ty.byte_size());
        offset += die.len();
        children.extend_from_slice(&die);
    }

    for ((name, lo, hi), vars) in functions.iter().zip(locals) {
        if vars.is_empty() {
            write_uleb(&mut children, 2); // abbrev 2: subprogram, no children
            cstr(&mut children, name);
            children.extend_from_slice(&lo.to_le_bytes());
            children.extend_from_slice(&hi.to_le_bytes());
        } else {
            write_uleb(&mut children, 3); // abbrev 3: subprogram with children
            cstr(&mut children, name);
            children.extend_from_slice(&lo.to_le_bytes());
            children.extend_from_slice(&hi.to_le_bytes());
            for (var_name, index, ty) in vars {
                // `DW_OP_WASM_location 0x00 <local index> DW_OP_stack_value`:
                // the value of wasm local `index`, wherever cranelift holds it.
                let mut expr = vec![DW_OP_WASM_LOCATION, 0x00];
                write_uleb(&mut expr, *index as u64);
                expr.push(DW_OP_STACK_VALUE);

                write_uleb(&mut children, 5); // abbrev 5: variable
                cstr(&mut children, var_name);
                children.extend_from_slice(&(type_offsets[type_index(*ty)] as u32).to_le_bytes());
                write_uleb(&mut children, expr.len() as u64);
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

pub(crate) fn append_custom(out: &mut Vec<u8>, name: &str, payload: &[u8]) {
    // A wasm custom section is: id, size, name length, name, payload - where
    // `size` counts everything after itself.
    let mut sec = Vec::new();
    write_uleb(&mut sec, name.len() as u64);
    sec.extend_from_slice(name.as_bytes());
    sec.extend_from_slice(payload);
    out.push(0); // custom section id
    write_uleb(out, sec.len() as u64);
    out.extend_from_slice(&sec);
}

