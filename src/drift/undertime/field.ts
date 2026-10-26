/**
 * Undertime's field — "bubble-chamber cosmos": pair tracks (tracks.ts), the light of their birth and
 * annihilation (flashes.ts), the hero pair of the cold open, the dome-wide light (sky.ts), and what remains
 * (grains.ts: the grains, the web, the first stars).
 *
 * STATELESS BY DESIGN. Every instance's position, size and colour is a pure function of its index, the act
 * time and the timeline uniforms — no simulation state on the GPU — so any frame renders on its own,
 * scrubbing is free, and re-rendering frame 412 gives back frame 412.
 */
import * as THREE from 'three/webgpu';
import { float, uniform } from 'three/tsl';
import type { DriftParams } from '../../params/drift';
import { beatStarts, fieldClock, heroGrainPosition, heroVertex, undertimeState, type UndertimeState } from './timeline';
import { heroSlot, pairSlot, trackPositionCpu, type PairUniforms } from './pairModel';
import { domeBasis } from '../../cine/domeMaster';
import { createTracks, type TrackUniforms } from './tracks';
import { createFlashes, type FlashUniforms } from './flashes';
import { createUndertimeSky } from './sky';
import { createGrains, createHeroGrain, createStars, createThreads, type GrainUniforms } from './grains';

type F = THREE.Node<'float'>;
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
  /** push the timeline state for act time `t`, seen from `eye` (world position) */
  update(state: UndertimeState, t: number, eye: THREE.Vector3): void;
  /** radians per pixel of the view about to be drawn (a cube face: (π/2)/faceSize) — ribbons never go sub-pixel */
  setPixelAngle(rad: number): void;
  dispose(): void;
}

