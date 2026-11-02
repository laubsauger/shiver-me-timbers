/**
 * THE SUNKEN WORLD ON THE FILM'S COAST AND AT SEA — the film's own placing of the sunken world's builders (src/drowned:
 * town.ts, fanPalm.ts, powerLine.ts, drownedLook.ts, the ones the game will share): a drowned town and its boulevard
 * off the beach of w1–w6 (coast.ts), a power line at sea through c2–c4, and a drowned valley's line across the lagoon
 * onto the high island (POWER_STUB). Each part is switched in or out of the cut by SUNKEN_SET (all out for the 2026-10-30 full render).
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
import { cameraPosition, max, positionWorld, pow, uniform } from 'three/tsl';
import { BUILDING_DIMS, TOWN_KIT_URL, buildTown, loadTownKit, type BuildingKind, type BuildingSpec } from '../../drowned/town';
import { buildFanPalms, type FanPalms, type FanPalmSpec, type FanPalmState } from '../../drowned/fanPalm';
import { PYLON_KIT_URL, buildPowerLine, loadPylonKit, plainPylonKit, type PowerLineSpec, type PylonSpec, type SpanSpec } from '../../drowned/powerLine';
import { createRng } from '../../state/rng';
import { expAir } from './radioTower';
import { HIGH_AIR } from './coast';
import { farAir } from './farAir';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node unions
type Node = any;

/**
 * WHAT IS IN THE CUT (2026-10-30, the coordinator, after the user's reviews of the first rounds): the boulevard OFF
 * ("I know what the intention was, but that's not gonna be readable like this" — from the beach its palms were a
 * cluster of thin poles on the horizon); the town's pieces OFF (from the raft's path they did not read at all, from the
 * air as seaweed); the church and the power line at sea OFF until the user has seen them (no new features in
 * tonight's full render). Each one line; the code and its tests stay.
 *
 * THE POWER LINE BACK IN, FOR REVIEW (the 2026-11-02 next-level review, move 3, approved as part of the spine: "four
 * or five half-drowned pylons march out of the swell toward the sun. Their sagging wires are gold threads; the last
 * tower leans"): switched by `drift.html?powerline` — the review scripts' `--query powerline` — and still OUT of the
 * cut by default, so the next master draws as the last one did until the user has seen it. A URL switch and not a
 * live `__drift.params` field because the line is built (its kit loaded, its geometry merged) once, as the sea is
 * built; the review scripts pass a query before boot and `--setup` only after it (raft.ts `?raftplain` is the same).
 *
 * THE STUB NEAR LAND, FOR REVIEW (2026-11-02, after the power line at sea was parked — the user: "Somewhere nearer to
 * land, that would work for me. But we have to see where we position it so that we don't … screw up existing shots
 * that work"; then "yes lets do it, try stuff, lets see"): POWER_STUB, IN the cut since the 2026-11-02 render (the
 * user: the storm and the drowned line "go in"); `drift.html?drownedstub=0` leaves it out. (Outside a page — the tests —
 * it stays off, as the line at sea does.)
 */
const QUERY = typeof location !== 'undefined' ? new URLSearchParams(location.search) : undefined;
export const SUNKEN_SET = { boulevard: false, town: false, church: false, powerLine: QUERY?.has('powerline') ?? false, stub: QUERY ? QUERY.get('drownedstub') !== '0' : false };

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
  const town = !SUNKEN_SET.town && !SUNKEN_SET.church
    ? Promise.resolve()
    : loadTownKit(TOWN_KIT_URL, renderer).then((kit) => {
        const submerged = layout.buildings.filter((b) => inCut(b) && !layout.above.includes(b));
        const out = layout.above.filter(inCut);
        if (submerged.length) under.add(buildTown(kit, submerged, site, { shadowAt: o.shadowAt }).group);
        if (out.length) above.add(buildTown(kit, out, site, { shadowAt: o.shadowAt }).group);
      });
  // the stub of a power line near land, running up onto the high island (POWER_STUB): with the town's other pieces above
  // the water, shown with the coast; seen through the far islands' air (farAir.ts, which the coast refreshes each
  // frame), as the high island's ground and masts are — nothing at the first tower's ~150 m, the island's own slate
  // haze at the last's 7 km
  const stub = !SUNKEN_SET.stub
    ? Promise.resolve()
    : loadPylonKit(PYLON_KIT_URL, renderer).then((kit) => {
        above.add(buildPowerLine(plainPylonKit(kit), stubPowerLine(o.beach), { origin, air: farAir.air, cableMinAngle: CABLE_MIN_ANGLE, cableLook: cableGoldSheen }).group);
      });
  const ready = Promise.all([town, stub]).then(() => undefined);
  return { under, above, ready, layout, setTime: (t) => palms?.setTime(t) };
}

