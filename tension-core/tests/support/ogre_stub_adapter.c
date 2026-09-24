/*
 * The OGRE capability's stub adapter.
 *
 * It exists to prove the *shape* of the capability ABI end to end: an AssemblyScript
 * guest calls `ogre::queue_mesh_load`, gets a job id, waits, and receives a
 * `JOB_DONE` event whose payload resolves to a resource. Everything about OGRE
 * the renderer — the version pin, the HLMS materials, the scene, the render
 * thread — is chunk 2 and is not here.
 *
 * What it is not:
 *
 *   * not a renderer: no window, no GPU, no OGRE-Next linked (this file
 *     includes `tension_adapter.h` and nothing else);
 *   * not a loader: `queue_*_load` records a request and returns an id, and
 *     `publish` completes it — the same "the guest asks, the session decides
 *     when" split every capability follows;
 *   * not reentrant: its state is file-scope statics, like the reference echo
 *     adapter's, and `dlopen` on one path returns one image — so one process is
 *     one instance per adapter. The `adapter_ctx` vtable slot that would fix
 *     that is a recorded future-work item (`tension-ogre/DESIGN.md` §12);
 *     production use before it lands means one OGRE adapter per process, which
 *     is the plan anyway.
 *
 * The Job record it writes into the `JOB` region is the layout
 * `tension-framework/assembly/ogre/wire.ts` mirrors field for field:
 *
 *   0 job_id, 4 state, 8 kind, 12 flags, 16 priority, 20 resource_id,
 *   24 progress, 28 error, 32 name_offset, 36 name_length, 40 seq u64,
 *   48 reserved u64, 56 reserved2 u64  ->  64 bytes
 *
 * SPDX-License-Identifier: MIT
 */
#include <stdint.h>
#include <string.h>

#include "tension_adapter.h"

/* The classes and states the guest's wire.ts also names. */
#define OGRE_CLASS_JOB_DONE 4u
#define OGRE_JOB_SIZE 64u
#define OGRE_JOB_PENDING 0u
#define OGRE_JOB_DONE 2u
/* Not one of the guest's five: a slot that has been released is marked, so a
 * stale id reports "released" rather than the next job's state. */
#define OGRE_JOB_RELEASED 5u
#define OGRE_RES_MESH 0u
#define OGRE_RES_TEXTURE 1u

/* The verb ids this adapter's imports register with. */
#define OGRE_VERB_INIT 1u
#define OGRE_VERB_SHUTDOWN 2u
#define OGRE_VERB_QUEUE_MESH 3u
#define OGRE_VERB_QUEUE_TEXTURE 4u
#define OGRE_VERB_JOB_STATE 5u
#define OGRE_VERB_JOB_RELEASE 6u
#define OGRE_VERB_LAST_ERROR 7u

/* The config keys `ogre_init` accepts, matching the SDK's ConfigBuilder. */
#define OGRE_KEY_ABI_VERSION 1u
#define OGRE_KEY_RENDERER 2u
#define OGRE_KEY_HEADLESS 3u
#define OGRE_KEY_VSYNC 4u
#define OGRE_KEY_FRAME_HZ 5u
#define OGRE_KEY_WINDOW_WIDTH 6u
#define OGRE_KEY_WINDOW_HEIGHT 7u

/* The Job record, as the wire defines it. */
typedef struct {
    uint32_t job_id;
    uint32_t state;
    uint32_t kind;
    uint32_t flags;
    int32_t priority;
    uint32_t resource_id;
    float progress;
    int32_t error;
    uint32_t name_offset;
    uint32_t name_length;
    uint64_t seq;
    uint64_t reserved;
    uint64_t reserved2;
} ogre_job;

/* The core API, kept from init. The vtable has no context accessor, so an
 * adapter of this shape keeps its services in statics (rule: §12's adapter_ctx
 * item). */
static const tension_core_api *g_core;

/* The region offsets `region_lookup` answered at link time: the layout is a
 * compile-time constant, so these are stable for the session's lifetime. */
