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
 *   dust    a field of dark clouds in a thin, corrugated layer through the disk mid-plane, denser just inside
 *           each arm (dust collects on the inner edge of a density wave) — the Great Rift and the dark clouds
 *           of the band seen from inside (`dust`; milkyWay.ts reddens what shines through it)
 *
 * No physical units are claimed; proportions follow a Milky Way-like barred spiral (scale length ~0.25 Rg,
 * scale height ~0.02 Rg, dust ~0.4 of the star height).
 */
import * as THREE from 'three/webgpu';
import { If, abs, atan, cos, exp, float, log, max, mix, mx_noise_float, pow, smoothstep, vec3 } from 'three/tsl';

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
}

// (less orange than they were, 1, 0.78, 0.52 and 0.95, 0.88, 0.8: the user, 2026-11-01, on the band "a smooth orange
// glow" — "colour to the eye is mostly silvery-white with a soft warm core. Keep it a little warmer than reality for
// mood, but far less orange and brown than now")
export const BULGE = vec3(1.0, 0.89, 0.76);
export const DISK = vec3(0.93, 0.92, 0.9);
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
 * arcs of spiral that still wind the same way (and OUR_LOOK's pitch is 18°, galaxies.ts, so there are fewer of them). Shared by the face and the volume, so the hand-over between them does not change it.
 * (The night over the sea once kept its own 13°, wander-free arms; since 2026-11-01 it bakes this same galaxy: the
 * user, "the SAME model used throughout the film")
 */
const WANDER = 2.1;
const WANDER_SCALE = 2.2;
function armWander(xy: V2, g: GalaxyLook): F {
  // two octaves: the broad kinks, and spurs at ~0.15 radii (with the broad one alone, 1.3 rad, the arms only slid
  // and still closed into ellipses at 100 s)
  const broad = mx_noise_float(vec3(xy.mul(WANDER_SCALE), g.seed.add(7.7)));
  const spurs = mx_noise_float(vec3(xy.mul(WANDER_SCALE * 2.7), g.seed.add(3.1)));
  return broad.add(spurs.mul(0.5)).mul(WANDER) as F;
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

/**
 * The dust's optical depth per radius at local point x (units of Rg), its in-plane radius r: the dark clouds of the
 * disk, which from inside it are the Great Rift and every dark patch of the band.
 *
 * WHY IT IS A FIELD OF CLOUDS (the user, 2026-11-01: the band "a smooth orange glow with one clean, even black stripe
 * down its middle"; the real one, from a dark ocean site, has a Rift "ragged and patchy, with branches, bays, gaps and
 * separate dark clouds (Cygnus Rift, Dark Horse, Pipe Nebula, Coalsack-like patches)"). The dust was a smooth sech²
 * layer through the mid-plane, its density varied only ±60% by one noise: seen from inside the layer, the depth
 * along any ray is the layer's column over sin(latitude), so every longitude drew the same dark stripe of the same
 * width. Now the layer is only the ENVELOPE, and inside it the dust is a domain-warped fractal of four octaves
 * (~0.09 down to ~0.006 radii), thresholded so that it breaks into clouds with clear gaps between them, and ridged at
 * its finest octave into filaments along the clouds' edges. From the Sun the near clouds (a few hundredths of a
 * radius off) are what shape the Rift: tens of degrees across, they lie over the band as separate dark shapes, bays
 * and branches; the far ones, a degree and under, mottle the bright clouds behind them. The envelope's mid-plane
 * CORRUGATES (±0.008 radii over ~0.05) and a fainter, taller share of it reaches ~4× higher, so some clouds stand
 * off the band like the Pipe and the Dark Horse, and where the clouds sit on the mid-plane they split the band into
 * two streams. The dust thickens inward (exp(−r / 0.32)), so the Rift widens toward the core, as the real one does.
 *
 * Its fine structure has to survive the night sky's bake (nightSky.ts, 2048 a face, ~23 px a degree, mipmapped): the
 * finest octave from the Sun at 0.05 radii is ~6°, at the core's distance ~0.5°, so nothing in it is finer than the
 * bake; the march's jitter turns what it cannot resolve along the ray into grain the mipmaps average.
 *
 * COST: six noise calls a sample, only where the envelope is not empty (an oblique ray's samples above and below the
 * dust skip them).
 */
function dust(x: V3, r: F, g: GalaxyLook, h: number): F {
  const kappa = float(0).toVar();
  // the mid-plane's corrugation, and with it the layer's thickness (thicker where it rises)
  const corr = mx_noise_float(vec3(x.xy.mul(18), g.seed.add(9.4)));
  const zz = x.z.sub(corr.mul(0.008));
  const hd = corr.mul(0.35).add(1).mul(h * 0.45);
  const env = sech2(zz.div(hd)).add(sech2(zz.div(hd.mul(4))).mul(0.5)).mul(exp(r.div(0.32).negate()));
  If(env.greaterThan(0.002), () => {
    // clouds flattened 2.2× along the plane, the space they sit in warped by a slower noise (bays and hooks, not
    // round blobs)
    const p = x.mul(vec3(1, 1, 2.2)).add(g.seed.add(5.3));
    const w = mx_noise_float(p.mul(5).add(13.1));
    const q = p.add(vec3(w, w.mul(-0.7), w.mul(0.4)).mul(0.07));
    const n1 = mx_noise_float(q.mul(11));
    const n2 = mx_noise_float(q.mul(27).add(n1.mul(0.8)));
    const n3 = mx_noise_float(q.mul(66).add(n2.mul(0.8)));
    const n4 = mx_noise_float(q.mul(160).add(n3.mul(0.8)));
    const fbm = n1.mul(0.5).add(n2.mul(0.3)).add(n3.mul(0.17)).add(n4.mul(0.09));
    // clouds with clear sky between them: about a third of the layer holds dust, a few percent of it is solid (fbm
    // spans about ±0.5; at −0.08 → 0.28 two thirds of it held dust and every ray along the plane met enough of it to go
    // black, the stripe again)
    const clouds = smoothstep(0.06, 0.3, fbm);
    // WINDOWS: regions ~0.2 radii across where the dust thins out altogether. With the clouds alone a ray along the
    // plane toward the core still met a dozen of them and every longitude of the Rift stayed black; through a window
    // the bright inner disk shows (the Scutum star cloud is one), and the Rift breaks into lengths
    const windows = smoothstep(-0.3, 0.15, mx_noise_float(x.mul(4.5).add(g.seed.add(31.3))));
    // filaments: the finest octave's zero crossings, strongest along the clouds' edges
    const ridge = pow(float(1).sub(abs(n4)), float(8)).mul(smoothstep(-0.06, 0.12, fbm)).mul(float(1).sub(clouds.mul(0.6)));
    kappa.assign(env.mul(clouds.add(ridge.mul(0.9))).mul(windows.mul(0.9).add(0.1)));
  });
  return kappa;
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
  // STAR CLOUDS, at three scales (the user, 2026-11-01: "the bright parts are mottled star clouds: grainy and lumpy,
  // brightest in a few big patches (the Sagittarius/Scutum star clouds near the core). Not a smooth fog"). One noise at
  // ~0.014 radii was all there was, and a ray along the plane crosses a hundred of those: integrated, they averaged to
  // fog. Now big patches (~0.1 radii, several degrees seen from the Sun) that stay coherent along a ray, lumps inside
  // them (~0.03), and the old fine grain; the big ones are strongest in the inner disk, the core's star clouds
  const big = smoothstep(0.5, 0.8, mx_noise_float(x.mul(vec3(7, 7, 20)).add(g.seed.add(21.7))).mul(0.5).add(0.5));
  const lumps = mx_noise_float(x.mul(vec3(30, 30, 75)).add(g.seed.add(2.9))).mul(0.5).add(0.5);
  const grain = pow(mx_noise_float(x.mul(vec3(70, 70, 160)).add(g.seed.add(11.1))).mul(0.5).add(0.5), float(3));
  const inner = smoothstep(0.5, 0.15, r);
  const clouds = big.mul(inner.mul(2.5).add(1)).add(0.3).mul(lumps.mul(lumps).mul(2.6).add(0.2)).mul(grain.mul(2.6).add(0.25));
  // the thick disk: old stars ~3× the thin disk's height, what gives the band its width toward the core (patchy too:
  // the core region is the brightest of the band, and lumpy)
  const thick = exp(r.div(0.22).negate()).mul(sech2(x.z.div(h * 3.2))).mul(0.16);
  const emit = DISK.mul(disk.mul(0.35).mul(clouds))
    .add(mix(DISK, BULGE, 0.5).mul(thick).mul(clouds.mul(0.85).add(0.15)))
    .add(ARMS.mul(disk.mul(arm).mul(clumps.mul(0.8).add(0.4))))
    .add(KNOTS.mul(disk.mul(knots)))
    .add(BULGE.mul(bulge).mul(lumps.mul(0.6).add(0.7)))
    .mul(25);
  // the dust: the clouds above, gathered toward each arm's inner edge (the lanes a far view of the disc shows)
  const lane = armWave(r, theta, g, -0.9, 6, wander).mul(smoothstep(0.08, 0.2, r));
  const kappa = dust(x, r, g, h).mul(lane.mul(1.5).add(0.5)).mul(320);
  return { emit, kappa: max(kappa, 0) };
}
