/**
 * The Drift — fulldome origin story for Raft 2100. Act 1, "Undertime".
 *
 * Boot only (§V109 spirit: an entry wires systems, it does not grow them). The act is a pure function of
 * act time `t` (drift/undertime/timeline.ts), so the page is a player with a scrub bar:
 *
 *   view   `flat`  a perspective preview from inside the medium (drag to look around)
 *          `dome`  the square dome master the planetarium plays (cine/domeCapture.ts), letterboxed
 *   keys   Space pause · ←/→ ±2 s (Shift ±10 s) · Home restart · V flat/dome · G guides · [ ] speed ×½/×2
 *   guides dome view only, a DOM layer over the master (never recorded): rings, spokes, front safe zone,
 *          eye-level horizon of the tilted dome — drift/domeGuides.ts
 *   url    ?t=<s> start time · ?view=flat|dome · ?speed=<x> · ?paused · ?markers (dome orientation check)
 *          ?record[&size=2048&fps=30] renders the act to the cine sink (npm run cine:sink), see drift/record.ts
 *
 * Content and treatment: /Users/flo/work/code/drift-narrative/undertime/treatment.md
 */
import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { webgpuAvailable, renderGatePage } from './core/gate';
import { App } from './core/app';
import { GameLoop } from './core/loop';
import { bootReady } from './core/bootSplash';
import { DomeCapture, type DomeLook } from './cine/domeCapture';
import { driftParams } from './params/drift';
import { beatStarts, eyePath, undertimeState } from './drift/undertime/timeline';
import { createUndertimeField } from './drift/undertime/field';
import { CrawlOverlay, crawlBand, type CrawlLayout } from './drift/undertime/crawl';
import { undertimeCrawl } from './drift/undertime/crawlText';
import { faceSizeFor, recordDomeMaster, type DriftRecordOptions } from './drift/record';
import { DomeGuides } from './drift/domeGuides';
import { billboardMesh, eyeFacing } from './drift/undertime/billboard';
import { float, length, step, uv, vec3, vec4 } from 'three/tsl';

