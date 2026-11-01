/**
 * One analytic galaxy model, used two ways: as the face of a far galaxy's impostor (galaxies.ts) and as the
 * volume our own galaxy is ray-marched through (milkyWay.ts). Sharing the model is what lets the Milky Way
 * hand over from a far disc to the sky around us without changing its look.
 *
 * Units are the galaxy's radius Rg. In the galaxy's own frame x, y lie in the disk and z is the normal.
 *
 *   bulge   warm, centrally concentrated (exponential in radius)
 *   disk    exponential in radius, sech² in height, ~1/50 of the radius thick
 *   arms    logarithmic spirals, m arms of pitch angle ψ: the arm phase is m·(θ − ln r / tan ψ); young blue
 *           stars along the arms, pink star-forming knots where a noise field peaks on an arm
 *   thick   old warm stars about three times the disk's height: the band's width toward the core
 *   dust    a lane just inside each arm (dust collects on the inner edge of a density wave) and a thin dust
 *           layer through the disk mid-plane — the dark rift of the band seen from inside (milkyWay.ts
 *           reddens what shines through it)
 *
 * No physical units are claimed; proportions follow a Milky Way-like barred spiral (scale length ~0.25 Rg,
 * scale height ~0.02 Rg, dust ~0.4 of the star height).
 */
import * as THREE from 'three/webgpu';
import { atan, cos, exp, float, log, max, mix, mx_noise_float, pow, smoothstep, vec3 } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V2 = THREE.Node<'vec2'>;

export interface GalaxyLook {
  /** arm count */
  arms: F;
  /** 1 / tan(pitch angle) */
  wind: F;
  /** rad, rotation of the arm pattern */
  phase: F;
  /** per-galaxy noise offset */
  seed: F;
  /** 0 spiral … 1 elliptical */
  elliptical: F;
  /** 0..1, how far the arms wander off their spirals (armWander; 1 if absent). 0 for the night sky over the sea,
   * which keeps the clean 13° arms the user liked (2026-11-01: the wander was added for Act 2's ~100 s rings) */
  wander?: F;
}

export const BULGE = vec3(1.0, 0.78, 0.52);
export const DISK = vec3(0.95, 0.88, 0.8);
export const ARMS = vec3(0.6, 0.72, 1.0);
export const KNOTS = vec3(1.0, 0.45, 0.62);

const sech2 = (x: F): F => {
  const e = exp(x.abs().mul(-2));
  return e.mul(4).div(e.add(1).pow(2));
};

/**
 * rad, how far the arms WANDER off their logarithmic spirals at in-plane point xy (radii): a slow noise added to the
 * arm phase, the same for an arm and its dust lane, so the lane stays on the arm's inner edge. Why (the coordinator's
 * check of ~100 s, 2026-11-01: our galaxy's far disc "shows concentric-ring banding … it must read as a galaxy, not
 * rings"): the arms are wound at 13° (a Milky Way's pitch), and two clean arms of that pitch with their lanes cross a
 * radius six times between the bulge and the rim; seen at ~75° from face-on, the perfect spirals foreshorten into
 * nested ellipses, a bullseye. It is the model, not its sampling: the impostor (galaxies.ts galaxyFace, nothing
 * marched) drew the same rings at 92 s as the volume at 100. A real disc's arms branch, kink and break into spurs
 * (flocculence); a phase that wanders by ~±2 rad over ~half a radius, with spurs on it, breaks every ellipse into
 * arcs of spiral that still wind the same way (and OUR_LOOK's pitch is 18°, galaxies.ts, so there are fewer of them). Shared by the face and the volume, so the hand-over between them does not change it
 */
const WANDER = 2.1;
const WANDER_SCALE = 2.2;
function armWander(xy: V2, g: GalaxyLook): F {
  // two octaves: the broad kinks, and spurs at ~0.15 radii (with the broad one alone, 1.3 rad, the arms only slid
  // and still closed into ellipses at 100 s)
  const broad = mx_noise_float(vec3(xy.mul(WANDER_SCALE), g.seed.add(7.7)));
  const spurs = mx_noise_float(vec3(xy.mul(WANDER_SCALE * 2.7), g.seed.add(3.1)));
  return broad.add(spurs.mul(0.5)).mul(WANDER).mul(g.wander ?? 1) as F;
}

/** arm intensity (0..1) at radius r, angle θ; `lag` shifts toward the inner edge (the dust lane); `wander` (rad) the
 * arms' own wandering off their spiral (armWander) */
