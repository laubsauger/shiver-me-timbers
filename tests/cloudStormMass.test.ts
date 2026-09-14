import { describe, expect, it } from 'vitest';
import { attachStormLobes, generateClusters, type CloudCluster, type CloudLobe } from '../src/clouds/cloudCores';
import { cloudParams, type CloudParams } from '../src/params/clouds';
import { weatherPresets } from '../src/weather/presets';

const defaults = { ...cloudParams };

// Undisplaced ellipsoid support is a layout diagnostic, not an exact test of
// the noise-displaced mesh. Use all three axes: a spherical radius test hides
// gaps between the deliberately flattened lobes.
function overlaps(a: CloudLobe, b: CloudLobe): boolean {
  return Math.hypot(
    (a.x - b.x) / (a.rx + b.rx),
    (a.y - b.y) / (a.ry + b.ry),
    (a.z - b.z) / (a.rz + b.rz),
  ) < 1;
}

function support(clusters: CloudCluster[]) {
  let total = 0;
  let detached = 0;
  let mainMass = 0;
  for (const c of clusters) {
    total += c.lobes.length;
    detached += c.lobes.filter(a => !c.lobes.some(b => a !== b && overlaps(a, b))).length;
    const remaining = new Set(c.lobes);
    let largest = 0;
    while (remaining.size) {
      const queue = [remaining.values().next().value!];
      remaining.delete(queue[0]);
      for (let i = 0; i < queue.length; i++) {
        for (const b of remaining) {
          if (overlaps(queue[i], b)) {
            remaining.delete(b);
            queue.push(b);
          }
        }
      }
      largest = Math.max(largest, queue.length);
    }
    mainMass += largest;
  }
  return { detached: detached / total, mainMass: mainMass / total };
}

function ensemble(p: CloudParams) {
  return Array.from({ length: 20 }, (_, i) => generateClusters(i + 1, p, () => 1)).flat();
}

describe('storm cloud mass at shipped instance counts', () => {
  it('global storm retains one dominant mass across seeds', () => {
    const measured = support(ensemble({ ...defaults, ...weatherPresets.storm.clouds }));
    // Previous shipped preset: most lobes were isolated. This also rejects
    // a sky made of overlapping pairs that never join the main cloud.
    expect(measured.detached).toBe(0);
    expect(measured.mainMass).toBe(1);
  });

  it('local storm growth retains overlap without adding instances', () => {
    const measured = support(ensemble(defaults));
    expect(measured.detached).toBe(0);
    expect(measured.mainMass).toBe(1);
    for (const seed of [1, 7, 11, 1337]) {
      const fair = generateClusters(seed, defaults, () => 0);
      const storm = generateClusters(seed, defaults, () => 1);
      expect(storm.map(c => c.lobes.map(l => l.seed))).toEqual(
        fair.map(c => c.lobes.map(l => l.seed)),
      );
    }
  });

  it('global storm uses its authored radius and base once', () => {
    const p = { ...defaults, ...weatherPresets.storm.clouds };
    for (const c of ensemble(p)) {
      expect(c.radius).toBeGreaterThanOrEqual(p.clusterRadiusMin);
      expect(c.radius).toBeLessThanOrEqual(p.clusterRadiusMax);
      expect(c.base).toBeGreaterThanOrEqual(p.altitudeMin);
      expect(c.base).toBeLessThanOrEqual(p.altitudeMax);
    }
  });

  it('leaving storm restores local-cell growth for every other preset', () => {
    for (const [name, patch] of Object.entries(weatherPresets)) {
      if (name === 'storm') continue;
      const transitioned = { ...defaults, ...weatherPresets.storm.clouds, ...patch.clouds };
      const direct = { ...defaults, ...patch.clouds };
      expect(generateClusters(7, transitioned, () => 1)).toEqual(
        generateClusters(7, direct, () => 1),
      );
    }
  });
});


it('storm attachment preserves fair placement and existing lobe sizes/seeds', () => {
  const original = generateClusters(7, defaults, () => 0)[0].lobes;
  const fair = structuredClone(original);
  attachStormLobes(fair, 0);
  expect(fair).toEqual(original);
  const storm = structuredClone(original);
  attachStormLobes(storm, 1);
  expect(storm.map(({ x, y, z, ...rest }) => rest)).toEqual(
    original.map(({ x, y, z, ...rest }) => rest),
  );
  expect(support([{ lobes: storm } as CloudCluster]).mainMass).toBe(1);
});


it('storm growth does not switch parents during a gradual weather change', () => {
  const p = { ...defaults, ...weatherPresets.storm.clouds };
  for (const seed of [1, 7, 11, 1337]) {
    let previous = generateClusters(seed, p, () => 0);
    for (let step = 1; step <= 100; step++) {
      const next = generateClusters(seed, p, () => step / 100);
      for (let c = 0; c < next.length; c++) for (let l = 0; l < next[c].lobes.length; l++) {
        const a = previous[c].lobes[l], b = next[c].lobes[l];
        // A 1% weather change must not teleport a lobe across its cloud.
        // Nearest-parent selection produced jumps > 0.3 cluster radii.
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / next[c].radius).toBeLessThan(0.05);
      }
      previous = next;
    }
  }
});
