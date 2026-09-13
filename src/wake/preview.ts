/**
 * Wake pond — W1 browser harness (dev tool, not shipped: /src/wake/preview.html).
 *
 * Runs ONLY the GPU eWave solver (no ocean, no ship) so the solver can be
 * seen, timed and checked against its CPU reference while every other system
 * is mid-edit. Top-down, domain-fixed view: the domain follows the source on
 * whole texels exactly as the game will (`wakeAnchor`), so the source sits
 * still on screen and the wake streams astern.
 *
 * Modes (`?mode=` or `__wakePond.mode()`):
 *   kelvin  one Gaussian pressure patch towed at Froude `fr` (Darmon b = π√2σ),
 *           with the 19.47° Kelvin lines drawn from the source
 *   fleet   8 vessels × 54 samples (the galleon quadrature count) on circles
 *   impulse a single 0.5 s press — the dispersive ring, long waves leading
 *   preset  §T W2a calibration vessel (`?preset=galleon-7`, see WAKE_PRESETS:
 *           galleon-5/7/10, brigantine-7, raft-2, speedboat-40) towed from her
 *           own buoyancy stations / planing proxy, on the preset's tier, with
 *           the Rabaud–Moisy angle drawn from the stem
 *
 * Console (`window.__wakePond`):
 *   compare(steps?, fr?)  → CPU↔GPU residual on identical inputs (fresh solvers)
 *   timing()              → min-of-60 GPU ms for the compute group + splat pass
 *   capture(name)         → PNG of the canvas POSTed to ?sink= (scratch sink)
 *   preset(name)          → switch to a calibration preset
 *   readout()             → W2a numbers measured on a GPU state readback
 *   readoutCpu(name?)     → the same numbers from a fresh CPU tow (+ wave resistance)
 *
 * No canvas readback for measurement (sky/preview.ts note): the solver state is
 * read from a FRESH float RenderTarget per call (docs/agent-browser-harness.md §2).
 */
import * as THREE from 'three/webgpu';
import { Fn, float, int, ivec2, mix, positionWorld, smoothstep, textureLoad, uniform, vec3, vec4 } from 'three/tsl';
import { GRAVITY } from '../ocean/oceanMath';
import { installGpuTimer, type GpuTimer } from '../debug/gpuTimer';
import {
  WakeSolverCpu,
  WakeSourceBuffer,
  defaultSponge,
  splatSigma,
  wakeAnchor,
  WAKE_RHO,
  type HydroSample,
} from './wakeSolverMath';
import {
  WAKE_PRESETS,
  measureWake,
  presetAnchor,
  presetByName,
  presetFrame,
  presetSamples,
  rabaudMoisyAngleDeg,
  seaParamsFor,
  towPreset,
  towStep,
  type HullFrame,
  type WakePreset,
  type WakeReadout,
} from './wakeCalibration';
import { WakeSolverGpu } from './wakeSolverPasses';

const params = new URLSearchParams(location.search);
// the tier: W1 modes run 256² × 0.5 m; a preset brings its own (wakeCalibration WAKE_PRESETS)
let N = 256;
let TEXEL = 0.5;
let DOMAIN = N * TEXEL;
const SINK = params.get('sink') ?? 'http://127.0.0.1:5299';

const container = document.getElementById('app') as HTMLElement;
const hud = document.getElementById('hud') as HTMLElement;

const renderer = new THREE.WebGPURenderer({ antialias: false, ...({ trackTimestamp: true } as object) });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
await renderer.init();
container.appendChild(renderer.domElement);
const timer: GpuTimer | null = installGpuTimer(renderer);

let solver = new WakeSolverGpu({ n: N, texel: TEXEL });
const sources = new WakeSourceBuffer();

// ---------------------------------------------------------------------------
// view: top-down plane over the domain, screen up = world −z
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
camera.position.set(0, 50, 0);
camera.up.set(0, 0, -1);
camera.lookAt(0, 0, 0);

