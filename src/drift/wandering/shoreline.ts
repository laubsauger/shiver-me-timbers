/**
 * THE WATER'S EDGE on our beach (the user, 2026-10-29, with photographs of real shores: "the laser sharp edge of the
 * water … no lapping waves, no foam, no nothing … that's not how it looks ever"). The ocean draws the water body down
 * to its line on the sand; on a real shore that line is never seen: each small wave breaks into white water, runs up
 * the face as a sheet with a rounded, bubbling front, stalls, drains back thin and glassy into the sand, and leaves
 * foam stranded where it turned.
 *
 * THE SWASH, event by event (swashAt; the user, 2026-10-29, of the tongue this replaces: "very one dimensional … like
 * two planes in the same spot pushing over each other … no substance … the pulling back and pushing out is kinda
 * clippy"). Each wave is an event of its own, analytic in time, so every frame stays a pure function of t:
 *
 *   - THE BORE: for BORE_LEAD s before it reaches the still line a crest of white water comes in across the shallows,
 *     its face steep, its back long, BORE_H high — the bigger the run-up it will make, the higher.
 *   - THE UPRUSH: from the still line the tip runs up the 1:11 face as a ballistic body, x = u₀t − ½·g·sinβ·t² — fast,
 *     slowing, stalling at its reach (Shen & Meyer 1963; Peregrine & Williams 2001: the swash tip under gravity alone).
 *     The water behind the tip is a lens, h = Δx²/(9g·t²) (Δx behind the tip, the same analytic solution), so it is
 *     thin at the tip and centimetres deep further down; at the tip itself a rounded lip of bubbly water (LIP) that
 *     catches the light.
 *   - THE BACKWASH: past the stall the tip falls back slower than it came (BACKWASH: friction, the water sinking in),
 *     the lens thins as 1/t² into a glassy film and drains into the sand at the top (DRAIN) — the edge recedes by
 *     draining, not as a rigid shape sliding back — and foam is left stranded below the reach line, popping over
 *     STRAND s; the sand stays dark for DRY s.
 *   - THE SET: events every runupPeriod, each a little early or late, each its own reach (most short, some long, in
 *     sets of about seven); their arrival lags along the beach, so the fronts come in oblique. The next bore meets the
 *     last backwash low on the face: a line of white water and a small heave where they collide.
 *
 * The layer's surface is that water: its vertices stand at the water's top (geometry with thickness, not a tint),
 * its normal the lens's own slope (the lip rounds over), rippled; where the sand under it is under the still water the
 * sea's own surface takes over (its SHORE FADE fades only the light through it, params shoreFadeEdge, so the
 * reflection runs on to the waterline), and this layer keeps only its foam there. The reflection here is the sea's:
 * the same Fresnel and cap, the same sky (the sea sky's dome, tinted as the sea tints it), the same mirror of the
 * island (mirror.ts) — no second sky model to disagree at the hand-over, and no mirrored Sun disc (the sea draws its
 * Sun as glints, never as a disc in the mirror).
 *
 * The sand under the swash (beachMaterial.ts) darkens and dries by the same events (swashAt, on swashClock).
 *
 * Foam is a raft of bubbles with holes in it — Worley cells' points as holes of every size, at two scales, the foam
 * between them, warped, torn in patches, loose bubbles in the holes (see FOAM LACE) — carried with its own event's
 * water, or lying still where it was stranded.
 */
import * as THREE from 'three/webgpu';
import { Fn, attribute, cameraPosition, cameraViewMatrix, exp, float, mix, normalize, output, positionLocal, positionWorld, screenUV, sin, smoothstep, uniform, vec2, vec3, vec4, vertexStage, viewportTexture } from 'three/tsl';
import type { ShoreUniforms } from '../../terrain/shoreRunup';
import { cellular2, fbm2, hash2 } from '../../terrain/noise';
import { coordFilter } from '../../ship/bandLimit';
import { graded } from './coast';
import { oceanSurfaceParams } from '../../params/oceanSurface';
import { causticsParams } from '../../params/caustics';
import { terrainParams } from '../../params/terrain';
import type { ReflectionShadeInput } from '../../reflection/reflectionShading';
import { SWASH, SWASH_CALM, SWASH_LAYOUT, swashField, swashFromSea, swashIn, swashRowWidth, swashSeaGone, swashUV } from './swashSim';
import { texture } from 'three/tsl';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

/** m across the shore the layer spans: inland of the still waterline (past the highest run-up), out to sea — past
 * the swash sim's seaward edge (swashSim.ts SWASH), where it is the water's whole surface */
const SPAN: [number, number] = [-12, 24];
/** m the layer floats over the sand or the still water (no fight with either) */
const LIFT = 0.025;
/** m seaward of a point the roller looks for its bore's crest (a sim bore's face is 2–3 cells, 0.2–0.3 m) */
const ROLL_AHEAD = 0.35;
/** the sim's water drawn as the sea draws its own, over a copy of the scene behind it (the hand-over seam from above,
 * 2026-10-30). It had been OFF for the final render: its own copy target cost a full-frame half-float texture per
 * render target (a farm box ran out of GPU memory with it on), and the sheet's own model it fell back on read from
 * the air as "a dark straight road" along the beach (the user, 2026-11-01). ON again, with no target of its own: its
 * copy is the SEA's (bindSwashToSea: the sea's scene-colour node is its reference, three's ViewportTextureNode keeps
 * one texture per render target per reference), copied again just before this layer draws — the opaque scene, which
 * is what this water shows through */
const SWASH_SEA_COMPOSITE = true;
/** m the froth at a sim bore's toe stands over the water */
const ROLL_LIP = 0.03;
/** albedo of foam (fresh white water; its bubbles scatter nearly everything) */
const FOAM = 0.8;
/** the most radiance (linear) the layer gives back: a Sun glint on the sheet, not a firefly (see THE SHEET) */
const SHEET_MAX = 2.5;

// THE SWASH (see the header)
/** m/s² */
const G = 9.81;
/** rise per m across our beach face (coast.ts OURS_FRONT: about 1:11), and its inverse */
const SLOPE = 1 / 11;
const RUN = 1 / SLOPE;
/** m/s²: how fast a run-up tip's RISE slows — g·sinβ along the face, its vertical share again: g·sin²β */
const A_UP = G * SLOPE * SLOPE;
/** the backwash tip's fall as a share of A_UP (friction, and the water sinking into the sand, hold it back) */
const BACKWASH = 0.6;
/** m: a bore's height at the still line, for the shortest run-up and the longest */
const BORE_H: [number, number] = [0.04, 0.14];
/** s a bore is seen before it reaches the still line; m/s its crest rises on the way in (≈ 1 m/s across the face,
 * a shallow-water wave in ~10 cm of water) */
const BORE_LEAD = 2;
const BORE_RISE = 0.09;
/** m: the rounded lip at a run-up's tip, its height and how far behind the tip it peaks */
const LIP: [number, number] = [0.014, 0.12];
/** m: the solid white line at a run-up's tip, its width across the face */
const LIP_LINE = 0.07;
/** s: the backwash sinking into the sand (its depth's time constant), the sand dark after the water left, the foam
 * left behind popping */
const DRAIN = 2.5;
const DRY = 10;
/** s the sand the water just left stays glazed with it (darker still, glossier) as it sinks in */
const FRESH = 3;
const STRAND = 3;
/** share of the period an event's start wanders; periods of age over which an event's traces go (before the
 * three-event window lets it go: a trace still there when it did would pop) */
const JITTER = 0.3;
const AGE: [number, number] = [1.25, 1.6];

