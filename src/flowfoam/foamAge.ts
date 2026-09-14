import { float, mix } from 'three/tsl';

/** Blend measured ages using the coverage each source contributes to the image. */
export function coverageWeightedAgeNode(
  coverageA: any, ageA: any, coverageB: any, ageB: any,
): any {
  // A zero-coverage source has no say in the visible age. The denominator
  // floor only defines the empty limit, where the final foam opacity is zero.
  return coverageA.mul(ageA).add(coverageB.mul(ageB))
    .div(coverageA.add(coverageB).max(1e-8));
}


/** Keep unknown analytic wake age separate from measured contact/shore age. */
export function foamSourceAgesNode(
  coverage: any, measuredWakeAge: any | null,
  contactShare: any, shoreShare: any, shoreAge: any,
): { body: any; edge: any; lighting: any } {
  const shoreWeight = shoreShare.mul(contactShare.oneMinus());
  const blend = (base: any) => mix(mix(base, float(1), contactShare), shoreAge, shoreWeight);
  // These are the existing analytic material laws, not invented ages:
  // coverage selects its body pattern; its torn edge stays resolved; its
  // lighting stays wake-coloured. Only real source coverage can change them.
  return {
    body: blend(measuredWakeAge ?? coverage),
    edge: blend(measuredWakeAge ?? float(1)),
    lighting: blend(measuredWakeAge ?? float(0)),
  };
}
