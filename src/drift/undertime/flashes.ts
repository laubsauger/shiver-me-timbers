/**
 * Undertime light: where pairs are born and where their tracks end in annihilation.
 *
 * Seven eye-facing quads per pair slot (billboard.ts), chosen by instanceIndex % 7:
 *   0     spark at the vertex the moment the pair is made
 *   1, 2  annihilation CORE at the end of the matter / antimatter track — small, very hot, gone fast
 *   3, 4  light SHELL — a thin ring expanding from that point (the gamma rays leaving)
 *   5, 6  HAZE — a large faint glow that lingers where the light was released
 *
 * The haze is what fills the dome with light in the boil and the final wave: structured, where the
 * annihilations happen, instead of a uniform fill that greys the blacks. Its gain is the timeline's `glow`.
 * Shells are rare (one annihilation in seven) and soft: many thin rings read as soap bubbles, not light.
 * An annihilation the wave front forces burns hotter and leaves more haze, for a shorter time — the front
 * is a travelling wall of light with darkness behind it.
 */
import * as THREE from 'three/webgpu';
import { Fn, clamp, float, hash, instanceIndex, length, mix, select, smoothstep, step, uv, vec3, vec4 } from 'three/tsl';
import { trackPosition, type PairSlot } from './pairModel';
import { billboardMesh, eyeFacing } from './billboard';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface FlashUniforms {
  flashGain: F;
  haze: F;
  coreSize: F;
  coreRadiance: F;
  shellSpeed: F;
  shellRadiance: F;
  hazeSize: F;
  hazeRadiance: F;
  light: V3;
  matter: V3;
  anti: V3;
  /** s the birth spark swells in before its pair leaves (the hero's point of light; ~0 for the field) */
  sparkLead: F;
}

export function createFlashes(slots: number, U: FlashUniforms, slotOf: (slot: F) => PairSlot, name = 'undertime-flashes'): THREE.InstancedMesh {
  const kind = float(instanceIndex.mod(7));
  const slot = float(instanceIndex.div(7));
  const P = slotOf(slot);
  // which end: kinds 1,3,5 are the matter track's end, 2,4,6 the antimatter track's
  const anti = step(0.5, kind.mod(2).oneMinus()).mul(step(0.5, kind)); // even and non-zero
  const q = float(1).sub(anti.mul(2));
  const tEnd = mix(P.tEnd, P.tEndAnti, anti);
  const end = trackPosition(P, q, tEnd);
  const isSpark = step(kind, 0.5);
  const isCore = step(0.5, kind).mul(step(kind, 2.5));
  const isShell = step(2.5, kind).mul(step(kind, 4.5));
  const isHaze = step(4.5, kind);
  const pos = mix(end, P.vertex, isSpark);

  const dt = P.tau.sub(tEnd); // time since this track ended
  // until the slot is reborn — or, on the wave front, briefly: darkness follows the front
  const left = mix(P.period.sub(tEnd), P.period.sub(tEnd).min(1), P.forced);
  const after = step(0, dt);
  const sparkA = smoothstep(U.sparkLead.negate(), 0, P.tau).pow(2).mul(float(1).sub(smoothstep(0, U.sparkLead.mul(0.6).max(0.18), P.tau)));
  const coreA = clamp(float(1).sub(dt.div(0.35)), 0, 1).pow(3).mul(after);
  // a shell is the light front leaving: quick, and only from some of the annihilations so they stay legible
  const shellK = clamp(dt.div(left.min(0.6)), 0, 1);
  const shellA = float(1).sub(shellK).pow(2).mul(after).mul(step(hash(P.seed.add(kind.mul(3.7))), 0.15));
  const hazeA = smoothstep(0, 0.12, dt).mul(float(1).sub(smoothstep(left.mul(0.4), left, dt))).mul(after);

  const size = isSpark.mul(U.coreSize.mul(1.1))
    .add(isCore.mul(U.coreSize.mul(dt.max(0).mul(3).add(1))))
    .add(isShell.mul(U.shellSpeed.mul(dt.max(0)).add(0.02)))
    .add(isHaze.mul(U.hazeSize.mul(smoothstep(0, left, dt).mul(0.6).add(0.4)).mul(mix(float(1), float(1.15), P.forced))));
  const alpha = isSpark.mul(sparkA).add(isCore.mul(coreA)).add(isShell.mul(shellA)).add(isHaze.mul(hazeA)).mul(P.alive).mul(P.dim);

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  // eye-facing, not view-plane-facing: a dome's six cube faces must agree on the quad (billboard.ts)
  material.positionNode = eyeFacing(pos, size.mul(step(0.0005, alpha)));
  material.colorNode = Fn(() => {
    const r = clamp(length(uv().sub(0.5)).mul(2), 0, 1);
    const disc = float(1).sub(r).pow(3); // hot centre
    const ring = smoothstep(0.55, 0.92, r).pow(2).mul(float(1).sub(smoothstep(0.92, 1, r))); // soft shell
    const soft = float(1).sub(r).pow(1.6);
    const tint = select(anti.greaterThan(0.5), U.anti, U.matter) as V3;
    // the birth spark: a needle-sharp core in a tight halo (the hero's first point of light is this)
    const sparkC = U.light.mul(U.coreRadiance).mul(float(1).sub(r).pow(14).mul(2.2).add(float(1).sub(r).pow(4).mul(0.12)));
    const hot = mix(float(1), float(1.6), P.forced);
    const coreC = mix(U.light, tint, 0.25).mul(U.coreRadiance.mul(U.flashGain).mul(hot)).mul(disc);
    const shellC = mix(U.light, vec3(0.72, 0.62, 1), 0.5).mul(U.shellRadiance.mul(U.flashGain)).mul(ring);
    // no haze on the wave front: its light is the sparks and the band, and blobs behind it read as bokeh
    const hazeC = mix(U.light, tint, 0.35).mul(U.hazeRadiance.mul(U.haze).mul(float(1).sub(P.forced))).mul(soft);
    const c = sparkC.mul(isSpark).add(coreC.mul(isCore)).add(shellC.mul(isShell)).add(hazeC.mul(isHaze));
    return vec4(c.mul(alpha), 1);
  })();
  material.name = name;

  return billboardMesh(material, slots * 7, name);
}
