/**
 * The water VOLUME (§V.25, §T.29) — per-channel Beer–Lambert extinction over
 * the length of each view ray that actually lies under the surface.
 *
 * WHY THIS EXISTS AT ALL. Dipping the camera under used to give a flat pale
 * void: the sky background filled every pixel the ocean mesh did not cover,
 * because nothing in the frame knew it was looking THROUGH water. There is no
 * such thing as "empty" underwater — the volume itself is the picture.
 *
 * THE MODEL, and why it is per-PIXEL and not per-CAMERA. At the waterline
 * crossing the camera sits exactly ON the surface: rays going down travel
 * through water, rays going up travel through air, in the SAME frame. A single
 * `blend` scalar (which is all submersion.ts publishes) cannot express that —
 * it can only fog the whole image uniformly, which is a filter, not a split
 * view. So we compute, for every pixel, the fraction of the camera→fragment
 * segment that lies below the sea plane, and extinguish by THAT length. The
 * meridian then falls out of the geometry instead of being drawn on.
 *
 * THE PATH IS MEASURED FROM THE CAMERA OUT, NOT BETWEEN THE TWO ENDS. This
 * replaces a symmetric two-ended fraction
 *
 *     frac = clamp( -min(a,b) / (max(a,b) - min(a,b)), 0, 1 )     // WRONG
 *
 * which was elegant, branchless, order-independent, provably correct for a
 * planar interface — and produced a solid green-blue frame every time the
 * camera crossed the waterline (user report: "a green-blue solid colour
 * covering the frame... it shouldn't be blue while we're already back out").
 *
 * THE REASON IT FAILED is that its second endpoint is not on the interface it
 * is measured against. `seaY` is one horizontal plane, sampled at the CAMERA's
 * XZ. The far end of most rays in this frame is a point on the ocean CLIPMAP,
 * whose real height is its own wave displacement kilometres away. A distant
 * fragment sitting in a 1.5 m trough reads as 1.5 m "below the plane", so the
 * formula reports 88% of a 3 km ray as submerged — 2.6 km of water — when the
 * true answer is zero and the camera is in open air. Two ends, two different
 * definitions of where the sea is (§V.8, and the exact failure §V.33/§V.51
 * describe: the surface is displaced, so a plane through the eye is not the
 * surface anywhere but under the eye).
 *
 * So: ask the question the camera can actually answer. The eye knows its OWN
 * depth exactly, because `seaY` is sampled at its own XZ where the plane and
 * the displaced surface do coincide. Everything else is ray direction:
 *
 *     underLen = min( rayLen, (camDepth + rise) / max(dirY, ε) )
 *
 * where `rise` is how much higher the surface is AT THE FRAGMENT than under
 * the eye — because the exit is a point on a displaced wave, not on a plane
 * (§V.71). Without it the tint terminates on a straight horizontal line and
 * crests draw through it unfogged; see the `rise` block below for the
 * derivation and the cap.
 *
 * Above the surface the numerator is 0, so the volume is the exact identity on
 * every pixel — no lag, no residue, and §V.24's see-through path keeps sole
 * ownership of the above-water case (see `blend` below). Submerged, an upward
 * ray exits after depth/dirY metres; a downward or level one never exits, and
 * the code SAYS so with a select instead of leaning on the §V.28 floor to
 * stand in for infinity. It cannot: `depth/ε` is only past any reachable
 * `rayLen` while depth is large, so at 1 cm under, ε = 1e-4 would cap the
 * lower half of the frame at 100 m of water rather than the whole ray. The
 * floor stays for what it is actually for — a grazing upward ray must not
 * divide by zero.
 *
 * SNELL'S WINDOW'S FALLOFF IS STILL FREE, and is the same expression: path
 * length grows as 1/sin(elevation), so straight up is one depth of water and
 * the horizon closes exponentially. Note this is only the window's ATTENUATION
 * — what is drawn INSIDE it (the refracted sky, the n² radiance gain, the
 * critical angle) belongs to src/ocean/surfaceMaterial.ts's backface branch,
 * which is where the window itself lives.
 *
 * COEFFICIENTS ARE NOT OURS. Extinction is `submergedAbsorption*` from
 * params/caustics — Jerlov K_d in 1/m, the SAME numbers the hull tint and the
 * caustics already attenuate by (§V.34 header). They are NOT a colour and get
 * no sRGB transfer (§V.31 applies to `*Color` keys only), so they enter as a
 * raw Vector3. Authoring a second set here is what would make the sea and the
 * things in it disagree about how deep they are. `murkiness` is a single
 * scalar ON that shared vector — a Jerlov water TYPE, not a second set.
 *
 * THE VISIBILITY LIMIT IS FREE. K_blue = 0.03/m puts transmittance at 5% by
 * ~100 m, so the horizon closes on its own and the §V.30 "4 km of readable
 * sea" simply stops applying under the surface. No separate far-clip, no fog
 * wall — the same exponential does both jobs.
 *
 * §V.57: every node here is a PURE EXPRESSION — no `assign`, no `.toVar()`.
 * That is deliberate (cf. §B.31/§B.32): a graph with no mutators is
 * stage-agnostic and cannot be silently dropped by being built outside a live
 * `Fn()` body, which removes the risk class instead of containing it.
 * §V.23: 3-arg maths uses the functional `mix`/`smoothstep` forms only.
 */
