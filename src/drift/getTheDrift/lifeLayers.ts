/**
 * The planet's life as shader layers over the measured Earth (earthMaps.ts; life.ts gives the states). Each
 * layer arrives as a TIME WAVE: a soft front travelling over the sphere from a point on the front limb
 * toward the audience, its edge broken by noise, so a layer is never switched on — it rolls in.
 *
 *   young     before life the land is bare: where the Blue Marble is green (forest, field, steppe) it is
 *             rock and sediment instead; the deserts are as they are
 *   fields    a first front brings back about half of the green
 *   forests   a second front brings the rest: the land as the satellites see it today
 *   ice       the young world's ice: caps down to ~50° latitude and snow down to ~1800 m, settling to the
 *             caps of today's climate, shrinking further in the overshoot
 *   lights    on the night side only, from the Black Marble: camp fires first (a faint speckle where people
 *             will live), then every settlement grows from its brightest core out to its dim edges; in the
 *             overshoot they brighten, whiten (LED) and run together; under the risen sea they go dark
 *   sea       metres the sea has risen: the measured elevation floods to it
 *   front     LIGHTS OUT (params lightsOut, on by default; ?lightsOut=0 off): the flood as a ragged front of water
 *             that crosses the lit night side toward the audience, the cities going out behind it in clusters
 *             (floodFront); since the 2026-11-03 review grid region by grid region in its wake, stuttering, a few
 *             holding on and a few cities on generators dying through the dark (gridGate, blackout.ts; ?loGrid=0
 *             gives the clusters alone)
 */
import * as THREE from 'three/webgpu';
import { abs, acos, asin, atan, cos, float, floor, hash, int, length, max, min, mix, mx_noise_float, select, smoothstep, step, texture, uniformArray, vec2, vec3 } from 'three/tsl';
import { EMBER_FROM, GEN_CATCH, GEN_FADE, LO_GENERATORS, UNIT_FADE } from './blackout';
import { GRID_BOX } from './gridUnits';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;
type Vec4Array = ReturnType<typeof uniformArray>;

export interface LifeUniforms {
  fields: F;
  forests: F;
  ice: F;
  lights: F;
  overshoot: F;
  sea: F;
  /** unit, where the time waves start (a point on the front limb) */
  waveOrigin: V3;
  /** LIGHTS OUT (floodFront): s since the front left the far limb (−1e4 while it is off: nothing is ever out), the s
   * it takes to cross everything in view, and where it starts from — unit, in the PLANET's frame (x lon 0, y lon 90°E,
   * z north: earthMaps.ts geoFrameAt), like the normal floodFront is given */
  frontClock: F;
  frontLen: F;
  frontOrigin: V3;
  /** LIGHTS OUT's grid regions (gridGate, blackout.ts): 1 = the shutdown unit by unit, 0 = the front's clusters alone;
   * the units' ids (grid-units.png, nearest), the schedule per unit id and per generator city (blackout.ts Blackout),
   * the generators' and embers' light (share of the full), the share of cells that hold on as embers, and the front's
   * clock by which the last of them are out */
  grid: F;
  gridMap: THREE.Texture;
  gridUnits: Vec4Array;
  gridGenAt: Vec4Array;
  gridGens: Vec4Array;
  genGain: F;
  embers: F;
  embersOut: F;
}

/** m the sea rises by the end of the flood: about what all the land ice holds */
export const SEA_RISE_M = 70;

/** 0..1: has the front of a wave at progress k (0..1 over the half-sphere) reached unit surface normal n? */
function waveFront(n: V3, k: F, L: LifeUniforms, seed: number): F {
  const reach = float(1).sub(n.dot(L.waveOrigin)).mul(0.5); // 0 at the origin, 1 at its antipode
  const ragged = mx_noise_float(n.mul(5).add(seed)).mul(0.08).add(mx_noise_float(n.mul(40).add(seed * 2)).mul(0.015));
  return smoothstep(reach.add(ragged).sub(0.04), reach.add(ragged).add(0.04), k.mul(1.15));
}

/** m, the sea level now */
export const seaLevel = (L: LifeUniforms): F => L.sea.mul(SEA_RISE_M);

