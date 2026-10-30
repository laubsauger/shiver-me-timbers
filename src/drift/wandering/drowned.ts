/**
 * THE SUNKEN WORLD ON THE FILM'S COAST AND AT SEA — the film's own placing of the sunken world's builders (src/drowned:
 * town.ts, fanPalm.ts, powerLine.ts, drownedLook.ts, the ones the game will share): a drowned town and its boulevard
 * off the beach of w1–w6 (coast.ts), and a power line at sea through c2–c4. Each part is switched in or out of the
 * cut by SUNKEN_SET (all out for the 2026-10-30 full render).
 *
 * WHY (the user, 2026-10-29: "without someone telling me the story it doesn't become apparent that this is what
 * happened" — this is California under hundreds of feet of water; drift-narrative/wandering-on/sunken-world-cues.md):
 *
 *   cue 6, THE SHALLOWS UNDER THE RAFT. "Clear turquoise water over roofs, a chimney … just before the raft beaches.
 *          We sail over a town." A few pieces in the sand flat beside the raft's way: a roof's ridge coming out of
 *          the sand, a chimney standing from it, a hip's apex — grown over, under half a metre of water — one chimney
 *          top just awash; and out in the lagoon the church, its nave's ridge just out of the water, its belfry and
 *          spire over it. (LOTS says why so few, and why at that depth.)
 *   cue 5, A DROWNED BOULEVARD. "A straight ROW of tall fan palms … standing in the water off the beach … Palms
 *          planted in a line are a street; in LA every viewer reads them." What is left of one side of it: seven
 *          Washingtonia along one curb, the line broken (BOULEVARD).
 *   cue 3, AT SEA. A power line marching out of the water toward the sunset (POWER_LINE).
 *
 * WHERE, AND WHY THERE (beats.ts COAST: `along` up the beach toward −z, `off` out to sea toward −x, from `beach`):
 *
 *   - THE EYE'S VIEW AHEAD. The dome is tilted 15° (Horizon 18): ahead, nothing more than 15° under the horizon is on
 *     it, so what lies in the water must be 18 m and more ahead of the raft's 2.6 m eye to be seen at all, and the
 *     nearer the better. So the town's pieces are where that view sweeps: w1 (490–540 s) sails along at off 60 (the
 *     eye) and 54 (the raft) from along −125 to −77, its view of the water along −110..−35, off 40..80; w2's run-in
 *     (540–570 s) turns right toward the land over along −50..−20, off 25..45.
 *   - CLEAR OF THE RAFT (its logs reach ~7 m from its centre, RAFT_BERTH; it heaves ±0.25 m on the swell): nothing
 *     within RAFT_CLEAR m of its way (w1's line and w2's landfall, beats.ts), and nothing in the swash sim's domain
 *     (off < 19.5, swashSim.ts SWASH), whose own water knows nothing of them.
 *   - THE BOULEVARD's curb at off 82: from the raft (w1) ~22 m to its left, running on ahead toward the island's
 *     point; from the beach (w3–w5, off −8) ~90 m out on the left, toward the evening Sun (beats.ts: 68° left).
 *   - THE CHURCH at along +30, off 138: from w1 ~160 m ahead-left, from the beach 83° left, beside the setting Sun.
 *
 * HEIGHTS. The town's pieces by their crests (LOTS), the rest of each in the sand (coast.ts OURS_FRONT: ~1.2 m deep at
 * off 38, ~1.7 m at off 70), its old ground floor ~10 m down. The palms rise from that drowned street: up to ~20 m of
 * trunk over the sand, an old Washingtonia's 22–30 m less the sand's 8.
 *
 * WHAT IT IS SEEN THROUGH. The sea shades what is under it from the scene's own depth (ocean surfaceMaterial: two-way
 * Beer–Lambert on the depth behind the surface, the wave-normal refraction's wobble), so the roofs' drowned slopes take
 * the water's absorption exactly as the sand round them does — the same straight lookup (sea.ts refractionSnell 0), so
 * they stand where the sand under them is. No caustics: the film binds none (sea.ts); the roofs fold in the same
 * receiver hook as the sand (waterLighting), so binding them lights both at once.
 *
 * NO SUN SHADOWS from any of it (createDrownedShallows says why: the "roads", and the blocks round the raft's figure).
 *
 * Every frame a pure function of t: nothing moves but the palms in the wind (`setTime`).
 */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { BUILDING_DIMS, TOWN_KIT_URL, buildTown, loadTownKit, type BuildingKind, type BuildingSpec } from '../../drowned/town';
