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
 *           own, so the fade shows no seam), its own water line, the zoom-11 terrain (EU-DEM), lon 6..15.984°,
 *           lat 43.5..47°: the western Alps to the Julian Alps and the Karawanks over the Po plain and Istria (fades
 *           over 0.35°; a two-layer texture array, INSET_LAYER below)
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
import { asin, atan, exp2, float, floor, fract, log2, min, mix, smoothstep, step, texture, vec2 } from 'three/tsl';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

export const REGION = { lon0: -25, lon1: 45, lat0: 18, lat1: 68, w: 7000, h: 5000 };
/** scripts/drift-earth-data.py NEAR: 1/240° a texel */
export const NEAR = { lon0: -12, lon1: 20, lat0: 36, lat1: 54, w: 7680, h: 4320 };
/** scripts/drift-earth-data.py INSET: 1/1000° of longitude, 1/1400° of latitude a texel (~79 m both ways at 45° N).
 * (2026-11-02: widened east from lon 14 to ~16: the left views at 282 s look past lon 14 onto the Julian Alps and the
 * Karawanks, which had only the near level's 460 m and read soft) */
export const INSET = { lon0: 6, lon1: 15.984, lat0: 43.5, lat1: 47, w: 9984, h: 4900 };
/**
 * The inset's 9984 columns are over the 8192 a texture may be on every render box (WebGPU's default limit, which the
 * renderer does not raise), so its maps are two-layer texture arrays: layer 0 holds columns 0..5120 (lon 6..11.12),
 * layer 1 columns 4864..9984 (lon 10.864..15.984), cut from one bake on one texel grid. One binding each, as before
 * (a second inset's own three maps would have taken the earth material to 15 of its 16 textures), for ~100 MB more
 * than the old 8000 columns. A lookup takes layer 0 west of column `split` (lon 10.992) and layer 1 east of it: 128
 * columns from either layer's edge, where both hold the same texels — and with the offset and the width multiples of
 * 256, the same mips through mip 8 (a 20 km texel) — so the switch shows no seam.
 */
export const INSET_LAYER = { w: 5120, cols: [0, 4864], split: 4992 };
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
/** the near level and the inset: on by default (the render boxes have their maps, in the asset bundle since
 * 2026-10-30); `?earthfine=0` turns them off, an A/B against the region alone that also skips their ~900 MB of
 * textures */
const FINE_LEVELS = ((q: string | null) => q !== '0')(typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('earthfine'));

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
  /** (the inset's maps are two-layer arrays: INSET_LAYER) */
  insetAlbedo: THREE.DataArrayTexture;
  /** R open water 0..1 (the inset has no lights or clouds of its own) */
  insetWater: THREE.DataArrayTexture;
  insetElevation: THREE.DataArrayTexture;
  ready: Promise<void>;
  dispose(): void;
}

/** (`box`: a level that does not go round the planet — its edges clamp, so a coarse mip does not wrap the far edge's
 * texels in, which the repeat that the global maps need for the date line would) */
function elevationTexture(w: number, h: number, box = false): THREE.DataTexture {
  return mapTexture(new THREE.DataTexture(new Uint16Array(w * h), w, h, THREE.RedFormat, THREE.HalfFloatType), box);
}

/** the inset's maps: INSET_LAYER's two layers, one 8-bit channel (the water), 8-bit sRGB RGBA (the colour) or
 * half-float metres (the elevation). (With the fine levels off, a 1 x 1 placeholder: never sampled, never filled) */
function insetArray(kind: 'mask' | 'colour' | 'elevation'): THREE.DataArrayTexture {
  const [w, h] = FINE_LEVELS ? [INSET_LAYER.w, INSET.h] : [1, 1];
  const n = w * h * 2;
  const t =
    kind === 'elevation'
      ? new THREE.DataArrayTexture(new Uint16Array(n), w, h, 2)
      : new THREE.DataArrayTexture(new Uint8Array(kind === 'colour' ? n * 4 : n), w, h, 2);
  t.format = kind === 'colour' ? THREE.RGBAFormat : THREE.RedFormat;
  t.type = kind === 'elevation' ? THREE.HalfFloatType : THREE.UnsignedByteType;
  if (kind === 'colour') t.colorSpace = THREE.SRGBColorSpace;
  return mapTexture(t, true);
}

