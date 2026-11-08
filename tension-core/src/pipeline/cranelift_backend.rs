//! The CPU lowering: a record comparator, compiled to machine code.
//!
//! The sort is the one part of a 2D frame that is not per-instance work, so it
//! cannot go in a vertex shader. The graph describes it as data —
//! `make_tuple(sort_key, group_id, z)` into `sort_by` — and this module turns
//! that key list into a native function:
//!
//! ```text
//! extern "C" fn(a: *const u8, b: *const u8) -> u8
//! ```
//!
//! returning 1 when `a` sorts before `b`. Lexicographic over the keys, each
//! compared with the signedness its dtype implies.
//!
//! # Why Cranelift
//!
//! It is already in the tree as Wasmtime's compiler (Apache-2.0 with the LLVM
//! exception), so this adds no dependency and no new licence to §10's list.
//! What it buys over a hand-written match is that the comparator is *emitted*
//! from the graph's key spec rather than switched on it: a guest graph with a
//! different key list gets a different function without this file changing.
//!
//! # The two lowerings must agree
//!
//! `render.cpp` sorts with the same key list, read from a table
//! `scripts/build-2d.mjs` emits. Two implementations of one comparator is a
//! divergence waiting to happen, which is why [`compiled_matches_reference`]
//! checks the compiled function against a plain Rust reference over a wide
//! random sample, and why the integration test compares whole frames.

use super::{DType, GraphError, Result};

/// One key: where it sits in the record and how to read it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Key {
    pub offset: u16,
    pub dtype: DType,
    /// An optional `mul(field, const_f32)` factor, so a graph can sort by a
    /// scaled field. `None` is the common case and costs nothing: the lowering
    /// emits no multiply at all.
    pub scale: Option<f32>,
}

/// The keys, in significance order. First key breaks ties for the second, and
/// so on.
pub type KeySpec = Vec<Key>;

/// A compiled comparator and the memory holding its code.
pub struct NativeComparator {
    code: *mut std::ffi::c_void,
    len: usize,
    keys: KeySpec,
}

// The code page is immutable once `mprotect`ed, and the function it holds
// touches only the two pointers it is handed.
unsafe impl Send for NativeComparator {}
unsafe impl Sync for NativeComparator {}

impl NativeComparator {
    /// The comparator as a callable function.
    ///
    /// # Safety
    ///
    /// Both pointers must address at least `max(offset + width)` readable bytes
    /// for every key.
    pub unsafe fn compare(&self, a: *const u8, b: *const u8) -> bool {
        let f: extern "C" fn(*const u8, *const u8) -> u8 = std::mem::transmute(self.code);
        f(a, b) != 0
    }

    pub fn keys(&self) -> &[Key] {
        &self.keys
    }

    pub fn code_len(&self) -> usize {
        self.len
    }

