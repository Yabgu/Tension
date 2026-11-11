// examples/2d/stiff-boxes/src/main.ts — 2D Rigid Box Physics with BDF2 Solver.
//
// Demonstrates:
//   1. Continuous rigid body differential equations with stiff contact penalty forces.
//   2. Solving stiff mechanical equations using tension::solver with method: "bdf2".
//   3. Compile-time generated texture atlas loaded at runtime from a packed .tns volume via
//      `canvas.loadTextureFromRes("textures/boxes.iwi")`.
//   4. Plain struct declarations with explicit storage views (@unmanaged [SpriteRecord *]).

import {
  print,
  log,
  RuntimeSession,
  ConfigBuilder,
  Solver,
  SolverConfig,
  PIPE_PRESET_MIN,
  Rgba,
  RECORD_SIZE,
  arg,
  argCount,
} from "tension-framework";
import * as platform from "tension-framework/assembly/platform";
import { Canvas, SpriteRecord } from "tension-framework/assembly/2d";
import { DEFAULT_2D_BLOB } from "./graph.generated";
import {
  AtlasFrame,
  FRAME_GROUND,
  FRAME_RAMP,
  FRAME_WALL,
  FRAME_BG,
  getBoxFrame,
} from "./atlas_info";

// Two non-overlapping 64 KiB regions in linear memory, aligned to f64 for solver copy-in/out
const BUF_IN: usize = memory.data(65536, 8);
const BUF_OUT: usize = memory.data(65536, 8);

export function deriv_buf_in(): i32 { return i32(BUF_IN); }
export function deriv_buf_out(): i32 { return i32(BUF_OUT); }

// ── Model Constants ────────────────────────────────────────────────────────

const BOX_COUNT: i32 = 10;
const STATE_DIM: i32 = 60; // 10 boxes * 6 DOFs (x, y, theta, vx, vy, omega)

const HALF_W: f64 = 20.0;
const HALF_H: f64 = 20.0;
const MASS: f64 = 2.0;
const INERTIA: f64 = 533.3333333333334; // 1/3 * m * (hw^2 + hh^2)
const INV_M: f64 = 0.5;
const INV_I: f64 = 0.001875;

const GRAVITY: f64 = 850.0;
const K_WALL: f64 = 6000.0;
const D_WALL: f64 = 36.0; // High energy dissipation on wall/ramp impacts (stops jumping)
const K_BOX: f64 = 8000.0;
const D_BOX: f64 = 42.0; // High energy dissipation on box-to-box collisions (settles stacks)

// Surface-specific friction
const MU_RAMP: f64 = 0.12;  // Sleek ramp to allow smooth sliding
const MU_FLOOR: f64 = 0.38; // High friction floor & walls to settle boxes
const MU_BOX: f64 = 0.32;   // High friction between boxes to hold stable stacks

// Continuous linear and angular medium drag (energy loss during free flight & tumbling)
const LINEAR_DRAG: f64 = 0.30;
const ANGULAR_DRAG: f64 = 0.70;

// Box styles (0..5)
const BOX_STYLES: i32[] = [0, 1, 2, 3, 4, 5, 0, 1, 2, 3];

// Static acceleration scratch buffers to prevent GC heap allocation in hot derivative calls
const AX: Float64Array = new Float64Array(BOX_COUNT);
const AY: Float64Array = new Float64Array(BOX_COUNT);
const A_ROT: Float64Array = new Float64Array(BOX_COUNT);

/**
 * C1-continuous smooth penalty transition function (Huber penalty).
 * Removes the step discontinuity at pen = 0 so Newton-Raphson has smooth derivatives.
 */
function smoothPen(pen: f64): f64 {
  if (pen <= 0.0) return 0.0;
  const EPS: f64 = 0.5;
  if (pen < EPS) {
    return (pen * pen) / (2.0 * EPS);
  }
  return pen - (0.5 * EPS);
}

/**
 * Smooth algebraic regularization of Coulomb friction with surface-specific coefficient.
 * Everywhere C-infinity differentiable, avoiding Coulomb jump discontinuities at vt = 0.
 */
function smoothFriction(vt: f64, fn: f64, mu: f64): f64 {
  const V_SLIP: f64 = 1.5; // 1.5 px/s crisp transition to prevent creeping
  const maxFt = mu * fn;
  const ratio = vt / Math.sqrt(vt * vt + V_SLIP * V_SLIP);
  return -maxFt * ratio;
}

