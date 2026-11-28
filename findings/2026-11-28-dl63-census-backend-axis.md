# DL63 — the census gains a backend axis, and the `-EIO` is diagnosed to engine shape

**Four OGRE examples read as `ran` for four rounds because the instrument ran each example on
the backend it declares.** That is now fixed, and the fix immediately found a fifth failure
nobody was looking for.

```
Tension        feat/dl59-ready-queue  0af037b2  clean  CI success (46101225279)  ← head
                                     357623e8         CI success (46099816389)  ← the code commit
TensionScript  feat/dl59-ready-queue  dc4337fb  clean  CI success (46099819059)  ← head
```

---

## 1. The backend axis, and the baseline

`TENSION_RUN_BACKEND=fiber npm run run:examples` rebuilds every example for that backend and
runs it. The `backend` column is read **from the artifact** (`tension.requires`), not from the
request, so a build that ignored the flag shows as a row that disagrees with the profile.

### Declared profile (each example on its own backend)

```
fiber     ran              ai                         0.2s
promise   ran              async-io                   0.3s
fiber     ran              async-on-main              0.2s
fiber     ran              audio                      0.2s
fiber     ran              io                         0.2s
fiber     ran              log                        0.2s
promise   ran-but-failed   ogre/animated-character    6.5s — ERROR core: game aborted: Index out of range (in ~lib/typedarray.ts, line 167, col 45)
promise   ran              ogre/bouncing-ball         4.9s
promise   ran              ogre/bouncing-bodies       7.6s
promise   ran              ogre/hello-mesh            8.6s
promise   ran              ogre/hello-triangle        8.2s
promise   hung             ogre/input-camera         29.9s
promise   ran              platform-control           0.3s
fiber     ran              res                        1.2s
fiber     refused-by-name  solver/collision           0.2s — gnuplot not found. Install it:
fiber     ran              solver/wasm                0.2s
fiber     ran              solver/world               0.2s
fiber     ran              spawn                      0.2s

run-examples: 18 example(s) — 15 ran, 1 ran-but-failed, 1 hung, 1 refused-by-name
```

### Fiber profile (every example rebuilt for fiber)

```
fiber   ran              ai                         0.2s
fiber   failed           async-io                   0.2s — game aborted: Unexpected 'null' (~lib/task.ts:405)
fiber   ran              async-on-main              0.2s
fiber   ran              audio                      0.2s
fiber   ran              io                         0.2s
fiber   ran              log                        0.2s
fiber   ran-but-failed   ogre/animated-character    0.5s — …characterMedium.mesh did not load (errno -5)
fiber   ran-but-failed   ogre/bouncing-ball         0.5s — …Barrel.mesh did not load (errno -5)
fiber   ran-but-failed   ogre/bouncing-bodies       0.3s — …cube.mesh did not load (errno -5)
fiber   ran-but-failed   ogre/hello-mesh            0.4s — …Barrel.mesh did not load (errno -5)
fiber   hung             ogre/hello-triangle       29.9s — host surface 640x480, swapchain 640x391 — rebuild
fiber   hung             ogre/input-camera         29.9s — procedural mesh resource 2 ready
fiber   needs-display    platform-control           0.3s — the host never applied the resize within 10 frames
fiber   ran              res                        1.4s
fiber   refused-by-name  solver/collision           0.3s — gnuplot not found. Install it:
fiber   ran              solver/wasm                0.2s
fiber   ran              solver/world                0.2s
fiber   ran              spawn                      0.3s

run-examples: 18 example(s) — 9 ran, 1 failed, 4 ran-but-failed, 2 hung, 1 needs-display,
              1 refused-by-name (backend=fiber)
```

