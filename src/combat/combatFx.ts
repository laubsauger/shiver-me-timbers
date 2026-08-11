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
  sizeAt,
  stepVelocity,
  type FxKind,
  type FxProfile,
} from './fxMath';

/** §V.31: sRGB-authored tints enter through THREE.Color, never bare setRGB */
const TINTS: Record<FxKind, THREE.Color> = {
  flash: new THREE.Color(0xffd08a),
  smoke: new THREE.Color(0x9a958c),
  splinter: new THREE.Color(0xa97c4e),
  splash: new THREE.Color(0xcfe6e2),
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
  /** queue this sim tick's events (call once per tick) */
  emit(frame: CombatFrame): void;
  /** advance particles and refresh buffers (call once per rendered frame) */
  update(frameDt: number, projectiles: readonly ProjectileState[]): void;
  dispose(): void;
}

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
  const kinds = new Array<FxKind>(count).fill('smoke');
  life.fill(1);
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

  const group = new THREE.Group();
  group.name = 'combat-fx';
  group.add(sprites, balls);

  let cursor = 0;

  const spawn = (
    kind: FxKind,
    origin: readonly number[],
    axis: readonly [number, number, number],
    index: number,
    prof: FxProfile,
  ): void => {
    const ox = finite(origin[0]);
    const oy = finite(origin[1]);
    const oz = finite(origin[2]);
    const i = cursor;
    cursor = (cursor + 1) % count; // rotating pool: newest burst wins
    const d = burstDirection(axis, index, prof.spread);
    const speed = nn(prof.speed, 0);
    posArr[i * 3] = ox;
    posArr[i * 3 + 1] = oy;
    posArr[i * 3 + 2] = oz;
    velArr[i * 3] = d[0] * speed;
    velArr[i * 3 + 1] = d[1] * speed;
    velArr[i * 3 + 2] = d[2] * speed;
    age[i] = 0;
    life[i] = prof.life;
    kinds[i] = kind;
  };

  return {
    group,

    emit(frame): void {
      const prof = profiles(p);
      const smokeN = sanitizeCount(p.smokePerShot, 14, 64);
      const splinterN = sanitizeCount(p.splintersPerBreach, 18, 64);
      const splashN = sanitizeCount(p.splashPerHit, 10, 64);

      for (const m of frame.muzzles) {
        const axis: [number, number, number] = [
          finite(m.direction[0]), finite(m.direction[1]), finite(m.direction[2]),
        ];
        spawn('flash', m.position, axis, 0, prof.flash);
        for (let k = 0; k < smokeN; k++) spawn('smoke', m.position, axis, k, prof.smoke);
      }
      for (const e of frame.destruction) {
        if (e.type !== 'splinters') continue;
        const n = Math.min(splinterN, sanitizeCount(e.count, splinterN, 64));
        for (let k = 0; k < n; k++) {
          spawn('splinter', e.position, [0, 1, 0], k, prof.splinter);
        }
      }
      for (const e of frame.projectiles) {
        if (e.type !== 'splash') continue;
        for (let k = 0; k < splashN; k++) {
          spawn('splash', e.position, [0, 1, 0], k, prof.splash);
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
        sizeArr[i] = sizeAt(pr, next);
        colArr[i * 3] = pr.color[0] * b;
        colArr[i * 3 + 1] = pr.color[1] * b;
        colArr[i * 3 + 2] = pr.color[2] * b;
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;

      const r = Math.max(1e-3, nn(p.ballDrawRadius, 0.16));
      ballScale.set(r, r, r);
      let n = 0;
      for (const proj of projectiles) {
        if (n >= ballMax) break;
        const [x, y, z] = proj.position;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        ballPos.set(x, y, z);
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
