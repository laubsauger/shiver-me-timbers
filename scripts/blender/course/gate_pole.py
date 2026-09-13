"""
GATE MARKER POLE (design doc §5 "channel markers": salvaged steel poles, painted daymarks, solar strobes,
reflective tape, flexible poles; ■ board = left pole, ▲ board = right pole, strobe = next gate).

A SPAR MARKER, because the gates stand in 6–40 m of water: a salvaged steel pipe on a foam-filled drum
float, ballasted below, with a black rubber flex coupling above the float (the "flexible pole" a hull can
whip past for −10 %, never a crash). Signal-orange spar with three bands of reflective tape, a welded
repair sleeve, a battery box behind the spar feeding a solar amber strobe at the top, and the daymark on
a two-arm bracket facing the approaching boats (+Z), numbered in the HUD's stencil face on both sides.

Variant nodes (instanced): Spar · Strobe (lens only, per-gate emissive) · BoardSquare · BoardTriangle ·
BoardChequer (start/finish) · Numeral1..8. Origin = still water on the spar axis.
Render hook (no physics): extras.bob — the runtime heaves/tilts each instance from the sea height and
slope at its pivot (src/circuit/courseFurniture.ts).
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo
import course_kit as CK
from course_kit import piece

SPAR_R = 0.085
SPAR_TOP = 6.3
BOARD_Y = 5.35
BOARD_Z = 0.19
BOARD_T = 0.022
SQUARE = 1.3
TRI = 1.55


def ring(r, y, tube_r, segs=24, rsegs=6):
    return kit.torus(r, tube_r, segs, rsegs).translate((0, y, 0))


def band(r, y0, y1, segs=20):
    return kit.cylinder(r, y1 - y0, segs=segs, caps=False).translate((0, y0, 0))


def spar_pieces():
    P = []
    V = 'Spar'
    # below water: pipe, ballast, shackle + chain stub (seen through clear shallow water at a gate)
    P.append(piece(V, 'spar_under', kit.cylinder(0.11, 2.62, segs=14).translate((0, -2.6, 0)), 'C_Steel', 'steel_painted_grey',
                   max_lod=1, smooth=40, tier='low'))
    ballast = kit.cylinder(0.3, 0.52, segs=18).translate((0, -3.1, 0))
    P.append(piece(V, 'ballast', ballast, 'C_Steel', 'concrete', max_lod=1, bevel=(0.03, 2), smooth=35, tier='low'))
    chain = Geo()
    for k in range(3):
        link = kit.torus(0.07, 0.016, 12, 5).transform(Matrix.Translation((0, -3.22 - 0.11 * k, 0)) @ kit.rot('X', 90) @ kit.rot('Y', 90 * (k % 2)))
        chain.extend(link)
    P.append(piece(V, 'chain', chain, 'C_Steel', 'chain', max_lod=0, smooth=60))
    # the float: a foam-filled salvaged drum, rolled rims, tape band, a domed top
    drum = kit.revolve([(0.52, -0.55), (0.55, -0.5), (0.55, 0.26), (0.5, 0.33), (0.2, 0.36), (0.12, 0.36)], segs=32, caps=True)
    P.append(piece(V, 'float', drum, 'C_Paint', 'foam_float', max_lod=2, bevel=(0.01, 1), smooth=40, wear=1.4))
    rims = ring(0.556, -0.22, 0.02, 32).extend(ring(0.556, 0.12, 0.02, 32))
    P.append(piece(V, 'float_rims', rims, 'C_Paint', 'paint_signal', max_lod=1, smooth=60, wear=1.3))
    P.append(piece(V, 'float_tape', band(0.5575, -0.08, 0.04, 32), 'C_Paint', 'tape_reflective', max_lod=1, smooth=60, wear=1.2))
    # flex coupling: ribbed rubber boot + hose clamps
    boot = kit.revolve([(0.12, 0.34), (0.15, 0.4), (0.13, 0.46), (0.15, 0.52), (0.13, 0.58), (0.15, 0.64), (0.12, 0.72)], segs=18, caps=True)
    P.append(piece(V, 'flex_boot', boot, 'C_Paint', 'rubber_black', max_lod=2, smooth=60))
    clamps = ring(0.122, 0.37, 0.012, 18, 4).extend(ring(0.122, 0.69, 0.012, 18, 4))
    P.append(piece(V, 'clamps', clamps, 'C_Steel', 'steel_black', max_lod=0, smooth=50))
    # the spar above: signal orange, three tape bands, a welded repair sleeve
    P.append(piece(V, 'spar', kit.cylinder(SPAR_R, SPAR_TOP - 0.72, segs=16).translate((0, 0.72, 0)), 'C_Paint', 'paint_signal',
                   max_lod=2, smooth=40, wear=1.2))
    tape = Geo()
    for y in (1.45, 2.45, 3.45):
        tape.extend(band(SPAR_R + 0.0015, y, y + 0.16, 16))
    P.append(piece(V, 'spar_tape', tape, 'C_Paint', 'tape_reflective', max_lod=1, smooth=60, wear=1.3))
    sleeve = kit.cylinder(SPAR_R + 0.012, 0.26, segs=16).translate((0, 2.82, 0))
    welds = [(math.cos(a) * (SPAR_R + 0.012), y, math.sin(a) * (SPAR_R + 0.012)) for y in (2.82, 3.08) for a in (0.3, 1.9, 3.6, 5.1)]
    P.append(piece(V, 'sleeve', sleeve, 'C_Steel', 'steel_painted_grey', max_lod=1, bevel=(0.004, 1), smooth=40, welds=welds, wear=1.5))
    # battery box behind the spar (away from the boats), two straps, the cable up the spar
    box = kit.box(0.24, 0.32, 0.17, center=(0, 3.95, -SPAR_R - 0.1))
    lid = kit.box(0.25, 0.03, 0.18, center=(0, 4.12, -SPAR_R - 0.1))
    fast = [((sx * 0.09, 4.12 + 0.015, -SPAR_R - 0.1 + sz * 0.07), (0, 1, 0), 0.008, 'screw', True) for sx in (-1, 1) for sz in (-1, 1)]
    P.append(piece(V, 'battery_box', box.extend(lid), 'C_Steel', 'steel_black', max_lod=1, bevel=(0.008, 1), smooth=35, fasteners=fast, wear=1.4))
    straps = ring(SPAR_R + 0.004, 3.86, 0.008, 16, 4).extend(ring(SPAR_R + 0.004, 4.04, 0.008, 16, 4))
    P.append(piece(V, 'box_straps', straps, 'C_Steel', 'steel_black', max_lod=0, smooth=60))
    cable = kit.sweep(kit.fillet_path([(0.0, 4.14, -SPAR_R - 0.1), (0.0, 4.3, -SPAR_R - 0.02), (0.0, 6.2, -SPAR_R - 0.02), (0.0, 6.34, -0.05)], 0.05, 3), 0.009, 5)
    P.append(piece(V, 'cable', cable, 'C_Paint', 'rubber_black', max_lod=0, smooth=60))
    # strobe housing + solar panel on a tilt bracket
    housing = kit.cylinder(0.075, 0.05, segs=18).translate((0, SPAR_TOP, 0))
    housing.extend(kit.cylinder(0.075, 0.035, segs=18).translate((0, SPAR_TOP + 0.19, 0)))
    housing.extend(kit.cylinder(0.05, 0.05, segs=18, r2=0.02).translate((0, SPAR_TOP + 0.225, 0)))
    P.append(piece(V, 'strobe_housing', housing, 'C_Steel', 'steel_black', max_lod=2, smooth=40))
    for sx in (-1, 1):
        post = kit.cylinder(0.006, 0.19, segs=6).translate((sx * 0.06, SPAR_TOP + 0.05, 0))
        P.append(piece(V, f'strobe_post_{sx}', post, 'C_Steel', 'steel_black', max_lod=0, smooth=60))
    panel_M = Matrix.Translation((0, SPAR_TOP - 0.3, -0.12)) @ kit.rot('X', -38)
    frame = kit.box(0.36, 0.028, 0.3).transform(panel_M)
    cells = kit.box(0.33, 0.004, 0.27, center=(0, 0.016, 0)).transform(panel_M)
    arm = CK.member((0, SPAR_TOP - 0.36, -SPAR_R), (0, SPAR_TOP - 0.31, -0.1), 0.03)
    P.append(piece(V, 'panel_frame', frame.extend(arm), 'C_Steel', 'steel_black', max_lod=1, bevel=(0.004, 1), smooth=35))
    o = panel_M @ Vector((0, 0.018, 0))
    P.append(piece(V, 'panel_cells', cells, 'C_Paint', 'solar_cell', max_lod=1, smooth=30,
                   local=(tuple(o), tuple((panel_M.to_3x3() @ Vector((1, 0, 0))).normalized()), tuple((panel_M.to_3x3() @ Vector((0, 0, 1))).normalized()))))
    # daymark bracket: two arms off the spar to the board plane, U-bolts
    arms = Geo()
    fast = []
    for y in (BOARD_Y - 0.45, BOARD_Y + 0.45):
        arms.extend(CK.member((0, y, SPAR_R * 0.6), (0, y, BOARD_Z - BOARD_T / 2 - 0.01), 0.05, 0.05))
        arms.extend(kit.box(0.5, 0.05, 0.012, center=(0, y, BOARD_Z - BOARD_T / 2 - 0.006)))
        ub = kit.torus(SPAR_R + 0.012, 0.007, 16, 4).transform(Matrix.Translation((0, y, 0)))
        arms.extend(ub)
        fast += [((sx * 0.2, y, BOARD_Z - BOARD_T / 2 - 0.013), (0, 0, -1), 0.012, 'bolt', True) for sx in (-1, 1)]
    P.append(piece(V, 'bracket', arms, 'C_Steel', 'steel_painted_grey', max_lod=1, bevel=(0.004, 1), smooth=35, fasteners=fast, wear=1.4))
    return P


def board_pieces(variant, outline, look_face):
    """a daymark plate + stencil border, both faces; `outline` is a CCW 2D polygon in the board plane"""
    P = []
    plate = kit.extrude(outline, BOARD_T).translate((0, BOARD_Y, BOARD_Z))
    local = ((0, BOARD_Y, BOARD_Z + BOARD_T / 2), (1, 0, 0), (0, 1, 0))
    P.append(piece(variant, 'plate', plate, 'C_Paint', look_face, max_lod=2, bevel=(0.006, 1), smooth=30, wear=1.3, local=local, tier='hero'))
    # stencil-black border band just proud of both faces, tape strip inside it
    border = Geo()
    tape = Geo()
    for side in (1, -1):
        z = BOARD_Z + side * (BOARD_T / 2 + 0.0035)
        to3d = lambda q, z=z, side=side: (q[0], BOARD_Y + q[1], z + side * q[2])  # noqa: E731
        for inset, w, g in ((0.0, 0.07, border), (0.1, 0.04, tape)):
            fr = CK.mitred_frame(outline, inset, w, 0.003, to3d)
            # the back face mirrors z (det −1): flip the winding back outward
            if side < 0:
                fr.flip()
            g.extend(fr)
    P.append(piece(variant, 'border', border, 'C_Paint', 'paint_stencil', max_lod=1, smooth=None, recalc=False, wear=1.2))
    P.append(piece(variant, 'tape', tape, 'C_Paint', 'tape_reflective', max_lod=1, smooth=None, recalc=False, wear=1.2))
    fast = [((x, BOARD_Y + y, BOARD_Z + BOARD_T / 2 + 0.004), (0, 0, 1), 0.014, 'bolt', True) for (x, y) in ((-0.2, -0.45), (0.2, -0.45), (-0.2, 0.45), (0.2, 0.45))]
    plate_piece = P[0]
    plate_piece.fasteners = fast
    return P


def numeral_pieces(n, y_offset):
    P = []
    V = f'Numeral{n}'
    g = Geo()
    for side in (1, -1):
        glyph = CK.stencil_text(str(n), 0.62, 0.006)
        M = Matrix.Translation((0, BOARD_Y + y_offset, BOARD_Z + side * (BOARD_T / 2 + 0.004)))
        if side < 0:
            M = M @ kit.rot('Y', 180)
        g.extend(glyph.transform(M))
    P.append(piece(V, 'glyph', g, 'C_Paint', 'paint_stencil', max_lod=1, smooth=None, wear=1.1, recalc=True))
    return P


def build(args):
    pieces = spar_pieces()
    # strobe lens: its own node so each gate's strobe is driven separately
    lens = kit.cylinder(0.062, 0.14, segs=20).translate((0, SPAR_TOP + 0.05, 0))
    pieces.append(piece('Strobe', 'lens', lens, 'C_Lamp', 'lens_amber', max_lod=2, smooth=60, wear=0.6))
    h = SQUARE / 2
    pieces += board_pieces('BoardSquare', [(-h, -h), (h, -h), (h, h), (-h, h)], 'paint_signal_board')
    pieces += board_pieces('BoardChequer', [(-h, -h), (h, -h), (h, h), (-h, h)], 'chequer')
    s = TRI
    r_in = s / (2 * math.sqrt(3))
    tri = [(-s / 2, -r_in), (s / 2, -r_in), (0, s / math.sqrt(3) - 0.0)]
    # centre the triangle's box on the board centre
    ys = [p[1] for p in tri]
    dy = -(min(ys) + max(ys)) / 2
    tri = [(x, y + dy) for (x, y) in tri]
    pieces += board_pieces('BoardTriangle', tri, 'paint_signal_board')
    for n in range(1, 9):
        pieces += numeral_pieces(n, 0.0)
    return {
        'pieces': pieces,
        'lodRatios': [1.0, 0.32, 0.08],
        'extras': {
            'heightAboveWater': SPAR_TOP + 0.26,
            'boardCentre': [0, BOARD_Y, BOARD_Z],
            'boardFaceZ': BOARD_Z + BOARD_T / 2,
            'triangleNumeralOffsetY': -0.12,
            'bob': {'pivotY': -0.15, 'heaveGain': 1.0, 'tiltGain': 0.35, 'lagSeconds': 0.35, 'maxTiltRad': 0.18},
        },
        'variantExtras': {
            'Strobe': {'lamps': [{'role': 'nextGate', 'at': [0, SPAR_TOP + 0.12, 0], 'colour': CK.LED_AMBER, 'flashHz': 1.2}]},
            'BoardSquare': {'side': 'left'},
            'BoardTriangle': {'side': 'right', 'numeralOffsetY': -0.12},
            'BoardChequer': {'side': 'start'},
        },
    }
