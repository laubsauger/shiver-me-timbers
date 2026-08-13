/**
 * Sail cloth material (T8 / §V22 sail critique). Two things live here:
 *
 * 1. MOTION. The belly, the luff-shake and the gust ripple are computed in
 *    the vertex stage from the REAL wind and the ship's own heading, so the
 *    cloth fills on a run, backs and shivers when the wind heads it, and
 *    shakes while the ship swings. The drive values come from
 *    sailDynamics.ts through per-object uniforms updated in `onObjectUpdate`
 *    — the ship's world matrix is read off the object itself, so nothing
 *    outside src/ship has to push state in (§V3: read-only on sim data,
 *    wind is read from params/ocean, the same object the sim reads).
 * 2. SHADING. The lee face must read genuinely dark. The old material lifted
 *    every fragment with a flat emissive floor and glowed on ANY backfacing
 *    normal, so both faces looked sunlit. Now transmission needs the viewer
 *    to be looking sunward THROUGH the cloth, and the shaded face gets a
 *    real albedo drop, with vertex normals rebuilt from the live billow so
 *    the curvature shades.
 *
 * §V23: functional mix()/smoothstep() only — chained a.mix(b,t) reads the
 * receiver as the factor (§B.1/§B.2).
 * §V28: every divisor floored, every uniform finite-guarded in sailDynamics.
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  directionToFaceDirection,
  float,
  fract,
  max,
  mix,
  normalLocal,
  normalWorld,
  positionLocal,
  positionWorld,
  smoothstep,
  transformNormalToView,
  uniform,
  uv,
  vec2,
} from 'three/tsl';
import { fbm2, hash2 } from '../terrain/noise';
import {
  bandLimitAmplitude,
  bandLimitWidth,
  bandLimitedEdge,
  coordFilter,
  periodResolved,
} from './bandLimit';
import {
  createSailClothNodes,
  createSailShapeUniforms,
  refreshSailShapeUniforms,
} from './sailClothNodes';
import { skyParams } from '../params/sky';
import { sunDirection } from '../sky/sunCycle';
import { shipMaterialParams, type ShipMaterialParams } from '../params/ship';
import { createSailWindUniforms } from './sailDriver';
import type { ShipMaterialHandle } from './woodMaterial';

/** seam falloff between cloth panels, as a fraction of one panel. Named
 *  because it is also the feature width its §V.48 band limit measures. */
const PANEL_SEAM = 0.045;

/** live sun direction (toward the sun), re-derived from the same pure
 *  function + params the sky rig uses — no wiring through main.ts */
export const uShipSunDirection = /*@__PURE__*/ uniform(
  new THREE.Vector3(0.4, 0.75, 0.3).normalize(),
).onRenderUpdate((): void => {
  const d = sunDirection(skyParams.timeOfDay, skyParams.latitude);
  uShipSunDirection.value.set(d[0], d[1], d[2]);
});

