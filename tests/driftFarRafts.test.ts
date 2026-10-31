/**
 * The other rafts at sea in c2–c4 (src/drift/wandering/farRafts.ts; direction.md C2: "other rafts and small vessels far
 * off on the horizon, each alone, all drifting the same way"). The user could not read them on a c2 sunset frame
 * (2026-10-30: "Are these pirate ships, or two other rafts?"): five copies of our raft as specks at 950–2100 m, two of
 * them behind our own sail. What must hold, whatever they are tuned to:
 *
 *   - some come near enough to read (200–350 m: our raft's 8.3 m is then ~1.4–2.4°, its square sail and hut a
 *     silhouette; at 480 m it was a speck again in the 16:9 frame), in the front half of the dome where the eye
 *     looks, and not behind our raft (24° right of the front at 15 m, its sail and logs covering ~0–50° right in c2);
 *   - the rest stay far, and their sizes vary;
 *   - none stands on a Rose station's bearing (their islands are 7 km off, ±4°), nor on the eye's own way ahead.
 * And (2026-10-31, the sea's first shot: two copies of our raft "doing stuff" in the distance, read as our main
 * character duplicated, and one popping in mid-shot):
 *   - NONE IS OUR RAFT: each is a craft of its own kind, well smaller than ours, more than one kind;
 *   - they belong to c2–c4: nothing of them before c2 starts, and they come in gradually, never in a frame.
 */
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { FAR_CRAFT_SIZE, FAR_FADE, FAR_RAFTS, OUR_RAFT, ROSE_CLEAR, createFarCraft, createFarCraftLook, farRaftsIn } from '../src/drift/wandering/farRafts';
import { STATIONS } from '../src/drift/wandering/props';

const apart = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

describe('the other rafts', () => {
  it('bring some near enough to read, in front, clear of our own raft', () => {
    const near = FAR_RAFTS.filter((f) => f.distance >= 200 && f.distance <= 350);
    expect(near.length).toBeGreaterThanOrEqual(2);
    for (const f of near) {
      expect(Math.abs(f.bearing)).toBeLessThan(90);
      expect(f.bearing < -5 || f.bearing > 55).toBe(true);
    }
  });

  it('keep the rest far off, and vary in size', () => {
    expect(FAR_RAFTS.filter((f) => f.distance > 1000).length).toBeGreaterThanOrEqual(2);
    const lengths = FAR_RAFTS.map((f) => FAR_CRAFT_SIZE[f.kind].length * f.scale);
    expect(Math.max(...lengths) / Math.min(...lengths)).toBeGreaterThanOrEqual(1.5);
  });

  it('are never our raft: other kinds, more than one, each well smaller than ours (as built, not as declared)', () => {
    expect(new Set(FAR_RAFTS.map((f) => f.kind)).size).toBeGreaterThanOrEqual(2);
    const look = createFarCraftLook();
    for (const f of FAR_RAFTS) {
      const craft = createFarCraft(f.kind, look, () => 0);
      craft.group.scale.setScalar(f.scale);
      craft.update(0, 0, 0, 0);
      const box = new THREE.Box3().setFromObject(craft.group);
      const size = box.getSize(new THREE.Vector3());
      expect(size.z).toBeLessThanOrEqual(FAR_CRAFT_SIZE[f.kind].length * f.scale * 1.05);
      expect(box.max.y).toBeLessThanOrEqual(FAR_CRAFT_SIZE[f.kind].height * f.scale * 1.05);
      expect(size.z).toBeLessThan(OUR_RAFT.length * 0.6);
      expect(box.max.y).toBeLessThan(OUR_RAFT.height * 0.85);
    }
  });

  it('belong to c2–c4: none before c2, and they come up gradually, never in one frame', () => {
    const c2 = 41;
    for (const t of [0, 20, 40.99, 41]) expect(farRaftsIn(t, c2)).toBe(0);
    expect(farRaftsIn(c2 + FAR_FADE, c2)).toBe(1);
    expect(farRaftsIn(c2 + 100, c2)).toBe(1);
    let worst = 0;
    for (let t = c2 - 1; t < c2 + FAR_FADE + 1; t += 1 / 30) worst = Math.max(worst, farRaftsIn(t + 1 / 30, c2) - farRaftsIn(t, c2));
    expect(worst).toBeLessThan(0.02);
  });

  it('stand on no Rose station\'s bearing and not on the eye\'s way ahead', () => {
    for (const f of FAR_RAFTS) {
      for (const s of STATIONS) expect(apart(f.bearing, s)).toBeGreaterThanOrEqual(ROSE_CLEAR);
      expect(Math.abs(f.bearing)).toBeGreaterThanOrEqual(10);
    }
  });
});
