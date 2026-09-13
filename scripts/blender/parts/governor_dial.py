"""
The Governor's rotating dial: its own node so the runtime turns it between detents (`animRole:
governorDial`, `pivot`, `axis` = the plate normal toward the pilot, `detents` OFF/AIR/FULL in degrees
clockwise from 12 o'clock as seen from the seat). Built at AIR. Knurled black knob with a white
pointer line on a stainless skirt.
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo, Piece
import governor as GV


def build(A):
    F, M = GV.socket(A)
    d = GV.SIZE[2]
    C = M @ Matrix.Translation((0.0, -0.004, d + 0.003))
    pieces = []
    # the stainless skirt is fixed to the plate (governor.py); only the knob turns
    knob = kit.cylinder(0.021, 0.024, segs=24, r2=0.019).transform(Matrix.Translation((0, 0.007, 0)))
    knob.extend(kit.box(0.007, 0.004, 0.036, center=(0, 0.031, -0.004)))  # pointer ridge
    pieces.append(Piece('knob', knob.transform(C @ kit.rot('X', 90)), 'M_Cockpit', 'knob_black', max_lod=1, bevel=(0.0015, 1), smooth=40, tier='cockpit'))
    line = kit.box(0.0024, 0.0012, 0.018, center=(0, 0.0335, 0.006))
    pieces.append(Piece('pointer', line.transform(C @ kit.rot('X', 90)), 'M_Cockpit', 'label_white', max_lod=0, smooth=None, tier='cockpit', recalc=False))
    pivot = C @ Vector((0, 0, 0))
    return {'pieces': pieces, 'extras': {'animRole': 'governorDial', 'pivot': list(pivot), 'axis': list(F.n),
                                          'detents': [GV.DETENTS['OFF'], GV.DETENTS['AIR'], GV.DETENTS['FULL']],
                                          'detentNames': 'OFF,AIR,FULL', 'builtAt': 'AIR'}}