import { buildFanPalms, type FanPalms, type FanPalmSpec, type FanPalmState } from '../../drowned/fanPalm';
import { PYLON_KIT_URL, buildPowerLine, loadPylonKit, type PowerLineSpec, type PylonSpec, type SpanSpec } from '../../drowned/powerLine';
import { createRng } from '../../state/rng';
import { expAir } from './radioTower';
import { HIGH_AIR } from './coast';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node unions
type Node = any;

/**
 * WHAT IS IN THE CUT (2026-10-30, the coordinator, after the user's reviews of the first rounds): the boulevard OFF
 * ("I know what the intention was, but that's not gonna be readable like this" — from the beach its palms were a
 * cluster of thin poles on the horizon); the town's pieces OFF (from the raft's path they did not read at all, from the
 * air as seaweed); the church and the power line at sea OFF until the user has seen them (no new features in
 * tonight's full render). Each one line; the code and its tests stay.
 */
export const SUNKEN_SET = { boulevard: false, town: false, church: false, powerLine: false };

/** m: the raft's logs reach this far from its centre, and a little more — the clearance kept round its way */
export const RAFT_CLEAR = 9;
/** m: the swash sim's seaward edge (swashSim.ts SWASH.x0: 19.5 m off), and a margin */
export const SWASH_EDGE = 22;

/**
 * THE TOWN: a few pieces, mostly in the sand (the user, 2026-10-30, on the first set — two rows of whole house roofs
 * standing out of the water, a store, palms in a grid: "whatever the super regular grid of shit is — no, that's not
 * gonna fly"; "black patches somewhere in the houses"). What is left of a town on a sand flat is not houses but a roof
 * ridge and its upper slopes coming out of the sand, a chimney standing from it, a hip's apex — shapes in the water,
 * grown over, read obliquely from the raft, never a box from above.
 *
 * HOW DEEP (the 2026-10-30 rounds). From the raft the floor past a few metres is not seen at all: at the 5–15° under the
 * horizon the dome shows, the sea passes what lies within a few decimetres of its surface and next to nothing under a
 * metre (ocean surfaceMaterial's absorption runs along the straight view ray, ~9 m of it to a floor 1.5 m down at
 * 10°). Within 0.4 m the barnacle crust's pale band and a ridge's white cap read as floating planks; out of the water,
 * as boxes. So the crests lie 0.45–0.6 m down — dark shapes under the turquoise, grown over, as faint as such things
 * are — tilted as each settled, so one end of a ridge comes nearer the surface than the other; one chimney top is just
 * awash. Each piece where the camera's view of the water passes (the dome's window: 18–45 m ahead of the eye, under
 * its 15° tilt): along w1's sail (off 60, along −125..−77) and the run-in's turn toward the beach (along −50..−20,
 * off 25..45).
 */
interface Lot {
  along: number;
  off: number;
  kind: BuildingKind;
  /** m over the mean sea (− under): its ridge … */
  crest?: number;
  /** … or its highest point (a chimney's top) */
  top?: number;
  /** rad: the settle, about its own x and z */
  tilt: [number, number];
  /** rad off the sea-facing yaw */
  turn: number;
}
export const LOTS: Lot[] = [
  // w1, ~22 m ahead at 505 s: a gable's ridge and upper slopes out of the sand, down at one end
  { along: -98, off: 70, kind: 'Gable', crest: -0.5, tilt: [0.03, -0.02], turn: 0.12 },
  // a chimney standing from the sand, the house under it buried to the ridge
  { along: -66, off: 73, kind: 'GableChimney', top: -0.3, tilt: [-0.02, 0.03], turn: -0.2 },
  // a hipped roof's apex, half in the sand, sunk on one side
  { along: -44, off: 67, kind: 'Hip', crest: -0.55, tilt: [-0.03, 0.03], turn: 0.35 },
  // the run-in's, under the bow at ~555 s: a gable's ridge, turned across the others
  { along: -26, off: 38, kind: 'Gable', crest: -0.45, tilt: [0.02, 0.03], turn: 1.4 },
  // a chimney top just awash, beyond w1's raft to the right (the swell bares and buries it)
  { along: -86, off: 38, kind: 'GableChimney', top: 0.1, tilt: [0.02, -0.03], turn: 0.25 },
];

