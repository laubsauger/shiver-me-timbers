/**
 * The dome master is the one frame the whole film is delivered in. If its orientation is wrong (front not
 * at the bottom, right mirrored) every shot is wrong on every dome, and nobody sees it until a dome booking.
 * These pin the convention studio-world already plays (and verified against the Paul Bourke charts):
 * zenith at the centre, front at the bottom, viewer-right at frame-right, radius linear in zenith angle.
 */
import { describe, expect, it } from 'vitest';
import { domeBasis, domeMasterDirection, type Vec3 } from '../src/cine/domeMaster';

const close = (a: Vec3, b: Vec3): void => {
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], 9);
};
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** studio-world's forward mapping, copied (src/engine/surfaces/domeWarp.ts domeMasterUV) */
function studioWorldUV(dir: Vec3, frame: { axis: Vec3; front: Vec3 }): { u: number; v: number } {
  const { axis, front } = frame;
  const right: Vec3 = [
    front[1] * axis[2] - front[2] * axis[1],
    front[2] * axis[0] - front[0] * axis[2],
    front[0] * axis[1] - front[1] * axis[0],
  ];
  const sinEl = Math.max(-1, Math.min(1, dot(dir, axis)));
  const el = Math.asin(sinEl);
  const h: Vec3 = [dir[0] - axis[0] * sinEl, dir[1] - axis[1] * sinEl, dir[2] - axis[2] * sinEl];
  const az = Math.atan2(dot(h, right), dot(h, front));
  const r = (1 - el / (Math.PI / 2)) * 0.5;
  return { u: 0.5 + r * Math.sin(az), v: 0.5 - r * Math.cos(az) };
}

describe('dome master orientation', () => {
  it('centre is the zenith, bottom edge is the front, right edge is the viewer right', () => {
    close(domeMasterDirection(0.5, 0.5)!.dir, [0, 1, 0]);
    close(domeMasterDirection(0.5, 0)!.dir, [0, 0, -1]); // front of a camera looks down −Z
    close(domeMasterDirection(1, 0.5)!.dir, [1, 0, 0]);
    close(domeMasterDirection(0, 0.5)!.dir, [-1, 0, 0]);
    close(domeMasterDirection(0.5, 1)!.dir, [0, 0, 1]); // top edge is behind
  });

  it('radius is linear in zenith angle (equidistant), and the corners are outside the dome', () => {
    for (const r of [0.05, 0.125, 0.25, 0.4, 0.5]) {
      const d = domeMasterDirection(0.5, 0.5 - r)!;
      expect(d.el).toBeCloseTo((1 - r / 0.5) * (Math.PI / 2), 12);
    }
    expect(domeMasterDirection(0, 0)).toBeNull();
    expect(domeMasterDirection(1, 1)).toBeNull();
  });

  it('is the exact inverse of studio-world’s playback mapping, tilted or not', () => {
    for (const tilt of [0, 15, 30]) {
      const frame = domeBasis(tilt);
      for (let i = 0; i < 200; i++) {
        // deterministic spread over the disc
        const a = i * 2.399963;
        const r = 0.5 * Math.sqrt((i + 0.5) / 200);
        const u = 0.5 + r * Math.cos(a);
        const v = 0.5 + r * Math.sin(a);
        const { dir } = domeMasterDirection(u, v, tilt)!;
        expect(Math.hypot(...dir)).toBeCloseTo(1, 12);
        const back = studioWorldUV(dir, frame);
        expect(back.u).toBeCloseTo(u, 9);
        expect(back.v).toBeCloseTo(v, 9);
      }
    }
  });

  it('a tilted dome leans its zenith toward the front, and the front horizon drops below the eye', () => {
    const zen = domeMasterDirection(0.5, 0.5, 15)!.dir;
    expect(zen[2]).toBeLessThan(0); // toward −Z, the front
    expect(Math.acos(zen[1]) * (180 / Math.PI)).toBeCloseTo(15, 9);
    const frontHorizon = domeMasterDirection(0.5, 0, 15)!.dir;
    expect(frontHorizon[1]).toBeLessThan(0);
    const backHorizon = domeMasterDirection(0.5, 1, 15)!.dir;
    expect(backHorizon[1]).toBeGreaterThan(0);
  });
});
