/**
 * Combat fx (§T.16 muzzle fx, §V.14 impact + splinter burst) — the visible
 * half of the chain: gun flash and powder smoke, the strike where a ball
 * finds oak, the pillar where one pitches into the sea, and the shot itself
 * in flight.
 *
 * ── WHAT WAS ACTUALLY WRONG, AND IT WAS NOT SUBTLE ─────────────────────
 * `emit` read `frame.muzzles`, `frame.destruction` and `frame.projectiles`
 * and NEVER READ `frame.hits`. The hit list — every cannonball that struck a
 * hull — reached exactly one consumer repo-wide, `audio.event('ballHit')`.
 * So a hit made a SOUND AND NO PICTURE, which is verbatim what the user
 * reported ("I just see a very weak impact sound and that's it" / "there's
 * like no visual effect of an impact whatsoever").
 *
 * The one visual that did exist was the splinter burst, and it hung off
 * `destruction`'s `splinters` event, which `ship/destruction.ts` fires
 * EXACTLY ONCE per piece, on the frame its hp crosses `holedThreshold`. At
 * hitDamage 0.25 / threshold 0.5 that is hit 2 of 4, and after hit 4 the
 * piece is at 0 hp and never emits again. ONE HIT IN FOUR drew anything, and
 * then nothing ever again — which is why it read as random rather than as
 * absent.
 *
 * The cure is to draw off `hits` (every hit, always) and let the breach
 * ESCALATE that with extra splinters, rather than gate it. destruction.ts's
 * exactly-once contract is deliberate and unit-tested (tests/destruction.ts)
 * and is left exactly as it was.
 *
 * ── WHY THESE ARE CPU SPRITES AND MUST STAY THAT WAY ───────────────────
 * §C sends HEAVY sims to compute passes; this is a few hundred short-lived
 * sprites driven by DISCRETE EVENTS. A compute pass buys nothing and drags in
 * the whole compute→render storage-buffer hazard that cost this project §B.8
 * (a `.toReadOnly()` on the write side silently downgrading the binding, no
 * error, no NaN, buffers stuck at zero — it froze the entire spray pool for
 * multiple sessions and made the rigging invisible on top of it).
 *
 * DO NOT "unify" this with src/foam/spray.ts. That pool is GPU compute with a
 * crest-LOTTERY spawn and no event-injection API at all; adding one is how
 * you walk back into §B.8. Two systems, on purpose: spray answers a field,
 * this answers events.
 *
 * §V.28 throughout: pool sizes are sanitized ints fixed at construction,
 * every caller-fed value is finite-guarded at the spawn boundary, every
 * divisor is floored (fxMath), and dead particles are written at EXACTLY
 * zero size rather than zero opacity — §B.5 was NaN-sized additive quads
 * that read as a browser hang, and invisible-but-rasterized quads are the
 * same fill-rate bill for nothing.
 * §V.44: the additive brightness bound lives in `FxProfile.boost`, applied at
 * the source rather than clamped downstream.
 * §V.3: reads a CombatFrame and SimState.projectiles, writes neither.
 */
import * as THREE from 'three/webgpu';
import { instancedBufferAttribute, uniform, uv, vec2 } from 'three/tsl';
import type { ProjectileState, ShipState } from '../state/simState';
import { combatFxParams, type CombatFxParams } from '../params/combat';
import type { CombatFrame } from './combatSystem';
import { createFlashLight, type FlashLight } from './flashLight';
import { createImpactRings, type ImpactRings } from './impactRing';
import { createProfiles, fillProfiles } from './fxProfiles';
import { tornAlpha } from './smokeShape';
import { createCameraShake, type CameraShake } from './cameraShake';
import { combatParams, combatShakeParams } from '../params/combat';
import {
  ageFraction,
  brightnessAt,
  burstDirection,
  jitterScale,
  hash01,
  particleAspect,
  particleSpin,
  sizeAt,
  stepVelocity,
  type FxKind,
  type FxProfile,
} from './fxMath';

/** kinds that take the torn contour and the aspect stretch (§V.65) */
const SMOKE_KINDS: ReadonlySet<FxKind> = new Set<FxKind>([
  'smoke', 'impactSmoke', 'breech',
]);