static uint32_t g_job_offset;
static uint32_t g_job_size;
static uint32_t g_resource_offset;
static uint32_t g_resource_size;
static uint32_t g_string_offset;
static uint32_t g_string_size;

/* The source id `register_source` returned, which every posted event carries. */
static uint32_t g_source;

/* Job bookkeeping. Ids are 1-based and never reused; the id's slot is `id - 1`. */
static uint32_t g_next_job_id = 1;
static uint32_t g_next_resource_id = 1;

/* The last refusal, for `ogre::last_error`. Empty means "nothing to report". */
static char g_last_error[256];
static uint32_t g_last_error_len;

static const char MSG_INIT[] = "ogre-stub: init";
static const char MSG_LINKED[] = "ogre-stub: seven imports registered";
static const char MSG_REGIONS[] = "ogre-stub: regions answered at link time";
static const char MSG_NO_REGIONS[] = "ogre-stub: a region did not answer at link time";
static const char MSG_DONE[] = "ogre-stub: a job completed";
static const char ERR_NO_SESSION[] = "no guest memory: the session is not open";
static const char ERR_BAD_JOB[] = "no such job";
static const char ERR_BAD_CONFIG[] = "the ogre config was refused";

static void say(const char *text, uint32_t len)
{
    if (g_core != NULL && g_core->log != NULL) {
        g_core->log(g_core->user, 1, text, len);
    }
}

static void note_error(const char *text, uint32_t len)
{
    uint32_t copy = len < sizeof(g_last_error) - 1 ? len : (uint32_t)sizeof(g_last_error) - 1;
    memcpy(g_last_error, text, copy);
    g_last_error[copy] = '\0';
    g_last_error_len = copy;
}

/* The address of job `id`'s record, or 0 when there is no session. */
static uint32_t job_address(uint32_t id)
{
    uint32_t slot;
    if (g_core == NULL || g_core->guest_size == NULL) return 0;
    if (id == 0) return 0;
    slot = (id - 1u) * OGRE_JOB_SIZE;
    if (slot + OGRE_JOB_SIZE > g_job_size) return 0;
    return g_job_offset + slot;
}

/* Write one Job record into the guest's JOB region. */
static int32_t store_job(const ogre_job *job)
{
    uint32_t at = job_address(job->job_id);
    if (at == 0) return -22; /* EINVAL */
    if (g_core->guest_write(g_core->user, at, job, (uint32_t)sizeof(ogre_job)) != 0) {
        return -5; /* EIO */
    }
    return 0;
}

/* Read job `id`'s record back out of the JOB region. */
static int32_t load_job(uint32_t id, ogre_job *out)
{
    uint32_t at = job_address(id);
    if (at == 0) return -22;
    if (g_core->guest_read(g_core->user, at, out, (uint32_t)sizeof(ogre_job)) != 0) return -5;
    return 0;
}

/*
 * ogre::init(cfg_ptr, cfg_len)
 *
 * Validates the argmap the way the session's decoder does — `abi_version`
 * first, a known key set, and no trailing bytes — because a capability's config
 * arriving wrong is a build mistake, not a runtime condition. The renderer and
 * headless keys are read and *ignored*: this stub renders nothing, so the only
 * honest answer to "which renderer" is "the one that does nothing", and the
 * keys exist to prove they cross.
 */
static int32_t ogre_init(void *ctx, const tension_core_api *core)
{
    (void)ctx;
    if (core == NULL || core->abi_version != TENSION_ADAPTER_ABI_VERSION) return -22;
    g_core = core;
    say(MSG_INIT, (uint32_t)(sizeof(MSG_INIT) - 1));
    return 0;
}

