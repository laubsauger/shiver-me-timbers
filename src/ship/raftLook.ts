/**
 * THE FILM RAFT'S SURFACES — the game's raft families (src/ship/raftMaterials*.ts) re-dressed for a camera at
 * 5–15 m, in sun and against it.
 *
 * The user, of the chase shots (2026-10-29): "a bunch of textures on the raft are just super weird … the textures
 * are too weak; we don't get a nice parallax effect", and of the backlit morning at 545 s: "all the textures in the
 * sun, especially backlit, look all the same — not pretty … I DO like the mossy line on the wood (the logs'
 * texture) — keep it". The game's families are procedural patterns over a mean tone, built for a deck seen from a
 * walking eye and held to a sampler budget (§V40) the film does not have; at the film's range they read as one
 * flat tan. So for the pieces that fill a close frame — the cabin's woven walls, its thatch, the boards, the deck
 * mats — the film swaps in materials of its own (the logs keep the game's balsa, moss line and all):
 *
 *   REAL SCANS (Poly Haven, CC0; scripts/drift-raft-pack.py): woven split bamboo on its battens, angled reed
 *     thatch, weathered planks, split cane — their colour, roughness, occlusion and normal as scanned.
 *   PARALLAX OCCLUSION: each scan's height MARCHED along the view ray, so a batten stands proud of the weave, a
 *     course of reeds overhangs the next, a board's gap is a slot — and shifts against the surface as the eye
 *     moves. Planar per box face (these pieces are boxes, src/ship/pieceGeometryWear.ts's worn ones), faded out
 *     where a texel of height goes sub-pixel.
 *   DISTINCT CHARACTER per material, which is what tells them apart against the light: bleached dry bamboo with
 *     the sun SHINING THROUGH the weave's gaps when it is behind the wall (thin woven cane is translucent); thatch
 *     whose fibres catch a rim (sheen); boards dark and wet low, salt-rimed above the wet, grey and dry on top;
 *     hemp with a fibre sheen. Each with its own albedo and roughness range, so a rim light separates them.
 *   WEATHERING: sun-bleach on what faces the sky, grime and salt in the cavities and low on the walls, the
 *     corners darker, the water's wet band and caustics (the game's shipWater) where the sea reaches.
 *
 * `ready` resolves when the scans are loaded (the raft's own `ready`, awaited before a frame is drawn).
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  cameraPosition,
  dFdx,
  dFdy,
  float,
  max,
  mix,
  modelWorldMatrixInverse,
  normalLocal,
  normalWorld,
  positionLocal,
  positionWorld,
  select,
  smoothstep,
  texture,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { MaterialFactory } from './shipAssembly';
import type { PieceKind } from './pieceTypes';
import { createRaftPieceUniforms, shipWater } from './raftMaterialNodes';
import { bambooDeckVariantOf } from './raftMaterialsWeave';
import { shipLocalFrame } from './woodMaterial';
import { hash2, triplanarFbm } from '../terrain/noise';
import { shipSunDirectionOverride } from './sailMaterial';
import { raftParams } from '../params/raft';
import { createWornSail } from './raftSailWear';
import { createHighlightNodes } from './raftHighlight';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL nodes
type N = any;

/** the packed scans (public/textures/raft/raft_*, scripts/drift-raft-pack.py): m a tile covers on the piece (Poly
 * Haven's own, the thatch's ×1.6: its reeds at 0.54 m were straws), m of relief the height spans, the mean colour
 * (linear) and roughness the pack printed */
const SCANS = {
  wall: { file: 'raft_bamboo_wall_03', tile: 1.85, depth: 0.018, mean: [0.306, 0.1767, 0.0936], rough: 0.838 },
  thatch: { file: 'raft_thatch_roof_angled', tile: 0.86, depth: 0.035, mean: [0.0954, 0.0859, 0.0731], rough: 0.893 },
  planks: { file: 'raft_weathered_planks', tile: 2.4, depth: 0.007, mean: [0.0821, 0.0582, 0.0441], rough: 0.736 },
  mat: { file: 'raft_bamboo_wall', tile: 2.0, depth: 0.006, mean: [0.2423, 0.1529, 0.0906], rough: 0.707 },
} as const;
type ScanName = keyof typeof SCANS;
/** texels across a packed map (the pack's SIZE) */
const TEXELS = 1024;
/**
 * THE QUALITY TIERS — one look, its cost scaled (the user, 2026-10-29: "ONE raft for game and film … the game gets
 * LOD/quality tiers, not a different look"). What a tier changes is the parallax march (steps along the view ray:
 * a fixed loop whose every texture read is explicit-gradient) — the scans, the materials, the dressing and the
 * stores are the same at every tier. `film` is the offline render's; the game's three follow its graphics preset
 * (ui/settingsStore Quality). At `low` there is no march: the scans lie flat, their normals still lit.
 */
export type RaftLookTier = 'film' | 'high' | 'medium' | 'low';
const STEPS: Record<RaftLookTier, number> = { film: 18, high: 12, medium: 7, low: 0 };

interface LoadedScan {
  a: THREE.Texture;
  b: THREE.Texture;
}