    /// Sort a byte-slice of records in place, given the stride.
    ///
    /// A stable sort, because two records with equal keys should keep the order
    /// the guest submitted them in — the same guarantee `render.cpp` makes.
    pub fn sort_records(&self, records: &mut [u8], stride: usize) {
        let count = records.len() / stride;
        let base = records.as_mut_ptr();
        let mut order: Vec<usize> = (0..count).collect();
        let keys = &self.keys;
        order.sort_by(|&i, &j| {
            // SAFETY: `i` and `j` are in `0..count`, and `count * stride` bytes
            // are live, so every record start is a valid pointer.
            let a = unsafe { base.add(i * stride) };
            let b = unsafe { base.add(j * stride) };
            let _ = keys;
            if unsafe { self.compare(a, b) } {
                std::cmp::Ordering::Less
            } else if unsafe { self.compare(b, a) } {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        });

        // Apply the permutation through a scratch copy.
        let original = records.to_vec();
        for (dest, src) in order.iter().enumerate() {
            records[dest * stride..(dest + 1) * stride]
                .copy_from_slice(&original[src * stride..(src + 1) * stride]);
        }
    }
}

impl Drop for NativeComparator {
    fn drop(&mut self) {
        if !self.code.is_null() && self.len > 0 {
            // SAFETY: the page came from `mmap` with this exact length, and
            // `code` is null-checked.
            #[cfg(unix)]
            unsafe {
                libc::munmap(self.code, self.len);
            }
            // SAFETY: the page came from `VirtualAlloc` and is released whole
            // (`dwSize` must be 0 with `MEM_RELEASE`).
            #[cfg(windows)]
            unsafe {
                windows_mem::VirtualFree(self.code, 0, windows_mem::MEM_RELEASE);
            }
            self.code = std::ptr::null_mut();
        }
    }
}

/// Compile a key list into a native comparator.
pub fn compile(keys: &KeySpec) -> Result<NativeComparator> {
    if keys.is_empty() {
        return Err(GraphError::Invalid(
            "a comparator needs at least one key".to_string(),
        ));
    }
    let code = emit_code(keys)?;
    let comparator = map_executable(&code)?;
    Ok(NativeComparator {
        code: comparator.0,
        len: comparator.1,
        keys: keys.to_vec(),
    })
}

/// The machine code for one key list.
///
/// Straight-line lexicographic chain: one block per key that branches to the
/// `less` exit, falls through to the next key, or (on the last key) reaches
/// `not_less`. Two exits, both returning a constant, so the function has no
/// stack frame and no other state.
fn emit_code(keys: &KeySpec) -> Result<Vec<u8>> {
    use cranelift_codegen::ir::condcodes::IntCC;
    use cranelift_codegen::ir::types;
    use cranelift_codegen::ir::{AbiParam, Function, InstBuilder, MemFlags, Signature, UserFuncName};
    use cranelift_codegen::settings::Configurable;
    use cranelift_codegen::{settings, Context};
    use cranelift_frontend::{FunctionBuilder, FunctionBuilderContext};

    let isa_builder = cranelift_native::builder()
        .map_err(|e| GraphError::Unsupported(format!("cranelift: no native ISA: {e}")))?;
    let mut flag_builder = settings::builder();
    flag_builder
        .set("opt_level", "speed")
        .map_err(|e| GraphError::Unsupported(format!("cranelift: setting opt_level: {e}")))?;
    let isa = isa_builder
        .finish(settings::Flags::new(flag_builder))
        .map_err(|e| GraphError::Unsupported(format!("cranelift: ISA: {e}")))?;

    let mut signature = Signature::new(isa.default_call_conv());
    signature.params.push(AbiParam::new(types::I64)); // a
    signature.params.push(AbiParam::new(types::I64)); // b
    signature.returns.push(AbiParam::new(types::I8));

    let mut func = Function::with_name_signature(UserFuncName::user(0, 1), signature);
    let mut func_ctx = FunctionBuilderContext::new();
    {
        let mut builder = FunctionBuilder::new(&mut func, &mut func_ctx);
        let entry = builder.create_block();
        let less = builder.create_block();
        let not_less = builder.create_block();

        builder.append_block_params_for_function_params(entry);
        builder.switch_to_block(entry);

        let a = builder.block_params(entry)[0];
        let b = builder.block_params(entry)[1];

        let mut current = entry;
        for key in keys {
            let next = builder.create_block();
            builder.switch_to_block(current);

            let ty = match key.dtype {
                DType::F32 | DType::I32 | DType::U32 => types::I32,
                DType::U16 | DType::I16 => types::I16,
                DType::U8 => types::I8,
            };
            let offset = i32::from(key.offset);
            let mut left = builder.ins().load(ty, MemFlags::new(), a, offset);
            let mut right = builder.ins().load(ty, MemFlags::new(), b, offset);

            // A scaled key: the graph asked for `mul(field, const)`, so both
            // sides are reinterpreted as f32 and multiplied before comparing.
            // Reinterpreting rather than converting is deliberate — the record
            // is bytes, and `f32` is the dtype the graph declared.
            if let Some(factor) = key.scale {
                // The load is an i32 (the record is bytes, and the integer type
                // is what `load` produces); the arithmetic is on floats, so
                // reinterpret rather than convert — the bits are already an
                // f32's.
                let lf = builder.ins().bitcast(types::F32, MemFlags::new(), left);
                let rf = builder.ins().bitcast(types::F32, MemFlags::new(), right);
                let k = builder.ins().f32const(factor);
                left = builder.ins().fmul(lf, k);
                right = builder.ins().fmul(rf, k);
            }

            // Three-way, not two. Falling through on `a > b` as well as on
            // `a == b` is the classic lexicographic bug: the chain would then
            // compare later keys that must not be consulted, and the sort goes
            // quietly wrong on ties in an early key.
            // A scaled key compared as f32 uses FloatCC, not IntCC: the values
            // coming out of `fmul` are floats, and `icmp` on them would compare
            // bit patterns.
            let (lt, gt) = if key.scale.is_some() {
                use cranelift_codegen::ir::condcodes::FloatCC;
                (
                    builder.ins().fcmp(FloatCC::LessThan, left, right),
                    builder.ins().fcmp(FloatCC::GreaterThan, left, right),
                )
            } else if key.dtype.signed() {
                (
                    builder.ins().icmp(IntCC::SignedLessThan, left, right),
                    builder.ins().icmp(IntCC::SignedGreaterThan, left, right),
                )
            } else {
                (
                    builder.ins().icmp(IntCC::UnsignedLessThan, left, right),
                    builder.ins().icmp(IntCC::UnsignedGreaterThan, left, right),
                )
            };
            builder.ins().brif(lt, less, &[], next, &[]);
            builder.switch_to_block(next);
            let after = builder.create_block();
            builder.ins().brif(gt, not_less, &[], after, &[]);
            current = after;
        }

        // Every key tied: "a is not before b".
        builder.switch_to_block(current);
        builder.ins().jump(not_less, &[]);

        builder.switch_to_block(less);
        let one = builder.ins().iconst(types::I8, 1);
        builder.ins().return_(&[one]);

        builder.switch_to_block(not_less);
        let zero = builder.ins().iconst(types::I8, 0);
        builder.ins().return_(&[zero]);

        builder.seal_all_blocks();
        builder.finalize();
    }

    let mut ctx = Context::new();
    ctx.func = func;
    let mut ctrl_plane = cranelift_codegen::control::ControlPlane::default();
    ctx.compile(&*isa, &mut ctrl_plane)
        .map_err(|e| GraphError::Unsupported(format!("cranelift: compile: {e:?}")))?;
    let compiled = ctx
        .compiled_code()
        .ok_or_else(|| GraphError::Unsupported("cranelift: no code emitted".to_string()))?;
    Ok(compiled.code_buffer().to_vec())
}

#[cfg(windows)]
mod windows_mem {
    use std::ffi::c_void;

