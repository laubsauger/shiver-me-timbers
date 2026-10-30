/**
 * Undertime's field — "bubble-chamber cosmos": pair tracks (tracks.ts), the light of their birth and
 * annihilation (flashes.ts), the hero pair of the cold open, the dome-wide light (sky.ts), and what remains
 * (grains.ts: the grains, the web, the first stars).
 *
 * STATELESS BY DESIGN. Every instance's position, size and colour is a pure function of its index, the act
 * time and the timeline uniforms — no simulation state on the GPU — so any frame renders on its own,
 * scrubbing is free, and re-rendering frame 412 gives back frame 412.
 */
import * as THREE from 'three/webgpu';
import { float, int, ivec2, textureLoad, uniform } from 'three/tsl';
import type { DriftParams } from '../../params/drift';
import { beatStarts, eyePath, fieldClock, heroGrainPosition, sweepInverseTable, undertimeState, waveEnvelope, waveTimeAt, webFlight, type UndertimeState } from './timeline';
import { heroSlot, pairSlot, trackPositionCpu, type PairUniforms } from './pairModel';
import { HERO_TRACK_END, heroPair, survivorPair } from './scripted';
import { frontFracCpu } from './front';
import { domeBasis } from '../../cine/domeMaster';
import { rng } from './web';
import { createTracks, type TrackUniforms } from './tracks';
import { createFlashes, type FlashUniforms } from './flashes';
import { createUndertimeSky } from './sky';
import { createWaveSparks } from './wave';
import { createGrains, createHeroGrain, createStars, type GrainUniforms } from './grains';
import { eventLights, generatePairs, type PairEvent } from './events';
import { createLoopSprites, createLoopTrails } from './loops';
import { createMist, type Mist } from './mist';
import { DUST_LIGHTS, createDust } from './dust';
import { createBursts, type Burst } from './burst';
import { generateProducts, jet, type Blast, type ProductTrack } from './productModel';
import { createProducts, type ProductMeshes } from './products';
import { createSurvivorGrains, pickSurvivors, type SurvivorRest } from './survivors';
import { SWEEP_LUT, type WaveFxUniforms } from './waveFx';
import { createWebParticles, createWebVolume, type WebData } from './webVolume';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface TextPocket {
  /** deg, elevation band the crawl occupies right now */
  lo: number;
  hi: number;
  /** deg, azimuth half-width */
  az: number;
  /** 0..1 */
  strength: number;
}

/**
 * Where the eye is in the cosmic web, and how the web sits in the world (getTheDrift/webDive.ts webPlace and its
 * frame): the web's box carries the pull-back, the dive and the approach on one curve across both acts.
 */
export interface WebView {
  /** the eye's place in the box (pattern units), the box's size (world units), the eye's velocity (pattern units/s) */
  eyePat: [number, number, number];
  box: number;
  vel: [number, number, number];
  /** pattern → world, row-major */
  R: readonly number[];
  /** 0..1 the dive's near detail on (webVolume.ts createWebParticles `close`) */
  close: number;
}

export interface UndertimeField {
  readonly group: THREE.Group;
  /** keep the field out of the sky the crawl is passing through */
  setPocket(pocket: TextPocket, tiltDeg: number): void;
  /** push the timeline state for act time `t`, seen from `eye` (world position); `fade` dims what remains
   * as the next act takes over; `web`, where the eye is in the web and the web's frame (getTheDrift/webDive.ts —
   * without it, the pull-back's own flight places the web, unturned) */
  update(state: UndertimeState, t: number, eye: THREE.Vector3, fade?: number, webKeep?: number, web?: WebView): void;
  /** radians per pixel of the view about to be drawn (a cube face: (π/2)/faceSize) — ribbons never go sub-pixel */
  setPixelAngle(rad: number): void;
  dispose(): void;
}

/** texels of the birth table (field.ts BIRTH TABLE): ~0.05 s of field clock each over the act */
const BIRTH_N = 2048;

/**
 * BIRTH TABLE. A pair's fate is decided at its birth: whether it exists (the density then) and whether it
 * was born where the text is or is about to be (the pocket then). Both change through the act, and the GPU
 * cannot evaluate the timeline at an arbitrary past moment, so they are baked here against the FIELD clock
 * (what a slot's birth is measured in) into a small float texture, rebaked whenever the inputs change.
 * Without it, an extrapolated guess flipped living pairs on and off whenever the density curve turned.
 */
function bakeBirthTable(p: DriftParams, pocketAt: (t: number) => TextPocket, data: Float32Array): number {
  const { total } = beatStarts(p);
  const end = total + 10;
  const clockMax = fieldClock(end, p);
  const D = Math.PI / 180;
  for (let j = 0; j < BIRTH_N; j++) {
    const c = (j / (BIRTH_N - 1)) * clockMax;
    // the act time whose field clock is c (the clock is monotonic)
    let lo = 0;
    let hi = end;
    for (let k = 0; k < 30; k++) {
      const m = (lo + hi) / 2;
      if (fieldClock(m, p) < c) lo = m;
      else hi = m;
    }
    const t = (lo + hi) / 2;
    const pk = pocketAt(t);
    data.set([undertimeState(t, p).pairDensity, pk.lo * D, pk.hi * D, pk.strength], j * 4);
  }
  return clockMax;
}

export interface ActEvents {
  /** every pair, for loops.ts (trails, sprites), mist.ts and the lights */
  events: PairEvent[];
  /** the collisions' products (productModel.ts) */
  tracks: ProductTrack[];
  /** creation and annihilation fireballs, for burst.ts */
  blasts: Blast[];
  /** where the survivors come to rest, and when (survivors.ts) */
  rests: SurvivorRest[];
}

/**
 * The act's pairs and what they leave. U0 is one HERO event at the first-light spot, its loop plane facing the
 * audience: two photons converge on it from the left and right of the dome, and its two loops open up and out like
 * the classic picture; its gammas convert far out into the first new pairs. From the arising on, the field: births
 * at the rate the timeline's density sets, around the eye as it drifts, never right on top of it, never where the
 * text is (or is about to be); loops last longer as the field clock slows (time slows as it cools). Some are BRAIDS
 * (bound pairs), some collisions are JETS (fans of tracks), and the annihilations throw stars, kinks, conversions
 * (productModel.ts; the 2026-10-30 review: "more interesting shapes … more interesting results of particles").
 *
 * THE BUILD (timeline.ts waveEnvelope; the same review: "a better ramp into intensity"): over the cooling's last
 * seconds, births gather low in front, where the front will rise, quicker and hotter, accelerating into it.
 */