export interface CombatFx {
  /** add to the scene once — sprites, cannonballs and surface rings */
  group: THREE.Object3D;
  /**
   * The flash PointLight. ADD IT AT BOOT, SEPARATELY FROM `group`, and never
   * remove it — see flashLight.ts. It is not in `group` precisely because
   * `group` is deferred by §T.40's warm-up, and adding a light after the
   * first frame recompiles every material in the scene including the ocean.
   */
  light: THREE.PointLight;
  /**
   * Queue this sim tick's events (call once per tick). `projectiles` are the
   * balls still in the air: each lays a short vapour ribbon, because a
   * 0.3 m dark sphere at 60 m/s is genuinely hard to follow and real footage
   * reads the trail, not the shot. `ships` lets an impact spray its debris
   * back along the hull's outward normal instead of straight up.
   */
  emit(
    frame: CombatFrame,
    projectiles?: readonly ProjectileState[],
    tick?: number,
    ships?: readonly ShipState[],
  ): void;
  /** advance particles and refresh buffers (call once per rendered frame) */
  update(
    frameDt: number,
    projectiles: readonly ProjectileState[],
    seaHeightAt?: (x: number, z: number) => number,
    /**
     * LIVE wind velocity (m/s) in world XZ — `state.wind`, the same air the
     * sails, flags, AI and spray answer to, NOT `oceanParams.windDirection`.
     * Weather transitions write `state.wind` every tick while the ocean param
     * is the spectrum's own default, so reading the param would drift the
     * smoke against the flags the player is looking at.
     */
    windX?: number,
    windZ?: number,
  ): void;
  /** the camera shake driven by this frame's guns and hits */
  shake: CameraShake;
  dispose(): void;
}

