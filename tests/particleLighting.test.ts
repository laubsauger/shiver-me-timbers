import { expect, it } from 'vitest';
import { DirectionalLight, HemisphereLight, Scene } from 'three/webgpu';
import { particleLighting, updateParticleLighting } from '../src/sky/particleLighting';
import { createLighting } from '../src/sky/lighting';
import { keyLight } from '../src/sky/moonCycle';
import { skyParams } from '../src/params/sky';

it('extinguishes both particle light terms when the actual lights turn off', () => {
  const key = new DirectionalLight(0xffddbb, 3.4);
  const sky = new HemisphereLight(0x88aaff, 0x334455, 0.7);
  updateParticleLighting(key, sky);
  expect(particleLighting.key.value.r).toBeGreaterThan(0.5);
  expect(particleLighting.ambient.value.b).toBeGreaterThan(0);
  key.intensity = 0;
  sky.intensity = 0;
  updateParticleLighting(key, sky);
  expect(particleLighting.key.value.toArray()).toEqual([0, 0, 0]);
  expect(particleLighting.ambient.value.toArray()).toEqual([0, 0, 0]);
});

it('scales moon/key and ambient independently, without normalizing away dim light', () => {
  const key = new DirectionalLight(0x8ea9d6, 1);
  const sky = new HemisphereLight(0x88aaff, 0x334455, 1);
  updateParticleLighting(key, sky);
  const beforeKey = particleLighting.key.value.clone();
  const beforeAmbient = particleLighting.ambient.value.clone();
  key.intensity = 0.03;
  sky.intensity = 0.1;
  updateParticleLighting(key, sky);
  for (const channel of ['r', 'g', 'b'] as const) {
    expect(particleLighting.key.value[channel]).toBeCloseTo(beforeKey[channel] * 0.03, 12);
    expect(particleLighting.ambient.value[channel]).toBeCloseTo(beforeAmbient[channel] * 0.1, 12);
  }
});

it('the live sky rig publishes intensity changes without a particle simulation tick', () => {
  const p = { ...skyParams };
  const rig = createLighting(new Scene(), p);
  rig.update(keyLight(12, p));
  expect(particleLighting.key.value.r).toBeGreaterThan(0.1);
  p.sunIntensity = 0;
  p.moonIntensity = 0;
  p.ambientIntensity = 0;
  rig.update(keyLight(0, p));
  expect(particleLighting.key.value.toArray()).toEqual([0, 0, 0]);
  expect(particleLighting.ambient.value.toArray()).toEqual([0, 0, 0]);
});
