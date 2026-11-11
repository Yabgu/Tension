// The mirror's unit gate: what `ingest` makes of one batch, read back through
// `snapshot`.
//
// No window, no SDL, no host. `Mirror` is pure state translation — a batch of
// `tension_event`s in, one state record out — and that is exactly the property
// worth pinning, because the two rules that broke in practice were both in this
// translation and neither of them needed a display to reproduce:
//
//   * **the device id is not a filter** (v7b, measured). SDL 3's X11 backend
//     reports ordinary motion with `which == 0`. A mirror that skipped device 0
//     left `mouse_x`/`mouse_y` at 0,0, and every guest's hit-testing was dead
//     while the buttons still worked — a bug that looks like a viewer bug and is
//     not. The first case below is that regression, in one assertion.
//
//   * **motion is accumulated, never posted** (v7c). One delta per snapshot, and
//     the remainder carries over. The settle window drops the *delta* of the
//     warp that follows an attach; it must not drop the position, because the
//     position is a fact about the pointer rather than about our frame rate.
//
// Built and run by `scripts/test-input.mjs`. Hand-rolled `expect`, no framework:
// this is one translation unit and the report reads better as sentences than as
// macro output.

#include "../src/input.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace tension_input {

// `input.h` declares this; the adapter implements it against the host's logger,
// which a unit test has no host for. Silence is the honest implementation here —
// the one thing worth asserting about a refusal (`-ENOSPC` on the ring) cannot
// be produced without an API table.
void input_log(const std::string &) {}

} // namespace tension_input

