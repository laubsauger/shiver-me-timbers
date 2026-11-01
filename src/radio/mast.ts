/**
 * THE MAST ON A STATION'S SUMMIT — the visual half of the radio network (network.ts), one builder for the game and
 * the film. A spec in (`MastSpec`: kind, height, face, lamp), a group of meshes out. It knows nothing of the film's
 * sea or coast: where it stands, the air it is seen through and how its lamp's light is scaled are handed in.
 *
 * WHY HERE. The Drift put the first of these on its high island (2026-10-29), and the user: "inevitably we have to
 * transport whatever we build here, at least in terms of aesthetics, not necessarily layout, from the film to the
 * game". The game's own summit aerials (§T.104: "the last cairn is the station's aerial on the summit", the design
 * doc §06) are these. HOW THE GAME WOULD USE IT, when T104 builds them:
 *
 *   const root = await loadMastKit(MAST_KIT_URL);
 *   const time = uniform(0);                                     // the game clock's seconds, set per frame
 *   const { group } = buildMast(root, { ground, at: summitPoi, toward: landing }, stationOf(id).mast,
 *     { time, air: { output: (m) => materials.aerialOutput(m), transmittance: () => … }, luxPerUnit: … });
 *   island.add(group);
 *
 * with `at` the slice island's 'station' POI (pathGraph.ts) — §V71, never a constant — and the island materials'
 * own aerial curve (§B67). The film passes its own air and its eye-referenced lamp (radioTower.ts); the game may pass
 * neither and gets an energy-conserving lamp.
 *
 * THE KIT is the speedboat circuit's tower (assets/models/course_radio_tower.glb, scripts/blender/course/
 * radio_tower.py): the lattice at LOD1 (LOD0 for one seen close) and its nine guys drawn from `extras.guys`, as
 * circuit/courseFurniture.ts draws them (CABLES). Geometry only (`geometryOnly`: no texture is fetched, none needs the
 * renderer); no race control shack, lamp rig or anchor floats. Loaded once per URL however many masts are built.
 *
 * KINDS (network.ts): a `broadcast` mast wears a solid panel-antenna stack on its top section — the head on the pin
 * that makes a hairline read as a transmitter at 7 km (the 2026-10-29 round: the kit's slim proportions were a line 4
 * levels off the sky at the 4K pixel); a `relay` is the kit's own guyed mast with its microwave dishes; a `tower` is
 * self-supporting — its lattice tapered to TAPER of its foot's face at the top, and no guys.
 *
 * THIN THINGS (§V41, core/minWidth.ts): every lattice member, the stack below ~1.25 px, and every guy drawn never
 * narrower than THIN_MIN_WIDTH_PX of the target it is drawn in, the widening paid back as coverage, BLENDED (not the
 * frame-stepped hash: a still eye would see it shimmer, and a frame would depend on the frames before it). Members
 * write no depth (a dozen overlap in one pixel and each must add its share); the solid stack does, drawn first, so the
 * lattice inside it is hidden. What the member fit cannot claim (plates, dishes, the cap) fades by its own coverage
 * (NON_MEMBER).
 *
 * THE LAMP: an L-864-style red flasher (FAA AC 150/5345-43: 20–40 flashes a minute, 2000 cd), alive or dead per the
 * spec, its blink a pure function of `time` (`beaconLevel`). An eye-facing point (it stitches across a dome's cube
 * faces: its basis is built from the eye's position, not a view plane, as undertime/billboard.ts explains), drawn at
 * least `corePx` target pixels in radius. Its core is energy-conserving unless `eyeCell` is given (the film: the
 * radiance the eye sees in its own resolution cell, which a coarse pixel would dilute); an optional glow carries a
 * share of the light the air scatters; `step` scales it (the film's night step).
 */
import * as THREE from 'three/webgpu';
import { abs, attribute, cameraPosition, cameraProjectionMatrix, cross, float, mix, modelPosition, modelWorldMatrix, modelWorldMatrixInverse, normalize, positionGeometry, positionWorld, select, smoothstep, uv, varying, vec2, vec3, vec4, viewport } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyMinWidth, computeThinAxes, projectedWidthPx, THIN_AXIS_ATTRIBUTE, THIN_MIN_WIDTH_PX } from '../core/minWidth';
import { hash2 } from '../terrain/noise';
import type { MastLamp, MastSpec } from './network';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export const MAST_KIT_URL = new URL('../../assets/models/course_radio_tower.glb', import.meta.url).href;

