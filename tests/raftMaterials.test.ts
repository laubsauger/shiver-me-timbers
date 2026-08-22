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
  balsaContrastStretch,
  balsaCreviceAt,
  balsaEndness,
  balsaGrooveAt,
  balsaLuminance,
  balsaToneRange,
  balsaWeedBand,
  balsaWetBand,
  bambooDeckVariantOf,
  crateVariantOf,
  createBalsaMaterial,
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
import { coordFilter } from '../src/ship/bandLimit';
import {
  SHIP_ROOT_NAME,
  createRaftPieceUniforms,
  hashPieceId,
  pieceIdOfMesh,
  shipFrameDown,
} from '../src/ship/raftMaterialNodes';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { createSailClothMaterial } from '../src/ship/sailMaterial';
import { thatchSlopeAxes } from '../src/ship/raftMaterialsWeave';
import { roofSlope } from '../src/ship/raftPartsCabin';
import { buildRaftBlueprint, raftLayout } from '../src/ship/raftBlueprint';
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

/**
 * §T147 — THE LOGS READ AS PLASTIC. The user, from the stern: "the colours are
 * a little bit lame, way too even. It looks like plastic instead of wood…
 * the textures are still a little bit weak."
 *
 * The chink half of the task was answered by MEASUREMENT and needed no change —
 * see tests/raft.test.ts, where the built raft's log surfaces sit 2.5–7.1 cm
 * apart along the whole parallel body, dead inside the reference's 2–8 cm.
 * What follows is the material half: the properties that separate timber from
 * a tube, each asserted against the thing woodMaterial.ts has and this file
 * did not.
 */
