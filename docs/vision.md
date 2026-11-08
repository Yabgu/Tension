# Vision

What Tension is for, what "done" means at each stage, and the decisions that are
not in the code because they are choices rather than behaviour.

Every other document in this tree is derived from source and cites `file:line`.
This one is not. It records intent: what we are building, what we are
deliberately not building, what we are postponing and what would unblock each
postponement, and which questions are still open. Where a decision has already
been made in code, the entry says so and cites it — those are marked **[V]**. A
claim about intent carries no marker, because intent is not a fact about the tree.

If this document and the code disagree about *what the code does*, the code is
right. If they disagree about *what we want*, this document is the record of the
want, and the discrepancy is a bug in the code.

## 1. What Tension is

Tension is a runtime where a host owns the machine and guests own their worlds.
It is deterministic by construction: same inputs, same outputs, on the same
machine or not. It is a development platform, not a game engine — the editor, the
language, and the toolchain are all part of the product.

The three sentences are load-bearing, in that order. The host owns the window,
the GPU instance, the audio device, the clock and the filesystem
(`docs/architecture.md` §2). The guest is a WebAssembly module that must never
learn that SDL3 or Vulkan exist (`tension-core/include/tension_adapter.h:35-36`
— the boundary header includes nothing but `<stddef.h>` and `<stdint.h>`). And
determinism is an architectural property, not an aspiration: the host contributes
no clock, no `dt`, and no wall time to the guest, so guest simulation is
reproducible because nothing outside the guest can vary it
(`docs/architecture.md` §1, §4 **[V]**).

"Development platform, not a game engine" is the sentence that decides most of
the deferrals below. A game engine sells a renderer; a platform sells the loop
from an idea to a running, debuggable, shippable build. The renderer is one
capability among several, and it is replaceable.

## 2. Alpha → beta

**Alpha ends at a specific moment, not by decay.** The moment is: everything
below is true at once.

1. Documentation matches code — every hand-written page derived from source, no
   design note contradicting the tree.
2. Four capability DSOs consume the host surface: Ogre (done), 2D, input, and a
   fourth.
3. No `DESIGN.md` file exists anywhere as a contradiction vector.
4. The examples are full demos, not snippets: collision, box physics, save/load,
   restart, a real UI.
5. Win32 is runtime-tested, not merely compiled.
6. Test-suite startup is enforced — a suite that cannot start fails rather than
   passing by absence (`docs/guard-discipline.md` "The other half").
7. The ABI is frozen.

**Beta begins when this works:**

```
npx create-tension-app && cd my-game && npx tension dev
```

produces a running game, and `npx tension editor` opens a command-driven editor
that can build that game for Linux and Windows.

**The ABI freeze is the transition, not a slow decay.** Before it, the ABI is
alpha and append-only is discipline rather than a promise
(`tension-core/include/tension_adapter.h:17-22` **[V]**). At the freeze it
becomes a compatibility promise, and the version number starts meaning what a
version number usually means. This is a single decision with a date, made once,
not a gradual tightening.

## 3. Beta features

Ordered by dependency, not by importance. Everything here ships with beta or is
explicitly cut in §6.

### 3.1 The editor — the defining beta feature

The editor is what makes Tension a platform rather than a runtime with examples.

- **Command-controlled throughout.** Every button, menu item and keyboard
  shortcut runs a named, parameterized command. There is no action in the editor
  that is not reachable as a command.
- **The command system is an engine feature, not an editor feature.** Commands
  are a public API — the same system a guest uses to drive the editor, a mod uses
  to extend it, and a script uses to automate it.
- **Undo/redo is mandatory**, which means every command must be invertible. That
  is a constraint on the command system's design, not a feature added on top.
- **Panels:** property inspector, scene tree, script editor, asset browser,
  preview viewport, command palette.
- **Single window first.** Multi-window is deferred (§5).
- **Editor-as-guest versus host-tool is OPEN** (§4.2). This is the largest
  architectural question left in the project.

### 3.2 Authoring

