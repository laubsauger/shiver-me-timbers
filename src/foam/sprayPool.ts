/**
 * Shared GPU particle pool for the spray emitters (§V6/§V7 crest spray in
 * spray.ts, bow spray in bowSpray.ts). Owns what both emitters have in
 * common: the two vec4 storage buffers, the init pass (whole pool dead),
 * the physics update pass (gravity, exponential drag, Euler, age — CPU
 * mirror: sprayMath.stepParticle) and the camera-facing soft-sprite render
 * (SpriteNodeMaterial: white, radial falloff, alpha fades with age,
 * additive blend, §V23 functional mix). Emitters add only their spawn pass.
 *
 * Buffers: posAge [xyz = world pos, w = age], velSize [xyz = vel, w = size
 * multiplier 0..1 chosen at spawn — how big a puff this particle is, e.g. a
 * bow slamming a swell throws a full sheet while cruising throws mist].
 * Dead = age ≥ THIS particle's life (`lifeNode`, jittered per slot — init
 * writes DEAD_AGE, far beyond any life slider × any jitter).
 * (The per-particle hash seed is NOT stored: it is fract((i+1)·φ), pure in
 * instanceIndex, so any pass that needs it recomputes it — sprayMath.goldenSeed.)
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  screenSize,
  float,
  instanceIndex,
  instancedArray,
  int,
  mix,
  select,
  smoothstep,
  storage,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { SIM_DT } from '../core/loop';
import { sprayParams } from '../params/spray';
import { hash2 } from '../terrain/noise';
import { bandLimitedFbm2, coordFootprint, foamTintNode } from './foamShading';
import { particleLighting } from '../sky/particleLighting';
import { POST_PARTICLE_LAYER } from '../core/skyDof';
import { DEAD_AGE, H_LIFE, PHI, T_LIFE, sanitizePoolCount } from './sprayMath';
import { activeHullMask, hullMaskSpriteNode } from '../ocean/hullVolumeMask';

export interface SprayPoolOptions {
  /** multiplies sizeMin/sizeMax for this pool (bow sheets > crest mist) */
  sizeScale?: () => number;
  /** per-pool lifetime override — bow sheets must fall away far sooner than
   *  crest mist, or they stream the length of the hull and over the deck */
  life?: () => number;
  /** per-pool drag override — heavier drag drops sheets out of the air fast */
  drag?: () => number;
  /**
   * §T.59 per-pool camera-distance fade. The shared `fadeNear`/`fadeFar` are
   * tuned for crest mist spawned around the camera; a ship-attached emitter
   * lives one follow-cam distance away and needs its own. A function so the
   * emitter can decide per tick (bowSpray: contact mode only). Uniform values
   * only — the sprite WGSL is the same with or without it.
   */
  fadeNear?: () => number;
  fadeFar?: () => number;
  /** §T.195 per-pool gravity (m/s², + down) — a bubble rises; uniform value only (default sprayParams.gravity) */
  gravity?: () => number;
  /** §T.195 per-pool opacity — uniform value only (default sprayParams.opacity) */
  opacity?: () => number;
  /** Custom scattering receives live sky/key radiance, just like the default tint. */
  colorNode?: (light: typeof particleLighting) => unknown;
  /**
   * §T.199 blend mode (pipeline state, not WGSL; default additive). A dense water plume (the rooster tail) OCCLUDES
   * what is behind it — additive white over a sunlit sky or whitewater adds nothing and the plume vanishes.
   */
  blending?: THREE.Blending;
  /**
   * §T.199 draw order in the transparent pass (default 0). THE OCEAN IS A TRANSPARENT, DEPTH-WRITING MESH at
   * renderOrder 0 (surfaceMaterial.ts), and three sorts equal renderOrders by the OBJECT's projected origin: a sprite
   * pool's origin is the world origin, the ocean's the camera-snapped grid centre, so a pool whose origin lay farther
   * than the ocean's drew FIRST and the sea painted over every particle above it (T199, measured sortZ 414 vs 3.8).
   * An emitter above the water draws after the ocean (`SPRAY_OVER_WATER_ORDER`), depth-tested against its depth.
   */
  renderOrder?: number;
  /** W8 per-pool motion-streak squash at `streakRefSpeed` (default sprayParams.streak) — uniform value only */
  streak?: () => number;
  /**
   * W8 WATER, NOT PUFFS (docs/wake/w8-foam-readability.md §8). Construction-time: replaces the round soft disc with a
   * sheet that has broken into ligaments and drops — `SPRAY_DROPLETS` hashed drops per sprite strung along the streak
   * axis on a thin ligament, each a small hard-ish core — and fades the sprite (a) with age as
   * (1 − age)^`dropletAgeFalloff` (dense only near the source) and (b) within `dropletNearFade` metres of the lens plane
   * (a drop at the lens is a sub-pixel speck out of focus, never a screen-filling blob). Absent: the pre-W8 sprite
   * graph, node for node (crest mist, bow sheet, bubbles).
   */
  droplets?: boolean;
  dropletAgeFalloff?: number;
  dropletNearFade?: readonly [number, number];
  /**
   * W8 round 4 PHYSICAL MOTION BLUR (droplet pools): a sprite is one drop's streak over the camera shutter — width
   * `width` m, length |v|·`shutter` (cm–dm, never metres), at most `maxRatio` widths, and never wider on screen than
   * `angularCap` radians (a drop at the lens is a speck). The quad is square, so its scale is the length and the shape
   * is squashed across by length/width. Replaces the droplet sprite size law; construction-time.
   */
  motionBlur?: {
    width: number; shutter: number; maxRatio: number; angularCap: number;
    /** Young shed water remains a broad fragment before separating into drops.
     * Width is in metres and breakupTime in seconds, independent of pool lifetime. */
    sheet?: { width: number; breakupTime: number; angularCap: number };
  };
  /**
   * W8 round 4: world y (m) below which a FALLING particle dies — it has hit the water (a uniform value; the emitter
   * passes the local mean surface of its sources). Absent: no kill, the pre-W8 physics pass node for node.
   */
  killBelow?: () => number;
  /** Metres below each particle's source surface at which it dies while falling.
   * Emitters must write birthHeight in their spawn pass, including births with
   * a sub-tick age. Other vessels and later emitter motion cannot change it. */
  returnBelowBirth?: number;
  /**
   * W8 round 6: break a soft mist pool's uniform envelope into drifting clumps — opacity × a smooth 3-D density field of
   * the sprite's world position (~2–4 m lumps, moving with time), so the plume has internal structure along its arc.
   * Construction-time; absent = the pre-W8 graph.
   */
  mistStructure?: boolean;
  /**
   * W9 WHITEWATER CLUMPS (`hullSpray.ts`, docs/wake/w9-at-speed-disturbance.md): the soft disc's rim torn into a few
   * lobes with a hashed phase per particle (no two clumps share an outline), so a dense sheet reads as torn water
   * rather than stacked balls. Like the droplet pools it is dense AT its source: born at 60 % of full size (sizeMax)
   * with a 2 % birth fade. Construction-time; absent = the pre-W9 graph node for node.
   */
  clumps?: boolean;
  /** W9 clumps: opacity × (1 − age)^this (uniform value; default 1.4, the pre-W8 law) — a whitewater trail thins astern */
  clumpAgeFalloff?: () => number;
}



