/**
 * THE RADIO TOWER ON THE HIGH ISLAND: the first sunken-world cue (drift-narrative/wandering-on/sunken-world-cues.md,
 * cue 4). The user, 2026-10-29: "without someone telling me the story it doesn't become apparent" — so put "the
 * massive radio tower that we built for the speedboat thing … with its wires … on the hill that is visible on the
 * island in the far distance", and the audience reads "this is California after being submerged by hundreds of feet
 * of water", "not a tropical paradise as it always has been". A guyed lattice mast on a summit is a mountaintop
 * transmitter (Mount Wilson, Sutro): that hill was a ridge over a city.
 *
 * THE KIT IS THE SPEEDBOAT CIRCUIT'S (assets/models/course_radio_tower.glb, scripts/blender/course/radio_tower.py): the
 * mast's lattice at LOD1 and its nine guys, drawn from the GLB's `extras.guys` to an anchor down the slope from each
 * leg, as the game does (circuit/courseFurniture.ts, CABLES). The game's loader is tied to its course (batched LOD
 * bands, KTX2 textures that need the renderer, its water lighting), so this is its film copy: the geometry alone
 * (`geometryOnly`: no texture is fetched or decoded), no race control shack, lamp rig or anchor floats. The game is
 * untouched.
 *
 * SCALE. The kit's mast is 104 m over the water (96 m to its cap, an 8 m whip) on a 2.4 m face. On a mountaintop it is
 * stretched to TOWER.tip (208 m to the whip's tip) and widened to TOWER.face, the guys at 60/120/180 m, their anchors
 * 50–98 m down the summit's slopes (guys 182–313 m long). At 7.6 km from the beach (the numbers below) it spans 1.56°
 * — 35 px of a 4K master, 71 of an 8K; a leg is 0.06 px of it, a guy 0.008 px. Nothing in it is resolved: what reads
 * is its silhouette on the summit, and how dark that can be is physics — through 7.6 km of this air (HIGH_AIR) 59 %
 * of what the eye gets from the summit is the haze's own light, so nothing there can be darker than the island is.
 *
 * A HEAVY BROADCAST MAST, NOT THE KIT'S SLIM ONE (the 2026-10-29 review round, at the 4K master's pixel: the kit's
 * proportions, a 3.4 m face, made a line 4 levels lighter than the morning sky and 5 darker than the sunset's, one
 * pixel wide — a cue no one would find; the user: "the massive radio tower … make it clear"). A lattice is a third
 * steel across its silhouette (measured from the beach: ~1.15 m² a metre of height at 3.4 m), so its ink goes with its
 * face: TOWER.face is 5 m, its legs 36 cm across, as a heavy broadcast mast's are. And the top of it carries what
 * every TV mast on a mountain carries, its ANTENNA STACK: the top section wrapped in panel antennas (TOWER.panels), a
 * solid triangular column ~6.6 m across and 46 m tall — a pixel of solid at 4K, eight tall: the head on the pin that
 * makes a hairline read as a transmitter. At sunset the island itself is 38 levels under the sky (measured, same
 * still), so a solid that size has the room to show without being drawn darker than the haze allows.
 *
 * THIN THINGS AT 7 KM (the brief: centimetre wires "far below a pixel … will alias/flicker even with the dome's 4×
 * MSAA"). Every lattice member and every guy is drawn by core/minWidth.ts (§V41, the game's own pylons and cables):
 * never narrower than THIN_MIN_WIDTH_PX of the face it is drawn in, the widening paid back as coverage, BLENDED — so a
 * member of a thirtieth of a pixel is a 1.25 px band at a thirtieth of its colour, and the mast is a faint continuous
 * line with the right amount of ink (its members' true projected area) instead of a dashed one that crawls. Not the
 * game's hashed mode: its threshold steps with the frame counter, so a still eye would see it shimmer, and a frame
 * would depend on how many came before (CLAUDE.md: every frame a pure function of t). Depth is not written: in one
 * pixel a dozen members overlap and each must add its share (with depth on, the ones drawn later behind were lost),
 * and nothing is behind the mast but the sky and the hill, both opaque and drawn first. What computeThinAxes cannot
 * take as a member (the guy plates, the dish shrouds, the cap: 51 % of the steel's vertices at LOD1, measured) has no
 * axis to widen along; it fades by its own coverage instead (NON_MEMBER), the way groundDebris.ts thins its twigs by
 * the pixel at their depth — a fade, not a cut, so nothing pops.
 *
 * Measured 2026-10-29 on the coast's own terrain along coastEye's path (w1 490 s to w6 740 s): the high island's
 * summit (`summitOf`) is (−45208, −5555), 467 m over the sea, 7610–7670 m from the eye, 42–43° left of the coast's
 * front (against the eye's look: 42° left in w1, 51–67° as the landfall looks round to the land, 32° in w4 when the
 * eye turns to the birds), 3.45–3.48° up; the tip 5.0° up. The ground in front of the summit along each of those
 * rays rises to at most 3.41°, behind it to 3.40°: the summit is the skyline from everywhere the eye goes, the whole
 * mast stands against the sky, and of the guys 84 % can be seen (the rest drop behind the summit to the far
 * anchors), 83 % of that against the sky. No guy passes under the ground between its ends.
 *
 * THE LAMP: ONE STILL BLINKS. A drowned, abandoned site — no grid, the side beacons dark — but the top one is a
 * self-contained solar obstruction light (they are made for towers no one visits), and it is still flashing red on
 * the mountain decades after anyone heard the station. That is the eerie half of the cue. It is drawn as the eye sees
 * a point (EYE_CELL: a pixel coarser than the eye would dilute it), with a faint glow of the light the air scatters
 * (GLOW), stepped down at night so AgX keeps it red (NIGHT). By day it is a faint pip at most (+5 levels of red
 * against w4's sky, modelled); against w5's afterglow a red point (+27 at 700.8 s); in w6's night a red point,
 * (163, 25, 4) at its core, not the field's warm white. No photocell switch: it would pop on mid-shot.
 *
 * Every frame a pure function of t: the lamp's phase is the coast's clock (`setTime`, sea seconds), nothing else moves.
 */
