//! A continuation module must instantiate in the host's engine, and must not
//! without the knob that makes it legal.
//!
//! TensionScript emits `cont.new`/`suspend`/`resume` for an async guest, so the
//! engine `main` builds has `wasm_stack_switching(true)` (see the comment on
//! that line in `src/main.rs`). Wasmtime 50 enables stack switching per
//! *engine*, not per module: an engine built without it refuses a module that
//! merely declares a continuation type, before any code runs. This test holds
//! both halves of that: the refusal is real, and the host's configuration is
//! what turns it off.
//!
//! The module is hand-written WAT rather than compiler output so the property
//! under test is the engine's, not the compiler's: one `cont.new`/`resume` pair
//! is enough to make the module a continuation module, and the guest returns 42
//! so a successful run proves the resume actually executed the continuation.

use wasmtime::{Config, Engine, Instance, Module, Store};

/// One `(cont (func))` type, one function to put in a continuation, and one
/// exported function that creates and resumes it. `(elem declare func $body)` is
/// what lets `ref.func $body` name a non-exported function.
const CONTINUATION_MODULE: &str = r#"
(module
  (type $f (func (result i32)))
  (type $k (cont $f))
  (func $body (result i32) i32.const 42)
  (elem declare func $body)
  (func (export "run") (result i32)
    (resume $k (cont.new $k (ref.func $body))))
)
"#;

#[test]
fn continuation_module_is_refused_without_stack_switching() {
    let engine = Engine::new(&Config::new()).expect("a default engine");
    let error = Module::new(&engine, CONTINUATION_MODULE)
        .expect_err("a default engine must refuse a continuation module");
    // `Display` is the outermost context only; the cause chain carries the
    // reason, and `Debug` is what renders it.
    let message = format!("{error:?}");
    assert!(
        message.contains("stack switching"),
        "the refusal should name the feature, got: {message}"
    );
}

#[test]
fn continuation_module_instantiates_with_stack_switching() {
    let mut config = Config::new();
    config.wasm_stack_switching(true);
    let engine = Engine::new(&config).expect("an engine with stack switching");
    let module = Module::new(&engine, CONTINUATION_MODULE).expect("the module compiles");
    let mut store = Store::new(&engine, ());
    let instance = Instance::new(&mut store, &module, &[]).expect("the module instantiates");
    let run = instance
        .get_typed_func::<(), i32>(&mut store, "run")
        .expect("`run` is exported with the declared signature");
    let value = run.call(&mut store, ()).expect("the continuation runs");
    assert_eq!(value, 42, "the resumed continuation returned its value");
}
