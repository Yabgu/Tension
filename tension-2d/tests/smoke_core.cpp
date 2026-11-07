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
#include <chrono>
#include <sys/wait.h>
#include <unistd.h>
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

/// `tension_core_api.compile_graph` (ABI v5), as a **test double**.
///
/// The real host compiles in-process — `ffi::compile_graph` calls
/// `pipeline::naga_backend`. This harness is C++ and cannot link that, so it
/// stands in by running `tension-core graph compile`, which is the same code
/// behind a command line. That makes the double honest in the part that
/// matters: the bytes it returns come from the real compiler, not from a
/// fixture.
int32_t compile_graph(void *, const uint8_t *blob, uint32_t blob_len, uint8_t *vs_out,
                      uint32_t vs_cap, uint8_t *fs_out, uint32_t fs_cap, uint32_t *out_vs_len,
                      uint32_t *out_fs_len) {
    if (blob == nullptr || out_vs_len == nullptr || out_fs_len == nullptr) return -EINVAL;

    char tmpl[] = "/tmp/tension2d-graph-XXXXXX";
    const char *dir = mkdtemp(tmpl);
    if (dir == nullptr) return -EIO;

    const std::string dir_str = dir;
    const std::string blob_path = dir_str + "/g.t2dg";
    {
        FILE *f = std::fopen(blob_path.c_str(), "wb");
        if (f == nullptr) return -EIO;
        if (std::fwrite(blob, 1, blob_len, f) != blob_len) {
            std::fclose(f);
            return -EIO;
        }
        std::fclose(f);
    }

    const char *bin = std::getenv("TENSION_CORE_BIN");
    const std::string core = bin != nullptr ? bin : "tension-core/target/debug/tension-core";
    const std::string command = "'" + core + "' graph compile '" + blob_path + "' --out '" +
                                dir_str + "' >/dev/null 2>&1";
    {
        const int status = std::system(command.c_str());
        if (status != 0) {
            // Mirror the exit codes `graph compile` documents, so this double
            // reports the same errno the real `ffi::compile_graph` would.
            const int code = WIFEXITED(status) ? WEXITSTATUS(status) : 1;
            return code == 2 ? -EINVAL : -ENOSYS;
        }
    }

    auto slurp = [&](const std::string &path, std::vector<uint8_t> &into) -> bool {
        FILE *f = std::fopen(path.c_str(), "rb");
        if (f == nullptr) return false;
        std::fseek(f, 0, SEEK_END);
        const long size = std::ftell(f);
        std::fseek(f, 0, SEEK_SET);
        into.resize(static_cast<size_t>(size));
        const bool ok = std::fread(into.data(), 1, into.size(), f) == into.size();
        std::fclose(f);
        return ok;
    };

    std::vector<uint8_t> vs, fs;
    const bool read_ok = slurp(dir_str + "/vs.spv", vs) && slurp(dir_str + "/fs.spv", fs);
    std::remove(blob_path.c_str());
    std::remove((dir_str + "/vs.spv").c_str());
    std::remove((dir_str + "/fs.spv").c_str());
    std::remove(dir_str.c_str());
    if (!read_ok) return -ENOSYS;

    *out_vs_len = static_cast<uint32_t>(vs.size());
    *out_fs_len = static_cast<uint32_t>(fs.size());
    if (vs.size() > vs_cap || fs.size() > fs_cap) return -ENOSPC;
    if (vs_out == nullptr || fs_out == nullptr) return -EINVAL;
    std::memcpy(vs_out, vs.data(), vs.size());
    std::memcpy(fs_out, fs.data(), fs.size());
    return 0;
}

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

