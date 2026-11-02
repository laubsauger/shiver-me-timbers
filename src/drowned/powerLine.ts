/**
 * A DROWNED POWER LINE — lattice pylons marching out of the sea in a straight row, their conductors sagging between
 * them, a span snapped here and there and hanging into the water. One builder for the film and, later, the Raft 2100
 * game: a list of pylons and spans in, a group out.
 *
 * WHY (drift-narrative/wandering-on/sunken-world-cues.md, cue 3: "the top of a pylon line marching out of the water in a
 * straight row with its sagging wires … seen at sunset or against the night sky as a silhouette"; the user, 2026-10-29:
 * "without someone telling me the story it doesn't become apparent that this is what happened").
 *
 * THE KIT is the speedboat circuit's pylon (assets/models/course_pylon.glb, scripts/blender/course/pylon.py): the top
 * section of a 230 kV double-circuit lattice tower from 14 m under still water to its earth-wire peak 26 m over it,
 * three cross-arms a side with their insulator strings, and the conductors' attach points (`extras.attach`: six
 * phases, two earth wires last). Drawn at LOD1 (seen from hundreds of metres to the horizon). The cables are catenaries
 * between neighbouring pylons' attach points, as the circuit draws them (circuit/courseFurniture.ts CABLES: a parabola's
 * sag of `sagPerSpan` × the span), a little slacker for a line no one has tensioned in decades (`sag`).
 *
 * THIN THINGS (§V41, core/minWidth.ts): the lattice, the insulator strings and every cable drawn never narrower than
 * THIN_MIN_WIDTH_PX, the widening paid back as coverage, BLENDED (a still eye must not see a frame-stepped hash
 * shimmer; radio/mast.ts's rule). The lattice writes depth and draws before the sea (THIN_BLEND_RENDER_ORDER: the sea's
 * refraction copy still sees its legs under the water); the cables write none and draw after it (SPRAY_OVER_WATER_ORDER,
 * as the circuit's do), so the sea behind a span does not paint over it.
 *
 * THE LOOK: the kit's own steel, paint and glass under the sea's (drownedLook.ts, steel): rust bleeding down from the
 * joints above the water, the splash zone's black band and crust at the waterline, turf under it. A caller's air
 * (`o.air`, radio/mast.ts MastAir's `output`) melts it into the haze with distance.
 *
 * Positions are kept LOCAL to `origin` (the group stands there), as town.ts's are.
 */
import * as THREE from 'three/webgpu';
import { cameraProjectionMatrix, float, max, mix, normalMap, normalWorldGeometry, positionLocal, positionWorld, texture, uniform, vec2, vec4, viewport } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { applyMinWidth, computeThinAxes, THIN_AXIS_ATTRIBUTE, THIN_BLEND_RENDER_ORDER, THIN_MIN_WIDTH_PX } from '../core/minWidth';
import { SPRAY_OVER_WATER_ORDER } from '../foam/sprayPool';
import { drownedLook } from './drownedLook';
import { kitExtra, kitPrims, loadKitRoot, type KitPrim } from './kit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node unions
type Node = any;

export const PYLON_KIT_URL = new URL('../../assets/models/course_pylon.glb', import.meta.url).href;

export interface PylonKit {
  /** LOD1's primitives: the tower (steel, its hazard band's paint) and the insulator strings */
  parts: KitPrim[];
  /** each conductor's attach point, asset metres (+z along the line): six phases, the two earth wires last */
  attach: Array<[number, number, number]>;
  /** m: a phase conductor's and an earth wire's radius; the sag as a share of the span */
  cable: { phaseRadius: number; earthRadius: number; sagPerSpan: number };
}

export async function loadPylonKit(source: string | ArrayBuffer, renderer?: THREE.WebGPURenderer): Promise<PylonKit> {
  const root = await loadKitRoot(source, 'CF_course_pylon', renderer);
  const attach = kitExtra(root, 'attach') as Array<[number, number, number]> | undefined;
  if (!attach?.length) throw new Error('power line: the pylon kit has no attach points');
  const cable = (kitExtra(root, 'cable') ?? { phaseRadius: 0.018, earthRadius: 0.011, sagPerSpan: 0.012 }) as PylonKit['cable'];
  return { parts: [...kitPrims(root, 1, 'Pylon'), ...kitPrims(root, 1, 'Insulators')], attach, cable };
}

