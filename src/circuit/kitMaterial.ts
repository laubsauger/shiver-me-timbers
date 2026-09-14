/**
 * RACE KIT SURFACES (§T.194) — the rock garden's tidal granite, the cay's
 * strandline, the drowned town's rubble. TSL, composed through the hooks the
 * sierra material exposes for `kit:` islands (src/island/kitIsland.ts), so the
 * granite underneath is the raft's granite (§V95) and only what makes a RACE
 * island read at 5-30 m is written here.
 *
 * WHAT A BOAT SEES GOING PAST A GRANITE KNOB IN THE SEA (research: rocky-shore
 * zonation, Stephenson & Stephenson 1949; exfoliation, Martel 2006):
 *
 *   splash   orange/yellow lichen patches and salt-white crust — only as high
 *            as the spray reaches, so higher on the face turned to the swell
 *   black    the Verrucaria zone: a tar-black band a metre or so tall, the
 *            single strongest "this is a sea rock" cue
 *   barnacle a grey-white crusted band just above still water, mussel clusters
 *            in its lower half
 *   subtidal olive/brown algae mats, bare rock between, under the §V34 water
 *            lighting (the ground hook runs BEFORE it, so caustics land on it)
 * plus WET rock wherever the swash has been (the sand's own swash memory, so
 * the rock and the beach beside it dry on the same clock), crack networks and
 * joint grooves as relief (the granite's sheeting risers come from the sierra
 * surface), and barnacle bumps.
 *
 * All pattern edges are band-limited on their own coordinate (§V48):
 * `bandLimitedEdge` on crack/joint distances, `periodResolved` fades on every
 * noise field, so at range the zonation keeps its BAND colours (the read from
 * across the course) while the speckle inside them fades to its mean.
 *
 * Cost: one extra sampler (the kit mask layer, 9/9 of the terrain budget), two
 * 3×3 Worley evaluations and ~14 value-noise octaves in the terrain fragment;
 * one Worley and ~9 octaves on the rocks. Measured in docs/speedboat/circuit.md §T194.
 */
import * as THREE from 'three/webgpu';
import { float, mix, normalWorldGeometry, positionLocal, positionWorld, texture, uniform, vec2, vec3 } from 'three/tsl';
import { fbm2, cellular2, valueNoise2 } from '../terrain/noise';
import { bandLimitedEdge, coordFilter, periodResolved } from '../ship/bandLimit';
import { reliefNormal } from '../ship/surfaceRelief';
import { sierraParams, type SierraParams } from '../params/sierra';
import { createSierraRockMaterial, createSierraTerrainMaterial, type SierraKitHooks } from '../island/sierraMaterial';
import { SIERRA_ATLAS_LAYERS, SIERRA_ATLAS_SIZE, resampleRgba8, type SierraAtlas } from '../island/sierraAtlas';
import type { KitMaterialSet } from '../island/kitIsland';
import type { IslandHeightmap } from '../island/heightmap';
import type { KitSurfaceMask } from './kitSurface';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

/** the kit's look numbers (§V16: one object, read at construction and on refresh) */
export const kitSurfaceParams = {
  // tidal zonation, metres above mean sea (scaled up by exposure: `splashLift`)
  subtidalTop: -0.25,
  barnacleTop: 0.45,
  blackTop: 1.25,
  splashTop: 2.9,
  splashLift: 1.1,
  bandWobble: 0.35,
  algaeColor: 0x3b4a22,
  kelpColor: 0x4a3a1c,
  barnacleColor: 0xbdb8aa,
  musselColor: 0x1d222c,
  blackLichenColor: 0x1c1c19,
  orangeLichenColor: 0xd08a2a,
  saltColor: 0xe4e1d6,
  wetDarken: 0.52,
  wetRoughness: 0.14,
  // granite relief (m)
  crackCell: 2.6,
  crackWidth: 0.04,
  crackDepth: 0.03,
  jointSpacing: 9,
  jointWidth: 0.12,
  jointDepth: 0.035,
  grainRelief: 0.02,
  barnacleRelief: 0.025,
  // strandline (sand)
  wrackLow: 0.7,
  wrackHigh: 1.0,
  wrackColor: 0x2e2a17,
  shellColor: 0xe9e2d2,
  duneLift: 1.04,
  // rubble
  rubbleCell: 1.7,
  concreteColor: 0x7f7b73,
  asphaltColor: 0x3a3a3b,
  brickColor: 0x6a4432,
  soilColor: 0x5b4f3a,
  rustColor: 0x7a3d17,
};
export type KitSurfaceParams = typeof kitSurfaceParams;

