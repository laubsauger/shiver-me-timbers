# Retained wake lace orientation

2026-09-15. Vessel path only; no changes to the other agent's spray, lighting,
transom sources or reflection work.

## Problem and change

`wakeWhiteNode` projected every fragment into the current player's heading.
Steering therefore rotated procedural detail across old foam and rival trails,
even though their coverage already belonged to retained world-space emissions.

The far accumulation tier has no surface slope, leaving its .ba channels free.
They now store a foam-weighted line orientation:
`coverage * (cos(2θ), sin(2θ))`. Prop wash, exhaust and appendage sources use
their own jet axes. Retained chine packets use their recorded axes. The
pressure/breaking contribution uses the existing local blend of vessel velocity.
Every contribution is weighted by its actual foam injection rate.

The moments undergo the same advection lookup, foam decay, saturation scaling
and diffusion as coverage. Both added channels use the foam source duration;
slick retains its separate duration. Empty, newly exposed cells have no moments.
The near tier still stores instantaneous water slope in .ba.

The material divides the stored moments by coverage. Opposite travel directions
share an axis; equal perpendicular crossings lose anisotropy. Coordinates use a
symmetric stretch rather than extracting an angle, avoiding a phase flip at
±90°. Zero directional evidence produces isotropic detail, not a guessed heading.

## Evidence

- Six algebra regressions cover retention, rivals, opposite directions,
  crossing weights, saturation, zero speed and the ±90° coordinate boundary.
- Eight real WebGPU assertions in `wake-orientation-probe.html` exercise the
  production accumulation kernels: explicit channel timing, saturation,
  one second of source-free decay, a four-texel region shift and empty new cells.
  All pass. The probe caught an early integration error where vec2 source timing
  padded to vec4 and incorrectly scaled the added channels; explicit packing fixed it.
- Full-game far texture after a controlled 12 m/s tow: 154 cells above 0.01
  coverage, all with coherent orientation; maximum normalized moment 0.9999944.
- Actual `wakeWhiteNode` render, fixed foam inputs and retained texture: a
  2 m / 128 pixel patch spans values 0–0.974718. Changing only the player's
  heading and updating at dt=0 gives **zero maximum pixel difference**.
  This is resolved lace (1.5625 cm/pixel), not an unresolved mean-color test.
- Compiled ocean binding inspection finds one far-texture sample binding and
  its one sampler. The additional material call site reuses those objects.
- 114 tests pass across orientation, wake simulation, readability, binding
  budget and flowfoam. TypeScript and diff whitespace checks pass.
- `wake-orientation-after.png` shows the combined game, including the concurrent
  spray work. `wake-orientation-water-only.png` hides airborne particles only
  for inspection of the water beneath. These are integration checks, not matched
  performance measurements or approval of the other agent's spray appearance.

## Cost and limits

No new texture allocation, compute dispatch, draw call or CPU history. The far
pass transports two additional values in its already allocated RGBA32F textures
and adds source moment arithmetic. The material adds a far-texture lookup and
coordinate arithmetic, with no additional noise octaves or texture bindings.
No FPS improvement is claimed.

Direction is retained at the far tier's coarse resolution; it is not a new
centimetre-scale velocity solver. Intersecting wakes blend rather than retaining
independent procedural layers. The single-hull sim path retains its previous
heading-based shading. Moving impact timing and rival transom/spray appearance
remain separate review items under the ongoing source work.


## Follow-up correction

The initial symmetric coordinate transform removed heading flips but introduced
world-position-dependent stretching where the retained direction varied. It is
superseded by fixed-axis field blending in [stern-wash.md](stern-wash.md). Storage,
source moments and history transport remain as described above. The material now
adds one noise octave, so the earlier no-additional-octaves statement describes
only the initial implementation.
