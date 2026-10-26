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
 */
import * as THREE from 'three/webgpu';
import { Fn, clamp, float, hash, instanceIndex, length, mix, select, smoothstep, step, uv, vec3, vec4 } from 'three/tsl';
import { pairSlot, trackPosition, type PairUniforms } from './pairModel';
import { billboardMesh, eyeFacing } from './billboard';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface FlashUniforms extends PairUniforms {
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
  spread: F;
}

export function createFlashes(slots: number, U: FlashUniforms): THREE.InstancedMesh {
  const kind = float(instanceIndex.mod(7));
  const slot = float(instanceIndex.div(7));
  const P = pairSlot(slot, U);
  const tEnd = P.period.mul(P.trackEnd);
  // which end: kinds 1,3,5 are the matter track's end, 2,4,6 the antimatter track's
  const anti = step(0.5, kind.mod(2).oneMinus()).mul(step(0.5, kind)); // even and non-zero
  const q = float(1).sub(anti.mul(2));
  const end = trackPosition(P, q, tEnd, U.field);
  const isSpark = step(kind, 0.5);
  const isCore = step(0.5, kind).mul(step(kind, 2.5));
  const isShell = step(2.5, kind).mul(step(kind, 4.5));
  const isHaze = step(4.5, kind);
  const pos = mix(end, P.vertex, isSpark).mul(U.spread);

  const dt = P.tau.sub(tEnd); // time since this track ended
  const left = P.period.sub(tEnd); // until the slot is reborn
  const after = step(0, dt);
  const sparkA = float(1).sub(smoothstep(0, 0.18, P.tau));
  const coreA = clamp(float(1).sub(dt.div(0.35)), 0, 1).pow(3).mul(after);
  // a shell is the light front leaving: quick, and only from some of the annihilations so they stay legible
  const shellK = clamp(dt.div(left.min(0.6)), 0, 1);
  const shellA = float(1).sub(shellK).pow(2).mul(after).mul(step(hash(P.seed.add(kind.mul(3.7))), 0.35));
  const hazeA = smoothstep(0, 0.12, dt).mul(float(1).sub(smoothstep(left.mul(0.4), left, dt))).mul(after);

  const size = isSpark.mul(U.coreSize.mul(0.6))
    .add(isCore.mul(U.coreSize.mul(dt.max(0).mul(3).add(1))))
    .add(isShell.mul(U.shellSpeed.mul(dt.max(0)).add(0.02)))
    .add(isHaze.mul(U.hazeSize.mul(smoothstep(0, left, dt).mul(0.6).add(0.4))));
  const alpha = isSpark.mul(sparkA).add(isCore.mul(coreA)).add(isShell.mul(shellA)).add(isHaze.mul(hazeA)).mul(P.alive);

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  // eye-facing, not view-plane-facing: a dome's six cube faces must agree on the quad (billboard.ts)
  material.positionNode = eyeFacing(pos, size.mul(U.spread).mul(step(0.0005, alpha)));
  material.colorNode = Fn(() => {
    const r = clamp(length(uv().sub(0.5)).mul(2), 0, 1);
    const disc = float(1).sub(r).pow(3); // hot centre
    const ring = smoothstep(0.78, 0.92, r).mul(float(1).sub(smoothstep(0.92, 1, r))); // thin shell
    const soft = float(1).sub(r).pow(1.6);
    const tint = select(anti.greaterThan(0.5), U.anti, U.matter) as V3;
    const sparkC = U.light.mul(U.coreRadiance).mul(disc);
    const coreC = mix(U.light, tint, 0.25).mul(U.coreRadiance.mul(U.flashGain)).mul(disc);
    const shellC = mix(U.light, vec3(0.72, 0.62, 1), 0.5).mul(U.shellRadiance.mul(U.flashGain)).mul(ring);
    const hazeC = mix(U.light, tint, 0.35).mul(U.hazeRadiance.mul(U.haze)).mul(soft);
    const c = sparkC.mul(isSpark).add(coreC.mul(isCore)).add(shellC.mul(isShell)).add(hazeC.mul(isHaze));
    return vec4(c.mul(alpha), 1);
  })();
  material.name = 'undertime-flashes';

  return billboardMesh(material, slots * 7, 'undertime-flashes');
}