import * as THREE from 'three/webgpu';
import { exp, float, min, mix, screenUV, select, vec2, vec3, vec4, uniform } from 'three/tsl';
import type { Node, PassNode, UniformNode } from 'three/webgpu';
import type { ShaderNodeObject } from 'three/tsl';
import { underwaterParams as p } from '../params/underwater';
import { causticsParams as cp } from '../params/caustics';

/**
 * Camera state the volume needs, pushed per frame from the REAL scene camera.
 *
 * These are our own uniforms rather than TSL's `cameraWorldMatrix` /
 * `cameraProjectionMatrixInverse` on purpose. `PostProcessing` draws a
 * fullscreen quad through its own internal camera, so the built-in camera
 * accessors resolve against THAT camera inside a post output node, not against
 * the one the scene was rendered with. Feeding them ourselves from
 * `update()` removes the ambiguity entirely (§V.28: caller-fed uniforms are
 * finite-guarded at the push site).
 */
export interface VolumeUniforms {
  /** inverse projection of the SCENE camera */
  invProj: ShaderNodeObject<UniformNode<THREE.Matrix4>>;
  /** world matrix of the SCENE camera (view → world) */
  camWorld: ShaderNodeObject<UniformNode<THREE.Matrix4>>;
  /** world-space camera position */
  camPos: ShaderNodeObject<UniformNode<THREE.Vector3>>;
  /** sea surface height (m) at the camera's own XZ — the split plane */
  seaY: ShaderNodeObject<UniformNode<number>>;
  /**
   * How far above `seaY` a crest may reach near the eye, in metres — the LIVE
   * envelope, measured off the same height function the hull floats on (§V.8),
   * never authored. See `rise` below for what it is for and why it is a CAP
   * rather than a height.
   */
  waveRise: ShaderNodeObject<UniformNode<number>>;
}

export interface WaterVolume {
  /**
   * Apply the volume to a scene-linear HDR rgb node. Returns rgb.
   * Call with the RAW scene colour, before bloom/god rays: fog reduces
   * radiance, so anything additive downstream must see the fogged image or it
   * blooms light that the water already absorbed.
   */
  apply(rgb: ShaderNodeObject<Node>): ShaderNodeObject<Node>;
  updateFromParams(): void;
}