/**
 * The land's albedo (linear) with life on it: `real` is the Blue Marble colour, `bare` the same map's desert
 * (earth.ts samples the Sahara for it: real bare rock and sand, its own geology), `e` elevation (m), `lat` deg.
 */
export function lifeAlbedo(n: V3, real: V3, bare: V3, e: F, lat: F, L: LifeUniforms): V3 {
  // green: the vegetation index of the colour (forest ~0.2, steppe ~0.05, desert < 0)
  const green = smoothstep(0, 0.2, real.y.sub(real.x).div(real.y.add(real.x).add(1e-3)));
  // the young world's rock is darker and greyer than today's sand
  const young = mix(real, bare.mul(vec3(0.72, 0.66, 0.62)), green);
  const life = waveFront(n, L.fields, L, 1.3).mul(0.5).add(waveFront(n, L.forests, L, 4.7).mul(0.5));
  const a = mix(young, real, life);
  // ice: a latitude edge and a snow line, both broken by noise
  const ragged = mx_noise_float(n.mul(9).add(8.8));
  const edge = float(90).sub(L.ice.mul(40)).add(ragged.mul(4));
  const snowLine = float(4600).sub(L.ice.mul(2800)).add(ragged.mul(350));
  const ice = max(smoothstep(edge, edge.add(2.5), abs(lat)), smoothstep(snowLine, snowLine.add(400), e));
  return mix(a, vec3(0.72, 0.77, 0.82), ice);
}

/**
 * THE FRONT'S SCHEDULE: [deg of arc from the front's origin, share of `frontLen`] — piecewise linear, so the shader can
 * turn a place's distance into the time the water reaches it. Measured for the default origin (45° N 30° E) on the
 * approved camera path and the map's glide turn, as act.ts draws them (the scratch harness of the 2026-11-02 next-level
 * review; the camera holds −27° onto the ground from 241 s, timeline.ts DIVE_FLARE_KEYS, and is not changed for this).
 * At 235–239 s the limb ahead lies ~20.5–21° up the dome and the ground is foreshortened toward it: 8–14.5° of arc from
 * the origin fit into the dome's top degree, and down the front meridian every 2.5° of dome from 20° to the edge sees
 * the ground 14.46°, 18.32°, 20.31°, 21.66°, 22.64°, 23.39°, 24.0°, 24.5° and 24.91° away at the moment the front is to
 * pass it — each step of dome ever less ground as it comes nearer (and the map's turn brings the ground ~0.35°/s toward
 * the audience meanwhile). The farthest ground in view, low at az ±55°, is 27–28.5° away. So the keys: over the limb's
 * band in 0.55 s, then 2.5° of dome every 0.36 s down the front meridian (7°/s: from 20° up to the edge in 2.85 s),
 * then out to the sides (0.9 s). A front at one
 * ground speed crossed the meridian's last 5° in 0.3 s (15°/s: a wipe toward the audience, not water coming in); one
 * easing out crossed it all in 1.6 s. Past the last key it runs on at the last rate (round the far side, out of view)
 */
export const FRONT_KEYS: ReadonlyArray<readonly [number, number]> = [
  [7.5, 0],
  [14.46, 0.128],
  [18.32, 0.212],
  [20.31, 0.293],
  [21.66, 0.377],
  [22.64, 0.46],
  [23.39, 0.544],
  [24, 0.626],
  [24.5, 0.709],
  [24.91, 0.791],
  [28, 1],
];
/** deg of arc: where the front meets the dome's front edge (FRONT_KEYS) — the nearest cities, the last to go */
export const FRONT_EDGE_DEG = 24.91;
/** s: a cluster of lights goes out up to this long after the front has passed it (its own delay, below) and over
 * LO_FADE s — "cities go out behind it in clusters" (move 2), never all on the line */
export const LO_DELAY: [number, number] = [0.35, 0.2];
export const LO_FADE = 0.45;
/** deg of arc: the front's raggedness, at two scales (its wavelengths ~6° and ~1.6° of arc) */
export const LO_RAGGED: [number, number] = [1.2, 0.35];
/** s the last cluster in view goes out after the front's last key (frontLen): the cluster delay at its most, its fade,
 * and the raggedness at the side's rate */