import * as THREE from 'three/webgpu';
import { cameraPosition, cameraProjectionMatrix, exp, float, log2, mix, modelWorldMatrix, output, positionGeometry, positionWorld, select, smoothstep, uniform, uv, varying, vec3, vec4, viewport, attribute } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyMinWidth, computeThinAxes, projectedWidthPx, THIN_AXIS_ATTRIBUTE, THIN_MIN_WIDTH_PX } from '../../core/minWidth';
import type { AerialUniforms } from '../../terrain/aerialPerspective';
import { SUN_E } from '../getTheDrift/atmosphere';
import { billboardMesh, eyeFacing } from '../undertime/billboard';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const URL_GLB = new URL('../../../assets/models/course_radio_tower.glb', import.meta.url).href;

/** the tower as built on the summit (see the header) */
export const TOWER = {
  /** m: the whip's tip over the footing (the kit's: 104.12) */
  tip: 208,
  /** m: across a face of the triangular lattice (the kit's: 2.4, radio_tower.py R = 2.4/√3; see the header) */
  face: 5,
  /** m over the footing the panel antenna stack wraps the mast from and to, and how far its panels stand out past the
   * lattice's corners (the beacon on the cap stays clear above it) */
  panels: { from: 140, to: 186, out: 1.2 },
  /** m: each leg's anchor out from the mast's axis, down the slope (a guyed mast's are ~0.7–0.8 of its height; one
   * anchor a leg takes all three of its guys, as the kit's three floats did) */
  anchorRadius: 150,
  /** m: a guy's radius (the game's, courseFurniture.ts) and its sag as a share of its length */
  guyRadius: 0.024,
  guySag: 0.006,
  /** m the guys run on into the slope past its surface (a drawn terrain cell may sit a metre off the sampled one) */
  guySink: 0.5,
  /** m the footing is sunk below the sampled ground (the kit's legs run on 28 m under it, scaled) */
  sink: 0.3,
};
/** m: the kit's face (radio_tower.py: R = 2.4 / √3) */
const KIT_FACE = 2.4;

