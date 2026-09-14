/**
 * BOAT-SELECT PICTURES FROM THE RUNTIME BOAT (§T.201, USER: "we should definitely use clean renders of our actual boats
 * for the boat selection instead of this weird sketch placeholder"). RENDER ONLY: nothing here reads or writes sim state.
 *
 * WHAT IS DRAWN. The loaded hero GLB (`boats.asset`), instantiated with the SAME slot materials the race uses
 * (`slotMaterials.ts`, the `water: false` studio build of each slot: same textures, same hull mask, same number glyphs)
 * wearing `liveryFor(paint, number)` read from `assets/livery.ts` at call time, never a copy of its palette. The seated
 * hero pilot is BORROWED for the draw (moved into the preview hull, skeleton refreshed, moved back), so the picture has
 * the one pilot the race has and no second GLB load. Studio light: a sky/sea hemisphere, a warm key, a cool rim.
 *
 *  - THUMBNAILS: one offscreen render per paint into a render target that is the renderer's OUTPUT target (so the
 *    game's tone mapping and sRGB conversion apply), read back once, downscaled on a 2D canvas, cached as a data URL
 *    per (paint, number). Lazy: the first time the select opens, never at boot. `stats` records the cost.
 *  - TURNTABLE: while mounted, `render()` (called after the frame's own render) draws the chosen boat into the preview
 *    host's rect on the main canvas (view offset + scissor, no readback), auto-rotating, drag to orbit. It stands on a
 *    STAGE drawn in the same pass (USER: "a more stylish way to embed it in the UI instead of just a black box"): a
 *    dusk sea-horizon gradient, a water disc glowing in the livery's signature hue and a soft contact shadow; the DOM
 *    around it (boatSelect.ts) adds the stencil brackets, the clipped corner and the number tag. Thumbnails skip the stage.
 */
import * as THREE from 'three/webgpu';
import { clamp, color, exp, float, length, mix, positionGeometry, pow, screenUV, smoothstep, uniform, uv, vec4 } from 'three/tsl';
import type { BoatAsset, BoatInstance } from '../assets';
import { COMMUNITY_PAINTS } from '../ui/roster';
import { liveryFor } from './liveries';

export interface BoatPreviewDeps {
  renderer: THREE.WebGPURenderer;
  asset: BoatAsset;
  /** the seated hero pilot once it has loaded (borrowed per draw), null before */
  pilot(): THREE.Object3D | null;
}

export interface BoatPreview {
  /** every paint's picture at race number `number`; `onThumb` fires as each lands (cached per paint + number) */
  thumbnails(number: number, onThumb: (paintId: string, src: string) => void): Promise<void>;
  /** start the live turntable in `host`'s rect; returns the disposer */
  mount(host: HTMLElement): () => void;
  setSelection(paintId: string, number: number): void;
  /** per frame, after the frame's own render; a no-op unless mounted */
  render(dt: number): void;
  readonly stats: { thumbs: number; thumbMs: number; firstBatchMs: number };
}

/** thumbnail pixels (drawn at 2× and averaged down: the readback target has no MSAA). 2×W×4 bytes is a multiple of 256,
 * so the GPU readback's rows need no padding */
export const THUMB_W = 384;
export const THUMB_H = 128;

