//! P8d tests: the world evaluator — loading compiled bytes and computing
//! f(t, y).
//!
//! T1–T12 are the phase brief's cases. T13 pins A3's no-allocation rule
//! with a counting global allocator: the counter is thread-local, so a
//! sibling test's allocations cannot leak into the measurement.
//!
//! The tests compile their worlds through the real compiler (P8c) and load
//! them through the real loader, so both halves of the seam are exercised;
//! the malformed inputs of T10 are compiled worlds patched at documented
//! offsets.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use tension_core::world::{compile, World, WorldError};

thread_local! {
    /// Allocations made by *this* thread; the allocator below bumps it.
    static LOCAL_ALLOCS: Cell<usize> = const { Cell::new(0) };
}

/// Counts allocations so T13 can assert `eval` makes none. `try_with`
/// keeps the allocator sound during thread teardown, when the counter is
/// already gone.
struct CountingAllocator;

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let _ = LOCAL_ALLOCS.try_with(|count| count.set(count.get() + 1));
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let _ = LOCAL_ALLOCS.try_with(|count| count.set(count.get() + 1));
        System.realloc(ptr, layout, new_size)
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn allocations() -> usize {
    LOCAL_ALLOCS.with(Cell::get)
}

fn bytes(yaml: &str) -> Vec<u8> {
    compile(yaml).unwrap_or_else(|e| panic!("compiles: {e}\nyaml:\n{yaml}"))
}

fn load(bytes: &[u8]) -> World<'_> {
    World::load(bytes).unwrap_or_else(|e| panic!("loads: {e}"))
}

fn eval(world: &World<'_>, t: f64, y: &[f64], out: &mut [f64]) {
    world
        .eval(t, y, out)
        .unwrap_or_else(|e| panic!("evaluates: {e}"));
}

/// Assert componentwise agreement within 1e-12.
#[track_caller]
fn assert_close(got: &[f64], want: &[f64]) {
    assert_eq!(got.len(), want.len(), "slot counts");
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        assert!((g - w).abs() <= 1e-12, "slot {i}: got {g}, want {w}");
    }
}

const SPRING_TO_ANCHOR: &str = r#"version: 1
dimensions: 2
components:
  - type: anchor
    name: pivot
  - type: point_mass
    name: bob
    mass: 1.0
connections:
  - type: spring
    name: rod
    from: pivot
    to: bob
    stiffness: 4.0
    rest_length: 1.0
"#;

/// T7's world: two point masses, a damped spring between them, gravity on
/// both.
const TWO_BODIES: &str = r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: a
    mass: 2.0
  - type: point_mass
    name: b
    mass: 1.0
connections:
  - type: spring
    name: link
    from: a
    to: b
    stiffness: 10.0
    rest_length: 1.0
    damping: 0.5
  - type: gravity
    acceleration: [0.0, -10.0]
"#;

/// The 96-byte minimal world: one point_mass, no connections.
fn minimal_world() -> Vec<u8> {
    bytes(
        "version: 1\ndimensions: 2\ncomponents:\n  - type: point_mass\n    name: ball\n    mass: 2.5\nconnections: []\n",
    )
}

// ═══ T1 ═════════════════════════════════════════════════════════════════
// A world whose components contribute no state: dim 0, and eval on empty
// slices is a no-op success.

#[test]
fn t1_anchors_only_dim_zero() {
    let b = bytes(
        "version: 1\ndimensions: 2\ncomponents:\n  - type: anchor\n    name: pivot\nconnections: []\n",
    );
    let world = load(&b);
    assert_eq!(world.dim(), 0);
    assert_eq!(world.dimensions(), 2);
    eval(&world, 0.0, &[], &mut []);
}

// ═══ T2 ═════════════════════════════════════════════════════════════════
// One point_mass, no connections: position' = velocity, velocity' = 0.

#[test]
fn t2_point_mass_without_forces() {
    let b = bytes(
        "version: 1\ndimensions: 2\ncomponents:\n  - type: point_mass\n    name: p\n    mass: 1.0\nconnections: []\n",
    );
    let world = load(&b);
    assert_eq!(world.dim(), 4);
    let mut out = [0.0; 4];
    eval(&world, 0.0, &[1.0, 2.0, 3.0, 4.0], &mut out);
    assert_eq!(out, [3.0, 4.0, 0.0, 0.0]);
}

// ═══ T3 ═════════════════════════════════════════════════════════════════
// Gravity is an acceleration: f = force / mass = mass·a / mass = a,
// whatever the mass is.