const uScale = uniform(0.25); // metres at full colour
const uSlopeShade = uniform(1);
let heightNodeTex = solver.heightTexture;
let slopeNodeTex = solver.slopeTexture;
const buildViewMaterial = (): THREE.MeshBasicNodeMaterial => {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = Fn(() => {
    // world x,z of this fragment in the domain frame → texel (i, j); texel i centre at (i − N/2)·TEXEL
    const i = int(positionWorld.x.div(TEXEL).add(N / 2).add(0.5).floor()).clamp(0, N - 1);
    const j = int(positionWorld.z.div(TEXEL).add(N / 2).add(0.5).floor()).clamp(0, N - 1);
    const h = textureLoad(heightNodeTex, ivec2(i, j)).x;
    const sl = textureLoad(slopeNodeTex, ivec2(i, j));
    const t = h.div(uScale).clamp(-1, 1);
    const crest = vec3(1.0, 0.62, 0.18);
    const trough = vec3(0.1, 0.55, 1.0);
    const base = vec3(0.05, 0.1, 0.14);
    const tint = mix(base, crest, smoothstep(0, 1, t)).add(mix(vec3(0), trough.sub(base), smoothstep(0, 1, t.negate())));
    // light from the upper left: shading by the solver's spectral slope
    const shade = float(1).add(sl.z.mul(-1.5).add(sl.w.mul(-1.5)).mul(uSlopeShade)).clamp(0.4, 1.6);
    return vec4(tint.mul(shade), 1);
  })();
  return m;
};
let viewMaterial = buildViewMaterial();
const plane = new THREE.Mesh(new THREE.PlaneGeometry(DOMAIN, DOMAIN).rotateX(-Math.PI / 2), viewMaterial);
scene.add(plane);

const lineMat = new THREE.LineBasicNodeMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 });
const kelvinLines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat);
kelvinLines.position.y = 1;
scene.add(kelvinLines);

const fitCamera = (): void => {
  const aspect = window.innerWidth / window.innerHeight;
  const half = DOMAIN / 2;
  camera.left = -half * Math.max(aspect, 1);
  camera.right = half * Math.max(aspect, 1);
  camera.top = half / Math.min(aspect, 1);
  camera.bottom = -half / Math.min(aspect, 1);
  camera.updateProjectionMatrix();
};
fitCamera();
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  fitCamera();
});

// ---------------------------------------------------------------------------
// scenarios — the SAME function feeds the GPU pond and the CPU comparison
// ---------------------------------------------------------------------------
type Mode = 'kelvin' | 'fleet' | 'impulse' | 'preset';
let mode: Mode = (params.get('mode') as Mode) ?? (params.get('preset') ? 'preset' : 'kelvin');
let froude = Number(params.get('fr') ?? 0.45);
let activePreset: WakePreset = presetByName(params.get('preset') ?? 'galleon-7');
let activeFrame: HullFrame = presetFrame(activePreset);
const presetScratch: HydroSample[] = [];
const SIGMA = 2; // m, effective splat σ of the towed patch
const W1_TEXEL = 0.5;
const FOOTPRINT = Math.sqrt(SIGMA * SIGMA - W1_TEXEL * W1_TEXEL);
const sponge = defaultSponge(256, W1_TEXEL);

interface Frame {
  cx: number;
  cz: number;
  srcX: number;
  srcZ: number;
}

