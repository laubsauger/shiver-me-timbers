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
import { float, normalWorld, positionWorld, vec3 } from 'three/tsl';
import { createOceanSim } from '../src/ocean';
import {
  activeCaustics,
  createCaustics,
  setActiveCaustics,
  waterLighting,
} from '../src/caustics';
import { causticsParams } from '../src/params/caustics';
import { oceanParams } from '../src/params/ocean';
import { shoalFactor, shoalWavenumber } from '../src/ocean/shoaling';
import { skyParams } from '../src/params/sky';
import {
  createWaterLightingUniforms,
  refreshWaterLightingUniforms,
} from '../src/caustics/waterLighting';

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
    expect(seabed.causticDarken).toBeTruthy();
  });

  it('exposes the two caustic lobes separately (§B.11)', () => {
    // `caustics` is additive and ≥0; `causticDarken` is multiplicative and
    // already folded into `tint`. They are not interchangeable — folding the
    // dark lobe into the additive term is what put negative light on the hull.
    const w = waterLighting({ worldPos: positionWorld, normal: normalWorld });
    expect(w.caustics).toBeTruthy();
    expect(w.causticDarken).toBeTruthy();
    expect(w.causticDarken).not.toBe(w.caustics);
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

/**
 * THE SEA'S BOUNCE COLOUR IS A SKY QUANTITY (§T.39).
 *
 * The user: "the water is not really affecting what happens to the ship… that
 * makes stuff floaty and disconnected in terms of lighting situation."
 *
 * There were TWO sources of truth for "what colour is the sea throwing up onto
 * the hull": an authored teal `bounceColor` (#2a9a9c), and `skyPalette().ground`
 * — whose sunset hex is documented as "sea bounce at golden hour, the water
 * throws back the orange sky" and which crossfades on the same shared `warm`
 * weight as the sky, the fog and the ambient. The hull read the one that could
 * not warm, so at a full amber sunset the sea lit the ship teal.
 *
 * These tests pin the coupling, because a colour that silently stops following
 * is exactly the failure §B.9 and §T.39 keep producing.
 */
describe('water bounce fill follows the live sky', () => {
  const readBounce = (timeOfDay: number): THREE.Color => {
    const prev = skyParams.timeOfDay;
    skyParams.timeOfDay = timeOfDay;
    try {
      const u = createWaterLightingUniforms();
      refreshWaterLightingUniforms(u);
      return (u.bounceColor.value as THREE.Color).clone();
    } finally {
      skyParams.timeOfDay = prev;
    }
  };

  it('warms toward the sunset ground colour as the sun drops', () => {
    const noon = readBounce(12);
    const sunset = readBounce(17.7);
    // red/blue ratio is the honest measure of "warm" — absolute brightness
    // moves for other reasons, the HUE shift is what we are asserting
    const warmth = (c: THREE.Color): number => c.r / Math.max(c.b, 1e-6);
    expect(warmth(sunset)).toBeGreaterThan(warmth(noon) * 1.5);
  });

  it('is teal-dominated at noon — the authored look is not thrown away', () => {
    const noon = readBounce(12);
    expect(noon.b).toBeGreaterThan(noon.r);
    expect(noon.g).toBeGreaterThan(noon.r);
  });

  it('bounceFollowSky = 0 restores the fixed authored colour exactly', () => {
    const prev = causticsParams.bounceFollowSky;
    causticsParams.bounceFollowSky = 0;
    try {
      const noon = readBounce(12);
      const sunset = readBounce(17.7);
      expect(sunset.getHexString()).toBe(noon.getHexString());
      expect(sunset.getHexString()).toBe(
        new THREE.Color(causticsParams.bounceColor).getHexString(),
      );
    } finally {
      causticsParams.bounceFollowSky = prev;
    }
  });
});

/**
 * §B.41'S TWIN — the caustic is made of THE KEY, not of a hex.
 *
 * The user: "the intensity of caustics should definitely be moderated by the
 * amount of light actually hitting things or illuminating stuff. Having like a
 * late night super bright and intense caustics visible on the ship sides
 * doesn't really make sense."
 *
 * `causticColor` was an authored cream refreshed from the param and from
 * nothing else, so a caustic — refracted SUNLIGHT — carried noon's colour and
 * noon's brightness at midnight. That is exactly §B.41 (the glint road times a
 * hardcoded `vec3(1.0, 0.95, 0.82)`) in a second file, and these tests pin the
 * coupling rather than the numbers: what matters is that the caustic CANNOT be
 * brighter than the light it is made of.
 */
describe('caustics are made of the key light (§B.41 twin)', () => {
  /** what sky/lighting.ts writes at noon: full sun intensity, sun-coloured */
  const noonKey = () => ({
    color: new THREE.Color(skyParams.sunColorNoon),
    intensity: skyParams.sunIntensity,
  });
  /** what moonCycle.ts hands the same light after dark */
  const moonKey = () => ({
    color: new THREE.Color(skyParams.moonColor),
    intensity: skyParams.moonIntensity,
  });

  const read = (key?: { color: THREE.Color; intensity: number }) => {
    const u = createWaterLightingUniforms();
    refreshWaterLightingUniforms(u, key);
    return {
      color: (u.causticColor.value as THREE.Color).clone(),
      level: u.causticKey.value as number,
    };
  };
  /** Rec.709 luminance — only meaningful because three.Color stores LINEAR */
  const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  /** what the shader actually multiplies the bright lobe by */
  const radiance = (r: { color: THREE.Color; level: number }) => lum(r.color) * r.level;

  it('burns an order of magnitude dimmer under a moon than under the noon sun', () => {
    // THE COMPLAINT. Before the fix these two were bit-identical, because
    // neither the key's colour nor its intensity was read at all.
    const day = radiance(read(noonKey()));
    const night = radiance(read(moonKey()));
    expect(night).toBeLessThan(day * 0.15);
  });

  it('goes out entirely when the key does — a new moon lights no caustics', () => {
    // intensity 0 is the moonless night AND the swing window moonCycle puts the
    // whole 180° key handover inside. Nothing may be lit by a key of zero.
    expect(read({ color: new THREE.Color(skyParams.moonColor), intensity: 0 }).level).toBe(0);
  });

  it('is unchanged at the signed-off noon level — the peak is the anchor', () => {
    // the level is the key's intensity over its own authored peak, so noon is
    // exactly 1 by construction and the amplitude tuning keeps its meaning
    expect(read(noonKey()).level).toBeCloseTo(1, 12);
  });

  it('takes the key COLOUR, not just its level — sunset caustics are orange', () => {
    const sunset = read({
      color: new THREE.Color(skyParams.sunColorLow),
      intensity: skyParams.sunIntensity,
    }).color;
    const noon = read(noonKey()).color;
    // red/blue ratio is the honest measure of warm; absolute level moves for
    // other reasons and is asserted separately above
    const warmth = (c: THREE.Color) => c.r / Math.max(c.b, 1e-6);
    expect(warmth(sunset)).toBeGreaterThan(warmth(noon) * 3);
  });

  it('stays in the LINEAR working space — no double sRGB transfer (§V.31/§B.9)', () => {
    // Both operands are already linear: color(hex) applies the transfer on the
    // way in and sky/lighting.ts's setSrgb() does the same to the key. So at
    // full follow the result must be the key colour BIT FOR BIT. Anyone who
    // "fixes" this by copying setBounceColor's getRGB/setRGB round trip — which
    // that function needs only because skyPalette() returns sRGB TRIPLES — puts
    // a second transfer on it and fails here.
    const key = moonKey();
    expect(read(key).color.getHexString()).toBe(key.color.getHexString());
  });

  it('can only ever DIM, whatever the panel does to the intensities (§V.44)', () => {
    // bounded at source, not clamped downstream: a user cranking moonIntensity
    // past sunIntensity must not make the caustic brighter than its authored value
    expect(read({ color: new THREE.Color(0xffffff), intensity: 1e6 }).level).toBe(1);
    expect(read({ color: new THREE.Color(0xffffff), intensity: -5 }).level).toBe(0);
  });

  it('causticFollowKey = 0 restores the authored constant exactly', () => {
    // the A/B is one slider — same guarantee bounceFollowSky gives
    const prev = causticsParams.causticFollowKey;
    causticsParams.causticFollowKey = 0;
    try {
      const night = read(moonKey());
      expect(night.level).toBe(1);
      expect(night.color.getHexString()).toBe(
        new THREE.Color(causticsParams.causticColor).getHexString(),
      );
    } finally {
      causticsParams.causticFollowKey = prev;
    }
  });

  it('degrades to the authored constant when no key is bound', () => {
    // §Rule 8: it also warns, because a knob that drives nothing is §V.62
    const r = read(undefined);
    expect(r.level).toBe(1);
    expect(r.color.getHexString()).toBe(
      new THREE.Color(causticsParams.causticColor).getHexString(),
    );
  });
});

/**
 * §V.72 — THE SEA A RECEIVER RECONSTRUCTS MUST BE THE SEA THAT IS DRAWN.
 *
 * `waterHeightNode` sums the cascade displacement, which is the RAW open-ocean
 * spectrum. The ocean surface material draws its vertices at that sum times
 * `shoalFactor(kᵢ, depth)` per cascade, put through `breakerClip`, and
 * `CpuOcean.shoaledSum` mirrors it for buoyancy. A receiver that skipped the
 * shoaling therefore had a sea level that was wrong by the WHOLE shoaling
 * term — 1.0 offshore, 0.0 at the waterline — and the terrain is the receiver
 * that matters, because it uses it to decide how drowned it is.
 *
 * Consequence when it was missing (measured in-browser on the showcase
 * island's 180° transect, swell preset): raw ran -1.945 … +1.610 m across the
 * beach while the drawn sea sat at 0.000 … 0.281 m, so a hundred metres of dry
 * sand was told it was underwater (absorption tint + caustics painted onto
 * land, marching with the swell) and, on the other half of the cycle,
 * genuinely submerged sand got no darkening at all.
 *
 * These tests pin the two halves that can silently rot: that the wavenumbers a
 * receiver shoals with come from the SAME law the material and the mirror use,
 * and that the law actually collapses the sea to nothing at a waterline.
 */
describe('§V.72 receiver shoaling', () => {
  it('derives its wavenumbers from the one law, so it cannot drift', () => {
    const water = createCaustics(sim);
    const openDepth = 45;
    water.setSeabedOpenDepth(openDepth);
    water.update(new THREE.Vector3(0, 1, 0));
    // the identical call surfaceMaterial's refreshShoal and CpuOcean's
    // refreshShoal make — if any consumer grows its own formula, this fails
    for (const [i, c] of sim.cascades.entries()) {
      expect(water.shoaling.k[i].value).toBeCloseTo(
        shoalWavenumber(c.meanWavenumber, openDepth, oceanParams),
        10,
      );
    }
    // and the breaker pair is the params', not a literal
    expect(water.shoaling.breaker.value.x).toBe(oceanParams.shoalBreakerIndex);
    expect(water.shoaling.breaker.value.y).toBe(oceanParams.shoalColumnCeiling);
  });

  it('is refreshed every frame, not only on rebuild (§V.62)', () => {
    const water = createCaustics(sim);
    water.setSeabedOpenDepth(45);
    water.update(new THREE.Vector3(0, 1, 0));
    const before = water.shoaling.k.map((u) => u.value as number);
    // openDepth is not a spectrum param: nothing rebuilds when it moves, so a
    // once-only push would leave every receiver shoaling against a stale sea
    water.setSeabedOpenDepth(10);
    water.update(new THREE.Vector3(0, 1, 0));
    const after = water.shoaling.k.map((u) => u.value as number);
    expect(after).not.toEqual(before);
  });

  it('collapses the sea to nothing at a waterline, at every wavelength', () => {
    const openDepth = 45;
    for (const c of sim.cascades) {
      const k = shoalWavenumber(c.meanWavenumber, openDepth, oceanParams);
      // dry sand: the terrain passes max(-y, 0) = 0, so the reconstructed sea
      // is EXACTLY 0 — a beach above the waterline cannot be told it is
      // submerged by construction rather than by a threshold
      expect(shoalFactor(k, 0)).toBe(0);
      // and it is back to open ocean by the seabed's own floor depth
      expect(shoalFactor(k, openDepth)).toBeGreaterThan(0.999);
    }
  });

  it('accepts a depth and changes the graph it builds', () => {
    const water = createCaustics(sim);
    water.setSeabedOpenDepth(45);
    const raw = water.waterHeight(positionWorld.xz);
    const shoaled = water.waterHeight(positionWorld.xz, float(3));
    expect(raw).toBeTruthy();
    expect(shoaled).toBeTruthy();
    // the shoaled branch ends in breakerClip, the raw one in a bare add
    expect(shoaled).not.toBe(raw);
  });
});