#[test]
fn t3_gravity_is_acceleration() {
    let b = bytes(
        "version: 1\ndimensions: 2\ncomponents:\n  - type: point_mass\n    name: p\n    mass: 2.0\nconnections:\n  - type: gravity\n    acceleration: [0.0, -9.8]\n",
    );
    let world = load(&b);
    let mut out = [0.0; 4];
    eval(&world, 0.0, &[1.0, 2.0, 3.0, 4.0], &mut out);
    assert_close(&out, &[3.0, 4.0, 0.0, -9.8]);
}

// ═══ T4 ═════════════════════════════════════════════════════════════════
// A harmonic oscillator at rest and displaced: hand-computed f.
//
//   at rest      bob [1,0], dist == rest_length      -> f = [0,0, 0,0]
//   displaced    bob [2,0], dist 2, stretch 1        -> magnitude -4·1
//                along +x̂ (pivot→bob), so on bob:     f = [0,0, -4,0]

#[test]
fn t4_spring_at_rest_and_displaced() {
    let b = bytes(SPRING_TO_ANCHOR);
    let world = load(&b);
    assert_eq!(world.dim(), 4);

    let mut out = [0.0; 4];
    eval(&world, 0.0, &[1.0, 0.0, 0.0, 0.0], &mut out);
    assert_eq!(out, [0.0, 0.0, 0.0, 0.0], "dist == rest_length");

    eval(&world, 0.0, &[2.0, 0.0, 0.0, 0.0], &mut out);
    assert_close(&out, &[0.0, 0.0, -4.0, 0.0]);
}

// ═══ T5 ═════════════════════════════════════════════════════════════════
// The sign convention, compressed: a spring shorter than its rest length
// pushes its ends apart.
//
//   pivot [0,0], bob [1,0], rest_length 2 (compression 1)
//     magnitude -4·(1-2) = +4 along +x̂ (pivot→bob, pointing away from
//     the pivot) -> f = [0,0, +4,0]
//
// (The brief's "bob at [-1,0]" with rest_length 1 is at rest_length, not
// compressed — dist 1 == rest 1 — and is asserted as the zero case below.)

#[test]
fn t5_spring_compressed_pushes_out() {
    let yaml = SPRING_TO_ANCHOR.replace("rest_length: 1.0", "rest_length: 2.0");
    let b = bytes(&yaml);
    let world = load(&b);
    let mut out = [0.0; 4];
    eval(&world, 0.0, &[1.0, 0.0, 0.0, 0.0], &mut out);
    assert_close(&out, &[0.0, 0.0, 4.0, 0.0]);

    // The brief's geometry, spelled out: dist == rest_length is zero force
    // on either side of the anchor.
    let b = bytes(SPRING_TO_ANCHOR);
    let world = load(&b);
    eval(&world, 0.0, &[-1.0, 0.0, 0.0, 0.0], &mut out);
    assert_eq!(out, [0.0, 0.0, 0.0, 0.0]);
}

// ═══ T6 ═════════════════════════════════════════════════════════════════
// Damping opposes radial motion, and it acts even with zero displacement:
//
//   bob [1,0], dist == rest_length (spring term 0), v = [1,0]
//     radial speed v_rel·x̂ = 1, c = 2 -> force -2·x̂
//       -> f = [1,0, -2,0]   (f_vel_y = 0; f_vel_x < 0, opposing +x̂)

#[test]
fn t6_damping_opposes_motion() {
    let yaml = SPRING_TO_ANCHOR.replace(
        "    rest_length: 1.0\n",
        "    rest_length: 1.0\n    damping: 2.0\n",
    );
    let b = bytes(&yaml);
    let world = load(&b);
    let mut out = [0.0; 4];
    eval(&world, 0.0, &[1.0, 0.0, 1.0, 0.0], &mut out);
    assert_close(&out, &[1.0, 0.0, -2.0, 0.0]);
}

// ═══ T7 ═════════════════════════════════════════════════════════════════
// Springs, damping, gravity, and two masses composed; hand-computed:
//
//   a: mass 2 at [0,0] v [0,0]; b: mass 1 at [2,0] v [1,0]
//   spring a→b: dist 2, stretch 1, radial 1
//     F = -10·1 - 0.5·1 = -10.5 along +x̂ (a→b)
//     force on b: -10.5·x̂ ; on a: +10.5·x̂
//   gravity: force = m·[0,-10]
//     a: total [10.5, -20] -> accel [5.25, -10]
//     b: total [-10.5, -10] -> accel [-10.5, -10]
//   f = [a.vel, a.accel, b.vel, b.accel]
//     = [0, 0, 5.25, -10, 1, 0, -10.5, -10]

#[test]
fn t7_two_bodies_composed() {
    let b = bytes(TWO_BODIES);
    let world = load(&b);
    assert_eq!(world.dim(), 8);
    let y = [0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 1.0, 0.0];
    let mut out = [0.0; 8];
    eval(&world, 0.3, &y, &mut out);
    assert_close(&out, &[0.0, 0.0, 5.25, -10.0, 1.0, 0.0, -10.5, -10.0]);
}

