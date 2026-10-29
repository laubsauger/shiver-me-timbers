/**
 * Clouds over the sea (Part C, Act 3): a layer of fair-weather cumulus, ray-marched per view direction in the
 * sky's own shader (seaSky.ts) — so it has no seams across the dome's cube faces, and every frame is a pure
 * function of time (the field drifts with a steady wind).
 *
 * THE FIELD (`cloudField`), after Schneider's Nubis (Horizon Zero Dawn's clouds): a coverage field decides where
 * clouds gather; in it a Perlin–Worley body billows, its threshold rising with height so only the strongest cores
 * reach the top (domes, not columns), cut flat at the base. The body's iso-surface is the cloud's surface: the
 * density rises across a fringe (SKIN, ~160 m) and on into a denser core (CORE), so the outer volume stays
 * translucent and only the thick of a cloud goes opaque (a 15 m skin made them solid to their last corner, the
 * user at the v11 stills); Worley detail moves that surface in and out (ERODE: round billows toward the top, the
 * cauliflower heads) and carves the fringe's thin outer part into wisps (WISPS). Its share of the flat look the
 * 2026-10-29 review called "flat grey blobs with soft edges" was the light, not the ramp.
 * scripts/drift-cloud-noise.py bakes the volumes.
 *
 * THE LIGHT (`cloudMarch`), after takram's three-geospatial clouds (MIT; ported, not depended on) and Hillaire's
 * Frostbite clouds:
 *   - the phase function is Jendersie & d'Eon's fit to Mie scattering by cloud droplets (2023): a Henyey–Greenstein
 *     forward lobe and a Draine lobe whose α gives the back-scattering a cloud's sunlit face sends to the Sun's side;
 *   - multiple scattering is Wrenninge's octaves (Oz, 2013; takram's eight, a = b = c = ½): each octave carries half
 *     the light of the last, sees half the extinction, scatters half as anisotropically — so the light that has
 *     scattered many times reaches deep into the cloud and comes out of it in every direction (the old single soft
 *     "diffuse" octave left a thick body near black or flat grey);
 *   - the way to the Sun is a short fine march near the sample (the billows shading each other) and beyond it the
 *     LIGHT VOLUME (`createCloudLight`): the optical depth toward the Sun from every cell of a grid over the layer
 *     (two levels, 100 m cells near the eye, 400 m out to the haze), marched 40 km once per (sub-)frame. With the
 *     Sun at 0–10° the light crosses the layer over 6–30 km and more; the old march reached 1.4 km of it, so no
 *     cloud ever shaded another — no dark bases behind sunlit ones, no self-shadowed far side. The volume's other
 *     channels hold the cloud above and below each cell: the sky's light from above and the sea's from below come
 *     through them. The same volume casts the clouds' shadows into the air under them (`sunThrough`): the light
 *     shafts (cloudAir.ts `shafts`);
 *   - the sunlight at each sample is the air's own (`sunAt`, from atmosphere.ts through seaSky.ts) at that sample's
 *     height and local Sun elevation: a cloud 40 km toward the Sun has it 0.4° higher than the eye does, so at
 *     sunset the shadow line climbs across the field, the clouds toward the Sun lit last.
 *
 * What the references measured (references/sea-golden-hour-sky): sunlit faces warm (#f6e0c3), shaded flanks
 * pinkish, bases blue-violet; toward the Sun, bodies darker than the sky with hard bright rims.
 *
 * Geometry: the layer is a spherical shell (BASE–TOP above the sea) on the planet's curvature, so it closes on
 * the horizon; beyond MAX_DIST it has gone into the haze. (A point's height above the sea is p.y plus the drop of
 * the sea's curve below the eye's horizontal, r²/2R: exact to millimetres at 50 km, and with none of the 0.5 m
 * steps of |p − C| − R in f32.)
 *
 * JITTER: the march starts each ray a fraction of a step along, per pixel (blue noise, blueNoise.ts: still from
 * frame to frame) and per sub-frame within a frame (`CloudLight.jitter`, the phase of the sea's clock in 1/600 s,
 * JITTER_RATE): the motion blur's sub-frames each sample the layer at different depths and average out within the
 * frame, and every frame takes the same set — deterministic, and nothing in the noise changes from one frame to
 * the next (an offset new every frame re-drew the grain 30 times a second: flicker).
 *
 * Above it, a thin CIRRUS layer at CIRRUS_H (`cirrus`): one sample per ray, streaked along the wind, lit by the
 * sunlight 8 km up — it keeps the Sun until it is ~3° down, the pink and orange after sunset the low cumulus
 * (dark by −2°) cannot give (references/sea-golden-hour-sky, sea-dusk-twilight).
 *
 * FOR THE GAME (src/clouds): the field, the light volume and the march take no scene, only the noise volumes, the
 * uniforms and the sunlight as a function; the game's sky can pass its own `sunAt` (or none: the sunBase/sunTop
 * uniforms) and run `CloudLight.update` once per frame (or every few: the field only drifts). `sunThrough` is a
 * cloud shadow for any surface under the layer — the sea's and the game's water and decks.
 */
