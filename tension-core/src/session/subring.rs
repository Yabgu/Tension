//! The arena side of delivery: the ten per-class sub-rings inside `EVENT_TABLE`
//! (`DESIGN.md` §3.4), and the transfer that moves what the posting face queued
//! into the ring the guest reads.
//!
//! **The model, in one place.** A sub-ring is a linear buffer of `capacity`
//! slots with two counters:
//!
//! - `head` — how many records the session has written and not yet had
//!   compacted away. The session writes it, and a record's slot is `head` (the
//!   buffer is kept dense from slot 0, which is what lets `onBatch` hand the
//!   guest one contiguous run).
//! - `tail` — how many records the guest has consumed. The **guest** writes it;
//!   it is space reclaim, not an acknowledgement (§3.3), and nothing in this
//!   module writes it except [`compact_subring`].
//!
//! When the buffer is full and the guest has reclaimed, [`compact_subring`]
//! slides the live records to the front, zeroes the tail and bumps the
//! generation — the "compacting on wrap" of §3.3. When the buffer is full and
//! the guest has reclaimed nothing, the append is refused and the caller counts
//! a drop: the session never overwrites a record the guest has not consumed.
//!
//! Nothing here is called by a verb yet. `flush_class_to_ring` is exercised by
//! the tests below and will be the epoch's publish step (A2b).

// Everything in this module is the epoch's publish step (A2b). Until that
// round exists, the tests below are the only callers — which is why the
// unused-in-the-run lint is off here and comes back with the epoch.
#![cfg_attr(not(test), allow(dead_code))]

use super::arena::{self, CLASS_COUNT, EVENT_RECORD_SIZE, RING_HEADER_SIZE};
use super::posting::ClassQueue;

/// A refusal from the arena side.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum SubringError {
    /// No such class in this chunk.
    UnknownClass { class: u32 },
    /// The sub-ring has no room: `head == capacity` and the guest has reclaimed
    /// nothing. The caller decides between dropping and reporting.
    Full { class: u32, capacity: u32 },
    /// The arena slice is too small for the sub-ring the capacities describe.
    Layout(arena::LayoutError),
    /// The header's own `capacity` disagrees with the capacities the session
    /// holds. That is not something the session does; it means something else
    /// wrote the header, and a refusal beats arithmetic on a number nobody
    /// agreed to.
    HeaderMismatch {
        class: u32,
        header: u32,
        expected: u32,
    },
}

impl From<arena::LayoutError> for SubringError {
    fn from(error: arena::LayoutError) -> SubringError {
        SubringError::Layout(error)
    }
}

impl SubringError {
    /// `-EINVAL` throughout: every one of these is a caller-side mistake or an
    /// arena the session did not write. There is no errno for "the arena moved".
    pub fn errno(&self) -> i32 {
        -22
    }
}

impl std::fmt::Display for SubringError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SubringError::UnknownClass { class } => {
                write!(f, "class {class} does not exist: this chunk has 0-{}", CLASS_COUNT - 1)
            }
            SubringError::Full { class, capacity } => {
                write!(f, "class {class}'s ring is full ({capacity} records, none reclaimed)")
            }
            SubringError::Layout(why) => write!(f, "the sub-ring does not fit the arena: {why:?}"),
            SubringError::HeaderMismatch {
                class,
                header,
                expected,
            } => write!(
                f,
                "class {class}'s header claims capacity {header}, but the session's is {expected}: \
                 the arena is not the one session_open wrote"
            ),
        }
    }
}

/// What one flush did.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct FlushResult {
    /// Records appended to the class's sub-ring.
    pub delivered: u32,
    /// Records the ring had no room for. Counted, never silently overwritten.
    pub dropped: u32,
    /// The slot the first delivered record sits in — what a `BATCHED` callback
    /// is handed as `table_ptr`. Only meaningful when `delivered > 0`: the run
    /// is contiguous from here (the flush makes room *before* it appends, so no
    /// compaction can move the run out from under the pointer).
    pub first_slot: u32,
}

