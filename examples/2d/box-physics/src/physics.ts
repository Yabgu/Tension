// examples/2d/box-physics/src/physics.ts
//
// 2D Rigid Body Physics Engine for Boxes.
//
// Features:
//   - Oriented Bounding Boxes (OBB) with continuous angle and angular velocity
//   - Mass and moment of inertia I = (1/3) * m * (hw^2 + hh^2)
//   - Separating Axis Theorem (SAT) for box-box narrow-phase collision detection
//   - Sutherland-Hodgman polygon contact clipping (1 or 2 contact points per manifold)
//   - Sequential impulse solver with Coulomb friction and restitution
//   - Baumgarte position stabilization (bias)
//   - Sub-stepping for stable stacking and crisp rotation dynamics
//   - Pre-allocated zero-allocation contact pool

import { absf, clamp, cross2d, dot2d, maxf, minf, PI, TWO_PI } from "./math";

export class Body {
  id: i32;
  x: f32;
  y: f32;
  angle: f32;
  vx: f32;
  vy: f32;
  omega: f32;
  hw: f32;
  hh: f32;
  mass: f32;
  invMass: f32;
  inertia: f32;
  invInertia: f32;
  restitution: f32;
  friction: f32;
  isStatic: bool;
  shapeType: i32;

  // Cached local axes (unit vectors along width and height)
  uxX: f32 = 1.0;
  uxY: f32 = 0.0;
  uyX: f32 = 0.0;
  uyY: f32 = 1.0;

  constructor(
    id: i32,
    x: f32,
    y: f32,
    angle: f32,
    hw: f32,
    hh: f32,
    mass: f32,
    inertia: f32,
    restitution: f32,
    friction: f32,
    isStatic: bool,
    shapeType: i32,
  ) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.vx = 0.0;
    this.vy = 0.0;
    this.omega = 0.0;
    this.hw = hw;
    this.hh = hh;
    this.mass = mass;
    this.invMass = isStatic || mass <= 0.0 ? 0.0 : 1.0 / mass;
    this.inertia = inertia;
    this.invInertia = isStatic || inertia <= 0.0 ? 0.0 : 1.0 / inertia;
    this.restitution = restitution;
    this.friction = friction;
    this.isStatic = isStatic;
    this.shapeType = shapeType;
    this.updateAxes();
  }

  updateAxes(): void {
    const c = Mathf.cos(this.angle);
    const s = Mathf.sin(this.angle);
    this.uxX = c;
    this.uxY = s;
    this.uyX = -s;
    this.uyY = c;
  }

  static createDynamic(
    id: i32,
    x: f32,
    y: f32,
    angle: f32,
    hw: f32,
    hh: f32,
    density: f32,
    restitution: f32,
    friction: f32,
    shapeType: i32,
  ): Body {
    const area: f32 = 4.0 * hw * hh;
    const m: f32 = density * area;
    // Moment of inertia for a solid rectangle of dimensions 2*hw by 2*hh:
    // I = (1/12) * m * ((2*hw)^2 + (2*hh)^2) = (1/3) * m * (hw^2 + hh^2)
    const I: f32 = (<f32>(1.0 / 3.0)) * m * (hw * hw + hh * hh);
    return new Body(
      id,
      x,
      y,
      angle,
      hw,
      hh,
      m,
      I,
      restitution,
      friction,
      false,
      shapeType,
    );
  }

  static createStatic(
    id: i32,
    x: f32,
    y: f32,
    angle: f32,
    hw: f32,
    hh: f32,
    restitution: f32,
    friction: f32,
    shapeType: i32,
  ): Body {
    return new Body(
      id,
      x,
      y,
      angle,
      hw,
      hh,
      0.0,
      0.0,
      restitution,
      friction,
      true,
      shapeType,
    );
  }
}

class ClipVertex {
  x: f32 = 0.0;
  y: f32 = 0.0;
}