import * as THREE from 'three/webgpu';
import { Break, Fn, If, Loop, exp, float, fract, instanceIndex, mix, smoothstep, sqrt, texture3D, textureStore, uint, uniform, uvec3, vec3, vec4 } from 'three/tsl';
import { blueNoise } from './blueNoise';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** m above the sea: the layer's base and top (fair-weather cumulus, humilis: wider than tall —
 * references/sea-golden-hour-sky) */
export const CLOUD_BASE = 1200;
export const CLOUD_TOP = 2300;
/** how far the cells stretch along the wind (the flat-based lines and streets of the references), and how slowly
 * the body changes with height against across (a cell keeps its footprint up through the layer: a cumulus is a
 * column with a domed top, where the body's full 3D noise made thin lenses of the weaker cells, translucent from
 * below and lit through all round) */
const STREETS = 1.6;
const UPRIGHT = 0.35;
const R = 6.371e6;
/** m above the sea: the cirrus sheet; m: its streaks' length and width */
export const CIRRUS_H = 8000;
const CIRRUS_LONG = 60000;
const CIRRUS_WIDE = 9000;
/** m: the patches the cirrus gathers in (most of the sky has none) */
const CIRRUS_PATCH = 90000;
/** the wind at the cirrus against the cumulus': a little stronger, but at four to five times the height that crosses
 * the sky at a quarter of the cumulus' angular speed; and veered (rad; winds turn with height). They had drifted
 * the same way at half the cumulus' rate, along their own streaks, and read as one layer moving together (user,
 * v9: no parallax); now they slide across each other. */
const CIRRUS_WIND = 1.2;
const CIRRUS_VEER = 0.5;
/** s on the sea's clock (mid-act) when the cirrus lies where its old drift (2.5× the cumulus wind) had it: the
 * layout the v9 cut was reviewed with, kept within ~3.5 km (a streak is 9 km wide) over the whole act */
const CIRRUS_PIVOT = 226;
/** m: beyond, the clouds have gone into the haze */
const MAX_DIST = 45000;
/** m: the shape volume's tile (cells ~1.5 km), the detail's, the coverage field's */
const SHAPE_TILE = 6000;
const DETAIL_TILE = 700;
const COVER_TILE = 30000;
/** the share of the sky the field gathers cloud groups over */
const GROUPS = 0.55;
/** per m: extinction of the cloud's body (density 1): a mean free path of 20 m (fair-weather cumulus: 0.05–0.1 at
 * their cores) */
const SIGMA = 0.06;
/** the surface: how far past the threshold (in the body noise's units, which change by ~1 per 750 m) the density
 * reaches its full value — 0.22 is a fringe ~160 m deep, the density rising as the 1.5th power of the way in (an
 * optical depth of ~3 across it: the sky shows through its outer half), and the detail carving the fringe's outer
 * part (WISPS) into wisps. (A skin of 15 m made every cloud a hard opaque surface, "not a single bit that has some
 * sort of transparency to it"; one of 60 m still "very, very quickly accumulates to very solid", the user at the
 * v11 stills: only the thick cores go opaque now) — how far the turrets (the shape's 375 m Worley) push the surface
 * out above the base, and how far the detail moves it in and out (0.3: ±110 m, the cauliflower) */
const SKIN = 0.22;
/** the density keeps rising past the fringe, from CORE_FRINGE of the core's at the surface to all of it CORE in
 * (0.6: ~450 m) */
const CORE = 0.6;
const CORE_FRINGE = 0.4;
const WISPS = 0.4;
const TURRETS = 0.12;
const ERODE = 0.3;
/** the surface's place past the coverage threshold: the old field's density rose from the threshold as a soft ramp
 * and was eroded, and read as cloud only ~0.12 past it — the same clouds, now with an edge (less the outer, faint
 * part of the fringe) */
const SURFACE = 0.08;
/** the density's rise from the base to the top (a cumulus' water content grows with height above its base: the
 * base is the thinnest of it) */
const BASE_DENSITY = 0.6;

/** the march: steps along the view ray, steps of the fine march toward the Sun (each twice the last, from 40 m)
 * before the light volume takes over, whether the detail erodes the surface, steps of the air in front */
export interface CloudQuality {
  steps: number;
  lightSteps: number;
  detail: boolean;
  airSteps: number;
}
/** the sky's own march; the water's reflection of it can do with far less (a rough sea blurs it) */
export const FULL: CloudQuality = { steps: 96, lightSteps: 6, detail: true, airSteps: 8 };
export const REFLECTED: CloudQuality = { steps: 24, lightSteps: 2, detail: false, airSteps: 3 };

/** THE PHASE FUNCTION: Jendersie & d'Eon's fit for droplets of 20 μm — Draine's g, α and weight as theirs; the HG
 * lobe's g held at 0.9 (theirs is 0.995, the diffraction peak within ~2° of the Sun: the dome draws the Sun's disc
 * at ~1/1700 of its true radiance (atmosphere.ts sunDisc), and a thin veil spreading the true peak around it came
 * out brighter than the disc itself) */
const G_HG = 0.9;
const G_D = 0.594;
const ALPHA_D = 27.1;
const W_D = 0.498;
/** multiple scattering: octaves (a = b = c = ½) */
const OCTAVES = 8;
/** the powder effect (Schneider): light at the sunlit skin has scattered too few times to come back out — the creases
 * between the billows read dark seen with the Sun behind; none seen toward the Sun (the rims stay bright) */
