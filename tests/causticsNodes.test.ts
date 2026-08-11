/**
 * §T.32 integration-surface contract. Unlike the rest of tests/, this file
 * imports three/webgpu on purpose: it is the only headless check that the
 * TSL graph BUILDS and that the three outputs actually drop into the three
 * material slots the ship/terrain agents are being asked to wire.
 *
 * HONEST SCOPE: node construction only. There is no GPU here, so nothing
 * below compiles WGSL — a shader that builds can still fail to compile or
 * render black. §V.22 still applies: this feature is not done until it has
 * been seen in a browser.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { normalWorld, positionWorld, vec3 } from 'three/tsl';
import { createOceanSim } from '../src/ocean';
import {
  activeCaustics,
  createCaustics,
  setActiveCaustics,
  waterLighting,
} from '../src/caustics';
import { causticsParams } from '../src/params/caustics';

const sim = createOceanSim(1234);

describe('water lighting integration surface', () => {
  it('is a safe no-op before main.ts binds it', () => {
    setActiveCaustics(undefined);
    const w = waterLighting({ worldPos: positionWorld });
    // identity for every material slot, so an unbound receiver still renders
    expect(w.tint).toBeTruthy();
    expect(w.addLight).toBeTruthy();
    expect(activeCaustics()).toBeUndefined();
  });

  it('drops into the three MeshStandardNodeMaterial slots without throwing', () => {
    const water = createCaustics(sim);
    setActiveCaustics(water);
    water.attachHullWetline({ bowZ: 15, sternZ: -15 });

    const hull = waterLighting({
      worldPos: positionWorld,
      normal: normalWorld,
      shipLocalPos: vec3(1, 2, 3),
    });
    const material = new THREE.MeshStandardNodeMaterial();
    // the exact wiring the ship agent is asked to do: MODULATE, never replace
    material.colorNode = vec3(0.5, 0.4, 0.3).mul(hull.tint) as never;
    material.emissiveNode = hull.addLight as never;
    material.roughnessNode = hull.roughnessScale as never;
    expect(material.colorNode).toBeTruthy();
    expect(material.emissiveNode).toBeTruthy();
    expect(material.roughnessNode).toBeTruthy();
  });

  it('builds the seabed/beach variant with the reflected branch compiled out', () => {
    const seabed = waterLighting({
      worldPos: positionWorld,
      normal: normalWorld,
      mode: 'below',
    });
    expect(seabed.addLight).toBeTruthy();
    expect(seabed.caustics).toBeTruthy();
  });

  it('accepts a receiver-supplied depth, skipping the height taps', () => {
    const w = waterLighting({
      worldPos: positionWorld,
      normal: normalWorld,
      depthBelowSurface: vec3(0, 3, 0).y as never,
      mode: 'below',
    });
    expect(w.depth).toBeTruthy();
  });

  it('writes the live sun into a WRITABLE uniform (not a node-valued one)', () => {
    // a uniform seeded with vec3() has no .x/.y/.z to copy into, so the sun
    // would silently freeze at its construction value (foamShading's trap)
    const water = activeCaustics()!;
    const dir = new THREE.Vector3(0.3, 0.9, 0.2).normalize();
    water.update(dir);
    const value = water.caustics.sunDirection.value as THREE.Vector3;
    expect(value.isVector3).toBe(true);
    expect(value.y).toBeCloseTo(dir.y, 9);
  });

  it('pushes live param edits into uniforms every frame (§V.16)', () => {
    const water = activeCaustics()!;
    const before = causticsParams.strength;
    causticsParams.strength = 2.75;
    water.update(new THREE.Vector3(0, 1, 0));
    expect(water.caustics.strength.value).toBeCloseTo(2.75, 9);
    causticsParams.strength = before;
  });

  it('exposes the wetline texture as a finite RGBA32F feed (§V.28)', () => {
    const wetline = activeCaustics()!.wetline!;
    // `needsUpdate` is a write-only setter in three — `version` is the signal
    const before = wetline.texture.version;
    wetline.updateFromContacts(1 / 60, new Float32Array(wetline.stations * 2).fill(0.4));
    const data = wetline.texture.image.data as Float32Array;
    expect(data.every((v) => Number.isFinite(v))).toBe(true);
    expect(data[0]).toBeCloseTo(0.4, 6);
    // the memory must actually reach the GPU each frame, or the band freezes
    expect(wetline.texture.version).toBeGreaterThan(before);
  });

  it('never uploads the -Infinity "never wetted" seed to the GPU', () => {
    const water = createCaustics(sim);
    const wetline = water.attachHullWetline({ bowZ: 10, sternZ: -10 });
    wetline.updateFromContacts(1 / 60, new Float32Array(0));
    const data = wetline.texture.image.data as Float32Array;
    expect(data.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('rejects a reversed hull loudly rather than mapping every fragment to one end', () => {
    expect(() => createCaustics(sim).attachHullWetline({ bowZ: -5, sternZ: 5 }))
      .toThrow(/bowZ/);
  });
});
