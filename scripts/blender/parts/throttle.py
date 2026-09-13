"""
Throttle quadrant for three engines + trim (REFERENCES c7 Zero Effort geometry, concept 05 far right).
Mounted on a pedestal against the starboard well wall at the pilot's right hand (socket: eye + well
side). Brushed alloy base plate with four slots and screws, three ganged throttle levers with red
anodised handles and a tie bar, one short trim lever with a black knob and thumb rocker, pivot boss.
Its own node (`animRole: throttle`, pivot + axis, lever travel); levers built at idle.
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo, Piece


def build(A, base=False):
    """base=True: the static pedestal/plate (joins the merged Parts node); False: the moving levers"""
    W = A.cockpit_well()
    eye = Vector(A.eye())
    x0 = -(W['halfWidth'] - 0.13)
    y0 = A.deck_y - 0.20
    z0 = eye.z + 0.24
    M = Matrix.Translation((x0, y0, z0)) @ kit.rot('Z', 8)  # plate rolled toward the pilot
    pieces = []
    ped = kit.box(0.16, 0.30, 0.30, center=(-0.01, -0.15, 0.0))
    ped.extend(kit.box(0.20, 0.02, 0.34, center=(-0.02, 0.0, 0.0)))
    pieces.append(Piece('pedestal', ped.transform(M), 'M_Carbon', 'carbon', max_lod=1, bevel=(0.006, 2), smooth=35, tier='cockpit'))
    plate = kit.box(0.15, 0.012, 0.26, center=(0, 0.016, 0))
    slots = Geo()
    fast = []
    for k, xs in enumerate((-0.045, -0.015, 0.015, 0.05)):
        slots.extend(kit.box(0.008, 0.0015, 0.17, center=(xs, 0.0228, 0.0)))
    for (sx, sz) in ((0.063, 0.115), (-0.063, 0.115), (0.063, -0.115), (-0.063, -0.115)):
        fast.append((tuple(M @ Vector((sx, 0.022, sz))), (0, 1, 0), 0.004, 'screw', False))
    pieces.append(Piece('plate', plate.transform(M), 'M_Metal', 'alu_bare', max_lod=1, bevel=(0.004, 2), smooth=35, tier='cockpit', fasteners=fast))
    pieces.append(Piece('slots', slots.transform(M), 'M_Carbon', 'vent_black', max_lod=0, smooth=35, tier='cockpit'))
    levers = Geo()
    handles = Geo()
    idle = -28.0
    pivot_local = Vector((0, 0.0, -0.02))
    for k, xs in enumerate((-0.045, -0.015, 0.015)):
        R = Matrix.Translation(pivot_local) @ kit.rot('X', idle)
        lv = kit.box(0.006, 0.20, 0.018, center=(xs, 0.10, 0.0))
        levers.extend(lv.transform(M @ R))
        hd = kit.box(0.026, 0.06, 0.04, center=(xs, 0.215, 0.006))
        handles.extend(hd.transform(M @ R))
    tie = kit.cylinder(0.006, 0.07, segs=10, axis='x').translate((-0.05, 0.185, 0.0))
    levers.extend(tie.transform(M @ Matrix.Translation(pivot_local) @ kit.rot('X', idle)))
    Rt = Matrix.Translation(pivot_local) @ kit.rot('X', -10)
    levers.extend(kit.box(0.005, 0.12, 0.012, center=(0.05, 0.06, 0.0)).transform(M @ Rt))
    knob = kit.dome(0.017, 14, 4, h=0.022).transform(M @ Rt @ Matrix.Translation((0.05, 0.12, 0.0)))
    knob.extend(kit.box(0.012, 0.006, 0.018, center=(0.05, 0.145, 0.0)).transform(M @ Rt))
    boss = kit.cylinder(0.03, 0.12, segs=16, axis='x').transform(M @ Matrix.Translation((-0.06, 0.03, -0.02)))
    pieces.append(Piece('boss', boss, 'M_Metal', 'alu_bare', max_lod=1, smooth=45, tier='cockpit'))
    if base:
        return {'pieces': pieces, 'extras': {}}
    moving = [
        Piece('levers', levers, 'M_Metal', 'stainless_polish', max_lod=1, bevel=(0.0015, 1), smooth=40, tier='cockpit'),
        Piece('handles', handles, 'M_Cockpit', 'anod_red', max_lod=1, bevel=(0.008, 2), smooth=45, tier='cockpit'),
        Piece('trim_knob', knob, 'M_Cockpit', 'knob_black', max_lod=0, bevel=(0.001, 1), smooth=45, tier='cockpit'),
    ]
    pv = M @ pivot_local
    return {'pieces': moving, 'extras': {'animRole': 'throttle', 'pivot': list(pv), 'axis': list((M.to_3x3() @ Vector((1, 0, 0))).normalized()),
                                         'idleDeg': idle, 'fullDeg': 32.0}}
