/**
 * Placeholder-hand pose math (§T.95), kept out of `hands.ts` so it runs with
 * no GPU: three named poses as camera-space transforms, a timed blend between
 * them, and the wrist turn a held lever imparts. `hands.ts` only copies the
 * numbers onto Object3Ds.
 *
 * Camera space: +x right, +y up, −z forward. The forearm axis is −z, so
 * `turn` rotates about z.
 */
import type { Vec3 } from './playerStep';

export type HandPose = 'idle' | 'grab' | 'turn';
export type Side = 'left' | 'right';

export interface HandTransform {
  position: Vec3;
  /** Euler XYZ, radians */
  rotation: Vec3;
}

const REST: Record<Side, HandTransform> = {
  left: { position: [-0.22, -0.25, -0.45], rotation: [0.3, 0.25, 0.1] },
  right: { position: [0.22, -0.25, -0.45], rotation: [0.3, -0.25, -0.1] },
};

/** where each mitt sits in each pose — `grab` reaches forward and closes in */
export function poseTransform(side: Side, pose: HandPose): HandTransform {
  const r = REST[side];
  const sx = side === 'left' ? -1 : 1;
  switch (pose) {
    case 'idle':
      return { position: [...r.position], rotation: [...r.rotation] };
    case 'grab':
      return { position: [sx * 0.14, -0.2, -0.55], rotation: [0.6, sx * -0.1, sx * -0.4] };
    case 'turn':
      return { position: [sx * 0.1, -0.18, -0.5], rotation: [0.5, 0, sx * -0.2] };
  }
}

export function lerpTransform(a: HandTransform, b: HandTransform, t: number): HandTransform {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const mix = (x: number, y: number): number => x + (y - x) * k;
  return {
    position: [mix(a.position[0], b.position[0]), mix(a.position[1], b.position[1]), mix(a.position[2], b.position[2])],
    rotation: [mix(a.rotation[0], b.rotation[0]), mix(a.rotation[1], b.rotation[1]), mix(a.rotation[2], b.rotation[2])],
  };
}

/** wrist angle a channel change imparts — radians per channel unit */
export function turnAngle(channelDelta: number, gain: number): number {
  const d = Number.isFinite(channelDelta) ? channelDelta : 0;
  const g = Number.isFinite(gain) ? gain : 0;
  return d * g;
}

/**
 * One hand's blend state: where it came from, where it is going, and how far
 * along. `advance` is what `hands.update(dt)` calls; `current` is what gets
 * written to the Object3D.
 */
export class HandBlend {
  private from: HandTransform;
  private to: HandTransform;
  private elapsed = Infinity;
  private pose: HandPose = 'idle';

  constructor(private side: Side) {
    this.from = poseTransform(side, 'idle');
    this.to = this.from;
  }

  get target(): HandPose {
    return this.pose;
  }

  setPose(pose: HandPose, duration: number): void {
    if (pose === this.pose) return;
    this.from = this.current(duration);
    this.to = poseTransform(this.side, pose);
    this.pose = pose;
    this.elapsed = 0;
  }

  advance(dt: number): void {
    if (Number.isFinite(dt) && dt > 0) this.elapsed += dt;
  }

  current(duration: number): HandTransform {
    const d = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const t = d === 0 ? 1 : this.elapsed / d;
    return lerpTransform(this.from, this.to, t);
  }

  /** true once the blend has arrived */
  settled(duration: number): boolean {
    return this.elapsed >= duration;
  }
}