**The instrument's honest answer to "can it see a program that exits 0 having done
nothing?"** Partly. `ran-but-failed` catches a guest that **said** it failed — the four OGRE
rows above, and one the declared profile had been hiding (`animated-character`'s `Index out of
range`, which `promise` reaches at 6.5 s and which read as `ran` for four rounds). It does
**not** catch a guest that exits 0 silently having finished early: that still reads as `ran`.
The narrow instrument for that class is a transcript assertion (which is what
`spawn_ready.rs`, `async_method.rs` and `park_frame.rs` are); the census cannot replace them,
and saying so is worth more than widening the sign list until it matches everything.

## 2. The `-EIO`, diagnosed — and it is engine shape

The brief's framing (`errno -5` at `res/mod.rs`) is not where the value comes from. The chain,
quoted from the tree:

- `tension-framework/assembly/ogre/async.ten:124` — `loadResult` reads the **delivered
  record**: `if (status != 0) result = status;` with the comment *"§6.4: a dropped completion
  wakes the task with -EIO"*;
- the next branch — `cls == CLASS_JOB_DONE` with `payload == 0` — also answers `-5`, *"a
  success record with no resource is incoherent"*.

So `-5` is **"the completion this await received was not the job's"**. The evidence, from
`TENSION_ITERATIONS=1` on `hello-mesh`:

```
INFO  iter: park task=0 class=4 (JOB_DONE) key=1
hello-mesh: resources/models/Barrel.mesh did not load (errno -5)
```

One park on `(JOB_DONE, key=1)`, resumed **in the same millisecond**, with no `post` line
between them, and the OGRE adapter's own log never says `realised mesh`.

**The minimal reproduction** — a floating spawn whose body awaits the frame clock:

```
entry
entry after spawn
INFO  iter: park task=0 class=9 (FRAME) key=0
body after await rt.frame()          ← no post, no resume, same millisecond
```

`(FRAME, key=0)` is posted by the host's own loop in `RL63`'s parlance — the frame clock — and
on the fiber path that loop only advanced during `__start`. A park that arrives **after**
`__start` returns (i.e. from a body the ready drain started) has no producer running, so the
park ABI answers immediately (a park the executor cannot strand is a park with no producer).
The guest then reads a record that no producer wrote: `payload == 0` → `-EIO`.

**Why the two backends differ, quoted.** On `promise` the same program logs the same
`park task=0 class=4 (JOB_DONE) key=1` and then the host's loop keeps ticking
(`iteration=1 … 9 …`), because that backend's loop is the thing that pumps completions. On
fiber the park resolves without a loop pass at all.

**This is engine shape, so the round stops at the diagnosis.** The shape of the fix is a
decision about who drives the loop while a drained body is parked: either the drain holds the
loop open (re-entering the frame/post machinery per iteration until the queue is empty and no
task is parked), or `drain_ready` yields to the existing loop instead of running to
completion, or a drained body's park is refused by name at compile time. Each changes what
"the host owns the loop" means, and that is the user's call, not a patch.

**What this costs the corpus:** the four OGRE examples and `hello-triangle` do not work on
fiber, and `async-io`'s `Unexpected 'null'` at `~lib/task.ts:405` is very likely the same
family (a task whose completion never arrived while its body ran under the drain). The
`--stackful-backend promise` declarations stay, per DL62's decision.

## 3. The three repairs

**I150 — the refusal, asserted.** `scripts/build-test-programs.mjs` said "`spawn_ready.rs`
asserts that refusal"; `spawn_ready.rs` reads committed artifacts and has no compiler, so it
could not. The assertion now lives where a compiler exists:
`TensionScript/tests/compiler/continuation-spawn/spawn-refused.json`, whose expected stderr is
the message **verbatim**. Proven able to fail: changing `nothing drives` to `SOMETHING drives`
in the expectation turns the test red (`[stderr mismatch]`), and restoring it turns it green.

**`schedule-order`, both backends — and which claim holds.** Run at DL63:

```
continuation   value low 1 / value mid 5 / value high 9 / value eager 7 / steps 15
fiber          value low 1 / value mid 5 / value high 9 / value eager 7 / steps 0
```

**Both register claims are true, about different programs.** `schedule-order`'s `main`
*awaits* its tasks, so on continuation its custom step drives the ring during that await
(`steps 15`). What has no driver is a **floating** spawn that nobody awaits, after the entry
has returned — DL61's claim, and the reason for the continuation refusal. The two statements
never described the same program shape, which is why they looked contradictory in the
register.

Getting that number required fixing a hole this round found: **`schedule-order` built for
fiber failed validation**

```
call target must exist, on (call $~lib/task-stack/$hostReady (local.get $1))
```

— because `__readySubmit` added the `scheduler::ready` import from a flag consumed by a block
near the end of `compile()`, and two callers of `__submitTask` (a guest's custom step, and the
override stubs) compile *after* it. The committed pin fails the same way, so this has been
latent since DL61: no gate built that program for fiber. The import is now added inside the
builtin at the call site, so no pass order can separate them. Byte-neutral in Tension
(`--check` 10/10, delta none).

**I151 — the citation.** `ready.rs` cited `tests/ready_queue.rs`, which does not exist, *and*
the invariant it named ("accepted equals served") was asserted nowhere. The citation now names
`accepted_equals_served_after_a_full_drain`, a test added beside it that asserts the property.
A citation to a file that is not there is the same defect as a green table over a broken
guest: a claim with no mechanism.

**I152 — the spawn example's bodies.** `yieldOnce()` had no `await`, so by DL59's recorded
lesson it was never lowered and the comment claiming "two suspensions" was false. The body now
awaits `rt.frame()`, and the artifact says so:

```
examples/spawn/build/game.wasm: __driveSlot  park  ready
```

`probe/spawn-park.ten` + `spawn_ready.rs`'s fourth test assert that import, so the claim can
fail. The transcript also records the fix's limit honestly — `step 1 (frame 0)`: the park
compiled, and (per §2) it did not wait.

## 4. Gates

| gate | result |
|---|---|
| `--check` (`TENSIONSCRIPT_DIR` set) | **10/10 links PASS**, delta **none** |
| threads · fiber · fiber-executor · fiber-runner | **15 · 6 · 7 · 5** |
| async_on_main · async_main_promise · debugger | **2 · 2 · 5** |
| park_frame · input_sources · spawn_ready · async_method | **2 · 1 · 4 · 4** |
| `--bin` | **312 passed** (311 + the new `ready` invariant) |
| `build:examples` | **23 of 23**, exit 0 |
| census, declared | **15 ran · 1 ran-but-failed · 1 hung · 1 refused** |
| census, fiber | **9 ran · 4 ran-but-failed · 2 hung · 1 needs-display · 1 failed · 1 refused** |
| `examples/spawn`, ten runs | **10/10 identical** |
| classifier test | **9 checks**, each with a control; **a CI step** |
| TensionScript | build + `bootstrap:debug` + `bootstrap:release` + suite: green, **zero `fixture mismatch`** |
| CI | Tension **success** `46101225279` @ `0af037b2` (head, docs) and `46099816389` @ `357623e8` (code) · TensionScript **success** `46099819059` @ `dc4337fb` (head) |

**What is in CI and what is not.** The classifier test is now a job step — it is a pure
function over transcripts, so it needs no compiler, no corpus and no GPU. The **backend
sweep is not**: it needs a built corpus (~4 min), which needs the vendored compiler, and OGRE
examples need a display or a null renderer plus the adapter. Moving it needs a job with
`build:examples` + a 4-minute budget + the render stack; the honest small version would run
the **headless subset** (`ai async-on-main audio io log res solver/wasm solver/world spawn`)
in both profiles, which is GPU-free. That is not added this round, per decision 6's shape.

**Sample-size line: 9 checks** (the classifier), **4 tests** (`spawn_ready`), **4 tests**
(`async_method`) — the numbers the gates above rest on.

## 5. What the tree contradicted in this brief

- **The `-EIO` path.** The brief points at `res/mod.rs:768`/`:869` ("a volume that does not
  parse"). It is not the volume: `res: mounted … (9728 bytes)` succeeds on both backends, and
  the value comes from `loadResult`'s "dropped completion" branch reading a record no producer
  wrote. The mount and the mesh job are different subsystems, and only the second is broken.
- **"`promise` runs these examples"** — mostly not what it seems: `ogre/animated-character`
  crashes on `promise` too (`Index out of range`), and read as `ran` until the new verdict
  existed. So one of the eight declarations was masking a defect on its own backend.
- **`schedule-order`'s two claims** are reconcilable and both true (§3) — but only after the
  fiber build itself was made to validate, which was a latent hole from DL61.
- **`TENSION_RUN_BACKEND` has a sharp edge worth knowing**: the sweep rebuilds in place, so a
  declared-profile run straight afterwards reports nonsense (measured: 4 `ran-but-failed`,
  2 `hung` from stale fiber artifacts). Documented in the script; both tables above were
  taken with `build:examples` between them.

## 6. What I did not verify

- **Windows.** No runner in Tension's CI; the classifier and the sweep were not run there.
  What a Windows runner would need: the same `ubuntu-latest` job plus a `windows-latest`
  matrix entry, the OGRE packages for that platform, and a null-renderer path (which exists —
  `--renderer=null` — so the headless subset would work today).
- **The engine-shape fix.** Not attempted; §2 says why and offers three shapes.
- **`async-io`'s `Unexpected 'null'`** — I believe it is the same family as the `-EIO` but
  did not prove it; it is named as a symptom, not diagnosed.
- **Whether the drain could simply keep the loop running.** Not prototyped — that is the
  decision the round hands back.
- **CI at any commit other than these two.** `46099816389` is green for `357623e8` and
  `46099819059` for `dc4337fb`, both read from `gh run list` **bound to that SHA** — not
  carried over from an earlier head, which is how DL62's report came to be wrong about
  `d67b490`.