/**
 * THE BEACON: an L-864 red flasher (FAA AC 150/5345-43: 20–40 flashes a minute, 2000 cd ± 25 %) — the kit's own
 * aviation lamp flashes at 0.6 Hz (36 a minute, `extras … flashHz`). `duty` of each cycle lit, its LED driver's soft
 * edge `ramp` s (and so a frame on the edge is not a coin toss between on and off).
 */
export const BEACON = { hz: 0.6, duty: 0.5, ramp: 0.12, candela: 2000 };
/** linear sRGB of the red lens (~630 nm sits just outside sRGB's red primary), scaled to unit luminance */
const RED: [number, number, number] = [1, 0.045, 0.02].map((c) => c / (0.2126 + 0.7152 * 0.045 + 0.0722 * 0.02)) as [number, number, number];
/** lux in one unit of the scene's irradiance: SUN_E (7) is the Sun's at the top of the air, ~128 000 lux */
const LUX_PER_UNIT = 128000 / SUN_E;
/** m: the lens's own radius */
const LENS = 0.25;
/**
 * THE POINT AS THE EYE SEES IT, NOT AS A PIXEL AVERAGES IT (the 2026-10-29 round: drawn with its light kept, the lamp
 * added +1 level of red to the dusk sky at 700.8 s; with all of its light in one 4K pixel it would still add +4 — while
 * a real L-864 at 7.6 km at dusk is plainly a red point). The eye resolves ~1 arcmin, a cell EYE_CELL in radius: a
 * point's light lands in that, and against the afterglow's ~2000 cd/m² it reads at ~200 cd/m² (+10 % and red). A 4K
 * pixel is 7× that cell's area, an 8K one 1.6×: kept to its energy, the point is diluted by the pixel, which is the
 * camera's truth, not the audience's. So the core is drawn at the eye's radiance (E / the cell), never under CORE_PX
 * face pixels in radius (flat over its inner half, so it fills the pixel it lands in) — more light than the lamp sends
 * where pixels are coarser than the eye, its own light exactly where they are finer.
 */
const EYE_CELL = 0.15e-3;
const CORE_PX = 1;
/**
 * THE GLOW: light the air scatters on the way, a share of the (1 − T) the haze takes out of the beam, drawn a few mrad
 * about the lamp and conserving its light at any size. Honestly bounded it is faint (forward scatter within a few mrad
 * is a small part of any real aerosol's scatter; `share` is generous): a soft red skirt round the point at night,
 * nothing by day.
 */
const GLOW = { share: 0.5, radius: 1.5e-3 };
/**
 * THE NIGHT STEP: as the sky goes dark the lamp steps down to `step` of its twilight output (a solar beacon's night
 * setting, sparing its battery). Without it the eye-true core, under the night's exposure (14×), goes salmon in AgX
 * (its inset and log curve pull a bright pure red toward orange: modelled, (226, 71, 43)); at 0.4 it is (163, 25, 4),
 * red. Keyed on the horizon's luminance (the haze colour the island already melts into: log10 −1.2 at w5's dusk, −7.3
 * in w6's night), between `horizon` (log10, scene units), so each beat of the w5→w6 dissolve draws its own.
 */
const NIGHT = { step: 0.4, horizon: [-5, -3] as [number, number] };
/** m the beacon's point is drawn toward the eye from the lamp: its few-pixel quad must not dip behind the antenna
 * stack's front a few metres nearer (the depth would cut its lower half off) */
const LAMP_OUT = 10;
/** m: what a part the lattice's member fit cannot claim (a plate, a dish, the cap) is taken to span, for its fade */
const NON_MEMBER = 0.5;

/** the lamp's level 0..1 at sea time t (s): a pure function of t, the TSL below its mirror */
export function beaconLevel(t: number): number {
  const ph = ((t * BEACON.hz) % 1 + 1) % 1;
  const r = BEACON.ramp * BEACON.hz;
  const s = (a: number, b: number, x: number): number => {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };
  return s(0, r, ph) * (1 - s(BEACON.duty, BEACON.duty + r, ph));
}

