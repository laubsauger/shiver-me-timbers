/**
 * THE FILM'S RADIO TOWERS — one on every island, the network's beacons (src/radio/network.ts), built by the shared
 * mast builder (src/radio/mast.ts). This file is what is the film's own: where each station stands in its two worlds,
 * the air it is seen through, and the lamp as the audience's eye sees it.
 *
 * HOW IT CAME ABOUT. The first sunken-world cue (drift-narrative/wandering-on/sunken-world-cues.md, cue 4): the user,
 * 2026-10-29, "the massive radio tower that we built for the speedboat thing … with its wires … on the hill that is
 * visible on the island in the far distance", so the audience reads "this is California after being submerged by
 * hundreds of feet of water", "not a tropical paradise as it always has been" — a guyed mast on a summit is a
 * mountaintop transmitter (Mount Wilson, Sutro). Then, seeing it: "almost not perceptible … let's have it there, this
 * one is cool … but we can't assume that these ten and a half pixels … are going to carry it home … these radio towers
 * should be on each and every island. These should be the beacons that the radio in the game is connecting to and also
 * that the Rose was illustrating on the sky … maybe … a glimpse" of the one on the island we land on.
 *
 * WHERE THEY STAND (§V71: each world resolves its own positions; the network says only what stands there):
 *
 *   the coast (w1–w6, coast.ts)   treetops   the high island's summit, 7.6 km: the first tower (250 m since
 *                                            2026-10-30), and beside it on the ridge a second, smaller mast
 *                                            (HIGH_SECOND_MAST): a transmitter site, Mount Wilson style
 *                                 wiggle     motu 2's spine, 2.6 km, 20–35° left of the look: the main cue, a
 *                                            broadcast mast with its stack (~75 px of a 4K master at 150 m)
 *                                 relay-a    motu 1's spine, 1.45 km, 70–100° left, by the dome's edge (~107 px)
 *                                 lagoon     OUR island, inland behind the forest (along +250 m, 120 m in): from the
 *                                            raft on the approach its top clears the trees (120–150 px), from the beach
 *                                            the forest hides it, and as the eye rises into w6's night it stands over
 *                                            the trees, blinking — the glimpse, for nothing
 *                                 (no tower on motu 3: our own forest hides it from every eye on the beach)
 *   the open sea (c2–c4, props.ts) all seven, one on each of the Rose's islands on the horizon (FILM_RING), and the
 *                                 Rose's beams run from lamp to lamp; in w6 the four coast stations answer from their
 *                                 coast towers and the other three from the ring
 *
 * (Measured 2026-10-29 on the coast's terrain along coastEye's path, canopy taken as 18 m.)
 *
 * THE HIGH ISLAND'S, as measured then: its summit (`summitOf`) (−45208, −5555), 467 m over the sea, 7610–7670 m from
 * the eye, 3.45–3.48° up and the summit the skyline from every eye; the guys 84 % visible, 83 % of that against the
 * sky. The kit's slim proportions made a line 4 levels off the sky at the 4K pixel; the heavy broadcast mast with its
 * antenna stack (network.ts 'treetops') is the head on the pin that made it findable.
 *
 * THE AIR: the high island's and the Rose's islands' own (farAir.ts: the light 7 km of marine air scatters in front of
 * them, in their own bearing, as their ground has it); the motus and our island the terrain's aerial curve (the same
 * node their ground and forest melt on, §B67).
 *
 * THE LAMP AS THE EYE SEES IT (the 2026-10-29 lamp round): drawn with its light kept, a 2000 cd flasher at 7.6 km added
 * +1 level of red to the dusk sky at 700.8 s; with all of its light in one 4K pixel it would still add +4 — while a
 * real L-864 at that range at dusk is plainly a red point. The fovea resolves ~½–1 arcmin, a cell EYE_CELL in radius: a
 * point's light lands in that, and against the afterglow's ~2000 cd/m² it reads at ~300 cd/m², red. A 4K pixel is ~10×
 * that cell's area, an 8K one ~2.5×: kept to its energy, the point is diluted by the pixel, which is the camera's
 * truth, not the audience's. So the core is drawn at the eye's radiance, never under CORE_PX target pixels in radius
 * (rendered: +31 levels of red at fov 40, +19 at the 4K pixel). A faint GLOW carries a share of the light the air
 * scatters. And a NIGHT step: the eye-true core under the night's exposure (14×) goes salmon in AgX (modelled
 * (253, 97, 67)); stepped to 0.3 it is (174, 32, 9), red.
 *
 * Every frame a pure function of t: a lamp's blink is its world's clock (`setTime`), nothing else moves.
 */
