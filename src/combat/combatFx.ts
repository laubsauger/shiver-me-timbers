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
import { createDebris, type DebrisChunks } from './debris';
import { createProfiles, fillProfiles } from './fxProfiles';
import { tornAlpha } from './smokeShape';
import { createCameraShake, type CameraShake } from './cameraShake';
import { combatParams, combatShakeParams } from '../params/combat';
import {
  ageFraction,
  brightnessAt,
  burstDirection,
  crownDirection,
  jitterScale,
  hash01,
  particleAspect,
  particleSpin,
  sizeAt,
  splinterAspect,
  splinterTumble,
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
  /**
   * Per-particle ROLL RATE, turns/s — nonzero for splinters and nothing else.
   *
   * A separate array rather than a derivation, because `update` no longer has
   * the (seed, index) pair the particle was born from and re-deriving it would
   * mean storing that instead. It is 6 KB for the whole pool and it never
   * reaches the GPU: `seedArr` is the attribute, this is only what advances it.
   */
  const spinArr = new Float32Array(count);
  /**
   * Per-particle OPACITY WEIGHT (§V.44-adjacent, and see the blend note on the
   * material below). 0 = pure additive light, 1 = opaque. Powder smoke, flash
   * and sparks stay at 0; the three water kinds do not.
   */
  const alphaArr = new Float32Array(count);

  const posAttr = new THREE.InstancedBufferAttribute(posArr, 3);
  const colAttr = new THREE.InstancedBufferAttribute(colArr, 3);
  const sizeAttr = new THREE.InstancedBufferAttribute(sizeArr, 1);
  const aspectAttr = new THREE.InstancedBufferAttribute(aspectArr, 1);
  const seedAttr = new THREE.InstancedBufferAttribute(seedArr, 1);
  const tearAttr = new THREE.InstancedBufferAttribute(tearArr, 1);
  const alphaAttr = new THREE.InstancedBufferAttribute(alphaArr, 1);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
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
  const alphaNode = instancedBufferAttribute(alphaAttr, 'float');

  // NON-UNIFORM SCALE + ROLL — the free half of the silhouette fix. A
  // uniformly-scaled sprite is a disc by construction; a cluster of ellipses
  // at differing angles is not, at any radius, and the cost is nil because it
  // is all in the vertex stage. AREA-PRESERVING: (s·a)·(s/a) = s², so a
  // stretched puff carries the same mass as a round one. `aspect` is bounded
  // to [0.5, 2] at spawn, which floors the `s/a` divisor AT SOURCE (§V.28).
  material.scaleNode = vec2(sizeNode.mul(aspectNode), sizeNode.div(aspectNode));
  material.rotationNode = seedNode.mul(Math.PI * 2);

  const tint = instancedBufferAttribute(colAttr, 'vec3');
  // soft round falloff; brightness IS the fade and a dead particle is already
  // zero-size before it can contribute anything
  const q = uv().mul(2).sub(1);
  const shape = q.dot(q).oneMinus().max(0).pow(1.5);
  // the torn contour rides on top of that disc; `tearNode` is 0 for every
  // non-smoke kind, which leaves `shape` mathematically untouched for them
  const cover = tornAlpha(shape, uv(), tearNode, seedNode, uDissolveScale);

  /**
   * ── ONE POOL, TWO BLEND MODELS, ONE DRAW CALL ─────────────────────────
   *
   * Powder smoke, muzzle flash and sparks are LIGHT: additive is the correct
   * model and it is what they had. Aerated water is a SUBSTANCE: additive can
   * only ever brighten what is behind it, so an additive column reads as a
   * glow latched onto the sea and vanishes outright against a bright sky —
   * which is exactly the angle a splash is seen from on a deck, and verbatim
   * what the user reported ("latched on top… don't look like they interact").
   *
   * The frame is CPU-BOUND at ~595 draws, so a second sprite pool with its own
   * material to hold the water kinds is the wrong currency to spend. Instead
   * both models are expressed in ONE blend function by writing the source
   * colour ALREADY MULTIPLIED by its own coverage and letting `alphaNode`
   * choose how much of the destination survives:
   *
   *     out = tint·cover + dst·(1 − cover·alpha)
   *
   *   alpha = 0  →  out = tint·cover + dst          — EXACTLY three's
   *                 AdditiveBlending (SrcAlpha, One) with colorNode = tint and
   *                 opacityNode = cover. Every pre-existing kind is unchanged,
   *                 not merely equivalent.
   *   alpha = 1  →  out = tint·cover + dst·(1−cover) — a correct source-over
   *                 composite of opaque water on the sea behind it.
   *
   * `premultipliedAlpha` stays FALSE and the premultiply is done here in the
   * node graph on purpose: three's flag multiplies rgb by alpha unconditionally,
   * which would zero every additive kind (alpha 0) and delete the smoke.
   */
  material.colorNode = tint.mul(cover);
  material.opacityNode = cover.mul(alphaNode);
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  material.premultipliedAlpha = false;
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
    alpha: alphaArr,
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
  /**
   * Solid debris. Its splash callback is bound to `rings.spawn` below, in
   * `update` — a chunk landing in the sea gets the SAME ring and foam scar a
   * cannonball does, off the same mesh, for no new draw call (376d02d). A
   * second splash path for the second thing that can hit the water is exactly
   * the duplication impactRing.ts's header argues against.
   */
  const debris: DebrisChunks = createDebris({
    count: sanitizeCount(p.chunkCount, 40, 256),
    life: nn(p.chunkLife, 6),
    floatLife: nn(p.chunkFloatLife, 3),
    speed: nn(p.chunkSpeed, 7),
    spread: nn(p.chunkSpread, 0.55),
    size: nn(p.chunkSize, 0.8),
    spin: nn(p.chunkSpin, 6),
    gravity: nn(combatParams.gravity, 9.81),
  });

  const group = new THREE.Group();
  group.name = 'combat-fx';
  // ORDER MATTERS to tests/combatWiring's instanced-mesh lookup: the balls
  // must be reachable by their own name, which they now are (both this and
  // the rings are InstancedMeshes).
  group.add(sprites, balls, rings.mesh, debris.mesh);

  /** refilled in place each frame so a Tweakpane edit is live, without churn */
  const prof = createProfiles();
  let cursor = 0;
  /**
   * Seconds of particle life still unspent, i.e. an upper bound on how long
   * the pool can still contain anything alive. `spawn` raises it, `update`
   * counts it down. Zero means every slot is provably dead, which is the one
   * condition under which skipping the walk cannot change a pixel.
   */
  let liveFor = 0;

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
    /**
     * ENERGY of the event, 1 = the authored burst (§V.66). Multiplies launch
     * speed and sprite size together, because a bigger splash is a faster one:
     * splitting them into two knobs is how you get a slow balloon. `dir`
     * overrides the cone entirely — the crown is a sheet, not a cone, and its
     * directions come from `crownDirection`.
     */
    scale = 1,
    dir?: readonly [number, number, number],
  ): void => {
    if (count === 0) return;
    const ox = finite(origin[0]);
    const oy = finite(origin[1]);
    const oz = finite(origin[2]);
    const i = cursor;
    cursor = (cursor + 1) % count; // rotating pool: newest burst wins
    const d = dir ?? burstDirection(axis, index, profile.spread);
    const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
    // three independent draws off the same (seed, index) pair: a puff that
    // is bigger must not also be slower and longer-lived in lockstep, or the
    // variation reads as one scale knob rather than as different puffs
    const speed = nn(profile.speed, 0) * jitterScale(seed, index * 3 + 1, vary) * s;
    posArr[i * 3] = ox;
    posArr[i * 3 + 1] = oy;
    posArr[i * 3 + 2] = oz;
    velArr[i * 3] = d[0] * speed;
    velArr[i * 3 + 1] = d[1] * speed;
    velArr[i * 3 + 2] = d[2] * speed;
    age[i] = 0;
    // floored below zero-length: a life of 0 divides to a NaN age (§B.5)
    life[i] = Math.max(0.02, profile.life * jitterScale(seed, index * 3 + 2, vary));
    sizeScale[i] = Math.max(0.05, jitterScale(seed, index * 3 + 3, vary) * s);
    kinds[i] = kind;
    // §V.28: bounded at the spawn boundary, where it can be tested
    alphaArr[i] = clamp01(nn(profile.alpha, 0));

    // §V.65 silhouette. THREE families, not two, and the middle one is what
    // was missing: smoke is stretched-and-torn, a SPLINTER is stretched hard
    // and tumbles but is never torn (a shard has a solid outline — that is the
    // whole point of it), and everything else stays a round point of light.
    //
    // The tear stays off for splinters deliberately: `tornAlpha` is the only
    // per-fragment cost in this system, and chewing holes in a sliver that is
    // already ~1.5 px wide at combat range would spend fill rate to delete it.
    const smoky = SMOKE_KINDS.has(kind);
    const shard = kind === 'splinter';
    aspectArr[i] = smoky
      ? particleAspect(seed, index, nn(p.smokeAspect, 0.75))
      : shard
        ? splinterAspect(seed, index, nn(p.splinterAspect, 4.5))
        : 1;
    // `seedArr` is the sprite's ROLL, in turns (the material multiplies by 2π).
    // For a shard it is an initial angle that `update` then advances; for smoke
    // it is a fixed roll that also decorrelates the tear.
    seedArr[i] = smoky || shard ? particleSpin(seed, index) / (Math.PI * 2) : 0;
    tearArr[i] = smoky ? clamp01(nn(p.smokeDissolve, 0.55)) : 0;
    // turns/s, signed. Zero for every kind but the shard, so the tumble branch
    // in `update` is provably a no-op for everything that existed before.
    spinArr[i] = shard
      ? splinterTumble(seed, index, nn(p.splinterSpin, 7)) / (Math.PI * 2)
      : 0;
    // §V.79 idle skip: the longest life still unspent in the pool. `update`
    // counts it down and skips the whole 1536-slot walk (and its seven buffer
    // uploads, ~68 KB/frame) once it reaches zero. Taking the MAX rather than
    // tracking a live count is exact and costs one compare per spawn: every
    // particle's death is known the moment it is born, so the pool is provably
    // empty once the longest of them has run out.
    if (life[i] > liveFor) liveFor = life[i];
    // aspect/tear are written HERE and nowhere else, so they are uploaded here
    // and nowhere else. They used to be re-flagged every frame in `update`,
    // re-uploading 18 KB of bytes that had not changed.
    //
    // `seed` is the exception SINCE THE TUMBLE: a shard's roll advances every
    // frame, so `update` re-uploads it — but ONLY on frames where a shard is
    // actually alive, and never at all in a fight with `splinterSpin` at 0.
    // That is 6 KB on frames that already carry 68 KB of particle motion.
    aspectAttr.needsUpdate = true;
    seedAttr.needsUpdate = true;
    tearAttr.needsUpdate = true;
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
      const momentum = Math.max(0, nn(p.splinterMomentum, 0.85));

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
        // what has MASS leans downrange; the flash and the powder smoke stay
        // on the surface normal, which is where they physically belong
        const throwAxis = ejectaAxis(axis, hit.direction, momentum);
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
          spawn('splinter', hit.point, throwAxis, k, prof.splinter, seed, vary);
        }
        for (let k = 0; k < impactSmokeN; k++) {
          spawn('impactSmoke', hit.point, axis, k, prof.impactSmoke, seed, vary);
        }
        // and the pieces that are actually going to LAND. Two, not twelve:
        // these are chunks of the ship, and a hull that sheds a dozen planks
        // per ball reads as papier-mache.
        debris.spawn(hit.point, throwAxis, sanitizeCount(p.chunkPerHit, 2, 16), seed);
      }

      // a BREACH escalates the hit above — it does not gate it. This is the
      // extra timber let go when a section finally stoves in, on top of the
      // debris that hit already threw.
      for (const e of frame.destruction) {
        if (e.type !== 'splinters') continue;
        const n = Math.min(splinterN, sanitizeCount(e.count, splinterN, 64));
        const seed = Math.round(finite(e.position[0]) * 977 + finite(e.position[1]) * 131);
        // Same outward normal the HIT used, not [0,1,0]. A breach is emitted
        // by applyHitDamage from inside the hit that caused it, so the ball
        // that stove the section in is in THIS frame at THIS point — matching
        // on the point recovers the ship, and with it the direction the timber
        // should be going. A hard-coded up-axis fountained the heaviest burst
        // in the whole system straight out of the deck, at right angles to the
        // debris the very same impact had just thrown along the hull normal.
        const cause = frame.hits.find((h) => samePoint(h.point, e.position));
        const axis = cause === undefined
          ? ([0, 1, 0] as [number, number, number])
          : ejectaAxis(
              outwardAxis(ships?.[cause.shipIndex], e.position),
              cause.direction,
              momentum,
            );
        for (let k = 0; k < n; k++) {
          spawn('splinter', e.position, axis, k, prof.splinter, seed, vary);
        }
        // the section coming apart throws real timber, several times what an
        // ordinary hit does — this is the one moment the ship visibly loses
        // pieces of herself, and it is what a breach has never had
        debris.spawn(
          e.position, axis, sanitizeCount(p.chunkPerBreach, 8, 32), seed ^ 0x6d2b79f5,
        );
      }

      // ── WATER ENTRY ──────────────────────────────────────────────────
      // Three parts on three clocks, which is the whole difference between a
      // displacement and a puff:
      //   CROWN   0 → 0.62 s   the rim sheet opens outward and falls back
      //   COLUMN  0 → 0.95 s   the pillar up the middle, still climbing when
      //                        the crown has already collapsed
      //   MIST    0 → 1.5 s    what is left hanging, and the only part the
      //                        wind carries away
      // plus the surface itself — the ring and the foam it leaves — which is
      // the one cue that says the water was INTERACTED WITH rather than
      // decorated. All of it scales with the speed the ball actually arrived
      // at; before this every water entry in the game was the same burst.
      const crownN = sanitizeCount(p.crownPerHit, 14, 64);
      const tilt = nn(p.crownTilt, 0.96);
      const jit = clamp01(nn(p.crownJitter, 0.55));
      for (const e of frame.projectiles) {
        if (e.type !== 'splash') continue;
        const energy = impactScale(e.speed, p);
        for (let k = 0; k < columnN; k++) {
          spawn('column', e.position, [0, 1, 0], k, prof.column, e.projectileId, vary, energy);
        }
        for (let k = 0; k < crownN; k++) {
          spawn(
            'crown', e.position, [0, 1, 0], k, prof.crown, e.projectileId, vary, energy,
            crownDirection(k, crownN, tilt, e.projectileId, jit),
          );
        }
        for (let k = 0; k < splashN; k++) {
          spawn('splash', e.position, [0, 1, 0], k, prof.splash, e.projectileId, vary, energy);
        }
        rings.spawn(e.position[0], e.position[1], e.position[2], energy);
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

      /**
       * NOTHING IN FLIGHT → NOTHING TO DO. Measured before this guard: the
       * loop below walked all 1536 slots and re-uploaded seven attribute
       * buffers (~68 KB) every single frame of a quiet cruise, with the whole
       * pool dead and every `sizeArr` entry already zero.
       *
       * `liveFor` is an upper bound on remaining life, so it hits zero only
       * AFTER the frame on which the last particle's `t >= 1` branch wrote its
       * final `sizeArr[i] = 0` and flagged the upload — the pool is flushed
       * before it is skipped, which is why this cannot leave a stuck sprite on
       * screen. The param pushes below stay OUTSIDE the guard so a live
       * Tweakpane drag still lands while idle.
       */
      if (liveFor > 0) {
        liveFor = Math.max(0, liveFor - dt);
        /** did any shard actually turn this frame? Gates the seed re-upload */
        let tumbled = false;
        for (let i = 0; i < count; i++) {
          const t = ageFraction(age[i], life[i]);
          if (t >= 1) {
            sizeArr[i] = 0; // §V.28: dead is zero-SIZE, not zero-opacity
            continue;
          }
          age[i] += dt;
          // TUMBLE. `spinArr` is zero for every kind but the splinter, so this
          // is one compare per slot for every effect that existed before, and
          // the buffer is not re-uploaded at all unless a shard is in the air.
          // Wrapped to [0,1) turns so a long-lived particle cannot drift the
          // float into a range where 2π·seed loses angular precision.
          if (spinArr[i] !== 0) {
            const turns = seedArr[i] + spinArr[i] * dt;
            seedArr[i] = turns - Math.floor(turns);
            tumbled = true;
          }
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
          const fade = brightnessAt(next);
          const b = fade * gain * pr.boost;
          sizeArr[i] = sizeAt(pr, next) * sizeScale[i];
          colArr[i * 3] = pr.color[0] * b;
          colArr[i * 3 + 1] = pr.color[1] * b;
          colArr[i * 3 + 2] = pr.color[2] * b;
          /**
           * THE FADE HAS TO BE IN THE ALPHA TOO, and this is not symmetry for
           * its own sake — it is what makes the composite a composite.
           *
           * `colArr` carries colour ALREADY MULTIPLIED by the age fade, because
           * for an additive particle the fade IS the brightness. Leaving the
           * alpha at a flat per-kind constant then hands the blender a fully
           * OPAQUE fragment whose colour has been faded toward black, so a
           * water particle paints DARK at both ends of its life — hardest in the
           * first 80 ms, where `brightnessAt` is still ramping in from zero and
           * the particle is at its largest. Caught on screen: the new column
           * rendered as a navy bruise on the sea rather than as white water.
           *
           * Multiplying the same fade into the alpha makes both channels agree
           * on one coverage f = cover·fade, so the fragment is exactly
           * `colour·f` over `dst·(1−f)` — a correct source-over of water that
           * thins as it dies instead of darkening. Additive kinds are at
           * `alpha` 0 and are untouched by this line.
           */
          alphaArr[i] = clamp01(pr.alpha) * fade;
        }
        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
        sizeAttr.needsUpdate = true;
        alphaAttr.needsUpdate = true;
        // gated, not unconditional: with no shard in the air (or `splinterSpin`
        // at 0) `seedArr` is byte-identical to what the GPU already holds, and
        // re-flagging it is exactly the 18 KB/frame of dead upload 076ad93
        // removed from this loop
        if (tumbled) seedAttr.needsUpdate = true;
      }
      uDissolveScale.value = Math.max(0.01, nn(p.smokeDissolveScale, 2.6));

      // the wind reaches the rings for the foam scars alone: they float IN the
      // surface layer, which is wind-driven, so they drift with it
      rings.update(dt, seaHeightAt, windX, windZ);
      // Debris BEFORE the rings would put a chunk's splash ring one frame
      // ahead of its own landing; after them, the ring spawned this frame is
      // laid on the surface by the NEXT `rings.update`, which is the same
      // one-frame relationship a cannonball's splash already has (both are
      // spawned from `emit`, which runs before this). Consistency here is what
      // stops a chunk's ring and a ball's ring from behaving differently.
      debris.update(dt, seaHeightAt, rings.spawn);
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
      debris.dispose();
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

/**
 * §T.63 — the axis timber actually leaves along: the surface normal, LEANED
 * DOWNRANGE by the shot's own tangential momentum.
 *
 * The bug this fixes: everything ejected from a hit was aimed along
 * `outwardAxis` alone, which is the ship's radial direction. A ball arriving
 * from fine on the bow and one arriving from square abeam therefore threw
 * identical, symmetric domes — the shot carried no momentum through the wood
 * at all, and the user read that (correctly) as the hit not registering.
 *
 * WHY THE TANGENT AND NOT THE BALL DIRECTION ITSELF. `ballDir` points INTO
 * the hull; mixing it with the outward normal passes through zero at
 * mid-blend, so the plume would collapse to a point and then normalise a
 * near-zero vector — §V.28's exact failure. Projecting the ball's direction
 * onto the surface PLANE removes that: the tangential part is orthogonal to
 * the normal, so `outward + momentum · tangent` has an outward component of
 * exactly 1 for any `momentum`, can never degenerate, and leans the burst
 * the way the shot was going. `momentum` = 0 restores the old radial dome,
 * which is what the §V.62 test compares against.
 */
function ejectaAxis(
  outward: readonly [number, number, number],
  ballDir: readonly number[] | undefined,
  momentum: number,
): [number, number, number] {
  const m = finite(momentum);
  if (ballDir === undefined || m === 0) return [outward[0], outward[1], outward[2]];
  const dx = finite(ballDir[0]);
  const dy = finite(ballDir[1]);
  const dz = finite(ballDir[2]);
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return [outward[0], outward[1], outward[2]]; // §V.28
  const ux = dx / len;
  const uy = dy / len;
  const uz = dz / len;
  const along = ux * outward[0] + uy * outward[1] + uz * outward[2];
  return normalized(
    outward[0] + m * (ux - along * outward[0]),
    outward[1] + m * (uy - along * outward[1]),
    outward[2] + m * (uz - along * outward[2]),
  );
}

/**
 * Are these the same impact point? Exact equality would be correct today —
 * destruction copies the hit's own point by value — but a millimetre tolerance
 * costs nothing and survives that copy becoming a transform.
 */
function samePoint(a: readonly number[], b: readonly number[]): boolean {
  return Math.abs(finite(a[0]) - finite(b[0])) < 1e-3
    && Math.abs(finite(a[1]) - finite(b[1])) < 1e-3
    && Math.abs(finite(a[2]) - finite(b[2])) < 1e-3;
}

/** dispatch/buffer sizes come from sanitized construction-time ints (§V.28) */
/**
 * Impact ENERGY as a multiple of the authored burst (§V.66: a feature scales
 * by its own dimension, never by an absolute metre value).
 *
 * The ball's own arrival speed against `impactSpeedRef`, square-rooted: the
 * cavity a projectile opens goes as its momentum, and the visible column
 * height goes as the square root of that, so a shot arriving twice as fast
 * throws a column ~1.4× taller rather than 2× — which is what stops a
 * long-range plunging shot from looking like a depth charge.
 *
 * A missing speed (an `expired` event, an old fixture, a forced hit) returns
 * exactly 1, so every caller that does not know the speed gets precisely the
 * authored burst rather than a silently scaled one.
 */
function impactScale(speed: number | undefined, p: CombatFxParams): number {
  const ref = Math.max(1e-3, nn(p.impactSpeedRef, 45)); // floored divisor (§V.28)
  const cap = Math.max(1, nn(p.impactSpeedMax, 2.2));
  if (!Number.isFinite(speed) || speed === undefined || speed <= 0) return 1;
  return Math.min(cap, Math.max(1 / cap, Math.sqrt(speed / ref)));
}

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