export const LO_CLUSTER = LO_DELAY[0] + LO_DELAY[1] + LO_FADE + 0.3;

/** s from the front's start to its reaching `deg` of arc from its origin (FRONT_KEYS), for a CPU check of the schedule */
export function frontArrival(deg: number, len: number): number {
  const k = FRONT_KEYS;
  if (deg <= k[0][0]) return 0;
  for (let i = 1; i < k.length; i++) {
    if (deg <= k[i][0]) return len * (k[i - 1][1] + ((deg - k[i - 1][0]) / (k[i][0] - k[i - 1][0])) * (k[i][1] - k[i - 1][1]));
  }
  const [a, b] = [k[k.length - 2], k[k.length - 1]];
  return len * (b[1] + ((deg - b[0]) / (b[0] - a[0])) * (b[1] - a[1]));
}

/**
 * LIGHTS OUT (the 2026-11-02 next-level review, move 2: "the water comes as a ragged front that travels across the lit
 * night side toward the audience. Cities go out behind it in clusters"): 1 where the lights are still on, 0 behind the
 * front. `geo` is the unit normal in the PLANET's frame — the map turns under the eye through the flood's first 7 s
 * (timeline.ts glideSpin), and a front, a ragged edge or a cluster hashed in the world's frame would slide over the
 * cities as it turns, letting a light that had gone out come back on. In the planet's frame each place has one time
 * the water reaches it: its distance from the origin (ragged by noise) through FRONT_KEYS, plus its cluster's own delay
 * (a ~45 km cell's hash and a ~3° region's noise), and it goes out over LO_FADE s from there — monotone in time, so a
 * light that is out stays out, and nothing pops (a cluster fades over ~13 frames).
 */
export function floodFront(geo: V3, L: LifeUniforms): F {
  const ragged = mx_noise_float(geo.mul(9).add(2.7)).mul(LO_RAGGED[0]).add(mx_noise_float(geo.mul(35).add(5.3)).mul(LO_RAGGED[1]));
  const deg = acos(geo.dot(L.frontOrigin).clamp(-1, 1)).mul(180 / Math.PI).add(ragged);
  // the schedule, piecewise linear (FRONT_KEYS; past the last key at the last rate)
  const k = FRONT_KEYS;
  let at: F = float(0);
  for (let i = k.length - 1; i >= 1; i--) {
    const [a, b] = [k[i - 1], k[i]];
    const seg = deg.sub(a[0]).div(b[0] - a[0]).mul(b[1] - a[1]).add(a[1]);
    at = (i === k.length - 1 ? seg : select(deg.lessThan(b[0]), seg, at)) as F;
  }
  at = max(at, 0).mul(L.frontLen) as F;
  const cell = floor(geo.mul(140));
  const delay = hash(cell.x.add(cell.y.mul(157)).add(cell.z.mul(113))).mul(LO_DELAY[0]).add(mx_noise_float(geo.mul(18).add(1.1)).mul(0.5).add(0.5).mul(LO_DELAY[1]));
  const out = at.add(delay);
  return float(1).sub(smoothstep(out, out.add(LO_FADE), L.frontClock));
}

/**
 * Night lights (emission, linear) from the Black Marble grey `v` (0..1, a gamma-encoded radiance), after the
 * ISS imagery: sodium amber with whiter cores, a faint rural speckle, the cores the brightest by far.
 * `land` 0..1 is the land above the sea now; `fp` the pixel's footprint on the unit sphere; `geo` the normal in the
 * planet's frame (floodFront).
 */