/**
 * THE POWER LINE AT SEA (cue 3: "the top of a pylon line marching out of the water in a straight row with its sagging
 * wires … seen at sunset or against the night sky as a silhouette"). Five pylons of the circuit's 230 kV kit
 * (powerLine.ts), each the top 26 m of a tower drowned to its waist.
 *
 * RESTAGED SHORT (the 2026-11-02 next-level review, move 3: "four or five half-drowned pylons march out of the swell
 * toward the sun. Their sagging wires are gold threads; the last tower leans" — and the contrarian's "short and
 * partial, not a road to the horizon"). The first staging (2026-10-30, never in a cut) ran nine pylons from 330 m out
 * to 3.2 km on the horizon: from the eye the nearest stood 5° tall at the far left and the rest were specks in the
 * glare — a road to the horizon nobody could read. Now five, laid in the eye's level frame at c2's start
 * (POWER_LINE.pylons: m right, m ahead):
 *
 *   - THE SPAN OVER US. The line comes from behind on the left (one pylon, on the dome's back) and crosses the eye's way
 *     POWER_LINE.cross m ahead to an angle tower ahead-right, so as the eye sails on (~1.5 m/s, beats.ts speedAt) it
 *     passes under that span ~15 s into c2 (~370 s): the wires come over from ahead, cross the zenith and go down
 *     behind (the dome lens: "the raft passes under one span, so the wires sweep overhead"). The raft, 15 m
 *     ahead-right of the eye, sails under the same span within a few seconds of it, its mast under the wires in view.
 *     No timing or path changed for it: the line stands where the existing way runs.
 *   - THE MARCH TOWARD THE SUN. At the angle tower the line turns (~78°, a dead-end tower's turn; its cross-arms on the
 *     bisector) and runs off across the front toward c2's Sun (beats.ts: 22° left, 3° up): ~37° right at 76 m, 10°
 *     left at 230 m, 18° at 410, the last, leaning, 21° left at 600 m — beside the Sun, its far conductors snapped and
 *     hanging into the sea where the line ran on. A row seen across, each tower smaller, not one end-on stack: the
 *     first try ran the line straight through our crossing along the Sun's bearing, and from beside it the four ahead
 *     stood within 2° of each other inside the Sun's glare, read as one pylon (the 2026-11-02 r1 stills).
 *   - CLEAR OVER THE RAFT. The lowest conductors hang from 11.35 m on the kit's towers and sag 0.012 × 1.3 of a span
 *     (powerLine.ts DEFAULT_SLACK): 2.4 m on the 156 m span over us. The raft's masthead stands ~7 m (measured off the
 *     c2 stills: its yard 14.6° over the eye from 16 m off), so the two towers of that span stand 2 m HIGHER than the
 *     kit (a drowned ridge under them; sink −2): the lowest wire ~11 m over the sea.
 *   - THE 15° TILT (the dome rim rule: ahead, nothing more than 0.27× its distance under the eye is on the dome): the
 *     towers' feet are in the water and their tops 9–24 m up, all far above that line ahead. The one behind stands at
 *     the back rim, by design: the span over us rises from behind the audience.
 *
 * It stands in the world, not in the debris field's slow turn: the eye drifts past it with the current, the near pylons
 * swinging against the far ones — the parallax that says how big they are. Through c3 the angle tower is abeam to the
 * right and the row ahead-left; no wire is overhead when the dolphin comes.
 */
