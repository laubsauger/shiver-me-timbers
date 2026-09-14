# Night sky: horizon transition review

## Final change

The banded cloud layer retains its original range-transition span
(`bandDegenerateFade: 0.2`, approximately 3.54–4.42° at a 2 m eye height).
Only its linear interpolation changes to cubic easing with zero slope at
both endpoints. Star visibility and wind-line settings are unchanged.
No new textures or rendering passes are added.

A wider 0.6 span was tried and visually reviewed. Its improvement was marginal,
and the user preferred preserving detailed sky closer to the horizon. That
parameter change was removed. Do not describe the final patch as a wider fade.

## GPU visual review

Rendered the actual sky and cloud pipeline, including its packed cloud target,
blur and composite, at 1280 × 720 in an isolated WebGPU scene. Seed 2100,
camera height 2 m, FOV 55°, fixed time, several view bearings. Compared the
original linear 0.2 transition, the wider cubic experiment, and final cubic 0.2.
Checked both the current moonlit preset and an older brighter 22:00 night.

Disabling the cloud sheet for diagnosis removes the large wisps; these are
not primarily the separate wind-line effect. The final transition change is
subtle and does not establish that the user's whole horizon shelf is fixed.
Daylight comparison showed no obvious regression. Full-game confirmation is
still limited by the concurrent spray/DOF import mismatch: this review excludes
boats, ocean, cinematic DOF and the final game grade.

- [Original night](horizon-night-original.png)
- [Final night](horizon-night-final.png)
- [Original daylight](horizon-day-original.png)
- [Final daylight](horizon-day-final.png)

All 108 cloud and cloud-coupling tests pass, including zero slope at both
transition endpoints, zero detail in the degenerate projection, and preservation
of the distant coverage mean. No performance claim or commit.

Separate small fix: race clock parsing rejects overflowing minutes, and invalid
labels cannot disable an active night preset. Both regressions were reproduced
before the fix; the 11 clock/night tests pass.