const loads: Promise<unknown>[] = [];
const scans = new Map<ScanName, LoadedScan>();
function scan(name: ScanName): LoadedScan {
  let s = scans.get(name);
  if (s) return s;
  const base = `${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'}textures/raft/`;
  const loader = new THREE.TextureLoader();
  const map = (file: string, srgb: boolean): THREE.Texture => {
    let t!: THREE.Texture;
    loads.push(
      new Promise((ok, fail) => {
        t = loader.load(`${base}${file}.webp`, ok, undefined, () => fail(new Error(`raftLook: ${file} (run scripts/drift-raft-pack.py)`)));
      }),
    );
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 16;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
  };
  s = { a: map(`${SCANS[name].file}_albedo_rough`, true), b: map(`${SCANS[name].file}_normal_ao_h`, false) };
  scans.set(name, s);
  return s;
}

// ---------------------------------------------------------------------------
// THE SUN, for what the light does THROUGH a thing (the scene's own shadowed sun light does the rest), and the
// sails' (sailMaterial.shipSunDirectionOverride: the game's sails face the rig's hour, the film aims its light at
// each act's own Sun). Read off the scene's shadow-casting directional light: sea.ts aims and colours it before
// it poses the raft, whose update calls `sync` — and at render time again, for a frame drawn without one.
const uSunDir = uniform(new THREE.Vector3(0, 1, 0));
const uSunRadiance = uniform(new THREE.Color(0, 0, 0));
const sailSun = new THREE.Vector3(0, 1, 0);
const tracked: { root: THREE.Object3D | null; light: THREE.DirectionalLight | null } = { root: null, light: null };
function readSun(): void {
  if (tracked.light === null && tracked.root !== null) {
    let top: THREE.Object3D = tracked.root;
    while (top.parent) top = top.parent;
    top.traverse((o) => {
      const l = o as THREE.DirectionalLight;
      if (tracked.light === null && l.isDirectionalLight && l.castShadow) tracked.light = l;
    });
  }
  const l = tracked.light;
  if (l === null) return;
  uSunDir.value.subVectors(l.position, l.target.position).normalize();
  // (radiance a white Lambertian surface facing it would send back: E/π)
  uSunRadiance.value.copy(l.color).multiplyScalar(l.intensity / Math.PI);
  sailSun.copy(uSunDir.value);
  shipSunDirectionOverride.direction = sailSun;
}
/** the worn sails' handles: their params are re-read with the sun (the game's refreshShipMaterials keeps its own
 * handles; these are not among them) */
const sails = new Set<ReturnType<typeof createWornSail>>();
uSunDir.onRenderUpdate(() => {
  readSun();
  for (const s of sails) s.refresh();
});

// ---------------------------------------------------------------------------

/** the face of a box a fragment is on, and the two axes its scan is laid along (U → texture u, W → v), local */
interface Face {
  U: N;
  W: N;
  N: N;
}

/** the dominant axis of the local normal picks the face; `axes(k)` lays the scan on the face whose normal is axis k */
function boxFace(axes: (k: 0 | 1 | 2) => [N, N]): Face {
  const n = normalLocal;
  const a = n.abs();
  const isX = a.x.greaterThanEqual(a.y).and(a.x.greaterThanEqual(a.z));
  const isY = isX.not().and(a.y.greaterThanEqual(a.z));
  const [ux, wx] = axes(0);
  const [uy, wy] = axes(1);
  const [uz, wz] = axes(2);
  const pick = (x: N, y: N, z: N): N => select(isX, x, select(isY, y, z));
  return {
    U: pick(ux, uy, uz),
    W: pick(wx, wy, wz),
    N: pick(vec3(n.x.sign(), 0, 0), vec3(0, n.y.sign(), 0), vec3(0, 0, n.z.sign())),
  };
}

interface Marched {
  /** the scan where the view ray meets its relief: colour (linear) + roughness, normal xy + AO + height */
  a: N;
  b: N;
  /** 0 at the surface's top … 1 at the bottom of the relief, where the ray landed */
  hit: N;
  /** the height where the fragment itself is (not where its ray lands): what a hole lets through is HERE */
  heightHere: N;
  /** the shading normal (local) with the scan's normal laid on the face, `strength` × the scan's slopes */
  normal: (strength: number) => N;
}

/**
 * PARALLAX OCCLUSION on one box face: the height (b.a, 1 = the surface) marched along the view ray from the
 * surface down `depth` metres in STEPS layers, the crossing interpolated (the secant between the last two
 * layers). The march runs in the scan's tile units; the shift is the view ray's slope across the face, its
 * grazing end clamped (a ray at 75° from the normal already shifts 3.7 depths). All of it fades out with the
 * texel footprint, so at range it is the flat scan and nothing swims.
 */