/** the kit's own numbers (radio_tower.py): its face (m: R = 2.4 / √3), and its top beacon's height as a share of its
 * whip's tip (96.33 / 104.12 m) — so a lamp's place is known before the kit loads (tests/radioNetwork checks it) */
export const KIT = { face: 2.4, lampShare: 96.33 / 104.12 };

/** how a mast is built, for its spec (shares of its tip where they scale with it) */
export const MAST = {
  /** m the footing is sunk below the sampled ground (the kit's legs run on below it) */
  sink: 0.3,
  /** each leg's anchor out from the axis, as a share of the tip (a guyed mast's are ~0.7–0.8 of its height; the
   * high island's 150 m at 208 m), one anchor a leg for all three of its guys, as the kit's three floats were */
  anchorShare: 150 / 208,
  /** m: a guy's radius (the game's, courseFurniture.ts), its sag as a share of its length, and how far it runs on
   * into the slope past the sampled surface (a drawn terrain cell may sit a metre off it) */
  guyRadius: 0.024,
  guySag: 0.006,
  guySink: 0.5,
  /** a broadcast mast's panel stack: from and to as shares of the tip (140 and 186 m of the high island's 208), and m
   * its panels stand out past the lattice's corners */
  stack: { from: 140 / 208, to: 186 / 208, out: 1.2 },
  /** a self-supporting tower's face at its top as a share of its foot's */
  taper: 0.3,
};

/** the flasher: share of a cycle lit, s of its LED driver's soft edge (a frame on the edge is no coin toss), cd */
export const BEACON = { duty: 0.5, ramp: 0.12, candela: 2000 };
/** linear sRGB of the red lens (~630 nm, just outside sRGB's red primary), scaled to unit luminance */
const RED: [number, number, number] = [1, 0.045, 0.02].map((c) => c / (0.2126 + 0.7152 * 0.045 + 0.0722 * 0.02)) as [number, number, number];
/** m: the lens's own radius */
const LENS = 0.25;
/** m: what a part the member fit cannot claim (a plate, a dish, the cap) is taken to span, for its fade */
const NON_MEMBER = 0.5;

const smooth = (a: number, b: number, x: number): number => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** a lamp's level 0..1 at time t (s): a pure function of t — the TSL below is its mirror. Dead: 0. */
export function beaconLevel(t: number, lamp: MastLamp): number {
  if (!lamp.alive) return 0;
  const hz = lamp.flashesPerMin / 60;
  const ph = (((t * hz + lamp.phase) % 1) + 1) % 1;
  const r = BEACON.ramp * hz;
  return smooth(0, r, ph) * (1 - smooth(BEACON.duty, BEACON.duty + r, ph));
}

/** the TSL of `beaconLevel`, on `time` */
export function beaconLevelNode(time: F, lamp: MastLamp): F {
  const hz = lamp.flashesPerMin / 60;
  const ph = time.mul(hz).add(lamp.phase).fract();
  const r = BEACON.ramp * hz;
  return smoothstep(0, r, ph).mul(float(1).sub(smoothstep(BEACON.duty, BEACON.duty + r, ph))) as F;
}

/** the core's profile over its drawn radius: flat to half of it, then a soft edge (it fills the pixel it lands in) */
export const coreProfile = (rho: number): number => 1 - smooth(0.5, 1, rho);
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

/** the lamp's light model (all optional; see the header) */
export interface MastLampOptions {
  /** rad: the eye's resolution cell's radius — the core is drawn at the radiance the eye sees in it, never less (absent:
   * the core keeps its own light, energy-conserving) */
  eyeCell?: number;
  /** target px: the core's drawn radius at least (default 1.5) */
  corePx?: number;
  /** a glow: `share` of the light the air scatters out of the beam, drawn `radius` rad about the lamp (absent: none) */
  glow?: { share: number; radius: number };
  /** a factor on the lamp's output (the film's night step) */
  step?: F;
  /** m the point is drawn toward the eye from the lamp, clear of the mast's own solid parts (default 10) */
  out?: number;
  /** a level added to the blink, 0 … ~1.5: the film's answer flare, as a message of the Rose reaches the station
   * (props.ts, roseTraffic.ts; absent: none — the game's lamps only blink) */
  flare?: F;
}

/**
 * The lamp's light at the eye (scene units), CPU mirror of the TSL: `candela` through transmittance `T` from `d` m,
 * `luxPerUnit` lux to the scene's irradiance unit, its core drawn `core` rad in radius and its glow `glow` rad — the
 * core's peak radiance and the glow's.
 */