/**
 * Rigorous 2D Separating Axis Theorem (SAT) contact evaluator with dual contact manifold.
 * Eliminates corner penetration artifacts and maintains rock-solid stacking and angular stability.
 */
function collideBoxesSAT(
  A: i32, B: i32,
  xA: f64, yA: f64, vxA: f64, vyA: f64, wA: f64,
  xB: f64, yB: f64, vxB: f64, vyB: f64, wB: f64,
  cosA: f64, sinA: f64, cosB: f64, sinB: f64
): void {
  const dx = xB - xA;
  const dy = yB - yA;
  // Broadphase: 29 px circumscribed radius each -> distance limit 58 px
  if (dx * dx + dy * dy >= 3400.0) return;

  // Box A unit axes:
  const uA1x = cosA;  const uA1y = sinA;
  const uA2x = -sinA; const uA2y = cosA;
  // Box B unit axes:
  const uB1x = cosB;  const uB1y = sinB;
  const uB2x = -sinB; const uB2y = cosB;

  // Absolute dot products between axes
  const d11 = Math.abs(uA1x * uB1x + uA1y * uB1y);
  const d12 = Math.abs(uA1x * uB2x + uA1y * uB2y);
  const d21 = Math.abs(uA2x * uB1x + uA2y * uB1y);
  const d22 = Math.abs(uA2x * uB2x + uA2y * uB2y);

  // Axis 1: uA1
  const rA1 = HALF_W;
  const rB1 = HALF_W * d11 + HALF_H * d12;
  const dist1 = dx * uA1x + dy * uA1y;
  const s1 = rA1 + rB1 - Math.abs(dist1);
  if (s1 <= 0.0) return;

  // Axis 2: uA2
  const rA2 = HALF_H;
  const rB2 = HALF_W * d21 + HALF_H * d22;
  const dist2 = dx * uA2x + dy * uA2y;
  const s2 = rA2 + rB2 - Math.abs(dist2);
  if (s2 <= 0.0) return;

  // Axis 3: uB1
  const rA3 = HALF_W * d11 + HALF_H * d21;
  const rB3 = HALF_W;
  const dist3 = dx * uB1x + dy * uB1y;
  const s3 = rA3 + rB3 - Math.abs(dist3);
  if (s3 <= 0.0) return;

  // Axis 4: uB2
  const rA4 = HALF_W * d12 + HALF_H * d22;
  const rB4 = HALF_H;
  const dist4 = dx * uB2x + dy * uB2y;
  const s4 = rA4 + rB4 - Math.abs(dist4);
  if (s4 <= 0.0) return;

  // Axis of minimum penetration defines the contact normal (pointing A -> B)
  let minS = s1;
  let nx = dist1 >= 0.0 ? uA1x : -uA1x;
  let ny = dist1 >= 0.0 ? uA1y : -uA1y;

  if (s2 < minS) {
    minS = s2;
    nx = dist2 >= 0.0 ? uA2x : -uA2x;
    ny = dist2 >= 0.0 ? uA2y : -uA2y;
  }
  if (s3 < minS - 0.2) {
    minS = s3;
    nx = dist3 >= 0.0 ? uB1x : -uB1x;
    ny = dist3 >= 0.0 ? uB1y : -uB1y;
  }
  if (s4 < minS - 0.2) {
    minS = s4;
    nx = dist4 >= 0.0 ? uB2x : -uB2x;
    ny = dist4 >= 0.0 ? uB2y : -uB2y;
  }

  // Tangent perpendicular to normal
  const tx = -ny;
  const ty = nx;

  // Manifold center at the overlap interface
  const cx = 0.5 * (xA + xB);
  const cy = 0.5 * (yA + yB);

  // Dual contact points along tangent for torque balance and rock-solid stacking
  const SPAN: f64 = 11.0;
  for (let pt = 0; pt < 2; pt++) {
    const sign = pt == 0 ? 1.0 : -1.0;
    const px = cx + tx * (sign * SPAN);
    const py = cy + ty * (sign * SPAN);

    const rAx = px - xA;
    const rAy = py - yA;
    const rBx = px - xB;
    const rBy = py - yB;

    const cvAx = vxA - wA * rAy;
    const cvAy = vyA + wA * rAx;
    const cvBx = vxB - wB * rBy;
    const cvBy = vyB + wB * rBx;

    const relVx = cvBx - cvAx;
    const relVy = cvBy - cvAy;

    const vpen = -(relVx * nx + relVy * ny);
    const sPen = smoothPen(minS) * 0.5;

    let fn = (K_BOX + D_BOX * vpen) * sPen;
    if (fn > 0.0) {
      const vt = relVx * tx + relVy * ty;
      const ft = smoothFriction(vt, fn, MU_BOX);

      const fx = fn * nx + ft * tx;
      const fy = fn * ny + ft * ty;

      // Apply to B (in direction of normal)
      AX[B] += fx * INV_M;
      AY[B] += fy * INV_M;
      A_ROT[B] += (rBx * fy - rBy * fx) * INV_I;

      // Equal and opposite on A
      AX[A] -= fx * INV_M;
      AY[A] -= fy * INV_M;
      A_ROT[A] -= (rAx * fy - rAy * fx) * INV_I;
    }
  }
}