function marchScan(name: ScanName, face: Face, offset: N, steps: number, tileScale = 1): Marched {
  const s = scan(name);
  const S = SCANS[name];
  const tile = float(S.tile * tileScale);
  const p = positionLocal;
  // (the offset may step — a wall's panels — so the footprint is taken before it: no seam of blurred mips)
  const uvBase = vec2(p.dot(face.U), p.dot(face.W)).div(tile);
  const uv0 = uvBase.add(offset.div(tile));
  const gx = dFdx(uvBase);
  const gy = dFdy(uvBase);
  const eye = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
  const V = eye.sub(p).normalize();
  const vn = V.dot(face.N).max(0.26);
  const footprint = max(gx.length(), gy.length()).mul(TEXELS);
  const fade = float(1).sub(smoothstep(1.2, 4, footprint));
  const shift = vec2(V.dot(face.U), V.dot(face.W)).div(vn).mul(float(S.depth).div(tile)).mul(fade);
  const heightTex = texture(s.b);
  const depthAt = (q: N): N => float(1).sub(heightTex.sample(q).grad(gx, gy).a);
  const layer = 1 / Math.max(1, steps);
  // (no march at all where it has faded out — at range the loop would still step through the relief at zero
  // shift, every step a texture read for nothing)
  const flatUV: N = uv0;
  const r: N = steps === 0 ? vec3(flatUV, float(1).sub(heightTex.sample(uv0).grad(gx, gy).a).mul(0.5)) : Fn(() => {
    const cur = uv0.toVar();
    const prev = uv0.toVar();
    const d = float(0).toVar();
    const hit = float(0).toVar();
    If(fade.greaterThan(0.01), () => {
      const mapD = depthAt(uv0).toVar();
      Loop(steps, () => {
        If(d.lessThan(mapD), () => {
          prev.assign(cur);
          cur.subAssign(shift.mul(layer));
          d.addAssign(layer);
          mapD.assign(depthAt(cur));
        });
      });
      const after = mapD.sub(d);
      const before = depthAt(prev).sub(d).add(layer);
      const w = after.div(after.sub(before).min(-1e-5)).clamp(0, 1);
      const hitUV: N = mix(cur, prev, w);
      cur.assign(hitUV);
      hit.assign(d.sub(w.mul(layer)).max(0));
    });
    const outUV: N = cur;
    return vec3(outUV, hit);
  })();
  const uv = r.xy;
  const a = texture(s.a, uv).grad(gx, gy);
  const b = texture(s.b, uv).grad(gx, gy);
  return {
    a,
    b,
    hit: r.z.mul(fade),
    heightHere: heightTex.sample(uv0).grad(gx, gy).a,
    normal: (strength) => {
      const t = b.xy.mul(2).sub(1).mul(strength);
      const nz = float(1).sub(t.dot(t)).max(0).sqrt();
      const n = face.U.mul(t.x).add(face.W.mul(t.y)).add(normalLocal.mul(nz)).normalize();
      // NO SUN ON A FACE TURNED FROM IT. A thin wall's shadowed face is barely behind its own lit one in the sun's
      // shadow map (the bias reaches through 5 cm), so a texel whose scanned normal tips sunward lit up: square
      // orange flecks all over a backlit wall. Where the surface itself faces away, the sunward part of the
      // scanned tilt is taken back off.
      const sun = modelWorldMatrixInverse.mul(vec4(uSunDir, 0)).xyz.normalize();
      const away = smoothstep(0.08, -0.04, normalLocal.dot(sun));
      return n.sub(sun.mul(n.dot(sun).max(0).mul(away))).normalize();
    },
  };
}

const luminance = (c: N): N => c.dot(vec3(0.2126, 0.7152, 0.0722));

/** the scan on the film's palette: its own variation about `target` (linear), `contrast` > 1 deepening it */
function onPalette(albedo: N, name: ScanName, target: [number, number, number], contrast: number): N {
  const m = SCANS[name].mean;
  const rel = albedo.div(vec3(m[0], m[1], m[2])).max(1e-4);
  return rel.pow(vec3(contrast)).mul(vec3(...target));
}

/** sunlight coming THROUGH a thin surface at this fragment (radiance, to add as emission): the sun behind it,
 * the eye looking toward the sun the more of it, × `through` (0..1, what the surface lets pass here) */
function transmitted(through: N, tint: N): N {
  const L = uSunDir;
  const behind = normalWorld.dot(L).negate().max(0);
  const toward = positionWorld.sub(cameraPosition).normalize().dot(L).max(0);
  return uSunRadiance.mul(tint).mul(through).mul(behind.mul(float(0.35).add(toward.pow(3).mul(0.65))));
}

// ---------------------------------------------------------------------------

/**
 * THE CABIN'S WALLS: split bamboo plaited in checks on horizontal battens (bamboo_wall_03), the battens standing
 * proud. Bleached to a greying tan by the sun, darker and salt-crusted low where the spray reaches and in the
 * corners where the grime gathers; the sun shines through the plait's gaps when it is behind a wall.
 */