/** the core's profile over its drawn radius: flat to half of it, then a soft edge (TSL below: `1 − smoothstep`) */
export const coreProfile = (rho: number): number => {
  const k = Math.min(1, Math.max(0, (rho - 0.5) / 0.5));
  return 1 - k * k * (3 - 2 * k);
};
/** ∫ coreProfile over the unit disc (numerically, once), and the glow's (1 − ρ²)³ (exactly π/4) */
const CORE_AREA = (() => {
  let a = 0;
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const r = (i + 0.5) / n;
    a += coreProfile(r) * 2 * Math.PI * r * (1 / n);
  }
  return a;
})();
const GLOW_AREA = Math.PI / 4;

/**
 * The lamp's light at the eye (scene units), for `candela` through transmittance `T` from `d` m, its core drawn `core`
 * rad in radius and its glow `glow` rad: the core's peak radiance (the eye's cell's, or its own light where the drawn
 * point is finer than the cell) and the glow's (its share of the scattered light, kept at any size). CPU mirror of the
 * TSL below.
 */
export function lampAt(candela: number, T: number, d: number, core: number, glow: number): { core: number; glow: number } {
  const I = candela / LUX_PER_UNIT;
  const E = (I * T) / (d * d);
  const scattered = (GLOW.share * (1 - T) * I) / (d * d);
  return { core: E / Math.min(Math.PI * EYE_CELL * EYE_CELL, CORE_AREA * core * core), glow: scattered / (GLOW_AREA * glow * glow) };
}

/** the lamp's output 1 … NIGHT.step as the horizon's luminance (scene units) falls through NIGHT.horizon */
export function nightStep(horizon: number): number {
  const x = Math.log10(Math.max(horizon, 1e-12));
  const k = Math.min(1, Math.max(0, (x - NIGHT.horizon[0]) / (NIGHT.horizon[1] - NIGHT.horizon[0])));
  return NIGHT.step + (1 - NIGHT.step) * k * k * (3 - 2 * k);
}

/** the highest ground within `half` m of `centre` (world x, z): a 20 m grid, then 2 m round its best */
export function summitOf(heightAt: (x: number, z: number) => number, centre: [number, number], half: number): { x: number; z: number; y: number } {
  let best = { x: centre[0], z: centre[1], y: -Infinity };
  const scan = (x0: number, z0: number, reach: number, step: number): void => {
    for (let z = z0 - reach; z <= z0 + reach; z += step) {
      for (let x = x0 - reach; x <= x0 + reach; x += step) {
        const y = heightAt(x, z);
        if (y > best.y) best = { x, z, y };
      }
    }
  };
  scan(centre[0], centre[1], half, 20);
  scan(best.x, best.z, 20, 2);
  return best;
}

/** what the kit's GLB says about its mast (its root's extras) */
export interface KitMast {
  /** m: the whip's tip over still water */
  heightAboveWater: number;
  /** rad: each leg's azimuth in the asset's x, z (radio_tower.py LEG_AZ) */
  legAzimuths: number[];
  /** each guy's lug, asset metres, and the leg (anchor) it runs to */
  guys: Array<{ leg: number; at: [number, number, number] }>;
  /** asset metres: the top beacon */
  lamp: [number, number, number];
}

export interface TowerLayout {
  /** world: the mast's origin (the kit's still-water point on its axis), on the summit */
  foot: [number, number, number];
  /** rad: its turn about y (three.js rotation.y) */
  yaw: number;
  /** the kit's scale across (x, z) and up (y) */
  across: number;
  up: number;
  /** world: each guy's lug on the mast and its end in the slope */
  guys: Array<{ from: [number, number, number]; to: [number, number, number] }>;
  /** world: the beacon */
  lamp: [number, number, number];
}

/**
 * Where the mast and its guys go: the foot on the ground at `at`, the first leg — and its anchor — turned toward
 * `toward` (the beach), so the other two anchors lie behind the summit at ±60° off the line of sight and their guys
 * fan out left and right against the sky (the first leg's run toward the eye, along the mast). Pure.
 */
