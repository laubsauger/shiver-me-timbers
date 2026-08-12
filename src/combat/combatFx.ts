/**
 * Combat fx (§T.16 muzzle fx, §V.14 splinter burst) — the visible half of
 * the chain: gun flash and powder smoke, splinters off a breach, the pillar
 * where a ball pitches into the sea, and the shot itself in flight.
 *
 * CPU-driven on purpose. §C sends HEAVY sims to compute passes; this is a
 * few hundred short-lived sprites driven by discrete events, so a compute
 * pass would buy nothing and would drag in the whole compute→render storage
 * buffer hazard that cost this project §B.8 (a `.toReadOnly()` on the write
 * side silently downgrading the binding, no error, buffers stuck at zero).
 * There is no compute pass here and no storage buffer, so §V.29 cannot
 * apply. Instanced attributes + SpriteNodeMaterial is the same pattern the
 * cloud cores already use.
 *
 * §V.28 throughout: pool sizes are sanitized ints fixed at construction,
 * every caller-fed value is finite-guarded at the spawn boundary, every
 * divisor is floored (fxMath), and dead particles are written at EXACTLY
 * zero size rather than zero opacity — §B.5 was NaN-sized additive quads
 * that read as a browser hang, and invisible-but-rasterized quads are the
 * same fill-rate bill for nothing.
 *
 * §V.3: reads a CombatFrame and SimState.projectiles, writes neither.
 */
import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, uv } from 'three/tsl';
import type { ProjectileState } from '../state/simState';
import { combatFxParams, type CombatFxParams } from '../params/combat';
import type { CombatFrame } from './combatSystem';
import {
  ageFraction,
  brightnessAt,
  burstDirection,
  jitterScale,
  hash01,
  sizeAt,
  stepVelocity,
  type FxKind,
  type FxProfile,
} from './fxMath';

/** §V.31: sRGB-authored tints enter through THREE.Color, never bare setRGB */
const TINTS: Record<FxKind, THREE.Color> = {
  flash: new THREE.Color(0xffd08a),
  smoke: new THREE.Color(0x9a958c),
  // burning powder grains: hotter and far more saturated than the smoke they
  // fly through, which is the only reason they read at all against it
  spark: new THREE.Color(0xffa53a),
  splinter: new THREE.Color(0xa97c4e),
  splash: new THREE.Color(0xcfe6e2),
  // the ball's own wake: thin, cool, and DIM on purpose — a bright trail
  // turns a wooden-ship demo into science fiction
  trail: new THREE.Color(0x6f7a80),
};

function profiles(p: CombatFxParams): Record<FxKind, FxProfile> {
  const rgb = (c: THREE.Color): [number, number, number] => [c.r, c.g, c.b];
  return {
    flash: {
      life: pos(p.flashLife, 0.09), sizeStart: pos(p.flashSize, 2.2),
      sizeEnd: pos(p.flashSize, 2.2) * 0.4, gravity: 0, drag: 6,
      color: rgb(TINTS.flash), speed: 2, spread: 0.35,
    },
    smoke: {
      life: pos(p.smokeLife, 2.4), sizeStart: pos(p.smokeSize, 1.1),
      sizeEnd: pos(p.smokeSize, 1.1) * pos(p.smokeGrowth, 4.5),
      gravity: -0.6, drag: 1.6, color: rgb(TINTS.smoke),
      speed: nn(p.smokeSpeed, 7), spread: 0.4,
    },
    spark: {
      life: pos(p.sparkLife, 0.4), sizeStart: pos(p.sparkSize, 0.14),
      sizeEnd: pos(p.sparkSize, 0.14) * 0.3, gravity: 9.81, drag: 1.1,
      color: rgb(TINTS.spark), speed: nn(p.sparkSpeed, 24), spread: 0.45,
    },
    trail: {
      life: pos(p.trailLife, 0.5), sizeStart: pos(p.trailSize, 0.22),
      sizeEnd: pos(p.trailSize, 0.22) * pos(p.trailGrowth, 3.2),
      gravity: -0.2, drag: 2.5, color: rgb(TINTS.trail), speed: 0.6, spread: 1,
    },
    splinter: {
      life: pos(p.splinterLife, 1.1), sizeStart: pos(p.splinterSize, 0.28),
      sizeEnd: pos(p.splinterSize, 0.28) * 0.5, gravity: 9.81, drag: 0.4,
      color: rgb(TINTS.splinter), speed: nn(p.splinterSpeed, 9), spread: 0.85,
    },
    splash: {
      life: pos(p.splashLife, 1), sizeStart: pos(p.splashSize, 1.4),
      sizeEnd: pos(p.splashSize, 1.4) * 2.2, gravity: 9.81, drag: 0.9,
      color: rgb(TINTS.splash), speed: nn(p.splashSpeed, 6), spread: 0.5,
    },
  };
}