/** fill `buf` for sim time t and return the anchor; pure in (mode, fr, t) */
function scenario(buf: WakeSourceBuffer, m: Mode, fr: number, t: number): Frame {
  buf.clear();
  if (m === 'preset') {
    const x = activePreset.speed * t;
    const r = Math.min(1, t / 4);
    const ramp = r * r * (3 - 2 * r);
    for (const q of presetSamples(activePreset, x, presetScratch)) buf.push(q.x, q.z, q.fy * ramp, q.footprint, q.depth);
    const c = presetAnchor(activePreset, activeFrame, x);
    return { cx: c.x, cz: c.z, srcX: x + activeFrame.stem, srcZ: 0 };
  }
  if (m === 'kelvin') {
    const sigma = splatSigma(FOOTPRINT, TEXEL, N);
    const U = fr * Math.sqrt(GRAVITY * Math.PI * Math.SQRT2 * sigma);
    const x = U * t;
    const ramp = Math.min(1, t / 3);
    const peak = 0.25; // m of head
    buf.push(x, 0, peak * WAKE_RHO * GRAVITY * 2 * Math.PI * sigma * sigma * ramp * ramp * (3 - 2 * ramp), FOOTPRINT);
    const c = wakeAnchor(x, 0, 1, 0, 0, DOMAIN, sponge, 4 * sigma);
    return { cx: c.x, cz: c.z, srcX: x, srcZ: 0 };
  }
  if (m === 'fleet') {
    // 8 hulls, 18 stations × 3 across, ≈ 12 m × 3 m, 0.25 m head, on circles
    for (let v = 0; v < 8; v++) {
      const radius = 14 + 5 * v;
      const speed = 2.2 + 0.25 * v;
      const dir = v % 2 === 0 ? 1 : -1;
      const a = (dir * speed * t) / radius + v * 0.9;
      const px = radius * Math.cos(a);
      const pz = radius * Math.sin(a);
      const fx = -Math.sin(a) * dir;
      const fz = Math.cos(a) * dir;
      const L = 12;
      const B = 3;
      const hull = [];
      for (let s = 0; s < 18; s++) {
        const u = -1 + (2 * (s + 0.5)) / 18;
        const halfBeam = (B / 2) * (1 - u * u);
        for (let c = -1; c <= 1; c++) {
          const along = (u * L) / 2;
          const across = (c * 2 * halfBeam) / 3;
          const area = (L / 18) * ((2 * halfBeam) / 3);
          hull.push({
            x: px + fx * along - fz * across,
            z: pz + fz * along + fx * across,
            fy: WAKE_RHO * GRAVITY * 0.25 * area * Math.min(1, t / 2),
            footprint: Math.sqrt(area) / 2,
            depth: 0,
          });
        }
      }
      buf.pushVessel(hull);
    }
    return { cx: 0, cz: 0, srcX: NaN, srcZ: NaN };
  }
  // impulse: 0.5 s press at the centre
  if (t < 0.5) buf.push(0, 0, 0.4 * WAKE_RHO * GRAVITY * 2 * Math.PI * 4, 1.5);
  return { cx: 0, cz: 0, srcX: NaN, srcZ: NaN };
}

// ---------------------------------------------------------------------------
// loop — rAF, or a rate-limited worker pump when the tab is hidden (§B.25)
// ---------------------------------------------------------------------------
let simTime = 0;
let paused = false;
let lastEncodeMs = 0;
let lastResidual = '—';
let frameCount = 0;
const DT = 1 / 60;
let busy = false;

function drawKelvinLines(f: Frame): void {
  if (!Number.isFinite(f.srcX) || (mode !== 'kelvin' && mode !== 'preset')) {
    kelvinLines.visible = false;
    return;
  }
  kelvinLines.visible = true;
  // hulls: the Rabaud–Moisy hull-length angle (= Kelvin below Fr_L 0.49)
  const a =
    mode === 'preset'
      ? (rabaudMoisyAngleDeg(activePreset.speed / Math.sqrt(GRAVITY * activeFrame.length)) * Math.PI) / 180
      : Math.asin(1 / 3);
  const len = DOMAIN;
  const sx = f.srcX - solver.centerX;
  const sz = f.srcZ - solver.centerZ;
  const pts = new Float32Array([
    sx, 0, sz, sx - len * Math.cos(a), 0, sz + len * Math.sin(a),
    sx, 0, sz, sx - len * Math.cos(a), 0, sz - len * Math.sin(a),
  ]);
  kelvinLines.geometry.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  kelvinLines.geometry.computeBoundingSphere();
}

