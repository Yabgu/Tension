// loader_test.cpp — the loader's unit tests.
//
// No OGRE, no guest, no session: a mock backend stands in for the renderer and
// the tests read the loader's own bookkeeping. That is the point of the thread
// split — everything except "parse these bytes into a Mesh2" is testable
// without a GPU, and the part that is not is one method on the backend.
//
//   ./build.sh --test

#include "../src/loader.h"

#include <unistd.h>

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <memory>
#include <fstream>
#include <string>
#include <vector>

#include "../include/tension_ogre.h"

using namespace tension_ogre;

namespace {

int failures = 0;
int checks = 0;

void check(bool ok, const std::string &what) {
    ++checks;
    if (!ok) {
        ++failures;
        std::printf("  FAIL %s\n", what.c_str());
    }
}

void check_eq(uint64_t got, uint64_t want, const std::string &what) {
    ++checks;
    if (got != want) {
        ++failures;
        std::printf("  FAIL %s: got %llu, want %llu\n", what.c_str(),
                    static_cast<unsigned long long>(got), static_cast<unsigned long long>(want));
    }
}

/// A backend that realises everything, remembers what it was asked to do, and
/// can be told to refuse.
class MockBackend final : public Backend {
  public:
    int32_t start(const Config &, StatusWriter &) override { return 0; }
    int32_t frame(StatusWriter &) override { return 0; }
    int32_t stop(StatusWriter &) override { return 0; }
    const char *name() const override { return "mock"; }

    int32_t realise_mesh(const uint8_t *bytes, size_t len, ResourceHandle *out) override {
        meshes += 1;
        last_mesh_bytes = len;
        last_mesh_magic_ok = len > 0 && bytes[0] == '[';
        if (refuse) return -EIO;
        *out = next_handle++;
        return 0;
    }
    int32_t realise_texture(const uint8_t *bytes, size_t len, ResourceHandle *out) override {
        textures += 1;
        last_texture_bytes = len;
        (void)bytes;
        if (refuse) return -ENOSYS;
        *out = next_handle++;
        return 0;
    }
    int32_t discard_resource(ResourceHandle) override {
        discarded += 1;
        return 0;
    }
    int32_t apply_submissions(const SceneMirror &) override { return 0; }
    int32_t request_readback() override { return -ENOSYS; }
    int32_t readback(uint8_t **out_ptr, size_t *out_len) override {
        if (out_ptr) *out_ptr = nullptr;
        if (out_len) *out_len = 0;
        return -ENOENT;
    }

    int meshes = 0;
    int textures = 0;
    int discarded = 0;
    size_t last_mesh_bytes = 0;
    bool last_mesh_magic_ok = false;
    size_t last_texture_bytes = 0;
    bool refuse = false;
    ResourceHandle next_handle = 100;
};

struct Recorder {
    std::vector<std::pair<uint32_t, uint32_t>> events; // (class, a)
    std::vector<std::string> logs;
    size_t bytes_written = 0;
    int writes = 0;
    int32_t refuse_after = -1; // refuse the Nth write (0-based) and later

    LoaderSink sink() {
        LoaderSink s;
        s.post_event = [this](uint32_t class_id, uint32_t a, uint32_t) {
            events.emplace_back(class_id, a);
        };
        s.log = [this](int32_t, const std::string &message) { logs.push_back(message); };
        return s;
    }

    Loader::GuestWrite write() {
        return [this](uint32_t, const void *, uint32_t len) -> int32_t {
            if (refuse_after >= 0 && writes >= refuse_after) return -ENOSPC;
            writes += 1;
            bytes_written += len;
            return 0;
        };
    }

    size_t count(uint32_t class_id) const {
        size_t total = 0;
        for (const auto &event : events) total += event.first == class_id ? 1 : 0;
        return total;
    }
};

/// A directory of fixture files, removed when the test ends.
struct Fixtures {
    std::filesystem::path dir;

    Fixtures() {
        dir = std::filesystem::temp_directory_path() /
              ("tension-loader-test-" + std::to_string(::getpid()));
        std::filesystem::create_directories(dir);
        write("good.mesh", std::string("[MeshSerializer_v1.8]") + std::string(64, '\0'));
        write("bad.mesh", std::string("not a mesh at all"));
        write("good.png", std::string("\x89PNG\r\n\x1a\n", 8) + std::string(64, '\0'));
    }
    ~Fixtures() {
        std::error_code ignored;
        std::filesystem::remove_all(dir, ignored);
    }

