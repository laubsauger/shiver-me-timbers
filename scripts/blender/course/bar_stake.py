"""
SANDBAR WARNING STAKE (§T.187): driven into The Bar's crest either side of the racing line, so a pilot reads
where the breaker line sits before the bow finds it.

A salvaged timber pile (a pier piling pulled from a drowned marina) jetted into the sand, capped with a steel
band, wrapped in hi-vis/stencil hazard stripes and a band of reflective tape, a crust of barnacles at the
waterline, and a yellow "X" special-mark topmark on a welded bracket above a stencilled BAR plate.

Variant node: Stake. Origin = still water on the pile axis; the pile runs 6 m down so it reaches the bar floor at every
placement (stakes do not bob; the runtime leans each one per placement).
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo
import course_kit as CK
from course_kit import piece

TOP = 4.1


def octagon_pile(r, y0, y1, wobble=0.012):
    rings = []
    n = 10
    for k in range(n + 1):
        y = y0 + (y1 - y0) * k / n
        ring = []
        for j in range(8):
            a = j * math.pi / 4 + 0.2
            rr = r * (1 + wobble * math.sin(3.1 * k + j * 1.7))
            ring.append((math.cos(a) * rr, y, -math.sin(a) * rr))
        rings.append(ring)
    return kit.grid_loft(rings, closed=True, cap0=True, cap1=True)


def build(args):
    V = 'Stake'
    P = []
    P.append(piece(V, 'pile', octagon_pile(0.15, -6.0, TOP - 0.1), 'C_Build', 'timber_dark', max_lod=2, smooth=40, wear=1.4))
    cap = kit.cylinder(0.165, 0.12, segs=16).translate((0, TOP - 0.14, 0))
    fast = [((math.cos(a) * 0.166, TOP - 0.08, math.sin(a) * 0.166), (math.cos(a), 0, math.sin(a)), 0.012, 'bolt', True) for a in (0.5, 2.6, 4.7)]
    P.append(piece(V, 'cap', cap, 'C_Steel', 'steel_painted_grey', max_lod=1, bevel=(0.004, 1), smooth=40, fasteners=fast, wear=1.6))
    band = kit.cylinder(0.158, 1.7, segs=16, caps=False).translate((0, 0.55, 0))
    P.append(piece(V, 'hazard', band, 'C_Paint', 'hazard_band', max_lod=2, smooth=40, wear=1.3))
    tape = kit.cylinder(0.159, 0.14, segs=16, caps=False).translate((0, 2.45, 0))
    P.append(piece(V, 'tape', tape, 'C_Paint', 'tape_reflective', max_lod=1, smooth=40, wear=1.4))
    # barnacle crust: a lumpy collar around the tide band
    crust = Geo()
    for k in range(26):
        a = k * 2.399
        y = -0.35 + (k % 7) * 0.08
        r = 0.035 + 0.02 * ((k * 37) % 5) / 5
        crust.extend(kit.dome(r, 8, 3).transform(Matrix.Translation((math.cos(a) * 0.15, y, math.sin(a) * 0.15)) @ Matrix.Rotation(-a + math.pi / 2, 4, 'Y') @ kit.rot('X', 90)))
    P.append(piece(V, 'barnacles', crust, 'C_Build', 'barnacle', max_lod=0, smooth=60, wear=1.0))
    # bracket + X topmark (special mark) + BAR plate facing +Z (and back)
    br = Geo()
    br.extend(CK.member((0, TOP - 0.3, 0.15), (0, TOP - 0.3, 0.26), 0.05))
    br.extend(CK.member((0, TOP - 0.9, 0.15), (0, TOP - 0.9, 0.26), 0.05))
    br.extend(CK.member((0, TOP - 1.05, 0.26), (0, TOP + 0.55, 0.26), 0.05, 0.03))
    welds = [(0, TOP - 0.3, 0.15), (0, TOP - 0.9, 0.15)]
    P.append(piece(V, 'bracket', br, 'C_Steel', 'steel_painted_grey', max_lod=1, bevel=(0.004, 1), smooth=35, welds=welds, wear=1.5))
    x = Geo()
    for ang in (45, -45):
        x.extend(kit.box(1.0, 0.16, 0.035).transform(Matrix.Translation((0, TOP + 0.2, 0.3)) @ kit.rot('Z', ang)))
    P.append(piece(V, 'topmark', x, 'C_Paint', 'paint_hivis', max_lod=2, bevel=(0.006, 1), smooth=35, wear=1.1))
    edge = Geo()
    for ang in (45, -45):
        for off in (0.085, -0.085):
            edge.extend(kit.box(1.0, 0.012, 0.04).transform(Matrix.Translation((0, TOP + 0.2, 0.3)) @ kit.rot('Z', ang) @ Matrix.Translation((0, off, 0))))
    P.append(piece(V, 'topmark_edge', edge, 'C_Paint', 'paint_stencil', max_lod=1, smooth=35))
    plate = kit.box(0.7, 0.34, 0.02, center=(0, TOP - 0.62, 0.285))
    P.append(piece(V, 'plate', plate, 'C_Paint', 'paint_hivis', max_lod=2, bevel=(0.004, 1), smooth=35, wear=1.1,
                   local=((0, TOP - 0.62, 0.296), (1, 0, 0), (0, 1, 0))))
    words = Geo()
    for side in (1, -1):
        glyph = CK.stencil_text('BAR', 0.2, 0.006)
        M = Matrix.Translation((0, TOP - 0.62, 0.285 + side * 0.013))
        if side < 0:
            M = M @ kit.rot('Y', 180)
        words.extend(glyph.transform(M))
    P.append(piece(V, 'plate_words', words, 'C_Paint', 'paint_stencil', max_lod=1, smooth=None))
    return {
        'pieces': P,
        'lodRatios': [1.0, 0.35, 0.1],
        'extras': {'heightAboveWater': TOP + 0.6, 'footY': -6.0, 'seat': 'origin at still water; the pile runs to footY so it reaches any bar floor down to -5 m'},
    }
