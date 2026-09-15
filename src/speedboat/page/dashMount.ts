/**
 * §T.208 THE DASH READS. `ui/dash.ts` DashDisplays paints the cockpit instruments; this mounts them on the hero boat's
 * modelled dash (design doc §9 "the boat is the HUD"). RENDER ONLY (§V3).
 *
 * WHERE. The SB-12 GLB merges the dash face into `Parts_LOD0`: there is no screen or needle node. What it does carry:
 *  - `GaugeGlass_LOD0`, the three gauge glasses (its own node, waterMask.ts) → the gauge centres and the face normal;
 *  - `partsSockets.dashCableAnchor` (position + face normal) → the dash face frame (scripts/blender/parts/dash.py Face);
 *  - `GovernorDial_LOD0` extras `pivot`/`axis`/`detents`/`detentNames`/`builtAt` → the Governor knob turn.
 * The tablet (plotter) has no socket, so its centre comes from dash.py's own layout constants in that face frame:
 * the jack sits at face (u 0.36, v 0.09, off 0.024), the gauges at v = H − 0.10, the tablet at (u 0.44, v 0.48 H) with
 * its 0.235 × 0.155 m screen 0.031 m proud. H (the face height) is solved from the centre gauge glass, not assumed.
 *
 * WHAT. Canvas-textured quads just proud of the real surfaces, children of the LOD0 level (they leave with it):
 * the plotter on the tablet screen, and one `gauges` tile over each gauge glass (tach face · LED speed + Surge +
 * Governor lamp · trim face — the baked needles are static, so the tiles cover them), and two needle quads over the
 * tach and trim faces that turn EVERY frame (a quaternion, no repaint). The Governor knob turns to the HUD's mode.
 *
 * WHEN. Not by camera mode but by what the lens sees (`dashScreenRadius`): the cockpit camera, a trailer insert over the
 * shoulder or at the gauges all get a live dash, and the chase camera (the dash a few pixels, or behind the seat) costs
 * nothing. `legible` (every gauge on screen and large enough to read at 1080p, with hysteresis) lets the HUD drop its
 * cockpit trim/speed panels while the dash itself shows them; look back or away and the panels return.
 *
 * LIGHT. Backlit: unlit materials at `dashBrightness(boat LED level)` — full by day, dimmed to a soft glow at night
 * (the LED level is the night preset's single dusk clock, page/boatLights.ts).
 *
 * COST. The needles pose per frame; DashDisplays paints at `DASH_HZ` (the plotter every paint, the gauge tiles on
 * change) and a texture uploads only when its canvas was repainted; four draws, no sampler outside these materials.
 */
import * as THREE from 'three/webgpu';
import { materialColor, uniform } from 'three/tsl';
import type { BoatInstance } from '../assets';
import { boatLedLevel } from '../assets/slotMaterials';
import { DashDisplays, type HudCourse, type HudRacer, type RaceHudModel } from '../ui';
import { GAUGE_TILE_PX, NEEDLE_PX } from '../ui/dash';

/** instrument repaint rate while the dash is in view (the needles pose every frame) */
export const DASH_HZ = 10;
const PERIOD = 1 / DASH_HZ;
/** on-screen gauge radius as a fraction of the viewport height: below this (≈ 9 px radius at 1080p) nothing repaints or poses */
export const DASH_VISIBLE_MIN = 0.008;
/**
 * every gauge at least this (≈ 40 px radius at 1080p: the tach numerals, 22/160 of the disc, ≈ 11 px tall) and on
 * screen → `legible`; it drops below `DASH_LEGIBLE_OFF` (hysteresis, no flicker on a bump)
 */
export const DASH_LEGIBLE_ON = 0.037;
export const DASH_LEGIBLE_OFF = 0.031;
/** …and clear of the frame edge by its own size plus 2 % of the height: a gauge cut by the bottom edge is not read */
const LEGIBLE_INSET = 0.02;
/** backlight: linear gain on the screens by day and at full night (LED level 1) */
export const DASH_BRIGHTNESS = { day: 1, night: 0.75 } as const;

