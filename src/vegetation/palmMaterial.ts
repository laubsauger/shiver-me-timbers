/**
 * Palm TSL material (T26). One material for the whole palm, branching on the
 * baked `role` attribute (palmGeometry.ts): trunk gets procedural ringed bark
 * stripes, fronds a two-tone green ramp along their length, coconuts a flat
 * husk tint. Translucency fake: when the sun is behind a frond
 * (dot(normalWorld, sunDir) < 0) a warm green backlit glow is added via
 * emissiveNode — no physical SSS. All colors/knobs live in params/vegetation
 * (§V16) and refresh() re-reads them each frame for live panel tweaks.
 */
import * as THREE from 'three/webgpu';
import { attribute, float, fract, mix, normalWorld, step, uniform, uv } from 'three/tsl';
import { vegetationParams, type VegetationParams } from '../params/vegetation';
// §V.48 — one band-limit implementation project-wide (src/ship for historical
// reasons, §B.20 was found on the hull; the maths carries nothing ship-specific)
import { coordFilter, periodResolved } from '../ship/bandLimit';

/**
 * Nyquist floor for the bark ring edge, in pixels. Two, not one, for the same
 * reason as `FILTER_PIXELS` in bandLimit.ts: at one pixel per transition two
 * neighbouring samples still straddle the whole step.
 */
const RING_FILTER_PIXELS = 2;

export function createPalmMaterial(p: VegetationParams = vegetationParams) {
  const material = new THREE.MeshStandardNodeMaterial();
  material.side = THREE.DoubleSide; // frond strips are single planes
  material.roughness = 0.85;
  material.metalness = 0;

  const uTrunkColor = uniform(new THREE.Color(p.trunkColor));
  const uStripeColor = uniform(new THREE.Color(p.barkStripeColor));
  const uFrondDark = uniform(new THREE.Color(p.frondColorDark));
  const uFrondLight = uniform(new THREE.Color(p.frondColorLight));
  const uBacklitColor = uniform(new THREE.Color(p.backlitColor));
  const uCoconutColor = uniform(new THREE.Color(p.coconutColor));
  const uRingFrequency = uniform(p.barkRingFrequency);
  const uStripeRatio = uniform(p.barkStripeRatio);
  const uBacklitStrength = uniform(p.backlitStrength);
  const uSunDirection = uniform(new THREE.Vector3(0.4, 0.75, 0.3).normalize());

  // role masks: 0 = trunk, 1 = frond, 2 = coconut
  const role = attribute('role', 'float');
  const frondMask = step(float(0.5), role).mul(step(float(1.5), role).oneMinus());
  const coconutMask = step(float(1.5), role);
  const trunkMask = step(float(0.5), role).oneMinus();

  const coords = uv();

  // Trunk: procedural ring stripes along height (uv.y = 0..1 up the trunk).
  //
  // §V.48, NINTH occurrence, and the worst-formed one in the project so far:
  // this was `step(ratio, fract(y·freq))` — a ZERO-WIDTH edge. Every other
  // occurrence had at least some transition to widen; a raw step has none, so
  // no pixel ever samples partway up the wall and it aliases at EVERY
  // distance, not merely past some onset. It also carried §B.20's second
  // failure verbatim: even had the `ratio` edge been softened, `fract` wraps
  // from 1 to 0 once per ring, and that wrap was a hard discontinuity too —
  // the same 1-px hairline the wale strake had.
  //
  // Numbers: `barkRingFrequency` 14 over a 4.4-11.3 m trunk is a ~0.5 m ring,
  // sub-pixel from ~980 m, which is INSIDE `lodPalmCull` (1400 m) — but the
  // zero-width edge is what makes it shimmer at the 50-200 m range where a
  // palm on a beach is the thing you are actually looking at.
  //
  // Cure, both halves of §V.48 as always:
  //  (a) measure distance to the nearest ring CENTRE as a triangle wave, so
  //      the wrap lands inside the stripe instead of on its edge and the
  //      function is continuous everywhere; then widen the edge to at least
  //      RING_FILTER_PIXELS of the ring coordinate's own footprint. That
  //      footprint is `fwidth(ringCoord)`, NOT of the triangle wave, which
  //      kinks once per ring and would report a huge width on every band.
  //  (b) fade to the ring pattern's own MEAN — the stripe covers `ratio` of
  //      each period, so the mean of `ring` is 1 − ratio — which is the colour
  //      a pixel spanning many rings should average to.
  const ringCoord = coords.y.mul(uRingFrequency);
  const ringFilter = coordFilter(ringCoord);
  // triangle wave: distance from the nearest ring centre, 0..0.5, continuous
  const ringDistance = fract(ringCoord.add(0.5)).sub(0.5).abs();
  const halfWidth = uStripeRatio.mul(0.5);
  const halfEff = halfWidth.max(ringFilter.mul(RING_FILTER_PIXELS * 0.5)).max(1e-4);
  // 0 inside the dark stripe, 1 out on the trunk
  const ring = ringDistance.smoothstep(halfWidth.sub(halfEff), halfWidth.add(halfEff));
  const ringLimited = mix(uStripeRatio.oneMinus(), ring, periodResolved(ringCoord));
  const barkColor = mix(uStripeColor, uTrunkColor, ringLimited);

  // fronds: two-tone green, darker at the stem, brighter toward the tip
  const frondColor = mix(uFrondDark, uFrondLight, coords.y);

  material.colorNode = barkColor
    .mul(trunkMask)
    .add(frondColor.mul(frondMask))
    .add(uCoconutColor.mul(coconutMask));

  // backlit boost: normal facing away from the sun → warm green glow
  const backlit = normalWorld.dot(uSunDirection).min(0).negate();
  material.emissiveNode = uBacklitColor.mul(backlit.mul(uBacklitStrength).mul(frondMask));

  return {
    material,
    uSunDirection,
    /** re-read live-tweakable params (Tweakpane mutates them in place) */
    refresh(): void {
      uTrunkColor.value.set(p.trunkColor);
      uStripeColor.value.set(p.barkStripeColor);
      uFrondDark.value.set(p.frondColorDark);
      uFrondLight.value.set(p.frondColorLight);
      uBacklitColor.value.set(p.backlitColor);
      uCoconutColor.value.set(p.coconutColor);
      uRingFrequency.value = p.barkRingFrequency;
      uStripeRatio.value = p.barkStripeRatio;
      uBacklitStrength.value = p.backlitStrength;
    },
  };
}

export type PalmMaterial = ReturnType<typeof createPalmMaterial>;
