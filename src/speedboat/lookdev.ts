/**
 * Speedboat asset LOOKDEV harness (§V22 verification aid — NOT the game, NOT the hero model).
 * Loads a contract GLB (today: the pipeline-test hull from `node scripts/asset-build.mjs`) through
 * the runtime asset module, so what is on screen is exactly what a speedboat page would draw.
 *
 * Query params (all optional):
 *   scene=studio|sea        studio: sky + grey ground, no ocean (cheap, default)
 *                           sea:    the shared buildSea() open sea, waterLighting + wetline + foam tag live
 *   variant=hero|npc        hero = transmissive perspex; npc = alpha perspex
 *   view=lit|slot|uv|normal|lod    material debug view (key [v] cycles)
 *   livery=<hex>            livery hue on the gelcoat mask, e.g. livery=d9442b (key [l] cycles)
 *   spin=0|1                turntable (key [space])
 *   count=1..8              instances in a row (draw-call sharing check; extra boats are npc)
 *   dist=<m>                initial camera distance      y=<m>  CG height above the sea (sea scene)
 *   tod=<h>                 time of day
 *
 * `window.__lookdev` exposes { app, asset, boats, setView } for scripted browser checks.
 * §V109: nothing here reaches main.ts, main-raft.ts, raft/, combat/ or ai/.
 */
import * as THREE from 'three/webgpu';
import { color, normalWorld, uv, vec3 } from 'three/tsl';
import { App } from '../core/app';
import { webgpuAvailable, renderGatePage } from '../core/gate';
import { installNodeTypeCache } from '../core/nodeTypeCache';
import { withFullCoverage } from '../core/bootCompile';
import { buildSea, type Sea } from '../core/seaScene';
import { createPostPipeline, type PostPipeline } from '../core/postPipeline';
import { createHarnessHud } from '../debug/harnessHud';
import { createSky } from '../sky';
import { skyParams } from '../params/sky';
import { seaPhysicsParams } from '../params/seaPhysics';
import { oceanParams } from '../ocean';
import { createWeatherSystem } from '../weather';
import { createInitialState } from '../state/simState';
import type { HullWetline } from '../caustics';
import {
  PIPELINE_TEST_BOAT_URL,
  createBoatAssetLoader,
  wetlineOptions,
  type BoatInstance,
  type BoatVariant,
  type SlotName,
} from './assets';