export const dashBrightness = (ledLevel: number): number => {
  const l = Number.isFinite(ledLevel) ? (ledLevel < 0 ? 0 : ledLevel > 1 ? 1 : ledLevel) : 0;
  return DASH_BRIGHTNESS.day + (DASH_BRIGHTNESS.night - DASH_BRIGHTNESS.day) * l;
};

/** scripts/blender/parts/dash.py layout, face frame (u = body +x, v = up the face, n = toward the pilot), metres */
const JACK = { u: 0.36, v: 0.09, n: 0.006 + 0.018 };
const GAUGE_V_BELOW_TOP = 0.1;
const TABLET = { u: 0.44, vOfHeight: 0.48, n: 0.006 + 0.031, w: 0.235, h: 0.155 };
/** the plotter canvas is 16:9; letterboxed inside the tablet glass */
const PLOTTER_ASPECT = 320 / 180;
/** proud of the surface they cover (the gauge glass lip is 1.5 mm above the glass, dash.py bezel profile) */
const PROUD = 0.0015;
/** gauge tile radius: inside the bezel's inner lip (0.058) */
const GAUGE_R = 0.057;
/** the needle quads over the gauge tiles */
const NEEDLE_LIFT = 0.001;

export interface DashFace {
  origin: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  n: THREE.Vector3;
  height: number;
  /** gauge glass centres (on the glass front), pilot's left → right */
  gauges: THREE.Vector3[];
  /** tablet screen centre (on the screen surface) */
  tablet: THREE.Vector3;
}

const v3 = (a: unknown): THREE.Vector3 | null =>
  Array.isArray(a) && a.length === 3 && a.every((c) => typeof c === 'number' && Number.isFinite(c)) ? new THREE.Vector3(a[0], a[1], a[2]) : null;

/** the dash face frame and mount points in the boat body frame, from the GLB (null when the nodes are missing) */
export function locateDash(level0: THREE.Object3D, boatUserData: Record<string, unknown>): DashFace | null {
  const raw = boatUserData.partsSockets;
  const sockets = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { dashCableAnchor?: { position?: unknown; normal?: unknown } } | undefined;
  const jack = v3(sockets?.dashCableAnchor?.position);
  const n0 = v3(sockets?.dashCableAnchor?.normal);
  const glass = level0.getObjectByName('GaugeGlass_LOD0');
  if (!jack || !n0 || !glass) return null;
  const n = n0.normalize();
  const u = new THREE.Vector3(1, 0, 0);
  const v = new THREE.Vector3().crossVectors(u, n).normalize(); // dash.py: n = v × u
  const origin = jack.clone().addScaledVector(u, -JACK.u).addScaledVector(v, -JACK.v).addScaledVector(n, -JACK.n);
  // the glass discs: vertices clustered by u (gauges at u −0.15 / 0 / +0.15), front = the furthest along n
  glass.updateMatrixWorld(true);
  const toLevel = level0.matrixWorld.clone().invert();
  const sums = [0, 1, 2].map(() => ({ p: new THREE.Vector3(), k: 0, front: -Infinity }));
  const p = new THREE.Vector3();
  glass.traverse((o) => {
    const pos = (o as THREE.Mesh).geometry?.getAttribute('position');
    if (!pos) return;
    const m = new THREE.Matrix4().multiplyMatrices(toLevel, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).applyMatrix4(m);
      const du = p.clone().sub(origin).dot(u);
      const g = du > 0.075 ? 0 : du < -0.075 ? 2 : 1;
      sums[g].p.add(p);
      sums[g].k++;
      sums[g].front = Math.max(sums[g].front, p.clone().sub(origin).dot(n));
    }
  });
  if (sums.some((s) => s.k === 0)) return null;
  const gauges = sums.map((s) => {
    const c = s.p.divideScalar(s.k);
    return c.addScaledVector(n, s.front - c.clone().sub(origin).dot(n));
  });
  const height = gauges[1].clone().sub(origin).dot(v) + GAUGE_V_BELOW_TOP;
  const tablet = origin.clone().addScaledVector(u, TABLET.u).addScaledVector(v, TABLET.vOfHeight * height).addScaledVector(n, TABLET.n);
  return { origin, u, v, n, height, gauges, tablet };
}

