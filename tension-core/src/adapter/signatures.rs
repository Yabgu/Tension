//! The closed value-type set and the signature rules an adapter's imports must
//! satisfy (`tension-core/include/tension_adapter.h` A.2, A.3).
//!
//! Pure Rust: there is no wasmtime here. The wasm-facing mapping is expressed on
//! a neutral [`Slot`], and `ffi` is the only module that turns a `Slot` into a
//! `wasmtime::Val` — so the rules are testable without a store, and there is
//! exactly one place where the two representations meet.
//!
//! # The mapping
//!
//! - `ValueType::I32` ↔ `Slot::I32(i32)` ↔ `Val::I32` ↔ `ValType::I32`
//! - `ValueType::I64` ↔ `Slot::I64(i64)` ↔ `Val::I64` ↔ `ValType::I64`
//! - `ValueType::F32` ↔ `Slot::F32(u32)` ↔ `Val::F32` ↔ `ValType::F32`
//! - `ValueType::F64` ↔ `Slot::F64(u64)` ↔ `Val::F64` ↔ `ValType::F64`
//! - `ValueType::Void` is a *return* type only, and maps to no wasm value at all
//!
//! The float slots carry **bit patterns**, not floats: that is what the wasm ABI
//! and `wasmtime::Val` both use, and keeping bits in the neutral form means the
//! round trip cannot quietly canonicalise a NaN or lose a payload.

/// One value type that may cross the adapter boundary. Mirrors
/// `tension_value_type`; the discriminants are the ABI's and are not free to
/// change.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum ValueType {
    /// A return with no value. Never a parameter.
    Void = 0,
    I32 = 1,
    I64 = 2,
    F32 = 3,
    F64 = 4,
}

/// The most parameters one import may take (`TENSION_ADAPTER_MAX_PARAMS`).
pub const MAX_PARAMS: usize = 8;

/// The wasm encodings this boundary excludes, for the error message. They are
/// the wasm binary's values, not ours: a capability author who reaches for a
/// vector or a reference type gets told which one it was.
const EXCLUDED: [(u32, &str); 3] = [(0x7B, "v128"), (0x70, "funcref"), (0x6F, "externref")];

/// Why a signature was refused.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum SignatureError {
    /// A type byte that is not in the closed set (and not one of [`EXCLUDED`]).
    UnknownValueType { raw: u32 },
    /// One of the excluded wasm encodings.
    ExcludedValueType { raw: u32, name: &'static str },
    /// More parameters than [`MAX_PARAMS`].
    TooManyParameters { count: usize, max: usize },
    /// `Void` in the parameter list.
    VoidParameter { index: usize },
}

impl std::fmt::Display for SignatureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SignatureError::UnknownValueType { raw } => write!(
                f,
                "value type {raw} is not in the closed set (0 void, 1 i32, 2 i64, 3 f32, 4 f64)"
            ),
            SignatureError::ExcludedValueType { raw, name } => write!(
                f,
                "value type {raw:#x} is `{name}`, which this boundary does not carry"
            ),
            SignatureError::TooManyParameters { count, max } => write!(
                f,
                "{count} parameters exceeds the boundary's limit of {max}"
            ),
            SignatureError::VoidParameter { index } => write!(
                f,
                "parameter {index} is `void`, which is only valid as a return type"
            ),
        }
    }
}

impl std::error::Error for SignatureError {}

/// A validated import signature: a return type and at most [`MAX_PARAMS`]
/// parameter types.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Signature {
    ret: ValueType,
    params: [ValueType; MAX_PARAMS],
    nparams: usize,
}

impl Signature {
    /// Validate the raw ABI form: `ret_type` and the `param_types` array an
    /// adapter passed to `register_import`.
    pub fn new(ret_type: u32, param_types: &[u32]) -> Result<Signature, SignatureError> {
        if param_types.len() > MAX_PARAMS {
            return Err(SignatureError::TooManyParameters {
                count: param_types.len(),
                max: MAX_PARAMS,
            });
        }
        let mut params = [ValueType::Void; MAX_PARAMS];
        for (index, raw) in param_types.iter().enumerate() {
            let value_type = decode(*raw)?;
            if value_type == ValueType::Void {
                return Err(SignatureError::VoidParameter { index });
            }
            params[index] = value_type;
        }
        Ok(Signature {
            ret: decode(ret_type)?,
            params,
            nparams: param_types.len(),
        })
    }

    /// The return type (`Void` for an import that returns nothing).
    pub fn ret(&self) -> ValueType {
        self.ret
    }

    /// The declared parameter types, in order.
    pub fn params(&self) -> &[ValueType] {
        &self.params[..self.nparams]
    }

    /// How many parameters the import takes.
#[cfg_attr(not(test), allow(dead_code))] // tests check decoded arities against it; the linker walks `params` itself
    pub fn nparams(&self) -> usize {
        self.nparams
    }
}

fn decode(raw: u32) -> Result<ValueType, SignatureError> {
    match raw {
        0 => Ok(ValueType::Void),
        1 => Ok(ValueType::I32),
        2 => Ok(ValueType::I64),
        3 => Ok(ValueType::F32),
        4 => Ok(ValueType::F64),
        excluded if EXCLUDED.iter().any(|(value, _)| *value == excluded) => {
            let name = EXCLUDED
                .iter()
                .find(|(value, _)| *value == excluded)
                .map(|(_, name)| *name)
                .expect("just matched");
            Err(SignatureError::ExcludedValueType {
                raw: excluded,
                name,
            })
        }
        other => Err(SignatureError::UnknownValueType { raw: other }),
    }
}

