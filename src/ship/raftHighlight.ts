/**
 * §T.155 — A GLOW ROUND THE THING YOU ARE ABOUT TO TOUCH.
 *
 * USER: "everything that can be interacted with could use a little bit of a
 * shader outline while we're seeing the interaction prompt — it would make it
 * clear, okay, this is the tiller you're looking at, this is the sail."
 *
 * WHY THIS IS NOT A NEW MATERIAL AND NOT A POST PASS. §T.79 shares one
 * material per KIND across 94 meshes, so lighting "the tiller" by tinting its
 * material lights every steering oar, log and plank that shares it; a material
 * per station would add ~18 pipelines to a boot §T.128/§T.133 spent 40 s
 * rescuing, and a full-screen outline pass would cost a target and a depth
 * read against the §V17 budget for one small affordance.
 *
 * What the raft already has is PER-OBJECT uniforms — `objectGroup` +
 * `onObjectUpdate`, the path §T.147's per-piece seed rides (raftMaterialNodes)
 * — so one more scalar on that group lights exactly one mesh with no new
 * material, no new pipeline and no new pass.
 *
 * §B70 IS THE TRAP HERE, and it is why the rim is folded into `emissiveNode`
 * rather than parked beside it: three only runs a uniform's `onObjectUpdate`
 * if the SHADER REFERENCES that uniform. A highlight uniform nothing reads is
 * a uniform nothing updates — §V62's shape, a control wired to nothing that
 * looks fine because the glow was never going to appear anyway.
 *
 * The state is module-level for the same reason `raftActions.radio` is: the
 * focus is one thing, the frame writes it once, and every material asks the
 * same question of it (§V95).
 */
import * as THREE from 'three';
import {
  cameraPosition,
  color,
  float,
  normalWorld,
  objectGroup,
  positionWorld,
  uniform,
} from 'three/tsl';
import { pieceIdOfMesh } from './raftMaterialNodes';
import type { AnyNode } from './raftMaterialNodes';

/** the piece the walker is being offered, and how far its glow has faded in */
let focusPiece: string | null = null;
let focusStrength = 0;

/**
 * The frame's one write. `strength` is the plaque's own fade (§T.116's 0.15 s),
 * so the outline arrives and leaves WITH the prompt rather than on a second
 * timer that can disagree with it.
 */
export function setRaftHighlight(pieceId: string | null, strength: number): void {
  focusPiece = pieceId;
  focusStrength = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0;
}

/** what the shader is currently told to light — the §V62 read-back */
export function raftHighlightState(): { piece: string | null; strength: number } {
  return { piece: focusPiece, strength: focusStrength };
}

/** 0..1 for one piece id, the value the per-object uniform takes */
export function highlightOf(pieceId: string): number {
  return focusPiece !== null && pieceId === focusPiece ? focusStrength : 0;
}

export interface HighlightNodes {
  /** add this to a material's `emissiveNode` */
  rim: AnyNode;
  /** the per-object scalar, exposed for tests */
  amount: ReturnType<typeof uniform>;
}

/**
 * THE SILHOUETTE, not a tint. `1 − |n·v|` is ~0 where the surface faces the
 * lens and ~1 where it turns away from it, which is exactly the outline of the
 * piece as drawn — every edge of it, from any angle, with no second pass and
 * no knowledge of the shape. Raised to a power so the band stays narrow
 * instead of washing the whole object.
 */
export function createHighlightNodes(): HighlightNodes {
  const amount = uniform(0).setGroup(objectGroup);
  amount.onObjectUpdate(({ object }: { object: THREE.Object3D | null }) => {
    amount.value = object === null || object === undefined
      ? 0
      : highlightOf(pieceIdOfMesh(object.name));
  });
  const view = cameraPosition.sub(positionWorld).normalize();
  const facing = normalWorld.dot(view).abs().clamp(0, 1);
  const rimBand = float(1).sub(facing).pow(RIM_POWER);
  return {
    rim: color(RIM_COLOR).mul(rimBand).mul(amount).mul(RIM_GAIN) as unknown as AnyNode,
    amount,
  };
}

/** brass, the colour every affordance on this HUD is already drawn in (§V21) */
const RIM_COLOR = 0xdfc06d;
/** narrow enough to read as an outline rather than a wash */
const RIM_POWER = 2.2;
/** additive, so it survives a dark cabin and a bright deck alike */
const RIM_GAIN = 2.4;