const POWDER = 0.5;
/** how diffuse light fades into a cloud: a slab's diffuse transmittance, 1/(1 + ¾τ(1 − g)), with the droplets'
 * g ~0.85 (a cumulus is τ ~100 across) */
const DIFFUSE = 0.75 * (1 - 0.85);
/** THE LIGHT THE OCTAVES LEAVE OUT: deep in a thick cloud the sunlight has scattered hundreds of times and diffuses,
 * falling off as diffusion does, not exponentially — what lights a cumulus' base and its far side (eight octaves of
 * ½ left a 1 km body ten times too dark: black undersides under a sunset sky). Its share (the light a cloud's body
 * passes on: most of it, its albedo is ~1), and the optical depth over which it takes over from the octaves at the
 * sunlit skin (where the octaves are the light, and both would count it twice) */
const DIFFUSION = 0.5;
const DIFFUSION_SKIN = 8;
/** the sea's light up onto the bases, as a share of the sky's light on it: its albedo with the grazing views'
 * Fresnel (from 1.2 km most of the sea a base sees is far off, mirroring the bright sky over the horizon) */
const SEA_UP = 0.12;

/** THE LIGHT VOLUME: cells each way, centred on the eye, and layers through the layer's depth (~70 m); m per cell
 * of its two levels — a fine one over the clouds near the eye, ±12.8 km (a cell of 400 m is 15° of the sky
 * overhead, and its interpolation drew the light on a cloud's base in facets and terraces) and a coarse one out
 * to MAX_DIST and the light's reach past it, ±51 km */
const GRID_N = 256;
const GRID_LAYERS = 16;
const GRID_CELLS = [100, 400];
/** the share of the fine level's half-width over which it hands over to the coarse one */
const GRID_BLEND = 0.15;
/** m: how far toward the Sun the volume's march looks, and its steps (crowding toward the cell: s ∝ u², the last
 * ~1.2 km long). Past 40 km the Sun is down to its last ~1° for a cloud, its light already near gone */
const SUN_REACH = 40000;
const SUN_STEPS = 64;
/** m per unit of the body noise (it changes by ~1 per 750 m): a march's step sees the cloud's surface blurred over
 * its own length — at a sharp surface a step 1 km long either hit a far cloud or missed it, and the light from
 * neighbouring cells 100 m apart came out as a patchwork of lit and shadowed blocks */
const BODY_M = 750;
/** m: a far cloud's shadow fills in with distance (the air scatters light into it, the cloud itself sends most of
 * what it stops on forward) — its optical depth counted at e^(−s/SHADOW_FADE). Counted whole, at the Sun's last
 * few degrees every cloud overhead lay in the shadow of the 20–40 km of field toward the Sun: a sky of flat brown
 * silhouettes where the references' sunset fields are lit, pink and peach, on every face toward the Sun */
const SHADOW_FADE = 12000;
/** steps up to the top and down to the base (the sky's and the sea's light; at ~45 m or less the domes' tops no
 * longer step the light under them into terraces) */
const UP_STEPS = 24;
/** per s: the rate the marches' offset turns at with the sea's clock (`CloudLight.update`): one turn every 1/600 s.
 * A frame period at 24, 25, 30, 50 or 60 fps is a whole number of turns, so every frame's sub-frames take the
 * same set of offsets (at 30 fps with an 8-sample 180° shutter: four, a quarter-turn apart, each twice) and a
 * frame without motion blur the same one offset as every other — no frame differs from the next by its noise */
const JITTER_RATE = 600;

export interface CloudData {
  shape: THREE.Data3DTexture;
  detail: THREE.Data3DTexture;
  ready: Promise<void>;
}

function volume(n: number): THREE.Data3DTexture {
  const t = new THREE.Data3DTexture(new Uint8Array(n * n * n * 4), n, n, n);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.unpackAlignment = 1;
  return t;
}

export function loadClouds(base = `${import.meta.env.BASE_URL}drift/clouds/`): CloudData {
  const shape = volume(128);
  const detail = volume(32);
  const fill = (name: string, tex: THREE.Data3DTexture): Promise<void> =>
    fetch(base + name)
      .then((r) => {
        if (!r.ok) throw new Error(`clouds: ${r.status} (run scripts/drift-cloud-noise.py)`);
        return r.arrayBuffer();
      })
      .then((b) => {
        (tex.image as { data: Uint8Array }).data = new Uint8Array(b);
        tex.needsUpdate = true;
      });
  return { shape, detail, ready: Promise.all([fill('cloud-shape-128.u8', shape), fill('cloud-detail-32.u8', detail)]).then(() => undefined) };
}

export interface CloudUniforms {
  /** s */
  time: F;
  /** m/s, the wind on the sea's xz plane */
  wind: THREE.Node<'vec2'>;
  /** m on the xz plane the field is sampled shifted by: a world placed elsewhere in the sea (c2's open sea, km
   * from c1's flood) keeps the sky it dissolves from */
  shift: THREE.Node<'vec2'>;
  /** 0..1, how much of the sky the field covers */
  coverage: F;
  /** 0..1, how far the clouds have formed: their density (thin, translucent veils while they form) */
  presence: F;
  /** unit, toward the Sun */
  sun: V3;
  /** the sunlight's radiance on a white surface facing it, at the layer's base and top (linear) */
  sunBase: V3;
  sunTop: V3;
  /** the sky's light on the layer (irradiance / π, linear) */
  ambient: V3;
  /** the cirrus: how much of the sky it covers (0..1), and the sunlight on it (as sunBase) */
  cirrusCover: F;
  sunCirrus: V3;
}

