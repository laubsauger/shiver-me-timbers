"""
DROWNED TRANSMISSION PYLON (design doc §5 "transmission line: steel lattice pylon tops in a row, sagging cables well
above the water; pylons solid, cables high and harmless"; §8 "hazard paint at the waterline").

The top section of a 230 kV double-circuit lattice tower whose footings are 40 m down in the drowned valley:
four galvanised angle-section legs tapering to a waist, X-braced panels with bolted gusset nodes, three
trussed cross-arms each side and an earth-wire peak, glazed insulator strings with conductor clamps, and a
hazard band repainted on the legs where the league's boats pass. Everything from y = −14 m up is modelled
(the clear water shows the upper panels); the cables are drawn at runtime between neighbouring pylons from
extras.attach, so a span can be any length.

Variant nodes: Pylon · Insulators. Origin = still water on the tower axis; +Z along the line.
"""
import math

from mathutils import Vector

import kit
from kit import Geo
import course_kit as CK
from course_kit import piece

BASE_Y = -14.0
WAIST_Y = 12.0
PEAK_Y = 25.0
ARMS = [(13.5, 7.2), (17.5, 9.0), (21.5, 6.8)]  # (height, reach)
STRING = 2.1


def half_width(y):
    if y <= WAIST_Y:
        t = (y - BASE_Y) / (WAIST_Y - BASE_Y)
        return 3.3 + (1.15 - 3.3) * t
    t = (y - WAIST_Y) / (PEAK_Y - WAIST_Y)
    return 1.15 + (0.55 - 1.15) * t


def corner(k, y):
    h = half_width(y)
    sx = 1 if k in (0, 3) else -1
    sz = 1 if k in (0, 1) else -1
    return (sx * h, y, sz * h)


