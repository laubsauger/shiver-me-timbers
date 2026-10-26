/**
 * The Drift's air (from orbit in Act 2, at sea level after it): single scattering, Rayleigh + Mie, in an
 * exponential atmosphere 100 km deep, its sunlight analytic. Shared by the Earth (earth.ts: the limb, the
 * terminator, the haze over the ground) and the sea-level sky (wandering/seaSky.ts), so the descent to the
 * water and the sky over it are one sky.
 *
 * WHY THE SUNLIGHT IS ANALYTIC: at dawn every light path is grazing, where a few uniform march steps get the
 * optical depth (and so the colour) badly wrong. The column of air along a ray in an exponential atmosphere
 * is a Chapman function: √(πx/2)·erfcx(√(x/2)·μ) with a rational erfcx, and the tangent-point identity below
 * the horizon (`chapmanColumn`).
 *
 * FROM THE GROUND it needs two more things (`GROUND`; Act 2's look from orbit was set without them, `ORBIT`).
 * They matter little from orbit and a lot at sea level. OZONE (a layer ~25 km up)
 * absorbs orange and red along the long twilight paths: it is why the sky overhead stays blue after sunset
 * instead of going grey. MULTIPLE SCATTERING lights the air in the planet's shadow from the lit air above
 * it: the twilight glow that lasts until the Sun is ~9° down. It is approximated, not marched: an isotropic
 * term fed by the sunlight a little higher up, its horizon softened over those degrees.
 *
 * Units: Mm (1000 km); the planet's centre is wherever the caller puts it.
 */
import * as THREE from 'three/webgpu';
import { If, Loop, PI, abs, asin, exp, float, fract, length, max, min, pow, screenCoordinate, select, sin, smoothstep, sqrt, vec3 } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** Mm (1000 km) */
export const EARTH_R = 6.371;
export const ATMOS = 0.1;
/** how hard the air's samples crowd toward an eye inside it (scatter) */
const CROWD = 3;
export const H_RAY = 0.008;
export const H_MIE = 0.0012;
/** scattering per Mm at sea level (and the numbers, for CPU twins) */
export const BETA_R_RGB = [5.8, 13.5, 33.1] as const;
export const BETA_R = vec3(...BETA_R_RGB);
export const BETA_M = 6;
export const MIE_G = 0.76;
/** the Sun's irradiance (linear): a white surface facing it is SUN_E / π */
export const SUN_E = 7;
/** rad, the Sun's angular radius */
export const SUN_ANG = 0.00465;
/** e^(y²)·erfc(y) ≈ (1 + c·y) / (1 + (a + c)·y + √π·c·y²) for y ≥ 0, within 0.4 % */
const ERFCX_A = 1.09;
const ERFCX_C = 0.6;
/** ozone: absorption per Mm at its peak density (orange-red), the layer's centre and half-width (Mm) */
export const OZONE_RGB = [0.65, 1.881, 0.085] as const;
const OZONE = vec3(...OZONE_RGB);
export const OZONE_H = 0.025;
export const OZONE_W = 0.015;
/** multiple scattering: its share against single scattering (isotropic), and how far below the horizon (rad)
 * the sunlight feeding it fades out */
export const MS_GAIN = 0.15;
export const MS_SOFT = 0.16;
export const MARINE_AEROSOL = 3;
export const MS_FEED_H = 0.03;

/** which air: with ozone, how much multiple scattering, and its aerosol (haze) against the clean air's */
export interface Air {
  ozone: boolean;
  ms: number;
  mie: number;
}
export const ORBIT: Air = { ozone: false, ms: 0, mie: 1 };
/** tropical marine air carries several times the clean air's aerosol: its forward scattering is what holds
 * the glow after sunset down on the horizon (references/sea-dusk-twilight) */
export const GROUND: Air = { ozone: true, ms: MS_GAIN, mie: MARINE_AEROSOL };

/** ray / sphere: [near, far] distances (far < near when it misses) */
export function sphereHit(o: V3, d: V3, c: V3, r: number | F): { t0: F; t1: F } {
  const oc = o.sub(c);
  const b = oc.dot(d);
  const rr = typeof r === 'number' ? float(r * r) : r.mul(r);
  const disc = b.mul(b).sub(oc.dot(oc)).add(rr);
  const s = sqrt(disc.max(0));
  const miss = disc.lessThan(0);
  return { t0: select(miss, float(1), b.negate().sub(s)) as F, t1: select(miss, float(-1), b.negate().add(s)) as F };
}

/**
 * Mm of sea-level-density air along a ray from radius r (Mm) at cos-zenith μ out to space, scale height H.
 * Below the horizon (μ < 0) the ray passes a tangent point: twice the horizontal column there, less the
 * column behind us. Whether the ray hits the ground is the caller's business. The CPU twin of `column`.
 */
