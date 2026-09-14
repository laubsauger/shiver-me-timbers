/**
 * §T.209 NIGHT RACING + BOAT LEDs. What must not regress, and why:
 *  - the LEDs are practical lights: OFF under a day sky (they would read as a bug at noon) and ON at the race night,
 *    keyed off the one dusk clock (`nightFactor` of the sun's elevation), with a deterministic override for cine renders;
 *  - the water light pools are a bounded uniform array (the ocean shader has a fixed loop, §V40 no samplers) and each
 *    slot carries THAT boat's LED colour — a pool in the wrong colour breaks "which boat is that" at night;
 *  - a boat whose signature is black still lights up (levee-town);
 *  - 'Night' is selectable for the race AND in free roam, and leaving it restores the page's own sky.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import raceUiSrc from '../src/speedboat/page/raceUi.ts?raw';
import mainSrc from '../src/main-speedboat.ts?raw';
import { skyParams } from '../src/params/sky';
import { nightFactor } from '../src/sky/moonCycle';
import { sunElevation } from '../src/sky/sunCycle';
import { MOONLIT_NIGHT } from '../src/sky/nightPreset';
import { BOAT_LIGHT_POOL_MAX, createBoatLightPool } from '../src/ocean/boatLightPool';
import { FLEET_LIVERIES, HERO_LIVERY, ledColor } from '../src/speedboat/assets/livery';
import { ledLevel, poolLedColors } from '../src/speedboat/page/boatLights';
import { npcLivery } from '../src/speedboat/page/speedboatScene';
import { applyRaceTime } from '../src/speedboat/page/raceTime';
import { DEFAULT_SELECTION, TIME_OPTIONS } from '../src/speedboat/ui/boatSelect';
import { sanitizeRaceSettings } from '../src/speedboat/page/raceSettings';

const levelAt = (hour: number): number => ledLevel(nightFactor(sunElevation(hour, skyParams.latitude)), null);

describe('T209 boat LEDs follow the sun', () => {
  it('are off in daylight (page default, noon, the 17:30 golden hour) and fully on at the race night', () => {
    expect(levelAt(skyParams.timeOfDay)).toBe(0);
    expect(levelAt(12)).toBe(0);
    expect(levelAt(17.3)).toBe(0);
    expect(levelAt(MOONLIT_NIGHT.timeOfDay)).toBe(1);
    // a smooth ramp around sunset, not a switch
    const dusk = levelAt(18.4);
    expect(dusk).toBeGreaterThan(0);
    expect(dusk).toBeLessThan(1);
  });

  it('a cine override wins and is clamped; null follows the sky again', () => {
    expect(ledLevel(0, 0.6)).toBe(0.6);
    expect(ledLevel(1, 0)).toBe(0);
    expect(ledLevel(0, 7)).toBe(1);
    expect(ledLevel(0.3, null)).toBe(0.3);
  });
});

describe('T209 water light pools', () => {
  it('are bounded at 8 slots and each slot carries its boat\'s LED colour, hero first', () => {
    expect(createBoatLightPool(20).max).toBe(BOAT_LIGHT_POOL_MAX);
    expect(BOAT_LIGHT_POOL_MAX).toBe(8);
    const liveries = [HERO_LIVERY, ...Array.from({ length: 7 }, (_, i) => npcLivery(i))];
    const hexes = poolLedColors(liveries, BOAT_LIGHT_POOL_MAX);
    expect(hexes).toHaveLength(8);
    const pool = createBoatLightPool();
    hexes.forEach((hex, i) => pool.set(i, 0, 0, 0, 0, new THREE.Color(hex), 1));
    hexes.forEach((hex, i) => {
      const c = new THREE.Color(hex);
      expect([pool.colors[i].x, pool.colors[i].y, pool.colors[i].z]).toEqual([c.r, c.g, c.b]);
      // the LED keeps the signature's hue family: its brightest channel is the signature's brightest channel
      const sig = liveries[i].dominant;
      const ch = (h: number) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
      if (Math.max(...ch(sig)) > 60) expect(ch(hex).indexOf(255)).toBe(ch(sig).indexOf(Math.max(...ch(sig))));
    });
    // level 0 = an unlit slot, whatever the colour
    pool.set(3, 0, 0, 0, 0, new THREE.Color(0xff0000), 0);
    expect(pool.colors[3].x).toBe(0);
  });

  it('the hero lights in her orange, not the red a saturated #e4572e tonemaps to; a rival never inherits it', () => {
    expect(ledColor(HERO_LIVERY)).toBe(0xff7a1a);
    expect(npcLivery(0).led).toBeUndefined();
    expect(ledColor(npcLivery(0))).not.toBe(0xff7a1a);
  });

  it('a black signature lights in its pinstripe, never black', () => {
    const levee = FLEET_LIVERIES['levee-town'];
    expect(ledColor(levee)).not.toBe(0);
    expect(ledColor(levee)).toBe(ledColor({ ...levee, dominant: levee.stripe }));
  });
});

describe('T209 night is a time option', () => {
  it('exists for the race, survives a settings reload, and leaving it restores the moon and sets the clock hour', () => {
    expect(TIME_OPTIONS).toContain('Night');
    const s = sanitizeRaceSettings({ lastSelection: { paintId: 'signal', number: 1, gogglesId: 'strap-amber', sea: 'Calm', time: 'Night', rivals: 'National' } });
    expect(s.lastSelection?.time).toBe('Night');
    const sky = { ...skyParams, timeOfDay: 15 };
    const before = { ...sky };
    applyRaceTime('Night', sky);
    expect(sky).toEqual({ ...before, ...MOONLIT_NIGHT });
    applyRaceTime('Night', sky); // twice: the first snapshot is kept
    applyRaceTime('17:30', sky);
    expect(sky).toEqual({ ...before, timeOfDay: 17.5 });
  });

  it('the clock labels drive the sky, and the default label is the look the page always had (perf baseline)', () => {
    expect(TIME_OPTIONS).toEqual(['06:30', '12:00', '15:00', '17:30', 'Night']);
    expect(DEFAULT_SELECTION.time).toBe('15:00');
    const sky = { ...skyParams, timeOfDay: 9 };
    applyRaceTime(DEFAULT_SELECTION.time, sky);
    expect(sky.timeOfDay).toBe(skyParams.timeOfDay); // params default 15.0, untouched by the race
    applyRaceTime('06:30', sky);
    expect(sky.timeOfDay).toBe(6.5);
    applyRaceTime('garbage', sky);
    expect(sky.timeOfDay).toBe(6.5);
  });

  it('free roam\'s pause has a Time row the page applies (same path as the Sea row)', () => {
    expect(raceUiSrc).toMatch(/onTime: free\s*\?/);
    expect(raceUiSrc).toMatch(/time: selection\.time/);
    expect(mainSrc).toMatch(/onTime: \(t\) => applyRaceTime\(t\)/);
    expect(mainSrc).toMatch(/applyRaceTime\(sel\.time\)/);
  });
});

describe('T209 night clouds take the moonlight', () => {
  it('day and the full-moon night are untouched; the race night (gibbous, turned down) dims the lit faces and the fill', async () => {
    const { moonlightDeficit, resolveCloudPalette, resolveDomeAmbient, resolveKeyTint } = await import('../src/clouds/cloudPalette');
    const { cloudParams } = await import('../src/params/clouds');
    const restore = { t: skyParams.timeOfDay, ph: skyParams.moonPhase, i: skyParams.moonIntensity };
    const key = new THREE.Color();
    const dome = new THREE.Color();
    const sun = new THREE.Color();
    const sky = new THREE.Color();
    const at = (t: number, ph: number, intensity = restore.i) => {
      skyParams.timeOfDay = t;
      skyParams.moonPhase = ph;
      skyParams.moonIntensity = intensity;
      resolveDomeAmbient(dome);
      resolveKeyTint(key);
      resolveCloudPalette(cloudParams, key, dome, sun, sky);
      return { deficit: moonlightDeficit(t, cloudParams.nightFullMoonKey), sunL: sun.r + sun.g + sun.b, skyL: sky.r + sky.g + sky.b, blueShift: sun.b / Math.max(sun.r, 1e-6) };
    };
    try {
      expect(at(12, 0.5).deficit).toBe(0);
      expect(at(17.3, 0.25).deficit).toBe(0); // sunset: the sun still owns it
      const full = at(MOONLIT_NIGHT.timeOfDay, 0.5);
      expect(full.deficit).toBe(0);
      const half = at(MOONLIT_NIGHT.timeOfDay, MOONLIT_NIGHT.moonPhase, MOONLIT_NIGHT.moonIntensity);
      expect(half.deficit).toBeGreaterThan(0.7);
      expect(half.sunL).toBeLessThan(full.sunL * 0.5);
      expect(half.skyL).toBeLessThan(full.skyL * 0.5);
      expect(half.blueShift).toBeGreaterThan(full.blueShift); // silvered toward the moon's blue, not a grey dim
    } finally {
      skyParams.timeOfDay = restore.t;
      skyParams.moonPhase = restore.ph;
      skyParams.moonIntensity = restore.i;
    }
  });
});