export interface CombatFx {
  /** add to the scene once */
  group: THREE.Object3D;
  /**
   * Queue this sim tick's events (call once per tick). `projectiles` are the
   * balls still in the air: each lays a short vapour ribbon, because a
   * 0.3 m dark sphere at 60 m/s is genuinely hard to follow and real footage
   * reads the trail, not the shot.
   */
  emit(frame: CombatFrame, projectiles?: readonly ProjectileState[], tick?: number): void;
  /** advance particles and refresh buffers (call once per rendered frame) */
  update(frameDt: number, projectiles: readonly ProjectileState[]): void;
  dispose(): void;
}

/** the sphere's own long axis — what the stretch aligns with the velocity */
const BALL_UP = /*@__PURE__*/ new THREE.Vector3(0, 1, 0);

export function createCombatFx(p: CombatFxParams = combatFxParams): CombatFx {
  const count = sanitizeCount(p.particleCount, 768, 4096);
  const ballMax = sanitizeCount(p.ballCount, 64, 512);

  // --- sprite pool -------------------------------------------------------
  const posArr = new Float32Array(count * 3);
  const colArr = new Float32Array(count * 3);
  const sizeArr = new Float32Array(count); // 0 = dead, and dead means ZERO
  const velArr = new Float32Array(count * 3);
  const age = new Float32Array(count);
  const life = new Float32Array(count);
  /** per-particle size multiplier — the other half of breaking uniformity */
  const sizeScale = new Float32Array(count);
  const kinds = new Array<FxKind>(count).fill('smoke');
  life.fill(1);
  sizeScale.fill(1);
  age.fill(2); // whole pool starts dead

  const posAttr = new THREE.InstancedBufferAttribute(posArr, 3);
  const colAttr = new THREE.InstancedBufferAttribute(colArr, 3);
  const sizeAttr = new THREE.InstancedBufferAttribute(sizeArr, 1);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  sizeAttr.setUsage(THREE.DynamicDrawUsage);

  const material = new THREE.SpriteNodeMaterial();
  material.positionNode = instancedBufferAttribute(posAttr, 'vec3');
  material.scaleNode = instancedBufferAttribute(sizeAttr, 'float');
  const tint = instancedBufferAttribute(colAttr, 'vec3');
  // soft round falloff; additive, so brightness IS the fade and a dead
  // particle is already zero-size before it can contribute anything
  const q = uv().mul(2).sub(1);
  const shape = q.dot(q).oneMinus().max(0).pow(1.5);
  material.colorNode = tint;
  material.opacityNode = shape;
  material.transparent = true;
  material.blending = THREE.AdditiveBlending;
  material.depthWrite = false;
  material.fog = false;

  const sprites = new THREE.Sprite(material as unknown as THREE.SpriteMaterial);
  sprites.count = count;
  sprites.frustumCulled = false; // positions are written per frame, no bounds

  // --- cannonballs -------------------------------------------------------
  const ballGeo = new THREE.SphereGeometry(1, 10, 8);
  const ballMat = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0x1b1a19), // §V.31 sRGB through THREE.Color
    roughness: 0.55,
    metalness: 0.6,
  });
  const balls = new THREE.InstancedMesh(ballGeo, ballMat, ballMax);
  balls.count = 0;
  balls.frustumCulled = false;
  balls.castShadow = true;
  const ballMatrix = new THREE.Matrix4();
  const ballPos = new THREE.Vector3();
  const ballQuat = new THREE.Quaternion();
  const ballScale = new THREE.Vector3();
  const ballAxis = new THREE.Vector3();

  const group = new THREE.Group();
  group.name = 'combat-fx';
  group.add(sprites, balls);

  let cursor = 0;

  /**
   * `seed` keys the per-particle variation. Two guns in one broadside get
   * different seeds, so their smoke differs in size, speed and lifetime
   * instead of being the same cloud stamped twice — which is what the user
   * saw and named. `vary` 0 reproduces the old uniform burst exactly, so the
   * knob can be taken to zero to prove the variation is what changed.
   */
  const spawn = (
    kind: FxKind,
    origin: readonly number[],
    axis: readonly [number, number, number],
    index: number,
    prof: FxProfile,
    seed = 0,
    vary = 0,
  ): void => {
    const ox = finite(origin[0]);
    const oy = finite(origin[1]);
    const oz = finite(origin[2]);
    const i = cursor;
    cursor = (cursor + 1) % count; // rotating pool: newest burst wins
    const d = burstDirection(axis, index, prof.spread);
    // three independent draws off the same (seed, index) pair: a puff that
    // is bigger must not also be slower and longer-lived in lockstep, or the
    // variation reads as one scale knob rather than as different puffs
    const speed = nn(prof.speed, 0) * jitterScale(seed, index * 3 + 1, vary);
    posArr[i * 3] = ox;
    posArr[i * 3 + 1] = oy;
    posArr[i * 3 + 2] = oz;
    velArr[i * 3] = d[0] * speed;
    velArr[i * 3 + 1] = d[1] * speed;
    velArr[i * 3 + 2] = d[2] * speed;
    age[i] = 0;
    // floored below zero-length: a life of 0 divides to a NaN age (§B.5)
    life[i] = Math.max(0.02, prof.life * jitterScale(seed, index * 3 + 2, vary));
    sizeScale[i] = Math.max(0.05, jitterScale(seed, index * 3 + 3, vary));
    kinds[i] = kind;
  };

  return {
    group,

    emit(frame, projectiles, tick = 0): void {
      const prof = profiles(p);
      const smokeN = sanitizeCount(p.smokePerShot, 14, 64);
      const sparkN = sanitizeCount(p.sparksPerShot, 12, 64);
      const splinterN = sanitizeCount(p.splintersPerBreach, 18, 64);
      const splashN = sanitizeCount(p.splashPerHit, 10, 64);
      const vary = nn(p.variation, 0.45);

      for (const m of frame.muzzles) {
        const axis: [number, number, number] = [
          finite(m.direction[0]), finite(m.direction[1]), finite(m.direction[2]),
        ];
        const seed = Number.isFinite(m.seed) ? m.seed : 0;
        spawn('flash', m.position, axis, 0, prof.flash, seed, vary * 0.4);
        // the smoke bank gets its OWN axis: a per-shot tilt plus a standing
        // upward bias, because powder smoke rolls up off the muzzle rather
        // than jetting flat, and because four guns on one hull otherwise
        // throw four plumes along one identical vector — which is what the
        // user actually saw ("identical across all cannons that shoot").
        const wob = vary * 0.3;
        const smokeAxis = normalized(
          axis[0] + (hash01(seed, 11) * 2 - 1) * wob,
          axis[1] + (hash01(seed, 12) * 2 - 1) * wob + nn(p.smokeRise, 0.35),
          axis[2] + (hash01(seed, 13) * 2 - 1) * wob,
        );
        for (let k = 0; k < smokeN; k++) {
          spawn('smoke', m.position, smokeAxis, k, prof.smoke, seed, vary);
        }
        // sparks last: they are the brightest thing here, and the rotating
        // pool means the newest burst survives if the pool is under pressure
        for (let k = 0; k < sparkN; k++) {
          spawn('spark', m.position, axis, k, prof.spark, seed ^ 0x5bf03635, vary);
        }
      }
      for (const e of frame.destruction) {
        if (e.type !== 'splinters') continue;
        const n = Math.min(splinterN, sanitizeCount(e.count, splinterN, 64));
        const seed = Math.round(finite(e.position[0]) * 977 + finite(e.position[1]) * 131);
        for (let k = 0; k < n; k++) {
          spawn('splinter', e.position, [0, 1, 0], k, prof.splinter, seed, vary);
        }
      }
      for (const e of frame.projectiles) {
        if (e.type !== 'splash') continue;
        for (let k = 0; k < splashN; k++) {
          spawn('splash', e.position, [0, 1, 0], k, prof.splash, e.projectileId, vary);
        }
      }

      // vapour ribbon behind each ball. Every `trailEvery` sim ticks rather
      // than every tick: at 60 Hz a per-tick ribbon eats the whole pool with
      // two guns firing, and the gap is invisible at these speeds.
      const every = Math.max(1, sanitizeCount(p.trailEvery, 2, 30));
      if (projectiles !== undefined && p.trailLife > 0) {
        for (const ball of projectiles) {
          if ((tick + ball.id) % every !== 0) continue;
          spawn('trail', ball.position, [0, 1, 0], ball.id, prof.trail, ball.id * 31 + tick, vary);
        }
      }
    },

    update(frameDt, projectiles): void {
      // a non-finite dt would drive every position to NaN in one frame; a
      // huge one (tab restored) would teleport the whole pool
      const dt = Number.isFinite(frameDt) ? Math.max(0, Math.min(frameDt, 0.25)) : 0;
      const prof = profiles(p);
      const gain = nn(p.intensity, 1);

      for (let i = 0; i < count; i++) {
        const t = ageFraction(age[i], life[i]);
        if (t >= 1) {
          sizeArr[i] = 0; // §V.28: dead is zero-SIZE, not zero-opacity
          continue;
        }
        age[i] += dt;
        const pr = prof[kinds[i]];
        const v = stepVelocity(
          velArr[i * 3], velArr[i * 3 + 1], velArr[i * 3 + 2], pr, dt,
        );
        velArr[i * 3] = v[0];
        velArr[i * 3 + 1] = v[1];
        velArr[i * 3 + 2] = v[2];
        posArr[i * 3] += v[0] * dt;
        posArr[i * 3 + 1] += v[1] * dt;
        posArr[i * 3 + 2] += v[2] * dt;

        const next = ageFraction(age[i], life[i]);
        const b = brightnessAt(next) * gain;
        sizeArr[i] = sizeAt(pr, next) * sizeScale[i];
        colArr[i * 3] = pr.color[0] * b;
        colArr[i * 3 + 1] = pr.color[1] * b;
        colArr[i * 3 + 2] = pr.color[2] * b;
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;

      const r = Math.max(1e-3, nn(p.ballDrawRadius, 0.16));
      // motion stretch. A 0.32 m dark sphere at 60 m/s covers 1 m per frame
      // and reads as a flicker; stretching it ALONG its own velocity is the
      // same trick a camera's shutter plays, costs one quaternion per ball,
      // and keeps it a cannonball rather than a glowing tracer.
      const stretchGain = Math.max(0, nn(p.ballStretch, 0.05));
      const stretchMax = Math.max(1, nn(p.ballStretchMax, 9));
      let n = 0;
      for (const proj of projectiles) {
        if (n >= ballMax) break;
        const [x, y, z] = proj.position;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        const [vx, vy, vz] = proj.velocity;
        const speed = Math.hypot(finite(vx), finite(vy), finite(vz));
        let stretch = 1;
        if (speed > 1e-3 && stretchGain > 0) {
          // §V.28: bounded at source, not clamped after — the product of two
          // caller-fed numbers is not bounded just because one of them is
          stretch = Math.min(stretchMax, 1 + speed * stretchGain);
          ballAxis.set(vx / speed, vy / speed, vz / speed);
          ballQuat.setFromUnitVectors(BALL_UP, ballAxis);
        } else {
          ballQuat.identity();
        }
        ballPos.set(x, y, z);
        ballScale.set(r, r * stretch, r);
        ballMatrix.compose(ballPos, ballQuat, ballScale);
        balls.setMatrixAt(n++, ballMatrix);
      }
      balls.count = n;
      balls.instanceMatrix.needsUpdate = true;
    },

    dispose(): void {
      material.dispose();
      ballMat.dispose();
      ballGeo.dispose();
    },
  };
}

/** dispatch/buffer sizes come from sanitized construction-time ints (§V.28) */
function sanitizeCount(v: number, fallback: number, max: number): number {
  const n = Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.max(0, Math.min(n, max));
}

function pos(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function nn(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

/** unit vector with a floored divisor — a zero axis would burst to NaN */
function normalized(x: number, y: number, z: number): [number, number, number] {
  const fx = finite(x);
  const fy = finite(y);
  const fz = finite(z);
  const len = Math.hypot(fx, fy, fz);
  if (len < 1e-6) return [0, 1, 0];
  return [fx / len, fy / len, fz / len];
}
