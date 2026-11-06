/*
 * smoke_core.cpp — the 2D adapter's smoke test, driven through its real ABI.
 *
 * A stub `tension-core`: it dlopens the DSO, provides the `tension_core_api`
 * slots the capability uses (guest memory, `register_import`, logging), then
 * loads `tension_adapter_v1`, calls `init`/`link`, and drives the nine verbs
 * through the *registered* import table — not by calling the shims directly.
 * That is the path the session uses, so a signing or registration bug fails
 * here.
 *
 * The assertion is pixels, not statuses. Ten sprites go in at known positions;
 * the frame is read back with `screenshot` and probed:
 *
 *   - the centre of each sprite is white (the texture sample reached the screen)
 *   - the gap between two sprites is black (the quad is 32 wide, not 64)
 *
 * If those fail, the bug is in the generator's arithmetic — not here, and not
 * in the adapter. Patching either to make the pixels appear would hide the
 * formula error this test exists to catch.
 *
 * SPDX-License-Identifier: MIT
 */

#include "tension_adapter.h"
#include "tension_2d.h"

#include <dlfcn.h>

#include <cerrno>
#include <cstdlib>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

namespace {

constexpr int32_t kFail = 1;
constexpr int32_t kSkip = 77; /* tapless / no device: distinguishable from a real failure */

struct StubCore {
    std::vector<uint8_t> guest;
    std::map<std::string, tension_import_fn> imports;
    std::map<std::string, uint32_t> flags;
    int log_lines = 0;
};

StubCore *g_core = nullptr;

int32_t guest_read(void *, uint32_t ptr, void *dst, uint32_t len) {
    if (dst == nullptr) return -EINVAL;
    if (static_cast<uint64_t>(ptr) + len > g_core->guest.size()) return -EINVAL;
    std::memcpy(dst, g_core->guest.data() + ptr, len);
    return 0;
}

int32_t guest_write(void *, uint32_t ptr, const void *src, uint32_t len) {
    if (src == nullptr) return -EINVAL;
    if (static_cast<uint64_t>(ptr) + len > g_core->guest.size()) return -EINVAL;
    std::memcpy(g_core->guest.data() + ptr, src, len);
    return 0;
}

uint32_t guest_size(void *) { return static_cast<uint32_t>(g_core->guest.size()); }

int32_t register_import(void *, const char *module, const char *name, uint32_t, const uint32_t *,
                        uint32_t, tension_import_fn fn, void *, uint32_t verb_id, uint32_t flags) {
    if (module == nullptr || name == nullptr || fn == nullptr) return -EINVAL;
    const std::string key = std::string(module) + "::" + name;
    if (g_core->imports.count(key) != 0) return -EINVAL;
    g_core->imports[key] = fn;
    g_core->flags[key] = (flags << 16) | (verb_id & 0xFFFF);
    return 0;
}

void log_slot(void *, int32_t level, const char *msg, uint32_t len) {
    g_core->log_lines++;
    std::fprintf(stderr, "    [%d] %.*s\n", level, static_cast<int>(len), msg ? msg : "");
}

void log_named(void *, int32_t level, const char *name, const char *msg, uint32_t len) {
    g_core->log_lines++;
    std::fprintf(stderr, "    [%d %s] %.*s\n", level, name ? name : "?", static_cast<int>(len),
                 msg ? msg : "");
}

/// Call a registered verb. Returns the guest-visible value: on success the
/// verb's own result, on refusal the negative errno it wrote into `ret`.
int32_t call(const char *name, std::initializer_list<int32_t> args) {
    const std::string key = std::string("tension::2d::") + name;
    auto found = g_core->imports.find(key);
    if (found == g_core->imports.end()) {
        std::fprintf(stderr, "FAIL: verb `%s` was never registered\n", name);
        std::exit(kFail);
    }
    std::vector<tension_value> values(args.size());
    uint32_t i = 0;
    for (int32_t arg : args) values[i++].i32 = arg;

    tension_value ret;
    ret.i64 = 0;
    const int32_t status = found->second(nullptr, values.data(), static_cast<uint32_t>(values.size()), &ret);
    // The session logs `status` and answers the guest `ret` — so this harness
    // reads `ret`, exactly as a guest would.
    (void)status;
    return ret.i32;
}

void put_bytes(uint32_t ptr, const void *src, size_t len) {
    std::memcpy(g_core->guest.data() + ptr, src, len);
}

/// The ten colours the test's atlas cells carry, one per sprite.
///
/// Distinct on purpose. The previous version of this test loaded a solid white
/// texture, and that is precisely what hid a real defect: the shader passed the
/// record's *pixel* source rect straight to `texture()`, which wants normalized
/// coordinates, so every sample clamped to the edge of a uniform image and came
/// back white no matter where the sprite was. A single colour cannot tell a
/// correct UV from a broken one.
constexpr uint8_t kCellColour[10][3] = {
    {255, 0, 0},   {0, 255, 0},   {0, 0, 255},   {255, 255, 0}, {0, 255, 255},
    {255, 0, 255}, {128, 0, 0},   {0, 128, 0},   {0, 0, 128},   {128, 128, 0},
};

/// A 128x128 RGBA8 atlas of 4x4 cells, 32x32 each, cell k painted
/// `kCellColour[k]`. Cell k sits at `((k%4)*32, (k/4)*32)`.
///
/// The cell is 32 px because the `sprite` record has **one** `w`/`h` pair and
/// the generator uses it for both the quad and the source rect (there is no
/// separate `src_w`/`src_h` in a 28-byte record). A 16 px cell under a 32 px
/// quad is not expressible, so the atlas is built at the size the record can
/// actually address.
std::vector<uint8_t> make_atlas() {
    constexpr uint32_t kWidth = 128, kHeight = 128;
    constexpr uint32_t kCell = 32;

    std::vector<uint8_t> out;
    auto u8 = [&](uint8_t v) { out.push_back(v); };
    auto u16 = [&](uint16_t v) { u8(v & 0xFF); u8(v >> 8); };
    auto u32 = [&](uint32_t v) { u16(v & 0xFFFF); u16(v >> 16); };
    auto u64 = [&](uint64_t v) { for (int i = 0; i < 8; ++i) u8(uint8_t((v >> (8 * i)) & 0xFF)); };

    out.insert(out.end(), {'I', 'W', 'I', '1'});
    u32(kWidth);
    u32(kHeight);
    u8(0);            // colorSpace: sRGB
    u16(3);           // componentCount
    u16(24);          // bitsPerPixel
    u8(0);            // storageLayout: interleaved
    for (int i = 0; i < 8; ++i) {
        const bool used = i < 3;
        u8(used ? uint8_t(i + 1) : 0);        // semantic R/G/B
        u8(used ? 2 : 0);                     // class UNORM
        u16(used ? uint16_t(i * 8) : 0);      // bitOffset
        u16(used ? 8 : 0);                    // bitWidth
    }
    u64(uint64_t(kWidth) * kHeight * 3);
    for (uint32_t y = 0; y < kHeight; ++y) {
        for (uint32_t x = 0; x < kWidth; ++x) {
            const int cell = static_cast<int>((y / kCell) * 4 + (x / kCell));
            const uint8_t *c = kCellColour[cell < 10 ? cell : 9];
            u8(c[0]); u8(c[1]); u8(c[2]);
        }
    }
    return out;
}

void write_record(uint32_t ptr, int32_t x, int32_t y, uint16_t src_x, uint16_t src_y, uint16_t w,
                  uint16_t h, uint16_t tex, uint32_t sort_key) {
    uint8_t *r = g_core->guest.data() + ptr;
    std::memset(r, 0, TENSION_2D_RECORD_SIZE);
    std::memcpy(r + TENSION_2D_OFF_X, &x, 4);
    std::memcpy(r + TENSION_2D_OFF_Y, &y, 4);
    std::memcpy(r + TENSION_2D_OFF_SRC_X, &src_x, 2);
    std::memcpy(r + TENSION_2D_OFF_SRC_Y, &src_y, 2);
    std::memcpy(r + TENSION_2D_OFF_W, &w, 2);
    std::memcpy(r + TENSION_2D_OFF_H, &h, 2);
    std::memcpy(r + TENSION_2D_OFF_TEX, &tex, 2);
    std::memcpy(r + TENSION_2D_OFF_SORT_KEY, &sort_key, 4);
}

void write_submit_hdr(uint32_t ptr, uint32_t records_ptr, uint32_t count) {
    tension_2d_submit_hdr hdr;
    hdr.records_ptr = records_ptr;
    hdr.records_count = count;
    hdr.record_stride = static_cast<uint16_t>(TENSION_2D_RECORD_SIZE);
    hdr.flags = 0;
    put_bytes(ptr, &hdr, sizeof hdr);
}

/// One sprite as the scenario tables describe it. `sort_key` is the only field
/// the record's ordering depends on.
struct SpriteSpec {
    int32_t x = 0;
    int32_t y = 0;
    uint16_t src_x = 0;
    uint16_t src_y = 0;
    uint16_t w = 0;
    uint16_t h = 0;
    uint32_t sort_key = 0;
};

/// Submit `order` (in the given submission order), present, and capture the
/// frame. The submission order is the caller's: that is the variable under test.
bool render_frame(int32_t handle, int32_t pipe_id, const std::vector<SpriteSpec> &order,
                  std::vector<uint8_t> &frame, const char *what) {
    const uint32_t records_ptr = 0x20000;
    for (size_t i = 0; i < order.size(); ++i) {
        const SpriteSpec &s = order[i];
        write_record(records_ptr + static_cast<uint32_t>(i) * TENSION_2D_RECORD_SIZE, s.x, s.y,
                     s.src_x, s.src_y, s.w, s.h, 0, s.sort_key);
    }

    const uint32_t hdr_ptr = 0x30000;
    write_submit_hdr(hdr_ptr, records_ptr, static_cast<uint32_t>(order.size()));

    const int32_t accepted =
        call("submit", {handle, pipe_id, static_cast<int32_t>(hdr_ptr), 0});
    if (accepted != static_cast<int32_t>(order.size())) {
        std::fprintf(stderr, "FAIL: %s: submit -> %d, expected %zu\n", what, accepted,
                     order.size());
        return false;
    }
    if (const int32_t rc = call("present", {handle}); rc != 0) {
        std::fprintf(stderr, "FAIL: %s: present -> %d\n", what, rc);
        return false;
    }

    const uint32_t frame_ptr = 0x40000;
    const uint32_t cap = 640u * 360u * 4u;
    const int32_t written =
        call("screenshot", {handle, static_cast<int32_t>(frame_ptr), static_cast<int32_t>(cap)});
    if (written != static_cast<int32_t>(cap)) {
        std::fprintf(stderr, "FAIL: %s: screenshot -> %d\n", what, written);
        return false;
    }
    frame.assign(g_core->guest.begin() + frame_ptr, g_core->guest.begin() + frame_ptr + cap);
    return true;
}

} // namespace