export function createVolumeUniforms(): VolumeUniforms {
  return {
    invProj: uniform(new THREE.Matrix4()),
    camWorld: uniform(new THREE.Matrix4()),
    camPos: uniform(new THREE.Vector3()),
    seaY: uniform(0),
    waveRise: uniform(1),
  };
}

export function buildWaterVolume(
  scenePass: ShaderNodeObject<PassNode>,
  v: VolumeUniforms,
  /** day-cycle tint owned by index.ts — dims the inscatter after dark */
  dayTint: ShaderNodeObject<UniformNode<THREE.Color>>,
  /**
   * 0..1 camera submersion (submersion.ts). SINGLE-OWNER GATE: while the
   * camera is ABOVE the surface, absorption through the water is already owned
   * by the ocean material's §V.24 see-through path (it attenuates a submerged
   * hull by its own probe thickness). Applying the volume there too would
   * extinguish the same water twice. The geometry above now hands that case
   * back to surfaceMaterial on its own — above the surface `underLen` is
   * identically 0 — so this is the anti-chatter smoother, nothing more:
   * §V.25's rate-limited, hysteresis-banded ramp, so chop across the eye
   * cannot strobe the whole frame.
   *
   * IT MIXES THE RESULT. It used to scale the PATH LENGTH, which is not a fade
   * at all: extinction is exp(−k·L), so on a 3 km ray blend had to fall below
   * ~0.003 before one photon survived. Measured against the CPU mirrors, blend
   * 0.03 still extinguished the distant sea by 96%, and since `smooth01` parks
   * blend at 0.028 for a camera 0.2 m above the water — inside the 0.5 m
   * hysteresis band — the tint never left at all while the camera sat there.
   * A continuous gate that produces a step is a §V.25 pop with extra steps.
   * Mixing the finished colour makes the ramp mean what it says.
   */
  blend: ShaderNodeObject<UniformNode<number>>,
): WaterVolume {
  // Jerlov K_d (1/m). NOT a colour — raw vector, no transfer function.
  const uAbsorb = uniform(
    new THREE.Vector3(cp.submergedAbsorptionR, cp.submergedAbsorptionG, cp.submergedAbsorptionB),
  );
  const uMurk = uniform(p.murkiness);
  // a LIVE uniform, not `float(cp.submergedPathScale)`: baking it would make
  // the caustics panel silently lie about a value it shares with us (§V.16).
  const uPathScale = uniform(cp.submergedPathScale);
  const uShallow = uniform(new THREE.Color(p.fogColorShallow));
  const uDeep = uniform(new THREE.Color(p.fogColorDeep));
  const uDepthRange = uniform(p.fogDepthRange);
  const uDownDarken = uniform(p.downwardDarkening);

  const viewZ = scenePass.getViewZNode();
  // positive distance along the view axis to whatever was drawn at this pixel.
  // Background pixels sit at the far plane, so rays that never hit the ocean
  // mesh get a huge length and extinguish to pure water — which is exactly
  // what "you cannot see the bottom" should look like.
  const viewDist = viewZ.negate();

  // ── reconstruct this pixel's world position from depth ────────────────
  // z = 0.5 is any point on the ray; dividing by w and then rescaling so the
  // view-space z is exactly -1 turns it into a direction with unit forward
  // component, which `viewDist` then scales to the real fragment.
  // Y IS INVERTED ON THE WAY TO NDC. `screenUV` is 0 at the TOP of the frame on
  // both backends (WGSL reads `fragCoord` directly, the GLSL path flips
  // `gl_FragCoord` to match), while NDC y is +1 at the top — so the conversion
  // is (1 − v)·2 − 1, not v·2 − 1. Three writes the same flip explicitly in
  // `getViewPosition()` (`screenPosition.y.oneMinus()`, PostProcessingUtils.js).
  // Without it every reconstructed ray is mirrored about the horizontal
  // midline, which SIGN-FLIPS `rayUp` below: Snell's window opens downward, the
  // downward darkening lands on the upward half of the frame, and the submerged
  // path length is measured for the wrong hemisphere (an upward ray gets the
  // never-exits arm and reads the whole ray as water). Same defect as the god
  // rays' mirrored sun — see core/postGodRays.ts.
  const ndc = vec2(screenUV.x, screenUV.y.oneMinus()).mul(2).sub(1);
  const clip = vec4(ndc.x, ndc.y, 0.5, 1);
  const vh = v.invProj.mul(clip);
  const vpos = vh.xyz.div(vh.w);
  const rayView = vpos.div(vpos.z.negate().max(1e-6)); // §V.28 floored divisor
  const fragView = rayView.mul(viewDist);
  const fragWorld = v.camWorld.mul(vec4(fragView, 1)).xyz;

  const toFrag = fragWorld.sub(v.camPos);
  const rayLen = toFrag.length();
  // ray elevation: +1 straight up, −1 straight down. ONE owner — the path
  // length and the downward-darkening below are the same question about the
  // same ray, and computing it twice is how they would drift apart.
  const rayUp = toFrag.y.div(rayLen.max(1e-3));

  // ── submerged path length of THIS ray (see header) ────────────────────
  // The camera's own depth is exact: `seaY` is sampled at its XZ, the one
  // place the split plane and the displaced surface actually coincide. It is
  // the ONLY thing that can switch the volume on — the far endpoint gets a
  // vote on where the ray EXITS (see `rise`) but never on whether there is any
  // water at all, because reading the far end against this plane as a second
  // depth is what put a solid green-blue wash over the frame at every crossing.
  const camDepth = v.seaY.sub(v.camPos.y).max(0);
  // THE SURFACE THE RAY EXITS THROUGH IS NOT A PLANE (§V.71, and the fourth
  // report of this shape in this project). `camDepth/rayUp` alone answers
  // "where does this ray cross the horizontal plane y = seaY", and the sea is
  // a Tessendorf FFT with metres of vertical displacement, so that plane cuts
  // straight through the swell. The visible consequence, and the user's exact
  // words: "the underwater tint is a straight line instead of following the
  // shape of the water surface... part of the wave above it revealing an
  // untinted view". A crest 2 m proud of the local sea level, 30 m away, is
  // seen at rayUp ≈ 0.1; the plane says the ray left the water after 10 m, so
  // 20 m of water is simply not drawn and the crest reads unfogged. Because
  // that clamp is a function of screen ELEVATION ONLY it is constant along
  // every horizontal line of the frame — hence a straight edge, with the waves
  // poking through it.
  //
  // NOT a regression of the two-ended `submergedFraction` fix above: that one
  // deleted the FAR endpoint because it was measured against the wrong plane.
  // This is the residual half of the same §V.8 error — the near endpoint's
  // plane was left standing in for the whole surface.
  //
  // THE FIX IS THE FRAGMENT'S OWN HEIGHT, and it is exact where it matters.
  // Every upward ray in a submerged frame terminates on the ocean clipmap
  // (the mesh writes depth, so it also wins over anything in the air behind
  // it), so the drawn fragment IS the exit point, and `rise` is how much
  // higher the surface is there than under the eye. Substituting: the exit
  //     (camDepth + rise)/rayUp  ==  rayLen
  // identically when the fragment is on the surface, so the min() stops
  // clipping crests and the boundary becomes the wave. Over a TROUGH the
  // fragment is nearer than the plane crossing and min() already took it, so
  // `rise` clamps at 0 and nothing changes.
  //
  // WHY IT IS CAPPED at `waveRise` rather than trusted. `fragWorld.y` is not
  // guaranteed to be a surface point: a background pixel sits on the far plane
  // (kilometres up), and a coarse near-field triangle can miss a 1 cm-deep
  // exit and hand back a crest 50 m away. Capping `rise` at the LIVE crest
  // envelope bounds the worst case at a few metres of extra water — the old
  // behaviour is the floor of the range, the true answer is inside it, and
  // nothing can run away. §V.8: that envelope is sampled off `cpuOcean`'s own
  // height function in index.ts, never authored, so it tracks the sea state
  // the ship is actually floating on.
  const rise = fragWorld.y.sub(v.seaY).clamp(0, v.waveRise.max(0));
  const exitLen = camDepth.add(rise).div(rayUp.max(1e-4));
  // An upward ray breaks the surface after that many metres. A downward or
  // level one never does, and that is stated as a SELECT rather than leaned on
  // the §V.28 floor: `depth/ε` is only "past any reachable rayLen" while depth
  // is large, so at 1 cm under, a floor of 1e-4 caps the lower half of the
  // frame at 100 m of water instead of the whole ray. The unit test caught
  // exactly that. The floor stays where it belongs — keeping a grazing upward
  // ray from dividing by zero.
  //
  // THE `camDepth > 0` GATE IS NOW THE OUTER SELECT, and that is load-bearing
  // rather than tidier: with `rise` in the numerator the upward arm is no
  // longer identically 0 above the surface, so the exact above-water identity
  // (§V.24 owns that case, and a lapse there is the solid green-blue frame in
  // the header) has to be stated instead of falling out.
  const underLen = select(
    camDepth.greaterThan(0),
    select(rayUp.greaterThan(0), min(rayLen, exitLen), rayLen),
    float(0),
  );

  // ── the light's own leg, which is NOT the eye's ───────────────────────
  // `submergedPathScale` = 1.4 exists because a RECEIVER only knows its own
  // depth: the seabed is lit by light that already sank to it, so the eye→
  // fragment segment understates the water the photons crossed. Applying it
  // as a flat multiplier on `underLen` charges that same 40% to Snell's
  // window, where the eye→surface path is the ENTIRE path — the light was in
  // air one metre earlier. One scalar cannot serve both, so it is split: the
  // extra leg is the FRAGMENT'S OWN DEPTH, which we have exactly.
  //
  // It agrees with the old model in its canonical case (looking straight down
  // at a seabed 40 m under: 40 + 0.4·40 = 56 m either way) and diverges where
  // the old one was wrong — 0 extra metres on a surface fragment, so the
  // window brightens by the 40% it was never owed, most visibly in RED, which
  // is where the sunset lives (K_r = 0.36/m: at 10 m down the red through the
  // window goes 0.006 → 0.027 transmitted).
  //
  // Gated by the same `camDepth > 0` as the eye leg, or a seabed 40 m below a
  // camera in open air would fog the frame the moment it left the water.
  const sinkLen = select(
    camDepth.greaterThan(0),
    v.seaY.sub(fragWorld.y).max(0).mul(uPathScale.sub(1).max(0)),
    float(0),
  );

  // ── per-channel Beer–Lambert ──────────────────────────────────────────
  const k = uAbsorb.mul(uMurk);
  const transmit = exp(k.mul(underLen.add(sinkLen)).negate());

  // ── inscattered water colour ──────────────────────────────────────────
  // Deepens with the CAMERA's depth (the body of water you are inside of),
  // then darkens for rays pointing down, where less skylight has reached.
  const depthT = camDepth.div(uDepthRange.max(1e-3)).saturate();
  const body = mix(uShallow, uDeep, depthT).mul(dayTint);
  const downFade = mix(float(1), float(1).sub(uDownDarken), rayUp.negate().saturate());
  const inscatter = body.mul(downFade);

  return {
    apply(rgb): ShaderNodeObject<Node> {
      // L = L_surface·T + L_water·(1 − T), per channel (§V.44: the water term
      // is a MULTIPLY on what arrives plus a bounded inscatter, never a
      // negative addend).
      const fogged = rgb.mul(transmit).add(inscatter.mul(vec3(1).sub(transmit)));
      // §V.23 functional mix. blend crossfades the FINISHED colour — see the
      // `blend` param docs for why scaling the path length instead turned a
      // continuous gate into a step.
      return mix(rgb, fogged, blend);
    },
    updateFromParams(): void {
      (uAbsorb.value as THREE.Vector3).set(
        cp.submergedAbsorptionR,
        cp.submergedAbsorptionG,
        cp.submergedAbsorptionB,
      );
      uMurk.value = p.murkiness;
      uPathScale.value = cp.submergedPathScale;
      (uShallow.value as THREE.Color).set(p.fogColorShallow);
      (uDeep.value as THREE.Color).set(p.fogColorDeep);
      uDepthRange.value = p.fogDepthRange;
      uDownDarken.value = p.downwardDarkening;
    },
  };
}