function createWallMaterial(steps: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'drift-raft-wall';
  const piece = createRaftPieceUniforms();
  const X = vec3(1, 0, 0);
  const Y = vec3(0, 1, 0);
  const Z = vec3(0, 0, 1);
  // battens horizontal: u along the panel, v up (a side wall's face is x-normal, a gable's z-normal)
  const face = boxFace((k) => (k === 0 ? [Z, Y] : k === 1 ? [X, Z] : [X, Y]));
  // A WALL IS SEVERAL MATS, lashed to the frame (raftDress.ts's posts stand on their seams): each side wall in
  // thirds of the cabin's length, each gable in halves either side of its king post. Each mat its own cut of the
  // scan and its own age — or the scan's 1.85 m tile repeats down a 4.2 m wall as one stamped pattern (the user,
  // front-lit at 545 s: "a cold grey repeating tile"). Panels by SHIP position (the piece's origin + local), so
  // the seams land on the posts whichever piece of wall they cut.
  const P = piece.origin.add(positionLocal);
  const third = raftParams.cabinLength / 3;
  const alongZ = face.U.z.abs().greaterThan(0.5);
  const panel = select(alongZ, P.z.sub(raftParams.cabinAftZ).div(third).floor(), P.x.div(raftParams.cabinWidth / 2).floor().add(10));
  const ph = hash2(vec2(panel, 4.7));
  const s = marchScan('wall', face, vec2(ph.mul(5.3).add(piece.seed.mul(0.7)), ph.mul(2.9)), steps);
  const p = positionLocal;
  const noise = triplanarFbm(p.mul(2.3).add(piece.seed.mul(17)), normalLocal, float(6), 3);
  const fine = triplanarFbm(p.mul(11).add(piece.seed.mul(5)), normalLocal, float(6), 2);
  const broad = triplanarFbm(P.mul(0.7).add(3.1), normalLocal, float(6), 2);
  // warm split bamboo, each mat a little older or newer (yellower or greyer), and broad mottling across it
  let c: N = onPalette(s.a.rgb, 'wall', [0.4, 0.3, 0.17], 1.1);
  c = c.mul(mix(vec3(0.9, 0.9, 0.88), vec3(1.08, 1.04, 0.92), ph)).mul(mix(float(0.84), float(1.12), broad));
  // sun-bleach: the outer skin goes a warm straw-grey in the sun, patchily — never cold
  const bleach = float(0.12).add(noise.mul(0.28)).add(ph.mul(0.1)).clamp(0, 1);
  c = mix(c, vec3(luminance(c)).mul(vec3(1.14, 1.0, 0.8)).mul(1.15), bleach);
  // low on the wall (spray, the deck's wet) and in the corners: grime, and salt in the plait's hollows
  const above = p.y.sub(piece.aabbMin.y);
  const low = float(1).sub(smoothstep(0.0, 0.45, above.add(noise.mul(0.2))));
  const u = p.dot(face.U);
  const edge = u.sub(piece.aabbMin.dot(face.U)).min(piece.aabbMax.dot(face.U).sub(u));
  const corner = float(1).sub(smoothstep(0.0, 0.3, edge.add(fine.mul(0.08))));
  const grime = low.mul(0.55).add(corner.mul(0.45)).clamp(0, 1);
  c = c.mul(mix(float(1), vec3(0.55, 0.5, 0.44), grime));
  const salt = smoothstep(0.45, 0.85, s.hit.mul(low.add(0.25)).add(fine.mul(0.35)));
  c = mix(c, vec3(0.52, 0.5, 0.45), salt.mul(0.7));
  const water = shipWater(shipLocalFrame());
  m.colorNode = c.mul(water.tint);
  // (split bamboo's outer skin keeps a little gloss: a grazing sun glints along the strips, the plait's backlit rim)
  m.roughnessNode = s.a.a.mul(mix(float(0.72), float(0.9), bleach)).add(salt.mul(0.15)).mul(water.roughnessScale).clamp(0.3, 1);
  m.metalness = 0;
  // (the scan's own occlusion eased: in shade the sky is all the light there is, and the full map blackened it)
  m.aoNode = mix(float(1), s.b.b, 0.6).mul(float(1).sub(s.hit.mul(0.3))).mul(float(1).sub(grime.mul(0.2)));
  m.normalNode = transformNormalToView(s.normal(1.4));
  // the light through the plait: the weave's gaps (its lowest relief) pass the sun, the strips a warm glow
  // (the pinholes only — the deepest of the relief — and a faint glow through the strips themselves: a whole wall
  // glowing reads as paper, not cane)
  // (at the fragment, not where its ray lands: a pinhole's light is not parallaxed along the view)
  const gaps = smoothstep(0.08, 0.0, s.heightHere).mul(smoothstep(0.35, 0.65, fine));
  const through = gaps.mul(0.08).add(0.005).mul(float(1).sub(grime.mul(0.8)));
  m.emissiveNode = water.addLight.add(transmitted(through, vec3(1.0, 0.78, 0.5)));
  return m;
}

/**
 * THE THATCH: reeds laid in angled courses (thatch_roof_angled), their tips hanging down the slope, sun-bleached
 * to a pale grey straw on top and dark beneath; a fibre sheen on top, so a low sun behind the roof rims its
 * courses. Its scan is laid down the slope by the piece's own ship-frame down (raftMaterialNodes.downRest: the
 * slab's local x runs down the slope one way on the port slab, the other on the starboard).
 */
