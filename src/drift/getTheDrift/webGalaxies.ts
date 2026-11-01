/**
 * THE GALAXIES OF THE DIVE (webDive.ts): G1's field, laid in the web at its true scale, where the dive passes (the
 * 2026-10-30 review: "have the galaxies pop in in the distance, then OUR galaxy"; the plan:
 * drift-narrative/get-the-drift/cosmic-web-flythrough-plan.md).
 *
 * The web's box is ~560 of our galaxy's radii now (it was ~12), so a galaxy is small against the structure it sits in
 * — after the deep fields and the simulations (references: galaxy-fields-clusters, cosmic-web): most are small
 * smudges, the knots are groups and clusters, and galaxies string the filaments. Three kinds, all real galaxies from
 * the atlas (galaxies.ts) but ours:
 *
 *   KNOTS     a galaxy at every knot within reach of the dive (the first stars of Undertime's gather beat become the
 *             first galaxies in place: they keep the birth flare), and round it its members, more the denser the knot
 *             (a group of a few at the faintest knots, ~40 at the hero knot, the cluster the grain became), the
 *             ellipticals packed toward the dense ones' centres
 *   FILAMENT  galaxies on the simulation's own particles near the dive's line (in a cone that narrows to our galaxy):
 *             what streams past as the eye flies down the filament. Born without a flare (hundreds of flashes at once
 *             would be fireworks, not a field opening)
 *   LOCAL     the Local Group, so ours reads as a place: a big inclined spiral in Andromeda's role, which the dive
 *             passes ~18 m (11 radii) off its line — growing out of the flow ahead, then sweeping up over the audience
 *             at ~6°/s as the dive slows (~93–97 s) — with a smaller spiral beside it, and two small irregulars just in front of ours
 *
 * MOST ARE MODELLED (the 2026-11-01 note: "a lot of the galaxies now look quite cheaply pasted in there, like bad
 * cutouts"): the members of the knots' groups and the filament's galaxies, the Local Group's two spirals and most knot
 * galaxies are drawn by galaxyFace as ours is (tile −1, galaxies.ts MODELLED GALAXIES), each with arms, pitch, phase
 * and noise of its own, ellipticals among them; a photo is kept only for PHOTO_SHARE of the knots' own galaxies, from
 * the tiles that hold up (PHOTO_KEEP) — the edge-on dust lanes the model cannot draw, and clean spirals — and for the
 * two small irregulars by ours.
 *
 * Every galaxy keeps clear of the dive's line by several of its own radii (one crossing the eye would be a blur
 * filling the dome), and of ours. Seeded: every lane renders the same sky.
 */
import { rng } from '../undertime/web';
import type { WebKnot } from '../undertime/webVolume';
import { GALAXY_TYPE, type GalaxyAtlas, type GalaxySpec, type GalaxyVariant } from './galaxies';
import { diveWorld, type WebFrame } from './webDive';
import type { Vec3 } from '../../cine/domeMaster';

/** box units: knots within this of the dive's middle get their galaxies (the far ones are points of light) */
const KNOT_REACH = 0.5;
/** members per unit of a knot's density over KNOT_FLOOR (~2 at the faintest knots, ~40 at the hero knot), and the
 * box units they spread over (a gaussian's σ: ~0.7 of a cell, the knot's own halo) */
const MEMBERS_PER = 2.4;
const KNOT_FLOOR = 6.5;
const MEMBER_SPREAD = 0.0028;
/** the filament cone round the dive's line: box units of radius at our galaxy, and per box unit back along the line;
 * a particle in it of log density over FILAMENT_V becomes a galaxy, one in FILAMENT_STRIDE of them */
const CONE_R0 = 0.004;
const CONE_SLOPE = 0.1;
const FILAMENT_V = 0.45;
const FILAMENT_STRIDE = 2;
/** a galaxy keeps this many of its own radii off the dive's line (world), and this far from ours (ours' radii) */
const CLEAR_RADII = 8;
const CLEAR_OURS = 2.4;
/** the Local Group, in our galaxy's radii: the big spiral's radius, how far before the Sun point along the line the
 * dive passes it and how far off the line (toward the dome's zenith: it sweeps up over the audience) */
const M31_RADIUS = 1.4;
const M31_ALONG = 7.5;
const M31_OFF = 11;
/** ours' radii the two small irregulars (the Magellanic Clouds' role) lie in front of ours along the approach */
const SAT_ALONG = 3.5;
/**
 * The atlas tiles that hold up as galaxies in the web (looked at 2026-11-01, galaxy-atlas.jpg): clean face-on spirals
 * (1, 10, 11, 13), the two edge-on discs with dust lanes (3, 7), a clean interacting pair (24), the soft irregular
 * (21). The rest carry foreground stars of our own galaxy, a hard elliptical mask with a stretched plateau (the
 * ellipticals, the Sombrero) or a cut-out bar, and read as pasted cards; the model draws those kinds instead.
 */