/// One value in its neutral form: what crosses the boundary, without wasmtime in
/// the type. The float variants hold **bits** (see the module docs).
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Slot {
    I32(i32),
    I64(i64),
    F32(u32),
    F64(u64),
}

impl Slot {
    /// The declared type this slot carries.
    pub fn value_type(&self) -> ValueType {
        match self {
            Slot::I32(_) => ValueType::I32,
            Slot::I64(_) => ValueType::I64,
            Slot::F32(_) => ValueType::F32,
            Slot::F64(_) => ValueType::F64,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_value_type_round_trips_through_its_slot() {
        let cases = [
            (ValueType::I32, Slot::I32(-7)),
            (ValueType::I64, Slot::I64(i64::MIN + 1)),
            (ValueType::F32, Slot::F32(0.5f32.to_bits())),
            (ValueType::F64, Slot::F64(f64::NAN.to_bits())),
        ];
        for (value_type, slot) in cases {
            assert_eq!(slot.value_type(), value_type, "{value_type:?}");
        }

        // The float slots are bit patterns, so a NaN payload survives the trip.
        let payload = 0x7FC0_0001u32;
        let slot = Slot::F32(payload);
        match slot {
            Slot::F32(bits) => assert_eq!(bits, payload, "the bit pattern is what crosses"),
            other => panic!("expected an F32 slot, got {other:?}"),
        }
    }

    #[test]
    fn the_discriminants_are_the_abis() {
        assert_eq!(ValueType::Void as u32, 0);
        assert_eq!(ValueType::I32 as u32, 1);
        assert_eq!(ValueType::I64 as u32, 2);
        assert_eq!(ValueType::F32 as u32, 3);
        assert_eq!(ValueType::F64 as u32, 4);
        assert_eq!(MAX_PARAMS, 8);
    }

    #[test]
    fn a_valid_mixed_signature_is_accepted() {
        let signature = Signature::new(
            ValueType::I32 as u32,
            &[
                ValueType::I32 as u32,
                ValueType::I64 as u32,
                ValueType::F32 as u32,
                ValueType::F64 as u32,
            ],
        )
        .expect("a mixed signature is legal");
        assert_eq!(signature.ret(), ValueType::I32);
        assert_eq!(signature.nparams(), 4);
        assert_eq!(
            signature.params(),
            &[ValueType::I32, ValueType::I64, ValueType::F32, ValueType::F64]
        );
    }

    #[test]
    fn a_void_return_is_accepted() {
        let signature = Signature::new(ValueType::Void as u32, &[ValueType::I32 as u32])
            .expect("void is a legal return type");
        assert_eq!(signature.ret(), ValueType::Void);

        // And with no parameters at all.
        let bare = Signature::new(ValueType::Void as u32, &[]).expect("a bare import");
        assert_eq!(bare.nparams(), 0);
    }

    #[test]
    fn a_void_parameter_is_refused() {
        let error = Signature::new(ValueType::I32 as u32, &[ValueType::I32 as u32, 0])
            .expect_err("void is not a parameter type");
        assert_eq!(error, SignatureError::VoidParameter { index: 1 });
        assert!(error.to_string().contains("only valid as a return type"));
    }

    #[test]
    fn a_ninth_parameter_is_refused() {
        let nine = [ValueType::I32 as u32; 9];
        let error = Signature::new(ValueType::I32 as u32, &nine).expect_err("too many");
        assert_eq!(
            error,
            SignatureError::TooManyParameters {
                count: 9,
                max: MAX_PARAMS
            }
        );
        assert!(error.to_string().contains("8"));

        // Eight is exactly the limit and is accepted.
        let eight = [ValueType::I32 as u32; 8];
        assert!(Signature::new(ValueType::I32 as u32, &eight).is_ok());
    }

    #[test]
    fn vector_and_reference_types_are_refused_by_name() {
        let v128 = Signature::new(ValueType::I32 as u32, &[0x7B]).expect_err("v128");
        assert_eq!(
            v128,
            SignatureError::ExcludedValueType {
                raw: 0x7B,
                name: "v128"
            }
        );
        assert!(v128.to_string().contains("v128"));

        let funcref = Signature::new(0x70, &[]).expect_err("funcref return");
        assert_eq!(
            funcref,
            SignatureError::ExcludedValueType {
                raw: 0x70,
                name: "funcref"
            }
        );

        let externref = Signature::new(ValueType::I32 as u32, &[0x6F]).expect_err("externref");
        assert!(matches!(
            externref,
            SignatureError::ExcludedValueType {
                name: "externref",
                ..
            }
        ));
    }

    #[test]
    fn an_unknown_type_byte_is_refused_with_the_number() {
        let error = Signature::new(ValueType::I32 as u32, &[9]).expect_err("unknown");
        assert_eq!(error, SignatureError::UnknownValueType { raw: 9 });
        assert!(error.to_string().contains('9'));
    }
}
