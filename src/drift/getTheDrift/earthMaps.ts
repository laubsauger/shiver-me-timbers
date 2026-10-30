/**
 * The Earth's surface as measured from orbit (scripts/drift-earth-data.py builds the maps, all public-domain
 * satellite data): NASA Blue Marble NG colour (July, cloud-free, no relief shading), Black Marble 2016 night
 * lights, a real VIIRS cloud field (2023-09-08) over Europe and NASA's global cloud composite elsewhere, and
 * the AWS Terrain Tiles elevation (SRTM land, EU-DEM, ETOPO1 sea floor); and, under the closest views, Sentinel-2
 * cloudless 2016 colour by EOX (CC BY 4.0: "Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH
 * (Contains modified Copernicus Sentinel data 2016)").
 *
 * Four nested levels, all equirectangular, each finer one fading into the one under it inside its own edge:
 *   GLOBAL  ~5 km, the planet as a disc
 *   REGION  ~1 km: Europe, the Mediterranean and North Africa, lon −25..45°, lat 18..68°, where every close view of
 *           the show looks (fades over its last 1.5°)
 *   NEAR    ~460 m: the Blue Marble's and the Black Marble's own 15″ grid, uncut, and the terrain tiles at zoom 9,
 *           lon −12..20°, lat 36..54° (fades over 1°)
 *   INSET   ~79 m: Sentinel-2 colour matched to the Blue Marble above its 460 m (only Sentinel's finer detail is its
 *           own, so the fade shows no seam), its own water line, the zoom-11 terrain (EU-DEM), lon 6..14°,
 *           lat 43.5..47°: the western Alps to Istria over the Po plain (fades over 0.35°)
 * Why these boxes (the 2026-10-30 question "at the zoom level we end up in they look kind of low resolution … can we
 * upscale them?"): measured against a 4096 master's pixel on the ground through Act 2 (docs/drift/earth-data.md,
 * "Resolution"), the region's kilometre is too coarse from the lights beat on over lon −13.5..19.5, lat 32..57; the
 * 460 m over lon −6.5..19, lat 39.5..50.5; and under the end of Drift-2 and the landing the pixel comes down to
 * 30–120 m over lon 4.5..14, lat 43.5..46.5. The night lights have no finer data than the Black Marble's own 500 m:
 * they stop at the near level (the closest night views, the flood's last twilight at ~265–273 s, 100–200 m a pixel,
 * are left to the shader's grain under the texel, lifeLayers.ts). The clouds stay on the region (the VIIRS day is
 * ~1 km).
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
/** scripts/drift-earth-data.py NEAR: 1/240° a texel */
export const NEAR = { lon0: -12, lon1: 20, lat0: 36, lat1: 54, w: 7680, h: 4320 };
/** scripts/drift-earth-data.py INSET: 1/1000° of longitude, 1/1400° of latitude a texel (~79 m both ways at 45° N) */
export const INSET = { lon0: 6, lon1: 14, lat0: 43.5, lat1: 47, w: 8000, h: 4900 };
const GLOBAL_ELEV = { w: 4096, h: 2048 };
/** rad on the sphere one texel spans: the region's maps, the global colour / lights / clouds, its elevation, the near
 * level's, the inset's (its north–south side: square on the ground at its latitude) */
const REGION_TEXEL = (((REGION.lon1 - REGION.lon0) / REGION.w) * Math.PI) / 180;
const GLOBAL_TEXEL = (2 * Math.PI) / 8192;
export const GLOBAL_ELEV_TEXEL = (2 * Math.PI) / GLOBAL_ELEV.w;
const NEAR_TEXEL = (((NEAR.lon1 - NEAR.lon0) / NEAR.w) * Math.PI) / 180;
const INSET_TEXEL = (((INSET.lat1 - INSET.lat0) / INSET.h) * Math.PI) / 180;
/** km on the ground one elevation texel spans, finest first: the inset's, the near level's, the region's */
export const ELEV_TEXEL_KM = { inset: INSET_TEXEL * 6371, near: NEAR_TEXEL * 6371, region: REGION_TEXEL * 6371 };
/** deg inside its edge each finer level fades in over: wide enough that its sharper detail comes in gradually, the
 * levels agree above the coarser one's texel (the bake makes them), so it is only the detail that fades */
