//! The logging C ABI: `tension_log` and `tension_log_structured`.
//!
//! These are the two `#[no_mangle] extern "C"` symbols a native component that
//! links the host *directly* can call — the C harness under `tests/support`, a
//! tool, and (if it ever needs to log) the statically linked Zig resource core.
//!
//! A capability **adapter does not call these.** `tension_adapter.h` rule 8
//! forbids an adapter from requiring a symbol in the host executable — the
//! property that makes `dlopen` safe with no `-rdynamic` — so an adapter
//! reaches the same logger through `tension_core_api.log_named` /
//! `.log_structured`. Both routes and the Rust API and the guest import all
//! forward to the one [`emit`], so a record is identical whichever language
//! produced it.
//!
//! ## Panic freedom
//!
//! Every body runs under `catch_unwind`. A panic is swallowed and reported as a
//! single fallback line on stderr; nothing unwinds across the FFI boundary,
//! because a logging call must never be the thing that aborts the process.
//!
//! ## Sizes
//!
//! These two symbols use `size_t` (see `tension_logger.h`), unlike the adapter
//! table, whose lengths are `uint32_t` throughout because they are guest
//! lengths. `logger_name` is NUL-terminated and has no length; `message` and
//! `json_payload` are byte slices of the given length and need not be
//! NUL-terminated. Invalid UTF-8 is replaced rather than refused — a log call
//! never fails.

use std::ffi::{c_char, CStr};
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};

use super::level::Level;
use super::{emit, DEFAULT_LOGGER};

/// `void tension_log(level, logger_name, message, message_len)`.
///
/// # Safety
///
/// `logger_name` must be NUL-terminated or null. `message` must point at
/// `message_len` readable bytes, or be null (then it is empty).
#[no_mangle]
pub unsafe extern "C" fn tension_log(
    level: i32,
    logger_name: *const c_char,
    message: *const c_char,
    message_len: usize,
) {
    guard(|| {
        // SAFETY: the caller's contract, documented in `tension_logger.h`.
        let name = unsafe { name_from(logger_name) };
        let text = unsafe { bytes_from(message, message_len) };
        emit(Level::from_abi_code(level), &name, &text, None);
    });
}

/// `void tension_log_structured(level, logger_name, json_payload, payload_len)`.
///
/// # Safety
///
/// As [`tension_log`]: `logger_name` is NUL-terminated or null, and
/// `json_payload` points at `payload_len` readable bytes or is null.
#[no_mangle]
pub unsafe extern "C" fn tension_log_structured(
    level: i32,
    logger_name: *const c_char,
    json_payload: *const c_char,
    payload_len: usize,
) {
    guard(|| {
        let name = unsafe { name_from(logger_name) };
        let payload = unsafe { bytes_from(json_payload, payload_len) };
        // A structured record has no message; the payload is the record.
        emit(Level::from_abi_code(level), &name, "", Some(&payload));
    });
}

/// Read a NUL-terminated logger name. A null or empty name is the default
/// logger (`core`), so an unnamed line still lands somewhere sensible.
///
/// # Safety
///
/// `ptr` is null or NUL-terminated.
unsafe fn name_from(ptr: *const c_char) -> String {
    if ptr.is_null() {
        return DEFAULT_LOGGER.to_string();
    }
    // SAFETY: the caller promised a NUL-terminated string.
    let text = unsafe { CStr::from_ptr(ptr) }.to_string_lossy();
    if text.is_empty() {
        DEFAULT_LOGGER.to_string()
    } else {
        text.into_owned()
    }
}

/// Read a counted byte slice as text. Null or zero length is the empty string;
/// invalid UTF-8 is replaced.
///
/// # Safety
///
/// If non-null, `ptr` points at `len` readable bytes.
unsafe fn bytes_from(ptr: *const c_char, len: usize) -> String {
    if ptr.is_null() || len == 0 {
        return String::new();
    }
    // SAFETY: the caller promised `len` readable bytes at `ptr`.
    let bytes = unsafe { std::slice::from_raw_parts(ptr as *const u8, len) };
    String::from_utf8_lossy(bytes).into_owned()
}

/// Run an FFI body, swallowing any panic. On a panic, one fallback line goes to
/// stderr — the same place the un-initialised logger writes — and the call
/// returns normally.
fn guard(body: impl FnOnce()) {
    if catch_unwind(AssertUnwindSafe(body)).is_err() {
        let stderr = std::io::stderr();
        let _ = writeln!(
            stderr.lock(),
            "tension: a log call panicked and was swallowed at the C ABI"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn a_null_name_reads_as_the_default_logger() {
        assert_eq!(unsafe { name_from(std::ptr::null()) }, DEFAULT_LOGGER);
        let empty = CString::new("").expect("no nul");
        assert_eq!(unsafe { name_from(empty.as_ptr()) }, DEFAULT_LOGGER);
    }

    #[test]
    fn a_name_is_read_as_written() {
        let name = CString::new("ogre:loader").expect("no nul");
        assert_eq!(unsafe { name_from(name.as_ptr()) }, "ogre:loader");
    }

    #[test]
    fn a_counted_slice_is_read_and_nulls_are_empty() {
        let text = b"hello";
        assert_eq!(
            unsafe { bytes_from(text.as_ptr() as *const c_char, text.len()) },
            "hello"
        );
        assert_eq!(unsafe { bytes_from(std::ptr::null(), 5) }, "");
        assert_eq!(unsafe { bytes_from(text.as_ptr() as *const c_char, 0) }, "");
    }

    #[test]
    fn invalid_utf8_is_replaced_not_refused() {
        // The type annotation is load-bearing: without `u8`, the literal infers
        // `[i32; 3]`, and `as_ptr() as *const c_char` plus `len()` would read
        // the first three *bytes* of that array — [0x66, 0x00, 0x00], not the
        // three values.
        let bytes: [u8; 3] = [0x66, 0x80, 0x6f]; // 'f', a stray continuation, 'o'
        let text = unsafe { bytes_from(bytes.as_ptr() as *const c_char, bytes.len()) };
        assert!(text.starts_with('f') && text.ends_with('o'), "{text:?}");
        assert!(text.contains('\u{FFFD}'), "{text:?}");
    }

    #[test]
    fn the_entry_points_never_panic_on_hostile_input() {
        // Called without an installed logger, these take the fallback path and
        // write to stderr (visible with --nocapture). The assertion is that the
        // calls return at all.
        unsafe {
            tension_log(Level::Info as i32, std::ptr::null(), std::ptr::null(), 0);
            tension_log(-99, std::ptr::null(), std::ptr::null(), 0);
            tension_log_structured(Level::Warn as i32, std::ptr::null(), std::ptr::null(), 0);
        }
    }

    #[test]
    fn guard_swallows_a_panic() {
        // The guard's contract: a panicking body returns, and a line is written.
        guard(|| panic!("the guard must swallow this"));
        guard(|| {}); // and a normal body is untouched
    }
}