export function nightLights(n: V3, v: F, land: F, L: LifeUniforms, fp: F, geo: V3): V3 {
  const stage = L.lights;
  // camp fires: a sparse warm speckle (~3 km cells) wherever there will be people, faint, early
  const pc = n.mul(2000);
  const cell = floor(pc);
  const hc = hash(cell.x.add(cell.y.mul(157)).add(cell.z.mul(113)));
  const inhabited = smoothstep(0.02, 0.12, v);
  const fineEnough = smoothstep(2 / 2000, 0.7 / 2000, fp);
  // (they belong to the night the lights first come up only: once past the balance they never return. The flood
  // halves the stage again (life.ts: the lights falter) to ~1.7, back inside the camps' window, and at Drift-2's
  // height a footprint is well under a cell, so every inhabited cell came back as a hard-edged 3 km square of rust
  // round the drowning cities — the 2026-10-30 QA sweep, item 9: "flat brown hard-edged rectangles" at 265–278 s.
  // The overshoot is 0 until the lights beat ends, by when the stage has passed 2.5 and the camps are out anyway)
  const camp = mix(inhabited.mul(0.04), step(hc, inhabited.mul(0.25)), fineEnough)
    .mul(smoothstep(0, 1, stage))
    .mul(float(1).sub(smoothstep(1.5, 2.5, stage)))
    .mul(float(1).sub(min(L.overshoot, 1)));
  // settlements grow from the core out: a pixel lights when the stage passes its level (bright = early);
  // the regions wake at different times
  const wake = mx_noise_float(n.mul(22).add(3.1)).mul(0.1);
  const level = float(1.05).sub(stage.sub(1).div(2).clamp(0, 1).mul(1.15)).sub(L.overshoot.mul(0.25)).add(wake);
  // (nothing before the villages' stage: at stage 0 the brightest cores would pass the level)
  const on = smoothstep(level.sub(0.12), level.add(0.02), v).mul(smoothstep(1, 1.3, stage));
  // within a ~1 km pixel: the streets' own grain, where it can show
  const grain = mx_noise_float(n.mul(16000)).mul(0.7).mul(float(1).sub(smoothstep(0.25, 0.5, fp.mul(16000)))).add(1);
  const radiance = v.mul(v).mul(on).mul(grain).mul(L.overshoot.mul(0.9).add(1));
  const sodium = vec3(1, 0.52, 0.18);
  const core = vec3(1, 0.83, 0.62);
  const led = vec3(0.86, 0.92, 1);
  const tint = mix(mix(sodium, core, smoothstep(0.55, 0.9, v)), led, min(L.overshoot, 1).mul(0.55));
  const fire = vec3(1, 0.42, 0.12).mul(camp).mul(0.25);
  // (LIGHTS OUT: the overshoot runs past 1 while the front comes — params loPush, life.ts — so the tint's LED share is
  // held at the full overshoot's; the brightness and the networks running together take the push)
  // (the grid's failing: the generators' and the embers' light is warmer, a redder sodium — gridGate)
  const gate = gridGate(geo, L, v);
  const warm = mix(tint, vec3(1, 0.45, 0.15), gate.gen.mul(0.35));
  return warm.mul(radiance).mul(6).add(fire).mul(land).mul(gate.on);
}

/** s: the generators' dips (one every GEN_DIP s, how deep) */
const GEN_DIP: [number, number] = [0.7, 0.6];

/**
 * LIGHTS OUT, GRID REGION BY GRID REGION (the 2026-11-03 review of the master: "the lights should turn off in a more
 * interesting way, so it's more visible that this is actually a global shutdown. More like country by country … And
 * fill in a bit of the pure-darkness moment so it's not so long"; blackout.ts says how the schedule is made). `on`
 * 0..1 is the lights' share still lit at `geo` (the planet's frame, as floodFront), `gen` 0..1 how much of what is lit
 * is a generator's or an ember's (warmer).
 *   - the place's unit, from grid-units.png (nearest: an id is not to be blended), over the region maps' box; outside
 *     it and on the open sea (id 0: ships, platforms) the front's own clusters (floodFront), as before
 *   - the unit: its dips (a raised cosine each, slow), then out over UNIT_FADE from its time — one time for the whole
 *     unit, so its border is drawn by the lights going out on one side of it
 *   - embers: a ~45 km cell of it in `embers` (its own hash, not the front's clusters') keeps genGain of its light from
 *     the unit's going until a time between EMBER_FROM after it and embersOut
 *   - generators: inside a city's radius the light comes back after the unit has gone (GEN_CATCH), at genGain, and
 *     dips and dies on its own time
 * With the front off (its clock at −1e4) every unit, ember and city is lit: ?lightsOut=0 draws the approved flood.
 */