const sat = (x: F): F => x.clamp(0, 1) as F;
/** a uniform node's value (the uniforms are typed as the nodes the shaders read) */
const valueOf = <T>(n: unknown): T => (n as { value: T }).value;

export interface CloudField {
  /** m: where the wind has carried the field (field coordinates are world + drift) */
  drift: V3;
  /** m above the sea of a world point (the sea's curve under the eye this field was made for) */
  alt: (p: V3) => F;
  /** the cloud's density at a world point (0..1); `detailed`: the detail erodes its surface; `blur` (m): the surface
   * spread over that width, for a march whose steps are that long (the mean density over a step) */
  density: (p: V3, detailed: boolean, blur?: number | F) => F;
}

/** the field as seen from `eye` (world, m; the sea's curve is centred under it) */
export function cloudField(data: CloudData, U: CloudUniforms, eye: V3): CloudField {
  const drift = vec3(U.wind.x, 0, U.wind.y).mul(U.time).add(vec3(U.shift.x, 0, U.shift.y));
  const alt = (p: V3): F => {
    const dx = p.x.sub(eye.x);
    const dz = p.z.sub(eye.z);
    return p.y.add(dx.mul(dx).add(dz.mul(dz)).div(2 * R)) as F;
  };
  const density = (p: V3, detailed: boolean, blur: number | F = 0): F => {
    const h = alt(p);
    const hr = h.sub(CLOUD_BASE).div(CLOUD_TOP - CLOUD_BASE);
    const hf = sat(hr);
    // (none outside the shell, within ~5 m: the marches toward the Sun and the base leave it)
    const shell = sat(hr.mul(200).add(1)).mul(sat(float(1).sub(hr).mul(200).add(1)));
    const q = p.add(drift);
    // (every noise channel is uniform on [0, 1]: a threshold at 1 − c keeps a share c)
    // where the field gathers clouds: groups over GROUPS of the sky, the cells inside them at `coverage`
    const field = texture3D(data.shape, vec3(q.x.div(COVER_TILE), 0.37, q.z.div(COVER_TILE))).g;
    const groups = smoothstep(1 - GROUPS - 0.12, 1 - GROUPS + 0.12, field);
    const c = U.coverage.mul(groups);
    const w = U.wind.normalize();
    const qs = vec3(q.x.mul(w.x).add(q.z.mul(w.y)).div(STREETS), q.y.mul(UPRIGHT), q.z.mul(w.x).sub(q.x.mul(w.y)));
    const s = texture3D(data.shape, qs.div(SHAPE_TILE));
    // the body: Perlin–Worley, rounded by the Worley billows
    const body = s.r.mul(0.7).add(s.g.mul(0.2)).add(s.b.mul(0.1));
    // the cell keeps its footprint up its sides and rounds off toward its top (cauliflower heads, not columns), cut
    // flat at its base: how far inside the surface this point is, in the body's units. (Narrowing from the base up,
    // hf^1.5, every cloud was a lens thinning to nothing at its rim: lit through all round from below, a wide glow
    // where a cumulus has a dark base to its edge and a hairline of light)
    const thr = float(1).sub(c.mul(float(1).sub(hf.pow(3).mul(0.75))));
    const base = float(1).sub(smoothstep(0, 0.05, hf)).mul(0.3).add(smoothstep(0.85, 1, hf).mul(0.3));
    let inside = body.sub(thr).sub(base).sub(SURFACE).add(s.a.sub(0.5).mul(sat(hf.mul(3).sub(0.3))).mul(TURRETS)) as F;
    let carve: F | null = null;
    if (detailed) {
      const dt = texture3D(data.detail, q.div(DETAIL_TILE));
      const dfbm = dt.r.mul(0.625).add(dt.g.mul(0.25)).add(dt.b.mul(0.125));
      // the surface moved in and out: wisps at the base (the Worley's ridges kept), billows above (its blobs)
      carve = mix(dfbm, dfbm.oneMinus(), sat(hf.mul(8))) as F;
      inside = inside.sub(carve.sub(0.5).mul(ERODE)) as F;
    }
    const wide = typeof blur === 'number' ? float(blur) : blur;
    // (the blurred surface ramps inward only: spread both ways, a far step saw every cloud half a step wider)
    let ramp = (blur === 0 ? sat(inside.div(SKIN)) : sat(inside.div(wide.div(BODY_M).add(SKIN)))) as F;
    // the fringe's outer part carved into wisps (Nubis' erosion: the detail takes the thin density away, the
    // core keeps it)
    if (carve) ramp = sat(ramp.sub(carve.mul(WISPS)).div(float(1).sub(carve.mul(WISPS)))) as F;
    // (the core denser than the fringe, deeper in: only the thick of a cloud goes opaque, and its light and shade
    // keep their contrast)
    const core = sat(inside.div(CORE)).mul(1 - CORE_FRINGE).add(CORE_FRINGE);
    return ramp.mul(ramp.sqrt()).mul(core).mul(mix(float(BASE_DENSITY), float(1), hf)).mul(shell).mul(U.presence) as F;
  };
  return { drift, alt, density };
}