export const POWER_LINE = {
  /** m ahead of the eye at c2's start where the span over us crosses the eye's way (between pylons 0 and 1) */
  cross: 22,
  /** m right and m ahead of the eye at c2's start: behind-left; the angle tower; the march toward the Sun */
  pylons: [[-91.9, -55.1], [46, 60.6], [-41, 227.1], [-128, 393.6], [-215, 560.1]] as Array<[number, number]>,
  /** m each stands lower than the kit (− higher): the span over us on a ridge, the rest deepening */
  sink: [-2, -2, 0.5, 1.5, 3],
  /** the one leaning on its footing (the last): index, deg */
  leaning: [4, 9] as [number, number],
  /** the conductors snapped at the last tower and hanging into the sea beyond it (the kit's attach indices: the far
   * side's three phases and earth wire) */
  snapped: [0, 2, 4, 6],
};

/** the line from the eye at c2's start (world x, z) and the eye's heading (sea.ts `yaw`: 0 looks toward −z) */
export function seaPowerLine(eye: { x: number; z: number }, yaw: number): PowerLineSpec {
  const front = [-Math.sin(yaw), -Math.cos(yaw)];
  const right = [Math.cos(yaw), -Math.sin(yaw)];
  const world = ([r, a]: [number, number]): [number, number] => [eye.x + right[0] * r + front[0] * a, eye.z + right[1] * r + front[1] * a];
  const at = POWER_LINE.pylons.map(world);
  const n = at.length;
  /** rad: the kit's +z along world (dx, dz) */
  const way = (dx: number, dz: number): number => Math.atan2(dx, dz);
  const r = createRng(2100 + 63);
  const pylons: PylonSpec[] = at.map(([x, z], i) => {
    // each tower's cross-arms square to the line, an angle tower's on the bisector of its two spans
    const inW = i > 0 ? way(x - at[i - 1][0], z - at[i - 1][1]) : way(at[1][0] - x, at[1][1] - z);
    const outW = i + 1 < n ? way(at[i + 1][0] - x, at[i + 1][1] - z) : inW;
    const yaw = Math.atan2(Math.sin(inW) + Math.sin(outW), Math.cos(inW) + Math.cos(outW));
    const lean = i === POWER_LINE.leaning[0] ? (POWER_LINE.leaning[1] * Math.PI) / 180 : (r() - 0.5) * 0.02;
    return { x, z, yaw: yaw + (r() - 0.5) * 0.03, lean: [(r() - 0.5) * 0.01, lean], sink: POWER_LINE.sink[i] };
  });
  const spans: SpanSpec[] = [];
  for (let i = 0; i + 1 < n; i++) spans.push({ from: i, to: i + 1 });
  const [lx, lz] = at[n - 1];
  const [px, pz] = at[n - 2];
  return {
    pylons,
    spans,
    // (the line ran on toward the Sun: the next tower is gone under the water, its conductors hang toward it)
    snapped: [{ at: n - 1, toward: [lx + (lx - px), lz + (lz - pz)], attach: POWER_LINE.snapped }],
  };
}

export interface SeaPowerLine {
  readonly group: THREE.Group;
  readonly ready: Promise<void>;
  readonly spec: PowerLineSpec;
}

/**
 * THE WIRES AS GOLD THREADS (the 2026-11-02 next-level review, move 3: "their sagging wires are gold threads"; "the
 * wires must stay at least 2 px at 4096²").
 *
 * WIDTH. A 3.6 cm conductor is 0.3 px of the 4096² master at 150 m and 0.1 px at 600 m: the pixel floor every thin
 * thing has (core/minWidth.ts, 1.25 face px) would draw it ~1.1 master px, and the review asks 2. So the cables are
 * never narrower than CABLE_MIN_ANGLE — 2 px of the master's 180° over 4096 — resolved in each face's own pixels
 * (powerLine.ts `cableMinAngle`), the widening paid back as coverage as always: a span fades with distance evenly,
 * a line, never a dotted one, and a far span is fainter than a near one, as it should be. Overhead (the span we pass
 * under, ~10 m up) a wire is ~3 px wide on its own.
 *
 * LIGHT. Against the sunset a dull grey wire at a fraction of a pixel's coverage is nothing. What makes real wires
 * read as threads of light at sunset is the Sun scattered forward off them, toward an eye looking into the light —
 * blazing near the Sun, dark lines away from it. SHEEN is that: the Sun's light (the scene's own sun, as sea.ts sets
 * it each frame) × a forward lobe about the Sun's direction (SHEEN_POWER: half at ~14° off it), added as emission. At
 * the pixel floor's coverage (~0.15 at 150 m) a sheen ~SHEEN × the Sun's radiance-per-steradian stands a little over
 * the glowing sky round the Sun, so the spans toward it read gold and the far ones fade; overhead and behind, away
 * from the Sun, the lobe is ~0 and the wires are what they are — dark lines on the sky.
 */