/** off-white weathered canvas: wind-driven shape + backlit translucency */
export function createSailClothMaterial(
  p: ShipMaterialParams = shipMaterialParams,
): ShipMaterialHandle {
  const material = new THREE.MeshStandardNodeMaterial();
  material.side = THREE.DoubleSide; // sails are single surfaces
  material.metalness = 0;
  material.roughness = 0.95;

  const uLight = uniform(new THREE.Color(p.sailLight));
  const uDark = uniform(new THREE.Color(p.sailDark));
  const uWeaveScale = uniform(p.sailWeaveScale);
  const uBacklitColor = uniform(new THREE.Color(p.sailBacklitColor));
  const uBacklitStrength = uniform(p.sailBacklitStrength);
  const uBacklitFocus = uniform(p.sailBacklitFocus);
  const uLeeDarken = uniform(p.sailLeeDarken);
  const uSeamDarken = uniform(p.sailSeamDarken);
  const uSeamRidge = uniform(p.sailSeamRidge);
  const uAmbientLift = uniform(p.sailAmbientLift);
  const uStain = uniform(p.sailStainStrength);
  // the shape's own uniforms live with the shape (sailClothNodes.ts)
  const shape = createSailShapeUniforms(p);

  // per-sail wind state (object uniform buffer, driven in sailDriver.ts)
  const wind = createSailWindUniforms(p);

  // --- shape ---------------------------------------------------------------
  // The whole cloth surface — outline, belly, leech, twist, flutter — lives in
  // sailClothNodes.ts, a line-for-line transliteration of sailShape.ts. This
  // file owns colour and light.
  const cloth3d = createSailClothNodes(wind, shape);
  material.positionNode = cloth3d.position;

  // normals rebuilt from the live surface, so the billow shades. Blended
  // against the authored normal by clothWeight: robands and the furled bundle
  // are not cloth and must keep theirs.
  const localNormal = mix(normalLocal, cloth3d.localNormal, cloth3d.clothWeight).normalize();
  const viewNormal = transformNormalToView(localNormal).toVarying('vSailNormalView').normalize();
  // the cloth's u direction, carried into view space alongside it — the seam
  // ridge below tilts the normal along this and nothing else. The normal
  // matrix is the inverse-transpose, which differs from the modelView upper
  // 3x3 only under non-uniform scale; ship transforms are rigid, so it is the
  // same rotation and one less matrix to plumb through.
  const viewTangentU = transformNormalToView(cloth3d.uTangent).normalize();

  // --- colour --------------------------------------------------------------
  const cloth = uv();
  const warp = fbm2(positionLocal.xy.mul(uWeaveScale).mul(vec2(1, 6)), 2);
  const weft = fbm2(positionLocal.xy.mul(uWeaveScale).mul(vec2(6, 1)), 2);
  const weave = warp.add(weft).mul(0.5);
  const stain = fbm2(positionLocal.xy.mul(0.35), 3);
  /**
   * VERTICAL PANEL SEAMS (user, against
   * docs/inspo/ship/ref-broadside-sails-spray-foam.png: "the full view of the
   * sails with their sewing striping vertically to segment them").
   *
   * A sail is sewn from vertical bolts of canvas, so the COUNT follows the
   * sail's own width — `sailClothWidth` is a bolt in metres, and a wider sail
   * gets more cloths rather than wider ones. It used to be a flat 7 panels on
   * every sail, which made the main course's "cloths" 1.74 m and the
   * topsail's 1.24 m: not a bolt of anything, and different on two sails of
   * the same ship. §V28: floored divisor, and at least two panels.
   *
   * The coordinate is the cloth's own `u`, so the seams ride the DEFORMED
   * surface for nothing: as the arc-length compensation above draws the
   * chord in, the seams compress with it. A seam that curves with the cloth
   * reads as fabric; one painted straight across a curved surface reads as a
   * decal.
   */
  // ONE panel grid, built with the geometry (sailClothNodes) and read here, so
  // the seam's shading sits exactly in the fold the shape put there. Two
  // independent literals is how the lantern ended up beside its own post.
  const panelCoord = cloth3d.panelCoord;
  const panelFilter = coordFilter(panelCoord);
  const panelTone = hash2(vec2(panelCoord.floor(), 3.7));
  // fades to the jitter's own MEAN, not to 1 — 0.92..1.03 averages 0.975, and
  // fading to 1 instead would brighten every distant sail by 2.5%
  const panelToneMul = mix(
    float(0.975),
    mix(float(0.92), float(1.03), panelTone),
    periodResolved(panelCoord, panelFilter),
  );
  const base = mix(uDark, uLight, weave)
    .mul(mix(float(1).sub(uStain), float(1), stain))
    .mul(panelToneMul);

  const pf = fract(panelCoord);
  const panelMask = bandLimitedEdge(pf.min(pf.oneMinus()), panelCoord, float(PANEL_SEAM), panelFilter);
  const hemMask = smoothstep(
    float(0),
    float(0.03),
    cloth.x.min(cloth.x.oneMinus()).min(cloth.y),
  );
  const cloth3 = mix(base.mul(uSeamDarken), base, panelMask.min(hemMask));

  /**
   * THE SEAM'S RIDGE — why the seams read at all.
   *
   * In the reference the seams catch light; they are not merely darker. A
   * sewn seam is a double thickness of canvas standing a few millimetres
   * proud, so it tilts the shading normal. An albedo line alone is flat and
   * reads as a printed stripe.
   *
   * §V.38 SAYS DO NOT DIFFERENTIATE A HEIGHT FIELD HERE, and this is exactly
   * the case that would burn: a ~2.7 cm feature differentiated in screen space
   * on a sail seen at 20-60 m is §B.20's hull speckle verbatim. So the SLOPE
   * is written in closed form instead — the seam's cross-section is a known
   * bump, so its derivative is known too, and nothing is differentiated at
   * all.
   *
   * §V.48, both halves, measured against the SEAM's own width and not the
   * panel's PERIOD — §B.20's whole lesson, and the seam is ~4.5% of a panel,
   * i.e. it goes sub-pixel ~22x sooner than the repeat does:
   *   (a) WIDEN: the bump is drawn at `bandLimitWidth` ≥ 2 px of panelCoord,
   *       so it never varies faster than the sample grid;
   *   (b) FADE: amplitude scaled by `bandLimitAmplitude`. The profile is
   *       ANTISYMMETRIC about the seam, so its mean over a pixel is exactly
   *       zero — fading to zero IS fading to its own mean, and no separate
   *       mean term is needed (see bandLimit.bandLimitAmplitude).
   */
  const seamEff = bandLimitWidth(float(PANEL_SEAM), panelCoord, panelFilter);
  // signed distance to the NEAREST seam, in panels: fract() folded to ±0.5
  const seamDist = pf.sub(pf.add(0.5).floor());
  const t = clamp(seamDist.div(seamEff), float(-1), float(1));
  // d/dt of the bump (1 − t²)² — zero at the crown and at both skirts, so the
  // ridge blends into flat cloth instead of ending on a crease
  const seamSlope = t
    .mul(t.mul(t).oneMinus())
    .mul(-4)
    .mul(uSeamRidge)
    .mul(bandLimitAmplitude(float(PANEL_SEAM), panelCoord, panelFilter));
  material.normalNode = directionToFaceDirection(
    viewNormal.add(viewTangentU.mul(seamSlope)).normalize(),
  );

  // shading normal in world space — normalWorld resolves to the material's
  // own normalNode (set above), so this is the billowed, face-flipped normal
  const sunDot = normalWorld.dot(uShipSunDirection);
  // Lee face albedo drop, but ONLY once the face is genuinely turned away.
  // MEASURED BUG (in-browser): the band used to open at −0.15 and not close
  // until +0.4, so a sun GRAZING the cloth (sunDot ≈ 0, which is most of the
  // day for square sails — their normals are fore-and-aft) darkened BOTH
  // faces to ~0.59 albedo. Sun-side and lee-side screenshots came out
  // identically dark grey, and switching the sun's shadows off changed
  // nothing, which is what proved it was this term and not self-shadowing.
  // Grazing light must now read as fully lit; only a real back-face darkens.
  // the argument is a DOT PRODUCT, not a spatial
  // coordinate. It has no repeat, no feature width and no sub-pixel regime — it
  // varies over the surface at the rate the surface curves. §V.48 is about
  // periodic detail outrunning the sample grid; there is no period here.
  // @band-limited-elsewhere
  const lit = smoothstep(float(-0.45), float(-0.02), sunDot);
  material.colorNode = cloth3.mul(mix(uLeeDarken, float(1), lit));

  // transmission: the sun must be BEHIND the cloth and the viewer looking
  // roughly toward it — not a blanket glow on every backfacing fragment
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const sunward = clamp(uShipSunDirection.dot(viewDir.negate()), float(0), float(1));
  const through = max(sunDot.negate(), float(0)).mul(sunward.pow(uBacklitFocus));
  /**
   * §V44 / §B.16 CLASS, and half of "they have no billow to them".
   *
   * The ambient floor used to be `uBacklitColor × uAmbientLift` added straight
   * into emissive: a near-WHITE constant, identical on every fragment,
   * responding to no normal and no light. Emissive does not scale with albedo
   * or with geometry, so it is a flat pedestal under the entire sail — and a
   * pedestal is exactly what destroys the contrast between the bright shoulder
   * of a belly and the shaded side of it. The cloth can be curved as deeply as
   * you like and still read as a flat white sheet, which is what the user has
   * now reported three times.
   *
   * The floor is still wanted (canvas in shadow must not go dead black), so it
   * stays — but tinted by the cloth's OWN colour, so it reads as dim canvas
   * rather than as glow, and it carries the panel and stain variation instead
   * of washing them out. The backlit transmission lobe is unchanged: that one
   * genuinely is light coming through the cloth and it is already gated on
   * both the sun being behind and the viewer looking toward it.
   */
  material.emissiveNode = uBacklitColor
    .mul(through.mul(uBacklitStrength))
    .add(cloth3.mul(uAmbientLift));

  return {
    material,
    refresh(): void {
      uLight.value.set(p.sailLight);
      uDark.value.set(p.sailDark);
      uWeaveScale.value = p.sailWeaveScale;
      uBacklitColor.value.set(p.sailBacklitColor);
      uBacklitStrength.value = p.sailBacklitStrength;
      uBacklitFocus.value = p.sailBacklitFocus;
      uLeeDarken.value = p.sailLeeDarken;
      uSeamDarken.value = p.sailSeamDarken;
      uSeamRidge.value = p.sailSeamRidge;
      uAmbientLift.value = p.sailAmbientLift;
      uStain.value = p.sailStainStrength;
      refreshSailShapeUniforms(shape, p);
    },
  };
}
