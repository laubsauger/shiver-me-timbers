/**
 * Sky-only preview harness (dev tool, not shipped — /src/sky/preview.html).
 *
 * The full app pulls in the ocean/ship/clouds compute graph, so palette
 * iteration there is at the mercy of whatever another system is mid-edit.
 * This page renders ONLY the sky background + a matte stand-in sea, which
 * makes the horizon/zenith ramp and the phantom-sphere check (§B9) readable
 * on their own. `window.__skyPreview` drives it from the console.
 */
import * as THREE from 'three/webgpu';
import { createSky } from './index';
import { skyParams } from '../params/sky';

const container = document.getElementById('app') as HTMLElement;

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
await renderer.init();
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// same fog contract as the app: colour + range driven by the sky rig
scene.fog = new THREE.Fog(0x9cc8de, skyParams.fogNear, skyParams.fogFar);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(0, 12, 0);

// matte stand-in sea: no FFT, just something to own the lower half of frame
const sea = new THREE.Mesh(
  new THREE.CircleGeometry(4500, 96).rotateX(-Math.PI / 2),
  new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0x0d4f66) }),
);
scene.add(sea);

const sky = createSky({ scene });
sky.configureRenderer(renderer);

let yaw = 0;
let pitch = 0;
const applyView = (): void => {
  camera.rotation.set(0, 0, 0);
  camera.rotateY(THREE.MathUtils.degToRad(yaw));
  camera.rotateX(THREE.MathUtils.degToRad(pitch));
};
applyView();

// NOTE: do NOT add canvas pixel readback here (drawImage(canvas) →
// getImageData). On this WebGPU surface it wedges the renderer process —
// screenshots + the offline ACES model in the report are the measuring tools.
const api = {
  camera,
  renderer,
  scene,
  sky,
  skyParams,
  /** aim the camera: yaw 0 = -Z, pitch + = up */
  look(y: number, p = 0): void {
    yaw = y;
    pitch = p;
    applyView();
  },
  /** teleport the eye — proves the sky rides the camera at any distance */
  at(x: number, z: number, y = 12): void {
    camera.position.set(x, y, z);
    sea.position.set(x, 0, z);
  },
};
(window as unknown as { __skyPreview: typeof api }).__skyPreview = api;

renderer.setAnimationLoop(() => {
  sky.update(skyParams.timeOfDay);
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
