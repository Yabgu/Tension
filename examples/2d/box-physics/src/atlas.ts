// examples/2d/box-physics/src/atlas.ts
//
// Procedural Texture Atlas for 2D Rotated Box Sprites.
//
// Generates a 1024x1024 RGBA8 IWI1 texture container directly in guest memory.
// The atlas holds 32 pre-rasterized rotation angles (11.25° increments) for each
// of the 6 dynamic box shapes and the static ramps, plus an industrial metal tile
// for floors and walls.
//
// Alpha channel is 255 for the box interior/borders and 0 outside, allowing
// seamless source-over blending through tension-2d's GPU pipeline.

import { Bytes, Frame, Rgba } from "tension-framework";
import { absf, minf, normalizeAngle, PI, TWO_PI } from "./math";

export const ATLAS_SIZE: u32 = 1024;
export const CELL_SIZE: u32 = 64;
export const CELLS_PER_ROW: u32 = ATLAS_SIZE / CELL_SIZE; // 16
export const ANGLES_PER_SHAPE: i32 = 32;

export const SHAPE_RED_SQUARE: i32 = 0;    // 30x30
export const SHAPE_BLUE_RECT: i32 = 1;     // 42x20
export const SHAPE_GREEN_RECT: i32 = 2;    // 20x42
export const SHAPE_AMBER_SQUARE: i32 = 3;  // 26x26
export const SHAPE_PURPLE_SLAB: i32 = 4;   // 38x24
export const SHAPE_CYAN_CUBE: i32 = 5;     // 22x22
export const SHAPE_RAMP: i32 = 6;          // 56x16
export const SHAPE_STATIC_TILE: i32 = 7;   // 64x64 at cell 224

struct ShapeProps {
  hw: f32;
  hh: f32;
  r: u8;
  g: u8;
  b: u8;
}

function getShapeProps(shapeType: i32): ShapeProps {
  const p = new ShapeProps();
  if (shapeType == SHAPE_RED_SQUARE) {
    p.hw = 15.0; p.hh = 15.0; p.r = 230; p.g = 45; p.b = 55;
  } else if (shapeType == SHAPE_BLUE_RECT) {
    p.hw = 21.0; p.hh = 10.0; p.r = 40; p.g = 115; p.b = 235;
  } else if (shapeType == SHAPE_GREEN_RECT) {
    p.hw = 10.0; p.hh = 21.0; p.r = 35; p.g = 190; p.b = 85;
  } else if (shapeType == SHAPE_AMBER_SQUARE) {
    p.hw = 13.0; p.hh = 13.0; p.r = 245; p.g = 175; p.b = 25;
  } else if (shapeType == SHAPE_PURPLE_SLAB) {
    p.hw = 19.0; p.hh = 12.0; p.r = 165; p.g = 55; p.b = 220;
  } else if (shapeType == SHAPE_CYAN_CUBE) {
    p.hw = 11.0; p.hh = 11.0; p.r = 25; p.g = 205; p.b = 230;
  } else {
    // SHAPE_RAMP
    p.hw = 28.0; p.hh = 8.0; p.r = 75; p.g = 80; p.b = 95;
  }
  return p;
}

