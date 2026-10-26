/**
 * G1's field of galaxies: REAL GALAXIES from the Hubble archive (scripts/drift-galaxy-atlas.py builds the
 * atlas: spirals, bars, edge-on dust lanes, ellipticals, irregulars, interacting pairs), one quad each.
 * Discs (spirals, bars, irregulars) lie in their own plane in space — seen at an angle they foreshorten, a
 * disc seen edge-on thins to a line; the rest (ellipticals, edge-on and interacting frames, already seen at
 * their own angle) face the eye with a roll of their own. Instance 0 is OUR galaxy, shaded with the
 * analytic model (galaxyModel.ts galaxyFace) its volume shares.
 *
 * They open at the knots where Undertime's first stars ignited (grains.ts finalKnots): each grows from a
 * point of light into its disc as `open` rises. Instance 0 is OUR galaxy, whose impostor hands over to the
 * ray-marched volume (milkyWay.ts) as we approach; its parameters are fixed so the two agree.
 *
 * Brightness per unit projected area rises as a disc tilts away (a longer path through a thin glowing
 * sheet), capped so an edge-on galaxy is a bright needle rather than a blown-out line.
 */
import * as THREE from 'three/webgpu';
import { Fn, abs, attribute, cameraPosition, clamp, cos, exp, float, max, min, mix, normalize, sin, smoothstep, step, texture, uv, vec2, vec3, vec4 } from 'three/tsl';
import { galaxyFace } from './galaxyModel';
import { rng } from '../undertime/web';
import type { Vec3 } from '../../cine/domeMaster';

type F = THREE.Node<'float'>;

export interface GalaxySpec {
  centre: Vec3;
  normal: Vec3;
  /** in-plane axis the model's x runs along */
  xAxis: Vec3;
  radius: number;
  arms: number;
  /** 1 / tan(pitch) */
  wind: number;
  phase: number;
  seed: number;
  elliptical: number;
  /** 0..1 order of appearance */
  appear: number;
  brightness: number;
  /** the atlas tile (−1: the analytic model), whether it lies in its plane, its roll (rad) as a billboard */
  tile: number;
  planar: boolean;
  roll: number;
}

export interface GalaxyAtlas {
  texture: THREE.Texture;
  cols: number;
  rows: number;
  galaxies: Array<{ tile: number; kind: string; planar: boolean }>;
  ready: Promise<void>;
}

export function loadGalaxyAtlas(base = `${import.meta.env.BASE_URL}drift/galaxies/`): GalaxyAtlas {
  const texture = new THREE.Texture();
  const atlas: GalaxyAtlas = { texture, cols: 8, rows: 4, galaxies: [], ready: Promise.resolve() };
  atlas.ready = Promise.all([
    new THREE.TextureLoader().loadAsync(base + 'galaxy-atlas.jpg').then((t) => {
      texture.image = t.image;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false; // v = 0 is the atlas's top row
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.anisotropy = 8;
      texture.needsUpdate = true;
    }),
    fetch(base + 'galaxy-atlas.json')
      .then((r) => {
        if (!r.ok) throw new Error(`galaxy atlas: ${r.status} (run scripts/drift-galaxy-atlas.py)`);
        return r.json();
      })
      .then((j: { cols: number; rows: number; galaxies: GalaxyAtlas['galaxies'] }) => {
        atlas.cols = j.cols;
        atlas.rows = j.rows;
        atlas.galaxies = j.galaxies;
      }),
  ]).then(() => undefined);
  return atlas;
}

/** the atlas tiles' brightest part is 1: their light against the analytic model's */
const ATLAS_GAIN = 0.9;

/** OUR galaxy's model parameters (the volume reads the same ones) */
export const OUR_LOOK = { arms: 2, wind: 1 / Math.tan((13 * Math.PI) / 180), phase: 0.6, seed: 3.7, elliptical: 0 };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

function randomUnit(r: () => number): Vec3 {
  const z = r() * 2 - 1;
  const a = r() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(a), z, s * Math.sin(a)];
}

function inPlane(n: Vec3, r: () => number): Vec3 {
  const t = randomUnit(r);
  const d = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
  const x: Vec3 = [t[0] - n[0] * d, t[1] - n[1] * d, t[2] - n[2] * d];
  const l = len(x) || 1;
  return [x[0] / l, x[1] / l, x[2] / l];
}

/**
 * The field: a galaxy at every knot, except where it would sit on our galaxy or across our flight line,
 * and round the knots their members — after the deep fields (references: galaxy-fields-clusters): the
 * sizes are extremely skewed (a handful large, most small smudges), clusters are concentrated (smooth warm
 * ellipticals packed toward the centre), there are galaxies everywhere between. Seeded, so every lane
 * renders the same sky.
 */
