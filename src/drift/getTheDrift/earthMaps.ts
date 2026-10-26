/**
 * The Earth's surface as measured from orbit (scripts/drift-earth-data.py builds the maps, all public-domain
 * satellite data): NASA Blue Marble NG colour (July, cloud-free, no relief shading), Black Marble 2016 night
 * lights, a real VIIRS cloud field (2023-09-08) over Europe and NASA's global cloud composite elsewhere, and
 * the AWS Terrain Tiles elevation (SRTM land, ETOPO1 sea floor).
 *
 * Two levels, both equirectangular: the GLOBAL maps (~5 km) for the planet as a disc, and a REGION (~1 km):
 * Europe, the Mediterranean and North Africa, lon −25..45°, lat 18..68°, where every close view of the show
 * looks. The region fades into the global maps over its last degree or so.
 *
 * The planet's frame: `geo` is three world-space unit vectors (the axis to the north pole, the direction of
 * lon 0° lat 0°, of lon 90°E) — the planet only translates, so they are fixed.
 */
import * as THREE from 'three/webgpu';
import { asin, atan, float, log2, min, mix, smoothstep, texture, vec2 } from 'three/tsl';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

export const REGION = { lon0: -25, lon1: 45, lat0: 18, lat1: 68, w: 7000, h: 5000 };
const GLOBAL_ELEV = { w: 4096, h: 2048 };
/** rad on the sphere one texel spans: the region's maps, the global colour / lights / clouds, its elevation */
const REGION_TEXEL = (((REGION.lon1 - REGION.lon0) / REGION.w) * Math.PI) / 180;
const GLOBAL_TEXEL = (2 * Math.PI) / 8192;
export const GLOBAL_ELEV_TEXEL = (2 * Math.PI) / GLOBAL_ELEV.w;
const DEG = 180 / Math.PI;

export interface GeoFrame {
  north: V3;
  zero: V3;
  east: V3;
}

export interface EarthMaps {
  regionAlbedo: THREE.Texture;
  /** R night lights (Black Marble grey), G cloud cover (sqrt), B open water */
  regionLcw: THREE.Texture;
  /** m, rows north to south */
  regionElevation: THREE.DataTexture;
  globalAlbedo: THREE.Texture;
  globalLcw: THREE.Texture;
  globalElevation: THREE.DataTexture;
  ready: Promise<void>;
  dispose(): void;
}

function elevationTexture(w: number, h: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint16Array(w * h), w, h, THREE.RedFormat, THREE.HalfFloatType);
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export function loadEarthMaps(base = `${import.meta.env.BASE_URL}drift/earth/`): EarthMaps {
  const loader = new THREE.TextureLoader();
  const image = (name: string, srgb: boolean): { tex: THREE.Texture; done: Promise<void> } => {
    const tex = new THREE.Texture();
    const done = loader.loadAsync(base + name).then((t) => {
      tex.image = t.image;
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.flipY = false; // v = 0 is the image's top row (north), as in the elevation
      tex.wrapS = THREE.RepeatWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.anisotropy = 8;
      tex.needsUpdate = true;
    });
    return { tex, done };
  };
  const elevation = (name: string, tex: THREE.DataTexture): Promise<void> =>
    fetch(base + name)
      .then((r) => {
        if (!r.ok) throw new Error(`earth maps: ${name} ${r.status} (run scripts/drift-earth-data.py)`);
        return r.arrayBuffer();
      })
      .then((b) => {
        (tex.image as { data: Uint16Array }).data = new Uint16Array(b);
        tex.needsUpdate = true;
      });
  const ra = image('region-albedo.jpg', true);
  const rl = image('region-lcw.png', false);
  const ga = image('global-albedo.jpg', true);
  const gl = image('global-lcw.png', false);
  const re = elevationTexture(REGION.w, REGION.h);
  const ge = elevationTexture(GLOBAL_ELEV.w, GLOBAL_ELEV.h);
  const ready = Promise.all([ra.done, rl.done, ga.done, gl.done, elevation('region-elevation.f16', re), elevation('global-elevation.f16', ge)]).then(() => undefined);
  const all = [ra.tex, rl.tex, ga.tex, gl.tex, re, ge];
  return {
    regionAlbedo: ra.tex, regionLcw: rl.tex, regionElevation: re,
    globalAlbedo: ga.tex, globalLcw: gl.tex, globalElevation: ge,
    ready,
    dispose: () => all.forEach((t) => t.dispose()),
  };
}