/** the sphere's own long axis — what the stretch aligns with the velocity */
const BALL_UP = /*@__PURE__*/ new THREE.Vector3(0, 1, 0);
const FLAT_SEA = (): number => 0;

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

  /**
   * SILHOUETTE attributes (§V.65). `aspect` stretches the sprite and `seed`
   * both rolls it and decorrelates its tear. Deliberately SEPARATE from
   * `sizeArr` rather than widening it to a vec2: the size buffer's "0 = dead"
   * contract is read by tests and by §V.28, and it stays exactly one float
   * per particle meaning exactly what it did.
   */
  const aspectArr = new Float32Array(count).fill(1);
  const seedArr = new Float32Array(count);
  /** per-particle tear strength — 0 for every kind that is not smoke */
  const tearArr = new Float32Array(count);

  const posAttr = new THREE.InstancedBufferAttribute(posArr, 3);
  const colAttr = new THREE.InstancedBufferAttribute(colArr, 3);
  const sizeAttr = new THREE.InstancedBufferAttribute(sizeArr, 1);
  const aspectAttr = new THREE.InstancedBufferAttribute(aspectArr, 1);
  const seedAttr = new THREE.InstancedBufferAttribute(seedArr, 1);
  const tearAttr = new THREE.InstancedBufferAttribute(tearArr, 1);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  sizeAttr.setUsage(THREE.DynamicDrawUsage);
  aspectAttr.setUsage(THREE.DynamicDrawUsage);
  seedAttr.setUsage(THREE.DynamicDrawUsage);
  tearAttr.setUsage(THREE.DynamicDrawUsage);

  /** live look knobs that must reach the shader without a rebuild (§V.62) */
  const uDissolveScale = uniform(nn(p.smokeDissolveScale, 2.6));

  const material = new THREE.SpriteNodeMaterial();
  material.positionNode = instancedBufferAttribute(posAttr, 'vec3');

  const sizeNode = instancedBufferAttribute(sizeAttr, 'float');
  const aspectNode = instancedBufferAttribute(aspectAttr, 'float');
  const seedNode = instancedBufferAttribute(seedAttr, 'float');
  const tearNode = instancedBufferAttribute(tearAttr, 'float');

  // NON-UNIFORM SCALE + ROLL — the free half of the silhouette fix. A
  // uniformly-scaled sprite is a disc by construction; a cluster of ellipses
  // at differing angles is not, at any radius, and the cost is nil because it
  // is all in the vertex stage. AREA-PRESERVING: (s·a)·(s/a) = s², so a
  // stretched puff carries the same mass as a round one. `aspect` is bounded
  // to [0.5, 2] at spawn, which floors the `s/a` divisor AT SOURCE (§V.28).
  material.scaleNode = vec2(sizeNode.mul(aspectNode), sizeNode.div(aspectNode));
  material.rotationNode = seedNode.mul(Math.PI * 2);

  const tint = instancedBufferAttribute(colAttr, 'vec3');
  // soft round falloff; additive, so brightness IS the fade and a dead
  // particle is already zero-size before it can contribute anything
  const q = uv().mul(2).sub(1);
  const shape = q.dot(q).oneMinus().max(0).pow(1.5);
  material.colorNode = tint;
  // the torn contour rides on top of that disc; `tearNode` is 0 for every
  // non-smoke kind, which leaves `shape` mathematically untouched for them
  material.opacityNode = tornAlpha(shape, uv(), tearNode, seedNode, uDissolveScale);
  material.transparent = true;
  material.blending = THREE.AdditiveBlending;
  material.depthWrite = false;
  material.fog = false;

  const sprites = new THREE.Sprite(material as unknown as THREE.SpriteMaterial);
  sprites.name = 'combat-sprites';
  /**
   * The pool's raw buffers, published for tests and the dev console.
   *
   * Tests used to read `material.scaleNode.value.array`, which only worked
   * while `scaleNode` happened to BE the size attribute; it now composes size
   * with the aspect stretch, and that lookup silently stopped resolving. A
   * test reaching through a node graph is a test that breaks on any shading
   * change and tells you nothing about the thing it meant to assert, so the
   * contract is stated here instead.
   */
  sprites.userData.fxPool = {
    position: posArr,
    color: colArr,
    size: sizeArr,
    aspect: aspectArr,
    seed: seedArr,
    tear: tearArr,
    kinds,
  };
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
  balls.name = 'combat-cannonballs';
  balls.count = 0;
  balls.frustumCulled = false;
  balls.castShadow = true;
  const ballMatrix = new THREE.Matrix4();
  const ballPos = new THREE.Vector3();
  const ballQuat = new THREE.Quaternion();
  const ballScale = new THREE.Vector3();
  const ballAxis = new THREE.Vector3();

  const rings: ImpactRings = createImpactRings(p);
  const flash: FlashLight = createFlashLight(p);
  const shake: CameraShake = createCameraShake();

  const group = new THREE.Group();
  group.name = 'combat-fx';
  // ORDER MATTERS to tests/combatWiring's instanced-mesh lookup: the balls
  // must be reachable by their own name, which they now are (both this and
  // the rings are InstancedMeshes).
  group.add(sprites, balls, rings.mesh);

  /** refilled in place each frame so a Tweakpane edit is live, without churn */
  const prof = createProfiles();
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
    profile: FxProfile,
    seed = 0,
    vary = 0,
  ): void => {
    if (count === 0) return;
    const ox = finite(origin[0]);
    const oy = finite(origin[1]);
    const oz = finite(origin[2]);
    const i = cursor;
    cursor = (cursor + 1) % count; // rotating pool: newest burst wins
    const d = burstDirection(axis, index, profile.spread);
    // three independent draws off the same (seed, index) pair: a puff that
    // is bigger must not also be slower and longer-lived in lockstep, or the
    // variation reads as one scale knob rather than as different puffs
    const speed = nn(profile.speed, 0) * jitterScale(seed, index * 3 + 1, vary);
    posArr[i * 3] = ox;
    posArr[i * 3 + 1] = oy;
    posArr[i * 3 + 2] = oz;
    velArr[i * 3] = d[0] * speed;
    velArr[i * 3 + 1] = d[1] * speed;
    velArr[i * 3 + 2] = d[2] * speed;
    age[i] = 0;
    // floored below zero-length: a life of 0 divides to a NaN age (§B.5)
    life[i] = Math.max(0.02, profile.life * jitterScale(seed, index * 3 + 2, vary));
    sizeScale[i] = Math.max(0.05, jitterScale(seed, index * 3 + 3, vary));
    kinds[i] = kind;

    // §V.65 silhouette: only the smoke family is stretched and torn. Sparks
    // and splinters are meant to read as points and streaks, and an elliptical
    // spark is just a wrong-shaped spark.
    const smoky = SMOKE_KINDS.has(kind);
    aspectArr[i] = smoky ? particleAspect(seed, index, nn(p.smokeAspect, 0.75)) : 1;
    seedArr[i] = smoky ? particleSpin(seed, index) / (Math.PI * 2) : 0;
    tearArr[i] = smoky ? clamp01(nn(p.smokeDissolve, 0.55)) : 0;
  };

  return {
    group,
    light: flash.light,
    shake,

    emit(frame, projectiles, tick = 0, ships): void {
      fillProfiles(prof, p);
      const smokeN = sanitizeCount(p.smokePerShot, 14, 64);
      const sparkN = sanitizeCount(p.sparksPerShot, 12, 64);
      const splinterN = sanitizeCount(p.splintersPerBreach, 18, 64);
      const splashN = sanitizeCount(p.splashPerHit, 10, 64);
      const impactSmokeN = sanitizeCount(p.impactSmokePerHit, 10, 64);
      const debrisN = sanitizeCount(p.debrisPerHit, 12, 64);
      const columnN = sanitizeCount(p.columnPerHit, 12, 64);
      const breechN = sanitizeCount(p.breechPerShot, 6, 64);
      const vary = nn(p.variation, 0.45);

      for (const m of frame.muzzles) {
        const axis: [number, number, number] = [
          finite(m.direction[0]), finite(m.direction[1]), finite(m.direction[2]),
        ];
        const seed = Number.isFinite(m.seed) ? m.seed : 0;
        spawn('flash', m.position, axis, 0, prof.flash, seed, vary * 0.4);
        flash.strike(m.position[0], m.position[1], m.position[2], 1);
        shake.impulse(
          m.position[0], m.position[1], m.position[2],
          nn(combatShakeParams.firingStrength, 0.7),
        );
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
        // THE BREECH VENT. A muzzle-loader fires from both ends, and the vent
        // puff is the tell that separates a cannon from a firework.
        //
        // Its position is DERIVED, never authored: `muzzleForward` is the one
        // owner of mount → muzzle along the barrel, so walking back along the
        // firing direction by exactly that distance lands on the gun's own
        // mount socket. Two independent literals for the two ends of one gun
        // is the bug that put a lantern beside a post it did not reach and
        // the sail seams out of step with their robands — move the gun and
        // this follows it, with nothing to keep in sync.
        const back = Math.max(0, nn(combatParams.muzzleForward, 1.4));
        const breechPos: [number, number, number] = [
          m.position[0] - axis[0] * back,
          m.position[1] - axis[1] * back,
          m.position[2] - axis[2] * back,
        ];
        // the vent jets UP off the breech, not outboard: `breechUp` 1 is
        // straight up, 0 is back along the barrel
        const up = clamp01(nn(p.breechUp, 0.8));
        const breechAxis = normalized(
          -axis[0] * (1 - up),
          (1 - up) * -axis[1] + up,
          -axis[2] * (1 - up),
        );
        for (let k = 0; k < breechN; k++) {
          spawn('breech', breechPos, breechAxis, k, prof.breech, seed ^ 0x2f9a1b73, vary);
        }
        // sparks last: they are the brightest thing here, and the rotating
        // pool means the newest burst survives if the pool is under pressure
        for (let k = 0; k < sparkN; k++) {
          spawn('spark', m.position, axis, k, prof.spark, seed ^ 0x5bf03635, vary);
        }
      }

      // THE HIT ITSELF — every hit, not one in four. Flash, debris and a
      // lingering puff, in that order of lifetime: ~70 ms, ~1 s, ~3.4 s. The
      // SPREAD of those three timescales is most of what makes a strike read
      // as a strike; matching them would read as one puff.
      for (let h = 0; h < frame.hits.length; h++) {
        const hit = frame.hits[h];
        // ships' own outward normal, approximated as the ray from her centre
        // through the impact point: debris off a hull sprays back the way the
        // ball came, and a hard-coded [0,1,0] fountains it out of the deck.
        const axis = outwardAxis(ships?.[hit.shipIndex], hit.point);
        const seed = (Math.imul(hit.projectileId, 2654435761) + h * 40503) >>> 0;
        spawn('impactFlash', hit.point, axis, 0, prof.impactFlash, seed, vary * 0.4);
        flash.strike(hit.point[0], hit.point[1], hit.point[2], 0.85);
        // a hit on OUR hull is the one that should be felt hardest; a hit on
        // anyone else still carries, scaled down and then by distance, so a
        // strike on the enemy at 200 m is a tremor rather than silence
        shake.impulse(
          hit.point[0], hit.point[1], hit.point[2],
          nn(hit.shipIndex === 0
            ? combatShakeParams.ownHitStrength
            : combatShakeParams.otherHitStrength, 0.55),
        );
        for (let k = 0; k < debrisN; k++) {
          spawn('splinter', hit.point, axis, k, prof.splinter, seed, vary);
        }
        for (let k = 0; k < impactSmokeN; k++) {
          spawn('impactSmoke', hit.point, axis, k, prof.impactSmoke, seed, vary);
        }
      }

      // a BREACH escalates the hit above — it does not gate it. This is the
      // extra timber let go when a section finally stoves in, on top of the
      // debris that hit already threw.
      for (const e of frame.destruction) {
        if (e.type !== 'splinters') continue;
        const n = Math.min(splinterN, sanitizeCount(e.count, splinterN, 64));
        const seed = Math.round(finite(e.position[0]) * 977 + finite(e.position[1]) * 131);
        for (let k = 0; k < n; k++) {
          spawn('splinter', e.position, [0, 1, 0], k, prof.splinter, seed, vary);
        }
      }

      // WATER ENTRY: a pillar going up, droplets off it, and a ring left on
      // the surface. The column's spread is 0.12 against the droplets' 0.5 —
      // that difference is what makes one a COLUMN and the other a splash.
      for (const e of frame.projectiles) {
        if (e.type !== 'splash') continue;
        for (let k = 0; k < columnN; k++) {
          spawn('column', e.position, [0, 1, 0], k, prof.column, e.projectileId, vary);
        }
        for (let k = 0; k < splashN; k++) {
          spawn('splash', e.position, [0, 1, 0], k, prof.splash, e.projectileId, vary);
        }
        rings.spawn(e.position[0], e.position[1], e.position[2]);
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

    update(frameDt, projectiles, seaHeightAt = FLAT_SEA, windX = 0, windZ = 0): void {
      // a non-finite dt would drive every position to NaN in one frame; a
      // huge one (tab restored) would teleport the whole pool
      const dt = Number.isFinite(frameDt) ? Math.max(0, Math.min(frameDt, 0.25)) : 0;
      fillProfiles(prof, p);
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
          velArr[i * 3], velArr[i * 3 + 1], velArr[i * 3 + 2], pr, dt, windX, windZ,
        );
        velArr[i * 3] = v[0];
        velArr[i * 3 + 1] = v[1];
        velArr[i * 3 + 2] = v[2];
        posArr[i * 3] += v[0] * dt;
        posArr[i * 3 + 1] += v[1] * dt;
        posArr[i * 3 + 2] += v[2] * dt;

        const next = ageFraction(age[i], life[i]);
        // §V.44: every factor is bounded at source — brightnessAt ∈ [0,1],
        // boost ≤ BOOST_MAX, colour ∈ [0,1] — so the product is too
        const b = brightnessAt(next) * gain * pr.boost;
        sizeArr[i] = sizeAt(pr, next) * sizeScale[i];
        colArr[i * 3] = pr.color[0] * b;
        colArr[i * 3 + 1] = pr.color[1] * b;
        colArr[i * 3 + 2] = pr.color[2] * b;
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      aspectAttr.needsUpdate = true;
      seedAttr.needsUpdate = true;
      tearAttr.needsUpdate = true;
      uDissolveScale.value = Math.max(0.01, nn(p.smokeDissolveScale, 2.6));

      rings.update(dt, seaHeightAt);
      flash.update(dt);

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
      rings.dispose();
      flash.dispose();
      shake.dispose();
    },
  };
}

/**
 * Outward direction at an impact point: from the ship's centre through the
 * point. A hull hit therefore throws its debris back OUT of the side rather
 * than up out of the deck, which is what a fixed [0,1,0] axis did. Falls back
 * to straight up when the ship is unknown or the point is degenerate.
 */
function outwardAxis(
  ship: ShipState | undefined,
  point: readonly number[],
): [number, number, number] {
  if (ship === undefined) return [0, 1, 0];
  return normalized(
    finite(point[0]) - finite(ship.position[0]),
    // the vertical share is damped: a hull's normal is mostly lateral, and
    // an undamped one at deck level would fountain debris straight up again
    (finite(point[1]) - finite(ship.position[1])) * 0.35 + 0.25,
    finite(point[2]) - finite(ship.position[2]),
  );
}

/** dispatch/buffer sizes come from sanitized construction-time ints (§V.28) */
function sanitizeCount(v: number, fallback: number, max: number): number {
  const n = Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.max(0, Math.min(n, max));
}

function nn(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
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