    void write(const std::string &name, const std::string &content) {
        std::ofstream file(dir / name, std::ios::binary);
        file.write(content.data(), static_cast<std::streamsize>(content.size()));
    }
};

void test_queue_allocates_sequential_ids() {
    std::printf("test_queue_allocates_sequential_ids\n");
    Fixtures fixtures;
    std::unique_ptr<Loader> loader = std::make_unique<Loader>();
    loader->set_search_paths({fixtures.dir.string()});
    const int32_t first = loader->queue(TENSION_OGRE_RES_KIND_MESH, "good.mesh", 0, 0, 0);
    const int32_t second = loader->queue(TENSION_OGRE_RES_KIND_MESH, "good.mesh", 0, 0, 0);
    const int32_t third = loader->queue(TENSION_OGRE_RES_KIND_TEXTURE, "good.png", 0, 0, 0);
    check_eq(first, 1, "the first job id");
    check_eq(second, 2, "the second job id");
    check_eq(third, 3, "the third job id");
    check_eq(loader->live_jobs(), 3, "three live jobs");
}

void test_queue_full_returns_enospc() {
    std::printf("test_queue_full_returns_enospc\n");
    Fixtures fixtures;
    std::unique_ptr<Loader> loader = std::make_unique<Loader>();
    loader->set_search_paths({fixtures.dir.string()});
    for (uint32_t index = 0; index < Loader::kCapacity; ++index) {
        const int32_t id = loader->queue(TENSION_OGRE_RES_KIND_MESH, "missing.mesh", 0, 0, 0);
        if (id <= 0) {
            check(false, "queue refused before the table was full");
            return;
        }
    }
    check_eq(loader->free_slots(), 0, "no free slots left");
    check_eq(static_cast<uint64_t>(loader->queue(TENSION_OGRE_RES_KIND_MESH, "missing.mesh", 0, 0, 0)),
             static_cast<uint64_t>(-ENOSPC), "the 769th job is refused with -ENOSPC");
}

void test_job_release_returns_slot_to_free_list() {
    std::printf("test_job_release_returns_slot_to_free_list\n");
    Fixtures fixtures;
    std::unique_ptr<Loader> loader = std::make_unique<Loader>();
    loader->set_search_paths({fixtures.dir.string()});
    const int32_t first = loader->queue(TENSION_OGRE_RES_KIND_MESH, "good.mesh", 0, 0, 0);
    const uint32_t slot_before_release = loader->slot_of(static_cast<uint32_t>(first));
    check_eq(loader->job_release(static_cast<uint32_t>(first)), 0, "release succeeds");
    check_eq(loader->free_slots(), Loader::kCapacity, "the slot is free again");
    check_eq(static_cast<uint64_t>(loader->job_release(static_cast<uint32_t>(first))),
             static_cast<uint64_t>(-ENOENT), "releasing twice is -ENOENT");

    const int32_t second = loader->queue(TENSION_OGRE_RES_KIND_MESH, "good.mesh", 0, 0, 0);
    check_eq(second, first, "the freed id is handed straight back");
    check_eq(loader->slot_of(static_cast<uint32_t>(second)), slot_before_release,
             "the freed slot was reused");
    const JobSlot slot = loader->job_at(loader->slot_of(static_cast<uint32_t>(second)));
    check_eq(slot.job_id, static_cast<uint64_t>(second), "and it holds the new job id");
    check(slot.state == TENSION_OGRE_JOB_PENDING || slot.state == TENSION_OGRE_JOB_LOADING,
          "which starts pending (or is already loading — the worker races the test)");
}

void test_job_state_unknown_id_returns_enoent() {
    std::printf("test_job_state_unknown_id_returns_enoent\n");
    std::unique_ptr<Loader> loader = std::make_unique<Loader>();
    uint8_t record[TENSION_OGRE_JOB_RECORD_BYTES] = {};
    check_eq(static_cast<uint64_t>(loader->job_state(7, record)), static_cast<uint64_t>(-ENOENT),
             "an id that is not in the table");
    check_eq(static_cast<uint64_t>(loader->job_state(0, record)), static_cast<uint64_t>(-ENOENT),
             "id 0 is never valid");
}

void test_mirror_writes_only_dirty_slots() {
    std::printf("test_mirror_writes_only_dirty_slots\n");
    Fixtures fixtures;
    std::unique_ptr<Loader> loader = std::make_unique<Loader>();
    loader->set_search_paths({fixtures.dir.string()});
    loader->queue(TENSION_OGRE_RES_KIND_MESH, "good.mesh", 0, 0, 0);

    Recorder recorder;
    const size_t first = loader->mirror_to_region(recorder.write(), 0x1000, 0x2000);
    check_eq(first, TENSION_OGRE_JOB_RECORD_BYTES, "one job record written");
    check(!loader->has_dirty(), "nothing is dirty afterwards");
    const size_t second = loader->mirror_to_region(recorder.write(), 0x1000, 0x2000);
    check_eq(second, 0, "a clean mirror writes nothing");

    // A refused write (the publish budget) leaves the slot dirty for the next
    // epoch, and stops the pass rather than pushing on.
    loader->queue(TENSION_OGRE_RES_KIND_MESH, "good.mesh", 0, 0, 0);
    Recorder refusing;
    refusing.refuse_after = 0;
    const size_t third = loader->mirror_to_region(refusing.write(), 0x1000, 0x2000);
    check_eq(third, 0, "the refused write wrote nothing");
    check(loader->has_dirty(), "and the slot stays dirty");
}

void test_worker_reads_bytes_and_completes() {
    std::printf("test_worker_reads_bytes_and_completes\n");
    Fixtures fixtures;
    std::unique_ptr<Loader> loader = std::make_unique<Loader>();
    Recorder recorder;
    loader->set_sink(recorder.sink());
    loader->set_search_paths({fixtures.dir.string()});

    const int32_t job = loader->queue(TENSION_OGRE_RES_KIND_MESH, "good.mesh", 11, 22, 0);
    check(loader->wait_for_idle(5000), "the worker goes idle");

    MockBackend backend;
    loader->drain_completions(backend);
    check_eq(backend.meshes, 1, "the backend realised one mesh");
    check(backend.last_mesh_bytes > 64, "with the file's bytes");
    check(backend.last_mesh_magic_ok, "the bytes start with the mesh magic");

    const uint32_t at = loader->slot_of(static_cast<uint32_t>(job));
    const JobSlot slot = loader->job_at(at);
    check_eq(slot.state, TENSION_OGRE_JOB_DONE, "the job is DONE");
    check_eq(slot.resource_id, 1, "and has resource id 1");
    check_eq(slot.job_id, static_cast<uint64_t>(job), "under the id it was given");
    check_eq(recorder.count(TENSION_OGRE_CLASS_JOB_DONE), 1, "one JOB_DONE posted");

    const ResourceSlot resource = loader->resource_at(1);
    check_eq(resource.state, TENSION_OGRE_RES_STATE_READY, "the resource record is READY");
    check_eq(resource.kind, TENSION_OGRE_RES_KIND_MESH, "and knows it is a mesh");

    uint8_t record[TENSION_OGRE_JOB_RECORD_BYTES] = {};
    check_eq(loader->job_state(static_cast<uint32_t>(job), record), 0, "job_state copies");
    const uint32_t copied_state = static_cast<uint32_t>(record[4]) |
                                  (static_cast<uint32_t>(record[5]) << 8) |
                                  (static_cast<uint32_t>(record[6]) << 16) |
                                  (static_cast<uint32_t>(record[7]) << 24);
    check_eq(copied_state, TENSION_OGRE_JOB_DONE, "and the copy says DONE");
    const uint32_t copied_resource = static_cast<uint32_t>(record[20]) |
                                     (static_cast<uint32_t>(record[21]) << 8);
    check_eq(copied_resource, 1, "and carries the resource id");
}

void test_worker_reports_enoent_for_missing_file() {
    std::printf("test_worker_reports_enoent_for_missing_file\n");
    Fixtures fixtures;
    std::unique_ptr<Loader> loader = std::make_unique<Loader>();
    Recorder recorder;
    loader->set_sink(recorder.sink());
    loader->set_search_paths({fixtures.dir.string()});

    loader->queue(TENSION_OGRE_RES_KIND_MESH, "not-there.mesh", 0, 0, 0);
    check(loader->wait_for_idle(5000), "the worker goes idle");

    MockBackend backend;
    loader->drain_completions(backend);
    check_eq(backend.meshes, 0, "nothing was realised");
    const JobSlot slot = loader->job_at(loader->slot_of(1));
    check_eq(slot.state, TENSION_OGRE_JOB_FAILED, "the job failed");
    check_eq(static_cast<uint64_t>(slot.error), static_cast<uint64_t>(-ENOENT), "with -ENOENT");
    check_eq(recorder.count(TENSION_OGRE_CLASS_JOB_FAILED), 1, "one JOB_FAILED posted");
}

void test_worker_reports_eio_for_bad_magic() {
    std::printf("test_worker_reports_eio_for_bad_magic\n");
    Fixtures fixtures;
    std::unique_ptr<Loader> loader = std::make_unique<Loader>();
    Recorder recorder;
    loader->set_sink(recorder.sink());
    loader->set_search_paths({fixtures.dir.string()});

    loader->queue(TENSION_OGRE_RES_KIND_MESH, "bad.mesh", 0, 0, 0);
    check(loader->wait_for_idle(5000), "the worker goes idle");

    MockBackend backend;
    loader->drain_completions(backend);
    const JobSlot slot = loader->job_at(loader->slot_of(1));
    check_eq(slot.state, TENSION_OGRE_JOB_FAILED, "a file of the wrong kind fails");
    check_eq(static_cast<uint64_t>(slot.error), static_cast<uint64_t>(-EIO), "with -EIO");
    check_eq(backend.meshes, 0, "and never reaches the renderer");
}

void test_backend_refusal_fails_the_job() {
    std::printf("test_backend_refusal_fails_the_job\n");
    Fixtures fixtures;
    std::unique_ptr<Loader> loader = std::make_unique<Loader>();
    Recorder recorder;
    loader->set_sink(recorder.sink());
    loader->set_search_paths({fixtures.dir.string()});

    loader->queue(TENSION_OGRE_RES_KIND_TEXTURE, "good.png", 0, 0, 0);
    check(loader->wait_for_idle(5000), "the worker goes idle");

    MockBackend backend;
    backend.refuse = true; // e.g. backend_none's -ENOSYS, or a decode failure
    loader->drain_completions(backend);
    const JobSlot slot = loader->job_at(loader->slot_of(1));
    check_eq(slot.state, TENSION_OGRE_JOB_FAILED, "a refused realisation fails the job");
    check_eq(static_cast<uint64_t>(slot.error), static_cast<uint64_t>(-ENOSYS),
             "with the backend's errno");
    check_eq(recorder.count(TENSION_OGRE_CLASS_JOB_FAILED), 1, "one JOB_FAILED posted");
}

void test_sweep_fails_in_flight_jobs() {
    std::printf("test_sweep_fails_in_flight_jobs\n");
    std::unique_ptr<Loader> loader = std::make_unique<Loader>();
    loader->queue(TENSION_OGRE_RES_KIND_MESH, "never-read.mesh", 0, 0, 0);
    loader->sweep_failed(-EIO);
    const JobSlot slot = loader->job_at(loader->slot_of(1));
    check_eq(slot.state, TENSION_OGRE_JOB_FAILED, "an in-flight job is failed by the sweep");
    check_eq(static_cast<uint64_t>(slot.error), static_cast<uint64_t>(-EIO), "with -EIO");
}

} // namespace

int main() {
    std::setvbuf(stdout, nullptr, _IONBF, 0);
    test_queue_allocates_sequential_ids();
    test_queue_full_returns_enospc();
    test_job_release_returns_slot_to_free_list();
    test_job_state_unknown_id_returns_enoent();
    test_mirror_writes_only_dirty_slots();
    test_worker_reads_bytes_and_completes();
    test_worker_reports_enoent_for_missing_file();
    test_worker_reports_eio_for_bad_magic();
    test_backend_refusal_fails_the_job();
    test_sweep_fails_in_flight_jobs();
    std::printf("%d checks, %d failures\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