/** the sierra look the kit islands start from: bare granite, less litter and grus than a forested dome */
export function kitSierraParams(base: SierraParams = sierraParams): SierraParams {
  return {
    ...base,
    // the race islands are low: the whole of every one sits in the sierra's LOW
    // elevation band, whose warm tint read as sand on the granite
    bandLowTint: 0xf4f1ec,
    bandStrength: base.bandStrength * 0.5,
    // grus only on the flattest pockets; a wave-washed knob is bare
    coverGrusSlope: 3,
    coverBareSlope: 8,
    litterStrength: base.litterStrength * 0.25,
    litterCoverage: base.litterCoverage * 0.5,
    lichenCoverage: Math.min(base.lichenCoverage * 1.2, 1),
    // the rounded pirate-style boulders are replaced by the kit's angular blocks (kitDecor.ts)
    erraticCount: 0,
    inlandBouldersPerRadius: 0,
    outcropsPerRadius: 0,
    // and no talus aprons: debris on a 5 m dune is sand, not a scree of round rocks
    talusDebrisMin: Number.POSITIVE_INFINITY,
    // a fallen block of kit granite is sea-worn, not a bright fresh fracture
    rockFreshStrength: base.rockFreshStrength * 0.3,
    // the sierra's two joint lattices plus the kit's own two sets drew a four-way crack net over every knob
    jointStrength: base.jointStrength * 0.35,
  };
}

const color = (hex: number) => uniform(new THREE.Color(hex));

function createKitUniforms(p: KitSurfaceParams = kitSurfaceParams) {
  return {
    waterLevel: uniform(0),
    swell: uniform(0.5),
    subtidalTop: uniform(p.subtidalTop),
    barnacleTop: uniform(p.barnacleTop),
    blackTop: uniform(p.blackTop),
    splashTop: uniform(p.splashTop),
    splashLift: uniform(p.splashLift),
    bandWobble: uniform(p.bandWobble),
    algaeColor: color(p.algaeColor),
    kelpColor: color(p.kelpColor),
    barnacleColor: color(p.barnacleColor),
    musselColor: color(p.musselColor),
    blackLichenColor: color(p.blackLichenColor),
    orangeLichenColor: color(p.orangeLichenColor),
    saltColor: color(p.saltColor),
    wetDarken: uniform(p.wetDarken),
    wetRoughness: uniform(p.wetRoughness),
    crackCell: uniform(p.crackCell),
    crackWidth: uniform(p.crackWidth),
    crackDepth: uniform(p.crackDepth),
    jointSpacing: uniform(p.jointSpacing),
    jointWidth: uniform(p.jointWidth),
    jointDepth: uniform(p.jointDepth),
    grainRelief: uniform(p.grainRelief),
    barnacleRelief: uniform(p.barnacleRelief),
    wrackLow: uniform(p.wrackLow),
    wrackHigh: uniform(p.wrackHigh),
    wrackColor: color(p.wrackColor),
    shellColor: color(p.shellColor),
    duneLift: uniform(p.duneLift),
    rubbleCell: uniform(p.rubbleCell),
    concreteColor: color(p.concreteColor),
    asphaltColor: color(p.asphaltColor),
    brickColor: color(p.brickColor),
    soilColor: color(p.soilColor),
    rustColor: color(p.rustColor),
  };
}
type KitUniforms = ReturnType<typeof createKitUniforms>;