const FADE = { region: 1.5, near: 1, inset: 0.35 };
const DEG = 180 / Math.PI;
/** the near level and the inset: `?earthfine` turns them on, `?earthfine=0` off (an A/B against the region alone).
 * Off by default until the render boxes have their maps (drift-bundle.mjs --manifest-only) */
const FINE_LEVELS = ((q: string | null) => (q === null ? false : q !== '0'))(typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('earthfine'));

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
  nearAlbedo: THREE.Texture;
  /** as the region's, but G (clouds) empty: the clouds are read from the region */
  nearLcw: THREE.Texture;
  nearElevation: THREE.DataTexture;
  insetAlbedo: THREE.Texture;
  /** R open water 0..1 (the inset has no lights or clouds of its own) */
  insetWater: THREE.DataTexture;
  insetElevation: THREE.DataTexture;
  ready: Promise<void>;
  dispose(): void;
}

/** (`box`: a level that does not go round the planet — its edges clamp, so a coarse mip does not wrap the far edge's
 * texels in, which the repeat that the global maps need for the date line would) */
function elevationTexture(w: number, h: number, box = false): THREE.DataTexture {
  return mapTexture(new THREE.DataTexture(new Uint16Array(w * h), w, h, THREE.RedFormat, THREE.HalfFloatType), box);
}

/** a one-channel 8-bit map (the inset's water) */
function maskTexture(w: number, h: number): THREE.DataTexture {
  return mapTexture(new THREE.DataTexture(new Uint8Array(w * h), w, h, THREE.RedFormat, THREE.UnsignedByteType), true);
}

