/*
 * xinject — synthetic input for the input capability's measurement probe.
 *
 * XTest is the only way to make a real X server produce real input: the events
 * go through the same server path a device's would, so SDL sees them exactly as
 * it sees a trackpad's. Pushing SDL events into the guest's own process would
 * measure this repository and not the platform.
 *
 *   xinject motion <count> <duration_ms> <dx> <dy> <x> <y>
 *       Warp the pointer to (x, y) — inside the guest's window — then send
 *       `count` relative motion events of (dx, dy), spaced so the whole burst
 *       takes `duration_ms`. duration_ms 0 means "as fast as the server takes
 *       them", which is how the overflow case is produced.
 *   xinject keys <pairs> <pace_us>
 *       Send `pairs` press+release pairs of `a`, `pace_us` apart. The guest
 *       counts edges, so `pairs * 2` events reach it.
 *
 * It prints `BEGIN` immediately before the first event and `END <n>` after the
 * last, both flushed: the driver script anchors its clock to those lines rather
 * than to process start, which would include X connection setup.
 *
 * Build (the test runner does this):
 *   cc -O2 -o tension-input/build/xinject tension-input/tests/xinject.c \
 *      -lX11 -lXtst
 */

#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <X11/keysym.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static void sleep_us(long usec) {
    if (usec <= 0) return;
    struct timespec ts;
    ts.tv_sec = usec / 1000000L;
    ts.tv_nsec = (usec % 1000000L) * 1000L;
    nanosleep(&ts, NULL);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: xinject motion <count> <duration_ms> <dx> <dy> <x> <y>\n"
                        "       xinject keys <pairs> <pace_us>\n");
        return 64;
    }
    Display *dpy = XOpenDisplay(NULL);
    if (dpy == NULL) {
        fprintf(stderr, "xinject: cannot open display '%s'\n",
                getenv("DISPLAY") != NULL ? getenv("DISPLAY") : "(unset)");
        return 2;
    }
    int event_base = 0, error_base = 0, major = 0, minor = 0;
    if (!XTestQueryExtension(dpy, &event_base, &error_base, &major, &minor)) {
        fprintf(stderr, "xinject: this server has no XTEST extension\n");
        XCloseDisplay(dpy);
        return 3;
    }

    if (strcmp(argv[1], "motion") == 0 && argc >= 8) {
        const long count = atol(argv[2]);
        const long duration_ms = atol(argv[3]);
        const int dx = atoi(argv[4]);
        const int dy = atoi(argv[5]);
        const int x = atoi(argv[6]);
        const int y = atoi(argv[7]);

        /* The pointer has to be *inside* the window for motion to be delivered
         * to it; where the window ended up is the window system's answer, so the
         * caller asks and passes the centre in. */
        XWarpPointer(dpy, None, DefaultRootWindow(dpy), 0, 0, 0, 0, x, y);
        XSync(dpy, False);
        /* Let the enter event and any confinement warp settle before the
         * measured burst starts. */
        sleep_us(80000);

        const long interval_us = count > 1 && duration_ms > 0 ? (duration_ms * 1000L) / count : 0;
        printf("BEGIN\n");
        fflush(stdout);
        for (long i = 0; i < count; ++i) {
            XTestFakeRelativeMotionEvent(dpy, dx, dy, CurrentTime);
            XFlush(dpy);
            sleep_us(interval_us);
        }
        XSync(dpy, False);
        printf("END %ld\n", count);
        fflush(stdout);
    } else if (strcmp(argv[1], "keys") == 0 && argc >= 4) {
        const long pairs = atol(argv[2]);
        const long pace_us = atol(argv[3]);
        const KeySym sym = XStringToKeysym("a");
        const KeyCode code = XKeysymToKeycode(dpy, sym);
        if (code == 0) {
            fprintf(stderr, "xinject: this keymap has no 'a'\n");
            XCloseDisplay(dpy);
            return 4;
        }
        printf("BEGIN\n");
        fflush(stdout);
        for (long i = 0; i < pairs; ++i) {
            /* The time is printed per pair, from CLOCK_MONOTONIC, because the
             * driver's clock is the same clock (Node's hrtime is CLOCK_MONOTONIC
             * on Linux). Assuming "pair i was injected at i * pace" would drift
             * by however much each nanosleep overshoots, and the whole point of
             * this number is that it is measured rather than assumed. */
            struct timespec now;
            clock_gettime(CLOCK_MONOTONIC, &now);
            const long long micros = (long long)now.tv_sec * 1000000LL + now.tv_nsec / 1000LL;
            XTestFakeKeyEvent(dpy, code, True, CurrentTime);
            XTestFakeKeyEvent(dpy, code, False, CurrentTime);
            XFlush(dpy);
            printf("K %ld %lld\n", i, micros);
            fflush(stdout);
            sleep_us(pace_us);
        }
        XSync(dpy, False);
        printf("END %ld\n", pairs * 2);
        fflush(stdout);
    } else {
        fprintf(stderr, "xinject: unknown mode '%s'\n", argv[1]);
        XCloseDisplay(dpy);
        return 64;
    }

    XCloseDisplay(dpy);
    return 0;
}