/** rad: 2 px of the 4096² dome master (180° over 4096 px) */
export const CABLE_MIN_ANGLE = (2 * Math.PI) / 4096;
/** × the Sun's light (its colour × SUN_E / π): the forward sheen's peak, toward the Sun */
const SHEEN = 6;
/** the forward lobe's power on cos(angle off the Sun) */
const SHEEN_POWER = 30;

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
        group.add(buildPowerLine(kit, spec, { origin: [o.eye.x, o.eye.z], air: expAir(haze as never, HIGH_AIR), cableMinAngle: CABLE_MIN_ANGLE, cableLook: cableGoldSheen }).group);
      });
  return { group, ready, spec };
}

/**
 * The cables' forward sheen (see CABLE_MIN_ANGLE): the Sun's direction and light read off the scene's sun (sea.ts
 * `sky.sunLight`, set from t before anything draws: a pure function of t) as the cables are drawn, so nothing in the
 * sea's own wiring changes for it.
 */
export function cableGoldSheen(m: THREE.MeshStandardNodeMaterial, mesh: THREE.Mesh): void {
  const sunDir = uniform(new THREE.Vector3(0, 1, 0));
  const sunLight = uniform(new THREE.Color(0, 0, 0));
  const view = positionWorld.sub(cameraPosition).normalize();
  const lobe = pow(max(view.dot(sunDir), 0), SHEEN_POWER);
  m.emissiveNode = sunLight.mul(lobe.mul(SHEEN));
  let sun: THREE.DirectionalLight | null = null;
  mesh.onBeforeRender = (_r, scene) => {
    if (!sun) scene.traverse((x) => void (!sun && (x as THREE.DirectionalLight).isDirectionalLight && x.castShadow && (sun = x as THREE.DirectionalLight)));
    if (!sun) return;
    const s = sun as THREE.DirectionalLight;
    sunDir.value.copy(s.position).sub(s.target.position).normalize();
    sunLight.value.copy(s.color).multiplyScalar(s.intensity / Math.PI);
  };
}

