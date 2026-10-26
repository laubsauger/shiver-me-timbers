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
import { beatStarts, eyePath, fieldClock, heroGrainPosition, undertimeState, waveTimeAt, webFlight, type UndertimeState } from './timeline';
import { heroSlot, pairSlot, trackPositionCpu, type PairUniforms } from './pairModel';
import { HERO_TRACK_END, heroPair, survivorPair, waveFracCpu } from './scripted';
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

export interface UndertimeField {
  readonly group: THREE.Group;
  /** keep the field out of the sky the crawl is passing through */
  setPocket(pocket: TextPocket, tiltDeg: number): void;
  /** push the timeline state for act time `t`, seen from `eye` (world position); `fade` dims what remains
   * as the next act takes over */
  update(state: UndertimeState, t: number, eye: THREE.Vector3, fade?: number, webKeep?: number): void;
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

/**
 * The act's pairs. U0 is one HERO event at the first-light spot, its loop plane facing the audience: two
 * photons converge on it from the left and right of the dome, and its two loops open up and out like the
 * classic picture. From the arising on, the field: births at the rate the timeline's density sets, around
 * the eye as it drifts, never right on top of it, never where the text is (or is about to be); loops last
 * longer as the field clock slows (time slows as it cools).
 */
function undertimeEvents(p: DriftParams, pocketAt: (t: number) => TextPocket): PairEvent[] {
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
  const field = generatePairs(
    {
      seed: 4711,
      // the arising builds to the boil; the cooling calms FAST to a few pairs a second (each loop lasts longer
      // as time slows, so the rate must fall further than the density)
      rate: (t) => {
        if (t < starts.arise) return 0;
        const ar = Math.min(1, (t - starts.arise) / Math.max(1e-6, p.arise));
        if (t < starts.cool) return PEAK * ar ** 2.2;
        const c = Math.min(1, (t - starts.cool) / Math.max(1e-6, p.cool));
        return PEAK * (1 - (1 - 0.05) * (1 - (1 - c) ** 6));
      },
      from: starts.arise,
      to: starts.wave + p.wave,
      centre: (t) => eyePath(t, p),
      radius: p.fieldRadius * 0.8,
      eye: (t) => eyePath(t, p),
      clearance: 5,
      loopRadius: [0.8, 2.8],
      loopTime: [2.2, 3.8],
    },
    PEAK,
  ).filter((e) => {
    // not born in (or about to be in) the text's sky
    const pk = pocketAt(e.birth);
    if (pk.strength <= 0.05) return true;
    const eye = eyePath(e.birth, p);
    const v = [e.vertex[0] - eye[0], e.vertex[1] - eye[1], e.vertex[2] - eye[2]];
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    const el = Math.asin((v[0] * b.axis[0] + v[1] * b.axis[1] + v[2] * b.axis[2]) / l) / D;
    const az = Math.atan2(v[0] * b.right[0] + v[1] * b.right[1] + v[2] * b.right[2], v[0] * b.front[0] + v[1] * b.front[1] + v[2] * b.front[2]) / D;
    return !(el > pk.lo - 6 && el < pk.hi + 6 && Math.abs(az) < pk.az + 8);
  });
  // time slows as it cools: a loop born then lasts longer
  for (const e of field) e.loop /= Math.max(0.3, undertimeState(e.birth, p).clockRate);
  // THE WAVE (U3): the front reaches a pair's direction at waveStart + frac·wave. A pair alive then ends
  // where it is (both beads annihilate on the front); nothing is born behind the front.
  const eyeW = eyePath(starts.wave, p);
  const kept = field.filter((e) => {
    const cut = starts.wave + waveTimeAt(waveFracCpu([e.vertex[0] - eyeW[0], e.vertex[1] - eyeW[1], e.vertex[2] - eyeW[2]], p.domeTilt)) * p.wave;
    if (e.birth >= cut) return false;
    if (e.birth + e.loop > cut) e.end = Math.max(0.02, (cut - e.birth) / e.loop);
    return true;
  });
  // and the front itself is made of the grammar: hundreds of small pairs born and annihilated ON it —
  // fireballs, quick loops, gamma rays — a wall of creation and cancellation sweeping over the audience
  const front = frontEvents(p, eyeW, b);
  return [hero, ...kept, ...front];
}

function frontEvents(p: DriftParams, eyeW: [number, number, number], b: { axis: [number, number, number]; front: [number, number, number]; right: [number, number, number] }): PairEvent[] {
  const { starts } = beatStarts(p);
  const r = rng(9090);
  const out: PairEvent[] = [];
  const N = 750;
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
    if (r() > Math.sin(theta) * (0.55 + 0.45 * climax)) continue;
    const phi = r() * Math.PI * 2;
    const d = [0, 1, 2].map((j) => Math.cos(theta) * b.front[j] + Math.sin(theta) * (Math.cos(phi) * b.right[j] + Math.sin(phi) * b.axis[j])) as [number, number, number];
    if (d[0] * b.axis[0] + d[1] * b.axis[1] + d[2] * b.axis[2] < -0.12) continue; // below the spring line
    const t = starts.wave + waveTimeAt(Math.min(1, Math.max(0, theta / Math.PI + (r() - 0.5) * 0.02))) * p.wave;
    const dist = 7 + r() * 16;
    const axis = unit();
    const t0 = unit();
    const dt = t0[0] * axis[0] + t0[1] * axis[1] + t0[2] * axis[2];
    const ac = [t0[0] - axis[0] * dt, t0[1] - axis[1] * dt, t0[2] - axis[2] * dt];
    const al = Math.hypot(ac[0], ac[1], ac[2]) || 1;
    const across = ac.map((x) => x / al) as [number, number, number];
    const open = 0.25 + r() * 0.4;
    const spiralish = r() < 0.4;
    out.push({
      birth: t - 0.05,
      // short lives: the activity hugs the front line, darkness follows right behind it
      loop: 0.18 + r() * 0.2,
      vertex: [eyeW[0] + d[0] * dist, eyeW[1] + d[1] * dist, eyeW[2] + d[2] * dist],
      axis,
      across,
      open,
      radius: (0.2 + r() * 0.45) * (0.8 + 0.4 * climax),
      // a few throw gamma rays (loops.ts rayKept), more of them at the climax
      energy: r() < 0.06 + 0.1 * climax ? 0.75 : 0.32 + r() * 0.12,
      gamma: across,
      spiral: spiralish ? 0.15 : 0,
      drift: 0,
      arc: spiralish ? Math.PI * 3 : 2 * Math.PI - 2 * open,
      meets: spiralish ? 0 : 1,
      // small fireballs: hundreds at once must not bloom the dome into milk
      burst: (0.12 + r() * 0.22) * (0.7 + 0.6 * climax),
      end: 1,
    });
  }
  return out;
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
    eyePat: v3(u.eyePat), box: u.box,
  };
  const grains = createGrains(p.grainCount, grainU);
  const stars = createStars(grainU, web.knots);
  // the web's gas (webVolume.ts), placed in its box by the same flight as the stars
  // the faint glow of the web's envelope, and its particles carrying the detail
  const webGlow = uniform(0.12);
  const webVolume = createWebVolume(web, { eyePat: v3(u.eyePat), presence: u.webPresence, radiance: webGlow });
  const webParticles = createWebParticles(web, {
    eyePat: v3(u.eyePat), presence: u.webPresence, radiance: u.webRadiance, eye: pair.eye, box: u.box, pixelAngle: u.pixelAngle,
  });
  const heroGrain = createHeroGrain(grainU);

  // ---------------------------------------------------------------- the event grammar (production-design.md)
  // light makes matter, matter makes light: photon collisions, looping pairs that meet and annihilate, in a
  // plasma lit by them. `grammar` 1 is this; 0 keeps the spiral tracks for comparison during look-dev.
  // the events are built on the first update: they avoid the text, and the text exists only once the show has
  // wired its crawl (pocketAt)
  let events: PairEvent[] = [];
  const loopU = {
    time: u.actTime, pixelAngle: u.pixelAngle, fog: uniform(0.03), matter, anti, light,
    trailRadiance: uniform(3), beadRadiance: uniform(1.5), flashRadiance: uniform(1),
    pocket: pair, eye: v3(u.eye),
  };
  let mist: Mist | null = null;
  let loopSprites: THREE.InstancedMesh | null = null;
  let loopTrails: THREE.InstancedMesh | null = null;
  let bursts: Burst | null = null;
  // the cloud chamber's side light: cool white from the front-left, high
  const keyDir = (() => {
    const b = domeBasis(p.domeTilt);
    const e = (50 * Math.PI) / 180;
    const az = (-60 * Math.PI) / 180;
    return new THREE.Vector3(...[0, 1, 2].map((i) => Math.cos(e) * (Math.cos(az) * b.front[i] + Math.sin(az) * b.right[i]) + Math.sin(e) * b.axis[i])).normalize();
  })();
  const mistU = {
    time: u.actTime, pixelAngle: u.pixelAngle, key: v3(uniform(keyDir)), keyColour: v3(uniform(new THREE.Color(0.8, 0.88, 1))),
    matter, anti, radiance: uniform(1.2), life: uniform(0.7), pocket: pair, eye: v3(u.eye),
  };
  const dustU = { time: u.actTime, pixelAngle: u.pixelAngle, centre: v3(u.eye), radius: uniform(26), density: uniform(1), radiance: uniform(2) };
  const dust = p.grammar ? createDust(110000, dustU) : null;

  const group = new THREE.Group();
  group.name = 'undertime-field';
  // the sky keeps only its wave band in the event grammar (its first-light shells belong to the old hero)
  if (dust) group.add(sky.mesh, dust.mesh, webVolume, webParticles, grains, stars, heroGrain);
  else group.add(sky.mesh, tracks, flashes, nearTracks, nearFlashes, heroTracks, heroFlashes, survTracks, survFlashes, sparks, grains, stars, heroGrain);

  const vx = (a: [number, number, number]): THREE.Vector3 => new THREE.Vector3(...a);
  return {
    group,
    update(state, t, eye, fade = 1, webKeep = 1) {
      if (dust && !mist) {
        events = undertimeEvents(p, pocketAt);
        mist = createMist(events, mistU, true);
        loopTrails = createLoopTrails(events, loopU);
        loopSprites = createLoopSprites(events, loopU);
        bursts = createBursts(events, { time: u.actTime, pixelAngle: u.pixelAngle, radiance: uniform(1) });
        group.add(loopTrails, mist.mesh, loopSprites, bursts.mesh);
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
        dustU.density.value = (0.25 + 0.75 * density) * (1 - 0.7 * state.pairDensity) * (1 - 0.7 * waving);
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
      sky.setWave(state.wave, u.domeFront.value, p.waveRadiance * (p.grammar ? 0.5 + 0.6 * overhead : 1));
      sky.setLight(u.light.value);
      sky.follow(eye);

      // the web flight: where the eye is in the web's box, the box's size, and the hero grain it carries
      const flight = webFlight(t, p);
      const knot = web.knots[0].pos;
      u.pivot.value.set(...flight.pivot);
      // the eye's own travel (Act 2 flies on through the web) moves it through the box too
      const still = eyePath(starts.zoom, p);
      u.eyePat.value.set(
        knot[0] + flight.offset[0] + (eye.x - still[0]) / flight.box,
        knot[1] + flight.offset[1] + (eye.y - still[1]) / flight.box,
        knot[2] + flight.offset[2] + (eye.z - still[2]) / flight.box,
      );
      u.box.value = flight.box;
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