import * as THREE from 'three/webgpu';
import { cameraPosition, exp, float, log2, mix, output, positionWorld, smoothstep, uniform, vec3, vec4 } from 'three/tsl';
import { aerialHazeFactor, aerialOutputNode, type AerialUniforms } from '../../terrain/aerialPerspective';
import { SUN_E } from '../getTheDrift/atmosphere';
import { buildMast, lampOverFoot, loadMastKit, MAST, MAST_KIT_URL, type MastAir, type MastLampOptions, type MastSite } from '../../radio/mast';
import type { MastSpec } from '../../radio/network';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type Haze = AerialUniforms['color'];

/** where the coast's stations stand (coast.ts resolves each island) */
export const FILM_COAST: Readonly<Record<string, 'high' | 'motu1' | 'motu2' | 'ours'>> = {
  treetops: 'high',
  wiggle: 'motu2',
  'relay-a': 'motu1',
  lagoon: 'ours',
};
/** the Rose's islands on the open sea's horizon, in props.ts's STATIONS order (bearings −150, −95, −40, 10, 55, 105,
 * 160): the coast's stations hold the slots nearest their coast bearings in w6 (treetops −40 ≈ the high island's
 * −43, relay-a −95 ≈ motu 1's −78), so the Rose's figure barely moves when they answer from the coast instead */
export const FILM_RING: readonly string[] = ['relay-b', 'relay-a', 'treetops', 'wiggle', 'lagoon', 'relay-c', 'relay-d'];
/** beach coordinates (beats.ts COAST: along up the beach toward −z, off out to sea toward −x) of our island's mast */
export const OURS_MAST = { along: 250, off: -120 };

/**
 * A SECOND MAST ON THE HIGH ISLAND'S SUMMIT RIDGE (the user, 2026-10-30, on the high island's tower: "maybe ever so
 * slightly [bigger] … maybe a second mast, not sure"): a relay of its own beside the broadcast mast, so the hill reads
 * as a transmitter site — Mount Wilson's is a ridge of them. A film-only extra on the treetops site, not a station of
 * the network (the Rose is seven), with its own lamp on its own rhythm (lit with the others at 744.1 s in w6). Placed by
 * `ridgeSite`: across the beach's line of sight, so it stands apart from the first on the skyline. The user decides
 * from the review whether it stays: this switch.
 */
export const HIGH_SECOND_MAST = true;
export const HIGH_SECOND: MastSpec = { kind: 'relay', tipM: 120, faceM: 4, lamp: { alive: true, flashesPerMin: 27, phase: 0.68 } };

/**
 * Where a second mast stands beside one at `summit`: the highest ground `min`–`max` m to either side of the line from
 * `from` (the eye's beach) to the summit, within ±60 m along it — so it is on the ridge, and from the beach it stands
 * beside the first (150 m apart across the line is 1.1° at 7.6 km, ~26 px of a 4K master), not behind it. Pure.
 */
export function ridgeSite(ground: (x: number, z: number) => number, summit: [number, number], from: [number, number], min = 150, max = 300): [number, number] {
  const dx = summit[0] - from[0];
  const dz = summit[1] - from[1];
  const l = Math.hypot(dx, dz);
  const [ux, uz] = [dx / l, dz / l];
  let best: [number, number, number] = [summit[0], summit[1], -Infinity];
  for (const side of [-1, 1]) {
    for (let d = min; d <= max; d += 10) {
      for (let a = -60; a <= 60; a += 20) {
        const x = summit[0] - uz * side * d + ux * a;
        const z = summit[1] + ux * side * d + uz * a;
        const y = ground(x, z);
        if (y > best[2]) best = [x, z, y];
      }
    }
  }
  return [best[0], best[1]];
}

/** lux in one unit of the film's irradiance: SUN_E (7) is the Sun's at the top of the air, ~128 000 lux */
export const LUX_PER_UNIT = 128000 / SUN_E;
/** rad: the eye's resolution cell (see the header); target px the core is drawn at least; the glow */
const EYE_CELL = 0.12e-3;
const CORE_PX = 1.6;
const GLOW = { share: 0.5, radius: 1.5e-3 };
/** the night step: the output it steps down to, between these log10 horizon luminances (scene units) — log10 −1.2 at
 * w5's dusk, −7.3 in w6's night, so each beat of their dissolve draws its own */