function createThatchMaterial(steps: number): THREE.MeshPhysicalNodeMaterial {
  const m = new THREE.MeshPhysicalNodeMaterial();
  m.name = 'drift-raft-thatch';
  const piece = createRaftPieceUniforms();
  const X = vec3(1, 0, 0);
  const Y = vec3(0, 1, 0);
  const Z = vec3(0, 0, 1);
  // v UP the slope (the reeds' tips point down it): −x on the starboard slab, +x on the port
  const upSlope = vec3(piece.downRest.x.sign().negate(), 0, 0);
  const face = boxFace((k) => (k === 0 ? [Z, Y] : k === 1 ? [Z, upSlope] : [X, Y]));
  const s = marchScan('thatch', face, vec2(piece.seed.mul(7.1), 0), steps, 1.3);
  const p = positionLocal;
  const noise = triplanarFbm(p.mul(1.7).add(piece.seed.mul(13)), normalLocal, float(6), 3);
  const fine = triplanarFbm(p.mul(9).add(piece.seed.mul(3)), normalLocal, float(6), 2);
  const up = normalLocal.dot(piece.downRest.negate()).clamp(-1, 1);
  const top = smoothstep(0.3, 0.8, up);
  const under = smoothstep(-0.3, -0.8, up);
  // GOLDEN-GREY (the user, 2026-10-29: "the colours still bleed into each other … sail, poles and roof all in the
  // same tan"): the thatch the warmest, yellowest thing aloft, its bleach a golden grey — not the sail's cooler
  // pale cloth, not the poles' dark grey wood
  let c: N = onPalette(s.a.rgb, 'thatch', [0.31, 0.255, 0.14], 1.15);
  // sun-bleached on top, patchy (the newer courses browner)
  const bleach = top.mul(float(0.25).add(noise.mul(0.35))).clamp(0, 1);
  c = mix(c, vec3(luminance(c)).mul(vec3(1.12, 1.0, 0.72)).mul(1.15), bleach);
  // beneath: shaded and older; the deep of the relief dark (the march's landing depth)
  c = c.mul(mix(float(1), float(0.55), under)).mul(float(1).sub(s.hit.mul(0.45)));
  // salt glitter in the tips (fine, sparse), and the odd darker damp patch
  const salt = smoothstep(0.72, 0.9, fine.add(top.mul(0.1)));
  c = mix(c, vec3(0.5, 0.48, 0.43), salt.mul(0.15));
  c = c.mul(mix(float(1), float(0.7), smoothstep(0.62, 0.8, noise).mul(0.6)));
  m.colorNode = c;
  m.roughnessNode = float(0.88).add(s.a.a.mul(0.1)).sub(salt.mul(0.1)).clamp(0.6, 1);
  m.metalness = 0;
  m.aoNode = mix(float(1), s.b.b, 0.7).mul(float(1).sub(s.hit.mul(0.4)));
  m.normalNode = transformNormalToView(s.normal(1.2));
  // the reeds' fibre sheen: a rim of light along the courses at grazing view (strongest backlit)
  m.sheenNode = vec3(0.3, 0.27, 0.21).mul(top.mul(0.6).add(0.4));
  m.sheenRoughnessNode = float(0.45);
  // the eave's thin reed tips pass a little of a low sun behind them
  m.emissiveNode = transmitted(smoothstep(0.55, 0.95, s.hit).mul(0.08).mul(under.oneMinus()), vec3(1.0, 0.82, 0.55));
  return m;
}

/**
 * THE BOARDS (splashboards, guaras and their collars): weathered planks with real gaps between them, the boards
 * along each piece's own long axis. Dark and wet low (the game's wet band, from the sea's own height), a white
 * rime of salt in a band above the wet and in the grain, grey and sun-dry on top edges.
 */