/** the church: along, off (m), and how far its nave's ridge stands over the sea (m: its belfry then all out, its
 * tower's top 3 m over the water — with less out, the slate spire on its pale base read as a sail, the first round) */
export const CHURCH = { along: 30, off: 138, ridge: 0.6 };

/**
 * THE BOULEVARD: what is left of one side of it — a broken line, not a planted grid (the user, 2026-10-30: from the air
 * the first set's two rows of 70 read as "the super regular grid"). Seven trees along one curb, the spacing broken by
 * the ones gone: a stump, a tall one still alive with a ragged crown, one fallen from its stump across the line into
 * the water, a dead one leaning, a snapped one, another alive, a dying one leaning hard. The curb runs at off 82: from
 * the raft (w1) ~22 m to its left, the line running on ahead toward the island's point; from the beach (w3–w5) ~90 m
 * out on the left toward the evening Sun. Each: along, its state, m of trunk over the sand (a fallen one: its length),
 * its lean (deg; a fallen one past 90° runs down into the water) and the bearing it leans to (deg: 0 toward the land,
 * +x; 90 toward +z, back along the beach), and m off the curb.
 */
export const BOULEVARD = {
  off: 82,
  palms: [
    { along: -146, state: 'snag', height: 3.2, lean: 4, to: 30, off: 0.4 },
    { along: -121, state: 'live', height: 19.5, lean: 3, to: -20, off: -0.3 },
    // (the stump the fallen one broke from, and the fallen one, lying landward across the line)
    { along: -84, state: 'snag', height: 2.6, lean: 2, to: 10, off: 0.2 },
    { along: -84, state: 'fallen', height: 12, lean: 98, to: 35, off: 0.2 },
    { along: -63, state: 'dead', height: 16, lean: 7, to: 160, off: -0.5 },
    { along: -44, state: 'snag', height: 6.5, lean: 2, to: 0, off: 0.3 },
    { along: -2, state: 'live', height: 17.5, lean: 5, to: 40, off: -0.2 },
    { along: 31, state: 'dying', height: 14, lean: 9, to: -60, off: 0.6 },
  ] as Array<{ along: number; state: FanPalmState; height: number; lean: number; to: number; off: number }>,
};

export interface DrownedLayout {
  buildings: BuildingSpec[];
  /** those whose top stands over the water (mirrored, clipped at the waterline) */
  above: BuildingSpec[];
  palms: FanPalmSpec[];
}

/** where everything stands, from the beach and the sand (pure: the tests read it) */
export function drownedLayout(beach: { x: number; z: number }, sand: (x: number, z: number) => number): DrownedLayout {
  const world = (along: number, off: number): [number, number] => [beach.x - off, beach.z - along];
  const buildings: BuildingSpec[] = [];
  const above: BuildingSpec[] = [];
  LOTS.forEach((lot, n) => {
    const [x, z] = world(lot.along, lot.off);
    const d = BUILDING_DIMS[lot.kind];
    const b: BuildingSpec = {
      kind: lot.kind,
      x,
      z,
      // the fronts face the sea (the kit's +z to −x), each turned its own way
      yaw: -Math.PI / 2 + lot.turn,
      floor: lot.top !== undefined ? lot.top - d.top : (lot.crest ?? 0) - d.ridge,
      tilt: lot.tilt,
      sag: 0.1 + 0.03 * n,
      seed: 300 + n,
    };
    buildings.push(b);
    if (b.floor + d.top > 0) above.push(b);
  });
  // the church: its tower to the boulevard, its nave's ridge CHURCH.ridge over the sea
  {
    const [x, z] = world(CHURCH.along, CHURCH.off);
    const b: BuildingSpec = { kind: 'Steeple', x, z, yaw: Math.PI / 2 + 0.03, floor: CHURCH.ridge - BUILDING_DIMS.Steeple.ridge, tilt: [0.012, -0.008], sag: 0.12, seed: 299 };
    buildings.push(b);
    above.push(b);
  }
  // the boulevard's broken line
  const D = Math.PI / 180;
  const palms: FanPalmSpec[] = BOULEVARD.palms.map((q, i) => {
    const [x, z] = world(q.along, BOULEVARD.off + q.off);
    const ground = sand(x, z);
    // (a fallen trunk lies from the top of its stump, the one before it in the list)
    const stump = q.state === 'fallen' ? BOULEVARD.palms[i - 1] : undefined;
    return { x, z, foot: stump ? ground + stump.height : ground - 0.3, sand: ground, height: q.height, lean: q.lean * D, leanDir: q.to * D, state: q.state, seed: 500 + i };
  });
  return { buildings, above, palms };
}