/**
 * CPU mirror of the submerged-path-length expression above, for the unit
 * tests. Kept literally identical in shape (clamped depth / floored divisor /
 * min against the ray) so a change to one that is not made to the other shows
 * up as a test failure rather than as a look regression nobody can trace.
 *
 * It takes the CAMERA's depth and the RAY's direction and nothing else. That
 * is the whole point of the rewrite: the previous mirror, `submergedFraction`,
 * took the signed heights of BOTH segment ends, and the far end is a point on
 * a displaced wave measured against a plane sampled kilometres away. It is
 * deleted rather than deprecated — leaving it exported would let the old
 * question keep being asked.
 *
 * `rise` is the §V.71 half: the surface at the far end is a displaced wave,
 * not the plane through the eye, and leaving it out is what drew the tint as a
 * straight horizontal line with crests poking through it unfogged.
 *
 * @param camDepth metres the camera is below the sea plane (≤ 0 → above it)
 * @param rayUp ray elevation, +1 straight up, −1 straight down
 * @param rayLen distance to whatever this pixel drew, in metres
 * @param rise metres the surface at the fragment stands above `seaY`, already
 *        capped at the live crest envelope by the caller (negative → 0)
 * @returns metres of water on this ray, ∈ [0, rayLen]
 */
export function submergedPathLength(
  camDepth: number,
  rayUp: number,
  rayLen: number,
  rise = 0,
): number {
  const depth = Math.max(0, camDepth);
  const len = Math.max(0, rayLen);
  // §V.24 owns every pixel above the surface, and with `rise` in the numerator
  // that is no longer implied by the arithmetic — so it is said first.
  if (depth <= 0) return 0;
  // upward: exits where the ray meets the SURFACE, which stands `rise` metres
  // higher out there than it does over the eye. Otherwise it never exits, so
  // the whole ray is water.
  if (rayUp > 0) {
    return Math.min(len, (depth + Math.max(0, rise)) / Math.max(rayUp, 1e-4));
  }
  return len;
}

/**
 * CPU mirror of the LIGHT's own leg — the metres of water the photons crossed
 * on their way DOWN to the fragment, which the eye→fragment segment does not
 * contain. This is the half of `submergedPathScale` that Snell's window must
 * not be charged for: a surface fragment has zero depth, so it pays nothing,
 * while a seabed 40 m down pays 40·(scale−1).
 *
 * @param fragDepth metres the fragment sits below the sea plane (≤ 0 → 0)
 * @param pathScale `causticsParams.submergedPathScale`; ≤ 1 → no extra leg
 */
export function lightSinkLength(fragDepth: number, pathScale: number): number {
  return Math.max(0, fragDepth) * Math.max(0, pathScale - 1);
}

/**
 * CPU mirror of the per-channel transmittance. `k` is the Jerlov coefficient
 * for one channel in 1/m, `len` the submerged path length in metres.
 */
export function transmittance(k: number, len: number, murkiness = 1, pathScale = 1): number {
  return Math.exp(-Math.max(0, k) * Math.max(0, murkiness) * Math.max(0, pathScale) * Math.max(0, len));
}
