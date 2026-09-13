"""
TURN MARK BUOY (design doc §5/§8: salvaged, painted, with a light; rounded to port).

A pre-flood steel pillar buoy pulled off a drowned harbour, repainted for the league: black antifoul below the
waterline, a signal-orange body with a chequer band (the "turn" read at 80 kn), a rubber fender ring, a four-leg
tapered cage carrying chequer/orange daymark panels, three solar panels, an amber LED lantern on a grated
platform, a radar reflector and lightning rod, a boarding ladder, lifting eyes, welded doubler plates with rust
runs from their bolts, and a mooring chain. The mark's tag (T1–T3) is stencilled on a plate on both sides.

Variant nodes: Buoy · Lantern (C_Lamp, per-mark emissive) · Tag1..3. Origin = still water on the buoy axis.
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo
import course_kit as CK
from course_kit import piece

BODY_R = 1.2
DECK_Y = 0.78
CAGE_TOP = 3.4
PANEL_Y0, PANEL_Y1 = 1.55, 2.95


def leg_point(k, y):
    """cage leg k (0..3) at height y: a square cage tapering from 0.72 at the deck to 0.36 at the top"""
    t = (y - DECK_Y) / (CAGE_TOP - DECK_Y)
    h = 0.72 + (0.36 - 0.72) * t
    a = math.pi / 4 + k * math.pi / 2
    return (math.cos(a) * h * math.sqrt(2), y, math.sin(a) * h * math.sqrt(2))


def build(args):
    P = []
    V = 'Buoy'
    # ── hull ──
    under = kit.revolve([(0.12, -2.2), (0.22, -2.1), (0.35, -1.55), (0.95, -0.95), (1.18, -0.6), (1.2, -0.05)], segs=40, caps=True)
    P.append(piece(V, 'hull_under', under, 'C_Steel', 'steel_black', max_lod=2, smooth=45, tier='low', wear=1.2))
    body = kit.revolve([(1.2, -0.05), (1.2, 0.62), (1.14, 0.74), (1.02, DECK_Y), (0.9, DECK_Y)], segs=40, caps=False)
    P.append(piece(V, 'body', body, 'C_Paint', 'paint_signal', max_lod=2, smooth=45, wear=1.2))
    deck = kit.cylinder(0.9, 0.02, segs=40, caps=True).translate((0, DECK_Y - 0.01, 0))
    P.append(piece(V, 'deck', deck, 'C_Steel', 'steel_painted_grey', max_lod=2, smooth=40))
    chq = kit.cylinder(BODY_R + 0.004, 0.32, segs=40, caps=False).translate((0, 0.22, 0))
    P.append(piece(V, 'chequer_band', chq, 'C_Paint', 'chequer_ring', max_lod=2, smooth=45, wear=1.1))
    fender = kit.torus(BODY_R + 0.06, 0.085, 48, 8).translate((0, 0.0, 0))
    P.append(piece(V, 'fender', fender, 'C_Paint', 'rubber_black', max_lod=1, smooth=60, wear=1.3))
    # welded doubler plates with bolt runs on the swell side
    plates = Geo()
    fast = []
    welds = []
    for (ang, y, w, h) in ((0.4, 0.42, 0.55, 0.3), (2.9, 0.5, 0.4, 0.22)):
        c, s = math.cos(ang), math.sin(ang)
        M = Matrix.Translation((c * (BODY_R + 0.008), y, s * (BODY_R + 0.008))) @ Matrix.Rotation(-ang + math.pi / 2, 4, 'Y')
        plates.extend(kit.box(w, h, 0.012).transform(M))
        for bx in (-w / 2 + 0.05, w / 2 - 0.05):
            for by in (-h / 2 + 0.05, h / 2 - 0.05):
                p = M @ Vector((bx, by, 0.009))
                fast.append((tuple(p), (c, 0, s), 0.014, 'bolt', True))
        for k in range(6):
            welds.append(tuple(M @ Vector((-w / 2 + w * k / 5, -h / 2, 0))))
    P.append(piece(V, 'doublers', plates, 'C_Steel', 'steel_painted_grey', max_lod=0, bevel=(0.004, 1), smooth=35, fasteners=fast, welds=welds, wear=1.6))
    # lifting eyes + mooring chain
    eyes = Geo()
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        eyes.extend(kit.torus(0.07, 0.018, 12, 5).transform(Matrix.Translation((math.cos(a) * 0.82, DECK_Y + 0.07, math.sin(a) * 0.82)) @ kit.rot('X', 90) @ Matrix.Rotation(-a, 4, 'Y')))
    P.append(piece(V, 'eyes', eyes, 'C_Steel', 'chain', max_lod=0, smooth=60))
    chain = Geo()
    for k in range(9):
        chain.extend(kit.torus(0.09, 0.02, 12, 5).transform(Matrix.Translation((0.05 * k, -2.3 - 0.15 * k, 0.03 * k)) @ kit.rot('X', 90) @ kit.rot('Y', 90 * (k % 2))))
    P.append(piece(V, 'chain', chain, 'C_Steel', 'chain', max_lod=0, smooth=60, tier='low'))
    # boarding ladder on the +Z face
    lad = Geo()
    for sx in (-0.2, 0.2):
        lad.extend(kit.sweep(kit.fillet_path([(sx, -0.5, BODY_R + 0.12), (sx, 0.7, BODY_R + 0.12), (sx, 0.95, BODY_R - 0.05), (sx, DECK_Y + 0.02, 0.95)], 0.08, 3), 0.018, 8))
    for y in (-0.3, 0.0, 0.3, 0.6):
        lad.extend(CK.tube((-0.2, y, BODY_R + 0.12), (0.2, y, BODY_R + 0.12), 0.014, 8))
        lad.extend(CK.tube((-0.2, y, BODY_R + 0.12), (-0.2, y, BODY_R), 0.012, 6))
        lad.extend(CK.tube((0.2, y, BODY_R + 0.12), (0.2, y, BODY_R), 0.012, 6))
    P.append(piece(V, 'ladder', lad, 'C_Steel', 'galv_steel', max_lod=1, smooth=50, wear=1.3))

    # ── cage ──
    cage = Geo()
    fast = []
    levels = [DECK_Y, 1.5, 2.2, 3.0, CAGE_TOP]
    for k in range(4):
        cage.extend(CK.tube(leg_point(k, DECK_Y), leg_point(k, CAGE_TOP), 0.045, 10))
        fast.append((leg_point(k, DECK_Y + 0.05), (0, 1, 0), 0.02, 'bolt', True))
    for y in levels[1:]:
        for k in range(4):
            cage.extend(CK.tube(leg_point(k, y), leg_point((k + 1) % 4, y), 0.028, 8))
    for i in range(len(levels) - 2):
        for k in range(4):
            cage.extend(CK.tube(leg_point(k, levels[i]), leg_point((k + 1) % 4, levels[i + 1]), 0.02, 6))
    P.append(piece(V, 'cage', cage, 'C_Steel', 'galv_steel', max_lod=2, smooth=50, fasteners=fast, wear=1.2))
    # daymark panels on the four faces: chequer above, orange below, framed
    for k in range(4):
        a0 = leg_point(k, PANEL_Y0)
        b0 = leg_point((k + 1) % 4, PANEL_Y0)
        a1 = leg_point(k, PANEL_Y1)
        b1 = leg_point((k + 1) % 4, PANEL_Y1)
        mid0 = Vector(((a0[0] + b0[0]) / 2, 0, (a0[2] + b0[2]) / 2))
        outward = mid0.normalized()
        inset = 0.06
        def lerpv(p, q, t):
            return Vector((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t))
        ymid = (PANEL_Y0 + PANEL_Y1) / 2
        am = leg_point(k, ymid)
        bm = leg_point((k + 1) % 4, ymid)
        for (lo_a, lo_b, hi_a, hi_b, look, nm) in ((a0, b0, am, bm, 'paint_signal_board', 'low'), (am, bm, a1, b1, 'chequer', 'high')):
            pa, pb = lerpv(lo_a, lo_b, 0.08), lerpv(lo_a, lo_b, 0.92)
            qa, qb = lerpv(hi_a, hi_b, 0.08), lerpv(hi_a, hi_b, 0.92)
            g = Geo()
            corners = [pa + outward * inset, pb + outward * inset, qb + outward * inset, qa + outward * inset]
            back = [c - outward * 0.02 for c in corners]
            ids = [g.vert(tuple(c)) for c in corners] + [g.vert(tuple(c)) for c in back]
            g.face((ids[0], ids[1], ids[2], ids[3]))
            g.face((ids[7], ids[6], ids[5], ids[4]))
            for i in range(4):
                j = (i + 1) % 4
                g.face((ids[j], ids[i], ids[4 + i], ids[4 + j]))
            xa = (pb - pa).normalized()
            ya = (qa - pa).normalized()
            o = pa + outward * inset
            P.append(piece(V, f'panel_{k}_{nm}', g, 'C_Paint', look, max_lod=2, smooth=None, local=(tuple(o), tuple(xa), tuple(ya)), tier='hero', wear=1.1))
    # solar panels on three faces, tilted out
    for k in (0, 1, 3):
        a = math.pi / 4 + k * math.pi / 2 + math.pi / 4
        c = Vector((math.cos(a), 0, math.sin(a)))
        M = Matrix.Translation((c.x * 0.62, 3.12, c.z * 0.62)) @ Matrix.Rotation(-a + math.pi / 2, 4, 'Y') @ kit.rot('X', 55)
        P.append(piece(V, f'solar_frame_{k}', kit.box(0.5, 0.03, 0.42).transform(M), 'C_Steel', 'steel_black', max_lod=1, bevel=(0.004, 1), smooth=35))
        o = M @ Vector((0, 0.017, 0))
        P.append(piece(V, f'solar_cells_{k}', kit.box(0.46, 0.004, 0.38, center=(0, 0.016, 0)).transform(M), 'C_Paint', 'solar_cell', max_lod=1,
                       smooth=30, local=(tuple(o), tuple((M.to_3x3() @ Vector((1, 0, 0))).normalized()), tuple((M.to_3x3() @ Vector((0, 0, 1))).normalized()))))
    # grated platform, lantern housing, lightning rod, radar reflector
    plat = kit.cylinder(0.52, 0.04, segs=24).translate((0, CAGE_TOP, 0))
    rail = kit.torus(0.5, 0.018, 24, 5).translate((0, CAGE_TOP + 0.45, 0))
    for k in range(6):
        a = k * math.pi / 3
        rail.extend(CK.tube((math.cos(a) * 0.5, CAGE_TOP, math.sin(a) * 0.5), (math.cos(a) * 0.5, CAGE_TOP + 0.45, math.sin(a) * 0.5), 0.014, 6))
    P.append(piece(V, 'platform', plat, 'C_Steel', 'galv_steel', max_lod=2, smooth=40))
    P.append(piece(V, 'rail', rail, 'C_Steel', 'galv_steel', max_lod=1, smooth=60))
    housing = kit.cylinder(0.2, 0.12, segs=24).translate((0, CAGE_TOP + 0.04, 0))
    housing.extend(kit.cylinder(0.2, 0.06, segs=24, r2=0.12).translate((0, CAGE_TOP + 0.5, 0)))
    for k in range(4):
        a = k * math.pi / 2 + 0.3
        housing.extend(CK.tube((math.cos(a) * 0.18, CAGE_TOP + 0.16, math.sin(a) * 0.18), (math.cos(a) * 0.18, CAGE_TOP + 0.5, math.sin(a) * 0.18), 0.012, 6))
    P.append(piece(V, 'lantern_housing', housing, 'C_Steel', 'steel_black', max_lod=2, smooth=40))
    rod = CK.tube((0, CAGE_TOP + 0.56, 0), (0, CAGE_TOP + 1.6, 0), 0.012, 6)
    P.append(piece(V, 'rod', rod, 'C_Steel', 'galv_steel', max_lod=1, smooth=60))
    refl = Geo()
    for rx, ry in ((0, 0), (90, 0), (0, 90)):
        refl.extend(kit.box(0.34, 0.34, 0.008).transform(Matrix.Translation((0, CAGE_TOP + 1.2, 0)) @ kit.rot('X', rx) @ kit.rot('Y', ry + 45)))
    P.append(piece(V, 'radar_reflector', refl, 'C_Steel', 'galv_steel', max_lod=1, smooth=None))

    # ── variant nodes ──
    lens = kit.cylinder(0.16, 0.34, segs=28).translate((0, CAGE_TOP + 0.16, 0))
    P.append(piece('Lantern', 'lens', lens, 'C_Lamp', 'lens_amber', max_lod=2, smooth=60, wear=0.6))
    tag_y = 1.92
    half = leg_point(0, tag_y)[0]  # the +X/+Z faces of the square cage at this height
    for n in (1, 2, 3):
        g = Geo()
        for side in (1, -1):
            glyph = CK.stencil_text(f'T{n}', 0.4, 0.012)
            M = Matrix.Translation((0, tag_y, side * (half + 0.085)))
            if side < 0:
                M = M @ kit.rot('Y', 180)
            g.extend(glyph.transform(M))
        P.append(piece(f'Tag{n}', 'glyph', g, 'C_Paint', 'paint_stencil', max_lod=1, smooth=None))
    return {
        'pieces': P,
        'lodRatios': [1.0, 0.3, 0.08],
        'extras': {
            'heightAboveWater': CAGE_TOP + 1.6,
            'bob': {'pivotY': -0.5, 'heaveGain': 1.0, 'tiltGain': 0.22, 'lagSeconds': 0.8, 'maxTiltRad': 0.12},
            'lanternCentre': [0, CAGE_TOP + 0.33, 0],
        },
        'variantExtras': {
            'Lantern': {'lamps': [{'role': 'turnMark', 'at': [0, CAGE_TOP + 0.33, 0], 'colour': CK.LED_AMBER, 'flashHz': 0.5}]},
            'Tag1': {'markId': 'T1'},
            'Tag2': {'markId': 'T2'},
            'Tag3': {'markId': 'T3'},
        },
    }
