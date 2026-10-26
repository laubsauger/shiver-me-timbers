/**
 * Undertime's particle field: matter–antimatter pairs, their annihilation flashes, and the leftover grains.
 *
 * STATELESS BY DESIGN. Every instance's position, size and colour is a pure function of its index, the act
 * time and the timeline uniforms — there is no simulation state on the GPU. That is what a film needs: any
 * frame can be rendered on its own, scrubbing is free, and re-rendering frame 412 gives back frame 412.
 *
 * PAIRS. Each pair slot cycles with its own period (pairLife ± 30 %). In each cycle a hash decides whether
 * the slot is alive (alive while hash < pairDensity, so density thins slots out smoothly), where the pair
 * is born and along which axis it separates. One slot draws three sprites: matter, antimatter, and the
 * flash at the moment they meet. Matter and antimatter are the only two particle colours.
 *
 * GRAINS. The leftover matter. Grain j appears when the timeline's `grains` passes its own hash (so they
 * appear through the final wave), wanders slowly, is carried outward by `spread` (the zoom beat: the
 * universe expands, the grains become pinpoints), and drifts toward one of `clusters` centres in the
 * gather beat, where it warms into starlight. A grain keeps the MATTER colour until it is starlight.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  PI,
  clamp,
  cos,
  float,
  fract,
  floor,
  hash,
  instanceIndex,
  length,
  mix,
  pow,
  select,
  sin,
  smoothstep,
  sqrt,
  step,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import type { DriftParams } from '../../params/drift';
import type { UndertimeState } from './timeline';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface UndertimeField {
  readonly group: THREE.Group;
  /** push the timeline state for act time `t` */
  update(state: UndertimeState, t: number): void;
  dispose(): void;
}

/** random unit vector from two hashes */
const randomDir = (a: F, b: F): V3 => {
  const z = a.mul(2).sub(1);
  const phi = b.mul(PI.mul(2));
  const rxy = sqrt(float(1).sub(z.mul(z)).max(0));
  return vec3(rxy.mul(cos(phi)), z, rxy.mul(sin(phi)));
};

/** a soft round sprite: 1 at the centre, 0 at the rim */
const softDisc = (): F => {
  const d = clamp(length(uv().sub(0.5)).mul(2), 0, 1);
  return float(1).sub(d).mul(float(1).sub(d));
};