function createPlankMaterial(steps: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = 'drift-raft-planks';
  const piece = createRaftPieceUniforms();
  const X = vec3(1, 0, 0);
  const Y = vec3(0, 1, 0);
  const Z = vec3(0, 0, 1);
  const e = piece.aabbMax.sub(piece.aabbMin);
  // v (the boards) along the longer of the face's two axes
  const face = boxFace((k) =>
    k === 0 ? [select(e.y.greaterThan(e.z), Z, Y), select(e.y.greaterThan(e.z), Y, Z)]
      : k === 1 ? [select(e.x.greaterThan(e.z), Z, X), select(e.x.greaterThan(e.z), X, Z)]
        : [select(e.x.greaterThan(e.y), Y, X), select(e.x.greaterThan(e.y), X, Y)],
  );
  const s = marchScan('planks', face, vec2(piece.seed.mul(5.3), piece.seed.mul(2.9)), steps);
  const p = positionLocal;
  const frame = shipLocalFrame();
  const water = shipWater(frame);
  // height over the logs' axis (the waterline at rest)
  const wy = (frame.localPos as N).y;
  const noise = triplanarFbm(p.mul(2.1).add(piece.seed.mul(11)), normalLocal, float(6), 3);
  const streak = triplanarFbm(p.mul(vec3(7, 0.8, 7)).add(piece.seed.mul(29)), normalLocal, float(6), 2);
  const up = normalLocal.dot(piece.downRest.negate()).clamp(-1, 1);
  let c: N = onPalette(s.a.rgb, 'planks', [0.095, 0.075, 0.06], 1.25);
  // sun-dried grey above, most on the top edges
  const dry = smoothstep(0.35, 0.95, wy.add(noise.mul(0.25))).mul(0.4).add(smoothstep(0.5, 0.9, up).mul(0.35)).clamp(0, 1);
  c = mix(c, vec3(luminance(c)).mul(vec3(1.05, 1.0, 0.95)).mul(1.9), dry);
  // salt: a rime dried in the grain's hollows and the board gaps' lips, in a band above the wet (blotches of it
  // read as camouflage paint: it is IN the wood, so it follows the relief)
  const band = smoothstep(0.12, 0.3, wy).mul(float(1).sub(smoothstep(0.5, 0.8, wy)));
  const salt = smoothstep(0.35, 0.75, s.hit).mul(band.mul(0.8).add(0.1)).mul(smoothstep(0.3, 0.6, streak)).clamp(0, 1);
  c = mix(c, vec3(0.45, 0.43, 0.39), salt.mul(0.4));
  m.colorNode = c.mul(water.tint);
  m.roughnessNode = s.a.a.mul(mix(float(0.85), float(1.1), dry)).add(salt.mul(0.12)).mul(water.roughnessScale).clamp(0.12, 1);
  m.metalness = 0;
  m.aoNode = mix(float(1), s.b.b, 0.7).mul(float(1).sub(s.hit.mul(0.45)));
  m.normalNode = transformNormalToView(s.normal(1.3));
  m.emissiveNode = water.addLight;
  return m;
}

/**
 * THE DECK MATS: split bamboo laid fore-and-aft (bamboo_wall: Poly Haven's split cane), the canes' crowns marched,
 * bleached on top, the grain's hollows dusty. The game's mat is a procedural plait at a 4–5 cm strip, which at
 * the film's grazing look along the deck beat into moiré waves; a mipmapped scan cannot. Only the mats (the
 * bamboo-deck family's variant 0, raftMaterialsWeave.ts): the laths, the berths and the lookout keep the game's
 * look through the same material (its nodes, mixed by the variant).
 */
function createMatMaterial(game: THREE.Material, steps: number): THREE.MeshPhysicalNodeMaterial {
  const g = game as THREE.MeshStandardNodeMaterial;
  const m = new THREE.MeshPhysicalNodeMaterial();
  m.name = 'drift-raft-mats';
  const piece = createRaftPieceUniforms({ variantOf: bambooDeckVariantOf });
  const isMat = float(1).sub(piece.variant.clamp(0, 1));
  const X = vec3(1, 0, 0);
  const Y = vec3(0, 1, 0);
  const Z = vec3(0, 0, 1);
  // canes fore-and-aft on top (v along z), up the edge faces
  const face = boxFace((k) => (k === 0 ? [Z, Y] : k === 1 ? [X, Z] : [X, Y]));
  const s = marchScan('mat', face, vec2(piece.seed.mul(4.3), piece.seed.mul(9.1)), steps);
  const p = positionLocal;
  const noise = triplanarFbm(p.mul(1.9).add(piece.seed.mul(5)), normalLocal, float(6), 3);
  let c: N = onPalette(s.a.rgb, 'mat', [0.3, 0.24, 0.155], 1.15);
  const bleach = float(0.3).add(noise.mul(0.4)).clamp(0, 1);
  c = mix(c, vec3(luminance(c)).mul(vec3(1.06, 1.0, 0.9)).mul(1.2), bleach);
  // dust and salt in the hollows between the canes, foot-worn darker in patches
  c = mix(c, vec3(0.36, 0.33, 0.27), smoothstep(0.4, 0.8, s.hit).mul(0.45));
  c = c.mul(mix(float(1), float(0.75), smoothstep(0.6, 0.85, noise)));
  const water = shipWater(shipLocalFrame());
  const mix3 = (a: N, b: N): N => mix(a, b, isMat);
  m.colorNode = mix3(g.colorNode, c.mul(water.tint));
  m.roughnessNode = mix3(g.roughnessNode, s.a.a.mul(mix(float(0.8), float(1.0), bleach)).mul(water.roughnessScale).clamp(0.3, 1));
  m.aoNode = mix3(g.aoNode ?? float(1), mix(float(1), s.b.b, 0.7).mul(float(1).sub(s.hit.mul(0.4))));
  m.normalNode = mix3(g.normalNode, transformNormalToView(s.normal(1.3))).normalize();
  m.emissiveNode = g.emissiveNode;
  m.metalness = 0;
  m.sheenNode = vec3(0.22, 0.2, 0.15);
  m.sheenRoughnessNode = float(0.4);
  return m;
}

/**
 * THE LOGS, WET WHERE THE SEA REACHES (the wake agent: the darker wet band belongs in the log material, as a
 * height test against the sea). The game's balsa — grain, end checks, rope grooves, the moss line the user
 * likes — kept whole; over it, a band from the waterline up to where the swell laps (~0.13 m over the logs' axis,
 * which is the raft's waterline, raftParams.logAxisY = 0) darkened and glossed as soaked wood is, its upper edge
 * ragged where the water last ran down. The moss stays legible through it: it is darkened, not covered.
 */
