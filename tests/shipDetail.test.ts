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
import * as THREE from 'three';
import { buildBrigantineBlueprint, buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { buildPieceGeometry } from '../src/ship/pieceGeometry';
import { galleonParams, shipDetailParams, shipFlagParams } from '../src/params/ship';
import type { PieceDef } from '../src/ship/pieceTypes';
import { hullHalfWidthAt, hullTopY, type HullShape } from '../src/ship/hullMath';
import { SPAR_AXIS, createPieceMaterial } from '../src/ship/pieceMaterials';
import { createDeckFieldTexture } from '../src/ship/deckFieldTexture';
import {
  advanceFlag,
  angleDelta,
  apparentWind,
  streamStrength,
  wrapAngle,
} from '../src/ship/flagDynamics';
import {
  buildDeckHeightfield,
  sampleDeckField,
  sampleDeckHeight,
} from '../src/ship/deckHeightfield';
import { vhash, vjitter } from '../src/ship/variation';

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

  it('ratline rungs land ON the shrouds, not beside them', () => {
    // WHY: src/ropes solves the shrouds as catenaries between the chainplate
    // sockets and the masthead (slack 1.004 — straight to a couple of cm). The
    // rungs are built here from the SAME sockets; if either side ever computed
    // its own endpoints instead, the ladder would hang in mid-air next to the
    // ropes and nothing would fail loudly.
    const mast = byId.get('mast-main')!;
    const head = new THREE.Vector3(0, mast.aabb.max[1], 0);
    for (const side of ['port', 'starboard']) {
      const rat = byId.get(`ratlines-${side}-main`)!;
      const feet = galleon
        .filter((p) => p.kind === 'hull-section')
        .flatMap((p) =>
          p.sockets
            .filter((s) => s.id.startsWith(`anchor-channel-${side}-main-`))
            .map((s) =>
              new THREE.Vector3(
                s.position[0],
                s.position[1] - mast.transform.position[1],
                s.position[2] + p.transform.position[2] - mast.transform.position[2],
              ),
            ),
        );
      expect(feet.length).toBe(galleonParams.channelPlates);
      const geo = buildPieceGeometry(rat.kind, rat.aabb, rat.shape);
      const pos = geo.attributes.position;
      expect(pos.count).toBeGreaterThan(100); // a real ladder, not two sticks
      const v = new THREE.Vector3();
      const line = new THREE.Line3();
      const closest = new THREE.Vector3();
      let worst = 0;
      for (let i = 0; i < pos.count; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        let best = Infinity;
        for (const foot of feet) {
          line.set(foot, head);
          line.closestPointToPoint(v, true, closest);
          best = Math.min(best, closest.distanceTo(v));
        }
        worst = Math.max(worst, best);
      }
      geo.dispose();
      // rungs span BETWEEN shrouds, so only their ends touch one; the belly of
      // a rung is legitimately off-line by up to the fan's own spread
      const spread = feet[0].distanceTo(feet[feet.length - 1]);
      expect(worst, `${side} rungs stray ${worst.toFixed(2)}m`).toBeLessThan(spread * 0.7);
    }
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
      { root: NaN, tip: NaN, strength: NaN },
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
    let s = { root: 0, tip: 0, strength: 1 };
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
    let s = { root: 3.0, tip: 3.0, strength: 1 };
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