function mapTexture<T extends THREE.DataTexture | THREE.DataArrayTexture>(t: T, box: boolean): T {
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
  const elevation = (name: string, tex: THREE.DataTexture | THREE.DataArrayTexture): Promise<void> =>
    fetch(base + name)
      .then((r) => {
        if (!r.ok) throw new Error(`earth maps: ${name} ${r.status} (run scripts/drift-earth-data.py)`);
        return r.arrayBuffer();
      })
      .then((b) => {
        (tex.image as { data: Uint16Array }).data = new Uint16Array(b);
        tex.needsUpdate = true;
      });
  // an image decoded here into a data texture: a grey PNG into one channel, not as an image texture, which would hold
  // it as RGBA (4x the GPU memory for one channel: 157 MB instead of 39 for the inset's water); and the inset's colour,
  // its two layers stacked in one JPEG, into an array (an image texture cannot be one). Opaque, so the canvas's
  // premultiplied alpha changes nothing
  const decode = (name: string, tex: THREE.DataTexture | THREE.DataArrayTexture, channels: 1 | 4): Promise<void> =>
    fetch(base + name)
      .then((r) => {
        if (!r.ok) throw new Error(`earth maps: ${name} ${r.status} (run scripts/drift-earth-data.py)`);
        return r.blob();
      })
      .then((b) => createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }))
      .then((bmp) => {
        const { width: w, height: h } = bmp;
        const img = tex.image as { data: Uint8Array; width: number; height: number; depth?: number };
        const rows = img.height * (img.depth ?? 1);
        if (w !== img.width || h !== rows) throw new Error(`earth maps: ${name} is ${w}x${h}, not ${img.width}x${rows}`);
        const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error(`earth maps: ${name}: no 2D canvas to decode it`);
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
        const px = ctx.getImageData(0, 0, w, h).data;
        if (channels === 4) img.data.set(px);
        else for (let i = 0; i < w * h; i++) img.data[i] = px[i * 4];
        tex.needsUpdate = true;
      });
  const ra = image('region-albedo.jpg', true);
  const rl = image('region-lcw.png', false);
  const ga = image('global-albedo.jpg', true);
  const gl = image('global-lcw.png', false);
  const none = { tex: new THREE.Texture(), done: Promise.resolve() };
  const na = FINE_LEVELS ? image('near-albedo.jpg', true, true) : none;
  const nl = FINE_LEVELS ? image('near-lcw.png', false, true) : none;
  const ia = insetArray('colour');
  const re = elevationTexture(REGION.w, REGION.h);
  const ge = elevationTexture(GLOBAL_ELEV.w, GLOBAL_ELEV.h);
  const ne = elevationTexture(NEAR.w, NEAR.h, true);
  const ie = insetArray('elevation');
  const iw = insetArray('mask');
  const ready = Promise.all([
    ra.done, rl.done, ga.done, gl.done, elevation('region-elevation.f16', re), elevation('global-elevation.f16', ge),
    ...(FINE_LEVELS ? [na.done, nl.done, decode('inset-albedo.jpg', ia, 4), elevation('near-elevation.f16', ne), elevation('inset-elevation.f16', ie), decode('inset-water.png', iw, 1)] : []),
  ]).then(() => undefined);
  const all = [ra.tex, rl.tex, ga.tex, gl.tex, na.tex, nl.tex, ia, re, ge, ne, ie, iw];
  return {
    regionAlbedo: ra.tex, regionLcw: rl.tex, regionElevation: re,
    globalAlbedo: ga.tex, globalLcw: gl.tex, globalElevation: ge,
    nearAlbedo: na.tex, nearLcw: nl.tex, nearElevation: ne,
    insetAlbedo: ia, insetWater: iw, insetElevation: ie,
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
  /** in the inset's layer `insetLayer` (0 or 1, INSET_LAYER) */
  inset: V2;
  insetLayer: F;
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
  // (the inset's weight from its whole box; its texture coordinates in the layer on this side of the switch)
  const layer = step((INSET.lon0 * 1000 + INSET_LAYER.split) / 1000, lon) as F;
  const x0 = mix(float(INSET.lon0 + INSET_LAYER.cols[0] / 1000), float(INSET.lon0 + INSET_LAYER.cols[1] / 1000), layer);
  const inset = vec2(lon.sub(x0).div(INSET_LAYER.w / 1000), i.uv.y);
  const global = vec2(lon.add(180).div(360), float(90).sub(lat).div(180));
  return { region: r.uv, global, near: n.uv, inset, insetLayer: layer, w: r.w, wn: FINE_LEVELS ? n.w : float(0), wi: FINE_LEVELS ? i.w : float(0) };
}