export function createBoatPreview(d: BoatPreviewDeps): BoatPreview {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xd8e8ec, 0x2a4a50, 1.6));
  const key = new THREE.DirectionalLight(0xfff0dc, 3.2);
  key.position.set(-8, 10, 9);
  const rim = new THREE.DirectionalLight(0xa8d4e0, 1.8);
  rim.position.set(9, 5, -10);
  scene.add(key, rim);

  const camera = new THREE.PerspectiveCamera(30, THUMB_W / THUMB_H, 0.5, 200);
  let boat: BoatInstance | null = null;
  const turn = new THREE.Group(); // yaw
  scene.add(turn);
  const midZ = (d.asset.extras.bowZ + d.asset.extras.sternZ) / 2;

  // ── the turntable's stage (hidden for thumbnails) ──
  const stage = new THREE.Group();
  const rectTop = uniform(0);
  const rectH = uniform(1);
  const t = clamp(screenUV.y.sub(rectTop).div(rectH), 0, 1);
  const HORIZON = 0.56;
  const skyCol = mix(color(0x35555a), color(0x1a2e31), smoothstep(0, HORIZON, t));
  const seaCol = mix(color(0x10211f), color(0x071112), smoothstep(HORIZON, 1, t));
  const backdropMat = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
  backdropMat.vertexNode = vec4(positionGeometry.x, positionGeometry.y, float(0.999), float(1));
  backdropMat.colorNode = mix(skyCol, seaCol, smoothstep(HORIZON - 0.004, HORIZON + 0.004, t)).add(
    color(0x9cc3c4).mul(exp(t.sub(HORIZON).abs().mul(-60)).mul(0.22)),
  );
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), backdropMat);
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -1000;
  const glowHue = uniform(new THREE.Color(0xe4572e));
  const soft = (strength: number, falloff: number) => pow(clamp(float(1).sub(length(uv().sub(0.5)).mul(2)), 0, 1), falloff).mul(strength);
  const glowMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  glowMat.colorNode = glowHue;
  glowMat.opacityNode = soft(0.3, 2.8);
  const glow = new THREE.Mesh(new THREE.CircleGeometry(9, 64), glowMat);
  const shadowMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  shadowMat.colorNode = color(0x000000);
  shadowMat.opacityNode = soft(0.75, 1.4);
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 48), shadowMat);
  const waterY = d.asset.extras.keelY + 0.35;
  glow.rotation.x = shadow.rotation.x = -Math.PI / 2;
  glow.position.y = waterY - 0.02;
  shadow.position.y = waterY;
  shadow.scale.set(d.asset.extras.beam * 0.75, ((d.asset.extras.bowZ - d.asset.extras.sternZ) / 2) * 1.05, 1);
  stage.add(backdrop, glow);
  turn.add(shadow); // turns with the hull
  scene.add(stage);
  const showStage = (on: boolean): void => {
    stage.visible = on;
    shadow.visible = on;
  };

  const ensureBoat = (): BoatInstance => {
    if (boat) return boat;
    boat = d.asset.instantiate({ variant: 'hero', water: false, livery: liveryFor('signal', 1), fovDeg: camera.fov });
    if (boat.waterMask) boat.waterMask.visible = false; // no sea here; the cap would only cost a draw
    boat.object.position.set(0, 0, -midZ); // spin about the hull's middle, not the CG
    turn.add(boat.object);
    return boat;
  };

  /** 3/4 bow view from a little above the sheer; `aspect` is the framed picture's, `dist` metres out */
  const frame = (aspect: number, yaw: number, dist: number): void => {
    turn.rotation.y = yaw;
    camera.aspect = aspect;
    camera.clearViewOffset();
    camera.position.set(dist * 0.84, dist * 0.24, dist * 0.5);
    camera.lookAt(0, 0.6, 0);
    camera.updateProjectionMatrix();
  };

  /** run `draw` with the race's hero pilot seated in the preview hull (render-time borrow, restored before return) */
  const withPilot = (draw: () => void): void => {
    const pilot = d.pilot();
    const home = pilot?.parent ?? null;
    if (!pilot || !boat) return draw();
    boat.object.add(pilot);
    refreshSkin(pilot);
    try {
      draw();
    } finally {
      home?.add(pilot);
      refreshSkin(pilot);
    }
  };

  const saveState = () => {
    const r = d.renderer;
    return { clear: r.getClearColor(new THREE.Color() as unknown as Parameters<typeof r.getClearColor>[0]) as unknown as THREE.Color, alpha: r.getClearAlpha(), exposure: r.toneMappingExposure, target: r.getRenderTarget(), out: r.getOutputRenderTarget() };
  };
  const restoreState = (s: ReturnType<typeof saveState>): void => {
    const r = d.renderer;
    r.setClearColor(s.clear, s.alpha);
    r.toneMappingExposure = s.exposure;
    r.setOutputRenderTarget(s.out);
    r.setRenderTarget(s.target);
  };

  // ── thumbnails ──
  const cache = new Map<string, string>();
  const stats = { thumbs: 0, thumbMs: 0, firstBatchMs: 0 };
  let target: THREE.RenderTarget | null = null;
  let compiled: Promise<void> | null = null;
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const big = document.createElement('canvas');
  big.width = THUMB_W * 2;
  big.height = THUMB_H * 2;

  async function thumb(paintId: string, number: number): Promise<string> {
    const b = ensureBoat();
    b.setLivery(liveryFor(paintId, number));
    target ??= new THREE.RenderTarget(THUMB_W * 2, THUMB_H * 2, { depthBuffer: true });
    const r = d.renderer;
    const saved = saveState();
    try {
      r.setClearColor(0x000000, 0);
      r.toneMappingExposure = 1;
      r.setOutputRenderTarget(target); // the output target: tone mapping + sRGB land in these bytes
      r.setRenderTarget(target);
      showStage(false);
      frame(THUMB_W / THUMB_H, -0.55, 8.5);
      withPilot(() => r.render(scene, camera));
    } finally {
      restoreState(saved);
    }
    const px = (await r.readRenderTargetPixelsAsync(target, 0, 0, THUMB_W * 2, THUMB_H * 2)) as Uint8Array;
    const g = big.getContext('2d') as CanvasRenderingContext2D;
    g.putImageData(new ImageData(new Uint8ClampedArray(px.buffer as ArrayBuffer, px.byteOffset, THUMB_W * 2 * THUMB_H * 2 * 4), THUMB_W * 2, THUMB_H * 2), 0, 0);
    const s = canvas.getContext('2d') as CanvasRenderingContext2D;
    s.clearRect(0, 0, THUMB_W, THUMB_H);
    s.imageSmoothingQuality = 'high';
    s.drawImage(big, 0, 0, THUMB_W, THUMB_H);
    return canvas.toDataURL('image/png');
  }

  let queue: Promise<void> = Promise.resolve();

  // ── turntable ──
  let host: HTMLElement | null = null;
  const rect = { x: 0, y: 0, w: 0, h: 0 };
  let yaw = -0.55;
  const SPIN = 0.35; // rad/s
  const canvasSize = new THREE.Vector2();
  let dragging = false;
  let lastX = 0;
  let idleFor = 0;
  let paint = 'signal';
  let num = 1;
  const measure = (): void => {
    if (!host) return;
    const b = host.getBoundingClientRect();
    rect.x = b.left;
    rect.y = b.top;
    rect.w = b.width;
    rect.h = b.height;
  };
  const onDown = (e: PointerEvent): void => {
    dragging = true;
    lastX = e.clientX;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    yaw += (e.clientX - lastX) * 0.01;
    lastX = e.clientX;
    idleFor = 0;
  };
  const onUp = (): void => {
    dragging = false;
  };

  return {
    stats,
    thumbnails(number, onThumb) {
      // serial on purpose: one render target, one readback at a time, and the first open pays for compile once
      queue = queue.then(async () => {
        const t0 = performance.now();
        if (!compiled) {
          ensureBoat();
          frame(THUMB_W / THUMB_H, yaw, 8.5);
          showStage(true); // the stage's pipelines compile here too, not as a stall on the first turntable frame
          compiled = d.renderer.compileAsync(scene, camera).catch((e: unknown) => console.warn('[speedboat] preview compile', e));
        }
        await compiled;
        for (const p of COMMUNITY_PAINTS) {
          const k = `${p.id}#${number}`;
          let src = cache.get(k);
          if (!src) {
            const t = performance.now();
            try {
              src = await thumb(p.id, number);
            } catch (e) {
              console.warn(`[speedboat] boat-select thumbnail '${p.id}' failed:`, e); // fail loud, keep the colour chip
              continue;
            }
            cache.set(k, src);
            stats.thumbs++;
            stats.thumbMs += performance.now() - t;
          }
          onThumb(p.id, src);
        }
        if (stats.firstBatchMs === 0) stats.firstBatchMs = performance.now() - t0;
        boat?.setLivery(liveryFor(paint, num));
      });
      return queue;
    },
    mount(el) {
      host = el;
      ensureBoat();
      measure();
      el.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('resize', measure);
      return () => {
        el.removeEventListener('pointerdown', onDown);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('resize', measure);
        host = null;
      };
    },
    setSelection(paintId, number) {
      paint = paintId;
      num = number;
      const l = liveryFor(paintId, number);
      boat?.setLivery(l);
      (glowHue.value as THREE.Color).setHex(l.dominant);
    },
    render(dt) {
      if (!host || !boat || rect.w < 2 || rect.h < 2) return;
      idleFor += dt;
      if (!dragging && idleFor > 1.2) yaw += SPIN * dt;
      const r = d.renderer;
      const saved = saveState();
      const autoClear = r.autoClear;
      try {
        // the host's rect on the main canvas (top-left origin on WebGPU): a studio plane with the boat on it
        r.setClearColor(0x071112, 1);
        r.toneMappingExposure = 1;
        r.setRenderTarget(null);
        // the whole canvas is the window onto a picture framed for the host's rect (a view offset), and the scissor keeps
        // the draw inside it: no viewport change, so the output pass's screen UVs stay the canvas's own
        const size = r.getSize(canvasSize);
        showStage(true);
        rectTop.value = rect.y / size.y;
        rectH.value = rect.h / size.y;
        turn.rotation.y = yaw;
        camera.aspect = rect.w / rect.h;
        camera.position.set(16 * 0.94, 16 * 0.34, 0); // 20° down, side on to the spin axis; the bow swinging past stays in frame
        camera.lookAt(0, 0.2, 0);
        camera.setViewOffset(rect.w, rect.h, -rect.x, -rect.y, size.x, size.y);
        r.setScissor(rect.x, rect.y, rect.w, rect.h);
        r.setScissorTest(true);
        r.autoClear = true;
        withPilot(() => r.render(scene, camera));
      } finally {
        r.setScissorTest(false);
        camera.clearViewOffset();
        r.autoClear = autoClear;
        restoreState(saved);
      }
    },
  };
}

/** a borrowed skinned rig moved to a new parent: world matrices and bone matrices again, before this frame's draw */
function refreshSkin(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh) m.skeleton.update();
  });
}