const scratch = new THREE.Vector3();
const scratchN = new THREE.Vector3();

/**
 * the on-screen radius of a disc of `radius` metres at `centre` (world) facing `normal` (world, unit), as a fraction of
 * the viewport height; 0 when it is behind the lens, seen from behind, or off screen.
 *
 * `inset` (fractions of the viewport height) asks for the WHOLE disc plus that margin to be inside the frame instead of
 * only its centre: a gauge half cut off by the bottom of the screen is not one the pilot reads, whatever its size.
 */
export function dashScreenRadius(centre: THREE.Vector3, normal: THREE.Vector3, radius: number, camera: THREE.Camera, inset = 0): number {
  camera.getWorldPosition(scratchN);
  if (scratchN.sub(centre).dot(normal) <= 0) return 0;
  const v = scratch.copy(centre).applyMatrix4(camera.matrixWorldInverse);
  const depth = -v.z;
  if (!(depth > 1e-3)) return 0;
  const p = camera.projectionMatrix.elements;
  // projectionMatrix[5] = zoom / tan(fov/2): a height h at depth d spans h·P5/d of the 2-unit NDC height
  const r = (radius * p[5]) / (2 * depth);
  v.applyMatrix4(camera.projectionMatrix);
  const pad = inset > 0 ? 2 * r + inset : 0;
  const padX = inset > 0 ? (pad * p[5]) / p[0] : 0; // the same margin in NDC x (NDC x is the wider axis)
  if (v.x < -1 + padX || v.x > 1 - padX || v.y < -1 + pad || v.y > 1 - pad) return 0;
  return r;
}

export interface DashMount {
  readonly displays: DashDisplays;
  /** the quads (plotter, gauges, tach needle, trim needle), children of the boat's LOD0 level */
  readonly meshes: readonly THREE.Mesh[];
  readonly face: DashFace;
  /** the last update saw every gauge on screen and large enough to read (the HUD may drop its cockpit trim/speed) */
  readonly legible: boolean;
  setCourse(hc: HudCourse): void;
  setRoster(roster: readonly HudRacer[]): void;
  update(m: RaceHudModel, dt: number): void;
}

const brightness = uniform(1).onRenderUpdate(() => dashBrightness(boatLedLevel()));

const screenMaterial = (canvas: HTMLCanvasElement): { mat: THREE.MeshBasicNodeMaterial; tex: THREE.CanvasTexture } => {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicNodeMaterial({ map: tex });
  mat.colorNode = materialColor.mul(brightness);
  mat.fog = false;
  mat.name = 'DashScreen';
  return { mat, tex };
};
/** a quad in the face plane (x = the pilot's right = −u, y = v, normal n) centred on `c` */
const facePlaced = (mesh: THREE.Mesh, face: DashFace, c: THREE.Vector3): THREE.Mesh => {
  const basis = new THREE.Matrix4().makeBasis(face.u.clone().negate(), face.v, face.n);
  mesh.quaternion.setFromRotationMatrix(basis);
  mesh.position.copy(c).addScaledVector(face.n, PROUD);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
};

/**
 * mount DashDisplays on the hero dash, seen through `camera`; null (one warning) when the GLB lacks the dash nodes.
 * The dash is cosmetic: a throw while mounting or updating is logged loudly once and the dash is dropped, never the page.
 */