function frame(): void {
  if (busy) return;
  busy = true;
  try {
    if (!paused) {
      // a fast hull must not jump more than ~0.4 σ per held step (towStep); the pond substeps
      const sub = mode === 'preset' ? Math.max(1, Math.ceil(DT / towStep(activePreset))) : 1;
      const t0 = performance.now();
      let f: Frame = { cx: 0, cz: 0, srcX: NaN, srcZ: NaN };
      for (let k = 0; k < sub; k++) {
        f = scenario(sources, mode, froude, simTime);
        solver.setCenter(f.cx, f.cz);
        solver.setSources(sources);
        solver.step(renderer, DT / sub);
        simTime += DT / sub;
      }
      lastEncodeMs = performance.now() - t0;
      drawKelvinLines(f);
    }
    renderer.render(scene, camera);
    timer?.tick();
    if (++frameCount % 15 === 0) {
      const t = timing();
      hud.textContent =
        `wake pond  mode ${mode}${mode === 'preset' ? ` ${activePreset.name}` : ` Fr ${froude.toFixed(2)}`}  t ${simTime.toFixed(1)} s\n` +
        `grid ${N}² × ${TEXEL} m  dispatches ${solver.computeNodes.length} in 1 group  samples ${solver.sampleCount}\n` +
        `GPU compute group ${fmt(t.computeMs)} ms  splat ${fmt(t.splatMs)} ms  (min of 60)\n` +
        `CPU encode ${lastEncodeMs.toFixed(3)} ms\n` +
        `CPU↔GPU ${lastResidual}` +
        (mode === 'preset' ? `\n${lastReadout}` : '');
    }
  } finally {
    busy = false;
  }
}
const fmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : '--');

let pumpWorker: Worker | null = null;
function startPump(): void {
  if (pumpWorker) return;
  const code = `let armed=true;onmessage=()=>{armed=true};setInterval(()=>{if(armed){armed=false;postMessage(0)}},16);`;
  pumpWorker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  pumpWorker.onmessage = () => {
    if (document.hidden) frame();
    pumpWorker?.postMessage(0);
  };
}
const raf = (): void => {
  if (!document.hidden) frame();
  requestAnimationFrame(raf);
};
requestAnimationFrame(raf);
startPump();

// ---------------------------------------------------------------------------
// measurement API
// ---------------------------------------------------------------------------
function timing(): { computeMs: number; splatMs: number; computePasses: number } {
  if (!timer) return { computeMs: NaN, splatMs: NaN, computePasses: 0 };
  const compute = timer.passes('compute');
  const render = timer.passes('render').filter((p) => p.label.startsWith('wake/head'));
  return {
    // the pool's min-of-window FRAME total: this page submits nothing but the wake group
    computeMs: timer.total('compute'),
    splatMs: render.length ? render[0].min : NaN,
    computePasses: compute.length,
  };
}

async function readState(gpu: WakeSolverGpu): Promise<Float32Array> {
  const n = gpu.n;
  const rt = new THREE.RenderTarget(n, n, { depthBuffer: false, type: THREE.FloatType });
  try {
    renderer.copyTextureToTexture(gpu.stateTexture, rt.texture);
    const raw = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, n, n)) as unknown as Float32Array;
    const perRow = (Math.ceil((n * 16) / 256) * 256) / 4;
    if (perRow === n * 4) return raw.slice(0, n * n * 4);
    const out = new Float32Array(n * n * 4);
    for (let y = 0; y < n; y++) out.set(raw.subarray(y * perRow, y * perRow + n * 4), y * n * 4);
    return out;
  } finally {
    rt.dispose();
  }
}

