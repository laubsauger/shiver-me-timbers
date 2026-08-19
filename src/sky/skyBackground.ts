/**
 * TSL sky as a scene BACKGROUND node (§V16 — every knob is a uniform fed
 * from sky params).
 *
 * WHY NOT A DOME MESH (§B9): this used to be a BackSide SphereGeometry of
 * radius `domeRadius` added at the world origin and never moved. The ship
 * sails away from the origin forever, so the camera drifted off-centre and
 * eventually outside the sphere — at which point the near hemisphere culls
 * away and you see the far interior wall as a giant pale ball hanging behind
 * the ship, with the renderer clear colour (near-black) everywhere else.
 * Even before that, the far side crossed camera.far (5000) and got clipped.
 * `scene.backgroundNode` hands the same shading to three's own background
 * mesh, which is unit-sized, pinned to the camera each frame, drawn first
 * with depthTest/depthWrite off and its vertex z forced to w. Result: the
 * sky is at infinity — no radius, no far-plane interaction, and it cannot
 * disagree with however many kilometres of ocean the water system draws.
 *
 * Technique note: three ships SkyMesh (Preetham analytic scattering) which
 * does run on WebGPURenderer, but its physically-derived turbidity/Rayleigh
 * look fights the painterly SoT reference — milky haze band, saturated flat
 * zenith, big soft glow. A hand-authored 3-stop gradient is ~40 lines of TSL
 * and every term is art-directable, so we build our own.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  float,
  fwidth,
  mix,
  positionWorld,
  smoothstep,
  uniform,
  vec3,
} from 'three/tsl';
import type { SkyParams } from '../params/sky';
import { moonIllumination, type KeyLight } from './moonCycle';
import { createStarfield } from './starfield';
import { createWindLines, type WindFrame } from './windLines';
import {
  bandGeometry,
  hexToRgb,
  skyPalette,
  skyTint,
  sunColor,
  sunDiscCosines,
  type Rgb,
} from './sunCycle';

/** sRGB triple × a 0..1 tint ramp → a linear-working-space three.Color */
function tinted(c: Rgb, tint: Rgb): THREE.Color {
  // setRGB with SRGBColorSpace does the transfer function; passing raw sRGB
  // numbers into the default (linear) working space is §B9, the white wash.
  return new THREE.Color().setRGB(
    c[0] * tint[0],
    c[1] * tint[1],
    c[2] * tint[2],
    THREE.SRGBColorSpace,
  );
}

/** floor for any shader divisor (§V28) */
const EPS = 1e-3;

