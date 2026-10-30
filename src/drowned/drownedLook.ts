/**
 * WHAT YEARS UNDER A WARM SEA DO TO A THING MEN BUILT — the one look every drowned structure of the sunken world
 * wears (the town's roofs, the boulevard's palm trunks, the church, a pylon's legs), for the film and, later, the
 * Raft 2100 game: albedo and roughness in, albedo and roughness out, the material's own lighting after.
 *
 * WHY (the user, 2026-10-29, on The Drift: "without someone telling me the story it doesn't become apparent that this
 * is what happened" — drift-narrative/wandering-on/sunken-world-cues.md cues 5 and 6). A clean CG roof seen through a
 * lagoon reads as a model dropped into a pool; one furred with turf algae, its up-faces silted, the sand drifted up
 * its slopes and a crust where the water meets it, reads as a roof the sea took. The zones are the rocky shore's
 * (Stephenson's universal scheme, and what the references of drowned piers and harbour walls show):
 *
 *   SUBTIDAL   always under (y below −SUBTIDAL m): a turf of fine algae, olive to brown, in patches a metre and a
 *              hand across; crustose coralline algae in mauve-grey crusts; silt on every face turned up; the sand
 *              itself, drifted against and onto whatever stands in it (`overSand`)
 *   FRINGE     the waterline's own band, a few decimetres either side of the mean sea: a barnacle and oyster crust,
 *              pale and rough, a ribbon of bright green weed (Ulva) just under it
 *   SPLASH     above it, the black zone (cyanobacteria, the "tar" band every rocky shore has) fading up into
 *              salt-bleached weathering
 *
 * Every pattern is band-limited (a period that shrinks under a couple of pixels fades to its mean, §V48b) and reads
 * a LOCAL position `p`, never the world's: the film's coast lies 40 km from its origin, where a 32-bit world position
 * steps every 4 mm, and fine noise read there crawls in stripes (the swash's moiré, the 2026-10-30 round). Heights
 * (`y`, over the mean sea) are small numbers wherever the world is, so they may come from the world.
 */
import { float, mix, smoothstep, vec2, vec3 } from 'three/tsl';
import { fbm2 } from '../terrain/noise';
import { coordFilter, periodResolved } from '../ship/bandLimit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node unions
type Node = any;

/** linear albedos (sRGB-decoded), each from what the thing is: a turf of fine algae a dull olive-brown (darker than
 * the sand, never black: at 0.045 its patches read as "black patches … in the houses" under the water, the user,
 * 2026-10-30), a coralline
 * crust a dusty mauve, silt and the lagoon's coral sand a grey-beige (beachMaterial.ts: the submerged sand ≈ 0.39,
 * 0.37, 0.33), a barnacle crust a chalky grey, sea lettuce a vivid green, the black zone black */
export const DROWNED_ALBEDO = {
  turfDark: [0.1, 0.1, 0.055],
  turfLight: [0.17, 0.16, 0.09],
  coralline: [0.3, 0.22, 0.24],
  silt: [0.29, 0.27, 0.22],
  sand: [0.38, 0.36, 0.31],
  crust: [0.5, 0.48, 0.44],
  ulva: [0.07, 0.17, 0.035],
  black: [0.08, 0.075, 0.065],
} as const;

/** m: the zones' edges about the mean sea (the lagoon's tide is small: a micro-tidal coast) */
export const ZONES = {
  /** under this depth the turf has it all */
  subtidal: 0.35,
  /** the crust's band, from under to over the mean sea */
  crust: [-0.4, 0.15] as [number, number],
  /** the black zone's top */
  splash: 1.1,
};

export interface DrownedInputs {
  albedo: Node;
  rough: Node;
  /** m: a LOCAL position (see the header), for the patterns */
  p: Node;
  /** m: height over the mean sea */
  y: Node;
  /** the geometry's world normal (silt lies on what faces up) */
  n: Node;
  /** m over the sand under this point (absent: nothing stands in sand) */
  overSand?: Node;
  /** 0..1 per object: its own share of each growth */
  seed?: Node;
  /** how far the sea has taken it, 0 fresh .. 1 years down (scales every growth; default 1) */
  age?: number;
  /** the structure is steel: rust bleeds from it above the water (a pylon, a mast) */
  steel?: boolean;
}