/// The byte offset of a class's `TableHeader` inside the arena.
///
/// Derived from the capacities the session opened with — `session_open` lets a
/// guest state per-class ring capacities, so the geometry is a function of the
/// live config and not of the defaults. `arena::ring_offset` has done this
/// arithmetic since A1; this is the checked form of it.
pub fn event_subring_offset(
    capacities: &[u32; CLASS_COUNT],
    class: u32,
) -> Result<usize, SubringError> {
    if class as usize >= CLASS_COUNT {
        return Err(SubringError::UnknownClass { class });
    }
    Ok(arena::ring_offset(capacities, class as usize))
}

/// A class's `TableHeader` and the `capacity * 32` bytes of slots behind it.
///
/// The slots come back as a slice rather than an array: `capacity` is a runtime
/// number, so `&[u8; capacity * 32]` is not a type Rust can spell. The slice is
/// exactly that many bytes long, which is the property callers want.
pub fn event_subring_slice<'a>(
    arena: &'a [u8],
    capacities: &[u32; CLASS_COUNT],
    class: u32,
) -> Result<(arena::RingHeader, &'a [u8]), SubringError> {
    let at = event_subring_offset(capacities, class)?;
    let capacity = capacities[class as usize] as usize;
    let slots_at = at + RING_HEADER_SIZE;
    let slots_end = slots_at + capacity * EVENT_RECORD_SIZE;
    if slots_end > arena.len() {
        return Err(SubringError::Layout(arena::LayoutError::BufferTooSmall {
            need: slots_end,
            have: arena.len(),
        }));
    }
    Ok((arena::ring_header(arena, at), &arena[slots_at..slots_end]))
}

/// Initialize one class's sub-ring header: empty, at the given capacity.
///
/// Delegates to `arena::write_ring_header`, which is the same write
/// `session_open` performs for all ten classes at once — this exists so the
/// tests and A2b can name one class without restating the offset arithmetic.
pub fn write_event_subring_header(
    arena: &mut [u8],
    capacities: &[u32; CLASS_COUNT],
    class: u32,
    capacity: u32,
) -> Result<(), SubringError> {
    let at = event_subring_offset(capacities, class)?;
    arena::write_ring_header(arena, at, capacity)?;
    Ok(())
}

/// Append one record to a class's sub-ring, or refuse because it is full.
///
/// Writes at slot `head`, advances `head`, and **never touches `tail`** — that
/// counter belongs to the guest. A full ring is a refusal, not an overwrite:
/// see [`compact_subring`] for what the caller does about it.
pub fn append_event_to_subring(
    arena: &mut [u8],
    capacities: &[u32; CLASS_COUNT],
    class: u32,
    record: &arena::EventRecord,
) -> Result<(), SubringError> {
    let at = event_subring_offset(capacities, class)?;
    let capacity = capacities[class as usize];
    let header = arena::ring_header(arena, at);
    if header.capacity != capacity {
        return Err(SubringError::HeaderMismatch {
            class,
            header: header.capacity,
            expected: capacity,
        });
    }
    if header.head >= capacity {
        return Err(SubringError::Full { class, capacity });
    }
    let slot = at + RING_HEADER_SIZE + header.head as usize * EVENT_RECORD_SIZE;
    arena::write_event_record(arena, slot, record)?;
    arena::set_ring_head(arena, at, header.head + 1)?;
    Ok(())
}