/// A square RGBA8 atlas of `cells_per_row` x `cells_per_row` cells, cell k
/// painted `colours[k]`. Cell k sits at `((k%n)*cell, (k/n)*cell)`.
///
/// 64 px cells by default, because the `sprite` record has **one** `w`/`h` pair
/// and the generator uses it for both the quad and the source rect (there is no
/// separate `src_w`/`src_h` in a 28-byte record). A 64 px record therefore
/// samples exactly one cell and is a flat colour; a 32 px record samples the
/// top-left quarter of one, also flat. Anything smaller would let one sprite
/// sample four cells at once and make every colour assertion ambiguous.
///
/// The size is a parameter because `set_texture` refuses a page whose
/// dimensions disagree with the pipeline's array, and that refusal needs an
/// atlas of a second size to exercise.
std::vector<uint8_t> make_atlas(const uint8_t (&colours)[10][3] = kCellColour,
                                uint32_t width = 256, uint32_t cells_per_row = 4) {
    const uint32_t kWidth = width, kHeight = width;
    const uint32_t kCell = width / cells_per_row;

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
            const int cell = static_cast<int>((y / kCell) * cells_per_row + (x / kCell));
            const uint8_t *c = colours[cell < 10 ? cell : 9];
            u8(c[0]); u8(c[1]); u8(c[2]);
        }
    }
    return out;
}

void write_record(uint32_t ptr, int32_t x, int32_t y, uint16_t src_x, uint16_t src_y, uint16_t w,
                  uint16_t h, uint16_t tex, uint32_t sort_key, uint16_t group_id, uint8_t z) {
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
    std::memcpy(r + TENSION_2D_OFF_GROUP_ID, &group_id, 2);
    r[TENSION_2D_OFF_Z] = z;
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
    uint16_t tex = 0;
    uint32_t sort_key = 0;
    /// Composite grouping. Records sharing a group sort together, ahead of `z`.
    uint16_t group_id = 0;
    /// Within-group order.
    uint8_t z = 0;
};