export interface CloudLight {
  /** per cell of each level (fine, coarse): optical depth (density · km) toward the Sun, up to the layer's top,
   * down to its base */
  readonly textures: THREE.Storage3DTexture[];
  /** 0..1, this (sub-)frame's offset of the march's jitter */
  readonly jitter: F;
  /** the volume at a field point q (world + drift) at height h: (toward the Sun, up, down), density · m */
  at(q: V3, h: F): V3;
  /** the sunlight's transmittance through the layer to a world point p in the air under it (the sea's curve under
   * the eye `o`): the clouds' shadow, for the light shafts in the air (cloudAir.ts) */
  sunThrough(p: V3, o: V3): F;
  /** march the volume for this instant: after every uniform is set, before the sky is drawn; `clock` (s): the
   * show's clock or one a whole number of frames off it (the sea's), which sets the marches' offset (JITTER_RATE;
   * none: the clouds' own clock, which a time-lapse warps) */
  update(renderer: THREE.WebGPURenderer, eye: THREE.Vector3, clock?: number): void;
}

/**
 * THE LIGHT VOLUME: GRID_N² cells over the layer around the eye, GRID_LAYERS through its depth, each holding the
 * optical depth from its centre toward the Sun (a march of SUN_STEPS out to SUN_REACH, or until the ray has left
 * the layer's top), and up to the top and down to the base; in two levels, fine near the eye and coarse out to the
 * haze. Computed once per (sub-)frame from the same field the sky marches; its cells are fixed in the FIELD's
 * coordinates (the grid steps by whole cells as the eye moves and the wind carries the field), so a cell's value
 * changes only as the clouds do. A world-space volume sampled per view ray has no seams across the dome's faces.
 */
