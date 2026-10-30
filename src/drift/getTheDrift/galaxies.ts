/**
 * G1's field of galaxies: REAL GALAXIES from the Hubble archive (scripts/drift-galaxy-atlas.py builds the
 * atlas: spirals, bars, edge-on dust lanes, ellipticals, irregulars, interacting pairs), one quad each.
 * Discs (spirals, bars, irregulars) lie in their own plane in space — seen at an angle they foreshorten, a
 * disc seen edge-on thins to a line; the rest (ellipticals, edge-on and interacting frames, already seen at
 * their own angle) face the eye with a roll of their own. Instance 0 is OUR galaxy, shaded with the
 * analytic model (galaxyModel.ts galaxyFace) its volume shares.
 *
 * They open at the knots where Undertime's first stars ignited, laid in the web where the dive into it passes
 * (webGalaxies.ts; the 2026-10-30 dive, webDive.ts): each grows from a point of light into its disc. Instance 0
 * is OUR galaxy, whose impostor hands over to the ray-marched volume (milkyWay.ts) as we approach; its parameters
 * are fixed so the two agree.
 *
 * Brightness per unit projected area rises as a disc tilts away (a longer path through a thin glowing
 * sheet), capped so an edge-on galaxy is a bright needle rather than a blown-out line.
 */
import * as THREE from 'three/webgpu';
import { Fn, abs, attribute, cameraPosition, clamp, cos, exp, float, max, min, mix, normalize, sin, smoothstep, step, texture, uv, vec2, vec3, vec4 } from 'three/tsl';
import { galaxyFace } from './galaxyModel';
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
  /** 0..1 how bright its birth flare is (default 1): the knots' first galaxies flare, the hundreds strung along the
   * dive's filament open without one (webGalaxies.ts). Ours always flares */
  flare?: number;
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
/** the galaxy quad spans ±EXTENT radii (the outer disk fades by then) */
const EXTENT = 1.5;
/** BIRTHS: s into the act the first galaxy is born, and the s they are spread over (by `appear`) */
const BIRTH_START = 0.2;
const BIRTH_SPAN = 7;
/** s a birth's flare rises over, the s it falls by 1/e in, the s the galaxy unfolds over from its peak */
const FLARE_RISE = 0.3;
const FLARE_FALL = 0.55;
const GROW = 2.6;
/** rad, the furthest a photographed disc tilts from facing the eye */
const TILT_MAX = (55 * Math.PI) / 180;

/** OUR galaxy's model parameters (the volume reads the same ones) */
export const OUR_LOOK = { arms: 2, wind: 1 / Math.tan((13 * Math.PI) / 180), phase: 0.6, seed: 3.7, elliptical: 0 };

export interface GalaxyUniforms {
  /** s, the act's own time */
  time: F;
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
    // (an atlas galaxy has no use for the model's arm phase: its slot carries the birth flare's strength)
    look.set([s.arms, s.wind, s.tile < 0 ? s.phase : (s.flare ?? 1), s.seed + s.elliptical * 1000], i * 4);
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
  const toEye = normalize(cameraPosition.sub(centreW));
  const N0 = normalize(U.skyTurn.mul(N4.xyz));
  // a PHOTO on a plane: tilted far, a face-on photo flattens into a bulgeless sliver (a real edge-on galaxy
  // keeps its bulge, and the atlas has those as their own photos), so a disc tilts at most TILT_MAX — past
  // it, its normal turns toward the eye just enough. Our galaxy is the model, and keeps its true plane
  const d = toEye.dot(N0);
  const turned = normalize(N0.sub(toEye.mul(d)).add(vec3(1e-6, 0, 0))).mul(Math.sin(TILT_MAX)).add(toEye.mul(d.greaterThanEqual(0).select(Math.cos(TILT_MAX), -Math.cos(TILT_MAX))));
  const N = abs(d).lessThan(Math.cos(TILT_MAX)).and(isOurs.lessThan(0.5)).select(turned, N0);
  const X0 = normalize(U.skyTurn.mul(X4.xyz));
  const X = normalize(X0.sub(N.mul(X0.dot(N))));
  const Y = N.cross(X);
  // ROUNDED: the instance's tile reaches the fragment stage as an interpolated varying, and three equal corner
  // values come out a few ulp either side of themselves (8 as 7.9999995 in about half the pixels), so the
  // floor(tile / cols) below flipped from pixel to pixel on the tiles that are multiples of the atlas's 8 columns
  // (8, 16, 24): neighbours looked a whole row apart, the sampler's derivatives took the atlas's last mip, and those
  // galaxies drew as grey cards full of black specks — grey where a 2×2 pixel quad straddled the flip, the tile's
  // black sky where all four agreed (the 2026-10-30 QA sweep, item 3b: "big grey speckled rectangles" in the dome at
  // 85–97 s, the same on all three farm boxes). Pinned at run time: every tile moved a quarter off the integer took
  // every card out; every tile set to 8 made every galaxy one. (The flare's tint, `tileC` below, reads it too.)
  const atlasTile = T4.y.round();
  const planar = max(T4.z, isOurs);
  // a billboard's basis: facing the eye, turned by the galaxy's own roll
  const side0 = normalize(toEye.cross(abs(toEye.y).lessThan(0.95).select(vec3(0, 1, 0), vec3(1, 0, 0))));
  const up0 = side0.cross(toEye);
  const BX = side0.mul(cos(T4.w)).add(up0.mul(sin(T4.w)));
  const BY = up0.mul(cos(T4.w)).sub(side0.mul(sin(T4.w)));
  const QX = mix(BX, X, planar);
  const QY = mix(BY, Y, planar);
  // BIRTH (the first stars at the web's knots becoming galaxies): a flare rises at the knot, sized to the
  // galaxy it will become, and falls; from its peak the galaxy unfolds out of it at its full surface
  // brightness (its light rises with its area, from nothing). In seconds, so every birth has one rhythm.
  // (ours is born with the field, a moment after the first few)
  const since = U.time.sub(N4.w.mul(BIRTH_SPAN).add(BIRTH_START));
  const size = smoothstep(0, GROW, since);
  const lit = smoothstep(-0.1, 0.4, since);
  const flare = smoothstep(-FLARE_RISE, 0, since).mul(exp(since.max(0).div(FLARE_FALL).negate()));
  const R = C4.w.mul(size).max(C4.w.mul(0.002));
  const dist = cameraPosition.sub(centreW).length();
  const half = R.mul(EXTENT);
  const corner = attribute<'vec3'>('position', 'vec3');
  const pos = centreW.add(QX.mul(corner.x.mul(2).mul(half))).add(QY.mul(corner.y.mul(2).mul(half)));
  const cosI = abs(toEye.dot(N));
  // a disc seen at a slant packs its light into less area (ours: capped, edge-on is a bright needle)
  const gain = mix(float(1), min(float(1).div(max(cosI, 0.15)), 3), planar);
  const present = mix(U.field, U.ours, isOurs).mul(lit);
  // a galaxy narrower than a few pixels is a point of light: keep it from vanishing between pixels
  const tiny = clamp(R.div(dist.mul(U.pixelAngle).mul(3)), 0, 1);

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.positionNode = pos;
  material.colorNode = Fn(() => {
    // the galaxy's own coordinates: ±EXTENT radii across
    const g = uv();
    const q = g.sub(0.5).mul(2 * EXTENT);
    const face = galaxyFace(vec2(q.x, q.y), { arms: L4.x, wind: L4.y, phase: L4.z, seed, elliptical });
    const edge = float(1).sub(smoothstep(1.1, EXTENT, q.length()));
    const model = face.light.mul(exp(face.tau.negate())).mul(edge);
    // the atlas: tile (col, row), v = 0 at its top row
    const col = atlasTile.sub(atlasTile.div(atlas.cols).floor().mul(atlas.cols));
    const row = atlasTile.div(atlas.cols).floor();
    const st = vec2(col.add(g.x.clamp(0, 1)).div(atlas.cols), row.add(float(1).sub(g.y.clamp(0, 1))).div(atlas.rows));
    const real = texture(atlas.texture, st).rgb.mul(ATLAS_GAIN);
    const light = mix(real, model, isOurs).mul(gain).mul(X4.w);
    return vec4(light.mul(present).mul(tiny.mul(0.7).add(0.3)).mul(U.radiance), 1);
  })();
  material.name = 'drift-galaxies';