/** a number in [a0, a1] from `r` */
const within = (r: () => number, a: [number, number]): number => a[0] + (a[1] - a[0]) * r();

export interface DrownedShallows {
  /** the submerged houses: under the water, out of the water's mirror (sea.ts `underwater`) */
  readonly under: THREE.Group;
  /** the boulevard, the church and the awash chimneys: in the mirror (clipped at the waterline: mirror.ts) */
  readonly above: THREE.Group;
  /** resolves once the town's kit is in */
  readonly ready: Promise<void>;
  /** s: the wind in the palms */
  setTime(t: number): void;
  readonly layout: DrownedLayout;
}

/**
 * The town and the boulevard off `beach` on `sand` (coast.ts `ground`). `light` is the beach palms' (palms.ts), set
 * per frame by sea.ts; `shadowAt` the lagoon floor's refracted shadow lookup (sea.ts seabedShadowAt).
 */
export function createDrownedShallows(
  renderer: THREE.WebGPURenderer,
  o: { beach: { x: number; z: number }; sand: (x: number, z: number) => number; light?: { sun: THREE.Vector3; sunLight: THREE.Vector3; skyLight: THREE.Vector3 }; shadowAt?: Node },
): DrownedShallows {
  const layout = drownedLayout(o.beach, o.sand);
  const origin: [number, number] = [o.beach.x, o.beach.z];
  const under = new THREE.Group();
  under.name = 'drowned-under';
  const above = new THREE.Group();
  above.name = 'drowned-above';
  // NONE OF IT CASTS THE SUN'S SHADOW (2026-10-30). At w1–w2's 5–14° Sun what it would shade lies 4–11 times its
  // height downlight: (1) the palms' long trunk and the spire's shadows lay across the lagoon floor as straight dark
  // bands — "the weird roads on the beach, I don't think we need the roads" (the user); (2) a crown's leaves 100 m
  // up the light, sharing a receiver's search with a near caster, were drawn at the near one's contact sharpness by
  // the film's single-penumbra filter (filmShadowFilter.ts: the harmonic mean of the casters' distances), in texel
  // squares round the raft's standing figure at 545 s ("something super weird pixelated … around him, of his
  // shadows"; found in one boot: gone with the leaves out of the map, not with the filter's wide grid made bilinear).
  // Their true shadows there are penumbrae metres wide: a faint dimming.
  const palms: FanPalms | undefined = SUNKEN_SET.boulevard ? buildFanPalms(layout.palms, { origin, light: o.light, castShadow: false }) : undefined;
  if (palms) above.add(palms.group);
  const site = { sand: o.sand, origin };
  const inCut = (b: BuildingSpec): boolean => (b.kind === 'Steeple' ? SUNKEN_SET.church : SUNKEN_SET.town);
  const ready = !SUNKEN_SET.town && !SUNKEN_SET.church
    ? Promise.resolve()
    : loadTownKit(TOWN_KIT_URL, renderer).then((kit) => {
        const submerged = layout.buildings.filter((b) => inCut(b) && !layout.above.includes(b));
        const out = layout.above.filter(inCut);
        if (submerged.length) under.add(buildTown(kit, submerged, site, { shadowAt: o.shadowAt }).group);
        if (out.length) above.add(buildTown(kit, out, site, { shadowAt: o.shadowAt }).group);
      });
  return { under, above, ready, layout, setTime: (t) => palms?.setTime(t) };
}

/**
 * THE POWER LINE AT SEA (cue 3: "the top of a pylon line marching out of the water in a straight row with its sagging
 * wires … seen at sunset or against the night sky as a silhouette"). Nine pylons of the circuit's 230 kV kit
 * (powerLine.ts), one missing — fallen, its neighbours' conductors snapped and hanging into the sea toward where it
 * stood — and one leaning on its footing.
 *
 * WHERE: laid from where the eye is as c2 begins (sea.ts sailingEye), from POWER_LINE.from (deg right of the front, m)
 * to POWER_LINE.to: the nearest 330 m ahead-left, a pylon 5° tall on the dome; the line running off to the horizon
 * 16° left of the front, into c2's sunset (beats.ts: the Sun 22° left, 3° up) and c3's afterglow, and black against
 * c4's night sky. It stands in the world, not in the debris field's slow turn: the eye drifts past it with the current,
 * the near pylons swinging a little against the far ones. Clear of the far rafts (FAR_RAFTS, sea.ts) and of the ring's
 * stations on the horizon (props.ts: −40°, 10°).
 */