/**
 * THE DROWNED VALLEY'S POWER LINE: TOWER TOPS MARCHING ACROSS THE LAGOON TO THE HIGH ISLAND (the 2026-11-02 review,
 * the line at sea parked: "we zoomed into what really looks like an ocean, flooding or not … Somewhere nearer to
 * land, that would work for me"; then, on the r1 seat stills of one half-drowned tower: "that drowned could work.
 * Maybe it spans from the water onto the island, kinda oriented towards the far back, suggesting that this is a
 * flooded valley now"; the coordinator's call on the r4 stills: tower tops marching across the lagoon toward the
 * island, each sunk deeper toward the old valley's middle, rising again toward the shore). The lagoon is the valley's
 * flooded floor: a tower drowned to its lowest arm in our shallows; out in the lagoon the tops of three more, only
 * their upper cross-arms out of the water; then the line coming up out of the water at the high island's shore and
 * climbing its left flank, the towers there upright on dry ground (never flooded), each further, higher and smaller.
 * Switched by `drift.html?drownedstub` (SUNKEN_SET.stub), off by default.
 *
 * WHERE, AND WHY THERE. The w1–w6 eyes see the coast's far land on fixed bearings (deg right of the coast's front, −z;
 * within a degree or two from every eye of the coast, it is so far): the high island's skyline −52..−27 with ITS
 * MASTS at −42..−45 (the station that answers in the radio story: never a tower in front of them), motu 2's relay at
 * −28..−30, motu 1's low band −66..−87 with its tower at −74..−78, and the Sun on w3–w5's sunset road at −68. Measured
 * along every eye of w1–w6 at 0.5 s (beats.ts coastEye, coastLook; the masts from coast.ts `towers`; the row-8 seat's
 * view reaches 91° round at the horizon, ~101° at the masts' 3°, 105° at 5°: off drift-seat-view.py's remap tables):
 *
 *   - THE FIRST, in the gap between the high island and motu 1: 120–130 m from the w1 raft, 170 m out from the beach.
 *     Through w1's dawn it stands in the open water left of the island, −52..−69 from the eye arm to arm (its peak
 *     6.5° up), its right arm 7° and more clear of the island's masts (only before first light, 505–515 s, does that
 *     arm stand over the island's low left foot). A near thing sweeps across everything far as the eye travels its
 *     ~150 m to the beach: this one slides left off the row of far tops through w1 (it covers them at 505–520 s and
 *     uncovers them by 530 s: the line's parallax), then off to the left as the eye turns toward the land in w2, in
 *     front of motu 1's tower at the very edge of the frame (551–577 s, 96–100° round: the eye's path crosses the
 *     line from motu 1's tower through the first, so some tower this near must sweep over it there or mid-frame); from
 *     the beach (w3–w5) it stands ~100° round, its top just in the seat view's left corner (w4's turn toward the flock
 *     brings the whole tower to the edge, 30° left of the Sun); in w6 it is back at the left edge, low against motu 1's
 *     band, then under the 22 m eye's horizon.
 *   - THE TOPS IN THE LAGOON, 2.0, 3.1 and 4.3 km out along the way to the island's shore, on a line bowed ~120 m to
 *     the left of the straight one: from the w1 eye at 535 s at −56.0, −54.5 and −53.5, then the shore
 *     tower at −52.5 and the two up the flank at −51.5 and −50.5 — a row of seven, each a degree or more from the next
 *     and further right, smaller and paler, receding into the island's left foot; from the beach the same row between
 *     the Sun's road and the island (−59..−53). Each drawn 2× the kit as the island's are, drowned so that only its
 *     upper cross-arms stand out of the water: the first (2 km) and the second (3.1 km, over the old valley's deepest
 *     floor: the least of it out, 31 %) to their middle arms, its tips 6.7 and 3.7 m out, the third (4.3 km, the floor
 *     rising toward the island) to its lowest, 4.7 m out; each leaning its own way on the silt. Their tops stand
 *     0.67, 0.39 and 0.41° over the sea's horizon from the w1 eye, the shore tower's 0.7, the flank's 0.85 and 1.25.
 *     (The r1 seat stills, at 2 m less out: the row read as small pale ticks, the third barely.)
 *
 *     WHY NOTHING NEARER, AT 300 OR 700 m (the coordinator asked for towers there too): the beach (w3–w5) and the w1
 *     raft see the near lagoon ~120 m apart, so a tower a few hundred metres out that stands between the first and
 *     the island from the raft stands 7–10° further left from the beach — on the sunset road (−68, kept 8° clear). A
 *     tower there clear of the road from the beach stands either in front of the island's masts from the raft or,
 *     left of the first, over motu 1's tower. From ~1.9 km out the two eyes' bearings close to within 3°, and the row
 *     fits both. The valley's near side drops steeply from our island's shore: its towers there are wholly drowned.
 *   - THE ISLAND: the shore tower 6.3 km off with its feet at the waterline, then two up the flank, 28 m and 86 m up
 *     the slope, at −52.4, −51.5 and −50.5 from the w1 eye (−53.5..−51.2 from the beach): beside each other, not
 *     stacked end-on, and 5° and more clear of the masts from every eye. Each where its top stands over the island's
 *     own skyline behind it from every eye (by 0.2–0.5°: its cross-arms and peak against the sky, not lost on the
 *     island's slate slope), drawn 2× the kit (an 80 m tower, as the big lines' are, not the 230 kV kit's 40). The
 *     line ends at the last, as if it ran on over the flank's shoulder. (A second tower in the water on a shoal 1.5 km
 *     out on the straight way stood end-on in front of the shore tower from w1 and was dropped: the bow is why the
 *     tops in the lagoon do not.)
 *
 * THE FAR ONES' MEMBERS read heavier by the pixel floor (powerLine.ts `heavy`): a lattice member 2–7 km off is
 * 1/6–1/25 of a pixel of the 4096² master, floored to THIN_MIN_WIDTH_PX it is drawn at that coverage, and the whole
 * tower through the far air came out ~5 % off the sky behind it (the r2–r4 stills: the island's three at 1.5×, then
 * 2× over its skyline, then 10× heavier, "three pale posts" at best). Each tower's `heavy` takes its leg members to
 * ~0.85 of the floor (1.25 px of the master) from its nearest eye: 5 at 2 km … 14 at 6.3 km — as heavy as it can be
 * and still be drawn at the floor's width, never wider.
 *
 * NO RACE PAINT (powerLine.ts plainPylonKit): the kit is the speedboat circuit's pylon, its legs banded with hazard
 * paint and hung with the league's chequer boards at the waterline; a valley's line never had them. Its own weathered
 * steel and the sea's growth (drownedLook.ts).
 *
 * The wires are strung only between the towers on the island (710 and 516 m spans, sagging as decades of slack do,
 * powerLine.ts), floored at 2 px of the 4096² master (CABLE_MIN_ANGLE). Every one that went into the water has
 * snapped and hangs into it: at the first tower, at each top in the lagoon from the arms still out of the water, and
 * at the shore tower on its seaward side. The spans between the far tops are not drawn (at 1–2 km apart their
 * catenaries would lie in the water; a conductor 2 km off is ~1 % of the floor's 2 px): the row implies them.
 *
 * Tried before (the r1 seat stills): the placement study's window, −15° to −35° from the w1 raft (two towers 160–210 m
 * off at along 88, off 112): its sweep ran ACROSS the island and its mast as the eye came ashore (575–597 s, in
 * frame), and from the beach it stood in the front-left vista within 8° of the sunset road. Every spot ~100 m off in
 * that window measured worse: over motu 1's tower for 20–40 s of w3–w6, or on the sunset road.
 *
 * Each tower: where (beach coordinates), the ground under it (the coast's), the kit's scale, and, in the water, how far
 * it is drowned (m lower than the kit: sink 8 leaves the first's lowest arm 3.35 m over the water, its earth-wire peak
 * 17.6 m) and its lean (deg, across the line and along it, pivoting where it leaves the floor). Each tower's cross-arms
 * stand square to the line (an angle tower's on the bisector of its two spans), broadside to the w1 eye that looks
 * along it.
 */
