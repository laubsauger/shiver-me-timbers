/**
 * Ship-only preview harness (§V22 verification aid — NOT part of the game).
 * Renders the galleon assembly with the game's own materials and a sun rig
 * matching src/sky/lighting.ts, so stern closure, yard clearance, sail motion
 * and self-shadowing can be checked from fixed camera stations without the
 * ocean/foam/cloud systems (and without every other agent's HMR reload).
 *
 * Query params (all optional):
 *   view=stern|bow|beam|top|lee|sun   camera station
 *   dist=<m> height=<m> yaw=<rad>     manual override
 *   wind=<rad> speed=<m/s>            wind (writes params/ocean live values)
 *   heading=<rad>                     ship yaw, to test apparent-wind response
 *   tod=<h>                           time of day → sun angle
 *   nbias/sbias/extent                shadow A/B (defaults track params/sky)
 *   plain=1                           flat materials, isolates geometry
 *   ship=galleon|brigantine|raft      which blueprint (default galleon)
 *   station=tiller|radio|bow|nest|cabin   raft on-deck eye stations (§T91)
 *   fp=1                              walk the raft (WASD, click to lock)
 */
import * as THREE from 'three/webgpu';
import { ShipAssembly } from './shipAssembly';
import { updateRig } from './rigTrim';
import { oceanParams } from '../params/ocean';
import { skyParams } from '../params/sky';
import { sunDirection } from '../sky/sunCycle';
import {
  attachFirstPerson,
  blueprintAabb,
  buildShipBlueprint,
  placeAtStation,
  shipNameOf,
  tintForShip,
} from './previewRaft';

const q = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const v = Number(q.get(key));
  return Number.isFinite(v) && q.has(key) ? v : fallback;
};

oceanParams.windDirection = num('wind', oceanParams.windDirection);
oceanParams.windSpeed = num('speed', oceanParams.windSpeed);
skyParams.timeOfDay = num('tod', skyParams.timeOfDay);

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x7fa0bb);

// Shadow rig mirrors src/sky/lighting.ts through the SAME params (§V16) —
// a preview with its own hand-picked bias would report shadows the game does
// not have. Extent is scaled down with the map so the texel size matches the
// game's (2*extent/mapSize), which is what governs whether a 0.09 m rail post
// still casts; the ship is the only caster here, so nothing gets clipped.
const sun = new THREE.DirectionalLight(0xfff2dd, 3.1);
const sd = sunDirection(skyParams.timeOfDay, skyParams.latitude);
sun.position.set(sd[0] * 120, sd[1] * 120, sd[2] * 120);
sun.castShadow = true;
const gameTexel = (2 * skyParams.shadowExtent) / skyParams.shadowMapSize;
const extent = num('extent', 45);
const mapSize = Math.min(4096, 2 ** Math.round(Math.log2((2 * extent) / gameTexel)));
sun.shadow.mapSize.set(mapSize, mapSize);
const sc = sun.shadow.camera;
sc.near = 40;
sc.far = 260;
sc.left = -extent;
sc.right = extent;
sc.top = extent;
sc.bottom = -extent;
sun.shadow.bias = num('sbias', skyParams.shadowBias);
sun.shadow.normalBias = num('nbias', skyParams.shadowNormalBias);
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xbcd8f0, 0x33506a, 0.9));

const sea = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshStandardMaterial({ color: 0x2f6f86, roughness: 0.6 }),
);
sea.rotateX(-Math.PI / 2);
sea.receiveShadow = true;
scene.add(sea);

