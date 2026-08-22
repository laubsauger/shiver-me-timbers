/**
 * §T90 — raft materials, GPU-free. Node graphs are ASSEMBLED here (a misused
 * node throws at build; the compile half is the browser's, §V22), the §V40
 * binding count is taken lexically the way tests/shipBindingBudget.test.ts
 * takes it, and the Kon-Tiki face is driven through its CPU mirror.
 */
import { describe, expect, it } from 'vitest';
import raftMaterialsSource from '../src/ship/raftMaterials.ts?raw';
import raftMaterialsBalsaSource from '../src/ship/raftMaterialsBalsa.ts?raw';
import raftMaterialsWeaveSource from '../src/ship/raftMaterialsWeave.ts?raw';
import raftMaterialNodesSource from '../src/ship/raftMaterialNodes.ts?raw';
import raftSailFaceSource from '../src/ship/raftSailFace.ts?raw';
import { createPieceMaterial, familyOf } from '../src/ship/pieceMaterials';
import {
  BALSA_AXIS,
  CRATE_VARIANT,
  bambooDeckVariantOf,
  crateVariantOf,
  crossbeamStation0,
} from '../src/ship/raftMaterials';
import {
  FACE_RAYS,
  konTikiFaceApplies,
  konTikiFaceNodes,
  konTikiFacePrimitives,
  konTikiFaceSdf,
} from '../src/ship/raftSailFace';
import * as THREE from 'three/webgpu';
import { float, vec2 } from 'three/tsl';
import { SHIP_ROOT_NAME, hashPieceId, pieceIdOfMesh, shipFrameDown } from '../src/ship/raftMaterialNodes';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { createSailClothMaterial } from '../src/ship/sailMaterial';
import { thatchSlopeAxes } from '../src/ship/raftMaterialsWeave';
import { roofSlope } from '../src/ship/raftPartsCabin';
import { buildRaftBlueprint } from '../src/ship/raftBlueprint';
import { raftParams } from '../src/params/raft';
import { raftMaterialParams } from '../src/params/raftMaterials';
import { getParamsEntry } from '../src/params/registry';
import type { PieceKind } from '../src/ship/pieceTypes';

const RAFT_KINDS: readonly PieceKind[] = [
  'log', 'crossbeam', 'bamboo-deck', 'guara', 'cabin-wall', 'thatch-roof',
  'bipod-mast', 'steering-oar', 'crate', 'splashboard', 'stern-block',
  // §B87 dressing pass
  'radio', 'rope-rail',
];

