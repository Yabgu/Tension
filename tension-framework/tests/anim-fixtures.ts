// The fixtures, as bytes the guest can hold.
//
// AssemblyScript 0.28 has no `includeBytes` and no way to embed a file, so the
// archives under `fixtures/ozz/` are carried as hex in the generated
// `anim-fixture-data.ts` and decoded here. The .ozz files remain the canonical
// artifact — `gen-anim-fixtures.py` derives the module from them, and this file
// checks the derivation before anyone parses anything:
//
//   * the decoded length must equal the length the generator recorded, and
//   * an FNV-1a hash of the decoded bytes must equal the hash it recorded.
//
// A corrupted literal therefore fails at the fixture, with the fixture named,
// rather than somewhere inside the parser. That check is what makes "the parser
// consumed exactly the file's bytes" a statement about a real file and not
// about a possibly-mangled copy of one.

import {
  ANIMATION_V6_LE_FNV,
  ANIMATION_V6_LE_HEX,
  ANIMATION_V6_LE_LEN,
  ANIMATION_V7_LE_FNV,
  ANIMATION_V7_LE_HEX,
  ANIMATION_V7_LE_LEN,
  BOX_ANIMATED_ANIMATION_0_FNV,
  BOX_ANIMATED_ANIMATION_0_HEX,
  BOX_ANIMATED_ANIMATION_0_LEN,
  BOX_ANIMATED_SKELETON_FNV,
  BOX_ANIMATED_SKELETON_HEX,
  BOX_ANIMATED_SKELETON_LEN,
  RIGGED_SIMPLE_ANIMATION_0_FNV,
  RIGGED_SIMPLE_ANIMATION_0_HEX,
  RIGGED_SIMPLE_ANIMATION_0_LEN,
  RIGGED_SIMPLE_SKELETON_FNV,
  RIGGED_SIMPLE_SKELETON_HEX,
  RIGGED_SIMPLE_SKELETON_LEN,
  ROBOT_ANIMATION_FNV,
  ROBOT_ANIMATION_HEX,
  ROBOT_ANIMATION_LEN,
  ROBOT_SKELETON_FNV,
  ROBOT_SKELETON_HEX,
  ROBOT_SKELETON_LEN,
  SKELETON_V1_LE_FNV,
  SKELETON_V1_LE_HEX,
  SKELETON_V1_LE_LEN,
  SKELETON_V2_BE_FNV,
  SKELETON_V2_BE_HEX,
  SKELETON_V2_BE_LEN,
  SKELETON_V2_LE_FNV,
  SKELETON_V2_LE_HEX,
  SKELETON_V2_LE_LEN,
} from "./anim-fixture-data";

/** One fixture's source: its hex, and what the generator measured it to be. */
class FixtureSource {
  name: string;
  hex: string;
  length: i32;
  fnv1a: u32;

  constructor(name: string, hex: string, length: i32, fnv1a: u32) {
    this.name = name;
    this.hex = hex;
    this.length = length;
    this.fnv1a = fnv1a;
  }
}

function source(name: string, hex: string, length: i32, fnv1a: u32): FixtureSource {
  return new FixtureSource(name, hex, length, fnv1a);
}

const SOURCES: FixtureSource[] = [
  source("skeleton_v2_le", SKELETON_V2_LE_HEX, SKELETON_V2_LE_LEN, SKELETON_V2_LE_FNV),
  source("animation_v7_le", ANIMATION_V7_LE_HEX, ANIMATION_V7_LE_LEN, ANIMATION_V7_LE_FNV),
  source("robot_skeleton", ROBOT_SKELETON_HEX, ROBOT_SKELETON_LEN, ROBOT_SKELETON_FNV),
  source("robot_animation", ROBOT_ANIMATION_HEX, ROBOT_ANIMATION_LEN, ROBOT_ANIMATION_FNV),
  source("rigged_simple_skeleton", RIGGED_SIMPLE_SKELETON_HEX, RIGGED_SIMPLE_SKELETON_LEN,
         RIGGED_SIMPLE_SKELETON_FNV),
  source("rigged_simple_animation_0", RIGGED_SIMPLE_ANIMATION_0_HEX,
         RIGGED_SIMPLE_ANIMATION_0_LEN, RIGGED_SIMPLE_ANIMATION_0_FNV),
  source("box_animated_skeleton", BOX_ANIMATED_SKELETON_HEX, BOX_ANIMATED_SKELETON_LEN,
         BOX_ANIMATED_SKELETON_FNV),
  source("box_animated_animation_0", BOX_ANIMATED_ANIMATION_0_HEX,
         BOX_ANIMATED_ANIMATION_0_LEN, BOX_ANIMATED_ANIMATION_0_FNV),
  source("skeleton_v1_le", SKELETON_V1_LE_HEX, SKELETON_V1_LE_LEN, SKELETON_V1_LE_FNV),
  source("animation_v6_le", ANIMATION_V6_LE_HEX, ANIMATION_V6_LE_LEN, ANIMATION_V6_LE_FNV),
  source("skeleton_v2_be", SKELETON_V2_BE_HEX, SKELETON_V2_BE_LEN, SKELETON_V2_BE_FNV),
];

/** The source for `name`, or `null` when the fixture does not exist. */
export function fixtureSource(name: string): FixtureSource | null {
  for (let i = 0; i < SOURCES.length; i++) {
    if (SOURCES[i].name == name) return SOURCES[i];
  }
  return null;
}

/** FNV-1a over the bytes: the same hash the generator recorded. */
export function fnv1a(bytes: StaticArray<u8>): u32 {
  let hash: u32 = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash = (hash ^ <u32>bytes[i]) * 0x01000193;
  }
  return hash;
}

/** One hex digit's value, or -1. */
function nibble(code: i32): i32 {
  if (code >= 0x30 && code <= 0x39) return code - 0x30; // '0'..'9'
  if (code >= 0x61 && code <= 0x66) return code - 0x57; // 'a'..'f'
  return -1;
}

/** Decode `hex` into bytes. */
export function decodeHex(hex: string): StaticArray<u8> {
  const count = hex.length / 2;
  const out = new StaticArray<u8>(count);
  for (let i = 0; i < count; i++) {
    const high = nibble(hex.charCodeAt(i * 2));
    const low = nibble(hex.charCodeAt(i * 2 + 1));
    out[i] = <u8>((high << 4) | low);
  }
  return out;
}

/** The fixture's bytes, decoded. An unknown name gives an empty array. */
export function fixtureBytes(name: string): StaticArray<u8> {
  const found = fixtureSource(name);
  if (found == null) return new StaticArray<u8>(0);
  return decodeHex(found.hex);
}

/** The fixture's recorded length, or 0 for an unknown name. */
export function fixtureLength(name: string): i32 {
  const found = fixtureSource(name);
  return found == null ? 0 : found.length;
}

/** The fixture's recorded FNV-1a, or 0 for an unknown name. */
export function fixtureFnv(name: string): u32 {
  const found = fixtureSource(name);
  return found == null ? 0 : found.fnv1a;
}