export function lampLight(candela: number, T: number, d: number, core: number, glow: number, luxPerUnit: number, o: MastLampOptions = {}): { core: number; glow: number } {
  const I = candela / luxPerUnit;
  const E = (I * T) / (d * d);
  const drawn = CORE_AREA * core * core;
  const cell = o.eyeCell !== undefined ? Math.PI * o.eyeCell * o.eyeCell : drawn;
  const scattered = ((o.glow?.share ?? 0) * (1 - T) * I) / (d * d);
  return { core: E / Math.min(cell, drawn), glow: scattered / (GLOW_AREA * glow * glow) };
}

/** a GLTF loader that reads the geometry and none of the materials' textures (KTX2: they would need the renderer) */
function geometryOnly(): GLTFLoader {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  // (the parser asks its plugins for each material before building its own: this one answers with a bare one named as
  // the slot was, so no texture is ever requested)
  loader.register((parser) => ({
    name: 'mast_geometry_only',
    loadMaterial: (i: number) => Promise.resolve(new THREE.MeshBasicMaterial({ name: String(parser.json.materials?.[i]?.name ?? '') })),
  }));
  return loader;
}

const kits = new Map<string, Promise<THREE.Object3D>>();
/** the kit's root (CF_course_radio_tower), geometry only, from its URL (loaded once) or the GLB's own bytes */
export function loadMastKit(source: string | ArrayBuffer): Promise<THREE.Object3D> {
  const load = async (): Promise<THREE.Object3D> => {
    await MeshoptDecoder.ready;
    const loader = geometryOnly();
    const gltf = typeof source === 'string' ? await loader.loadAsync(source) : await loader.parseAsync(source, '');
    const root = gltf.scene.getObjectByName('CF_course_radio_tower') ?? gltf.scene.children[0];
    if (!root) throw new Error('mast: the kit has no CF_course_radio_tower root');
    return root;
  };
  if (typeof source !== 'string') return load();
  let p = kits.get(source);
  if (!p) kits.set(source, (p = load()));
  return p;
}

const extra = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

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

export function kitMast(root: THREE.Object3D): KitMast {
  const ex = (k: string): unknown => extra(root.userData?.[k]);
  const variants = (ex('variants') ?? {}) as Record<string, { lamps?: Array<{ at: [number, number, number]; role: string }> }>;
  const lamp = variants.Beacons?.lamps?.find((l) => l.role === 'aviation')?.at;
  const guys = ex('guys') as KitMast['guys'] | undefined;
  const legs = ex('legAzimuths') as number[] | undefined;
  const tall = Number(ex('heightAboveWater'));
  if (!lamp || !guys?.length || !legs?.length || !Number.isFinite(tall)) throw new Error('mast: the kit lacks its guys, legs, height or beacon (extras)');
  return { heightAboveWater: tall, legAzimuths: legs, guys, lamp };
}

/** where a mast stands: its ground (m) at a point, its axis (x, z), and the point its first leg's guys run toward —
 * all in the frame of the group it will be added to */
export interface MastSite {
  ground: (x: number, z: number) => number;
  at: [number, number];
  toward: [number, number];
}

export interface MastLayout {
  /** the mast's origin (the kit's still-water point on its axis), on the ground */
  foot: [number, number, number];
  /** rad: its turn about y (three.js rotation.y) */
  yaw: number;
  /** the kit's scale across (x, z: at the foot) and up (y) */
  across: number;
  up: number;
  /** each guy's lug on the mast and its end in the slope (none for a self-supporting tower) */
  guys: Array<{ from: [number, number, number]; to: [number, number, number] }>;
  /** the top beacon */
  lamp: [number, number, number];
}

/** m: the lamp over the foot, without the kit (KIT.lampShare; on the axis, whatever the kind) */
export const lampOverFoot = (spec: MastSpec): number => spec.tipM * KIT.lampShare;

/**
 * Where the mast and its guys go: the foot on the ground at `at` (MAST.sink under it), the first leg — and its
 * anchor — turned toward `toward`, so the other two anchors lie on the far side at ±60° off that line and their
 * guys fan out left and right. Pure.
 */