const NIGHT = { step: 0.3, horizon: [-5, -3] as [number, number] };

/** the lamp's output 1 … NIGHT.step as the horizon's luminance (scene units) falls (CPU mirror of `filmLamp`'s) */
export function nightStep(horizon: number): number {
  const x = Math.log10(Math.max(horizon, 1e-12));
  const k = Math.min(1, Math.max(0, (x - NIGHT.horizon[0]) / (NIGHT.horizon[1] - NIGHT.horizon[0])));
  return NIGHT.step + (1 - NIGHT.step) * k * k * (3 - 2 * k);
}

/** the film's lamp: the eye's cell, its floor, the glow, the night step keyed on `haze` (the air's colour) */
export function filmLamp(haze: Haze): MastLampOptions {
  const lum = vec3(haze as unknown as V3).dot(vec3(0.2126, 0.7152, 0.0722)).max(1e-12);
  const dark = log2(lum).mul(Math.LOG10E / Math.LOG2E);
  return { eyeCell: EYE_CELL, corePx: CORE_PX, glow: GLOW, step: mix(float(NIGHT.step), float(1), smoothstep(NIGHT.horizon[0], NIGHT.horizon[1], dark)) as F, out: 10 };
}

/** an exponential haze over `air` m of horizontal distance into `haze` (the high island's, before farAir.ts: drowned.ts's
 * power lines still melt on it) */
export function expAir(haze: Haze, air: number): MastAir {
  return {
    output(m) {
      const k = float(1).sub(exp(positionWorld.xz.sub(cameraPosition.xz).length().div(-air))) as F;
      m.outputNode = vec4(mix(output.rgb, vec3(haze as unknown as V3), k), output.a);
    },
    transmittance: (at) => exp(at.xz.sub(cameraPosition.xz).length().div(-air)) as F,
  };
}

/** the terrain's aerial curve (§B67: the island and everything on it melt on one node) */
export function terrainAir(aerial: AerialUniforms): MastAir {
  return {
    output(m) {
      m.outputNode = aerialOutputNode(aerial);
    },
    // (evaluated at the lamp's own fragments: they lie within metres of it)
    transmittance: () => float(1).sub(aerialHazeFactor(aerial)) as F,
  };
}

/** the highest ground within `half` m of `centre` (x, z): a 20 m grid, then 2 m round its best */
export function summitOf(heightAt: (x: number, z: number) => number, centre: [number, number], half: number): { x: number; z: number; y: number } {
  let best = { x: centre[0], z: centre[1], y: -Infinity };
  const scan = (x0: number, z0: number, reach: number, step: number): void => {
    for (let z = z0 - reach; z <= z0 + reach; z += step) {
      for (let x = x0 - reach; x <= x0 + reach; x += step) {
        const y = heightAt(x, z);
        if (y > best.y) best = { x, z, y };
      }
    }
  };
  scan(centre[0], centre[1], half, 20);
  scan(best.x, best.z, 20, 2);
  return best;
}

export interface RadioTower {
  /** its meshes, added once the kit is in */
  readonly group: THREE.Group;
  readonly ready: Promise<void>;
  /** the lamp, in `site`'s frame — known before the kit loads (the Rose's beams run to it) */
  readonly lamp: [number, number, number];
  /** s: the lamp's clock */
  setTime(t: number): void;
}

/**
 * The tower `spec` on `site` (in the frame of the group it is added to), seen through `air`, its lamp's night step
 * keyed on `haze`. `lod` 0 for one seen at a few hundred metres.
 */
export function createRadioTower(site: MastSite, spec: MastSpec, o: { air: MastAir; haze: Haze; lod?: 0 | 1 }): RadioTower {
  const group = new THREE.Group();
  group.name = 'drift-radio-tower';
  const time = uniform(0);
  const lamp: [number, number, number] = [site.at[0], site.ground(site.at[0], site.at[1]) - MAST.sink + lampOverFoot(spec), site.at[1]];
  const ready = loadMastKit(MAST_KIT_URL).then((root) => {
    group.add(buildMast(root, site, spec, { time, air: o.air, luxPerUnit: LUX_PER_UNIT, lod: o.lod, lamp: filmLamp(o.haze) }).group);
  });
  return {
    group,
    ready,
    lamp,
    setTime(t) {
      time.value = t;
    },
  };
}
