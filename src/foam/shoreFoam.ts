/**
 * Regional shoreline history in cascade 0's otherwise unused BA channels.
 * RG remains periodic whitecap state. BA uses its own camera-following world
 * coordinates, zero boundary, advection and two decay clocks. No new texture.
 */
import * as THREE from 'three/webgpu';
import { float, ivec2, mix, smoothstep, texture, textureLoad, uniform, vec2, vec3 } from 'three/tsl';
import type { OceanSimulation } from '../ocean/oceanCascades';
import type { SeabedField } from '../island/seabed';
import { seabedHeightNode } from '../island/seabed';
import { fetchFieldSampleNode, type FetchField } from '../ocean/fetchField';
import { developmentRatioNode, fetchBandCoefficient, fetchBandGainNode, fullyDevelopedFetch, fullyDevelopedPeakWavenumber } from '../ocean/fetch';
import { breakerClipNodes, shoalSurfNodes, shoalWavenumber } from '../ocean/shoaling';
import { bandPropagation, SHOAL_ASYMMETRY_BANDS, shoalAsymmetryNodes } from '../ocean/shoalAsymmetry';
import { swellBandShare, swellShadowGainNode } from '../ocean/swellShadow';
import { loadCascadeLayer } from '../ocean/oceanTextures';
import { oceanParams as p } from '../params/ocean';
import { valueNoise2 } from '../terrain/noise';
import { coordFootprint } from './foamShading';

export const SHORE_REGION_METRES = 512;
export const SHORE_RESIDUE_HALF_LIFE = 4;
export const SHORE_BREAKING_HALF_LIFE = 0.65;
export const SHORE_INJECTION_RATE = 0.14;

/** Whole-texel origin; the shader and history translate by the same amount. */
export function shoreOrigin(center: number, texel: number): number {
  return Math.floor(center / texel) * texel - SHORE_REGION_METRES / 2;
}