export function gridGate(geo: V3, L: LifeUniforms, v: F): { on: F; gen: F } {
  const c = L.frontClock;
  const lat = asin(geo.z.clamp(-1, 1)).mul(180 / Math.PI);
  const lon = atan(geo.y, geo.x).mul(180 / Math.PI);
  const uv = vec2(lon.sub(GRID_BOX.lon0).div(GRID_BOX.lon1 - GRID_BOX.lon0), float(GRID_BOX.lat1).sub(lat).div(GRID_BOX.lat1 - GRID_BOX.lat0));
  const inBox = step(0, uv.x).mul(step(uv.x, 1)).mul(step(0, uv.y)).mul(step(uv.y, 1));
  const id = floor(texture(L.gridMap, uv.clamp(0, 1)).x.mul(255).add(0.5)).mul(inBox);
  const u = L.gridUnits.element(int(id)) as unknown as V4;
  const out = u.x;
  // the dips: u.y of them, u.z s each, u.w deep, ending at `out`
  const x = c.sub(out.sub(u.y.mul(u.z))).div(u.z);
  const dip = select(x.greaterThan(0).and(x.lessThan(u.y)), u.w.mul(float(0.5).sub(cos(x.mul(2 * Math.PI)).mul(0.5))), float(0));
  const unit = float(1).sub(dip).mul(float(1).sub(smoothstep(out, out.add(UNIT_FADE), c)));
  // embers: a cell that holds on, dim, from its unit's going to its own time — a soft disc in it (~20 km across at most,
  // less where the sphere cuts its cube off-centre), not the whole cell: the cell's own edges cut through the towns as
  // straight lines and the first stills (2026-11-03) showed the embers as dim orange rectangles
  const cell = floor(geo.mul(140));
  const h = hash(cell.x.add(cell.y.mul(157)).add(cell.z.mul(113)).add(71.3));
  const holds = step(h, L.embers).mul(float(1).sub(smoothstep(0.15, 0.4, length(geo.mul(140).sub(cell).sub(0.5)))));
  const emberOut = mix(out.add(EMBER_FROM), max(L.embersOut, out.add(EMBER_FROM)), h.div(L.embers.max(1e-4)).clamp(0, 1));
  const ember = holds.mul(L.genGain).mul(float(1).sub(smoothstep(emberOut, emberOut.add(GEN_FADE), c)));
  // the cities on generators: back after their unit has gone, dim, and out on their own time — only their cores (the
  // Black Marble's brighter half), in patches (~2–3 km noise) and fading out from the centre: lit whole inside a
  // radius, the first clip drew each as a flat bright disc, foreshortened to a saucer ("UFO"); a city on generators
  // is a scatter of what still has power
  const core = smoothstep(0.3, 0.65, v);
  let gen: F = ember as F;
  for (let i = 0; i < LO_GENERATORS.length; i++) {
    const at = L.gridGenAt.element(i) as unknown as V4;
    const g = L.gridGens.element(i) as unknown as V4;
    const km = length(geo.sub(at.xyz)).mul(6371);
    const patch = smoothstep(0.0, 0.35, mx_noise_float(geo.mul(2500).add(i * 7.3)));
    const inside = float(1).sub(smoothstep(at.w.mul(0.3), at.w, km)).mul(patch).mul(core);
    const gx = c.sub(g.x.sub(g.y.mul(GEN_DIP[0]))).div(GEN_DIP[0]);
    const gdip = select(gx.greaterThan(0).and(gx.lessThan(g.y)), float(GEN_DIP[1]).mul(float(0.5).sub(cos(gx.mul(2 * Math.PI)).mul(0.5))), float(0));
    const caught = smoothstep(out.add(GEN_CATCH[0]), out.add(GEN_CATCH[1]), c);
    const lit = inside.mul(L.genGain).mul(caught).mul(float(1).sub(gdip)).mul(float(1).sub(smoothstep(g.x, g.x.add(GEN_FADE), c)));
    gen = max(gen, lit) as F;
  }
  const on = max(unit, gen);
  const useGrid = id.greaterThan(0.5).and(L.grid.greaterThan(0.5));
  return {
    on: select(useGrid, on, floodFront(geo, L)) as F,
    gen: select(useGrid, smoothstep(0, 0.1, gen.sub(unit)), float(0)) as F,
  };
}