/// Make room in a sub-ring from what the guest has reclaimed.
///
/// Slides the live records (`[tail, head)`) down to the front of the buffer,
/// sets `head` to the number of live records, zeroes `tail`, and bumps the
/// generation. The generation is the guest's signal that the tail it knew about
/// has moved: it is a rebase, and a guest that is mid-read can see it happened.
///
/// Returns how many slots were freed — `0` when the guest has reclaimed nothing
/// (or has written a tail that makes no sense), which is the case the caller
/// counts as a drop. This is the only place the session writes a tail.
pub fn compact_subring(
    arena: &mut [u8],
    capacities: &[u32; CLASS_COUNT],
    class: u32,
) -> Result<u32, SubringError> {
    let at = event_subring_offset(capacities, class)?;
    let capacity = capacities[class as usize];
    let header = arena::ring_header(arena, at);
    if header.capacity != capacity {
        return Err(SubringError::HeaderMismatch {
            class,
            header: header.capacity,
            expected: capacity,
        });
    }

    let head = header.head as usize;
    let tail = header.tail as usize;
    // A tail at or past the head means the guest has not left anything to
    // preserve (and a tail beyond it is a number the session will not act on).
    if tail == 0 || tail > head {
        return Ok(0);
    }

    let slots_at = at + RING_HEADER_SIZE;
    let live = head - tail;
    if live > 0 {
        arena.copy_within(
            slots_at + tail * EVENT_RECORD_SIZE..slots_at + head * EVENT_RECORD_SIZE,
            slots_at,
        );
    }
    arena::set_ring_head(arena, at, live as u32)?;
    arena::set_ring_tail(arena, at, 0)?;
    arena::set_ring_generation(arena, at, header.generation.wrapping_add(1))?;
    Ok(tail as u32)
}