export function createShoreFoam(
  sim: OceanSimulation, bed: SeabedField, fetch: FetchField | null | undefined,
  state: THREE.StorageTexture, coarse: THREE.StorageTexture, resolution: number,
) {
  const texel = SHORE_REGION_METRES / resolution;
  const origin = uniform(new THREE.Vector2());
  const previousOrigin = uniform(new THREE.Vector2());
  const history = uniform(0);
  const dt = uniform(0);
  const clock = uniform(0);
  const decay = uniform(new THREE.Vector2(1, 1));
  const bandWidth = uniform(1);
  const wind = uniform(new THREE.Vector2(1, 0));
  const breaker = uniform(new THREE.Vector2(p.shoalBreakerIndex, p.shoalColumnCeiling));
  const fetchFull = uniform(1), fetchMax = uniform(1);
  // §T.190: breaking reads the whole sea's Hs, so every cascade carries its
  // shoaling uniforms even though only the first two are drawn into history
  const surf = uniform(new THREE.Vector2(p.shoalSurfGamma, p.shoalSurfOnset));
  const bands = sim.cascades.map(() => ({ k: uniform(0), sigma: uniform(0), c: uniform(0), share: uniform(0), speed: uniform(0) }));
  // §T.193 shoaling asymmetry uniforms (src/ocean/shoalAsymmetry.ts), same values as the ocean material's
  const asymBand = sim.cascades.map(() => uniform(new THREE.Vector3(0, 1, 1)));
  const asymDir = sim.cascades.map(() => uniform(new THREE.Vector2(1, 0)));
  const asym = uniform(new THREE.Vector2(p.shoalAsymmetryGain, p.shoalAsymmetryHarmonicCap));
  const chop = uniform(p.choppiness);
  const target = new THREE.Vector2();
  let ready = false;

  function prepare(step: number): void {
    previousOrigin.value.copy(origin.value);
    origin.value.set(shoreOrigin(target.x, texel), shoreOrigin(target.y, texel));
    history.value = ready ? 1 : 0;
    ready = true;
    dt.value = step;
    clock.value += step;
    decay.value.set(2 ** (-step / SHORE_RESIDUE_HALF_LIFE), 2 ** (-step / SHORE_BREAKING_HALF_LIFE));
    bandWidth.value = Math.max(0.3, Math.min(2, sim.heightRms * 2));
    wind.value.set(Math.cos(p.windDirection), Math.sin(p.windDirection));
    breaker.value.set(p.shoalBreakerIndex, p.shoalColumnCeiling);
    surf.value.set(p.shoalSurfGamma, p.shoalSurfOnset);
    fetchFull.value = fullyDevelopedFetch(p.windSpeed, p);
    fetchMax.value = p.fetchMaxGain;
    const peak = fullyDevelopedPeakWavenumber(p.windSpeed);
    for (let i = 0; i < bands.length; i++) {
      const c = sim.cascades[i], u = bands[i];
      u.k.value = shoalWavenumber(c.meanWavenumber, -bed.openHeight, p);
      u.sigma.value = Math.sqrt(Math.max(c.heightVariance, 0));
      u.c.value = fetchBandCoefficient(peak, c.meanWavenumber, p);
      u.share.value = swellBandShare(p, i, c.heightVariance);
      u.speed.value = c.meanWavenumber > 0 ? Math.sqrt(9.81 / c.meanWavenumber) : 0;
      if (i >= SHOAL_ASYMMETRY_BANDS) continue;
      const m = bandPropagation(sim.spectrum.current.cascades[i].h0);
      asymBand[i].value.set(c.meanWavenumber, m.q, m.r);
      asymDir[i].value.set(m.x, m.z);
    }
    asym.value.set(p.shoalAsymmetryGain, p.shoalAsymmetryHarmonicCap);
    chop.value = sim.effectiveChoppiness();
  }

  /** Integer history taps explicitly reject out-of-region coordinates. */
  function load(coord: any): any {
    const valid = coord.x.greaterThanEqual(0).and(coord.y.greaterThanEqual(0))
      .and(coord.x.lessThan(resolution)).and(coord.y.lessThan(resolution));
    return textureLoad(state, coord.clamp(0, resolution - 1)).ba
      .mul(valid.select(float(1), float(0))).mul(history);
  }

  return {
    setCenter(x: number, z: number): void {
      if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('shore foam: center must be finite');
      target.set(x, z);
    },
    prepare,
    /** Called inside the existing inject kernel, producing only BA. */
    inject(coord: any): any {
      const world = vec2(coord).add(0.5).mul(texel).add(origin).toVar();
      const bedHere = seabedHeightNode(bed, world).toVar();
      const depth = bedHere.negate().max(0);
      const fs = fetch ? fetchFieldSampleNode(fetch, world) : null;
      const ratio = fs ? developmentRatioNode(fs.r, fetchFull) : null;
      // §T.190: the ocean's own per-band gains and breaking intensity — the
      // TSL twin of `shoalBandGains`, one B shared by the gains and the foam
      const shoal = shoalSurfNodes(depth, bands.map((u) => u.k), bands.map((u) => u.sigma),
        ratio ? bands.map((u) => fetchBandGainNode(u.c, ratio, fetchMax).mul(swellShadowGainNode(u.share, fs!.g))) : null,
        surf);
      const displacement = vec3(0).toVar();
      const rise = float(0).toVar();
      const surfaceGradient = vec2(0).toVar();
      const bandDisp: any[] = [];
      // Match the two bands used for shoreline/buoyancy geometry. Sub-metre
      // capillary slopes cannot be represented by this one-metre history grid.
      for (let i = 0; i < 2; i++) {
        const c = sim.cascades[i], u = bands[i];
        const gain = shoal.gains[i];
        const uv = world.div(c.domain);
        const d = texture(c.displacement, uv).level(float(0));
        bandDisp.push(d);
        // Array textures require integer loads outside fragment shaders in r180.
        const oceanN = sim.spectrum.current.params.resolution;
        // @band-limited-elsewhere: periodic compute lookup into a band-limited wave field.
        const address = ivec2(uv.fract().mul(oceanN));
        const slope = loadCascadeLayer(c.derivatives, address).xy;
        surfaceGradient.addAssign(slope.mul(gain));
        displacement.addAssign(d.xyz.mul(gain));
        // Narrow-band estimate of vertical approach velocity: -c * dh/dx.
        // Positive rise injects; receding water only transports and decays.
        rise.subAssign(slope.dot(wind).mul(u.speed).mul(gain));
      }
      const clipped = breakerClipNodes(displacement.y, depth, breaker.x, breaker.y);
      const landed = world.add(displacement.xz);
      const floor = seabedHeightNode(bed, landed).toVar();
      const column = clipped.clipped.sub(floor).toVar();
      const gx = seabedHeightNode(bed, landed.add(vec2(texel, 0))).sub(floor).div(texel);
      const gz = seabedHeightNode(bed, landed.add(vec2(0, texel))).sub(floor).div(texel);
      const gradient = vec2(gx, gz).toVar();
      const normal = gradient.div(gradient.length().max(0.001));
      // Alternating runup/backwash along the bed gradient, plus weak wind drift.
      const flow = normal.mul(rise.mul(clipped.slope).clamp(-0.7, 0.7))
        .add(wind.mul(0.08));
      const back = world.sub(flow.mul(dt)).sub(previousOrigin).div(texel).sub(0.5).toVar();
      const base = ivec2(back.floor());
      // @band-limited-elsewhere: bilinear history reconstruction in a compute kernel.
      const f = back.fract();
      const prior = mix(mix(load(base), load(base.add(ivec2(1, 0))), f.x),
        mix(load(base.add(ivec2(0, 1))), load(base.add(ivec2(1, 1))), f.x), f.y);
      // Only a thin WET column near land may produce foam. Deep water and
      // exposed sand cannot inject, even when the ocean above it is breaking.
      const cellHeight = surfaceGradient.mul(clipped.slope).sub(gradient).length()
        .mul(texel * 0.5).max(0.08);
      // @band-limited-elsewhere: integrate the waterline over this compute cell's height footprint.
      const wet = smoothstep(cellHeight.negate(), cellHeight, column);
      // @band-limited-elsewhere: the shoreline band includes the same compute-cell footprint.
      const near = smoothstep(bandWidth.add(cellHeight), float(0), column);
      // @band-limited-elsewhere: a simulation source-rate gate, not a fragment edge.
      const approaching = smoothstep(float(0.015), float(0.25), rise.mul(clipped.slope));
      const patches = valueNoise2(world.mul(Math.min(0.23, 1 / (4 * texel)))
        .sub(wind.mul(clock).mul(0.035)));
      // §T.190 BREAKING FOAM: also inject wherever the drawn sea is depth-limited
      // breaking (surf zones, whitewater over bars), keyed on the SAME B its
      // gains carry. `max`, not a sum: at the waterline both say the same thing.
      // Still phase-gated by `approaching` and broken by `patches`, so it is
      // wave-face whitewater, never a ribbon along a depth contour.
      // §T.193: breaking whitewater sits on the crest and the steep front face,
      // where the shoaling second harmonic lifts the crest half of the wave
      // (positive harmonic AND positive elevation; troughs also get a positive
      // harmonic, so the elevation gate keeps them clean). Same term the drawn
      // sea carries, relative to the bands' local RMS.
      const asymTerms = shoalAsymmetryNodes(depth, bands.map((u) => u.k), asymBand, asymDir, bands.map((u) => u.sigma),
        shoal.gains, [bandDisp[0].y.mul(shoal.gains[0]), bandDisp[1].y.mul(shoal.gains[1])],
        [bandDisp[0].xz.mul(shoal.gains[0]), bandDisp[1].xz.mul(shoal.gains[1])], chop, asym);
      const localRms = bands[0].sigma.mul(shoal.gains[0]).pow(2).add(bands[1].sigma.mul(shoal.gains[1]).pow(2)).sqrt().max(0.01);
      // @band-limited-elsewhere: products of the band-limited cascade fields on this compute grid.
      const face = smoothstep(float(0), localRms.mul(0.15), asymTerms[0].dy.add(asymTerms[1].dy))
        .mul(smoothstep(float(0), localRms.mul(0.5), displacement.y));
      const drive = near.max(shoal.breaking.mul(face));
      const source = wet.mul(drive).mul(approaching).mul(patches.mul(0.8).add(0.2))
        .mul(SHORE_INJECTION_RATE).mul(dt);
      // Dry ground drains old foam; the sand material owns stranded swash.
      return prior.mul(decay).add(vec2(source)).mul(wet).clamp(0, 1);
    },
    /** Same texture UUID as whitecaps: another lookup, no additional binding. */
    sample(world: any): any {
      const uv = world.sub(origin).div(SHORE_REGION_METRES);
      const distance = uv.sub(0.5).abs();
      const edge = distance.x.max(distance.y).mul(2);
      // @band-limited-elsewhere: a 38.4 m regional boundary taper, wider than the filtered state cells.
      const fade = smoothstep(float(1), float(0.85), edge);
      const filtered = smoothstep(float(texel * 0.5), float(texel * 2), coordFootprint(world));
      return mix(texture(state, uv).ba, texture(coarse, uv).ba, filtered).mul(fade).toVar();
    },
  };
}

export type ShoreFoam = ReturnType<typeof createShoreFoam>;