/**
 * THE LIVE WATERLINE the hero raft's logs stand in, world space (raft.ts writes it every frame from the sea it floats
 * on, at t itself, not the settle average): `centre` (x, z, the sea's height there), `slope` (∂h/∂x, ∂h/∂z). Below
 * that plane a log is under the water (`withWetBand`). The far rafts share the material and are kilometres off it:
 * the term fades out past UNDER_REACH of the centre, so they keep their dry-lit wood.
 */
export const filmWaterline = { centre: uniform(new THREE.Vector3(0, -1e3, 0)), slope: uniform(new THREE.Vector2()) };
/** m from the hero raft's centre past which `filmWaterline` is not trusted (its logs reach 6.9 m) */
const UNDER_REACH = 10;

function withWetBand(base: THREE.Material): THREE.MeshStandardNodeMaterial {
  const b = base as THREE.MeshStandardNodeMaterial;
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = `${b.name}-film`;
  const piece = createRaftPieceUniforms();
  const p = positionLocal;
  // (a log is laid unrotated at its station: the piece's origin plus local y is the height in the raft's frame)
  const y = piece.origin.y.add(p.y);
  const ragged = triplanarFbm(p.mul(vec3(1.2, 6, 1.2)).add(piece.seed.mul(9)), normalLocal, float(6), 3);
  const runs = triplanarFbm(p.mul(vec3(9, 0.8, 9)).add(piece.seed.mul(4)), normalLocal, float(6), 2);
  // soaked to ~0.11 m, ragged ±3 cm, with runs of wet reaching higher where water drained off the deck
  const top = float(0.11).add(ragged.sub(0.5).mul(0.06)).add(smoothstep(0.6, 0.85, runs).mul(0.1));
  const wet = float(1).sub(smoothstep(top.sub(0.03), top.add(0.02), y));
  // UNDER THE WATER (the wake agent, for the 2026-10-29 note "things below the waterline, like the raft logs, should
  // be darker — less light reaches them"): the wood under the live sea is lit as if in air by the scene's lights, where
  // it gets only what came down through the surface — the sun refracted and spread, the sky's light from one side,
  // almost nothing from below. Dimmed by half at the surface and turned blue-green with depth (Beer–Lambert down
  // ~0.25 m of the log's half-diameter, Jerlov-coastal-ish per channel); the ocean's own absorption along the view and
  // its mirror go on top of this. Multiplied over the wet band, not in place of it.
  const rel = positionWorld.xz.sub(filmWaterline.centre.xy);
  const sea = filmWaterline.centre.z.add(rel.dot(filmWaterline.slope));
  const depth = sea.sub(positionWorld.y);
  const under = smoothstep(-0.015, 0.04, depth).mul(smoothstep(UNDER_REACH, UNDER_REACH - 3, rel.length()));
  const deepened = vec3(1.4, 0.55, 0.45).mul(depth.max(0)).negate().exp().mul(vec3(0.42, 0.5, 0.52));
  const underwater = mix(vec3(1), deepened, under);
  m.colorNode = (b.colorNode as N).mul(mix(float(1), vec3(0.5, 0.52, 0.5), wet)).mul(underwater);
  m.roughnessNode = (b.roughnessNode as N).mul(mix(float(1), float(0.35), wet)).clamp(0.08, 1);
  m.metalnessNode = b.metalnessNode;
  m.emissiveNode = b.emissiveNode;
  m.aoNode = b.aoNode;
  m.normalNode = b.normalNode;
  return m;
}

/** the game's interaction rim (raftHighlight.ts) added to a material's emission */
function withRim<M extends THREE.MeshStandardNodeMaterial>(m: M): M {
  const { rim } = createHighlightNodes();
  m.emissiveNode = m.emissiveNode ? (m.emissiveNode as N).add(rim) : rim;
  return m;
}

/**
 * BARK LEFT ON THE LOGS (the museum raft, 2026-10-29: "the logs' bark remnants"): balsa felled and floated still
 * carries strips of its bark where the axe did not take it — darker, browner, rough, in long patches along the
 * log, most toward its ends. Over the game's balsa (and the wet band and the moss: those stay legible on it).
 */
function withBark(m: THREE.MeshStandardNodeMaterial): THREE.MeshStandardNodeMaterial {
  const piece = createRaftPieceUniforms();
  const p = positionLocal;
  const strip = triplanarFbm(p.mul(vec3(2.2, 2.2, 0.35)).add(piece.seed.mul(23)), normalLocal, float(6), 3);
  const fine = triplanarFbm(p.mul(vec3(30, 30, 6)).add(piece.seed.mul(5)), normalLocal, float(6), 2);
  const along = p.z.sub(piece.aabbMin.z).div(piece.aabbMax.z.sub(piece.aabbMin.z).max(1e-3));
  const ends = smoothstep(0.25, 0.0, along).max(smoothstep(0.75, 1.0, along));
  const bark = smoothstep(0.6, 0.66, strip.add(ends.mul(0.12))).mul(smoothstep(0.2, 0.5, fine.add(0.2)));
  m.colorNode = (m.colorNode as N).mul(mix(vec3(1), vec3(0.42, 0.34, 0.27), bark));
  m.roughnessNode = mix(m.roughnessNode as N, float(0.95), bark);
  return m;
}