export function galaxyField(knots: Array<{ pos: Vec3; level: number }>, ours: GalaxySpec, flight: [Vec3, Vec3], size: number, atlas: GalaxyAtlas['galaxies']): GalaxySpec[] {
  const r = rng(4242);
  const [a, b] = flight;
  const ab = sub(b, a);
  const abl = len(ab);
  const clearOfFlight = (p: Vec3): number => {
    const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / (abl * abl)));
    return len(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
  };
  const gauss = (): number => Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());
  const byKind = (kinds: string[]): number[] => atlas.filter((g) => kinds.includes(g.kind)).map((g) => g.tile);
  const discs = byKind(['spiral', 'barred']);
  const others = byKind(['edge', 'inclined', 'irregular', 'interacting']);
  const ellipticals = byKind(['elliptical']);
  // each tile used in turn from a shuffled deck, so no two neighbours are the same galaxy
  const decks = new Map<number[], number[]>();
  const draw = (pool: number[]): number => {
    if (pool.length === 0) return 0;
    let d = decks.get(pool);
    if (!d || d.length === 0) {
      d = [...pool].sort(() => r() - 0.5);
      decks.set(pool, d);
    }
    return d.pop() as number;
  };
  const out: GalaxySpec[] = [ours];
  const add = (centre: Vec3, radius: number, pool: number[], brightness: number): void => {
    // clear of our galaxy, and of the flight line by a margin (a galaxy passing close is a blur sweeping by)
    if (len(sub(centre, ours.centre)) < ours.radius * 2.2 + radius || clearOfFlight(centre) < radius * 4 + size * 2) return;
    const tile = draw(pool);
    const normal = randomUnit(r);
    out.push({
      centre, normal, xAxis: inPlane(normal, r), radius,
      arms: 2, wind: 1, phase: 0, seed: 0, elliptical: 0,
      appear: r(), brightness,
      tile, planar: atlas.find((g) => g.tile === tile)?.planar ?? false, roll: r() * Math.PI * 2,
    });
  };
  for (const k of knots) {
    // the knot's own galaxy: most modest, a few large (the size distribution of the deep fields)
    const radius = size * (0.35 + 1.3 * Math.pow(r(), 3)) * (k.level > 0 ? 1.5 : 1);
    const roll = r();
    add(k.pos, radius, roll < 0.55 ? discs : roll < 0.8 ? others : ellipticals, 0.7 + r() * 0.5);
    // a few of the knots are clusters (ellipticals packed toward the centre), the rest have a companion or two
    const cluster = r() < 0.15;
    const members = cluster ? 3 + Math.floor(r() * 5) : Math.floor(r() * 1.6);
    for (let m = 0; m < members; m++) {
      const spread = radius * (cluster ? 2.5 : 5);
      const p: Vec3 = [k.pos[0] + gauss() * spread, k.pos[1] + gauss() * spread, k.pos[2] + gauss() * spread];
      add(p, size * (0.08 + 0.3 * Math.pow(r(), 2.5)), cluster && r() < 0.7 ? ellipticals : r() < 0.6 ? discs : others, 0.45 + r() * 0.45);
    }
  }
  return out;
}

export interface GalaxyUniforms {
  open: F;
  /** 0..1 our galaxy's impostor (it hands over to the volume) */
  ours: F;
  /** 0..1 the rest of the field */
  field: F;
  radiance: F;
  pixelAngle: F;
  /** the sky's turn about the eye (world from sky) */
  skyTurn: THREE.Node<'mat3'>;
}