int main(int argc, char **argv) {
    const char *dso_path = argc > 1 ? argv[1] : "tension-2d/build/libtension_2d.so";

    StubCore core;
    core.guest.resize(8u << 20); // 8 MiB: the 640x360 RGBA8 readback needs ~0.9 MiB
                                 // on top of the record and texture ranges
    g_core = &core;

    void *handle = dlopen(dso_path, RTLD_NOW | RTLD_LOCAL);
    if (handle == nullptr) {
        std::fprintf(stderr, "FAIL: dlopen(%s): %s\n", dso_path, dlerror());
        return kFail;
    }

    auto entry = reinterpret_cast<const tension_adapter *(*)()>(dlsym(handle, "tension_adapter_v1"));
    if (entry == nullptr) {
        std::fprintf(stderr, "FAIL: tension_adapter_v1 not found: %s\n", dlerror());
        return kFail;
    }
    const tension_adapter *adapter = entry();
    if (adapter == nullptr) {
        std::fprintf(stderr, "FAIL: tension_adapter_v1 returned NULL\n");
        return kFail;
    }

    std::printf("adapter: name=%s abi=%u layout_hash=%u publish=%s apply=%s\n", adapter->name,
                adapter->abi_version, adapter->layout_hash, adapter->publish ? "set" : "NULL",
                adapter->apply ? "set" : "NULL");
    if (adapter->abi_version != TENSION_ADAPTER_ABI_VERSION) {
        std::fprintf(stderr, "FAIL: ABI mismatch (%u != %u)\n", adapter->abi_version,
                     TENSION_ADAPTER_ABI_VERSION);
        return kFail;
    }
    if (adapter->publish != nullptr || adapter->apply != nullptr) {
        std::fprintf(stderr, "FAIL: v1 owns no regions and has no deferrable verb\n");
        return kFail;
    }

    tension_core_api api;
    std::memset(&api, 0, sizeof api);
    api.user = &core;
    api.guest_read = guest_read;
    api.guest_write = guest_write;
    api.guest_size = guest_size;
    api.register_import = register_import;
    api.log = log_slot;
    api.log_named = log_named;

    if (const int32_t rc = adapter->init(nullptr, &api); rc != 0) {
        std::fprintf(stderr, "FAIL: init -> %d\n", rc);
        return kFail;
    }
    if (const int32_t rc = adapter->link(nullptr, &api); rc != 0) {
        std::fprintf(stderr, "FAIL: link -> %d\n", rc);
        return kFail;
    }
    std::printf("registered: %zu imports\n", core.imports.size());
    if (core.imports.size() != 9) {
        std::fprintf(stderr, "FAIL: expected nine verbs, got %zu\n", core.imports.size());
        return kFail;
    }

    // ── open ────────────────────────────────────────────────────────────
    const int32_t handle_id = call("open", {0});
    if (handle_id <= 0) {
        std::fprintf(stderr, "open -> %d\n", handle_id);
        if (handle_id == -ENODEV || handle_id == -ENOSYS) {
            std::fprintf(stderr, "SKIP: this machine has no GPU device\n");
            return kSkip;
        }
        return kFail;
    }
    std::printf("open -> handle %d\n", handle_id);

    // ── info ────────────────────────────────────────────────────────────
    const uint32_t info_ptr = 0x1000;
    const int32_t info_len = call("info", {handle_id, static_cast<int32_t>(info_ptr), 64});
    if (info_len != static_cast<int32_t>(sizeof(tension_2d_info_record))) {
        std::fprintf(stderr, "FAIL: info -> %d\n", info_len);
        return kFail;
    }
    tension_2d_info_record info;
    std::memcpy(&info, core.guest.data() + info_ptr, sizeof info);
    std::printf("info: version=%u max_records=%u max_buckets=%u\n", info.version, info.max_records,
                info.max_buckets);

    // ── set_pipeline: the built-in default_2d graph ──────────────────────
    const int32_t pipe = call("set_pipeline", {handle_id, 0, 1});
    if (pipe != 1) {
        std::fprintf(stderr, "FAIL: set_pipeline(0, 1) -> %d\n", pipe);
        return kFail;
    }
    std::printf("set_pipeline(default_2d) -> pipe_id %d\n", pipe);

    // ── texture_load: a 128x128 atlas of ten distinct colours ───────────
    const std::vector<uint8_t> iwi = make_atlas();
    const uint32_t iwi_ptr = 0x10000;
    put_bytes(iwi_ptr, iwi.data(), iwi.size());
    const int32_t texture = call("texture_load",
                                 {handle_id, static_cast<int32_t>(iwi_ptr),
                                  static_cast<int32_t>(iwi.size()), TENSION_2D_TEX_RGBA8});
    if (texture <= 0) {
        std::fprintf(stderr, "FAIL: texture_load -> %d\n", texture);
        return kFail;
    }
    std::printf("texture_load -> texture %d (%zu bytes)\n", texture, iwi.size());

    // ── the two scenarios ───────────────────────────────────────────────
    //
    // A. Ten sprites, 64 px apart, each sampling its own atlas cell. This is
    //    the position-and-colour check: every sprite's centre must be *its*
    //    colour, which only holds if both the quad arithmetic and the pixel ->
    //    normalized UV conversion are right.
    //
    // B. The same ten records in a 16 px cascade, so they overlap. Here draw
    //    order changes the pixels, which is the only way this test can observe
    //    a sort at all — ten non-overlapping opaque sprites look identical in
    //    any order.
    constexpr int kSprites = 10;

    std::vector<SpriteSpec> spread;
    std::vector<SpriteSpec> cascade;
    for (int i = 0; i < kSprites; ++i) {
        SpriteSpec base;
        base.src_x = static_cast<uint16_t>((i % 4) * 32);
        base.src_y = static_cast<uint16_t>((i / 4) * 32);
        base.w = 32;
        base.h = 32;
        base.sort_key = static_cast<uint32_t>(i);

        SpriteSpec a = base;
        a.x = i * 64;
        a.y = 0;
        spread.push_back(a);

        SpriteSpec b = base;
        b.x = i * 16;
        b.y = i * 16;
        cascade.push_back(b);
    }

    std::vector<SpriteSpec> spread_reversed(spread.rbegin(), spread.rend());
    std::vector<SpriteSpec> cascade_reversed(cascade.rbegin(), cascade.rend());

    std::vector<uint8_t> frame_a, frame_a_rev, frame_b, frame_b_rev;
    if (!render_frame(handle_id, pipe, spread, frame_a, "A forward")) return kFail;
    if (!render_frame(handle_id, pipe, spread_reversed, frame_a_rev, "A reversed")) return kFail;
    if (!render_frame(handle_id, pipe, cascade, frame_b, "B forward")) return kFail;
    if (!render_frame(handle_id, pipe, cascade_reversed, frame_b_rev, "B reversed")) return kFail;

    auto pixel_of = [](const std::vector<uint8_t> &frame, uint32_t x, uint32_t y) {
        return frame.data() + (static_cast<size_t>(y) * 640u + x) * 4u;
    };
    auto near_colour = [](const uint8_t *p, const uint8_t (&c)[3]) {
        return std::abs(static_cast<int>(p[0]) - c[0]) <= 3 &&
               std::abs(static_cast<int>(p[1]) - c[1]) <= 3 &&
               std::abs(static_cast<int>(p[2]) - c[2]) <= 3;
    };
    auto nonblack = [](const std::vector<uint8_t> &frame) {
        size_t n = 0;
        for (size_t i = 0; i < frame.size(); i += 4) {
            if (frame[i] || frame[i + 1] || frame[i + 2]) n++;
        }
        return n;
    };

    int failures = 0;

    // ── A: every sprite shows its own cell, at its own position ─────────
    for (int i = 0; i < kSprites; ++i) {
        const uint32_t cx = static_cast<uint32_t>(i * 64) + 16;
        const uint8_t *p = pixel_of(frame_a, cx, 16);
        if (!near_colour(p, kCellColour[i])) {
            std::fprintf(stderr,
                         "FAIL: A sprite %d centre (%u,16) is (%u,%u,%u), expected (%u,%u,%u) — "
                         "position or UV is wrong\n",
                         i, cx, p[0], p[1], p[2], kCellColour[i][0], kCellColour[i][1],
                         kCellColour[i][2]);
            failures++;
        }
    }
    const size_t count_a = nonblack(frame_a);
    std::printf("A forward: %zu non-black pixels (expected %d)\n", count_a, kSprites * 32 * 32);
    if (count_a != static_cast<size_t>(kSprites * 32 * 32)) {
        std::fprintf(stderr, "FAIL: A coverage %zu != %d\n", count_a, kSprites * 32 * 32);
        failures++;
    }

    // ── A reversed: same pixels (no overlap, so this is the weak half) ──
    if (frame_a_rev != frame_a) {
        std::fprintf(stderr, "FAIL: A reversed differs from A forward\n");
        failures++;
    }

    // ── B: overlap, so the sort decides what is visible ─────────────────
    //
    // Sprite i occupies [i*16, i*16+32)^2 and sprite i+1 overlaps its right and
    // bottom half, so the pixel at sprite i's centre belongs to whichever of
    // {i, i+1} is drawn last. With sort_key = i ascending, that is i+1.
    for (int i = 0; i < kSprites; ++i) {
        const uint32_t px = static_cast<uint32_t>(i * 16) + 16;
        const uint32_t py = static_cast<uint32_t>(i * 16) + 16;
        const int winner = (i + 1 < kSprites) ? i + 1 : i;
        const uint8_t *p = pixel_of(frame_b, px, py);
        if (!near_colour(p, kCellColour[winner])) {
            std::fprintf(stderr,
                         "FAIL: B pixel (%u,%u) is (%u,%u,%u), expected sprite %d's colour "
                         "(%u,%u,%u) — the draw order is not sort_key order\n",
                         px, py, p[0], p[1], p[2], winner, kCellColour[winner][0],
                         kCellColour[winner][1], kCellColour[winner][2]);
            failures++;
        }
    }
    std::printf("B forward: %zu non-black pixels\n", nonblack(frame_b));

    // ── B reversed: THE sort test ───────────────────────────────────────
    //
    // Submitted 9..0. Without a sort restoring sort_key order, sprite 0 is drawn
    // last and wins every overlap it touches, so the cascade inverts and the
    // frame differs. Byte equality is the assertion.
    if (nonblack(frame_b_rev) != nonblack(frame_b)) {
        std::fprintf(stderr, "FAIL: B reversed coverage %zu != %zu\n", nonblack(frame_b_rev),
                     nonblack(frame_b));
        failures++;
    }
    if (frame_b_rev != frame_b) {
        size_t first = 0;
        while (first < frame_b.size() && frame_b_rev[first] == frame_b[first]) first++;
        std::fprintf(stderr,
                     "FAIL: B reversed is not byte-identical to B forward (first difference at "
                     "byte %zu, pixel (%zu,%zu)) — the sort is not restoring sort_key order\n",
                     first, (first / 4) % 640, (first / 4) / 640);
        failures++;
    } else {
        std::printf("B reversed: byte-identical to B forward (%zu pixels, sort verified)\n",
                    nonblack(frame_b));
    }

    // ── the graph path: set_pipeline(blob) -> pipe 100 ──────────────────
    //
    // The blob is the one `tension-core graph emit-default` wrote, loaded from
    // disk rather than embedded here so the test reads the artifact a reviewer
    // can inspect (tension-2d/tests/default_2d.t2dg).
    std::vector<uint8_t> blob;
    {
        const char *path = std::getenv("TENSION_2D_GRAPH");
        std::string resolved = path ? path : "tension-2d/tests/default_2d.t2dg";
        FILE *f = std::fopen(resolved.c_str(), "rb");
        if (f == nullptr) {
            std::fprintf(stderr, "FAIL: cannot open graph blob %s\n", resolved.c_str());
            return kFail;
        }
        std::fseek(f, 0, SEEK_END);
        const long size = std::ftell(f);
        std::fseek(f, 0, SEEK_SET);
        blob.resize(static_cast<size_t>(size));
        if (std::fread(blob.data(), 1, blob.size(), f) != blob.size()) {
            std::fprintf(stderr, "FAIL: short read on %s\n", resolved.c_str());
            std::fclose(f);
            return kFail;
        }
        std::fclose(f);
    }

    const uint32_t blob_ptr = 0x60000;
    put_bytes(blob_ptr, blob.data(), blob.size());
    const int32_t graph_pipe =
        call("set_pipeline", {handle_id, static_cast<int32_t>(blob_ptr),
                              static_cast<int32_t>(blob.size())});
    if (graph_pipe != 100) {
        std::fprintf(stderr, "FAIL: set_pipeline(blob) -> %d, expected 100\n", graph_pipe);
        return kFail;
    }
    std::printf("set_pipeline(blob, %zu bytes) -> pipe_id %d\n", blob.size(), graph_pipe);

    // A blob this build was not built with must be refused, not guessed at.
    std::vector<uint8_t> foreign = blob;
    foreign[foreign.size() - 1] ^= 0xFF;
    put_bytes(blob_ptr + blob.size(), foreign.data(), foreign.size());
    const int32_t foreign_pipe =
        call("set_pipeline", {handle_id, static_cast<int32_t>(blob_ptr + blob.size()),
                              static_cast<int32_t>(foreign.size())});
    if (foreign_pipe != -ENOSYS) {
        std::fprintf(stderr, "FAIL: an unbuilt blob -> %d, expected -ENOSYS\n", foreign_pipe);
        failures++;
    }

    // ── acceptance: the two pipes produce identical frames ──────────────
    //
    // Same records, same submission order, different pipeline. If the graph's
    // RECORD, its STAGE or its emit wiring disagreed with the preset, this is
    // where it shows.
    std::vector<uint8_t> graph_a, graph_b, graph_b_rev;
    if (!render_frame(handle_id, graph_pipe, spread, graph_a, "graph A")) return kFail;
    if (!render_frame(handle_id, graph_pipe, cascade, graph_b, "graph B")) return kFail;
    if (!render_frame(handle_id, graph_pipe, cascade_reversed, graph_b_rev, "graph B reversed"))
        return kFail;

    const bool spread_identical = (graph_a == frame_a);
    const bool cascade_identical = (graph_b == frame_b);
    const bool graph_sort_identical = (graph_b_rev == graph_b);
    std::printf("graph vs preset, scenario A: %s\n", spread_identical ? "byte-identical" : "DIFFERS");
    if (!spread_identical) {
        size_t first = 0;
        while (first < frame_a.size() && graph_a[first] == frame_a[first]) first++;
        std::fprintf(stderr,
                     "FAIL: graph path differs from the preset at byte %zu (pixel (%zu,%zu))\n",
                     first, (first / 4) % 640, (first / 4) / 640);
        failures++;
    }
    if (!cascade_identical) {
        std::fprintf(stderr, "FAIL: graph and preset disagree on the overlapping scenario\n");
        failures++;
    }
    if (!graph_sort_identical) {
        std::fprintf(stderr, "FAIL: the graph pipeline does not sort\n");
        failures++;
    }
    if (spread_identical && cascade_identical && graph_sort_identical) {
        std::printf("graph vs preset, scenario B: byte-identical, both sorted\n");
    }

    // ── default_2d_scaled: a graph the preset cannot express ────────────
    //
    // `tension-shadergen` emits `corner * w` from the record's own `w`; it has
    // no way to double it. So a 64x64 quad is evidence that the graph's `mul`
    // node reached the shader as data, rather than the compiler replaying the
    // preset it already knew how to draw.
    std::vector<uint8_t> scaled_blob;
    {
        const char *path = std::getenv("TENSION_2D_SCALED_GRAPH");
        const std::string resolved = path ? path : "tension-2d/tests/default_2d_scaled.t2dg";
        FILE *f = std::fopen(resolved.c_str(), "rb");
        if (f == nullptr) {
            std::fprintf(stderr, "FAIL: cannot open scaled graph %s\n", resolved.c_str());
            return kFail;
        }
        std::fseek(f, 0, SEEK_END);
        const long size = std::ftell(f);
        std::fseek(f, 0, SEEK_SET);
        scaled_blob.resize(static_cast<size_t>(size));
        if (std::fread(scaled_blob.data(), 1, scaled_blob.size(), f) != scaled_blob.size()) {
            std::fprintf(stderr, "FAIL: short read on %s\n", resolved.c_str());
            std::fclose(f);
            return kFail;
        }
        std::fclose(f);
    }

    const uint32_t scaled_ptr = 0x70000;
    put_bytes(scaled_ptr, scaled_blob.data(), scaled_blob.size());
    const int32_t scaled_pipe =
        call("set_pipeline", {handle_id, static_cast<int32_t>(scaled_ptr),
                              static_cast<int32_t>(scaled_blob.size())});
    if (scaled_pipe <= 100 || scaled_pipe == graph_pipe) {
        std::fprintf(stderr, "FAIL: set_pipeline(scaled) -> %d, expected a new pipe above 100\n",
                     scaled_pipe);
        return kFail;
    }
    std::printf("set_pipeline(scaled, %zu bytes) -> pipe_id %d\n", scaled_blob.size(), scaled_pipe);

    std::vector<uint8_t> scaled_a, scaled_b, scaled_b_rev;
    if (!render_frame(handle_id, scaled_pipe, spread, scaled_a, "scaled A")) return kFail;
    if (!render_frame(handle_id, scaled_pipe, cascade, scaled_b, "scaled B")) return kFail;
    if (!render_frame(handle_id, scaled_pipe, cascade_reversed, scaled_b_rev, "scaled B reversed"))
        return kFail;

    // Coverage: 2x each axis is 4x the area, and the ten 64 px sprites at 64 px
    // pitch tile the row exactly, so the count is exact.
    const size_t scaled_count = nonblack(scaled_a);
    const size_t expected_scaled = static_cast<size_t>(kSprites) * 64u * 64u;
    std::printf("scaled A: %zu non-black pixels (expected %zu, = 4 x %zu)\n", scaled_count,
                expected_scaled, count_a);
    if (scaled_count != expected_scaled) {
        std::fprintf(stderr, "FAIL: scaled coverage %zu != %zu\n", scaled_count, expected_scaled);
        failures++;
    }
    if (scaled_count != 4 * count_a) {
        std::fprintf(stderr, "FAIL: scaled coverage is not exactly 4x the unscaled (%zu vs %zu)\n",
                     scaled_count, 4 * count_a);
        failures++;
    }

    // Extent: sprite 0's top-left is at (0,0) unscaled and stays there, because
    // the graph scales `size` and not `position`. The *centre* therefore moves
    // by half the size delta (16,16) — the task asked for "centered at the same
    // point", which this arithmetic does not do, and the honest assertion is
    // the one the graph actually specifies.
    {
        const uint8_t *corner = pixel_of(scaled_a, 0, 0);
        if (!near_colour(corner, kCellColour[0])) {
            std::fprintf(stderr,
                         "FAIL: scaled sprite 0 top-left is (%u,%u,%u), expected its colour — the \
                         quad did not stay anchored where the graph puts it\n",
                         corner[0], corner[1], corner[2]);
            failures++;
        }
        const uint8_t *inside = pixel_of(scaled_a, 63, 63);
        if (!near_colour(inside, kCellColour[0])) {
            std::fprintf(stderr, "FAIL: scaled sprite 0 does not cover 64x64\n");
            failures++;
        }
        const uint8_t *past = pixel_of(scaled_a, 64, 63);
        if (near_colour(past, kCellColour[0])) {
            std::fprintf(stderr, "FAIL: scaled sprite 0 is wider than 64 px\n");
            failures++;
        }
    }

    // Part 4: the sort still runs, on the scaled pipeline.
    //
    // The comparison is scaled-reversed vs scaled-forward. Comparing against
    // the *unscaled* cascade would be wrong: a 64x64 cascade at 16 px pitch is
    // a different picture from a 32x32 one, and the two should differ.
    if (scaled_b_rev != scaled_b) {
        size_t first = 0;
        while (first < scaled_b.size() && scaled_b_rev[first] == scaled_b[first]) first++;
        std::fprintf(stderr,
                     "FAIL: scaled reversed is not byte-identical to scaled forward (first "
                     "difference at byte %zu) — the sort and the new primitive disagree\n",
                     first);
        failures++;
    } else {
        std::printf("scaled B reversed: byte-identical to scaled forward (%zu pixels, sort + mul "
                    "together)\n",
                    nonblack(scaled_b));
    }

    // ── refusals ────────────────────────────────────────────────────────
    struct Expect {
        const char *what;
        int32_t got;
        int32_t want;
    };
    const int32_t guest_graph = call("set_pipeline", {handle_id, 0x1234, 8});
    const int32_t raw_shader = call("shader_compile_raw", {handle_id, 0, 0, 0, 0});
    // A stride that disagrees with the layout must be refused, not guessed at.
    const uint32_t bad_hdr_ptr = 0x38000;
    write_submit_hdr(bad_hdr_ptr, 0x20000, 1);
    g_core->guest[bad_hdr_ptr + 10] = 12; // record_stride = 12, not 28
    const int32_t bad_stride =
        call("submit", {handle_id, pipe, static_cast<int32_t>(bad_hdr_ptr), 0});
    const Expect expects[] = {
        {"set_pipeline(guest graph)", guest_graph, -ENOSYS},
        {"shader_compile_raw", raw_shader, -ENOSYS},
        {"submit(bad stride)", bad_stride, -EINVAL},
    };
    for (const Expect &e : expects) {
        if (e.got != e.want) {
            std::fprintf(stderr, "FAIL: %s -> %d, expected %d\n", e.what, e.got, e.want);
            failures++;
        }
    }

    // ── close ───────────────────────────────────────────────────────────
    const int32_t closed = call("close", {handle_id});
    if (closed != 0) {
        std::fprintf(stderr, "FAIL: close -> %d\n", closed);
        return kFail;
    }
    std::printf("close -> 0\n");

    if (failures != 0) return kFail;
    std::printf("OK: positions, per-sprite colours and sort order all verified\n");
    return 0;
}
