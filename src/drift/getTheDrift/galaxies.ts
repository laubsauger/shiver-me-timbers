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
import { Fn, abs, acos, attribute, mx_noise_float, cameraPosition, clamp, cos, exp, float, max, min, mix, normalize, sin, smoothstep, step, texture, uv, vec2, vec3, vec4 } from 'three/tsl';
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
  /** a modelled galaxy's kind and look (galaxies.ts VARIETY; ours and the photos have none) */
  variant?: GalaxyVariant;
  /** the atlas tile (−1: the analytic model), whether it lies in its plane, its roll (rad) as a billboard */
  tile: number;
  planar: boolean;
  roll: number;
}

/** a modelled galaxy's kind (VARIETY) */
export const GALAXY_TYPE = { spiral: 0, barred: 1, lenticular: 2, elliptical: 3, irregular: 4, edgeOn: 5 } as const;

export interface GalaxyVariant {
  type: (typeof GALAXY_TYPE)[keyof typeof GALAXY_TYPE];
  /** −1..2: less or more bulge than the model's own (bulge-to-disc) */
  bulge: number;
  /** 0..2: the dust lanes' depth over the model's */
  dust: number;
  /** −1 old (yellow-white) … 1 young (blue) disc */
  hue: number;
  /** pink HII knots along the arms, or not */
  knots: boolean;
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

/** the atlas tiles' brightest part is 1: their light against the analytic model's. (0.9 until the coordinator's check
 * of ~92 s, 2026-11-01: the near galaxies "read a bit bright and photographic"; with COOL_NEAR they sit in the web's
 * light instead of on it) */
const ATLAS_GAIN = 0.65;
/** the galaxy quad spans ±EXTENT radii (the outer disk fades by then) */
const EXTENT = 1.5;
/** BIRTHS: s into the act the first galaxy is born, and the s they are spread over (by `appear`) */
const BIRTH_START = 0.2;
const BIRTH_SPAN = 7;
/** s a birth's flare rises over, the s it falls by 1/e in, the s the galaxy unfolds over from its peak */
const FLARE_RISE = 0.3;
const FLARE_FALL = 0.55;
const GROW = 2.6;
/** rad, the furthest a photographed disc tilts from facing the eye; a modelled one (tile −1) may tilt further, toward
 * the bright needle of edge-on (it has no bulge-less photo to flatten) */
const TILT_MAX = (55 * Math.PI) / 180;
const TILT_MAX_MODEL = (76 * Math.PI) / 180;
/**
 * MODELLED GALAXIES (the 2026-11-01 note: "a lot of the galaxies now look quite cheaply pasted in there, like bad
 * cutouts"): most of the field is now drawn by galaxyFace, as ours is — no card, no photo sky, no foreground stars,
 * a disc in its own plane in 3D, in the same light model as ours — each with its own arms, pitch, phase and noise
 * (webGalaxies.ts). It takes the web's fog and tint as the photos do, at MODEL_GAIN of ours' light. Below
 * MODEL_DETAIL pixels of radius its arms would alias into sparkle, so it eases into a plain bulge-and-disc glow there
 * (a far galaxy is a smudge, not a spiral).
 */
const MODEL_GAIN = 0.8;
const MODEL_DETAIL: [number, number] = [2.5, 10];
/** the photos' foreground stars (stars of OUR galaxy, in front of theirs, baked into the tiles): in the outskirts
 * (from STAR_FROM of the tile's half-width) a pixel may be at most STAR_CLIP× its blurred neighbourhood — a point
 * star is far above it, a disc's own light is not */
const STAR_CLIP = 1.6;
/**
 * VARIETY (the 2026-11-01 note on the modelled field: "we still want variance, and not all galaxies to look the same
 * and use the same colours"). galaxyFace draws one kind — a spiral, or an elliptical — in ours' colours; each modelled
 * galaxy now also has a kind and a look of its own (GalaxyVariant, seeded in webGalaxies.ts), drawn here on top of it:
 *   spiral       galaxyFace's arms: grand-design (2 open arms) or flocculent (5–7 tight ones), by its arm count
 *   barred       a bar (an elongated bulge, BAR radii long) across the centre, the arms from its ends
 *   lenticular   a bulge and a smooth disc, no arms, a faint dust ring
 *   elliptical   galaxyFace's warm glow
 *   irregular    galaxyFace on warped coordinates, off-centre and clumpy, little bulge, blue
 *   edge-on      a billboard: a thin disc (EDGE_THICK radii), a bulge, a dark lane through the middle
 * and a bulge-to-disc ratio, a dust depth, a disc colour from old yellow-white to young blue (the bulge stays warm),
 * with or without the pink HII knots. The web's light and fog go on top as before, so they still sit in it.
 */
const BAR = 0.32;
const EDGE_THICK = 0.045;
const OLD_DISC: [number, number, number] = [1.06, 0.95, 0.78];
const YOUNG_DISC: [number, number, number] = [0.78, 0.92, 1.22];
const WARM_CORE: [number, number, number] = [1.08, 0.94, 0.8];
const STAR_FROM: [number, number] = [0.12, 0.3];
/**
 * INTO THE WEB'S LIGHT (the 2026-10-31 review of ~95–110 s: "most of these look a little bit pasted in, not merging
 * with the surroundings … like a stuck decal"). The atlas tiles are photographs cut out of their skies: drawn whole
 * on their quads, each kept the cut-out's hard rim and the photo's stretched outskirts (a display stretch lifts the
 * faint disc to a flat plateau that ends at the mask), at one brightness and in warm Hubble colour at any distance —
 * against a web whose light is blue and falls off with depth (undertime/webVolume.ts FOG). Now:
 *   SOFT_MIP, SOFT_FROM  the outskirts (from SOFT_FROM of the tile's half-width out) are read from a blurred mip,
 *                        so the cut-out's rim becomes a falloff, and a round window (WINDOW, tile half-widths) takes
 *                        them to nothing before the quad's edge — no square, no rim
 *   DESTRETCH            the photo's stretch undone, roughly: light ∝ luminance^DESTRETCH, so the core keeps its
 *                        light and the plateau of the outer disc sinks into the dark as a real disc's exponential does
 *   the web's fog        a galaxy's light falls with its distance as the web's own does (e-folding over FOG box
 *                        units), and turns toward the web's pale blue as it fades (WEB_TINT, at most COOL of it):
 *                        the far ones are faint bluish smudges in the filaments, the near ones keep their colour
 */
const SOFT_MIP = 4;
const SOFT_FROM: [number, number] = [0.35, 0.8];
const WINDOW: [number, number] = [0.6, 0.97];
const DESTRETCH = 1.45;
/** the web's pale filament colour (webVolume.ts palette), normalised to luminance 1 */
const WEB_TINT: [number, number, number] = [0.75, 1.02, 1.5];
const COOL = 0.55;
/** the share of the web's tint even the nearest galaxy takes (the same check): unfogged, the near ones kept the
 * photographs' full warm Hubble colour and contrast, cut-outs laid on a blue web; a quarter of its light in the
 * web's colour makes them seen THROUGH its light, as the far ones are */
const COOL_NEAR = 0.25;
/**
 * THE FOCUS (the same review: "this galaxy to the left of our actual Milky Way … stays there for way too long … make
 * sure it goes away so that once we are in the zoom we can focus on the Milky Way"): from the zoom's start (`focus`,
 * act.ts) the other galaxies near ours on the sky go out — inside FOCUS_CONE degrees beyond ours' own angular radius
 * ×1.5 (its disc as drawn), softly to nothing over FOCUS_SOFT more. The rest of the field, round the dome, stays.
 */
const FOCUS_CONE = 22;
const FOCUS_SOFT = 25;

/** OUR galaxy's model parameters (the volume reads the same ones). Arms of 18° pitch (13° until 2026-11-01: wound that
 * tight, two arms and their lanes crossed a radius six times and the inclined disc read as nested rings at ~100 s;
 * galaxyModel.ts armWander) */
export const OUR_LOOK = { arms: 2, wind: 1 / Math.tan((18 * Math.PI) / 180), phase: 0.6, seed: 3.7, elliptical: 0 };

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
  /** m, the web's fog length in Get the Drift's world (webVolume.ts FOG × the box's size) */
  fog: F;
  /** 0..1 the zoom into ours has begun (the others near it on the sky go out), ours' centre (world) and angular
   * radius (rad) */
  focus: F;
  oursAt: THREE.Node<'vec3'>;
  oursAngle: F;
}