/** the swash's clock (s): the terrain's swash time, kept by createShoreline — the sand (beachMaterial.ts) reads it */
export const swashClock = uniform(0);

/** the light the foam scatters, set per frame by sea.ts: the Sun's (its colour × its irradiance / π, a white surface
 * facing it) and the sky's (its irradiance / π); and the direction to the Sun (unit), for the water's glitter */
/** THE SEA'S OWN LIGHT, read where the sea reads it (surfaceMaterial.ts: its key's radiance, its haze colour — the
 * sky's light on the water — and its key's direction), bound once the sea is built (`bindSwashToSea`, sea.ts) and
 * copied in at render time, so the sim's water is lit as the sea beside it is, in the same frame */
const seaLight = {
  sun: uniform(new THREE.Color()),
  haze: uniform(new THREE.Color()),
  dir: uniform(new THREE.Vector3(0, 1, 0)),
};
let seaSource: { sunColorUniform: { value: THREE.Color }; hazeColorUniform: { value: THREE.Color }; sunDirectionUniform: { value: THREE.Vector3 }; sceneColorNode?: unknown } | null = null;
/** the shorelines' scene copies, which take the sea's as their reference (SWASH_SEA_COMPOSITE) */
const behindNodes: Array<{ referenceNode: unknown }> = [];
export function bindSwashToSea(sea: NonNullable<typeof seaSource>): void {
  seaSource = sea;
  if (sea.sceneColorNode) for (const n of behindNodes) n.referenceNode = sea.sceneColorNode;
}
seaLight.sun.onRenderUpdate(() => {
  if (seaSource) (seaLight.sun.value as THREE.Color).copy(seaSource.sunColorUniform.value);
});
seaLight.haze.onRenderUpdate(() => {
  if (seaSource) (seaLight.haze.value as THREE.Color).copy(seaSource.hazeColorUniform.value);
});
seaLight.dir.onRenderUpdate(() => {
  if (seaSource) (seaLight.dir.value as THREE.Vector3).copy(seaSource.sunDirectionUniform.value);
});
/** the sea's params, live as the sea takes them (surfaceMaterial.ts update) */
const live = <T>(init: T, read: () => T) => {
  const u = uniform(init as never);
  u.onRenderUpdate(() => read());
  return u;
};
const colourOf = (hex: () => string) => {
  const u = uniform(new THREE.Color());
  u.onRenderUpdate(() => {
    (u.value as THREE.Color).set(hex());
  });
  return u;
};
const seaWater = {
  deep: colourOf(() => oceanSurfaceParams.deepColor),
  shallow: colourOf(() => oceanSurfaceParams.shallowColor),
  sss: colourOf(() => oceanSurfaceParams.sssColor),
  shallowMix: live(0.6, () => oceanSurfaceParams.shallowTintStrength),
  shallowFull: live(6, () => oceanSurfaceParams.shallowFullDepth),
  lightFloor: live(0.62, () => oceanSurfaceParams.lightFloor),
  lightGain: live(0.62, () => oceanSurfaceParams.lightGain),
  skyDesat: live(0.5, () => oceanSurfaceParams.skylightDesaturation),
  scatter: live(new THREE.Vector2(0.22, 1.5), () => new THREE.Vector2(oceanSurfaceParams.sunScatterStrength, oceanSurfaceParams.sunScatterPower)),
  reflStrength: live(1, () => oceanSurfaceParams.reflectionStrength),
  transFloor: live(0.45, () => oceanSurfaceParams.transmissionFloor),
  pigFloor: live(new THREE.Vector2(0.14, 1), () => new THREE.Vector2(oceanSurfaceParams.pigmentFloorChroma, oceanSurfaceParams.pigmentFloorStrength)),
  shoreFade: live(0.5, () => oceanSurfaceParams.shoreFadeThickness),
  absorption: live(new THREE.Vector3(0.5, 0.17, 0.13), () => new THREE.Vector3(causticsParams.submergedAbsorptionR, causticsParams.submergedAbsorptionG, causticsParams.submergedAbsorptionB)),
};

export const swashLight = { sun: uniform(new THREE.Vector3()), sky: uniform(new THREE.Vector3()), dir: uniform(new THREE.Vector3(0, 1, 0)) };
/** the share of the Sun's light foam gives back whatever its surface's tilt: a froth of bubbles scatters it from
 * every face, not by the cosine of a flat sheet's — lit as a flat sheet, by a Sun 4–6° up, the white water came out
 * darker than the water's own mirror of the sky beside it and read as nothing (the swash v2 clips) */
const FOAM_SUN = 0.6;

export interface SwashState {
  /** m: the water's top over the still level (the sand's own rise where there is no water) */
  top: F;
  /** d top / d rise: the water surface's slope against the sand's (1 where it lies on the sand) */
  dTop: F;
  /** m of water over the sand (the lens and its lip) */
  depth: F;
  /** foam riding with the water (tips, bores, collisions, the backwash film), 0..1; and the m its lace is carried */
  moving: F;
  carry: F;
  /** foam left lying where the backwash stranded it: its line's cover 0..1, and how fresh it is (its cover × 1 just
   * stranded … 0 popped away) */
  still: F;
  stillFresh: F;
  /** 0..1: how wet the sand is from the events (1 under the water, drying behind it) */
  wet: F;
  /** 0..1: the sand the water has just left, still glazed with it (gone over FRESH s) */
  fresh: F;
  /** 0..1: solid white water — the thin lip on each run-up's tip, the spilling face of each bore (with `px`) */
  solid: F;
  /** m: the bores' height over the still water here */
  bore: F;
}

// (the project's sin-free hash of the event's whole index: fract(sin(n)·43758) came out different on Apple's GPU and on
// NVIDIA's, by up to 0.75, so every event's reach and timing differed between the Mac and the render farm —
// tests/gpuSinHash.test.ts)
const hashK = (k: F, salt: number): F => hash2(vec2(k, salt)) as F;

/**
 * The swash at `rise` m over the still water (negative under it), world `xz`, swash time `time` s: the three events
 * around now (the one before, this one, the next one's bore), each analytic in time (see the header). `px` (m a pixel
 * spans there) band-limits the solid white lines: never narrower than a pixel and a half, their coverage kept — a lip
 * a few cm wide 50 m off would otherwise be one bright line of pixels from end to end of the beach.
 */