    pub const MEM_COMMIT: u32 = 0x0000_1000;
    pub const MEM_RESERVE: u32 = 0x0000_2000;
    pub const MEM_RELEASE: u32 = 0x0000_8000;
    pub const PAGE_READWRITE: u32 = 0x04;
    pub const PAGE_EXECUTE_READ: u32 = 0x20;

    extern "system" {
        pub fn GetCurrentProcess() -> *mut c_void;

        #[allow(non_snake_case)]
        pub fn FlushInstructionCache(
            hProcess: *mut c_void,
            lpBaseAddress: *const c_void,
            dwSize: usize,
        ) -> i32;

        pub fn VirtualAlloc(
            lpAddress: *mut c_void,
            dwSize: usize,
            flAllocationType: u32,
            flProtect: u32,
        ) -> *mut c_void;

        pub fn VirtualProtect(
            lpAddress: *mut c_void,
            dwSize: usize,
            flNewProtect: u32,
            lpflOldProtect: *mut u32,
        ) -> i32;

        pub fn VirtualFree(
            lpAddress: *mut c_void,
            dwSize: usize,
            dwFreeType: u32,
        ) -> i32;
    }
}

// The comparator is called through `extern "C" fn(*const u8, *const u8) -> u8`
// (see `NativeComparator::compare`), so the code must be emitted with that
// same convention. `isa.default_call_conv()` supplies it — but only where
// `extern "C"` *is* the target's default. On Windows that holds for x86-64
// (both are Win64) and fails for 32-bit x86, where `extern "C"` is cdecl and
// the default is fastcall: the callee would read its arguments from the wrong
// registers and the sort would misbehave as memory errors rather than a build
// failure. Refusing to compile is the honest outcome.
#[cfg(all(windows, not(target_arch = "x86_64")))]
compile_error!(
    "the comparator JIT assumes extern \"C\" == the target's default calling \
     convention, which holds on x86-64 Windows only. Teach `emit_code` the \
     explicit convention for this target before building it."
);

/// Map `code` into an executable page and return `(pointer, length)`.
#[cfg(unix)]
fn map_executable(code: &[u8]) -> Result<(*mut std::ffi::c_void, usize)> {
    let len = code.len().max(1);
    // SAFETY: a fresh anonymous mapping. The length is rounded up to a page by
    // the kernel, and `munmap` takes the same length.
    let page = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            len,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
            -1,
            0,
        )
    };
    if page == libc::MAP_FAILED {
        return Err(GraphError::Unsupported("mmap failed".to_string()));
    }
    // SAFETY: `page` is a live mapping of at least `len` bytes and `code` is
    // that long.
    unsafe {
        std::ptr::copy_nonoverlapping(code.as_ptr(), page as *mut u8, code.len());
    }
    // W^X: make it executable and drop write permission.
    let rc = unsafe { libc::mprotect(page, len, libc::PROT_READ | libc::PROT_EXEC) };
    if rc != 0 {
        unsafe {
            libc::munmap(page, len);
        }
        return Err(GraphError::Unsupported("mprotect failed".to_string()));
    }
    Ok((page, len))
}