export function layTower(site: { ground: (x: number, z: number) => number; at: [number, number]; toward: [number, number] }, kit: KitMast): TowerLayout {
  const [x0, z0] = site.at;
  const up = TOWER.tip / kit.heightAboveWater;
  const across = TOWER.face / KIT_FACE;
  const foot: [number, number, number] = [x0, site.ground(x0, z0) - TOWER.sink, z0];
  // the asset's first leg is at azimuth legAzimuths[0] (π: its −x); turned by `yaw` it points along (dx, dz)
  const dx = site.toward[0] - x0;
  const dz = site.toward[1] - z0;
  const a0 = kit.legAzimuths[0];
  // rotation.y θ takes asset (cos a, sin a) to (cos(a − θ), sin(a − θ)) in x, z: want a0 − θ = atan2(dz, dx)
  const yaw = a0 - Math.atan2(dz, dx);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const world = (p: [number, number, number]): [number, number, number] => {
    const x = p[0] * across;
    const z = p[2] * across;
    return [foot[0] + c * x + s * z, foot[1] + p[1] * up, foot[2] - s * x + c * z];
  };
  const guys = kit.guys.map((g) => {
    const a = kit.legAzimuths[g.leg] - yaw;
    const ax = x0 + Math.cos(a) * TOWER.anchorRadius;
    const az = z0 + Math.sin(a) * TOWER.anchorRadius;
    return { from: world(g.at), to: [ax, site.ground(ax, az) - TOWER.guySink, az] as [number, number, number] };
  });
  return { foot, yaw, across, up, guys, lamp: world(kit.lamp) };
}

export interface RadioTowerSite {
  /** the island's ground (m over the sea) at a world x, z */
  ground: (x: number, z: number) => number;
  /** world x, z the mast stands on (`summitOf`) */
  at: [number, number];
  /** world x, z its first leg's guys run toward */
  toward: [number, number];
  /** the haze the island melts into, and its air (m; coast.ts HIGH_AIR): the tower melts on the same curve */
  haze: AerialUniforms['color'];
  air: number;
  url?: string;
}

export interface RadioTower {
  readonly group: THREE.Group;
  /** resolves once the kit's geometry is in */
  readonly ready: Promise<void>;
  readonly layout: Promise<TowerLayout>;
  /** sea seconds: the beacon's clock */
  setTime(t: number): void;
}

/** a GLTF loader that reads the geometry and none of the materials' textures (KTX2: they would need the renderer) */
function geometryOnly(): GLTFLoader {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  // (the parser asks its plugins for each material before building its own: this one answers with a bare one named
  // as the slot was, so no texture is ever requested)
  loader.register((parser) => ({
    name: 'drift_geometry_only',
    loadMaterial: (i: number) => Promise.resolve(new THREE.MeshBasicMaterial({ name: String(parser.json.materials?.[i]?.name ?? '') })),
  }));
  return loader;
}

const extra = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/** position and normal only, float32, as the merge and the member fit want them */
function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const a = g.getAttribute(name);
    const arr = new Float32Array(a.count * 3);
    for (let i = 0; i < a.count; i++) arr.set([a.getX(i), a.getY(i), a.getZ(i)], i * 3);
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  if (g.index) out.setIndex(Array.from(g.index.array as ArrayLike<number>));
  return out;
}

/** a material melting into `haze` over `air` m, as the island's ground does (forest.ts createForestGround) */
function hazed<M extends THREE.NodeMaterial>(m: M, haze: AerialUniforms['color'], air: number): M {
  m.fog = false;
  const k = float(1).sub(exp(positionWorld.xz.sub(cameraPosition.xz).length().div(-air))) as F;
  m.outputNode = vec4(mix(output.rgb, vec3(haze as unknown as V3), k), output.a);
  return m;
}

/**
 * THE MAST'S PAINT, seventy years on: the aviation bands it was painted in (seven, orange and white, from the foot to
 * the cap) chalked and mostly gone, rust where they are gone. Each band keeps its own share of paint (a hash of its
 * index, so it is constant along the band and never noise at a scale the distance cannot draw), its edges soft over
 * a few metres. At 7 km it is the line's darkness: a mean albedo of ~0.15, darker than the haze it stands in.
 */