export function createCloudLight(data: CloudData, U: CloudUniforms): CloudLight {
  const eye = uniform(new THREE.Vector3());
  const jitter = uniform(0);
  const f = cloudField(data, U, eye as unknown as V3);
  const layer = (CLOUD_TOP - CLOUD_BASE) / GRID_LAYERS;
  const levels = GRID_CELLS.map((cell) => {
    const texture = new THREE.Storage3DTexture(GRID_N, GRID_N, GRID_LAYERS);
    texture.name = `drift-cloud-light-${cell}`;
    texture.type = THREE.HalfFloatType;
    texture.format = THREE.RGBAFormat;
    texture.generateMipmaps = false;
    texture.minFilter = texture.magFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
    /** m, field coordinates of the grid's corner (x, z) */
    const origin = uniform(new THREE.Vector2());
    const kernel = Fn(() => {
      const i = instanceIndex.mod(uint(GRID_N));
      const j = instanceIndex.div(uint(GRID_N)).mod(uint(GRID_N));
      const k = instanceIndex.div(uint(GRID_N * GRID_N));
      // the marches' samples offset per (sub-)frame, all cells alike: at fixed places a cloud edge crossed one
      // sample between one cell and the next and the light stepped there, the same in every sub-frame (terraces
      // under every far shadow's edge); offset per cell as well, the cells' noise came out of the interpolation as
      // blotches eight sub-frames could not even out
      const jc = jitter;
      // the cell's centre: in the field, then in the world (less the drift; its height over the sea's curve)
      const qx = origin.x.add(float(i).add(0.5).mul(cell));
      const qz = origin.y.add(float(j).add(0.5).mul(cell));
      const h = float(k).add(0.5).mul(layer).add(CLOUD_BASE);
      const px = qx.sub(f.drift.x);
      const pz = qz.sub(f.drift.z);
      const dx = px.sub(eye.x);
      const dz = pz.sub(eye.z);
      const p = vec3(px, h.sub(dx.mul(dx).add(dz.mul(dz)).div(2 * R)), pz).toVar();
      const sun = U.sun;
      // toward the Sun, until the ray has climbed out of the layer
      const odSun = float(0).toVar();
      Loop(SUN_STEPS, ({ i: n }) => {
        const u = float(n).add(jc).div(SUN_STEPS);
        const x = p.add(sun.mul(u.mul(u).mul(SUN_REACH)));
        // (the ray climbs relative to the sea's curve wherever the Sun is above that point's horizon)
        const xdx = x.x.sub(eye.x);
        const xdz = x.z.sub(eye.z);
        const muS = sun.y.add(sun.x.mul(xdx).add(sun.z.mul(xdz)).div(R));
        If(f.alt(x).greaterThan(CLOUD_TOP).and(muS.greaterThan(0)), () => {
          Break();
        });
        const ds = u.mul(2 * SUN_REACH / SUN_STEPS);
        odSun.addAssign(f.density(x, false, ds).mul(ds).mul(exp(u.mul(u).mul(-SUN_REACH / SHADOW_FADE))));
      });
      // up to the top, down to the base
      const odUp = float(0).toVar();
      const odDown = float(0).toVar();
      const up = float(CLOUD_TOP).sub(h).div(UP_STEPS);
      const down = h.sub(CLOUD_BASE).div(UP_STEPS);
      Loop(UP_STEPS, ({ i: n }) => {
        const s = float(n).add(jc);
        odUp.addAssign(f.density(p.add(vec3(0, s.mul(up), 0)), false).mul(up));
        odDown.addAssign(f.density(p.sub(vec3(0, s.mul(down), 0)), false).mul(down));
      });
      // (density · km: half floats hold 65504, and the march to the Sun can cross 60 km of cloud)
      textureStore(texture, uvec3(i, j, k), vec4(odSun.mul(1e-3), odUp.mul(1e-3), odDown.mul(1e-3), 1)).toWriteOnly();
    });
    const compute = (kernel() as unknown as { compute: (n: number) => unknown }).compute(GRID_N * GRID_N * GRID_LAYERS);
    const sample = texture3D(texture);
    // (in texels, eased between their centres: plain trilinear interpolation creases at every cell, and with the
    // Sun on the horizon, where the light on a cloud's base comes the whole way from the volume, the creases drew
    // its cells on the base as crosses and ridges, 100 m apart)
    const size = vec3(GRID_N, GRID_N, GRID_LAYERS);
    const uvw = (q: V3, h: F): V3 => {
      const x = vec3(q.x.sub(origin.x).div(cell), q.z.sub(origin.y).div(cell), h.sub(CLOUD_BASE).div(layer)).sub(0.5);
      const i = x.floor();
      const t = x.sub(i);
      return i.add(t.mul(t).mul(t.mul(-2).add(3))).add(0.5).div(size) as unknown as V3;
    };
    return { cell, texture, origin, compute, sample, uvw };
  });
  const [fine, coarse] = levels;
  return {
    textures: levels.map((l) => l.texture),
    jitter: jitter as unknown as F,
    at(q, h) {
      const a = fine.uvw(q, h);
      // (the fine level where it reaches, handing over to the coarse one toward its edge)
      const edge = a.x.sub(0.5).abs().max(a.y.sub(0.5).abs());
      const w = sat(float(0.5).sub(edge).div(0.5 * GRID_BLEND));
      return mix(coarse.sample.sample(coarse.uvw(q, h)).xyz, fine.sample.sample(a).xyz, w).mul(1e3) as unknown as V3;
    },
    sunThrough(p, o) {
      const sun = U.sun;
      const dx = p.x.sub(o.x);
      const dz = p.z.sub(o.z);
      const h = p.y.add(dx.mul(dx).add(dz.mul(dz)).div(2 * R));
      const muS = sun.y.add(sun.x.mul(dx).add(sun.z.mul(dz)).div(R));
      // up the Sun's ray to the layer's base (the shell's stable root), and the volume's depth to the Sun from there
      const r0 = h.add(R);
      const k = float(CLOUD_BASE).sub(h).max(0).mul(h.add(2 * R + CLOUD_BASE));
      const tb = k.div(r0.mul(muS).add(sqrt(r0.mul(r0).mul(muS.mul(muS)).add(k)).max(1e-3)));
      const pb = p.add(sun.mul(tb));
      const od = this.at(pb.add(f.drift), float(CLOUD_BASE)).x;
      // (none past the coarse level's reach, where its edge texels would be smeared outward)
      const far = pb.x.sub(o.x).abs().max(pb.z.sub(o.z).abs());
      const reach = sat(float(GRID_N * GRID_CELLS[1] * 0.5 - 3000).sub(far).div(3000));
      return mix(float(1), exp(od.mul(-SIGMA)), reach.mul(sat(muS.mul(50).add(1)))) as F;
    },
    update(renderer, at, clock) {
      const t = valueOf<number>(U.time);
      const wind = valueOf<THREE.Vector2>(U.wind);
      const shift = valueOf<THREE.Vector2>(U.shift);
      eye.value.copy(at);
      // (the phase of the clock against the frames: the same set of offsets in every frame's sub-frames. It had been
      // a golden-ratio turn per 1/4800 s of the clouds' clock — a new offset every frame, the blue-noise grain
      // re-drawn 30 times a second: the "strong flicker" of the v11 cycle clip, 37× the old clouds' frame-to-frame
      // change in a sunset cumulus row)
      jitter.value = (((clock ?? t) * JITTER_RATE) % 1 + 1) % 1;
      for (const l of levels) {
        // the grid's corner, in whole cells of the field around the eye
        l.origin.value.set(
          (Math.floor((at.x + wind.x * t + shift.x) / l.cell) - GRID_N / 2) * l.cell,
          (Math.floor((at.z + wind.y * t + shift.y) / l.cell) - GRID_N / 2) * l.cell,
        );
        renderer.compute(l.compute as Parameters<THREE.WebGPURenderer['compute']>[0]);
      }
    },
  };
}

/** Henyey–Greenstein, and Draine's generalisation of it (α = 0: HG; α = 1: Cornette–Shanks) */
const hg = (g: number, c: F): F => float((1 - g * g) / (4 * Math.PI)).div(float(1 + g * g).sub(c.mul(2 * g)).pow(1.5)) as F;
const draine = (g: number, a: number, c: F): F =>
  float((1 - g * g) / (4 * Math.PI * (1 + (a * (1 + 2 * g * g)) / 3)))
    .mul(c.mul(c).mul(a).add(1))
    .div(float(1 + g * g).sub(c.mul(2 * g)).pow(1.5)) as F;
/** the droplets' phase function at cos θ = c, its anisotropy scaled by k (an octave's c^i) */
const cloudPhase = (c: F, k: number): F => mix(hg(G_HG * k, c), draine(G_D * k, ALPHA_D, c), W_D) as F;

