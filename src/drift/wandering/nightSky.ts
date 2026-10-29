/**
 * The night sky over the sea: Act 2's own galaxy (milkyWay.ts — the ray-marched disk and the stars near the
 * Sun) as seen from the Sun's position. The galaxy does not change between the end of Act 2 and the sea, so
 * all of it is fixed when the act is built and every frame stays a pure function of time; the sky over the
 * sea draws it behind the air (seaSky.ts), dimmed by the air along each ray and swamped by the day sky until
 * the light falls.
 *
 * TWO HALVES, BECAUSE A POINT CANNOT BE BAKED. The glow (the volume) is smooth and baked once into a cube
 * texture. The stars were baked with it, and a baked star is as wide as the bake drew it: 0.1° (milkyWay.ts
 * STAR_SIGMA), ~1 px of the 1024 preview it was set at, but a 4–5 px smudge on an 8K master — and a larger
 * bake only sharpens the texels, not the 0.1° the stars were drawn at. So the bake holds the glow alone, and
 * the SAME stars (milkyWay.ts `localStars`, their flux and colour as the bake drew them) go into a STAR MAP
 * the sky reads per pixel (`stars`): each drawn as wide as the pixel it lands on, its light kept, so a star
 * is one sharp point at every resolution and the sky holds the same stars it always did.
 *
 * THE STAR MAP is a cube of cells (CELLS per face edge, equi-angular so the cells are near-equal in angle,
 * ~0.35°), each holding the LAYERS brightest stars whose direction falls in it: where in the cell (0..1 on
 * each axis), the peak radiance it was baked at, and its colour rank. A pixel reads the 3 × 3 cells around
 * its own — a star's drawn width is under a cell, so nothing reaches further — and, in a cell at a face's
 * edge, the cells just over it on the next face, read in that face's own grid (a neighbour carried over an
 * edge lands a fraction of a cell askew, and could read one cell twice or miss one: a star doubled or lost
 * along every cube edge).
 *
 * Its orientation is chosen for the dome, not computed from a date: the galactic centre GC_AZ / GC_EL from
 * the dome's front, the band arching through it and near the dome's zenith.
 */
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, abs, atan, exp, float, floor, int, ivec2, normalize, select, tan, textureLoad, vec2, vec3 } from 'three/tsl';
import { getTheDriftParams } from '../../params/getTheDrift';
import { driftParams } from '../../params/drift';
import { ourGalaxy } from '../getTheDrift/timeline';
import { STAR_PEAK, STAR_SIGMA, createMilkyWay, localStarFlux, localStars, starTemp, starTint } from '../getTheDrift/milkyWay';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

/** deg: the galactic centre's bearing from the dome's front (+ right) and its elevation */
const GC_AZ = -35;
const GC_EL = 30;

/** the star map: cells per cube-face edge, and the stars kept per cell (the brightest two: the stars past them,
 * where the band crowds them, carry ~0.6% of the light, all but one of them too faint to show) */
const CELLS = 256;
const LAYERS = 2;

export interface NightSky {
  /** the galaxy's glow (the volume, no stars), in the bake's (galaxy) frame */
  readonly texture: THREE.CubeTexture;
  /** sea-world direction → the bake's (galaxy) direction */
  readonly toGalaxy: THREE.Matrix3;
  /**
   * The stars near the Sun toward `dir` (unit, the bake's frame): each round and `sigma` rad wide
   * (exp(−θ²/σ²), as milkyWay.ts draws them, σ ≤ STAR_SIGMA — a cell holds no wider), its light the bake's
   * whatever the width: the peak × (STAR_SIGMA / σ)².
   */
  stars(dir: V3, sigma: F): V3;
}

/** a unit direction's cube face (0..5: +x −x +y −y +z −z) and its plain (gnomonic) coordinates on it, the two
 * axes across the face in order (x: y, z; y: x, z; z: x, y) */
function faceOf(d: THREE.Vector3): [number, number, number] {
  const ax = Math.abs(d.x);
  const ay = Math.abs(d.y);
  const az = Math.abs(d.z);
  if (ax >= ay && ax >= az) return [d.x > 0 ? 0 : 1, d.y / ax, d.z / ax];
  if (ay >= az) return [d.y > 0 ? 2 : 3, d.x / ay, d.z / ay];
  return [d.z > 0 ? 4 : 5, d.x / az, d.y / az];
}

/** the stars seen from the Sun into the map: per cell and layer (x across, faces stacked down), rgba = where
 * in the cell (0..1, 0..1), peak radiance at STAR_SIGMA, colour rank */