/** degrees: latitude and longitude of the unit surface normal n */
export function latLon(n: V3, g: GeoFrame): { lat: F; lon: F } {
  return { lat: asin(n.dot(g.north).clamp(-1, 1)).mul(DEG) as F, lon: atan(n.dot(g.east), n.dot(g.zero)).mul(DEG) as F };
}

/** the world-space unit normal at (lat, lon) degrees, CPU side */
export function geoNormal(latDeg: number, lonDeg: number, g: { north: THREE.Vector3; zero: THREE.Vector3; east: THREE.Vector3 }): THREE.Vector3 {
  const la = latDeg / DEG;
  const lo = lonDeg / DEG;
  return new THREE.Vector3()
    .addScaledVector(g.zero, Math.cos(la) * Math.cos(lo))
    .addScaledVector(g.east, Math.cos(la) * Math.sin(lo))
    .addScaledVector(g.north, Math.sin(la));
}

/**
 * The frame that puts (lat, lon) at the world direction `up`, with geographic north along the world
 * tangent `ahead` there.
 */
export function geoFrameAt(latDeg: number, lonDeg: number, up: THREE.Vector3, ahead: THREE.Vector3): { north: THREE.Vector3; zero: THREE.Vector3; east: THREE.Vector3 } {
  const u = up.clone().normalize();
  const nth = ahead.clone().addScaledVector(u, -ahead.dot(u)).normalize();
  const est = new THREE.Vector3().crossVectors(nth, u);
  // the local frame in planet coordinates (x lon 0, y lon 90E, z north): up, east, north at (lat, lon)
  const la = latDeg / DEG;
  const lo = lonDeg / DEG;
  const U = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
  const E = new THREE.Vector3(-Math.sin(lo), Math.cos(lo), 0);
  const N = new THREE.Vector3(-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la));
  // world = M · planet, M = [u est nth] · [U E N]ᵀ; the planet's axes are M's columns
  const col = (i: 0 | 1 | 2): THREE.Vector3 =>
    new THREE.Vector3().addScaledVector(u, U.getComponent(i)).addScaledVector(est, E.getComponent(i)).addScaledVector(nth, N.getComponent(i));
  return { zero: col(0), east: col(1), north: col(2) };
}

export interface MapSample {
  albedo: V3;
  /** R lights, G clouds (sqrt), B water */
  lcw: V4;
  /** 0..1 how much of the region map is used */
  w: F;
}

/** the two levels' texture coordinates at (lat, lon), and how far inside the region it is */
export function mapCoords(lat: F, lon: F): { region: V2; global: V2; w: F } {
  const region = vec2(lon.sub(REGION.lon0).div(REGION.lon1 - REGION.lon0), float(REGION.lat1).sub(lat).div(REGION.lat1 - REGION.lat0));
  const global = vec2(lon.add(180).div(360), float(90).sub(lat).div(180));
  const edge = min(min(region.x, float(1).sub(region.x)).mul(REGION.lon1 - REGION.lon0), min(region.y, float(1).sub(region.y)).mul(REGION.lat1 - REGION.lat0));
  return { region, global, w: smoothstep(0, 1.5, edge) as F };
}

export function sampleBoth(regionTex: THREE.Texture, globalTex: THREE.Texture, c: { region: V2; global: V2; w: F }, fp: F, globalTexel: number = GLOBAL_TEXEL): V4 {
  // the mip level from the pixel's footprint on the ground (fp, rad), not from screen derivatives: the
  // same on every cube face (derivatives taken in the shaders' loops are undefined, and differed across a
  // face seam), and free of the date line's jump
  const level = (texel: number): F => log2(fp.div(texel).max(1)) as F;
  const r = texture(regionTex, c.region).level(level(REGION_TEXEL));
  const gl = texture(globalTex, c.global).level(level(globalTexel));
  return mix(gl, r, c.w) as unknown as V4;
}
