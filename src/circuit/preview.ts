/**
 * TOWER REACH PREVIEW harness (§T.187, §V22 verification aid — NOT the game): the shared `buildSea` with the
 * circuit's kit islands, the course furniture at the measured placements, a free-fly camera and a minimap
 * overlay drawn from the Course/minimap data the HUD will get.
 *
 *   circuit-preview.html?cam=overhead|start|bar|pylons|street|tower&seed=1965&weather=swell&tod=17.5&lamps=0..5&green=1
 *
 * Fly: drag = look, W/A/S/D = move, Q/E = down/up, Shift = fast, 1–6 = camera presets, L = cycle start lamps.
 * `window.__circuit` = { app, world, furniture, sea, setCam, stats } for scripted browser checks.
 * §V109/§V95: shared sea plumbing (core/seaScene, core/seaFrame, core/postPipeline) by import only.
 */
import * as THREE from 'three/webgpu';
import { App } from '../core/app';
import { webgpuAvailable, renderGatePage } from '../core/gate';
import { installNodeTypeCache } from '../core/nodeTypeCache';
import { withFullCoverage } from '../core/bootCompile';
import { buildSea } from '../core/seaScene';
import { createSeaFrame } from '../core/seaFrame';
import { createPostPipeline } from '../core/postPipeline';
import { createHarnessHud } from '../debug/harnessHud';
import { createSky } from '../sky';
import { skyParams } from '../params/sky';
import { seaPhysicsParams } from '../params/seaPhysics';
import { weatherParams } from '../params/weather';
import { createWeatherSample, createWeatherSystem } from '../weather';
import { createInitialState } from '../state/simState';
import { buildTowerReach, towerReachSites } from './towerReach';
import { createCourseFurniture } from './courseFurniture';
import type { Vec2 } from '../race/types';

const q = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const v = Number(q.get(key));
  return q.has(key) && Number.isFinite(v) ? v : fallback;
};

