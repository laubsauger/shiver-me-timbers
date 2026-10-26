/**
 * Undertime's field — "bubble-chamber cosmos": pair tracks (tracks.ts), the light of their birth and
 * annihilation (flashes.ts), and the leftover grains of matter (below).
 *
 * STATELESS BY DESIGN. Every instance's position, size and colour is a pure function of its index, the act
 * time and the timeline uniforms — no simulation state on the GPU — so any frame renders on its own,
 * scrubbing is free, and re-rendering frame 412 gives back frame 412.
 *
 * GRAINS. The leftover matter. Grain j appears when the timeline's `grains` passes its own hash (so they
 * appear through the final wave), wanders slowly, is carried outward by `spread` (the zoom beat: the
 * universe expands, the grains become pinpoints), and drifts toward one of `clusters` centres in the
 * gather beat, where it warms into starlight. A grain keeps the MATTER colour until it is starlight.
 */
import * as THREE from 'three/webgpu';
import { Fn, clamp, cos, float, floor, hash, instanceIndex, length, mix, pow, sin, smoothstep, step, uniform, uv, vec3, vec4 } from 'three/tsl';
import type { DriftParams } from '../../params/drift';
import type { UndertimeState } from './timeline';
import { pocketMask, randomDir } from './pairModel';
import { domeBasis } from '../../cine/domeMaster';
import { createTracks, type TrackUniforms } from './tracks';
import { createFlashes, type FlashUniforms } from './flashes';
import { billboardMesh, eyeFacing } from './billboard';

type V3 = THREE.Node<'vec3'>;

export interface TextPocket {
  /** deg, elevation band the crawl occupies right now */
  lo: number;
  hi: number;
  /** deg, azimuth half-width */
  az: number;
  /** 0..1 */
  strength: number;
}

export interface UndertimeField {
  readonly group: THREE.Group;
  /** keep the field out of the sky the crawl is passing through */
  setPocket(pocket: TextPocket, tiltDeg: number): void;
  /** push the timeline state for act time `t` */
  update(state: UndertimeState, t: number): void;
  /** radians per pixel of the view about to be drawn (a cube face: (π/2)/faceSize) — ribbons never go sub-pixel */
  setPixelAngle(rad: number): void;
  dispose(): void;
}