export interface StubTower {
  /** m: beach coordinates (beats.ts COAST) */
  along: number;
  off: number;
  /** m: the ground under it over the sea (− under: the floor), as coast.ts `heightAt` has it — the far island's ground
   * is not in the sand function this file is handed, so it is written here and the tests hold it to the coast's */
  ground: number;
  /** × the kit's size */
  scale: number;
  /** a tower in the water: m it stands lower than the kit (and deg it leans across the line, and along it — toward
   * the next tower +, pivoting where it leaves the floor). A tower on land has none of these: it stands upright on
   * its footings, as built */
  sink?: number;
  lean?: number;
  leanAlong?: number;
  /** × its members' widths as the pixel floor reads them (powerLine.ts PylonSpec.heavy): the far ones' */
  heavy?: number;
}
export interface StubLayout {
  towers: StubTower[];
  /** the spans still strung: tower indices and the conductors on them (the kit's attach indices; the rest snapped) */
  spans: Array<{ from: number; to: number; attach?: number[] }>;
  /** conductors snapped at tower `at`, hanging toward tower `toward` */
  snapped: Array<{ at: number; toward: number; attach: number[] }>;
}
/** m: a tower on land stands this far into its ground (its footings, and the slope under its widest legs) */
const FOOTINGS = 1.5;
/** m: the kit's foot under its own origin (powerLine.ts: from 14 m under still water to its 26 m peak) */
const KIT_FOOT = 14;