/** m (kit): the top of the legs' hazard band (pylon.py `band1`, 2.2 m, and a little for the members' own ends); the
 * kit's other paint (its danger plate from 3.0 m, the league's chequer boards from 3.9 m) all stands above it */
const PAINT_BAND_TOP = 2.4;

/**
 * THE KIT WITHOUT ITS RACE PAINT: a tower of a valley's line, never the speedboat league's course furniture. The kit's
 * paint slot (C_Paint, pylon.py) is the legs' hazard band at the waterline, the danger plate over it and the league's
 * chequer boards bolted across two faces; here the plate and the boards are dropped and the band's leg members are
 * drawn as the steel they are (they are the legs between −0.8 and 2.2 m: dropped too, the four legs would stop short),
 * each of their vertices taking the steel atlas's coordinates at the nearest vertex of the kit's own steel, so they
 * wear the galvanised legs' colour above and below them. (The Drift's line climbing the high island, the 2026-11-02
 * review: "remove the speedboat-course hazard paint band … a valley line wouldn't have it")
 */
export function plainPylonKit(kit: PylonKit): PylonKit {
  const steel = kit.parts.find((p) => p.slot === 'C_Steel');
  if (!steel) return kit;
  // the steel's vertices near the band, to take the band's texture coordinates from
  const sp = steel.geometry.getAttribute('position');
  const suv = steel.geometry.getAttribute('uv');
  const near: number[] = [];
  for (let i = 0; i < sp.count; i++) if (sp.getY(i) > -4 && sp.getY(i) < PAINT_BAND_TOP + 3) near.push(i);
  const parts = kit.parts.map((p): KitPrim => {
    if (p.slot !== 'C_Paint') return p;
    const g = p.geometry.clone();
    const pos = g.getAttribute('position');
    const idx = g.getIndex();
    const corner = (t: number, c: number): number => (idx ? idx.getX(t * 3 + c) : t * 3 + c);
    const keep: number[] = [];
    for (let t = 0; t < (idx ? idx.count : pos.count) / 3; t++) {
      const tri = [corner(t, 0), corner(t, 1), corner(t, 2)];
      if (tri.every((i) => pos.getY(i) < PAINT_BAND_TOP)) keep.push(...tri);
    }
    g.setIndex(keep);
    const uv = g.getAttribute('uv');
    if (uv && suv) {
      for (let i = 0; i < pos.count; i++) {
        let best = -1;
        let bd = Infinity;
        for (const j of near) {
          const d = (sp.getX(j) - pos.getX(i)) ** 2 + (sp.getY(j) - pos.getY(i)) ** 2 + (sp.getZ(j) - pos.getZ(i)) ** 2;
          if (d < bd) [bd, best] = [d, j];
        }
        if (best >= 0) uv.setXY(i, suv.getX(best), suv.getY(best));
      }
    }
    return { geometry: g, slot: steel.slot, source: steel.source };
  });
  return { ...kit, parts };
}

export interface PylonSpec {
  /** m: world x, z of its axis */
  x: number;
  z: number;
  /** rad: the line's way (the kit's +z) turned about y */
  yaw: number;
  /** rad: the lean it has settled into, about its own x and z, pivoting on its footing FOOTING m down */
  lean?: [number, number];
  /** m it stands lower than the kit's (a deeper valley under it) */
  sink?: number;
  /**
   * m under the still water its lean pivots at (default: the kit's footing, FOOTING m under its own origin). In a
   * lagoon a couple of metres deep a tower leans where it leaves the sand, not 40 m down: pivoting at the deep-water
   * footing a 9° lean also slid its waterline sideways by ~8 m (The Drift's stub near land, drift/wandering/drowned.ts)
   */
  footing?: number;
  /** × the kit's size (default 1: its 230 kV tower; The Drift's line climbing the high island is drawn larger, so a
   * tower 6–8 km off still reads from the back rows) */
  scale?: number;
  /**
   * × its members' widths as the pixel floor reads them (default 1). At 6–7 km a lattice member is ~1/25 of a dome
   * pixel: floored to THIN_MIN_WIDTH_PX it is drawn at ~4 % coverage, and the whole tower — through the far air —
   * comes out ~5 % off the sky behind it: there, but unseen (The Drift's line on the high island, the 2026-11-02 r3
   * seat stills). Heavier members raise that coverage k-fold while the floor still sets the drawn width. Only for a
   * tower whose members stay under the floor at every eye (k × their width < THIN_MIN_WIDTH_PX): above it a member is
   * drawn at its true width at full coverage.
   */
  heavy?: number;
}