export interface CloudMarchOptions {
  quality?: CloudQuality;
  /** the light volume (none: no cloud shades another past the fine march, the sky's light unshaded) */
  light?: CloudLight;
  /** the sunlight's irradiance on a surface facing it (linear) at height h (m) where the Sun's cos-zenith is mu
   * (none: the sunBase/sunTop uniforms) */
  sunAt?: (h: F, mu: F) => V3;
}

/**
 * The layer along a ray from the eye `o` (m, y up, sea level at y = 0) in direction d: the light it sends back
 * (linear, the in-scattered light — already weighted by its own opacity), its opacity, and how far its light comes
 * from (m, opacity-weighted; for the air in front of it).
 */
export function cloudMarch(o: V3, d: V3, data: CloudData, U: CloudUniforms, opt: CloudMarchOptions = {}): { light: V3; alpha: F; dist: F } {
  const quality = opt.quality ?? FULL;
  const f = cloudField(data, U, o);

  // the shell between BASE and TOP along the ray (stable roots: the radii are 6 Mm, the gaps 1 km)
  const r0 = float(R).add(o.y);
  const mu = d.y;
  const toAlt = (H: number): F => {
    const k = float(H).sub(o.y).mul(float(2 * R + H).add(o.y));
    return k.div(r0.mul(mu).add(sqrt(r0.mul(r0).mul(mu.mul(mu)).add(k)))) as F;
  };
  const t0 = toAlt(CLOUD_BASE).max(0);
  const t1 = toAlt(CLOUD_TOP).min(MAX_DIST);
  const light = vec3(0).toVar();
  const T = float(1).toVar();
  const distW = float(0).toVar();
  const cosT = d.dot(U.sun);
  // the octaves' phase functions (constant along the ray)
  const phases = Array.from({ length: OCTAVES }, (_, i) => cloudPhase(cosT, 0.5 ** i).toVar());
  const powderK = sat(cosT.negate().mul(0.5).add(0.5)).mul(POWDER);
  // (blue noise per pixel, blueNoise.ts: an interleaved-gradient hash drew a checker through the clouds in any one
  // frame)
  const bn = blueNoise(0);
  const jitter = opt.light ? fract(bn.add(opt.light.jitter)) : bn;
  // the march toward the Sun offset too (by another pattern): its samples at fixed places crossed a cloud's edge
  // one at a time across the cloud, the light stepping at each — terraces parallel to every sunlit edge
  // (the tile at another shift, on its own sequence of frame offsets: a second interleaved-gradient pattern beat
  // against the first in fine diagonal stripes, white noise stayed speckle through eight sub-frames)
  const jitterL = opt.light ? fract(blueNoise(1).add(fract(opt.light.jitter.mul(1.618034).add(0.5)))) : blueNoise(1);
  // the fine march toward the Sun: steps doubling from 40 m, each sampled at a jittered point in it; the volume
  // from its end
  const near: [number, number][] = [];
  let reach = 0;
  for (let k = 0, step = 40; k < quality.lightSteps; k++, step *= 2) {
    near.push([reach, step]);
    reach += step;
  }
  // the sea's light on the bases: its albedo of the sky's and the Sun's light on it
  const seaUp = U.ambient.add(U.sunBase.mul(U.sun.y.max(0))).mul(SEA_UP * 0.5);
  If(mu.greaterThan(0).and(t1.greaterThan(t0)), () => {
    const ds = t1.sub(t0).div(quality.steps);
    Loop(quality.steps, ({ i }) => {
      If(T.lessThan(0.01), () => {
        Break();
      });
      const t = t0.add(float(i).add(jitter).mul(ds));
      const p = o.add(d.mul(t)).toVar();
      const rho = f.density(p, quality.detail).toVar();
      If(rho.greaterThan(0.002), () => {
        // the cloud between here and the Sun: the billows near, the volume beyond
        const od = float(0).toVar();
        for (const [at, step] of near) od.addAssign(f.density(p.add(U.sun.mul(jitterL.mul(step).add(at))), false).mul(step));
        const h = f.alt(p).toVar();
        const odNear = od.toVar();
        if (opt.light) {
          const pf = p.add(U.sun.mul(reach));
          od.addAssign(opt.light.at(pf.add(f.drift), f.alt(pf)).x);
        }
        const tau = od.mul(SIGMA);
        // the octaves: e^(−τ/2^i), from the last (one exp) back to the first by squaring
        const e: F[] = new Array(OCTAVES);
        e[OCTAVES - 1] = exp(tau.div(-(2 ** (OCTAVES - 1)))).toVar() as F;
        for (let k = OCTAVES - 2; k >= 0; k--) e[k] = e[k + 1].mul(e[k + 1]) as F;
        let ms = e[0].mul(phases[0]) as F;
        for (let k = 1; k < OCTAVES; k++) ms = ms.add(e[k].mul(phases[k]).mul(0.5 ** k)) as F;
        const powder = float(1).sub(exp(odNear.mul(-SIGMA * 2)).mul(powderK));
        // the sunlight here: the air's, at this height and this point's own Sun elevation
        const dx = p.x.sub(o.x);
        const dz = p.z.sub(o.z);
        const muS = U.sun.y.mul(float(1).sub(dx.mul(dx).add(dz.mul(dz)).div(2 * R * R))).add(U.sun.x.mul(dx).add(U.sun.z.mul(dz)).div(R));
        const hf = sat(h.sub(CLOUD_BASE).div(CLOUD_TOP - CLOUD_BASE));
        const E = opt.sunAt ? opt.sunAt(h, muS) : mix(U.sunBase, U.sunTop, hf).mul(Math.PI);
        // the sky's light from above and the sea's from below, through the cloud over and under this point (from
        // above, half of it: the light comes in through the sides as well as the top)
        const vol = opt.light ? opt.light.at(p.add(f.drift), h) : vec3(0, float(CLOUD_TOP).sub(h).mul(0.5), h.sub(CLOUD_BASE).mul(0.5));
        const amb = U.ambient
          .mul(0.5)
          .div(vol.y.mul(SIGMA * DIFFUSE * 0.5).add(1))
          .add(seaUp.div(vol.z.mul(SIGMA * DIFFUSE).add(1)));
        const diffused = sat(tau.div(DIFFUSION_SKIN)).div(tau.mul(DIFFUSE).add(1)).mul(DIFFUSION / (4 * Math.PI));
        const S = E.mul(ms.mul(powder).add(diffused)).add(amb);
        const a = float(1).sub(exp(rho.mul(-SIGMA).mul(ds)));
        light.addAssign(S.mul(a).mul(T));
        distW.addAssign(t.mul(a).mul(T));
        T.mulAssign(a.oneMinus());
      });
    });
  });
  const alpha = T.oneMinus();
  return { light: light as unknown as V3, alpha: alpha as F, dist: distW.div(alpha.max(1e-4)) as F };
}

