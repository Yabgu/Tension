# async/await: complete

The state of the feature at TensionScript 0.7.1 / Tension 0.7.0, and what is not
in it. Written the way the arrow-`this`, closures and scheduler notes were: what
shipped, what is tested, what is deferred, and what the record is.

**Consumer state.** All sixteen consumers are on `^0.7.0`, installed from the
registry. 0.7.1 is built, packed (1,624,436 bytes) and committed in TensionScript
— the compiler half of `break`/`continue` — but it is **not published**, so the
transition to it is pending and `guest-flow` reports SKIP against 0.7.0 rather
than passing. When 0.7.1 publishes, the transition is mechanical: bump sixteen
`package.json`s, clean-install, and apply the bouncing-bodies adoption saved at
`/tmp/bb-adopted.ts` (its frame loop's exit becomes a real `break`, verified
against the packed tarball: `asleep 64/64`, exit 0).

## What shipped

| version | what it delivered |
|---|---|
| 0.2.0 | arrow-`this`: the resolver and codegen, the fixture re-baseline |
| 0.3.0 | the task machine and the completion path — `Task<T>`, `TaskRecord`, the state struct, `f$resume` |
| 0.3.1 | the async-body and type-argument refusals, named rather than generic |
| 0.3.2 | one guard per run of statements (scope, and the reason a `let` after an `await` survives) |
| 0.3.3 | the guest-side completion buffer and drop report |
| 0.4.0 / 0.4.1 | async complete; closures complete; `thisof` fix; D10 closed |
| 0.5.0 / 0.5.1 | D11 closed in practice; generic env classes (C6a/C6b); the `stdSources` marker |
| 0.6.0 | the push path beside the pull path: `__taskBindTable`, `__taskPark`'s host call, `__taskWake` |
| 0.6.1 | `__taskResume` (the record travels with the wake), `__taskFail`, pre-park registration and the `__taskRegistered` guard |
| 0.7.0 | the pull path retired: `__taskTick`, `__taskDeliver`, `__taskReportDrops`, the guest buffer and `waitingByKey` removed |
| 0.7.1 | `break` and `continue` in an await-bearing loop |

**The final shape.** A guest's async function lowers to a state struct plus
`f$resume`. An `await` that is not already settled parks: `__taskPark` records the
state on the task's slot — claimed at creation — and calls `scheduler::park`. The
host epoch matches every published `(class, key)` to a parked id, or to the
recent-completions table when nobody is parked yet, and wakes with
`__taskResume(ids, classes, payloads, count)`. A refusal or a lost completion
arrives as `__taskFail` with a status. The one rendezvous the host cannot own — a
task awaiting another *suspending guest task*, whose record has no producer key —
is queued by `wake` and drained at the top of the next host entry.

## What is tested

- `cargo test --no-default-features --features audio`: **519 passed, 0 failed,
  37 suites**.
- `tension-framework/tests/run.sh`: **eight fixtures** —
  `guest-push`, `guest-frame`, `guest-early`, `guest-sync`, `guest-enospc`,
  `guest-chain`, `guest-flow`, `guest-drop` — plus the AI controls C1 (stall →
  `AI_ERROR`), C2 (coalescing: one wake, four records), C3 (done-vs-empty),
  C4 (dropped = 0). Against 0.7.1 all eight run; against the published 0.7.0,
  `guest-flow` reports **SKIP — needs 0.7.1**, which is the guard, not a pass.
- `tension-ogre/tests/run.sh`: all cases passed, `ASYNC PASS drop` (the lost
  completion wakes with `-EIO`, attribution per family).
- Seven adopting examples on the host-owned loop: bouncing-bodies, hello-mesh,
  animated-character, hello-triangle, input-camera, async-io, ai. bouncing-ball
  is source-adopted behind its pre-existing `AS105` memory-page gate.
- **The real llama.cpp stream on 0.7.0**: 35 chunks, ending on `AI_DONE`
  (class 11), one host wake per chunk, exit 0. The chunk count varies with
  timing (36 on 0.6.1, same reply) — what does not vary is that it passes 16,
  the ring capacity a per-chunk registration used to pressure.
- io's wasm is the non-adopting control: byte-identical between 0.6.1 and 0.7.0
  except for the globals the retired buffer occupied.

## What is deferred

- **Generic async functions** (`async function f<T>(…)`) are refused at
  `lower.ts:427`. The narrower case-30 — a captured local typed by a type
  parameter inside an async body — is refused by the closures transform with its
  own message; closing it means teaching the async transform's synthesized types
  to carry a parameter list. Not scheduled.
- **The barrel leak.** An adopting guest re-exports `__taskWake`,
  `__taskResume` and `__taskFail` by hand, because the linker drops an export
  nobody names. `export *` in the framework barrel leaks ~567 bytes into guests
  that import none of it. A naive `export *` of the task symbols leaked them into
  io. The fix is barrel narrowing, its own phase with its own compatibility
  question.
- **The canary runtime check.** `verify_band_is_zero` and the lattice are
  verified at session *open* only; page 0's tail is covered by neither. Filed.
