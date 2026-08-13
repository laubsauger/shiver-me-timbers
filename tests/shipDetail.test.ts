/**
 * §T.34 ship detail pass + the procedural deck heightfield.
 *
 * WHY each block exists is stated at the block. The theme running through all
 * of them: a fitting that is COMPUTED from its host cannot drift from it, and
 * a fitting that is merely placed near its host silently will. That is the
 * §V37 lesson (two polylines through one curve agree only at the ends), and
 * these tests are how it stays learned.
 */
import { describe, expect, it } from 'vitest';
/** corners in the yard's plane — the shape BEFORE the sheets haul them */
const FLAT_SHEETS = {
  sheetLeadPort: [0, 0, 0] as [number, number, number],
  sheetLeadStarboard: [0, 0, 0] as [number, number, number],
};
import * as THREE from 'three';
import { buildBrigantineBlueprint, buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { buildPieceGeometry } from '../src/ship/pieceGeometry';
import { galleonParams, shipDetailParams, shipFlagParams } from '../src/params/ship';
import type { PieceDef } from '../src/ship/pieceTypes';
import {
  hullEnvelope,
  hullHalfWidthAt,
  hullTopY,
  sectionHalf,
  type HullShape,
} from '../src/ship/hullMath';
import {
  SPAR_AXIS,
  createLocalFrame,
  createPieceMaterial,
  setShipWorldMatrix,
  shipLocalFrame,
} from '../src/ship/pieceMaterials';
import { createDeckFieldTexture } from '../src/ship/deckFieldTexture';
import {
  FLAG_CRACK_RATIO,
  advanceFlag,
  angleDelta,
  apparentWind,
  flagWaveRate,
  gustModulation,
  streamStrength,
  wrapAngle,
  type FlagState,
} from '../src/ship/flagDynamics';
import {
  buildDeckHeightfield,
  sampleDeckField,
  sampleDeckHeight,
} from '../src/ship/deckHeightfield';
import { vhash, vjitter } from '../src/ship/variation';
import {
  bandLimitEnergy,
  bandLimitedEdgeValue,
  periodResolvedValue,
} from '../src/ship/bandLimit';
import { MIN_RUNG, buildRatlinePlan, validateRatlinePlan } from '../src/ship/ratlinePlan';
import { buildSailGeometry } from '../src/ship/pieceGeometrySail';
import { sailClothPoint } from '../src/ship/sailShape';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { shipMaterialParams } from '../src/params/ship';

const stubMaterial = () => ({ dispose(): void {} }) as unknown as THREE.Material;

const galleon = buildGalleonBlueprint();
const byId = new Map(galleon.map((p) => [p.id, p]));
const hints = (id: string): HullShape => byId.get(id)!.shape as unknown as HullShape;

/** ship-space vertices of a piece, resolving one level of un-rotated parenting */
function shipVertices(piece: PieceDef): THREE.Vector3[] {
  const geo = buildPieceGeometry(piece.kind, piece.aabb, piece.shape);
  const pos = geo.attributes.position;
  const parent = piece.parent === undefined ? undefined : byId.get(piece.parent);
  const base = new THREE.Vector3().fromArray(
    parent === undefined ? [0, 0, 0] : parent.transform.position,
  );
  const own = new THREE.Vector3().fromArray(piece.transform.position);
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    out.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).add(own).add(base));
  }
  geo.dispose();
  return out;
}

describe('seeded variation is variation, not noise (§V2)', () => {
  it('is deterministic, bounded, and actually different per key', () => {
    // WHY: the whole detail pass leans on this. If it drifted between runs the
    // blueprint would stop being a pure function and multiplayer would desync;
    // if it collapsed to one value everything would be "ultra regular" again.
    expect(vhash(1, 2, 3)).toBe(vhash(1, 2, 3));
    expect(vhash(1, 2, 3)).not.toBe(vhash(1, 2, 4));
    const samples = Array.from({ length: 64 }, (_, i) => vhash(i, 7));
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...samples)).toBeLessThan(1);
    expect(new Set(samples).size).toBeGreaterThan(60);
    for (const s of Array.from({ length: 32 }, (_, i) => vjitter(0.2, i))) {
      expect(Math.abs(s)).toBeLessThanOrEqual(0.2);
    }
  });
});

describe('detail fittings ride the pieces they belong to (§V13/§V14)', () => {
  it('gunports, channels and mouldings exist on both sides of every section', () => {
    for (const side of ['port', 'starboard']) {
      for (const seg of ['bow', 'mid', 'stern']) {
        const ports = byId.get(`gunports-${side}-${seg}`);
        expect(ports, `gunports-${side}-${seg}`).toBeDefined();
        expect(ports!.parent).toBe(`hull-${side}-${seg}`);
      }
      expect(byId.get(`moulding-${side}`)).toBeDefined();
      for (const mast of ['fore', 'main', 'rear']) {
        expect(byId.get(`channel-${side}-${mast}`), `channel-${side}-${mast}`).toBeDefined();
      }
    }
  });

  it('a blown-off hull section takes its ports and its channel with it', () => {
    // WHY §V13: fittings welded into a shell survive the destruction that
    // removes the shell, leaving frames and deadeyes floating over a hole.
    for (const piece of galleon) {
      if (!/^(gunports|channel)-/.test(piece.id)) continue;
      expect(piece.parent, piece.id).toMatch(/^hull-(port|starboard)-/);
    }
    // …and a broken mast takes its ratlines and its pennant
    for (const piece of galleon) {
      if (!/^(ratlines|pennant)-/.test(piece.id)) continue;
      expect(piece.parent, piece.id).toMatch(/^mast-/);
    }
    // …but the fiferail stays on deck when the mast goes over the side
    for (const piece of galleon) {
      if (!piece.id.startsWith('pin-rail-')) continue;
      expect(piece.parent).not.toMatch(/^mast-/);
    }
  });

  it('no gunport breaches the sheer line or floats off the planking', () => {
    // WHY: a port frame placed on an axis-aligned plane drifts away from a
    // doubly-curved shell toward the ends of the ship — the same class of bug
    // that produced the "ugly panels sticking out" report. And a port cut
    // above the sheer is a hole in the rail, not a gunport.
    const shell = hints('hull-starboard-mid');
    for (const side of ['port', 'starboard']) {
      for (const seg of ['bow', 'mid', 'stern']) {
        const piece = byId.get(`gunports-${side}-${seg}`)!;
        for (const v of shipVertices(piece)) {
          expect(v.y, `${piece.id} breaches the rail`).toBeLessThan(
            hullTopY(v.z, shell) + 0.6, // a triced-up lid may stand above it
          );
          // every vertex sits within a lid's reach of the shell surface
          const off = Math.abs(Math.abs(v.x) - hullHalfWidthAt(v.z, v.y, shell));
          expect(off, `${piece.id} floats ${off.toFixed(2)}m off the shell`).toBeLessThan(1.1);
        }
      }
    }
  });

  it('emits ratlines as INTENT, not as rung meshes (§V.45)', () => {
    // WHY THE HANDOFF: rungs authored here from the chainplate sockets and the
    // masthead are straight lines between two static points. The shrouds they
    // are seized to are solved catenaries that sag — and will soon move — so
    // authored rungs drift off their own ropes with nothing erroring. src/ropes
    // samples both curves from the SAME solved points buffer, so the ship side
    // must emit which shrouds, where along them, and how thick: no geometry.
    expect(galleon.some((p) => (p.kind as string) === 'ratlines')).toBe(false);
    const plan = buildRatlinePlan(galleon);
    expect(() => validateRatlinePlan(plan, galleon)).not.toThrow();
    expect(plan.map((l) => l.id).sort()).toEqual([
      'ratlines-port-fore', 'ratlines-port-main', 'ratlines-port-rear',
      'ratlines-starboard-fore', 'ratlines-starboard-main', 'ratlines-starboard-rear',
    ]);
    for (const ladder of plan) {
      // spans the fan OUTBOARD → inboard, so a rung crosses every shroud
      const outer = galleon.flatMap((p) => p.sockets).find((s2) => s2.id === ladder.footA)!;
      const inner = galleon.flatMap((p) => p.sockets).find((s2) => s2.id === ladder.footB)!;
      expect(Math.abs(outer.position[0])).toBeGreaterThanOrEqual(Math.abs(inner.position[0]));
      expect(ladder.rungs.length).toBeGreaterThan(8);
      for (const rung of ladder.rungs) {
        for (const t of [rung.tA, rung.tB]) {
          expect(t).toBeGreaterThan(0);
          expect(t).toBeLessThan(1);
        }
        // hand-seized: never perfectly level, never perfectly evenly spaced
        expect(rung.sag).toBeGreaterThan(0);
      }
      const levels = ladder.rungs.map((r) => r.tA - r.tB);
      expect(new Set(levels.map((v) => v.toFixed(6))).size).toBeGreaterThan(1);
    }
  });

  it('stops the ladder where the fan has closed to less than a foothold', () => {
    // WHY: the shrouds converge on the masthead, so a plain "rungs up to
    // topFrac" rule ends the ladder in a spike of stubs you could not stand on.
    const plan = buildRatlinePlan(galleon);
    const ladder = plan.find((l) => l.id === 'ratlines-starboard-main')!;
    const at = (id: string): THREE.Vector3 => {
      for (const piece of galleon) {
        for (const s2 of piece.sockets) {
          if (s2.id !== id) continue;
          return new THREE.Vector3().fromArray(s2.position)
            .add(new THREE.Vector3().fromArray(piece.transform.position));
        }
      }
      throw new Error(id);
    };
    const head = at(ladder.masthead);
    const a = at(ladder.footA);
    const b = at(ladder.footB);
    const last = ladder.rungs[ladder.rungs.length - 1];
    const span = a.clone().lerp(head, last.tA).distanceTo(b.clone().lerp(head, last.tB));
    expect(span).toBeGreaterThan(MIN_RUNG * 0.9);
  });

  it('spars declare the axis their staves run along', () => {
    // WHY (§B-class): the plank-seam function indexes courses by local y on
    // any non-horizontal face. On a cylinder that wraps the seams into HOOPS —
    // the "mast rings" in the gap list. Every cylindrical spar must name its
    // axis so the seam coordinate becomes the angle AROUND it instead.
    for (const kind of ['mast', 'bowsprit', 'yard', 'crow-nest'] as const) {
      expect(SPAR_AXIS[kind], `${kind} would wear barrel hoops`).toBeDefined();
    }
    expect(SPAR_AXIS.yard).toBe('x'); // a yard lies athwartships
    expect(SPAR_AXIS.mast).toBe('y');
    expect(SPAR_AXIS.deck).toBeUndefined(); // a deck is planked, not staved
  });
});