export function swashAt(rise: F, xz: V2, time: F, px: F = float(0) as F): SwashState {
  const T = terrainParams.runupPeriod;
  const r0 = terrainParams.runupHeightMin;
  const r1 = Math.max(terrainParams.runupHeightMax, r0 + 0.01);
  // (the fronts lag along the beach, ±1.3 s over ~90 m; the reach a little more here, a little less there)
  const tt = time.sub(fbm2(xz.mul(0.011).add(vec2(5.3, 1.7)), 2).sub(0.5).mul(2.6)) as F;
  const reachAlong = fbm2(xz.div(37).add(vec2(2.2, 9.4)), 2).mul(0.3).add(0.85) as F;
  const k0 = tt.div(T).floor() as F;
  const event = (k: F) => {
    const start = k.mul(T).add(hashK(k, 1).sub(0.5).mul(JITTER * T)) as F;
    // (a set of about seven: its big ones reach far; most do not)
    const set = sin(k.mul((2 * Math.PI) / 7).add(1.3)).mul(0.5).add(0.5) as F;
    const R = float(r0).add(hashK(k, 2).pow(1.8).mul(set.mul(0.5).add(0.5)).mul(r1 - r0)).mul(reachAlong) as F;
    // (each wave breaks here and not there along the beach, in its own places: a bore whole along the beach drew one
    // white line from end to end — the review stills' swash_620)
    const breaks = smoothstep(0.32, 0.62, fbm2(xz.mul(0.22).add(vec2(hashK(k, 3).mul(97), hashK(k, 4).mul(53))), 2)) as F;
    const H = mix(float(BORE_H[0]), float(BORE_H[1]), R.sub(r0).div(r1 - r0).clamp(0, 1)).mul(breaks.mul(0.6).add(0.4)) as F;
    const ts = R.mul(2 / A_UP).sqrt() as F;
    const tau = tt.sub(start) as F;
    const age = float(1).sub(smoothstep(AGE[0] * T, AGE[1] * T, tau)) as F;
    const live = tau.greaterThan(0).select(float(1), float(0)).mul(age) as F;
    const up = tau.lessThan(ts).select(float(1), float(0)) as F;
    const tb = tau.sub(ts).max(0) as F;
    const front = mix(R.sub(tb.mul(tb).mul(0.5 * A_UP * BACKWASH)), ts.mul(A_UP).mul(tau).sub(tau.mul(tau).mul(0.5 * A_UP)), up) as F;
    // THE LENS behind the tip (m across the face behind it, its depth and that depth's slope against the rise)
    const behind = front.sub(rise).mul(RUN).max(0) as F;
    const tl = tau.max(0).add(0.35) as F;
    const lens = behind.mul(behind).div(tl.mul(tl).mul(9 * G)) as F;
    const dLens = behind.mul(-2 * RUN).div(tl.mul(tl).mul(9 * G)) as F;
    // (no deeper than the bore it came in as, settling to a couple of cm)
    const cap = H.mul(exp(tau.max(0).div(-0.9))).add(0.02) as F;
    const capped = lens.greaterThan(cap);
    const has = behind.greaterThan(0).select(float(1), float(0)).mul(live).mul(exp(tb.div(-DRAIN))) as F;
    const depth = capped.select(cap, lens).mul(has) as F;
    const dDepth = capped.select(float(0), dLens).mul(has) as F;
    // THE LIP: a rounded roll of bubbly water at the tip while it runs up, spent as it stalls
    const vigor = float(1).sub(tau.div(ts)).clamp(0, 1).sqrt().mul(up).mul(live) as F;
    const u = behind.div(LIP[1]) as F;
    const e1 = exp(float(1).sub(u)) as F;
    const lip = vigor.mul(LIP[0]).mul(u).mul(e1) as F;
    const dLip = vigor.mul(LIP[0]).mul(e1).mul(float(1).sub(u)).mul(-RUN / LIP[1]) as F;
    // THE BORE on its way in: a crest at rise BORE_RISE·τ (a little off the still line as it gets there, where the
    // lens's own depth takes over), its face 0.3 m, its back 1.4 m
    const approach = smoothstep(-BORE_LEAD, -BORE_LEAD + 0.8, tau).mul(float(1).sub(smoothstep(-0.05, 0.3, tau))).mul(age) as F;
    const db = rise.sub(tau.mul(BORE_RISE).sub(0.05)).mul(RUN) as F;
    const ahead = db.greaterThan(0);
    const face = exp(db.div(0.3).mul(db.div(0.3)).negate()) as F;
    const back = exp(db.div(1.4)) as F;
    const bore = H.mul(approach).mul(ahead.select(face, back)) as F;
    const dBore = H.mul(approach).mul(ahead.select(face.mul(db.mul(-2 / 0.09)), back.div(1.4))).mul(RUN) as F;
    const onSand = rise.add(depth).add(lip) as F;
    const top = onSand.max(bore) as F;
    const dTop = onSand.greaterThanEqual(bore).select(float(1).add(dDepth).add(dLip), dBore) as F;
    // FOAM: the tip's roll and the bubbles behind it; a thin lace over the run-up, thinner on the backwash's film;
    // the bore's white face; stranded below the reach line once it turned. (Every one eased in and out over time,
    // never switched: a term that stepped at the stall popped the foam on or off across the whole face)
    const running = float(1).sub(smoothstep(ts.mul(0.7), ts.mul(1.05), tau)) as F;
    const turned = smoothstep(ts.mul(0.95), ts.add(0.6), tau) as F;
    // (white only where this wave is still breaking; where it has run out into a glassy film the tip is clear water)
    const tip = exp(behind.div(-0.28)).mul(smoothstep(0, 0.02, behind)).mul(running).mul(live).mul(breaks.mul(0.85).add(0.15)) as F;
    const film = smoothstep(0.0004, 0.0015, depth).mul(mix(float(0.06), float(0.2), running)).mul(live) as F;
    const white = approach.mul(exp(db.sub(0.05).div(0.45).mul(db.sub(0.05).div(0.45)).negate())).mul(breaks) as F;
    // SOLID WHITE (the 2026-10-29 clip: the tip's foam read faint, the incoming crest not at all): the thin roll of
    // white at each run-up's tip, ~LIP_LINE wide, and the spilling face of each bore — white water, not a lace of it
    const lw = px.mul(1.5).max(LIP_LINE) as F;
    const lipD = behind.sub(LIP_LINE * 0.6).div(lw) as F;
    // (in patches of its own, down to nothing between them, and only where the wave is still breaking: a lip along the
    // whole tip was a white outline of the waterline — the "laser sharp edge" in a new colour, the 2026-10-29 review of
    // a604 and swash_620)
    const lipPatch = smoothstep(0.38, 0.6, fbm2(xz.mul(0.75).add(vec2(hashK(k, 5).mul(71), hashK(k, 6).mul(43))), 2)) as F;
    const lipLine = exp(lipD.mul(lipD).negate()).mul(float(LIP_LINE).div(lw)).mul(running).mul(live).mul(breaks).mul(lipPatch) as F;
    const faceD = db.sub(0.12).div(px.mul(1.5).max(0.18)) as F;
    const spill = exp(faceD.mul(faceD).negate()).mul(approach).mul(breaks) as F;
    // STRANDED (the 2026-10-29 review of beach_600: white "worms" on dry-looking sand): a thin, broken line along
    // this wave's reach, a hand's breadth down from it on the sand it wet, ~12 cm across; as it ages it thins — its
    // strands part, its bubbles pop to dots (stillFresh) — rather than fading as one stroke
    const below = R.sub(0.012).sub(rise).mul(RUN).div(0.12) as F;
    const strandBreak = smoothstep(0.3, 0.58, fbm2(xz.mul(1.6).add(vec2(hashK(k, 7).mul(61), hashK(k, 8).mul(37))), 2)) as F;
    const stranded = turned.mul(age).mul(exp(below.mul(below).negate())).mul(strandBreak) as F;
    const fresh = stranded.mul(exp(tb.div(-STRAND))) as F;
    const reached = mix(R, front, up) as F;
    const wet = rise.lessThan(reached).select(float(1), float(0)).mul(exp(tb.div(-DRY))).mul(live) as F;
    const glazed = rise.lessThan(reached).select(float(1), float(0)).mul(exp(tb.div(-FRESH))).mul(live) as F;
    return { top, dTop, depth: depth.add(lip) as F, moving: tip.max(film).max(white) as F, carry: front.max(tau.mul(BORE_RISE).sub(0.05)).mul(RUN) as F, still: stranded, stillFresh: fresh, wet, glazed, tip, solid: lipLine.mul(0.85).max(spill.mul(0.7)) as F, bore };
  };
  const evs = [event(k0.sub(1)), event(k0), event(k0.add(1))];
  // where the next bore meets the last backwash: a line of white water, and a small heave
  const collide = evs[1].tip.mul(smoothstep(0.001, 0.006, evs[0].depth)).max(evs[2].tip.mul(smoothstep(0.001, 0.006, evs[1].depth))) as F;
  let top = evs[0].top;
  let dTop = evs[0].dTop;
  for (const e of evs.slice(1)) {
    const higher = e.top.greaterThan(top);
    dTop = higher.select(e.dTop, dTop) as F;
    top = top.max(e.top) as F;
  }
  const moving = evs[0].moving.max(evs[1].moving).max(evs[2].moving) as F;
  // (each foam carried with its own event's water: where two events' foam meet, the lace moves as their foam-weighted
  // mean — chosen by the denser, it jumped from one event's pattern to the other's as they crossed)
  const wsum = evs[0].moving.add(evs[1].moving).add(evs[2].moving).max(1e-4) as F;
  const carry = evs[0].moving.mul(evs[0].carry).add(evs[1].moving.mul(evs[1].carry)).add(evs[2].moving.mul(evs[2].carry)).div(wsum) as F;
  return {
    top: top.add(collide.mul(0.012)) as F,
    dTop,
    depth: evs[0].depth.max(evs[1].depth).max(evs[2].depth) as F,
    moving: moving.max(collide) as F,
    carry,
    still: evs[0].still.max(evs[1].still).max(evs[2].still) as F,
    stillFresh: evs[0].stillFresh.max(evs[1].stillFresh).max(evs[2].stillFresh) as F,
    solid: evs[0].solid.max(evs[1].solid).max(evs[2].solid) as F,
    bore: evs[0].bore.max(evs[1].bore).max(evs[2].bore) as F,
    wet: evs[0].wet.max(evs[1].wet).max(evs[2].wet) as F,
    fresh: evs[0].glazed.max(evs[1].glazed).max(evs[2].glazed) as F,
  };
}