/** screen footprint of a 2D field coordinate, the wider axis (sierraMaterial's `fieldFilter`) */
function fieldFilter(coord: AnyNode): AnyNode {
  const f = coordFilter(coord);
  return f.x.max(f.y);
}

/** a [0,1] noise field faded to its mean (0.5) once its period is sub-pixel (§V48b) */
function fadedFbm(coord: AnyNode, octaves: number): AnyNode {
  return mix(float(0.5), fbm2(coord, octaves), periodResolved(coord, fieldFilter(coord)));
}

/**
 * The "slope-aware" planar coordinate: world xz pushed along the face's own
 * horizontal normal by the height, so a near-vertical face gets variation UP
 * the face instead of one noise value smeared down it. Cheaper than three
 * planar projections and continuous everywhere.
 */
function faceCoord(): AnyNode {
  // unfolded onto the slope: along the fall line of a face at θ the xz step is
  // cos θ and the height step sin θ, and tan(θ/2) = n.xz/(1 + n.y) turns the pair
  // back into one metre per metre, flats (n.y = 1) to walls (n.y = 0)
  const n = normalWorldGeometry;
  return positionWorld.xz.sub(n.xz.div(n.y.add(1)).mul(positionWorld.y));
}

interface Zonation {
  albedo: AnyNode;
  roughness: AnyNode;
  relief: AnyNode;
}

/**
 * GRANITE IN THE SEA: relief (cracks, joints, grain) and the tidal bands over a
 * granite albedo. `wet` 0..1 is where the water has just been.
 */