export function createUndertimeField(p: DriftParams): UndertimeField {
  const u = {
    time: uniform(0),
    density: uniform(1),
    flashGain: uniform(1),
    haze: uniform(1),
    grains: uniform(0),
    spread: uniform(1),
    gather: uniform(0),
    starlight: uniform(0),
    radius: uniform(p.fieldRadius),
    life: uniform(p.pairLife),
    speed: uniform(p.trackSpeed),
    curl: uniform(p.trackCurl),
    drag: uniform(p.trackDrag),
    field: uniform(new THREE.Vector3(0, 1, 0)),
    domeAxis: uniform(new THREE.Vector3(0, 1, 0)),
    domeFront: uniform(new THREE.Vector3(0, 0, -1)),
    domeRight: uniform(new THREE.Vector3(1, 0, 0)),
    pocketLo: uniform(0),
    pocketHi: uniform(0),
    pocketAz: uniform(0.9),
    pocket: uniform(0),
    tail: uniform(p.trackTail),
    width: uniform(p.trackWidth),
    pixelAngle: uniform(0.002),
    trackRadiance: uniform(p.trackRadiance),
    coreSize: uniform(p.coreSize),
    coreRadiance: uniform(p.coreRadiance),
    shellSpeed: uniform(p.shellSpeed),
    shellRadiance: uniform(p.shellRadiance),
    hazeSize: uniform(p.hazeSize),
    hazeRadiance: uniform(p.hazeRadiance),
    size: uniform(p.particleSize),
    grainRadiance: uniform(p.particleRadiance),
    matter: uniform(new THREE.Color(p.matterColor)),
    anti: uniform(new THREE.Color(p.antimatterColor)),
    light: uniform(new THREE.Color(p.lightColor)),
    star: uniform(new THREE.Color(p.starColor)),
  };
  // colour and vec3 uniforms are 'color'/'vec3' to @types/three 0.186; at runtime all are vec3 (terra-sim idiom)
  const matter = u.matter as unknown as V3;
  const anti = u.anti as unknown as V3;
  const light = u.light as unknown as V3;
  const star = u.star as unknown as V3;
  const field = u.field as unknown as V3;
  const pair = {
    time: u.time, density: u.density, life: u.life, radius: u.radius, speed: u.speed, curl: u.curl, drag: u.drag, field,
    domeAxis: u.domeAxis as unknown as V3, domeFront: u.domeFront as unknown as V3, domeRight: u.domeRight as unknown as V3,
    pocketLo: u.pocketLo, pocketHi: u.pocketHi, pocketAz: u.pocketAz, pocket: u.pocket,
  };

  const trackU: TrackUniforms = { ...pair, tail: u.tail, width: u.width, pixelAngle: u.pixelAngle, radiance: u.trackRadiance, matter, anti, spread: u.spread };
  const tracks = createTracks(p.pairSlots, p.trackSegments, trackU);
  const flashU: FlashUniforms = {
    ...pair,
    flashGain: u.flashGain,
    haze: u.haze,
    coreSize: u.coreSize,
    coreRadiance: u.coreRadiance,
    shellSpeed: u.shellSpeed,
    shellRadiance: u.shellRadiance,
    hazeSize: u.hazeSize,
    hazeRadiance: u.hazeRadiance,
    light,
    matter,
    anti,
    spread: u.spread,
  };
  const flashes = createFlashes(p.pairSlots, flashU);

  // ---------------------------------------------------------------- grains
  const j = float(instanceIndex);
  const appear = hash(j.mul(3.1).add(0.7));
  // grains and first stars dim (not vanish) behind the crawl — the pocket is about legibility, not absence
  const grainAlphaRaw = smoothstep(appear, appear.add(0.08), u.grains);
  const r0 = u.radius.mul(pow(hash(j.mul(4.3).add(0.2)), float(1 / 3)).mul(0.85).add(0.15));
  const p0 = randomDir(hash(j.mul(5.9).add(0.1)), hash(j.mul(6.7).add(0.4))).mul(r0);
  const w = hash(j.mul(8.3)).mul(0.25).add(0.08);
  const wander = vec3(sin(u.time.mul(w).add(j)), sin(u.time.mul(w.mul(1.3)).add(j.mul(1.7))), cos(u.time.mul(w.mul(0.9)).add(j.mul(2.3)))).mul(0.6);
  const k = floor(hash(j.mul(9.7).add(0.3)).mul(p.clusters));
  const clusterCenter = randomDir(hash(k.mul(11.3).add(0.5)), hash(k.mul(12.9).add(0.25))).mul(u.radius.mul(0.6));
  const inCluster = randomDir(hash(j.mul(13.1)), hash(j.mul(14.7))).mul(hash(j.mul(15.3)).mul(u.radius.mul(0.05)));
  const grainPos = mix(p0.add(wander), clusterCenter.add(inCluster), u.gather).mul(u.spread);
  const grainAlpha = grainAlphaRaw.mul(float(1).sub(pocketMask(grainPos, pair).mul(0.85)));
  // spread pushes grains outward; growing the sprite a little slower keeps them visible pinpoints
  const grainSize = u.size.mul(pow(u.spread, float(0.85))).mul(mix(float(1), float(0.7), u.gather)).mul(u.starlight.mul(2).add(1));
  const grainColor = mix(matter, star, u.starlight).mul(u.starlight.mul(5).add(1)).mul(u.grainRadiance);

  const grainMat = new THREE.NodeMaterial();
  grainMat.transparent = true;
  grainMat.depthWrite = false;
  grainMat.side = THREE.DoubleSide;
  grainMat.blending = THREE.AdditiveBlending;
  grainMat.positionNode = eyeFacing(grainPos, grainSize.mul(step(0.001, grainAlpha)));
  grainMat.colorNode = Fn(() => {
    const r = clamp(length(uv().sub(0.5)).mul(2), 0, 1);
    return vec4(grainColor.mul(grainAlpha).mul(float(1).sub(r).pow(2.5)), 1);
  })();
  grainMat.name = 'undertime-grains';
  const grains = billboardMesh(grainMat, p.grainCount, 'undertime-grains');

  const group = new THREE.Group();
  group.name = 'undertime-field';
  group.add(tracks, flashes, grains);

  return {
    group,
    update(state, t) {
      u.time.value = t;
      u.density.value = state.pairDensity;
      u.flashGain.value = state.flashGain;
      u.haze.value = state.glow;
      u.grains.value = state.grains;
      u.spread.value = 1 / state.scale;
      u.gather.value = state.gather;
      u.starlight.value = state.starlight;
      u.radius.value = p.fieldRadius;
      u.life.value = p.pairLife;
      u.speed.value = p.trackSpeed;
      u.curl.value = p.trackCurl;
      u.drag.value = p.trackDrag;
      const a = (p.fieldTilt * Math.PI) / 180;
      u.field.value.set(0, Math.cos(a), -Math.sin(a));
      u.tail.value = p.trackTail;
      u.width.value = p.trackWidth;
      u.trackRadiance.value = p.trackRadiance;
      u.coreSize.value = p.coreSize;
      u.coreRadiance.value = p.coreRadiance;
      u.shellSpeed.value = p.shellSpeed;
      u.shellRadiance.value = p.shellRadiance;
      u.hazeSize.value = p.hazeSize;
      u.hazeRadiance.value = p.hazeRadiance;
      u.size.value = p.particleSize;
      u.grainRadiance.value = p.particleRadiance;
      u.matter.value.set(p.matterColor);
      u.anti.value.set(p.antimatterColor);
      u.light.value.set(p.lightColor);
      u.star.value.set(p.starColor);
    },
    setPocket(pk, tiltDeg) {
      const b = domeBasis(tiltDeg);
      u.domeAxis.value.set(...b.axis);
      u.domeFront.value.set(...b.front);
      u.domeRight.value.set(...b.right);
      const D = Math.PI / 180;
      u.pocketLo.value = pk.lo * D;
      u.pocketHi.value = pk.hi * D;
      u.pocketAz.value = pk.az * D;
      u.pocket.value = pk.strength;
    },
    setPixelAngle(rad) {
      u.pixelAngle.value = rad;
    },
    dispose() {
      tracks.geometry.dispose();
      (tracks.material as THREE.Material).dispose();
      for (const m of [flashes, grains]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
  };
}