function mastMaterial(foot: number, height: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  const u = positionWorld.y.sub(foot).div(height).clamp(0, 0.9999).mul(7);
  const band = u.floor();
  const f = u.fract();
  // (orange on the even bands, the foot's and the cap's; the edge between two blends over ±0.06 of a band, ~2 m)
  const edge = smoothstep(0.94, 1, f).add(smoothstep(0.06, 0, f)).mul(0.5) as F;
  const odd = band.mod(2) as F;
  const whiteness = mix(odd, float(1).sub(odd), edge) as F;
  const paint = mix(vec3(0.36, 0.11, 0.05), vec3(0.42, 0.4, 0.36), whiteness) as V3;
  const left = band.mul(12.9898).sin().mul(43758.5453).fract().mul(0.4).add(0.2) as F;
  const rust = vec3(0.1, 0.052, 0.03) as V3;
  m.colorNode = mix(rust, paint, left);
  return m;
}

/** the kit's root (CF_course_radio_tower), geometry only, from its URL or the GLB's own bytes */
export async function loadKit(source: string | ArrayBuffer): Promise<THREE.Object3D> {
  await MeshoptDecoder.ready;
  const loader = geometryOnly();
  const gltf = typeof source === 'string' ? await loader.loadAsync(source) : await loader.parseAsync(source, '');
  const root = gltf.scene.getObjectByName('CF_course_radio_tower') ?? gltf.scene.children[0];
  if (!root) throw new Error('radioTower: the kit has no CF_course_radio_tower root');
  return root;
}

/**
 * The tower from the kit's `root` on `site`: the mast, its guys and its beacon added to `group`, the beacon's clock
 * `time` (sea s). Returns where everything went.
 */
