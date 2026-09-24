// The animation verb: one call per renderable per frame, absolute time within
// a clip (chunk 13c).
//
// The guest owns the clock. It names a clip the rig carries — the names the
// skeleton exporter wrote, `idle` / `run` / `jump` for the Kenney character —
// and an absolute time in milliseconds; the adapter finds the renderable's
// `SkeletonInstance`, enables the named animation, loops it, and calls
// `setTime` on it. The renderer deforms the mesh from there, exactly as it
// would have from the bone table — except that OGRE's own animation system is
// doing it, so a keyframed clip comes free and a guest that wants a frame
// counter rather than a physics step is a legitimate caller.
//
// Why absolute time and not a delta: the adapter drains the queue once a frame
// and only the newest request per renderable matters, so a guest that skips a
// frame or runs its loop faster than the renderer still lands on the time it
// meant. `timeMs` is within the clip, so a looping caller does
// `elapsed % duration` itself — the durations are the exporter's, and this
// verb does not report them (a `query_animation_duration` is a §12 item).
//
// Requires a **rigged** mesh drawn with a **PBS** material: HlmsUnlit's shader
// templates carry no skeletal animation at all (the same finding the bone table
// documents), so an Unlit rig animates on the CPU and never moves on screen.

import { writeString, lastWriteLength } from "../runtime/strings";

/** `ogre::submit_animation(renderableId, clip, timeMs)`: 0, or an errno. */
@external("ogre", "submit_animation")
declare function submitAnimationRaw(renderableId: i32, clipPtr: u32, clipLen: u32,
                                    timeMs: i32): i32;

/**
 * Put `renderableId`'s rig at `timeMs` into the clip `clipName`.
 *
 * Returns 0 when the request was queued (the adapter applies it before the next
 * frame and logs a refusal it finds there), `-28` (-ENOSPC) when the name does
 * not fit the guest's half of the STRING region, or the verb's own errno for a
 * malformed call (`-22` for an empty or over-long name, a zero renderable, or a
 * non-positive time).
 */
export function submitAnimation(renderableId: i32, clipName: string, timeMs: i32): i32 {
  const at = writeString(clipName);
  if (at == 0 && clipName.length > 0) return -28; // -ENOSPC: the half is full
  return submitAnimationRaw(renderableId, at, lastWriteLength, timeMs);
}