export function createSkyBackground(p: SkyParams) {
  const uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  const uSunColor = uniform(new THREE.Color());
  const uZenith = uniform(new THREE.Color());
  const uMid = uniform(new THREE.Color());
  const uHaze = uniform(new THREE.Color());
  const uWarm = uniform(new THREE.Color());
  const uHazeStrength = uniform(p.hazeStrength);
  const uHazeFalloff = uniform(p.hazeFalloff);
  const uSunHaze = uniform(p.sunHazeStrength);
  const uWarmAmount = uniform(0);
  const uGradCurve = uniform(p.gradientCurve);
  // disc thresholds precomputed CPU-side as cosines (cheap dot compare)
  const uDiscCosOuter = uniform(1);
  const uDiscCosInner = uniform(1);
  const uDiscIntensity = uniform(p.sunDiscIntensity);
  const uGlowPower = uniform(p.sunGlowPower);
  const uGlowStrength = uniform(p.sunGlowStrength);
  const uHaloPower = uniform(p.sunHaloPower);
  const uHaloStrength = uniform(p.sunHaloStrength);
  // ── moon: disc + phase terminator + its own (much tighter) glow ────────
  // Every one of these is used ONLY in `colorNode` below, never inside
  // `skyDome` — same rule as the sun disc, and for the same two reasons:
  // a reflection must not re-add an HDR disc the water's own glint road
  // already owns, and `skyDome` is evaluated per WATER pixel in the ocean's
  // fragment stage, which is at 16/16 samplers and is the frame's dominant
  // cost (§V40, §V17). Nothing here may ever migrate into skyDome.
  const uMoonDir = uniform(new THREE.Vector3(0, -1, 0));
  const uMoonColor = uniform(new THREE.Color());
  const uMoonCosOuter = uniform(1);
  const uMoonCosInner = uniform(1);
  const uMoonSinRadius = uniform(0.02);
  const uMoonIntensity = uniform(p.moonDiscIntensity);
  /** cos of the phase angle: +1 = new (nothing lit), -1 = full (all lit) */
  const uMoonTermK = uniform(-1);
  const uMoonTermSoft = uniform(p.moonTerminatorSoftness);
  const uMoonGlowPower = uniform(p.moonGlowPower);
  const uMoonGlowStrength = uniform(p.moonGlowStrength);
  const uMoonHaloPower = uniform(p.moonHaloPower);
  const uMoonHaloStrength = uniform(p.moonHaloStrength);
  /** 0..1 lit FRACTION of the drawn disc — scales glow/halo so a new moon
   *  has no aura. Driven by `moonDiscPhase`, not `moonPhase`, so the aura
   *  always matches the disc actually on screen, and by the lit AREA rather
   *  than by MOON_SURGE: the surge is a reflectance law about light leaving
   *  the regolith, while an aura is bloom off the disc you can see. */
  const uMoonBright = uniform(0);

  // ── stars (§T.46) ──────────────────────────────────────────────────────
  // Same rule as the discs, and this one is the whole reason the field is
  // affordable: it is built INTO `colorNode` and is invisible to `skyDome`,
  // which the ocean evaluates per water pixel. Nothing here may migrate.
  const starfield = createStarfield(p);

  // ── wind lines (§T.47) ─────────────────────────────────────────────────
  // Same rule again, same reason: `colorNode` only, never `skyDome`.
  const windLines = createWindLines(p);

  // ── THE directional sky colour, for ANY direction ────────────────────
  // SINGLE SOURCE OF TRUTH (§T39, same rule as skyPalette for colour and
  // bandGeometry for shape). This is the sky's radiance toward `dir`,
  // EXCLUDING the sun disc/glow/halo — a reflection must not re-add the HDR
  // disc, which the water's own specular and glint road already own.
  //
  // Exposed as `skyDomeColor` so the ocean's reflected sky can call it
  // instead of re-deriving a two-stop elevation ramp from uZenith/uHorizon.
  // That duplicate is why the sea reflects the same warm cream in every
  // direction at sunset ("too much sunlight colour all around"): a gradient
  // in elevation ONLY has no azimuth, so the anti-sun water is as warm as
  // the sun-side water, and the sun-side halo then stacks on top of it.
  // Everything azimuthal here rides `band`, so a consumer gets the sun-side
  // warmth — and any anti-solar cooling added later — for free.
  //
  // Cost note: this is evaluated per WATER pixel, and the ocean is the
  // frame's dominant cost. Two transcendentals (`pow` for the body curve,
  // `exp` for the haze wedge) and no texture fetches; sunSide is squared with
  // a multiply rather than pow(2) for that reason. Keep it that cheap.
  //
  // NOTE §B1/§V23: functional mix(a,b,t) ONLY — chained a.mix(b,t) reads the
  // RECEIVER as the factor (mixElement) and silently inverts the blend.
  const skyDome = Fn(([dir]: [ReturnType<typeof vec3>]) => {
    const lift = dir.y.max(0); // sin(elevation), 0 at and below the horizon

    // 1. sky body: mid → zenith with height
    const height = lift.pow(uGradCurve.max(EPS));
    const body = mix(vec3(uMid), vec3(uZenith), height);

    // 2. haze band: exponential wedge hugging the horizon, thickened on the
    //    sun's side (forward scattering makes the sun's quarter of the sky
    //    paler — visible in docs/final-full-result.png)
    const d = dir.dot(uSunDir);
    const sunSide = d.mul(0.5).add(0.5);
    const band = lift.div(uHazeFalloff.max(EPS)).negate().exp().clamp(0, 1);
    const hazeAmt = band.mul(uHazeStrength.add(sunSide.mul(uSunHaze))).clamp(0, 1);
    const hazed = mix(body, vec3(uHaze), hazeAmt);

    // 3. golden-hour warmth, strongest in the band on the sun's side
    const warmMask = band.mul(sunSide.mul(sunSide)).mul(uWarmAmount).clamp(0, 1);
    return mix(hazed, vec3(uWarm), warmMask);
  });

  // three pins the background mesh to the camera (matrixWorld.copyPosition),
  // so world position minus camera position is exactly the view ray.
  const viewDir = positionWorld.sub(cameraPosition).normalize();
  const warmed = skyDome(viewDir);

  /**
   * 4. analytic sun: HDR disc + tight glow + wide halo, all additive.
   *    smoothstep(e0,e1,x) functional form; e0 = cos(outer) < e1 = cos(inner)
   *    because cosine falls as the angle grows.
   *
   * §T.61 — A FUNCTION OF `dir`, NOT OF THE BACKGROUND'S OWN VIEW RAY. It was
   * a straight-line expression on `viewDir` because the background mesh was
   * its only consumer. It now has a second one: the ocean's Snell's-window
   * branch, which needs the sun's radiance toward a REFRACTED direction that
   * has nothing to do with any view ray. Same terms, same uniforms, no cost
   * change on this side — `sunTerm` below is this called on `viewDir`.
   *
   * §V.26 IS DELIBERATELY NOT WEAKENED. `skyDome` still excludes all three
   * terms, and this is published SEPARATELY rather than folded into it, so
   * the above-water reflection cannot pick the disc up by accident. See
   * `skySunTerm`'s own note for why transmission is the other case.
   */
  const sunFor = Fn(([dir]: [ReturnType<typeof vec3>]) => {
    const c = dir.dot(uSunDir);
    /**
     * §V.48, BOTH HALVES — and it is not the background that needs it. On the
     * sky mesh `dir` is the view ray, `fwidth(c)` is a fraction of a degree,
     * and the `max` below is a no-op: this block is algebraically the disc it
     * replaces. The consumer that needs it is the ocean's Snell's window,
     * where `dir` is refracted about the LIVE PER-PIXEL WAVE NORMAL and the
     * refraction's Jacobian n·cosθ_w/cosθ_a runs away at the rim — so the
     * sun's image there is a sub-pixel-thin arc swinging by degrees between
     * neighbouring pixels. An unfiltered HDR disc under those conditions is a
     * firefly field, straight into the bloom.
     *
     * (a) WIDEN the transition to at least 2 px of `c`'s own screen footprint;
     * (b) and drop the amplitude by the SAME ratio, so the widened disc keeps
     *     the energy of the authored one instead of gaining a fatter core.
     *     Without (b) a smeared sun is BRIGHTER than a sharp one, which is the
     *     §V.48(b) mistake with the sign flipped.
     * Both collapse to identity when the authored width already wins.
     *
     * FRAGMENT-STAGE ONLY, by `fwidth`. Both callers are fragment; a vertex
     * caller would need the widening handed in, as §V.48 requires everywhere
     * else in this project.
     */
    const w0 = uDiscCosInner.sub(uDiscCosOuter).max(EPS);
    const w = w0.max(fwidth(c).mul(2));
    const mid = uDiscCosOuter.add(uDiscCosInner).mul(0.5);
    const disc = smoothstep(mid.sub(w.mul(0.5)), mid.add(w.mul(0.5)), c)
      .mul(uDiscIntensity)
      .mul(w0.div(w));
    const toSun = c.clamp(0, 1); // clamp before pow — negative base = NaN (§V28)
    const glow = toSun.pow(uGlowPower.max(EPS)).mul(uGlowStrength);
    const halo = toSun.pow(uHaloPower.max(EPS)).mul(uHaloStrength);
    return vec3(uSunColor).mul(disc.add(glow).add(halo));
  });
  const sunTerm = sunFor(viewDir);

  // 5. analytic MOON: disc, phase terminator, tight glow, tight halo.
  //
  // The terminator is the reason this is not just a second copy of the sun
  // block. Build a 2D basis on the disc — `right` across it, `up2` up it —
  // and project the view ray into it, so (x, y) are disc coordinates in units
  // of the disc radius. A point is lit where x > k·sqrt(1-y²): that ellipse
  // IS the terminator, and k = cos(phase angle) makes it sweep from the
  // limb (k=+1, new: nothing lit) through the centre (k=0, quarter: half lit)
  // to the far limb (k=-1, full: everything lit).
  //
  // §V28: `right` is degenerate when the moon sits exactly at the zenith, so
  // the length is floored rather than trusted — that collapses x to 0 (a
  // half moon at an arbitrary roll) instead of NaN-ing the entire sky.
  const md = viewDir.dot(uMoonDir);
  const rAxis = uMoonDir.cross(vec3(0, 1, 0));
  const right = rAxis.div(rAxis.length().max(EPS));
  const up2 = right.cross(uMoonDir);
  const inv = float(1).div(uMoonSinRadius.max(EPS));
  const dx = viewDir.dot(right).mul(inv);
  const dy = viewDir.dot(up2).mul(inv).clamp(-1, 1);
  const termEdge = float(1).sub(dy.mul(dy)).max(0).sqrt().mul(uMoonTermK);
  // §V48, both halves. (a) WIDEN: the terminator is the sharpest feature on
  // the disc and the disc is only ~40 px across at 1440p — narrower still at
  // a wide FOV — so the authored softness is FLOORED at 2 px of `dx`'s own
  // fwidth. One pixel is not enough: neighbours still straddle the whole
  // step. (b) the amplitude half is free here, because the widened edge
  // converges on the disc's own mean brightness rather than on a step.
  const soft = uMoonTermSoft.max(EPS).max(fwidth(dx).mul(2));
  const lit = smoothstep(termEdge.sub(soft), termEdge.add(soft), dx);
  // Same treatment for the limb: `moonDiscSoftness` is authored in degrees,
  // but a wide FOV can push that under a pixel, so it too is floored by the
  // screen footprint of the cosine it is thresholding.
  const limbSoft = fwidth(md).mul(2);
  const moonDisc = smoothstep(uMoonCosOuter.sub(limbSoft), uMoonCosInner.add(limbSoft), md)
    .mul(lit)
    .mul(uMoonIntensity);
  const toMoon = md.clamp(0, 1); // clamp before pow — negative base = NaN (§V28)
  const moonGlow = toMoon.pow(uMoonGlowPower.max(EPS)).mul(uMoonGlowStrength);
  const moonHalo = toMoon.pow(uMoonHaloPower.max(EPS)).mul(uMoonHaloStrength);
  // §V44 bounded at source: every factor is a 0..1 smoothstep or a clamped
  // pow, and the phase weight zeroes the whole term at new moon rather than
  // relying on a clamp downstream.
  const moonTerm = vec3(uMoonColor).mul(
    moonDisc.add(moonGlow.add(moonHalo).mul(uMoonBright)),
  );

  // 6. stars and wind lines. Added LAST and only here — see the note by
  //    `createStarfield`.
  //
  //    THE WIND LINES COMPOSITE BEHIND THE CLOUDS, AND THAT IS A DECISION, NOT
  //    AN ACCIDENT. `scene.backgroundNode` is drawn first, so the cloud
  //    composite quad (src/clouds/cloudComposite.ts) lands on top of
  //    everything here. The SoT reference shows the streaks crossing IN FRONT
  //    of cloud masses, which is what makes them read as near-field air rather
  //    than as sky texture, and there is a functional argument too: heavy
  //    storm coverage hides the lines exactly when they are meant to be
  //    intensifying, which is the one condition the feature most needs to
  //    survive. It is behind anyway because that costs no new pass, no new
  //    draw call and no contention with the cloud pipeline.
  //
  //    MOVING IT IS ONE LINE. `windLines.node` is a pure function of the view
  //    RAY — no camera position, no plane, no world anchor — so a caller
  //    inside the cloud composite can reconstruct the same ray and add the
  //    same node, and nothing in this file has to change but the deletion of
  //    the `.add()` below. If the streaks read as sky texture instead of as
  //    air, or if a storm sky swallows them, that is the move to make.
  const colorNode = warmed
    .add(sunTerm)
    .add(moonTerm)
    .add(starfield.node(viewDir))
    .add(windLines.node(viewDir));

  return {
    colorNode,
    /**
     * The sky's radiance toward an arbitrary direction, sun disc EXCLUDED.
     * Give it a normalized world-space vec3 (a reflection ray is fine —
     * downward rays clamp to the horizon colour rather than going negative).
     *
     * This is the ocean's reflected-sky term. Call it rather than rebuilding
     * a horizon→zenith ramp: a second implementation cannot see the sun's
     * azimuth and drifts from this one the moment either is tuned (§T39).
     */
    skyDomeColor: (dir: ReturnType<typeof vec3>) => skyDome(dir),
    /**
     * §T.61 — THE SUN ITSELF (disc + glow + halo) toward an arbitrary
     * direction, in the same scene-linear units `skyDomeColor` returns. Add
     * the two to get the full sky radiance; `skyDomeColor` alone is the sky
     * WITHOUT the sun, which is what §V.26 requires of a reflection.
     *
     * WHY THIS EXISTS AND WHAT IT MAY BE USED FOR. §V.26 keeps the disc out of
     * `skyDomeColor` because re-adding it to the ocean's REFLECTION paints a
     * clean circular blob: a wind-roughened sea reflects the sun as a glint
     * ROAD, and the water's own specular plus the glint field already own that
     * light. That argument is entirely about reflection off a ROUGH INTERFACE.
     * It does not transfer to TRANSMISSION THROUGH one — looking up from below,
     * the sun is a real object at a real place in a compressed hemisphere, and
     * a Snell's window with no sun in it is the defect the user has now
     * reported four times: the hull's specular blows out, the god rays
     * converge, the caustics dance, and the window that all three are evidence
     * of shows nothing.
     *
     * So: legitimate for the underwater window and for any other TRANSMITTED
     * path. NOT legitimate for the above-water reflected sky, which is why
     * this is a second function and not a flag on the first.
     *
     * §V.40: pure ALU on uniforms this material already holds — one
     * smoothstep, two `pow`, no texture and no sampler. Safe on a stage at
     * 15/16.
     */
    skySunTerm: (dir: ReturnType<typeof vec3>) => sunFor(dir),
    uniforms: { uSunDir, uSunColor, uZenith, uMid, uHaze, uWarm },
    /**
     * Re-derive all ramp-driven uniforms for a new KEY state.
     *
     * `uSunDir` is fed the KEY direction, not the sun's: it drives the haze
     * wedge's forward-scattering lift and the warm mask, and at night the
     * body doing the scattering is the moon. The warm mask costs nothing to
     * hand over because `lowSunWarmth()` is already 0 that far below the
     * horizon, so what the moon inherits is exactly the pale lift on its own
     * quarter of the sky — which is what a moon actually does to a night sky.
     *
     * Everything else keys off `key.sunElevation`: the sky's PALETTE is the
     * sun's business at every hour, and only the KEY changes hands.
     *
     * `wind` is the LIVE wind plus this frame's dt — see `windLines.update`
     * for why it must be `state.wind` and not the `oceanParams` default, and
     * why a dt (rather than a clock) is what a §V.55 accumulator needs.
     */
    update(key: KeyLight, wind: WindFrame): void {
      const sunDir = key.direction;
      const elevation = key.sunElevation;
      uSunDir.value.set(sunDir[0], sunDir[1], sunDir[2]);
      const tint = skyTint(elevation, key.moonWeight);
      const sun = sunColor(elevation);
      // one palette for sky + fog + ambient, crossfaded to golden hour (§T39)
      const pal = skyPalette(elevation, p);
      uZenith.value.copy(tinted(pal.zenith, tint));
      uMid.value.copy(tinted(pal.mid, tint));
      uHaze.value.copy(tinted(pal.horizon, tint));
      uWarm.value.copy(tinted(hexToRgb(p.horizonWarmColor), tint));
      uSunColor.value.setRGB(sun[0], sun[1], sun[2], THREE.SRGBColorSpace);
      uWarmAmount.value = p.horizonWarmStrength * pal.warm;
      uHazeStrength.value = p.hazeStrength;
      uSunHaze.value = p.sunHazeStrength;
      // band SHAPE crossfades on the same weight as the palette's colours,
      // so the signed-off midday geometry is untouched at warm = 0 (§T39)
      const band = bandGeometry(pal.warm, p);
      uHazeFalloff.value = band.hazeFalloff;
      uGradCurve.value = band.gradientCurve;
      uDiscIntensity.value = p.sunDiscIntensity;
      uGlowPower.value = p.sunGlowPower;
      uGlowStrength.value = p.sunGlowStrength;
      uHaloPower.value = p.sunHaloPower;
      uHaloStrength.value = p.sunHaloStrength;
      const [outer, inner] = sunDiscCosines(p.sunDiscSize, p.sunDiscSoftness);
      uDiscCosOuter.value = outer;
      uDiscCosInner.value = inner;

      // ── moon ────────────────────────────────────────────────────────────
      // The moon's own direction, NOT the key's: the disc has to be drawn
      // where the moon is even while the sun still owns the key (a daytime
      // moon is a real and unremarkable sight), and the key's direction is
      // mid-swing through the nadir during the twilight handover.
      const md = key.moonDirection;
      uMoonDir.value.set(md[0], md[1], md[2]);
      // The moon is a GREY body: it has no colour of its own beyond the
      // stylised tint the key carries, and the tint is NOT darkened by the
      // night ramp here because a disc is a source, not a lit surface.
      const mc = hexToRgb(p.moonColor);
      uMoonColor.value.setRGB(mc[0], mc[1], mc[2], THREE.SRGBColorSpace);
      const [mOuter, mInner] = sunDiscCosines(p.moonDiscSize, p.moonDiscSoftness);
      uMoonCosOuter.value = mOuter;
      uMoonCosInner.value = mInner;
      uMoonSinRadius.value = Math.sin((Math.max(0, p.moonDiscSize) * Math.PI) / 180);
      uMoonIntensity.value = p.moonDiscIntensity;
      // k = cos(phase angle): +1 new (nothing lit) → -1 full (all lit).
      // `moonDiscPhase`, NOT `moonPhase` — see the param's docstring. The
      // orbital phase has to stay full (it is what puts the moon low enough at
      // the Night preset to lay a glint road, and what keeps MOON_SURGE from
      // dropping the key to 0.044), while every reference shows a crescent.
      // The disc is the only thing given the crescent.
      const discPhase = Math.min(1, Math.max(0, p.moonDiscPhase));
      uMoonTermK.value = Math.cos(2 * Math.PI * discPhase);
      uMoonTermSoft.value = Math.max(1e-3, p.moonTerminatorSoftness);
      uMoonGlowPower.value = p.moonGlowPower;
      uMoonGlowStrength.value = p.moonGlowStrength;
      uMoonHaloPower.value = p.moonHaloPower;
      uMoonHaloStrength.value = p.moonHaloStrength;
      uMoonBright.value = moonIllumination(discPhase);

      starfield.update(key);
      // uHaze, not a second palette lookup: the streaks must warm on exactly
      // the weight the sky warms on, and a duplicate resolve drifts the moment
      // either side is tuned (§T39).
      windLines.update(key, wind, uHaze.value);
    },
  };
}

export type SkyBackground = ReturnType<typeof createSkyBackground>;