export interface Shoreline {
  readonly mesh: THREE.Mesh;
}

/**
 * The layer along our beach: `ground` its height (m over the sea) at world x, z; `beach` the waterline at the walk's
 * middle; `along` the stretch it covers (m up the beach, −z, from `beach`); the terrain's swash uniforms and its
 * live still-water level; the sea sky's dome and Sun (seaSky.ts), and the sea's mirror (mirror.ts), for what the
 * water mirrors.
 */
export function createShoreline(o: {
  ground: (x: number, z: number) => number;
  beach: { x: number; z: number };
  along: [number, number];
  shore: ShoreUniforms;
  waterline: THREE.Node<'float'>;
  skyDome: (dir: V3) => V3;
  skySun: (dir: V3) => V3;
  reflection?: { shade(input: ReflectionShadeInput): THREE.Node<'vec3'> };
  /** the Sun's transmittance through the clouds at a world point (seaSky.ts `cloudSun`): their shadows */
  cloudSun?: (p: V3) => F;
}): Shoreline {

  const { beach, ground } = o;
  // the grid: along the beach (fine where the eye walks), across it from the still waterline at each station
  const alongs = graded(o.along[0], o.along[1], -200, 200, 0.3, 1.2);
  const across: number[] = [];
  for (let s = SPAN[0]; s <= SPAN[1] + 1e-6; s += 0.2) across.push(s);
  /** off (m, out to sea) of the still waterline at `along`: where the ground crosses 0 */
  const waterlineOff = (along: number): number => {
    const z = beach.z - along;
    let lo = -60;
    let hi = 160;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (ground(beach.x - mid, z) > 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const nu = across.length;
  const nv = alongs.length;
  const pos = new Float32Array(nu * nv * 3);
  const groundY = new Float32Array(nu * nv);
  for (let j = 0; j < nv; j++) {
    const along = alongs[j];
    const w = waterlineOff(along);
    const z = beach.z - along;
    for (let i = 0; i < nu; i++) {
      const x = beach.x - (w + across[i]);
      const k = j * nu + i;
      const y = ground(x, z);
      // (about the beach's middle, the mesh placed there: see `xzP`)
      pos[k * 3] = x - beach.x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z - beach.z;
      groundY[k] = y;
    }
  }
  const idx = new Uint32Array((nu - 1) * (nv - 1) * 6);
  let t = 0;
  for (let j = 0; j < nv - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const a = j * nu + i;
      const b = a + 1;
      const c = a + nu;
      const d = c + 1;
      idx[t++] = a;
      idx[t++] = b;
      idx[t++] = c;
      idx[t++] = b;
      idx[t++] = d;
      idx[t++] = c;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('groundY', new THREE.BufferAttribute(groundY, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  // (one winding up: the grid's handedness depends on the beach frame)
  if ((geo.getAttribute('normal') as THREE.BufferAttribute).getY(Math.floor(nv / 2) * nu + Math.floor(nu / 2)) < 0) {
    for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
    geo.computeVertexNormals();
  }
  geo.computeBoundingSphere();

  // (MeshPhysical for its specular intensity: the water takes the sea's reflection below and no key-light highlight
  // of its own — the sea has none; the foam is lit as a rough white surface)
  // (the scene behind the water, for the sim's water: its own copy, half-float like the faces it is copied from)
  const sceneBehind = new THREE.FramebufferTexture(1, 1);
  sceneBehind.name = 'swash-scene-behind';
  (sceneBehind as unknown as { internalFormat: string }).internalFormat = 'rgba16float';
  const m = new THREE.MeshPhysicalNodeMaterial({ transparent: true, depthWrite: false, metalness: 0 });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  const gY = attribute('groundY', 'float') as F;
  const xz = positionWorld.xz as V2;
  // THE PATTERNS' COORDINATES, m from the beach's middle. The coast lies 40 km out, where a 32-bit world position
  // steps every 4 mm, and the noises read it multiplied by up to 37/m: their cells came out in flat steps a few mm
  // apart, the water's ripples one regular ruling across the beach, which the pixels beat into fine arcs of moiré
  // over the swash ("this weird moiré pattern", the 2026-10-30 note). Local to the mesh they are exact; the world
  // position stays for what must agree with the sand (swashAt) and the sim's fields (metre-scale lookups)
  const xzP = positionLocal.xz as V2;
  /** world xz at the vertex (the mesh is placed at the beach's middle) */
  const xzV = positionLocal.xz.add(vec2(beach.x, beach.z)) as V2;
  const heightAbove = gY.sub(o.waterline) as F;
  // (the sand's clock: the terrain swash's own time, the sea's — pushed per frame by sea.ts)
  swashClock.onRenderUpdate(() => (o.shore.time as unknown as { value: number }).value);

  // THE SWASH (swashAt): the water's top at the vertex (geometry with thickness), and per fragment everything else
  const swV = swashAt(heightAbove, xzV, o.shore.time as unknown as F);
  // (never below the sand; LIFT over it where there is no water)
  const yEvents = o.waterline.add(swV.top.max(heightAbove)).add(LIFT) as F;
  // THE SIMULATED SWASH (swashSim.ts) over its domain: the water's own surface η where there is water, the sand
  // (LIFT over it) where there is none; the analytic events beyond it, crossfaded over a band (simIn)
  const simUV = swashUV;
  const simIn = swashIn;
  const wV = texture(swashField.water, simUV(xzV)).level(float(0)) as unknown as THREE.Node<'vec4'>;
  // (a bore's toe stands a few cm proud of the water ahead of it, a lip of froth: where the water 0.35 m seaward
  // stands ~0.1 m higher, the front is about to arrive, ROLL_LIP m; the 2026-10-30 note: "a slightly lifted, bubbly lip")
  const wBack = texture(swashField.water, simUV(xzV.sub(vec2(ROLL_AHEAD, 0)) as V2)).level(float(0)) as unknown as THREE.Node<'vec4'>;
  const lipV = smoothstep(0.04, 0.12, wBack.x.sub(wV.x)).mul(smoothstep(0.004, 0.02, wV.y)) as F;
  const ySim = mix(gY.add(LIFT), wV.x.add(0.002).add(lipV.mul(ROLL_LIP)), smoothstep(0.0003, 0.002, wV.y)) as F;
  const yNew = mix(yEvents, ySim, simIn(xzV)) as F;
  // THE CLOUDS' SHADOWS, the same transmittance as the sea's and the sand's (seaSky.ts cloudSun), read at the vertex
  // (two filterable 3D textures; ~100 m soft, the grid's cells 0.2–1.2 m): on the foam's sunlight and on the Sun's
  // mirror in the water, so a shadow runs on across the waterline
  const cloudV = (o.cloudSun ? vertexStage(o.cloudSun(vec3(xzV.x, 0, xzV.y) as V3)) : float(1)) as F;
  /** m one pixel spans on the sand here */
  const footprint = (() => {
    const f = coordFilter(xzP) as V2;
    return f.x.max(f.y) as F;
  })();
  const sw = swashAt(heightAbove, xz, o.shore.time as unknown as F, footprint);
  const water0 = smoothstep(0.0003, 0.002, sw.depth) as F;
  // (where the sand under the layer is under the still water, the sea's surface is the water's: this layer keeps
  // only its foam there — two mirrors of one sky one over the other were the bright band at the waterline)
  // (but where a bore stands up out of the sea, its face is the water's surface: it takes the sky at its own tilt — the
  // crest catching the light)
  const overSea = smoothstep(-0.001, -0.012, heightAbove).mul(float(1).sub(smoothstep(0.006, 0.025, sw.bore))) as F;

  // FOAM LACE (see the header): carried with its event's water, or lying where it was stranded
  const warp = vec2(fbm2(xzP.mul(2.7), 3), fbm2(xzP.mul(2.7).add(7.3), 3))
    .sub(0.5)
    .mul(0.3)
    .add(vec2(fbm2(xzP.mul(9.1).add(2.1), 2), fbm2(xzP.mul(9.1).add(5.9), 2)).sub(0.5).mul(0.07)) as V2;
  /** how far the pattern of `q` (cells per unit) is from a pixel: 0 resolved … 1 a cell per pixel and finer */
  const unresolved = (q: V2): F => {
    const f = coordFilter(q) as V2;
    return smoothstep(0.25, 0.7, f.x.max(f.y)) as F;
  };
  /** the lace at `at`: 1 on foam, 0 in a hole — holes round each cell's point at two scales, each its own radius,
   * opened where the foam is thin (two big holes side by side leave no strand: the web breaks), shrunk where it is
   * dense; loose bubbles in the holes; each scale fading to its mean cover before its cells reach a pixel */
  const laceAt = (at: V2, density: F, opacity: F = density.mul(1.5).clamp(0, 1) as F, dots: F = density.mul(0.7) as F): F => {
    const raft = (scale: number, seed: [number, number], rMin: number, rMax: number, shrink: number): F => {
      const q = at.mul(scale).add(vec2(...seed)) as V2;
      const c = cellular2(q) as V3;
      const r = mix(float(rMin), float(rMax), c.z).mul(mix(float(1.25), float(shrink), density)) as F;
      const open = smoothstep(r, r.add(0.1), c.x) as F;
      const mean = float(1 - Math.PI * ((rMin + rMax) / 2) ** 2 * 0.8) as F;
      return mix(open, mean, unresolved(q)) as F;
    };
    const q = at.mul(26).add(vec2(31.7, 9.2)) as V2;
    const c = cellular2(q) as V3;
    const br = c.z.mul(c.z).mul(0.32) as F;
    const bubbles = smoothstep(br, br.mul(0.5), c.x).mul(dots).mul(float(1).sub(unresolved(q))) as F;
    // (torn in patches, more where it is thin; its whiteness uneven)
    const tear = smoothstep(0.3, 0.55, fbm2(at.mul(2.2).add(vec2(4.4, 1.3)), 3).add(density.mul(0.35))) as F;
    const body = fbm2(at.mul(5.3).add(vec2(8.8, 2.2)), 2).mul(0.6).add(0.55) as F;
    return raft(3.4, [0, 0], 0.32, 0.62, 0.35)
      .mul(raft(10.5, [13.1, 4.7], 0.22, 0.55, 0.5))
      .max(bubbles)
      .mul(tear)
      .mul(body)
      .mul(opacity)
      .clamp(0, 1) as F;
  };
  const movingD = sw.moving.clamp(0, 1) as F;
  // (the stranded line: thin lace whose holes open as it ages, its last bubbles lingering as dots)
  const stillFresh = sw.stillFresh.div(sw.still.max(1e-4)).clamp(0, 1) as F;
  // (the solid white over the lace: its body uneven, thick roll here, thinner there)
  const solidBody = fbm2(xzP.mul(1.7).add(vec2(6.1, 2.9)), 2).mul(0.7).add(0.65) as F;
  const foamNew = sw.solid.mul(solidBody).clamp(0, 0.95).max(laceAt(xzP.sub(vec2(sw.carry.mul(0.8), 0)).add(warp) as V2, movingD))
    // (at 2.5× finer cells — ~12 cm and 4 cm holes, 1.5 cm bubbles — and 0.65 opacity: the line is ~12 cm across, and
    // the coarse lace's 29 cm holes could not open inside it, so it read as solid white squiggles, "worms", in
    // beach_600, the 2026-10-29 review)
    .max(laceAt(xzP.add(warp).mul(2.5).add(vec2(3.7, 11.3)) as V2, stillFresh.mul(0.5), sw.still.mul(0.65).clamp(0, 1) as F, stillFresh.sqrt().mul(0.6) as F)) as F;

  // THE SIM'S WATER here: depth, velocity, its surface's slope (central differences over a cell), its foam
  const sIn = simIn(xz);
  const suv = simUV(xz);
  const wS = texture(swashField.water, suv) as unknown as THREE.Node<'vec4'>;
  const mS = texture(swashField.marks, suv) as unknown as THREE.Node<'vec4'>;
  const du = vec2(1 / SWASH.nx, 0) as V2;
  // (a cell along, in this row's lookup: the rows coarsen along the shore beyond the core, swashSim.ts SWASH_ROWS)
  const dv = vec2(0, float(SWASH.cell / SWASH_LAYOUT.nz).div(swashRowWidth(xz))) as V2;
  const etaAt = (q: V2): F => (texture(swashField.water, q) as unknown as THREE.Node<'vec4'>).x as F;
  const gEta = vec2(etaAt(suv.add(du)).sub(etaAt(suv.sub(du))), etaAt(suv.add(dv)).sub(etaAt(suv.sub(dv)))).div(2 * SWASH.cell) as V2;
  const hS = wS.y as F;
  // (water from ~1.5 mm: the backwash's last film below that sinks in as the sand's glaze, beachMaterial.ts)
  const waterS = smoothstep(0.0012, 0.004, hS) as F;
  // (a glassy film where it is thin; rippled where it is deep and running)
  // (and everywhere the sea's own small chop over the swell's slope — a smooth slope mirrored one darker band of sky
  // along each crest, the v2 clips — a glassy film only where it is a few mm thin)
  // (a film only a few mm thin keeps some of it: sand grains, bubbles and the flow pucker it — a mirror-smooth film
  // took the low Sun's whole aureole as one white slab, the sim6 close clip at 649 s)
  const rough = mix(float(0.45), float(1), smoothstep(0.004, 0.04, hS)).mul(smoothstep(0.1, 0.8, vec2(wS.z, wS.w).length()).mul(0.4).add(0.6)) as F;
  const flowT = (o.shore.time as unknown as F).div(1.2);
  // FOAM, the sim's: its field drawn as lace carried by the water (two phases of a flow map, a 1.2 s cycle, each
  // advected half a cycle, crossfaded so neither's reset shows); its bores' steep faces solid white; its stranded
  // foam the fine lace
  const flowAt = (ph: F): V2 => xzP.sub(vec2(wS.z, wS.w).mul(ph.fract().sub(0.5).mul(1.2))) as V2;
  const ph0 = flowT as F;
  const ph1 = flowT.add(0.5) as F;
  const wPh = ph0.fract().sub(0.5).abs().mul(2) as F;
  // (its holes never closing: the dense foam behind a bore drawn solid lay along the water as one smooth pale band,
  // the tower agent's beach_650 still, 2026-10-29)
  const foamDS = mS.x.clamp(0, 0.75) as F;
  // (drawn out across the shore, 1.8× its width: the foam a bore leaves smears into streaks behind it as it runs up
  // and back, the 2026-10-30 note)
  const smear = (q: V2): V2 => vec2(q.x.mul(0.55), q.y) as V2;
  const laceS = mix(laceAt(smear(flowAt(ph0).add(warp) as V2), foamDS), laceAt(smear(flowAt(ph1).add(warp).add(vec2(5.3, 2.1)) as V2), foamDS), wPh) as F;
  const steepS = gEta.length() as F;
  // (none in the sim's outer metres, as it makes none there: the sea takes over beyond them, SWASH_CALM)
  const calmS = smoothstep(SWASH_CALM[0], SWASH_CALM[1], swashFromSea(xz)) as F;
  // (the breaking face white and aerated where it is steep, in sections: a front breaks here and runs on unbroken
  // there, sections metres long that hold as it comes in (stretched across the shore). Whole and with the dense foam
  // behind it, it was a pale band as long as the beach)
  const sections = smoothstep(0.35, 0.6, fbm2(vec2(xzP.y.mul(0.45), xzP.x.mul(0.08)).add(vec2(2.3, 7.1)), 2)) as F;
  // (and never one smooth white: torn into clumps and the streaks the water draws down the face — 0.3 m along the
  // front, 1.7 m across it, so they still resolve where the grazing view squeezes the across-shore metres into a few
  // pixels — carried with the water as the lace is. Smooth, the face read as a pale sheet lying on the water)
  const clumpAt = (q: V2): F => smoothstep(0.34, 0.62, fbm2(vec2(q.y.mul(3), q.x.mul(0.6)).add(vec2(8.1, 3.3)), 3)) as F;
  const clumps = mix(clumpAt(flowAt(ph0)), clumpAt(flowAt(ph1).add(vec2(2.9, 6.4)) as V2), wPh) as F;
  // THE ROLLER, ragged and aerated (the 2026-10-30 note on the sim6 clips: "crisp straight top/bottom edges"): its
  // edges wander with the foam's own noise, carried with the water — the steepness it starts at moved ±0.17 — and
  // a lip of froth and bubbles runs just ahead of its toe, where the water 0.35 m seaward stands higher (ROLL_AHEAD,
  // lifted ROLL_LIP in the vertex stage)
  const rollAt = (q: V2): F => fbm2(vec2(q.y.mul(5), q.x.mul(1.6)).add(vec2(1.7, 9.2)), 3) as F;
  const roll = mix(rollAt(flowAt(ph0)), rollAt(flowAt(ph1).add(vec2(4.2, 1.9)) as V2), wPh) as F;
  const faceS = smoothstep(0.1, 0.3, steepS.add(roll.sub(0.5).mul(0.35))) as F;
  const frontS = faceS.mul(calmS).mul(sections).mul(clumps).mul(smoothstep(0.008, 0.03, hS)).mul(solidBody).clamp(0, 0.92) as F;
  const riseAhead = etaAt(suv.sub(vec2(ROLL_AHEAD / (SWASH.nx * SWASH.cell), 0)) as V2).sub(wS.x) as F;
  const lipM = smoothstep(0.04, 0.12, riseAhead.add(roll.sub(0.5).mul(0.06))).mul(float(1).sub(faceS)).mul(calmS).mul(sections).mul(smoothstep(0.004, 0.02, hS)) as F;
  const lipS = laceAt(xzP.add(warp).mul(1.8).add(vec2(9.4, 2.6)) as V2, lipM.mul(0.6) as F, lipM.mul(0.85) as F, lipM) as F;
  const strandS = laceAt(xzP.add(warp).mul(2.5).add(vec2(3.7, 11.3)) as V2, mS.y.mul(0.5) as F, mS.y.mul(0.9).clamp(0, 0.65) as F, mS.y.sqrt().mul(0.6) as F) as F;
  const foamS = frontS.max(laceS).max(strandS).max(lipS) as F;

  // THE SURFACE: the lens's slope over the sand's (the sand's own rise gradient from the grid's normal), rippled
  const nG = attribute('normal', 'vec3') as V3;
  const gradRise = vec2(nG.x.negate(), nG.z.negate()).div(nG.y.max(0.2)) as V2;
  const grad = gradRise.mul(sw.dTop) as V2;
  const ripple = vec3(fbm2(xzP.mul(1.3).sub(vec2(sw.carry, 0)), 3).sub(0.5), 0, fbm2(xzP.mul(1.3).add(vec2(5.1, 2.7)), 3).sub(0.5)).mul(0.22).mul(water0) as V3;
  const nEvents = normalize(vec3(grad.x.negate(), 1, grad.y.negate()).add(ripple)) as V3;
  // THE SEA'S SMALL WAVES on it (the 2026-10-30 note: "the same micro-roughness/normal detail as the sea beside
  // it"): five octaves from ~0.9 m to ~3 cm, slope ~0.12 rms all told (the sea's own short waves: its glitter road
  // breaks where the old two octaves, 0.05 rms, mirrored the low Sun's aureole as one white slab and a crest's back
  // the dark forest as one band), each fading out on its own size before a pixel can hold it — band-limited, so
  // what a pixel cannot see goes, rather than sizzles
  // (the two longest drawn out along the shore, as a swell's ripples run along their crests: round, they mirrored the
  // high sky as dark blotches a metre across, nothing like the streaked sea beyond)
  const octave = (k: number, a: number, seed: number, along = 1): V3 => {
    const q = xzP.mul(vec2(k, k * along)) as V2;
    const c = vec3(fbm2(q.add(vec2(seed, 0.4)), 2).sub(0.5), 0, fbm2(q.add(vec2(4.1, seed)), 2).sub(0.5)) as V3;
    return c.mul(a).mul(smoothstep(0.5, 0.25, footprint.mul(k))) as V3;
  };
  const rippleS = octave(1.1, 0.2, 3.3, 0.3).add(octave(2.9, 0.3, 1.7, 0.4)).add(octave(7.3, 0.5, 6.2)).add(octave(17, 0.55, 8.4)).add(octave(37, 0.5, 2.8)).mul(rough) as V3;
  // (its slope held to an unbroken swell's, 0.15: a bore in the sim is a first-order shock, its face 2–3 cells, ~45°,
  // steeper than any water face that is not white — drawn so, it mirrored one patch of high sky as a smooth band the
  // length of the beach, pale or dark with the sky's height, the tower agent's beach_650 still, 2026-10-29. Its
  // breaking sections are white (frontS); the rest reads as the swell it would be)
  const gN = gEta.mul(float(0.15).div(gEta.length().max(0.15))) as V2;
  const nSim = normalize(vec3(gN.x.negate(), 1, gN.y.negate()).add(rippleS)) as V3;
  const nNew = normalize(mix(nEvents, nSim, sIn)) as V3;

  // THE REFLECTION: the sea's (surfaceMaterial.ts): Schlick at its R0 and strength, capped as it caps it over
  // shallow ground (transmissionFloor: §V.24, the floor seen through; seeThrough ≈ 1 under a swash), its sky the sea
  // sky's dome pulled toward the water's hue as it pulls it near the eye (grazingSaturation), the island in it from
  // the sea's own mirror
  const viewDir = normalize(cameraPosition.sub(positionWorld)) as V3;
  const refl = viewDir.negate().sub(nNew.mul(viewDir.negate().dot(nNew).mul(2))) as V3;
  const cosI = viewDir.dot(nNew).max(0) as F;
  const r0F = oceanSurfaceParams.fresnelR0;
  const fresnel = float(r0F).add(float(1 - r0F).mul(float(1).sub(cosI).pow(5))).mul(oceanSurfaceParams.reflectionStrength).min(1 - oceanSurfaceParams.transmissionFloor) as F;
  const hue = new THREE.Color(oceanSurfaceParams.shallowColor);
  const peak = Math.max(hue.r, hue.g, hue.b, 1e-3);
  const tint = vec3(hue.r / peak, hue.g / peak, hue.b / peak) as V3;
  const camDist = positionWorld.sub(cameraPosition).length() as F;
  const reflected = Fn(() => {
    const sky = o.skyDome(refl);
    const skyCol = mix(sky, sky.mul(tint), oceanSurfaceParams.grazingSaturation) as V3;
    return o.reflection
      ? o.reflection.shade({ skyColor: skyCol, normalWorld: nNew, viewDirection: viewDir, chop: float(0), camDist, surfacePosition: positionWorld, footprint })
      : skyCol;
  })() as unknown as V3;
  // THE SUN'S GLITTER, as the sea draws it (surfaceMaterial's sparkle). Where the mirrored ray runs within ~13° of
  // the Sun, the aureole it meets is so bright that the water took it as one bright smear, where the sea beside it
  // breaks into a glitter path (the 2026-10-30 note: "a sparkling glitter path like the sea's, not a solid white
  // slab" — the slab itself, at 649 s in the sim6 close clip, was the sand's gloss under the film: beachMaterial.ts).
  // Its light gathered into points instead: cells ~2.5 px wide (octaves of the footprint, world-locked between them),
  // a hashed point in each, about half of them lit at any moment, each twinkling at its own rate; the mean kept, so
  // the path is as bright as before, only broken
  const sunD = normalize(swashLight.dir as unknown as V3) as V3;
  const toSun = smoothstep(0.975, 0.998, refl.dot(sunD)) as F;
  const cellSz = float(2).pow(footprint.mul(2.5).max(0.004).log2().floor()) as F;
  // (cells counted from the beach's middle, hashed without sin: sin(dot(cell, …)) of a cell index 40 km out, in
  // 32-bit floats, came out as rings and stripes of moiré down the glitter path)
  const cellQ = xzP.div(cellSz) as V2;
  const cellI = cellQ.floor() as V2;
  const hash = (salt: number): F => {
    const p3 = vec3(cellI.x, cellI.y, cellI.x).mul(vec3(0.1031, 0.103, 0.0973)).add(salt).fract() as V3;
    const p4 = p3.add(p3.dot(vec3(p3.y, p3.z, p3.x).add(33.33))) as V3;
    return p4.x.add(p4.y).mul(p4.z).fract() as F;
  };
  const hashA = hash(0.13);
  const hashB = hash(0.57);
  const hashC = hash(0.91);
  const lit = smoothstep(0.5, 0.42, hashA.add((o.shore.time as unknown as F).mul(hashB.mul(0.9).add(0.4))).fract()) as F;
  const pt = vec2(hashB, hashC).mul(0.5).add(0.25) as V2;
  const spot = smoothstep(0.32, 0.1, cellQ.sub(cellI).sub(pt).length()) as F;
  // (mean of lit·spot ≈ 0.5 × 0.14; the dark between the points keeps 0.3 of the light)
  const glitter = float(0.3).add(lit.mul(spot).mul(0.7 / 0.07)) as F;
  // (under a cloud's shadow the Sun is gone from its mirror too: the ray to it crosses the same cloud)
  const reflectedG = reflected.mul(mix(float(1), glitter.mul(cloudV), toSun)) as V3;
  const waterEv = fresnel.mul(water0).mul(float(1).sub(overSea)).mul(float(1).sub(foamNew)) as F;
  // THE SIM'S WATER is the whole surface over its domain (the sea is faded out there, surfaceMaterial shoreSim), and
  // it is drawn AS the sea draws its water (surfaceMaterial.ts, the transmission channel), from the sea's own params,
  // light and scene copy, so the two are one water at the hand-over (the 2026-10-30 aerials: the sim's strip, drawn
  // as a film over the sand in a model of its own, read from above as a brown band ruled off a turquoise sea):
  //   L = F·L_refl + (1 − F)·[T·L_behind + (1 − T)·L_body], the mirror capped by what shows through it, the
  //   transmitted light thinned to the scene behind over the last of the water, the pigment floor re-tinting a
  //   low-chroma composite toward the water's hue
  // · the light's path through h along the refracted ray (h / cos θt, θt from Snell at n = 1.333) and down to the sand
  //   (h), as the sea's (refractedLightPath, submergedLightPath), at the sea's own absorption
  const seaComp = (() => {
  const pathS = hS.div(float(1).sub(float(1).sub(cosI.mul(cosI)).div(1.333 * 1.333)).sqrt()).add(hS) as F;
  const trans = exp((seaWater.absorption as unknown as V3).mul(pathS).negate()) as V3;
  // · the body: the deep pigment pulled to the shallow one by the depth, lit by the sky's light and the key's, with
  //   the key's light the body scatters back (the sea's waterCol, lightWrap, bodyScatter; the clouds' shadow on the
  //   key's share). A crest's thin water lit through from behind and below lifts it (the turquoise of a lagoon wave's
  //   face)
  const shallowF = smoothstep(seaWater.shallowFull as unknown as F, float(0), hS) as F;
  const pigment = mix(seaWater.deep as unknown as V3, seaWater.shallow as unknown as V3, (seaWater.shallowMix as unknown as F).mul(shallowF)) as V3;
  const haze = seaLight.haze as unknown as V3;
  const skylight = mix(haze, vec3(haze.dot(vec3(0.2126, 0.7152, 0.0722))), (seaWater.skyDesat as unknown as F).clamp(0, 1)) as V3;
  const ndlS = nNew.dot(normalize(seaLight.dir as unknown as V3)).max(0) as F;
  const keyS = (seaLight.sun as unknown as V3).mul(cloudV) as V3;
  const scatterU = seaWater.scatter as unknown as V2;
  const crestLift = smoothstep(0.03, 0.14, steepS).mul(smoothstep(0.6, 0.08, hS)).mul(0.9) as F;
  const bodyS = pigment
    .mul(skylight.mul(seaWater.lightFloor as unknown as F).add(keyS.mul(ndlS.mul(seaWater.lightGain as unknown as F))))
    .add((seaWater.sss as unknown as V3).mul(keyS).mul(ndlS.pow(scatterU.y.max(0.05)).mul(scatterU.x)))
    .mul(crestLift.add(1)) as V3;
  // · behind it the scene as it stands (the sand, the floor), copied as the sea copies it (a half-float target: the
  //   film's faces are drawn into one, and a copy in the canvas's format fails every frame — surfaceMaterial §V24)
  const behindNode = viewportTexture(screenUV, null, sceneBehind);
  behindNodes.push(behindNode as unknown as { referenceNode: unknown });
  if (seaSource?.sceneColorNode) (behindNode as unknown as { referenceNode: unknown }).referenceNode = seaSource.sceneColorNode;
  const behind = (behindNode as unknown as THREE.Node<'vec4'>).rgb as V3;
  const throughBody = mix(bodyS, behind, trans.mul(0.9)) as V3;
  const shoreBody = smoothstep(float(0), (seaWater.shoreFade as unknown as F).max(1e-3), hS) as F;
  const transmitted = mix(behind, throughBody, shoreBody) as V3;
  const fresnelRaw = float(r0F).add(float(1 - r0F).mul(float(1).sub(cosI).pow(5))) as F;
  const reflW = fresnelRaw.mul(seaWater.reflStrength as unknown as F).min(float(1).sub((seaWater.transFloor as unknown as F).clamp(0, 0.9).mul(trans.y))).clamp(0, 1) as F;
  const compS = mix(transmitted, reflectedG, reflW) as V3;
  const cHi = compS.x.max(compS.y).max(compS.z) as F;
  const chroma = cHi.sub(compS.x.min(compS.y).min(compS.z)).div(cHi.max(1e-4)) as F;
  const pigU = seaWater.pigFloor as unknown as V2;
  const pigNeed = smoothstep(pigU.x, float(0), chroma).mul(pigU.y.clamp(0, 1)).mul(float(1).sub(foamS.clamp(0, 1))).mul(shoreBody) as F;
  const bodyTint = bodyS.div(bodyS.x.max(bodyS.y).max(bodyS.z).max(1e-4)) as V3;
  const colourS = mix(compS, compS.mul(bodyTint).div(bodyTint.dot(vec3(0.2126, 0.7152, 0.0722)).max(1e-4)), pigNeed) as V3;
  // (the water whole where it is: the composite carries what shows through it — but only where the sea has let go of
  // the surface (surfaceMaterial shoreSim: faded out 4–6 m in from the domain's edge, 8–12 m in from its ends). Under
  // the sea a whole water of its own was seen through the sea's own: water twice, a bright turquoise stripe along the
  // hand-over in the first aerial of it. Over the band the two cross: the sea's share of the sim's water in what it
  // sees through peaks at a quarter, mid-band)
  // (and on the sand above the still water, where the sea draws nothing: the run-up's sheets stay drawn through the
  // ends' 30 m crossfade, where the sea has not let go of its water yet)
  const seaGone = swashSeaGone(xz).max(smoothstep(0, 0.04, heightAbove)) as F;
  const waterS2 = waterS.mul(float(1).sub(foamS)).mul(seaGone) as F;
    return { colourS, waterS2 };
  })();
  // (SWASH_SEA_COMPOSITE off: the sheet's own model — a film over the sand, its body the sky's light × SWASH_BODY,
  // Beer–Lambert at 3× the lagoon's absorption — the look of the 2026-10-30 evening renders)
  const pathS0 = hS.div(float(1).sub(float(1).sub(cosI.mul(cosI)).div(1.333 * 1.333)).sqrt()).add(hS) as F;
  const trans0 = exp(vec3(1.5, 0.5, 0.4).mul(pathS0).negate()) as V3;
  const tAvg0 = trans0.x.add(trans0.y).add(trans0.z).div(3) as F;
  const bodyS0 = tint.mul((swashLight.sky as unknown as V3).mul(0.12)) as V3;
  const crestLift0 = smoothstep(0.03, 0.14, steepS).mul(smoothstep(0.6, 0.08, hS)).mul(0.9) as F;
  const colourS0 = reflectedG
    .mul(fresnel)
    .add(bodyS0.mul(vec3(1).sub(trans0).add(crestLift0)).mul(float(1).sub(fresnel)))
    .div(fresnel.add(float(1).sub(fresnel).mul(float(1).sub(tAvg0))).max(1e-4)) as V3;
  const waterS20 = fresnel.add(float(1).sub(fresnel).mul(float(1).sub(tAvg0))).mul(waterS).mul(float(1).sub(foamS)) as F;
  const colourS = (SWASH_SEA_COMPOSITE ? seaComp.colourS : colourS0) as V3;
  const waterS2 = (SWASH_SEA_COMPOSITE ? seaComp.waterS2 : waterS20) as F;
  const foamAll = mix(foamNew, foamS, sIn) as F;
  const waterNew = mix(waterEv, waterS2, sIn) as F;
  // (foam OVER the water: the water's share already leaves the foam's out, waterS2 and waterEv. Their max instead
  // let half-foamed deep water go half transparent, and the sand under the sea's hand-over showed through as a dark
  // band along it — the tower agent's beach_650 still, 2026-10-29, pale where that foam was whiter)
  const alphaNew = waterNew.add(foamAll.mul(0.96)).clamp(0, 1) as F;
  const shareNew = foamAll.div(alphaNew.max(1e-4)).clamp(0, 1) as F;

  m.positionNode = vec3(positionLocal.x, yNew, positionLocal.z);
  m.colorNode = vec4(vec3(FOAM).mul(shareNew), 1);
  m.roughnessNode = mix(float(0.06), float(0.85), shareNew);
  m.specularIntensityNode = shareNew;
  const foamGlow = (swashLight.sun as unknown as V3).mul(FOAM_SUN).mul(cloudV).add(swashLight.sky as unknown as V3).mul(FOAM * 0.6) as V3;
  m.emissiveNode = mix(reflectedG, colourS, sIn).mul(waterNew.div(alphaNew.max(1e-4))).add(foamGlow.mul(shareNew));
  m.opacityNode = alphaNew;
  if (o.cloudSun) (m as unknown as { receivedShadowNode: unknown }).receivedShadowNode = (sh: F) => sh.mul(cloudV);
  // (the shading normal, view space: the water's own surface; foam lit as a rough white surface on the same normal)
  m.normalNode = normalize(cameraViewMatrix.mul(vec4(nNew, 0)).xyz);
  // NO FIREFLIES (the same review: "one round, white glowing blob on the swash"): a near-mirror on low, metre-long
  // ripples makes one compact image of the low Sun, radiance in the thousands, which the bloom blew up into a ball.
  // Capped at SHEET_MAX: a bright glint still, not a light source
  m.outputNode = vec4(output.rgb.min(vec3(SHEET_MAX)), output.a);

  const mesh = new THREE.Mesh(geo, m);
  mesh.name = 'coast-shoreline';
  // (its vertices about the beach's middle, `xzP`: the parent is the world's frame)
  mesh.position.set(beach.x, 0, beach.z);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  // (drawn BEFORE the sea, among the transparents: the sea writes depth even where it is faded out over the swash
  // sim, and the sim's water in a trough under the sea's still level failed the depth test against it — the sand
  // showed through in bands the shape of the troughs (the swash v2 stills). Drawn first, the layer is tested against
  // the sand alone, and the sea then lays itself over it at its own opacity: none over the sim, all of it beyond)
  mesh.renderOrder = -0.25;
  // (its water stands up to a bore's height over the still level: the culling sphere reaches it)
  if (geo.boundingSphere) geo.boundingSphere.radius += BORE_H[1];
  return { mesh };
}
