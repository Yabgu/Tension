use std::time::Instant;

use wasmtime::{Config, Engine, ExternType, Func, FuncType, Linker, Module, Store, Val, ValType};

fn val_for(t: Option<&ValType>, epoch: Instant) -> Val {
    match t {
        Some(ValType::F64) => Val::F64((epoch.elapsed().as_secs_f64() * 1000.0).to_bits()),
        Some(ValType::F32) => Val::F32(0),
        Some(ValType::I64) => Val::I64(0),
        _ => Val::I32(0),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = &args[1];
    let func = args.get(2).map(|s| s.as_str()).unwrap_or("main");

    let bytes = std::fs::read(path).expect("read wasm");
    let mut config = Config::new();
    config.wasm_bulk_memory(true);
    let engine = Engine::new(&config).unwrap();
    let module = Module::new(&engine, &bytes).expect("compile module");

    let t_start = Instant::now();
    let epoch = Instant::now();
    let mut store = Store::new(&engine, ());
    let mut linker = Linker::new(&engine);

    for imp in module.imports() {
        let name = imp.name().to_string();
        let mname = imp.module().to_string();
        if let ExternType::Func(ft) = imp.ty() {
            let params: Vec<ValType> = ft.params().collect();
            let results: Vec<ValType> = ft.results().collect();
            let r0 = results.first().cloned();
            let fn_type = FuncType::new(&engine, params, results);
            let is_clock = name == "now" || name.ends_with(".now") || name == "Date.now";
            let is_abort = name == "abort";
            let f = Func::new(&mut store, fn_type, move |_caller, _p, res| {
                if is_abort {
                    return Err(wasmtime::Error::msg("guest abort"));
                }
                for r in res.iter_mut() {
                    *r = if is_clock {
                        Val::F64((epoch.elapsed().as_secs_f64() * 1000.0).to_bits())
                    } else {
                        val_for(r0.as_ref(), epoch)
                    };
                }
                Ok(())
            });
            linker.define(&mut store, &mname, &name, f).ok();
        }
    }

    let instance = linker
        .instantiate(&mut store, &module)
        .expect("instantiate");
    let t_ready = Instant::now();

    // Try the signatures the probes use, in order.
    enum Callable {
        Unit(wasmtime::TypedFunc<(), ()>),
        I32In(wasmtime::TypedFunc<i32, i32>),
        I32Out(wasmtime::TypedFunc<(), i32>),
    }
    let arg = args.get(3).and_then(|s| s.parse::<i32>().ok());
    let callable = if let (Ok(f), Some(a)) =
        (instance.get_typed_func::<i32, i32>(&mut store, func), arg)
    {
        let _ = a;
        Callable::I32In(f)
    } else if let Ok(f) = instance.get_typed_func::<(), ()>(&mut store, func) {
        Callable::Unit(f)
    } else if let Ok(f) = instance.get_typed_func::<(), i32>(&mut store, func) {
        Callable::I32Out(f)
    } else {
        panic!("no compatible export `{func}`")
    };

    let mem_before = instance
        .get_memory(&mut store, "memory")
        .map(|m| m.data_size(&store))
        .unwrap_or(0);

    let mem = instance.get_memory(&mut store, "memory");
    let t0 = Instant::now();
    let mut scalar: Option<i32> = None;
    let outcome: Result<(), wasmtime::Error> = match &callable {
        Callable::Unit(f) => f.call(&mut store, ()),
        Callable::I32In(f) => f.call(&mut store, arg.unwrap_or(0)).map(|v| { scalar = Some(v); }),
        Callable::I32Out(f) => f.call(&mut store, ()).map(|v| { scalar = Some(v); }),
    };
    let dt = t0.elapsed();

    // If the module reports results through a Float64 array, read them out.
    let mut vals: Vec<f64> = Vec::new();
    if outcome.is_ok() {
        if let (Ok(pf), Ok(lf), Some(m)) = (
            instance.get_typed_func::<(), i32>(&mut store, "resultPtr"),
            instance.get_typed_func::<(), i32>(&mut store, "resultLen"),
            mem.as_ref(),
        ) {
            if let (Ok(ptr), Ok(len)) = (pf.call(&mut store, ()), lf.call(&mut store, ())) {
                let len = len.clamp(0, 256) as usize;
                let data = m.data(&store);
                for i in 0..len {
                    let at = ptr as usize + i * 8;
                    if at + 8 <= data.len() {
                        let mut b = [0u8; 8];
                        b.copy_from_slice(&data[at..at + 8]);
                        vals.push(f64::from_le_bytes(b));
                    }
                }
            }
        }
    }
    let vals_s = vals
        .iter()
        .map(|v| format!("{v:.6}"))
        .collect::<Vec<_>>()
        .join(",");

    let mem_after = instance
        .get_memory(&mut store, "memory")
        .map(|m| m.data_size(&store))
        .unwrap_or(0);

    let values_line = || {
        if vals_s.is_empty() { String::new() } else { format!("\nWASMTIME_VALUES\t{func}\t{vals_s}") }
    };
    match outcome {
        Ok(()) => println!(
            "WASMTIME_RESULT\tok\t{}\tcall_ms={:.3}\tinstantiate_ms={:.3}\theap_before={}\theap_after={}",
            func,
            dt.as_secs_f64() * 1000.0,
            (t_ready - t_start).as_secs_f64() * 1000.0,
            mem_before,
            mem_after
        ),
        // values appended below via a separate print to keep the format stable
        Err(e) => println!(
            "WASMTIME_RESULT\ttrap\t{}\tcall_ms={:.3}\theap_before={}\theap_after={}\terr={}",
            func,
            dt.as_secs_f64() * 1000.0,
            mem_before,
            mem_after,
            e.to_string().lines().next().unwrap_or("").to_string()
        ),
    }
    if let Some(v) = scalar {
        print!("\nWASMTIME_I32\t{func}\t{v}");
    }
    print!("{}", values_line());
}