/**
 * §V.56 — the sea's own pigment is a FLOOR, not a base layer.
 *
 * CPU TRANSLITERATION PAIR (same pattern as src/ship/bandLimit.ts for §V.48).
 * Every function here is written line-for-line against the TSL in
 * surfaceMaterial.ts's colorNode, so the invariant can be MEASURED in vitest
 * instead of argued about in a screenshot. If you change one side, change the
 * other — tests/ocean.test.ts's "§V.56" block sweeps both axes the defect
 * actually lives on (view AZIMUTH and DISTANCE) and fails if either loses the
 * water's colour.
 *
 * WHY THIS EXISTS AT ALL. Five separate complaints have now been the same
 * complaint: the cow pattern, the teal hull, the rotation blowout, the grazing
 * grey wash, the wake's white curtain. Each was fixed correctly and locally,
 * and none of them left the sea ROBUST to losing its pigment, so a sixth kept
 * arriving. The failure mode is a PRODUCT of individually defensible terms —
 * physical Fresnel → 1 at grazing, a pale sky, foam, haze — and it is invisible
 * to a luminance test, because grey has exactly the luminance it should. Only
 * CHROMA sees it.
 */

/** linear RGB triple */
export type Rgb = readonly [number, number, number];

/** Rec.709 luminance weights — the same vec3 the shader multiplies by */
export const LUMA: Rgb = [0.2126, 0.7152, 0.0722];

export const luminance = (c: Rgb): number =>
  c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];

/**
 * HSV saturation: (max − min) / max. 0 is a perfect grey at ANY brightness,
 * which is exactly the quantity every one of the five defects moved and the
 * one a luminance check cannot see.
 */
export function chroma(c: Rgb): number {
  const hi = Math.max(c[0], c[1], c[2]);
  const lo = Math.min(c[0], c[1], c[2]);
  return hi <= 1e-4 ? 0 : (hi - lo) / hi;
}

/** the water's own hue, brightest channel normalised to 1 (shader: bodyTint) */
export function bodyTint(body: Rgb): Rgb {
  const peak = Math.max(body[0], body[1], body[2], 0.001);
  return [body[0] / peak, body[1] / peak, body[2] / peak];
}

/**
 * smoothstep(e0, e1, x), the functional form the shader uses (§V23).
 * e0 > e1 is LEGAL and load-bearing here — it reads "1 below e1, 0 above e0",
 * the idiom every distance fade in surfaceMaterial.ts uses. Do NOT floor the
 * denominator with `max(ε, e1 − e0)`: that turns the inverted ramp into a
 * divide by ε and the fade fires backwards (cost: one debugging round).
 */
export function smoothstep(e0: number, e1: number, x: number): number {
  const d = e1 - e0;
  if (Math.abs(d) < 1e-9) return x >= e1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - e0) / d));
  return t * t * (3 - 2 * t);
}

/**
 * §V.56 lever 1 — re-saturation of the reflected sky, RAMPED WITH DISTANCE.
 *
 * A single constant cannot serve both ends of the frame. Close water can
 * afford raw Fresnel: you see its body THROUGH the surface (§V.24), so the
 * pigment is present whatever the reflection does, and re-saturating hard
 * there is what made the sea read as over-saturated teal. Distant water is
 * ENTIRELY grazing — Schlick is ≈1, there is no transmission, and the pixel is
 * nothing but reflected sky — so without its pigment handed back it goes grey
 * and washed out, which is the user's report.
 */
export function grazingSaturationAt(
  camDist: number,
  near: number,
  far: number,
  fullDist: number,
): number {
  return near + (far - near) * smoothstep(0, Math.max(1, fullDist), camDist);
}

/** shader: mix(sky, sky·bodyTint, sat) — keeps the sky's VALUE, not its whiteness */
export function resaturate(sky: Rgb, tint: Rgb, sat: number): Rgb {
  const s = Math.min(1, Math.max(0, sat));
  return [
    sky[0] * (1 - s) + sky[0] * tint[0] * s,
    sky[1] * (1 - s) + sky[1] * tint[1] * s,
    sky[2] * (1 - s) + sky[2] * tint[2] * s,
  ];
}

/**
 * §V.56 lever 2 — THE FLOOR ITSELF, and the only place in the material that
 * is allowed to be a stylisation rather than a physical term.
 *
 * §V.20 is a LOOK bar, not a physics bar. If honest Fresnel against a pale sky
 * means a correct equation deletes the sea's colour, the stylisation has to
 * push back somewhere DELIBERATE and NAMED rather than the look quietly being
 * lost. This is that place, and it is the last word on the composite: it acts
 * on the SUM of every term (reflection, transmission, foam, glint), not on any
 * one of them, which is the §V.49 lesson applied to a whole material.
 *
 * It engages only BELOW the floor, so a sea that is already coloured is
 * untouched — bit-exact, not "nearly". Value is preserved: the tinted result
 * is renormalised by the tint's own luminance, so this restores hue without
 * darkening the frame (§V.44 — bounded, and a multiply, never a subtraction).
 */