function armWave(r: F, theta: F, g: GalaxyLook, lag: number, sharp: number, wander: F): F {
  const phase = g.arms.mul(theta.sub(log(r.max(0.02)).mul(g.wind))).add(g.phase).add(lag).add(wander);
  return pow(cos(phase).mul(0.5).add(0.5), float(sharp));
}

/** emission (linear rgb, per unit area seen face-on) and dust optical depth of the disk at in-plane point p */
export function galaxyFace(p: V2, g: GalaxyLook): { light: V3; tau: F } {
  const r = p.length();
  const theta = atan(p.y, p.x);
  const bulge = exp(r.div(0.07).negate()).mul(2.2);
  const disk = exp(r.div(0.26).negate());
  const wander = armWander(p, g);
  const arm = armWave(r, theta, g, 0, 4, wander).mul(smoothstep(0.06, 0.18, r));
  const clumps = mx_noise_float(vec3(p.mul(9), g.seed)).mul(0.5).add(0.5);
  const knots = pow(clumps, float(5)).mul(arm).mul(2.5);
  const spiralLight = DISK.mul(disk.mul(0.35))
    .add(ARMS.mul(disk.mul(arm).mul(clumps.mul(0.8).add(0.4))))
    .add(KNOTS.mul(disk.mul(knots)))
    .add(BULGE.mul(bulge));
  const lane = armWave(r, theta, g, -0.9, 6, wander).mul(smoothstep(0.08, 0.2, r)).mul(exp(r.div(0.35).negate()));
  const tau = lane.mul(2.2).mul(clumps.mul(0.6).add(0.7));
  // an elliptical: a smooth warm glow, no arms, no dust
  const ell = BULGE.mul(exp(pow(r.div(0.32), float(0.6)).mul(-3)).mul(3));
  return { light: mix(spiralLight, ell, g.elliptical), tau: tau.mul(float(1).sub(g.elliptical)) };
}

/** emission density and dust opacity of the galaxy volume at local point x (units of Rg) */
export function galaxyVolume(x: V3, g: GalaxyLook): { emit: V3; kappa: F } {
  const r = x.xy.length();
  const theta = atan(x.y, x.x);
  const h = 0.02;
  // the bulge: bright, compact, a little flattened (a bar seen end-on from the Sun)
  const bulge = exp(vec3(x.x, x.y, x.z.mul(1.6)).length().div(0.055).negate()).mul(3.5);
  const disk = exp(r.div(0.26).negate()).mul(sech2(x.z.div(h)));
  const wander = armWander(x.xy, g);
  const arm = armWave(r, theta, g, 0, 4, wander).mul(smoothstep(0.06, 0.18, r));
  const clumps = mx_noise_float(x.mul(vec3(14, 14, 40)).add(g.seed)).mul(0.5).add(0.5);
  const knots = pow(clumps, float(5)).mul(arm).mul(2.5);
  // star clouds: a finer mottling of the disk's light, what makes the band read as stars rather than fog
  // (the Scutum and Sagittarius clouds are this, close up)
  const clouds = pow(mx_noise_float(x.mul(vec3(70, 70, 160)).add(g.seed.add(11.1))).mul(0.5).add(0.5), float(3)).mul(2.2).add(0.15);
  // the thick disk: old stars ~3× the thin disk's height, what gives the band its width toward the core
  const thick = exp(r.div(0.22).negate()).mul(sech2(x.z.div(h * 3.2))).mul(0.16);
  const emit = DISK.mul(disk.mul(0.35).mul(clouds))
    .add(BULGE.mul(thick).mul(clouds.mul(0.4).add(0.6)))
    .add(ARMS.mul(disk.mul(arm).mul(clumps.mul(0.8).add(0.4))))
    .add(KNOTS.mul(disk.mul(knots)))
    .add(BULGE.mul(bulge))
    .mul(25);
  const lane = armWave(r, theta, g, -0.9, 6, wander).mul(smoothstep(0.08, 0.2, r));
  const dustLayer = exp(r.div(0.32).negate()).mul(sech2(x.z.div(h * 0.4)));
  const filaments = smoothstep(0.35, 0.8, mx_noise_float(x.mul(vec3(22, 22, 60)).add(g.seed.add(5.3))).mul(0.5).add(0.5));
  const kappa = dustLayer.mul(lane.mul(1.5).add(0.35)).mul(filaments.mul(1.4).add(0.3)).mul(90);
  return { emit, kappa: max(kappa, 0) };
}
