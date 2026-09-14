/**
 * §T.183 boat audio graph, wiring and isolation.
 *
 * WHY each block:
 *  - NODE BUDGET (tech-research §6.3): ≤ 50 AudioNodes with 8 boats and ≤ 2 HRTF panners — HRTF is the
 *    expensive panner, and a graph that grows per boat would blow the budget the moment a spectator
 *    fleet spawns. Measured through `createBoatAudio` itself on a counting mock context, with 8 and
 *    with 12 boats (the second proves stealing caps the graph, not the boat count).
 *  - VOICES: the three most audible rivals are the full voices, the rest cheap (task brief).
 *  - §V109: the speedboat page must never pull pirate/raft/combat/AI code in through its audio, and the
 *    worklet bundle must stay inside src/audio/boat + pure helpers (the AudioWorkletGlobalScope has no
 *    DOM; a module that touches `window` would throw on load and silence every boat).
 *  - V112: no phase accumulator in the voices reads a speed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBoatAudio, type BoatFrameTelemetry } from '../src/audio/boat/boatAudio';
import { BOAT_STRIDE, SI, SLOT_COUNT, SLOT_STRIDE } from '../src/audio/boat/protocol';
import { enginePositionOf, playerTelemetry } from '../src/audio/boat/pageSink';
import { boatAudioParams } from '../src/audio/boat/params';

const all = import.meta.glob('../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

// ───────────── counting mock WebAudio ─────────────
class Param {
  value = 0;
  events = 0;
  setValueAtTime(v: number) {
    this.value = v;
    this.events++;
    return this;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
    this.events++;
    return this;
  }
  setTargetAtTime(v: number) {
    this.value = v;
    this.events++;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}
const created: { kind: string; node: MockNode }[] = [];
class MockNode {
  panningModel = 'equalpower';
  distanceModel = 'inverse';
  refDistance = 1;
  maxDistance = 1;
  rolloffFactor = 1;
  gain = new Param();
  delayTime = new Param();
  threshold = new Param();
  knee = new Param();
  ratio = new Param();
  attack = new Param();
  release = new Param();
  positionX = new Param();
  positionY = new Param();
  positionZ = new Param();
  connect() {}
  disconnect() {}
}
const posted: { t: string; boats?: Float32Array; nBoats?: number; slots?: Float32Array }[] = [];
class MockWorkletNode extends MockNode {
  port = { postMessage: (m: never) => posted.push(m), onmessage: null as unknown };
  constructor(_ctx: unknown, _name: string, _opts: unknown) {
    super();
    created.push({ kind: 'worklet', node: this });
  }
}
function mockContext() {
  const make = (kind: string) => () => {
    const n = new MockNode();
    created.push({ kind, node: n });
    return n;
  };
  return {
    state: 'running',
    currentTime: 0,
    sampleRate: 48000,
    listener: { positionX: new Param(), positionY: new Param(), positionZ: new Param(), forwardX: new Param(), forwardY: new Param(), forwardZ: new Param(), upX: new Param(), upY: new Param(), upZ: new Param() },
    audioWorklet: { addModule: async () => {} },
    createGain: make('gain'),
    createDelay: make('delay'),
    createPanner: make('panner'),
    createDynamicsCompressor: make('compressor'),
  };
}

const camera = { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 10, 1] } };

function fleet(n: number, t: number): BoatFrameTelemetry[] {
  const boats: BoatFrameTelemetry[] = [
    { id: 0, isPlayer: true, voice: 'v8', position: [0, 0, 0], velocity: [0, 0, -40], throttle: 1, driveAdvance: [40, 40, 40], driveImmersion: [0.8, 0.8, 0.8], driveThrust: [9e3, 9e3, 9e3], wettedArea: 5, slamImpulse: 0 },
  ];
  const kinds = ['v8', 'turbine', 'twoStroke', 'electric'] as const;
  for (let i = 1; i < n; i++) {
    boats.push({ id: i, voice: kinds[i % 4], position: [20 * i * Math.cos(i + t), 0, 20 * i * Math.sin(i + t)], velocity: [30, 0, 0], throttle: 0.9, propImmersion: 0.85, wettedArea: 5, slamImpulse: 0 });
  }
  return boats;
}

describe('§T.183 node budget through createBoatAudio', () => {
  beforeEach(() => {
    created.length = 0;
    posted.length = 0;
    (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = MockWorkletNode;
  });
  afterEach(() => {
    delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
  });

  async function drive(boats: number) {
    const ctx = mockContext();
    const buses = { sfx: new MockNode(), ambience: new MockNode(), music: new MockNode() };
    const audio = createBoatAudio({ getContext: () => ctx as never, getBuses: () => buses as never }, { workletUrl: 'mock://worklet' });
    audio.update(fleet(boats, 0), 1 / 60, camera);
    await new Promise((r) => setTimeout(r, 0));
    expect(audio.ready()).toBe(true);
    for (let f = 0; f < 120; f++) {
      ctx.currentTime += 1 / 60;
      audio.update(fleet(boats, f / 60), 1 / 60, camera);
    }
    return audio;
  }

  it.each([8, 12])('%i boats: ≤ 50 nodes, ≤ 2 HRTF panners, and the graph does not grow per frame', async (boats) => {
    const audio = await drive(boats);
    const count = created.length;
    expect(count).toBe(audio.nodeCount());
    expect(count).toBeLessThanOrEqual(50);
    expect(created.filter((c) => c.kind === 'panner' && c.node.panningModel === 'HRTF').length).toBeLessThanOrEqual(2);
    // every panner leaves distance to the worklet (§V96 law), none uses the 350 m plateau model
    for (const c of created.filter((x) => x.kind === 'panner')) expect(c.node.rolloffFactor).toBe(0);
    audio.update(fleet(boats, 3), 1 / 60, camera);
    expect(created.length).toBe(count);
  });

  it('12 boats: player on its two slots, 7 NPC slots bound, exactly 3 full voices — the most audible', async () => {
    await drive(12);
    const frame = [...posted].reverse().find((m) => m.t === 'frame')!;
    const slots = frame.slots!;
    expect(slots[SI.BOAT]).toBe(0);
    expect(slots[SLOT_STRIDE + SI.BOAT]).toBe(0);
    const npc = Array.from({ length: SLOT_COUNT - 2 }, (_, i) => ({ boat: slots[(2 + i) * SLOT_STRIDE + SI.BOAT], full: slots[(2 + i) * SLOT_STRIDE + SI.FULL] > 0.5, gain: slots[(2 + i) * SLOT_STRIDE + SI.GAIN] }));
    expect(npc.filter((s) => s.boat >= 0).length).toBe(7);
    const full = npc.filter((s) => s.full);
    expect(full.length).toBe(3);
    const minFull = Math.min(...full.map((s) => s.gain));
    const maxCheap = Math.max(...npc.filter((s) => !s.full && s.boat >= 0).map((s) => s.gain));
    expect(minFull).toBeGreaterThan(maxCheap * 0.79);
    expect(frame.nBoats).toBe(12);
    expect(frame.boats!.length).toBe(12 * BOAT_STRIDE);
  });
});

// ───────────── isolation ─────────────
function imports(src: string): string[] {
  return [...src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm), ...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
}
function resolve(fromKey: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const parts = `${fromKey.replace(/\/[^/]+$/, '')}/${spec.replace(/\?.*$/, '')}`.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  const path = out.join('/');
  for (const cand of [path, `${path}.ts`, `${path}/index.ts`]) {
    const key = cand.startsWith('..') ? cand : `../${cand}`;
    if (key in all) return key;
  }
  return null;
}
function walk(roots: string[]): Set<string> {
  const seen = new Set(roots);
  const q = [...roots];
  while (q.length) {
    const k = q.shift()!;
    for (const spec of imports(all[k])) {
      const r = resolve(k, spec);
      if (r && !seen.has(r)) {
        seen.add(r);
        q.push(r);
      }
    }
  }
  return seen;
}

describe('§V109 boat audio isolation', () => {
  it('src/audio/boat reaches none of main.ts, main-raft.ts, raft/, combat/, ai/ at any depth', () => {
    const roots = Object.keys(all).filter((k) => k.startsWith('../src/audio/boat/'));
    expect(roots).toContain('../src/audio/boat/boatAudio.ts');
    expect(roots).toContain('../src/audio/boat/harness.ts');
    for (const k of walk(roots)) {
      expect(k).not.toMatch(/\/src\/main(-raft)?\.ts$/);
      expect(k).not.toMatch(/\/src\/(raft|combat|ai)\//);
    }
  });

  it('the worklet bundle stays inside src/audio/boat (no DOM-touching module in the AudioWorkletGlobalScope)', () => {
    const graph = walk(['../src/audio/boat/boatAudio.worklet.ts']);
    // §T.189: the physics engine model (pure) is the one module allowed in from outside
    for (const k of graph) expect(k.startsWith('../src/audio/boat/') || k === '../src/sea-physics/engine.ts').toBe(true);
    expect(graph.has('../src/audio/boat/synthCore.ts')).toBe(true);
  });

  it('V77 seam: engineModel.ts is the ONLY boat-audio module importing an engine model, and it imports the physics one', () => {
    const offenders = Object.entries(all)
      .filter(([k]) => k.startsWith('../src/audio/boat/') && k !== '../src/audio/boat/engineModel.ts')
      .filter(([, v]) => imports(v).some((spec) => /rpmModel|sea-physics\/engine/.test(spec)))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
    // and the seam really is on the physics model (§T.189), not only the temporary adapter
    expect(imports(all['../src/audio/boat/engineModel.ts'])).toContain('../../sea-physics/engine');
  });

  it('V112: no oscillator/crank phase in the voices advances by a speed', () => {
    const src = all['../src/audio/boat/voices.ts'];
    const phaseLines = src.split('\n').filter((l) => /Phase \+=|this\.phase \+=/.test(l));
    expect(phaseLines.length).toBeGreaterThan(8);
    for (const l of phaseLines) expect(l).not.toMatch(/speed|advance|sN\b/);
    expect(Object.entries(all).filter(([k, v]) => k.startsWith('../src/audio/boat/') && /playbackRate/.test(v))).toEqual([]);
  });
});

describe('§T.183 page seam adapter', () => {
  it('the engine emitter sits at the transom of the DRAWN hull: yawing the boat 180° swings it to the other side of the CG', () => {
    const ahead = enginePositionOf([10, 0, 0], [0, 0, 0, 1], boatAudioParams);
    const turned = enginePositionOf([10, 0, 0], [0, 1, 0, 0], boatAudioParams);
    expect(ahead[2]).toBeCloseTo(boatAudioParams.engineOffsetZ, 6);
    expect(turned[2]).toBeCloseTo(-boatAudioParams.engineOffsetZ, 6);
    expect(ahead[1]).toBeCloseTo(boatAudioParams.engineEmitterY, 6);
  });

  it('maps the seam frame onto the player telemetry without copying the hullWater arrays', () => {
    const thrust = new Float64Array([1, 2, 3]);
    const t = playerTelemetry(
      { frameDt: 1 / 60, view: { position: [1, 2, 3], quaternion: [0, 0, 0, 1] }, boat: { velocity: [0, 0, 20] }, controls: { throttle: 0.7 }, contact: { wettedArea: 4, slamImpulse: 99, propImmersion: 0.6, driveThrust: thrust } },
      'v8',
      boatAudioParams,
    );
    expect(t).toMatchObject({ isPlayer: true, throttle: 0.7, wettedArea: 4, slamImpulse: 99, propImmersion: 0.6 });
    expect(t.driveThrust).toBe(thrust);
    // no published rpm (or the zero-filled array before the sim's first step) ⟹ the voice integrates locally
    expect(t.rpm).toBeUndefined();
    const base = { frameDt: 1 / 60, view: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }, boat: { velocity: [0, 0, 0] }, controls: { throttle: 1 } };
    const zero = playerTelemetry({ ...base, contact: { wettedArea: 4, slamImpulse: 0, propImmersion: 1, driveThrust: thrust, driveRpm: new Float64Array(3) } }, 'v8', boatAudioParams);
    expect(zero.rpm).toBeUndefined();
    const live = new Float64Array([6100, 6090, 6110]);
    const pub = playerTelemetry({ ...base, contact: { wettedArea: 4, slamImpulse: 0, propImmersion: 1, driveThrust: thrust, driveRpm: live } }, 'v8', boatAudioParams);
    expect(pub.rpm).toBe(live);
  });
});