function graniteZonation(
  granite: { albedo: AnyNode; roughness: AnyNode },
  exposure: AnyNode,
  wet: AnyNode,
  jointDirA: AnyNode,
  jointDirB: AnyNode,
  localXZ: AnyNode,
  u: KitUniforms,
  /** a loose block: its whole height sits in the tidal bands, so they are laid on thinner */
  block = false,
): Zonation {
  const bandOpacity = block ? 0.55 : 1;
  const wc = faceCoord();
  const y = positionWorld.y;

  // ── relief: a crack network (Worley F2−F1), two joint sets, fine grain ────
  const crackCoord = wc.add(vec2(fbm2(wc.mul(0.21), 2), fbm2(wc.mul(0.21).add(7.3), 2)).sub(0.5).mul(1.6)).div(u.crackCell);
  const cells = cellular2(crackCoord);
  const crackDist = cells.y.sub(cells.x);
  const crackFilter = fieldFilter(crackCoord);
  const patches = fadedFbm(wc.mul(0.09), 3);
  // cracks run where the rock is jointed and the surf works it — a net over a whole dome read as crazy paving
  // @band-limited-elsewhere: elevation gate on world height (the splash zone), not a spatial period
  const surfWorked = positionWorld.y.smoothstep(3.5, 1.0);
  const crackLine = bandLimitedEdge(crackDist, crackCoord.x, u.crackWidth.div(u.crackCell), crackFilter)
    .oneMinus()
    .mul(patches.smoothstep(0.5, 0.64))
    .mul(surfWorked);
  const jointCoordA = localXZ.dot(jointDirA).div(u.jointSpacing);
  const jointCoordB = localXZ.dot(jointDirB).div(u.jointSpacing);
  // @band-limited-elsewhere: this fract is the INPUT to bandLimitedEdge, which filters on the joint width
  const jointDistA = jointCoordA.add(fbm2(wc.mul(0.05), 2).mul(0.6)).add(0.5).fract().sub(0.5).abs();
  // @band-limited-elsewhere: same as above, second joint set
  const jointDistB = jointCoordB.add(fbm2(wc.mul(0.05).add(3.1), 2).mul(0.6)).add(0.5).fract().sub(0.5).abs();
  const jointFeature = u.jointWidth.div(u.jointSpacing);
  const joints = bandLimitedEdge(jointDistA, jointCoordA, jointFeature)
    .oneMinus()
    .max(bandLimitedEdge(jointDistB, jointCoordB, jointFeature).oneMinus())
    // joints are patchy: they bite where the patch field says the rock is jointed
    .mul(patches.smoothstep(0.42, 0.62));
  const grainCoord = wc.mul(3.1);
  const grain = fadedFbm(grainCoord, 2);
  let relief: AnyNode = crackLine
    .mul(u.crackDepth)
    .negate()
    .sub(joints.mul(u.jointDepth))
    .add(grain.sub(0.5).mul(u.grainRelief).mul(2));

  // ── zonation heights, wobbled so no band is a contour line ────────────────
  const lift = exposure.mul(u.splashLift);
  const midCoord = wc.mul(0.6);
  const mid = fadedFbm(midCoord, 3);
  const wobble = patches.sub(0.5).mul(u.bandWobble).mul(2).add(mid.sub(0.5).mul(0.3));
  const yb = y.add(wobble);
  const barnacleTop = u.barnacleTop.add(lift.mul(0.4));
  const blackTop = u.blackTop.add(lift.mul(0.8));
  const splashTop = u.splashTop.add(lift.mul(1.4));
  // @band-limited-elsewhere: elevation bands on world height (≥ 0.2 m wide), not a spatial period
  const subtidal = yb.smoothstep(u.subtidalTop.add(0.15), u.subtidalTop.sub(0.2));
  // @band-limited-elsewhere: elevation band
  const barnacleBand = yb.smoothstep(u.subtidalTop.sub(0.3), u.subtidalTop.add(0.1)).mul(yb.smoothstep(barnacleTop.add(0.1), barnacleTop.sub(0.2)));
  // @band-limited-elsewhere: elevation band
  const blackBand = yb.smoothstep(barnacleTop.sub(0.25), barnacleTop.add(0.1)).mul(yb.smoothstep(blackTop.add(0.1), blackTop.sub(0.4)));
  // @band-limited-elsewhere: elevation band
  const splashBand = yb.smoothstep(blackTop.sub(0.3), blackTop.add(0.4)).mul(yb.smoothstep(splashTop.add(0.3), splashTop.sub(1.1)));

  // ── patterns inside the bands (each faded to its mean when sub-pixel) ─────
  const speckCoord = wc.mul(22);
  const speck = mix(float(0.5), valueNoise2(speckCoord), periodResolved(speckCoord, fieldFilter(speckCoord)));
  const clumpCoord = wc.mul(2.2);
  const clump = fadedFbm(clumpCoord, 2);

  let albedo: AnyNode = granite.albedo;
  let roughness: AnyNode = granite.roughness;

  // splash: orange lichen rosettes and salt crust over the granite
  const orange = clump.smoothstep(0.6, 0.7).mul(mid.smoothstep(0.42, 0.6)).mul(splashBand).mul(float(0.3).add(exposure.mul(0.7)));
  albedo = mix(albedo, u.orangeLichenColor, orange.mul(0.8));
  // salt crust in soft drifts (a thresholded fine lattice noise reads as pixels)
  const salt = clump.mul(0.6).add(mid.mul(0.4)).smoothstep(0.55, 0.72).mul(splashBand).mul(exposure).mul(0.45);
  albedo = mix(albedo, u.saltColor, salt);
  roughness = mix(roughness, float(0.9), orange.max(salt));

  // black zone: tar-black, soft holes where the granite shows through
  const blackCover = blackBand.mul(float(1).sub(mid.smoothstep(0.55, 0.75).mul(0.8)));
  albedo = mix(albedo, u.blackLichenColor, blackCover.mul(0.72 * bandOpacity));
  roughness = mix(roughness, float(0.6), blackCover);

  // barnacles: a fine grey-white crust over dark rock, mussel beds in the lower half
  // the crust's COVER follows the 45 cm clumps; the speck only breaks its tone (a thresholded lattice noise reads as pixels)
  const crust = clump.smoothstep(0.3, 0.62).mul(speck.mul(0.5).add(0.6));
  const lower = yb.smoothstep(barnacleTop.sub(0.15), u.subtidalTop.add(0.1));
  const mussel = barnacleBand.mul(clump.smoothstep(0.44, 0.34)).mul(lower);
  albedo = mix(albedo, albedo.mul(0.42), barnacleBand.mul(bandOpacity));
  albedo = mix(albedo, u.barnacleColor, barnacleBand.mul(crust).mul(0.75));
  albedo = mix(albedo, u.musselColor, mussel.mul(0.9));
  roughness = mix(roughness, float(0.8), barnacleBand.mul(crust));
  // the barnacle bumps ride the crust pattern only; the band (a height compare) stays out of the relief for the same reason
  relief = relief.add(crust.mul(u.barnacleRelief)).add(clump.smoothstep(0.44, 0.34).mul(0.02));

  // subtidal: soft algae mats with darker bare rock between
  const algae = subtidal.mul(mid.smoothstep(0.36, 0.58));
  const algaeTone = mix(u.algaeColor, u.kelpColor, clump);
  albedo = mix(albedo, albedo.mul(0.5), subtidal);
  albedo = mix(albedo, algaeTone, algae.mul(0.85));
  roughness = mix(roughness, float(0.35), subtidal);

  // wet where the water has just been: darker, glossy (the bands stay readable)
  albedo = albedo.mul(float(1).sub(wet.mul(u.wetDarken).mul(bandOpacity)));
  roughness = mix(roughness, u.wetRoughness, wet.mul(bandOpacity));
  // a crack is shadowed and holds water
  albedo = albedo.mul(float(1).sub(crackLine.mul(0.22)).sub(joints.mul(0.14)));

  return { albedo, roughness, relief };
}