export class Contact {
  bodyA: Body | null = null;
  bodyB: Body | null = null;
  px: f32 = 0.0;
  py: f32 = 0.0;
  nx: f32 = 0.0;
  ny: f32 = 0.0;
  penetration: f32 = 0.0;
  normalImpulse: f32 = 0.0;
  tangentImpulse: f32 = 0.0;
  normalMass: f32 = 0.0;
  tangentMass: f32 = 0.0;
  bias: f32 = 0.0;
  rAx: f32 = 0.0;
  rAy: f32 = 0.0;
  rBx: f32 = 0.0;
  rBy: f32 = 0.0;

  set(
    bodyA: Body,
    bodyB: Body,
    px: f32,
    py: f32,
    nx: f32,
    ny: f32,
    penetration: f32,
  ): void {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    this.px = px;
    this.py = py;
    this.nx = nx;
    this.ny = ny;
    this.penetration = penetration;
    this.normalImpulse = 0.0;
    this.tangentImpulse = 0.0;
  }
}

export class PhysicsWorld {
  bodies: Body[] = [];
  contacts: Contact[] = [];
  contactCount: i32 = 0;
  gravityY: f32 = 500.0;
  substeps: i32 = 4;
  velocityIterations: i32 = 8;
  totalCollisionsResolved: i32 = 0;

  // Scratch buffers for polygon clipping (avoids allocation during SAT loop)
  private clipBuf1: ClipVertex[] = [new ClipVertex(), new ClipVertex()];
  private clipBuf2: ClipVertex[] = [new ClipVertex(), new ClipVertex()];

  constructor(maxContacts: i32 = 128) {
    for (let i = 0; i < maxContacts; i++) {
      this.contacts.push(new Contact());
    }
  }

  addBody(body: Body): void {
    this.bodies.push(body);
  }