export function createUndertimeField(p: DriftParams): UndertimeField {
  const uTime = uniform(0);
  const uDensity = uniform(1);
  const uFlashGain = uniform(1);
  const uGrains = uniform(0);
  const uSpread = uniform(1);
  const uGather = uniform(0);
  const uStarlight = uniform(0);
  const uRadius = uniform(p.fieldRadius);
  const uSize = uniform(p.particleSize);
  const uSeparation = uniform(p.pairSeparation);
  const uLife = uniform(p.pairLife);
  const uFlashGrow = uniform(p.flashGrow);
  const uParticleRadiance = uniform(p.particleRadiance);
  const uFlashRadiance = uniform(p.flashRadiance);
  // colour uniforms are 'color' nodes to @types/three 0.186; at runtime they are vec3 (terra-sim idiom)
  const uMatter = uniform(new THREE.Color(p.matterColor));
  const uAnti = uniform(new THREE.Color(p.antimatterColor));
  const uLight = uniform(new THREE.Color(p.lightColor));
  const uStar = uniform(new THREE.Color(p.starColor));
  const matter = uMatter as unknown as V3;
  const anti = uAnti as unknown as V3;
  const light = uLight as unknown as V3;
  const star = uStar as unknown as V3;

  // ---------------------------------------------------------------- pairs
  const slot = float(instanceIndex.div(3));
  const kind = float(instanceIndex.mod(3)); // 0 matter, 1 antimatter, 2 flash
  const period = uLife.mul(hash(slot.mul(1.37).add(0.11)).mul(0.6).add(0.7));
  const phase = uTime.add(hash(slot.mul(2.71).add(0.33)).mul(period)).div(period);
  const cycle = floor(phase);
  const a = fract(phase); // 0..1 through this cycle's life
  const seed = slot.mul(7.13).add(cycle.mul(131.7));
  const alive = step(hash(seed.add(0.5)), uDensity);
  const radius = uRadius.mul(pow(hash(seed.add(3)), float(1 / 3)).mul(0.85).add(0.15));
  const center = randomDir(hash(seed.add(1)), hash(seed.add(2))).mul(radius);
  const axis = randomDir(hash(seed.add(4)), hash(seed.add(5)));
  const sep = sin(PI.mul(clamp(a.div(0.8), 0, 1))).mul(uSeparation).mul(0.5);
  const side = select(kind.equal(0), float(1), select(kind.equal(1), float(-1), float(0)));
  const pairPos = center.add(axis.mul(sep.mul(side))).mul(uSpread);
  const isFlash = step(1.5, kind);
  const particleAlpha = smoothstep(0, 0.08, a).mul(float(1).sub(smoothstep(0.74, 0.8, a)));
  const f = clamp(a.sub(0.78).div(0.22), 0, 1);
  const flashAlpha = float(1).sub(f).mul(float(1).sub(f)).mul(step(0.78, a)).mul(uFlashGain);
  const pairAlpha = mix(particleAlpha, flashAlpha, isFlash).mul(alive);
  const pairSize = uSize.mul(mix(float(1), f.mul(uFlashGrow).add(1), isFlash));
  const pairColor = select(kind.equal(0), matter, select(kind.equal(1), anti, light)).mul(mix(uParticleRadiance, uFlashRadiance, isFlash));

  const pairMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  pairMat.positionNode = pairPos;
  pairMat.scaleNode = pairSize.mul(alive);
  pairMat.colorNode = Fn(() => vec4(pairColor.mul(pairAlpha).mul(softDisc()), 1))();
  pairMat.name = 'undertime-pairs';
  const pairs = new THREE.Sprite(pairMat);
  pairs.count = p.pairSlots * 3;
  pairs.frustumCulled = false;

  // ---------------------------------------------------------------- grains
  const j = float(instanceIndex);
  const appear = hash(j.mul(3.1).add(0.7));
  const grainAlpha = smoothstep(appear, appear.add(0.08), uGrains);
  const r0 = uRadius.mul(pow(hash(j.mul(4.3).add(0.2)), float(1 / 3)).mul(0.85).add(0.15));
  const p0 = randomDir(hash(j.mul(5.9).add(0.1)), hash(j.mul(6.7).add(0.4))).mul(r0);
  const w = hash(j.mul(8.3)).mul(0.25).add(0.08);
  const wander = vec3(sin(uTime.mul(w).add(j)), sin(uTime.mul(w.mul(1.3)).add(j.mul(1.7))), cos(uTime.mul(w.mul(0.9)).add(j.mul(2.3)))).mul(0.6);
  const k = floor(hash(j.mul(9.7).add(0.3)).mul(p.clusters));
  const clusterCenter = randomDir(hash(k.mul(11.3).add(0.5)), hash(k.mul(12.9).add(0.25))).mul(uRadius.mul(0.6));
  const inCluster = randomDir(hash(j.mul(13.1)), hash(j.mul(14.7))).mul(hash(j.mul(15.3)).mul(uRadius.mul(0.05)));
  const grainPos = mix(p0.add(wander), clusterCenter.add(inCluster), uGather).mul(uSpread);
  // spread pushes grains outward; growing the sprite a little slower keeps them visible pinpoints
  const grainSize = uSize.mul(1.4).mul(pow(uSpread, float(0.85))).mul(mix(float(1), float(0.7), uGather)).mul(uStarlight.mul(2).add(1));
  const grainColor = mix(matter, star, uStarlight).mul(uStarlight.mul(5).add(1)).mul(uParticleRadiance);

  const grainMat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  grainMat.positionNode = grainPos;
  grainMat.scaleNode = grainSize.mul(step(0.001, grainAlpha));
  grainMat.colorNode = Fn(() => vec4(grainColor.mul(grainAlpha).mul(softDisc()), 1))();
  grainMat.name = 'undertime-grains';
  const grains = new THREE.Sprite(grainMat);
  grains.count = p.grainCount;
  grains.frustumCulled = false;

  const group = new THREE.Group();
  group.name = 'undertime-field';
  group.add(pairs, grains);

  return {
    group,
    update(state, t) {
      uTime.value = t;
      uDensity.value = state.pairDensity;
      uFlashGain.value = state.flashGain;
      uGrains.value = state.grains;
      uSpread.value = 1 / state.scale;
      uGather.value = state.gather;
      uStarlight.value = state.starlight;
      uRadius.value = p.fieldRadius;
      uSize.value = p.particleSize;
      uSeparation.value = p.pairSeparation;
      uLife.value = p.pairLife;
      uFlashGrow.value = p.flashGrow;
      uParticleRadiance.value = p.particleRadiance;
      uFlashRadiance.value = p.flashRadiance;
      uMatter.value.set(p.matterColor);
      uAnti.value.set(p.antimatterColor);
      uLight.value.set(p.lightColor);
      uStar.value.set(p.starColor);
    },
    dispose() {
      pairMat.dispose();
      grainMat.dispose();
    },
  };
}