/**
 * The spars' own wood (the bipod's legs, the poles, the yards) DARKER AND GREYER than the raft's balsa (the user:
 * "darker, greyer weathered mangrove poles" — they had read as the same tan as the sail and the roof): the game's
 * material, its colour taken `desat` toward grey and darkened by `tone`.
 */
function withTone(base: THREE.Material, tone: [number, number, number], desat: number): THREE.MeshStandardNodeMaterial {
  const b = base as THREE.MeshStandardNodeMaterial;
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = `${b.name}-toned`;
  const c0 = b.colorNode as N;
  m.colorNode = mix(c0, vec3(luminance(c0)), desat).mul(vec3(...tone));
  m.roughnessNode = b.roughnessNode;
  m.metalnessNode = b.metalnessNode;
  m.emissiveNode = b.emissiveNode;
  m.aoNode = b.aoNode;
  m.normalNode = b.normalNode;
  m.positionNode = b.positionNode;
  m.side = b.side;
  return m;
}

/**
 * The game's hemp (lashings, the rope railing), given what its standard material cannot: a FIBRE SHEEN (a rope
 * seen against a low sun is rimmed in light along its strands). The game's own nodes, carried over onto a
 * physical material.
 */
function withSheen(base: THREE.Material, sheen: [number, number, number], sheenRough: number, fibre?: [number, number, number]): THREE.MeshPhysicalNodeMaterial {
  const b = base as THREE.MeshStandardNodeMaterial;
  const m = new THREE.MeshPhysicalNodeMaterial();
  m.name = `${b.name}-film`;
  // (hemp its own fibre tone: half its colour taken to grey and tinted — a grey-brown cord against the tan wood)
  const c0 = b.colorNode as N;
  m.colorNode = fibre ? mix(c0, vec3(luminance(c0)), 0.5).mul(vec3(...fibre)) : c0;
  m.roughnessNode = b.roughnessNode;
  m.metalnessNode = b.metalnessNode;
  m.emissiveNode = b.emissiveNode;
  m.aoNode = b.aoNode;
  m.normalNode = b.normalNode;
  m.side = b.side;
  m.sheenNode = vec3(...sheen);
  m.sheenRoughnessNode = float(sheenRough);
  return m;
}

/**
 * The raft's material factory — the game's raft and the film's: the game's own (`base`) for every kind but those
 * re-dressed here (see the header), one material a kind as the game's cache keeps. `tier` sets what the look costs
 * (RaftLookTier). `track(root)`: any object of the raft once it is in the scene — the scene's sun is found from it,
 * and from then on, each render, the sun the materials and the sails see and the sails' live params are read
 * (`update` does the same at once: the film calls it after it has aimed its light for a frame).
 */
export function createRaftLook(base: MaterialFactory, o: { tier?: RaftLookTier } = {}): {
  factory: MaterialFactory;
  ready: Promise<void>;
  track(root: THREE.Object3D): void;
  update(): void;
} {
  const steps = STEPS[o.tier ?? 'medium'];
  for (const name of Object.keys(SCANS) as ScanName[]) scan(name);
  const made = new Map<PieceKind, THREE.Material>();
  const make = (kind: PieceKind): THREE.Material | null => {
    switch (kind) {
      case 'sail': {
        const sail = createWornSail();
        sails.add(sail);
        return sail.material;
      }
      case 'log':
        return withBark(withWetBand(base(kind, 'base')));
      case 'bipod-mast':
      case 'mast':
      case 'yard':
        return withTone(base(kind, 'base'), [0.6, 0.58, 0.55], 0.55);
      // (the game's focus rim on the ones built new, as raftMaterials.withHighlight puts it on every raft family:
      // a station the player looks at glows whichever look it wears — §T.155)
      case 'cabin-wall':
        return withRim(createWallMaterial(steps));
      case 'thatch-roof':
        return withRim(createThatchMaterial(steps));
      case 'splashboard':
      case 'guara':
        return withRim(createPlankMaterial(steps));
      case 'lashing':
      case 'rope-rail':
        return withSheen(base(kind, 'base'), [0.28, 0.27, 0.24], 0.55, [0.92, 0.9, 0.84]);
      case 'bamboo-deck':
        return createMatMaterial(base(kind, 'base'), steps);
      default:
        return null;
    }
  };
  const factory: MaterialFactory = (kind, role) => {
    if (role !== 'base') return base(kind, role);
    let m = made.get(kind);
    if (m === undefined) {
      m = make(kind) ?? base(kind, role);
      made.set(kind, m);
    }
    return m;
  };
  return {
    factory,
    ready: Promise.all(loads).then(() => undefined),
    track(root) {
      tracked.root = root;
      tracked.light = null;
    },
    update() {
      readSun();
    },
  };
}
