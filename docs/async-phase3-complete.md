# Async/await, Phase 3 complete

Phase 3 of `docs/async-await-plan-v2.md` — the Backend A state-machine lowering
— is landed and verified. This note records what was delivered, what remains
refused, and what Phase 4 owns. It adds no design; the plan is the design.

## Where it lives

- Phase 3 commits 1–6: `feat/async-phase3` @ `ccf888c6`.
- Closures C1–C4 (the interaction Phase 3's commit 5 case 6 needed):
  `feat/closures-c1` … `feat/closures-c4` @ `df53b863`.
- Phase 3 commits 7, 7b, 8: `feat/async-phase3b` @ `27ec8e0b`, cut from
  `df53b863` so the walk could reflect C4's un-refusals.
- Byte-identity baseline: `ccf888c6` (`/tmp/as-closure-base`).

## What each commit delivered

Groundwork (Phases 1–2), in order: `c8a23df2` adds the `AwaitExpression` and
the async-function fact; `b60bbdf9`/`c266da35` recognize `async`/`await` and
keep the AST honest; `bdf18009`/`3b2a012b` add visitor and parser coverage;
`73483ef5` adds `Task<T>`; `8d6ca652`/`94a8c7f4` resolve `await` and type an
async call as `Task<T>`; `0fee1b88` tests it; `1fc7c808` gives `Task<T>` a
traced record.

| Commit | Delivered |
|---|---|
| `70642d13` | Registers the `afterParse` transform and emits the three-artifact skeleton: state struct, entry, resume function. |
| `abc54ec9` | Lowers `await` as a state transition — park, resume point, guards — and reads the value back at codegen (§4.7.4). |
| `a5fb118b` | Lifts the bindings that cross a suspension into state fields, with copy-in and copy-out (commit 4). |
| `56f24115` | The six correctness cases: straight line, loops, conditionals, nesting, early return; case 6 deferred to closures (commit 5). |
| `ccf888c6` | Emits the state struct's `$env: TaskEnv \| null` field, traced, null until a receiver or capture fills it (commit 6). |
| `50538547` | The validation walk: a read-only second phase that refuses every `async` construct the lowering pass cannot reach (commit 7). |
| `f8b4c81e` | `export default` async names its own shape, landed before the parser guard could come down (7b, phase A). |
| `c4a55386` | Coverage for the single-identifier arrow production, which had only guard-text coverage (7b, phase B). |
| `11cae2ee` | The this-env class gains the constructor the entry's `new` requires, so called async methods compile. |
| `ac72bd11` | The parser's five `AS100: Not implemented: Async functions` sites are deleted; the transforms refuse by name (commit 7b). |
| `27ec8e0b` | One top-level fixture composes async with closures through the whole pipeline (commit 8). |

## Verification, as of `27ec8e0b`

- `npm run build`: four targets SUCCESS.
- `npm test` — the consolidated invocation: parser, async (resolver then
  lowering), closure, compiler, browser, asconfig, transform, cli. Exit 0.
- Async: 30 resolver + 188 lowering checks. Closures: 92 of 92.
- Compiler: **248** fixtures, 0 mismatches, `[ SUCCESS ]`, same 7
  feature-gated skips. 247 before commit 8's fixture; none re-baselined.
- Byte-identity against `ccf888c6`: 10/10 probes (plain and optimized).
- Probes: this-only arrow 7, indirect `this` 8.
- `Not implemented: Async functions`: 0 occurrences in the built
  `dist/assemblyscript.js`, and one historical comment in
  `src/async/validate.ts` recording what the deleted guard used to say.

## What is refused, after Phase 3

The authoritative list is plan §4.8; the short form: `switch`, `try`/`catch`,
`do`, `for-of`, `break`, `continue`, `throw` inside an async body; `await` in
any position but the four lowered ones, and two awaits in one statement; async
arrows, async function expressions, async generics, async statics,
optional/rest parameters, an omitted return type, a bodyless declaration;
`this`/`super` in a free async function with no receiver; `super` in a
capturing arrow; a local or captured binding with no declared type (D10) or
typed by a type parameter (D11); and any async construct the lowering pass
cannot reach — non-async body, object literal, class-field initializer,
top-level `if`/loop/`try`/`switch`, `export default` — refused by the
validation walk.

## Known limitations carried into Phase 4

1. **Every async entry traps at runtime.** `__taskRegister` and the rest of
   `std/assembly/task-rt.ts` are Phase 4 stubs that call `unreachable()`. This
   holds for *any* async function, not only methods; Phase 3 proves compilation
   and shape, not values.
2. **Divergence 2 — nested arrows capturing `this` in async bodies.** The `this`
   replacement does not enter nested function expressions, so such an arrow is
   reported (TS2332) rather than lowered. Needs a decision in C5+.
3. **Divergence 3 — an untyped closure value across an await**, alongside D10:
   the state field needs a type the transform cannot name.
4. **D10 / D11** — inferred-type and type-parameter captures are refused, as
   ruled for v1. The fix is architectural (analysis in the resolver, or types
   carried on the AST) and is a joint follow-up with the async untyped-local gap.
5. **§8.3(a) is not implemented — an async function that is *itself* a closure
   value.** Measured while building commit 8's fixture: a nested
   `async function` that captures an outer local fails with `TS2304: Cannot
   find name '$closureEnvIn'`, because §8.3(a)'s two statements — `state.$env =
   $closureEnvIn` in the entry and the `changetype` re-declaration at the top of
   `f$resume` — are not emitted. Case (b), an async function that *contains* a
   closure, works and is what commit 8's fixture pins.
6. **Parent-chain captures (C5).** A capture across more than one environment is
   refused by the closure transform.

## What Phase 4 delivers

- The runtime behind `~lib/task-rt`: `__taskRegister`, `__taskPark`,
  `__taskSettled`, `__taskDeliver`, `__taskTick`, the task table, and the guest
  frame-loop tick (plan §6).
- Value assertions for the tests that are shape-only today: the six correctness
  cases, case 6, and the async method `this` reads before and after an await.
- The scheduler's ordering and wakeup encoding (§6.2, §6.5) and the host ABI of
  §7.1.

Until then, Phase 3's guarantee is: every lowered program is structurally
correct and byte-identical to the pre-async compiler when it declares no
`async`, and every refused program is refused by name.