type View = 'flat' | 'dome';

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app root');
  if (!(await webgpuAvailable())) {
    renderGatePage(root);
    return;
  }
  const p = driftParams;
  // ?trace: three records where each node was created, so a TSL error names our line, not its own
  if (new URLSearchParams(location.search).has('trace')) (THREE.Node as unknown as { captureStackTrace: boolean }).captureStackTrace = true;
  const app = await App.create(root, { antialias: true });
  const { renderer, scene, camera, controls } = app;
  scene.fog = null;
  // AgX keeps saturated emitters (the cyan and magenta tracks) cleaner than ACES; the dome present pass
  // bakes the same operator in (cine/domeCapture.ts)
  renderer.toneMapping = THREE.AgXToneMapping;
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

  // deep black: the dome fills with light only where light is released (flashes.ts haze), never a fill
  scene.background = new THREE.Color(0x000000);
  // flat preview gets the same bloom as the master, through a pipeline (it tone-maps on output)
  const flatPass = pass(scene, camera);
  const flatBloom = bloom(flatPass, p.bloomStrength, p.bloomRadius, p.bloomThreshold);
  const flatPipeline = new THREE.RenderPipeline(renderer);
  flatPipeline.outputNode = flatPass.add(flatBloom);

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
    // seam probe: two rings straddling the top/back cube-face boundary (world elevation 45° toward +Z):
    // left = plain mesh oriented on the CPU, right = the eye-facing billboard shader. Both must stay whole.
    const ringMat = (): THREE.MeshBasicNodeMaterial => new THREE.MeshBasicNodeMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const cpuRing = new THREE.Mesh(new THREE.RingGeometry(2.6, 3, 64), ringMat());
    cpuRing.position.set(-4, 8, 8);
    cpuRing.lookAt(0, 0, 0);
    scene.add(cpuRing);
    const gpuMat = ringMat();
    gpuMat.positionNode = eyeFacing(vec3(4, 8, 8), float(6));
    gpuMat.colorNode = vec4(vec3(step(0.43, length(uv().sub(0.5))).mul(step(length(uv().sub(0.5)), 0.5))), 1);
    scene.add(billboardMesh(gpuMat, 1, 'seam-probe'));
    // a lat/long grid around the eye: any cube face mirrored or rotated in the lookup breaks its lines at a seam
    const grid = new THREE.Mesh(new THREE.SphereGeometry(20, 36, 18), new THREE.MeshBasicNodeMaterial({ color: 0x406080, wireframe: true, side: THREE.BackSide }));
    scene.add(grid);
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
  const crawl = new CrawlOverlay(undertimeCrawl(p), crawlLayout());
  // the crawl lives in master space, so it shows in the dome view only
  const dome = new DomeCapture({ faceSize: p.domeFace, overlay: crawl.texture });

  const q = new URLSearchParams(location.search);
  let t = Number(q.get('t') ?? 0) || 0;
  let speed = Number(q.get('speed') ?? 1) || 1;
  let paused = q.has('paused');
  let view: View = q.get('view') === 'dome' ? 'dome' : 'flat';
  let guidesOn = q.get('guides') !== '0';
  const guides = new DomeGuides(document.body);
  const clampT = (x: number): number => Math.min(total + 5, Math.max(0, x));

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') paused = !paused;
    else if (e.code === 'ArrowLeft') t = clampT(t - (e.shiftKey ? 10 : 2));
    else if (e.code === 'ArrowRight') t = clampT(t + (e.shiftKey ? 10 : 2));
    else if (e.code === 'Home') t = 0;
    else if (e.code === 'KeyV') view = view === 'flat' ? 'dome' : 'flat';
    else if (e.code === 'KeyG') guidesOn = !guidesOn;
    else if (e.code === 'BracketLeft') speed /= 2;
    else if (e.code === 'BracketRight') speed *= 2;
    else return;
    e.preventDefault();
  });

  const hud = document.getElementById('drift-hud');
  const size = new THREE.Vector2();

  // the flat preview rides along with the eye (the act's camera path), keeping the look the user dragged to
  const eyeWas = new THREE.Vector3();
  /** put the world into the state of act time `at` — the one place a frame's content is decided */
  const prepare = (at: number): ReturnType<typeof undertimeState> => {
    const state = undertimeState(at, p);
    eye.position.set(...eyePath(at, p));
    const moved = eye.position.clone().sub(eyeWas);
    camera.position.add(moved);
    controls.target.add(moved);
    eyeWas.copy(eye.position);
    field.update(state, at, eye.position);
    dome.setFaceSize(faceOverride ?? p.domeFace);
    Object.assign(crawl.layout, crawlLayout());
    crawl.lines = undertimeCrawl(p);
    crawl.draw(at);
    const band = crawlBand(at, crawl.lines, crawl.layout);
    field.setPocket({ lo: band.lo, hi: band.hi, az: p.crawlPocketAz, strength: band.strength * p.crawlPocket }, p.domeTilt);
    return state;
  };
  /** the master into whatever is bound, filling the current viewport */
  const look = (): DomeLook => ({
    exposure: p.exposure,
    bloomStrength: p.bloomStrength,
    bloomRadius: p.bloomRadius,
    bloomThreshold: p.bloomThreshold,
    overlayRadiance: p.crawlRadiance,
  });
  let masterSize = 1024;
  const renderMaster = (): void => {
    field.setPixelAngle(Math.PI / 2 / (faceOverride ?? p.domeFace));
    dome.render(renderer, scene, eye, p.domeTilt, masterSize, look());
  };

  const draw = (): void => {
    const state = prepare(t);
    renderer.getSize(size);
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    if (view === 'flat') {
      controls.update();
      flatBloom.strength.value = p.bloomStrength;
      flatBloom.radius.value = p.bloomRadius;
      flatBloom.threshold.value = p.bloomThreshold;
      renderer.toneMappingExposure = p.exposure;
      field.setPixelAngle(((camera.fov * Math.PI) / 180) / (size.y * renderer.getPixelRatio()));
      flatPipeline.render();
    } else {
      // square master, centred and letterboxed, at the drawing buffer's own resolution
      const s = Math.min(size.x, size.y);
      masterSize = Math.round(s * renderer.getPixelRatio());
      renderer.setViewport((size.x - s) / 2, (size.y - s) / 2, s, s);
      renderMaster();
      renderer.setViewport(0, 0, size.x, size.y);
    }
    guides.update(view === 'dome' && guidesOn, p.domeTilt);
    if (hud) {
      hud.textContent =
        `${state.beat.padEnd(10)} ${t.toFixed(2).padStart(6)} s / ${total.toFixed(0)} s  ×${speed}${paused ? '  paused' : ''}${recording}\n` +
        `view ${view}   pairs ${state.pairDensity.toFixed(2)}  glow ${state.glow.toFixed(2)}  clock ×${state.clockRate.toFixed(2)}  wave ${state.wave.toFixed(2)}  grains ${state.grains.toFixed(2)}  zoom ×${(1 / state.scale).toFixed(0)}  stars ${state.stars.toFixed(2)}`;
    }
  };

  const loop = new GameLoop(
    () => {},
    (_alpha, frameDt) => {
      if (!paused) t = clampT(t + frameDt * speed);
      draw();
    },
  );

  let recording = '';
  let faceOverride: number | null = null;
  const record = async (o: Partial<DriftRecordOptions> = {}): Promise<number> => {
    loop.stop(); // nothing else draws while a take runs (Loom suspends its previews for the same reason)
    const size = o.size ?? 2048;
    faceOverride = faceSizeFor(size);
    const previewSize = masterSize;
    masterSize = size;
    try {
      return await recordDomeMaster(
        { to: total, ...o, size, onProgress: (n, of) => { recording = `  ● REC ${n}/${of}`; if (hud) hud.textContent = recording; } },
        { renderer, prepare, renderMaster },
      );
    } finally {
      faceOverride = null;
      masterSize = previewSize;
      recording = '';
      loop.start();
    }
  };

  (window as unknown as Record<string, unknown>).__drift = {
    app,
    /** live tunables (src/params/drift.ts) — write a field and the next frame uses it */
    params: p,
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
    /** offline dome-master render to the cine sink (npm run cine:sink): { size, fps, from, to, shot } */
    record,
  };

  draw();
  bootReady();
  loop.start();
  if (q.has('record')) {
    // ?record[&size&fps&from&to&shot&group&lane&sink&inflight] — a lane of scripts/drift-render.mjs, or a one-off
    const num = (k: string, d: number): number => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
    const status = window as unknown as { __driftRecord?: { done: boolean; frames?: number; error?: string } };
    status.__driftRecord = { done: false };
    record({
      size: num('size', 2048),
      fps: num('fps', 30),
      from: num('from', 0),
      to: num('to', total),
      shot: q.get('shot') ?? undefined,
      group: q.get('group') ?? undefined,
      lane: q.has('lane'),
      sink: q.get('sink') ?? undefined,
      inFlight: num('inflight', 3),
    }).then(
      (frames) => (status.__driftRecord = { done: true, frames }),
      (e) => (status.__driftRecord = { done: true, error: String(e) }),
    );
  }
}

void boot();