/**
 * The cirrus sheet along a ray from the eye `o` (m) in direction d: its light, opacity and distance, from one
 * sample where the ray meets CIRRUS_H. Streaks run along the wind; thin (an optical depth of at most ~0.6), lit
 * mostly forward (ice scatters ahead) with the sky's light behind it.
 */
export function cirrus(o: V3, d: V3, data: CloudData, U: CloudUniforms): { light: V3; alpha: F; dist: F } {
  const r0 = float(R).add(o.y);
  const mu = d.y;
  const k = float(CIRRUS_H).sub(o.y).mul(float(2 * R + CIRRUS_H).add(o.y));
  const t = k.div(r0.mul(mu.max(0)).add(sqrt(r0.mul(r0).mul(mu.mul(mu)).add(k))));
  const cv = Math.cos(CIRRUS_VEER) * CIRRUS_WIND;
  const sv = Math.sin(CIRRUS_VEER) * CIRRUS_WIND;
  const wind = vec3(U.wind.x.mul(cv).sub(U.wind.y.mul(sv)), 0, U.wind.x.mul(sv).add(U.wind.y.mul(cv)));
  const p = o.add(d.mul(t)).add(vec3(U.wind.x, 0, U.wind.y).mul(2.5 * CIRRUS_PIVOT)).add(wind.mul(U.time.sub(CIRRUS_PIVOT))).add(vec3(U.shift.x, 0, U.shift.y));
  // along and across the wind up there
  const w = wind.normalize();
  // warped, so the streaks bend and wander instead of running in ranks
  const warp = texture3D(data.shape, vec3(p.x.div(45000), 0.19, p.z.div(45000))).rg.sub(0.5);
  const along = p.x.mul(w.x).add(p.z.mul(w.z)).add(warp.x.mul(3000));
  const across = p.z.mul(w.x).sub(p.x.mul(w.z)).add(warp.y.mul(2200));
  const streak = texture3D(data.shape, vec3(along.div(CIRRUS_LONG), 0.71, across.div(CIRRUS_WIDE)));
  const fine = texture3D(data.detail, vec3(along.div(CIRRUS_LONG / 9), 0.29, across.div(CIRRUS_WIDE / 6)));
  const patch = smoothstep(0.42, 0.7, texture3D(data.shape, vec3(p.x.div(CIRRUS_PATCH), 0.53, p.z.div(CIRRUS_PATCH))).b);
  const fibres = texture3D(data.detail, vec3(along.div(CIRRUS_LONG / 4), 0.61, across.div(CIRRUS_WIDE / 5))).g;
  // (a soft ramp from a little under the cover's threshold: from it, only the noise's ridges passed, as thin
  // hard-edged threads — "worms" in the v9 review)
  const sheet = smoothstep(U.cirrusCover.oneMinus().sub(0.12), U.cirrusCover.oneMinus().add(0.62), streak.g.mul(0.65).add(fine.r.mul(0.2)).add(fibres.mul(0.15))).mul(patch);
  const tau = sheet.mul(0.6).mul(smoothstep(0, 0.02, mu)).mul(smoothstep(MAX_DIST * 3, MAX_DIST, t));
  const cosT = d.dot(U.sun);
  const hgc = float((1 - 0.49) / (4 * Math.PI)).div(float(1.49).sub(cosT.mul(1.4)).pow(1.5));
  const alpha = float(1).sub(exp(tau.negate()));
  const light = U.sunCirrus.mul(hgc.mul(0.8).add(0.2 / (4 * Math.PI)).mul(Math.PI)).add(U.ambient.mul(0.7)).mul(alpha);
  return { light: light as V3, alpha: alpha as F, dist: t as F };
}
