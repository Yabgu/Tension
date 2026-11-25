// **One source, more than one artifact.**
//
// A test program is normally one `.ts` and one `.wasm` named after it. An alias
// breaks that only where the *build flags* are the subject: DL38 compiles the
// ABI contract program twice — once for the continuation backend, once for the
// fiber backend — and the second artifact is what a gate can assert on. Writing a
// second `.ts` that re-exported the first would compile a different file through
// the same lowering, which is a weaker claim than "this exact program, on this
// backend, prints these lines".
//
// Kept in its own module because **two scripts need it and they must agree**:
// `scripts/build-test-programs.mjs` writes the artifacts, and `scripts/rebuild.mjs`
// counts and dates them. A copy of this table in each is how the check and the
// build come to disagree about what exists.
//
// `name → source`, repo-relative under `tension-core/tests/programs/`.

export const PROGRAM_ALIASES = {
  "async-on-main-fiber": "async/async-on-main.ts",
  // DL40: the three cross-store programs, on the fiber backend. Same sources,
  // fiber flags, no `--enable stack-switching` — the twins the thread suite
  // asserts beside their continuation builds.
  "spawn-join-fiber": "thread/spawn-join.ts",
  "two-workers-fiber": "thread/two-workers.ts",
  "spawn-entry-async-fiber": "thread/spawn-entry-async.ts",
  // DL41: the served body that actually suspends. **Fiber only**, and that is the
  // round's finding rather than an oversight — see the program's own header: the
  // shape that goes on to complete on the continuation backend (a bare `await` on
  // a stamped handle) has no suspension site on a fiber build at all, and this one
  // cannot complete on the continuation backend. A pair would assert a capability
  // one of the two does not have.
  "suspend-serve-fiber": "thread/suspend-serve.ts",
};