export function layMast(site: MastSite, kit: KitMast, spec: MastSpec): MastLayout {
  const [x0, z0] = site.at;
  const up = spec.tipM / kit.heightAboveWater;
  const across = spec.faceM / KIT.face;
  const foot: [number, number, number] = [x0, site.ground(x0, z0) - MAST.sink, z0];
  const dx = site.toward[0] - x0;
  const dz = site.toward[1] - z0;
  // rotation.y θ takes asset (cos a, sin a) to (cos(a − θ), sin(a − θ)) in x, z: want a0 − θ = atan2(dz, dx)
  const yaw = kit.legAzimuths[0] - Math.atan2(dz, dx);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const taper = (y: number): number => (spec.kind === 'tower' ? 1 - (1 - MAST.taper) * Math.min(1, Math.max(0, (y * up) / spec.tipM)) : 1);
  const world = (p: [number, number, number]): [number, number, number] => {
    const k = across * taper(p[1]);
    const x = p[0] * k;
    const z = p[2] * k;
    return [foot[0] + c * x + s * z, foot[1] + p[1] * up, foot[2] - s * x + c * z];
  };
  const reach = MAST.anchorShare * spec.tipM;
  const guys =
    spec.kind === 'tower'
      ? []
      : kit.guys.map((g) => {
          const a = kit.legAzimuths[g.leg] - yaw;
          const ax = x0 + Math.cos(a) * reach;
          const az = z0 + Math.sin(a) * reach;
          return { from: world(g.at), to: [ax, site.ground(ax, az) - MAST.guySink, az] as [number, number, number] };
        });
  return { foot, yaw, across, up, guys, lamp: world(kit.lamp) };
}

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

/**
 * THE PAINT, decades on: the aviation bands it was painted in (seven, orange and white, foot to tip) chalked and
 * mostly gone, rust where they are gone. Each band keeps its own share of paint (a hash of its index: constant along
 * the band, never noise at a scale the distance cannot draw), its edges soft over a few metres. From kilometres off it
 * is the line's darkness: a mean albedo of ~0.15.
 */
function paintMaterial(foot: number, height: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  const u = positionWorld.y.sub(foot).div(height).clamp(0, 0.9999).mul(7);
  const band = u.floor();
  const f = u.fract();
  // (orange on the even bands, the foot's and the top's; the edge between two blends over ±0.06 of a band)
  const edge = smoothstep(0.94, 1, f).add(smoothstep(0.06, 0, f)).mul(0.5) as F;
  const odd = band.mod(2) as F;
  const whiteness = mix(odd, float(1).sub(odd), edge) as F;
  const paint = mix(vec3(0.36, 0.11, 0.05), vec3(0.42, 0.4, 0.36), whiteness) as V3;
  // (the sin-free hash2 of the band's index, terrain/noise.ts: a GPU fract(sin(·)·43758) is not the same number on
  // Apple's GPUs and NVIDIA's — the farm consistency check, 2026-10-30, tests/gpuSinHash.test.ts)
  const left = (hash2(vec2(band, 7)) as F).mul(0.4).add(0.2) as F;
  m.colorNode = mix(vec3(0.1, 0.052, 0.03), paint, left);
  return m;
}

/** the air a mast is seen through: what it does to a material's output, and the light it lets through to `at` */
export interface MastAir {
  output(material: THREE.NodeMaterial): void;
  transmittance(at: V3): F;
}

export interface MastOptions {
  /** s: the lamp's clock */
  time: THREE.UniformNode<'float', number>;
  air: MastAir;
  /** lux in one unit of the scene's irradiance (the scene's own light scale) */
  luxPerUnit: number;
  /** the kit's level of detail: 1 (default) from afar, 0 for a mast seen at a few hundred metres */
  lod?: 0 | 1;
  lamp?: MastLampOptions;
}

/**
 * The mast `spec` from the kit's `root` on `site`: the lattice, the stack (broadcast), the guys (not a tower) and the
 * lamp (alive) in a new group, in the frame `site` is given in. Returns the group and where everything went.
 */
