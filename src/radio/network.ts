/**
 * THE NETWORK — every station the radio can reach, and what stands where it broadcasts from. ONE manifest for the
 * game and the film (the user, 2026-10-29, on The Drift's radio towers: they "should be the beacons that the radio
 * in the game is connecting to and also that the Rose was illustrating on the sky. Each island should have one";
 * and "inevitably we have to transport whatever we build here, at least in terms of aesthetics, not necessarily
 * layout, from the film to the game").
 *
 * SEVEN STATIONS. Three are the game's voiced stations: their id, title and frequency are READ from `stations.ts`,
 * never restated (§V87 — content is a manifest; retune a station there and the network follows). Four are relays
 * that carry no voice yet: on the dial they would be silent carriers, in the film they are four more towers in the
 * Rose. The film's Rose is seven stations (props.ts, c4: every one answering every other), so seven it is.
 *
 * EACH HAS ITS MAST: the structure on its island's summit and its aviation lamp, built by `mast.ts` from the
 * speedboat circuit's tower kit. Kinds:
 *
 *   broadcast  a heavy guyed TV/FM mast with a solid panel-antenna stack on its top section (the high island's)
 *   relay      a guyed mast of the kit's own proportions, its microwave dishes, no stack
 *   tower      a self-supporting lattice tower: wide at the foot, tapering, no guys
 *
 * Lamps are L-864-style red flashers, 20–40 flashes a minute, each on its own rate and phase (towers that are not
 * one structure are not synchronised); some are dead — a drowned world, decades on.
 *
 * §V71: WHERE A STATION STANDS IS NOT HERE. Each world resolves it, never from a constant: the game from a slice
 * island's summit POI (pathGraph.ts 'station', §T.104), the film from its coast and the Rose's ring
 * (src/drift/wandering/radioTower.ts). Pure data, no three.js — tests/radioNetwork.test.ts.
 */
import { RADIO_STATIONS } from './stations';

export type MastKind = 'broadcast' | 'relay' | 'tower';

export interface MastLamp {
  /** false: dead, dark — nothing is drawn */
  alive: boolean;
  /** flashes a minute (FAA AC 150/5345-43, L-864: 20–40) */
  flashesPerMin: number;
  /** 0..1 of a cycle: where in its blink this lamp is at time 0 */
  phase: number;
}

export interface MastSpec {
  kind: MastKind;
  /** m: the top of the whip over the footing */
  tipM: number;
  /** m: across a face of the triangular lattice at the foot (a `tower` tapers from it) */
  faceM: number;
  lamp: MastLamp;
}

export interface NetworkStation {
  id: string;
  title: string;
  /** MHz, on the game's dial (params/radio.ts band) */
  freqMHz: number;
  /** the game's voiced station this is (stations.ts id), or null: a relay with no voice yet */
  voice: string | null;
  mast: MastSpec;
}

const voiced = (id: string, mast: MastSpec): NetworkStation => {
  const s = RADIO_STATIONS.find((d) => d.id === id);
  if (!s) throw new Error(`radio network: no voiced station '${id}' in stations.ts`);
  return { id, title: s.title, freqMHz: s.freqMHz, voice: id, mast };
};
const relay = (id: string, title: string, freqMHz: number, mast: MastSpec): NetworkStation => ({ id, title, freqMHz, voice: null, mast });

export const NETWORK: readonly NetworkStation[] = [
  // the film's high island: the first tower as reviewed on 2026-10-29 (a heavy mast, 5 m face, 0.6 Hz), raised from 208 to
  // 250 m on 2026-10-30 (the user: "maybe ever so slightly [bigger] if it's an option"; its stack and guys scale with it)
  voiced('treetops', { kind: 'broadcast', tipM: 250, faceM: 5, lamp: { alive: true, flashesPerMin: 36, phase: 0 } }),
  // (the film's main cue, motu 2: a broadcast mast with its stack — as a slim relay it was a hairline 6 levels off the
  // sunset sky at the 4K pixel, its foot lost against the high island behind it, the 2026-10-29 towers round)
  voiced('wiggle', { kind: 'broadcast', tipM: 150, faceM: 4.5, lamp: { alive: true, flashesPerMin: 30, phase: 0.37 } }),
  voiced('lagoon', { kind: 'relay', tipM: 80, faceM: 2.6, lamp: { alive: true, flashesPerMin: 40, phase: 0.71 } }),
  // (a self-supporting tower's foot is ~a tenth of its height across)
  relay('relay-a', 'Relay A', 6.12, { kind: 'tower', tipM: 90, faceM: 9, lamp: { alive: false, flashesPerMin: 30, phase: 0 } }),
  relay('relay-b', 'Relay B', 6.58, { kind: 'relay', tipM: 160, faceM: 4, lamp: { alive: true, flashesPerMin: 24, phase: 0.15 } }),
  relay('relay-c', 'Relay C', 7.05, { kind: 'tower', tipM: 110, faceM: 11, lamp: { alive: true, flashesPerMin: 33, phase: 0.52 } }),
  relay('relay-d', 'Relay D', 7.48, { kind: 'relay', tipM: 140, faceM: 3.4, lamp: { alive: false, flashesPerMin: 30, phase: 0 } }),
];

/** the station `id`, or a loud failure (a tower placed for a station that does not exist is a bug) */
export function stationOf(id: string): NetworkStation {
  const s = NETWORK.find((n) => n.id === id);
  if (!s) throw new Error(`radio network: no station '${id}'`);
  return s;
}