/** a [0, 1] field faded to its mean once its period is under a couple of pixels (§V48b) */
export function fadedField(coord: Node, octaves: number): Node {
  const f = coordFilter(coord);
  return mix(float(0.5), fbm2(coord, octaves), periodResolved(coord, f.x.max(f.y)));
}

const v3 = (c: readonly number[]): Node => vec3(c[0], c[1], c[2]);

/**
 * The look: `albedo` and `rough` taken over by the sea's growth where the zones say, and `cover` (0..1, how much of
 * the surface is growth or sediment, not the thing itself) for the caller's own fades (a normal map under a turf
 * reads flatter).
 */
export function drownedLook(i: DrownedInputs): { albedo: Node; rough: Node; cover: Node } {
  const age = i.age ?? 1;
  const seed = i.seed ?? float(0.5);
  const p = i.p;
  const n = i.n;
  // a pattern coordinate that wraps walls and floors alike (the plane is sheared by height, so a wall's patches
  // vary up it, a roof's along it): the tideBand trick (circuit/courseFurniture.ts), on a local position
  const wc = p.xz.add(vec2(p.y.mul(0.73), p.y.mul(-0.61))).add(vec2(seed.mul(37.1), seed.mul(-23.7)));
  const big = fadedField(wc.mul(0.55), 3);
  const mid = fadedField(wc.mul(2.1).add(vec2(5.3, 1.7)), 2);
  const fine = fadedField(wc.mul(9).add(vec2(-2.9, 8.1)), 2);
  // the zones' edges wander a hand up and down, so no band is a ruled line
  const yb = i.y.add(big.sub(0.5).mul(0.3)).add(mid.sub(0.5).mul(0.12));
  const depth = yb.negate();
  // @band-limited-elsewhere: elevation bands on height over the sea (≥ 0.25 m ramps), not spatial periods
  const sub = smoothstep(ZONES.subtidal * 0.2, ZONES.subtidal, depth);
  // @band-limited-elsewhere: elevation band
  const crustBand = smoothstep(ZONES.crust[0] - 0.15, ZONES.crust[0] + 0.1, yb).mul(smoothstep(ZONES.crust[1] + 0.15, ZONES.crust[1] - 0.05, yb));
  // @band-limited-elsewhere: elevation band
  const ulvaBand = smoothstep(ZONES.crust[0] - 0.5, ZONES.crust[0] - 0.15, yb).mul(smoothstep(ZONES.crust[0] + 0.15, ZONES.crust[0] - 0.05, yb));
  // @band-limited-elsewhere: elevation band (the black zone, thinning upward)
  const blackBand = smoothstep(ZONES.crust[1] - 0.05, ZONES.crust[1] + 0.2, yb).mul(smoothstep(ZONES.splash, ZONES.splash * 0.35, yb));
  // @band-limited-elsewhere: elevation band (salt and sun above the splash)
  const weather = smoothstep(ZONES.splash * 0.6, ZONES.splash + 0.8, yb);
  const up = n.y.max(0);

  let a: Node = i.albedo;
  let r: Node = i.rough;
  // ABOVE: sun and salt bleach it toward a pale grey, the paint chalked; steel rusts and bleeds down
  const lum = a.dot(vec3(0.2126, 0.7152, 0.0722));
  a = mix(a, mix(vec3(lum), vec3(0.42, 0.41, 0.39), 0.35), weather.mul(0.45 * age));
  if (i.steel) {
    const streak = fadedField(vec2(wc.x.add(wc.y).mul(3.2), p.y.mul(0.35)), 2);
    const rust = smoothstep(0.4, 0.62, streak).mul(smoothstep(-0.2, 0.4, yb));
    a = mix(a, vec3(0.3, 0.13, 0.05).mul(big.mul(0.4).add(0.8)), rust.mul(0.7 * age));
    r = mix(r, float(0.85), rust);
  }
  // THE SPLASH ZONE'S BLACK BAND, and the wet: everything within reach of the waves darker
  a = mix(a, a.mul(0.55), smoothstep(ZONES.splash + 0.4, 0.1, yb).mul(age));
  // (a grey-brown stain in patches, not black blotches: the same review)
  a = mix(a, v3(DROWNED_ALBEDO.black), blackBand.mul(smoothstep(0.45, 0.7, mid)).mul(0.4 * age));
  // THE FRINGE: barnacle crust in clumps (the fine field is its grain; faded to its mean at range), sea lettuce under
  const crustAt = crustBand.mul(smoothstep(0.3, 0.55, fine.mul(0.6).add(mid.mul(0.4)))).mul(age);
  a = mix(a, v3(DROWNED_ALBEDO.crust).mul(fine.mul(0.4).add(0.8)), crustAt.mul(0.85));
  a = mix(a, v3(DROWNED_ALBEDO.ulva).mul(mid.mul(0.6).add(0.7)), ulvaBand.mul(smoothstep(0.35, 0.6, big)).mul(0.75 * age));
  // SUBTIDAL: the turf over all of it in patches (thin where the patch field is low — the thing shows through a
  // film there, darkened), coralline crusts between, silt on what faces up
  const turf = smoothstep(0.28, 0.62, big.mul(0.65).add(mid.mul(0.35)).add(seed.sub(0.5).mul(0.3)));
  const turfCol = mix(v3(DROWNED_ALBEDO.turfDark), v3(DROWNED_ALBEDO.turfLight), mid.mul(0.7).add(fine.mul(0.3)));
  a = mix(a, a.mul(0.6), sub.mul(0.85 * age));
  a = mix(a, turfCol, sub.mul(turf).mul(0.92 * age));
  const coral = smoothstep(0.62, 0.78, mid.mul(0.7).add(big.mul(0.3))).mul(float(1).sub(turf.mul(0.6)));
  a = mix(a, v3(DROWNED_ALBEDO.coralline).mul(fine.mul(0.3).add(0.85)), sub.mul(coral).mul(0.6 * age));
  // (none where the waves wash: within a metre of the surface the swell keeps the faces swept — the first round's roofs
  // a few decimetres down read as pale sand-coloured decks)
  // @band-limited-elsewhere: the depth ramp is an elevation band (0.5 m wide)
  const silt = smoothstep(0.35, 0.95, up).mul(smoothstep(0.25, 0.7, big.mul(0.5).add(fine.mul(0.5)).add(0.15))).mul(smoothstep(0.6, 1.1, depth));
  a = mix(a, v3(DROWNED_ALBEDO.silt).mul(mid.mul(0.3).add(0.85)), sub.mul(silt).mul(0.8 * age));
  let cover: Node = sub.mul(turf.max(silt).max(coral)).max(crustAt).mul(age);
  // THE SAND drifted against it and onto its lower slopes: within a few decimetres of the sand's height, wandering
  // with the patches (a drift, not a ruled line), more on what faces up
  if (i.overSand) {
    const h = i.overSand.add(big.sub(0.5).mul(0.45)).add(mid.sub(0.5).mul(0.15));
    // @band-limited-elsewhere: a ramp on height over the sand (0.35 m wide), not a spatial period
    const drift = smoothstep(0.38, 0.02, h).mul(up.mul(0.6).add(0.4)).max(smoothstep(0.08, -0.05, h));
    a = mix(a, v3(DROWNED_ALBEDO.sand).mul(fine.mul(0.2).add(0.9)), drift);
    cover = cover.max(drift);
  }
  // growth and silt are matte; the water fills them (no gloss of their own under it: beachMaterial.ts's rule)
  r = mix(r, float(0.95), cover.max(sub.mul(0.7)));
  return { albedo: a, rough: r.clamp(0.04, 1), cover: cover.clamp(0, 1) };
}

/** a [0, 1] hash of a building's or a trunk's seed, for CPU-side choices that must match the shader's */
export function seedOf(i: number): number {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}