export function createGalaxies(specs: GalaxySpec[], U: GalaxyUniforms, atlas: GalaxyAtlas): THREE.InstancedMesh {
  const n = specs.length;
  const centre = new Float32Array(n * 4);
  const normal = new Float32Array(n * 4);
  const xAxis = new Float32Array(n * 4);
  const look = new Float32Array(n * 4);
  const tiles = new Float32Array(n * 4);
  specs.forEach((s, i) => {
    centre.set([...s.centre, s.radius], i * 4);
    normal.set([...s.normal, s.appear], i * 4);
    xAxis.set([...s.xAxis, s.brightness], i * 4);
    look.set([s.arms, s.wind, s.phase, s.seed + s.elliptical * 1000], i * 4);
    tiles.set([i, s.tile, s.planar ? 1 : 0, s.roll], i * 4);
  });
  const C4 = attribute<'vec4'>('galaxyCentre', 'vec4');
  const N4 = attribute<'vec4'>('galaxyNormal', 'vec4');
  const X4 = attribute<'vec4'>('galaxyX', 'vec4');
  const L4 = attribute<'vec4'>('galaxyLook', 'vec4');
  const T4 = attribute<'vec4'>('galaxyTile', 'vec4');
  const isOurs = step(T4.x, 0.5);
  const elliptical = step(999, L4.w);
  const seed = L4.w.sub(elliptical.mul(1000));
  // turned with the sky about the eye
  const centreW = cameraPosition.add(U.skyTurn.mul(C4.xyz.sub(cameraPosition)));
  const N = normalize(U.skyTurn.mul(N4.xyz));
  const X = normalize(U.skyTurn.mul(X4.xyz));
  const Y = N.cross(X);
  const atlasTile = T4.y;
  const planar = max(T4.z, isOurs);
  // a billboard's basis: facing the eye, turned by the galaxy's own roll
  const toEye = normalize(cameraPosition.sub(centreW));
  const side0 = normalize(toEye.cross(abs(toEye.y).lessThan(0.95).select(vec3(0, 1, 0), vec3(1, 0, 0))));
  const up0 = side0.cross(toEye);
  const BX = side0.mul(cos(T4.w)).add(up0.mul(sin(T4.w)));
  const BY = up0.mul(cos(T4.w)).sub(side0.mul(sin(T4.w)));
  const QX = mix(BX, X, planar);
  const QY = mix(BY, Y, planar);
  // open from a point of light: the galaxy grows into its shape in its own moment, with a brief flash as it
  // catches (a light pop, not a sprite appearing)
  const appear = N4.w.mul(0.6);
  const grow = mix(smoothstep(appear, appear.add(0.4), U.open), float(1), isOurs);
  const pop = exp(U.open.sub(appear.add(0.06)).div(0.05).pow(2).negate()).mul(float(1).sub(isOurs));
  const R = C4.w.mul(grow.mul(0.95).add(0.05));
  const corner = attribute<'vec3'>('position', 'vec3');
  const EXTENT = 1.5; // the quad spans ±1.5 radii (the outer disk fades by then)
  const pos = centreW.add(QX.mul(corner.x.mul(2 * EXTENT).mul(R))).add(QY.mul(corner.y.mul(2 * EXTENT).mul(R)));
  const cosI = abs(toEye.dot(N));
  // a disc seen at a slant packs its light into less area (capped: edge-on is a bright needle, not a line)
  const gain = mix(float(1), min(float(1).div(max(cosI, 0.15)), 3), planar);
  const present = mix(U.field, U.ours, isOurs).mul(grow);
  // a galaxy narrower than a few pixels is a point of light: keep it from vanishing between pixels
  const dist = cameraPosition.sub(centreW).length();
  const tiny = clamp(R.div(dist.mul(U.pixelAngle).mul(3)), 0, 1);

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.positionNode = pos;
  material.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2 * EXTENT);
    const face = galaxyFace(vec2(q.x, q.y), { arms: L4.x, wind: L4.y, phase: L4.z, seed, elliptical });
    const edge = float(1).sub(smoothstep(1.1, EXTENT, q.length()));
    const model = face.light.mul(exp(face.tau.negate())).mul(edge);
    // the atlas: tile (col, row), v = 0 at its top row
    const col = atlasTile.sub(atlasTile.div(atlas.cols).floor().mul(atlas.cols));
    const row = atlasTile.div(atlas.cols).floor();
    const st = vec2(col.add(uv().x).div(atlas.cols), row.add(float(1).sub(uv().y)).div(atlas.rows));
    const real = texture(atlas.texture, st).rgb.mul(ATLAS_GAIN);
    const r = uv().sub(0.5).mul(2).length();
    const flash = vec3(0.85, 0.9, 1).mul(exp(r.div(0.12).pow(2).negate()).mul(pop).mul(6));
    const light = mix(real, model, isOurs).mul(gain).mul(X4.w);
    return vec4(light.mul(present).add(flash.mul(mix(U.field, float(0), isOurs))).mul(U.radiance).mul(tiny.mul(0.7).add(0.3)), 1);
  })();
  material.name = 'drift-galaxies';

  const geometry = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, n);
  geometry.setAttribute('galaxyCentre', new THREE.InstancedBufferAttribute(centre, 4));
  geometry.setAttribute('galaxyNormal', new THREE.InstancedBufferAttribute(normal, 4));
  geometry.setAttribute('galaxyX', new THREE.InstancedBufferAttribute(xAxis, 4));
  geometry.setAttribute('galaxyLook', new THREE.InstancedBufferAttribute(look, 4));
  geometry.setAttribute('galaxyTile', new THREE.InstancedBufferAttribute(tiles, 4));
  // the plane's normals are never read (and WebGPU allows 8 vertex buffers)
  geometry.deleteAttribute('normal');
  mesh.frustumCulled = false;
  mesh.name = 'drift-galaxies';
  return mesh;
}