#[cfg(windows)]
fn map_executable(code: &[u8]) -> Result<(*mut std::ffi::c_void, usize)> {
    let len = code.len().max(1);
    let page = unsafe {
        windows_mem::VirtualAlloc(
            std::ptr::null_mut(),
            len,
            windows_mem::MEM_COMMIT | windows_mem::MEM_RESERVE,
            windows_mem::PAGE_READWRITE,
        )
    };
    if page.is_null() {
        return Err(GraphError::Unsupported("VirtualAlloc failed".to_string()));
    }
    unsafe {
        std::ptr::copy_nonoverlapping(code.as_ptr(), page as *mut u8, code.len());
    }
    let mut old_protect = 0u32;
    let rc = unsafe {
        windows_mem::VirtualProtect(
            page,
            len,
            windows_mem::PAGE_EXECUTE_READ,
            &mut old_protect,
        )
    };
    if rc == 0 {
        unsafe {
            windows_mem::VirtualFree(page, 0, windows_mem::MEM_RELEASE);
        }
        return Err(GraphError::Unsupported("VirtualProtect failed".to_string()));
    }
    // Writing code and changing its protection does not, on its own, make the
    // bytes visible to the instruction fetcher: MSDN requires this call on
    // every architecture. It is a no-op on x86-64, which is why its absence
    // would not show up on the machine this was first built on — and it is not
    // a no-op on ARM64, where stale bytes execute as garbage. The return value
    // is documented as always succeeding; a failure here means the page is not
    // executable, so treat it as one.
    let flushed = unsafe {
        windows_mem::FlushInstructionCache(
            windows_mem::GetCurrentProcess(),
            page as *const std::ffi::c_void,
            len,
        )
    };
    if flushed == 0 {
        unsafe {
            windows_mem::VirtualFree(page, 0, windows_mem::MEM_RELEASE);
        }
        return Err(GraphError::Unsupported(
            "FlushInstructionCache failed".to_string(),
        ));
    }
    Ok((page, len))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::parser::parse;
    use crate::pipeline_default::serialize_default_2d;

    /// The keys `default_2d`'s `make_tuple(sort_key, group_id, z)` names.
    fn default_keys() -> KeySpec {
        vec![
            Key { offset: 20, dtype: DType::U32, scale: None },
            Key { offset: 24, dtype: DType::U16, scale: None },
            Key { offset: 26, dtype: DType::U8, scale: None },
        ]
    }

    fn record(sort_key: u32, group_id: u16, z: u8) -> [u8; 28] {
        let mut r = [0u8; 28];
        r[20..24].copy_from_slice(&sort_key.to_le_bytes());
        r[24..26].copy_from_slice(&group_id.to_le_bytes());
        r[26] = z;
        r
    }

    fn reference(a: &[u8; 28], b: &[u8; 28], keys: &KeySpec) -> std::cmp::Ordering {
        for key in keys {
            let width = usize::from(key.dtype.width());
            let start = usize::from(key.offset);
            let left = &a[start..start + width];
            let right = &b[start..start + width];
            let ord = match key.dtype {
                DType::U8 => left[0].cmp(&right[0]),
                DType::U16 => u16::from_le_bytes([left[0], left[1]])
                    .cmp(&u16::from_le_bytes([right[0], right[1]])),
                DType::I16 => i16::from_le_bytes([left[0], left[1]])
                    .cmp(&i16::from_le_bytes([right[0], right[1]])),
                DType::U32 => u32::from_le_bytes([left[0], left[1], left[2], left[3]])
                    .cmp(&u32::from_le_bytes([right[0], right[1], right[2], right[3]])),
                DType::I32 => i32::from_le_bytes([left[0], left[1], left[2], left[3]])
                    .cmp(&i32::from_le_bytes([right[0], right[1], right[2], right[3]])),
                DType::F32 => {
                    let l = f32::from_le_bytes([left[0], left[1], left[2], left[3]]);
                    let r = f32::from_le_bytes([right[0], right[1], right[2], right[3]]);
                    l.partial_cmp(&r).unwrap_or(std::cmp::Ordering::Equal)
                }
            };
            if ord != std::cmp::Ordering::Equal {
                return ord;
            }
        }
        std::cmp::Ordering::Equal
    }

    #[test]
    fn the_comparator_orders_by_the_triple() {
        let comparator = compile(&default_keys()).expect("compile");
        let mut records: Vec<[u8; 28]> = vec![
            record(5, 0, 0),
            record(1, 2, 0),
            record(1, 1, 3),
            record(1, 1, 1),
            record(0, 9, 9),
        ];
        let mut flat: Vec<u8> = records.iter().flatten().copied().collect();
        comparator.sort_records(&mut flat, 28);

        for (i, chunk) in flat.chunks(28).enumerate() {
            records[i].copy_from_slice(chunk);
        }
        let order: Vec<(u32, u16, u8)> = records
            .iter()
            .map(|r| {
                (
                    u32::from_le_bytes([r[20], r[21], r[22], r[23]]),
                    u16::from_le_bytes([r[24], r[25]]),
                    r[26],
                )
            })
            .collect();
        assert_eq!(order, vec![(0, 9, 9), (1, 1, 1), (1, 1, 3), (1, 2, 0), (5, 0, 0)]);
    }

    /// The compiled function must agree with the plain-Rust reference on every
    /// pair in a sample wide enough to hit ties in each key position.
    #[test]
    fn compiled_matches_reference() {
        let keys = default_keys();
        let comparator = compile(&keys).expect("compile");

        let mut sample: Vec<[u8; 28]> = Vec::new();
        for sort_key in [0u32, 1, 2, 7, u32::MAX] {
            for group_id in [0u16, 1, 3] {
                for z in [0u8, 1, 255] {
                    sample.push(record(sort_key, group_id, z));
                }
            }
        }

        for a in &sample {
            for b in &sample {
                let want = reference(a, b, &keys);
                // SAFETY: both point at 28-byte records, and the largest key
                // offset plus width is 28.
                let got = unsafe {
                    if comparator.compare(a.as_ptr(), b.as_ptr()) {
                        std::cmp::Ordering::Less
                    } else if comparator.compare(b.as_ptr(), a.as_ptr()) {
                        std::cmp::Ordering::Greater
                    } else {
                        std::cmp::Ordering::Equal
                    }
                };
                assert_eq!(got, want, "a={a:?} b={b:?}");
            }
        }
    }

    #[test]
    fn a_signed_key_is_compared_signed() {
        let keys = vec![Key { offset: 0, dtype: DType::I32, scale: None }];
        let comparator = compile(&keys).expect("compile");
        let mut lower = [0u8; 4];
        lower.copy_from_slice(&(-5i32).to_le_bytes());
        let mut higher = [0u8; 4];
        higher.copy_from_slice(&(3i32).to_le_bytes());
        // -5 sorts before 3 only if the compare is signed.
        assert!(unsafe { comparator.compare(lower.as_ptr(), higher.as_ptr()) });
        assert!(!unsafe { comparator.compare(higher.as_ptr(), lower.as_ptr()) });
    }

    /// A `mul` key: the graph asks for `sort by 2*f`. Negative factors invert
    /// the order, which is the cheapest way to prove the multiply actually ran
    /// rather than being parsed and dropped.
    #[test]
    fn a_scaled_key_multiplies_before_comparing() {
        let keys = vec![Key { offset: 0, dtype: DType::F32, scale: Some(2.0) }];
        let comparator = compile(&keys).expect("compile");

        let mut one = [0u8; 4];
        one.copy_from_slice(&1.0f32.to_le_bytes());
        let mut two = [0u8; 4];
        two.copy_from_slice(&2.0f32.to_le_bytes());
        // 2*1 < 2*2, so `one` sorts first under a positive factor.
        assert!(unsafe { comparator.compare(one.as_ptr(), two.as_ptr()) });

        let inverted = vec![Key { offset: 0, dtype: DType::F32, scale: Some(-1.0) }];
        let comparator = compile(&inverted).expect("compile");
        // -1 < -2, so the order flips. A dropped multiply would not flip it.
        assert!(!unsafe { comparator.compare(one.as_ptr(), two.as_ptr()) });
    }

    #[test]
    fn an_empty_key_list_is_refused() {
        assert!(matches!(compile(&vec![]), Err(GraphError::Invalid(_))));
    }

    #[test]
    fn the_default_graphs_key_list_is_the_one_this_module_tests() {
        // Guard against the graph and this test drifting apart: both name the
        // same three fields in the same order.
        let graph = parse(&serialize_default_2d()).expect("parse");
        let stage = &graph.stages[0];
        let tuple = stage.nodes.iter().find(|n| n.op == "make_tuple").unwrap();
        assert_eq!(tuple.inputs, vec![7, 8, 9]);

        let record = &graph.records[0];
        let offsets: Vec<u16> = tuple
            .inputs
            .iter()
            .map(|id| {
                let node = stage.nodes.iter().find(|n| n.id == *id).unwrap();
                record.fields[usize::from(node.args[0])].offset
            })
            .collect();
        assert_eq!(offsets, vec![20, 24, 26]);
    }
}