/**
 * §T.199 transparent-pass slot for spray ABOVE the water: after the ocean (0), before cockpit glass
 * (`PERSPEX_RENDER_ORDER` = 1, speedboat/assets/waterMask.ts), so spray seen through a windscreen is still behind it.
 */
export const SPRAY_OVER_WATER_ORDER = 0.5;
/**
 * §T.199 slot for particles UNDER the surface (prop bubbles): after the hull water-mask cap (−1), before the ocean,
 * so they are in the framebuffer the ocean's refraction copies when it draws.
 */
export const SPRAY_UNDER_WATER_ORDER = -0.5;

export function createSprayPool(rawCount: number, options: SprayPoolOptions = {}) {
  if (options.returnBelowBirth !== undefined && (
    !Number.isFinite(options.returnBelowBirth) || options.returnBelowBirth < 0 || options.killBelow !== undefined
  )) throw new Error('Spray returnBelowBirth requires a finite nonnegative offset and no shared killBelow plane');
  // counts feed buffer sizes + dispatch counts at construction — sanitize
  const count = sanitizePoolCount(rawCount, 1024);
  const posAge = instancedArray(count, 'vec4');
  const velSize = instancedArray(count, 'vec4');
  const birthHeight = options.returnBelowBirth !== undefined ? instancedArray(count, 'float') : null;
  // separate read-only VIEWS for the sprite vertex stage: posAge.toReadOnly()
  // would mutate the shared node and silently drop every compute write to it
  // (init + physics), freezing the whole pool at buffer-zero — see §B.8
  const posAgeRead = storage(posAge.value, 'vec4', count).toReadOnly();
  const velSizeRead = storage(velSize.value, 'vec4', count).toReadOnly();

  const uLife = uniform(sprayParams.life);
  const uLifeVar = uniform(sprayParams.lifeVariation);
  const uGravity = uniform(sprayParams.gravity);
  const uDragFactor = uniform(1);
  const uSizeMin = uniform(sprayParams.sizeMin);
  const uSizeMax = uniform(sprayParams.sizeMax);
  const uOpacity = uniform(sprayParams.opacity);
  const uSoftness = uniform(sprayParams.softness);
  const uStreak = uniform(options.streak?.() ?? sprayParams.streak);
  const uStreakRef = uniform(sprayParams.streakRefSpeed);
  const uFadeNear = uniform(sprayParams.fadeNear);
  const uFadeFar = uniform(sprayParams.fadeFar);
  const uKillY = uniform(options.killBelow?.() ?? -1e6);
  const uClumpTime = uniform(0);
  /** W9 clumps' age falloff (`clumpAgeFalloff`), read by the quad cull and the opacity law */
  const uClumpFalloff = uniform(options.clumpAgeFalloff?.() ?? 1.4);
  const uSizeScale = uniform(
    Number.isFinite(options.sizeScale?.() ?? 1) ? Math.max(0, options.sizeScale?.() ?? 1) : 1,
  );

  /**
   * Per-particle lifetime (CPU mirror: sprayMath.particleLife). EVERY test of
   * "is this particle dead" must use this node and not `uLife`, or a slot
   * respawns before it has faded (spawn gate too loose) or never fades out
   * (integrator too generous). Pure in instanceIndex on purpose: the physics
   * pass has no spawn time to hash against, and the value has to agree across
   * three passes that never talk to each other.
   */
  const lifeNode = () => {
    // @band-limited-elsewhere: fract of the particle INDEX, not of a spatial
    // coordinate — it never varies across a pixel, so it has no footprint
    const s = float(instanceIndex).add(1).mul(PHI).fract();
    const r = hash2(vec2(s.mul(H_LIFE), float(T_LIFE)));
    return uLife.mul(uLifeVar.oneMinus().add(uLifeVar.mul(2).mul(r))).max(1e-3);
  };

  // whole pool starts dead far below the surface
  const initPass = Fn(() => {
    posAge.element(instanceIndex).assign(vec4(0, -1000, 0, DEAD_AGE));
    velSize.element(instanceIndex).assign(vec4(0, 0, 0, 0));
  })().compute(count);

  // physics update — CPU mirror: sprayMath.stepParticle
  const updatePass = Fn(() => {
    const pa = posAge.element(instanceIndex);
    const vs = velSize.element(instanceIndex);
    If(pa.w.lessThan(lifeNode()), () => {
      const vel = vec3(vs.x, vs.y.sub(uGravity.mul(SIM_DT)), vs.z)
        .mul(uDragFactor)
        .toVar();
      velSize.element(instanceIndex).assign(vec4(vel, vs.w));
      if (options.killBelow || birthHeight) {
        const next = pa.xyz.add(vel.mul(SIM_DT)).toVar();
        // W8 round 4: a falling particle that reaches the water dies there (no drops lying on the lane)
        const plane = birthHeight ? birthHeight.element(instanceIndex).sub(options.returnBelowBirth!) : uKillY;
        const hit = next.y.lessThan(plane).and(vel.y.lessThan(0));
        posAge.element(instanceIndex).assign(vec4(next, select(hit, float(DEAD_AGE), pa.w.add(SIM_DT))));
      } else {
        posAge
          .element(instanceIndex)
          .assign(vec4(pa.xyz.add(vel.mul(SIM_DT)), pa.w.add(SIM_DT)));
      }
    });
  })().compute(count);

  // render: instanced camera-facing sprites; dead → ageN = 1 → zero size
  const material = new THREE.SpriteNodeMaterial();
  const el = posAgeRead.element(instanceIndex);
  const vel = velSizeRead.element(instanceIndex).xyz;
  // divisor floor: uLife is CPU-clamped too, but 0/0 here would be a NaN
  // scale → screen-covering quad × pool size = fill-rate wedge. Never risk it.
  const ageN = el.w.div(lifeNode().max(1e-6)).clamp(0, 1);
  material.positionNode = el.xyz;

  // distance falloff (user critique: dots stippled out to the horizon).
  // Particles are a NEAR-FIELD effect — far crests carry painted foam, not
  // sprites. Inverted smoothstep, functional form only (§V23).
  const camDist = el.xyz.sub(cameraPosition).length();
  const distFade = smoothstep(uFadeNear, uFadeFar.max(uFadeNear.add(1)), camDist)
    .oneMinus();

  // dead OR fully faded particles collapse to zero size: a degenerate quad
  // rasterizes no fragments, so the idle pool costs no fill rate (alpha-0
  // quads still would — §V28/§B.5)
  // per-particle size multiplier chosen at spawn (bow sheet vs cruise mist),
  // clamped so a garbage buffer value can never inflate a quad (§V28)
  const sizeMul = velSizeRead.element(instanceIndex).w.clamp(0, 1);
  // round 3: a droplet pool is dense AT its source — its sprites start near full size (the old 4× growth hid the plume's
  // root and left only the aged cloud visible, detached behind the boat)
  const mb = options.droplets ? options.motionBlur : undefined;
  const viewDepth = cameraViewMatrix.mul(vec4(el.xyz, 1)).z.negate().max(0.05);
  const fragmentSeed = float(instanceIndex).add(1).mul(PHI).fract();
  const breakup = mb?.sheet
    ? smoothstep(float(0), float(mb.sheet.breakupTime).mul(fragmentSeed.mul(0.4).add(0.8)), el.w)
    : null;
  const dropWidth = mb ? (mb.sheet && breakup
    ? mix(float(mb.sheet.width), float(mb.width), breakup)
    : float(mb.width)) : null;
  const blurLen = mb && dropWidth ? vel.length().mul(mb.shutter).max(dropWidth).min(dropWidth.mul(mb.maxRatio)) : null;
  const angularCap = mb ? (mb.sheet && breakup
    ? mix(float(mb.sheet.angularCap), float(mb.angularCap), breakup)
    : float(mb.angularCap)) : null;
  const trueSize = mb && blurLen && angularCap ? blurLen.mul(sizeMul.mul(0.5).add(0.5)).min(viewDepth.mul(angularCap)) : null;
  // round 5 COVERAGE CONSERVATION: a drop smaller than ~1.5 px is drawn at 1.5 px with its opacity × (true/drawn)²,
  // so a far plume of sub-pixel drops reads as the haze their summed cross-section makes instead of vanishing
  // (sub-pixel quads miss pixel centres). One pixel at depth z spans 2z/(P₁₁·H) m.
  const minSize = viewDepth.mul(3).div(cameraProjectionMatrix.element(int(1)).element(int(1)).mul(screenSize.y).max(1));
  const drawnSize = trueSize ? trueSize.max(minSize) : null;
  const coverage = trueSize && drawnSize ? trueSize.div(drawnSize).pow(2) : null;
  const size = drawnSize
    ? drawnSize
    : (options.droplets || options.clumps ? mix(uSizeMax.mul(0.6), uSizeMax, ageN) : mix(uSizeMin, uSizeMax, ageN)).mul(uSizeScale).mul(sizeMul);
  // W9 clumps: a clump whose age law has faded it below 1 % draws no quad (dense packs: overdraw of invisible sprites)
  const hidden = options.clumps
    ? ageN.greaterThanEqual(1).or(distFade.lessThan(0.01)).or(ageN.oneMinus().pow(uClumpFalloff.max(0.5)).lessThan(0.01))
    : ageN.greaterThanEqual(1).or(distFade.lessThan(0.01));
  material.scaleNode = select(hidden, float(0), size);
  // W9 clumps REST ON the water: the quad is drawn half its size up, so a clump born at the surface is not cut in half by
  // the ocean's depth (a camera-facing quad centred on the waterline reads as foam sunk into the sea)
  if (options.clumps) material.positionNode = el.xyz.add(vec3(0, size.mul(0.5), 0));

  // motion streak: squash the radial falloff ACROSS the screen-space velocity
  // so fast droplets read as short dashes of mist, not bouncy balls. The
  // sprite quad is built in view space, so the view-space velocity direction
  // is the quad's own axis frame.
  const q = uv().mul(2).sub(1);
  const viewVel = cameraViewMatrix.mul(vec4(vel, 0)).xy;
  const viewSpeed = viewVel.length().toVar();
  // a zero-length direction would make BOTH quad axes read 0 → shape = 1 over
  // the whole quad → a hard bright SQUARE at additive blend (the §B.5 class
  // of failure). Fall back to a fixed axis; the streak factor is ~0 there.
  const dir = select(
    viewSpeed.greaterThan(1e-4),
    viewVel.div(viewSpeed.max(1e-4)), // floored divisor (§V28)
    vec2(1, 0),
  );
  const along = q.dot(dir);
  const across = q.dot(vec2(dir.y.negate(), dir.x));
  const streakN = smoothstep(float(0), uStreakRef.max(1e-3), vel.length());
  const velocitySquash = mb && blurLen && drawnSize && dropWidth ? blurLen.div(dropWidth).min(drawnSize.div(minSize).max(1)) : mix(float(1), uStreak.max(1), streakN);
  // Broad silhouette variation survives when small interior holes no longer
  // resolve. Older sheet fragments narrow along their projected motion rather
  // than all settling into identical circular puffs.
  const squash = options.clumps
    ? velocitySquash.mul(float(instanceIndex).add(1).mul(PHI).fract().mul(0.8).add(1.35).add(ageN.mul(0.5)))
    : velocitySquash;
  const r2 = along.mul(along).add(across.mul(squash).pow(2));
  // pow of a clamped-non-negative base: softness ≥ 1 gives a mist-soft edge
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union
  let shape: any = r2.oneMinus().max(0).pow(uSoftness.max(1));
  if (options.droplets) {
    // W8 round 4: one drop's motion-blur streak — a soft capsule (length = the quad, width = length/squash), no hashed
    // dots; the plume's grain is the COUNT of these. @band-limited-elsewhere: per-sprite shape, no world period
    shape = r2.oneMinus().max(0).pow(1.5);
    if (mb?.sheet && breakup) {
      // The young sheet has a ragged, elongated outline. It narrows into the
      // existing drop silhouette over time; it never paints a prebuilt trail.
      const edge = along.mul(9).add(fragmentSeed.mul(31)).sin().mul(0.12).add(0.86);
      const sheetR2 = along.pow(2).add(across.mul(squash).div(edge).pow(2).mul(2.5));
      const sheetShape = sheetR2.oneMinus().max(0).pow(0.65);
      shape = mix(sheetShape, shape, breakup);
    }
  }
  if (options.clumps) {
    // Break the interior as well as the silhouette. A scalloped rim around an
    // opaque radial core still reads as a row of balls, even with size jitter.
    // The field follows the projected motion, drifts during breakup, and has
    // an independent phase per particle. Octaves filter at their own footprint.
    const seed = float(instanceIndex).add(1).mul(PHI).fract();
    const base = vec2(along.mul(0.8).sub(across.mul(squash).mul(0.6)),
      along.mul(0.6).add(across.mul(squash).mul(0.8))).mul(3.2)
      .add(vec2(seed.mul(31.7), seed.mul(73.1)))
      .add(vec2(ageN.mul(0.8), ageN.mul(-0.5)));
    // Bend the noise lattice so erosion cannot expose straight grid-aligned
    // cutouts. Its derivative participates in the octave footprint below.
    const coord = base.add(vec2(base.y.mul(0.73).sin(), base.x.mul(0.67).sin()).mul(0.55));
    const footprint = coordFootprint(coord);
    const breakup = bandLimitedFbm2(coord, 1, footprint);
    const rim = breakup.mul(0.6).add(0.4);
    const erosion = ageN.mul(0.22).add(0.34);
    const holes = smoothstep(erosion, erosion.add(breakup.fwidth().max(0.1)), breakup);
    // @band-limited-elsewhere: this is the cell footprint fade. Unresolved
    // holes resolve to partial coverage instead of a solid opaque core.
    const detail = smoothstep(float(1), float(0.25), footprint);
    const coverageMean = mix(float(0.6), float(0.25), ageN);
    shape = rim.sub(r2).div(rim).max(0).pow(0.6).mul(mix(coverageMean, holes, detail));
  }

  // birth fade-in kills the pop of a sprite appearing at full size/alpha
  const born = smoothstep(float(0), float(options.droplets || options.clumps ? 0.02 : 0.12), ageN);
  const decayN = options.clumps
    ? ageN.oneMinus().pow(uClumpFalloff.max(0.5))
    : ageN.oneMinus().pow(options.droplets ? Math.max(1, options.dropletAgeFalloff ?? 1.4) : 1.4);
  // W8: a drop at the lens fades out (SprayPoolOptions.dropletNearFade); pre-W8 pools keep 1
  // round 3: depth to the LENS PLANE (view-space −z), not a sphere around the eye — a hard-mounted close camera still sees
  // the plume a metre or two away; only drops at the glass fade.
  // @band-limited-elsewhere: a fade on view depth (metres, per sprite), no spatial period
  const nearFade = options.dropletNearFade
    ? smoothstep(float(options.dropletNearFade[0]), float(Math.max(options.dropletNearFade[0] + 0.1, options.dropletNearFade[1])), viewDepth)
    : null;
  // warm-white, shared with sea foam (§T.195: a pool may bring its own, e.g. the prop wash's aerated turquoise)
  const tint = options.colorNode
    ? options.colorNode(particleLighting)
    : foamTintNode().mul(particleLighting.ambient.add(particleLighting.key));
  // W9 clumps: each clump's own brightness (0.45–1.25, hashed per particle) — torn whitewater is lit face by face, so a
  // dense sheet keeps its texture instead of averaging to one flat tone
  // @band-limited-elsewhere: fract of the particle INDEX (a seed), not a spatial coordinate
  const clumpShade = options.clumps ? hash2(vec2(float(instanceIndex).add(1).mul(PHI).fract().mul(211.7), float(5.3))).mul(0.8).add(0.45) : null;
  material.colorNode = (clumpShade ? (tint as { mul(v: unknown): unknown }).mul(clumpShade) : tint) as typeof material.colorNode;
  const faded0 = shape.mul(born).mul(decayN).mul(distFade);
  const faded1 = coverage ? faded0.mul(coverage) : faded0;
  // @band-limited-elsewhere: a per-sprite density factor of its world position (metre-scale, sampled once per sprite)
  const clump = options.mistStructure
    ? el.x.mul(1.3).add(uClumpTime).sin().mul(el.y.mul(1.9).sub(uClumpTime.mul(0.7)).sin()).mul(el.z.mul(1.1).add(uClumpTime.mul(0.4)).sin()).mul(0.5).add(0.5).pow(2).mul(2.2)
    : null;
  const faded = clump ? faded1.mul(clump) : faded1;
  material.opacityNode = (nearFade ? faded.mul(nearFade) : faded).mul(uOpacity).clamp(0, 1);
  material.transparent = true;
  material.blending = options.blending ?? THREE.AdditiveBlending;
  material.depthWrite = false;
  // explicit, not defaulted: spray must be depth-TESTED against the hull or
  // particles behind the ship would draw over it and read as the deck being
  // covered in speckle rather than spray passing in front of it. depthWrite
  // stays off so particles don't occlude each other.
  material.depthTest = true;
  material.fog = false;
  // hull volume mask (ocean/hullVolumeMask.ts): no spray inside any boat's hull + cockpit column; opt-in, absent ⇒ no node
  const hullMask = activeHullMask();
  if (hullMask) material.maskNode = hullMaskSpriteNode(hullMask);

  const mesh = new THREE.Sprite(material as unknown as THREE.SpriteMaterial);
  // DOF (trailer agent's current `core/skyDof` contract): spray also sits on the particle COVERAGE layer, keeping its own
  mesh.layers.enable(POST_PARTICLE_LAYER);
  mesh.count = count;
  mesh.frustumCulled = false; // positions live GPU-side, CPU knows no bounds
  if (options.renderOrder !== undefined && Number.isFinite(options.renderOrder)) mesh.renderOrder = options.renderOrder;

  let initialized = false;
  const run = (renderer: THREE.WebGPURenderer, pass: unknown) =>
    renderer.compute(pass as Parameters<THREE.WebGPURenderer['compute']>[0]);

  // non-finite params must never reach uniforms: NaN reaching the position
  // or scale path renders garbage quads (fill-rate hazard), and it would
  // persist in the storage buffers until every particle respawned.
  const fin = (v: number, fallback: number) => (Number.isFinite(v) ? v : fallback);

  return {
    posAge,
    velSize,
    /** Source water height, written alongside posAge/velSize by retained-plane emitters. */
    birthHeight,
    mesh,
    /** sanitized pool size — emitters must size their spawn passes with THIS */
    count,

    /** refresh shared uniforms from live params, then init (once) + physics */
    step(renderer: THREE.WebGPURenderer): void {
      // life floor: ageN divides by life; drag floor: negative drag would be
      // exponential velocity GROWTH → positions at Infinity within seconds
      uLife.value = Math.max(fin(options.life?.() ?? sprayParams.life, 1), 1e-3);
      if (options.killBelow) uKillY.value = fin(options.killBelow(), -1e6);
      if (options.mistStructure) uClumpTime.value += SIM_DT * 0.6;
      if (options.clumpAgeFalloff) uClumpFalloff.value = fin(options.clumpAgeFalloff(), 1.4);
      // clamped < 1 so the shortest-lived slot keeps a positive lifetime
      uLifeVar.value = Math.min(0.9, Math.max(0, fin(sprayParams.lifeVariation, 0)));
      uGravity.value = fin(options.gravity?.() ?? sprayParams.gravity, 0);
      uDragFactor.value = Math.exp(
        -Math.max(0, fin(options.drag?.() ?? sprayParams.drag, 0)) * SIM_DT,
      );
      uSizeScale.value = Math.max(0, fin(options.sizeScale?.() ?? 1, 1));
      uSizeMin.value = fin(sprayParams.sizeMin, 0);
      uSizeMax.value = fin(sprayParams.sizeMax, 0);
      uOpacity.value = fin(options.opacity?.() ?? sprayParams.opacity, 0);
      uSoftness.value = Math.max(1, fin(sprayParams.softness, 1));
      uStreak.value = Math.max(1, fin(options.streak?.() ?? sprayParams.streak, 1));
      uStreakRef.value = Math.max(1e-3, fin(sprayParams.streakRefSpeed, 1));
      uFadeNear.value = Math.max(0, fin(options.fadeNear?.() ?? sprayParams.fadeNear, 40));
      uFadeFar.value = Math.max(
        uFadeNear.value + 1,
        fin(options.fadeFar?.() ?? sprayParams.fadeFar, 90),
      );
      if (!initialized) {
        run(renderer, initPass);
        initialized = true;
      }
      run(renderer, updatePass);
    },

    /** run an emitter's spawn pass (after step) */
    run,
    /**
     * THIS particle's lifetime, as a node — emitters must gate "is it dead?"
     * on `lifeNode()`, never on `uLife` (see the definition above).
     */
    lifeNode,

    dispose(): void {
      material.dispose();
    },
  };
}

export type SprayPool = ReturnType<typeof createSprayPool>;
