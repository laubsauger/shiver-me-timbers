/**
 * The air between the eye and a cloud (seaSky.ts): its transmittance and the light it scatters toward the eye
 * over that stretch — the sky's own single-scattering air (getTheDrift/atmosphere.ts `scatter`, its sunlight and
 * its multiple-scattering stand-in), cut off at the cloud. A cloud then sits IN the sky:
 *
 *   L = (1 − α)·L_sky + α·L_air(0→d) + T_air(0→d)·L_cloud
 *
 * (L_cloud already weighted by its opacity α; what shows through it is the sky beyond, the air in front of it is
 * the same air either way). It had been an exponential haze, 1/e over 18 km, toward the sky's colour: the light
 * from a far cloud at sunset was not reddened on its way, nor a near one at noon veiled in blue — the air's own
 * colours, which it now takes from the same physics as the sky around it.
 *
 * The samples crowd toward the eye (at u² of the way), where the marine haze is: a level ray from the sea leaves
 * most of it in its first few km. Ozone is left out: its layer is 10–40 km up, every cloud far under it.
 */
import * as THREE from 'three/webgpu';
import { Loop, PI, exp, float, fract, length, pow, vec3 } from 'three/tsl';
import { blueNoise } from './blueNoise';
import { BETA_M, BETA_R, EARTH_R, H_MIE, H_RAY, MIE_G, SUN_E, skylight, sunlight, type Air } from '../getTheDrift/atmosphere';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/**
 * The air along a ray from o (Mm, planet centre C) in direction d (unit) over `dist` m, Sun toward S: its
 * transmittance T and the light it scatters toward o (linear, the sky's units). `jitter` (0..1) offsets the
 * samples per (sub-)frame, on top of a per-pixel pattern.
 */
export function airTo(o: V3, C: V3, d: V3, S: V3, dist: F, steps: number, jitter: F, air: Air): { T: V3; L: V3 } {
  const L = dist.mul(1e-6);
  const inR = vec3(0).toVar();
  const inM = vec3(0).toVar();
  const msR = vec3(0).toVar();
  const msM = vec3(0).toVar();
  const odR = float(0).toVar();
  const odM = float(0).toVar();
  const mie = BETA_M * air.mie;
  const mu = d.dot(S);
  const phaseR = float(3).div(PI.mul(16)).mul(mu.mul(mu).add(1));
  const g2 = MIE_G * MIE_G;
  const phaseM = float(3 * (1 - g2)).div(PI.mul(8 * (2 + g2))).mul(mu.mul(mu).add(1)).div(pow(float(1 + g2).sub(mu.mul(2 * MIE_G)), float(1.5)));
  // (the blue-noise tile at its own shift: the cloud march's would step in lockstep with it)
  const j = fract(blueNoise(2).add(jitter));
  Loop(steps, ({ i }) => {
    const u = float(i).add(j).div(steps);
    const ds = L.mul(u.mul(2)).div(steps);
    const p = o.add(d.mul(L.mul(u.mul(u))));
    const r = length(p.sub(C));
    const h = r.sub(EARTH_R).max(0);
    const rR = exp(h.div(H_RAY).negate()).mul(ds);
    const rM = exp(h.div(H_MIE).negate()).mul(ds);
    odR.addAssign(rR.mul(0.5));
    odM.addAssign(rM.mul(0.5));
    const toEye = exp(BETA_R.mul(odR).add(vec3(mie * 1.1).mul(odM)).negate());
    const muS = p.sub(C).dot(S).div(r);
    const att = toEye.mul(sunlight(r.max(EARTH_R), muS, air));
    inR.addAssign(att.mul(rR));
    inM.addAssign(att.mul(rM));
    if (air.ms > 0) {
      const amb = toEye.mul(skylight(r, muS, air));
      msR.addAssign(amb.mul(rR));
      msM.addAssign(amb.mul(rM));
    }
    odR.addAssign(rR.mul(0.5));
    odM.addAssign(rM.mul(0.5));
  });
  const single = inR.mul(BETA_R).mul(phaseR).add(inM.mul(mie).mul(phaseM));
  const light = (air.ms > 0 ? single.add(msR.mul(BETA_R).add(msM.mul(mie)).mul(air.ms / (4 * Math.PI))) : single).mul(SUN_E);
  const T = exp(BETA_R.mul(odR).add(vec3(mie * 1.1).mul(odM)).negate());
  return { T: T as V3, L: light as V3 };
}

/**
 * THE LIGHT SHAFTS (crepuscular rays): the sunlight the air along a ray would scatter toward the eye but for the
 * clouds' shadow — subtracted from the sky, it leaves the lit air between the shadows as shafts. The shadow is
 * the clouds' light volume, read per sample (`through`, clouds.ts CloudLight.sunThrough): world-space, per view
 * direction, so seam-free across the dome's faces (no screen-space radial blur). Single scattering of the Sun
 * only (the sky's multiple-scattering stand-in is left whole), over `dist` m in `steps` crowding toward the eye
 * (u^1.5), jittered as the rest. Strongest where the Mie haze scatters forward: toward a low Sun.
 */
export function shafts(o: V3, C: V3, d: V3, S: V3, dist: F, steps: number, jitter: F, air: Air, through: (t: F) => F): V3 {
  const L = dist.mul(1e-6);
  const lost = vec3(0).toVar();
  const odR = float(0).toVar();
  const odM = float(0).toVar();
  const mie = BETA_M * air.mie;
  const mu = d.dot(S);
  const phaseR = float(3).div(PI.mul(16)).mul(mu.mul(mu).add(1));
  const g2 = MIE_G * MIE_G;
  const phaseM = float(3 * (1 - g2)).div(PI.mul(8 * (2 + g2))).mul(mu.mul(mu).add(1)).div(pow(float(1 + g2).sub(mu.mul(2 * MIE_G)), float(1.5)));
  const j = fract(blueNoise(3).add(jitter.mul(1.618034)));
  Loop(steps, ({ i }) => {
    const u = float(i).add(j).div(steps);
    const s = u.mul(u.sqrt());
    const ds = L.mul(u.sqrt().mul(1.5)).div(steps);
    const p = o.add(d.mul(L.mul(s)));
    const r = length(p.sub(C));
    const h = r.sub(EARTH_R).max(0);
    const rR = exp(h.div(H_RAY).negate()).mul(ds);
    const rM = exp(h.div(H_MIE).negate()).mul(ds);
    odR.addAssign(rR.mul(0.5));
    odM.addAssign(rM.mul(0.5));
    const toEye = exp(BETA_R.mul(odR).add(vec3(mie * 1.1).mul(odM)).negate());
    const muS = p.sub(C).dot(S).div(r);
    const shade = float(1).sub(through(dist.mul(s)));
    lost.addAssign(toEye.mul(sunlight(r.max(EARTH_R), muS, air)).mul(BETA_R.mul(phaseR).mul(rR).add(vec3(mie).mul(phaseM).mul(rM))).mul(shade));
    odR.addAssign(rR.mul(0.5));
    odM.addAssign(rM.mul(0.5));
  });
  return lost.mul(SUN_E) as V3;
}