- **`try`/`catch`** — `AS100: Not implemented: Exceptions`. A separate language
  feature, not a gap in this one.
- **Bootstrap-ordering.** The self-hosting build's ordering failures, the
  standing CI red on `main`. Measured to predate the C6 work and unaffected by
  it. Until it lands, `npm run bootstrap:debug` is red.

## The next phase — a menu

1. **Interop struct views — reframed.** The scoping pass that was started and
   interrupted left a measurement that changes the phase's shape. `@unmanaged`
   **already works at the ABI boundary**: field order *is* the layout (a swapped
   declaration really swaps the bytes — `B { y: f32; x: i32 }` puts `y` at 0 and
   `x` at 4), alignment is honoured (`i32/i64/i32` puts the third field at 16),
   **39 wire types already use it**, and `offsetof<T>("field")` is already the
   framework's cross-check in 75 places.

   What does *not* work is narrower than the feature sounds: `sizeof<T>()`
   returns **4** for an unmanaged class (pointer size, not data size), and
   `store<T>(ptr, value)` writes **one word** — while `load<T>(ptr)` correctly
   copies the data. So the phase is **not** "add struct views". It is: fix
   `sizeof`/`store<T>` for unmanaged types, and adopt the `@unmanaged` pattern
   the tree already uses everywhere it currently hand-rolls offsets. The
   scoping document needs revising along that line before anything is built.
2. **Bootstrap-ordering.** The CI red; self-hosting.
3. **`try`/`catch`.**
4. **Barrel narrowing.** The leak above, and the hand-written re-exports with it.
5. **Docs.** The async plan's §4.8 validation walk and the closures plan both
   carry measured-but-unexplained observations that belong in one place.

## The record

- **TensionScript PR #4** (`next`) — the scheduler contract and the std/transform
  work through 0.7.1. **Open.** Its commits: `54584f88` (push path, 0.6.0),
  `01324994` (`__taskFail`), `db8c2bec` (`__taskResume`, the guest buffers yield),
  `d761dec8` (creation-time slot), `f0dde736` (0.6.1), `99ec9b28` (the wake's
  no-filter rule and `drainReady`), `2612169b` (0.7.0), `aa310a54` (0.7.1),
  `6e6f3a6c` (contract §10.1).
- **Tension PR #25** (`next`) — the host side. **Open.** `31f8f5b` (the `Ctx`
  variant), `8874286`/`60aa51e` (the host loop and `scheduler::park`),
  `bff01a7` (adapter ABI v3), `6ac060e` (the FRAME resume), `7001280` (the
  two-layer rule), `92300db` (`rt.stream`), `3104022` (the first adoptions),
  `79a4c47` (the mirror-vs-record test), `376a8ef` (recent completions),
  `d563307` (the `-ENOSPC` fixture), `921548d` (guest-sync), `501f024`+
  (the consumer transitions), `dbed8c5`/`99ec9b28` (the chained-await deadlock),
  `cd1e014` (the retirement), `5746baf` (consumers on 0.7.0), `5dc4206`
  (guest-flow).
- **The plans that anchor it:** `docs/async-await-plan-v2.md` (the design, the
  refusals, the measured limits), `docs/scheduler-contract.md` (the language
  feature, and §10.1 for how it shipped), `docs/scheduler-implementation-plan.md`
  (the audit and the phase order), `docs/closures-plan.md` (the transform that
  carries the state struct).
- **`docs/pipeline-notes.md`** is the operational record: the two-layer rule,
  the canary gap, the wake buffer, the sub-ring reclaim, the `HostState`
  test-literal obligation, and the no-poll audit.

## What the record got wrong, and the discipline that catches it

- **A consumer table is evidence, not a claim.** `501f024`'s message said all
  sixteen consumers were on `^0.6.1`; `io` and `input-camera` were not — they had
  been reinstalled at `^0.6.0` to take measurements, which rewrites the
  dependency, and the transition's `git add -A` staged the drift. Repaired in
  `5746baf`, whose message says so. **Stage by name, never `-A`**: a shell command
  that installs a package edits the record, and `-A` cannot tell that apart from
  a deliberate bump.
- **"Tests pass" is evidence for the committed tree.** A structural change to a
  type constructed in test code is not verified until `cargo test` *compiles* it.
  This cost two phases (`HostState`'s `task_fail`/`drop_seen`, then
  `task_resume`).
- **A capacity is a silent timeout.** The sub-ring filled at its 16 slots and
  stopped delivering with no trap and no error; only the real llama.cpp backend,
  which posts per chunk, made it visible. The stub posts once per generation and
  cannot see it. **The real-backend gate is not optional for anything that
  touches delivery.**
- **A compiler change gets three fixtures, not two.** For `break`/`continue` the
  useful evidence was: the published compiler **refuses** (the gap is real), a
  partial fix **passes the obvious cases and hangs on `for`+`continue`** (the
  incrementor was in the body), and the full fix passes all four. The middle
  state is the one a two-way fixture hides — and it is the state a partial
  implementation ships in.