- **TensionScript stable enough for real games**, with syntax frozen at beta.
- **A CSS-like property language** — selectors, cascade, inheritance — which
  compiles to a flat array. Authoring stays declarative; storage stays flat.
- **The DOM model is an optional runtime overlay**; the flat array is the default
  storage model (§4.1).
- **Save/load: versioned, forward-compatible, with a migration path.** This is a
  constraint that locks the world model — the format cannot be designed after the
  object model, because it is a projection of it.
- **Asset pipeline:** source → intermediate → shipped format. The intermediate
  format is OPEN (§4.4).

### 3.3 Content

Ships with beta:

- **Pipelines: five to ten curated** — `default_3d`, unlit, PBR, PBR+HDR, and
  post-processing (bloom, tonemap, FXAA).
- **Game controls:** action mapping, rebinding, controller support, dead zones,
  vibration.
- **Animation:** state machines, blending, root motion, retargeting.
- **Audio:** 3D positional, mixers, effect chains, streaming music.
- **Shaders:** user-authored, hot-reloadable, graph or GLSL.
- **Colour profiles:** sRGB, Display P3, Rec.2020; HDR10, HLG; linear versus
  gamma working space. The HDR discussion lands here and is deferred for the
  render path (§5.1) while the colour-management API is part of beta.
- **Box physics and collision.**
- **Examples as full demos** — collision, box physics, save/load, restart, proper
  UI. Not snippets: the examples are the documentation of what a game looks like.

### 3.4 AI — a research direction, not a feature

- **Inference:** llama.cpp embedded. Working today.
- **Training:** 0.01b — ten-million-parameter — custom models for AI controls,
  retrainable on consumer hardware. Not domain-tuned llama.
- **The novel bit:** training on guest-side steps is reproducible. Almost no ML
  pipeline can claim the same trajectory twice; a deterministic guest makes the
  training run a function of its inputs.

This category ships when the research lands, not on a schedule. It is listed
because it constrains the world model (see the open question in §4.3), not
because beta blocks on it.

### 3.5 Distribution

- **NPM package.** `npx create-tension-app`, `tension dev`, `tension build`,
  `tension editor`, `tension package`, `tension test`.
- **The editor is a development dependency, never part of a shipped game.**
  Because the editor is a guest built against the same ABI as a game (§4.2), it
  installs into a project's development toolchain and the runtime bundle
  `tension build` produces carries no reference to it. How the packages are
  split on npm follows from that; the split itself is not decided here.
- **A project template** — what a Tension project looks like on disk is a
  decision the scaffold makes, and everything else hangs off it.
- **Compiled HTML documentation**: searchable, versioned, cross-linked. The
  generator choice is OPEN.

### 3.6 Debugging and iteration

- **Hot reload:** edit a script, see the change, without restarting.
- **Time-travel debugging and replay.** Deterministic guests make record-replay
  nearly free. "Rewind to any frame, change one input, see what differs" is the
  headline feature of the platform, and it is only possible because the host
  contributes no clock (§7). It runs on the restorable snapshot primitive of
  §4.3 — the same primitive save/load is built on.
- **Profiling:** per-frame, per-guest-function, and GPU cost.
- **Live property editing** in the inspector.

### 3.7 Ecosystem

- **Mod support** — nearly free given deterministic guests and a command system.
- **A third-party library story.** npm? Rust crates? TensionScript-only? OPEN.
- **An example gallery** of the full demos from §3.3.

### 3.8 Non-goals for beta

Stated so they do not creep in:

- Localization and i18n.
- Accessibility — screen readers, controller-only navigation.
- A marketplace or package hosting.
- Mobile.
- Console.
- Multiplayer (§4.3). Rollback netcode is deferred, not built (§5.6).

## 4. Decisions before beta

Five decisions that must be made before the beta work starts, in the sense that
later work does not survive getting them wrong. Four are made; one is open.

### 4.1 CSS / DOM / flat array — **DECIDED**

Authoring is CSS-like and compiles to a flat array. The DOM model is an optional
runtime overlay. Flat array is the default storage model.