static int32_t ogre_init_call(void *ctx, const tension_value *args, uint32_t nargs,
                              tension_value *ret)
{
    uint32_t cfg_ptr;
    uint32_t cfg_len;
    uint8_t buf[512];
    uint32_t at;
    uint32_t count;
    uint32_t i;
    int32_t abi_seen = 0;

    (void)ctx;
    if (nargs != 2 || args == NULL || ret == NULL) return -22;
    if (g_core == NULL || g_core->guest_read == NULL || g_core->guest_size == NULL) return -38;
    cfg_ptr = (uint32_t)args[0].i32;
    cfg_len = (uint32_t)args[1].i32;
    if (cfg_len < 4 || cfg_len > sizeof(buf)) {
        note_error(ERR_BAD_CONFIG, (uint32_t)(sizeof(ERR_BAD_CONFIG) - 1));
        return -22;
    }
    if (g_core->guest_read(g_core->user, cfg_ptr, buf, cfg_len) != 0) return -5;

    memcpy(&count, buf, 4);
    at = 4;
    for (i = 0; i < count; i++) {
        uint32_t key;
        uint8_t tag;
        int64_t value;
        if (at + 13 > cfg_len) {
            note_error(ERR_BAD_CONFIG, (uint32_t)(sizeof(ERR_BAD_CONFIG) - 1));
            return -22;
        }
        memcpy(&key, buf + at, 4);
        tag = buf[at + 4];
        memcpy(&value, buf + at + 5, 8);
        at += 13;
        if (tag != 2) {
            note_error(ERR_BAD_CONFIG, (uint32_t)(sizeof(ERR_BAD_CONFIG) - 1));
            return -22;
        }
        if (i == 0) {
            if (key != OGRE_KEY_ABI_VERSION || value != 1) {
                note_error(ERR_BAD_CONFIG, (uint32_t)(sizeof(ERR_BAD_CONFIG) - 1));
                return -22;
            }
            abi_seen = 1;
            continue;
        }
        if (key < OGRE_KEY_RENDERER || key > OGRE_KEY_WINDOW_HEIGHT) {
            note_error(ERR_BAD_CONFIG, (uint32_t)(sizeof(ERR_BAD_CONFIG) - 1));
            return -22;
        }
    }
    if (!abi_seen || at != cfg_len) {
        note_error(ERR_BAD_CONFIG, (uint32_t)(sizeof(ERR_BAD_CONFIG) - 1));
        return -22;
    }
    g_last_error_len = 0;
    ret->i32 = 0;
    return 0;
}

/*
 * The shared body of the two queue verbs: read the name out of the STRING
 * region, take the next job id, and write a PENDING record into the JOB region.
 * Nothing is loaded here — `publish` is what completes jobs, and the guest
 * learns about that from a JOB_DONE event, not from this call's return.
 */
static int32_t queue_load(const tension_value *args, tension_value *ret, uint32_t kind)
{
    uint32_t name_ptr;
    uint32_t name_len;
    ogre_job job;
    int32_t status;

    if (args == NULL || ret == NULL) return -22;
    if (g_core == NULL || g_core->guest_size == NULL) return -38;
    name_ptr = (uint32_t)args[0].i32;
    name_len = (uint32_t)args[1].i32;
    if (name_len == 0 || name_len > 4096) return -22;
    if (name_ptr < g_string_offset || name_ptr + name_len > g_string_offset + g_string_size) {
        return -22; /* not a STRING-region pointer */
    }

    memset(&job, 0, sizeof(job));
    job.job_id = g_next_job_id++;
    job.state = OGRE_JOB_PENDING;
    job.kind = kind;
    job.priority = args[2].i32;
    job.name_offset = name_ptr;
    job.name_length = name_len;
    status = store_job(&job);
    if (status != 0) {
        note_error(ERR_NO_SESSION, (uint32_t)(sizeof(ERR_NO_SESSION) - 1));
        return status;
    }
    ret->i32 = (int32_t)job.job_id;
    return 0;
}

static int32_t ogre_queue_mesh_load(void *ctx, const tension_value *args, uint32_t nargs,
                                    tension_value *ret)
{
    (void)ctx;
    if (nargs != 3) return -22; /* (name_ptr, name_len, priority) */
    return queue_load(args, ret, OGRE_RES_MESH);
}

static int32_t ogre_queue_texture_load(void *ctx, const tension_value *args, uint32_t nargs,
                                       tension_value *ret)
{
    (void)ctx;
    if (nargs != 3) return -22;
    return queue_load(args, ret, OGRE_RES_TEXTURE);
}