namespace {

using namespace tension_input;

int failures = 0;
int checks = 0;

void expect(bool ok, const char *what) {
    ++checks;
    if (!ok) {
        ++failures;
        std::printf("  FAIL: %s\n", what);
    }
}

void expectEq(long long want, long long got, const char *what) {
    ++checks;
    if (want != got) {
        ++failures;
        std::printf("  FAIL: %s (want %lld, got %lld)\n", what, want, got);
    }
}

/// The f32 an event payload word carries, as the host packs it.
int64_t bits(float value) {
    uint32_t word = 0;
    std::memcpy(&word, &value, sizeof(word));
    return static_cast<int64_t>(word);
}

/// One motion event, with the device id on the wire exactly as SDL sent it.
tension_event motion(uint32_t device_id, int32_t x, int32_t y, float dx, float dy) {
    tension_event event{};
    event.family = TENSION_EVENT_MOUSE_MOTION;
    event.flags = device_id;
    event.a0 = x;
    event.a1 = y;
    event.a2 = bits(dx);
    event.a3 = bits(dy);
    return event;
}

tension_event button(uint32_t device_id, uint32_t which, bool down, uint32_t mask) {
    tension_event event{};
    event.family = TENSION_EVENT_MOUSE_BUTTON;
    // `a0` is the button, `a1` the transition, `a3` the mask after it. The
    // device id rides in `flags`, which is the field the old filter read.
    event.flags = device_id;
    event.a0 = which;
    event.a1 = down ? 1 : 0;
    event.a3 = mask;
    return event;
}

StateRecord snapshotOf(Mirror &mirror) {
    StateRecord record{};
    mirror.snapshot(&record, 0);
    return record;
}

/// One key event: `a0` scancode, `a1` keycode, `a2` the modifier set after the
/// transition, `flags` the direction and the repeat bit.
tension_event key(uint32_t scancode, bool down, uint32_t modifiers) {
    tension_event event{};
    event.family = TENSION_EVENT_KEY;
    event.flags = down ? TENSION_KEY_FLAG_DOWN : 0u;
    event.a0 = scancode;
    event.a1 = scancode; /* keycode, unused by the mirror */
    event.a2 = modifiers;
    return event;
}

/// One text event: `flags` bytes of UTF-8 inline in `a0..a3`.
tension_event text(const std::string &typed) {
    tension_event event{};
    event.family = TENSION_EVENT_TEXT;
    event.flags = static_cast<uint32_t>(typed.size());
    int64_t *words[4] = {&event.a0, &event.a1, &event.a2, &event.a3};
    for (size_t index = 0; index < typed.size(); ++index) {
        *words[index / 8] |= static_cast<int64_t>(static_cast<uint8_t>(typed[index]))
                             << ((index % 8) * 8);
    }
    return event;
}

/// A window event whose subtype is in `a0`.
tension_event window(uint32_t subtype) {
    tension_event event{};
    event.family = TENSION_EVENT_WINDOW;
    event.a0 = subtype;
    return event;
}

// ── 1. device id 0 is the ordinary device ───────────────────────────────────
//
// The regression, in full: one motion event carrying device id 0 must move the
// pointer and the delta. With the old filter this case read 0,0 and 0.
void caseDeviceZeroIsNotFiltered() {
    Mirror mirror;
    const tension_event batch[] = {motion(0, 495, 371, 7.0f, -3.0f)};
    mirror.ingest(batch, 1, now_ms());

    const StateRecord state = snapshotOf(mirror);
    expectEq(495, state.mouse_x, "motion with device id 0 updates mouse_x");
    expectEq(371, state.mouse_y, "motion with device id 0 updates mouse_y");
    expectEq(7, state.mouse_dx, "motion with device id 0 accumulates mouse_dx");
    expectEq(-3, state.mouse_dy, "motion with device id 0 accumulates mouse_dy");
    expect(std::fabs(state.mouse_dxf - 7.0f) < 1e-6f, "the float delta survives the wire");
    std::printf("  device-0 motion at 495,371 -> m=%d,%d d=%d,%d\n", state.mouse_x,
                state.mouse_y, state.mouse_dx, state.mouse_dy);
}

// ── 2. a non-zero device id behaves identically ─────────────────────────────
//
// The other half of "no filter": removing the gate must not have made device 0
// the only device. A second mouse, or a touchscreen, arrives with its own id.
void caseOtherDevicesStillWork() {
    Mirror mirror;
    const tension_event batch[] = {motion(3, 12, 34, 1.0f, 2.0f)};
    mirror.ingest(batch, 1, now_ms());

    const StateRecord state = snapshotOf(mirror);
    expectEq(12, state.mouse_x, "device 3 updates mouse_x");
    expectEq(34, state.mouse_y, "device 3 updates mouse_y");
}

// ── 3. the last motion wins, and the deltas add up ──────────────────────────
//
// Position is a level (the newest sample), delta is a flow (the sum). A batch
// of three samples must leave the last position and the total displacement —
// that is what "accumulated, never posted" means in one assertion.
void caseBatchAccumulates() {
    Mirror mirror;
    const tension_event batch[] = {
        motion(0, 100, 100, 2.5f, 0.0f),
        motion(0, 110, 120, 2.5f, 5.0f),
        motion(0, 125, 130, 3.0f, 1.0f),
    };
    mirror.ingest(batch, 3, now_ms());

    const StateRecord state = snapshotOf(mirror);
    expectEq(125, state.mouse_x, "the newest sample is the position");
    expectEq(130, state.mouse_y, "the newest sample is the position (y)");
    expect(std::fabs(state.mouse_dxf - 8.0f) < 1e-6f, "the batch's deltas sum");
    expectEq(8, state.mouse_dx, "the integer delta is the sum's truncation");
}

// ── 4. a snapshot consumes the delta exactly once ───────────────────────────
//
// The guest reads the state per frame; the magnitude of what it sees must not
// depend on how often it asks. Two reads with no motion between them: the
// second is zero.
void caseSnapshotConsumes() {
    Mirror mirror;
    const tension_event batch[] = {motion(0, 10, 10, 4.0f, 4.0f)};
    mirror.ingest(batch, 1, now_ms());

    const StateRecord first = snapshotOf(mirror);
    const StateRecord second = snapshotOf(mirror);
    expectEq(4, first.mouse_dx, "the first snapshot carries the delta");
    expectEq(0, second.mouse_dx, "the second snapshot carries nothing");
    expectEq(10, second.mouse_x, "the position is a level, so it persists");
}

// ── 5. the settle window drops the delta, never the position ────────────────
//
// Attaching is followed by a relative-mode warp: one enormous delta nobody
// wants. `kAttachSettleMs` exists for that. It must not also freeze the
// pointer — a guest that read 0,0 for half a second after attaching could not
// draw a cursor at the position it was about to click.
void caseSettleKeepsPosition() {
    Mirror mirror;
    const uint64_t attached_at = 1'000'000;
    mirror.attach(attached_at);

    const tension_event warp[] = {motion(0, 640, 360, 900.0f, -700.0f)};
    mirror.ingest(warp, 1, attached_at + 5);

    const StateRecord during = snapshotOf(mirror);
    expectEq(640, during.mouse_x, "position is true during the settle window");
    expectEq(360, during.mouse_y, "position is true during the settle window (y)");
    expectEq(0, during.mouse_dx, "the settling warp's delta is dropped");
    expectEq(0, during.mouse_dy, "the settling warp's delta is dropped (y)");

    // And the window closes: real motion after it counts again.
    mirror.ingest(warp, 1, attached_at + kAttachSettleMs + 1);
    const StateRecord after = snapshotOf(mirror);
    expectEq(900, after.mouse_dx, "motion after the settle window counts");
}

// ── 6. zero-delta motion adds nothing ───────────────────────────────────────
//
// This is what the device-id filter was *for*: motion that is not the device's
// — the window moving under a stationary pointer — arrives with a zero delta.
// The accumulator absorbs it by adding nothing, so the filter is not needed to
// keep that noise out.
void caseZeroDeltaAddsNothing() {
    Mirror mirror;
    const tension_event moved_window[] = {motion(0, 200, 150, 0.0f, 0.0f)};
    mirror.ingest(moved_window, 1, now_ms());

    const StateRecord state = snapshotOf(mirror);
    expectEq(200, state.mouse_x, "a window move still reports the pointer's position");
    expectEq(0, state.mouse_dx, "and contributes no displacement");
    expectEq(0, state.mouse_dy, "and contributes no displacement (y)");
}

// ── 7. buttons are state, and device id 0 sets them ─────────────────────────
//
// The half that always worked, kept so a future gate on `flags` fails here too.
void caseButtonsFromDeviceZero() {
    Mirror mirror;
    const tension_event press[] = {button(0, 1, true, 0x1u)};
    mirror.ingest(press, 1, now_ms());
    expectEq(1, snapshotOf(mirror).mouse_buttons, "a left press from device 0 sets bit 0");

    const tension_event release[] = {button(0, 1, false, 0x0u)};
    mirror.ingest(release, 1, now_ms());
    expectEq(0, snapshotOf(mirror).mouse_buttons, "the release clears the mask");

    // `detach` forgets what was held: a button held when the window closed must
    // not read as held when the next attach begins.
    mirror.ingest(press, 1, now_ms());
    mirror.detach();
    expectEq(0, snapshotOf(mirror).mouse_buttons, "detach clears a held button");
}

// ── 8. the state record is the wire's size and shape ────────────────────────
//
// The header pins this with `static_assert`; asserting it here too means a
// layout change is a red line in a test that runs, not only in a compile that
// someone has to trigger.
void caseRecordShape() {
    Mirror mirror;
    const StateRecord state = snapshotOf(mirror);
    expectEq(static_cast<long long>(TENSION_INPUT_STATE_SIZE),
             static_cast<long long>(sizeof(StateRecord)), "the record is the wire's size");
    expectEq(TENSION_INPUT_STATE_VERSION, state.version, "the snapshot carries the version");
    expectEq(0, state.mouse_x, "a fresh mirror's pointer is at the origin");
    expectEq(88, static_cast<long long>(offsetof(StateRecord, modifiers)),
             "the modifier word sits at the offset the header publishes");
}

// ── 9. modifiers are a level, taken from the key events ─────────────────────
//
// Both halves of a pair carry the set held *after* the transition, so the last
// key event is the current state. That is what makes this a copy rather than a
// bookkeeping of which key owns which bit.
void caseModifiersFollowKeys() {
    Mirror mirror;
    mirror.attach(now_ms());
    expectEq(0, snapshotOf(mirror).modifiers, "no modifiers before any key");

    // Ctrl down (and nothing else), then the letter that completes Ctrl+S.
    tension_event ctrl_down = key(224, true, TENSION_INPUT_MOD_CTRL);
    mirror.ingest(&ctrl_down, 1, now_ms());
    expectEq(TENSION_INPUT_MOD_CTRL, snapshotOf(mirror).modifiers,
             "a Ctrl key-down sets CTRL");

    tension_event s_down = key(22, true, TENSION_INPUT_MOD_CTRL);
    mirror.ingest(&s_down, 1, now_ms());
    expectEq(TENSION_INPUT_MOD_CTRL, snapshotOf(mirror).modifiers,
             "a letter typed while Ctrl is held still reports CTRL");

    tension_event ctrl_up = key(224, false, 0);
    mirror.ingest(&ctrl_up, 1, now_ms());
    expectEq(0, snapshotOf(mirror).modifiers, "releasing Ctrl clears it");

    // Shift and Ctrl together, which is what a shortcut-with-a-capital needs.
    tension_event both = key(225, true, TENSION_INPUT_MOD_SHIFT | TENSION_INPUT_MOD_CTRL);
    mirror.ingest(&both, 1, now_ms());
    expectEq(TENSION_INPUT_MOD_SHIFT | TENSION_INPUT_MOD_CTRL,
             snapshotOf(mirror).modifiers, "Shift and Ctrl together are both reported");
}

// ── 10. losing focus forgets a held modifier ────────────────────────────────
//
// The case that made this a rule: Ctrl held, alt-tab, released in the other
// window. No key-up is ever delivered here, so a mirror that trusted the last
// key event would turn every later click into Ctrl+click.
void caseFocusLossClearsModifiers() {
    Mirror mirror;
    mirror.attach(now_ms());
    tension_event ctrl_down = key(224, true, TENSION_INPUT_MOD_ALT);
    mirror.ingest(&ctrl_down, 1, now_ms());
    expectEq(TENSION_INPUT_MOD_ALT, snapshotOf(mirror).modifiers, "Alt is held");

    tension_event lost = window(TENSION_WINDOW_EVENT_FOCUS_LOST);
    mirror.ingest(&lost, 1, now_ms());
    expectEq(0, snapshotOf(mirror).modifiers, "losing focus clears the modifier set");
}

// ── 11. text accumulates and is consumed by reading ─────────────────────────
//
// A flow, not a level: the penance for not reading is losing it, and reading it
// twice must not produce it twice.
void caseTextAccumulates() {
    Mirror mirror;
    mirror.attach(now_ms());
    expectEq(0, mirror.take_text(nullptr, 0), "no text before anything is typed");

    tension_event a = text("a");
    tension_event b = text("b");
    mirror.ingest(&a, 1, now_ms());
    mirror.ingest(&b, 1, now_ms());
    expectEq(2, mirror.take_text(nullptr, 0), "two typed characters are pending");

    char out[16] = {0};
    expectEq(2, mirror.take_text(out, sizeof(out)), "reading returns both bytes");
    expect(std::strncmp(out, "ab", 2) == 0, "in the order they were typed");
    expectEq(0, mirror.take_text(nullptr, 0), "and consumes them");

    // Multi-byte UTF-8 survives byte for byte: the mirror does not re-encode.
    tension_event e_acute = text("\xC3\xA9");
    mirror.ingest(&e_acute, 1, now_ms());
    char wide[8] = {0};
    expectEq(2, mirror.take_text(wide, sizeof(wide)), "é is two UTF-8 bytes");
    expectEq(0xC3, static_cast<uint8_t>(wide[0]), "the first byte is the lead byte");
    expectEq(0xA9, static_cast<uint8_t>(wide[1]), "the second is the continuation");
}

// ── 12. a short buffer loses nothing ────────────────────────────────────────
//
// The caller that measured with a probe gets its text; the caller that guessed
// short gets -ENOSPC and another chance, rather than half a keystroke.
void caseShortBufferKeepsText() {
    Mirror mirror;
    mirror.attach(now_ms());
    tension_event typed = text("hello");
    mirror.ingest(&typed, 1, now_ms());

    char small[3] = {0};
    expectEq(Mirror::kTextShort, mirror.take_text(small, sizeof(small)),
             "a short buffer is refused");
    expectEq(5, mirror.take_text(nullptr, 0), "and the text is still pending");

    char enough[8] = {0};
    expectEq(5, mirror.take_text(enough, sizeof(enough)), "a big enough buffer gets it all");
    expect(std::strncmp(enough, "hello", 5) == 0, "and it is the same text");
}

// ── 13. the buffer is bounded, and the loss is counted ──────────────────────
//
// A guest that stopped reading must not grow this mirror without limit. 256
// bytes is ~16 frames of fast typing, so a guest reading once per frame never
// reaches it; one that does loses bytes and the log says so.
void caseTextIsBounded() {
    Mirror mirror;
    mirror.attach(now_ms());
    std::string chunk(32, 'x');
    for (int index = 0; index < 12; ++index) {
        tension_event typed = text(chunk);
        mirror.ingest(&typed, 1, now_ms());
    }
    expectEq(static_cast<long long>(Mirror::kTextCapacity), mirror.take_text(nullptr, 0),
             "the pending text stops at the capacity");
}

} // namespace

int main() {
    std::printf("== tension-input mirror\n");
    caseDeviceZeroIsNotFiltered();
    caseOtherDevicesStillWork();
    caseBatchAccumulates();
    caseSnapshotConsumes();
    caseSettleKeepsPosition();
    caseZeroDeltaAddsNothing();
    caseButtonsFromDeviceZero();
    caseRecordShape();
    caseModifiersFollowKeys();
    caseFocusLossClearsModifiers();
    caseTextAccumulates();
    caseShortBufferKeepsText();
    caseTextIsBounded();

    if (failures != 0) {
        std::printf("mirror: %d of %d check(s) failed\n", failures, checks);
        return 1;
    }
    std::printf("mirror: all %d check(s) passed\n", checks);
    return 0;
}