const PHOTO_KEEP = new Set([1, 3, 7, 10, 11, 13, 21, 24]);
/** the share of the knots' own galaxies drawn from those photos (the rest, and every other galaxy, modelled) */
const PHOTO_SHARE = 0.3;
/** deg, the most a modelled elliptical's plane leans from facing the dive (a planar model squashes as it tilts: an
 * elliptical is a ball, its outline at most ~E4 from here) */
const ELLIPTICAL_LEAN = 50;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function randomUnit(r: () => number): Vec3 {
  const z = r() * 2 - 1;
  const a = r() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(a), z, s * Math.sin(a)];
}

function inPlane(n: Vec3, r: () => number): Vec3 {
  const t = randomUnit(r);
  return norm(sub(t, [n[0] * dot(t, n), n[1] * dot(t, n), n[2] * dot(t, n)]));
}

export interface DiveGalaxyInput {
  frame: WebFrame;
  knots: WebKnot[];
  /** the simulation's particles, (u, v, w, log density) as normalised uint16 (webVolume.ts WebData) */
  particles: Uint16Array;
  ours: GalaxySpec;
  /** m, a typical galaxy's radius (getTheDrift params galaxySize) */
  size: number;
  /** unit, the dome's zenith (the big spiral sweeps toward it) */
  zenith: Vec3;
  /** where the dive starts in Get the Drift's world (its line runs from there to the Sun point) */
  start: Vec3;
}