// ?plain=1 swaps the TSL cloth/wood materials for flat ones — bisect switch
// when the preview itself is under suspicion (§B.5 taught us to isolate GPU
// work before blaming geometry)
const plain = q.get('plain') === '1';
const shipName = shipNameOf(q.get('ship'));
const blueprint = buildShipBlueprint(shipName);
const assembly = new ShipAssembly(
  blueprint,
  plain
    ? () => new THREE.MeshStandardMaterial({ color: 0xb08050, roughness: 0.9, side: THREE.DoubleSide })
    : undefined,
);
assembly.group.rotation.y = num('heading', 0);
const tint = tintForShip(shipName);
if (tint !== undefined) assembly.setSailTint(tint);
assembly.group.traverse((o) => {
  const mesh = o as THREE.Mesh;
  if (mesh.isMesh) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
});
scene.add(assembly.group);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 900);
const SUN_YAW = Math.atan2(sd[0], sd[2]);
const VIEWS: Record<string, { yaw: number; height: number; dist: number }> = {
  stern: { yaw: Math.PI, height: 8, dist: 34 },
  sternLow: { yaw: Math.PI, height: 3.5, dist: 24 },
  bow: { yaw: Math.PI * 0.28, height: 10, dist: 44 },
  beam: { yaw: Math.PI / 2, height: 12, dist: 52 },
  top: { yaw: Math.PI * 0.75, height: 46, dist: 30 },
  sun: { yaw: SUN_YAW, height: 14, dist: 52 },
  lee: { yaw: SUN_YAW + Math.PI, height: 14, dist: 52 },
};
// the exterior stations were authored for the galleon; other classes scale
// them by hull length off their own AABB (galleon ratio = 1, so unchanged)
const box = blueprintAabb(blueprint);
const lengthOf = (b: ReturnType<typeof blueprintAabb>): number => b.max[2] - b.min[2];
const fit = shipName === 'galleon' ? 1 : lengthOf(box) / lengthOf(blueprintAabb(buildShipBlueprint('galleon')));
const view = VIEWS[q.get('view') ?? 'stern'] ?? VIEWS.stern;
const yaw = num('yaw', view.yaw);
const dist = num('dist', view.dist * fit);
const height = num('height', view.height * fit);
camera.position.set(Math.sin(yaw) * dist, height, Math.cos(yaw) * dist);
camera.lookAt(0, num('lookY', shipName === 'galleon' ? 9 : (box.max[1] + box.min[1]) * 0.4), 0);
sun.target.position.set(0, 8, 0);
const station = q.get('station');
if (station !== null && !placeAtStation(camera, assembly, station)) {
  console.warn(`preview: unknown station '${station}'`);
}
const walk = q.get('fp') === '1' && shipName === 'raft'
  ? attachFirstPerson(assembly, blueprint, renderer.domElement, station ?? undefined)
  : undefined;

const hud = document.getElementById('hud') as HTMLDivElement;
let frames = 0;
let last = performance.now();
let prevFrame = performance.now();
renderer.setAnimationLoop(() => {
  // the preview must run the same per-frame rig update main.ts does, or it is
  // not a faithful harness: yards never brace, sails never trim, and — since
  // updateRig is what publishes the ship's world matrix to the piece materials
  // — the deck heightfield is sampled in WORLD space, so its planking slides
  // off the deck the moment ?heading= is non-zero
  const nowFrame = performance.now();
  const dt = (nowFrame - prevFrame) / 1000;
  updateRig(assembly, dt, num('trim', 1));
  walk?.update(dt, camera);
  prevFrame = nowFrame;

  renderer.render(scene, camera);
  frames++;
  const now = performance.now();
  if (now - last > 500) {
    hud.textContent =
      `${((frames * 1000) / (now - last)).toFixed(0)} fps | ` +
      `wind ${oceanParams.windSpeed.toFixed(1)} m/s @ ${oceanParams.windDirection.toFixed(2)} rad | ` +
      `nbias ${sun.shadow.normalBias} | ${mapSize}px @ ±${extent}m ` +
      `(${((2 * extent * 100) / mapSize).toFixed(1)} cm/texel, game ${(gameTexel * 100).toFixed(1)})`;
    frames = 0;
    last = now;
  }
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

(window as unknown as Record<string, unknown>).__preview = { assembly, sun, scene, camera, renderer, walk };
