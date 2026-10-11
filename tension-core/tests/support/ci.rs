//! One rule, in one place: a missing fixture **fails** the test.
//!
//! The `ogre_*` integration tests need artifacts built by other recipes — the
//! adapter DSO, the compiled guests, the shared fixture volume. Those are built
//! by `tension-framework/tests/run.sh` and `tension-ogre/tests/run.sh`, which
//! `test.sh` runs *before* `cargo test`; a full run therefore has them. When one
//! is nonetheless absent, the test fails: a run that silently skips the check it
//! exists to make can go green while the thing it guards is broken, which is the
//! failure mode a gate is supposed to prevent — so the default is strict, in
//! every environment, and no environment variable gates it.
//!
//! A developer iterating on one test, with the fixtures not built, opts out
//! explicitly with `TENSION_TEST_ALLOW_SKIP=1` — the one way to turn a missing
//! fixture back into a printed skip. [`skip_or_fail`] is the single decision
//! point, so the policy cannot drift between the thirteen tests.
//!
//! Included with `#[path = "support/ci.rs"] mod support_ci;`.

/// Whether a missing fixture may be skipped. Off unless asked for by name.
///
/// `TENSION_TEST_ALLOW_SKIP=1` is the explicit opt-out; anything else (unset,
/// `0`, `true`, an empty string) leaves the strict default. It mirrors
/// `TENSION_ALLOW_UNPINNED=1` in `build.rs`: one escape hatch per strict
/// default, spelled out at the call site that needs it.
fn skip_allowed() -> bool {
    matches!(std::env::var("TENSION_TEST_ALLOW_SKIP").as_deref(), Ok("1"))
}

/// Decide what to do about an artifact a test could not find.
///
/// The call site supplies a message naming the missing fixture — `format_args!`
/// so the wording and the fields are exactly what the old `eprintln!` printed.
/// By default that message panics: a missing fixture is a failure, in every
/// environment. With `TENSION_TEST_ALLOW_SKIP=1` the message is printed as
/// `skipped: …` and the caller returns.
#[track_caller]
pub fn skip_or_fail(reason: std::fmt::Arguments<'_>) {
    if skip_allowed() {
        eprintln!("skipped: {reason}");
        return;
    }
    panic!(
        "{reason}\n\
         A missing fixture fails the test by default, in every environment. Build the fixture \
         (the message above names the recipe), or set TENSION_TEST_ALLOW_SKIP=1 to skip a test \
         whose fixture is absent."
    );
}