export interface SpanSpec {
  /** indices into the pylons */
  from: number;
  to: number;
  /** × the kit's sag (default 1.3: decades of slack) */
  sag?: number;
  /** the conductors strung on it, the kit's attach indices (default: every one; the rest have snapped) */
  attach?: number[];
}

export interface PowerLineSpec {
  pylons: PylonSpec[];
  spans: SpanSpec[];
  /** conductors snapped at a pylon and hanging into the sea toward `toward` (an index or a world point): the attach
   * points' indices that broke */
  snapped?: Array<{ at: number; toward: [number, number]; attach: number[] }>;
}

export interface PowerLineOptions {
  /** m: world x, z the group stands at */
  origin: [number, number];
  /** the air it is seen through (radio/mast.ts MastAir's output) */
  air?: { output(material: THREE.NodeMaterial): void };
  /**
   * rad: the cables are never drawn narrower than this ANGLE (and never under THIN_MIN_WIDTH_PX), the widening paid
   * back as coverage as always — so a far span fades out evenly instead of thinning to nothing. The Drift's: the
   * 2026-11-02 next-level review asks that its wires "stay at least 2 px at 4096²" of the dome master, an angle
   * (2 px of the master's 180° over 4096), which in a cube face's own pixels depends on the size the take draws its
   * faces at — so it is resolved per pass, from the pass's projection and viewport. Unset: the pixel floor alone.
   */
  cableMinAngle?: number;
  /** the caller's last word on the cables' material (The Drift's gold sheen toward a low Sun, drift/wandering/drowned.ts) */
  cableLook?: (material: THREE.MeshStandardNodeMaterial, mesh: THREE.Mesh) => void;
}

/** m: the footing a pylon leans on, under its still-water origin (pylon.py: "footings 40 m down") */
export const FOOTING = 40;
const DEFAULT_SLACK = 1.3;

/** a pylon's pose: the kit's frame → world */
export function pylonMatrix(p: PylonSpec): THREE.Matrix4 {
  const [lx, lz] = p.lean ?? [0, 0];
  // (the pivot, m under the kit's origin: its own footing, or the world depth asked for)
  const f = p.footing !== undefined ? p.footing - (p.sink ?? 0) : FOOTING;
  return new THREE.Matrix4()
    .makeTranslation(p.x, -(p.sink ?? 0), p.z)
    .multiply(new THREE.Matrix4().makeTranslation(0, -f, 0))
    .multiply(new THREE.Matrix4().makeRotationX(lx))
    .multiply(new THREE.Matrix4().makeRotationZ(lz))
    .multiply(new THREE.Matrix4().makeTranslation(0, f, 0))
    .multiply(new THREE.Matrix4().makeRotationY(p.yaw))
    .multiply(new THREE.Matrix4().makeScale(p.scale ?? 1, p.scale ?? 1, p.scale ?? 1));
}

/** a conductor's attach point `k` on pylon `p`, world */
export function attachAt(kit: PylonKit, p: PylonSpec, k: number): THREE.Vector3 {
  return new THREE.Vector3(...kit.attach[k]).applyMatrix4(pylonMatrix(p));
}