export function createDashMount(boat: BoatInstance, camera: THREE.Camera): DashMount | null {
  let mount: DashMount | null;
  try {
    mount = mountDash(boat, camera);
  } catch (e) {
    console.error('[speedboat] dash displays not mounted: mounting threw', e);
    return null;
  }
  if (!mount) return null;
  const inner = mount;
  let broken = false;
  return {
    get displays() {
      return inner.displays;
    },
    meshes: inner.meshes,
    face: inner.face,
    get legible() {
      return !broken && inner.legible;
    },
    setCourse: (hc) => inner.setCourse(hc),
    setRoster: (r) => inner.setRoster(r),
    update(m, dt) {
      if (broken) return;
      try {
        inner.update(m, dt);
      } catch (e) {
        broken = true;
        for (const mesh of inner.meshes) mesh.visible = false;
        console.error('[speedboat] dash displays disabled: update threw', e);
      }
    },
  };
}

function mountDash(boat: BoatInstance, camera: THREE.Camera): DashMount | null {
  const level0 = boat.object.levels[0]?.object;
  const face = level0 ? locateDash(level0, boat.object.userData as Record<string, unknown>) : null;
  if (!level0 || !face) {
    console.warn('[speedboat] dash displays not mounted: no GaugeGlass_LOD0 / partsSockets.dashCableAnchor in the boat GLB');
    return null;
  }
  const displays = new DashDisplays();
  const plotter = screenMaterial(displays.plotter);
  const gauges = screenMaterial(displays.gauges);

  const pw = TABLET.w;
  const ph = Math.min(TABLET.h, pw / PLOTTER_ASPECT);
  const plotterMesh = facePlaced(new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), plotter.mat), face, face.tablet);
  plotterMesh.name = 'DashPlotter';

  // three discs, one geometry: each disc's UVs cover its third of the gauges canvas (tile 0 at the pilot's left)
  const discs: THREE.BufferGeometry[] = face.gauges.map((c, k) => {
    const g = new THREE.CircleGeometry(GAUGE_R, 40);
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setX(i, (k + uv.getX(i)) / 3);
    // disc k at its gauge, in the plotter quad's frame (the mesh frame below)
    const off = c.clone().sub(face.tablet);
    g.translate(-off.dot(face.u), off.dot(face.v), off.dot(face.n));
    return g;
  });
  const merged = new THREE.BufferGeometry();
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  for (const g of discs) {
    const base = pos.length / 3;
    pos.push(...(g.getAttribute('position').array as Float32Array));
    uvs.push(...(g.getAttribute('uv').array as Float32Array));
    for (const i of g.index?.array ?? []) idx.push(base + i);
    g.dispose();
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  merged.setIndex(idx);
  const gaugeMesh = facePlaced(new THREE.Mesh(merged, gauges.mat), face, face.tablet);
  gaugeMesh.name = 'DashGauges';
  // the needles: one tapered quad each, pivoting on its gauge centre (tile 0 tach, tile 2 trim), just proud of the tile
  const pxM = GAUGE_R / (GAUGE_TILE_PX / 2);
  const needleGeo = new THREE.PlaneGeometry(NEEDLE_PX.width * pxM, (NEEDLE_PX.tail + NEEDLE_PX.tip) * pxM);
  needleGeo.translate(0, ((NEEDLE_PX.tip - NEEDLE_PX.tail) / 2) * pxM, 0);
  const np = needleGeo.getAttribute('position');
  for (let i = 0; i < np.count; i++) if (np.getY(i) > 0) np.setX(i, np.getX(i) * 0.45); // taper to the tip
  const needleMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color('#FF6B1F') });
  needleMat.colorNode = materialColor.mul(brightness);
  needleMat.fog = false;
  needleMat.name = 'DashNeedle';
  const needles = [0, 2].map((k) => {
    const mesh = facePlaced(new THREE.Mesh(needleGeo, needleMat), face, face.gauges[k]);
    mesh.position.addScaledVector(face.n, NEEDLE_LIFT);
    mesh.name = k === 0 ? 'DashTachNeedle' : 'DashTrimNeedle';
    return mesh;
  });
  const faceQ = needles[0].quaternion.clone();
  const turnQ = new THREE.Quaternion();
  const Z = new THREE.Vector3(0, 0, 1);
  const poseNeedles = (): void => {
    // canvas angles run clockwise as the pilot sees the face; the quad's +z faces the pilot, so a clockwise turn is −z
    needles[0].quaternion.copy(faceQ).multiply(turnQ.setFromAxisAngle(Z, -displays.rpmNeedleRad));
    needles[1].quaternion.copy(faceQ).multiply(turnQ.setFromAxisAngle(Z, -displays.trimNeedleRad));
  };
  poseNeedles();
  level0.add(plotterMesh, gaugeMesh, ...needles);

  // the Governor knob: detents in degrees about its pivot/axis, the GLB built at `builtAt`
  const dial = level0.getObjectByName('GovernorDial_LOD0');
  const dx = (dial?.userData ?? {}) as { pivot?: unknown; axis?: unknown; detents?: unknown; detentNames?: unknown; builtAt?: unknown };
  const pivot = v3(dx.pivot);
  const axis = v3(dx.axis)?.normalize() ?? null;
  const names = typeof dx.detentNames === 'string' ? dx.detentNames.split(',').map((s) => s.trim().toLowerCase()) : [];
  const detents = Array.isArray(dx.detents) ? (dx.detents as number[]) : [];
  const builtDeg = detents[names.indexOf(String(dx.builtAt ?? '').toLowerCase())] ?? 0;
  const dialRest = dial ? (dial.updateMatrix(), dial.matrix.clone()) : null;
  if (dial) dial.matrixAutoUpdate = false;
  let dialMode = '';
  const turn = new THREE.Matrix4();
  const tmp = new THREE.Matrix4();

  // what the lens sees: the gauges and the tablet, in world space at the last drawn pose
  const world = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const tabletR = ph / 2;
  let legible = false;
  const look = (): number => {
    if (!level0.visible || !boat.object.visible) return 0;
    const mw = level0.matrixWorld;
    normal.copy(face.n).transformDirection(mw);
    let least = Infinity;
    let most = 0;
    for (const g of face.gauges) {
      world.copy(g).applyMatrix4(mw);
      const r = dashScreenRadius(world, normal, GAUGE_R, camera);
      if (r > most) most = r;
      const inside = r > 0 ? dashScreenRadius(world, normal, GAUGE_R, camera, LEGIBLE_INSET) : 0;
      if (inside < least) least = inside;
    }
    legible = legible ? least >= DASH_LEGIBLE_OFF : least >= DASH_LEGIBLE_ON;
    return Math.max(most, dashScreenRadius(world.copy(face.tablet).applyMatrix4(mw), normal, tabletR, camera));
  };

  let acc = Infinity;
  return {
    displays,
    meshes: [plotterMesh, gaugeMesh, ...needles],
    face,
    get legible() {
      return legible;
    },
    setCourse: (hc) => displays.setCourse(hc),
    setRoster: (r) => displays.setRoster(r),
    update(m, dt) {
      if (dial && dialRest && pivot && axis && m.governor !== dialMode) {
        dialMode = m.governor;
        const deg = detents[names.indexOf(m.governor)];
        const rad = THREE.MathUtils.degToRad(Number.isFinite(deg) ? deg - builtDeg : 0);
        turn.makeTranslation(pivot.x, pivot.y, pivot.z).multiply(tmp.makeRotationAxis(axis, rad)).multiply(tmp.makeTranslation(-pivot.x, -pivot.y, -pivot.z));
        dial.matrix.multiplyMatrices(turn, dialRest);
        dial.matrixWorldNeedsUpdate = true;
      }
      if (look() < DASH_VISIBLE_MIN) {
        acc = Infinity; // repaint on the first frame it is seen again
        return;
      }
      displays.pose(m);
      poseNeedles();
      acc += Number.isFinite(dt) && dt > 0 ? dt : 0;
      if (acc + 1e-6 < PERIOD) return;
      displays.update(m, PERIOD);
      acc = acc === Infinity ? 0 : Math.min(acc - PERIOD, PERIOD); // carry the remainder: DASH_HZ at any frame rate
      if (displays.plotterDirty) plotter.tex.needsUpdate = true;
      if (displays.gaugesDirty) gauges.tex.needsUpdate = true;
    },
  };
}
