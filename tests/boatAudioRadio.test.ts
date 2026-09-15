/**
 * §T.197 item 7: THE RACE RADIO HAS ITS OWN VOLUME.
 *
 * WHY: the pause screen has shown a 'Race radio' slider since §T.185, and nothing listened to it. A player who turns
 * the radio off to hear the engines must not lose the engines, and a player who drops Master must not keep hearing
 * the radio. The persisted setting must survive a reload, and a settings record saved before the radio field existed
 * must still load (with the default), or an old save would reset every other pause choice.
 */
import { describe, expect, it } from 'vitest';
import { createRadioBus, radioBusLevel } from '../src/audio/boat/radioBus';
import { DEFAULT_AUDIO, engineVolumes, loadRaceSettings, RACE_SETTINGS_KEY, radioLevel, saveRaceSettings, defaultRaceSettings } from '../src/speedboat/page/raceSettings';

class Param {
  value = 0;
  setValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  setTargetAtTime() {
    return this;
  }
}
class Node {
  gain = new Param();
  frequency = new Param();
  Q = new Param();
  type = '';
  buffer: unknown = null;
  onended: (() => void) | null = null;
  out: unknown[] = [];
  started = 0;
  constructor(readonly kind: string) {}
  connect(n: unknown) {
    this.out.push(n);
    return n;
  }
  disconnect() {}
  start() {
    this.started++;
  }
  stop() {}
}
function mockCtx() {
  const nodes: Node[] = [];
  const make = (kind: string) => () => {
    const n = new Node(kind);
    nodes.push(n);
    return n;
  };
  const destination = new Node('destination');
  return {
    nodes,
    ctx: {
      state: 'running',
      sampleRate: 48000,
      currentTime: 0,
      destination,
      createGain: make('gain'),
      createBiquadFilter: make('biquad'),
      createBufferSource: make('source'),
      createBuffer: (_c: number, n: number) => {
        const d = new Float32Array(n);
        return { getChannelData: () => d };
      },
    },
  };
}

/** does a started source reach the destination through the radio bus? */
function audibleThroughBus(nodes: Node[], bus: Node, destination: Node): boolean {
  const reaches = (n: unknown, seen = new Set<unknown>()): boolean => {
    if (n === destination) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    return (n as Node).out.some((m) => m === destination ? n === bus : reaches(m, seen));
  };
  return nodes.some((n) => n.kind === 'source' && n.started > 0 && reaches(n)) && bus.gain.value > 0;
}

describe('race radio bus', () => {
  const audio = (master: number, radio: number) => ({ ...DEFAULT_AUDIO, master, radio });

  it('radio at 0 silences the radio but leaves the engines at their level', () => {
    const a = audio(0.8, 0);
    expect(radioLevel(a)).toBe(0);
    expect(engineVolumes(a)).toMatchObject({ master: 0.8, sfx: DEFAULT_AUDIO.engines });
    const { ctx, nodes } = mockCtx();
    const bus = createRadioBus({ getContext: () => ctx as unknown as AudioContext });
    bus.setLevel(radioLevel(a));
    bus.call();
    expect(nodes.filter((n) => n.kind === 'source')).toHaveLength(0);
  });

  it('master at 0 silences the radio whatever the radio slider says', () => {
    expect(radioLevel(audio(0, 1))).toBe(0);
    const { ctx, nodes } = mockCtx();
    const bus = createRadioBus({ getContext: () => ctx as unknown as AudioContext });
    bus.setLevel(radioLevel(audio(0, 1)));
    bus.call();
    expect(nodes.filter((n) => n.kind === 'source')).toHaveLength(0);
  });

  it('a radio call is audible only through the bus, at master × radio', () => {
    const { ctx, nodes } = mockCtx();
    const bus = createRadioBus({ getContext: () => ctx as unknown as AudioContext });
    bus.setLevel(radioLevel(audio(0.5, 0.6)));
    bus.call();
    const node = bus.node as unknown as Node;
    expect(node.gain.value).toBeCloseTo(0.3, 12);
    expect(audibleThroughBus(nodes, node, ctx.destination)).toBe(true);
    // a live slider move reaches the built bus
    bus.setLevel(radioLevel(audio(0.5, 0)));
    expect(node.gain.value).toBe(0);
  });

  it('never builds before the context runs (browser gesture gate) and guards non-finite levels', () => {
    const bus = createRadioBus({ getContext: () => null });
    bus.setLevel(Number.NaN);
    expect(bus.level).toBe(0);
    expect(radioBusLevel(Number.POSITIVE_INFINITY, 0.5)).toBe(0);
    bus.setLevel(0.7);
    bus.call();
    expect(bus.node).toBeNull();
  });
});

describe('radio volume persistence', () => {
  const memStore = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it('the radio level survives a reload', () => {
    const s = memStore();
    const want = defaultRaceSettings();
    want.audio.radio = 0.15;
    saveRaceSettings(want, s);
    expect(loadRaceSettings(s).audio.radio).toBe(0.15);
  });

  it('a record saved without the radio field loads with the default radio and keeps the rest', () => {
    const s = memStore();
    s.setItem(RACE_SETTINGS_KEY, JSON.stringify({ camera: 'near', audio: { master: 0.4, engines: 0.2, music: 0.1 } }));
    const got = loadRaceSettings(s);
    // an older record also lacks §T.212's ambience level: it loads at its default the same way
    expect(got.audio).toEqual({ master: 0.4, engines: 0.2, radio: DEFAULT_AUDIO.radio, music: 0.1, ambience: DEFAULT_AUDIO.ambience });
    expect(got.camera).toBe('near');
  });
});