The reason this needs deciding early: it decides what a saved game is, what the
editor manipulates, and what a mod patches. Authoring syntax can change; the
storage model cannot, because it is what the save format and the replay format
are projections of.

### 4.2 Editor as guest — **DECIDED**

The editor is itself a Tension guest, built against the same ABI games use,
shipped as a development dependency and never in a game's runtime bundle. The
rationale is the dogfood value: every friction point the editor hits is one real
users hit, and it forces the guest ABI to be complete before beta rather than
after. The cost is that the guest ABI must support a generic "opens a project
directory given on the command line" pattern, which is more than a self-contained
game needs.

**Open design point, deferred to beta:** project-path access for the editor
guest. A game guest reads its host-assembled resource library; the editor guest
must read the user's project directory. The options identified are (a) the CLI
mounts the project directory as an additional resource library under a known
name, (b) a new host verb, something like `tension::host.project_path()`, or
(c) a convention on the working directory. None is chosen. This is not solved in
alpha.

### 4.3 Multiplayer — deferred, snapshot/restore prepared — **DECIDED**

No multiplayer, no network subsystem, and no prediction or reconciliation in
beta.

**What is built anyway is the primitive.** The snapshot the world model produces
is **restorable, not merely serializable**: it can be applied atomically and
repeatedly, including RNG state, timing state, and epoch state. This is nearly
free when designed in from the start and expensive as a retrofit, so it is
designed in now. Rollback later becomes a small addition on top of an existing
primitive, not a save-format migration and snapshot redesign. The same primitive
serves time-travel debugging (§3.6), so the cost is amortized beyond
multiplayer.

Multiplayer itself remains a beta non-goal (§3.8); rollback is deferred with the
primitive in place (§5.6).

### 4.4 Asset pipeline intermediate format — **OPEN**

- **glTF.** Ecosystem, Blender-friendly, tooling exists. Some lock-in to the
  glTF data model.
- **Source-native.** No lock-in, but more per-tool work and no tooling that
  already speaks it.

Not decided. The pipeline shape — source → intermediate → shipped — is decided;
only the middle format is not.

### 4.5 AI training scope — **DECIDED**

0.01b (ten-million-parameter) custom models for AI controls, retrainable on
consumer hardware. Explicitly **not** domain-tuned llama.

The decision is what makes the training story tractable: a model small enough to
retrain on a laptop, trained on a deterministic guest's own steps, is a different
product from a fine-tuned large model, and only the first one is compatible with
the determinism claim.

## 5. Deliberate deferrals

Each of these is a decision to *not* build something now, with the reason and the
condition that would reopen it. A deferral is not a gap; it is a choice with a
trigger.

### 5.1 HDR output

**What:** high-dynamic-range presentation from the renderer.
**Why not now:** the path is three parts and only the first is ours. The
swapchain colour-space extension has to be enabled on the host's instance; the
Ogre-Next format chooser has to be patched to pick an HDR format; and the
compositor/pipeline decision has to be made about where tonemapping happens.
Ogre-Next has no output-HDR path today, so two of the three parts are work in a
submodule we do not own.
**Unlocks when:** the colour-management API (§3.3) exists. That gives the
pipeline something to target, and makes the swapchain work testable against a
known expectation instead of a guess.

### 5.2 2D window ownership

**What:** `tension-2d` creating its own `SDL_Window` rather than rendering into
the host's surface (`docs/modules/2d.md` §3; contradiction 24).
**Why not now:** SDL_GPU offers no external-surface handoff. Unifying means the
2d path either gains a renderer that consumes a `VkSurfaceKHR` the way
`tension-ogre` does, or SDL_GPU grows the capability upstream. It is a separate
capability path, not a parameter.
**Unlocks when:** either upstream support exists, or the 2d renderer is rewritten
onto the host's Vulkan surface.

### 5.3 Win32 runtime testing

**What:** running the test suite on Windows, not merely cross-compiling it.
**Why not now:** needs the user's Windows machine, and needs a Win32 variant of
`ogre_host_surface` — the host-owned-surface test path exists only on the Linux
rig today.
**Unlocks when:** those two exist. Level 2 of the Windows story is
"runtime-tested"; level 3 would be "shipped", and shipping is out of scope.