/** DUNE SAND + STRANDLINE: a narrow wrack line of weed clumps, shell litter, paler dry dune sand */
function strandline(sand: { albedo: AnyNode; roughness: AnyNode }, strand: AnyNode, wet: AnyNode, u: KitUniforms): Zonation {
  const wc = positionWorld.xz;
  const y = positionWorld.y;
  // the line wanders alongshore by ±25 cm of height — on a 1:15 beach that is ±4 m of run
  const wobble = fadedFbm(wc.mul(0.03), 2).sub(0.5).mul(0.5);
  const yw = y.add(wobble);
  // @band-limited-elsewhere: elevation band on world height (0.12 m ramps), not a spatial period
  const wrackBand = yw.smoothstep(u.wrackLow.sub(0.12), u.wrackLow).mul(yw.smoothstep(u.wrackHigh, u.wrackHigh.sub(0.12)));
  const clumpCoord = wc.mul(vec2(1.6, 1.6));
  const clump = fadedFbm(clumpCoord, 3);
  const wrack = wrackBand.mul(clump.smoothstep(0.52, 0.66)).mul(strand);
  const shellCoord = wc.mul(5);
  const shellField = mix(float(0.5), valueNoise2(shellCoord), periodResolved(shellCoord, fieldFilter(shellCoord)));
  // shells gather at and below the wrack line; the threshold keeps its own fade so a far beach just brightens slightly
  // @band-limited-elsewhere: elevation band on world height
  const shellZone = yw.smoothstep(0.1, 0.5).mul(yw.smoothstep(1.4, 0.9)).mul(strand);
  const shells = shellField.smoothstep(0.7, 0.8).mul(shellZone);
  // @band-limited-elsewhere: elevation band on world height (dry dune above the swash reach)
  const dune = y.smoothstep(1.2, 2.6);
  const luma = sand.albedo.dot(vec3(0.3, 0.59, 0.11));
  let albedo: AnyNode = mix(sand.albedo, mix(vec3(luma, luma, luma), sand.albedo, 0.62).mul(u.duneLift), dune);
  albedo = mix(albedo, u.wrackColor, wrack.mul(0.8));
  albedo = mix(albedo, u.shellColor, shells.mul(float(1).sub(wet)).mul(0.6));
  const roughness = mix(sand.roughness, float(0.75), wrack);
  return { albedo, roughness, relief: float(0) };
}