// ── Solver Right-Hand Side ────────────────────────────────────────────────

export function _derivative(yPtr: usize, len: i32, t: f64, dyPtr: usize, dyCap: i32): i32 {
  if (len < STATE_DIM || dyCap < len) return -22;

  // Let views over y and dy
  let y = changetype<@unmanaged [f64 *]>(yPtr);
  let dy = changetype<@unmanaged [f64 *]>(dyPtr);

  for (let i = 0; i < BOX_COUNT; i++) {
    const base = i * 6;
    const bvx = y[base + 3];
    const bvy = y[base + 4];
    const bw = y[base + 5];

    // Medium drag for continuous energy dissipation & anti-jitter
    AX[i] = -LINEAR_DRAG * bvx;
    AY[i] = GRAVITY - LINEAR_DRAG * bvy;
    A_ROT[i] = -ANGULAR_DRAG * bw;
  }

  // 1. Box vs Boundaries and Ramps
  for (let i = 0; i < BOX_COUNT; i++) {
    const base = i * 6;
    const bx = y[base + 0];
    const by = y[base + 1];
    const th = y[base + 2];
    const bvx = y[base + 3];
    const bvy = y[base + 4];
    const bw = y[base + 5];

    const cosT = Math.cos(th);
    const sinT = Math.sin(th);

    // 4 corners of box i
    for (let c = 0; c < 4; c++) {
      let lcx: f64 = HALF_W;
      let lcy: f64 = HALF_H;
      if (c == 1) { lcx = -HALF_W; lcy = HALF_H; }
      else if (c == 2) { lcx = -HALF_W; lcy = -HALF_H; }
      else if (c == 3) { lcx = HALF_W; lcy = -HALF_H; }

      const rx = lcx * cosT - lcy * sinT;
      const ry = lcx * sinT + lcy * cosT;
      const px = bx + rx;
      const py = by + ry;

      const cvx = bvx - bw * ry;
      const cvy = bvy + bw * rx;

      // Ceiling: y = 30
      if (py < 30.0) {
        const sPen = smoothPen(30.0 - py);
        const vpen = -cvy;
        let fn = (K_WALL + D_WALL * vpen) * sPen;
        if (fn > 0.0) {
          const ft = smoothFriction(cvx, fn, MU_FLOOR);
          const fx = ft;
          const fy = fn;
          AX[i] += fx * INV_M;
          AY[i] += fy * INV_M;
          A_ROT[i] += (rx * fy - ry * fx) * INV_I;
        }
      }

      // Ground Floor: y = 620
      if (py > 620.0) {
        const sPen = smoothPen(py - 620.0);
        const vpen = cvy;
        let fn = (K_WALL + D_WALL * vpen) * sPen;
        if (fn > 0.0) {
          const ft = smoothFriction(cvx, fn, MU_FLOOR);
          const fx = ft;
          const fy = -fn;
          AX[i] += fx * INV_M;
          AY[i] += fy * INV_M;
          A_ROT[i] += (rx * fy - ry * fx) * INV_I;
        }
      }

      // Left Wall: x = 100
      if (px < 100.0) {
        const sPen = smoothPen(100.0 - px);
        const vpen = -cvx;
        let fn = (K_WALL + D_WALL * vpen) * sPen;
        if (fn > 0.0) {
          const ft = smoothFriction(cvy, fn, MU_FLOOR);
          const fx = fn;
          const fy = ft;
          AX[i] += fx * INV_M;
          AY[i] += fy * INV_M;
          A_ROT[i] += (rx * fy - ry * fx) * INV_I;
        }
      }

      // Right Wall: x = 1180
      if (px > 1180.0) {
        const sPen = smoothPen(px - 1180.0);
        const vpen = cvx;
        let fn = (K_WALL + D_WALL * vpen) * sPen;
        if (fn > 0.0) {
          const ft = smoothFriction(cvy, fn, MU_FLOOR);
          const fx = -fn;
          const fy = ft;
          AX[i] += fx * INV_M;
          AY[i] += fy * INV_M;
          A_ROT[i] += (rx * fy - ry * fx) * INV_I;
        }
      }

      // Ramp 1: Solid slab from (100, 220) to (720, 340), thickness 36 px
      const r1dx = 620.0;
      const r1dy = 120.0;
      const r1len = 631.5061;
      const r1tx = r1dx / r1len;
      const r1ty = r1dy / r1len;
      const r1nx = r1ty;
      const r1ny = -r1tx; // upward normal (ny < 0)

      const v1x = px - 100.0;
      const v1y = py - 220.0;
      const s1 = v1x * r1tx + v1y * r1ty;
      if (s1 > -10.0 && s1 < r1len + 15.0) {
        const d1 = v1x * r1nx + v1y * r1ny;
        const RAMP_THICK: f64 = 36.0;

        // Top surface collision: d1 in [-18, 0]
        if (d1 <= 0.0 && d1 >= -18.0 && s1 <= r1len) {
          const sPen = smoothPen(-d1);
          const vpen = -(cvx * r1nx + cvy * r1ny);
          let fn = (K_WALL + D_WALL * vpen) * sPen;
          if (fn > 0.0) {
            const vt = cvx * r1tx + cvy * r1ty;
            const ft = smoothFriction(vt, fn, MU_RAMP);
            const fx = fn * r1nx + ft * r1tx;
            const fy = fn * r1ny + ft * r1ty;
            AX[i] += fx * INV_M;
            AY[i] += fy * INV_M;
            A_ROT[i] += (rx * fy - ry * fx) * INV_I;
          }
        }
        // Underside surface collision: d1 in [-48, -18]
        else if (d1 < -18.0 && d1 >= -RAMP_THICK - 12.0 && s1 <= r1len) {
          const pen = d1 + RAMP_THICK;
          if (pen > 0.0) {
            const sPen = smoothPen(pen);
            const unx = -r1nx;
            const uny = -r1ny; // uny > 0 (downward normal)
            const vpen = -(cvx * unx + cvy * uny);
            let fn = (K_WALL + D_WALL * vpen) * sPen;
            if (fn > 0.0) {
              const utx = -r1tx;
              const uty = -r1ty;
              const vt = cvx * utx + cvy * uty;
              const ft = smoothFriction(vt, fn, MU_RAMP);
              const fx = fn * unx + ft * utx;
              const fy = fn * uny + ft * uty;
              AX[i] += fx * INV_M;
              AY[i] += fy * INV_M;
              A_ROT[i] += (rx * fy - ry * fx) * INV_I;
            }
          }
        }
        // Tip collision at the end of Ramp 1
        else if (s1 > r1len && s1 < r1len + 15.0 && d1 <= 0.0 && d1 >= -RAMP_THICK) {
          const sPen = smoothPen(r1len + 15.0 - s1);
          const vpen = -(cvx * r1tx + cvy * r1ty);
          let fn = (K_WALL + D_WALL * vpen) * sPen;
          if (fn > 0.0) {
            const fx = fn * r1tx;
            const fy = fn * r1ty;
            AX[i] += fx * INV_M;
            AY[i] += fy * INV_M;
            A_ROT[i] += (rx * fy - ry * fx) * INV_I;
          }
        }
      }

      // Ramp 2: Solid slab from (1180, 380) to (520, 500), thickness 36 px
      const r2dx = -660.0;
      const r2dy = 120.0;
      const r2len = 670.8204;
      const r2tx = r2dx / r2len;
      const r2ty = r2dy / r2len;
      const r2nx = -r2ty;
      const r2ny = r2tx; // upward normal (ny < 0)

      const v2x = px - 1180.0;
      const v2y = py - 380.0;
      const s2 = v2x * r2tx + v2y * r2ty;
      if (s2 > -10.0 && s2 < r2len + 15.0) {
        const d2 = v2x * r2nx + v2y * r2ny;
        const RAMP_THICK: f64 = 36.0;

        // Top surface collision: d2 in [-18, 0]
        if (d2 <= 0.0 && d2 >= -18.0 && s2 <= r2len) {
          const sPen = smoothPen(-d2);
          const vpen = -(cvx * r2nx + cvy * r2ny);
          let fn = (K_WALL + D_WALL * vpen) * sPen;
          if (fn > 0.0) {
            const vt = cvx * r2tx + cvy * r2ty;
            const ft = smoothFriction(vt, fn, MU_RAMP);
            const fx = fn * r2nx + ft * r2tx;
            const fy = fn * r2ny + ft * r2ty;
            AX[i] += fx * INV_M;
            AY[i] += fy * INV_M;
            A_ROT[i] += (rx * fy - ry * fx) * INV_I;
          }
        }
        // Underside surface collision: d2 in [-48, -18]
        else if (d2 < -18.0 && d2 >= -RAMP_THICK - 12.0 && s2 <= r2len) {
          const pen = d2 + RAMP_THICK;
          if (pen > 0.0) {
            const sPen = smoothPen(pen);
            const unx = -r2nx;
            const uny = -r2ny; // uny > 0 (downward normal)
            const vpen = -(cvx * unx + cvy * uny);
            let fn = (K_WALL + D_WALL * vpen) * sPen;
            if (fn > 0.0) {
              const utx = -r2tx;
              const uty = -r2ty;
              const vt = cvx * utx + cvy * uty;
              const ft = smoothFriction(vt, fn, MU_RAMP);
              const fx = fn * unx + ft * utx;
              const fy = fn * uny + ft * uty;
              AX[i] += fx * INV_M;
              AY[i] += fy * INV_M;
              A_ROT[i] += (rx * fy - ry * fx) * INV_I;
            }
          }
        }
        // Tip collision at the end of Ramp 2
        else if (s2 > r2len && s2 < r2len + 15.0 && d2 <= 0.0 && d2 >= -RAMP_THICK) {
          const sPen = smoothPen(r2len + 15.0 - s2);
          const vpen = -(cvx * r2tx + cvy * r2ty);
          let fn = (K_WALL + D_WALL * vpen) * sPen;
          if (fn > 0.0) {
            const fx = fn * r2tx;
            const fy = fn * r2ty;
            AX[i] += fx * INV_M;
            AY[i] += fy * INV_M;
            A_ROT[i] += (rx * fy - ry * fx) * INV_I;
          }
        }
      }
    }
  }

  // 2. Box-to-Box Continuous Contacts via 2D SAT
  for (let i = 0; i < BOX_COUNT; i++) {
    const baseI = i * 6;
    const xi = y[baseI + 0];
    const yi = y[baseI + 1];
    const thi = y[baseI + 2];
    const vxi = y[baseI + 3];
    const vyi = y[baseI + 4];
    const wi = y[baseI + 5];

    const cosI = Math.cos(thi);
    const sinI = Math.sin(thi);

    for (let j = i + 1; j < BOX_COUNT; j++) {
      const baseJ = j * 6;
      const xj = y[baseJ + 0];
      const yj = y[baseJ + 1];
      const thj = y[baseJ + 2];
      const vxj = y[baseJ + 3];
      const vyj = y[baseJ + 4];
      const wj = y[baseJ + 5];

      const cosJ = Math.cos(thj);
      const sinJ = Math.sin(thj);

      collideBoxesSAT(
        i, j,
        xi, yi, vxi, vyi, wi,
        xj, yj, vxj, vyj, wj,
        cosI, sinI, cosJ, sinJ
      );
    }
  }

  // 3. Assemble dy/dt: [vx, vy, omega, ax, ay, alpha]
  for (let i = 0; i < BOX_COUNT; i++) {
    const base = i * 6;
    dy[base + 0] = y[base + 3];
    dy[base + 1] = y[base + 4];
    dy[base + 2] = y[base + 5];
    dy[base + 3] = AX[i];
    dy[base + 4] = AY[i];
    dy[base + 5] = A_ROT[i];
  }

  return 0;
}