/**
 * CPU↔GPU agreement on identical inputs: fresh solvers, the same scenario,
 * the same Δt and the same texel-snapped anchor each step; then the GPU state
 * is read back and compared texel-for-texel with the CPU reference.
 */
async function compare(steps = 240, m: Mode = mode, fr = froude): Promise<Record<string, number | string>> {
  paused = true;
  const gpu = new WakeSolverGpu({ n: N, texel: TEXEL });
  const cpu = new WakeSolverCpu({ n: N, texel: TEXEL });
  const DT = m === 'preset' ? Math.min(1 / 60, towStep(activePreset)) : 1 / 60;
  const buf = new WakeSourceBuffer();
  try {
    for (let k = 0; k < steps; k++) {
      const f = scenario(buf, m, fr, k * DT);
      gpu.setCenter(f.cx, f.cz);
      cpu.setCenter(f.cx, f.cz);
      gpu.setSources(buf);
      cpu.splat(buf);
      gpu.step(renderer, DT);
      cpu.step(DT);
    }
    const state = await readState(gpu);
    let maxVis = 0;
    let maxHead = 0;
    let dVis = 0;
    let dHead = 0;
    let dEta = 0;
    let sqVis = 0;
    let nonFinite = 0;
    for (let idx = 0; idx < N * N; idx++) {
      // GPU state (ζ, φ, h_bin0, h_bin1); the drawn surface is ζ clamped
      const zeta = state[idx * 4];
      const head = state[idx * 4 + 2] + state[idx * 4 + 3];
      const vis = Math.max(-3, Math.min(3, zeta));
      if (!Number.isFinite(zeta) || !Number.isFinite(head)) nonFinite++;
      maxVis = Math.max(maxVis, Math.abs(cpu.surface[idx]));
      maxHead = Math.max(maxHead, Math.abs(cpu.head[idx]));
      dVis = Math.max(dVis, Math.abs(vis - cpu.surface[idx]));
      dHead = Math.max(dHead, Math.abs(head - cpu.head[idx]));
      dEta = Math.max(dEta, Math.abs(zeta - cpu.zeta[idx]));
      sqVis += (vis - cpu.surface[idx]) ** 2;
    }
    const result = {
      mode: m,
      froude: fr,
      steps,
      maxAbsVisCpu: maxVis,
      maxAbsHeadCpu: maxHead,
      maxDiffVis: dVis,
      rmsDiffVis: Math.sqrt(sqVis / (N * N)),
      relMaxDiffVis: dVis / Math.max(maxVis, 1e-12),
      maxDiffHead: dHead,
      relMaxDiffHead: dHead / Math.max(maxHead, 1e-12),
      maxDiffZeta: dEta,
      nonFinite,
      centerCpu: `${cpu.centerX},${cpu.centerZ}`,
      centerGpu: `${gpu.centerX},${gpu.centerZ}`,
    };
    lastResidual = `max|Δη_vis| ${dVis.toExponential(2)} m of ${maxVis.toFixed(3)} (${(result.relMaxDiffVis * 100).toFixed(3)}%)`;
    console.log('[wakePond] compare', result);
    return result;
  } finally {
    gpu.dispose();
    paused = false;
    timer?.reset();
  }
}

async function capture(name: string): Promise<string> {
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL('image/png');
  const res = await fetch(`${SINK}/${encodeURIComponent(name)}`, { method: 'POST', body: url });
  return res.text();
}

let lastReadout = 'readout: __wakePond.readout()';

function formatReadout(r: WakeReadout, extra = ''): string {
  const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '--');
  return (
    `Fr_L ${f(r.froudeL)}  λ_T ${f(r.lambdaT, 1)} m  p2t ${f(r.nearHullPeakToTrough)} m (≥0.83, ≤2.0 @ galleon 7)\n` +
    `bow ${f(r.bowCrest)}  stern ${f(r.sternCrest)}  shoulder ${f(r.shoulderCrest)} m  cusp slope ${f(r.cuspSlope, 3)} (0.14–0.40)\n` +
    `H(y=L/2) ${f(r.lineHeightHalfL)} m vs Kriebel ${f(r.kriebelHalfL)}  α_max ${f(r.alphaMaxDeg, 1)}° vs R–M ${f(r.alphaRabaudMoisyDeg, 1)}°  clamp ${r.clampHits}${extra}`
  );
}