export function buildBoxAtlas(): Bytes {
  const pixels = ATLAS_SIZE * ATLAS_SIZE * 4;
  const total: i32 = 74 + <i32>pixels;
  const image = Bytes.allocate(total);
  image.fill(0);

  // The 74-byte packed IWI1 container header (TS6408)
  image.setByteAt(0, 0x49); // I
  image.setByteAt(1, 0x57); // W
  image.setByteAt(2, 0x49); // I
  image.setByteAt(3, 0x31); // 1
  image.setU32(4, ATLAS_SIZE); // width
  image.setU32(8, ATLAS_SIZE); // height
  image.setByteAt(12, 0); // colorSpace: sRGB
  image.setU16(13, 4); // componentCount: RGBA (4 channels)
  image.setU16(15, 32); // bitsPerPixel: 32
  image.setByteAt(17, 0); // storageLayout: interleaved

  // Four 6-byte component descriptors (R, G, B, A)
  for (let i = 0; i < 4; i++) {
    const at = 18 + i * 6;
    image.setByteAt(at + 0, <u8>(i + 1)); // semantic
    image.setByteAt(at + 1, 2); // class UNORM
    image.setU16(at + 2, <u16>(i * 8)); // bitOffset
    image.setU16(at + 4, 8); // bitWidth
  }
  image.setU64(66, <u64>pixels);

  // A pixel view for the rasteriser below, from the buffer's **address**.
  //
  // One million pixels through `setByteAt` would be four million bounds-checked
  // stores; the header above is thirty bytes and the body is not. What makes this
  // safe now is where the number comes from: `image.address()` is the framework's
  // `dataStart`, so this is a view over a known buffer's data — not
  // `changetype<usize>(typedArray)`, which is the object and was the Gate Zero
  // fault (`tension-framework/assembly/bytes.ts` has the backtrace).
  let px = changetype<@unmanaged [Rgba *]>(image.address() + 74);

  // 1. Rasterize rotation angles for shapes 0..6
  for (let shape = 0; shape <= SHAPE_RAMP; shape++) {
    const props = getShapeProps(shape);
    const isRamp = shape == SHAPE_RAMP;

    for (let a = 0; a < ANGLES_PER_SHAPE; a++) {
      const angle = <f32>a * (TWO_PI / <f32>ANGLES_PER_SHAPE);
      const cosA = Mathf.cos(angle);
      const sinA = Mathf.sin(angle);

      const cellIndex = shape * ANGLES_PER_SHAPE + a;
      const cellX = (cellIndex % <i32>CELLS_PER_ROW) * <i32>CELL_SIZE;
      const cellY = (cellIndex / <i32>CELLS_PER_ROW) * <i32>CELL_SIZE;

      for (let cy: u32 = 0; cy < CELL_SIZE; cy++) {
        for (let cx: u32 = 0; cx < CELL_SIZE; cx++) {
          const dx = <f32>cx - 31.5;
          const dy = <f32>cy - 31.5;

          // Inverse rotation into box local coordinates
          const lx = dx * cosA + dy * sinA;
          const ly = -dx * sinA + dy * cosA;

          if (absf(lx) <= props.hw && absf(ly) <= props.hh) {
            const outX = cellX + <i32>cx;
            const outY = cellY + <i32>cy;
            const pIdx = outY * <i32>ATLAS_SIZE + outX;

            // Border
            if (absf(lx) >= props.hw - 1.8 || absf(ly) >= props.hh - 1.8) {
              px[pIdx].r = 20;
              px[pIdx].g = 20;
              px[pIdx].b = 25;
              px[pIdx].a = 255;
            } else if (isRamp) {
              // Diagonal hazard stripes on ramps
              const stripe = (<i32>(lx + ly + 100.0) >> 3) & 1;
              if (stripe != 0) {
                px[pIdx].r = 235;
                px[pIdx].g = 195;
                px[pIdx].b = 30;
                px[pIdx].a = 255;
              } else {
                px[pIdx].r = 45;
                px[pIdx].g = 48;
                px[pIdx].b = 55;
                px[pIdx].a = 255;
              }
            } else if (ly < -props.hh + 5.0 && absf(lx) <= 3.5) {
              // Top-orientation notch indicator
              px[pIdx].r = 255;
              px[pIdx].g = 255;
              px[pIdx].b = 255;
              px[pIdx].a = 255;
            } else if (absf(lx) <= 1.2 || absf(ly) <= 1.2) {
              // Center alignment cross
              px[pIdx].r = <u8>minf(255.0, <f32>props.r * 1.3);
              px[pIdx].g = <u8>minf(255.0, <f32>props.g * 1.3);
              px[pIdx].b = <u8>minf(255.0, <f32>props.b * 1.3);
              px[pIdx].a = 255;
            } else {
              // Main body fill
              px[pIdx].r = props.r;
              px[pIdx].g = props.g;
              px[pIdx].b = props.b;
              px[pIdx].a = 255;
            }
          }
        }
      }
    }
  }

  // 2. Rasterize static industrial metal tile at cell 224
  const tileCell = 224;
  const tileX = (tileCell % <i32>CELLS_PER_ROW) * <i32>CELL_SIZE;
  const tileY = (tileCell / <i32>CELLS_PER_ROW) * <i32>CELL_SIZE;

  for (let cy: u32 = 0; cy < CELL_SIZE; cy++) {
    for (let cx: u32 = 0; cx < CELL_SIZE; cx++) {
      const outX = tileX + <i32>cx;
      const outY = tileY + <i32>cy;
      const pIdx = outY * <i32>ATLAS_SIZE + outX;

      // Dark bevel border around tile
      if (cx < 2 || cy < 2 || cx >= CELL_SIZE - 2 || cy >= CELL_SIZE - 2) {
        px[pIdx].r = 25;
        px[pIdx].g = 28;
        px[pIdx].b = 35;
        px[pIdx].a = 255;
      } else if (cx == 32 || cy == 32) {
        // Grid crosshair
        px[pIdx].r = 35;
        px[pIdx].g = 38;
        px[pIdx].b = 48;
        px[pIdx].a = 255;
      } else if (
        (cx == 8 && (cy == 8 || cy == 56)) ||
        (cx == 56 && (cy == 8 || cy == 56))
      ) {
        // Corner rivet dots
        px[pIdx].r = 180;
        px[pIdx].g = 185;
        px[pIdx].b = 195;
        px[pIdx].a = 255;
      } else {
        // Steel plate fill
        px[pIdx].r = 52;
        px[pIdx].g = 56;
        px[pIdx].b = 66;
        px[pIdx].a = 255;
      }
    }
  }

  return image;
}

export function getBoxFrame(shapeType: i32, angle: f32): Frame {
  const a = normalizeAngle(angle);
  const step = TWO_PI / <f32>ANGLES_PER_SHAPE;
  const angleIndex = <i32>Mathf.floor((a + step * 0.5) / step) % ANGLES_PER_SHAPE;
  const cellIndex = shapeType * ANGLES_PER_SHAPE + angleIndex;
  const cellX = <u16>((cellIndex % <i32>CELLS_PER_ROW) * <i32>CELL_SIZE);
  const cellY = <u16>((cellIndex / <i32>CELLS_PER_ROW) * <i32>CELL_SIZE);
  return new Frame(0, cellX, cellY, <u16>CELL_SIZE, <u16>CELL_SIZE);
}

export function getStaticTileFrame(): Frame {
  const cellIndex = 224;
  const cellX = <u16>((cellIndex % <i32>CELLS_PER_ROW) * <i32>CELL_SIZE);
  const cellY = <u16>((cellIndex / <i32>CELLS_PER_ROW) * <i32>CELL_SIZE);
  return new Frame(0, cellX, cellY, <u16>CELL_SIZE, <u16>CELL_SIZE);
}
