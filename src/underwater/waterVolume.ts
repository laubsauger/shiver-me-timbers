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
 * THE FRACTION IS SYMMETRIC, which is what makes it robust. With `a` and `b`
 * the signed heights of the two segment ends relative to the sea plane,
 *
 *     frac = clamp( -min(a,b) / (max(a,b) - min(a,b)), 0, 1 )
 *
 * covers all four cases (both under → 1, both above → 0, either crossing →
 * the true partial) with no branches, and — because the underwater fraction of
 * a segment cannot depend on which end you walk from — it needs no knowledge
 * of whether the camera or the fragment is the submerged one. The horizontal
 * ray (a == b) is the degenerate case: the floored divisor (§V.28) sends the
 * quotient to ±1/ε, which clamps to exactly 1 when under and 0 when above.
 * That is the correct answer, so the guard and the maths agree rather than the
 * guard papering over the maths.
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
import { exp, float, max, min, mix, screenUV, vec3, vec4, uniform } from 'three/tsl';
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
  };
}

export function buildWaterVolume(
  scenePass: ShaderNodeObject<PassNode>,
  v: VolumeUniforms,
  /** day-cycle tint owned by index.ts — dims the inscatter after dark */
  dayTint: ShaderNodeObject<UniformNode<THREE.Color>>,
  /**
   * 0..1 camera submersion (submersion.ts). SINGLE-OWNER GATE, not a fade:
   * while the camera is ABOVE the surface, absorption through the water is
   * already owned by the ocean material's §V.24 see-through path (it
   * attenuates a submerged hull by its own probe thickness). Applying the
   * volume there too would extinguish the same water twice. Scaling the path
   * length by `blend` hands the above-water case back to surfaceMaterial
   * whole, keeps the submerged case entirely ours, and leaves the crossing —
   * where the split shape comes from the per-pixel fraction, not from this —
   * sharing them continuously with no pop (§V.25).
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
  const ndc = screenUV.mul(2).sub(1);
  const clip = vec4(ndc.x, ndc.y, 0.5, 1);
  const vh = v.invProj.mul(clip);
  const vpos = vh.xyz.div(vh.w);
  const rayView = vpos.div(vpos.z.negate().max(1e-6)); // §V.28 floored divisor
  const fragView = rayView.mul(viewDist);
  const fragWorld = v.camWorld.mul(vec4(fragView, 1)).xyz;

  const toFrag = fragWorld.sub(v.camPos);
  const rayLen = toFrag.length();

  // ── submerged fraction of the segment (see header) ────────────────────
  const a = v.camPos.y.sub(v.seaY);
  const b = fragWorld.y.sub(v.seaY);
  const lo = min(a, b);
  const hi = max(a, b);
  // §V.28: floored divisor. The horizontal-ray degenerate case resolves
  // CORRECTLY through this floor rather than in spite of it — see header.
  const frac = lo.negate().div(hi.sub(lo).max(1e-4)).saturate();
  const underLen = rayLen.mul(frac).mul(blend);

  // ── per-channel Beer–Lambert ──────────────────────────────────────────
  // `submergedPathScale` is the same honest-path multiplier the hull uses:
  // the receiver only knows its own depth, but light also travels back to the
  // eye through water.
  const k = uAbsorb.mul(uMurk).mul(uPathScale);
  const transmit = exp(k.mul(underLen).negate());

  // ── inscattered water colour ──────────────────────────────────────────
  // Deepens with the CAMERA's depth (the body of water you are inside of),
  // then darkens for rays pointing down, where less skylight has reached.
  const camDepth = v.seaY.sub(v.camPos.y).max(0);
  const depthT = camDepth.div(uDepthRange.max(1e-3)).saturate();
  const body = mix(uShallow, uDeep, depthT).mul(dayTint);
  // ray elevation: +1 straight up, -1 straight down
  const rayUp = toFrag.y.div(rayLen.max(1e-3));
  const downFade = mix(float(1), float(1).sub(uDownDarken), rayUp.negate().saturate());
  const inscatter = body.mul(downFade);

  return {
    apply(rgb): ShaderNodeObject<Node> {
      // L = L_surface·T + L_water·(1 − T), per channel (§V.44: the water term
      // is a MULTIPLY on what arrives plus a bounded inscatter, never a
      // negative addend).
      return rgb.mul(transmit).add(inscatter.mul(vec3(1).sub(transmit)));
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
 * CPU mirror of the submerged-fraction expression above, for the unit tests.
 * Kept literally identical in shape (min/max/floored divisor/saturate) so a
 * change to one that is not made to the other shows up as a test failure
 * rather than as a look regression nobody can trace.
 *
 * @param a signed height of segment end A relative to the sea plane
 * @param b signed height of segment end B relative to the sea plane
 * @returns fraction of the segment lying below the plane, ∈ [0, 1]
 */
export function submergedFraction(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.min(1, Math.max(0, -lo / Math.max(hi - lo, 1e-4)));
}

/**
 * CPU mirror of the per-channel transmittance. `k` is the Jerlov coefficient
 * for one channel in 1/m, `len` the submerged path length in metres.
 */
export function transmittance(k: number, len: number, murkiness = 1, pathScale = 1): number {
  return Math.exp(-Math.max(0, k) * Math.max(0, murkiness) * Math.max(0, pathScale) * Math.max(0, len));
}