async function boot(): Promise<void> {
  installNodeTypeCache();
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app root');
  if (!(await webgpuAvailable())) {
    renderGatePage(root);
    return;
  }
  const seed = Math.floor(num('seed', 1965));
  skyParams.timeOfDay = num('tod', 17.5);
  const app = await App.create(root);
  app.controls.enabled = false;
  app.camera.far = 20000;
  app.camera.updateProjectionMatrix();
  const state = createInitialState(2100);
  weatherParams.cellIntensity = 0;
  const weather = createWeatherSystem({ seed: state.seed });
  weather.apply(q.get('weather') ?? 'swell', { lerpSeconds: 0 });
  const weatherHere = createWeatherSample();
  const sky = createSky({ scene: app.scene });
  sky.configureRenderer(app.renderer);

  const layout = towerReachSites(seed);
  const t0 = performance.now();
  const sea = buildSea(app, state, sky, weather, { sites: layout.sites, wakeSpeedScale: 1, seaParams: seaPhysicsParams });
  const tSea = performance.now() - t0;
  const world = buildTowerReach(seed, { heightmaps: sea.archipelago.islands.map((i) => i.heightmap), seabed: sea.archipelago.seabed });
  const tCourse = performance.now() - t0 - tSea;
  const waterAt = (x: number, z: number): number => sea.cpuOcean.heightAt(x, z, state.time);
  const furniture = await createCourseFurniture({
    renderer: app.renderer,
    data: world.furniture,
    course: world.course,
    seabedAt: world.seabedAt,
    water: true,
  });
  app.scene.add(furniture.group);
  const seaFrame = createSeaFrame({ app, sea, sky, state, weatherHere, waterAt });

  // ── camera presets + free fly ───────────────────────────────────────────
  const gate = (id: string) => world.gates.find((g) => g.id === id)!;
  const { min, max } = world.minimap.bounds;
  const centre: Vec2 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
  const look = (from: [number, number, number], to: [number, number, number]): void => {
    app.camera.position.set(...from);
    app.camera.lookAt(new THREE.Vector3(...to));
  };
  const presets: Record<string, () => void> = {
    overhead: () => look([centre[0], Math.max(max[0] - min[0], max[1] - min[1]) * 1.05, centre[1] + 1], [centre[0], 0, centre[1]]),
    start: () => {
      const s = gate('S');
      look([s.mid[0] - s.heading[0] * 160, 2.2, s.mid[1] - s.heading[1] * 160], [s.mid[0] + s.heading[0] * 200, 8, s.mid[1] + s.heading[1] * 200]);
    },
    bar: () => {
      const x = world.bars[0].crossing ?? gate('G2').mid;
      const h = gate('G2').heading;
      look([x[0] - h[0] * 140, 2.0, x[1] - h[1] * 140], [x[0] + h[0] * 60, 0, x[1] + h[1] * 60]);
    },
    pylons: () => {
      const g = gate('G4');
      look([g.mid[0] - g.heading[0] * 260, 3.0, g.mid[1] - g.heading[1] * 260], [g.mid[0], 12, g.mid[1]]);
    },
    street: () => {
      const g = gate('G6');
      look([g.mid[0] - g.heading[0] * 90, 2.0, g.mid[1] - g.heading[1] * 90], [g.mid[0] + g.heading[0] * 120, 1, g.mid[1] + g.heading[1] * 120]);
    },
    tower: () => {
      const t = world.furniture.tower.at;
      const s = gate('S');
      look([s.mid[0] - s.heading[0] * 60 - 40, 9, s.mid[1] - s.heading[1] * 60 + 20], [t[0], 40, t[1]]);
    },
  };
  const presetNames = Object.keys(presets);
  const setCam = (name: string): void => (presets[name] ?? presets.overhead)();
  setCam(q.get('cam') ?? 'overhead');

  const keys = new Set<string>();
  let yaw = 0;
  let pitch = 0;
  const syncAngles = (): void => {
    const e = new THREE.Euler().setFromQuaternion(app.camera.quaternion, 'YXZ');
    yaw = e.y;
    pitch = e.x;
  };
  syncAngles();
  let dragging = false;
  addEventListener('keydown', (e) => {
    keys.add(e.key.toLowerCase());
    const i = Number(e.key) - 1;
    if (i >= 0 && i < presetNames.length) {
      setCam(presetNames[i]);
      syncAngles();
    }
    if (e.key === 'l') lamps = (lamps + 1) % 7;
  });
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  app.renderer.domElement.addEventListener('pointerdown', () => (dragging = true));
  addEventListener('pointerup', () => (dragging = false));
  addEventListener('pointermove', (e) => {
    if (!dragging) return;
    yaw -= e.movementX * 0.003;
    pitch = Math.max(-1.55, Math.min(1.55, pitch - e.movementY * 0.003));
  });
  let lamps = Math.floor(num('lamps', 0));

  // ── minimap overlay, drawn from the data the HUD gets ────────────────────
  const mm = document.createElement('canvas');
  mm.width = 260;
  mm.height = 260;
  Object.assign(mm.style, { position: 'fixed', right: '12px', top: '12px', background: 'rgba(11,21,22,0.82)', borderRadius: '3px', pointerEvents: 'none' });
  document.body.appendChild(mm);
  const ctx = mm.getContext('2d')!;
  const span = Math.max(max[0] - min[0], max[1] - min[1]);
  const P = (p: readonly [number, number]): [number, number] => [((p[0] - min[0]) / span) * 244 + 8, ((p[1] - min[1]) / span) * 244 + 8];
  const drawMinimap = (): void => {
    ctx.clearRect(0, 0, 260, 260);
    const ring = (r: readonly (readonly [number, number])[], close: boolean) => {
      ctx.beginPath();
      r.forEach((p, i) => (i ? ctx.lineTo(...P(p)) : ctx.moveTo(...P(p))));
      if (close) ctx.closePath();
    };
    ctx.fillStyle = 'rgba(111,178,176,0.35)';
    for (const r of world.minimap.shallows) {
      ring(r, true);
      ctx.fill();
    }
    ctx.fillStyle = '#A9A39A';
    for (const r of world.minimap.land) {
      ring(r, true);
      ctx.fill();
    }
    ctx.strokeStyle = '#F2B54A';
    ctx.lineWidth = 1.5;
    ring(world.minimap.course, true);
    ctx.stroke();
    for (const g of world.minimap.gates) {
      const sheltered = world.course.elements.some((e) => e.kind === 'gate' && e.gate.id === g.id && e.gate.sector === 'sheltered');
      ctx.strokeStyle = sheltered ? '#5FD39A' : '#FF6B1F';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(...P(g.left));
      ctx.lineTo(...P(g.right));
      ctx.stroke();
    }
    ctx.fillStyle = '#F2C94C';
    for (const m of world.minimap.marks) {
      ctx.beginPath();
      ctx.arc(...P(m.at), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#FF3B2A';
    ctx.beginPath();
    ctx.arc(...P(world.minimap.tower), 3.5, 0, Math.PI * 2);
    ctx.fill();
    const c = P([app.camera.position.x, app.camera.position.z]);
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(c[0], c[1], 3, 0, Math.PI * 2);
    ctx.fill();
  };

  const post = createPostPipeline(app.renderer, app.scene, app.camera, { sunDirection: () => sky.sunDirection });
  const hud = createHarnessHud();
  const pose = { position: [centre[0], 0, centre[1]], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0] };
  seaFrame.trackWake(pose, 6, -6, 2.5, 1 / 60);
  furniture.update({ camera: app.camera, time: 0, dt: 0, waterHeightAt: waterAt });
  await withFullCoverage(app.scene, () => Promise.all([post.warmup(), sea.flowFoam.warmAsync(app.renderer)]));
  const stats = () => ({ ...furniture.stats(), lap: world.lapLength, hash: world.hash, tSea, tCourse });
  (window as unknown as Record<string, unknown>).__circuit = { app, world, furniture, sea, setCam, stats };

  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  app.renderer.setAnimationLoop(() => {
    const dt = Math.min(hud.frame(), 0.1);
    state.time += dt;
    weather.update(dt);
    weather.weatherAt(app.camera.position.x, app.camera.position.z, weatherHere);
    seaFrame.tickSpectrum();
    pose.position[0] = app.camera.position.x;
    pose.position[2] = app.camera.position.z;
    seaFrame.trackWake(pose, 6, -6, 2.5, dt);
    // free fly
    app.camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    const speed = (keys.has('shift') ? 240 : 40) * dt;
    app.camera.getWorldDirection(fwd);
    right.crossVectors(fwd, app.camera.up).normalize();
    if (keys.has('w')) app.camera.position.addScaledVector(fwd, speed);
    if (keys.has('s')) app.camera.position.addScaledVector(fwd, -speed);
    if (keys.has('d')) app.camera.position.addScaledVector(right, speed);
    if (keys.has('a')) app.camera.position.addScaledVector(right, -speed);
    if (keys.has('e')) app.camera.position.y += speed;
    if (keys.has('q')) app.camera.position.y -= speed;
    seaFrame.renderSeaBase(pose, dt, false);
    seaFrame.renderSpray(pose);
    seaFrame.renderShore();
    seaFrame.renderFlowFoam(dt);
    furniture.update({
      camera: app.camera, time: state.time, dt, waterHeightAt: waterAt,
      nextElement: 1, startLamps: Math.min(lamps, 5), startGreen: lamps === 6 || q.get('green') === '1',
    });
    seaFrame.renderCameraPasses();
    seaFrame.renderSurface();
    post.updateFromParams();
    post.render();
    const info = app.renderer.info.render;
    hud.hud.setRenderStats(info);
    const s = furniture.stats();
    hud.setNotes([
      `Tower Reach · seed ${seed} · lap ${world.lapLength.toFixed(0)} m · hash ${world.hash} · sea ${tSea.toFixed(0)} ms · course ${tCourse.toFixed(0)} ms`,
      `furniture ${s.draws} draws · ${s.instances} instances · ${s.trianglesDrawn} tris · LOD ${s.lodHistogram.join('/')} · ~${s.textureMB.toFixed(1)} MB tex`,
      `gates ${world.gates.map((g) => `${g.id}:${g.k.toFixed(2)}`).join(' ')}`,
      `cam ${presetNames.map((n, i) => `${i + 1} ${n}`).join(' · ')} · lamps [L] ${lamps} · frame ${info.drawCalls} draws ${info.triangles} tris`,
    ]);
    drawMinimap();
  });
}

boot();
