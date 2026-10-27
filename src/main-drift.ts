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
import { beatStarts, eyePath, undertimeState, webFlight } from './drift/undertime/timeline';
import { finalKnots } from './drift/undertime/grains';
import { loadWebData } from './drift/undertime/webVolume';
import { getTheDriftParams } from './params/getTheDrift';
import { createArrival } from './drift/getTheDrift/act';
import { loadGalaxyAtlas } from './drift/getTheDrift/galaxies';
import type { ArrivalState } from './drift/getTheDrift/timeline';
import { createUndertimeField } from './drift/undertime/field';
import { CrawlOverlay, crawlBand, type CrawlLayout } from './drift/undertime/crawl';
import type { TextPocket } from './drift/undertime/field';
import { undertimeCrawl } from './drift/undertime/crawlText';
import { faceSizeFor, recordDomeMaster, type DriftRecordOptions } from './drift/record';
import { DomeGuides } from './drift/domeGuides';
import { billboardMesh, eyeFacing } from './drift/undertime/billboard';
import { float, length, step, uv, vec3, vec4 } from 'three/tsl';
import { createSea } from './drift/wandering/sea';
import { C1_FOLLOW, beatStarts as seaBeats, type BeatName } from './drift/wandering/beats';
import { adaptation, skyIrradiance } from './drift/wandering/seaSky';
import { EARTH_R } from './drift/getTheDrift/atmosphere';
import { beatStarts as driftBeats } from './drift/getTheDrift/timeline';

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

  // the text pocket at act time `at`: the sky the text occupies, and — so the field has cleared before a
  // phrase arrives — the sky it is ABOUT to occupy, its strength rising over the 3 s before (set below,
  // once the crawl exists; the field bakes it into each pair's birth)
  let pocketAt: (at: number) => TextPocket = () => ({ lo: 0, hi: 0, az: 0, strength: 0 });
  // the cosmic web's volume and knots (~17 MB, scripts/drift-web-volume.py): needed to build the field and
  // to place Act 2's galaxies at its knots
  const web = loadWebData();
  const galaxyAtlas = loadGalaxyAtlas();
  await Promise.all([web.ready, galaxyAtlas.ready]);
  const field = createUndertimeField(p, web, (at) => pocketAt(at));
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
  // THE SHOW: the acts on one clock. Get the Drift starts `overlap` s before Undertime ends (the web's knots
  // open into galaxies under the fading signature), from where Undertime leaves the eye
  const { total: act1 } = beatStarts(p);
  const p2 = getTheDriftParams;
  const act2Start = act1 - p2.overlap;
  // the galaxies open at the web's knots where the pull-back leaves them
  const flightEnd = webFlight(act2Start, p);
  const heroKnot = web.knots[0].pos;
  const eyePatEnd: [number, number, number] = [0, 1, 2].map((i) => heroKnot[i] + flightEnd.offset[i]) as [number, number, number];
  const arrival = createArrival(p2, eyePath(act2Start, p), finalKnots(web.knots, eyePatEnd, eyePath(act2Start, p), flightEnd.box), p.domeTilt, galaxyAtlas);
  scene.add(arrival.group);
  // THE SEA (drift/wandering/sea.ts), in a scene of its own: the landing's last hundred-odd metres (C1), taken
  // over from Get the Drift as one descent, then the rest of Part C and Act 3 (wandering/beats.ts) — or, with
  // ?sea[&hour=h], the sea test act alone on its own clock
  const seaQuery = new URLSearchParams(location.search);
  const seaTest = seaQuery.has('sea');
  const sea = seaTest
    ? createSea(renderer, { hour: seaQuery.has('hour') ? Number(seaQuery.get('hour')) : undefined })
    : createSea(renderer, {
        drive: (ts) => arrival.seaDrive(arrival.seaFrom + ts, arrival.seaFrom),
        c1End: arrival.total - arrival.seaFrom + C1_FOLLOW,
      });
  const seaStart = seaTest ? 0 : act2Start + arrival.seaFrom;
  const total = seaStart + sea.total;
  /** s the show fades to black over at its end (W5: "the title, or the game") */
  const END_FADE = 6;
  /** the end title: Act 1's signature again, over the outro's night (W6), in the crawl's overlay */
  const endTitle = [{ lines: ['the Drift'], at: seaTest ? Infinity : seaStart + seaBeats(arrival.total - arrival.seaFrom + C1_FOLLOW).starts.w6 + 9, signature: true }];
  let titleOn = false;
  /** s the hand-over into the sea's scene crossfades over: both scenes summed in HDR, each at its own exposure */
  const XF = 3;
  // through the landing Act 2 eases into the sea's look — its adaptation to the light where the sea takes over,
  // and its grade — so the crossfade only swaps what is drawn
  const handSun = arrival.seaDrive(arrival.seaFrom, arrival.seaFrom).sun;
  const handSky = skyIrradiance(EARTH_R, handSun);
  const seaAdapt = adaptation(0.2126 * handSky[0] + 0.7152 * handSky[1] + 0.0722 * handSky[2]);
  const landingFrom = driftBeats(p2).starts.landing;
  /** the sea acts' grade: a camera's contrast and colour over AgX's flat curve */
  const SEA_GRADE: [number, number] = [1.2, 1.12];
  const crawlLayout = (): CrawlLayout => ({
    elTop: p.crawlElTop,
    sink: p.crawlSink,
    holdEl: p.crawlHoldEl,
    size: p.crawlSize,
    fade: 3,
    end: act1,
    maxArc: p.crawlMaxArc,
  });
  const crawl = new CrawlOverlay(undertimeCrawl(p), crawlLayout());
  pocketAt = (at) => {
    const now = crawlBand(at, crawl.phrases, crawl.layout);
    let lo = now.strength > 0 ? now.lo : Infinity;
    let hi = now.strength > 0 ? now.hi : -Infinity;
    let strength = now.strength;
    for (const dt of [0.5, 1, 1.5, 2, 2.5, 3]) {
      const b = crawlBand(at + dt, crawl.phrases, crawl.layout);
      if (b.strength <= 0) continue;
      lo = Math.min(lo, b.lo);
      hi = Math.max(hi, b.hi);
      strength = Math.max(strength, b.strength * (1 - dt / 3.5));
    }
    return strength > 0 ? { lo, hi, az: p.crawlPocketAz, strength: strength * p.crawlPocket } : { lo: 0, hi: 0, az: p.crawlPocketAz, strength: 0 };
  };
  // the crawl lives in master space, so it shows in the dome view only
  // (the sea acts: SEA_GRADE — references/sea-golden-hour-sky)
  const dome = new DomeCapture({ faceSize: p.domeFace, overlay: crawl.texture, grade: true });

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
  let act2: (ArrivalState & { altitude: number }) | null = null;
  /** this frame's share of the sea's scene (0 before the hand-over, 1 after), its eye; and Act 2's exposure
   * and near plane */
  let seaK = 0;
  const seaEye = new THREE.Object3D();
  /** the sea's beats this frame (two across a dissolve), on its clock; and the end's fade */
  let seaPasses: Array<{ beat: BeatName; weight: number }> = [];
  let seaT = 0;
  let endFade = 1;
  let actExposure = 1;
  let actNear = 0.05;
  const prepare = (at: number): ReturnType<typeof undertimeState> => {
    const state = undertimeState(at, p);
    const x = seaTest ? 1 : Math.min(1, Math.max(0, (at - seaStart) / XF));
    seaK = x * x * (3 - 2 * x);
    dome.setFaceSize(faceOverride ?? p.domeFace);
    seaT = at - seaStart;
    seaPasses = seaK > 0 ? sea.passes(seaT) : [];
    const e = Math.min(1, Math.max(0, (total - at) / END_FADE));
    endFade = seaTest ? 1 : e * e * (3 - 2 * e);
    if (seaK >= 1) {
      dome.setGrade(...SEA_GRADE);
      titleOn = at >= endTitle[0].at;
      if (titleOn) {
        Object.assign(crawl.layout, crawlLayout(), { end: total, fade: END_FADE - 1 });
        crawl.phrases = endTitle;
        crawl.draw(at);
      }
      return state;
    }
    const t2 = at - act2Start;
    const g = Math.min(1, Math.max(0, (t2 - landingFrom) / (arrival.seaFrom - landingFrom)));
    const look = g * g * (3 - 2 * g);
    actExposure = 1 + (seaAdapt - 1) * look;
    dome.setGrade(1 + (SEA_GRADE[0] - 1) * look, 1 + (SEA_GRADE[1] - 1) * look);
    eye.quaternion.identity();
    act2 = t2 >= 0 ? arrival.update(t2, eye.position, eye.quaternion) : null;
    if (!act2) eye.position.set(...eyePath(at, p));
    // Undertime hands its world over to the galaxies, then leaves the scene
    const k = Math.min(1, Math.max(0, t2 / (p2.overlap + 2)));
    const fade = 1 - k * k * (3 - 2 * k);
    // the web stays on as the structure the galaxies sit on, dimmer, until we are inside our own galaxy
    const webKeep = act2 ? 0.45 * (1 - act2.local) + 0.55 * fade : 1;
    field.group.visible = fade > 0 || webKeep > 0.002;
    arrival.group.visible = t2 >= 0;
    const moved = eye.position.clone().sub(eyeWas);
    camera.position.add(moved);
    controls.target.add(moved);
    eyeWas.copy(eye.position);
    field.update(state, at, eye.position, fade, webKeep);
    // Get the Drift arrives at the Sun from galaxy distances: the near clip must follow the scale
    // (and once the planet is there, the nearest thing is its atmosphere, a thousand km off: 1e-4 of a unit)
    // (and as the landing comes down to the water, a few hundredths of the height)
    const near = act2 ? (act2.earth > 0 ? Math.min(1e-4, Math.max(1e-9, act2.altitude * 0.03)) : Math.max(1e-7, Math.min(0.05, act2.f * 0.02))) : 0.05;
    actNear = near;
    if (camera.near !== Math.min(near, 0.02)) {
      camera.near = Math.min(near, 0.02);
      camera.updateProjectionMatrix();
    }
    Object.assign(crawl.layout, crawlLayout());
    crawl.phrases = undertimeCrawl(p);
    crawl.draw(at);
    field.setPocket(pocketAt(at), p.domeTilt);
    return state;
  };
  /** how the master is presented (`exposure` on top of the show's) */
  const look = (exposure: number): DomeLook => ({
    exposure: p.exposure * exposure,
    bloomStrength: p.bloomStrength,
    bloomRadius: p.bloomRadius,
    bloomThreshold: p.bloomThreshold,
    overlayRadiance: seaK >= 1 && !titleOn ? 0 : p.crawlRadiance,
  });
  /** the prepared frame's scenes into the dome's accumulator with `weight`, shared out by the hand-over (each
   * scene's own exposure in its share, so present with `look(1)`) */
  const accumulate = (weight: number, first: boolean): void => {
    if (seaK < 1) {
      dome.setNear(actNear);
      dome.setFar(1e6);
      dome.accumulate(renderer, scene, eye, p.domeTilt, masterSize, weight * (1 - seaK) * actExposure, first);
    }
    // each of the sea's beats (a dissolve draws two), put in its state just before it is drawn
    let clear = first && seaK >= 1;
    for (const ps of seaPasses) {
      sea.update(seaT, seaEye, renderer, ps.beat);
      dome.setNear(0.05);
      dome.setFar(sea.far);
      dome.accumulate(renderer, sea.scene, seaEye, p.domeTilt, masterSize, weight * seaK * ps.weight * endFade * sea.exposure, clear);
      clear = false;
    }
  };
  let masterSize = 1024;
  const setPixelAngle = (rad: number): void => {
    field.setPixelAngle(rad);
    arrival.setPixelAngle(rad);
    sea.setPixelAngle(rad);
  };
  const renderMaster = (): void => {
    setPixelAngle(Math.PI / 2 / (pixelFace ?? p.domeFace));
    if (seaK <= 0) {
      dome.setNear(actNear);
      dome.setFar(1e6);
      dome.render(renderer, scene, eye, p.domeTilt, masterSize, look(actExposure));
      return;
    }
    accumulate(1, true);
    dome.presentAccumulated(renderer, look(1));
  };
  /** one recorded frame: the master of time `at`, motion-blurred over `shutter` s with `samples` sub-frames */
  const frame = (at: number, shutter: number, samples: number): void => {
    // the pixel size BEFORE the scene is prepared: the acts copy it into their shaders as they update, so set
    // after, a lane's first frame drew with the preview's pixel size (pixel-floored stars a frame too bright)
    setPixelAngle(Math.PI / 2 / (pixelFace ?? p.domeFace));
    if (samples <= 1) {
      prepare(at);
      renderMaster();
      return;
    }
    for (let i = 0; i < samples; i++) {
      prepare(at + shutter * ((i + 0.5) / samples - 0.5));
      accumulate(1 / samples, i === 0);
    }
    dome.presentAccumulated(renderer, look(1));
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
      setPixelAngle(((camera.fov * Math.PI) / 180) / (size.y * renderer.getPixelRatio()));
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
      const a2 = act2 as ArrivalState | null;
      const beatNow = seaPasses.map((ps) => ps.beat).join('→');
      const where = seaK >= 1 ? `the sea · ${beatNow}` : seaK > 0 ? 'the sea · hand-over' : a2 && t >= act1 ? `get the drift · ${a2.beat}` : `undertime · ${state.beat}`;
      hud.textContent =
        `${where.padEnd(26)} ${t.toFixed(2).padStart(6)} s / ${total.toFixed(0)} s  ×${speed}${paused ? '  paused' : ''}${recording}\n` +
        (a2 && t >= act1
          ? `view ${view}   distance ×${a2.f.toExponential(1)}  volume ${a2.volume.toFixed(2)}  local stars ${a2.local.toFixed(2)}  sun ${a2.sunStar.toFixed(2)}`
          : `view ${view}   pairs ${state.pairDensity.toFixed(2)}  glow ${state.glow.toFixed(2)}  clock ×${state.clockRate.toFixed(2)}  wave ${state.wave.toFixed(2)}  grains ${state.grains.toFixed(2)}  zoom ×${(1 / state.scale).toFixed(0)}  stars ${state.stars.toFixed(2)}`);
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
  /** the face size the master is matched to (`faceOverride` without supersampling): one master pixel's angle */
  let pixelFace: number | null = null;
  const record = async (o: Partial<DriftRecordOptions> = {}): Promise<number> => {
    loop.stop(); // nothing else draws while a take runs (Loom suspends its previews for the same reason)
    const size = o.size ?? 2048;
    faceOverride = faceSizeFor(size * (o.supersample ?? 1));
    pixelFace = faceSizeFor(size);
    const previewSize = masterSize;
    masterSize = size;
    try {
      return await recordDomeMaster(
        { to: total, ...o, size, onProgress: (n, of) => { recording = `  ● REC ${n}/${of}`; if (hud) hud.textContent = recording; } },
        { renderer, frame },
      );
    } finally {
      faceOverride = null;
      pixelFace = null;
      masterSize = previewSize;
      recording = '';
      loop.start();
    }
  };

  // the Earth's maps (~150 MB of satellite data) load in the background; nothing may be captured before
  await arrival.ready;
  await sea.ready;
  (window as unknown as Record<string, unknown>).__drift = {
    app,
    /** live tunables (src/params/drift.ts) — write a field and the next frame uses it */
    params: p,
    dome,
    field,
    sea,
    get t(): number {
      return t;
    },
    /** s, the show's end (every act) — what scripts/drift-render.mjs renders up to */
    total,
    arrival,
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
    // ?record[&size&fps&from&to&shot&group&lane&sink&inflight&blur&shutter&ss] — a lane of scripts/drift-render.mjs, or a one-off
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
      blur: num('blur', 1),
      shutter: num('shutter', 0.5),
      supersample: num('ss', 1),
    }).then(
      (frames) => (status.__driftRecord = { done: true, frames }),
      (e) => (status.__driftRecord = { done: true, error: String(e) }),
    );
  }
}

void boot();
