"""
Steering wheel + helm (concept 05: 3-spoke stainless wheel, rope/cloth-wrapped rim with an orange tape
marker at 12 o'clock; REFERENCES c1). Its own node (`animRole: wheel`, `pivot` = hub, `axis` = shaft).
Socket: cockpit_frame.Face, on the centreline in front of the eye. Rim torus wrapped in rope (a
twisted-strand look), marker tape band, three flat spokes with lightening slots modelled as insets,
hub boss with a nut, tilt-helm shaft and boot into the dash.
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo, Piece
from cockpit_frame import Face


def build(A):
    F = Face(A)
    # §T.192 ergonomics (pilot-log v2): the hub is placed from the SEAT (pan + 0.30 up, 0.50 ahead), and the shaft runs
    # from it down to the dash face just under the gauge cluster, so the axis is whatever joins the two
    hub = Vector(A.wheel_hub())
    entry = F.at(0.0, F.height - A.extra['helm']['shaftEntryBelowFaceTop'], 0.0)
    axis = (hub - entry).normalized()  # the shaft points at the pilot
    x_axis = -F.u
    M = Matrix.Translation(hub) @ kit.frame((0, 0, 0), x_axis, axis.cross(x_axis))  # local z = axis (toward the pilot)
    Rr = 0.18
    pieces = []
    rim_core = kit.torus(Rr, 0.0165, 36, 8).transform(M @ kit.rot('X', 90))  # §T.192 budget: 40 → 36 around
    pieces.append(Piece('rim_wrap', rim_core, 'M_Cockpit', 'rope_tan', max_lod=2, smooth=70, tier='cockpit', wear=1.4))
    # orange marker tape at 12 o'clock: a short sleeve
    tape_path = [tuple(M @ Vector((math.sin(a) * Rr, math.cos(a) * Rr, 0.0))) for a in [math.radians(-6 + 1.5 * i) for i in range(9)]]
    tape = kit.sweep(tape_path, 0.0185, 12)
    pieces.append(Piece('rim_tape', tape, 'M_Cockpit', 'vinyl_orange', max_lod=1, smooth=60, tier='cockpit'))
    spokes = Geo()
    for k in range(3):
        a = math.radians(90 + 120 * k)
        sp = kit.extrude([(0.035, -0.012), (Rr - 0.01, -0.016), (Rr - 0.01, 0.016), (0.035, 0.012)], 0.006)
        sp.transform(kit.rot('Z', math.degrees(a)) @ Matrix.Translation((0, 0, -0.012)))
        spokes.extend(sp.transform(M))
    boss = kit.cylinder(0.042, 0.05, segs=24, r2=0.036).transform(kit.rot('X', 90) @ Matrix.Translation((0, -0.035, 0)))
    boss.extend(kit.cylinder(0.022, 0.012, segs=18).transform(kit.rot('X', 90) @ Matrix.Translation((0, 0.015, 0))))
    pieces.append(Piece('spokes', spokes, 'M_Metal', 'stainless_polish', max_lod=2, bevel=(0.0015, 1), smooth=35, tier='cockpit'))
    pieces.append(Piece('boss', boss.transform(M), 'M_Metal', 'stainless_polish', max_lod=1, smooth=45, tier='cockpit'))
    nut = kit.hex_prism(0.016, 0.012).transform(M @ kit.rot('X', 90) @ Matrix.Translation((0, 0.026, 0)))
    pieces.append(Piece('nut', nut, 'M_Metal', 'stainless', max_lod=0, bevel=(0.001, 1), smooth=35, tier='cockpit'))
    shaft_len = (hub - entry).length + 0.02  # 2 cm into the face
    shaft = kit.cylinder(0.02, shaft_len - 0.05, segs=16).transform(M @ kit.rot('X', -90) @ Matrix.Translation((0, 0.04, 0)))
    boot = kit.revolve([(0.045, 0.0), (0.04, 0.03), (0.034, 0.045), (0.03, 0.06), (0.026, 0.075), (0.024, 0.09)], segs=18, caps=False)
    boot.transform(M @ kit.rot('X', -90) @ Matrix.Translation((0, shaft_len - 0.09, 0)))
    pieces.append(Piece('shaft', shaft, 'M_Metal', 'powder_black', max_lod=1, smooth=45, tier='cockpit'))
    pieces.append(Piece('boot', boot, 'M_Metal', 'rubber', max_lod=1, smooth=50, tier='cockpit', recalc=False))
    sockets = {'wheelRim': {'centre': [round(c, 5) for c in hub], 'axis': [round(c, 5) for c in axis], 'radius': Rr, 'tube': 0.0165,
                            'spokesDeg': [0, 120, 240], 'about': 'rim torus centre + shaft axis (toward the pilot), body frame; spokes at 12/4/8 o\'clock'}}
    return {'pieces': pieces, 'extras': {'animRole': 'wheel', 'pivot': list(hub), 'axis': list(axis)}, 'sockets': sockets}
