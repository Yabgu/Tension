import { Callbacks, CALLBACKS_SIZE } from "./wire";
import {
  ABI_VERSION,
  ARENA_SIZE,
  CLASS_COUNT,
  LAYOUT_HASH,
  MAX_ARENA_SIZE,
  RING_CAPACITIES,
} from "./layout";
import { TlvArgmap } from "./tlv";

/** `abi_version` — must be the first entry; the decoder refuses otherwise. */
export const KEY_ABI_VERSION: u32 = 1;
/** The guest's compiled-in layout hash; the session compares it to its own. */
export const KEY_LAYOUT_HASH: u32 = 2;
/** The live arena, in bytes. */
export const KEY_ARENA_SIZE: u32 = 3;
/** The reserved ceiling — and the guest's `--memoryBase`. */
export const KEY_MAX_ARENA_SIZE: u32 = 4;
/** Where the `Callbacks` record lives (the guest's own heap). */
export const KEY_CALLBACKS_PTR: u32 = 5;
/** Its length: the manifest's `Callbacks` size, or 0 for "no record at all". */
export const KEY_CALLBACKS_LEN: u32 = 6;
/** `ring_capacity_<class>`: the base a class id is added to. */
export const KEY_RING_CAPACITY_BASE: u32 = 0x0100;

/**
 * Builds the `session_open` config over the shared argmap encoder
 * (`./tlv`): the shape is the session protocol's, and only the keys are this
 * capability's.
 *
 *   const cfg = ConfigBuilder.forThisBuild(callbacks);
 *   RuntimeSession.open(cfg);
 */
export class ConfigBuilder {
  private argmap: TlvArgmap;

  constructor() {
    this.argmap = new TlvArgmap(KEY_ABI_VERSION, ABI_VERSION);
  }

  /** `layout_hash`: the shape this guest was compiled against. */
  layoutHash(hash: u32): ConfigBuilder {
    this.argmap.put(KEY_LAYOUT_HASH, hash);
    return this;
  }

  /** `arena_size`: the live arena the guest asks for. */
  arenaSize(bytes: u32): ConfigBuilder {
    this.argmap.put(KEY_ARENA_SIZE, bytes);
    return this;
  }

  /** `max_arena_size`: the ceiling, which is also `--memoryBase`. */
  maxArenaSize(bytes: u32): ConfigBuilder {
    this.argmap.put(KEY_MAX_ARENA_SIZE, bytes);
    return this;
  }

  /** `callbacks_ptr` / `callbacks_len`: a record, or 0/0 for none. */
  callbacks(ptr: usize, len: u32): ConfigBuilder {
    this.argmap.put(KEY_CALLBACKS_PTR, <u32>ptr);
    this.argmap.put(KEY_CALLBACKS_LEN, len);
    return this;
  }

  /** `ring_capacity_<class>`: override one class's ring capacity. */
  ringCapacity(class_: u32, capacity: u32): ConfigBuilder {
    this.argmap.put(KEY_RING_CAPACITY_BASE + class_, capacity);
    return this;
  }

  /**
   * The config this build's `session.json` implies: the generated constants,
   * the callbacks record if there is one, and every class's ring capacity
   * stated explicitly (the values the host would default to anyway — stating
   * them is what makes the guest's geometry and the host's provably the same).
   */
  static forThisBuild(callbacks: Callbacks | null = null, arenaSize: u32 = ARENA_SIZE): ConfigBuilder {
    const builder = new ConfigBuilder()
      .layoutHash(LAYOUT_HASH)
      .arenaSize(arenaSize)
      .maxArenaSize(MAX_ARENA_SIZE);
    if (callbacks != null) {
      builder.callbacks(changetype<usize>(callbacks), CALLBACKS_SIZE);
    } else {
      builder.callbacks(0, 0);
    }
    for (let class_: u32 = 0; class_ < CLASS_COUNT; class_++) {
      builder.ringCapacity(class_, RING_CAPACITIES[class_]);
    }
    return builder;
  }

  /** Encode the stream for `session_open`. */
  toBytes(): ArrayBuffer {
    return this.argmap.toBytes();
  }
}
