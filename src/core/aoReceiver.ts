/**
 * B124: THE SEA DOES NOT RECEIVE SCREEN-SPACE AMBIENT OCCLUSION.
 *
 * THE DEFECT (user, speedboat trailer 1080p N=16, pirate mode too): rows of blocky dark bars on the far water, hugging
 * the horizon, strongest into a bright sun road, with nothing above the surface to cause them. Bisected on one frozen
 * frame (docs/ocean/reflection-b124-b125.md): sun glitter, the planar reflection (live and strength), far normals,
 * refraction, foam, haze, a flat sea, the radial LOD, god rays, bloom, DoF, grain and hiding every scene group leave
 * them; `aoStrength 0` alone removes them.
 *
 * WHY. The ocean writes depth (surfaceMaterial.ts, §V28 early-Z at a 4.6 km rim), so GTAO marches the water surface
 * itself. At a grazing angle a kilometre out, a half-resolution march over depth-RECONSTRUCTED normals of a displaced
 * sheet sees its own neighbouring texels as occluders, and the half-res result lands on the frame as blocks. It is also
 * the wrong term there at any distance: hemisphere AO darkens diffuse irradiance, and this surface is unlit pigment,
 * Fresnel reflection and transmission (§V20, §V24) — what would occlude its reflection is reflected-ray visibility,
 * which the planar mirror already carries.
 *
 * THE RULE. AO applies to the surfaces that receive it. Each draw writes its AO receptivity into one extra 8-bit target
 * of the scene pass, carried by its own alpha, so a transparent sheet replaces what is under it only as far as it
 * covers: the ocean writes 0, everything else 1. The hull keeps its contact shading AGAINST the water (her pixels still
 * march the water's depth); the water in front of her no longer takes the occlusion of itself. Where the hull volume
 * mask draws the sea at opacity 0 (inside a cockpit) the mask stays what the hull wrote.
 *
 * WHY NOT material.mrtNode ON THE OCEAN. three r180 makes a material's mrtNode its WHOLE output whenever it renders
 * into a target without an MRT (NodeMaterial.setupOutput) — any such pass would draw the sea as a mask. The receptivity
 * is decided per material inside the pass's own MRT node instead, at build time, and exists only there.
 */
import { Fn, output, vec3, vec4 } from 'three/tsl';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union
type TslNode = any;

/** the scene pass MRT attachment name */
export const AO_RECEIVER_OUTPUT = 'aoReceiver';
const EXEMPT_KEY = 'aoExempt';

/** mark a material as NOT receiving screen-space AO (its pixels keep their colour under the AO multiply) */
export function markAoExempt(material: { userData: Record<string, unknown> }): void {
  material.userData[EXEMPT_KEY] = true;
}

/** 1 for a material that receives AO, 0 for one marked exempt */
export function aoReceptivity(material: { userData?: Record<string, unknown> } | null | undefined): 0 | 1 {
  return material?.userData?.[EXEMPT_KEY] === true ? 0 : 1;
}

/**
 * The MRT value for {@link AO_RECEIVER_OUTPUT}: this draw's receptivity, covered by its own output alpha. Decided per
 * material when its pipeline is built (the Fn runs in each material's builder).
 */
export const aoReceiverNode: TslNode = Fn((builder: TslNode) =>
  vec4(vec3(aoReceptivity(builder.material)), output.a),
)();