/** RUBBLE: soil and weeds with concrete, asphalt and brick fragments showing through it */
function rubbleGround(base: { albedo: AnyNode; roughness: AnyNode }, rubble: AnyNode, wet: AnyNode, u: KitUniforms): Zonation {
  const wc = positionWorld.xz;
  const y = positionWorld.y;
  const cellCoord = wc.add(vec2(fbm2(wc.mul(0.3), 2), fbm2(wc.mul(0.3).add(5.1), 2)).sub(0.5).mul(0.9)).div(u.rubbleCell);
  const cells = cellular2(cellCoord);
  const id = cells.z;
  const gap = bandLimitedEdge(cells.y.sub(cells.x), cellCoord.x, float(0.09), fieldFilter(cellCoord)).oneMinus();
  const tone = fadedFbm(wc.mul(2.3), 2);
  const cover = fadedFbm(wc.mul(0.25), 3);
  // most of the ground is soil; fragments show where the soil is thin
  const fragment = cover.smoothstep(0.52, 0.66).mul(id.smoothstep(0.15, 0.2)).mul(0.85);
  const concrete = id.smoothstep(0.68, 0.64);
  const asphalt = id.smoothstep(0.64, 0.68).mul(id.smoothstep(0.86, 0.82));
  const brick = id.smoothstep(0.82, 0.86);
  const frag: AnyNode = u.concreteColor.mul(concrete).add(u.asphaltColor.mul(asphalt)).add(u.brickColor.mul(brick).mul(0.8));
  let albedo: AnyNode = mix(u.soilColor, frag, fragment.mul(float(1).sub(gap))).mul(tone.mul(0.3).add(0.85));
  // weeds on the soil above the splash line
  // @band-limited-elsewhere: elevation band on world height
  const weeds = y.smoothstep(1.2, 2.4).mul(float(1).sub(fragment)).mul(cover.smoothstep(0.55, 0.35));
  albedo = mix(albedo, vec3(0.2, 0.22, 0.11), weeds.mul(0.7));
  const rust = fadedFbm(wc.mul(0.6), 2).smoothstep(0.66, 0.78).mul(concrete).mul(fragment);
  albedo = mix(albedo, u.rustColor, rust.mul(0.35));
  // under the surf the rubble takes the algae and the wet like the rock does
  // @band-limited-elsewhere: elevation band on world height
  const sub = y.smoothstep(0.3, -0.4);
  albedo = mix(albedo, mix(albedo.mul(0.5), u.algaeColor, cover.smoothstep(0.4, 0.6).mul(0.7)), sub);
  albedo = albedo.mul(float(1).sub(wet.mul(u.wetDarken)));
  let roughness: AnyNode = mix(float(0.9), float(0.62), asphalt.mul(fragment));
  roughness = mix(roughness, u.wetRoughness, wet);
  // the pattern is a shore feature: it fades out down the bench, where it only read as crazing through the water
  // @band-limited-elsewhere: elevation band on world height
  const shoreOnly = rubble.mul(y.smoothstep(-3.5, -1.5));
  const relief = gap.mul(fragment).mul(-0.04);
  return {
    albedo: mix(base.albedo, albedo, shoreOnly),
    roughness: mix(base.roughness, roughness, shoreOnly),
    relief: relief.mul(shoreOnly),
  };
}

// ── the mask atlas ─────────────────────────────────────────────────────────