export function diveGalaxies(input: DiveGalaxyInput, atlas: GalaxyAtlas['galaxies']): GalaxySpec[] {
  const { frame: f, ours, size } = input;
  const r = rng(4242);
  const gauss = (): number => Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());
  const byKind = (kinds: string[]): number[] => atlas.filter((g) => kinds.includes(g.kind)).map((g) => g.tile);
  const discs = byKind(['spiral', 'barred']);
  const others = byKind(['edge', 'inclined', 'irregular', 'interacting']);
  const irregulars0 = byKind(['irregular']);
  const keep = (pool: number[]): number[] => (pool.some((t) => PHOTO_KEEP.has(t)) ? pool.filter((t) => PHOTO_KEEP.has(t)) : pool);
  const irregulars = keep(irregulars0);
  const photos = keep([...discs, ...others]);
  // each tile used in turn from a shuffled deck, so no two neighbours are the same galaxy
  const decks = new Map<number[], number[]>();
  const draw = (pool: number[]): number => {
    if (pool.length === 0) return 0;
    let d = decks.get(pool);
    if (!d || d.length === 0) {
      d = [...pool].sort(() => r() - 0.5);
      decks.set(pool, d);
    }
    return d.pop() as number;
  };
  // the dive's line in Get the Drift's world, from its start to the Sun point
  const a = input.start;
  const ab = sub(f.sun, a);
  const abl = len(ab);
  const offLine = (p: Vec3): number => {
    const t = Math.min(1, Math.max(0, dot(sub(p, a), ab) / (abl * abl)));
    return len(sub(p, add(a, ab, t)));
  };
  const out: GalaxySpec[] = [ours];
  // A MODELLED GALAXY'S LOOK (tile −1; galaxies.ts VARIETY, the 2026-11-01 note: "we still want variance, and not all
  // galaxies to look the same and use the same colours"). MODEL draws a disc galaxy of a seeded kind — grand-design
  // (2 open arms) 24 %, flocculent (5–7 tight, broken arms) 16 %, barred 20 %, lenticular 12 %, irregular 12 %,
  // edge-on with a dust lane 16 % — ELLIPTICAL an elliptical, EARLY one or a lenticular (the dense knots' cores:
  // morphology–density), GRAND and FLOCCULENT those kinds (the Local Group's two spirals). Each also draws its
  // bulge-to-disc ratio, dust, disc colour (old yellow-white to young blue, with its bulge: big bulges old) and HII
  // knots or not. Ellipticals' and lenticulars' planes lean at most ELLIPTICAL_LEAN from facing the dive (a planar
  // model squashes as it tilts; a ball does not); an edge-on is a billboard, its roll random.
  const MODEL = -1;
  const ELLIPTICAL = -2;
  const EARLY = -3;
  const GRAND = -4;
  const FLOCCULENT = -5;
  type Look = Pick<GalaxySpec, 'arms' | 'wind' | 'phase' | 'seed' | 'elliptical'> & { variant: GalaxyVariant; normal?: Vec3; planar: boolean };
  const facing = (): Vec3 => {
    const lean = Math.cos((ELLIPTICAL_LEAN * Math.PI) / 180);
    const z = lean + (1 - lean) * r();
    const t = inPlane(f.approach, r);
    const k = Math.sqrt(1 - z * z);
    return norm([-f.approach[0] * z + t[0] * k, -f.approach[1] * z + t[1] * k, -f.approach[2] * z + t[2] * k]);
  };
  const pitch = (lo: number, hi: number): number => 1 / Math.tan(((lo + (hi - lo) * r()) * Math.PI) / 180);
  const modelLook = (code: number): Look => {
    let kind = code;
    if (code === EARLY) kind = r() < 0.6 ? ELLIPTICAL : 2;
    let type: GalaxyVariant['type'] = GALAXY_TYPE.spiral;
    let arms = 2;
    let wind = pitch(16, 30);
    if (kind === ELLIPTICAL) type = GALAXY_TYPE.elliptical;
    else if (kind === 2) type = GALAXY_TYPE.lenticular;
    else if (kind === GRAND) arms = 2;
    else if (kind === FLOCCULENT) [arms, wind] = [5 + Math.floor(r() * 3), pitch(10, 16)];
    else {
      const k = r();
      if (k < 0.24) arms = 2;
      else if (k < 0.4) [arms, wind] = [5 + Math.floor(r() * 3), pitch(10, 16)];
      else if (k < 0.6) [type, arms, wind] = [GALAXY_TYPE.barred, 2, pitch(14, 26)];
      else if (k < 0.72) type = GALAXY_TYPE.lenticular;
      else if (k < 0.84) [type, arms, wind] = [GALAXY_TYPE.irregular, 1 + Math.floor(r() * 2), pitch(25, 40)];
      else type = GALAXY_TYPE.edgeOn;
    }
    const early = type === GALAXY_TYPE.elliptical || type === GALAXY_TYPE.lenticular;
    // bulge-to-disc first; the disc's age follows it (a big bulge, an old disc), with scatter
    const bulge = type === GALAXY_TYPE.irregular ? -0.8 : early ? 0.3 + r() * 1.2 : -0.6 + r() * 1.8;
    const hue = type === GALAXY_TYPE.irregular ? 0.6 + 0.4 * r() : early ? -0.6 - 0.4 * r() : Math.max(-1, Math.min(1, 0.55 - bulge * 0.5 + (r() - 0.5) * 0.7));
    const variant: GalaxyVariant = {
      type,
      bulge,
      dust: type === GALAXY_TYPE.elliptical ? 0 : early ? r() * 0.8 : 0.3 + r() * 1.5,
      hue,
      knots: !early && (type === GALAXY_TYPE.irregular || hue > 0.1 ? r() < 0.85 : r() < 0.35),
    };
    return {
      arms,
      wind,
      phase: r() * Math.PI * 2,
      seed: 1 + r() * 97,
      elliptical: type === GALAXY_TYPE.elliptical ? 1 : 0,
      variant,
      normal: early ? facing() : undefined,
      planar: type !== GALAXY_TYPE.edgeOn,
    };
  };
  const place = (centre: Vec3, radius: number, tile: number, brightness: number, appear: number, flare: number, normal?: Vec3): boolean => {
    if (len(sub(centre, ours.centre)) < ours.radius * CLEAR_OURS + radius || offLine(centre) < radius * CLEAR_RADII) return false;
    const look: Partial<Look> & Pick<GalaxySpec, 'arms' | 'wind' | 'phase' | 'seed' | 'elliptical'> = tile < 0 ? modelLook(tile) : { arms: 2, wind: 1, phase: 0, seed: 0, elliptical: 0 };
    const n = normal ?? look.normal ?? randomUnit(r);
    out.push({
      centre, normal: n, xAxis: inPlane(n, r), radius,
      arms: look.arms, wind: look.wind, phase: look.phase, seed: look.seed, elliptical: look.elliptical,
      appear, brightness, flare,
      variant: look.variant,
      tile: tile < 0 ? -1 : tile, planar: look.planar ?? atlas.find((g) => g.tile === tile)?.planar ?? false, roll: r() * Math.PI * 2,
    });
    return true;
  };
  // ---------------------------------------------------------------- the knots and their groups
  const mid = add(f.start, sub(f.target, f.start), 0.5);
  const wrapLen = (d: Vec3): number => len(d.map((x) => x - Math.round(x)) as Vec3);
  for (const k of input.knots) {
    if (wrapLen(sub(k.pos, mid)) > KNOT_REACH) continue;
    const at = diveWorld(f, k.pos, mid);
    // the knot's own galaxy: most modest, a few large (the size distribution of the deep fields)
    const dense = k.density > 12;
    const radius = size * (0.35 + 1.3 * Math.pow(r(), 3)) * (dense ? 1.5 : 1);
    const roll = r();
    const own = r() < PHOTO_SHARE ? draw(photos) : roll < 0.6 || (roll < 0.75 && !dense) ? MODEL : EARLY;
    place(at, radius, own, 0.7 + r() * 0.5, r(), 1);
    const members = Math.max(1, Math.round((k.density - KNOT_FLOOR) * MEMBERS_PER));
    const spread = MEMBER_SPREAD * f.box * Math.min(1.6, Math.sqrt(k.density / 10));
    for (let m = 0; m < members; m++) {
      // packed toward the centre: the ellipticals inside, the spirals in the outskirts (morphology–density)
      const g = Math.abs(gauss());
      const p = add(at, randomUnit(r), g * spread);
      const kind = g < 0.9 && dense ? EARLY : r() < 0.12 ? ELLIPTICAL : MODEL;
      place(p, size * (0.12 + 0.55 * Math.pow(r(), 2.5)), kind, 0.45 + r() * 0.45, r(), 0);
    }
  }
  // ---------------------------------------------------------------- the filament down which the dive runs
  const P = input.particles;
  const L = len(sub(f.target, f.start));
  for (let i = 0; i < P.length; i += 4 * FILAMENT_STRIDE) {
    const v = P[i + 3] / 65536;
    if (v < FILAMENT_V) continue;
    const q: Vec3 = [P[i] / 65536, P[i + 1] / 65536, P[i + 2] / 65536];
    // its image nearest the line's middle, and where it lies along and off the line (pattern)
    const rel = sub(mid, f.start);
    const d0 = sub(q, mid).map((x) => x - Math.round(x)) as Vec3;
    const w = add(rel, d0);
    const along = dot(w, f.dive);
    if (along < -0.01 || along > L + 0.004) continue;
    const off = len(sub(w, [f.dive[0] * along, f.dive[1] * along, f.dive[2] * along]));
    if (off > CONE_R0 + CONE_SLOPE * Math.max(0, L - along)) continue;
    const roll = r();
    place(diveWorld(f, q, mid), size * (0.1 + 0.5 * Math.pow(r(), 3)), roll < 0.85 ? MODEL : ELLIPTICAL, 0.4 + 0.5 * r(), r(), 0);
  }
  // ---------------------------------------------------------------- the Local Group
  const R = ours.radius;
  const up = norm(sub(input.zenith, [f.approach[0] * dot(input.zenith, f.approach), f.approach[1] * dot(input.zenith, f.approach), f.approach[2] * dot(input.zenith, f.approach)]));
  const m31 = add(add(f.sun, f.approach, -M31_ALONG * R), up, M31_OFF * R);
  // inclined ~65° to the line of sight as it first shows (Andromeda's own is 77°: a long ellipse), a planar spiral
  const m31n = norm(add(f.approach, up, 1.8));
  place(m31, M31_RADIUS * R, GRAND, 1, 0.35, 1, m31n);
  // a smaller spiral beside it (M33's role), and two small irregulars by ours (the Magellanic Clouds' role), off the
  // side of ours away from the line
  const side = norm([f.approach[1] * up[2] - f.approach[2] * up[1], f.approach[2] * up[0] - f.approach[0] * up[2], f.approach[0] * up[1] - f.approach[1] * up[0]]);
  place(add(add(m31, side, 4.5 * R), f.approach, -2 * R), 0.45 * R, FLOCCULENT, 0.8, 0.42, 1);
  // ON THE NEAR SIDE of ours (SAT_ALONG radii back toward the eye), so the approach carries them out of the frame by
  // parallax: beside ours as it is recognised (~88–92 s), out past 50° from it by ~96 s and passing the eye before
  // the zoom. They were 2.2 radii BEYOND ours: from the eye they then kept ~2 of ours' own angular radii off its edge
  // the whole way in, growing with it — "this galaxy to the left of our actual Milky Way where we're zooming in stays
  // there for way too long and looks cheap" (the 2026-10-31 review, ~95–110 s)
  const near = add(ours.centre, f.approach, -SAT_ALONG * R);
  place(add(add(near, side, -4 * R), up, -1.2 * R), 0.32 * R, draw(irregulars.length ? irregulars : others), 0.8, 0.7, 0);
  place(add(add(add(near, f.approach, -1.2 * R), side, -4.6 * R), up, -0.3 * R), 0.22 * R, draw(irregulars.length ? irregulars : others), 0.7, 0.74, 0);
  return out;
}