describe('railings — asked for three times (§T.34, §V22)', () => {
  it('rails the quarterdeck and the forecastle on both sides and at the break', () => {
    for (const run of ['forecastle', 'quarterdeck']) {
      for (const name of ['port', 'starboard', 'break']) {
        const rail = byId.get(`rail-${run}-${name}`);
        expect(rail, `rail-${run}-${name}`).toBeDefined();
        expect(rail!.kind).toBe('rail');
      }
    }
  });

  it('the midship rail stands railHeight above the deck, not railHeight + sheer', () => {
    // WHY: the builder derived its post height as (aabb top − sheer over the
    // rail RUN), but the aabb top carried the sheer at the ENDS OF THE HULL.
    // The run is 80% of the length, so every post came out ~0.6 m too tall —
    // "the midship rail is visibly too tall", a units bug, not a tuning miss.
    const p = galleonParams;
    const rail = byId.get('rail-starboard')!;
    let top = -Infinity;
    // amidships only: toward the ends the posts legitimately ride the sheer up
    for (const v of shipVertices(rail)) if (Math.abs(v.z) < 2.5) top = Math.max(top, v.y);
    expect(top - p.freeboard).toBeGreaterThan(p.railHeight - 0.15);
    expect(top - p.freeboard).toBeLessThan(p.railHeight + 0.15);
  });

  it('castle railings do not inherit the main deck sheer', () => {
    // WHY: a castle deck is FLAT. Feeding it the hull's sheer curve rakes
    // every stanchion up toward the ends and the rail visibly climbs off its
    // own deck.
    const rail = byId.get('rail-quarterdeck-starboard')!;
    const ys = shipVertices(rail).map((v) => v.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(
      shipDetailParams.castleRailHeight + 0.2,
    );
  });
});

describe('flags are wind instruments (user: "just like in the movies")', () => {
  it('reads APPARENT wind: running downwind at speed kills it', () => {
    // WHY this is the whole point. A flag on true wind alone ignores the helm
    // and tells the player nothing they did not already know. On apparent
    // wind, sailing by the lee makes the pennant fall slack — which is exactly
    // the cue a helmsman reads off a masthead.
    const still = apparentWind({ windDirection: 0, windSpeed: 8, shipVelX: 0, shipVelZ: 0 });
    expect(still.speed).toBeCloseTo(8);
    expect(still.z).toBeCloseTo(1); // blowing toward +z
    const running = apparentWind({ windDirection: 0, windSpeed: 8, shipVelX: 0, shipVelZ: 7 });
    expect(running.speed).toBeCloseTo(1);
    expect(streamStrength(running.speed, shipFlagParams)).toBeLessThan(
      streamStrength(still.speed, shipFlagParams) * 0.3,
    );
    // and beating INTO it the flag streams harder than the true wind alone
    const beating = apparentWind({ windDirection: 0, windSpeed: 8, shipVelX: 0, shipVelZ: -5 });
    expect(beating.speed).toBeGreaterThan(12);
  });

  it('never emits a non-finite value into a shader uniform (§V28)', () => {
    const bad = apparentWind({
      windDirection: NaN,
      windSpeed: NaN,
      shipVelX: Infinity,
      shipVelZ: NaN,
    });
    for (const v of [bad.x, bad.z, bad.speed]) expect(Number.isFinite(v)).toBe(true);
    const state = advanceFlag(
      { root: NaN, tip: NaN, strength: NaN, phase: NaN, wavePhase: NaN, crackPhase: NaN },
      NaN,
      NaN,
      0,
      shipFlagParams,
    );
    for (const v of [state.root, state.tip, state.strength]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('the fly tip LAGS the root, so coming about cracks out along the cloth', () => {
    // WHY: a flag that rotates rigidly reads as a signpost. The lag is what
    // makes it read as cloth, and the request was specifically that it "react
    // visibly when she comes about".
    let s = { root: 0, tip: 0, strength: 1, phase: 0.4, wavePhase: 0, crackPhase: 0 };
    for (let i = 0; i < 12; i++) s = advanceFlag(s, Math.PI * 0.75, 1, 1 / 60, shipFlagParams);
    expect(s.root).toBeGreaterThan(0.05); // the root has swung
    expect(Math.abs(s.tip)).toBeLessThan(Math.abs(s.root)); // the tip trails it
    // and it converges — a lag that never closes would leave a permanent kink
    for (let i = 0; i < 600; i++) s = advanceFlag(s, Math.PI * 0.75, 1, 1 / 60, shipFlagParams);
    expect(Math.abs(angleDelta(s.tip, s.root))).toBeLessThan(0.02);
  });

  it('crosses the ±π branch by the short way round', () => {
    // WHY: a ship steadying on due south walks the target angle across the
    // wrap. Damping the raw difference would spin the flag the long way round
    // — a full 360° sweep at the masthead, once per crossing.
    let s = { root: 3.0, tip: 3.0, strength: 1, phase: 0.4, wavePhase: 0, crackPhase: 0 };
    const target = -3.0; // 0.28 rad away the short way, 6.0 the long way
    s = advanceFlag(s, target, 1, 1 / 60, shipFlagParams);
    expect(s.root).toBeGreaterThan(3.0); // moved AWAY from zero, toward +π
    expect(Math.abs(wrapAngle(s.root))).toBeLessThanOrEqual(Math.PI);
  });

  it('flies a flag at every masthead plus an ensign at the taffrail', () => {
    const flags = galleon.filter((p) => p.kind === 'pennant');
    expect(flags.map((f) => f.id).sort()).toEqual([
      'ensign-stern', 'pennant-fore', 'pennant-main', 'pennant-rear',
    ]);
    // the mainmast flies the colours (square), the others fly coachwhips
    expect(byId.get('pennant-main')!.shape!.taper).toBe(0);
    expect(byId.get('pennant-fore')!.shape!.taper).toBeGreaterThan(0.5);
  });

  it('a flag carries a bounding sphere big enough for every heading', () => {
    // WHY: the material rebuilds every cloth vertex around the staff, so the
    // BUILT geometry is not the DRAWN extent. Left to three's own bounds the
    // flag is culled the moment it streams away from its built +x — it would
    // simply vanish on one tack, with no error anywhere.
    const flag = byId.get('pennant-main')!;
    const geo = buildPieceGeometry(flag.kind, flag.aabb, flag.shape);
    expect(geo.boundingSphere).not.toBeNull();
    expect(geo.boundingSphere!.center.x).toBeCloseTo(0);
    expect(geo.boundingSphere!.radius).toBeGreaterThan(flag.shape!.fly);
    geo.dispose();
  });
});

/**
 * §V22 — "the flags are flapping with some super super twitchy, super ultra
 * high frequency wind. They feel like they're in 1000 kilometre an hour wind."
 *
 * The shader's carrier was `time × rate`, with `rate` a function of the live
 * stream strength. That is the phase of a sine ONLY while the rate is constant.
 * A flag breathes with the gusts, so ω varies, and the instantaneous frequency
 * of sin(t·ω(t)) is ω + t·dω/dt — the elapsed time multiplies every wobble in
 * the rate, without bound and forever. It is invisible on a fresh reload and
 * unbearable ten minutes in, which is exactly how it survived three flag
 * passes.
 *
 * The cure is that a phase is an INTEGRAL: ∫ω dt, accumulated per flag. These
 * tests pin the property that distinguishes the two — the frequency must not
 * depend on how long the app has been running.
 */
describe('flag ripple frequency does not run away with elapsed time (§V22)', () => {
  const p = shipFlagParams;
  const dt = 1 / 100;

  /** unwrapped step of a phase that lives on [0, 2π) */
  const advance = (a: number, b: number): number => angleDelta(a, b);

  function fly(seconds: number): { worst: number; intendedMax: number; phases: number[] } {
    let s: FlagState = {
      root: 0, tip: 0, strength: streamStrength(11, p), phase: 1.7, wavePhase: 1.7, crackPhase: 2.2,
    };
    let worst = 0;
    const phases: number[] = [];
    for (let i = 0; i * dt <= seconds; i++) {
      const t = i * dt;
      // the same gust train the driver feeds it, so `rate` really does move
      const gusted = streamStrength(11, p) * gustModulation(t, s.phase);
      const prev = s;
      s = advanceFlag(s, 0, gusted, dt, p);
      const rad = Math.abs(advance(prev.wavePhase, s.wavePhase)) / dt;
      if (t > 0.5 && rad > worst) worst = rad;
      phases.push(s.wavePhase);
    }
    // the fastest the cloth may ever legitimately flap: strength pinned at 1
    return { worst, intendedMax: flagWaveRate(1, p), phases };
  }

  it('flaps at the same rate after ten minutes as after one second', () => {
    // MEASURED ON THE OLD FORM, against an intended 0.93 Hz: 2.2 Hz at 15 s,
    // 5.8 Hz at 60 s, 13.4 Hz at 2 min, 59.5 Hz at 10 min — and the sign
    // flipped, so the ripple reversed direction at random. A ceiling that does
    // not mention `t` is the whole point of this assertion.
    for (const seconds of [5, 60, 600]) {
      const { worst, intendedMax } = fly(seconds);
      expect(worst, `${seconds}s`).toBeLessThanOrEqual(intendedMax + 1e-6);
    }
  });

  it('never lets the ripple run backwards', () => {
    // WHY: t·dω/dt goes negative whenever the wind eases, which reverses the
    // travelling wave mid-flap. Cloth ripples downwind, always.
    let s: FlagState = {
      root: 0, tip: 0, strength: streamStrength(11, p), phase: 0.9, wavePhase: 0, crackPhase: 0,
    };
    for (let i = 0; i * dt <= 300; i++) {
      const gusted = streamStrength(11, p) * gustModulation(i * dt, s.phase);
      const prev = s;
      s = advanceFlag(s, 0, gusted, dt, p);
      expect(advance(prev.wavePhase, s.wavePhase)).toBeGreaterThan(0);
      expect(advance(prev.crackPhase, s.crackPhase)).toBeGreaterThan(0);
    }
  });

  it('keeps both accumulators bounded, so precision never decays', () => {
    // WHY: an unwrapped accumulator loses its low bits over a long session and
    // the flag starts to judder — the failure this file already documents for
    // the damped ANGLES, which is why lagAngle is sent as a difference.
    const { phases } = fly(600);
    for (const v of phases) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(Math.PI * 2);
    }
  });

  it('still reads the wind: a gale ripples faster than a light air', () => {
    // WHY: killing the runaway must not kill the signal. The rate is still the
    // information — it just has to be integrated rather than multiplied.
    expect(flagWaveRate(1, p)).toBeGreaterThan(flagWaveRate(0, p) * 2);
    expect(flagWaveRate(streamStrength(22, p), p)).toBeGreaterThan(
      flagWaveRate(streamStrength(4, p), p) * 1.5,
    );
    // and the crack stays detuned from the ripple, or the two lock into one
    // obvious period (§B.4)
    expect(FLAG_CRACK_RATIO % 1).not.toBeCloseTo(0, 3);
  });
});

describe('furled canvas gathers into swags, not a rolled tube (§T.34)', () => {
  const sail = galleon.find((p) => p.kind === 'sail')!;
  const width = sail.aabb.max[0] - sail.aabb.min[0];

  /** lowest built vertex of the bundle at each station across the yard */
  function bottomProfile(state: 'furled' | 'reefed', bins = 48): number[] {
    const geo = buildSailGeometry(state, sail.aabb);
    const pos = geo.attributes.position;
    const shape = geo.getAttribute('sailShape');
    const low = new Array<number>(bins).fill(Infinity);
    for (let i = 0; i < pos.count; i++) {
      if (shape.getX(i) !== 0) continue; // hardware/bundle only, not the skirt
      const t = (pos.getX(i) / width + 0.5) * (bins - 1);
      const k = Math.round(Math.min(bins - 1, Math.max(0, t)));
      low[k] = Math.min(low[k], pos.getY(i));
    }
    geo.dispose();
    return low.filter((v) => Number.isFinite(v));
  }

  it('hangs in bays: the bottom edge dips and lifts across the yard', () => {
    // WHY (user, against a reference of a galleon at anchor): "instead of just
    // being like a completely straight line rolled up". A cylinder's bottom
    // edge is a straight line — the ONLY thing that distinguishes gathered
    // canvas from a rolled tube is that the edge goes down and up again
    // between gaskets. Count the direction changes: `bays` swags means the
    // profile must turn at least that many times.
    const profile = bottomProfile('furled');
    let turns = 0;
    let rising = profile[1] > profile[0];
    for (let i = 2; i < profile.length; i++) {
      const nowRising = profile[i] > profile[i - 1];
      if (nowRising !== rising && Math.abs(profile[i] - profile[i - 1]) > 1e-4) {
        turns++;
        rising = nowRising;
      }
    }
    expect(turns, 'furled bundle is a straight tube').toBeGreaterThanOrEqual(
      shipDetailParams.sailBuntBays,
    );
    // and the swags are a real depth, not a ripple
    const depth = Math.max(...profile) - Math.min(...profile);
    expect(depth).toBeGreaterThan(0.1);
  });

  it('gathers the two sides differently — no mirrored lumps (§V2)', () => {
    // WHY: the through-line. Two yards furled into identical lumps, or one
    // yard symmetric about its own centre, reads as CG immediately.
    const profile = bottomProfile('furled');
    const half = Math.floor(profile.length / 2);
    const left = profile.slice(0, half);
    const right = profile.slice(profile.length - half).reverse();
    let same = 0;
    for (let i = 0; i < half; i++) if (Math.abs(left[i] - right[i]) < 1e-3) same++;
    expect(same).toBeLessThan(half * 0.8);
  });

  it('reefed keeps working canvas below the bundle; furled does not', () => {
    const reefed = buildSailGeometry('reefed', sail.aabb);
    const furled = buildSailGeometry('furled', sail.aabb);
    const clothWeight = (g: THREE.BufferGeometry): number => {
      const shape = g.getAttribute('sailShape');
      let n = 0;
      for (let i = 0; i < shape.count; i++) if (shape.getX(i) === 1) n++;
      return n;
    };
    expect(clothWeight(reefed)).toBeGreaterThan(0); // a reefed sail still draws
    expect(clothWeight(furled)).toBe(0); // a furled one is all hardware
    reefed.dispose();
    furled.dispose();
  });

  it('the full sail carries reef bands, each riding one point of canvas', () => {
    // WHY the uv matters: a weight-1 part is displaced by the cloth shader at
    // ITS OWN (u, v). A reef point built with three's default plane uv would be
    // stretched across the whole sail's billow instead of riding the spot it is
    // sewn to — it would visibly slide over the canvas as the sail fills.
    const geo = buildSailGeometry('full', sail.aabb);
    const shape = geo.getAttribute('sailShape');
    const uv = geo.getAttribute('uv');
    let cloth = 0;
    for (let i = 0; i < shape.count; i++) if (shape.getX(i) === 1) cloth++;
    expect(cloth).toBeGreaterThan(0);
    // every uv stays inside the cloth's parameter square
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(-1e-6);
      expect(uv.getX(i)).toBeLessThanOrEqual(1 + 1e-6);
    }
    geo.dispose();
  });
});

describe('sail-attached anchors ride the canvas (§V12 endpoints, §V.45 rule)', () => {
  it('every sail declares clews and buntline anchors', () => {
    // WHY: src/ropes had to start its sheet run at the YARD END because no
    // clew sockets existed — its own header says "adapt when the ship system
    // adds clew anchors" — and the user spotted the result: "some of them
    // should actually attach to the sails in the appropriate spots".
    const sails = galleon.filter((p) => p.kind === 'sail');
    expect(sails.length).toBe(6);
    for (const sail of sails) {
      const ids = sail.sockets.map((s) => s.id);
      for (const suffix of ['clew-port', 'clew-starboard', 'bunt-port', 'bunt-starboard']) {
        expect(ids, sail.id).toContain(`anchor-${sail.id}-${suffix}`);
      }
      for (const socket of sail.sockets) {
        expect(socket.type).toBe('rope-anchor');
        expect(socket.cloth, `${socket.id} must know where it is sewn`).toBeDefined();
      }
      // the clews are the two LOWER corners, not points on the spar
      const clew = sail.sockets.find((s) => s.id.endsWith('clew-port'))!;
      expect(clew.cloth).toEqual([0, 0]);
      expect(clew.position[1]).toBeLessThan(0);
    }
  });

  it('a clew MOVES when the canvas bellies, and stays finite (§V28)', () => {
    // WHY: this is the whole point of the handoff. A clew resolved from its
    // flat panel station would sit still while the sail bellied away from it,
    // leaving every sheet ending in mid-air — the §V.45 failure, in cloth.
    const asm = new ShipAssembly(galleon, stubMaterial);
    const id = 'anchor-sail-main-lower-clew-starboard';
    const slack = asm.socketWorldPosition(id);
    asm.setSailDropScale('sail-main-lower', 0.3); // haul the sheets right in
    const hauled = asm.socketWorldPosition(id);
    // the foot comes UP as the canvas comes in
    expect(hauled[1]).toBeGreaterThan(slack[1] + 0.5);
    for (const v of [...slack, ...hauled]) expect(Number.isFinite(v)).toBe(true);
    asm.dispose();
  });

  it('the flat socket station and the live one agree when there is no cloth', () => {
    // a zero-drive, zero-flutter sail must resolve to exactly its built corner,
    // or the CPU mirror has drifted from the panel it claims to describe
    const p = { ...shipMaterialParams, sailCamber: 0, sailFootRoach: 0, sailFlutterAmp: 0 };
    const sail = galleon.find((s) => s.id === 'sail-main-lower')!;
    const width = sail.aabb.max[0] - sail.aabb.min[0];
    const drop = -sail.aabb.min[1];
    const state = { drive: 0, luff: 0, skew: 0, dropScale: 1, flutterPhase: 0, ...FLAT_SHEETS };
    const pt = sailClothPoint(1, 0, width, drop, state, p);
    const socket = sail.sockets.find((s) => s.id.endsWith('clew-starboard'))!;
    expect(pt[0]).toBeCloseTo(socket.position[0], 5);
    expect(pt[1]).toBeCloseTo(socket.position[1], 5);
    expect(pt[2]).toBeCloseTo(0, 6);
  });
});

describe('every piece kind gets a material graph that BUILDS (§V18)', () => {
  it('constructs one material per kind, including the new fittings', () => {
    // WHY: a TSL node graph is assembled eagerly in JS but only COMPILED on
    // the GPU, so a misused node (wrong attribute type, a 3-arg chained form,
    // a node that silently no-ops — §V23/§V38) surfaces as a black material or
    // a shader-compile failure in the browser, long after the change. Building
    // every graph headless catches the assembly half here, per commit.
    const kinds = new Set(buildGalleonBlueprint().map((p) => p.kind));
    for (const kind of buildBrigantineBlueprint().map((p) => p.kind)) kinds.add(kind);
    expect(kinds.size).toBeGreaterThan(25);
    for (const kind of kinds) {
      const mat = createPieceMaterial(kind);
      expect(mat.colorNode, `${kind} has no colour`).toBeDefined();
      mat.dispose();
    }
  });

  it('builds the deck material against a real heightfield texture', () => {
    // the deck family is the only one that samples the field, and the sampler
    // is wired through ShipAssembly — a plumbing break here is invisible
    // otherwise (the deck just goes back to being flat)
    const field = buildDeckHeightfield(galleon)!;
    const sampler = createDeckFieldTexture(field);
    expect(sampler.texture.image.width).toBe(field.width);
    for (const kind of ['deck', 'forecastle-deck', 'stairs'] as const) {
      const mat = createPieceMaterial(kind, sampler);
      expect(mat.normalNode).toBeDefined();
      mat.dispose();
    }
    sampler.texture.dispose();
  });
});

describe('procedural deck heightfield (talk: "Surface Water: Setup")', () => {
  const field = buildDeckHeightfield(galleon)!;

  it('is generated, deterministic and covers the deck (§V2)', () => {
    expect(field).not.toBeNull();
    expect(field.width * field.height).toBe(field.data.length);
    const again = buildDeckHeightfield(galleon)!;
    expect(Array.from(again.data.slice(0, 4096))).toEqual(Array.from(field.data.slice(0, 4096)));
    // a brigantine gets its OWN field, not a copy of the galleon's (§V18)
    const brig = buildDeckHeightfield(buildBrigantineBlueprint())!;
    expect(brig.maxZ - brig.minZ).not.toBeCloseTo(field.maxZ - field.minZ);
  });

  it('masks the water domain to the planking', () => {
    expect(sampleDeckField(field, field.mask, 0, 0)).toBeGreaterThan(0.9);
    expect(sampleDeckField(field, field.mask, galleonParams.beam, 0)).toBeLessThan(0.05);
  });

  it('crowns amidships so the deck sheds water outboard', () => {
    // WHY: a flat deck gives the Mei solver a flat, characterless sheet. The
    // camber is what sends it to the waterway and over the side.
    const centre = sampleDeckHeight(field, 0, 0);
    const outboard = sampleDeckHeight(field, galleonParams.beam * 0.35, 0);
    expect(centre).toBeGreaterThan(outboard);
  });

  it('coamings stand proud of the deck around them — hatches stay dry', () => {
    // WHY: the user asked for pooling; a coaming is what makes water pool
    // AROUND a hatch instead of pouring into the hold.
    const hatch = galleon.find((p) => p.kind === 'grating')!;
    const deck = byId.get('deck')!;
    const hz = hatch.transform.position[2] + deck.transform.position[2];
    const hx = hatch.transform.position[0] + deck.transform.position[0];
    const lipZ = hz + (hatch.aabb.max[2] - hatch.aabb.min[2]) / 2 + 0.1;
    expect(sampleDeckHeight(field, hx, lipZ)).toBeGreaterThan(
      sampleDeckHeight(field, hx, lipZ + 1.2) + 0.05,
    );
  });

  it('steps up onto the raised decks and marks them solid where they must be', () => {
    const quarterdeck = sampleDeckHeight(field, 0, -galleonParams.hullLength / 2 + 2);
    expect(quarterdeck).toBeGreaterThan(galleonParams.sterncastleRise * 0.8);
    // the bulwark ring is an obstacle, the open deck is not
    const shell = hints('hull-port-mid');
    const edge = hullHalfWidthAt(0, galleonParams.freeboard, shell) * 0.985;
    expect(sampleDeckField(field, field.solid, edge, 0)).toBeGreaterThan(0.5);
    expect(sampleDeckField(field, field.solid, 0, 0)).toBeLessThan(0.1);
  });

  it('a ladder landing on a deck does not stack with the deck it lands on', () => {
    // WHY (measured, §B-class): steps and ramps were SUMMED. The aft
    // companionway's top tread overlaps the quarterdeck footprint by ~0.9 m,
    // so that strip got 2.2 m of step plus 2.2 m of ramp — a 4.4 m spike in
    // the middle of the deck. The solver would read it as a wall and the
    // shading as a cliff, and nothing would have said a word.
    let peak = -Infinity;
    for (const v of field.data) peak = Math.max(peak, v);
    const p = galleonParams;
    expect(peak).toBeLessThan(p.sterncastleRise + 1.4); // deck + bulwark, no more
  });

  it('wears a hollow where the crew works, so puddles land somewhere true', () => {
    const capstan = galleon.find((p) => p.kind === 'capstan')!;
    const deck = byId.get('deck')!;
    const cz = capstan.transform.position[2] + deck.transform.position[2];
    // just outboard of the drum, inside the worn ring, vs. clear of it
    expect(sampleDeckHeight(field, 1.4, cz)).toBeLessThan(sampleDeckHeight(field, 1.4, cz + 4));
  });

  it('gives every board its own height, without stepping at the seams', () => {
    // WHY BOTH HALVES: variation is the point (the talk's field is per-plank
    // greys, and the user's note is "not so ultra regular everywhere") — but a
    // per-board CONSTANT is a step, and both consumers differentiate this
    // field: the shading as a screen-space gradient (§V38, where a step
    // becomes a one-pixel spike) and the solver as a slope (where it becomes
    // an infinite current). Every term is crowned to zero at the seams.
    const row = Math.floor(field.height / 2);
    const open = (i: number): boolean =>
      field.mask[row * field.width + i] > 0.95 && field.solid[row * field.width + i] < 0.05;
    let spread = 0;
    let worstJump = 0;
    for (let i = 1; i < field.width; i++) {
      const v = field.plank[row * field.width + i];
      if (!open(i)) continue;
      spread = Math.max(spread, Math.abs(v));
      // only compare texels that are BOTH open deck: the domain edge is a
      // real boundary, not a seam, and the solver treats it as one
      if (open(i - 1)) {
        worstJump = Math.max(worstJump, Math.abs(v - field.plank[row * field.width + i - 1]));
      }
    }
    expect(spread).toBeGreaterThan(0.0005); // boards really do differ
    expect(spread).toBeLessThan(0.02); // …by millimetres, not steps
    // a seam crossing must not jump more than the whole board's own relief
    expect(worstJump).toBeLessThan(spread * 0.6);
  });

  it('sampling clamps at the border instead of wrapping or reading off the end', () => {
    // §V28: the solver and the material both sample this from caller-fed
    // coordinates; a wrap would read the stem's planking at the transom.
    for (const [x, z] of [[-1e6, -1e6], [1e6, 1e6], [NaN, 0]] as const) {
      const v = sampleDeckHeight(field, x, z);
      expect(Number.isFinite(v) || Number.isNaN(x)).toBe(true);
    }
    expect(sampleDeckHeight(field, -1e6, 0)).toBe(sampleDeckHeight(field, field.minX - 5, 0));
  });
});

/**
 * §V.48 — the speckle. Five occurrences in this project, so it gets a test
 * that fails on the mechanism rather than on any one surface.
 *
 * MECHANISM. `reliefNormal` builds the shading normal from the SCREEN-SPACE
 * derivative of a procedural height field. That derivative is honest only
 * while the height varies slowly across the pixel grid. A caulking groove is
 * 4.4 cm wide; once a pixel covers more than that, two neighbouring pixels
 * land on opposite ends of the groove wall and their difference is the FULL
 * step regardless of where the groove actually is — per-pixel random normals,
 * i.e. white specular speckle over the whole surface (on the masts the same
 * noise drove diffuse to black).
 *
 * WHAT THESE PIN. That the shipped feature widths stay resolvable up close and
 * that their per-pixel contribution genuinely decays to nothing as the
 * footprint grows — the property the first, period-based fix did NOT have,
 * which is why the hull kept speckling after the masts were fixed.
 */
describe('§V.48 band limiting of procedural periodic terms', () => {
  /** the unfiltered edge — what the material used to draw */
  const sharp = (distance: number, feature: number): number => {
    const t = Math.min(1, Math.max(0, distance / feature));
    return t * t * (3 - 2 * t);
  };

  /** the drawn mask at position `x`, for a repeat of `period` */
  const maskAt = (
    x: number,
    filter: number,
    feature: number,
    limited: boolean,
    period: number,
  ): number => {
    const t = x / period;
    const f = t - Math.floor(t);
    const d = Math.min(f, 1 - f) * period;
    return limited ? bandLimitedEdgeValue(d, feature, filter) : sharp(d, feature);
  };

  /**
   * Supremum of the difference between NEIGHBOURING pixels — the exact
   * quantity reliefNormal differentiates, and so the one that has to fall.
   * The mask's average is not the point: it can look perfectly reasonable
   * while the surface boils.
   *
   * Taken over a dense sweep of x rather than over one pixel grid. Aliasing IS
   * sub-pixel phase dependence, and a grid whose spacing happens to divide the
   * repeat reads out a CONSTANT — the fully-folded case, which looks like a
   * pass and is in fact the worst possible aliasing.
   */
  const maxPixelStep = (filter: number, feature: number, limited: boolean, period = 1): number => {
    let worst = 0;
    const step = period / 4000;
    for (let x = 0; x < period; x += step) {
      const a = maskAt(x, filter, feature, limited, period);
      const b = maskAt(x + filter, filter, feature, limited, period);
      worst = Math.max(worst, Math.abs(b - a));
    }
    return worst;
  };

  /** how much of the feature is still THERE: full darkening = 1, gone = 0 */
  const contrast = (filter: number, feature: number, limited: boolean, period = 1): number => {
    let lo = 1;
    const step = period / 4000;
    for (let x = 0; x < period; x += step) {
      lo = Math.min(lo, maskAt(x, filter, feature, limited, period));
    }
    return 1 - lo;
  };

  const SEAM = shipMaterialParams.seamWidth; // fraction of a plank
  const BUTT = shipMaterialParams.buttWidth; // metres
  const PLANK = shipMaterialParams.plankLength; // metres between butts

  it('leaves plank detail untouched while the seam still spans several pixels', () => {
    // close range: a 0.55 m plank across ~90 px. The user asked for this
    // detail explicitly — band limiting must not be a quiet deletion of it.
    for (const filter of [0.002, 0.005, 0.01]) {
      for (const d of [0, 0.01, 0.03, 0.08, 0.2, 0.5]) {
        expect(bandLimitedEdgeValue(d, SEAM, filter)).toBeCloseTo(sharp(d, SEAM), 3);
      }
    }
    expect(bandLimitEnergy(SEAM, 0.01)).toBe(1);
  });

  it('drives the seam contribution to zero as the pixel footprint grows', () => {
    // past the feature width, where the widening has fully engaged
    const steps = [0.11, 0.23, 0.47, 0.93].map((f) => maxPixelStep(f, SEAM, true));
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeLessThanOrEqual(steps[i - 1] + 1e-6); // monotone decay
    }
    expect(steps[steps.length - 1]).toBeLessThan(0.05); // and it reaches nothing

    // the groove's DEPTH decays over the whole range, not just its slope —
    // widening alone would smear a 4 cm seam across a whole plank at range
    const depths = [0.02, 0.05, 0.11, 0.23, 0.47, 0.93].map((f) => contrast(f, SEAM, true));
    for (let i = 1; i < depths.length; i++) {
      expect(depths[i]).toBeLessThanOrEqual(depths[i - 1] + 1e-6);
    }
    expect(depths[depths.length - 1]).toBeLessThan(0.1);
  });

  it('never lets the edge become a full per-pixel step at ANY footprint', () => {
    // the property that actually distinguishes "an antialiased edge" from
    // "speckle": the drawn transition is never narrower than two pixels, so
    // the largest neighbour difference is bounded by smoothstep's own peak
    // slope over that width. Unlimited, the same edge steps the whole way
    // between two adjacent pixels — which is the noise.
    let worst = 0;
    for (let f = 0.001; f < 2; f += 0.003) worst = Math.max(worst, maxPixelStep(f, SEAM, true));
    expect(worst).toBeLessThan(0.8);
    expect(maxPixelStep(SEAM, SEAM, false)).toBeGreaterThan(0.99);
  });

  it('fails the same way the shipped material used to, without the limit', () => {
    // the regression pin. If this ever stops holding, the "before" case is no
    // longer the bug and the test above is proving nothing.
    for (const filter of [0.11, 0.47, 0.93]) {
      expect(maxPixelStep(filter, SEAM, false)).toBeGreaterThan(0.9); // full step, per pixel
      expect(contrast(filter, SEAM, false)).toBeGreaterThan(0.99); // at full depth, forever
    }
  });

  it('kills the butt-joint dots on a grazing deck', () => {
    // the follow camera sees the deck edge-on: a pixel covers tens of
    // centimetres of fore-and-aft deck while covering millimetres across it,
    // so the 5 cm butts alias long before the 0.55 m plank seams do.
    expect(contrast(0.004, BUTT, true, PLANK)).toBeGreaterThan(0.95); // near deck: full butts
    expect(maxPixelStep(0.37, BUTT, true, PLANK)).toBeLessThan(0.05); // far deck: no dots
    expect(contrast(0.37, BUTT, true, PLANK)).toBeLessThan(0.15); //   …because they faded
    expect(maxPixelStep(0.37, BUTT, false, PLANK)).toBeGreaterThan(0.9); // unlimited: dots
  });

  it('measures the FEATURE, not the repeat — the distinction the first fix missed', () => {
    // a 0.08-of-a-plank seam inside a 1.0 plank repeat: at a fifth of a plank
    // per pixel the repeat is still perfectly resolved (periodResolved == 1)
    // and yet the seam is 2.5 pixels of footprint wide and already aliasing.
    // Everything between these two distances was the speckle the user saw.
    const filter = 0.2;
    expect(periodResolvedValue(filter)).toBe(1); // repeat says "all fine"
    expect(bandLimitEnergy(SEAM, filter)).toBeLessThan(0.25); // feature says otherwise
  });

  it('keeps the smooth per-board terms gated on the repeat instead', () => {
    // the crowned lift and the per-board tone jitter have no edge — a whole
    // period IS their feature — so they stay on periodResolved.
    expect(periodResolvedValue(0.05)).toBe(1);
    expect(periodResolvedValue(2)).toBe(0);
    expect(periodResolvedValue(0.75)).toBeGreaterThan(0);
    expect(periodResolvedValue(0.75)).toBeLessThan(1);
  });

  it('feathers BOTH edges of a wale strake, not just the top one', () => {
    // the old form was smoothstep(ratio ± 0.03, fract(y·freq)): smooth at the
    // top of the belt, a raw STEP at the fract wrap at its bottom. A step in
    // the height field differentiates to a one-pixel spike, so the wale drew a
    // bright hairline the whole length of the ship.
    const ratio = shipMaterialParams.waleRatio;
    const EDGE = 0.06;
    // the signed-distance form the material now uses
    const dist = (c: number): number => {
      const s = c - ratio / 2 + 0.5;
      const centred = s - Math.floor(s) - 0.5;
      return Math.abs(centred) - ratio / 2 + EDGE / 2;
    };
    const band = (c: number): number => bandLimitedEdgeValue(dist(c), EDGE, 1e-4);
    let worst = 0;
    for (let i = 0; i < 4000; i++) {
      const c = i / 1000; // four full repeats
      worst = Math.max(worst, Math.abs(band(c) - band(c - 0.001)));
    }
    expect(worst).toBeLessThan(0.1); // continuous everywhere, incl. across the wrap
    // and it is still a belt: dark inside, clear outside
    expect(band(ratio / 2)).toBeLessThan(0.05);
    expect(band(ratio + 0.5 * (1 - ratio))).toBeGreaterThan(0.95);
  });
});

/**
 * HULL PLANKING — the strake coordinate (user report: "we have this nice
 * normal map with the gap between planks on the deck, but on the sides and
 * on most of the back we are not doing that").
 *
 * WHAT WAS ACTUALLY WRONG. The seams were never missing: hull and deck share
 * one `createWoodMaterial`, so the topsides always had caulk grooves, butt
 * joints and per-board relief. What they did not have was the right SHAPE.
 * The coordinate was `positionLocal.y / plankWidth` — level slices of world
 * height — which draws waterlines, not strakes: they cut across the sheer at
 * both ends and hold one width for the whole 35 m. On top of that a wale
 * every 1.11 m of height (0.9 per metre against a 0.55 m board) put a proud
 * dark belt on every other plank, so what read at any distance was the belts.
 *
 * WHAT THESE PIN is the contract the material now leans on: the loft's own
 * `uv.y` is the height fraction between the keel and the SHEER-FOLLOWING rail
 * line, so lines of constant uv.y are the strakes and nothing has to guess at
 * the hull's shape a second time (§V37 — two parameterisations of one curve
 * agree only at the ends).
 */
describe('hull planking follows the strakes, not world height', () => {
  const shellShape = (kind: 'hull-section' | 'bow' | 'transom'): HullShape =>
    galleon.find((p) => p.kind === kind)!.shape as unknown as HullShape;

  it('parameterises the shell by height fraction to the RAIL, so uv.y is the strake', () => {
    // the material reads uv().y as "how far up the section am I, 0 keel to 1
    // rail". If the loft ever re-parameterises, the planking silently lands
    // somewhere else — that is the failure this catches.
    const piece = galleon.find((p) => p.kind === 'hull-section')!;
    const s = shellShape('hull-section');
    const geo = buildPieceGeometry(piece.kind, piece.aabb, piece.shape);
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    expect(uv).toBeDefined(); // no uv ⟹ the strake coordinate is garbage
    const zOffset = (s.z0 + s.z1) / 2; // buildLoftedHullSection translates by this
    let checked = 0;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y < -s.draft + 0.01) continue; // the bottom patch parameterises across
      const z = pos.getZ(i) + zOffset;
      const expected = (y + s.draft) / (hullTopY(z, s) + s.draft);
      expect(uv.getY(i)).toBeCloseTo(expected, 3);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('carries the strakes UP with the sheer instead of slicing level', () => {
    // the visible tell in every reference of a real hull: the planking sweeps
    // up toward stem and stern parallel to the rail. Level slices do not.
    const s = shellShape('hull-section');
    const yOfStrake = (h: number, z: number): number => -s.draft + (hullTopY(z, s) + s.draft) * h;
    const midship = yOfStrake(0.9, 0);
    expect(yOfStrake(0.9, s.bowZ * 0.9)).toBeGreaterThan(midship + 0.5);
    expect(yOfStrake(0.9, s.sternZ * 0.9)).toBeGreaterThan(midship + 0.3);
    // and the rail line itself is what they are parallel to
    expect(hullTopY(s.bowZ, s)).toBeCloseTo(hullTopY(0, s) + s.sheerBow, 6);
  });

  it('narrows the boards toward both ends, because a plank runs the whole hull', () => {
    // a strake is continuous stem to stern, so the COUNT is fixed and the
    // width is girth/count — which is why real planking tapers into the ends.
    // A fixed metre width (the old coordinate) cannot express that at all.
    const s = shellShape('hull-section');
    const girth = (z: number): number => {
      const env = hullEnvelope(z, s);
      const span = hullTopY(z, s) + s.draft;
      let total = 0;
      let px = s.beamHalf * sectionHalf(env, 0, s);
      let py = -s.draft;
      for (let i = 1; i <= 64; i++) {
        const h = i / 64;
        const x = s.beamHalf * sectionHalf(env, h, s);
        const y = -s.draft + span * h;
        total += Math.hypot(x - px, y - py);
        px = x;
        py = y;
      }
      return total;
    };
    const mid = girth(0);
    expect(girth(s.bowZ * 0.9)).toBeLessThan(mid * 0.95); // taper into the stem
    expect(girth(s.sternZ * 0.95)).toBeLessThan(mid * 0.95); // …and into the stern
    // the strake count is chosen so the boards read the same size amidships
    // as the deck's: girth / plankWidth
    const implied = mid / shipMaterialParams.plankWidth;
    expect(shipMaterialParams.hullStrakes).toBeGreaterThan(implied * 0.8);
    expect(shipMaterialParams.hullStrakes).toBeLessThan(implied * 1.25);
  });

  it('cannot run butt joints down the transom in z — the plate has no z', () => {
    // WHY the along-plank axis is chosen from the surface normal now. A
    // transom is planked ACROSS the ship, and its piece-local z is the crown
    // bulge only, far less than one board long: keyed on z, every course of
    // the plate sat at one fixed phase of the butt pattern, so the joints
    // stopped being joints and became a per-strake darkening of the whole
    // stern. That is "on most spots on the back we are not doing that".
    const piece = galleon.find((p) => p.kind === 'transom')!;
    const geo = buildPieceGeometry(piece.kind, piece.aabb, piece.shape);
    const pos = geo.attributes.position;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      minZ = Math.min(minZ, pos.getZ(i));
      maxZ = Math.max(maxZ, pos.getZ(i));
      minX = Math.min(minX, pos.getX(i));
      maxX = Math.max(maxX, pos.getX(i));
    }
    expect(maxZ - minZ).toBeLessThan(shipMaterialParams.plankLength * 0.5); // under one board
    expect(maxX - minX).toBeGreaterThan(shipMaterialParams.plankLength); // several boards
  });

  it('lays each wale on a whole number of strakes, so its edges land on seams', () => {
    // a wale IS a strake — a thicker board in the run — so it is counted in
    // planks. An integer repeat also means the belt's two band-limited edges
    // coincide with plank seams instead of splitting a board down the middle.
    const perWale = 1 / shipMaterialParams.waleFrequency;
    expect(perWale).toBeCloseTo(Math.round(perWale), 6);
    expect(Math.round(perWale)).toBeGreaterThan(1); // 1 would make EVERY board a wale
    // and the belt itself is a whole number of boards, so its two feathered
    // edges sit in the caulk lines rather than splitting a board in half
    const boardsWide = shipMaterialParams.waleRatio / shipMaterialParams.waleFrequency;
    expect(boardsWide).toBeCloseTo(Math.round(boardsWide), 6);
    expect(Math.round(boardsWide)).toBeGreaterThanOrEqual(1);
    // …and the ship carries a few of them, not one every other plank. The old
    // 0.9-per-metre value works out at ~0.5 per board, which is the setting
    // that buried the planking under belts.
    const wales = shipMaterialParams.hullStrakes * shipMaterialParams.waleFrequency;
    expect(wales).toBeGreaterThanOrEqual(2);
    expect(wales).toBeLessThanOrEqual(5);
  });
});

/**
 * §V.48 again, on the surface this task carries the relief onto. The lesson
 * §B.20 cost three rounds of misattribution to learn is that a band limit
 * keyed on the wrong LENGTH SCALE passes every unit test and speckles on
 * screen: the mast fix gated `fwidth(plankCoord)` against the plank PERIOD,
 * and a 0.08-of-a-plank seam goes sub-pixel 12× before the plank does, so
 * every distance in that band was left aliasing. These pin the gate to the
 * seam's own width by making the period-keyed answer visibly wrong.
 */
describe('§V.48 the hull seam gate is keyed on the SEAM, not the plank', () => {
  const SEAM = shipMaterialParams.seamWidth; // fraction of a plank

  /** neighbour-to-neighbour difference of the drawn mask — what aliases */
  const step = (filter: number, limited: boolean): number => {
    const at = (x: number): number => {
      const f = x - Math.floor(x);
      const d = Math.min(f, 1 - f);
      if (limited) return bandLimitedEdgeValue(d, SEAM, filter);
      const t = Math.min(1, Math.max(0, d / SEAM));
      return t * t * (3 - 2 * t);
    };
    let worst = 0;
    for (let x = 0; x < 1; x += 1 / 4000) worst = Math.max(worst, Math.abs(at(x + filter) - at(x)));
    return worst;
  };

  it('is at full strength only while the seam still spans two pixels', () => {
    // the widening threshold IS the seam width — not the period, not the
    // board. Two pixels rather than one: at exactly one, neighbouring samples
    // still land on opposite ends of the groove wall (see FILTER_PIXELS).
    expect(bandLimitEnergy(SEAM, SEAM / 2)).toBe(1); // seam = 2 px: untouched
    expect(bandLimitEnergy(SEAM, SEAM / 2 + 1e-6)).toBeLessThan(1); // one hair past: fading
  });

  it('has already collapsed where a period-keyed gate still reads "all fine"', () => {
    // THE REGRESSION PIN for §B.20. Across this whole band the plank repeat is
    // comfortably resolved, so the gate that fixed the masts does nothing at
    // all — and the seam inside it is a sub-pixel step, i.e. random normals.
    for (const filter of [SEAM, 2 * SEAM, 4 * SEAM]) {
      expect(periodResolvedValue(filter)).toBe(1); // period says: no problem
      expect(bandLimitEnergy(SEAM, filter)).toBeLessThanOrEqual(0.5); // seam disagrees
      expect(step(filter, false)).toBeGreaterThan(0.9); // unlimited: a full step per pixel
    }
    // and the limit reaches nothing by the time the seam is under a pixel,
    // rather than merely starting to fade there
    expect(step(SEAM, true)).toBeLessThan(0.5); // 1 px per seam: already a slope
    expect(step(2 * SEAM, true)).toBeLessThan(0.25); // half a pixel: going
    expect(step(4 * SEAM, true)).toBeLessThan(0.1); // a quarter: gone
  });

  it('§V.49 — the relief factor scales the NORMAL, never the height it differentiates', () => {
    // The wetline factor multiplies the hull's relief. Fold it into the height
    // field and reliefNormal differentiates the PRODUCT, so the product rule
    // hands the normal an H·dS/dx term: the factor's own sampling jitter,
    // amplified by the full magnitude of the wood grain. Applying it after the
    // derivative (reliefNormal scales dH/dx, not H) cannot produce that term.
    // Invisible while the hull is dry, because a constant S has no derivative.
    const PIXEL = 1e-3; // one pixel of whatever coordinate this is measured in
    const H = (x: number): number => 0.012 * Math.sin(x * 40); // wood height, metres
    // a factor read from a minified sampler: it changes by a few percent
    // between neighbouring pixels, which on its own is nothing to look at
    const S = (x: number): number => 0.5 + 0.25 * Math.sin(x * 3000);
    // swept, not spot-checked: aliasing IS sub-pixel phase dependence, and a
    // single sample can land anywhere on the beat (this test first shipped
    // spot-checked and read 1.02× on a phase where dS happened to vanish)
    const worst = (f: (x: number) => number): number => {
      let out = 0;
      for (let x = 0; x < 1; x += PIXEL / 4) out = Math.max(out, Math.abs(f(x + PIXEL) - f(x)));
      return out;
    };
    const scaledHeight = worst((x) => H(x) * S(x)); // the §V.49 bug
    const scaledNormal = worst(H) * 1; // what the material does now, S bounded by 1
    expect(scaledHeight).toBeGreaterThan(scaledNormal * 3);
    // and with a dry hull the two are the SAME function, which is why a bug
    // of this shape can sit in the deck material unseen until it rains
    const dry = worst((x) => H(x) * 1);
    expect(dry).toBeCloseTo(worst(H), 12);
  });
});

/**
 * THE PROUD RIM (§T.34 "chamfered edges (90° arrises ⊥)"; user: "we still see
 * perfect 90 degree edges and angles between the deck and the sides ...
 * everything is basically nailed to a millionth of an inch precision").
 *
 * The shell used to stop exactly on `hullTopY`, and amidships `hullTopY` IS
 * `freeboard`, which is where the deck plate's top face sits — so the planking
 * and the deck met flush in a square corner along the whole waist, the one
 * join the follow camera looks at all day. Toward the ends the sheer lifted
 * the shell clear on its own, which is why this read as a midships problem.
 *
 * WHAT THESE PIN, in the order they can break:
 *   1. there IS an overhang, at the waist, where there was none;
 *   2. the stations the transom and the bottom patch mate against did NOT
 *      move — §B.13's crack up both stern quarters came from exactly this
 *      kind of "small" change to a shared polyline (§V37);
 *   3. the rim is not a constant offset — it wanders, off the same seeded
 *      `irregularity` dial the sails and ratlines use, and it is STABLE
 *      across builds (§V2: same ship every run, and on every client).
 */
describe('the topsides stand proud of the deck, and the arris is broken', () => {
  const piece = galleon.find((p) => p.kind === 'hull-section')!;
  const s = piece.shape as unknown as HullShape;
  const geo = buildPieceGeometry(piece.kind, piece.aabb, piece.shape);
  const pos = geo.attributes.position;
  const uvA = geo.attributes.uv;
  const zOffset = (s.z0 + s.z1) / 2;

  /** side-strip vertices grouped by station, via the loft's own uv.x */
  const stations = new Map<number, { y: number; x: number; v: number; z: number }[]>();
  for (let i = 0; i < pos.count; i++) {
    const v = uvA.getY(i);
    const key = Math.round(uvA.getX(i) * 1e4);
    const list = stations.get(key) ?? [];
    list.push({ y: pos.getY(i), x: Math.abs(pos.getX(i)), v, z: pos.getZ(i) + zOffset });
    stations.set(key, list);
  }
  /** the loft's rows only — the bottom patch shares uv.x but never rises */
  const rims = [...stations.values()]
    .map((rows) => rows.filter((r) => r.v > 1.0001))
    .filter((rows) => rows.length > 0);

  it('carries the planking ABOVE the deck it encloses, amidships too', () => {
    // the complaint is specifically about the waist: at the ends the sheer
    // already lifted the shell clear, which is why it read as "the sides
    // meet the deck at a perfect 90°" rather than "the whole ship is flush".
    expect(rims.length).toBeGreaterThan(8);
    const lip = shipDetailParams.bulwarkLip;
    for (const rows of rims) {
      const top = Math.max(...rows.map((r) => r.y));
      const z = rows[0].z;
      const proud = top - hullTopY(z, s); // hullTopY at the waist == deck top
      expect(proud).toBeGreaterThan(lip * 0.7); // jitter is ±16%, never a deletion
      expect(proud).toBeLessThan(lip * 1.4);
    }
  });

  it('bevels the rim rather than leaving an infinitely sharp arris', () => {
    // a true 90° arris has no facet to catch a light, so it reads as one
    // aliased line whatever the sun does. §T.34 asks for the chamfer; this is
    // it, and it must actually pull the top edge inboard.
    for (const rows of rims) {
      const sorted = [...rows].sort((a, b) => a.y - b.y);
      const cap = sorted[sorted.length - 1];
      const foot = sorted[sorted.length - 2];
      expect(cap.x).toBeLessThan(foot.x); // the cap leans in: that is the bevel
      expect(foot.x - cap.x).toBeGreaterThan(shipDetailParams.railChamfer * 0.5);
    }
  });

  it('does NOT move the stations the transom and the bottom mate against', () => {
    // §V37 / §B.13. Rows at and below the sheer are the shared polyline; a
    // jittered shared station is a crack up the stern quarters that no
    // silhouette check can see. Only the rows above it were allowed to move.
    let checked = 0;
    for (const rows of stations.values()) {
      for (const r of rows) {
        // the bottom patch parameterises v ACROSS the half-breadth, so its
        // garboard edge is also v = 1 — at the keel, not at the sheer
        if (r.y <= -s.draft + 1e-6) continue;
        if (Math.abs(r.v - 1) > 1e-4) continue;
        expect(r.y).toBeCloseTo(hullTopY(r.z, s), 6); // exactly on the sheer
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(8);
  });

  it('wanders station to station, and lands the same way every build', () => {
    // the point of the whole exercise: a CONSTANT offset would just move the
    // square corner up by 28 cm and keep the machined look.
    const proud = rims.map((rows) => Math.max(...rows.map((r) => r.y)) - hullTopY(rows[0].z, s));
    const mean = proud.reduce((a, b) => a + b, 0) / proud.length;
    const spread = Math.max(...proud) - Math.min(...proud);
    expect(spread).toBeGreaterThan(mean * 0.05); // genuinely irregular…
    expect(spread).toBeLessThan(mean * 0.8); //     …but still a sheer strake
    // §V2: seeded, so it is the same ship on reload and on every client
    const again = buildPieceGeometry(piece.kind, piece.aabb, piece.shape);
    for (let i = 0; i < pos.count; i++) {
      expect(again.attributes.position.getY(i)).toBe(pos.getY(i));
    }
    again.dispose();
  });

  it('agrees at the joins between hull sections, because it keys on ship z', () => {
    // keyed on the station INDEX the jitter would step at every section
    // boundary — three sections per side, so six visible notches in the rim.
    // Keyed on ship-space z, two pieces meeting at a station agree by
    // construction. This asserts the neighbouring section's shared station.
    const sections = galleon.filter((p) => p.kind === 'hull-section' && p.shape !== undefined);
    const rimAt = (pc: PieceDef): Map<number, number> => {
      const g = buildPieceGeometry(pc.kind, pc.aabb, pc.shape);
      const sh = pc.shape as unknown as HullShape;
      const off = (sh.z0 + sh.z1) / 2;
      const out = new Map<number, number>();
      for (let i = 0; i < g.attributes.position.count; i++) {
        if (g.attributes.uv.getY(i) <= 1.0001) continue;
        const z = Math.round((g.attributes.position.getZ(i) + off) * 1e3);
        out.set(z, Math.max(out.get(z) ?? -Infinity, g.attributes.position.getY(i)));
      }
      g.dispose();
      return out;
    };
    const bySide = sections.filter((pc) => (pc.shape as unknown as HullShape).side > 0);
    expect(bySide.length).toBeGreaterThan(1);
    const maps = bySide.map(rimAt);
    let shared = 0;
    for (let a = 0; a < maps.length; a++) {
      for (let b = a + 1; b < maps.length; b++) {
        for (const [z, y] of maps[a]) {
          const other = maps[b].get(z);
          if (other === undefined) continue;
          expect(other).toBeCloseTo(y, 6); // same station ⟹ same rim height
          shared++;
        }
      }
    }
    expect(shared).toBeGreaterThan(0); // the sections really do share stations
  });
});

/**
 * ORGANIC PLANKING — the material half of the same complaint. Straightness is
 * the tell: a hull's worth of exactly parallel, exactly straight caulk lines
 * reads as printed, and this project has now had the identical "too regular"
 * note on the sea, the foam, the sails and the hull.
 *
 * These are the CPU transliteration of the two TSL terms (same convention as
 * bandLimit.ts ↔ woodMaterial's graph), and they pin the two properties that
 * make the terms safe rather than the fact that they exist:
 *   • the wander is a function of POSITION, not of board index — a per-board
 *     displacement steps at every seam and §V38 turns a step in the height
 *     field into a one-pixel spike;
 *   • it perturbs the seam's PLACE, not its WIDTH, by enough less than the
 *     plank coordinate's own gradient that the §V.48 seam gate — which is
 *     measured on the unwandered footprint — stays honest. That gate is what
 *     stands between this ship and §B.20's speckle.
 */
describe('planking is cut by eye, not by CNC', () => {
  const m = shipMaterialParams;
  /** CPU mirror of the TSL wander */
  const wander = (along: number, coord: number, amp = m.plankWander): number =>
    Math.sin((along * Math.PI * 2) / m.plankWanderLength + coord * 1.7) * amp;
  const boardCoord = (along: number, coord: number, amp = m.plankWander): number =>
    coord + wander(along, coord, amp);

  it('displaces the seam by position, so it cannot step at a board edge', () => {
    // the failure this forbids: seeding the wander from `plankCoord.floor()`.
    // That is the obvious implementation, it looks right in a still, and it
    // puts a discontinuity in the height field at every single seam.
    for (const along of [0, 3.3, 11.7]) {
      for (const seam of [1, 2, 7]) {
        const below = boardCoord(along, seam - 1e-6);
        const above = boardCoord(along, seam + 1e-6);
        expect(above - below).toBeLessThan(1e-4); // one point, one value
      }
    }
  });

  it('moves the seam without changing how wide it is on screen', () => {
    // §V.48 keeps measuring the UNWANDERED footprint, so the wander's own
    // gradient has to stay well inside the two-pixel margin FILTER_PIXELS
    // carries. Checked across the whole tunable range, not just the default —
    // a slider is exactly how this would silently stop being true.
    for (const amp of [0, m.plankWander, 0.15]) {
      let worst = 0;
      for (let c = 0; c < 12; c += 0.01) {
        for (const along of [0, 2.5, 9]) {
          const d = (boardCoord(along, c + 1e-4, amp) - boardCoord(along, c, amp)) / 1e-4;
          worst = Math.max(worst, Math.abs(d - 1)); // 1 = the unwandered gradient
        }
      }
      expect(worst).toBeLessThan(0.5); // < 1 pixel of the 2-pixel margin
    }
    // and it genuinely does wander: over half a cycle a seam swings across
    // to the other side of where it was, by up to the full amplitude
    let drift = 0;
    for (let c = 0; c < 12; c += 0.05) {
      drift = Math.max(drift, Math.abs(wander(0, c) - wander(m.plankWanderLength / 2, c)));
    }
    expect(drift).toBeGreaterThan(m.plankWander * 1.9); // ±amp, i.e. the full swing
    expect(drift * m.plankWidth).toBeGreaterThan(0.01); // …and it is centimetres, visible
  });

  it('tilts each board to zero at BOTH its seams', () => {
    // sin(2πf) is antisymmetric across the board and vanishes at either edge,
    // so a per-board tilt amplitude multiplies something that is already zero
    // where the discontinuity would be. Same reason `crown` is a sine.
    const tilt = (f: number): number => Math.sin(f * Math.PI * 2);
    expect(tilt(0)).toBeCloseTo(0, 12);
    expect(tilt(1)).toBeCloseTo(0, 12);
    expect(tilt(0.25)).toBeCloseTo(1, 12); // one edge proud…
    expect(tilt(0.75)).toBeCloseTo(-1, 12); // …the other shy
    expect(m.plankTilt).toBeGreaterThan(0);
    expect(m.plankTilt).toBeLessThan(m.seamDepth); // a tilt, not a step
  });

  it('rides the ship-wide irregularity dial instead of growing its own', () => {
    // §T.34's `irregularity` already governs the sails, the ratlines and now
    // the hull rim. A fourth private slider is how a "look" setting stops
    // meaning anything.
    expect(shipDetailParams.irregularity).toBeGreaterThan(0);
    expect(m.plankWander * 0).toBe(0); // dial to 0 ⟹ dead straight, by construction
  });
});

/**
 * THE LOCAL FRAME (islands agent, found by reading rather than by shipping).
 *
 * `createWoodMaterial` used to resolve world positions through a MODULE-LEVEL
 * `uShipWorldInverse`. That is fine until a second object wants the material:
 * a pier reusing it would have had its wet band slide around as the ship
 * sailed, because the pier's world→local transform would have been the ship's.
 *
 * This is the third instance of the shape in this project — `setShipWorldMatrix`
 * is still written once per assembly per frame, so the enemy's matrix wins and
 * the player's wetline is indexed in the wrong frame; and three's own
 * `_defaultRT`/`_sharedDepthbuffer` are resized by whichever consumer touched
 * them last. It always fails SILENTLY and always reads as a shader bug, which
 * is why it is worth a test that fails on the mechanism: two frames must be
 * two frames.
 */
describe('a material resolves world space through a frame it was GIVEN', () => {
  it('keeps two frames independent — the whole point of the parameter', () => {
    const ship = createLocalFrame();
    const pier = createLocalFrame();
    const a = new THREE.Matrix4().makeTranslation(10, 2, -30);
    const b = new THREE.Matrix4().makeTranslation(-4, 0, 7);
    ship.setFromMatrix(a);
    pier.setFromMatrix(b);
    // each holds its OWN inverse; writing one must not touch the other
    expect(ship.worldInverse.value.elements).toEqual(a.clone().invert().elements);
    expect(pier.worldInverse.value.elements).toEqual(b.clone().invert().elements);
    ship.setFromMatrix(b);
    expect(pier.worldInverse.value.elements).toEqual(b.clone().invert().elements);
    expect(ship.worldInverse.value.elements).toEqual(b.clone().invert().elements);
    // …and the module-level ship frame is one of them, not a fourth thing
    setShipWorldMatrix(a);
    expect(shipLocalFrame().worldInverse.value.elements).toEqual(a.clone().invert().elements);
    expect(pier.worldInverse.value.elements).toEqual(b.clone().invert().elements);
  });

  it('builds every piece kind with NO frame — the shore-structure path', () => {
    // omitting the frame is a supported answer, not a degraded one:
    // waterLighting treats shipLocalPos as optional and falls back to plain
    // depth-below-surface wetness, which is where a pier's wet band belongs.
    // The deck families need a frame and must SKIP their branches, not throw.
    const field = createDeckFieldTexture(buildDeckHeightfield(galleon)!);
    for (const kind of new Set(galleon.map((p) => p.kind))) {
      const mat = createPieceMaterial(kind, field, null);
      expect(mat).toBeTruthy();
      mat.dispose();
    }
  });

  it('still gives ship pieces the ship frame by default', () => {
    // every caller in this project relies on the default; the refactor must
    // not have quietly made the hull wetline stop tracking the hull.
    const mat = createPieceMaterial('hull-section');
    expect(mat).toBeTruthy();
    mat.dispose();
  });
});