export function buildRadioTower(root: THREE.Object3D, site: RadioTowerSite, time: THREE.UniformNode<'float', number>, group: THREE.Group): TowerLayout {
  const ex = (k: string): unknown => extra(root.userData?.[k]);
  const variants = (ex('variants') ?? {}) as Record<string, { lamps?: Array<{ at: [number, number, number]; role: string }> }>;
  const lamp = variants.Beacons?.lamps?.find((l) => l.role === 'aviation')?.at;
  const guys = ex('guys') as KitMast['guys'] | undefined;
  const legs = ex('legAzimuths') as number[] | undefined;
  const tall = Number(ex('heightAboveWater'));
  if (!lamp || !guys?.length || !legs?.length || !Number.isFinite(tall)) throw new Error('radioTower: the kit lacks its guys, legs, height or beacon (extras)');
  const lay = layTower(site, { heightAboveWater: tall, legAzimuths: legs, guys, lamp });

  // THE MAST: its LOD1 lattice (legs, struts, diagonals, plates, the whip), scaled into the geometry so the member
  // fit and the widening are in true metres (minWidth reads a member's radius as world metres)
  const node = root.getObjectByName('LOD1')?.getObjectByName('Mast_LOD1');
  if (!node) throw new Error('radioTower: the kit has no Mast_LOD1');
  const parts: THREE.BufferGeometry[] = [];
  node.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) parts.push(plain((o as THREE.Mesh).geometry));
  });
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!geo) throw new Error('radioTower: the mast would not merge');
  geo.applyMatrix4(new THREE.Matrix4().makeScale(lay.across, lay.up, lay.across));
  geo.setAttribute(THIN_AXIS_ATTRIBUTE, new THREE.BufferAttribute(computeThinAxes(geo), 4));
  geo.computeBoundingSphere();
  const mm = hazed(mastMaterial(lay.foot[1], TOWER.tip), site.haze, site.air);
  applyMinWidth(mm, 'blend', THIN_MIN_WIDTH_PX);
  // (a part with no member axis: faded by its own coverage, NON_MEMBER m against the face's pixel)
  const member = attribute(THIN_AXIS_ATTRIBUTE, 'vec4').w.greaterThan(0);
  const world = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
  const fade = varying(select(member, float(1), projectedWidthPx(world, float(NON_MEMBER / 2)).div(THIN_MIN_WIDTH_PX).min(1)));
  mm.opacityNode = (mm.opacityNode as Node).mul(fade);
  mm.transparent = true;
  mm.depthWrite = false;
  mm.name = 'drift-radio-tower-mast';
  const mast = new THREE.Mesh(geo, mm);
  mast.name = 'drift-radio-tower-mast';
  mast.position.set(...lay.foot);
  mast.rotation.y = lay.yaw;
  group.add(mast);

  // THE ANTENNA STACK: a triangular column round the top section, its corners on the legs', TOWER.panels.out past
  // them. It is solid, so unlike the lattice it writes depth and is drawn first: the members inside it and the guys
  // behind it are hidden as they would be. Its axis is the mast's, its half-width its corner radius, so minWidth widens
  // it too once it is under ~1.25 px (a 2K preview, a far eye) and pays that back as coverage.
  {
    const P = TOWER.panels;
    const R = TOWER.face / Math.sqrt(3) + P.out;
    const h = P.to - P.from;
    // (three sides; thetaStart puts its corners at the legs' azimuths, the kit's legs being at π and ±π/3 in x, z —
    // three's cylinder puts θ at (sin θ, cos θ))
    const prism = new THREE.CylinderGeometry(R, R, h, 3, 1, false, Math.PI / 2 - legs[0]).toNonIndexed();
    prism.translate(0, (P.from + P.to) / 2, 0);
    prism.computeVertexNormals();
    prism.deleteAttribute('uv');
    const pos = prism.getAttribute('position');
    const axes = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) axes.set([pos.getX(i), 0, pos.getZ(i), R], i * 4);
    prism.setAttribute(THIN_AXIS_ATTRIBUTE, new THREE.BufferAttribute(axes, 4));
    prism.computeBoundingSphere();
    const pm = hazed(mastMaterial(lay.foot[1], TOWER.tip), site.haze, site.air);
    applyMinWidth(pm, 'blend', THIN_MIN_WIDTH_PX);
    pm.transparent = true;
    pm.depthWrite = true;
    pm.name = 'drift-radio-tower-antennas';
    const stack = new THREE.Mesh(prism, pm);
    stack.name = 'drift-radio-tower-antennas';
    stack.position.set(...lay.foot);
    stack.rotation.y = lay.yaw;
    stack.renderOrder = -1;
    stack.castShadow = false;
    stack.receiveShadow = false;
    group.add(stack);
  }

  // THE GUYS: catenaries (a parabola's sag) from each lug to its anchor, tubes whose normals are their offsets from
  // the centreline (courseFurniture.ts cableAlong), built about the foot so the float32 positions stay small
  const tubes: THREE.BufferGeometry[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const r = TOWER.guyRadius;
  for (const g of lay.guys) {
    a.set(g.from[0] - lay.foot[0], g.from[1] - lay.foot[1], g.from[2] - lay.foot[2]);
    b.set(g.to[0] - lay.foot[0], g.to[1] - lay.foot[1], g.to[2] - lay.foot[2]);
    const sag = TOWER.guySag * a.distanceTo(b);
    const pts: THREE.Vector3[] = [];
    const n = 24;
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      pts.push(new THREE.Vector3().lerpVectors(a, b, k).setY(a.y + (b.y - a.y) * k - 4 * sag * k * (1 - k)));
    }
    const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n, r, 5, false);
    const nor = tube.getAttribute('normal');
    const axes = new Float32Array(nor.count * 4);
    for (let i = 0; i < nor.count; i++) axes.set([nor.getX(i) * r, nor.getY(i) * r, nor.getZ(i) * r, r], i * 4);
    tube.setAttribute(THIN_AXIS_ATTRIBUTE, new THREE.BufferAttribute(axes, 4));
    tube.deleteAttribute('uv');
    tubes.push(tube);
  }
  const guyGeo = mergeGeometries(tubes, false);
  for (const t of tubes) t.dispose();
  if (!guyGeo) throw new Error('radioTower: the guys would not merge');
  guyGeo.computeBoundingSphere();
  // (weathered galvanised strand: dull, a little metallic — in a low Sun a guy can still catch a glint)
  const gm = hazed(new THREE.MeshStandardNodeMaterial({ color: 0x55504a, roughness: 0.6, metalness: 0.6 }), site.haze, site.air);
  applyMinWidth(gm, 'blend', THIN_MIN_WIDTH_PX);
  gm.transparent = true;
  gm.depthWrite = false;
  gm.name = 'drift-radio-tower-guys';
  const wires = new THREE.Mesh(guyGeo, gm);
  wires.name = 'drift-radio-tower-guys';
  wires.position.set(...lay.foot);
  group.add(wires);

  // THE BEACON: an eye-facing quad (undertime/billboard.ts: it stitches across the dome's cube faces) holding the
  // core and its glow (`lampAt`, its CPU mirror), dimmed by the same air, stepped down at night (`nightStep`). (Its
  // corners are world positions: the coast's set and every group over it are untransformed, in world metres.)
  const lampPos = vec3(...lay.lamp);
  const centre = lampPos.add(cameraPosition.sub(lampPos).normalize().mul(LAMP_OUT));
  const dist = centre.sub(cameraPosition).length();
  // (a face pixel's angle at the face's centre: the same in all six faces, so the point is one size across a seam)
  const pixel = float(2).div(cameraProjectionMatrix.mul(vec4(1, 0, 0, 0)).x.abs().mul(viewport.z));
  // rad: the core's drawn radius, and the glow's (the quad's), at least twice the core's
  const coreAng = dist.mul(pixel).mul(CORE_PX).max(LENS).div(dist) as F;
  const glowAng = coreAng.mul(2).max(GLOW.radius) as F;
  const lm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  lm.positionNode = eyeFacing(centre, dist.mul(glowAng).mul(2));
  const ph = time.mul(BEACON.hz).fract();
  const ramp = BEACON.ramp * BEACON.hz;
  const level = smoothstep(0, ramp, ph).mul(float(1).sub(smoothstep(BEACON.duty, BEACON.duty + ramp, ph)));
  const lampDist = lampPos.sub(cameraPosition).length();
  const T = exp(lampPos.xz.sub(cameraPosition.xz).length().div(-site.air)) as F;
  const I = BEACON.candela / LUX_PER_UNIT;
  const vCore = varying(coreAng);
  const vGlow = varying(glowAng);
  const coreL = float(I).mul(T).div(lampDist.mul(lampDist)).div(vCore.mul(vCore).mul(CORE_AREA).min(Math.PI * EYE_CELL * EYE_CELL));
  const glowL = float(GLOW.share * I).mul(float(1).sub(T)).div(lampDist.mul(lampDist)).div(vGlow.mul(vGlow).mul(GLOW_AREA));
  const hazeLum = vec3(site.haze as unknown as V3).dot(vec3(0.2126, 0.7152, 0.0722)).max(1e-12);
  const dark = log2(hazeLum).mul(Math.LOG10E / Math.LOG2E);
  const step = mix(float(NIGHT.step), float(1), smoothstep(NIGHT.horizon[0], NIGHT.horizon[1], dark));
  const across = uv().sub(0.5).mul(2).length();
  const core = float(1).sub(smoothstep(0.5, 1, across.mul(vGlow).div(vCore)));
  const glow = float(1).sub(across.mul(across)).max(0).pow(3);
  lm.colorNode = vec4(vec3(...RED).mul(coreL.mul(core).add(glowL.mul(glow)).mul(level).mul(step)), 1);
  lm.name = 'drift-radio-tower-beacon';
  const beacon = billboardMesh(lm, 1, 'drift-radio-tower-beacon');
  beacon.renderOrder = 1;
  group.add(beacon);

  for (const o of [mast, wires, beacon]) {
    o.castShadow = false;
    o.receiveShadow = false;
  }
  return lay;
}

export function createRadioTower(site: RadioTowerSite): RadioTower {
  const group = new THREE.Group();
  group.name = 'drift-radio-tower';
  const time = uniform(0);
  const layout = loadKit(site.url ?? URL_GLB).then((root) => buildRadioTower(root, site, time, group));
  return {
    group,
    ready: layout.then(() => undefined),
    layout,
    setTime(t) {
      time.value = t;
    },
  };
}