export const POWER_LINE = {
  from: [-62, 330] as [number, number],
  to: [-16, 3200] as [number, number],
  count: 9,
  /** the fallen one */
  missing: 5,
  /** the one leaning on its footing: index, deg */
  leaning: [3, 5] as [number, number],
  /** m: how much lower each stands than the kit (the valley under it deepening and shoaling) */
  sink: [0, 3] as [number, number],
};

/** the line from the eye at c2's start (world x, z) and the eye's heading (sea.ts `yaw`: 0 looks toward −z) */
export function seaPowerLine(eye: { x: number; z: number }, yaw: number): PowerLineSpec {
  const front = [-Math.sin(yaw), -Math.cos(yaw)];
  const right = [Math.cos(yaw), -Math.sin(yaw)];
  const at = ([bearing, dist]: [number, number]): [number, number] => {
    const b = (bearing * Math.PI) / 180;
    return [eye.x + (front[0] * Math.cos(b) + right[0] * Math.sin(b)) * dist, eye.z + (front[1] * Math.cos(b) + right[1] * Math.sin(b)) * dist];
  };
  const a = at(POWER_LINE.from);
  const b = at(POWER_LINE.to);
  const along = Math.atan2(b[0] - a[0], b[1] - a[1]);
  const r = createRng(2100 + 63);
  const pylons: PylonSpec[] = [];
  const n = POWER_LINE.count;
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1);
    const lean = i === POWER_LINE.leaning[0] ? (POWER_LINE.leaning[1] * Math.PI) / 180 : (r() - 0.5) * 0.02;
    pylons.push({ x: a[0] + (b[0] - a[0]) * k, z: a[1] + (b[1] - a[1]) * k, yaw: along + (r() - 0.5) * 0.03, lean: [(r() - 0.5) * 0.01, lean], sink: within(r, POWER_LINE.sink) });
  }
  const m = POWER_LINE.missing;
  const spans: SpanSpec[] = [];
  for (let i = 0; i + 1 < n; i++) if (i !== m && i + 1 !== m) spans.push({ from: i, to: i + 1 });
  const gone: [number, number] = [pylons[m].x, pylons[m].z];
  return {
    // (the fallen one is not drawn: its place is only where its neighbours' broken conductors point)
    pylons: pylons.map((p, i) => (i === m ? null : p)).filter((p): p is PylonSpec => p !== null),
    // (indices shift past the missing one)
    spans: spans.map((s) => ({ from: s.from - (s.from > m ? 1 : 0), to: s.to - (s.to > m ? 1 : 0) })),
    snapped: [
      { at: m - 1, toward: gone, attach: [1, 3, 6] },
      { at: m, toward: gone, attach: [0, 4] },
    ],
  };
}

export interface SeaPowerLine {
  readonly group: THREE.Group;
  readonly ready: Promise<void>;
  readonly spec: PowerLineSpec;
}

/** the line at sea, melting into `horizon` (seaSky.ts: the sky's radiance at the horizon, updated per frame) over the
 * high island's air (coast.ts HIGH_AIR: the open sea's own marine haze) */
export function createSeaPowerLine(renderer: THREE.WebGPURenderer, o: { eye: { x: number; z: number }; yaw: number; horizon: THREE.Color }): SeaPowerLine {
  const spec = seaPowerLine(o.eye, o.yaw);
  const group = new THREE.Group();
  group.name = 'drowned-power-line-at-sea';
  const haze = uniform(o.horizon);
  const ready = !SUNKEN_SET.powerLine
    ? Promise.resolve()
    : loadPylonKit(PYLON_KIT_URL, renderer).then((kit) => {
        group.add(buildPowerLine(kit, spec, { origin: [o.eye.x, o.eye.z], air: expAir(haze as never, HIGH_AIR) }).group);
      });
  return { group, ready, spec };
}