const VIEWS = ['lit', 'slot', 'uv', 'normal', 'lod'] as const;
type View = (typeof VIEWS)[number];
const LIVERIES = [null, 0xd9442b, 0x1f6fd1, 0xf2c230, 0x2a9d6f] as const;
const SLOT_DEBUG: Record<SlotName, number> = {
  M_Gelcoat: 0xf2f2f2, M_Antifoul: 0xc0392b, M_NonSlip: 0x7f8c8d, M_Carbon: 0x222244,
  M_Metal: 0xf1c40f, M_Perspex: 0x3498db, M_Rubber: 0x8e44ad, M_Cockpit: 0x27ae60, M_Pilot: 0xe67e22,
};
const LOD_DEBUG = [0x2ecc71, 0xf1c40f, 0xe74c3c];

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
  const sceneMode = q.get('scene') === 'sea' ? 'sea' : 'studio';
  const variant: BoatVariant = q.get('variant') === 'npc' ? 'npc' : 'hero';
  const count = Math.max(1, Math.min(8, Math.floor(num('count', 1))));
  const spinFromQuery = q.get('spin') !== '0';
  skyParams.timeOfDay = num('tod', skyParams.timeOfDay);

  const app = await App.create(root);
  const state = createInitialState(2100);
  const sky = createSky({ scene: app.scene });
  sky.configureRenderer(app.renderer);

  let sea: Sea | null = null;
  if (sceneMode === 'sea') {
    const weather = createWeatherSystem({ seed: state.seed });
    weather.apply('calm');
    sea = buildSea(app, state, sky, weather, { sites: [], wakeSpeedScale: 1, seaParams: seaPhysicsParams });
  } else {
    const ground = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshStandardNodeMaterial({ color: 0x8a8d90, roughness: 0.9 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    app.scene.add(ground);
  }

  const loader = await createBoatAssetLoader(app.renderer);
  const url = q.get('glb') ?? PIPELINE_TEST_BOAT_URL;
  const asset = await loader.load(url);
  const { extras, stats } = asset;

  // the wetline and caustics must be bound before the slot materials are built (TSL bakes graphs)
  let wetline: HullWetline | null = null;
  if (sea !== null) wetline = sea.caustics.attachHullWetline(wetlineOptions(extras));

  const boatY = sceneMode === 'sea' ? num('y', 0.3) : -extras.keelY + 0.02;
  const boats: BoatInstance[] = [];
  for (let i = 0; i < count; i++) {
    const b = asset.instantiate({
      variant: i === 0 ? variant : 'npc',
      water: sea !== null,
      livery: i === 0 ? undefined : (LIVERIES[1 + (i % (LIVERIES.length - 1))] as number),
      fovDeg: app.camera.fov,
    });
    b.object.position.set((i - (count - 1) / 2) * (extras.beam + 2.5), boatY, 0);
    app.scene.add(b.object);
    boats.push(b);
  }
  if (q.has('livery')) boats[0].setLivery(parseInt(q.get('livery') as string, 16));
  const hero = boats[0];

  // camera: orbit + turntable around the hero's mid-deck
  const length = extras.bowZ - extras.sternZ;
  const target = new THREE.Vector3(0, boatY + (extras.keelY + extras.deckY) / 2, (extras.bowZ + extras.sternZ) / 2);
  const dist = num('dist', length * 1.35);
  app.camera.position.set(target.x + dist * 0.72, target.y + dist * 0.32, target.z + dist * 0.62);
  app.controls.target.copy(target);
  app.controls.autoRotate = spinFromQuery;
  app.controls.autoRotateSpeed = 1.2;
  app.controls.update();
  sky.setShadowFocus(target.x, target.y, target.z);

  // debug views: shared per key, never per mesh
  const debugCache = new Map<string, THREE.Material>();
  const debugMaterial = (key: string, make: () => THREE.NodeMaterial): THREE.Material => {
    let m = debugCache.get(key);
    if (m === undefined) {
      m = make();
      debugCache.set(key, m);
    }
    return m;
  };
  const levelOf = (mesh: THREE.Object3D): number => {
    for (let o: THREE.Object3D | null = mesh; o !== null; o = o.parent) {
      const m = /^LOD(\d+)$/.exec(o.name);
      if (m) return Number(m[1]);
    }
    return 0;
  };
  let view: View = (VIEWS as readonly string[]).includes(q.get('view') ?? '') ? (q.get('view') as View) : 'lit';
  const setView = (v: View): void => {
    view = v;
    for (const b of boats) {
      if (v === 'lit') {
        b.overrideMaterials(null);
        continue;
      }
      b.overrideMaterials((slot, mesh) => {
        if (v === 'slot') {
          return debugMaterial(`slot:${slot}`, () => {
            const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
            m.colorNode = color(SLOT_DEBUG[slot]);
            return m;
          });
        }
        if (v === 'lod') {
          const lvl = Math.min(levelOf(mesh), LOD_DEBUG.length - 1);
          return debugMaterial(`lod:${lvl}`, () => {
            const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6 });
            m.colorNode = color(LOD_DEBUG[lvl]);
            return m;
          });
        }
        if (v === 'uv') {
          return debugMaterial('uv', () => {
            const m = new THREE.MeshBasicNodeMaterial();
            m.colorNode = vec3(uv().x, uv().y, 0);
            return m;
          });
        }
        return debugMaterial('normal', () => {
          const m = new THREE.MeshBasicNodeMaterial();
          m.colorNode = normalWorld.mul(0.5).add(0.5);
          return m;
        });
      });
    }
  };
  setView(view);
  let liveryIndex = 0;
  addEventListener('keydown', (e) => {
    if (e.key === 'v') setView(VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]);
    else if (e.key === 'l') {
      liveryIndex = (liveryIndex + 1) % LIVERIES.length;
      hero.setLivery(LIVERIES[liveryIndex]);
    } else if (e.key === ' ') app.controls.autoRotate = !app.controls.autoRotate;
  });

  const hud = createHarnessHud();
  const mb = (stats.textureBytes / (1024 * 1024)).toFixed(1);
  const staticNotes = [
    `${extras.pipelineTest ? 'PIPELINE TEST asset — not the hero model' : 'speedboat asset'} · ${sceneMode} · ${variant} · ${count} boat(s)`,
    `asset tris/LOD ${stats.lods.map((l) => l.tris).join(' / ')} · draws/LOD ${stats.lods.map((l) => l.draws).join(' / ')}`,
    `materials ${stats.materials} · textures ${stats.textures} · ${mb} MB GPU texture memory`,
    `L ${length.toFixed(2)} m · beam ${extras.beam.toFixed(2)} m · stern ${extras.sternZ} → bow ${extras.bowZ}`,
  ];
  const wetContacts = wetline ? new Float32Array(wetline.stations * 2).fill(-boatY) : null;

  // sea scene draws through the shared post pipeline, as the game does: the ocean's scene-colour copy
  // tracks the HALF-FLOAT pass target, and a bare compileAsync against the 8-bit canvas made every
  // framebuffer-copy node fail ("copyFramebufferToTexture: bgra8unorm rgba16float", browser sync
  // 2026-09-13). post.warmup() binds the pass target for the compile (postPipeline §T.124).
  const post: PostPipeline | null = sea !== null ? createPostPipeline(app.renderer, app.scene, app.camera, { sunDirection: () => sky.sunDirection }) : null;
  await withFullCoverage(app.scene, () =>
    Promise.all([post ? post.warmup() : app.renderer.compileAsync(app.scene, app.camera), sea ? sea.flowFoam.warmAsync(app.renderer) : null]),
  );
  (window as unknown as Record<string, unknown>).__lookdev = { app, asset, boats, sea, setView, stats, extras };

  app.renderer.setAnimationLoop(() => {
    const dt = Math.min(hud.frame(), 0.1);
    state.time += dt;
    sky.update(skyParams.timeOfDay);
    if (sea !== null) {
      sea.ocean.update(app.renderer, state.time);
      sea.foam.update(app.renderer, dt);
      sea.caustics.update(sky.sunDirection);
      sea.fetchField.update(oceanParams.windDirection);
      if (wetline && wetContacts) wetline.updateFromContacts(dt, wetContacts);
      sea.flowFoam.setCenter(0, 0);
      // the wake track is sim state (flowFoam.update errors if it never advances): the lookdev boat
      // sits still at the origin, so it advances a zero-speed ship like raftFrame.tickSea does
      sea.flowFoam.setShip([0, 0], 0, 0, extras.bowZ, extras.sternZ, extras.beam);
      sea.flowFoam.advanceWake(dt);
      sea.flowFoam.renderInjection(app.renderer, app.scene);
      sea.flowFoam.update(app.renderer, dt);
    }
    app.controls.update();
    if (sea !== null) {
      sea.clouds.update(state.time, sky.sunDirection);
      sea.reflection?.update(app.camera, state.time);
      sea.surface.update(app.camera, state.time, sky.sunDirection);
    }
    if (post) {
      post.updateFromParams();
      post.render();
    } else {
      app.render();
    }
    const info = app.renderer.info.render;
    hud.hud.setRenderStats(info);
    hud.setNotes([
      ...staticNotes,
      `hero LOD ${hero.currentLevel()} · frame ${info.drawCalls} draws · ${info.triangles} tris · view ${view} [v] · livery [l] · spin [space]`,
    ]);
  });
}

boot();
