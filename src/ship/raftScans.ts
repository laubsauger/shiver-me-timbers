/**
 * THE RAFT'S SCANNED SURFACES — CC0 photo-scans (Poly Haven) under the raft families' procedural structure.
 *
 * The user, of the procedural balsa after §T147: "the raft wood is still pretty shitty". The families keep
 * everything that is structure — the seeded per-piece tone, the metre-scale stains, end checks, rope grooves,
 * weed, the wet band, the chink crevices, the thatch's down-slope frame — and take what a procedural fbm cannot
 * give from a scan: the grain, its colour, its roughness and its relief. Packed by scripts/raft-scan-pack.py into
 * public/textures/raft/ (two RGBA maps a scan, the beach's layout):
 *
 *   <scan>_albedo_rough   RGB colour (sRGB), A roughness
 *   <scan>_normal_ao_h    RG normal x, y (unused: the families' relief is a height), B ambient occlusion, A height
 *
 * §V40: TWO bindings a family (each map is one texture and one sampler however many projections read it), on top
 * of the ship-wide six — 8 of the deck family's 9 (tests/raftMaterials.test.ts). §V48: the maps are mipmapped and
 * sampled with the pixel's own footprint, so the grain fades to its mean at range instead of aliasing; the
 * families' own band limits stay on their procedural terms.
 *
 * Sampled TRI-PLANAR in piece-local metres, each plane oriented so the scan's grain (its texture v) runs along
 * the member: a scan has a direction, a log's grain does not run round it.
 */
import * as THREE from 'three/webgpu';
import { abs, float, mix, pow, texture, vec2, vec3 } from 'three/tsl';
import { RAFT_SCAN_META as scanMeta } from './raftScanMeta';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
type AnyNode = any;
type Axis = 'x' | 'y' | 'z';

export type RaftScanName = keyof typeof scanMeta;

export interface RaftScan {
  readonly albedoRough: THREE.Texture;
  readonly normalAoH: THREE.Texture;
  /** m on the ground one tile of the scan covers */
  readonly metres: number;
  /** its mean colour (linear) and roughness: what a family divides out to put the scan on its own palette */
  readonly mean: THREE.Color;
  readonly roughMean: number;
}

const cache = new Map<RaftScanName, RaftScan>();

function map(file: string, srgb: boolean): THREE.Texture {
  const t = new THREE.Texture();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.name = file;
  // (a browser loads it; a node test builds the material against the empty texture)
  if (typeof Image !== 'undefined') {
    const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    new THREE.ImageLoader().load(`${base}textures/raft/${file}`, (img) => {
      t.image = img;
      t.needsUpdate = true;
    });
  }
  return t;
}

/** one shared pair of maps per scan, for every material that uses it */
export function raftScan(name: RaftScanName): RaftScan {
  let s = cache.get(name);
  if (!s) {
    const m = scanMeta[name];
    s = {
      albedoRough: map(`${name}_albedo_rough.webp`, true),
      normalAoH: map(`${name}_normal_ao_h.webp`, false),
      metres: m.metres,
      mean: new THREE.Color(m.mean[0], m.mean[1], m.mean[2]),
      roughMean: m.roughMean,
    };
    cache.set(name, s);
  }
  return s;
}

export interface ScanSample {
  /** linear colour, as scanned */
  albedo: AnyNode;
  rough: AnyNode;
  ao: AnyNode;
  /** 0..1, 0.5 the mean plane */
  height: AnyNode;
}

/**
 * The scan on a piece, tri-planar in `pos` (piece-local metres) weighted by `normal`, the grain (texture v)
 * along `along`; `offset` slides the sample per piece (no two alike), `tile` scales the scan's own size.
 */
export function sampleRaftScan(scan: RaftScan, pos: AnyNode, normal: AnyNode, along: Axis, offset: AnyNode, tile: AnyNode = float(1)): ScanSample {
  const p = pos.add(offset).div(tile.mul(scan.metres));
  const a = abs(normal);
  const w0 = pow(a, vec3(4));
  const w = w0.div(w0.x.add(w0.y).add(w0.z).max(1e-5));
  // each plane's (u, v), v along the member wherever the plane contains it
  const uvFor = (n: Axis): AnyNode => {
    const inPlane = (['x', 'y', 'z'] as Axis[]).filter((x) => x !== n);
    if (inPlane.includes(along)) {
      const across = inPlane.find((x) => x !== along)!;
      return vec2(p[across], p[along]);
    }
    return vec2(p[inPlane[0]], p[inPlane[1]]);
  };
  const uvx = uvFor('x');
  const uvy = uvFor('y');
  const uvz = uvFor('z');
  const tri = (t: THREE.Texture): AnyNode =>
    texture(t, uvx).mul(w.x).add(texture(t, uvy).mul(w.y)).add(texture(t, uvz).mul(w.z));
  const c = tri(scan.albedoRough);
  const r = tri(scan.normalAoH);
  return { albedo: c.rgb, rough: c.a, ao: r.b, height: r.a };
}

/**
 * The same, with the grain along whichever of the piece's local axes is longest (its bounds, `aabbMin`/`aabbMax`
 * from raftMaterialNodes): for a family whose pieces run in different directions (a guara stands up, a
 * splashboard runs across the bow).
 */
export function sampleRaftScanAlongLongest(scan: RaftScan, pos: AnyNode, normal: AnyNode, aabbMin: AnyNode, aabbMax: AnyNode, offset: AnyNode, tile: AnyNode = float(1)): ScanSample {
  const p = pos.add(offset).div(tile.mul(scan.metres));
  const e = aabbMax.sub(aabbMin);
  // 1 where that axis is the longest (x wins ties, then y)
  const ax = e.x.greaterThanEqual(e.y).and(e.x.greaterThanEqual(e.z)).select(float(1), float(0));
  const ay = float(1).sub(ax).mul(e.y.greaterThanEqual(e.z).select(float(1), float(0)));
  const a = abs(normal);
  const w0 = pow(a, vec3(4));
  const w = w0.div(w0.x.add(w0.y).add(w0.z).max(1e-5));
  // each plane: (across, along) when the long axis lies in it, else its two axes in order
  const sel = (k: AnyNode, a0: AnyNode, a1: AnyNode): AnyNode => (mix as (...x: AnyNode[]) => AnyNode)(a0, a1, k);
  const uvx = sel(ay, vec2(p.y, p.z), vec2(p.z, p.y));
  const uvy = sel(ax, vec2(p.x, p.z), vec2(p.z, p.x));
  const uvz = sel(ay, sel(ax, vec2(p.x, p.y), vec2(p.y, p.x)), vec2(p.x, p.y));
  const tri = (t: THREE.Texture): AnyNode =>
    texture(t, uvx).mul(w.x).add(texture(t, uvy).mul(w.y)).add(texture(t, uvz).mul(w.z));
  const c = tri(scan.albedoRough);
  const r = tri(scan.normalAoH);
  return { albedo: c.rgb, rough: c.a, ao: r.b, height: r.a };
}
