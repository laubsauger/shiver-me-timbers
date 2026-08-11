/**
 * PROCEDURAL DECK HEIGHTFIELD — one field, two consumers.
 *
 * The Rare talk's "Surface Water: Setup" slide runs their deck-water sim on a
 * 512 × 192 grid over an ARTIST-SUPPLIED static heightfield: the deck outline,
 * raised borders at the bulwarks, hatches and gratings as distinct steps, and
 * — the detail that matters — per-plank micro-variation, every board a very
 * slightly different grey. We generate the same thing from the piece graph
 * instead of hand-painting it, which means a brigantine gets its own for free
 * and it can never drift out of sync with the fittings (§V18: an AI-generated
 * deck supplies its own pieces and this still produces the right field).
 *
 * CONSUMER 1 — plank appearance (§T.34, user: "everything is too perfectly
 * aligned", "planks shouldn't just look like flat surfaces with painted-on
 * wood lines"). The `plank` channel gives every board its own height to a few
 * millimetres, so the boards genuinely sit proud and shy of each other. It
 * composes with the Mikkelsen surface-gradient relief already in
 * woodMaterial.ts, which owns the HIGH-frequency detail (grain, caulk groove);
 * this field owns the low-frequency structure. Splitting it that way is also
 * what keeps the texture useful at ~4 cm/texel — a caulk line is thinner than
 * a texel and belongs in the shader.
 *
 * CONSUMER 2 — the deck-water solver (§V9/§T.12). Water flows downhill and
 * pools in the low spots; a flat deck gives a flat, characterless sheet.
 * `height` is the terrain the Mei outflow reads, `mask` is its domain, and
 * `solid` marks what it must not flow into (bulwarks, coamings, mast partners,
 * the capstan drum).
 *
 * §V2: every random-looking number comes from variation.ts's seeded hash, so
 * the same blueprint yields a bit-identical field on every client.
 * §V28: the field is built from sanitised construction-time ints; any caller
 * bounds are clamped before they index anything.
 */
import type { PieceDef } from './pieceTypes';
import { hullHalfWidthAt, type HullShape } from './hullMath';
import { shipMaterialParams } from '../params/ship';
import { vhash, vjitter } from './variation';

/** talk-parity default: 512 along the length, 192 across the beam */
export const DECK_FIELD_LENGTH = 512;
export const DECK_FIELD_BEAM = 192;

export interface DeckHeightfield {
  /** texels across the beam (ship x) and along the length (ship z) */
  width: number;
  height: number;
  /** ship-space rectangle the field covers */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** metres per texel */
  texelX: number;
  texelZ: number;
  /** ship-space y of the reference deck plane (height 0 lives here) */
  deckY: number;
  /**
   * Terrain height in METRES relative to `deckY`, row-major, `width` per row,
   * rows running from `minZ` to `maxZ`. This is `structure + plank`.
   */
  data: Float32Array;
  /** the per-board component of `data` alone — what the wood material wants */
  plank: Float32Array;
  /** 0..1 coverage of the water domain (0 = outboard of the ship) */
  mask: Float32Array;
  /** 1 = obstacle the water must not enter (bulwark, coaming, partner, drum) */
  solid: Float32Array;
}

/** deck-shape constants, all in metres — the "artist" half of the field */
const CAMBER = 0.085; // crown at the centreline; decks shed water outboard
const WATERWAY_WIDTH = 0.55; // gutter inboard of the bulwark
const WATERWAY_DEPTH = 0.028;
const BULWARK_INSET = 0.14; // thickness of the bulwark ring inside the outline
const BULWARK_HEIGHT = 0.95;
/**
 * Coaming dimensions are EXPORTED and the grating geometry is built from
 * them: the raised lip a player sees round a hatch and the raised lip the
 * water refuses to flow over have to be the same lip, or the puddle stops
 * where nothing is.
 */
export const COAMING_HEIGHT = 0.18;
export const COAMING_WIDTH = 0.16;
export const GRATING_HEIGHT = 0.09;
const PARTNER_HEIGHT = 0.055;
const WEAR_DEPTH = 0.014; // hollow worn where hands and feet go
const WEAR_RADIUS = 1.25;
const PLANK_VARIATION = 0.0045; // per-board proud/shy
const PLANK_CUP = 0.0022; // old boards cup: the middle of each dishes down
const BUTT_DIP = 0.0035;
const HOG_AMPLITUDE = 0.009; // long-wave settling of the whole deck