static int32_t ogre_job_state(void *ctx, const tension_value *args, uint32_t nargs,
                              tension_value *ret)
{
    ogre_job job;
    int32_t status;

    (void)ctx;
    if (nargs != 2 || args == NULL || ret == NULL) return -22;
    if (g_core == NULL) return -38;
    status = load_job((uint32_t)args[0].i32, &job);
    if (status != 0) {
        note_error(ERR_BAD_JOB, (uint32_t)(sizeof(ERR_BAD_JOB) - 1));
        return -2; /* ENOENT */
    }
    if (g_core->guest_write(g_core->user, (uint32_t)args[1].i32, &job,
                            (uint32_t)sizeof(job)) != 0) {
        return -5;
    }
    ret->i32 = 0;
    return 0;
}

static int32_t ogre_job_release(void *ctx, const tension_value *args, uint32_t nargs,
                                tension_value *ret)
{
    ogre_job job;
    int32_t status;

    (void)ctx;
    if (nargs != 1 || args == NULL || ret == NULL) return -22;
    status = load_job((uint32_t)args[0].i32, &job);
    if (status != 0) return -2;
    /* Released slots are marked, not reused: ids are never recycled, so a stale
     * id keeps pointing at its own history rather than at a new job. */
    job.state = OGRE_JOB_RELEASED;
    if (store_job(&job) != 0) return -5;
    ret->i32 = 0;
    return 0;
}

static int32_t ogre_last_error(void *ctx, const tension_value *args, uint32_t nargs,
                               tension_value *ret)
{
    uint32_t cap;

    (void)ctx;
    if (nargs != 2 || args == NULL || ret == NULL) return -22;
    if (g_last_error_len == 0) {
        ret->i32 = -1; /* nothing to report */
        return 0;
    }
    cap = (uint32_t)args[1].i32;
    if (cap == 0) {
        ret->i32 = (int32_t)g_last_error_len; /* probe */
        return 0;
    }
    if (g_core == NULL || g_core->guest_write == NULL) return -38;
    if (g_core->guest_write(g_core->user, (uint32_t)args[0].i32, g_last_error,
                            g_last_error_len) != 0) {
        return -5;
    }
    ret->i32 = (int32_t)g_last_error_len;
    g_last_error_len = 0; /* consume */
    return 0;
}

/* ogre::shutdown() — no arguments, no return value beyond its status. */
static int32_t ogre_shutdown_call(void *ctx, const tension_value *args, uint32_t nargs,
                                  tension_value *ret)
{
    (void)ctx;
    (void)args;
    if (nargs != 0 || ret == NULL) return -22;
    ret->i32 = 0;
    return 0;
}

/*
 * publish: complete every PENDING job.
 *
 * The stub's "work" is the transition itself: a real adapter would have its
 * render thread fill the resource and hand the completion back, which is
 * exactly what this simulates — the guest is told by an event, and the Job
 * record is the authority the event points at.
 */
static int32_t ogre_publish(void *ctx, const tension_core_api *core)
{
    uint32_t id;
    (void)ctx;
    if (core == NULL || core->post_event == NULL) return -22;
    for (id = 1; id < g_next_job_id; id++) {
        ogre_job job;
        if (load_job(id, &job) != 0) continue;
        if (job.state != OGRE_JOB_PENDING) continue;
        job.state = OGRE_JOB_DONE;
        job.progress = 1.0f;
        job.resource_id = g_next_resource_id++;
        if (store_job(&job) != 0) continue;
        /* The event is a hint; the record is the truth. `a` carries the job id
         * and `b` the resource, which is what the guest's `onEvent` reads. */
        (void)core->post_event(core->user, g_source, OGRE_CLASS_JOB_DONE, 0,
                               job.job_id, job.resource_id, 0.0f, 0.0f, NULL);
        say(MSG_DONE, (uint32_t)(sizeof(MSG_DONE) - 1));
    }
    return 0;
}