def build(args):
    P = []
    V = 'Pylon'
    levels = [BASE_Y, -10.5, -7.0, -3.8, -0.8, 2.2, 5.2, 8.2, WAIST_Y, 13.5, 15.5, 17.5, 19.5, 21.5, 23.3, PEAK_Y]
    legs, legs_paint, horiz, diag, gussets = Geo(), Geo(), Geo(), Geo(), Geo()
    fast = []
    band0, band1 = -0.8, 2.2
    for k in range(4):
        for i in range(len(levels) - 1):
            a, b = corner(k, levels[i]), corner(k, levels[i + 1])
            m = CK.angle_member(a, b, 0.16, 0.014, roll_to=(-a[0], 0, -a[2]))
            (legs_paint if band0 <= levels[i] < band1 else legs).extend(m)
    for i, y in enumerate(levels):
        for k in range(4):
            a, b = corner(k, y), corner((k + 1) % 4, y)
            if y > WAIST_Y and y not in [h for h, _ in ARMS] and y != PEAK_Y:
                continue
            horiz.extend(CK.angle_member(a, b, 0.09, 0.009, roll_to=(0, 1, 0)))
            c = Vector(corner(k, y))
            # gusset plates in the two lattice faces that meet at the leg (a cube at every node read as a block)
            sgx = 1 if c.x > 0 else -1
            sgz = 1 if c.z > 0 else -1
            gussets.extend(kit.box(0.016, 0.42, 0.36, center=(c.x + sgx * 0.02, c.y, c.z - sgz * 0.14)))
            gussets.extend(kit.box(0.36, 0.42, 0.016, center=(c.x - sgx * 0.14, c.y, c.z + sgz * 0.02)))
            for dy in (-0.06, 0.06):
                fast.append(((c.x * 1.08, c.y + dy, c.z * 1.08), (c.x, 0, c.z), 0.02, 'bolt', True))
    for i in range(len(levels) - 1):
        for k in range(4):
            a0, b0 = corner(k, levels[i]), corner((k + 1) % 4, levels[i])
            a1, b1 = corner(k, levels[i + 1]), corner((k + 1) % 4, levels[i + 1])
            diag.extend(CK.angle_member(a0, b1, 0.08, 0.008))
            diag.extend(CK.angle_member(b0, a1, 0.08, 0.008))
    # cross-arms: trussed, both sides, plus the earth-wire peak
    arms = Geo()
    attach = []
    for (y, reach) in ARMS:
        hw = half_width(y)
        for sx in (1, -1):
            tip_top = (sx * reach, y + 0.35, 0.0)
            tip_bot = (sx * reach, y - 0.05, 0.0)
            for sz in (1, -1):
                arms.extend(CK.angle_member((sx * hw, y + 1.6, sz * hw), tip_top, 0.09, 0.009))
                arms.extend(CK.angle_member((sx * hw, y, sz * hw), tip_bot, 0.1, 0.01))
                for f in (0.33, 0.66):
                    p_top = (sx * (hw + (reach - hw) * f), y + 1.6 + (0.35 - 1.6) * f, sz * hw * (1 - f))
                    p_bot = (sx * (hw + (reach - hw) * f), y - 0.05 * f, sz * hw * (1 - f))
                    arms.extend(CK.angle_member(p_bot, p_top, 0.07, 0.007))
            attach.append([sx * reach, y - 0.05 - STRING, 0.0])
    peak = Geo()
    for k in range(4):
        c = corner(k, PEAK_Y)
        sx = 1 if c[0] > 0 else -1
        peak.extend(CK.angle_member(c, (sx * 2.2, PEAK_Y + 0.9, 0.0), 0.08, 0.008))
    for sx in (1, -1):
        attach.append([sx * 2.2, PEAK_Y + 0.9, 0.0])
    P.append(piece(V, 'legs', legs, 'C_Steel', 'galv_steel', max_lod=2, smooth=None, fasteners=fast, wear=1.2))
    P.append(piece(V, 'legs_hazard', legs_paint, 'C_Paint', 'hazard_band', max_lod=2, smooth=None, wear=1.3))
    P.append(piece(V, 'horizontals', horiz, 'C_Steel', 'galv_steel', max_lod=2, smooth=None, wear=1.2))
    P.append(piece(V, 'gussets', gussets, 'C_Steel', 'galv_steel', max_lod=0, smooth=None, wear=1.2))
    P.append(piece(V, 'diagonals', diag, 'C_Steel', 'galv_steel', max_lod=1, smooth=None, wear=1.2, tier='low'))
    P.append(piece(V, 'arms', arms, 'C_Steel', 'galv_steel', max_lod=2, smooth=None, wear=1.2))
    P.append(piece(V, 'peak', peak, 'C_Steel', 'galv_steel', max_lod=2, smooth=None, wear=1.2))
    # anti-climb band + a danger plate (lightning pictogram) on the +Z face above the hazard band
    plate = kit.box(0.6, 0.8, 0.02, center=(0, 3.4, half_width(3.4) + 0.05))
    P.append(piece(V, 'danger_plate', plate, 'C_Paint', 'paint_hivis', max_lod=1, bevel=(0.004, 1), smooth=35, wear=1.3,
                   local=((0, 3.4, half_width(3.4) + 0.06), (1, 0, 0), (0, 1, 0))))
    bolt = [(-0.22, 3.72), (0.22, 3.72), (-0.22, 3.08), (0.22, 3.08)]
    P[-1].fasteners = [((x, y, half_width(3.4) + 0.061), (0, 0, 1), 0.012, 'bolt', True) for (x, y) in bolt]
    zig = Geo()
    pts = [(-0.08, 3.72), (0.12, 3.72), (0.0, 3.46), (0.14, 3.46), (-0.1, 3.08), (0.0, 3.36), (-0.14, 3.36)]
    z0 = half_width(3.4) + 0.061
    ids_f = [zig.vert((x, y, z0 + 0.006)) for (x, y) in pts]
    ids_b = [zig.vert((x, y, z0)) for (x, y) in pts]
    zig.face(tuple(ids_f))
    zig.face(tuple(reversed(ids_b)))
    for i in range(len(pts)):
        j = (i + 1) % len(pts)
        zig.face((ids_b[i], ids_b[j], ids_f[j], ids_f[i]))
    P.append(piece(V, 'danger_bolt', zig, 'C_Paint', 'paint_stencil', max_lod=1, smooth=None))
    # the league's chequer boards (design doc §8 "hazard paint at the waterline, checker band") bolted across the two
    # faces the boats run past (±X, the arms' side), above the hazard band: Pylon Row reads as race furniture
    ybd = 4.5
    for sx in (1, -1):
        hwb = half_width(ybd)
        xb = sx * (hwb + 0.06)
        P.append(piece(V, f'chequer_board_{"p" if sx > 0 else "n"}', kit.box(0.03, 1.2, 2.0 * hwb - 0.3, center=(xb, ybd, 0.0)), 'C_Paint', 'chequer',
                       max_lod=2, smooth=None, wear=1.0, local=((xb + sx * 0.016, ybd - 0.6, -hwb), (0, 0, 1), (0, 1, 0))))

    # insulator strings: glazed discs + clamps, hanging from each arm tip
    ins = Geo()
    clamps = Geo()
    for (y, reach) in ARMS:
        for sx in (1, -1):
            x = sx * reach
            top = y - 0.05
            clamps.extend(CK.tube((x, top, 0), (x, top - 0.25, 0), 0.025, 8))
            for d in range(13):
                cy = top - 0.3 - d * 0.13
                ins.extend(kit.revolve([(0.02, cy - 0.03), (0.13, cy - 0.01), (0.12, cy + 0.01), (0.05, cy + 0.04)], segs=14, caps=True).translate((x, 0, 0)))
            clamps.extend(kit.box(0.14, 0.12, 0.3, center=(x, top - STRING + 0.04, 0)))
    P.append(piece('Insulators', 'discs', ins, 'C_Build', 'ceramic_glaze', max_lod=2, smooth=45, wear=1.1))
    P.append(piece('Insulators', 'clamps', clamps, 'C_Steel', 'galv_steel', max_lod=1, smooth=35, wear=1.3))
    return {
        'pieces': P,
        'lodRatios': [1.0, 0.25, 0.06],
        # ~3800 angle-member islands: 2 px pads, not 4 + 4 (the pads were most of the lattice's atlas; T187b)
        'uvMarginPx': {'C_Steel': 2},
        'extras': {
            'heightAboveWater': PEAK_Y + 0.9 + 0.08,
            'baseY': BASE_Y,
            # conductor attach points (the bottom clamp of each string) and the earth-wire peaks, asset frame
            'attach': attach,
            'cable': {'phaseRadius': 0.018, 'earthRadius': 0.011, 'sagPerSpan': 0.012},
        },
    }