export function pigmentFloor(
  col: Rgb,
  tint: Rgb,
  floor: number,
  strength = 1,
): Rgb {
  // 1 when the pixel is fully grey, 0 once it reaches the floor
  const need = smoothstep(floor, 0, chroma(col)) * Math.min(1, Math.max(0, strength));
  if (need <= 0) return [col[0], col[1], col[2]];
  const norm = Math.max(1e-4, luminance(tint));
  const t: Rgb = [
    (col[0] * tint[0]) / norm,
    (col[1] * tint[1]) / norm,
    (col[2] * tint[2]) / norm,
  ];
  return [
    col[0] + (t[0] - col[0]) * need,
    col[1] + (t[1] - col[1]) * need,
    col[2] + (t[2] - col[2]) * need,
  ];
}

/** Schlick, the shader's exact form */
export function fresnel(cosTheta: number, r0: number): number {
  const c = Math.min(1, Math.max(0, cosTheta));
  return Math.min(1, Math.max(0, r0 + (1 - r0) * Math.pow(1 - c, 5)));
}

/**
 * The sky's radiance toward `dir`, sun disc EXCLUDED — a transliteration of
 * `skyDomeColor` in src/sky/skyBackground.ts. It is here so the sweep below
 * can vary AZIMUTH, which is the axis the old elevation-only ramp could not
 * see at all.
 */
export interface SkyDomeCpu {
  mid: Rgb;
  zenith: Rgb;
  haze: Rgb;
  warm: Rgb;
  sunDir: Rgb;
  hazeStrength: number;
  hazeFalloff: number;
  sunHaze: number;
  warmAmount: number;
  gradientCurve: number;
}

export function skyDomeCpu(dir: Rgb, p: SkyDomeCpu): Rgb {
  const lift = Math.max(0, dir[1]);
  const height = Math.pow(lift, Math.max(1e-3, p.gradientCurve));
  const mixc = (a: Rgb, b: Rgb, t: number): Rgb => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  const body = mixc(p.mid, p.zenith, height);
  const d = dir[0] * p.sunDir[0] + dir[1] * p.sunDir[1] + dir[2] * p.sunDir[2];
  const sunSide = d * 0.5 + 0.5;
  const band = Math.min(
    1,
    Math.max(0, Math.exp(-lift / Math.max(1e-3, p.hazeFalloff))),
  );
  const hazeAmt = Math.min(1, Math.max(0, band * (p.hazeStrength + sunSide * p.sunHaze)));
  const hazed = mixc(body, p.haze, hazeAmt);
  const warmMask = Math.min(1, Math.max(0, band * sunSide * sunSide * p.warmAmount));
  return mixc(hazed, p.warm, warmMask);
}

export interface SeaSample {
  /** unit reflection ray (world) */
  refl: Rgb;
  /** cos of the angle between view and surface normal */
  cosTheta: number;
  camDist: number;
  body: Rgb;
  sky: SkyDomeCpu;
  fresnelR0: number;
  reflectionStrength: number;
  grazingSaturation: number;
  grazingSaturationFar: number;
  grazingSaturationFullDist: number;
  pigmentFloorChroma: number;
  pigmentFloorStrength: number;
  /** 0..1 how far this pixel has melted into the haze colour */
  hazeT: number;
  hazeColor: Rgb;
}

/**
 * The colour-critical path of the composite, in the shader's own order:
 *   sky = skyDome(refl)
 *   skyRefl = resaturate(sky, bodyTint, grazingSaturationAt(dist))
 *   col = mix(body, skyRefl, F·reflectionStrength)
 *   col = pigmentFloor(col, bodyTint, …)          ← §V.56, on the SUM
 *   col = mix(col, haze, hazeT)
 * Foam and glint are deliberately absent: they are additive on top and only
 * ever push the same way, so a floor that holds without them holds with them
 * only if the floor is applied to the sum — which is why it sits where it does.
 */
export function seaColorCpu(s: SeaSample): Rgb {
  const tint = bodyTint(s.body);
  const sky = skyDomeCpu(s.refl, s.sky);
  const sat = grazingSaturationAt(
    s.camDist,
    s.grazingSaturation,
    s.grazingSaturationFar,
    s.grazingSaturationFullDist,
  );
  const skyRefl = resaturate(sky, tint, sat);
  const w = Math.min(1, fresnel(s.cosTheta, s.fresnelR0) * s.reflectionStrength);
  let col: Rgb = [
    s.body[0] + (skyRefl[0] - s.body[0]) * w,
    s.body[1] + (skyRefl[1] - s.body[1]) * w,
    s.body[2] + (skyRefl[2] - s.body[2]) * w,
  ];
  col = pigmentFloor(col, tint, s.pigmentFloorChroma, s.pigmentFloorStrength);
  const h = Math.min(1, Math.max(0, s.hazeT));
  return [
    col[0] + (s.hazeColor[0] - col[0]) * h,
    col[1] + (s.hazeColor[1] - col[1]) * h,
    col[2] + (s.hazeColor[2] - col[2]) * h,
  ];
}