export function createUndertimeField(p: DriftParams): UndertimeField {
  const u = {
    time: uniform(0),
    actTime: uniform(0),
    density: uniform(1),
    densityRate: uniform(0),
    flashGain: uniform(1),
    haze: uniform(1),
    radius: uniform(p.fieldRadius),
    life: uniform(p.pairLife),
    speed: uniform(p.trackSpeed),
    curl: uniform(p.trackCurl),
    drag: uniform(p.trackDrag),
    tilt0: uniform(0),
    tilt1: uniform(0),
    tiltClock0: uniform(0),
    tiltClock1: uniform(1),
    eye: uniform(new THREE.Vector3()),
    domeAxis: uniform(new THREE.Vector3(0, 1, 0)),
    domeFront: uniform(new THREE.Vector3(0, 0, -1)),
    domeRight: uniform(new THREE.Vector3(1, 0, 0)),
    pocketLo: uniform(0),
    pocketHi: uniform(0),
    pocketAz: uniform(0.9),
    pocket: uniform(0),
    waveClock0: uniform(1e6),
    waveRate: uniform(1),
    waveLength: uniform(1),
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
    matter: uniform(new THREE.Color(p.matterColor)),
    anti: uniform(new THREE.Color(p.antimatterColor)),
    light: uniform(new THREE.Color(p.lightColor)),
    star: uniform(new THREE.Color(p.starColor)),
    warm: uniform(new THREE.Color()),
    // the remainder
    pivot: uniform(new THREE.Vector3()),
    scale: uniform(1),
    fill: uniform(0),
    web: uniform(0),
    reveal: uniform(0),
    heroGrain: uniform(0),
    stars: uniform(0),
    size: uniform(p.particleSize),
    grainRadiance: uniform(p.particleRadiance),
    starRadiance: uniform(p.starRadiance),
    // the hero pair (U0)
    heroBirth: uniform(p.heroBirth),
    heroVertex: uniform(new THREE.Vector3()),
    heroDir: uniform(new THREE.Vector3(1, 0, 0)),
    heroField: uniform(new THREE.Vector3(0, 1, 0)),
    heroV: uniform(p.heroSpeed),
  };
  // colour and vec3 uniforms are 'color'/'vec3' to @types/three 0.186; at runtime all are vec3 (terra-sim idiom)
  const v3 = (x: unknown): V3 => x as V3;
  const matter = v3(u.matter);
  const anti = v3(u.anti);
  const light = v3(u.light);
  const pair: PairUniforms = {
    time: u.time, density: u.density, densityRate: u.densityRate, life: u.life, radius: u.radius, speed: u.speed, curl: u.curl, drag: u.drag,
    tilt0: u.tilt0, tilt1: u.tilt1, tiltClock0: u.tiltClock0, tiltClock1: u.tiltClock1, eye: v3(u.eye),
    domeAxis: v3(u.domeAxis), domeFront: v3(u.domeFront), domeRight: v3(u.domeRight),
    pocketLo: u.pocketLo, pocketHi: u.pocketHi, pocketAz: u.pocketAz, pocket: u.pocket,
    waveClock0: u.waveClock0, waveRate: u.waveRate, waveLength: u.waveLength,
  };
  const slotOf = (slot: F) => pairSlot(slot, pair);

  const trackU: TrackUniforms = { tail: u.tail, width: u.width, pixelAngle: u.pixelAngle, radiance: u.trackRadiance, matter, anti };
  const tracks = createTracks(p.pairSlots, p.trackSegments, trackU, slotOf);
  const flashU: FlashUniforms = {
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
    sparkLead: float(0.01),
  };
  const flashes = createFlashes(p.pairSlots, flashU, slotOf);

  // ---------------------------------------------------------------- the hero pair (U0, first light)
  // seen face-on (its field along the line of sight), so its two spirals read as the bubble-chamber
  // signature at full size: one curling left, one right, each ending in a flash
  const HERO = { omega: 2.0, k: 0.7, tEnd: 2.6 };
  const hero = heroSlot({
    time: u.actTime, birth: u.heroBirth, vertex: v3(u.heroVertex), dir: v3(u.heroDir), field: v3(u.heroField),
    v: u.heroV, omega: float(HERO.omega), k: float(HERO.k), tEnd: float(HERO.tEnd),
  });
  const heroTracks = createTracks(1, 160, { tail: float(8), width: float(0.035), pixelAngle: u.pixelAngle, radiance: float(9), matter, anti }, () => hero, 'undertime-hero-tracks');
  const heroFlashes = createFlashes(1, {
    ...flashU,
    flashGain: float(1),
    haze: float(1),
    coreSize: float(1.1),
    coreRadiance: float(40),
    // the hero's light shells are the sky's (a billboard ring cannot pass over the audience)
    shellRadiance: float(0),
    hazeSize: float(6),
    hazeRadiance: float(0.015),
    sparkLead: float(1.2),
  }, () => hero, 'undertime-hero-flashes');
  const sky = createUndertimeSky();

  // ---------------------------------------------------------------- the remainder
  const grainU: GrainUniforms = {
    domeAxis: pair.domeAxis, domeFront: pair.domeFront, domeRight: pair.domeRight,
    pocketLo: u.pocketLo, pocketHi: u.pocketHi, pocketAz: u.pocketAz, pocket: u.pocket,
    time: u.actTime, eye: pair.eye, pivot: v3(u.pivot), scale: u.scale, reveal: u.reveal, fill: u.fill, web: u.web,
    heroGrain: u.heroGrain, stars: u.stars, radius: u.radius, size: u.size, radiance: u.grainRadiance,
    starRadiance: u.starRadiance, pixelAngle: u.pixelAngle, warm: v3(u.warm), star: v3(u.star),
  };
  const grains = createGrains(p.grainCount, grainU, p.zoomDecades);
  const stars = createStars(grainU, p.zoomDecades);
  const heroGrain = createHeroGrain(grainU);
  const threadRadiance = uniform(p.threadRadiance);
  const threads = createThreads(grainU, threadRadiance, p.zoomDecades);

  const group = new THREE.Group();
  group.name = 'undertime-field';
  group.add(sky.mesh, tracks, flashes, heroTracks, heroFlashes, threads, grains, stars, heroGrain);

  const vx = (a: [number, number, number]): THREE.Vector3 => new THREE.Vector3(...a);
  return {
    group,
    update(state, t, eye) {
      const { starts } = beatStarts(p);
      u.time.value = state.clock;
      u.actTime.value = t;
      u.density.value = state.pairDensity;
      // the density a slot was born with: d density / d clock, from the timeline either side of t
      const e = 0.05;
      u.densityRate.value = (undertimeDensity(t + e) - undertimeDensity(t - e)) / (2 * e) / Math.max(1e-3, state.clockRate);
      u.flashGain.value = state.flashGain;
      u.haze.value = state.glow;
      u.radius.value = p.fieldRadius;
      u.life.value = p.pairLife;
      u.speed.value = p.trackSpeed;
      u.curl.value = p.trackCurl;
      u.drag.value = p.trackDrag;
      const D = Math.PI / 180;
      u.tilt0.value = p.fieldTilt * D;
      u.tilt1.value = p.fieldTiltEnd * D;
      u.tiltClock0.value = fieldClock(starts.cool, p);
      u.tiltClock1.value = fieldClock(starts.cool + p.cool, p);
      u.eye.value.copy(eye);
      u.waveClock0.value = state.waveClock0;
      u.waveRate.value = state.waveRate;
      u.waveLength.value = state.waveLength;
      u.tail.value = p.trackTail;
      u.width.value = p.trackWidth;
      u.trackRadiance.value = p.trackRadiance;
      u.coreSize.value = p.coreSize;
      u.coreRadiance.value = p.coreRadiance;
      u.shellSpeed.value = p.shellSpeed;
      u.shellRadiance.value = p.shellRadiance;
      u.hazeSize.value = p.hazeSize;
      u.hazeRadiance.value = p.hazeRadiance;
      u.matter.value.set(p.matterColor);
      u.anti.value.set(p.antimatterColor);
      u.light.value.set(p.lightColor);
      u.star.value.set(p.starColor);
      u.warm.value.set(p.matterColor).lerp(u.star.value, p.grainWarmth);

      // hero pair, and the two light shells its annihilations release
      const hv = heroVertex(p);
      u.heroBirth.value = p.heroBirth;
      u.heroVertex.value.set(...hv);
      u.heroField.value.set(...hv).normalize();
      u.heroV.value = p.heroSpeed;
      const H = { vertex: hv, dir: [1, 0, 0] as [number, number, number], field: u.heroField.value.toArray() as [number, number, number], v: p.heroSpeed, omega: HERO.omega, k: HERO.k };
      sky.u.c0.copy(vx(trackPositionCpu(H, 1, HERO.tEnd)));
      sky.u.c1.copy(vx(trackPositionCpu(H, -1, HERO.tEnd)));
      sky.setShell(t - (p.heroBirth + HERO.tEnd), p.heroShellSpeed, p.heroShellRadiance);
      sky.setAfterglow(state.afterglow, p.afterglowRadiance);
      sky.setWave(state.wave, u.domeFront.value, p.waveRadiance);
      sky.setColours(u.light.value, u.matter.value, u.anti.value);
      sky.follow(eye);

      u.pivot.value.set(...heroGrainPosition(p));
      u.scale.value = state.scale;
      const decades = -Math.log10(state.scale);
      u.fill.value = Math.min(1, Math.max(0, decades));
      // the threads emerge late in the pull-back, once the web's level fills the sky
      u.web.value = Math.min(1, Math.max(0, (decades - 0.8) / 0.9));
      u.reveal.value = state.grains;
      u.heroGrain.value = state.heroGrain;
      u.stars.value = state.stars;
      u.size.value = p.particleSize;
      u.grainRadiance.value = p.particleRadiance;
      u.starRadiance.value = p.starRadiance;
      threadRadiance.value = p.threadRadiance;
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
      sky.dispose();
      for (const m of [tracks, flashes, heroTracks, heroFlashes, threads, grains, stars, heroGrain]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
  };

  function undertimeDensity(at: number): number {
    return undertimeState(at, p).pairDensity;
  }
}