function createMaskTexture(layers: number): THREE.DataArrayTexture {
  const size = SIERRA_ATLAS_SIZE;
  const tex = new THREE.DataArrayTexture(new Uint8Array(size * size * 4 * layers), size, size, layers);
  tex.name = 'island/kitSurface';
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  // §V48: minified from across the course; each layer mips on its own
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export interface KitMaterialDeps {
  /** the island's baked mask (kitRender memoises it per heightmap) */
  maskFor(hm: IslandHeightmap): KitSurfaceMask;
  sierra?: SierraParams;
  surface?: KitSurfaceParams;
}

export function createKitMaterialSet(atlas: SierraAtlas, deps: KitMaterialDeps): KitMaterialSet {
  const u = createKitUniforms(deps.surface);
  const sp = deps.sierra ?? kitSierraParams();
  const maskTex = createMaskTexture(SIERRA_ATLAS_LAYERS);
  const maskAt = (localXZ: AnyNode): AnyNode =>
    texture(maskTex, localXZ.div(atlas.uniforms.radius.mul(2)).add(0.5)).depth(atlas.uniforms.layer.toInt());

  const hooks: SierraKitHooks = {
    terrain(ctx) {
      const mask = maskAt(positionLocal.xz);
      const up = normalWorldGeometry.y;
      // a face too steep to hold sand is rock whatever the mask says
      // @band-limited-elsewhere: slope compare on the geometric normal, no period
      const steep = up.smoothstep(0.78, 0.62);
      const bedrock = mask.r.max(steep.mul(float(1).sub(mask.g)));
      const rubble = mask.g.mul(float(1).sub(bedrock));
      const exposure = mask.b;
      const wet = ctx.sand.wet;
      const granite = graniteZonation(
        { albedo: ctx.surface.albedo, roughness: ctx.surface.roughness },
        exposure,
        wet,
        ctx.jointDirA,
        ctx.jointDirB,
        ctx.localXZ,
        u,
      );
      const sandLayer = strandline({ albedo: ctx.sand.color, roughness: ctx.sand.roughness }, mask.a, wet, u);
      const ground = rubbleGround(sandLayer, rubble, wet, u);
      const albedo = mix(ground.albedo, granite.albedo, bedrock);
      const roughness = mix(ground.roughness, granite.roughness, bedrock);
      // NOT the sierra sheet risers: they are a function of world height, which is linear per triangle,
      // so their screen-space gradient steps at every triangle edge and drew the 3 m mesh as a crack net
      const relief = mix(ground.relief, granite.relief, bedrock);
      const solid = bedrock.add(rubble).clamp(0, 1);
      return {
        albedo,
        roughness,
        emissiveGate: float(1).sub(bedrock).mul(float(1).sub(rubble)),
        normal: mix(ctx.sand.reliefNormal, reliefNormal(relief, float(1)), solid).normalize(),
      };
    },
    rock(ctx) {
      const mask = maskAt(ctx.localXZ);
      const y = positionWorld.y;
      // no swash model on a block: wet up to the live sea plus a swell-scaled splash
      // @band-limited-elsewhere: elevation compare against the live water level, no period
      const wet = y.sub(u.waterLevel).smoothstep(u.swell.mul(0.6).add(0.3), float(0));
      const z = graniteZonation(
        { albedo: ctx.surface.albedo, roughness: ctx.surface.roughness },
        mask.b,
        wet,
        ctx.jointDirA,
        ctx.jointDirB,
        ctx.localXZ,
        u,
        true,
      );
      return { albedo: z.albedo, roughness: z.roughness, normal: reliefNormal(z.relief, float(1)) };
    },
  };

  const terrain = createSierraTerrainMaterial(sp, { atlas, kit: hooks });
  const rock = createSierraRockMaterial(sp, { atlas, kit: hooks });
  const bound = new Set<IslandHeightmap>();
  const layerBytes = SIERRA_ATLAS_SIZE * SIERRA_ATLAS_SIZE * 4;

  return {
    terrain,
    rock,
    bind(hm, layer) {
      if (bound.has(hm)) return;
      bound.add(hm);
      const m = deps.maskFor(hm);
      resampleRgba8(m.bytes, 0, m.size, maskTex.image.data as Uint8Array, layer * layerBytes, SIERRA_ATLAS_SIZE);
      maskTex.needsUpdate = true;
    },
    tag() {
      // the kit reads the sierra atlas's own object-group uniforms (layer, radius): nothing extra to stamp
    },
    update(frame) {
      u.waterLevel.value = frame.waterLevel;
      u.swell.value = frame.swell;
    },
    dispose() {
      terrain.dispose();
      rock.dispose();
      maskTex.dispose();
    },
  };
}