### 5.4 Multi-window editor

**What:** the editor with more than one window.
**Why not now:** the v6 ABI exposes one `HostSurface` per process
(`docs/architecture.md` §2). A second window is an ABI extension, not an editor
feature.
**Unlocks when:** the ABI gains a surface set, or the editor settles for one
window and a docked panel layout.

### 5.5 Input v7 rework

**What:** the input capability's dispatcher moves into the core; the DSO becomes
a subscriber; `register_event_layer` and the `window_handle` re-point land.
**Why not now:** it is scheduled as its own pass, and it owns `INPUT.md` and
`tension-input/DESIGN.md` — both of which still describe an X11 premise the
architecture has left behind.
**Unlocks when:** that pass opens. Nothing blocks it.

### 5.6 Rollback netcode

**What:** input prediction, reconciliation, and rolling guest state back to a
confirmed frame across a network.
**Why not now:** multiplayer is not in beta (§4.3). The primitive it needs is
built anyway — the snapshot is restorable, not merely serializable — so what is
deferred is the network layer on top of a primitive that save/load and
time-travel debugging require regardless.
**Unlocks when:** post-beta. Rollback is a small addition on top of the existing
snapshot; multiplayer is a larger addition on top of rollback.

## 6. Deliberate non-builds

The anti-vision. Each of these has been proposed, considered, and rejected. They
are listed so the argument does not have to be had twice.

**No second WebAssembly runtime for capabilities.** Capabilities are native
DSOs, not wasm modules. A wasm capability would need its own instance, its own
memory, and a second copy of the ABI across a runtime boundary, to buy isolation
that `dlopen` plus the vtable already provides for code we control.

**No scripting language for the host.** TensionScript is for guests. The host is
Rust and C++, and a scripting layer in the host would be a second language for
the same job, with a second set of bindings to keep in step.