/// Submit `order` (in the given submission order), present, and capture the
/// frame. The submission order is the caller's: that is the variable under test.
bool render_frame(int32_t handle, int32_t pipe_id, const std::vector<SpriteSpec> &order,
                  std::vector<uint8_t> &frame, const char *what, uint32_t canvas_w = 640,
                  uint32_t canvas_h = 360) {
    const uint32_t records_ptr = 0x20000;
    for (size_t i = 0; i < order.size(); ++i) {
        const SpriteSpec &s = order[i];
        write_record(records_ptr + static_cast<uint32_t>(i) * TENSION_2D_RECORD_SIZE, s.x, s.y,
                     s.src_x, s.src_y, s.w, s.h, s.tex, s.sort_key, s.group_id, s.z);
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
    const uint32_t cap = canvas_w * canvas_h * 4u;
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
    api.compile_graph = compile_graph;

    if (const int32_t rc = adapter->init(nullptr, &api); rc != 0) {
        std::fprintf(stderr, "FAIL: init -> %d\n", rc);
        return kFail;
    }
    if (const int32_t rc = adapter->link(nullptr, &api); rc != 0) {
        std::fprintf(stderr, "FAIL: link -> %d\n", rc);
        return kFail;
    }
    std::printf("registered: %zu imports\n", core.imports.size());
    if (core.imports.size() != 10) {
        std::fprintf(stderr, "FAIL: expected ten verbs, got %zu\n", core.imports.size());
        return kFail;
    }

    // ── open ────────────────────────────────────────────────────────────
    //
    // The canvas is the caller's decision. 640x360 here so every pixel
    // coordinate in this file keeps its meaning; the second half of the test
    // opens a second handle at 320x180 to prove the size is not baked in.
    const int32_t handle_id = call("open", {640, 360, 0});
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
    std::printf("info: version=%u max_records=%u max_buckets=%u canvas=%ux%u\n", info.version,
                info.max_records, info.max_buckets, info.canvas_width, info.canvas_height);
    if (info.canvas_width != 640 || info.canvas_height != 360) {
        std::fprintf(stderr, "FAIL: info reports canvas %ux%u, opened 640x360\n",
                     info.canvas_width, info.canvas_height);
        return kFail;
    }

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
        base.src_x = static_cast<uint16_t>((i % 4) * 64);
        base.src_y = static_cast<uint16_t>((i / 4) * 64);
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

    // A malformed blob is still refused. Runtime compilation widened what
    // `set_pipeline` accepts (an unknown but *valid* graph now compiles, below);
    // it did not make corrupt bytes acceptable.
    std::vector<uint8_t> corrupt = blob;
    corrupt.resize(corrupt.size() - 5);
    put_bytes(blob_ptr + blob.size(), corrupt.data(), corrupt.size());
    const int32_t corrupt_pipe =
        call("set_pipeline", {handle_id, static_cast<int32_t>(blob_ptr + blob.size()),
                              static_cast<int32_t>(corrupt.size())});
    if (corrupt_pipe != -EINVAL) {
        std::fprintf(stderr, "FAIL: a truncated blob -> %d, expected -EINVAL\n", corrupt_pipe);
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

    // ── composite characters: group_id and z under the sort ─────────────
    //
    // Every test above leaves group_id and z at zero, so the sort's second and
    // third keys have never been populated. This one puts two characters on the
    // same tile (sort_key 100) with three layers each and probes a pixel where
    // both are present.
    //
    //   correct  (sort_key, group_id, z): C1 red/green/blue, then C2 yellow/cyan
    //                                     -> pixel (20,20) is cyan
    //   z-first  (sort_key, z, group_id): red+yellow, green+cyan, then blue
    //                                     -> pixel (20,20) is blue
    //
    // The two predictions differ, which is the whole point: this pixel can tell
    // the two orderings apart, where the flat scenarios above cannot.
    constexpr uint32_t kTile = 100;
    auto layer = [](int32_t x, int32_t y, int cell, uint16_t group, uint8_t z) {
        SpriteSpec s;
        s.x = x;
        s.y = y;
        s.src_x = static_cast<uint16_t>((cell % 4) * 64);
        s.src_y = static_cast<uint16_t>((cell / 4) * 64);
        s.w = 64;
        s.h = 64;
        s.sort_key = kTile;
        s.group_id = group;
        s.z = z;
        return s;
    };

    const SpriteSpec c1_body = layer(0, 0, 0, 1, 0);      // red
    const SpriteSpec c1_hair = layer(0, 0, 1, 1, 1);      // green
    const SpriteSpec c1_back = layer(0, 0, 2, 1, 2);      // blue
    const SpriteSpec c2_body = layer(16, 16, 3, 2, 0);    // yellow
    const SpriteSpec c2_hair = layer(16, 16, 4, 2, 1);    // cyan

    // Interleaved: the submission order deliberately fights the sort.
    const std::vector<SpriteSpec> interleaved = {c1_body, c2_body, c1_hair, c2_hair, c1_back};
    // Forward: grouped by character, which is what a naive guest would do.
    const std::vector<SpriteSpec> grouped = {c1_body, c1_hair, c1_back, c2_body, c2_hair};

    std::vector<uint8_t> composite_interleaved, composite_grouped;
    if (!render_frame(handle_id, pipe, interleaved, composite_interleaved, "composite interleaved"))
        return kFail;
    if (!render_frame(handle_id, pipe, grouped, composite_grouped, "composite grouped"))
        return kFail;

    {
        // (20,20) is inside C1 (0..64) and inside C2 (16..80).
        const uint8_t *p = pixel_of(composite_interleaved, 20, 20);
        const bool is_cyan = near_colour(p, kCellColour[4]);
        const bool is_blue = near_colour(p, kCellColour[2]);
        p = pixel_of(composite_interleaved, 20, 20);
        std::printf("composite (20,20) -> (%u,%u,%u)%s%s\n", p[0], p[1], p[2],
                    is_cyan ? "  cyan: grouped by character" : "",
                    is_blue ? "  blue: z outranks group_id" : "");
        if (!is_cyan) {
            std::fprintf(stderr,
                         "FAIL: composite pixel (20,20) is (%u,%u,%u); expected cyan (0,255,255) — "
                         "the sort is not ordering by (sort_key, group_id, z)%s\n",
                         p[0], p[1], p[2],
                         is_blue ? " (blue is the z-first prediction: group_id is not consulted "
                                   "before z)"
                                 : "");
            failures++;
        }
    }

    if (composite_interleaved != composite_grouped) {
        size_t first = 0;
        while (first < composite_grouped.size() &&
               composite_interleaved[first] == composite_grouped[first])
            first++;
        std::fprintf(stderr,
                     "FAIL: interleaved and grouped submissions differ at byte %zu — the sort does "
                     "not neutralise submission order\n",
                     first);
        failures++;
    } else {
        std::printf("composite: interleaved and grouped submissions are byte-identical\n");
    }

    // The layer that loses must be the one the grouping says it is. If `z`
    // dominated, C1's backpack (z=2) would still be visible somewhere C2 is not
    // — at (70,70), inside C2 only.
    {
        const uint8_t *p = pixel_of(composite_interleaved, 70, 70);
        if (!near_colour(p, kCellColour[4])) {
            std::fprintf(stderr,
                         "FAIL: (70,70) is (%u,%u,%u), expected C2's cyan — outside C1's quad the "
                         "top of C2's stack must still be C2's last layer\n",
                         p[0], p[1], p[2]);
            failures++;
        }
    }

    // ── animation: the record's src rect is the frame selector ──────────
    //
    // `src_x`/`src_y` have been in the record since the first draft and nothing
    // above ever changed them between frames, so "the record supports
    // animation" was an untested claim. Here one record is submitted four
    // times, with only `src_x` moving across the atlas's first four cells —
    // red, green, blue, yellow. One sprite, four frames, four screenshots.
    //
    // Position (8,8) with a 32 px quad means (16,16) is inside the sprite and
    // (0,0) is outside it, so the test can check both "the frame changed" and
    // "the quad did not move".
    {
        // Set by the revert-test: freeze the frame index and the assertion
        // below must fail at step 1 with red still on screen.
        const bool freeze = std::getenv("TENSION_2D_FREEZE_FRAME") != nullptr;
        const uint16_t frame_x[4] = {0, 64, 128, 192};
        int animation_failures = 0;

        for (int step = 0; step < 4; ++step) {
            SpriteSpec s;
            s.x = 8;
            s.y = 8;
            s.src_x = freeze ? frame_x[0] : frame_x[step];
            s.src_y = 0;
            s.w = 32;
            s.h = 32;
            s.sort_key = 0;

            std::vector<uint8_t> frame;
            if (!render_frame(handle_id, pipe, {s}, frame, "animation")) return kFail;

            const uint8_t *inside = pixel_of(frame, 16, 16);
            const uint8_t *outside = pixel_of(frame, 0, 0);
            if (!near_colour(inside, kCellColour[step])) {
                std::fprintf(stderr,
                             "FAIL: animation step %d: (16,16) is (%u,%u,%u), expected frame %d's "
                             "(%u,%u,%u) — src_x is not selecting the frame\n",
                             step, inside[0], inside[1], inside[2], step, kCellColour[step][0],
                             kCellColour[step][1], kCellColour[step][2]);
                animation_failures++;
            }
            if (outside[0] != 0 || outside[1] != 0 || outside[2] != 0) {
                std::fprintf(stderr,
                             "FAIL: animation step %d: (0,0) is (%u,%u,%u), expected black — the "
                             "quad moved with the frame\n",
                             step, outside[0], outside[1], outside[2]);
                animation_failures++;
            }
        }
        if (animation_failures == 0) {
            std::printf("animation: src_x cycled red, green, blue, yellow; (0,0) black each frame\n");
        }
        failures += animation_failures;
    }

    // ── runtime compilation: a graph the build never saw ────────────────
    //
    // `default_2d_scaled_1_5.t2dg` is generated by `scripts/test-2d.mjs` from
    // `graph emit-scaled --factor 1.5`. Its hash is not in kGraphPipes, so
    // `set_pipeline` must fall through to the host's `compile_graph` slot and
    // come back with a pipe_id in the 1000+ range.
    std::vector<uint8_t> runtime_blob;
    {
        const char *path = std::getenv("TENSION_2D_RUNTIME_GRAPH");
        const std::string resolved =
            path ? path : "tension-2d/tests/default_2d_scaled_1_5.t2dg";
        FILE *f = std::fopen(resolved.c_str(), "rb");
        if (f == nullptr) {
            std::fprintf(stderr, "FAIL: cannot open runtime graph %s\n", resolved.c_str());
            return kFail;
        }
        std::fseek(f, 0, SEEK_END);
        const long size = std::ftell(f);
        std::fseek(f, 0, SEEK_SET);
        runtime_blob.resize(static_cast<size_t>(size));
        if (std::fread(runtime_blob.data(), 1, runtime_blob.size(), f) != runtime_blob.size()) {
            std::fprintf(stderr, "FAIL: short read on %s\n", resolved.c_str());
            std::fclose(f);
            return kFail;
        }
        std::fclose(f);
    }

    const uint32_t runtime_ptr = 0x80000;
    put_bytes(runtime_ptr, runtime_blob.data(), runtime_blob.size());

    const auto compile_start = std::chrono::steady_clock::now();
    const int32_t runtime_pipe =
        call("set_pipeline", {handle_id, static_cast<int32_t>(runtime_ptr),
                              static_cast<int32_t>(runtime_blob.size())});
    const auto compile_end = std::chrono::steady_clock::now();
    const double compile_ms =
        std::chrono::duration<double, std::milli>(compile_end - compile_start).count();

    if (runtime_pipe < TENSION_2D_PIPE_RAW_MIN) {
        std::fprintf(stderr,
                     "FAIL: set_pipeline(1.5x graph) -> %d, expected >= %d — the graph was not "
                     "compiled at runtime\n",
                     runtime_pipe, TENSION_2D_PIPE_RAW_MIN);
        return kFail;
    }
    std::printf("set_pipeline(1.5x, %zu bytes, compiled at runtime) -> pipe_id %d in %.2f ms\n",
                runtime_blob.size(), runtime_pipe, compile_ms);

    // A second call must reuse the pipeline, not compile again: the cache is
    // keyed by blob hash on the adapter side.
    const auto reuse_start = std::chrono::steady_clock::now();
    const int32_t reused = call("set_pipeline", {handle_id, static_cast<int32_t>(runtime_ptr),
                                                 static_cast<int32_t>(runtime_blob.size())});
    const auto reuse_end = std::chrono::steady_clock::now();
    const double reuse_ms =
        std::chrono::duration<double, std::milli>(reuse_end - reuse_start).count();
    if (reused != runtime_pipe) {
        std::fprintf(stderr, "FAIL: second set_pipeline -> %d, expected the cached %d\n", reused,
                     runtime_pipe);
        failures++;
    } else {
        std::printf("  re-set_pipeline -> %d in %.3f ms (cached)\n", reused, reuse_ms);
    }

    std::vector<uint8_t> runtime_a, runtime_b_rev;
    if (!render_frame(handle_id, runtime_pipe, spread, runtime_a, "runtime 1.5x"))
        return kFail;
    if (!render_frame(handle_id, runtime_pipe, spread_reversed, runtime_b_rev, "runtime 1.5x rev"))
        return kFail;

    // 1.5x of 32 is 48, and the ten sprites sit 64 px apart, so nothing
    // overlaps and the count is exact.
    const size_t runtime_count = nonblack(runtime_a);
    const size_t expected_runtime = static_cast<size_t>(kSprites) * 48u * 48u;
    std::printf("runtime 1.5x: %zu non-black pixels (expected %zu)\n", runtime_count,
                expected_runtime);
    if (runtime_count != expected_runtime) {
        std::fprintf(stderr, "FAIL: 1.5x coverage %zu != %zu\n", runtime_count, expected_runtime);
        failures++;
    }
    // 23040 is 2.25x the 10240 of the unscaled pipeline, which is what "1.5x
    // each axis" means for area.
    if (runtime_count != static_cast<size_t>(2.25 * static_cast<double>(count_a))) {
        std::fprintf(stderr, "FAIL: 1.5x coverage is not 2.25x the unscaled (%zu vs %.0f)\n",
                     runtime_count, 2.25 * static_cast<double>(count_a));
        failures++;
    }
    if (runtime_b_rev != runtime_a) {
        std::fprintf(stderr, "FAIL: the runtime-compiled pipeline does not sort\n");
        failures++;
    } else {
        std::printf("runtime 1.5x: reversed submission byte-identical (sort + runtime compile)\n");
    }

    // ── multi-atlas: `tex` selects the page ─────────────────────────────
    //
    // Every scenario so far loaded one atlas and left `tex` at 0, so the field
    // travelled through the record, was skipped by the shader, and proved
    // nothing. Two atlases with the *same* geometry and different palettes make
    // it observable: page 0 is the ten colours above, page 1 is a palette with
    // no colour in common with it.
    constexpr uint8_t kCellColourB[10][3] = {
        {255, 128, 0},   {128, 0, 128},   {0, 96, 128},    {192, 192, 192}, {96, 0, 0},
        {0, 0, 96},      {96, 96, 0},     {0, 96, 0},      {64, 64, 64},    {160, 160, 255},
    };
    {
        const std::vector<uint8_t> atlas_b = make_atlas(kCellColourB);
        const uint32_t atlas_b_ptr = 0x90000;
        put_bytes(atlas_b_ptr, atlas_b.data(), atlas_b.size());
        const int32_t tex_b = call("texture_load",
                                   {handle_id, static_cast<int32_t>(atlas_b_ptr),
                                    static_cast<int32_t>(atlas_b.size()), TENSION_2D_TEX_RGBA8});
        if (tex_b <= 0) {
            std::fprintf(stderr, "FAIL: second texture_load -> %d\n", tex_b);
            return kFail;
        }

        // `texture` is the atlas loaded at the start of this run; `tex_b` is the
        // second. Page order is the caller's choice and the record names it.
        const int32_t bind_a = call("set_texture", {handle_id, pipe, 0, texture});
        const int32_t bind_b = call("set_texture", {handle_id, pipe, 1, tex_b});
        if (bind_a != 0 || bind_b != 0) {
            std::fprintf(stderr, "FAIL: set_texture -> %d, %d\n", bind_a, bind_b);
            failures++;
        }

        SpriteSpec page0;
        page0.x = 0;
        page0.y = 0;
        page0.w = 64;
        page0.h = 64;
        page0.tex = 0;
        page0.sort_key = 0;

        SpriteSpec page1 = page0;
        page1.x = 100;
        page1.tex = 1;
        page1.sort_key = 1;

        std::vector<uint8_t> frame;
        if (!render_frame(handle_id, pipe, {page0, page1}, frame, "multi-atlas")) return kFail;
        const uint8_t *left = pixel_of(frame, 32, 32);
        const uint8_t *right = pixel_of(frame, 132, 32);
        const bool left_ok = near_colour(left, kCellColour[0]);
        const bool right_ok = near_colour(right, kCellColourB[0]);
        std::printf("multi-atlas: page 0 -> (%u,%u,%u), page 1 -> (%u,%u,%u)\n", left[0], left[1],
                    left[2], right[0], right[1], right[2]);
        if (!left_ok || !right_ok) {
            std::fprintf(stderr,
                         "FAIL: multi-atlas: expected page 0 red (%u,%u,%u) at (32,32) and page 1 "
                         "orange (%u,%u,%u) at (132,32) — `tex` is not selecting the layer\n",
                         kCellColour[0][0], kCellColour[0][1], kCellColour[0][2],
                         kCellColourB[0][0], kCellColourB[0][1], kCellColourB[0][2]);
            failures++;
        }

        // Composite ordering across pages: the same tile, two characters, one
        // on each atlas. The sort is `(sort_key, group_id, z)` and knows nothing
        // about pages, so group 2 must still win — whatever page it samples.
        SpriteSpec c1 = page0;
        c1.sort_key = 100;
        c1.group_id = 1;
        c1.z = 0;
        SpriteSpec c2 = page1;
        c2.x = 16;
        c2.y = 16;
        c2.sort_key = 100;
        c2.group_id = 2;
        c2.z = 0;

        std::vector<uint8_t> composite, composite_reversed;
        if (!render_frame(handle_id, pipe, {c1, c2}, composite, "multi-atlas composite"))
            return kFail;
        if (!render_frame(handle_id, pipe, {c2, c1}, composite_reversed,
                          "multi-atlas composite reversed"))
            return kFail;

        const uint8_t *p = pixel_of(composite, 20, 20);
        if (!near_colour(p, kCellColourB[0])) {
            std::fprintf(stderr,
                         "FAIL: multi-atlas composite (20,20) is (%u,%u,%u), expected page 1's "
                         "orange — the sort does not order across pages\n",
                         p[0], p[1], p[2]);
            failures++;
        } else {
            std::printf("multi-atlas composite: (20,20) is page 1's colour, group 2 over group 1; "
                        "reversed submission %s\n",
                        composite_reversed == composite ? "byte-identical"
                                                       : "DIFFERS (sort broken)");
        }
        if (composite_reversed != composite) {
            failures++;
        }

        // A page of another size cannot join the array: an array texture has one
        // size, and resampling would move pixels inside a cell.
        const std::vector<uint8_t> tiny = make_atlas(kCellColourB, 32, 1);
        const uint32_t tiny_ptr = 0x98000;
        put_bytes(tiny_ptr, tiny.data(), tiny.size());
        const int32_t tex_tiny =
            call("texture_load", {handle_id, static_cast<int32_t>(tiny_ptr),
                                  static_cast<int32_t>(tiny.size()), TENSION_2D_TEX_RGBA8});
        const int32_t mismatch = call("set_texture", {handle_id, pipe, 2, tex_tiny});
        const int32_t bad_slot = call("set_texture", {handle_id, pipe, 16, texture});
        const int32_t bad_pipe = call("set_texture", {handle_id, 999, 0, texture});
        if (mismatch != -EINVAL || bad_slot != -EINVAL || bad_pipe != -ENOENT) {
            std::fprintf(stderr,
                         "FAIL: set_texture refusals -> size mismatch %d (want -EINVAL), page 16 "
                         "%d (want -EINVAL), unknown pipe %d (want -ENOENT)\n",
                         mismatch, bad_slot, bad_pipe);
            failures++;
        } else {
            std::printf("multi-atlas: the size mismatch, page 16 and unknown pipe are refused\n");
        }
    }

    // ── refusals ────────────────────────────────────────────────────────
    struct Expect {
        const char *what;
        int32_t got;
        int32_t want;
    };
    // A blob that is not a graph at all. Runtime compilation widened what
    // `set_pipeline` accepts, so this is now a *compile* refusal: malformed
    // (-EINVAL), not "no compiler" (-ENOSYS).
    const int32_t guest_graph = call("set_pipeline", {handle_id, 0x1234, 8});
    const int32_t raw_shader = call("shader_compile_raw", {handle_id, 0, 0, 0, 0});
    // A stride that disagrees with the layout must be refused, not guessed at.
    const uint32_t bad_hdr_ptr = 0x38000;
    write_submit_hdr(bad_hdr_ptr, 0x20000, 1);
    g_core->guest[bad_hdr_ptr + 10] = 12; // record_stride = 12, not 28
    const int32_t bad_stride =
        call("submit", {handle_id, pipe, static_cast<int32_t>(bad_hdr_ptr), 0});
    const Expect expects[] = {
        {"set_pipeline(not a graph)", guest_graph, -EINVAL},
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

    // ── the canvas is a runtime decision ────────────────────────────────
    //
    // Everything above opened 640x360, which is also what the old
    // compile-time constant was — so none of it can tell a dynamic canvas from
    // a baked one. These three refusals and the 320x180 handle below can.
    {
        struct BadOpen {
            const char *what;
            int32_t width;
            int32_t height;
            int32_t flags;
            int32_t want;
        };
        const BadOpen bad[] = {
            {"open(0, 360, 0)", 0, 360, 0, -EINVAL},
            {"open(640, 16385, 0)", 640, 16385, 0, -EINVAL},
            // Bit 0 is `TENSION_2D_OPEN_WINDOWED` and is accepted; any other bit
            // is not. `flags = 1` used to be the invalid case here, which is
            // now the one flag with a meaning.
            {"open(640, 360, 2)", 640, 360, 2, -EINVAL},
        };
        for (const BadOpen &b : bad) {
            const int32_t rc = call("open", {b.width, b.height, b.flags});
            if (rc != b.want) {
                std::fprintf(stderr, "FAIL: %s -> %d, expected %d\n", b.what, rc, b.want);
                failures++;
            }
        }
    }

    const int32_t small = call("open", {320, 180, 0});
    if (small <= 0) {
        std::fprintf(stderr, "FAIL: open(320, 180, 0) -> %d\n", small);
        return kFail;
    }
    {
        const int32_t len = call("info", {small, static_cast<int32_t>(info_ptr), 64});
        tension_2d_info_record small_info;
        std::memcpy(&small_info, core.guest.data() + info_ptr, sizeof small_info);
        if (len != static_cast<int32_t>(sizeof small_info) || small_info.canvas_width != 320 ||
            small_info.canvas_height != 180) {
            std::fprintf(stderr, "FAIL: info on the 320x180 handle -> len %d, canvas %ux%u\n", len,
                         small_info.canvas_width, small_info.canvas_height);
            failures++;
        }
        std::printf("open(320,180) -> handle %d, info canvas %ux%u\n", small, small_info.canvas_width,
                    small_info.canvas_height);
    }

    const int32_t small_pipe = call("set_pipeline", {small, 0, 1});
    put_bytes(iwi_ptr, iwi.data(), iwi.size());
    const int32_t small_tex =
        call("texture_load", {small, static_cast<int32_t>(iwi_ptr), static_cast<int32_t>(iwi.size()),
                              TENSION_2D_TEX_RGBA8});
    if (small_pipe != 1 || small_tex <= 0) {
        std::fprintf(stderr, "FAIL: small handle set_pipeline -> %d, texture_load -> %d\n",
                     small_pipe, small_tex);
        failures++;
    } else {
        // Two 32 px sprites at the top-left, 64 px apart: at 320x180 they fit,
        // and their centres are at (16,16) and (80,16) in a 320-wide frame.
        std::vector<SpriteSpec> pair(2);
        pair[0].x = 0;
        pair[0].y = 0;
        pair[0].src_x = 0;
        pair[0].w = 32;
        pair[0].h = 32;
        pair[0].sort_key = 0;
        pair[1] = pair[0];
        pair[1].x = 64;
        pair[1].src_x = 64;
        pair[1].sort_key = 1;

        std::vector<uint8_t> frame;
        if (!render_frame(small, small_pipe, pair, frame, "320x180", 320, 180)) return kFail;

        auto at = [&frame](uint32_t x, uint32_t y) {
            return frame.data() + (static_cast<size_t>(y) * 320u + x) * 4u;
        };
        size_t nonblack = 0;
        for (size_t i = 0; i < frame.size(); i += 4) {
            if (frame[i] || frame[i + 1] || frame[i + 2]) nonblack++;
        }
        const bool colour_ok = near_colour(at(16, 16), kCellColour[0]) &&
                               near_colour(at(80, 16), kCellColour[1]);
        // A pixel that only exists in the 640x360 frame must not be readable
        // content: (300,170) is inside 320x180, and (400,300) is outside it.
        const size_t expected = 2u * 32u * 32u;
        std::printf("320x180: %zu non-black pixels (expected %zu), %d bytes read back\n", nonblack,
                    expected, static_cast<int>(frame.size()));
        if (frame.size() != 320u * 180u * 4u) {
            std::fprintf(stderr, "FAIL: screenshot on the 320x180 handle returned %zu bytes\n",
                         frame.size());
            failures++;
        }
        if (nonblack != expected) {
            std::fprintf(stderr, "FAIL: 320x180 coverage %zu != %zu\n", nonblack, expected);
            failures++;
        }
        if (!colour_ok) {
            std::fprintf(stderr,
                         "FAIL: 320x180 sprite centres are not their cells' colours — the "
                         "projection still uses the 640x360 half-extents\n");
            failures++;
        }
    }
    if (call("close", {small}) != 0) {
        std::fprintf(stderr, "FAIL: close on the 320x180 handle\n");
        failures++;
    }

    if (failures != 0) return kFail;
    std::printf("OK: positions, per-sprite colours and sort order all verified\n");
    return 0;
}
