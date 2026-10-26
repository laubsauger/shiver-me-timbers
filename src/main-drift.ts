/**
 * The Drift — fulldome origin story for Raft 2100. Act 1, "Undertime".
 *
 * Boot only (§V109 spirit: an entry wires systems, it does not grow them). The act is a pure function of
 * act time `t` (drift/undertime/timeline.ts), so the page is a player with a scrub bar:
 *
 *   view   `flat`  a perspective preview from inside the medium (drag to look around)
 *          `dome`  the square dome master the planetarium plays (cine/domeCapture.ts), letterboxed
 *   keys   Space pause · ←/→ ±2 s (Shift ±10 s) · Home restart · V flat/dome · [ ] speed ×½/×2
 *   url    ?t=<s> start time · ?view=flat|dome · ?speed=<x> · ?paused
 *
 * Content and treatment: /Users/flo/work/code/drift-narrative/undertime/treatment.md
 */
import * as THREE from 'three/webgpu';
import { color, uniform } from 'three/tsl';
import { webgpuAvailable, renderGatePage } from './core/gate';
import { App } from './core/app';
import { GameLoop } from './core/loop';
import { bootReady } from './core/bootSplash';
import { DomeCapture } from './cine/domeCapture';
import { driftParams } from './params/drift';
import { beatStarts, undertimeState } from './drift/undertime/timeline';
import { createUndertimeField } from './drift/undertime/field';
import { CrawlOverlay, type CrawlLayout } from './drift/undertime/crawl';
import { UNDERTIME_CRAWL } from './drift/undertime/crawlText';

type View = 'flat' | 'dome';

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app root');
  if (!(await webgpuAvailable())) {
    renderGatePage(root);
    return;
  }
  const p = driftParams;
  const app = await App.create(root, { antialias: true });
  const { renderer, scene, camera, controls } = app;
  scene.fog = null;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.autoClear = false;

  // flat preview: look around from (almost) the field's centre
  camera.near = 0.02;
  camera.far = 1e6;
  camera.fov = 80;
  camera.position.set(0, 0, 0.01);
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.maxPolarAngle = Math.PI;
  controls.rotateSpeed = -0.35; // drag the sky, not the camera
  controls.update();

  // the dome's eye: at the centre, front = −Z, zenith = +Y (tilt is applied by the capture)
  const eye = new THREE.Object3D();
  scene.add(eye);

  const uGlow = uniform(0);
  scene.backgroundNode = color(new THREE.Color(p.lightColor)).mul(uGlow);

  const field = createUndertimeField(p);
  scene.add(field.group);
  // ?markers: orientation check for the dome master — front red, right green, zenith blue, back yellow.
  // In the master, red must sit at the bottom, green at the right, blue at the centre, yellow at the top.
  if (new URLSearchParams(location.search).has('markers')) {
    const at: Array<[number, THREE.Vector3]> = [
      [0xff2020, new THREE.Vector3(0, 0, -6)],
      [0x20ff20, new THREE.Vector3(6, 0, 0)],
      [0x2060ff, new THREE.Vector3(0, 6, 0)],
      [0xffe020, new THREE.Vector3(0, 0, 6)],
    ];
    for (const [hex, pos] of at) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), new THREE.MeshBasicNodeMaterial({ color: hex }));
      m.position.copy(pos);
      scene.add(m);
    }
  }
  const { total } = beatStarts(p);
  const crawlLayout = (): CrawlLayout => ({
    start: p.crawlStart,
    gap: p.crawlGap,
    travel: p.crawlTravel,
    elTop: p.crawlElTop,
    elBottom: p.crawlElBottom,
    holdEl: p.crawlHoldEl,
    sizeTop: p.crawlSizeTop,
    sizeBottom: p.crawlSizeBottom,
    fade: 3,
    end: total,
    maxArc: p.crawlMaxArc,
  });
  const crawl = new CrawlOverlay(UNDERTIME_CRAWL, crawlLayout());
  // the crawl lives in master space, so it shows in the dome view only
  const dome = new DomeCapture({ faceSize: p.domeFace, overlay: crawl.texture });

  const q = new URLSearchParams(location.search);
  let t = Number(q.get('t') ?? 0) || 0;
  let speed = Number(q.get('speed') ?? 1) || 1;
  let paused = q.has('paused');
  let view: View = q.get('view') === 'dome' ? 'dome' : 'flat';
  const clampT = (x: number): number => Math.min(total + 5, Math.max(0, x));

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') paused = !paused;
    else if (e.code === 'ArrowLeft') t = clampT(t - (e.shiftKey ? 10 : 2));
    else if (e.code === 'ArrowRight') t = clampT(t + (e.shiftKey ? 10 : 2));
    else if (e.code === 'Home') t = 0;
    else if (e.code === 'KeyV') view = view === 'flat' ? 'dome' : 'flat';
    else if (e.code === 'BracketLeft') speed /= 2;
    else if (e.code === 'BracketRight') speed *= 2;
    else return;
    e.preventDefault();
  });

  const hud = document.getElementById('drift-hud');
  const size = new THREE.Vector2();

  const draw = (): void => {
    const state = undertimeState(t, p);
    field.update(state, t);
    uGlow.value = state.glow * p.glowRadiance;
    renderer.toneMappingExposure = p.exposure;
    renderer.getSize(size);
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    if (view === 'flat') {
      controls.update();
      renderer.render(scene, camera);
    } else {
      // square master, centred and letterboxed
      const s = Math.min(size.x, size.y);
      dome.setFaceSize(p.domeFace);
      Object.assign(crawl.layout, crawlLayout());
      crawl.draw(t);
      dome.setOverlayRadiance(p.crawlRadiance);
      renderer.setViewport((size.x - s) / 2, (size.y - s) / 2, s, s);
      dome.render(renderer, scene, eye, p.domeTilt);
      renderer.setViewport(0, 0, size.x, size.y);
    }
    if (hud) {
      hud.textContent =
        `${state.beat.padEnd(10)} ${t.toFixed(2).padStart(6)} s / ${total.toFixed(0)} s  ×${speed}${paused ? '  paused' : ''}\n` +
        `view ${view}   pairs ${state.pairDensity.toFixed(2)}  glow ${state.glow.toFixed(2)}  grains ${state.grains.toFixed(2)}  spread ×${(1 / state.scale).toFixed(0)}`;
    }
  };

  const loop = new GameLoop(
    () => {},
    (_alpha, frameDt) => {
      if (!paused) t = clampT(t + frameDt * speed);
      draw();
    },
  );

  (window as unknown as Record<string, unknown>).__drift = {
    app,
    dome,
    field,
    get t(): number {
      return t;
    },
    setTime(x: number): void {
      t = clampT(x);
    },
    setView(v: View): void {
      view = v;
    },
    pause(on = true): void {
      paused = on;
    },
    state: () => undertimeState(t, p),
  };

  draw();
  bootReady();
  loop.start();
}

void boot();