export function createGalaxies(specs: GalaxySpec[], U: GalaxyUniforms, atlas: GalaxyAtlas): THREE.InstancedMesh {
  const n = specs.length;
  const centre = new Float32Array(n * 4);
  const normal = new Float32Array(n * 4);
  const xAxis = new Float32Array(n * 4);
  const look = new Float32Array(n * 4);
  const tiles = new Float32Array(n * 4);
  const vary = new Float32Array(n * 4);
  specs.forEach((s, i) => {
    centre.set([...s.centre, s.radius], i * 4);
    normal.set([...s.normal, s.appear], i * 4);
    xAxis.set([...s.xAxis, s.brightness], i * 4);
    // (an atlas galaxy has no use for the model's arm phase: its slot carries the birth flare's strength)
    look.set([s.arms, s.wind, s.tile < 0 ? s.phase : (s.flare ?? 1), s.seed + s.elliptical * 1000], i * 4);
    tiles.set([i, s.tile, s.planar ? 1 : 0, s.roll], i * 4);
    // (a modelled galaxy's variant; its flare and knots packed with its hue: hue + 4·knots + 8·flare)
    const v = s.variant ?? { type: 0, bulge: 0, dust: 1, hue: 0, knots: true };
    vary.set([v.type, v.bulge, v.dust, v.hue + (v.knots ? 4 : 0) + ((s.flare ?? 1) > 0.5 ? 8 : 0)], i * 4);
  });
  const C4 = attribute<'vec4'>('galaxyCentre', 'vec4');
  const N4 = attribute<'vec4'>('galaxyNormal', 'vec4');
  const X4 = attribute<'vec4'>('galaxyX', 'vec4');
  const L4 = attribute<'vec4'>('galaxyLook', 'vec4');
  const T4 = attribute<'vec4'>('galaxyTile', 'vec4');
  const V4 = attribute<'vec4'>('galaxyVary', 'vec4');
  const vFlare = step(6, V4.w);
  const vKnots = step(2, V4.w.sub(vFlare.mul(8)));
  const vHue = V4.w.sub(vFlare.mul(8)).sub(vKnots.mul(4));
  const kind = V4.x.round();
  const isKind = (k: number): F => step(abs(kind.sub(k)), 0.5);
  const isOurs = step(T4.x, 0.5);
  // the analytic model (ours, and the modelled field: tile −1)
  const modelled = max(isOurs, step(T4.y, -0.5));
  const others = modelled.sub(isOurs);
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
  const turnedModel = normalize(N0.sub(toEye.mul(d)).add(vec3(1e-6, 0, 0))).mul(Math.sin(TILT_MAX_MODEL)).add(toEye.mul(d.greaterThanEqual(0).select(Math.cos(TILT_MAX_MODEL), -Math.cos(TILT_MAX_MODEL))));
  const N = isOurs
    .greaterThan(0.5)
    .select(N0, others.greaterThan(0.5).select(abs(d).lessThan(Math.cos(TILT_MAX_MODEL)).select(turnedModel, N0), abs(d).lessThan(Math.cos(TILT_MAX)).select(turned, N0)));
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
  const planar = max(T4.z, isOurs).min(1);
  // the birth flare's strength: an atlas galaxy carries it in its look's phase slot, a modelled one (always planar,
  // so it has no use for a billboard's roll) in the roll slot; ours always flares
  const flareK = mix(mix(L4.z, vFlare, others), float(1), isOurs);
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
  // (the focus: the others near ours on the sky go out as the zoom starts)
  const oursW = cameraPosition.add(U.skyTurn.mul(U.oursAt.sub(cameraPosition)));
  const offOurs = acos(toEye.negate().dot(normalize(oursW.sub(cameraPosition))).clamp(-1, 1));
  const cone = U.oursAngle.mul(1.5).add((FOCUS_CONE * Math.PI) / 180);
  const aside = smoothstep(cone, cone.add((FOCUS_SOFT * Math.PI) / 180), offOurs);
  const focused = float(1).sub(U.focus.mul(float(1).sub(aside)));
  // (the web's fog over the distance)
  const fogged = exp(cameraPosition.sub(centreW).length().div(U.fog).negate());
  const present = mix(U.field.mul(focused), U.ours, isOurs).mul(lit);
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
    // (VARIETY: an irregular's coordinates warped and stretched off-centre)
    const irr = isKind(GALAXY_TYPE.irregular).mul(others);
    const warp = vec2(mx_noise_float(vec3(q.mul(1.3), seed)), mx_noise_float(vec3(q.mul(1.3), seed.add(7.7))));
    const qf = q.add(warp.mul(irr.mul(0.45))).mul(vec2(irr.mul(0.4).add(1), 1));
    const face = galaxyFace(vec2(qf.x, qf.y), { arms: L4.x, wind: L4.y, phase: L4.z, seed, elliptical });
    const edge = float(1).sub(smoothstep(1.1, EXTENT, q.length()));
    const qr0 = q.length();
    // the kinds galaxyFace does not draw, from the same few profiles (light per unit area, its own dust)
    const lentic = vec3(...WARM_CORE).mul(exp(qr0.div(0.08).negate()).mul(2.0)).add(vec3(0.95, 0.93, 0.88).mul(exp(qr0.div(0.24).negate()).mul(0.55)));
    const lenticTau = exp(qr0.sub(0.45).div(0.06).pow(2).negate()).mul(0.5);
    const eq = vec2(q.x, q.y.div(EDGE_THICK / 0.3));
    const edgeOn = vec3(0.95, 0.93, 0.9)
      .mul(exp(abs(q.x).div(0.3).negate()).mul(exp(abs(q.y).div(EDGE_THICK).negate())).mul(2.2))
      .add(vec3(...WARM_CORE).mul(exp(vec2(q.x, q.y.div(0.75)).length().div(0.08).negate()).mul(1.6)));
    const edgeTau = exp(q.y.sub(EDGE_THICK * 0.15).div(EDGE_THICK * 0.32).pow(2).negate())
      .mul(exp(abs(q.x).div(0.55).negate()))
      .mul(mx_noise_float(vec3(eq.mul(6), seed)).mul(0.35).add(0.85))
      .mul(2.6);
    const bar = vec3(...WARM_CORE).mul(exp(abs(q.x).div(BAR * 0.45).add(abs(q.y).div(0.045)).negate()).mul(1.4)).mul(isKind(GALAXY_TYPE.barred));
    const isLentic = isKind(GALAXY_TYPE.lenticular).mul(others);
    const isEdge = isKind(GALAXY_TYPE.edgeOn).mul(others);
    const dustK = mix(float(1), V4.z, others);
    const faceLit = face.light.add(bar.mul(others)).mul(exp(face.tau.mul(dustK).negate()));
    const kindLit = mix(mix(faceLit, lentic.mul(exp(lenticTau.mul(dustK).negate())), isLentic), edgeOn.mul(exp(edgeTau.mul(dustK).negate())), isEdge);
    // bulge-to-disc, the disc's colour (the core stays warm), the knots or not — the field only, ours as it is
    const core = exp(qr0.div(0.1).negate());
    const bd = float(1).add(V4.y.mul(core)).mul(float(1).sub(irr.mul(0.7).mul(core))).max(0.05);
    const discTint = mix(vec3(...OLD_DISC), vec3(...YOUNG_DISC), vHue.mul(0.5).add(0.5).clamp(0, 1));
    const tint = mix(vec3(...WARM_CORE), discTint, smoothstep(0.06, 0.35, mix(qr0, abs(q.x), isEdge)));
    const lit = kindLit.mul(bd).mul(tint);
    const kLum = lit.dot(vec3(0.2126, 0.7152, 0.0722));
    const varied = mix(lit, discTint.mul(kLum), float(1).sub(vKnots).mul(0.6)).mul(mx_noise_float(vec3(q.mul(5), seed.add(3.1))).mul(irr.mul(0.6)).add(1));
    const modelSharp = mix(varied, face.light.mul(exp(face.tau.negate())), isOurs).mul(edge);
    // (a few pixels across: a smooth bulge and disc in the model's colours, not aliased arms; MODELLED GALAXIES)
    const qr = q.length();
    const blob = vec3(...WARM_CORE)
      .mul(exp(qr.div(0.08).negate()).mul(0.9).mul(bd))
      .add(discTint.mul(exp(mix(qr, vec2(q.x, q.y.div(0.25)).length(), isEdge).div(0.3).negate()).mul(0.22)))
      .mul(edge);
    const px = R.div(dist.mul(U.pixelAngle));
    const model = mix(blob, modelSharp, max(isOurs, smoothstep(MODEL_DETAIL[0], MODEL_DETAIL[1], px)));
    // the atlas: tile (col, row), v = 0 at its top row
    const col = atlasTile.sub(atlasTile.div(atlas.cols).floor().mul(atlas.cols));
    const row = atlasTile.div(atlas.cols).floor();
    const st = vec2(col.add(g.x.clamp(0, 1)).div(atlas.cols), row.add(float(1).sub(g.y.clamp(0, 1))).div(atlas.rows));
    // soft outskirts and a round window (no rim, no square), the photo's stretch undone, the web's fog and tint
    // (INTO THE WEB'S LIGHT above)
    const r = g.sub(0.5).length().mul(2);
    const sharp0 = texture(atlas.texture, st).rgb;
    const near = texture(atlas.texture, st).level(float(2)).rgb;
    const sharp = mix(sharp0, sharp0.min(near.mul(STAR_CLIP)), smoothstep(STAR_FROM[0], STAR_FROM[1], r));
    const soft = texture(atlas.texture, st).level(float(SOFT_MIP)).rgb.min(near.mul(STAR_CLIP));
    const photo = mix(sharp, soft, smoothstep(SOFT_FROM[0], SOFT_FROM[1], r)).sub(0.002).max(0);
    const lum = photo.dot(vec3(0.2126, 0.7152, 0.0722));
    const destretched = photo.mul(lum.max(1e-4).pow(DESTRETCH - 1));
    const cool = vec3(...WEB_TINT).mul(destretched.dot(vec3(0.2126, 0.7152, 0.0722)));
    const real = mix(destretched, cool, max(float(1).sub(fogged).mul(COOL), COOL_NEAR))
      .mul(fogged)
      .mul(float(1).sub(smoothstep(WINDOW[0], WINDOW[1], r)))
      .mul(ATLAS_GAIN);
    // a modelled galaxy of the field: the photos' fog and tint, without their stretch to undo
    const mLum = model.dot(vec3(0.2126, 0.7152, 0.0722));
    const fieldModel = mix(model, vec3(...WEB_TINT).mul(mLum), max(float(1).sub(fogged).mul(COOL), COOL_NEAR)).mul(fogged).mul(MODEL_GAIN);
    const light = mix(mix(real, fieldModel, others), model, isOurs).mul(gain).mul(X4.w);
    return vec4(light.mul(present).mul(tiny.mul(0.7).add(0.3)).mul(U.radiance), 1);
  })();
  material.name = 'drift-galaxies';

  // the flare: its own quad facing the eye (in the galaxy's plane, a disc seen near edge-on squashed it to a
  // sliver), its radius from the galaxy's final angular size (0.7°–5°), swelling as it rises and drawing in
  // as it falls; empty when not flaring
  const flareR = C4.w.div(dist).mul(1.3).clamp(0.012, 0.09);
  const swell = mix(0.5, 1, smoothstep(-FLARE_RISE, 0, since)).mul(mix(1, 0.65, smoothstep(0, FLARE_FALL * 3, since)));
  const flashHalf = dist.mul(flareR).mul(swell).mul(2).mul(step(0.002, flare.mul(flareK)));
  // its colour: the galaxy's own (the tile's mean, from the atlas's last mips), hot white at the core
  const tileC = vec2(atlasTile.sub(atlasTile.div(atlas.cols).floor().mul(atlas.cols)).add(0.5).div(atlas.cols), atlasTile.div(atlas.cols).floor().add(0.5).div(atlas.rows));
  const mean = mix(texture(atlas.texture, tileC).level(float(9)).rgb, vec3(0.9, 0.85, 0.75), modelled);
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
    return vec4(c.mul(flare).mul(flareK).mul(X4.w).mul(mix(U.field, U.ours, isOurs)).mul(U.radiance), 1);
  })();
  flashMaterial.name = 'drift-galaxy-flashes';

  const geometry = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, n);
  geometry.setAttribute('galaxyCentre', new THREE.InstancedBufferAttribute(centre, 4));
  geometry.setAttribute('galaxyNormal', new THREE.InstancedBufferAttribute(normal, 4));
  geometry.setAttribute('galaxyX', new THREE.InstancedBufferAttribute(xAxis, 4));
  geometry.setAttribute('galaxyLook', new THREE.InstancedBufferAttribute(look, 4));
  // (the tile and the variant share one interleaved buffer: with the position, uv and instance matrix that is WebGPU's 8)
  const tv = new Float32Array(n * 8);
  for (let i = 0; i < n; i++) {
    tv.set(tiles.subarray(i * 4, i * 4 + 4), i * 8);
    tv.set(vary.subarray(i * 4, i * 4 + 4), i * 8 + 4);
  }
  const tvBuffer = new THREE.InstancedInterleavedBuffer(tv, 8);
  geometry.setAttribute('galaxyTile', new THREE.InterleavedBufferAttribute(tvBuffer, 4, 0));
  geometry.setAttribute('galaxyVary', new THREE.InterleavedBufferAttribute(tvBuffer, 4, 4));
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