/// Drain one class's queue into its sub-ring: the publish step the epoch (A2b)
/// will call, and the only place the two halves of A2a meet.
///
/// Per record: append if there is room; if the ring is full, try compaction
/// once (the guest may have reclaimed since) and append again; if that fails,
/// count a drop. Nothing is ever overwritten.
///
/// Returns a `Result` rather than a bare `FlushResult` even though the brief's
/// sketch did not: a `SubringError` here means the arena is not the one the
/// session wrote or the class does not exist, and folding that into "dropped"
/// would turn a session bug into a statistic.
pub fn flush_class_to_ring(
    arena: &mut [u8],
    capacities: &[u32; CLASS_COUNT],
    class: u32,
    queue: &ClassQueue,
) -> Result<FlushResult, SubringError> {
    // Validate the class and the geometry before draining: a refused flush must
    // not have emptied the queue.
    let _ = event_subring_slice(arena, capacities, class)?;
    if queue.class() != class {
        return Err(SubringError::UnknownClass { class: queue.class() });
    }

    let records = queue.drain();
    if records.is_empty() {
        return Ok(FlushResult::default());
    }

    // Make room **once, before appending**: compacting halfway through a run
    // would slide the records already written out from under the pointer the
    // callback is about to be handed. After this, the flush appends or drops.
    let at = event_subring_offset(capacities, class)?;
    if arena::ring_header(arena, at).head >= capacities[class as usize] {
        let _ = compact_subring(arena, capacities, class)?;
    }
    let mut result = FlushResult {
        first_slot: arena::ring_header(arena, at).head,
        ..FlushResult::default()
    };

    for fields in records {
        let record = arena::EventRecord {
            seq: fields.seq,
            class,
            flags: fields.flags,
            a: fields.a,
            b: fields.b,
            f0: fields.f0,
            f1: fields.f1,
        };
        match append_event_to_subring(arena, capacities, class, &record) {
            Ok(()) => result.delivered += 1,
            // No room, and the guest has reclaimed nothing: the record is
            // counted and dropped. Nothing is ever overwritten.
            Err(SubringError::Full { .. }) => result.dropped += 1,
            Err(error) => return Err(error),
        }
    }
    queue.note_flushed(result.delivered, result.dropped);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::posting::PostingSide;

    /// The default capacities: the widths the frozen table states.
    fn capacities() -> [u32; CLASS_COUNT] {
        arena::DEFAULT_RING_CAPACITIES
    }

    /// Tiny rings, so "full" is three records rather than four thousand.
    fn tiny() -> [u32; CLASS_COUNT] {
        [2; CLASS_COUNT]
    }

    /// A whole arena, the size of the frozen layout — what `prepare_arena`
    /// leaves behind.
    fn arena_bytes() -> Vec<u8> {
        let mut arena = vec![0u8; arena::LAYOUT_FLOOR];
        for (class, capacity) in capacities().iter().enumerate() {
            write_event_subring_header(&mut arena, &capacities(), class as u32, *capacity)
                .expect("the header fits");
        }
        arena
    }

    fn record(seq: u64, class: u32) -> arena::EventRecord {
        arena::EventRecord {
            seq,
            class,
            flags: 0,
            a: seq as u32,
            b: 0,
            f0: 1.5,
            f1: -2.25,
        }
    }

    fn header(arena: &[u8], class: u32) -> arena::RingHeader {
        arena::ring_header(arena, arena::ring_offset(&capacities(), class as usize))
    }

    #[test]
    fn test_subring_layout_frozen() {
        let arena = arena_bytes();
        for (class, capacity) in capacities().iter().enumerate() {
            let at = event_subring_offset(&capacities(), class as u32).expect("class exists");
            assert_eq!(
                at,
                arena::ring_offset(&capacities(), class),
                "class {class} sits where the frozen geometry says"
            );
            let (header, slots) = event_subring_slice(&arena, &capacities(), class as u32)
                .expect("the sub-ring is inside the arena");
            assert_eq!(header.capacity, *capacity, "class {class}");
            assert_eq!(header.head, 0);
            assert_eq!(header.tail, 0);
            assert_eq!(header.stride, EVENT_RECORD_SIZE as u32);
            assert_eq!(header.generation, 0);
            assert_eq!(slots.len(), *capacity as usize * EVENT_RECORD_SIZE);
        }
    }

    #[test]
    fn test_append_event_advances_head() {
        let mut arena = arena_bytes();
        let caps = capacities();
        // Class 7 (INPUT_MOUSE) has the joint-smallest non-unit capacity: 64.
        for seq in 1..=3u64 {
            append_event_to_subring(&mut arena, &caps, 7, &record(seq, 7)).expect("room");
        }
        assert_eq!(header(&arena, 7).head, 3);
        assert_eq!(header(&arena, 7).tail, 0, "append never touches the tail");

        let (_, slots) = event_subring_slice(&arena, &caps, 7).expect("in range");
        for seq in 1..=3u64 {
            let at = (seq as usize - 1) * EVENT_RECORD_SIZE;
            let read = arena::read_event_record(slots, at);
            assert_eq!(read, record(seq, 7), "slot {} holds record {seq}", seq - 1);
        }
        // The record's own class field is what the sub-ring is: no queue can
        // make a record claim another class.
        assert_eq!(arena::read_event_record(slots, 0).f0, 1.5);
        assert_eq!(arena::read_event_record(slots, 0).f1, -2.25);
    }

    #[test]
    fn test_append_wraps_and_preserves_contiguity() {
        let mut arena = arena_bytes();
        let caps = tiny();
        // Header first, at the tiny capacity: class 0's ring holds two records.
        write_event_subring_header(&mut arena, &caps, 0, caps[0]).expect("header");
        append_event_to_subring(&mut arena, &caps, 0, &record(1, 0)).expect("slot 0");
        append_event_to_subring(&mut arena, &caps, 0, &record(2, 0)).expect("slot 1");
        assert_eq!(header(&arena, 0).head, 2, "the ring is full");

        // The guest consumes one: `tail` is its reclaim counter.
        arena::set_ring_tail(&mut arena, arena::ring_offset(&caps, 0), 1).expect("tail");

        // The next append would be refused — so the flush path compacts first,
        // which is the "compacting on wrap" of §3.3: the older record is moved
        // to the front, then the newer one is appended behind it.
        let reclaimed = compact_subring(&mut arena, &caps, 0).expect("compaction");
        assert_eq!(reclaimed, 1);
        let header_after = header(&arena, 0);
        assert_eq!(header_after.head, 1, "one live record");
        assert_eq!(header_after.tail, 0, "the guest's reclaim is consumed");
        assert_eq!(header_after.generation, 1, "the rebase is visible");

        let (_, slots) = event_subring_slice(&arena, &caps, 0).expect("in range");
        assert_eq!(
            arena::read_event_record(slots, 0),
            record(2, 0),
            "the surviving record was memmoved to the front"
        );

        append_event_to_subring(&mut arena, &caps, 0, &record(3, 0)).expect("room again");
        let (_, slots) = event_subring_slice(&arena, &caps, 0).expect("in range");
        assert_eq!(arena::read_event_record(slots, 0), record(2, 0));
        assert_eq!(
            arena::read_event_record(slots, EVENT_RECORD_SIZE),
            record(3, 0),
            "the newer record landed behind the survivor: still contiguous from slot 0"
        );
    }

    #[test]
    fn test_append_overflow_returns_full() {
        let mut arena = arena_bytes();
        let caps = tiny();
        write_event_subring_header(&mut arena, &caps, 0, caps[0]).expect("header");
        for seq in 1..=caps[0] as u64 {
            append_event_to_subring(&mut arena, &caps, 0, &record(seq, 0)).expect("room");
        }
        let refused = append_event_to_subring(&mut arena, &caps, 0, &record(99, 0))
            .expect_err("the ring is full and nothing was reclaimed");
        assert_eq!(refused, SubringError::Full { class: 0, capacity: 2 });
        assert_eq!(refused.errno(), -22);
        // Nothing was overwritten, and the head did not move.
        assert_eq!(header(&arena, 0).head, 2);
        let (_, slots) = event_subring_slice(&arena, &caps, 0).expect("in range");
        assert_eq!(arena::read_event_record(slots, 0), record(1, 0));
        assert_eq!(arena::read_event_record(slots, EVENT_RECORD_SIZE), record(2, 0));
    }

    #[test]
    fn test_flush_class_to_ring_delivers_and_drops() {
        // Class 0 holds one record by default, so the second flush is where the
        // ring — not the queue — is the constraint.
        let mut arena = arena_bytes();
        let caps = capacities();
        let posting = PostingSide::default();
        let queue = posting.queue(0).expect("class 0");

        posting.post(1, 0, 0x10, 7, 8, 0.5, 0.25).expect("queued");
        let first = flush_class_to_ring(&mut arena, &caps, 0, queue).expect("flushes");
        assert_eq!(
            first,
            FlushResult { delivered: 1, dropped: 0, first_slot: 0 }
        );
        assert_eq!(queue.delivered(), 1);
        assert_eq!(queue.dropped(), 0);
        assert_eq!(header(&arena, 0).head, 1);

        // The ring is full with the guest's tail still at zero: the record is
        // dropped, and the drop is visible on both sides.
        posting.post(1, 0, 0x10, 9, 10, 0.0, 0.0).expect("queued");
        let second = flush_class_to_ring(&mut arena, &caps, 0, queue).expect("flushes");
        assert_eq!(
            second,
            FlushResult { delivered: 0, dropped: 1, first_slot: 1 }
        );
        assert_eq!(queue.delivered(), 1);
        assert_eq!(queue.dropped(), 1);
        assert_eq!(header(&arena, 0).head, 1, "nothing was overwritten");

        // The guest reclaims, and the next flush compacts and delivers.
        arena::set_ring_tail(&mut arena, arena::ring_offset(&caps, 0), 1).expect("tail");
        posting.post(1, 0, 0x10, 11, 12, 0.0, 0.0).expect("queued");
        let third = flush_class_to_ring(&mut arena, &caps, 0, queue).expect("flushes");
        assert_eq!(
            third,
            FlushResult { delivered: 1, dropped: 0, first_slot: 0 }
        );
        let (_, slots) = event_subring_slice(&arena, &caps, 0).expect("in range");
        let record = arena::read_event_record(slots, 0);
        assert_eq!((record.seq, record.a, record.b), (3, 11, 12));
        assert_eq!((record.flags, record.class), (0x10, 0));
    }

    #[test]
    fn test_flush_refuses_an_unknown_class_and_an_empty_queue_is_free() {
        let mut arena = arena_bytes();
        let caps = capacities();
        let posting = PostingSide::default();

        // An empty queue flushes to nothing, without touching the ring.
        let empty = flush_class_to_ring(&mut arena, &caps, 4, posting.queue(4).expect("class 4"))
            .expect("an empty flush is not an error");
        assert_eq!(empty, FlushResult::default());

        // A queue can only be flushed into its own class: the queue knows which
        // class it is, and this is what stops a batch of LOG events from landing
        // in JOB_DONE's ring.
        let error = flush_class_to_ring(&mut arena, &caps, 5, posting.queue(4).expect("class 4"))
            .expect_err("wrong class");
        assert_eq!(error, SubringError::UnknownClass { class: 4 });
    }


    #[test]
    fn test_a_refused_flush_does_not_empty_the_queue() {
        // The epoch will call this per class; a refusal (an arena that is not
        // the one the session wrote, a class that does not exist) must leave the
        // events where they were rather than eating them.
        let mut arena = arena_bytes();
        let caps = capacities();
        let posting = PostingSide::default();
        posting.post(1, 4, 0, 1, 2, 0.0, 0.0).expect("queued");
        posting.post(1, 4, 0, 3, 4, 0.0, 0.0).expect("queued");
        let queue = posting.queue(4).expect("class 4");
        assert_eq!(queue.len(), 2);

        let error = flush_class_to_ring(&mut arena, &caps, 5, queue).expect_err("wrong class");
        assert_eq!(error, SubringError::UnknownClass { class: 4 });
        assert_eq!(queue.len(), 2, "the events are still queued");
        assert_eq!(queue.delivered(), 0);

        // The right class drains it.
        let flushed = flush_class_to_ring(&mut arena, &caps, 4, queue).expect("flushes");
        assert_eq!(
            flushed,
            FlushResult { delivered: 2, dropped: 0, first_slot: 0 }
        );
        assert_eq!(queue.len(), 0);
    }

    #[test]
    fn test_flushed_records_are_ordered_by_seq() {
        // The delivery contract the epoch depends on: a batch is a contiguous
        // run whose `seq` ascends. Producers post concurrently, so the *order*
        // in the ring can only come from the queue and the flush — which is
        // exactly what this pins.
        let mut arena = arena_bytes();
        let caps = capacities();
        let posting = std::sync::Arc::new(PostingSide::default());
        let mut threads = Vec::new();
        for producer in 0..4u32 {
            let posting = std::sync::Arc::clone(&posting);
            threads.push(std::thread::spawn(move || {
                for i in 0..1000u32 {
                    posting
                        .post(1, 4, 0, producer, i, 0.0, 0.0)
                        .expect("class 4 holds 4096");
                }
            }));
        }
        for thread in threads {
            thread.join().expect("no thread panics");
        }

        let queue = posting.queue(4).expect("class 4");
        let flushed = flush_class_to_ring(&mut arena, &caps, 4, queue).expect("flushes");
        assert_eq!(
            flushed,
            FlushResult { delivered: 4000, dropped: 0, first_slot: 0 }
        );

        let (header, slots) = event_subring_slice(&arena, &caps, 4).expect("in range");
        assert_eq!(header.head, 4000);
        let seqs: Vec<u64> = (0..4000)
            .map(|slot| arena::read_event_record(slots, slot * EVENT_RECORD_SIZE).seq)
            .collect();
        assert!(
            seqs.windows(2).all(|pair| pair[0] < pair[1]),
            "the ring holds ascending sequence numbers"
        );
        assert_eq!(seqs, (1..=4000).collect::<Vec<u64>>());
    }

    #[test]
    fn test_header_mismatch_is_refused() {
        // An arena whose header says something other than the session's own
        // capacities: the session refuses rather than computing an offset from a
        // number it did not write.
        let mut arena = arena_bytes();
        let caps = capacities();
        let at = arena::ring_offset(&caps, 6);
        arena::set_ring_capacity(&mut arena, at, caps[6] + 1).expect("write");

        let error = append_event_to_subring(&mut arena, &caps, 6, &record(1, 6))
            .expect_err("mismatch");
        assert_eq!(
            error,
            SubringError::HeaderMismatch {
                class: 6,
                header: caps[6] + 1,
                expected: caps[6],
            }
        );
        // And it did not half-write the record.
        let (_, slots) = event_subring_slice(&arena, &caps, 6).expect("in range");
        assert_eq!(arena::read_event_record(slots, 0).seq, 0);
    }
}