describe('§T90 raft material factory', () => {
  it('builds a lit, relief-carrying material for every raft kind', () => {
    for (const kind of RAFT_KINDS) {
      const mat = createPieceMaterial(kind);
      expect(mat.colorNode, `${kind} has no colour`).toBeDefined();
      expect(mat.roughnessNode, `${kind} has no roughness`).toBeDefined();
      expect(mat.name).toBe(`piece-${kind}`);
      mat.dispose();
    }
  });

  it('routes every raft kind to a raft family — none is left on the galleon presets', () => {
    const galleonFamilies = new Set(['hull', 'deck', 'spar', 'trim', 'sail', 'flag', 'iron', 'glass']);
    for (const kind of RAFT_KINDS) {
      expect(galleonFamilies.has(familyOf(kind)), `${kind} still on ${familyOf(kind)}`).toBe(false);
    }
    // and the blueprint uses nothing this file forgot
    const used = new Set(buildRaftBlueprint().map((d) => d.kind));
    for (const kind of used) expect(familyOf(kind)).toBeDefined();
  });

  it('knows the axis every balsa member runs along (a log is along z, a leg along y)', () => {
    for (const kind of RAFT_KINDS) {
      if (familyOf(kind) === 'balsa') expect(BALSA_AXIS[kind], `${kind} has no axis`).toBeDefined();
    }
    expect(BALSA_AXIS.log).toBe('z');
    expect(BALSA_AXIS.crossbeam).toBe('x');
    expect(BALSA_AXIS['bipod-mast']).toBe('y');
  });

  it('picks a crate look per authored piece id, and every dressing id resolves', () => {
    const ids = buildRaftBlueprint().filter((d) => d.kind === 'crate').map((d) => d.id);
    expect(ids).toContain('rain-drum');
    expect(ids).toContain('dinghy');
    expect(ids).toContain('cage');
    expect(crateVariantOf('rain-drum')).toBe(CRATE_VARIANT.drum);
    expect(crateVariantOf('dinghy')).toBe(CRATE_VARIANT.dinghy);
    expect(crateVariantOf('cage')).toBe(CRATE_VARIANT.cage);
    expect(crateVariantOf('jerrycan-1')).toBe(CRATE_VARIANT.jerrycan);
    expect(crateVariantOf('crate-2')).toBe(CRATE_VARIANT.pine);
    for (const id of ids) expect(Number.isInteger(crateVariantOf(id))).toBe(true);
    // mats everywhere a deck slab is; slats only on the lookout
    expect(bambooDeckVariantOf('lookout-platform')).toBe(1);
    expect(bambooDeckVariantOf('deck-fore')).toBe(0);
    expect(bambooDeckVariantOf('cabin-floor')).toBe(0);
  });

  /**
   * §B87 — the dressing pass added ONE crate look and gave four more ids a home
   * in looks that already existed, because a lane per prop is a lane per prop
   * in the shader for the rest of the project's life. What the test holds is
   * that every id the blueprint authors RESOLVES to a look, and that the four
   * that share are sharing on purpose (pots are the cage's thin dark iron; a
   * battery case is a jerrycan's dull plastic; the partition and the chart are
   * the same salvaged card).
   */
  it('every §B87 dressing id resolves to a look, and the shared ones share on purpose', () => {
    const ids = buildRaftBlueprint().filter((d) => d.kind === 'crate').map((d) => d.id);
    for (const id of ['radio-crate', 'radio-partition', 'battery-1', 'battery-2',
      'pot-1', 'pot-2', 'ladle', 'chart', 'plank-chest']) {
      expect(ids, `${id} is not in the blueprint`).toContain(id);
      expect(Number.isInteger(crateVariantOf(id)), id).toBe(true);
    }
    expect(crateVariantOf('radio-partition')).toBe(CRATE_VARIANT.card);
    expect(crateVariantOf('chart')).toBe(CRATE_VARIANT.card);
    expect(crateVariantOf('pot-1')).toBe(CRATE_VARIANT.cage);
    expect(crateVariantOf('ladle')).toBe(CRATE_VARIANT.cage);
    expect(crateVariantOf('battery-1')).toBe(CRATE_VARIANT.jerrycan);
    // a lashed crate and the plank chest are still pine/khaki boards
    expect(crateVariantOf('radio-crate')).toBe(CRATE_VARIANT.pine);
    expect(crateVariantOf('plank-chest')).toBe(CRATE_VARIANT.pine);
    // …and the weave family grew the mattress ticking and the roof laths
    expect(bambooDeckVariantOf('berth-port')).toBe(2);
    expect(bambooDeckVariantOf('berth-starboard')).toBe(2);
    expect(bambooDeckVariantOf('roof-lath-port')).toBe(1);
    expect(bambooDeckVariantOf('floor-mat-0')).toBe(0);
  });

  it('the radio draws through its own family, and the railing through the hemp one', () => {
    // §B87: the radio is the one prop a player looks AT (T103 drives its
    // dial), so it gets a family; a railing post is a weathered stake the same
    // colour as the rope on it, so it does not.
    expect(familyOf('radio')).toBe('radio');
    expect(familyOf('rope-rail')).toBe('rope');
    const mat = createPieceMaterial('radio');
    expect(mat.colorNode).toBeDefined();
    // the LED must be LIT, or it is a red dot nobody sees in a cabin at noon
    expect(mat.emissiveNode).toBeDefined();
    expect(mat.metalnessNode).toBeDefined();
    mat.dispose();
  });

  it('reads the rope-groove stations off the blueprint, not a second literal (§V37)', () => {
    const beam0 = buildRaftBlueprint().find((d) => d.id === 'crossbeam-0')!;
    expect(crossbeamStation0()).toBe(beam0.transform.position[2]);
  });

  it('identifies a piece from its mesh name, deterministically (§V2)', () => {
    expect(pieceIdOfMesh('log-3-mesh')).toBe('log-3');
    expect(pieceIdOfMesh('log-3')).toBe('log-3');
    expect(hashPieceId('log-3')).toBe(hashPieceId('log-3'));
    expect(hashPieceId('log-3')).not.toBe(hashPieceId('log-4'));
    for (const id of ['log-0', 'crate-1', 'sail-main-lower']) {
      const h = hashPieceId(id);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });
});

describe('§V40 binding budget of the raft families', () => {
  // the same patterns tests/shipBindingBudget.test.ts counts with
  const BINDING_PATTERNS: readonly RegExp[] = [
    /\btexture\s*\(/g, /\btextureNode\s*\(/g, /\btexture3D\s*\(/g, /\bcubeTexture\s*\(/g,
    /\bviewportTexture\s*\(/g, /\bviewportDepthTexture\s*\(/g, /\bshadow\s*\(/g,
    /\breflector\s*\(/g, /\.sample\s*\(/g, /\btextureLoad\s*\(/g, /\bsampleCascadeLayer\s*\(/g,
  ];
  const strip = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const sites = (s: string): number =>
    BINDING_PATTERNS.reduce((n, re) => n + (strip(s).match(re) ?? []).length, 0);

  const FAMILY_SOURCES = [raftMaterialsSource, raftMaterialsBalsaSource, raftMaterialsWeaveSource];

  it('binds no texture of its own in any raft family file', () => {
    for (const src of FAMILY_SOURCES) expect(sites(src)).toBe(0);
    expect(sites(raftMaterialNodesSource)).toBe(0);
    expect(sites(raftSailFaceSource)).toBe(0);
  });

  it('stays at or under the deck family (9 samplers) — it shares only the ship-wide set', () => {
    // every raft family = its own 0 + the set woodMaterial's non-deck families
    // bind: wetline 1 + caustics (1 array + 3 displacement) + sun shadow 1.
    // The deck family adds the heightfield + 2 deck-water tiers on top = 9.
    const SHARED = 1 + 4 + 1;
    const own = FAMILY_SOURCES.reduce((n, src) => n + sites(src), 0) + sites(raftMaterialNodesSource) + sites(raftSailFaceSource);
    expect(SHARED + own).toBeLessThanOrEqual(9);
  });

  it('binds nothing in the vertex stage (no positionNode)', () => {
    for (const src of FAMILY_SOURCES) expect(src).not.toContain('positionNode');
  });
});

describe('the Kon-Tiki face (CPU mirror of the sail decal SDF)', () => {
  const W = raftParams.mainSailWidth;
  const D = raftParams.mainSailDrop;
  const p = raftMaterialParams;

  it('is symmetric about the sail centreline', () => {
    for (let i = 0; i <= 40; i++) {
      for (let j = 0; j <= 40; j++) {
        const u = i / 40;
        const v = j / 40;
        expect(Math.abs(konTikiFaceSdf(u, v) - konTikiFaceSdf(1 - u, v))).toBeLessThan(1e-6);
      }
    }
  });

  it('is paint at the face centre and bare cloth outside the margin', () => {
    expect(konTikiFaceSdf(0.5, p.faceCentreV)).toBeLessThan(0);
    for (const [u, v] of [[0.02, 0.5], [0.98, 0.5], [0.5, 0.02], [0.5, 0.98], [0.03, 0.03]]) {
      expect(konTikiFaceSdf(u, v), `(${u},${v}) should be cloth`).toBeGreaterThan(0);
    }
  });

  it('wears exactly eight rays round the head', () => {
    // a circle through the middle of the rays crosses each one twice; the
    // head and beard sit inside it, the sail's edge outside
    const r = (p.faceRayInner + p.faceRayOuter) / 2;
    expect(p.faceRayInner).toBeGreaterThan(Math.hypot(p.faceHalfWidth, p.faceHalfHeight) - p.faceCorner * 0.4);
    const n = 1440;
    let changes = 0;
    let prev = konTikiFaceSdf(0.5 + r / W, p.faceCentreV) > 0;
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const inside = konTikiFaceSdf(0.5 + (r * Math.cos(a)) / W, p.faceCentreV + (r * Math.sin(a)) / D) > 0;
      if (inside !== prev) changes++;
      prev = inside;
    }
    expect(changes).toBe(FACE_RAYS * 2);
    expect(konTikiFacePrimitives().filter((q) => q.kind === 'segment').length).toBeGreaterThanOrEqual(FACE_RAYS);
  });

  it('goes on the raft main course only — the galleon names its course the same', () => {
    expect(konTikiFaceApplies('sail-main-lower', W)).toBe(true);
    expect(konTikiFaceApplies('sail-main-lower', 16)).toBe(false);
    expect(konTikiFaceApplies('sail-main-upper', W)).toBe(false);
    expect(konTikiFaceApplies('sail-mizzen-lower', 2)).toBe(false);
    expect(konTikiFaceApplies('sail-main-lower', Number.NaN)).toBe(false);
  });

  it('is composed into the sail material through the decal hook, once', () => {
    let calls = 0;
    const handle = createSailClothMaterial(undefined, {
      apply(color) {
        calls++;
        return color;
      },
    });
    expect(calls).toBe(1);
    expect(handle.material.colorNode).toBeDefined();
    handle.material.dispose();
  });
});

describe('§B70 — the face SDF resolves its node type in linear time', () => {
  // WHY: three's MathNode/OperatorNode.getNodeType re-walk every input with no
  // memo. An inline smin chain re-reads its predecessor ~4× per level, so 35
  // primitives unfolded to ~4^35 visits and the preview's main thread sat
  // blocked for minutes before any sail shader existed. A typed Fn pins each
  // level's type; this bounds the walk so the chain cannot grow back.
  it('getNodeType on the full fill + stroke chain returns within 250 ms', () => {
    const builder = {
      getTypeLength: (t: string) => ({ float: 1, vec2: 2, vec3: 3, vec4: 4, bool: 1, int: 1, uint: 1 }[t] ?? 1),
      isMatrix: (t: string) => typeof t === 'string' && t.startsWith('mat'),
      getVectorType: (t: string) => t,
      changeComponentType: (_t: string, c: string) => c,
      getIntegerType: (t: string) => t,
      getNodeProperties: () => ({}),
      getComponentType: () => 'float',
      getTypeFromLength: (n: number) => ['float', 'float', 'vec2', 'vec3', 'vec4'][n],
      getVectorFromMatrix: (t: string) => t,
    } as never;
    const d = konTikiFaceNodes(vec2(float(0.1), float(0.2)), konTikiFacePrimitives(), float(0.02));
    const t0 = performance.now();
    expect(d.fill.getNodeType(builder)).toBe('float');
    expect(d.stroke.getNodeType(builder)).toBe('float');
    expect(performance.now() - t0).toBeLessThan(250);
  });
});

/**
 * §T129 — WHAT THE CABIN IS DRAWN AT. Both halves are §V66: a feature is
 * scaled by its OWN dimension, and both of these had drifted onto somebody
 * else's. The weave was reading at the plaited CHECK (an EST) instead of at
 * the split-bamboo strip the reference gives a number for; the thatch was
 * reading down the WORLD instead of down the ROOF.
 */
describe('§T129 the cabin weave and the thatch are on the reference dimension (§V66)', () => {
  const m = raftMaterialParams;

  it('the wall plaits at the reference strip: the unit the eye reads is 4–5 cm, not a 20 cm check', () => {
    // [§3 Walls] "split-bamboo basket weave (~4–5 cm strips)" — the ONE
    // dimension the reference gives the cabin wall. `weaveStrip` had it right
    // all along; `weaveBlock` then multiplied it by five, and what the frame
    // shows is the product: 22.5 cm slabs of parallel canes that read as
    // stacked crates. The number that has to sit in the band is therefore the
    // repeat the wall actually presents, not the strip hiding inside it.
    expect(m.weaveStrip).toBeGreaterThanOrEqual(0.04);
    expect(m.weaveStrip).toBeLessThanOrEqual(0.05);
    const check = m.weaveStrip * Math.max(1, m.weaveBlock);
    expect(check, 'the plaited check is off the reference band').toBeGreaterThanOrEqual(0.04);
    expect(check, 'the plaited check is off the reference band').toBeLessThanOrEqual(0.05);
    // …and the ratio §V66 actually cares about: the cabin's own 2.4 m wall
    // carries the reference's ~50 strips across, not a dozen crates
    expect(raftParams.cabinWidth / check).toBeGreaterThanOrEqual(48);
  });

  it('the thatch runs down the SLOPE, not down the WORLD — a metre of course is a metre of roof', () => {
    const slope = roofSlope(raftParams);
    for (const sign of [-1, 1]) {
      // the roof slab's own frame: rotated about z by −sign·slope, so world
      // down lands in the slab's axes as `down` (this is `piece.downRest`)
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -sign * slope));
      const down = new THREE.Vector3(0, -1, 0).applyQuaternion(q.clone().invert());
      const { along, across } = thatchSlopeAxes(down);
      // it lies IN the slab (local +y is the slab's normal) and is unit
      expect(along.y).toBeCloseTo(0, 9);
      expect(along.length()).toBeCloseTo(1, 9);
      // and it points DOWN the slope: +x to starboard, −x to port
      expect(Math.sign(along.x)).toBe(sign);
      // THE PROPERTY. One metre travelled down the slope must advance the
      // coordinate by one metre — otherwise every course, strand and eave band
      // is stretched by the reciprocal. Read raw, `downRest` gives sin θ.
      const step = new THREE.Vector3(sign, 0, 0);
      expect(step.dot(along), 'the course coordinate is not measured on the roof').toBeCloseTo(1, 9);
      expect(step.dot(down), 'the frame this replaces: 1/sin θ = 4.9× too long').toBeCloseTo(Math.sin(slope), 9);
      // the ridge axis is unit, perpendicular, and runs fore-and-aft
      expect(across.length()).toBeCloseTo(1, 9);
      expect(Math.abs(across.z)).toBeCloseTo(1, 9);
      expect(along.dot(across)).toBeCloseTo(0, 9);
    }
  });

  it('the thatch pattern is many courses down the slope and many tiles along the ridge', () => {
    // §V66 again, each term against the dimension it runs on: a "course" that
    // spans the whole slope is a stripe, and a "tile" as long as the ridge is
    // a rule ruled across it. Both were true on screen because the coordinate
    // was 4.9× long, not because these numbers were wrong — so they are
    // asserted as the ratios that keep the fix honest if the roof is resized.
    const p = raftParams;
    const slope = roofSlope(p);
    const slabLen = (p.cabinWidth / 2 + p.roofOverhang) / Math.cos(slope); // ridge → eave tip
    const ridgeLen = p.cabinLength + 2 * p.roofOverhang;
    expect(slabLen / m.thatchRowPitch, 'the slope reads as one stripe, not courses').toBeGreaterThanOrEqual(6);
    expect(ridgeLen / m.thatchTileWidth, 'the course line runs the whole ridge unbroken').toBeGreaterThanOrEqual(8);
  });
});

/**
 * §T134/§B99 — THE PATTERN BELONGS TO THE PIECE, NOT TO THE SEA.
 *
 * The user filmed the cabin roof's thatch sliding back and forth as the raft
 * rocked (`docs/raft2100/ref/bug-thatch-animates-{1,2-annotated}.jpg`): "it
 * looks like it's animating the whole texture instead of just receiving a
 * shadow… which none of the other textures are doing". The cause was a live
 * WORLD-down vector in a per-object uniform, projected onto the slab to give
 * §T129's down-slope axis — so the axis was a function of the boat's attitude.
 *
 * THE WITNESS IS INVARIANCE, and it has to be taken through the ASSEMBLY (§V71:
 * a part tested against its own authored geometry passes while being wrong).
 * Rock the real ship group, read the real roof mesh, and the pattern coordinate
 * of a fixed point on the roof must not move by so much as a float.
 */
describe('§T134 the thatch pattern is a constant of the piece, not of the raft attitude', () => {
  const stubFactory = (): THREE.Material => ({ dispose(): void {} }) as unknown as THREE.Material;
  const asm = new ShipAssembly(buildRaftBlueprint(), stubFactory);
  const ROOF = ['thatch-roof-port-mesh', 'thatch-roof-starboard-mesh'] as const;

  /** put the ship at an attitude and read what the material would sample */
  const sampleAt = (meshName: string, euler: THREE.Euler): { down: THREE.Vector3; along: THREE.Vector3 } => {
    asm.group.quaternion.setFromEuler(euler);
    asm.group.updateMatrixWorld(true);
    const mesh = asm.group.getObjectByName(meshName);
    expect(mesh, `${meshName} is not in the assembly`).toBeDefined();
    const down = shipFrameDown(mesh!);
    return { down, along: thatchSlopeAxes(down).along };
  };

  /** what the pre-fix code did: the LIVE world quaternion, straight off the mesh */
  const liveWorldDown = (meshName: string, euler: THREE.Euler): THREE.Vector3 => {
    asm.group.quaternion.setFromEuler(euler);
    asm.group.updateMatrixWorld(true);
    const mesh = asm.group.getObjectByName(meshName)!;
    const q = mesh.getWorldQuaternion(new THREE.Quaternion());
    return new THREE.Vector3(0, -1, 0).applyQuaternion(q.invert());
  };

  const LEVEL = new THREE.Euler(0, 0, 0);
  // 15° of heel (roll about the fore-aft axis) and 15° of pitch, each alone and
  // together, plus a heading — a raft in a seaway visits all of them
  const ATTITUDES: readonly [string, THREE.Euler][] = [
    ['15° heel', new THREE.Euler(0, 0, THREE.MathUtils.degToRad(15))],
    ['15° pitch', new THREE.Euler(THREE.MathUtils.degToRad(15), 0, 0)],
    ['15° pitch + 15° heel', new THREE.Euler(THREE.MathUtils.degToRad(15), 0, THREE.MathUtils.degToRad(15))],
    ['heading 130°', new THREE.Euler(0, THREE.MathUtils.degToRad(130), 0)],
  ];

  it('the down-slope axis is IDENTICAL level and rocking — the pattern cannot slide', () => {
    for (const meshName of ROOF) {
      const rest = sampleAt(meshName, LEVEL);
      for (const [label, euler] of ATTITUDES) {
        const heeled = sampleAt(meshName, euler);
        // bit-for-bit: the axis is a pure function of the blueprint transform,
        // so there is no tolerance to spend here
        expect(heeled.down.equals(rest.down), `downRest moved at ${label} on ${meshName}`).toBe(true);
        expect(heeled.along.equals(rest.along), `the course axis moved at ${label} on ${meshName}`).toBe(true);
      }
    }
  });

  it('…and the old live-world vector moved it by 53° at a pitch and flipped it at a heel', () => {
    // WHY THE TEST ABOVE IS WORTH ITS LINES, measured rather than asserted from
    // memory: `thatchSlopeAxes` keeps only the component of its input lying in
    // the slab, which on an 11.77° roof is sin θ = 0.204 of a unit vector. That
    // near-degeneracy is the amplifier — a small change of attitude is a large
    // change of axis, which is why the roof was the ONLY surface visibly
    // swimming. These numbers are the defect, recorded so the fix cannot be
    // quietly reverted into a "surely it barely moves" argument.
    const mesh = 'thatch-roof-starboard-mesh';
    const rest = thatchSlopeAxes(liveWorldDown(mesh, LEVEL)).along;
    expect(rest.x).toBeCloseTo(1, 9); // starboard slab: +x is down-slope

    const pitched = thatchSlopeAxes(liveWorldDown(mesh, ATTITUDES[1][1])).along;
    const swing = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, rest.dot(pitched))));
    expect(swing, 'a 15° pitch used to swing the courses by ~53°').toBeGreaterThan(45);

    // …and 15° of heel exceeds the 11.77° pitch of the roof outright, so the
    // in-plane component changes SIGN and the whole pattern runs backwards
    const heeled = thatchSlopeAxes(liveWorldDown(mesh, ATTITUDES[0][1])).along;
    expect(heeled.dot(rest), 'a 15° heel used to flip the courses end for end').toBeLessThan(-0.99);

    // the fixed vector answers the same thing at all three (the test above), so
    // this describe block is the before/after in one file
    asm.group.quaternion.identity();
    asm.group.updateMatrixWorld(true);
  });

  it('the ship root is the node the pose lives on, and it still answers to that name', () => {
    // `shipFrameDown` walks UP TO the ship root and stops. If ShipAssembly ever
    // renames the group, the walk would run past it, swallow the pose, and put
    // the sea straight back into every piece's local frame — silently. §B85 is
    // exactly this shape of failure, so the coupling is asserted, not trusted.
    expect(asm.group.name).toBe(SHIP_ROOT_NAME);
  });
});

/**
 * §T134 — RELIEF IS IN METRES AND `reliefNormal` IS EXACT (Mikkelsen on the
 * true screen gradient), so a `*Bump` gain is pure exaggeration and the face
 * slope it produces is arithmetic, not taste. §T129 removed a 4.9× stretch from
 * the thatch's coordinate and left `thatchBump` 6 behind, which multiplied
 * every gradient by the same 4.9 — the frames show each leaf course as a lit
 * slab beside a black one, "a row of crates".
 */
describe('§T134 the raft relief presents believable faces, not embossed crates', () => {
  const m = raftMaterialParams;
  /** max slope of a half-sine crown of amplitude `amp` over period `p`, degrees */
  const crownFace = (amp: number, period: number, bump: number): number =>
    THREE.MathUtils.radToDeg(Math.atan((Math.PI * amp * bump) / period));

  it('a thatch leaf lies ON its neighbour — it does not stand up like a kerb', () => {
    // the row crown carries 0.8 of `thatchRelief` (raftMaterialsWeave.ts)
    const face = crownFace(m.thatchRelief * 0.8, m.thatchRowPitch, m.thatchBump);
    expect(face, 'the thatch reads as corrugated iron').toBeLessThan(20);
    expect(face, 'the thatch has gone flat — a painted plane again (§B87)').toBeGreaterThan(6);
  });

  it('a split-bamboo strand is crowned, not moulded', () => {
    const face = crownFace(m.weaveRelief, m.weaveStrip, m.weaveBump);
    expect(face, 'the wall reads as moulded plastic').toBeLessThan(28);
    expect(face, 'the plait has lost its over-under').toBeGreaterThan(10);
  });

  it("the material's leaf lap is SMALLER than the geometry's structural course", () => {
    // §V66 — the two are different features and must not compete. The geometry
    // steps every `roofCoursePitch`; the material draws the leaves INSIDE one
    // of those steps, so several laps have to fit in a course. At 0.12 against
    // 0.30 they were 0.4 apart and read as one confused stack of blocks.
    expect(raftParams.roofCoursePitch / m.thatchRowPitch,
      'the leaf lap and the structural course are the same feature twice').toBeGreaterThanOrEqual(3);
    // …and a leaf is wider across the slope than it is deep down it, which is
    // what makes it a TILE rather than a batten [§3 Roof]
    expect(m.thatchTileWidth).toBeGreaterThan(m.thatchRowPitch);
  });
});

describe('§V16 raft material params', () => {
  it('registers every tunable under raft-materials', () => {
    const entry = getParamsEntry('raft-materials');
    expect(entry).toBeDefined();
    expect(entry!.params).toBe(raftMaterialParams);
    for (const key of ['balsaGrey', 'weedColor', 'weaveStrip', 'thatchRowPitch', 'faceFill', 'sailTint', 'drumColor']) {
      expect(key in entry!.params, key).toBe(true);
    }
  });
});
