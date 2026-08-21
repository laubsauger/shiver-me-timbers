/**
 * Hull waterline contact sampler — WHY these tests:
 * the user's report is that spray "detaches" because the emitters fire from
 * a FIXED stem point that is often in mid-air over a trough. So the one
 * thing this module must never do is hand a consumer a contact point that
 * is not on the water, and the one thing it must always do is tell a
 * consumer when nothing is touching at all. Everything below is a way of
 * failing if either of those regresses.
 *
 * §V.8: it samples the same CpuOcean mirror buoyancy does — a second,
 * differently-sampled sea would put the spray back off the waves (§B.7).
 */
import { describe, expect, it } from 'vitest';
import { quatFromAxisAngle, quatMul, rotateVec } from '../src/core/quat';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../src/params/seaPhysics';
import { cascadeBand, spectralHeightVariance } from '../src/ocean/oceanMath';
import { CpuOcean, MIRRORED_CASCADES } from '../src/sea-physics/cpuOcean';
import {
  buildWaterlineStations,
  createHullContact,
  waterlineFromBox,
  waterlineFromBlueprint,
  type HullWaterline,
} from '../src/sea-physics/hullContact';
import { stepShipBuoyancy } from '../src/sea-physics/buoyancy';
import { buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { galleonParams } from '../src/params/ship';
import type { ShipState } from '../src/state/simState';

const DT = 1 / 60;

function testOceanParams(over: Partial<OceanParams> = {}): OceanParams {
  return { ...oceanParams, resolution: 128, ...over };
}
function testSeaParams(over: Partial<SeaPhysicsParams> = {}): SeaPhysicsParams {
  return { ...seaPhysicsParams, mirrorResolution: 64, ...over };
}

/**
 * Ocean params scaled to a TARGET RMS surface elevation (§V.36 spirit:
 * express a sea state as the sea state, not as whatever `amplitude` happens
 * to mean this week). Phillips energy is linear in `amplitude` and elevation
 * is its square root, so one closed-form rescale hits the target exactly —
 * measured over the cascades the CPU mirror actually carries, since those
 * are the waves the hull feels.
 */
function seaOfSpectralRms(targetRms: number, over: Partial<OceanParams> = {}): OceanParams {
  const base = testOceanParams(over);
  let variance = 0;
  for (let i = 0; i < MIRRORED_CASCADES; i++) {
    variance += spectralHeightVariance(
      base.resolution,
      base.cascades[i].domain,
      base,
      cascadeBand(i, base.splitWavelengths),
    );
  }
  const rms = Math.sqrt(Math.max(1e-9, variance));
  return { ...base, amplitude: base.amplitude * (targetRms / rms) ** 2 };
}

function makeShip(): ShipState {
  return {
    id: 's',
    kind: 'player',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim: 0,
    flood: 0,
    damage: {},
  };
}

/** flat sea at a fixed height — isolates geometry from wave phase */
function flatSea(level: number) {
  let t = 0;
  return {
    get currentTime(): number {
      return t;
    },
    update(time: number): void {
      t = time;
    },
    heightAt(): number {
      return level;
    },
    // flat water is one mode at k = 0, so e^(−k·d) = 1 and the pressure head
    // IS the surface — the Smith correction (§V.68) is identically inert here
    pressureHeadAt(): number {
      return level;
    },
  };
}

const HULL: HullWaterline = waterlineFromBox(21, -17.5, 4.25);

describe('waterline stations come from the hull, not from a constant', () => {
  it('spans stem to transom and narrows to a point at the stem', () => {
    // WHY: hardcoded stations silently describe an older boat the moment
    // the ship agent reshapes the hull (§V.18 says the mesh is swappable).
    const { stations, sliceZ } = buildWaterlineStations(HULL, 9);
    expect(stations).toHaveLength(18);
    expect(sliceZ[0]).toBeCloseTo(21, 6); // slice 0 is the stem
    expect(sliceZ[sliceZ.length - 1]).toBeCloseTo(-17.5, 6);
    // slices run bow → stern, monotonically
    for (let i = 1; i < sliceZ.length; i++) expect(sliceZ[i]).toBeLessThan(sliceZ[i - 1]);
    // bow-biased: over half the slices sit in the forward third
    const foreThird = 21 - (21 + 17.5) / 3;
    expect([...sliceZ].filter((z) => z > foreThird).length).toBeGreaterThan(sliceZ.length / 2);
    // the pair collapses at the stem and opens out amidships
    expect(Math.abs(stations[0].x)).toBeLessThan(0.5);
    const widest = Math.max(...stations.map((s) => Math.abs(s.x)));
    expect(widest).toBeGreaterThan(2);
    expect(widest).toBeLessThanOrEqual(4.25);
  });

  it('reads the real galleon loft out of its blueprint', () => {
    // WHY: this is the link that keeps the stations honest as the hull
    // changes shape. If the ship agent's shape hints move, fail here — with
    // a named test — instead of drifting quietly in game.
    const hull = waterlineFromBlueprint(buildGalleonBlueprint(galleonParams));
    expect(hull).not.toBeNull();
    const p = galleonParams;
    expect(hull!.bowZ).toBeCloseTo(p.hullLength / 2 + p.bowLength, 6);
    expect(hull!.sternZ).toBeCloseTo(-p.hullLength / 2, 6);
    expect(hull!.halfWidthAt(hull!.bowZ)).toBeLessThan(0.5); // pointed stem
    expect(hull!.halfWidthAt(0)).toBeGreaterThan(p.beam / 4); // full amidships
    expect(hull!.halfWidthAt(0)).toBeLessThanOrEqual(p.beam / 2);
  });

  it('falls back to null (not a guess) when a blueprint carries no loft', () => {
    expect(waterlineFromBlueprint([{ shape: { notAHull: 1 } }, {}])).toBeNull();
  });
});

describe('contact: the emitter point is ON the water or nowhere', () => {
  it('level hull in calm water: the cutwater is the stem, and it is wet', () => {
    const contact = createHullContact(HULL, 9);
    const ship = makeShip();
    ship.position[1] = -0.4; // riding at its draft
    const sea = flatSea(0);
    sea.update(DT);
    contact.update(ship, sea, DT);
    expect(contact.inContact).toBe(true);
    expect(contact.wetFraction).toBe(1);
    expect(contact.cutwater.inContact).toBe(true);
    expect(contact.cutwater.localZ).toBeCloseTo(21, 6);
    expect(contact.cutwater.depth).toBeCloseTo(0.4, 6);
    expect(contact.contactZFore).toBeCloseTo(21, 6);
    expect(contact.contactZAft).toBeCloseTo(-17.5, 6);
  });

  it('BOW LIFTED CLEAR: the contact point moves aft and stays on the surface', () => {
    // WHY — this is the user's bug, in one test: "it looks detached,
    // because the spray comes out from something that is in the air where
    // there's nothing touching the water". Pitch the bow up so the stem is
    // metres above the sea. The cutwater must move aft to the real entry
    // point and its world y must sit ON the water, not on the hull.
    const contact = createHullContact(HULL, 9);
    const ship = makeShip();
    ship.quaternion = quatFromAxisAngle([1, 0, 0], -0.18); // ≈10° bow-up
    ship.position[1] = 1.2;
    const sea = flatSea(0);
    sea.update(DT);
    contact.update(ship, sea, DT);

    // the stem itself is out of the water — the old fixed emitter point
    const stemWorldY = ship.position[1] + rotateVec(ship.quaternion, [0, 0, 21])[1];
    expect(stemWorldY).toBeGreaterThan(1.5);
    expect(contact.sliceDepth[0]).toBeLessThan(0);

    expect(contact.inContact).toBe(true);
    expect(contact.cutwater.inContact).toBe(true);
    // ...so the contact point is well aft of the stem...
    expect(contact.cutwater.localZ).toBeLessThan(15);
    expect(contact.cutwater.localZ).toBeGreaterThan(-17.5);
    // ...and it is ON the waterline, which is the whole fix
    expect(Math.abs(contact.cutwater.world[1])).toBeLessThan(0.05);
    // it also reports a positive immersion for intensity, never 0/negative
    expect(contact.cutwater.depth).toBeGreaterThan(0);
  });

  it('the crossing slides CONTINUOUSLY as the bow rises — no slice-sized hops', () => {
    // WHY: snapping the emitter to the nearest wet STATION teleports it aft
    // in metre jumps as each station dries out, which reads as a second
    // detachment bug. Measured against that quantised alternative
    // (contactZFore) over the same sweep, so the comparison holds however
    // fast the pose is swept and however many slices are configured.
    const contact = createHullContact(HULL, 9);
    const ship = makeShip();
    const sea = flatSea(0);
    let prevSmooth = Number.NaN;
    let prevQuant = Number.NaN;
    let maxSmoothJump = 0;
    let maxQuantJump = 0;
    for (let i = 0; i <= 600; i++) {
      const u = i / 600;
      ship.quaternion = quatFromAxisAngle([1, 0, 0], -u * 0.25); // → ~14° bow-up
      ship.position[1] = -0.4 + 1.6 * u;
      const t = (i + 1) * DT;
      sea.update(t);
      contact.update(ship, sea, t);
      if (!contact.cutwater.inContact) continue;
      if (Number.isFinite(prevSmooth)) {
        maxSmoothJump = Math.max(maxSmoothJump, Math.abs(contact.cutwater.localZ - prevSmooth));
        maxQuantJump = Math.max(maxQuantJump, Math.abs(contact.contactZFore - prevQuant));
      }
      prevSmooth = contact.cutwater.localZ;
      prevQuant = contact.contactZFore;
    }
    expect(Number.isFinite(prevSmooth)).toBe(true);
    expect(prevSmooth).toBeLessThan(15); // it did travel aft
    // the quantised version really does hop a whole slice at a time...
    expect(maxQuantJump).toBeGreaterThan(1);
    // ...while the interpolated crossing creeps
    expect(maxSmoothJump).toBeLessThan(maxQuantJump / 3);
    // never a whole slice in one tick, even at the fast end of the sweep
    expect(maxSmoothJump).toBeLessThan(21 - contact.sliceZ[1]);
  });

  it('fully airborne hull reports NO contact — emitters must shut off', () => {
    // WHY: the flag is the only thing that can stop a consumer emitting.
    // A sampler that silently returns the stem here recreates the bug.
    const contact = createHullContact(HULL, 9);
    const ship = makeShip();
    ship.position[1] = 12; // launched clean off a crest
    const sea = flatSea(0);
    sea.update(DT);
    contact.update(ship, sea, DT);
    expect(contact.inContact).toBe(false);
    expect(contact.cutwater.inContact).toBe(false);
    expect(contact.wetFraction).toBe(0);
    expect(Number.isNaN(contact.contactZFore)).toBe(true);
    expect(contact.cutwater.depth).toBe(0);
  });
});

describe('burial rate (impact energy, what spray intensity keys off)', () => {
  it('is positive while driving under and negative while emerging', () => {
    const contact = createHullContact(HULL, 9);
    const ship = makeShip();
    const sea = flatSea(0);
    ship.position[1] = 0.5;
    sea.update(DT);
    contact.update(ship, sea, DT); // first tick: no history, rate 0
    expect(contact.cutwater.rate).toBe(0);

    ship.position[1] = 0.5 - 2 * DT; // 2 m/s downward
    sea.update(2 * DT);
    contact.update(ship, sea, 2 * DT);
    expect(contact.sliceRate[0]).toBeCloseTo(2, 3);

    ship.position[1] = 0.5; // back up at 2 m/s
    sea.update(3 * DT);
    contact.update(ship, sea, 3 * DT);
    expect(contact.sliceRate[0]).toBeCloseTo(-2, 3);
  });

  it('is clamped, so a mirror recompute cannot fire a burst from nowhere', () => {
    const contact = createHullContact(HULL, 9);
    const ship = makeShip();
    const sea = flatSea(0);
    ship.position[1] = 0;
    sea.update(DT);
    contact.update(ship, sea, DT);
    ship.position[1] = -1000; // absurd step, as a stale-grid jump would be
    sea.update(2 * DT);
    contact.update(ship, sea, 2 * DT);
    expect(contact.sliceRate[0]).toBeLessThanOrEqual(20);
  });
});

describe('§V.8: the contact point is on the SAME sea the ship floats on', () => {
  it('tracks the mirrored spectrum, tick by tick, under a real hull', () => {
    // WHY §V.8/§B.7: spray keyed to a different (or staler) sea than the
    // buoyancy floats on is the drift the invariant exists to forbid — it
    // is what "detached" looks like even when the emitter is in the water.
    const op = testOceanParams({ amplitude: 1 });
    const sp = testSeaParams();
    const ocean = new CpuOcean(7, op, sp);
    const contact = createHullContact(HULL, 9);
    const ship = makeShip();
    ship.position[1] = -0.4;
    let airborneTicks = 0;
    let checked = 0;
    for (let i = 0; i < 900; i++) {
      const t = (i + 1) * DT;
      ocean.update(t);
      stepShipBuoyancy(ship, ocean, DT, sp);
      contact.update(ship, ocean, t);
      if (i < 300) continue; // let the transient settle
      if (!contact.cutwater.inContact) {
        airborneTicks++;
        continue;
      }
      const cw = contact.cutwater.world;
      const surface = ocean.heightAt(cw[0], cw[2], t);
      // the emitter point sits ON the water surface every single tick — a
      // regression guard for the snap: drop it and the coarse slice chord
      // puts the emitter tens of centimetres off a curved wave again
      expect(Math.abs(cw[1] - surface)).toBeLessThan(1e-9);
      // and it is a point on the HULL, between the last dry slice and the
      // first wet one — not just any point of the sea
      expect(contact.cutwater.localZ).toBeGreaterThanOrEqual(contact.contactZFore - 1e-9);
      checked++;
    }
    expect(checked).toBeGreaterThan(500);
    // and in a seaway the bow does leave the water sometimes — which is
    // exactly when the old fixed-point emitter was firing into the air
    expect(airborneTicks + checked).toBe(600);
  });
});

describe('feel target: the hull keeps CONTACT with the sea', () => {
  it('the forefoot is not airborne most of the time at cruising speed', () => {
    // WHY (user, sailing live): "sometimes we're losing contact with the
    // waves a little bit too much — we start to fly a little bit early".
    // Measured cause was heave/pitch damping: the hull was riding out of a
    // beam sea and taking the stem with it. This pins the symptom directly —
    // how often the stem's KEEL line (draft below the waterline outline) is
    // clear of the water — because that is what "flying" looks like.
    //
    // Fixed sea params on purpose: the ocean agent tunes the live spectrum
    // continuously, and this must fail on a sea-physics regression, never on
    // someone else's weather.
    // The sea is pinned by MEASURED WAVE HEIGHT, not by an amplitude
    // constant. An amplitude number changes meaning every time the spectrum
    // is retuned — and how much damping helps is itself sea-state dependent
    // (at 3× sailing weather the forefoot flies whatever the damping does,
    // correctly: real ships leave the water in a real gale). Normalising by
    // RMS elevation makes "sailing weather" mean the same thing next week.
    const op = seaOfSpectralRms(0.6, { windSpeed: 11 });

    // BOTH hulls fly through ONE sea. This is a damping comparison, so the
    // two runs are only meaningful against the SAME water — and they always
    // were, because CpuOcean.update(t) is a pure function of t and reads no
    // ship state, while buoyancy and hullContact only ever READ heightAt.
    // buoyancyDamping is not in the mirror's rebuild signature either
    // (cpuOcean `mirrorSignature`), so the two CpuOcean(7, op, sp) the old
    // code built were bit-identical objects computing bit-identical IFFTs —
    // twice, and the IFFT is 71% of a tick. Interleaving is not an
    // approximation: each ship sees the same field at the same t.
    const fly = (
      sps: SeaPhysicsParams[],
    ): { stemDry: number; keelClear: number; rms: number }[] => {
      const ocean = new CpuOcean(7, op, sps[0]);
      const rigs = sps.map((sp) => {
        const ship = makeShip();
        ship.position[1] = -0.4;
        return {
          sp,
          ship,
          contact: createHullContact(HULL, 11),
          water: [] as number[],
          keelClear: 0,
          stemDry: 0,
          samples: 0,
        };
      });
      for (let i = 0; i < 3000; i++) {
        const t = (i + 1) * DT;
        ocean.update(t);
        for (const r of rigs) {
          r.ship.position[0] += 8 * DT; // beam sea at 8 m/s — the worst case
          stepShipBuoyancy(r.ship, ocean, DT, r.sp);
          r.contact.update(r.ship, ocean, t);
          if (i < 900) continue;
          r.samples++;
          const sx = (r.contact.worldX[0] + r.contact.worldX[1]) / 2;
          const sy = (r.contact.worldY[0] + r.contact.worldY[1]) / 2;
          const sz = (r.contact.worldZ[0] + r.contact.worldZ[1]) / 2;
          const surface = ocean.heightAt(sx, sz, t);
          r.water.push(surface);
          const gap = sy - surface;
          if (gap > 0) r.stemDry++;
          if (gap > 2) r.keelClear++; // 2 m = galleon draft: the keel is in air
        }
      }
      return rigs.map((r) => {
        const m = r.water.reduce((s, v) => s + v, 0) / r.water.length;
        const rms = Math.sqrt(
          r.water.reduce((s, v) => s + (v - m) ** 2, 0) / r.water.length,
        );
        return { stemDry: r.stemDry / r.samples, keelClear: r.keelClear / r.samples, rms };
      });
    };

    // the measured cause: at the old damping she rides out of the sea far
    // more (0.70 of the flying at this sea state, measured).
    const [shipped, bouncy] = fly([
      testSeaParams(),
      testSeaParams({ buoyancyDamping: 1.6e5 }),
    ]);
    // fail loud if the normalisation stopped working: every threshold below
    // is calibrated for roughly this much sea and means nothing without it
    expect(shipped.rms).toBeGreaterThan(0.6);
    expect(shipped.rms).toBeLessThan(1.4);
    expect(shipped.keelClear).toBeLessThan(bouncy.keelClear * 0.85);
    // she still lifts her forefoot sometimes — a ship that never did would
    // be glued to the water, which is the other half of the same complaint
    expect(shipped.stemDry).toBeGreaterThan(0.05);
    // ...but not as a habit
    expect(shipped.keelClear).toBeLessThan(0.25);
  });
});

describe('determinism (§V.2) and cost', () => {
  it('same pose + same sea → identical contact numbers', () => {
    const run = (): number[] => {
      const ocean = new CpuOcean(3, testOceanParams({ amplitude: 0.8 }), testSeaParams());
      const contact = createHullContact(HULL, 9);
      const ship = makeShip();
      ship.position[1] = -0.4;
      ship.quaternion = quatMul(
        quatFromAxisAngle([0, 1, 0], 0.7),
        quatFromAxisAngle([1, 0, 0], -0.05),
      );
      for (let i = 0; i < 120; i++) {
        const t = (i + 1) * DT;
        ocean.update(t);
        contact.update(ship, ocean, t);
      }
      return [contact.cutwater.localZ, contact.cutwater.depth, contact.cutwater.rate, contact.wetFraction];
    };
    expect(run()).toEqual(run());
  });

  it('refuses to sample a sea nobody has advanced (§B.7 fail-loud)', () => {
    const ocean = new CpuOcean(1, testOceanParams(), testSeaParams());
    const contact = createHullContact(HULL, 9);
    expect(() => contact.update(makeShip(), ocean, 0)).toThrow(/ocean.update/);
  });
});