interface Disc {
  x: number;
  z: number;
  r: number;
}

interface Rect {
  x: number;
  z: number;
  hx: number;
  hz: number;
}

/** smooth 0→1 ramp, C1 at both ends (the field is differentiated downstream) */
function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / Math.max(1e-6, e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** 1 inside a rectangle, falling off over `fade` metres outside it */
function rectMask(rx: Rect, x: number, z: number, fade: number): number {
  const dx = Math.abs(x - rx.x) - rx.hx;
  const dz = Math.abs(z - rx.z) - rx.hz;
  const d = Math.max(dx, dz);
  return 1 - smoothstep(0, Math.max(1e-4, fade), d);
}

/** 1 at the centre of a disc, 0 at its rim */
function discMask(d: Disc, x: number, z: number): number {
  const r = Math.hypot(x - d.x, z - d.z);
  return 1 - smoothstep(d.r * 0.55, d.r, r);
}

/** value noise on a 1 m lattice, seeded — the deck's long-wave settling */
function hogNoise(x: number, z: number, scale: number): number {
  const fx = x / scale;
  const fz = z / scale;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const tx = smoothstep(0, 1, fx - ix);
  const tz = smoothstep(0, 1, fz - iz);
  const c00 = vhash(ix, iz);
  const c10 = vhash(ix + 1, iz);
  const c01 = vhash(ix, iz + 1);
  const c11 = vhash(ix + 1, iz + 1);
  const a = c00 + (c10 - c00) * tx;
  const b = c01 + (c11 - c01) * tx;
  return (a + (b - a) * tz) * 2 - 1;
}

/** everything the generator needs, harvested from the piece graph */
interface DeckLayout {
  shape: HullShape;
  deckY: number;
  /** raised decks: footprint plus how far they step up */
  steps: Array<{ z0: number; z1: number; rise: number }>;
  /** ramps (companionway ladders): climb from 0 to `rise` along +z within */
  ramps: Array<Rect & { rise: number; flip: boolean }>;
  hatches: Rect[];
  partners: Disc[];
  pads: Disc[];
  wear: Disc[];
}

/** pull the layout out of the blueprint — no ship params needed (§V18) */
function readLayout(blueprint: PieceDef[]): DeckLayout | null {
  const deck = blueprint.find((p) => p.kind === 'deck');
  if (deck === undefined || deck.shape === undefined) return null;
  const shape = deck.shape as unknown as HullShape;
  const deckY = deck.transform.position[1];
  const layout: DeckLayout = {
    shape,
    deckY,
    steps: [],
    ramps: [],
    hatches: [],
    partners: [],
    pads: [],
    wear: [],
  };
  const byId = new Map(blueprint.map((p) => [p.id, p]));
  /** ship-space position of a piece, resolving one level of parenting */
  const shipPos = (p: PieceDef): [number, number, number] => {
    const parent = p.parent === undefined ? undefined : byId.get(p.parent);
    const base = parent === undefined ? [0, 0, 0] : parent.transform.position;
    return [
      base[0] + p.transform.position[0],
      base[1] + p.transform.position[1],
      base[2] + p.transform.position[2],
    ];
  };

  for (const piece of blueprint) {
    const [px, py, pz] = shipPos(piece);
    const hx = (piece.aabb.max[0] - piece.aabb.min[0]) / 2;
    const hz = (piece.aabb.max[2] - piece.aabb.min[2]) / 2;
    switch (piece.kind) {
      case 'forecastle-deck':
      case 'sterncastle-deck': {
        const s = piece.shape as unknown as HullShape | undefined;
        if (s === undefined) break;
        layout.steps.push({ z0: s.z0, z1: s.z1, rise: py - deckY });
        break;
      }
      case 'stairs':
        layout.ramps.push({
          x: px,
          z: pz,
          hx,
          hz,
          rise: piece.aabb.max[1] - piece.aabb.min[1],
          // a stairs piece climbs its own +z; the aft pair is turned 180°
          flip: Math.abs(piece.transform.rotation[1]) > Math.PI / 2,
        });
        // the head and foot of a ladder are the most walked-on planks aboard
        layout.wear.push({ x: px, z: pz - hz, r: WEAR_RADIUS });
        break;
      case 'grating':
        layout.hatches.push({ x: px, z: pz, hx, hz });
        break;
      case 'mast':
        // only masts STEPPED on this deck get partners here; the mizzen
        // stands on the quarterdeck and its collar belongs up there
        if (Math.abs(py - deckY) < 0.05) {
          layout.partners.push({ x: px, z: pz, r: Math.max(0.3, hx) * 2.6 });
          layout.wear.push({ x: px, z: pz, r: WEAR_RADIUS * 1.4 });
        }
        break;
      case 'capstan':
        layout.pads.push({ x: px, z: pz, r: Math.max(0.4, hx) * 1.15 });
        layout.wear.push({ x: px, z: pz, r: WEAR_RADIUS * 1.6 });
        break;
      case 'wheel':
        layout.wear.push({ x: px, z: pz, r: WEAR_RADIUS });
        break;
      default:
        break;
    }
  }
  return layout;
}

/** structural (non-plank) height and the two masks at one ship-space point */
function structureAt(
  L: DeckLayout,
  x: number,
  z: number,
): { height: number; mask: number; solid: number } {
  // Deck LEVEL first: raised decks are steps, and the companionway ladders
  // are ramps up onto them. Combined with max(), NOT sum — a ladder's top
  // tread overlaps the deck it lands on, and adding the two produced a 4.4 m
  // spike in the middle of the quarterdeck, which the solver would have read
  // as a wall and the shading as a cliff.
  let lift = 0;
  for (const step of L.steps) {
    const inZ = Math.min(
      smoothstep(step.z0 - 0.08, step.z0 + 0.08, z),
      1 - smoothstep(step.z1 - 0.08, step.z1 + 0.08, z),
    );
    lift = Math.max(lift, inZ * step.rise);
  }
  for (const ramp of L.ramps) {
    const inside = rectMask(ramp, x, z, 0.12);
    const t = Math.min(1, Math.max(0, (z - (ramp.z - ramp.hz)) / Math.max(0.1, ramp.hz * 2)));
    lift = Math.max(lift, inside * ramp.rise * (ramp.flip ? 1 - t : t));
  }

  // the outline is taken at the LOCAL deck height, so a raised deck narrows
  // the way the hull actually narrows above the sheer
  const half = Math.max(0.05, hullHalfWidthAt(z, L.shape.freeboard + lift, L.shape) * 0.99);
  const inset = Math.max(0.2, half - BULWARK_INSET);
  const ax = Math.abs(x);
  // outboard of the planking there is no deck at all
  const mask = 1 - smoothstep(inset - 0.02, half, ax);
  if (ax > half + 0.05) return { height: lift + BULWARK_HEIGHT, mask: 0, solid: 1 };

  // crown, so the deck sheds outboard, plus the long settle of old timber
  let h = lift - CAMBER * (ax / half) * (ax / half);
  h += hogNoise(x, z, 5.5) * HOG_AMPLITUDE;

  // waterway: the gutter that runs the water aft along the bulwark foot
  const gutter = 1 - smoothstep(0, WATERWAY_WIDTH, Math.abs(ax - (inset - WATERWAY_WIDTH * 0.5)));
  h -= gutter * WATERWAY_DEPTH;

  let solid = smoothstep(inset - 0.06, inset + 0.04, ax); // the bulwark ring
  h += solid * BULWARK_HEIGHT;
  // hatch coamings: a raised lip holding water OUT, grating proud inside it
  for (const hatch of L.hatches) {
    const lip = rectMask(
      { x: hatch.x, z: hatch.z, hx: hatch.hx + COAMING_WIDTH, hz: hatch.hz + COAMING_WIDTH },
      x,
      z,
      0.06,
    );
    const inner = rectMask(hatch, x, z, 0.06);
    h += lip * COAMING_HEIGHT - inner * (COAMING_HEIGHT - GRATING_HEIGHT);
    solid = Math.max(solid, lip);
  }
  for (const partner of L.partners) {
    const m = discMask(partner, x, z);
    h += m * PARTNER_HEIGHT;
    solid = Math.max(solid, discMask({ ...partner, r: partner.r * 0.42 }, x, z));
  }
  for (const pad of L.pads) {
    const m = discMask(pad, x, z);
    h += m * PARTNER_HEIGHT * 1.3;
    solid = Math.max(solid, discMask({ ...pad, r: pad.r * 0.75 }, x, z));
  }
  // and the hollows worn by two centuries of boots and hauling
  for (const w of L.wear) {
    h -= discMask(w, x, z) * WEAR_DEPTH;
  }
  return { height: h, mask, solid: Math.min(1, solid) };
}

/**
 * Per-board micro-height. Deck planks run FORE-AND-AFT, so a board is indexed
 * by x and butts along z — the same convention woodMaterial.ts uses for its
 * seams, which is what keeps the shading and the water agreeing about where
 * one board ends and the next begins.
 *
 * Every term is crowned to zero at the plank seams (× sin πf). A per-board
 * CONSTANT would be a step in the field, and both consumers differentiate it:
 * the relief normal in screen space (§V38) and the water solver as a slope.
 */
function plankAt(x: number, z: number): number {
  const p = shipMaterialParams;
  const width = Math.max(0.05, p.plankWidth);
  const coord = x / width;
  const index = Math.floor(coord);
  const f = coord - index;
  const crown = Math.sin(Math.PI * f);

  const proud = vjitter(PLANK_VARIATION, index, 17.3) * crown;
  const cup = -PLANK_CUP * crown; // the middle of a weathered board dishes
  // butts: each course carries its own phase and its own board length, so no
  // two courses end at the same station (staggered, as a shipwright lays them)
  const boardLength = Math.max(0.5, p.plankLength * (0.7 + 0.65 * vhash(index, 41.9)));
  const phase = vhash(index, 5.1);
  const bt = z / boardLength + phase;
  const bf = bt - Math.floor(bt);
  const buttDistance = Math.min(bf, 1 - bf) * boardLength;
  const butt = -BUTT_DIP * (1 - smoothstep(0, Math.max(0.02, p.buttWidth * 2), buttDistance));

  return proud + cup + butt * crown;
}

/**
 * Build the field from a piece graph. Pure and deterministic; costs a few ms
 * for the default 512 × 192, which is a build-time cost paid once per ship.
 * Returns null if the blueprint has no deck carrying hull shape hints.
 */
export function buildDeckHeightfield(
  blueprint: PieceDef[],
  opts: { width?: number; height?: number } = {},
): DeckHeightfield | null {
  const L = readLayout(blueprint);
  if (L === null) return null;
  // §V28: dimensions are sanitised construction-time ints
  const width = Math.max(8, Math.min(2048, Math.round(opts.width ?? DECK_FIELD_BEAM)));
  const height = Math.max(8, Math.min(4096, Math.round(opts.height ?? DECK_FIELD_LENGTH)));
  const halfBeam = L.shape.beamHalf * 1.02;
  const minX = -halfBeam;
  const maxX = halfBeam;
  const minZ = L.shape.z0;
  const maxZ = L.shape.z1;
  const texelX = (maxX - minX) / width;
  const texelZ = (maxZ - minZ) / height;

  const data = new Float32Array(width * height);
  const plank = new Float32Array(width * height);
  const mask = new Float32Array(width * height);
  const solid = new Float32Array(width * height);
  for (let j = 0; j < height; j++) {
    const z = minZ + (j + 0.5) * texelZ;
    for (let i = 0; i < width; i++) {
      const x = minX + (i + 0.5) * texelX;
      const k = j * width + i;
      const s = structureAt(L, x, z);
      const board = plankAt(x, z) * s.mask * (1 - s.solid);
      data[k] = s.height + board;
      plank[k] = board;
      mask[k] = s.mask;
      solid[k] = s.solid;
    }
  }
  return {
    width, height, minX, maxX, minZ, maxZ, texelX, texelZ,
    deckY: L.deckY,
    data, plank, mask, solid,
  };
}

/** bilinear sample of any channel in ship space; clamps at the border */
export function sampleDeckField(
  field: DeckHeightfield,
  channel: Float32Array,
  x: number,
  z: number,
): number {
  const fx = (x - field.minX) / field.texelX - 0.5;
  const fz = (z - field.minZ) / field.texelZ - 0.5;
  const x0 = Math.min(field.width - 1, Math.max(0, Math.floor(fx)));
  const z0 = Math.min(field.height - 1, Math.max(0, Math.floor(fz)));
  const x1 = Math.min(field.width - 1, x0 + 1);
  const z1 = Math.min(field.height - 1, z0 + 1);
  const tx = Math.min(1, Math.max(0, fx - x0));
  const tz = Math.min(1, Math.max(0, fz - z0));
  const a = channel[z0 * field.width + x0];
  const b = channel[z0 * field.width + x1];
  const c = channel[z1 * field.width + x0];
  const d = channel[z1 * field.width + x1];
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz;
}

/** terrain height (m, relative to `deckY`) at a ship-space point */
export function sampleDeckHeight(field: DeckHeightfield, x: number, z: number): number {
  return sampleDeckField(field, field.data, x, z);
}