/** W2a numbers on the GPU state (ζ, φ read back from a fresh RT) */
async function readout(): Promise<WakeReadout> {
  if (mode !== 'preset') throw new Error('readout: switch to a preset first (__wakePond.preset(name))');
  const state = await readState(solver);
  const nn = solver.n * solver.n;
  const zeta = new Float32Array(nn);
  const phi = new Float32Array(nn);
  for (let i = 0; i < nn; i++) {
    zeta[i] = state[i * 4];
    phi[i] = state[i * 4 + 1];
  }
  const shipX = activePreset.speed * simTime;
  const r = measureWake({ n: solver.n, texel: solver.texel, centerX: solver.centerX, centerZ: solver.centerZ, zeta, phi }, activeFrame, shipX, activePreset.speed);
  lastReadout = `GPU ${formatReadout(r)}`;
  console.log('[wakePond] readout', activePreset.name, r);
  return r;
}

/** the same numbers from a fresh CPU tow of a preset (steady, independent of the pond clock) */
function readoutCpu(name = activePreset.name): WakeReadout & { waveResistanceOverWeight: number } {
  const preset = presetByName(name);
  const tow = towPreset(preset);
  const r = measureWake(tow.solver, tow.frame, tow.x, preset.speed);
  const mass = seaParamsFor(preset.kind)?.mass ?? NaN;
  const out = { ...r, waveResistanceOverWeight: tow.solver.waveResistance(1, 0) / (mass * GRAVITY) };
  if (name === activePreset.name) lastReadout = `CPU ${formatReadout(r, `  R_w/W ${out.waveResistanceOverWeight.toFixed(4)}`)}`;
  console.log('[wakePond] readoutCpu', name, out);
  return out;
}

function rebuild(n: number, texel: number): void {
  N = n;
  TEXEL = texel;
  DOMAIN = n * texel;
  simTime = 0;
  const old = solver;
  solver = new WakeSolverGpu({ n: N, texel: TEXEL });
  heightNodeTex = solver.heightTexture;
  slopeNodeTex = solver.slopeTexture;
  viewMaterial = buildViewMaterial();
  plane.material = viewMaterial;
  plane.geometry.dispose();
  plane.geometry = new THREE.PlaneGeometry(DOMAIN, DOMAIN).rotateX(-Math.PI / 2);
  fitCamera();
  old.dispose();
  timer?.reset();
}

const api = {
  renderer,
  presets: WAKE_PRESETS.map((p) => p.name),
  readout,
  readoutCpu,
  preset(name: string): void {
    activePreset = presetByName(name);
    activeFrame = presetFrame(activePreset);
    mode = 'preset';
    lastReadout = 'readout: __wakePond.readout()';
    rebuild(activePreset.n, activePreset.texel);
  },
  get solver() {
    return solver;
  },
  timing,
  compare,
  capture,
  health: () => timer?.health() ?? null,
  mode(m: Mode, fr = froude): void {
    mode = m;
    froude = fr;
    if (m === 'preset') rebuild(activePreset.n, activePreset.texel);
    else rebuild(256, W1_TEXEL);
  },
  setScale(metres: number): void {
    uScale.value = metres;
  },
  setSlopeShade(v: number): void {
    uSlopeShade.value = v;
  },
  pause(p = true): void {
    paused = p;
  },
  get simTime() {
    return simTime;
  },
  frame,
};
(window as unknown as { __wakePond: typeof api }).__wakePond = api;
if (mode === 'preset') api.preset(activePreset.name); // ?preset=… boots on the preset's own tier