  step(dt: f32): void {
    const h = dt / <f32>this.substeps;

    for (let s = 0; s < this.substeps; s++) {
      // 1. Apply gravity and update axes
      for (let i = 0; i < this.bodies.length; i++) {
        const b = this.bodies[i];
        if (!b.isStatic) {
          b.vy += this.gravityY * h;
        }
        b.updateAxes();
      }

      // 2. Collision detection (SAT + Clipping)
      this.contactCount = 0;
      for (let i = 0; i < this.bodies.length; i++) {
        const bA = this.bodies[i];
        for (let j = i + 1; j < this.bodies.length; j++) {
          const bB = this.bodies[j];
          if (bA.isStatic && bB.isStatic) continue;
          this.testBoxCollision(bA, bB);
        }
      }

      this.totalCollisionsResolved += this.contactCount;

      // 3. Pre-step contacts (compute effective masses and bias)
      for (let c = 0; c < this.contactCount; c++) {
        const contact = this.contacts[c];
        const bA = contact.bodyA!;
        const bB = contact.bodyB!;

        contact.rAx = contact.px - bA.x;
        contact.rAy = contact.py - bA.y;
        contact.rBx = contact.px - bB.x;
        contact.rBy = contact.py - bB.y;

        const rnA = cross2d(contact.rAx, contact.rAy, contact.nx, contact.ny);
        const rnB = cross2d(contact.rBx, contact.rBy, contact.nx, contact.ny);
        const kNormal =
          bA.invMass +
          bB.invMass +
          rnA * rnA * bA.invInertia +
          rnB * rnB * bB.invInertia;
        contact.normalMass = kNormal > 0.0 ? 1.0 / kNormal : 0.0;

        const tx = -contact.ny;
        const ty = contact.nx;
        const rtA = cross2d(contact.rAx, contact.rAy, tx, ty);
        const rtB = cross2d(contact.rBx, contact.rBy, tx, ty);
        const kTangent =
          bA.invMass +
          bB.invMass +
          rtA * rtA * bA.invInertia +
          rtB * rtB * bB.invInertia;
        contact.tangentMass = kTangent > 0.0 ? 1.0 / kTangent : 0.0;

        // Baumgarte stabilization bias: positive velocity push-out to resolve overlap
        const slop: f32 = 0.5;
        const biasFactor: f32 = 0.2;
        const maxBiasVelocity: f32 = 50.0;
        let biasVelocity = (biasFactor / h) * maxf(0.0, contact.penetration - slop);
        biasVelocity = minf(biasVelocity, maxBiasVelocity);
        contact.bias = biasVelocity;

        // Relative velocity along normal
        const rvx = (bB.vx - bB.omega * contact.rBy) - (bA.vx - bA.omega * contact.rAy);
        const rvy = (bB.vy + bB.omega * contact.rBx) - (bA.vy + bA.omega * contact.rAx);
        const vn = dot2d(rvx, rvy, contact.nx, contact.ny);

        // Restitution bounce for closing velocities
        const e = maxf(bA.restitution, bB.restitution);
        if (vn < -10.0) {
          contact.bias += -e * vn;
        }
      }

      // 4. Sequential impulse iterations
      for (let iter = 0; iter < this.velocityIterations; iter++) {
        for (let c = 0; c < this.contactCount; c++) {
          const contact = this.contacts[c];
          const bA = contact.bodyA!;
          const bB = contact.bodyB!;

          const tx = -contact.ny;
          const ty = contact.nx;

          // Friction impulse
          const rvx1 = (bB.vx - bB.omega * contact.rBy) - (bA.vx - bA.omega * contact.rAy);
          const rvy1 = (bB.vy + bB.omega * contact.rBx) - (bA.vy + bA.omega * contact.rAx);
          const vt = dot2d(rvx1, rvy1, tx, ty);

          const dJt = contact.tangentMass * -vt;
          const friction = Mathf.sqrt(bA.friction * bB.friction);
          const maxJt = friction * contact.normalImpulse;
          const oldJt = contact.tangentImpulse;
          contact.tangentImpulse = clamp(oldJt + dJt, -maxJt, maxJt);
          const actualDJt = contact.tangentImpulse - oldJt;

          bA.vx -= actualDJt * tx * bA.invMass;
          bA.vy -= actualDJt * ty * bA.invMass;
          bA.omega -= cross2d(contact.rAx, contact.rAy, tx, ty) * actualDJt * bA.invInertia;

          bB.vx += actualDJt * tx * bB.invMass;
          bB.vy += actualDJt * ty * bB.invMass;
          bB.omega += cross2d(contact.rBx, contact.rBy, tx, ty) * actualDJt * bB.invInertia;

          // Normal impulse
          const rvx2 = (bB.vx - bB.omega * contact.rBy) - (bA.vx - bA.omega * contact.rAy);
          const rvy2 = (bB.vy + bB.omega * contact.rBx) - (bA.vy + bA.omega * contact.rAx);
          const vn = dot2d(rvx2, rvy2, contact.nx, contact.ny);

          const dJn = contact.normalMass * (-vn + contact.bias);
          const oldJn = contact.normalImpulse;
          contact.normalImpulse = maxf(0.0, oldJn + dJn);
          const actualDJn = contact.normalImpulse - oldJn;

          bA.vx -= actualDJn * contact.nx * bA.invMass;
          bA.vy -= actualDJn * contact.ny * bA.invMass;
          bA.omega -= cross2d(contact.rAx, contact.rAy, contact.nx, contact.ny) * actualDJn * bA.invInertia;

          bB.vx += actualDJn * contact.nx * bB.invMass;
          bB.vy += actualDJn * contact.ny * bB.invMass;
          bB.omega += cross2d(contact.rBx, contact.rBy, contact.nx, contact.ny) * actualDJn * bB.invInertia;
        }
      }

      // 5. Integrate positions and orientations with damping and bounds safety
      for (let i = 0; i < this.bodies.length; i++) {
        const b = this.bodies[i];
        if (!b.isStatic) {
          b.x += b.vx * h;
          b.y += b.vy * h;
          b.angle += b.omega * h;

          // Velocity damping to allow natural settling without buzzing
          b.vx *= 1.0 - 0.05 * h;
          b.vy *= 1.0 - 0.05 * h;
          b.omega *= 1.0 - 0.08 * h;

          // Velocity speed limits to prevent numerical explosion
          const speedSq = b.vx * b.vx + b.vy * b.vy;
          const maxSpeed: f32 = 500.0;
          if (speedSq > maxSpeed * maxSpeed) {
            const scale = maxSpeed / Mathf.sqrt(speedSq);
            b.vx *= scale;
            b.vy *= scale;
          }
          b.omega = clamp(b.omega, -20.0, 20.0);

          // Hard safety boundary guard: guarantee boxes never escape screen
          const xMin: f32 = <f32>18.0 + b.hw;
          const xMax: f32 = <f32>622.0 - b.hw;
          const yMin: f32 = <f32>18.0 + b.hh;
          const yMax: f32 = <f32>328.0 - b.hh;

          if (b.x < xMin) {
            b.x = xMin;
            if (b.vx < 0.0) b.vx = 0.0;
          } else if (b.x > xMax) {
            b.x = xMax;
            if (b.vx > 0.0) b.vx = 0.0;
          }
          if (b.y < yMin) {
            b.y = yMin;
            if (b.vy < 0.0) b.vy = 0.0;
          } else if (b.y > yMax) {
            b.y = yMax;
            if (b.vy > 0.0) b.vy = 0.0;
          }
        }
      }
    }
  }