// ═══ T8 ═════════════════════════════════════════════════════════════════
// A kinematic body: position' = velocity from y, velocity' = 0 — always,
// even with a spring pulling on it. The spring moves the other end.

#[test]
fn t8_kinematic_velocity_slots_stay_zero() {
    let b = bytes(
        r#"version: 1
dimensions: 2
components:
  - type: kinematic
    name: k
  - type: point_mass
    name: p
    mass: 1.0
connections:
  - type: spring
    name: link
    from: k
    to: p
    stiffness: 4.0
    rest_length: 1.0
"#,
    );
    let world = load(&b);
    let y = [0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0];
    let mut out = [0.0; 8];
    eval(&world, 0.0, &y, &mut out);
    // k: [pos' = vel = 0,0] [vel' = 0,0]; p: [pos' = vel = 0,0] [vel' = -4,0]
    assert_close(&out, &[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -4.0, 0.0]);
}

// ═══ T9 ═════════════════════════════════════════════════════════════════
// Purity: the same (t, y) gives bit-identical out, with a different call
// in between to catch any hidden state.

#[test]
fn t9_purity_bit_identical() {
    let b = bytes(TWO_BODIES);
    let world = load(&b);
    let y = [0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 1.0, 0.0];
    let mut first = [0.0; 8];
    let mut scratch = [0.0; 8];
    let mut second = [0.0; 8];
    eval(&world, 0.3, &y, &mut first);
    eval(&world, 7.0, &[9.0; 8], &mut scratch);
    eval(&world, 0.3, &y, &mut second);
    assert_eq!(
        first.map(f64::to_bits),
        second.map(f64::to_bits),
        "same (t, y) must give bit-identical f"
    );
}

// ═══ T10 ════════════════════════════════════════════════════════════════
// The loader's refusals: compiled worlds with one field patched, at the
// documented offsets (DESIGN.md §4).

#[test]
fn t10_bad_magic_refused() {
    let mut b = minimal_world();
    b[0] = b'X';
    assert_eq!(World::load(&b).unwrap_err(), WorldError::BadMagic);
}

#[test]
fn t10_bad_version_refused() {
    let mut b = minimal_world();
    b[8..10].copy_from_slice(&2u16.to_le_bytes());
    assert_eq!(
        World::load(&b).unwrap_err(),
        WorldError::BadVersion { found: 2 }
    );
}

#[test]
fn t10_bad_flags_refused() {
    for (off, what) in [(13usize, "flags"), (14, "reserved"), (36, "reserved2")] {
        let mut b = minimal_world();
        b[off] = 1;
        assert_eq!(World::load(&b).unwrap_err(), WorldError::BadFlags, "{what}");
    }
}

#[test]
fn t10_bad_dimensions_refused() {
    let mut b = minimal_world();
    b[12] = 4;
    assert_eq!(
        World::load(&b).unwrap_err(),
        WorldError::BadDimensions { found: 4 }
    );
}

#[test]
fn t10_count_too_large_refused() {
    let mut b = minimal_world();
    b[16..20].copy_from_slice(&5u32.to_le_bytes()); // room for one entry, not five
    assert_eq!(World::load(&b).unwrap_err(), WorldError::Truncated);
}

#[test]
fn t10_bad_offset_refused() {
    // The connection table offset doesn't land where the component walk
    // ends.
    let mut b = minimal_world();
    b[28..32].copy_from_slice(&89u32.to_le_bytes());
    assert_eq!(World::load(&b).unwrap_err(), WorldError::BadOffset);

    // The name table would start inside the component table.
    let mut b = minimal_world();
    b[32..36].copy_from_slice(&40u32.to_le_bytes());
    assert_eq!(World::load(&b).unwrap_err(), WorldError::BadOffset);

    // A file with no name table must end where its tables do.
    let mut b = minimal_world();
    b[32..36].copy_from_slice(&0u32.to_le_bytes());
    assert_eq!(World::load(&b).unwrap_err(), WorldError::BadOffset);
}