function starMap(g: ReturnType<typeof ourGalaxy>): THREE.DataTexture {
  const local = localStars(g);
  const count = local.length / 4;
  const W = CELLS * LAYERS;
  const cell = new Float32Array(CELLS * CELLS * 6 * LAYERS * 4);
  const d = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    d.set(local[i * 4] - g.sun[0], local[i * 4 + 1] - g.sun[1], local[i * 4 + 2] - g.sun[2]);
    const peak = localStarFlux(local[i * 4 + 3], d.length(), g.radius) * STAR_PEAK;
    const [face, u, v] = faceOf(d.normalize());
    const x = ((Math.atan(u) * 4) / Math.PI + 1) * (CELLS / 2);
    const y = ((Math.atan(v) * 4) / Math.PI + 1) * (CELLS / 2);
    const cx = Math.min(CELLS - 1, Math.floor(x));
    const cy = Math.min(CELLS - 1, Math.floor(y));
    const star = [x - cx, y - cy, peak, starTemp(i)];
    // the layers hold the cell's brightest, brightest first
    const at = ((face * CELLS + cy) * W + cx * LAYERS) * 4;
    for (let l = 0; l < LAYERS; l++) {
      const o = at + l * 4;
      if (peak <= cell[o + 2]) continue;
      cell.copyWithin(o + 4, o, at + (LAYERS - 1) * 4);
      cell.set(star, o);
      break;
    }
  }
  const half = new Uint16Array(cell.length);
  for (let k = 0; k < cell.length; k++) half[k] = THREE.DataUtils.toHalfFloat(cell[k]);
  const tex = new THREE.DataTexture(half, W, CELLS * 6, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.name = 'drift-night-stars';
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Render the galaxy's glow from the Sun into a cube (size² per face), and map its stars. `front` and `up` are
 * the sea world's dome front and up (unit): the frame the galactic centre is placed in.
 */
export function bakeNightSky(renderer: THREE.WebGPURenderer, front: THREE.Vector3, up: THREE.Vector3, size = 1536): NightSky {
  const p = getTheDriftParams;
  const g = ourGalaxy(p, [0, 0, 0], driftParams.domeTilt);
  const milky = createMilkyWay(g, p.marchSteps);
  const sun = new THREE.Vector3(...g.sun);
  milky.update({
    volume: 1,
    // the stars are drawn per pixel from the star map, not baked
    local: 0,
    sunStar: 0,
    radiance: p.volumeRadiance,
    pixelAngle: Math.PI / 2 / size,
    eye: sun,
    occluder: { centre: new THREE.Vector3(), radius: 0 },
    skyTurn: new THREE.Matrix3(),
  });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.add(milky.group);
  const target = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType });
  const camera = new THREE.CubeCamera(1e-7, 1e4, target);
  camera.position.copy(sun);
  scene.add(camera);
  const autoClear = renderer.autoClear;
  renderer.autoClear = true;
  camera.update(renderer, scene);
  renderer.autoClear = autoClear;
  milky.dispose();

  // the galaxy's frame (toward its centre, its pole) placed in the sea's: the centre at GC_AZ / GC_EL, the pole
  // square to it and to the dome's zenith side, so the band runs through the centre and arches overhead
  const gc = new THREE.Vector3(...g.centre).sub(sun).normalize();
  const pole = new THREE.Vector3(...g.normal);
  gc.addScaledVector(pole, -gc.dot(pole)).normalize();
  const right = new THREE.Vector3().crossVectors(front, up).normalize();
  const az = (GC_AZ * Math.PI) / 180;
  const el = (GC_EL * Math.PI) / 180;
  const gcSea = front.clone().multiplyScalar(Math.cos(az) * Math.cos(el)).addScaledVector(right, Math.sin(az) * Math.cos(el)).addScaledVector(up, Math.sin(el));
  const poleSea = new THREE.Vector3().crossVectors(gcSea, up).normalize();
  // the sea's basis (centre, pole, centre × pole) onto the galaxy's: G · Sᵀ (columns are the basis vectors)
  const s3 = new THREE.Vector3().crossVectors(gcSea, poleSea);
  const g3 = new THREE.Vector3().crossVectors(gc, pole);
  const S = new THREE.Matrix3().set(gcSea.x, poleSea.x, s3.x, gcSea.y, poleSea.y, s3.y, gcSea.z, poleSea.z, s3.z);
  const G = new THREE.Matrix3().set(gc.x, pole.x, g3.x, gc.y, pole.y, g3.y, gc.z, pole.z, g3.z);
  const toGalaxy = G.multiply(S.transpose());

  // ------------------------------------------------------------------ the stars, per pixel
  const map = starMap(g);
  // a face (0..5, as faceOf) as its axis (0 x, 1 y, 2 z) and the sign of its normal
  const axisOf = (face: F): F => floor(face.mul(0.5));
  const signOf = (face: F): F => float(1).sub(face.sub(axisOf(face).mul(2)).mul(2));
  const pick = (axis: F, v: V3): F => select(axis.equal(0), v.x, select(axis.equal(1), v.y, v.z));
  /** d's equi-angular coordinates (−1..1 on the face) on the plane of `face`, which d need only lean toward */
  const coordsOn = (face: F, d: V3): V2 => {
    const axis = axisOf(face);
    const n = pick(axis, d).mul(signOf(face));
    const a = select(axis.equal(0), d.y, d.x);
    const b = select(axis.equal(2), d.y, d.z);
    return vec2(atan(a.div(n)), atan(b.div(n))).mul(4 / Math.PI);
  };
  /** the unit direction at equi-angular coordinates `c` on `face` (coordsOn's inverse) */
  const dirOn = (face: F, c: V2): V3 => {
    const axis = axisOf(face);
    const s = signOf(face);
    const t = tan(c.mul(Math.PI / 4));
    return normalize(select(axis.equal(0), vec3(s, t.x, t.y), select(axis.equal(1), vec3(t.x, s, t.y), vec3(t.x, t.y, s)))) as V3;
  };
  const cellOn = (face: F, d: V3): V2 => floor(coordsOn(face, d).add(1).mul(CELLS / 2)).clamp(0, CELLS - 1);
  const stars = Fn(([dir, width]: [V3, F]) => {
    // (held in vars up here: an expression first built inside one of the loops below is cached in a variable
    // assigned only there, and read from it everywhere after — the width read 0 outside the cells at a face's
    // edge, and the whole night went black but for lines along the cube's edges)
    const d = dir.toVar();
    const sigma = width.toVar();
    const k = float(1).div(sigma.mul(sigma)).toVar();
    const light = vec3(0).toVar();
    // the 3 × 3 cells of `face` around d's (d's own face, or the next one over an edge it lies at)
    const gather = (face: F): void => {
      const centre = cellOn(face, d);
      Loop({ start: -1, end: 2, type: 'int' }, { start: -1, end: 2, type: 'int' }, ({ i, j }) => {
        const c = centre.add(vec2(float(i), float(j)));
        If(c.x.greaterThanEqual(0).and(c.y.greaterThanEqual(0)).and(c.x.lessThan(CELLS)).and(c.y.lessThan(CELLS)), () => {
          for (let l = 0; l < LAYERS; l++) {
            const s = textureLoad(map, ivec2(int(c.x).mul(LAYERS).add(l), int(face.mul(CELLS).add(c.y))));
            const r = d.sub(dirOn(face, c.add(s.xy).mul(2 / CELLS).sub(1)));
            light.addAssign(starTint(s.w).mul(s.z).mul(exp(r.dot(r).mul(k).negate())));
          }
        });
      });
    };
    const a = abs(d);
    const onX = a.x.greaterThanEqual(a.y).and(a.x.greaterThanEqual(a.z));
    const onY = onX.not().and(a.y.greaterThanEqual(a.z));
    const axis = select(onX, float(0), select(onY, float(1), float(2)));
    const face = axis.mul(2).add(select(pick(axis, d).greaterThan(0), float(0), float(1))).toVar();
    gather(face);
    // at a face's edge, the stars just over it: the next face, the one d leans toward along that axis
    const own = cellOn(face, d);
    const across = (other: F): F => other.mul(2).add(select(pick(other, d).greaterThan(0), float(0), float(1)));
    If(own.x.equal(0).or(own.x.equal(CELLS - 1)), () => {
      gather(across(select(axis.equal(0), float(1), float(0))).toVar());
    });
    If(own.y.equal(0).or(own.y.equal(CELLS - 1)), () => {
      gather(across(select(axis.equal(2), float(1), float(2))).toVar());
    });
    return light.mul(float(STAR_SIGMA).div(sigma).pow(2));
  });
  return { texture: target.texture as THREE.CubeTexture, toGalaxy, stars: (dir, sigma) => stars(dir, sigma) as unknown as V3 };
}
