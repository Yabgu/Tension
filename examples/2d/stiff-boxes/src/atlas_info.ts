// src/atlas_info.ts — Mapping logic for the compile-time generated texture atlas.
//
// The 1024x1024 atlas has:
//   - Rows 0..11: 6 box styles x 32 rotation angles (each style occupies 2 rows of 16 tiles)
//   - Row 12: Static tiles (Ground, Ramp, Wall, Background)

export const ATLAS_WIDTH: u16 = 1024;
export const ATLAS_HEIGHT: u16 = 1024;
export const TILE_SIZE: u16 = 64;
export const ROTATIONS: i32 = 32;

export class AtlasFrame {
  srcX: u16;
  srcY: u16;
  w: u16;
  h: u16;

  constructor(x: u16, y: u16, w: u16, h: u16) {
    this.srcX = x;
    this.srcY = y;
    this.w = w;
    this.h = h;
  }
}

// Pre-computed frame instances for static tiles
export const FRAME_GROUND = new AtlasFrame(0, 768, 64, 64);
export const FRAME_RAMP   = new AtlasFrame(64, 768, 64, 64);
export const FRAME_WALL   = new AtlasFrame(128, 768, 64, 64);
export const FRAME_BG     = new AtlasFrame(192, 768, 64, 64);

/**
 * Returns (srcX, srcY, 64, 64) for a given box style (0..5) and angle in radians.
 */
export function getBoxFrame(style: i32, angleRad: f64): AtlasFrame {
  const TWO_PI: f64 = 6.283185307179586;
  let a: f64 = angleRad % TWO_PI;
  if (a < 0.0) a += TWO_PI;

  const r: i32 = <i32>(Math.round((a / TWO_PI) * 32.0)) % 32;
  const col: i32 = r % 16;
  const row: i32 = (style * 2) + (r / 16);

  const sx: u16 = <u16>(col * 64);
  const sy: u16 = <u16>(row * 64);

  return new AtlasFrame(sx, sy, 64, 64);
}