function mapTexture(t: THREE.DataTexture, box: boolean): THREE.DataTexture {
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.wrapS = box ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export function loadEarthMaps(base = `${import.meta.env.BASE_URL}drift/earth/`): EarthMaps {
  const loader = new THREE.TextureLoader();
  const image = (name: string, srgb: boolean, box = false): { tex: THREE.Texture; done: Promise<void> } => {
    const tex = new THREE.Texture();
    const done = loader.loadAsync(base + name).then((t) => {
      tex.image = t.image;
      tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      tex.flipY = false; // v = 0 is the image's top row (north), as in the elevation
      tex.wrapS = box ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
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
  // a grey PNG into a one-channel texture: decoded here, not as an image texture, which would hold it as RGBA (4x the
  // GPU memory for one channel: 157 MB instead of 39 for the inset's water)
  const grey = (name: string, tex: THREE.DataTexture): Promise<void> =>
    fetch(base + name)
      .then((r) => {
        if (!r.ok) throw new Error(`earth maps: ${name} ${r.status} (run scripts/drift-earth-data.py)`);
        return r.blob();
      })
      .then((b) => createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
      .then((bmp) => {
        const { width: w, height: h } = bmp;
        const img = tex.image as { data: Uint8Array; width: number; height: number };
        if (w !== img.width || h !== img.height) throw new Error(`earth maps: ${name} is ${w}x${h}, not ${img.width}x${img.height}`);
        const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error(`earth maps: ${name}: no 2D canvas to decode it`);
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        const px = ctx.getImageData(0, 0, w, h).data;
        for (let i = 0; i < w * h; i++) img.data[i] = px[i * 4];
        tex.needsUpdate = true;
      });
  const ra = image('region-albedo.jpg', true);
  const rl = image('region-lcw.png', false);
  const ga = image('global-albedo.jpg', true);
  const gl = image('global-lcw.png', false);
  const none = { tex: new THREE.Texture(), done: Promise.resolve() };
  const na = FINE_LEVELS ? image('near-albedo.jpg', true, true) : none;
  const nl = FINE_LEVELS ? image('near-lcw.png', false, true) : none;
  const ia = FINE_LEVELS ? image('inset-albedo.jpg', true, true) : none;
  const re = elevationTexture(REGION.w, REGION.h);
  const ge = elevationTexture(GLOBAL_ELEV.w, GLOBAL_ELEV.h);
  const ne = elevationTexture(NEAR.w, NEAR.h, true);
  const ie = elevationTexture(INSET.w, INSET.h, true);
  const iw = maskTexture(INSET.w, INSET.h);
  const ready = Promise.all([
    ra.done, rl.done, ga.done, gl.done, elevation('region-elevation.f16', re), elevation('global-elevation.f16', ge),
    ...(FINE_LEVELS ? [na.done, nl.done, ia.done, elevation('near-elevation.f16', ne), elevation('inset-elevation.f16', ie), grey('inset-water.png', iw)] : []),
  ]).then(() => undefined);
  const all = [ra.tex, rl.tex, ga.tex, gl.tex, na.tex, nl.tex, ia.tex, re, ge, ne, ie, iw];
  return {
    regionAlbedo: ra.tex, regionLcw: rl.tex, regionElevation: re,
    globalAlbedo: ga.tex, globalLcw: gl.tex, globalElevation: ge,
    nearAlbedo: na.tex, nearLcw: nl.tex, nearElevation: ne,
    insetAlbedo: ia.tex, insetWater: iw, insetElevation: ie,
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

export interface MapCoords {
  region: V2;
  global: V2;
  near: V2;
  inset: V2;
  /** 0..1 how much of the region's / the near level's / the inset's maps is used (each over the coarser ones) */
  w: F;
  wn: F;
  wi: F;
}

/** a level's texture coordinates at (lat, lon), and its weight: 0 outside, 1 from `fade` degrees inside its edge */
function boxCoords(lat: F, lon: F, b: { lon0: number; lon1: number; lat0: number; lat1: number }, fade: number): { uv: V2; w: F } {
  const uv = vec2(lon.sub(b.lon0).div(b.lon1 - b.lon0), float(b.lat1).sub(lat).div(b.lat1 - b.lat0));
  const edge = min(min(uv.x, float(1).sub(uv.x)).mul(b.lon1 - b.lon0), min(uv.y, float(1).sub(uv.y)).mul(b.lat1 - b.lat0));
  return { uv, w: smoothstep(0, fade, edge) as F };
}

/** every level's texture coordinates at (lat, lon), and how far inside each it is */
export function mapCoords(lat: F, lon: F): MapCoords {
  const r = boxCoords(lat, lon, REGION, FADE.region);
  const n = boxCoords(lat, lon, NEAR, FADE.near);
  const i = boxCoords(lat, lon, INSET, FADE.inset);
  const global = vec2(lon.add(180).div(360), float(90).sub(lat).div(180));
  return { region: r.uv, global, near: n.uv, inset: i.uv, w: r.w, wn: FINE_LEVELS ? n.w : float(0), wi: FINE_LEVELS ? i.w : float(0) };
}

// the mip level from the pixel's footprint on the ground (fp, rad), not from screen derivatives: the
// same on every cube face (derivatives taken in the shaders' loops are undefined, and differed across a
// face seam), and free of the date line's jump
const level = (fp: F, texel: number): F => log2(fp.div(texel).max(1)) as F;

/** the region over the global maps (the clouds, the desert's bare rock: neither has finer levels) */
export function sampleBoth(regionTex: THREE.Texture, globalTex: THREE.Texture, c: { region: V2; global: V2; w: F }, fp: F, globalTexel: number = GLOBAL_TEXEL): V4 {
  const r = texture(regionTex, c.region).level(level(fp, REGION_TEXEL));
  const gl = texture(globalTex, c.global).level(level(fp, globalTexel));
  return mix(gl, r, c.w) as unknown as V4;
}

/**
 * Every level of one map, each finer one over the coarser ones where it is: `near` and `inset` are left out for a map
 * that has none (the night lights stop at the near level). (All of them are fetched everywhere: four lookups a map
 * are cheap next to the surface's noise and air, and a branch around them would buy little on a GPU.)
 */
export function sampleLevels(t: { global: THREE.Texture; region: THREE.Texture; near?: THREE.Texture; inset?: THREE.Texture; globalTexel?: number }, c: MapCoords, fp: F): V4 {
  let v = sampleBoth(t.region, t.global, c, fp, t.globalTexel ?? GLOBAL_TEXEL);
  if (t.near && FINE_LEVELS) v = mix(v, texture(t.near, c.near).level(level(fp, NEAR_TEXEL)), c.wn) as unknown as V4;
  if (t.inset && FINE_LEVELS) v = mix(v, texture(t.inset, c.inset).level(level(fp, INSET_TEXEL)), c.wi) as unknown as V4;
  return v;
}

/** the inset's own water (0..1) over `coarse` (the near level's and the region's, from their colour) */
export function insetWater(maps: EarthMaps, c: MapCoords, fp: F, coarse: F): F {
  if (!FINE_LEVELS) return coarse;
  return mix(coarse, texture(maps.insetWater, c.inset).level(level(fp, INSET_TEXEL)).x, c.wi) as F;
}