export function chapmanColumn(r: number, mu: number, H: number): number {
  const x = r / H;
  const y = Math.sqrt(x / 2) * Math.abs(mu);
  const erfcx = (1 + ERFCX_C * y) / (1 + (ERFCX_A + ERFCX_C) * y + Math.sqrt(Math.PI) * ERFCX_C * y * y);
  const above = Math.exp(-(r - EARTH_R) / H) * Math.sqrt((Math.PI * x) / 2) * erfcx;
  if (mu >= 0) return H * above;
  const rt = r * Math.sqrt(1 - mu * mu);
  return H * (Math.sqrt((2 * Math.PI * rt) / H) * Math.exp(Math.min(60, -(rt - EARTH_R) / H)) - above);
}

function column(r: F, mu: F, H: number): F {
  const x = r.div(H);
  const y = sqrt(x.mul(0.5)).mul(abs(mu));
  const erfcx = y.mul(ERFCX_C).add(1).div(y.mul(y).mul(Math.sqrt(Math.PI) * ERFCX_C).add(y.mul(ERFCX_A + ERFCX_C)).add(1));
  const above = exp(r.sub(EARTH_R).div(-H)).mul(sqrt(x.mul(Math.PI / 2))).mul(erfcx);
  const rt = r.mul(sqrt(float(1).sub(mu.mul(mu)).max(0)));
  const through = sqrt(rt.mul((2 * Math.PI) / H)).mul(exp(min(rt.sub(EARTH_R).div(-H), 60)));
  return select(mu.lessThan(0), through.sub(above), above).mul(H) as F;
}

/**
 * Mm of peak-density ozone along a ray from radius r at cos-zenith μ out to space: the layer as a thin shell
 * (its vertical column OZONE_W), crossed once from below it, twice by a ray from above that dips under it.
 */
export function ozoneColumnCpu(r: number, mu: number): number {
  const ro = EARTH_R + OZONE_H;
  const s2 = 1 - mu * mu;
  const cosAt = Math.sqrt(Math.max(1 - (r / ro) * (r / ro) * s2, (2 * OZONE_W) / ro));
  const crossings = r < ro ? 1 : mu < 0 && r * Math.sqrt(s2) < ro ? 2 : 0;
  return (OZONE_W / cosAt) * crossings;
}

function ozoneColumn(r: F, mu: F): F {
  const ro = EARTH_R + OZONE_H;
  const s2 = float(1).sub(mu.mul(mu)).max(0);
  const cosAt = sqrt(float(1).sub(r.div(ro).pow(2).mul(s2)).max((2 * OZONE_W) / ro));
  const crossings = select(r.lessThan(ro), float(1), select(mu.lessThan(0).and(r.mul(sqrt(s2)).lessThan(ro)), float(2), float(0)));
  return float(OZONE_W).div(cosAt).mul(crossings) as F;
}

/** optical depth (per channel) of the air along a ray from radius r at cos-zenith μ out to space */
export const opticalDepth = (r: F, mu: F, air: Air = ORBIT): V3 => {
  const od = BETA_R.mul(column(r, mu, H_RAY)).add(column(r, mu, H_MIE).mul(BETA_M * air.mie * 1.1));
  return air.ozone ? od.add(OZONE.mul(ozoneColumn(r, mu))) : od;
};

/** the Sun's light reaching radius r at cos-zenith μ (white = 1): through the air, and set behind the horizon */
export function sunlight(r: F, mu: F, air: Air = ORBIT): V3 {
  // the horizon dips by √(2h/R) at height h; the Sun's disc makes the setting a fade
  const dip = sqrt(r.sub(EARTH_R).max(0).mul(2 / EARTH_R));
  return exp(opticalDepth(r, mu, air).negate()).mul(smoothstep(-SUN_ANG, SUN_ANG, asin(mu.clamp(-1, 1)).add(dip)));
}

/** what feeds multiple scattering at radius r: the sunlight a few km higher (and no lower than MS_FEED_H: the
 * light that fills the shadowed air comes down from the lit air high above it, far less reddened than the
 * grazing sunlight down low), its setting softened over MS_SOFT */
export function skylight(r: F, mu: F, air: Air): V3 {
  const dip = sqrt(r.sub(EARTH_R).max(0).mul(2 / EARTH_R));
  // (below the horizon the path to the Sun runs through the ground: take the grazing one, let the fade set)
  const grazing = max(mu, sin(dip.add(0.003).negate()));
  return exp(opticalDepth(r.add(0.003).max(EARTH_R + MS_FEED_H), grazing, air).negate()).mul(smoothstep(-MS_SOFT, 0.02, asin(mu.clamp(-1, 1)).add(dip)));
}

/** transmittance from a point at radius r up to the eye: the ray's cos-zenith μ there, μe at the eye (radius re) */
export const towardEye = (r: F, mu: F, re: F, mue: F): V3 => exp(opticalDepth(r, mu).sub(opticalDepth(re, mue)).max(0).negate());

/** the Sun's colour as the eye sees it (white balance of the disc and its glare) */
export const SUN_TINT = vec3(1, 0.95, 0.86);
/** the Sun's disc, r rad from its centre (radiance, set for the dome, not the physical 1e5) */
export const sunDisc = (r: F): F => smoothstep(0.0052, 0.0042, r).mul(60);
/** the glare of a bright disc through optics: a tight bloom, a wider soft halo and a faint veil — no spikes or
 * stars (a precise cross or star reads as a graphic, not as light) */