// the mip level from the pixel's footprint on the ground (fp, rad), not from screen derivatives: the
// same on every cube face (derivatives taken in the shaders' loops are undefined, and differed across a
// face seam), and free of the date line's jump
const level = (fp: F, texel: number): F => log2(fp.div(texel).max(1)) as F;
/** a lookup into an array texture's layer (the inset's, INSET_LAYER), or the plain one */
const onLayer = (t: ReturnType<typeof texture>, layer?: F): ReturnType<typeof texture> => (layer ? t.depth(layer.toInt()) : t);

/** the region over the global maps (the clouds, the desert's bare rock: neither has finer levels) */
export function sampleBoth(regionTex: THREE.Texture, globalTex: THREE.Texture, c: { region: V2; global: V2; w: F }, fp: F, globalTexel: number = GLOBAL_TEXEL): V4 {
  const r = texture(regionTex, c.region).level(level(fp, REGION_TEXEL));
  const gl = texture(globalTex, c.global).level(level(fp, globalTexel));
  return mix(gl, r, c.w) as unknown as V4;
}

/**
 * A map magnified through a cubic B-spline instead of the bilinear tent: four bilinear taps (Sigg and Hadwiger's
 * third-order filtering, GPU Gems 2 ch. 20). A bilinear lookup is only C0 across a texel's edge, and under a steep
 * curve its texels show as squares: the Black Marble's own 15″ grid is single-texel speckle saturated in the cores,
 * and the night lights' threshold (lifeLayers.ts nightLights `on`) cut it into hard squares ~500 m across once the
 * near level came in (the 2026-10-31 look at 275 s: "blocky squares in the foreground"); the elevation's slope is
 * constant across a texel, so the relief drew the inset's texel grid where the view is closer than its 79 m. The
 * spline is smooth to the second derivative and keeps the map's mean. On each of the two mips the level falls
 * between, blended as trilinear does: the level is set by the footprint's geometric mean, and at a grazing view the
 * footprint across it is √μV of that, so even past the first mip a texel spans several pixels across the view (the
 * squares at 275 s were mip 1–2 texels, 1–2 km, under a bilinear lookup).
 */
function bspline(tex: THREE.Texture, uv: V2, w: number, h: number, lvl: F, layer?: F): V4 {
  const at = (L: F): V4 => {
    const size = vec2(w, h).div(exp2(L));
    const st = uv.mul(size).sub(0.5);
    const i = floor(st);
    const f = fract(st);
    const f2 = f.mul(f);
    const f3 = f2.mul(f);
    const w0 = float(1).sub(f).pow(3).div(6);
    const w1 = f3.mul(3).sub(f2.mul(6)).add(vec2(4)).div(6);
    const w2 = f3.mul(-3).add(f2.mul(3)).add(f.mul(3)).add(1).div(6);
    const w3 = f3.div(6);
    const g0 = w0.add(w1);
    const g1 = w2.add(w3);
    // the two taps' texel positions (their centres at +0.5), in uv
    const p0 = i.sub(0.5).add(w1.div(g0)).div(size);
    const p1 = i.add(1.5).add(w3.div(g1)).div(size);
    const tap = (x: F, y: F): V4 => onLayer(texture(tex, vec2(x, y)), layer).level(L) as unknown as V4;
    return tap(p0.x, p0.y).mul(g0.x).add(tap(p1.x, p0.y).mul(g1.x)).mul(g0.y).add(tap(p0.x, p1.y).mul(g0.x).add(tap(p1.x, p1.y).mul(g1.x)).mul(g1.y)) as V4;
  };
  const L0 = floor(lvl);
  return mix(at(L0), at(L0.add(1)), fract(lvl)) as unknown as V4;
}