export function buildPowerLine(kit: PylonKit, line: PowerLineSpec, o: PowerLineOptions): { group: THREE.Group } {
  const group = new THREE.Group();
  group.name = 'drowned-power-line';
  const [ox, oz] = o.origin;
  group.position.set(ox, 0, oz);
  const local = new THREE.Matrix4().makeTranslation(-ox, 0, -oz);

  // ── THE PYLONS: each slot's primitives of every pylon merged, member axes turned with them ──────────────────
  const axesOf = new Map<KitPrim, Float32Array>();
  for (const prim of kit.parts) axesOf.set(prim, computeThinAxes(prim.geometry));
  const perSlot = new Map<string, { geoms: THREE.BufferGeometry[]; source: THREE.MeshStandardMaterial }>();
  const v = new THREE.Vector3();
  for (const p of line.pylons) {
    const m = local.clone().multiply(pylonMatrix(p));
    const rot = new THREE.Matrix3().setFromMatrix4(m);
    // (a scaled tower's members are as much wider: the half-width w with the offsets; a heavy one's read heavier)
    const k = p.scale ?? 1;
    const h = p.heavy ?? 1;
    for (const prim of kit.parts) {
      const g = prim.geometry.clone().applyMatrix4(m);
      const axes = new Float32Array(axesOf.get(prim)!);
      for (let i = 0; i < axes.length; i += 4) {
        v.set(axes[i], axes[i + 1], axes[i + 2]).applyMatrix3(rot).multiplyScalar(h);
        axes.set([v.x, v.y, v.z, axes[i + 3] * k * h], i);
      }
      g.setAttribute(THIN_AXIS_ATTRIBUTE, new THREE.BufferAttribute(axes, 4));
      let entry = perSlot.get(prim.slot);
      if (!entry) perSlot.set(prim.slot, (entry = { geoms: [], source: prim.source }));
      entry.geoms.push(g);
    }
  }
  for (const [slot, { geoms, source }] of perSlot) {
    const merged = mergeGeometries(geoms, false);
    if (!merged) throw new Error(`power line: the kit's ${slot} primitives do not share one attribute set`);
    merged.computeBoundingSphere();
    const mat = pylonMaterial(slot, source, o);
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = `drowned-pylons-${slot}`;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = THIN_BLEND_RENDER_ORDER;
    group.add(mesh);
  }

  // ── THE CABLES: catenaries between neighbours, and the snapped ones hanging into the sea ─────────────────────
  const tubes: THREE.BufferGeometry[] = [];
  const tube = (pts: THREE.Vector3[], radius: number): void => {
    const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), pts.length * 2, radius, 5, false);
    // (a tube's normals ARE its unit offsets from the centreline: courseFurniture.ts cableAlong)
    const n = g.getAttribute('normal');
    const axes = new Float32Array(n.count * 4);
    for (let i = 0; i < n.count; i++) axes.set([n.getX(i) * radius, n.getY(i) * radius, n.getZ(i) * radius, radius], i * 4);
    g.setAttribute(THIN_AXIS_ATTRIBUTE, new THREE.BufferAttribute(axes, 4));
    g.deleteAttribute('uv');
    tubes.push(g);
  };
  const earth = (k: number): boolean => k >= kit.attach.length - 2;
  for (const s of line.spans) {
    const A = line.pylons[s.from];
    const B = line.pylons[s.to];
    const span = Math.hypot(A.x - B.x, A.z - B.z);
    kit.attach.forEach((_, k) => {
      if (s.attach && !s.attach.includes(k)) return;
      const a = attachAt(kit, A, k).applyMatrix4(local);
      // (the far pylon's attach point on the same side: the line turned end for end is the same tower)
      const b = attachAt(kit, B, k).applyMatrix4(local);
      const sag = kit.cable.sagPerSpan * span * (s.sag ?? DEFAULT_SLACK) * (earth(k) ? 0.8 : 1);
      const pts: THREE.Vector3[] = [];
      const n = 24;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        pts.push(new THREE.Vector3().lerpVectors(a, b, u).add(new THREE.Vector3(0, -4 * sag * u * (1 - u), 0)));
      }
      tube(pts, earth(k) ? kit.cable.earthRadius : kit.cable.phaseRadius);
    });
  }
  for (const s of line.snapped ?? []) {
    const P = line.pylons[s.at];
    for (const k of s.attach) {
      const a = attachAt(kit, P, k).applyMatrix4(local);
      const dir = new THREE.Vector3(s.toward[0] - ox - a.x, 0, s.toward[1] - oz - a.z).normalize();
      // it hangs from the string, swings out a little toward where it ran, and lies on into the water
      const reach = a.y * 0.35;
      const pts: THREE.Vector3[] = [];
      const n = 16;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const y = a.y * (1 - u) * (1 - u) - 1.2 * u * u;
        pts.push(new THREE.Vector3(a.x + dir.x * reach * u * u * 1.4, y, a.z + dir.z * reach * u * u * 1.4));
      }
      tube(pts, earth(k) ? kit.cable.earthRadius : kit.cable.phaseRadius);
    }
  }
  if (tubes.length) {
    const merged = mergeGeometries(tubes, false);
    for (const g of tubes) g.dispose();
    if (!merged) throw new Error('power line: the cables would not merge');
    merged.computeBoundingSphere();
    // (weathered aluminium conductor steel-reinforced: dull grey, dark against an evening sky)
    const cm = new THREE.MeshStandardNodeMaterial({ color: 0x4a4e50, roughness: 0.5, metalness: 0.7 });
    cm.name = 'drowned-cables';
    // (an angle's width in this pass's pixels at the view's centre: α·P₀₀·viewport.z/2, as projectedWidthPx measures
    // a member — core/minWidth.ts)
    const floor = o.cableMinAngle ? max(float(THIN_MIN_WIDTH_PX), float(o.cableMinAngle).mul(cameraProjectionMatrix.mul(vec4(1, 0, 0, 0)).x.abs()).mul(viewport.z).mul(0.5)) : THIN_MIN_WIDTH_PX;
    applyMinWidth(cm, 'blend', floor);
    cm.transparent = true;
    cm.depthWrite = false;
    o.air?.output(cm);
    const cables = new THREE.Mesh(merged, cm);
    cables.name = 'drowned-cables';
    cables.renderOrder = SPRAY_OVER_WATER_ORDER;
    o.cableLook?.(cm, cables);
    group.add(cables);
  }
  return { group };
}