export const sunGlare = (r: F): F => exp(r.div(0.008).negate()).mul(4).add(exp(r.div(0.035).negate()).mul(0.35)).add(exp(r.div(0.16).negate()).mul(0.035));

/**
 * The air's light along a ray from o in direction d (unit), planet centre C, toward the Sun S (unit): the
 * single-scattered sunlight it gathers out to space or to the ground, and its transmittance. 32 steps,
 * jittered per pixel (banding becomes fine grain). From inside the air the steps crowd toward the eye (CROWD).
 */
export function scatter(o: V3, d: V3, C: V3, S: V3, air: Air = ORBIT): { light: V3; T: V3; hitGround: THREE.Node<'bool'> } {
  const atm = sphereHit(o, d, C, EARTH_R + ATMOS);
  const gnd = sphereHit(o, d, C, EARTH_R);
  const t0 = atm.t0.max(0);
  const hitGround = gnd.t1.greaterThan(gnd.t0).and(gnd.t0.greaterThan(0));
  const t1 = select(hitGround, gnd.t0, atm.t1);
  const STEPS = 32;
  const L = t1.sub(t0).max(0);
  // from inside the air (the descent, the sea) a ray's light comes mostly from its first tens of km — a level
  // ray from the sea is out of the marine haze ~120 km along a ~1100 km path, where even steps (35 km each) left
  // the jitter a halftone in the sky: the samples crowd toward the eye, at u^k of the way, weighted by the
  // Jacobian k·u^(k−1); from space (k = 1) they run even, as they always have
  const k = smoothstep(EARTH_R + ATMOS, EARTH_R + ATMOS * 0.3, length(o.sub(C))).mul(CROWD - 1).add(1);
  const inR = vec3(0).toVar();
  const inM = vec3(0).toVar();
  const odR = float(0).toVar();
  const odM = float(0).toVar();
  const odO = float(0).toVar();
  const msR = vec3(0).toVar();
  const msM = vec3(0).toVar();
  const mu = d.dot(S);
  const phaseR = float(3).div(PI.mul(16)).mul(mu.mul(mu).add(1));
  const g2 = MIE_G * MIE_G;
  const phaseM = float(3 * (1 - g2)).div(PI.mul(8 * (2 + g2))).mul(mu.mul(mu).add(1)).div(pow(float(1 + g2).sub(mu.mul(2 * MIE_G)), float(1.5)));
  // a per-pixel jitter of the samples turns banding into fine grain
  const jitter = fract(fract(screenCoordinate.x.mul(0.06711056).add(screenCoordinate.y.mul(0.00583715))).mul(52.9829189));
  If(t1.greaterThan(t0), () => {
    Loop(STEPS, ({ i }) => {
      const u = float(i).add(jitter).div(STEPS);
      const ds = L.mul(k).mul(u.max(1e-4).pow(k.sub(1))).div(STEPS);
      const p = o.add(d.mul(t0.add(L.mul(u.pow(k)))));
      const r = length(p.sub(C));
      const h = r.sub(EARTH_R).max(0);
      const rR = exp(h.div(H_RAY).negate()).mul(ds);
      const rM = exp(h.div(H_MIE).negate()).mul(ds);
      const rO = float(1).sub(abs(h.sub(OZONE_H)).div(OZONE_W)).max(0).mul(ds);
      odR.addAssign(rR.mul(0.5));
      odM.addAssign(rM.mul(0.5));
      if (air.ozone) odO.addAssign(rO.mul(0.5));
      const ext = BETA_R.mul(odR).add(vec3(BETA_M * air.mie * 1.1).mul(odM));
      const toEye = exp((air.ozone ? ext.add(OZONE.mul(odO)) : ext).negate());
      // the Sun's light here, through the air above (analytic), none in the planet's shadow
      const muS = p.sub(C).dot(S).div(r);
      const att = toEye.mul(sunlight(r, muS, air));
      inR.addAssign(att.mul(rR));
      inM.addAssign(att.mul(rM));
      if (air.ms > 0) {
        // and the light of the lit air around, which still reaches the air in the shadow
        const amb = toEye.mul(skylight(r, muS, air));
        msR.addAssign(amb.mul(rR));
        msM.addAssign(amb.mul(rM));
      }
      odR.addAssign(rR.mul(0.5));
      odM.addAssign(rM.mul(0.5));
      if (air.ozone) odO.addAssign(rO.mul(0.5));
    });
  });
  const single = inR.mul(BETA_R).mul(phaseR).add(inM.mul(BETA_M * air.mie).mul(phaseM));
  const light = (air.ms > 0 ? single.add(msR.mul(BETA_R).add(msM.mul(BETA_M * air.mie)).mul(air.ms / (4 * Math.PI))) : single).mul(SUN_E);
  const ext = BETA_R.mul(odR).add(vec3(BETA_M * air.mie * 1.1).mul(odM));
  const T = exp((air.ozone ? ext.add(OZONE.mul(odO)) : ext).negate());
  return { light, T, hitGround: hitGround as THREE.Node<'bool'> };
}
