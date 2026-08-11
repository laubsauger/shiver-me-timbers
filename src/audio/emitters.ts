/**
 * Spatialisation primitives: the WebAudio listener (driven by the render
 * camera) and world-positioned PannerNodes.
 *
 * Deliberately NOT three.js `PositionalAudio`/`AudioListener`: those need the
 * emitters to be Object3Ds inside the scene graph (owned by main.ts) and
 * three's global AudioContext, while everything else here already lives on our
 * own context and bus graph. Raw panners fed with world positions that main.ts
 * already computes keep the ownership boundary clean and the per-frame cost at
 * a handful of AudioParam writes.
 *
 * Both the listener and the panners use the modern AudioParam interface where
 * available and fall back to the deprecated setPosition/setOrientation on
 * engines that lack it.
 */
import { audioParams as p } from '../params/audio';

export interface ListenerPose {
  px: number;
  py: number;
  pz: number;
  /** unit forward (three cameras look down their local -Z) */
  fx: number;
  fy: number;
  fz: number;
  ux: number;
  uy: number;
  uz: number;
}

/**
 * Extract a listener pose from a column-major 4x4 world matrix (i.e.
 * `camera.matrixWorld.elements`). Pure — unit-tested without three.js.
 * Turning the camera therefore turns the whole sound field, which is what
 * makes emitters localizable.
 */
export function listenerPoseFromMatrix(e: ArrayLike<number>): ListenerPose {
  const norm = (x: number, y: number, z: number): [number, number, number] => {
    const l = Math.hypot(x, y, z);
    return l > 1e-6 ? [x / l, y / l, z / l] : [0, 0, -1];
  };
  const [fx, fy, fz] = norm(-e[8], -e[9], -e[10]);
  const [ux, uy, uz] = norm(e[4], e[5], e[6]);
  return { px: e[12], py: e[13], pz: e[14], fx, fy, fz, ux, uy, uz };
}

/** minimal structural type so main.ts can pass `app.camera` unadapted */
export interface HasWorldMatrix {
  matrixWorld: { elements: ArrayLike<number> };
}

export function applyListenerPose(listener: AudioListener, pose: ListenerPose): void {
  const l = listener as AudioListener & {
    positionX?: AudioParam;
    forwardX?: AudioParam;
    setPosition?: (x: number, y: number, z: number) => void;
    setOrientation?: (
      fx: number,
      fy: number,
      fz: number,
      ux: number,
      uy: number,
      uz: number,
    ) => void;
  };
  if (l.positionX && l.forwardX) {
    l.positionX.value = pose.px;
    listener.positionY.value = pose.py;
    listener.positionZ.value = pose.pz;
    l.forwardX.value = pose.fx;
    listener.forwardY.value = pose.fy;
    listener.forwardZ.value = pose.fz;
    listener.upX.value = pose.ux;
    listener.upY.value = pose.uy;
    listener.upZ.value = pose.uz;
    return;
  }
  l.setPosition?.(pose.px, pose.py, pose.pz);
  l.setOrientation?.(pose.fx, pose.fy, pose.fz, pose.ux, pose.uy, pose.uz);
}

export function createPanner(ctx: BaseAudioContext, out: AudioNode): PannerNode {
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = p.emitterRefDistance;
  panner.maxDistance = p.emitterMaxDistance;
  panner.rolloffFactor = p.emitterRolloff;
  panner.connect(out);
  return panner;
}

/** world position write + live re-read of the distance params (§V16) */
export function setPannerPosition(panner: PannerNode, x: number, y: number, z: number): void {
  const node = panner as PannerNode & {
    positionX?: AudioParam;
    setPosition?: (x: number, y: number, z: number) => void;
  };
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return; // §V28
  if (node.positionX) {
    node.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else {
    node.setPosition?.(x, y, z);
  }
  panner.refDistance = p.emitterRefDistance;
  panner.maxDistance = p.emitterMaxDistance;
  panner.rolloffFactor = p.emitterRolloff;
}