#[test]
fn t10_bad_reference_refused() {
    let base = bytes(
        r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: a
    mass: 1.0
  - type: anchor
    name: b
connections:
  - type: spring
    name: s
    from: a
    to: b
    stiffness: 1.0
    rest_length: 1.0
"#,
    );
    let conn = u32::from_le_bytes(base[28..32].try_into().unwrap()) as usize;

    // `to` names no component.
    let mut b = base.clone();
    b[conn + 12..conn + 16].copy_from_slice(&9u32.to_le_bytes());
    assert_eq!(
        World::load(&b).unwrap_err(),
        WorldError::BadReference { connection: 0 }
    );

    // A binary connection must not carry gravity's sentinel endpoint.
    let mut b = base.clone();
    b[conn + 8..conn + 12].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
    assert_eq!(
        World::load(&b).unwrap_err(),
        WorldError::BadReference { connection: 0 }
    );

    // Gravity must carry the sentinel on both ends.
    let gravity = bytes(
        "version: 1\ndimensions: 2\ncomponents: []\nconnections:\n  - type: gravity\n    acceleration: [0.0, -9.8]\n",
    );
    let conn = u32::from_le_bytes(gravity[28..32].try_into().unwrap()) as usize;
    let mut b = gravity.clone();
    b[conn + 8..conn + 12].copy_from_slice(&0u32.to_le_bytes());
    assert_eq!(
        World::load(&b).unwrap_err(),
        WorldError::BadReference { connection: 0 }
    );
}

// ═══ T11 ════════════════════════════════════════════════════════════════
// Declaration order fixes the slot layout, and anchors contribute none of
// it: with a=0, b=1 (anchor), c=2, the state is (a.pos, a.vel, c.pos,
// c.vel) — eight slots, not twelve — while the connections keep naming
// components by table index.
//
//   a [0,0.5] v 0 (mass 1); c [0,2] v 0 (mass 1); b the anchor at [0,0]
//   spring a→c: dist 1.5, magnitude -2 → force on a +2·ŷ, on c -2·ŷ
//   spring c→b: dist 2, magnitude -4 → force on c -4·ŷ (b is the anchor)
//   f = [a.vel, a.force, c.vel, c.force] = [0,0, 0,2, 0,0, 0,-6]

#[test]
fn t11_slot_order_skips_anchors() {
    let b = bytes(
        r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: a
    mass: 1.0
  - type: anchor
    name: b
    position: [0.0, 0.0]
  - type: point_mass
    name: c
    mass: 1.0
connections:
  - type: spring
    name: ac
    from: a
    to: c
    stiffness: 4.0
    rest_length: 1.0
  - type: spring
    name: cb
    from: c
    to: b
    stiffness: 4.0
    rest_length: 1.0
"#,
    );
    let world = load(&b);
    assert_eq!(world.dim(), 8, "anchors contribute no slots");

    // The binary's references are component-table indices: a=0, b=1, c=2.
    let conn = u32::from_le_bytes(b[28..32].try_into().unwrap()) as usize;
    let word = |off: usize| u32::from_le_bytes(b[off..off + 4].try_into().unwrap());
    assert_eq!((word(conn + 8), word(conn + 12)), (0, 2), "spring a→c");
    let second = conn + 40; // both springs are 40 bytes
    assert_eq!((word(second + 8), word(second + 12)), (2, 1), "spring c→b");

    let y = [0.0, 0.5, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0];
    let mut out = [0.0; 8];
    eval(&world, 0.0, &y, &mut out);
    assert_close(&out, &[0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, -6.0]);
}

// ═══ T12 ════════════════════════════════════════════════════════════════
// The pin decision (a): a pin is structurally a world (it compiles, it
// loads), but a rigid constraint has no force form, so evaluation refuses
// it by name.

#[test]
fn t12_pin_refused_at_eval() {
    let b = bytes(
        r#"version: 1
dimensions: 2
components:
  - type: point_mass
    name: bob
    mass: 1.0
  - type: anchor
    name: wall
    position: [0.0, 0.0]
connections:
  - type: pin
    name: arm
    from: bob
    to: wall
    offset: [1.0, 0.0]
"#,
    );
    let world = load(&b);
    let mut out = [0.0; 4];
    let err = world.eval(0.0, &[1.0, 0.0, 0.0, 0.0], &mut out).unwrap_err();
    assert_eq!(
        err,
        WorldError::UnsupportedConnection {
            index: 0,
            tag: 2,
            name: Some("arm")
        }
    );
    let text = err.to_string();
    assert!(text.contains("`arm`"), "names the connection: {text}");
    assert!(
        text.contains("not implemented in v1"),
        "says v1 does not implement it: {text}"
    );
}

// ═══ T13 ════════════════════════════════════════════════════════════════
// A3, proven rather than asserted in prose: one eval call allocates
// nothing.

#[test]
fn t13_eval_allocates_nothing() {
    let b = bytes(TWO_BODIES);
    let world = load(&b);
    let y = [0.0, 0.0, 0.0, 0.0, 2.0, 0.0, 1.0, 0.0];
    let mut out = [0.0; 8];
    eval(&world, 0.3, &y, &mut out); // warm-up, outside the window

    let before = allocations();
    eval(&world, 0.3, &y, &mut out);
    let during = allocations() - before;
    assert_eq!(during, 0, "eval allocated {during} time(s)");
}