  private testBoxCollision(bA: Body, bB: Body): void {
    const dx = bB.x - bA.x;
    const dy = bB.y - bA.y;

    // Test axis 1: bA.ux
    const rA1 = bA.hw;
    const rB1 =
      bB.hw * absf(dot2d(bB.uxX, bB.uxY, bA.uxX, bA.uxY)) +
      bB.hh * absf(dot2d(bB.uyX, bB.uyY, bA.uxX, bA.uxY));
    const dist1 = dot2d(dx, dy, bA.uxX, bA.uxY);
    const s1 = rA1 + rB1 - absf(dist1);
    if (s1 <= 0.0) return;

    // Test axis 2: bA.uy
    const rA2 = bA.hh;
    const rB2 =
      bB.hw * absf(dot2d(bB.uxX, bB.uxY, bA.uyX, bA.uyY)) +
      bB.hh * absf(dot2d(bB.uyX, bB.uyY, bA.uyX, bA.uyY));
    const dist2 = dot2d(dx, dy, bA.uyX, bA.uyY);
    const s2 = rA2 + rB2 - absf(dist2);
    if (s2 <= 0.0) return;

    // Test axis 3: bB.ux
    const rA3 =
      bA.hw * absf(dot2d(bA.uxX, bA.uxY, bB.uxX, bB.uxY)) +
      bA.hh * absf(dot2d(bA.uyX, bA.uyY, bB.uxX, bB.uxY));
    const rB3 = bB.hw;
    const dist3 = dot2d(dx, dy, bB.uxX, bB.uxY);
    const s3 = rA3 + rB3 - absf(dist3);
    if (s3 <= 0.0) return;

    // Test axis 4: bB.uy
    const rA4 =
      bA.hw * absf(dot2d(bA.uxX, bA.uxY, bB.uyX, bB.uyY)) +
      bA.hh * absf(dot2d(bA.uyX, bA.uyY, bB.uyX, bB.uyY));
    const rB4 = bB.hh;
    const dist4 = dot2d(dx, dy, bB.uyX, bB.uyY);
    const s4 = rA4 + rB4 - absf(dist4);
    if (s4 <= 0.0) return;

    // Find axis of minimum penetration
    let minS = s1;
    let axisIndex: i32 = 1;

    if (s2 < minS) {
      minS = s2;
      axisIndex = 2;
    }
    if (s3 < minS) {
      minS = s3;
      axisIndex = 3;
    }
    if (s4 < minS) {
      minS = s4;
      axisIndex = 4;
    }

    let nx: f32 = 0.0;
    let ny: f32 = 0.0;
    let refBody = bA;
    let incBody = bB;
    let isARef = true;

    if (axisIndex == 1) {
      nx = bA.uxX;
      ny = bA.uxY;
      if (dot2d(dx, dy, nx, ny) < 0.0) {
        nx = -nx;
        ny = -ny;
      }
    } else if (axisIndex == 2) {
      nx = bA.uyX;
      ny = bA.uyY;
      if (dot2d(dx, dy, nx, ny) < 0.0) {
        nx = -nx;
        ny = -ny;
      }
    } else if (axisIndex == 3) {
      nx = bB.uxX;
      ny = bB.uxY;
      if (dot2d(dx, dy, nx, ny) < 0.0) {
        nx = -nx;
        ny = -ny;
      }
      refBody = bB;
      incBody = bA;
      isARef = false;
    } else {
      nx = bB.uyX;
      ny = bB.uyY;
      if (dot2d(dx, dy, nx, ny) < 0.0) {
        nx = -nx;
        ny = -ny;
      }
      refBody = bB;
      incBody = bA;
      isARef = false;
    }

    // Normal points from bA to bB
    const normalABX = nx;
    const normalABY = ny;

    // Normal pointing outward from reference body
    const nRefX = isARef ? normalABX : -normalABX;
    const nRefY = isARef ? normalABY : -normalABY;

    // Reference body face extents
    let extN: f32 = 0.0;
    let extT: f32 = 0.0;
    if (isARef) {
      if (axisIndex == 1) {
        extN = refBody.hw;
        extT = refBody.hh;
      } else {
        extN = refBody.hh;
        extT = refBody.hw;
      }
    } else {
      if (axisIndex == 3) {
        extN = refBody.hw;
        extT = refBody.hh;
      } else {
        extN = refBody.hh;
        extT = refBody.hw;
      }
    }

    const tRefX = -nRefY;
    const tRefY = nRefX;
    const cRefX = refBody.x + nRefX * extN;
    const cRefY = refBody.y + nRefY * extN;

    // Find incident edge on incident body (face with normal most anti-parallel to nRef)
    const dot0 = dot2d(incBody.uxX, incBody.uxY, nRefX, nRefY);
    const dot1 = -dot0;
    const dot2 = dot2d(incBody.uyX, incBody.uyY, nRefX, nRefY);
    const dot3 = -dot2;

    let minDot = dot0;
    let incFace = 0;
    if (dot1 < minDot) {
      minDot = dot1;
      incFace = 1;
    }
    if (dot2 < minDot) {
      minDot = dot2;
      incFace = 2;
    }
    if (dot3 < minDot) {
      minDot = dot3;
      incFace = 3;
    }

    let p0x: f32 = 0.0;
    let p0y: f32 = 0.0;
    let p1x: f32 = 0.0;
    let p1y: f32 = 0.0;

    if (incFace == 0) {
      p0x = incBody.x + incBody.uxX * incBody.hw + incBody.uyX * incBody.hh;
      p0y = incBody.y + incBody.uxY * incBody.hw + incBody.uyY * incBody.hh;
      p1x = incBody.x + incBody.uxX * incBody.hw - incBody.uyX * incBody.hh;
      p1y = incBody.y + incBody.uxY * incBody.hw - incBody.uyY * incBody.hh;
    } else if (incFace == 1) {
      p0x = incBody.x - incBody.uxX * incBody.hw - incBody.uyX * incBody.hh;
      p0y = incBody.y - incBody.uxY * incBody.hw - incBody.uyY * incBody.hh;
      p1x = incBody.x - incBody.uxX * incBody.hw + incBody.uyX * incBody.hh;
      p1y = incBody.y - incBody.uxY * incBody.hw + incBody.uyY * incBody.hh;
    } else if (incFace == 2) {
      p0x = incBody.x - incBody.uxX * incBody.hw + incBody.uyX * incBody.hh;
      p0y = incBody.y - incBody.uxY * incBody.hw + incBody.uyY * incBody.hh;
      p1x = incBody.x + incBody.uxX * incBody.hw + incBody.uyX * incBody.hh;
      p1y = incBody.y + incBody.uxY * incBody.hw + incBody.uyY * incBody.hh;
    } else {
      p0x = incBody.x + incBody.uxX * incBody.hw - incBody.uyX * incBody.hh;
      p0y = incBody.y + incBody.uxY * incBody.hw - incBody.uyY * incBody.hh;
      p1x = incBody.x - incBody.uxX * incBody.hw - incBody.uyX * incBody.hh;
      p1y = incBody.y - incBody.uxY * incBody.hw - incBody.uyY * incBody.hh;
    }

    // Clip against reference side plane 1 (-tRef)
    const offset1 = -dot2d(cRefX, cRefY, tRefX, tRefY) + extT;
    const count1 = this.clipSegment(
      p0x,
      p0y,
      p1x,
      p1y,
      -tRefX,
      -tRefY,
      offset1,
      this.clipBuf1,
    );
    if (count1 < 2) return;

    // Clip against reference side plane 2 (+tRef)
    const offset2 = dot2d(cRefX, cRefY, tRefX, tRefY) + extT;
    const count2 = this.clipSegment(
      this.clipBuf1[0].x,
      this.clipBuf1[0].y,
      this.clipBuf1[1].x,
      this.clipBuf1[1].y,
      tRefX,
      tRefY,
      offset2,
      this.clipBuf2,
    );
    if (count2 < 2) return;

    // Check penetration against reference face
    let addedCount = 0;
    for (let k = 0; k < 2; k++) {
      const qx = this.clipBuf2[k].x;
      const qy = this.clipBuf2[k].y;
      const sep = dot2d(qx - cRefX, qy - cRefY, nRefX, nRefY);
      if (sep <= 0.0 && this.contactCount < this.contacts.length) {
        const contact = this.contacts[this.contactCount++];
        contact.set(bA, bB, qx, qy, normalABX, normalABY, -sep);
        addedCount++;
      }
    }

    // Fallback if rounding left 0 points penetrating
    if (addedCount == 0 && this.contactCount < this.contacts.length) {
      const contact = this.contacts[this.contactCount++];
      contact.set(
        bA,
        bB,
        bA.x + dx * 0.5,
        bA.y + dy * 0.5,
        normalABX,
        normalABY,
        minS,
      );
    }
  }

  private clipSegment(
    p0x: f32,
    p0y: f32,
    p1x: f32,
    p1y: f32,
    nx: f32,
    ny: f32,
    offset: f32,
    outPts: ClipVertex[],
  ): i32 {
    const d0 = dot2d(p0x, p0y, nx, ny) - offset;
    const d1 = dot2d(p1x, p1y, nx, ny) - offset;

    if (d0 <= 0.0 && d1 <= 0.0) {
      outPts[0].x = p0x;
      outPts[0].y = p0y;
      outPts[1].x = p1x;
      outPts[1].y = p1y;
      return 2;
    }
    if (d0 > 0.0 && d1 > 0.0) {
      return 0;
    }
    const t = d0 / (d0 - d1);
    const ix = p0x + t * (p1x - p0x);
    const iy = p0y + t * (p1y - p0y);

    if (d0 <= 0.0) {
      outPts[0].x = p0x;
      outPts[0].y = p0y;
      outPts[1].x = ix;
      outPts[1].y = iy;
    } else {
      outPts[0].x = ix;
      outPts[0].y = iy;
      outPts[1].x = p1x;
      outPts[1].y = p1y;
    }
    return 2;
  }
}
