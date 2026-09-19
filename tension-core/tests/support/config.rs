//! Test-side builder for the solver's configuration struct.
//!
//! `tension_solver_create` takes a `tension_solver_config` — the struct
//! declared in tension-solver/include/tension_solver.h, which the host fills
//! from the §12 wire — so the integration tests build one from Rust values
//! here and take no part in the wire layout at all. The builder owns the
//! `CString`s its pointers borrow: a built config is valid for the duration
//! of the call and no longer.
//!
//! Nothing here parses text. A test that wants a *malformed* config says so
//! structurally: `Config::new("euler", "wasm").method_none()` is a struct
//! with a NULL method pointer, `.method_empty()` one with `method_len == 0`,
//! `.bits(1 << 20)` one with a reserved bitmap bit set.
//!
//! `SolverConfigFfi` mirrors the header field for field; a drift between the
//! two is a compile-time-visible one only if the field *order* changes, so
//! the P2 cross-check test (T20) also asserts the struct's size.

#![allow(dead_code)]

use std::ffi::{c_char, CString};

extern "C" {
    pub fn tension_solver_create(config: *const SolverConfigFfi) -> i32;
}

/// The header's `tension_solver_config`, field for field.
#[repr(C)]
pub struct SolverConfigFfi {
    pub method: *const c_char,
    pub method_len: u32,
    pub source: *const c_char,
    pub source_len: u32,
    pub description: *const c_char,
    pub description_len: u32,
    pub dim: u32,
    pub parameters_bitmap: u32,
    pub rel_tol: f64,
    pub abs_tol: f64,
    pub min_step: f64,
    pub max_step: f64,
    pub fixed_step: f64,
    pub iterations: u32,
    pub convergence_tol: f64,
    pub compliance: f64,
    pub relaxation: f64,
}

/// The bitmap bit of each parameter, in schema declaration order.
pub const P_RELTOL: u32 = 1 << 0;
pub const P_ABSTOL: u32 = 1 << 1;
pub const P_MINSTEP: u32 = 1 << 2;
pub const P_MAXSTEP: u32 = 1 << 3;
pub const P_FIXEDSTEP: u32 = 1 << 4;
pub const P_ITERATIONS: u32 = 1 << 5;
pub const P_CONVERGENCETOL: u32 = 1 << 6;
pub const P_COMPLIANCE: u32 = 1 << 7;
pub const P_RELAXATION: u32 = 1 << 8;

/// A `tension_solver_config` under construction.
pub struct Config {
    method: Option<CString>,
    /// `true` keeps the pointer but forces `method_len` to 0.
    method_zero_len: bool,
    source: Option<CString>,
    source_zero_len: bool,
    description: Option<CString>,
    dim: u32,
    /// Extra bits, for the tests that set a bit without a value (the reserved
    /// bits, or a parameter the method does not read).
    bits: u32,
    params: [f64; 9],
    iterations: u32,
}

impl Config {
    /// The common case: a method and a source, nothing else stated.
    pub fn new(method: &str, source: &str) -> Self {
        Self {
            method: Some(CString::new(method).unwrap()),
            method_zero_len: false,
            source: Some(CString::new(source).unwrap()),
            source_zero_len: false,
            description: None,
            dim: 0,
            bits: 0,
            params: [0.0; 9],
            iterations: 0,
        }
    }

    /// As `new`, from a name that may be any string (the tests use this for
    /// unknown-method and unknown-source cases).
    pub fn named(method: &str, source: &str) -> Self {
        Self::new(method, source)
    }

    pub fn dim(mut self, dim: u32) -> Self {
        self.dim = dim;
        self
    }

    pub fn description(mut self, text: &str) -> Self {
        self.description = Some(CString::new(text).unwrap());
        self
    }

    /// A NULL `method` pointer (`method_len` stays 0).
    pub fn method_none(mut self) -> Self {
        self.method = None;
        self
    }

    /// A non-NULL `method` pointer with `method_len == 0`.
    pub fn method_empty(mut self) -> Self {
        self.method = Some(CString::new("").unwrap());
        self.method_zero_len = true;
        self
    }

    /// A NULL `source` pointer.
    pub fn source_none(mut self) -> Self {
        self.source = None;
        self
    }

    /// A non-NULL `source` pointer with `source_len == 0`.
    pub fn source_empty(mut self) -> Self {
        self.source = Some(CString::new("").unwrap());
        self.source_zero_len = true;
        self
    }

    /// Set bitmap bits directly, without values (reserved bits, or a
    /// parameter whose value stays 0.0).
    pub fn bits(mut self, bits: u32) -> Self {
        self.bits |= bits;
        self
    }

    /// State one f64 parameter: its bit, and its value at the schema's
    /// declaration index.
    fn f64_param(mut self, bit: u32, index: usize, value: f64) -> Self {
        self.bits |= bit;
        self.params[index] = value;
        self
    }

    pub fn rel_tol(self, v: f64) -> Self {
        self.f64_param(P_RELTOL, 0, v)
    }
    pub fn abs_tol(self, v: f64) -> Self {
        self.f64_param(P_ABSTOL, 1, v)
    }
    pub fn min_step(self, v: f64) -> Self {
        self.f64_param(P_MINSTEP, 2, v)
    }
    pub fn max_step(self, v: f64) -> Self {
        self.f64_param(P_MAXSTEP, 3, v)
    }
    pub fn fixed_step(self, v: f64) -> Self {
        self.f64_param(P_FIXEDSTEP, 4, v)
    }
    pub fn convergence_tol(self, v: f64) -> Self {
        self.f64_param(P_CONVERGENCETOL, 6, v)
    }
    pub fn compliance(self, v: f64) -> Self {
        self.f64_param(P_COMPLIANCE, 7, v)
    }
    pub fn relaxation(self, v: f64) -> Self {
        self.f64_param(P_RELAXATION, 8, v)
    }

    /// A stated count. The struct's field is u32; a negative `n` is stored as
    /// its two's-complement bits, exactly as a guest's cast would, so the
    /// out-of-range check is exercised rather than papered over.
    pub fn iterations(mut self, n: i32) -> Self {
        self.bits |= P_ITERATIONS;
        self.iterations = n as u32;
        self
    }

    /// The C-layout struct, borrowing this config's strings. Valid while
    /// `self` is alive.
    pub fn ffi(&self) -> SolverConfigFfi {
        let (method, method_len) = match &self.method {
            Some(text) if !self.method_zero_len => (text.as_ptr(), text.as_bytes().len() as u32),
            Some(text) => (text.as_ptr(), 0),
            None => (std::ptr::null(), 0),
        };
        let (source, source_len) = match &self.source {
            Some(text) if !self.source_zero_len => (text.as_ptr(), text.as_bytes().len() as u32),
            Some(text) => (text.as_ptr(), 0),
            None => (std::ptr::null(), 0),
        };
        let (description, description_len) = match &self.description {
            Some(text) => (text.as_ptr(), text.as_bytes().len() as u32),
            None => (std::ptr::null(), 0),
        };
        SolverConfigFfi {
            method,
            method_len,
            source,
            source_len,
            description,
            description_len,
            dim: self.dim,
            parameters_bitmap: self.bits,
            rel_tol: self.params[0],
            abs_tol: self.params[1],
            min_step: self.params[2],
            max_step: self.params[3],
            fixed_step: self.params[4],
            iterations: self.iterations,
            convergence_tol: self.params[6],
            compliance: self.params[7],
            relaxation: self.params[8],
        }
    }

    /// Build and call `tension_solver_create`.
    pub fn create(&self) -> i32 {
        unsafe { tension_solver_create(&self.ffi()) }
    }
}
