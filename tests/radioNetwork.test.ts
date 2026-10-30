/**
 * The radio network (src/radio/network.ts): one manifest the game's radio and the film's towers share. What must hold
 * whatever the stations are retuned or renamed to: the game's voiced stations are the game's own (their id, title and
 * frequency read from stations.ts, so a retune there cannot leave the film's towers broadcasting on a stale dial); every
 * station can be found on the dial and told apart from its neighbours; the masts are real-world masts; the lamps are
 * aviation flashers, not synchronised, some dead (a drowned world); and a station that does not exist fails loud.
 */
import { describe, expect, it } from 'vitest';
import { NETWORK, stationOf } from '../src/radio/network';
import { RADIO_STATIONS } from '../src/radio/stations';
import { radioParams } from '../src/params/radio';

describe('the radio network', () => {
  it('has the seven stations of the film\'s Rose, each once', () => {
    expect(NETWORK).toHaveLength(7);
    expect(new Set(NETWORK.map((s) => s.id)).size).toBe(7);
  });

  it('carries every voiced station of the game, as the game has it (one source: stations.ts)', () => {
    for (const g of RADIO_STATIONS) {
      const s = stationOf(g.id);
      expect(s.voice).toBe(g.id);
      expect(s.title).toBe(g.title);
      expect(s.freqMHz).toBe(g.freqMHz);
    }
    // and the rest are relays with no voice yet
    expect(NETWORK.filter((s) => s.voice === null)).toHaveLength(NETWORK.length - RADIO_STATIONS.length);
  });

  it('puts every station on the dial, a channel clear of the band\'s ends and of every other station', () => {
    const w = radioParams.channelWidth;
    const f = NETWORK.map((s) => s.freqMHz).sort((a, b) => a - b);
    expect(f[0] - radioParams.bandLowMHz).toBeGreaterThanOrEqual(w);
    expect(radioParams.bandHighMHz - f[f.length - 1]).toBeGreaterThanOrEqual(w);
    for (let i = 1; i < f.length; i++) expect(f[i] - f[i - 1]).toBeGreaterThan(2 * w);
  });

  it('stands a real mast on each island: 50–300 m, a guyed mast slender, a self-supporting tower broad at its foot', () => {
    for (const { mast } of NETWORK) {
      expect(mast.tipM).toBeGreaterThanOrEqual(50);
      expect(mast.tipM).toBeLessThanOrEqual(300);
      const slender = mast.tipM / mast.faceM;
      if (mast.kind === 'tower') expect(slender).toBeLessThan(15);
      else expect(slender).toBeGreaterThan(25);
    }
    // (and all three kinds stand somewhere: the islands differ)
    expect(new Set(NETWORK.map((s) => s.mast.kind)).size).toBe(3);
  });

  it('lights them as aviation flashers, 20–40 a minute, no two in step; some dead', () => {
    const alive = NETWORK.filter((s) => s.mast.lamp.alive);
    expect(alive.length).toBeGreaterThan(0);
    expect(alive.length).toBeLessThan(NETWORK.length);
    for (const { mast } of alive) {
      expect(mast.lamp.flashesPerMin).toBeGreaterThanOrEqual(20);
      expect(mast.lamp.flashesPerMin).toBeLessThanOrEqual(40);
    }
    const beats = new Set(alive.map((s) => `${s.mast.lamp.flashesPerMin}/${s.mast.lamp.phase}`));
    expect(beats.size).toBe(alive.length);
  });

  it('fails loud on a station that does not exist', () => {
    expect(() => stationOf('nowhere')).toThrow();
  });
});