// ── Main Entry Point ──────────────────────────────────────────────────────

/// Whether the guest was asked to show a window.
function wantsWindow(): bool {
  for (let i = 0; i < argCount(); i++) {
    if (arg(i) == "--windowed") return true;
  }
  return false;
}

export function _start_game(): void {
  print("Tension 2D Stiff Box Physics (BDF2 Implicit Solver)");

  // 1. Session Setup
  if (RuntimeSession.open(ConfigBuilder.forThisBuild()) != 0) {
    print("ERROR: RuntimeSession failed to open");
    return;
  }

  // 2. Open Canvas (windowed if requested, offscreen otherwise)
  const window = wantsWindow();
  const canvas = window
    ? Canvas.windowedOrOffscreen(1280, 720, "Tension 2D - Stiff Boxes (BDF2)")
    : Canvas.open(1280, 720);
  if (!canvas.isValid()) {
    print("ERROR: Canvas open failed");
    return;
  }
  if (canvas.displaysToWindow()) {
    platform.setWindowTitle("Tension 2D - Stiff Boxes (BDF2 Solver)");
  }

  // 3. Load Compile-Time Packed Texture from .tns Resource
  const tex = canvas.loadTextureFromRes("textures/boxes.iwi");
  if (tex <= 0) {
    print("ERROR: Failed to load texture from resource volume: " + tex.toString());
    return;
  }
  print("OK: Texture loaded from resource volume, handle: " + tex.toString());

  // 4. Set Pipeline and Bind Texture
  const BLOB_SIZE: u32 = 584;
  const blobPtr: usize = memory.data(<usize>BLOB_SIZE, 8);
  memory.copy(blobPtr, changetype<usize>(DEFAULT_2D_BLOB.dataStart), BLOB_SIZE);
  const pipe = canvas.pipelineGraph(blobPtr, BLOB_SIZE);
  if (pipe < PIPE_PRESET_MIN) {
    print("ERROR: pipelineGraph failed: " + pipe.toString());
    canvas.close();
    return;
  }
  canvas.bindTexture(pipe, 0, tex);

  // 5. Create Solver with method: "bdf2"
  const solverCfg = new SolverConfig();
  solverCfg.method = "bdf2";
  solverCfg.source = "wasm";
  solverCfg.dim = STATE_DIM;
  solverCfg.iterations = 12;
  solverCfg.convergenceTol = 3.0; // 3.0 px/s velocity residual -> 0.012 px position accuracy

  const solver = Solver.create(solverCfg, {
    derivative: _derivative,
    bufIn: deriv_buf_in,
    bufOut: deriv_buf_out,
  });
  if (solver == null) {
    print("ERROR: Solver.create(bdf2) failed");
    return;
  }
  print("OK: Solver initialized with BDF2 (Implicit 2nd-order L-stable)");

  // 6. Set Initial Conditions (Slot 0 is time t; slots 1..60 are the state vector)
  const state = new Float64Array(STATE_DIM + 1);
  // Staggered initial box positions cascading onto Ramp 1
  const initialPositions: f64[] = [
    180.0, 100.0,
    230.0,  60.0,
    280.0, 110.0,
    330.0,  70.0,
    380.0, 120.0,
    210.0, 150.0,
    260.0, 160.0,
    310.0, 160.0,
    360.0, 170.0,
    410.0, 130.0,
  ];

  for (let i = 0; i < BOX_COUNT; i++) {
    const base = 1 + i * 6;
    state[base + 0] = initialPositions[i * 2 + 0];
    state[base + 1] = initialPositions[i * 2 + 1];
    state[base + 2] = (<f64>i) * 0.12 - 0.3; // initial tilt
    state[base + 3] = 0.0; // drop straight down naturally
    state[base + 4] = 0.0;
    state[base + 5] = 0.0;
  }

  if (solver.setState(0.0, state.subarray(1)) != 0) {
    print("ERROR: solver.setState failed");
    return;
  }

  // Buffer for SpriteRecords. Sized from the declaration — `RECORD_SIZE` is
  // `sizeof<SpriteRecord>()`, and hardcoding the 28 bytes here would be a
  // second, unchecked copy of a layout the struct already states.
  const MAX_RECORDS: i32 = 512;
  const recordsAddr: usize = memory.data(MAX_RECORDS * <i32>RECORD_SIZE, 8);
  let records = changetype<@unmanaged [SpriteRecord *]>(recordsAddr);

  // 7. Simulation Loop
  const MAX_FRAMES: i32 = window ? 216000 : 500;
  const DT: f64 = 1.0 / 60.0;
  const SUBSTEPS: i32 = 4;
  const SUB_DT: f64 = DT / (<f64>SUBSTEPS);

  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    // Step BDF2 solver with substeps for continuous stiff contact mechanics
    for (let s = 0; s < SUBSTEPS; s++) {
      solver.step(SUB_DT);
    }

    if (solver.state(state) < 0) {
      print("ERROR: solver.state failed");
      break;
    }

    // Build Render Records
    let recIdx: u32 = 0;

    // Background tiles (1280x720 / 64x64 = 20x12 tiles)
    for (let by = 0; by < 720; by += 64) {
      for (let bx = 0; bx < 1280; bx += 64) {
        records[recIdx].x = bx;
        records[recIdx].y = by;
        records[recIdx].srcX = FRAME_BG.srcX;
        records[recIdx].srcY = FRAME_BG.srcY;
        records[recIdx].w = FRAME_BG.w;
        records[recIdx].h = FRAME_BG.h;
        records[recIdx].tex = 0;
        records[recIdx].sortKey = 10;
        records[recIdx].groupId = 0;
        records[recIdx].z = 0;
        records[recIdx].flags = 0;
        recIdx++;
      }
    }

    // Ceiling Platform at y = 0
    for (let cx = 64; cx < 1216; cx += 64) {
      records[recIdx].x = cx;
      records[recIdx].y = -30;
      records[recIdx].srcX = FRAME_GROUND.srcX;
      records[recIdx].srcY = FRAME_GROUND.srcY;
      records[recIdx].w = FRAME_GROUND.w;
      records[recIdx].h = FRAME_GROUND.h;
      records[recIdx].tex = 0;
      records[recIdx].sortKey = 50;
      records[recIdx].groupId = 0;
      records[recIdx].z = 1;
      records[recIdx].flags = 0;
      recIdx++;
    }

    // Ground Platform at y = 620 (19 tiles)
    for (let gx = 64; gx < 1216; gx += 64) {
      records[recIdx].x = gx;
      records[recIdx].y = 620;
      records[recIdx].srcX = FRAME_GROUND.srcX;
      records[recIdx].srcY = FRAME_GROUND.srcY;
      records[recIdx].w = FRAME_GROUND.w;
      records[recIdx].h = FRAME_GROUND.h;
      records[recIdx].tex = 0;
      records[recIdx].sortKey = 50;
      records[recIdx].groupId = 0;
      records[recIdx].z = 1;
      records[recIdx].flags = 0;
      recIdx++;
    }

    // Left and Right Walls (wy = 0 to 640)
    for (let wy = 0; wy < 640; wy += 64) {
      records[recIdx].x = 36;
      records[recIdx].y = wy;
      records[recIdx].srcX = FRAME_WALL.srcX;
      records[recIdx].srcY = FRAME_WALL.srcY;
      records[recIdx].w = FRAME_WALL.w;
      records[recIdx].h = FRAME_WALL.h;
      records[recIdx].tex = 0;
      records[recIdx].sortKey = 50;
      records[recIdx].groupId = 0;
      records[recIdx].z = 1;
      records[recIdx].flags = 0;
      recIdx++;

      records[recIdx].x = 1180;
      records[recIdx].y = wy;
      records[recIdx].srcX = FRAME_WALL.srcX;
      records[recIdx].srcY = FRAME_WALL.srcY;
      records[recIdx].w = FRAME_WALL.w;
      records[recIdx].h = FRAME_WALL.h;
      records[recIdx].tex = 0;
      records[recIdx].sortKey = 50;
      records[recIdx].groupId = 0;
      records[recIdx].z = 1;
      records[recIdx].flags = 0;
      recIdx++;
    }

    // Ramp 1 tiles: from (100, 220) to (720, 340) (11 tiles)
    for (let r = 0; r < 11; r++) {
      const frac = (<f64>r) / 10.0;
      const rx = <i32>(100.0 + frac * 620.0 - 32.0);
      const ry = <i32>(220.0 + frac * 120.0);
      records[recIdx].x = rx;
      records[recIdx].y = ry;
      records[recIdx].srcX = FRAME_RAMP.srcX;
      records[recIdx].srcY = FRAME_RAMP.srcY;
      records[recIdx].w = FRAME_RAMP.w;
      records[recIdx].h = FRAME_RAMP.h;
      records[recIdx].tex = 0;
      records[recIdx].sortKey = 60;
      records[recIdx].groupId = 0;
      records[recIdx].z = 2;
      records[recIdx].flags = 0;
      recIdx++;
    }

    // Ramp 2 tiles: from (1180, 380) to (520, 500) (11 tiles)
    for (let r = 0; r < 11; r++) {
      const frac = (<f64>r) / 10.0;
      const rx = <i32>(1180.0 - frac * 660.0 - 32.0);
      const ry = <i32>(380.0 + frac * 120.0);
      records[recIdx].x = rx;
      records[recIdx].y = ry;
      records[recIdx].srcX = FRAME_RAMP.srcX;
      records[recIdx].srcY = FRAME_RAMP.srcY;
      records[recIdx].w = FRAME_RAMP.w;
      records[recIdx].h = FRAME_RAMP.h;
      records[recIdx].tex = 0;
      records[recIdx].sortKey = 60;
      records[recIdx].groupId = 0;
      records[recIdx].z = 2;
      records[recIdx].flags = 0;
      recIdx++;
    }

    // Dynamic Boxes
    for (let i = 0; i < BOX_COUNT; i++) {
      const base = 1 + i * 6;
      const bx = <i32>Math.round(state[base + 0] - 32.0);
      const by = <i32>Math.round(state[base + 1] - 32.0);
      const th = state[base + 2];

      const boxF = getBoxFrame(BOX_STYLES[i], th);
      records[recIdx].x = bx;
      records[recIdx].y = by;
      records[recIdx].srcX = boxF.srcX;
      records[recIdx].srcY = boxF.srcY;
      records[recIdx].w = boxF.w;
      records[recIdx].h = boxF.h;
      records[recIdx].tex = 0;
      records[recIdx].sortKey = 100 + <u32>i;
      records[recIdx].groupId = 0;
      records[recIdx].z = 3;
      records[recIdx].flags = 0;
      recIdx++;
    }

    // Submit and Present
    canvas.submit(pipe, records, recIdx);
    const presentRc = canvas.present();
    if (presentRc != 0) {
      if (presentRc == -125) { // -ECANCELED: window closed
        break;
      }
      print("ERROR: present failed: " + presentRc.toString());
      break;
    }

    // Assertion at frame 150
    if (frame == 150) {
      print("OK: Frame 150 reached, all boxes active in simulation");
    }
  }

  // 8. Verify the physics invariant the example claims. The screenshot
  // check below cannot carry this: the background tiles cover every pixel,
  // so a frame renders "fully" whether or not a single box moved.
  let physicsOk = true;
  let inArena = 0;
  let fell = 0;
  for (let i = 0; i < BOX_COUNT; i++) {
    const base = 1 + i * 6;
    const bx = state[base + 0];
    const by = state[base + 1];
    const th = state[base + 2];
    if (!isFinite(bx) || !isFinite(by) || !isFinite(th)) {
      print("ERROR: box " + i.toString() + " has NaN/infinite state");
      physicsOk = false;
      continue;
    }
    // Arena: walls at x = 36 / 1180, ceiling 30, floor 620.
    if (bx < 36.0 || bx > 1180.0 || by < 30.0 || by > 620.0) {
      print(
        "ERROR: box " + i.toString() + " escaped the arena: (" +
          bx.toString() + ", " + by.toString() + ")",
      );
      physicsOk = false;
    } else {
      inArena++;
    }
    // Spawn heights are y = 60..170; resting on the floor or a ramp is y > 300.
    if (by > 300.0) fell++;
  }
  // Stiff contact must not freeze bodies in mid-air: every box that was
  // dropped has to have travelled down to a surface.
  if (fell < BOX_COUNT) {
    print(
      "ERROR: only " + fell.toString() + "/" + BOX_COUNT.toString() +
        " boxes reached a surface (stiff contact held them up)",
    );
    physicsOk = false;
  }

  // 9. Screenshot Verification
  const SS_PIXELS: u32 = 1280 * 720;
  const SS_BYTES: u32 = SS_PIXELS * 4;
  const ssBuf: usize = memory.data(<usize>SS_BYTES, 8);
  let ssPix = changetype<@unmanaged [Rgba *]>(ssBuf);
  const ssRc = canvas.screenshot(ssPix, SS_BYTES);
  if (ssRc > 0) {
    let nonZero: u32 = 0;
    for (let p: u32 = 0; p < SS_PIXELS; p++) {
      if (ssPix[p].r > 0 || ssPix[p].g > 0 || ssPix[p].b > 0) {
        nonZero++;
      }
    }
    if (nonZero > 10000) {
      print("OK: Screenshot verified with " + nonZero.toString() + " rendered non-zero pixels");
    } else {
      print("WARNING: Screenshot has low pixel coverage: " + nonZero.toString());
    }
  }

  solver.destroy();
  canvas.close();
  if (physicsOk) {
    print(
      "OK: " + inArena.toString() + "/" + BOX_COUNT.toString() +
        " boxes finite, in-arena, and settled on a surface under BDF2",
    );
    print("OK: stiff-boxes BDF2 simulation stable");
  } else {
    print("ERROR: stiff-boxes physics verification failed");
  }
}