static int32_t ogre_link(void *ctx, const tension_core_api *core)
{
    static const uint32_t two_i32[2] = { TENSION_VT_I32, TENSION_VT_I32 };
    static const uint32_t three_i32[3] = { TENSION_VT_I32, TENSION_VT_I32, TENSION_VT_I32 };
    static const uint32_t one_i32[1] = { TENSION_VT_I32 };

    (void)ctx;
    if (core == NULL) return -22;
    g_core = core;
    if (core->register_source == NULL || core->register_import == NULL ||
        core->region_lookup == NULL) {
        return -38;
    }
    if (core->register_source(core->user, "ogre", 0, &g_source) != 0) return -1;

    if (core->register_import(core->user, "ogre", "init", TENSION_VT_I32, two_i32, 2,
                              ogre_init_call, ctx, OGRE_VERB_INIT, 0) != 0) {
        return -1;
    }
    if (core->register_import(core->user, "ogre", "shutdown", TENSION_VT_I32, NULL, 0,
                              ogre_shutdown_call, ctx, OGRE_VERB_SHUTDOWN, 0) != 0) {
        return -1;
    }
    if (core->register_import(core->user, "ogre", "queue_mesh_load", TENSION_VT_I32, three_i32,
                              3, ogre_queue_mesh_load, ctx, OGRE_VERB_QUEUE_MESH, 0) != 0) {
        return -1;
    }
    if (core->register_import(core->user, "ogre", "queue_texture_load", TENSION_VT_I32,
                              three_i32, 3, ogre_queue_texture_load, ctx,
                              OGRE_VERB_QUEUE_TEXTURE, 0) != 0) {
        return -1;
    }
    if (core->register_import(core->user, "ogre", "job_state", TENSION_VT_I32, two_i32, 2,
                              ogre_job_state, ctx, OGRE_VERB_JOB_STATE, 0) != 0) {
        return -1;
    }
    if (core->register_import(core->user, "ogre", "job_release", TENSION_VT_I32, one_i32, 1,
                              ogre_job_release, ctx, OGRE_VERB_JOB_RELEASE, 0) != 0) {
        return -1;
    }
    if (core->register_import(core->user, "ogre", "last_error", TENSION_VT_I32, two_i32, 2,
                              ogre_last_error, ctx, OGRE_VERB_LAST_ERROR, 0) != 0) {
        return -1;
    }

    /* The regions this adapter needs, asked about at link time — which is both
     * how it learns the offsets and how the session learns what it must keep
     * in the arena (§7.2). */
    if (core->region_lookup(core->user, TENSION_REGION_JOB, &g_job_offset, &g_job_size) != 0 ||
        core->region_lookup(core->user, TENSION_REGION_RESOURCE, &g_resource_offset,
                            &g_resource_size) != 0 ||
        core->region_lookup(core->user, TENSION_REGION_RESOURCE_REQ, &g_resource_offset,
                            &g_resource_size) != 0 ||
        core->region_lookup(core->user, TENSION_REGION_STRING, &g_string_offset,
                            &g_string_size) != 0) {
        say(MSG_NO_REGIONS, (uint32_t)(sizeof(MSG_NO_REGIONS) - 1));
        return -1;
    }
    say(MSG_REGIONS, (uint32_t)(sizeof(MSG_REGIONS) - 1));
    say(MSG_LINKED, (uint32_t)(sizeof(MSG_LINKED) - 1));
    return 0;
}

static int32_t ogre_shutdown_hook(void *ctx)
{
    (void)ctx;
    g_core = NULL;
    return 0;
}

static void ogre_destroy(void *ctx)
{
    (void)ctx;
}

static const tension_adapter OGRE_STUB_ADAPTER = {
    .abi_version = TENSION_ADAPTER_ABI_VERSION,
    .name = "ogre-stub",
    .flags = 0,
    .init = ogre_init,
    .link = ogre_link,
    .publish = ogre_publish,
    .apply = NULL,
    .shutdown = ogre_shutdown_hook,
    .destroy = ogre_destroy,
};

const tension_adapter *tension_adapter_v1(void)
{
    return &OGRE_STUB_ADAPTER;
}