export function buildMast(root: THREE.Object3D, site: MastSite, spec: MastSpec, o: MastOptions): { group: THREE.Group; layout: MastLayout } {
  const kit = kitMast(root);
  const lay = layMast(site, kit, spec);
  const group = new THREE.Group();
  group.name = `mast-${spec.kind}`;
  const lod = o.lod ?? 1;
  const hazed = <M extends THREE.NodeMaterial>(m: M): M => {
    m.fog = false;
    o.air.output(m);
    return m;
  };

  // THE LATTICE: legs, struts, diagonals, plates, dishes, the whip — scaled (and for a tower, tapered) into the geometry
  // so the member fit and the widening are in true metres (minWidth reads a member's radius as metres)
  const node = root.getObjectByName(`LOD${lod}`)?.getObjectByName(`Mast_LOD${lod}`);
  if (!node) throw new Error(`mast: the kit has no Mast_LOD${lod}`);
  const parts: THREE.BufferGeometry[] = [];
  node.traverse((x) => {
    if ((x as THREE.Mesh).isMesh) parts.push(plain((x as THREE.Mesh).geometry));
  });
  const geo = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!geo) throw new Error('mast: the lattice would not merge');
  geo.applyMatrix4(new THREE.Matrix4().makeScale(lay.across, lay.up, lay.across));
  if (spec.kind === 'tower') {
    // (the face narrows linearly with height: legs stay straight; a diagonal bows by a few cm over its panel)
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const k = 1 - (1 - MAST.taper) * Math.min(1, Math.max(0, pos.getY(i) / spec.tipM));
      pos.setX(i, pos.getX(i) * k);
      pos.setZ(i, pos.getZ(i) * k);
    }
  }
  // (members as thick as a tower's foot's legs are members too: the fit's limit grows with the scale across)
  geo.setAttribute(THIN_AXIS_ATTRIBUTE, new THREE.BufferAttribute(computeThinAxes(geo, { maxRadius: Math.max(0.35, 0.085 * lay.across * 1.6) }), 4));
  geo.computeBoundingSphere();
  const mm = hazed(paintMaterial(lay.foot[1], spec.tipM));
  applyMinWidth(mm, 'blend', THIN_MIN_WIDTH_PX);
  // (a part with no member axis: faded by its own coverage, NON_MEMBER m against the target's pixel)
  const member = attribute(THIN_AXIS_ATTRIBUTE, 'vec4').w.greaterThan(0);
  const worldGeom = modelWorldMatrix.mul(vec4(positionGeometry, 1)).xyz;
  const fade = varying(select(member, float(1), projectedWidthPx(worldGeom, float(NON_MEMBER / 2)).div(THIN_MIN_WIDTH_PX).min(1)));
  mm.opacityNode = (mm.opacityNode as Node).mul(fade);
  mm.transparent = true;
  mm.depthWrite = false;
  mm.name = 'mast-lattice';
  const mast = new THREE.Mesh(geo, mm);
  mast.name = 'mast-lattice';
  mast.position.set(...lay.foot);
  mast.rotation.y = lay.yaw;
  group.add(mast);

  // THE ANTENNA STACK (broadcast): a triangular column round the top section, its corners on the legs', MAST.stack.out
  // past them. Solid: it writes depth and is drawn first, so the members inside it and the guys behind it are hidden.
  // Its axis is the mast's, its half-width its corner radius, so minWidth widens it too under ~1.25 px.
  if (spec.kind === 'broadcast') {
    const R = spec.faceM / Math.sqrt(3) + MAST.stack.out;
    const from = MAST.stack.from * spec.tipM;
    const to = MAST.stack.to * spec.tipM;
    // (three sides; thetaStart puts its corners at the legs' azimuths — three's cylinder puts θ at (sin θ, cos θ))
    const prism = new THREE.CylinderGeometry(R, R, to - from, 3, 1, false, Math.PI / 2 - kit.legAzimuths[0]).toNonIndexed();
    prism.translate(0, (from + to) / 2, 0);
    prism.computeVertexNormals();
    prism.deleteAttribute('uv');
    const pos = prism.getAttribute('position');
    const axes = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) axes.set([pos.getX(i), 0, pos.getZ(i), R], i * 4);
    prism.setAttribute(THIN_AXIS_ATTRIBUTE, new THREE.BufferAttribute(axes, 4));
    prism.computeBoundingSphere();
    const pm = hazed(paintMaterial(lay.foot[1], spec.tipM));
    applyMinWidth(pm, 'blend', THIN_MIN_WIDTH_PX);
    pm.transparent = true;
    pm.depthWrite = true;
    pm.name = 'mast-antennas';
    const stack = new THREE.Mesh(prism, pm);
    stack.name = 'mast-antennas';
    stack.position.set(...lay.foot);
    stack.rotation.y = lay.yaw;
    stack.renderOrder = -1;
    group.add(stack);
  }

  // THE GUYS: catenaries (a parabola's sag) from each lug to its anchor, tubes whose normals are their offsets from the
  // centreline (courseFurniture.ts cableAlong), built about the foot so the float32 positions stay small
  if (lay.guys.length) {
    const tubes: THREE.BufferGeometry[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const r = MAST.guyRadius;
    for (const g of lay.guys) {
      a.set(g.from[0] - lay.foot[0], g.from[1] - lay.foot[1], g.from[2] - lay.foot[2]);
      b.set(g.to[0] - lay.foot[0], g.to[1] - lay.foot[1], g.to[2] - lay.foot[2]);
      const sag = MAST.guySag * a.distanceTo(b);
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
    if (!guyGeo) throw new Error('mast: the guys would not merge');
    guyGeo.computeBoundingSphere();
    // (weathered galvanised strand: dull, a little metallic — in a low Sun a guy can still catch a glint)
    const gm = hazed(new THREE.MeshStandardNodeMaterial({ color: 0x55504a, roughness: 0.6, metalness: 0.6 }));
    applyMinWidth(gm, 'blend', THIN_MIN_WIDTH_PX);
    gm.transparent = true;
    gm.depthWrite = false;
    gm.name = 'mast-guys';
    const wires = new THREE.Mesh(guyGeo, gm);
    wires.name = 'mast-guys';
    wires.position.set(...lay.foot);
    group.add(wires);
  }

  // THE LAMP (alive): a quad placed at the lamp, faced to the eye in world space and drawn toward it by `out`, at least
  // `corePx` target pixels in radius, its core and glow from `lampLight` (CPU mirror), dimmed by the same air
  if (spec.lamp.alive) {
    const L = o.lamp ?? {};
    const lampW = modelPosition as unknown as V3;
    const centre = lampW.add(cameraPosition.sub(lampW).normalize().mul(L.out ?? 10)) as V3;
    const dist = centre.sub(cameraPosition).length();
    // (a target pixel's angle at the view's centre: the same in all six faces of a cube capture, so one size across
    // its seams)
    const pixel = float(2).div(cameraProjectionMatrix.mul(vec4(1, 0, 0, 0)).x.abs().mul(viewport.z));
    const coreAng = dist.mul(pixel).mul(L.corePx ?? 1.5).max(LENS).div(dist) as F;
    const glowAng = (L.glow ? coreAng.mul(2).max(L.glow.radius) : coreAng) as F;
    const corner = attribute<'vec3'>('position', 'vec3');
    const toEye = normalize(cameraPosition.sub(centre));
    const up0 = select(abs(toEye.y).greaterThan(0.98), vec3(1, 0, 0), vec3(0, 1, 0)) as V3;
    const right = normalize(cross(up0, toEye));
    const upv = cross(toEye, right);
    const size = dist.mul(glowAng).mul(2);
    const cornerW = centre.add(right.mul(corner.x.mul(size))).add(upv.mul(corner.y.mul(size)));
    const lm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
    lm.positionNode = modelWorldMatrixInverse.mul(vec4(cornerW, 1)).xyz;
    const level = beaconLevelNode(o.time as unknown as F, spec.lamp);
    const lampDist = lampW.sub(cameraPosition).length();
    const T = o.air.transmittance(lampW);
    const I = BEACON.candela / o.luxPerUnit;
    const vCore = varying(coreAng);
    const vGlow = varying(glowAng);
    const drawn = vCore.mul(vCore).mul(CORE_AREA);
    const coreL = float(I).mul(T).div(lampDist.mul(lampDist)).div(L.eyeCell !== undefined ? drawn.min(Math.PI * L.eyeCell * L.eyeCell) : drawn);
    const across = uv().sub(0.5).mul(2).length();
    const core = float(1).sub(smoothstep(0.5, 1, across.mul(vGlow).div(vCore)));
    let light = coreL.mul(core) as F;
    if (L.glow) {
      const glowL = float(L.glow.share * I).mul(float(1).sub(T)).div(lampDist.mul(lampDist)).div(vGlow.mul(vGlow).mul(GLOW_AREA));
      light = light.add(glowL.mul(float(1).sub(across.mul(across)).max(0).pow(3))) as F;
    }
    lm.colorNode = vec4(vec3(...RED).mul(light.mul(L.flare ? level.add(L.flare) : level).mul(L.step ?? float(1))), 1);
    lm.name = 'mast-beacon';
    const beacon = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lm);
    beacon.name = 'mast-beacon';
    beacon.position.set(...lay.lamp);
    beacon.frustumCulled = false;
    beacon.renderOrder = 1;
    group.add(beacon);
  }

  group.traverse((x) => {
    x.castShadow = false;
    x.receiveShadow = false;
  });
  return { group, layout: lay };
}