/** a slot's material: the kit's own under the sea's growth (steel), drawn by minimum width with blended coverage */
function pylonMaterial(slot: string, s: THREE.MeshStandardMaterial, o: PowerLineOptions): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial();
  m.name = `drowned-pylon:${slot}`;
  const factor = uniform(s.color ? s.color.clone() : new THREE.Color(1, 1, 1));
  const map = s.map ? texture(s.map) : null;
  const ormTex = s.roughnessMap ?? s.aoMap ?? s.metalnessMap ?? null;
  const orm = ormTex ? texture(ormTex) : null;
  const albedo: Node = map ? map.rgb.mul(factor) : factor;
  const rough: Node = orm ? orm.g.mul(s.roughness ?? 1) : float(s.roughness ?? 0.6);
  const metal: Node = orm ? orm.b.mul(s.metalness ?? 1) : float(s.metalness ?? 0.5);
  const look = drownedLook({ albedo, rough, p: positionLocal, y: positionWorld.y, n: normalWorldGeometry, steel: true });
  if (orm) m.aoNode = mix(float(1), orm.r, float(s.aoMapIntensity ?? 1));
  m.colorNode = look.albedo;
  m.roughnessNode = look.rough;
  m.metalnessNode = metal.mul(float(1).sub(look.cover));
  if (s.normalMap) m.normalNode = normalMap(texture(s.normalMap), vec2(s.normalScale?.x ?? 1, s.normalScale?.y ?? 1));
  applyMinWidth(m, 'blend', THIN_MIN_WIDTH_PX);
  // depthWrite stays on: a member at full coverage occludes as an opaque one would, and the sea depth-tests against
  // it (courseFurniture.ts's blend path)
  m.transparent = true;
  m.depthWrite = true;
  o.air?.output(m);
  return m;
}