describe('§T147 the balsa reads as wood, not as a moulded tube', () => {
  const m = raftMaterialParams;
  const LOG_IDS = Array.from({ length: raftParams.logCount }, (_, k) => `log-${k}`);

  /**
   * ref §7 — "no two logs alike". A shared material can only deliver this
   * through the per-object seed (§B85/§T90), so the property has two halves and
   * BOTH were broken before §T147:
   *
   *   • the SEED had to spread. `hashPieceId` was plain FNV-1a folded to its
   *     top 24 bits, and FNV mixes upward, so `log-0 … log-8` came back as
   *     0.5631 … 0.6100 — a 1/256 step between neighbours and 4.7% of the range
   *     for the whole family. Nine logs at one seed is nine identical logs.
   *   • the TONE had to use the seed. `seed × toneVar` is one-sided, so even a
   *     spread seed only ever reached the grey half of the grey→warm ramp.
   *
   * Asserted as a DISTRIBUTION, not per pair: a hash is allowed to put two
   * neighbours near each other — what it may not do is put all nine there.
   */
  it('no two logs alike: the seeded tones spread across the palette', () => {
    const lum = LOG_IDS.map((id) => balsaLuminance(balsaToneRange(hashPieceId(id)).tone));
    const base = lum.reduce((s, x) => s + x, 0) / lum.length;
    const spread = (Math.max(...lum) - Math.min(...lum)) / base;
    const adj = lum.slice(1).map((x, k) => Math.abs(x - lum[k]) / base).sort((a, b) => a - b);
    const median = adj[Math.floor(adj.length / 2)];

    // the defect, as the number it was: the whole nine-log family used to span
    // 4.7% of the seed range, which came out as ~1.4% of tone
    expect(spread, `nine logs still span only ${(spread * 100).toFixed(1)}% of tone`)
      .toBeGreaterThan(0.25);
    expect(median, 'the typical pair of neighbours is the same log twice')
      .toBeGreaterThan(0.05);
    for (let k = 1; k < lum.length; k++) {
      expect(Math.abs(lum[k] - lum[k - 1]) / base, `log-${k - 1} and log-${k} are identical`)
        .toBeGreaterThan(0.005);
    }
    // and the crossbeams — "the second layer" — spread too, on the same seed
    const beams = Array.from({ length: raftParams.crossbeamCount }, (_, k) =>
      balsaLuminance(balsaToneRange(hashPieceId(`crossbeam-${k}`)).tone));
    const bBase = beams.reduce((s, x) => s + x, 0) / beams.length;
    expect((Math.max(...beams) - Math.min(...beams)) / bBase).toBeGreaterThan(0.25);
  });

  it('the seed spreads for ANY numbered family — the §T147 root cause', () => {
    // The property, held away from the balsa so it fails wherever it breaks:
    // consecutive ids in a family must land all over 0..1, not in one bucket.
    for (const family of ['log-', 'crossbeam-', 'crate-', 'guara-', 'lashing-']) {
      const s = Array.from({ length: 9 }, (_, k) => hashPieceId(`${family}${k}`));
      // the recorded defect is 0.047 of the range for a nine-piece family; nine
      // samples of a genuinely spread hash bounce around 0.8 with a fat lower
      // tail, so the bar is set an order of magnitude above the defect, not at
      // the ideal (§V80: the property is "spread", not a particular draw)
      expect(Math.max(...s) - Math.min(...s), `${family}* all draw at one seed`)
        .toBeGreaterThan(0.4);
      expect(new Set(s.map((x) => Math.floor(x * 5))).size, `${family}* seeds bunch`)
        .toBeGreaterThanOrEqual(3);
      // …and the ORDER is not the value: a monotone hash is a gradient painted
      // across the raft, which is not variation either
      const rising = s.slice(1).filter((x, k) => x > s[k]).length;
      expect(rising, `${family}* seeds march in order`).toBeGreaterThan(1);
      expect(rising, `${family}* seeds march in order`).toBeLessThan(7);
    }
  });

  it('the seed the tone rides on actually reaches the shader (§B85)', () => {
    // §B85's failure was silent: the hook lived on `aabbMin` alone, three fires
    // a uniform's object update only when THAT uniform is in the shader, and a
    // seed-only graph therefore never updated — every crate drew as pine. The
    // balsa's whole "no two logs alike" property hangs off the same hook, so
    // it is driven here rather than trusted.
    const u = createRaftPieceUniforms();
    const stubFactory = (): THREE.Material => ({ dispose(): void {} }) as unknown as THREE.Material;
    const asm = new ShipAssembly(buildRaftBlueprint(), stubFactory);
    asm.group.updateMatrixWorld(true);
    for (const id of ['log-0', 'log-4', 'crossbeam-3']) {
      const mesh = asm.group.getObjectByName(`${id}-mesh`);
      expect(mesh, `${id} is not in the assembly`).toBeDefined();
      const node = u.seed as unknown as { updateType: string; update(f: unknown): void; value: number };
      expect(node.updateType).toBe('object');
      node.update({ object: mesh, frameId: Math.random() });
      expect(node.value, `${id}'s seed never arrived`).toBe(hashPieceId(id));
    }
    // and the graph reads it — a hook on a uniform nothing samples is a no-op
    expect(raftMaterialsBalsaSource).toContain('piece.seed');
  });

  it('the grain is a COLOUR ramp with contrast, not a ±3% brightness ripple', () => {
    // THE DEFECT, as arithmetic. `mix(0.86, 1.1, grain)` is ±12% ACHROMATIC at
    // its extremes, and a 3-octave value fbm measured over a log flank has mean
    // 0.51 and sd 0.129 — so what reached the pixel was a brightness sd of
    // 0.24 × 0.129 = ±3.1%, with no hue movement at all. woodMaterial has
    // always run `mix(hullDark, hullLight, grain)` between two DIFFERENT
    // colours 1.6–2.0× apart per channel. That is the difference the user saw.
    const OLD_RELATIVE_SD = 0.24 * 0.129;
    expect(OLD_RELATIVE_SD).toBeLessThan(0.04); // the recorded defect

    // …and the OTHER half of why it was invisible: the fbm never reaches its
    // own extremes. The contrast stretch is what puts a measured p10/p90 pair
    // (0.343 / 0.674) somewhere near the ends of the ramp, and it is
    // mean-preserving, so it darkens nothing on average.
    expect(balsaContrastStretch(0.5)).toBeCloseTo(0.5, 9);
    expect(balsaContrastStretch(0.343)).toBeLessThan(0.2);
    expect(balsaContrastStretch(0.674)).toBeGreaterThan(0.8);
    expect(balsaContrastStretch(0.5 - 0.16) + balsaContrastStretch(0.5 + 0.16)).toBeCloseTo(1, 9);

    for (const seed of [0.05, 0.5, 0.95]) {
      const { dark, lite, tone } = balsaToneRange(seed);
      const ratio = balsaLuminance(lite) / balsaLuminance(dark);
      expect(ratio, 'the grain ends are the same colour twice').toBeGreaterThan(1.6);
      // …and it MOVES THE HUE, which a brightness multiply cannot: the dark end
      // is relatively warmer/browner than the light end (weathered balsa greys
      // where it is dry and browns where it holds water)
      const hue = (c: THREE.Color): number => c.r / Math.max(1e-6, c.b);
      expect(hue(dark), 'the dark end is a scaled copy of the light one')
        .not.toBeCloseTo(hue(lite), 2);
      // the spread the pixel actually sees, in units of the base tone: the
      // stretched fbm has sd 0.27 (measured, see CONTRAST_GAIN), so
      // sd(colour) ≈ 0.27 × |lite − dark|
      const spread = 0.27 * (balsaLuminance(lite) - balsaLuminance(dark)) / balsaLuminance(tone);
      expect(spread, `seed ${seed}: still too even`).toBeGreaterThan(4 * OLD_RELATIVE_SD);
    }
  });

  it('something varies at the scale the viewer stands at — the empty band', () => {
    // §V66/§V48 read together. Every varying term used to be either per-PIECE
    // (one tone for a whole 13.7 m log) or 2.8 cm grain, which is sub-pixel
    // past a few metres and averages to ONE FLAT COLOUR. At the 10 m the raft
    // is looked at there was, arithmetically, nothing left — which is exactly
    // what "way too even" describes. woodMaterial fills that band with 0.55 m
    // per-board tone steps; a log has no boards, so the stain does it.
    const acrossGrain = 1 / m.balsaGrainScale; // m, the grain's base cell
    const acrossStain = 1 / m.balsaBlotchScale;
    const alongStain = m.balsaGrainStretch / m.balsaBlotchScale;
    expect(acrossGrain, 'the grain is not the fine term any more').toBeLessThan(0.2);
    // a stain is a fraction of the girth across and metres along
    const girth = Math.PI * raftParams.logDiameterMax;
    expect(acrossStain).toBeGreaterThan(girth * 0.2);
    expect(acrossStain).toBeLessThan(girth * 0.6);
    expect(alongStain).toBeGreaterThan(1.5);
    // …and a 13.7 m log carries several of them, so it is not one flat piece
    expect(raftParams.logCentreLength / alongStain).toBeGreaterThanOrEqual(3);
    // it is a STAIN, not a speckle: much coarser than the grain it sits over
    expect(acrossStain / acrossGrain).toBeGreaterThan(4);
  });

  it('the relief presents believable faces — §T134 arithmetic on a third family', () => {
    // `reliefNormal` is exact (Mikkelsen on the true screen gradient) and every
    // depth here is in METRES, so `balsaBump` is pure exaggeration. At the
    // shipped 8 the numbers below came out 87.1° (an end check), 78.5° (a rope
    // groove) and 48.7° (the grain): the log ends rendered as black caps with
    // white radial lines, which is the "plastic" half nobody had measured.
    const grooveFace = (depth: number, width: number, bump: number): number =>
      THREE.MathUtils.radToDeg(Math.atan((1.5 * depth * bump) / width));
    const check = grooveFace(m.balsaCheckDepth, m.balsaCheckWidth, m.balsaBump);
    const groove = grooveFace(m.grooveDepth, m.grooveWidth, m.balsaBump);
    // the grain's own face: its finest octave's cell, across the member
    const grainCell = 1 / (m.balsaGrainScale * 2 ** 2);
    const grain = THREE.MathUtils.radToDeg(Math.atan((m.balsaGrainRelief * m.balsaBump) / grainCell));

    expect(check, 'an end check is a moulded slot, not a crack').toBeLessThan(72);
    expect(check, 'the checks have gone flat — painted lines again').toBeGreaterThan(40);
    expect(groove, 'the lashing groove reads as a moulded rib').toBeLessThan(40);
    expect(groove, 'the rope has stopped biting into the log').toBeGreaterThan(12);
    expect(grain, 'the grain is embossed, not grain').toBeLessThan(20);
    expect(grain, 'the grain has no relief at all').toBeGreaterThan(4);
    // the defect, recorded so it cannot be quietly reverted
    expect(grooveFace(0.02, m.balsaCheckWidth, 8)).toBeGreaterThan(85);
  });

  it('the weed band sits AT the waterline and only there [§7 Balsa]', () => {
    expect(balsaWeedBand(0)).toBeCloseTo(1, 6);
    expect(balsaWeedBand(m.weedHalfBand * 1.01), 'weed above the band').toBe(0);
    expect(balsaWeedBand(-m.weedHalfBand * 1.01), 'weed below the band').toBe(0);
    // monotone away from the water, both ways — it is a band, not a stripe pair
    for (let i = 1; i <= 12; i++) {
      const y = (i / 12) * m.weedHalfBand;
      expect(balsaWeedBand(y)).toBeLessThanOrEqual(balsaWeedBand(y - m.weedHalfBand / 12) + 1e-9);
      expect(balsaWeedBand(y)).toBeCloseTo(balsaWeedBand(-y), 9);
    }
    // and the band is a band, not the whole log: a 0.55 m log is half out
    expect(m.weedHalfBand).toBeLessThan(raftParams.logDiameterMin / 2);
  });

  it('the wet band STRADDLES the waterline instead of hiding under it', () => {
    // §T147 — `logAxisY` = 0 IS the waterline (the logs float half submerged),
    // so the pre-fix `wet = max(−y/0.15, 0)` painted only the half nobody can
    // see: at y = 0 it was exactly zero and the visible flank kept its dry tone
    // right down to the sea. [ref kon-tiki-1947-sailing] shows the opposite.
    const oldWet = (y: number): number => Math.min(1, Math.max(0, -y / 0.15));
    expect(oldWet(0), 'the defect: nothing visible was ever wet').toBe(0);

    expect(balsaWetBand(0), 'the waterline itself is dry').toBeGreaterThan(0.5);
    expect(balsaWetBand(-raftParams.logDiameterMin / 2)).toBeCloseTo(1, 6);
    expect(balsaWetBand(m.wetRise * 1.01), 'the whole log is wet').toBe(0);
    // …and it does not swallow the log: the crown stays dry
    expect(m.wetRise).toBeLessThan(raftParams.logDiameterMin / 4);
  });

  it('end-grain checks appear within `balsaEndZone` of an end and nowhere else', () => {
    expect(balsaEndness(0)).toBeCloseTo(1, 6);
    expect(balsaEndness(m.balsaEndZone * 1.01), 'checks in the middle of a log').toBe(0);
    for (let i = 1; i <= 10; i++) {
      const d = (i / 10) * m.balsaEndZone;
      expect(balsaEndness(d)).toBeLessThanOrEqual(balsaEndness(d - m.balsaEndZone / 10) + 1e-9);
    }
    // §V66 — the zone is a fraction of the SHORTEST member it is drawn on, or
    // the "ends" meet in the middle and the whole log is end grain
    expect(raftParams.logOuterLength / (2 * m.balsaEndZone)).toBeGreaterThan(8);
    expect(raftParams.crossbeamLength / (2 * m.balsaEndZone)).toBeGreaterThan(4);
  });

  it('lashing grooves land at the crossbeam stations and nowhere between them', () => {
    const raft = buildRaftBlueprint();
    const log = raft.find((d) => d.id === 'log-4')!; // the centre log, reached by every beam
    const beams = raft.filter((d) => d.id.startsWith('crossbeam-'));
    expect(beams.length).toBe(raftParams.crossbeamCount);
    const oz = log.transform.position[2];
    const ox = log.transform.position[0];
    for (const beam of beams) {
      const along = beam.transform.position[2] - oz;
      expect(balsaGrooveAt(along, oz, ox), `no groove under ${beam.id}`).toBeGreaterThan(0.9);
      // …and half a station away there is bare log
      expect(balsaGrooveAt(along + raftParams.crossbeamPitch / 2, oz, ox),
        `groove between stations, aft of ${beam.id}`).toBe(0);
    }
    // outside the run of beams the log is unlashed
    const first = beams[0].transform.position[2] - oz;
    expect(balsaGrooveAt(first - raftParams.crossbeamPitch, oz, ox)).toBe(0);
    // the 5.5 m beams DO span the whole 4.9 m log field, so every log is
    // lashed at every station — but a log outside their reach carries none,
    // which is the gate that keeps the grooves honest if the field widens
    const outer = raft.find((d) => d.id === 'log-0')!;
    expect(Math.abs(outer.transform.position[0])).toBeLessThan(raftParams.crossbeamLength / 2);
    expect(balsaGrooveAt(beams[4].transform.position[2] - outer.transform.position[2],
      outer.transform.position[2], outer.transform.position[0])).toBeGreaterThan(0.9);
    expect(balsaGrooveAt(0, oz, raftParams.crossbeamLength / 2 + 0.5),
      'a log the beams cannot reach is still being grooved').toBe(0);
  });

  it('the chink reads as a dark slot — but the sea-facing flank of an outer log does not', () => {
    // §T147 half (a). The gap is INSIDE the reference band (tests/raft.test.ts
    // measures it), so the defect is the READ: two 0.55 m logs 5 cm apart form
    // a slot that sees almost no sky, and ours had both walls lit by the full
    // hemisphere. The exemption matters as much as the term — the beam station
    // looks straight at the one face that genuinely IS open.
    const half = raftLayout().halfBeam;
    const inner = raftLayout().logs.find((l) => l.i === 1)!.x;
    expect(balsaCreviceAt(1, inner, half), 'an inboard flank sees the sky').toBeCloseTo(m.balsaCrevice, 6);
    expect(balsaCreviceAt(-1, inner, half)).toBeCloseTo(m.balsaCrevice, 6);
    // the outer log: inboard flank occluded, outboard flank open
    expect(balsaCreviceAt(-1, half, half), 'the outer log lost its chink').toBeCloseTo(m.balsaCrevice, 6);
    expect(balsaCreviceAt(1, half, half), 'the sea-facing flank is being shaded').toBeCloseTo(0, 6);
    expect(balsaCreviceAt(-1, -half, -half)).toBeCloseTo(0, 6);
    // the crown is open sky whichever log it is on — the sun still rakes it
    expect(balsaCreviceAt(0, inner, half)).toBe(0);
    expect(balsaCreviceAt(0.5, inner, half)).toBe(0);
  });

  it('the balsa albedo is a THREE-channel colour — the §B96 vec2 witness', () => {
    // §B96 zeroed the islands' BLUE by handing `periodResolved` a vec2: the
    // filter came back per-component, `mix(float, float, vec2)` widened every
    // downstream field, and `NodeBuilder.format` pads vec2 → `vec3(v, 0.0)`.
    // Nothing in a node-shape test can see that; the TYPE can. This file passes
    // only scalars, and this is what keeps that true.
    const renderer = new THREE.WebGPURenderer({ canvas: t147StubCanvas() });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardNodeMaterial());
    const backend = (renderer as unknown as { backend: Record<string, unknown> }).backend;
    backend.renderer = renderer;
    const builder = (
      backend as unknown as { createNodeBuilder: (o: THREE.Object3D, r: THREE.WebGPURenderer) => Record<string, unknown> }
    ).createNodeBuilder(mesh, renderer);
    builder.material = mesh.material;
    const typeOf = (n: unknown): string => (n as { getNodeType(b: unknown): string }).getNodeType(builder);
    // three names a 3-component colour `color`, not `vec3` — what matters is
    // the COMPONENT COUNT, because §B96's damage was a vec2 padded to
    // `vec3(v, 0.0)` and the missing component is the whole bug
    const LENGTH: Record<string, number> = { float: 1, color: 3, vec2: 2, vec3: 3, vec4: 4 };
    const width = (n: unknown): number => LENGTH[typeOf(n)] ?? -1;

    // the trap is still live in bandLimit, which is why nothing in this file
    // may hand it a vec2 (§B96 lists the call sites that still do)
    expect(typeOf(coordFilter(vec2(1, 2)))).toBe('vec2');

    for (const kind of ['log', 'crossbeam', 'stern-block'] as const) {
      const handle = createBalsaMaterial(kind);
      expect(width(handle.material.colorNode), `${kind} albedo lost a channel`).toBe(3);
      expect(width(handle.material.roughnessNode), `${kind} roughness widened`).toBe(1);
      expect(width(handle.material.aoNode), `${kind} ao widened`).toBe(1);
      handle.material.dispose();
    }
  });

  it('the balsa pattern is a constant of the PIECE, not of the raft attitude (§T134)', () => {
    // The thatch's bug was a live WORLD-down vector in a per-object uniform.
    // The balsa samples `positionLocal`/`normalLocal` and the bounds/origin/seed
    // uniforms, none of which the sea can touch — asserted both ways so a
    // future "just project it onto the sea" cannot land here quietly.
    expect(raftMaterialsBalsaSource, '§T134: the balsa must not read the down vector')
      .not.toContain('downRest');

    const stubFactory = (): THREE.Material => ({ dispose(): void {} }) as unknown as THREE.Material;
    const asm = new ShipAssembly(buildRaftBlueprint(), stubFactory);
    const u = createRaftPieceUniforms();
    const node = u as unknown as Record<string, { update(f: unknown): void; value: { clone(): unknown } }>;
    const read = (meshName: string, euler: THREE.Euler): string => {
      asm.group.quaternion.setFromEuler(euler);
      asm.group.updateMatrixWorld(true);
      const mesh = asm.group.getObjectByName(meshName)!;
      const out: string[] = [];
      for (const key of ['aabbMin', 'aabbMax', 'origin', 'seed']) {
        node[key].update({ object: mesh, frameId: Math.random() });
        out.push(JSON.stringify(node[key].value));
      }
      return out.join('|');
    };
    for (const meshName of ['log-0-mesh', 'log-4-mesh', 'crossbeam-2-mesh']) {
      const rest = read(meshName, new THREE.Euler(0, 0, 0));
      for (const [label, euler] of [
        ['15° heel', new THREE.Euler(0, 0, THREE.MathUtils.degToRad(15))],
        ['15° pitch', new THREE.Euler(THREE.MathUtils.degToRad(15), 0, 0)],
        ['heading 130°', new THREE.Euler(0, THREE.MathUtils.degToRad(130), 0)],
      ] as const) {
        expect(read(meshName, euler), `${meshName} moved at ${label}`).toBe(rest);
      }
    }
    asm.group.quaternion.identity();
    asm.group.updateMatrixWorld(true);
  });
});

/** the sierra suite's stub — a WebGPURenderer built only to hand out a node builder */
function t147StubCanvas(): HTMLCanvasElement {
  return {
    width: 4,
    height: 4,
    style: {},
    getContext: (): null => null,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    getRootNode: (): unknown => ({}),
    setAttribute: (): void => {},
  } as unknown as HTMLCanvasElement;
}