**No host-side clock.** The host wakes the guest; it does not tell it what time
it is. There is no clock import, no `dt` on the frame wake, and no `tick(dt)`
callback (`docs/architecture.md` §1, §4 **[V]** — no import matching `clock`,
`time`, `now` or `elapsed` exists among the core's registrations). Adding one is
a determinism regression, not a convenience.

**No runtime `dt` on the frame wake.** `rt.frame()` resolves to a task whose
payload is the literal `0` (`tension-framework/assembly/runtime/rt.ts:255-257`,
`tension-core/src/main.rs:2098` **[V]**). The wake carries frame identity, never
a delta. A guest that needs elapsed time counts its own wakes.

**No SDL3 dependency in the guest.** The guest must not know SDL3 exists. The
boundary header cannot even name an SDL type (`tension_adapter.h:35-36`), and
that is structural rather than documentary.

**No frozen ABI during alpha.** The ABI is alpha and may break between releases.
Append-only within a version is the discipline we keep because it makes version
bumps catchable; it is not a compatibility promise until beta
(`tension_adapter.h:17-22` **[V]**).

## 7. Constraints that must survive refactoring

The "do not accidentally fix this" list. Each is a property that looks like an
omission to a reader who has not met the reason.

**Frame wake is identity, not time.** `rt.frame()` returns a task whose payload
is `0` — a key, not a delta (`rt.ts:255-257` **[V]**). If a future change makes
it carry elapsed time, guest simulation becomes a function of host jitter and the
determinism claim dies silently. Any change here needs the vision, not just a
review.

**`tension::platform` has no time imports.** Adding one is the same regression by
another door. The absence is verified mechanically in `docs/architecture.md` §4
**[V]**; a new import matching `clock|time|now|elapsed` should fail a test before
it ships.

**Capabilities stay native DSOs.** The adapter boundary is a C vtable with a
version and a layout hash. Moving a capability to wasm would be a second boundary
with its own semantics, and the two would drift.

**Append-only ABI discipline.** Slots are appended, never reordered or removed,
within a version. This is what makes `TENSION_ADAPTER_ABI_VERSION` informative;
break it and the number stops meaning anything.

**Guard discipline: derive the expected value, do not check presence.** A guard
that asks "does this exist?" answers a question nobody asked. See
`docs/guard-discipline.md` for the nine instances and the rule.

**Guard discipline: a guard that never runs is not a guard.** A suite outside the
gate, a harness that cannot start, and a crashed run read as a failed one — all
three produce the same evidence as a passing suite, which is none
(`docs/guard-discipline.md` "The other half").

## 8. Open design questions

Recorded so they are not re-argued from scratch. None of these blocks beta
directly; each changes what beta can claim.

**Session plurality.** `SESSION.md` argues that the API should be plural — more
than one session in a process. The code is one `Option<Session>`
(`docs/architecture.md` §7 **[V]**). Whether beta is plural is open; the
argument is recorded, and `SESSION.md` remains the rationale document.

**Sync mechanism.** Extrapolation, interpolation, hold-last-frame, and
parallel-with-merge are all valid positions for multiplayer sync. None is picked.
The choice interacts with §4.3 — rollback implies snapshot/restore and therefore
a different world model from interpolation.

**Entry-time fault detection.** `docs/session.md` §7 records, as **[I]**, a design
claim that a verb detecting a fault during its own entry returns `-EIO` and moves
the session to FAULTED. The only fault source the code has is a callback trap;
there is no entry-time detector. Whether to build one is open.

**Training-loop determinism as a guarantee.** Reproducible training on guest-side
steps would be a genuine differentiator — almost no ML pipeline can claim the
same trajectory twice. Whether it becomes a guaranteed property (tested, part of
the beta contract) or a happy consequence of determinism is not decided.

## 9. Source of truth

This page records intent. Everything about what the code *does* lives here:

| Topic | Document |
|---|---|
| Ownership, teardown, host loop | `docs/architecture.md` |
| Adapter vtable, slots, offsets | `tension-core/include/tension_adapter.h` + `docs/abi/adapter.md` (generated) |
| Guest imports, signatures | `docs/abi/guest.md` (generated) |
| Session contract — epoch, arena, verbs | `docs/session.md` |
| The Ogre capability | `docs/modules/ogre.md` |
| The 2D capability | `docs/modules/2d.md` |
| Build, guards, CI | `docs/build.md` |
| What is known not to work | `docs/known-limitations.md` |
| Why the guards look like this | `docs/guard-discipline.md` |
| Doc-versus-code contradictions | `/home/acakar/work/docs-contradictions.md` (working file, outside the repo; deleted at beta) |

Where a decision in this page is already implemented, the entry cites the code.
Where it is not, the absence is the fact.

## 10. Sequencing

Ordered by what unblocks what. One paragraph, because a schedule in a vision
document is a fossil the moment it is written — the ordering is the durable part.

The npm scaffold and CLI come first, because they define what a Tension project
is on disk and everything else hangs off that shape. Compiled HTML docs and
proper examples come second, because they pay back for the whole beta. The world
model decision (§4.1–4.4) comes third and must precede anything that manipulates
objects. The snapshot format follows the world model directly, and it is a
*restorable* snapshot rather than one-way serialization (§4.3): save/load and,
later, rollback read the same primitive from two directions. The command system
and its undo/redo come next, because the editor is built out of commands and
nothing else. Then the editor skeleton — single-window, command-driven, and an
editor *guest* built against the same ABI as a game (§4.2), including the
project-path access that decision leaves open. Save/load lands on top of the
snapshot format. Pipelines, game controls, animation and audio run in
parallel with the editor work, because they do not depend on it. AI training
starts early as research and ships when it is ready. Multi-window, hot reload and
time-travel debugging run in parallel once the editor exists to debug. Rollback
netcode and multiplayer are not in this sequence; they are post-beta (§5.6),
resting on the snapshot primitive the fourth step builds. The ABI freeze comes
last, after the world model, the snapshot format and the command system have
settled — freezing before them would freeze the wrong shape.