/** the pixel's footprint on the ground as an ellipse, for anisotropic lookups: its axes along and across the view as
 * (east, north) steps in degrees of longitude and latitude, and the minor axis's length (unit sphere) */
export interface Aniso {
  along: V2;
  across: V2;
  minor: F;
}

type Box = { lon0: number; lon1: number; lat0: number; lat1: number };
const WORLD: Box = { lon0: -180, lon1: 180, lat0: -90, lat1: 90 };
/** one of the inset's layers, for the gradients' scale (only its spans count) */
const INSET_LAYER_BOX: Box = { lon0: 0, lon1: INSET_LAYER.w / 1000, lat0: INSET.lat0, lat1: INSET.lat1 };
/** a (lon, lat) deg step as a step in a level's texture coordinates (v runs north to south) */
const gradUv = (g: V2, b: Box): V2 => vec2(g.x.div(b.lon1 - b.lon0), g.y.div(b.lat1 - b.lat0).negate());

/**
 * Every level of one map, each finer one over the coarser ones where it is: `near` and `inset` are left out for a map
 * that has none (the night lights stop at the near level). (All of them are fetched everywhere: four lookups a map
 * are cheap next to the surface's noise and air, and a branch around them would buy little on a GPU.) `smooth`: the
 * near level and the inset magnified through the B-spline (`bspline`, above) — for the maps whose texels showed.
 *
 * `an`: the lookups filtered over the footprint's ellipse (the hardware's anisotropic filter, from the analytic
 * gradients) instead of a mip from its mean. At the grazing views of Drift-2 (μV 0.1–0.3) the footprint across the
 * view is √μV of the mean, so the mean's mip blurred everything 2–3× across the view: the Alps' ridges and the
 * snowfields smeared sideways into soft blobs (the 2026-10-31 look at 275–282 s: "still kind of blurry and pixely").
 */
export function sampleLevels(t: { global: THREE.Texture; region: THREE.Texture; near?: THREE.Texture; inset?: THREE.Texture; globalTexel?: number; smooth?: boolean }, c: MapCoords, fp: F, an?: Aniso): V4 {
  const look = (tex: THREE.Texture, uv: V2, texel: number, box: Box, layer?: F): V4 =>
    (an ? onLayer(texture(tex, uv), layer).grad(gradUv(an.along, box), gradUv(an.across, box)) : onLayer(texture(tex, uv), layer).level(level(fp, texel))) as unknown as V4;
  // a finer level: through the B-spline while it is magnified across the view, the plain lookup from there
  const fine = (tex: THREE.Texture, uv: V2, texel: number, box: Box, w: number, h: number, layer?: F): V4 => {
    if (!t.smooth) return look(tex, uv, texel, box, layer);
    const spline = bspline(tex, uv, w, h, level(fp, texel), layer);
    if (!an) return spline;
    return mix(spline, look(tex, uv, texel, box, layer), smoothstep(0.5, 1.5, level(an.minor, texel))) as unknown as V4;
  };
  let v = an
    ? (mix(look(t.global, c.global, t.globalTexel ?? GLOBAL_TEXEL, WORLD), look(t.region, c.region, REGION_TEXEL, REGION), c.w) as unknown as V4)
    : sampleBoth(t.region, t.global, c, fp, t.globalTexel ?? GLOBAL_TEXEL);
  if (t.near && FINE_LEVELS) v = mix(v, fine(t.near, c.near, NEAR_TEXEL, NEAR, NEAR.w, NEAR.h), c.wn) as unknown as V4;
  if (t.inset && FINE_LEVELS) v = mix(v, fine(t.inset, c.inset, INSET_TEXEL, INSET_LAYER_BOX, INSET_LAYER.w, INSET.h, c.insetLayer), c.wi) as unknown as V4;
  return v;
}

/** the inset's own water (0..1) over `coarse` (the near level's and the region's, from their colour) */
export function insetWater(maps: EarthMaps, c: MapCoords, fp: F, coarse: F): F {
  if (!FINE_LEVELS) return coarse;
  return mix(coarse, (onLayer(texture(maps.insetWater, c.inset), c.insetLayer).level(level(fp, INSET_TEXEL)) as unknown as V4).x, c.wi) as F;
}
