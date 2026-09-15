# Low-speed foam heading

The filament shader previously normalized `(velocity.x, velocity.z + 0.001)`.
The fixed northward offset changed its direction at crawling speeds and made
the stationary pattern face north regardless of the hull heading. Near a
southward speed of 0.001 m/s, it also made the vector nearly zero.

The existing hull heading now supplies a unit direction uniform independently
of speed. The same sine and cosine still form hull velocity, preserving the
simulation input. This adds a two-component uniform, removes the fragment
normalization, and adds no texture or simulation pass. No fallback direction
or new heading memory is introduced.

Regression coverage checks five headings at rest, 0.0005, 0.001, 0.002 and
20 m/s, including the former southward cancellation case. It verifies unit
length, heading alignment and unchanged velocity components.
The complete wake-foam simulation suite and ocean binding-budget suite pass
(16 tests, single worker). Cockpit light tests were separately updated for
the current per-boat LED-color API and pass (2 tests).

This small correction originally left the filament frame tied to the current
hero heading. The vessel path now retains source orientation in its existing
far accumulation texture; see `wake-retained-orientation.md` for the subsequent
implementation and GPU checks. The single-hull path keeps this unit-heading fix.