export const POWER_STUB: StubLayout = {
  towers: [
    // the half-drowned one in our lagoon's shallows (the r1 stills: "that drowned could work")
    { along: -20, off: 168, ground: -2.46, scale: 1, sink: 8, lean: 9 },
    // the tops in the lagoon, on the way to the island's shore bowed 118, 105 and 70 m to its left: to the middle arm
    // (its tips 6.7 m out, the lowest's 1.3 m under), to the middle arm (3.7 m out: the deepest), to the lowest (4.7 m)
    { along: 1109, off: 1824, ground: -24, scale: 2, sink: 24, lean: 5, leanAlong: -2, heavy: 5 },
    { along: 1791, off: 2687, ground: -29.8, scale: 2, sink: 27, lean: -7, heavy: 8 },
    { along: 2552, off: 3616, ground: -29.8, scale: 2, sink: 18, lean: 2, leanAlong: 4, heavy: 11 },
    // at the high island's shore, its feet at the waterline; then up its left flank, each topping the skyline
    { along: 3755, off: 5058, ground: 1.7, scale: 2, heavy: 14 },
    { along: 4278, off: 5538, ground: 28.2, scale: 2, heavy: 14 },
    { along: 4691, off: 5847, ground: 85.8, scale: 2, heavy: 14 },
  ],
  spans: [
    { from: 4, to: 5 },
    { from: 5, to: 6 },
  ],
  snapped: [
    // (every conductor that ran into the water: from the arms still out of it, toward the towers gone under)
    { at: 0, toward: 1, attach: [0, 2, 4] },
    { at: 0, toward: -1, attach: [3, 7] },
    { at: 1, toward: 0, attach: [2, 5, 6] },
    { at: 1, toward: 2, attach: [4, 7] },
    { at: 2, toward: 1, attach: [4, 6] },
    { at: 2, toward: 3, attach: [5] },
    { at: 3, toward: 2, attach: [0, 3, 7] },
    { at: 3, toward: 4, attach: [2, 4, 5] },
    { at: 4, toward: 3, attach: [0, 1, 2, 3] },
  ],
};

/** the stub's towers and wires off `beach`, world x, z (pure: the tests read it). `toward` −1: away from tower 1 */
export function stubPowerLine(beach: { x: number; z: number }, stub: StubLayout = POWER_STUB): PowerLineSpec {
  const D = Math.PI / 180;
  const at = stub.towers.map((t): [number, number] => [beach.x - t.off, beach.z - t.along]);
  const n = at.length;
  /** rad: the kit's +z along world (dx, dz) */
  const way = (dx: number, dz: number): number => Math.atan2(dx, dz);
  const pylons: PylonSpec[] = stub.towers.map((t, i) => {
    const [x, z] = at[i];
    // each tower's cross-arms square to the line, an angle tower's on the bisector of its two spans
    const inW = i > 0 ? way(x - at[i - 1][0], z - at[i - 1][1]) : way(at[1][0] - x, at[1][1] - z);
    const outW = i + 1 < n ? way(at[i + 1][0] - x, at[i + 1][1] - z) : inW;
    const yaw = Math.atan2(Math.sin(inW) + Math.sin(outW), Math.cos(inW) + Math.cos(outW));
    // in the water: sunk and leaning on the floor; on land: its foot FOOTINGS m into the ground, upright
    const sink = t.sink ?? -(t.ground - FOOTINGS + KIT_FOOT * t.scale);
    return { x, z, yaw, sink, lean: [(t.leanAlong ?? 0) * D, (t.lean ?? 0) * D], footing: -t.ground, scale: t.scale, heavy: t.heavy };
  });
  const snapped = stub.snapped.map((s) => {
    const [x, z] = at[s.at];
    const [tx, tz] = s.toward >= 0 ? at[s.toward] : [2 * x - at[1][0], 2 * z - at[1][1]];
    return { at: s.at, toward: [tx, tz] as [number, number], attach: s.attach };
  });
  return { pylons, spans: stub.spans.map((s) => ({ ...s })), snapped };
}