  // the flare: its own quad facing the eye (in the galaxy's plane, a disc seen near edge-on squashed it to a
  // sliver), its radius from the galaxy's final angular size (0.7°–5°), swelling as it rises and drawing in
  // as it falls; empty when not flaring
  const flareR = C4.w.div(dist).mul(1.3).clamp(0.012, 0.09);
  const swell = mix(0.5, 1, smoothstep(-FLARE_RISE, 0, since)).mul(mix(1, 0.65, smoothstep(0, FLARE_FALL * 3, since)));
  const flashHalf = dist.mul(flareR).mul(swell).mul(2).mul(step(0.002, flare.mul(mix(L4.z, 1, isOurs))));
  // its colour: the galaxy's own (the tile's mean, from the atlas's last mips), hot white at the core
  const tileC = vec2(atlasTile.sub(atlasTile.div(atlas.cols).floor().mul(atlas.cols)).add(0.5).div(atlas.cols), atlasTile.div(atlas.cols).floor().add(0.5).div(atlas.rows));
  const mean = mix(texture(atlas.texture, tileC).level(float(9)).rgb, vec3(0.9, 0.85, 0.75), isOurs);
  const tint = mean.div(max(mean.dot(vec3(0.2126, 0.7152, 0.0722)), 1e-3)).clamp(0, 2);
  const flashMaterial = new THREE.NodeMaterial();
  flashMaterial.transparent = true;
  flashMaterial.depthWrite = false;
  flashMaterial.side = THREE.DoubleSide;
  flashMaterial.blending = THREE.AdditiveBlending;
  flashMaterial.positionNode = centreW.add(side0.mul(corner.x.mul(2).mul(flashHalf))).add(up0.mul(corner.y.mul(2).mul(flashHalf)));
  flashMaterial.colorNode = Fn(() => {
    // in flare radii (the quad spans ±2)
    const rho = uv().sub(0.5).mul(4).length();
    const core = exp(rho.div(0.1).pow(2).negate()).mul(5);
    const halo = exp(rho.div(0.45).pow(2).negate()).mul(0.9).add(exp(rho.div(1.1).pow(2).negate()).mul(0.12));
    const c = vec3(0.85, 0.9, 1).mul(core).add(mix(vec3(0.85, 0.9, 1), tint, 0.6).mul(halo));
    return vec4(c.mul(flare).mul(mix(L4.z, 1, isOurs)).mul(X4.w).mul(mix(U.field, U.ours, isOurs)).mul(U.radiance), 1);
  })();
  flashMaterial.name = 'drift-galaxy-flashes';

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
  const flashes = new THREE.InstancedMesh(geometry, flashMaterial, n);
  flashes.frustumCulled = false;
  flashes.name = 'drift-galaxy-flashes';
  mesh.add(flashes);
  return mesh;
}
