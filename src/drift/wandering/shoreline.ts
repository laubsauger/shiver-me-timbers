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
import { Fn, attribute, cameraPosition, cameraViewMatrix, exp, float, mix, normalize, output, positionLocal, positionWorld, sin, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import type { ShoreUniforms } from '../../terrain/shoreRunup';
import { cellular2, fbm2 } from '../../terrain/noise';
import { coordFilter } from '../../ship/bandLimit';
import { graded } from './coast';
import { oceanSurfaceParams } from '../../params/oceanSurface';
import { terrainParams } from '../../params/terrain';
import type { ReflectionShadeInput } from '../../reflection/reflectionShading';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

/** m across the shore the layer spans: inland of the still waterline (past the highest run-up), out to sea */
const SPAN: [number, number] = [-12, 7];
/** m the layer floats over the sand or the still water (no fight with either) */
const LIFT = 0.025;
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

const hashK = (k: F, salt: number): F => sin(k.mul(12.9898).add(salt * 78.233)).mul(43758.5453).fract() as F;

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
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
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
  const m = new THREE.MeshPhysicalNodeMaterial({ transparent: true, depthWrite: false, metalness: 0 });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  const gY = attribute('groundY', 'float') as F;
  const xz = positionWorld.xz as V2;
  const heightAbove = gY.sub(o.waterline) as F;
  // (the sand's clock: the terrain swash's own time, the sea's — pushed per frame by sea.ts)
  swashClock.onRenderUpdate(() => (o.shore.time as unknown as { value: number }).value);

  // THE SWASH (swashAt): the water's top at the vertex (geometry with thickness), and per fragment everything else
  const swV = swashAt(heightAbove, positionLocal.xz as V2, o.shore.time as unknown as F);
  // (never below the sand; LIFT over it where there is no water)
  const yNew = o.waterline.add(swV.top.max(heightAbove)).add(LIFT) as F;
  /** m one pixel spans on the sand here */
  const footprint = (() => {
    const f = coordFilter(xz) as V2;
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
  const warp = vec2(fbm2(xz.mul(2.7), 3), fbm2(xz.mul(2.7).add(7.3), 3))
    .sub(0.5)
    .mul(0.3)
    .add(vec2(fbm2(xz.mul(9.1).add(2.1), 2), fbm2(xz.mul(9.1).add(5.9), 2)).sub(0.5).mul(0.07)) as V2;
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
  const solidBody = fbm2(xz.mul(1.7).add(vec2(6.1, 2.9)), 2).mul(0.7).add(0.65) as F;
  const foamNew = sw.solid.mul(solidBody).clamp(0, 0.95).max(laceAt(xz.sub(vec2(sw.carry.mul(0.8), 0)).add(warp) as V2, movingD))
    // (at 2.5× finer cells — ~12 cm and 4 cm holes, 1.5 cm bubbles — and 0.65 opacity: the line is ~12 cm across, and
    // the coarse lace's 29 cm holes could not open inside it, so it read as solid white squiggles, "worms", in
    // beach_600, the 2026-10-29 review)
    .max(laceAt(xz.add(warp).mul(2.5).add(vec2(3.7, 11.3)) as V2, stillFresh.mul(0.5), sw.still.mul(0.65).clamp(0, 1) as F, stillFresh.sqrt().mul(0.6) as F)) as F;

  // THE SURFACE: the lens's slope over the sand's (the sand's own rise gradient from the grid's normal), rippled
  const nG = attribute('normal', 'vec3') as V3;
  const gradRise = vec2(nG.x.negate(), nG.z.negate()).div(nG.y.max(0.2)) as V2;
  const grad = gradRise.mul(sw.dTop) as V2;
  const ripple = vec3(fbm2(xz.mul(1.3).sub(vec2(sw.carry, 0)), 3).sub(0.5), 0, fbm2(xz.mul(1.3).add(vec2(5.1, 2.7)), 3).sub(0.5)).mul(0.22).mul(water0) as V3;
  const nNew = normalize(vec3(grad.x.negate(), 1, grad.y.negate()).add(ripple)) as V3;

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
  const waterNew = fresnel.mul(water0).mul(float(1).sub(overSea)).mul(float(1).sub(foamNew)) as F;
  const alphaNew = waterNew.max(foamNew.mul(0.96)).clamp(0, 1) as F;
  const shareNew = foamNew.div(alphaNew.max(1e-4)).clamp(0, 1) as F;

  m.positionNode = vec3(positionLocal.x, yNew, positionLocal.z);
  m.colorNode = vec4(vec3(FOAM).mul(shareNew), 1);
  m.roughnessNode = mix(float(0.06), float(0.85), shareNew);
  m.specularIntensityNode = shareNew;
  m.emissiveNode = reflected.mul(waterNew.div(alphaNew.max(1e-4)));
  m.opacityNode = alphaNew;
  // (the shading normal, view space: the water's own surface; foam lit as a rough white surface on the same normal)
  m.normalNode = normalize(cameraViewMatrix.mul(vec4(nNew, 0)).xyz);
  // NO FIREFLIES (the same review: "one round, white glowing blob on the swash"): a near-mirror on low, metre-long
  // ripples makes one compact image of the low Sun, radiance in the thousands, which the bloom blew up into a ball.
  // Capped at SHEET_MAX: a bright glint still, not a light source
  m.outputNode = vec4(output.rgb.min(vec3(SHEET_MAX)), output.a);

  const mesh = new THREE.Mesh(geo, m);
  mesh.name = 'coast-shoreline';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  // (drawn after the sea and the sand it lies on)
  mesh.renderOrder = 2;
  // (its water stands up to a bore's height over the still level: the culling sphere reaches it)
  if (geo.boundingSphere) geo.boundingSphere.radius += BORE_H[1];
  return { mesh };
}
