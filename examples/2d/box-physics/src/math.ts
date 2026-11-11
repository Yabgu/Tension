// examples/2d/box-physics/src/math.ts
//
// 2D scalar math primitives for rigid-body box physics.
//
// Inlined scalar components (x, y) rather than heap-allocated vector objects
// avoid GC pressure during the tight sub-step integration and SAT loops.

export const PI: f32 = 3.14159265358979323846;
export const TWO_PI: f32 = 6.28318530717958647692;

export function clamp(v: f32, minVal: f32, maxVal: f32): f32 {
  if (v < minVal) return minVal;
  if (v > maxVal) return maxVal;
  return v;
}

export function absf(v: f32): f32 {
  return Mathf.abs(v);
}

export function minf(a: f32, b: f32): f32 {
  return a < b ? a : b;
}

export function maxf(a: f32, b: f32): f32 {
  return a > b ? a : b;
}

export function cross2d(x1: f32, y1: f32, x2: f32, y2: f32): f32 {
  return x1 * y2 - y1 * x2;
}

export function dot2d(x1: f32, y1: f32, x2: f32, y2: f32): f32 {
  return x1 * x2 + y1 * y2;
}

/** Wrap an angle in radians into [0, 2π). */
export function normalizeAngle(angle: f32): f32 {
  let a = angle % TWO_PI;
  if (a < 0.0) a += TWO_PI;
  return a;
}
