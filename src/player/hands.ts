/**
 * Placeholder hands (§T.95): two low-poly mitts — a box palm and four finger
 * boxes each, ~120 triangles a hand — parented to the camera. Three poses
 * (idle / grab / turn) blended over `playerParams.handPoseTime`; `turn`
 * rotates the held (right) hand about its forearm axis by the channel delta
 * the station reported. The pose math is `handPoses.ts`; this file owns
 * only the Object3Ds and a plain node material, no new shader.
 */
import * as THREE from 'three/webgpu';
import { playerParams } from '../params/player';
import { HandBlend, turnAngle, type HandPose, type Side } from './handPoses';

export interface Hands {
  /** parent this to the camera */
  readonly group: THREE.Group;
  setPose(pose: HandPose): void;
  /** accumulated wrist angle of the held hand, radians */
  setTurn(angle: number): void;
  /** add a channel delta's worth of wrist turn (× playerParams.handTurnGain) */
  turnBy(channelDelta: number): void;
  update(dt: number): void;
  dispose(): void;
}

function mitt(side: Side, material: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.name = `hand-${side}`;
  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.025, 0.09), material);
  g.add(palm);
  const fingerGeo = new THREE.BoxGeometry(0.016, 0.018, 0.05);
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(fingerGeo, material);
    f.position.set(-0.03 + i * 0.02, 0, -0.065);
    f.rotation.x = 0.35;
    g.add(f);
  }
  // the thumb is the fifth box, on the inboard side
  const thumb = new THREE.Mesh(fingerGeo, material);
  thumb.position.set(side === 'left' ? 0.05 : -0.05, 0, -0.02);
  thumb.rotation.y = side === 'left' ? -0.8 : 0.8;
  g.add(thumb);
  return g;
}

export interface HandsOptions {
  /**
   * §T.127: true → the mitts stop drawing. Wire to `ui.isPhotoMode()`.
   *
   * PHOTO MODE ONLY, not full-screen cinematic: cinematic IS full screen (§I
   * ui/cinematic) and most people PLAY full screen, so hiding the hands there
   * would take them out of normal play. Photo mode is the deliberate "I am
   * taking a frame" gesture — the same call the raft prompts already make.
   *
   * A PREDICATE, not a boolean: the mode is a live thing the player toggles
   * with a key, and a boolean captured here is §V62's exact shape (a value
   * read once at construction into a closure).
   */
  hidden?: () => boolean;
}

export function createHands(opts: HandsOptions = {}): Hands {
  const material = new THREE.MeshStandardNodeMaterial({ color: 0xb98a62, roughness: 0.85, metalness: 0 });
  const group = new THREE.Group();
  group.name = 'hands';
  const sides: Side[] = ['left', 'right'];
  const nodes: Record<Side, THREE.Group> = { left: mitt('left', material), right: mitt('right', material) };
  const blends: Record<Side, HandBlend> = { left: new HandBlend('left'), right: new HandBlend('right') };
  group.add(nodes.left, nodes.right);
  let turn = 0;
  const apply = (): void => {
    // re-read every tick: the answer changes when the player presses P, and
    // the group is the one thing that decides whether a capture has mitts in it
    group.visible = !(opts.hidden?.() ?? false);
    for (const s of sides) {
      const t = blends[s].current(playerParams.handPoseTime);
      nodes[s].position.set(t.position[0], t.position[1], t.position[2]);
      nodes[s].rotation.set(t.rotation[0], t.rotation[1], t.rotation[2]);
      if (s === 'right' && blends[s].target === 'turn') nodes[s].rotation.z += turn;
    }
  };
  apply();
  return {
    group,
    setPose(pose) {
      for (const s of sides) blends[s].setPose(pose, playerParams.handPoseTime);
      if (pose !== 'turn') turn = 0;
    },
    setTurn(angle) {
      turn = Number.isFinite(angle) ? angle : 0;
    },
    turnBy(channelDelta) {
      turn += turnAngle(channelDelta, playerParams.handTurnGain);
    },
    update(dt) {
      for (const s of sides) blends[s].advance(dt);
      apply();
    },
    dispose() {
      group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
      });
      material.dispose();
    },
  };
}