export function undertimeEvents(p: DriftParams, pocketAt: (t: number) => TextPocket): ActEvents {
  const { starts } = beatStarts(p);
  const g = heroGrainPosition(p);
  const eye0 = eyePath(p.heroBirth, p);
  const view = [g[0] - eye0[0], g[1] - eye0[1], g[2] - eye0[2]] as [number, number, number];
  const vl = Math.hypot(...view);
  const vd = view.map((x) => x / vl) as [number, number, number];
  const b = domeBasis(p.domeTilt);
  const upDot = b.axis[0] * vd[0] + b.axis[1] * vd[1] + b.axis[2] * vd[2];
  const up = b.axis.map((x, i) => x - vd[i] * upDot) as [number, number, number];
  const ul = Math.hypot(...up);
  const axis = up.map((x) => x / ul) as [number, number, number];
  const across = [vd[1] * axis[2] - vd[2] * axis[1], vd[2] * axis[0] - vd[0] * axis[2], vd[0] * axis[1] - vd[1] * axis[0]] as [number, number, number];
  // the hero's loop plane leans away from the audience (55°) and its axis leans off vertical (30°): two
  // loops seen in depth, as ellipses — face-on they would draw a symbol (a heart), not an event
  const rot = (v: number[], k: number[], a: number): [number, number, number] => {
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const kd = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
    const kx = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
    return [0, 1, 2].map((i) => v[i] * c + kx[i] * sn + k[i] * kd * (1 - c)) as [number, number, number];
  };
  const axisLeaned = rot(axis, vd, (30 * Math.PI) / 180);
  const acrossLeaned = rot(across, vd, (30 * Math.PI) / 180);
  const heroAxis = rot(axisLeaned, acrossLeaned, (55 * Math.PI) / 180);
  const hero: PairEvent = {
    birth: p.heroBirth, loop: 3.8, vertex: g, axis: heroAxis, across: acrossLeaned, open: 0.42, radius: 4.5, energy: 1, gamma: acrossLeaned,
    spiral: 0, drift: 0, arc: 2 * Math.PI - 0.84, meets: 1, burst: 3.2, end: 1,
  };
  const PEAK = 70;
  const D = Math.PI / 180;
  const rate = (t: number): number => {
    if (t < starts.arise) return 0;
    const ar = Math.min(1, (t - starts.arise) / Math.max(1e-6, p.arise));
    if (t < starts.cool) return PEAK * ar ** 2.2;
    const c = Math.min(1, (t - starts.cool) / Math.max(1e-6, p.cool));
    return PEAK * (1 - (1 - 0.05) * (1 - (1 - c) ** 6));
  };
  // not born in (or about to be in) the text's sky
  const clearOfText = (birth: number, at: readonly number[]): boolean => {
    const pk = pocketAt(birth);
    if (pk.strength <= 0.05) return true;
    const eye = eyePath(birth, p);
    const v = [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    const el = Math.asin((v[0] * b.axis[0] + v[1] * b.axis[1] + v[2] * b.axis[2]) / l) / D;
    const az = Math.atan2(v[0] * b.right[0] + v[1] * b.right[1] + v[2] * b.right[2], v[0] * b.front[0] + v[1] * b.front[1] + v[2] * b.front[2]) / D;
    return !(el > pk.lo - 6 && el < pk.hi + 6 && Math.abs(az) < pk.az + 8);
  };
  const field = generatePairs(
    {
      seed: 4711,
      // the arising builds to the boil; the cooling calms FAST to a few pairs a second (each loop lasts longer
      // as time slows, so the rate must fall further than the density)
      rate,
      from: starts.arise,
      to: starts.wave + p.wave,
      centre: (t) => eyePath(t, p),
      radius: p.fieldRadius * 0.8,
      eye: (t) => eyePath(t, p),
      clearance: 5,
      loopRadius: [0.8, 2.8],
      loopTime: [2.2, 3.8],
      // one in eight a bound pair (a braid): the cooling's graceful shape
      braid: 0.12,
    },
    PEAK,
  ).filter((e) => clearOfText(e.birth, e.vertex));
  // time slows as it cools: a loop born then lasts longer
  for (const e of field) e.loop /= Math.max(0.3, undertimeState(e.birth, p).clockRate);
  // THE BUILD: births low in front where the front will rise (centred ~23° up the dome, 12 m out), quick and hot,
  // their loops shortening as the tension rises — the field accelerating into the collapse
  const rise = (t: number): number => waveEnvelope(t, p).build;
  const eyeW = eyePath(starts.wave, p);
  const lowFront = (t: number): [number, number, number] => {
    const e = eyePath(t, p);
    return [0, 1, 2].map((i) => e[i] + b.front[i] * 12 + b.axis[i] * 5) as [number, number, number];
  };
  // (46 at first: with their products and jets the build became a tangle; 2026-10-30 first look)
  const BUILD_PEAK = 18;
  const build = generatePairs(
    {
      seed: 5151,
      rate: (t) => BUILD_PEAK * rise(t),
      from: starts.wave - p.waveBuild,
      to: starts.wave + 2.6,
      centre: lowFront,
      radius: 10,
      eye: (t) => eyePath(t, p),
      clearance: 5,
      loopRadius: [0.5, 1.9],
      loopTime: [1.1, 2.2],
      braid: 0.1,
      energyBias: 0.12,
    },
    BUILD_PEAK,
  ).filter((e) => clearOfText(e.birth, e.vertex));
  // quicker as the tension rises; their creation fireballs smaller (hot pairs low in front made orange puffs)
  for (const e of build) {
    e.loop /= 1 + 1.4 * rise(e.birth);
    e.burst *= 0.45;
  }
  // THE WAVE (U3): the front reaches a pair's direction at waveStart + frac·wave (front.ts: the same ragged edge the
  // GPU freezes trails on). A pair alive then ends where it is (both beads annihilate on the front); nothing is born
  // behind the front.
  const cutAt = (at: readonly number[]): number =>
    starts.wave + waveTimeAt(frontFracCpu([at[0] - eyeW[0], at[1] - eyeW[1], at[2] - eyeW[2]], b.front), p.waveStall) * p.wave;
  const cutPairs = (list: PairEvent[]): PairEvent[] =>
    list.filter((e) => {
      const cut = cutAt(e.vertex);
      if (e.birth >= cut) return false;
      if (e.birth + e.loop > cut) e.end = Math.max(0.02, (cut - e.birth) / e.loop);
      return true;
    });
  const cutTracks = (list: ProductTrack[]): ProductTrack[] =>
    list.filter((T) => {
      const cut = cutAt(T.start);
      if (T.t0 >= cut) return false;
      if (T.t0 + T.life > cut) T.end = Math.max(0.02, (cut - T.t0) / T.life);
      return true;
    });
  const kept = cutPairs([...field, ...build]);
  // THE SURVIVORS (survivors.ts): a few of the pairs the front catches leave their matter bead running on, out of the
  // light, to rest as a grain — the one in a billion; and the hero's onto the hero grain. Never where the remain
  // beat's text will be (it says what they are)
  const textThen = starts.remain + 3.5;
  const survivors = pickSurvivors(kept, p, Math.round(p.survivors), (at) => clearOfText(textThen, at));
  // JETS: now and then a collision is a fast particle hitting the medium, a fan of tracks out of one vertex
  // (productModel.ts jet): about one for every sixteen pairs in the boil, more of them low in front in the build
  const jr = rng(6262);
  const jetTracks: ProductTrack[] = [];
  const jetBlasts: Blast[] = [];
  const JET_PEAK = 8;
  for (let t = starts.arise; t < starts.wave + 2.6; ) {
    t += -Math.log(Math.max(1e-9, jr())) / JET_PEAK;
    const keep = jr();
    const rb = rise(t);
    const want = Math.min(JET_PEAK, rate(t) / 16 + 2 * rb);
    const off = [jr() * 2 - 1, jr() * 2 - 1, jr() * 2 - 1];
    const pos = jr();
    const beam = [jr() * 2 - 1, jr() * 2 - 1, jr() * 2 - 1];
    const en = 0.55 + 0.45 * jr();
    if (keep > want / JET_PEAK) continue;
    const ol = Math.hypot(...off) || 1;
    const inBuild = jr() < (2 * rb) / Math.max(1e-6, want);
    const c = inBuild ? lowFront(t) : eyePath(t, p);
    const R = inBuild ? 10 : p.fieldRadius * 0.7;
    const vtx = [0, 1, 2].map((i) => c[i] + (off[i] / ol) * R * Math.cbrt(pos)) as [number, number, number];
    const eye = eyePath(t, p);
    if (Math.hypot(vtx[0] - eye[0], vtx[1] - eye[1], vtx[2] - eye[2]) < 6 || !clearOfText(t, vtx) || t >= cutAt(vtx)) continue;
    const bl = Math.hypot(...beam) || 1;
    const J = jet(t, vtx, beam.map((x) => x / bl) as [number, number, number], en, jr);
    jetTracks.push(...J.tracks);
    jetBlasts.push(...J.blasts);
  }
  // and the front itself is made of the grammar: a wall of small pairs born and annihilated ON it — fireballs,
  // quick loops, braids, gamma rays, stars and fans — creation and cancellation sweeping over the audience
  const front = frontEvents(p, eyeW, b);
  // what the collisions leave: the field's are cut by the front like the pairs; the front's own run their course
  // just behind it (they are its light), and make no new pairs there
  const fieldProducts = generateProducts([hero, ...kept], 8181, { hero: 0 });
  const conversions = cutPairs(fieldProducts.conversions.filter((e) => clearOfText(e.birth, e.vertex)));
  // (few stars on the front: a thousand of them were a field of scratches, not a front; 2026-10-30 first look)
  const frontProducts = generateProducts(front.events, 8282, { conversions: false, stars: 0.3 });
  return {
    events: [hero, ...kept, ...conversions, ...front.events],
    tracks: [...cutTracks([...fieldProducts.tracks, ...jetTracks]), ...frontProducts.tracks, ...front.tracks, ...survivors.tracks],
    blasts: [hero, ...kept, ...conversions, ...front.events, ...fieldProducts.blasts, ...frontProducts.blasts, ...jetBlasts, ...front.blasts]
      .filter((x) => x.burst > 0),
    rests: survivors.rests,
  };
}

function frontEvents(p: DriftParams, eyeW: [number, number, number], b: { axis: [number, number, number]; front: [number, number, number]; right: [number, number, number] }): { events: PairEvent[]; tracks: ProductTrack[]; blasts: Blast[] } {
  const { starts } = beatStarts(p);
  const r = rng(9090);
  const out: PairEvent[] = [];
  const tracks: ProductTrack[] = [];
  const blasts: Blast[] = [];
  // (750 until the 2026-10-30 review; more, smaller on average, a few brighter: the front is a seam of events, not a
  // crowd of equal blobs)
  const N = 1200;
  const unit = (): [number, number, number] => {
    const z = r() * 2 - 1;
    const a = r() * Math.PI * 2;
    const s = Math.sqrt(1 - z * z);
    return [s * Math.cos(a), z, s * Math.sin(a)];
  };
  while (out.length < N) {
    // where on the front: its angle θ from the dome front, drawn in proportion to the front circle's length
    // (sin θ) so the front never thins out overhead, and weighted toward the CLIMAX over the audience
    const theta = r() * Math.PI;
    const climax = Math.sin(theta) ** 2;
    if (r() > Math.sin(theta) * (0.5 + 0.5 * climax)) continue;
    const phi = r() * Math.PI * 2;
    const d = [0, 1, 2].map((j) => Math.cos(theta) * b.front[j] + Math.sin(theta) * (Math.cos(phi) * b.right[j] + Math.sin(phi) * b.axis[j])) as [number, number, number];
    if (d[0] * b.axis[0] + d[1] * b.axis[1] + d[2] * b.axis[2] < -0.12) continue; // below the spring line
    // born as the front's ragged edge reaches it (front.ts), a hair before
    const t = starts.wave + waveTimeAt(Math.min(1, Math.max(0, frontFracCpu(d, b.front) + (r() - 0.5) * 0.012)), p.waveStall) * p.wave;
    const dist = 6 + r() * 18;
    const vertex: [number, number, number] = [eyeW[0] + d[0] * dist, eyeW[1] + d[1] * dist, eyeW[2] + d[2] * dist];
    // now and then the front's event is a jet: a fan thrown out of the line
    if (r() < 0.006 + 0.008 * climax) {
      const J = jet(t, vertex, unit(), 0.6 + 0.3 * r(), r);
      tracks.push(...J.tracks);
      blasts.push(...J.blasts);
      continue;
    }
    const axis = unit();
    const t0 = unit();
    const dt = t0[0] * axis[0] + t0[1] * axis[1] + t0[2] * axis[2];
    const ac = [t0[0] - axis[0] * dt, t0[1] - axis[1] * dt, t0[2] - axis[2] * dt];
    const al = Math.hypot(ac[0], ac[1], ac[2]) || 1;
    const across = ac.map((x) => x / al) as [number, number, number];
    const open = 0.25 + r() * 0.4;
    const shape = r();
    const spiralish = shape < 0.38;
    const braided = !spiralish && shape < 0.52;
    const hot = r() < 0.04 + 0.07 * climax;
    out.push({
      birth: t - 0.05,
      // short lives: the activity hugs the front line, the afterglow follows right behind it
      loop: (0.18 + r() * 0.24) * (braided ? 1.6 : 1),
      vertex,
      axis,
      across,
      open,
      radius: (0.18 + r() * 0.5) * (0.8 + 0.4 * climax),
      // a few throw gamma rays (loops.ts rayKept) and stars (productModel.ts), more of them at the climax
      energy: hot ? 0.62 + r() * 0.25 : 0.3 + r() * 0.16,
      gamma: across,
      spiral: spiralish ? 0.15 + 0.15 * r() : 0,
      drift: 0,
      arc: spiralish ? Math.PI * (2.5 + 1.5 * r()) : braided ? Math.PI * 2 * (1.5 + 1.2 * r()) : 2 * Math.PI - 2 * open,
      meets: spiralish ? 0 : 1,
      // small fireballs: hundreds at once must not bloom the dome into milk
      burst: (0.1 + r() * 0.2) * (0.7 + 0.6 * climax),
      end: 1,
      braid: braided ? 1.5 + 1.5 * r() : 0,
    });
  }
  return { events: out, tracks, blasts };
}

export function createUndertimeField(p: DriftParams, web: WebData, pocketAt: (t: number) => TextPocket = () => ({ lo: 0, hi: 0, az: 0, strength: 0 })): UndertimeField {
  const birthData = new Float32Array(BIRTH_N * 4);
  const birthTex = new THREE.DataTexture(birthData, BIRTH_N, 1, THREE.RGBAFormat, THREE.FloatType);
  birthTex.minFilter = THREE.NearestFilter;
  birthTex.magFilter = THREE.NearestFilter;
  const birthMax = uniform(1);
  let birthKey = '';
  const birthTable = (clock: F): THREE.Node<'vec4'> =>
    textureLoad(birthTex, ivec2(int(clock.div(birthMax).clamp(0, 1).mul(BIRTH_N - 1)), int(0))) as THREE.Node<'vec4'>;
  const u = {
    time: uniform(0),
    actTime: uniform(0),
    density: uniform(1),
    flashGain: uniform(1),
    haze: uniform(1),
    radius: uniform(p.fieldRadius),
    life: uniform(p.pairLife),
    speed: uniform(p.trackSpeed),
    curl: uniform(p.trackCurl),
    drag: uniform(p.trackDrag),
    tilt0: uniform(0),
    tilt1: uniform(0),
    tiltClock0: uniform(0),
    tiltClock1: uniform(1),
    eye: uniform(new THREE.Vector3()),
    eyeVel: uniform(new THREE.Vector3()),
    origin: uniform(new THREE.Vector3()),
    still: uniform(new THREE.Vector3()),
    nearRadius: uniform(9),
    nearSpeed: uniform(p.trackSpeed * 1.3),
    domeAxis: uniform(new THREE.Vector3(0, 1, 0)),
    domeFront: uniform(new THREE.Vector3(0, 0, -1)),
    domeRight: uniform(new THREE.Vector3(1, 0, 0)),
    pocketLo: uniform(0),
    pocketHi: uniform(0),
    pocketAz: uniform(0.9),
    pocket: uniform(0),
    waveClock0: uniform(1e6),
    waveRate: uniform(1),
    waveLength: uniform(1),
    tail: uniform(p.trackTail),
    width: uniform(p.trackWidth),
    pixelAngle: uniform(0.002),
    trackRadiance: uniform(p.trackRadiance),
    coreSize: uniform(p.coreSize),
    coreRadiance: uniform(p.coreRadiance),
    shellSpeed: uniform(p.shellSpeed),
    shellRadiance: uniform(p.shellRadiance),
    hazeSize: uniform(p.hazeSize),
    hazeRadiance: uniform(p.hazeRadiance),
    matter: uniform(new THREE.Color(p.matterColor)),
    anti: uniform(new THREE.Color(p.antimatterColor)),
    light: uniform(new THREE.Color(p.lightColor)),
    star: uniform(new THREE.Color(p.starColor)),
    warm: uniform(new THREE.Color()),
    // the remainder
    pivot: uniform(new THREE.Vector3()),
    scale: uniform(1),
    eyePat: uniform(new THREE.Vector3()),
    box: uniform(1),
    webPresence: uniform(0),
    webRadiance: uniform(1),
    // the web's frame (webDive.ts): world = webToWorld · pattern; the world velocity the web streams past at; the dive
    webToWorld: uniform(new THREE.Matrix3()),
    webToPattern: uniform(new THREE.Matrix3()),
    webFlow: uniform(new THREE.Vector3()),
    webClose: uniform(0),
    fill: uniform(0),
    reveal: uniform(0),
    heroGrain: uniform(0),
    stars: uniform(0),
    size: uniform(p.particleSize),
    grainRadiance: uniform(p.particleRadiance),
    starRadiance: uniform(p.starRadiance),
    // the hero pair (U0)
    // the scripted pairs (scripted.ts): CPU-placed, pushed every frame (they follow the live params)
    heroBirth: uniform(0),
    heroVertex: uniform(new THREE.Vector3()),
    heroDir: uniform(new THREE.Vector3(1, 0, 0)),
    heroField: uniform(new THREE.Vector3(0, 1, 0)),
    heroV: uniform(1),
    survBirth: uniform(0),
    survVertex: uniform(new THREE.Vector3()),
    survDir: uniform(new THREE.Vector3(1, 0, 0)),
    survField: uniform(new THREE.Vector3(0, 1, 0)),
    survAntiEnd: uniform(1),
    survAlive: uniform(0),
    waveStart: uniform(0),
    waveAct: uniform(1),
    sparkRadiance: uniform(p.sparkRadiance),
  };
  // colour and vec3 uniforms are 'color'/'vec3' to @types/three 0.186; at runtime all are vec3 (terra-sim idiom)
  const v3 = (x: unknown): V3 => x as V3;
  const m3 = (x: unknown): THREE.Node<'mat3'> => x as THREE.Node<'mat3'>;
  const matter = v3(u.matter);
  const anti = v3(u.anti);
  const light = v3(u.light);
  const pair: PairUniforms = {
    time: u.time, density: u.density, birthTable, life: u.life, radius: u.radius, speed: u.speed, curl: u.curl, drag: u.drag,
    tilt0: u.tilt0, tilt1: u.tilt1, tiltClock0: u.tiltClock0, tiltClock1: u.tiltClock1, eye: v3(u.eye),
    centre: v3(u.origin), centreVel: v3(u.still), layer: float(0), textAvoid: float(0),
    domeAxis: v3(u.domeAxis), domeFront: v3(u.domeFront), domeRight: v3(u.domeRight),
    pocketLo: u.pocketLo, pocketHi: u.pocketHi, pocketAz: u.pocketAz, pocket: u.pocket,
    waveClock0: u.waveClock0, waveRate: u.waveRate, waveLength: u.waveLength,
  };
  const slotOf = (slot: F) => pairSlot(slot, pair);
  // NEAR LAYER: a handful of pairs at a few metres, born around the eye and riding with it — they give the
  // boil its scale (big, fast, thick tracks sweeping a quarter of the dome over the fine far field)
  const NEAR_SLOTS = 12;
  const nearPair: PairUniforms = { ...pair, radius: u.nearRadius, speed: u.nearSpeed, centre: v3(u.eye), centreVel: v3(u.eyeVel), layer: float(1), textAvoid: float(1) };
  const nearOf = (slot: F) => pairSlot(slot, nearPair);

  const trackU: TrackUniforms = { tail: u.tail, width: u.width, pixelAngle: u.pixelAngle, radiance: u.trackRadiance, matter, anti };
  const tracks = createTracks(p.pairSlots, p.trackSegments, trackU, slotOf);
  const flashU: FlashUniforms = {
    flashGain: u.flashGain,
    haze: u.haze,
    coreSize: u.coreSize,
    coreRadiance: u.coreRadiance,
    shellSpeed: u.shellSpeed,
    shellRadiance: u.shellRadiance,
    hazeSize: u.hazeSize,
    hazeRadiance: u.hazeRadiance,
    light,
    matter,
    anti,
    sparkLead: float(0.01),
  };
  const flashes = createFlashes(p.pairSlots, flashU, slotOf);
  // near: thicker, not brighter — they are already big; a near flash at full strength is a flashbulb
  const nearTracks = createTracks(NEAR_SLOTS, 96, { ...trackU, width: u.width.mul(2.5), radiance: u.trackRadiance.mul(0.6) }, nearOf, 'undertime-near-tracks');
  const nearFlashes = createFlashes(NEAR_SLOTS, { ...flashU, coreRadiance: u.coreRadiance.mul(0.35), hazeRadiance: u.hazeRadiance.mul(0.4) }, nearOf, 'undertime-near-flashes');

  // ---------------------------------------------------------------- the scripted pairs (scripted.ts)
  const H0 = heroPair(p);
  const hero = heroSlot({
    time: u.actTime, birth: u.heroBirth, vertex: v3(u.heroVertex), dir: v3(u.heroDir), field: v3(u.heroField),
    v: u.heroV, omega: float(H0.omega), k: float(H0.k), open: float(H0.open), tEnd: float(HERO_TRACK_END),
  });
  const heroTracks = createTracks(1, 200, { tail: float(8), width: float(0.03), pixelAngle: u.pixelAngle, radiance: float(9), matter, anti }, () => hero, 'undertime-hero-tracks');
  const S0 = survivorPair(p);
  const survivor = heroSlot({
    time: u.actTime, birth: u.survBirth, vertex: v3(u.survVertex), dir: v3(u.survDir), field: v3(u.survField),
    v: float(S0.v), omega: float(S0.omega), k: float(S0.k), open: float(S0.open), tEnd: float(S0.tEnd), tEndAnti: u.survAntiEnd, linger: float(2),
  });
  const survivorLive = { ...survivor, alive: u.survAlive };
  const survTracks = createTracks(1, 200, { tail: float(2.6), width: float(0.045), pixelAngle: u.pixelAngle, radiance: float(7), matter, anti }, () => survivorLive, 'undertime-survivor-tracks');
  const survFlashes = createFlashes(1, { ...flashU, flashGain: float(1.4), haze: float(0), sparkLead: float(0.01) }, () => survivorLive, 'undertime-survivor-flashes');
  const heroFlashes = createFlashes(1, {
    ...flashU,
    flashGain: float(1),
    haze: float(1),
    coreSize: float(0.45),
    coreRadiance: float(40),
    // the hero's light shells are the sky's (a billboard ring cannot pass over the audience)
    shellRadiance: float(0),
    hazeSize: float(6),
    hazeRadiance: float(0.015),
    sparkLead: float(1.2),
  }, () => hero, 'undertime-hero-flashes');
  const sky = createUndertimeSky();
  const sparks = createWaveSparks(14000, {
    time: u.actTime, start: u.waveStart, length: u.waveAct, eye: v3(u.eye), domeAxis: v3(u.domeAxis), domeFront: v3(u.domeFront),
    light, radiance: u.sparkRadiance, pixelAngle: u.pixelAngle,
  });

  // ---------------------------------------------------------------- the remainder
  const grainU: GrainUniforms = {
    domeAxis: pair.domeAxis, domeFront: pair.domeFront, domeRight: pair.domeRight,
    pocketLo: u.pocketLo, pocketHi: u.pocketHi, pocketAz: u.pocketAz, pocket: u.pocket,
    time: u.actTime, eye: pair.eye, pivot: v3(u.pivot), scale: u.scale, reveal: u.reveal, fill: u.fill,
    heroGrain: u.heroGrain, stars: u.stars, radius: u.radius, size: u.size, radiance: u.grainRadiance,
    starRadiance: u.starRadiance, pixelAngle: u.pixelAngle, warm: v3(u.warm), star: v3(u.star),
    eyePat: v3(u.eyePat), box: u.box, webToWorld: m3(u.webToWorld),
  };
  const grains = createGrains(p.grainCount, grainU);
  const stars = createStars(grainU, web.knots);
  // the web's gas (webVolume.ts), placed in its box by the same flight as the stars
  // the faint glow of the web's envelope, and its particles carrying the detail
  const webGlow = uniform(0.12);
  const webFrame = { toWorld: m3(u.webToWorld), toPattern: m3(u.webToPattern) };
  const webVolume = createWebVolume(web, { eyePat: v3(u.eyePat), presence: u.webPresence, radiance: webGlow, ...webFrame });
  const webParticles = createWebParticles(web, {
    eyePat: v3(u.eyePat), presence: u.webPresence, radiance: u.webRadiance, eye: pair.eye, box: u.box, pixelAngle: u.pixelAngle,
    flow: v3(u.webFlow), close: u.webClose, ...webFrame,
  });
  const heroGrain = createHeroGrain(grainU);

  // ---------------------------------------------------------------- the event grammar (production-design.md)
  // light makes matter, matter makes light: photon collisions, looping pairs that meet and annihilate, in a
  // plasma lit by them. `grammar` 1 is this; 0 keeps the spiral tracks for comparison during look-dev.
  // the events are built on the first update: they avoid the text, and the text exists only once the show has
  // wired its crawl (pocketAt)
  let events: PairEvent[] = [];
  // the light wave's optics (waveFx.ts), shared by every layer it acts on; the sweep's inverse as a table the GPU
  // reads (rebuilt when the stall changes)
  const lutData = sweepInverseTable(SWEEP_LUT, p.waveStall);
  const sweepInverse = new THREE.DataTexture(lutData, SWEEP_LUT, 1, THREE.RedFormat, THREE.FloatType);
  sweepInverse.minFilter = sweepInverse.magFilter = THREE.NearestFilter;
  sweepInverse.needsUpdate = true;
  let lutStall = p.waveStall;
  const fx: WaveFxUniforms = {
    sweepInverse,
    time: u.actTime, eye: v3(u.eye), front: v3(u.domeFront), sweep: uniform(0), lens: uniform(0),
    width: uniform((p.waveLensWidth * Math.PI) / 180), start: u.waveStart, length: u.waveAct, afterglow: uniform(p.afterglow),
  };
  // "a few more shades" (the 2026-10-30 review): each family's range either side of its base
  const shadeU = {
    deep: uniform(new THREE.Color(p.matterDeep)), pale: uniform(new THREE.Color(p.matterPale)),
    cyan: uniform(new THREE.Color(p.antiCyan)), magenta: uniform(new THREE.Color(p.antiMagenta)),
    rose: uniform(new THREE.Color(p.productWarm)), teal: uniform(new THREE.Color(p.productCool)),
  };
  const shades = { deep: v3(shadeU.deep), pale: v3(shadeU.pale), cyan: v3(shadeU.cyan), magenta: v3(shadeU.magenta) };
  // the lights' core-and-halo profile (glow.ts; the 2026-10-30 note on the particles' falloff)
  const profileU = { core: uniform(p.glowCore), halo: uniform(p.glowHalo), haloGain: uniform(p.glowHaloGain) };
  const loopU = {
    time: u.actTime, pixelAngle: u.pixelAngle, fog: uniform(0.03), matter, anti, light,
    trailRadiance: uniform(3), beadRadiance: uniform(1.5), flashRadiance: uniform(1),
    pocket: pair, eye: v3(u.eye), shades, fx, sharp: true, profile: profileU,
  };
  let mist: Mist | null = null;
  let loopSprites: THREE.InstancedMesh | null = null;
  let loopTrails: THREE.InstancedMesh | null = null;
  let bursts: Burst | null = null;
  let products: ProductMeshes | null = null;
  let survivorGrains: THREE.InstancedMesh | null = null;
  const survivorU = { focus: uniform(0), radiance: uniform(1) };
  // the cloud chamber's side light: cool white from the front-left, high
  const keyDir = (() => {
    const b = domeBasis(p.domeTilt);
    const e = (50 * Math.PI) / 180;
    const az = (-60 * Math.PI) / 180;
    return new THREE.Vector3(...[0, 1, 2].map((i) => Math.cos(e) * (Math.cos(az) * b.front[i] + Math.sin(az) * b.right[i]) + Math.sin(e) * b.axis[i])).normalize();
  })();
  const mistU = {
    time: u.actTime, pixelAngle: u.pixelAngle, key: v3(uniform(keyDir)), keyColour: v3(uniform(new THREE.Color(0.8, 0.88, 1))),
    matter, anti, radiance: uniform(1.2), life: uniform(0.7), pocket: pair, eye: v3(u.eye), shades, fx,
  };
  // the front as a sheet of light through the medium (dust.ts): its colours, set per frame from the params
  const frontU = {
    sheet: uniform(0), build: uniform(0), crest: uniform(0),
    lead: uniform(new THREE.Color()), trail: uniform(new THREE.Color()), ember: uniform(new THREE.Color()),
  };
  const dustU = {
    time: u.actTime, pixelAngle: u.pixelAngle, centre: v3(u.eye), radius: uniform(26), density: uniform(1), radiance: uniform(2),
    front: { fx, sheet: frontU.sheet, build: frontU.build, crest: frontU.crest, light, lead: v3(frontU.lead), trail: v3(frontU.trail), domeFront: v3(u.domeFront), density: uniform(0) },
  };
  // (110 000 motes until the light wave lit them as a sheet; more where it pays: the front's depth is made of them)
  const dust = p.grammar ? createDust(180000, dustU) : null;

  const group = new THREE.Group();
  group.name = 'undertime-field';
  // the sky keeps only its wave in the event grammar (its first-light shells belong to the old hero)
  if (dust) group.add(sky.mesh, dust.mesh, webVolume, webParticles, grains, stars, heroGrain);
  else group.add(sky.mesh, tracks, flashes, nearTracks, nearFlashes, heroTracks, heroFlashes, survTracks, survFlashes, sparks, grains, stars, heroGrain);

  const vx = (a: [number, number, number]): THREE.Vector3 => new THREE.Vector3(...a);
  return {
    group,
    update(state, t, eye, fade = 1, webKeep = 1, view) {
      if (dust && !mist) {
        const act = undertimeEvents(p, pocketAt);
        events = act.events;
        mist = createMist(events, mistU, true);
        loopTrails = createLoopTrails(events, loopU);
        loopSprites = createLoopSprites(events, loopU);
        bursts = createBursts(act.blasts, { time: u.actTime, pixelAngle: u.pixelAngle, radiance: uniform(1), fx });
        products = createProducts(act.tracks, {
          time: u.actTime, pixelAngle: u.pixelAngle, matter, anti, light, rose: v3(shadeU.rose), teal: v3(shadeU.teal), shades,
          radiance: uniform(3), fog: loopU.fog, pocket: pair, eye: v3(u.eye), fx, profile: profileU,
        });
        survivorGrains = createSurvivorGrains(act.rests, heroGrainPosition(p), {
          time: u.actTime, eye: v3(u.eye), pixelAngle: u.pixelAngle, pivot: v3(u.pivot), scale: u.scale, focus: survivorU.focus,
          warm: v3(u.warm), radiance: survivorU.radiance,
        });
        group.add(loopTrails, products.trails, mist.mesh, loopSprites, products.heads, bursts.mesh, survivorGrains);
      }
      if (dust) {
        // the plasma: dense and dark in the cold open, glowing with the boil, thinning to clear as it cools
        const { starts: st } = beatStarts(p);
        const cool = Math.min(1, Math.max(0, (t - st.cool) / Math.max(1e-6, p.cool)));
        const thin = 1 - cool * cool * (3 - 2 * cool);
        const density = 0.9 * thin * (1 - Math.min(1, Math.max(0, (t - st.wave) / Math.max(1e-6, p.wave))));
        const lights = eventLights(events, t, [eye.x, eye.y, eye.z], DUST_LIGHTS);
        dust.setLights(lights);
        // the dust thins as the field fills (with many lights it would light everywhere: a grey wash)
        const waving = Math.min(1, Math.max(0, (t - st.wave) / 0.5)) * (1 - Math.min(1, Math.max(0, (t - st.wave - p.wave) / 0.5)));
        // …and the light wave brings it back: the medium is what the front lights as a sheet and what visibly folds
        // toward it, so through the build and the wave most of the motes are there
        const sheetMotes = Math.max(0.6 * state.build, waving);
        dustU.density.value = (0.25 + 0.75 * density) * (1 - 0.7 * state.pairDensity) * (1 - 0.7 * waving);
        (dustU.front.density as unknown as { value: number }).value = 0.85 * sheetMotes;
        mist?.setLights(lights);
        loopU.fog.value = 0.012 * density;
      }
      const { starts } = beatStarts(p);
      u.time.value = state.clock;
      u.actTime.value = t;
      u.density.value = state.pairDensity;
      // rebake the birth table when anything it depends on changed (the params; the text it reads via pocketAt)
      const key = JSON.stringify(p) + JSON.stringify(pocketAt(starts.cool + 3)) + JSON.stringify(pocketAt(starts.remain + 3));
      if (key !== birthKey) {
        birthKey = key;
        birthMax.value = bakeBirthTable(p, pocketAt, birthData);
        birthTex.needsUpdate = true;
      }
      u.flashGain.value = state.flashGain;
      u.haze.value = state.glow;
      u.radius.value = p.fieldRadius;
      u.life.value = p.pairLife;
      u.speed.value = p.trackSpeed;
      u.curl.value = p.trackCurl;
      u.drag.value = p.trackDrag;
      const D = Math.PI / 180;
      u.tilt0.value = p.fieldTilt * D;
      u.tilt1.value = p.fieldTiltEnd * D;
      u.tiltClock0.value = fieldClock(starts.cool, p);
      u.tiltClock1.value = fieldClock(starts.cool + p.cool, p);
      u.eye.value.copy(eye);
      u.waveClock0.value = state.waveClock0;
      u.waveStart.value = starts.wave;
      u.waveAct.value = Math.max(1e-3, p.wave);
      u.sparkRadiance.value = p.sparkRadiance;
      u.waveRate.value = state.waveRate;
      u.waveLength.value = state.waveLength;
      u.tail.value = p.trackTail;
      u.width.value = p.trackWidth;
      u.trackRadiance.value = p.trackRadiance;
      u.coreSize.value = p.coreSize;
      u.coreRadiance.value = p.coreRadiance;
      u.shellSpeed.value = p.shellSpeed;
      u.shellRadiance.value = p.shellRadiance;
      u.hazeSize.value = p.hazeSize;
      u.hazeRadiance.value = p.hazeRadiance;
      u.matter.value.set(p.matterColor);
      u.anti.value.set(p.antimatterColor);
      u.light.value.set(p.lightColor);
      u.star.value.set(p.starColor);
      u.warm.value.set(p.matterColor).lerp(u.star.value, p.grainWarmth);

      // the scripted pairs, and the two light shells the hero's annihilations release
      const H = heroPair(p);
      u.heroBirth.value = H.birth;
      u.heroVertex.value.set(...H.vertex);
      u.heroDir.value.set(...H.dir);
      u.heroField.value.set(...H.field);
      u.heroV.value = H.v;
      sky.u.c0.copy(vx(trackPositionCpu(H, 1, HERO_TRACK_END)));
      sky.u.c1.copy(vx(trackPositionCpu(H, -1, HERO_TRACK_END)));
      const S = survivorPair(p);
      u.survBirth.value = S.birth;
      u.survVertex.value.set(...S.vertex);
      u.survDir.value.set(...S.dir);
      u.survField.value.set(...S.field);
      u.survAntiEnd.value = S.tEndAnti;
      // the survivor's matter becomes the hero grain: its track fades as the grain comes up
      u.survAlive.value = 1 - state.heroGrain;
      u.eyeVel.value.set(...eyeVelocity(t));
      u.nearSpeed.value = p.trackSpeed * 1.3;
      sky.setShell(p.grammar ? -1 : t - (H.birth + HERO_TRACK_END), p.heroShellSpeed, p.heroShellRadiance);
      // in the event grammar the band is only the glow behind the front's events
      // the band glows along the front's events, brightest as it passes over the audience
      const overhead = Math.sin(Math.PI * state.wave) ** 2;
      // (the event grammar's front is the radiant line of sky.ts, at frontRadiance; the old grammar keeps its band)
      sky.setWave(state.wave, u.domeFront.value, p.grammar ? p.frontRadiance * state.frontGain : p.waveRadiance);
      void overhead;
      // the colours of the collapse: the violet-cyan the front drives ahead (antimatter's side), the gold-amber of its
      // wake (matter's), the ember of what it leaves
      frontU.lead.value.set(p.antiCyan).lerp(new THREE.Color(p.antiMagenta), 0.4).lerp(u.light.value, 0.25);
      frontU.trail.value.set(p.matterColor).lerp(u.light.value, 0.15);
      frontU.ember.value.set(p.matterDeep).multiplyScalar(0.8);
      sky.setCollapse(state.build, state.crest, p.crestRadiance, t, frontU.lead.value, frontU.trail.value, frontU.ember.value);
      frontU.sheet.value = p.frontRadiance * state.frontGain * 0.35;
      frontU.build.value = state.build;
      frontU.crest.value = state.crest * p.crestRadiance;
      (fx.sweep as unknown as { value: number }).value = state.wave;
      (fx.lens as unknown as { value: number }).value = state.lens;
      (fx.width as unknown as { value: number }).value = (p.waveLensWidth * Math.PI) / 180;
      (fx.afterglow as unknown as { value: number }).value = p.afterglow;
      if (p.waveStall !== lutStall) {
        lutStall = p.waveStall;
        lutData.set(sweepInverseTable(SWEEP_LUT, p.waveStall));
        sweepInverse.needsUpdate = true;
      }
      profileU.core.value = p.glowCore;
      profileU.halo.value = p.glowHalo;
      profileU.haloGain.value = p.glowHaloGain;
      shadeU.deep.value.set(p.matterDeep);
      shadeU.pale.value.set(p.matterPale);
      shadeU.cyan.value.set(p.antiCyan);
      shadeU.magenta.value.set(p.antiMagenta);
      shadeU.rose.value.set(p.productWarm);
      shadeU.teal.value.set(p.productCool);
      sky.setLight(u.light.value);
      sky.follow(eye);

      // the web flight: where the eye is in the web's box, the box's size, and the hero grain it carries
      const flight = webFlight(t, p);
      const knot = web.knots[0].pos;
      if (view) {
        // the show's curve through the web (getTheDrift/webDive.ts: the pull-back, the dive, the approach) and the
        // web's frame: the hero grain sits on the hero knot wherever the eye is, in whichever act's world
        const R = view.R;
        u.webToWorld.value.set(R[0], R[1], R[2], R[3], R[4], R[5], R[6], R[7], R[8]);
        u.webToPattern.value.copy(u.webToWorld.value).transpose();
        u.eyePat.value.set(...view.eyePat);
        u.box.value = view.box;
        const h = [0, 1, 2].map((i) => {
          const d = knot[i] - view.eyePat[i];
          return d - Math.round(d);
        });
        u.pivot.value.set(h[0], h[1], h[2]).applyMatrix3(u.webToWorld.value).multiplyScalar(view.box).add(eye);
        u.webFlow.value.set(...view.vel).applyMatrix3(u.webToWorld.value).multiplyScalar(-view.box);
        u.webClose.value = view.close;
      } else {
        u.webToWorld.value.identity();
        u.webToPattern.value.identity();
        u.webFlow.value.set(0, 0, 0);
        u.webClose.value = 0;
        u.pivot.value.set(...flight.pivot);
        // the eye's own travel (Act 2 flies on through the web) moves it through the box too
        const still = eyePath(starts.zoom, p);
        u.eyePat.value.set(
          knot[0] + flight.offset[0] + (eye.x - still[0]) / flight.box,
          knot[1] + flight.offset[1] + (eye.y - still[1]) / flight.box,
          knot[2] + flight.offset[2] + (eye.z - still[2]) / flight.box,
        );
        u.box.value = flight.box;
      }
      u.webPresence.value = flight.presence * webKeep;
      u.webRadiance.value = p.webRadiance;
      webGlow.value = p.webRadiance * 0.04;
      webVolume.position.copy(eye);
      u.scale.value = state.scale;
      const decades = -Math.log10(state.scale);
      u.fill.value = Math.min(1, Math.max(0, decades));
      u.reveal.value = state.grains;
      u.heroGrain.value = state.heroGrain;
      u.stars.value = state.stars;
      u.size.value = p.particleSize;
      u.grainRadiance.value = p.particleRadiance * fade;
      // the survivors: a little under the hero grain's light, stepping back as the remain beat singles it out
      survivorU.radiance.value = p.particleRadiance * 1.1 * fade;
      survivorU.focus.value = Math.min(1, Math.max(0, (t - (starts.remain + 0.5)) / 2.5));
      u.starRadiance.value = p.starRadiance * fade;
    },
    setPocket(pk, tiltDeg) {
      const b = domeBasis(tiltDeg);
      u.domeAxis.value.set(...b.axis);
      u.domeFront.value.set(...b.front);
      u.domeRight.value.set(...b.right);
      const D = Math.PI / 180;
      u.pocketLo.value = pk.lo * D;
      u.pocketHi.value = pk.hi * D;
      u.pocketAz.value = pk.az * D;
      u.pocket.value = pk.strength;
    },
    setPixelAngle(rad) {
      u.pixelAngle.value = rad;
    },
    dispose() {
      sky.dispose();
      dust?.dispose();
      mist?.dispose();
      bursts?.dispose();
      products?.dispose();
      if (survivorGrains) {
        survivorGrains.geometry.dispose();
        (survivorGrains.material as THREE.Material).dispose();
      }
      for (const m of [tracks, flashes, nearTracks, nearFlashes, heroTracks, heroFlashes, survTracks, survFlashes, sparks, grains, stars, heroGrain,  ...(loopSprites ? [loopSprites] : []), ...(loopTrails ? [loopTrails] : [])]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
  };

  function eyeVelocity(at: number): [number, number, number] {
    const a = eyePath(at - 0.05, p);
    const b = eyePath(at + 0.05, p);
    return [(b[0] - a[0]) / 0.1, (b[1] - a[1]) / 0.1, (b[2] - a[2]) / 0.1];
  }

}
