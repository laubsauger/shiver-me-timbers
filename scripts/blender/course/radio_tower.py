"""
THE DROWNED RADIO TOWER — Tower Reach's landmark (design doc §5 "120 m guyed broadcast mast rising from the water at
start/finish; race control's shack bolted on; start lamps hang on it; the start straight between guy anchors; red lamps
visible from every sector", §8 furniture, §1 "the radio is the grandstand").

A pre-flood AM/FM broadcast mast standing in 25 m of water with a 4° list: a triangular lattice (2.4 m faces) of
banded aviation red/white tube legs, horizontal struts and zig-zag diagonals, guy plates at 30/60/90 m with lugs
toward the three anchors, rest platforms, a caged climbing ladder, an antenna whip and aviation beacons. Race control
is a corrugated steel shack bolted onto the course-side leg at 7 m — wraparound windows, a stencilled RACE CONTROL /
CH 16 board, solar panels, VHF whips and a yagi, a chequered flag — with a ladder down to a drum pontoon. The start
lamp rig hangs off a trussed boom at 22 m: a black board of five red lamp pairs over a green row, facing the grid.

Frame: origin = still water on the mast axis; legs at asset −X (the course side) and ±60°; +Z toward the boats running
up the start straight (src/circuit/towerReach.ts TowerPlacement). The guys are drawn at runtime from extras.guys to
the anchor floats (variant GuyAnchor, instanced ×3), so the anchors can sit wherever the layout puts them.

Variant nodes: Mast · Hut · LampRig · StartLamp1..5 · StartGreen · Beacons · GuyAnchor.
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo
import course_kit as CK
from course_kit import piece

R = 2.4 / math.sqrt(3)
BASE = -14.0
TOP = 96.0
STEP = 1.6
LEG_AZ = [math.pi, math.pi / 3, -math.pi / 3]
GUY_LEVELS = [30.0, 60.0, 90.0]
HUT_FLOOR = 7.0
RIG_Y = 22.0
BOOM_X = -13.6


def leg(k, y):
    a = LEG_AZ[k]
    return (math.cos(a) * R, y, math.sin(a) * R)


def mast_pieces():
    P = []
    V = 'Mast'
    legs, horiz, diag = Geo(), Geo(), Geo()
    fast = []
    n = int(round((TOP - BASE) / STEP))
    for i in range(n):
        y0 = BASE + i * STEP
        y1 = y0 + STEP
        for k in range(3):
            legs.extend(CK.tube(leg(k, y0), leg(k, y1), 0.085, 10, caps=False))
            horiz.extend(CK.tube(leg(k, y1), leg((k + 1) % 3, y1), 0.042, 6))
            a, b = (leg(k, y0), leg((k + 1) % 3, y1)) if i % 2 == 0 else (leg((k + 1) % 3, y0), leg(k, y1))
            diag.extend(CK.tube(a, b, 0.034, 6))
        if y1 > -2 and i % 3 == 0:
            for k in range(3):
                p = leg(k, y1)
                fast.append(((p[0] * 1.07, y1 + 0.05, p[2] * 1.07), (p[0], 0, p[2]), 0.02, 'bolt', True))
    P.append(piece(V, 'legs', legs, 'C_Paint', 'mast_bands', max_lod=2, smooth=45, tier='low', fasteners=fast, wear=1.2))
    P.append(piece(V, 'struts', horiz, 'C_Paint', 'mast_bands', max_lod=2, smooth=45, tier='low', wear=1.2))
    P.append(piece(V, 'diagonals', diag, 'C_Paint', 'mast_bands', max_lod=1, smooth=45, tier='low', wear=1.2))
    # guy plates + lugs toward the anchors, rest platforms with rails
    plates, rails = Geo(), Geo()
    guys = []
    for y in GUY_LEVELS:
        tri = [(math.cos(a) * (R + 0.9), -math.sin(a) * (R + 0.9)) for a in LEG_AZ]
        plate = kit.extrude(tri, 0.05).transform(Matrix.Translation((0, y, 0)) @ kit.rot('X', -90))
        plates.extend(plate)
        for k, a in enumerate(LEG_AZ):
            out = Vector((math.cos(a), 0, math.sin(a)))
            p0 = Vector(leg(k, y)) + out * 0.2
            p1 = Vector(leg(k, y)) + out * 1.15
            plates.extend(CK.member(tuple(p0), tuple(p1), 0.06, 0.24, up=(0, 1, 0)))
            tb = Vector(leg(k, y)) + out * 1.2
            plates.extend(CK.tube(tuple(tb), tuple(tb + out * 0.9 + Vector((0, -0.3, 0))), 0.03, 8))
            guys.append({'level': y, 'leg': k, 'at': [round(v, 4) for v in (tb + out * 0.9 + Vector((0, -0.3, 0)))]})
        for k in range(3):
            a, b = Vector(leg(k, y + 1.1)), Vector(leg((k + 1) % 3, y + 1.1))
            c = (a + b) / 2
            out = Vector((c.x, 0, c.z)).normalized() * 0.9
            rails.extend(CK.tube(tuple(a + out * 0.9), tuple(b + out * 0.9), 0.025, 6))
    P.append(piece(V, 'guy_plates', plates, 'C_Steel', 'galv_steel', max_lod=2, smooth=35, wear=1.3))
    P.append(piece(V, 'platform_rails', rails, 'C_Steel', 'galv_steel', max_lod=1, smooth=50, wear=1.2))
    # the caged ladder on the course-side leg's outer face (asset −X), from the hut roof to the top
    rungs, rails2, hoops = Geo(), Geo(), Geo()
    lx = -R - 0.35
    y = HUT_FLOOR + 3.0
    # rails in 3.2 m lengths: one 85 m tube was one 85 m UV island, and the packer scaled all of C_Steel to fit it
    # across the atlas (24 px/m, 10 % of the 2048² used; T187b)
    for sz in (-0.22, 0.22):
        n_seg = int(math.ceil((TOP - 0.5 - y) / 3.2))
        for k in range(n_seg):
            ya = y + (TOP - 0.5 - y) * k / n_seg
            yb = y + (TOP - 0.5 - y) * (k + 1) / n_seg
            rails2.extend(CK.tube((lx, ya, sz), (lx, yb, sz), 0.025, 6, caps=(k == 0 or k == n_seg - 1)))
    yy = y
    while yy < TOP - 0.6:
        rungs.extend(CK.tube((lx, yy, -0.22), (lx, yy, 0.22), 0.016, 6, caps=False))
        yy += 0.35
    yy = y + 2.2
    while yy < TOP - 1.0:
        arc = [(lx - 0.35 * math.sin(t) - 0.02, yy, 0.36 * math.cos(t)) for t in [math.pi * j / 8 for j in range(9)]]
        hoops.extend(kit.sweep(arc, 0.016, 5, caps=True))
        yy += 1.25
    P.append(piece(V, 'ladder_rails', rails2, 'C_Steel', 'galv_steel', max_lod=1, smooth=50, wear=1.3))
    P.append(piece(V, 'ladder_rungs', rungs, 'C_Steel', 'galv_steel', max_lod=0, smooth=50, wear=1.3))
    P.append(piece(V, 'ladder_cage', hoops, 'C_Steel', 'galv_steel', max_lod=0, smooth=50, wear=1.3))
    # top: cap plate, antenna whip
    cap = kit.cylinder(R + 0.25, 0.12, segs=12).translate((0, TOP, 0))
    whip = kit.cylinder(0.07, 8.0, segs=8, r2=0.018).translate((0, TOP + 0.12, 0))
    P.append(piece(V, 'top_cap', cap, 'C_Steel', 'steel_painted_grey', max_lod=2, smooth=40, wear=1.3))
    # the relay that still earns the mast its keep ("the radio is the grandstand"): microwave drum dishes, FM ring bays
    # and the coax runs down a leg. They break the 110 m stick into a readable landmark silhouette
    shrouds, radomes, brackets, bays, coax = Geo(), Geo(), Geo(), Geo(), Geo()
    for (k, y, turn, rr) in ((1, 44.0, 0.35, 0.95), (2, 44.0, -0.25, 0.95), (1, 67.0, -0.2, 0.75)):
        a = LEG_AZ[k] + turn
        out = Vector((math.cos(a), 0, math.sin(a)))
        pl = Vector(leg(k, y))
        centre = pl + out * 1.25
        M = Matrix.Translation(tuple(centre)) @ kit.rot('Y', math.degrees(math.pi / 2 - a)) @ kit.rot('X', 90)
        shrouds.extend(kit.revolve([(0.12, -0.3), (rr * 0.55, -0.26), (rr, -0.05), (rr, 0.3), (rr * 0.97, 0.3)], segs=24, caps=True).transform(M))
        radomes.extend(kit.revolve([(rr * 0.96, 0.29), (rr * 0.6, 0.34), (0.0, 0.36)], segs=24, caps=False).transform(M))
        back = centre - out * 0.3
        for dy in (-0.45, 0.45):
            brackets.extend(CK.tube(tuple(pl + Vector((0, dy, 0))), tuple(back + Vector((0, dy * 0.6, 0))), 0.04, 6))
    k = 1
    po = Vector((math.cos(LEG_AZ[k]), 0, math.sin(LEG_AZ[k])))
    base_p = Vector(leg(k, 81.0)) + po * 0.75
    brackets.extend(CK.tube(tuple(base_p), tuple(base_p + Vector((0, 11.0, 0))), 0.05, 8))
    for yb in (82.0, 84.6, 87.2, 89.8, 92.4):
        brackets.extend(CK.tube(tuple(Vector(leg(k, yb))), tuple(Vector(leg(k, yb)) + po * 0.75), 0.03, 6))
    for yb in (83.3, 85.9, 88.5, 91.1):
        bays.extend(kit.torus(0.42, 0.028, 18, 6).translate(tuple(base_p + po * 0.46 + Vector((0, yb - 81.0, 0)))))
    for off in (-0.14, 0.14):
        side = Vector((-po.z, 0, po.x)) * off
        yy = HUT_FLOOR + 2.0
        while yy < 81.0:
            yb = min(81.0, yy + 3.2)
            coax.extend(CK.tube(tuple(Vector(leg(k, yy)) + side - po * 0.12), tuple(Vector(leg(k, yb)) + side - po * 0.12), 0.035, 6, caps=False))
            yy = yb
    P.append(piece(V, 'dish_shrouds', shrouds, 'C_Steel', 'steel_painted_grey', max_lod=2, smooth=40, wear=1.2))
    P.append(piece(V, 'dish_radomes', radomes, 'C_Paint', 'paint_gelcoat', max_lod=2, smooth=50, wear=1.1, tier='low'))
    P.append(piece(V, 'relay_brackets', brackets, 'C_Steel', 'galv_steel', max_lod=1, smooth=45, wear=1.3))
    P.append(piece(V, 'fm_bays', bays, 'C_Steel', 'galv_steel', max_lod=1, smooth=50, wear=1.1))
    P.append(piece(V, 'coax', coax, 'C_Paint', 'rubber_black', max_lod=0, smooth=60, tier='low'))
    P.append(piece(V, 'whip', whip, 'C_Steel', 'galv_steel', max_lod=2, smooth=45, wear=1.1))
    return P, guys


def hut_pieces():
    P = []
    V = 'Hut'
    cx = -R - 3.1
    w, h, d = 4.6, 2.8, 3.8
    y0 = HUT_FLOOR
    # cantilever frame: two I-ish beams off the course-side leg, struts down to it
    frame = Geo()
    lg = leg(0, y0)
    welds = []
    for sz in (-1.4, 1.4):
        frame.extend(CK.member((lg[0] + 0.2, y0 - 0.12, sz * 0.6), (cx - w / 2 - 0.6, y0 - 0.12, sz), 0.22, 0.22))
        frame.extend(CK.member((lg[0], y0 - 2.6, 0.0), (cx - 0.4, y0 - 0.2, sz), 0.12, 0.12))
        welds.append((lg[0] + 0.2, y0 - 0.12, sz * 0.6))
    deck = kit.box(w + 1.6, 0.1, d + 1.6, center=(cx, y0 - 0.05, 0))
    P.append(piece(V, 'frame', frame, 'C_Steel', 'steel_painted_grey', max_lod=2, smooth=None, welds=welds, wear=1.5))
    P.append(piece(V, 'deck', deck, 'C_Steel', 'galv_steel', max_lod=2, smooth=None, wear=1.3, tier='hero'))
    rail = Geo()
    hw, hd = w / 2 + 0.75, d / 2 + 0.75
    corners = [(cx - hw, -hd), (cx + hw, -hd), (cx + hw, hd), (cx - hw, hd)]
    for i in range(4):
        a, b = corners[i], corners[(i + 1) % 4]
        if i == 1:
            continue  # the mast side stays open for the door and the ladder
        for yr in (0.55, 1.05):
            rail.extend(CK.tube((a[0], y0 + yr, a[1]), (b[0], y0 + yr, b[1]), 0.025, 6))
        for t in (0.0, 0.33, 0.66):
            p = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            rail.extend(CK.tube((p[0], y0, p[1]), (p[0], y0 + 1.07, p[1]), 0.025, 6))
    P.append(piece(V, 'railing', rail, 'C_Steel', 'galv_steel', max_lod=1, smooth=50, wear=1.3))
    # the chequer banner (design doc §8 "checker banner") zip-tied outside the course-side railing, facing the straight
    bx = cx - hw - 0.05
    banner = kit.box(0.02, 0.86, 4.8, center=(bx, y0 + 0.58, 0.0))
    P.append(piece(V, 'banner', banner, 'C_Paint', 'chequer', max_lod=2, smooth=None, wear=0.9,
                   local=((bx - 0.011, y0 + 0.15, -2.4), (0, 0, 1), (0, 1, 0))))
    ties = Geo()
    for zt in (-2.35, -1.2, 0.0, 1.2, 2.35):
        for yt in (0.55, 1.05):
            ties.extend(kit.box(0.05, 0.03, 0.035, center=(bx + 0.015, y0 + yt, zt)))
    P.append(piece(V, 'banner_ties', ties, 'C_Paint', 'rubber_black', max_lod=0, smooth=None))
    walls = kit.box(w, h, d, center=(cx, y0 + h / 2, 0))
    P.append(piece(V, 'walls', walls, 'C_Paint', 'teal_corrugated', max_lod=2, smooth=None, wear=1.4, tier='hero'))
    # windows: a wide band to the course (−X), the grid side (+Z), a small one aft; frames
    glass, frames = Geo(), Geo()
    for (cxw, cyw, czw, sx, sy, sz) in (
        (cx - w / 2 - 0.02, y0 + 1.75, 0.0, 0.05, 1.0, d * 0.82),
        (cx, y0 + 1.75, d / 2 + 0.02, w * 0.62, 1.0, 0.05),
        (cx + 0.6, y0 + 1.8, -d / 2 - 0.02, 1.2, 0.8, 0.05),
    ):
        glass.extend(kit.box(sx, sy, sz, center=(cxw, cyw, czw)))
        frames.extend(kit.box(sx + (0.1 if sx > 0.1 else 0.04), 0.08, sz + (0.1 if sz > 0.1 else 0.04), center=(cxw, cyw - sy / 2 - 0.04, czw)))
        frames.extend(kit.box(sx + (0.1 if sx > 0.1 else 0.04), 0.06, sz + (0.1 if sz > 0.1 else 0.04), center=(cxw, cyw + sy / 2 + 0.03, czw)))
    P.append(piece(V, 'glass', glass, 'C_Build', 'glass_dark', max_lod=2, smooth=None))
    P.append(piece(V, 'window_frames', frames, 'C_Steel', 'steel_black', max_lod=1, smooth=None, wear=1.4))
    door = kit.box(0.05, 2.0, 0.9, center=(cx + w / 2 + 0.03, y0 + 1.0, 0.8))
    P.append(piece(V, 'door', door, 'C_Paint', 'paint_signal', max_lod=1, smooth=None, wear=1.6))
    roof = kit.box(w + 0.6, 0.08, d + 0.6, center=(cx, y0 + h + 0.12, 0)).transform(
        Matrix.Translation((cx, y0 + h + 0.12, 0)) @ kit.rot('Z', -4) @ Matrix.Translation((-cx, -(y0 + h + 0.12), 0)))
    P.append(piece(V, 'roof', roof, 'C_Steel', 'tin_roof', max_lod=2, smooth=None, wear=1.3, tier='hero'))
    # RACE CONTROL / CH 16 board over the course window
    board = kit.box(0.06, 0.62, 3.4, center=(cx - w / 2 - 0.08, y0 + h - 0.35, 0.0))
    P.append(piece(V, 'board', board, 'C_Paint', 'paint_signal_board', max_lod=2, smooth=None, wear=1.2,
                   local=((cx - w / 2 - 0.11, y0 + h - 0.35, 0.0), (0, 0, -1), (0, 1, 0))))
    words = CK.stencil_text('RACE CONTROL', 0.24, 0.02).transform(Matrix.Translation((cx - w / 2 - 0.115, y0 + h - 0.22, 0.0)) @ kit.rot('Y', -90))
    words.extend(CK.stencil_text('CH 16', 0.16, 0.02).transform(Matrix.Translation((cx - w / 2 - 0.115, y0 + h - 0.52, 0.0)) @ kit.rot('Y', -90)))
    P.append(piece(V, 'board_words', words, 'C_Paint', 'paint_stencil', max_lod=1, smooth=None))
    # roof gear: solar panels, VHF whips, a yagi, a salvaged dish
    for k, zz in enumerate((-1.1, 0.0, 1.1)):
        M = Matrix.Translation((cx + 0.9, y0 + h + 0.42, zz)) @ kit.rot('Z', 25)
        P.append(piece(V, f'solar_frame_{k}', kit.box(1.0, 0.04, 0.95).transform(M), 'C_Steel', 'steel_black', max_lod=1, smooth=None))
        o = M @ Vector((0, 0.022, 0))
        P.append(piece(V, f'solar_cells_{k}', kit.box(0.94, 0.005, 0.9, center=(0, 0.022, 0)).transform(M), 'C_Paint', 'solar_cell', max_lod=1, smooth=None,
                       local=(tuple(o), tuple((M.to_3x3() @ Vector((1, 0, 0))).normalized()), tuple((M.to_3x3() @ Vector((0, 0, 1))).normalized()))))
    ant = Geo()
    for (ax, az, hgt) in ((cx - 1.8, 1.6, 3.2), (cx - 1.8, -1.6, 2.4)):
        ant.extend(kit.cylinder(0.025, hgt, segs=6, r2=0.008).translate((ax, y0 + h + 0.16, az)))
    boom_y = y0 + h + 1.6
    ant.extend(CK.tube((cx - 0.8, y0 + h + 0.16, 0.0), (cx - 0.8, boom_y, 0.0), 0.03, 6))
    ant.extend(CK.tube((cx - 0.8, boom_y, 0.0), (cx - 2.4, boom_y, 0.0), 0.02, 6))
    for k in range(5):
        xk = cx - 0.95 - k * 0.35
        ant.extend(CK.tube((xk, boom_y, -0.4 + k * 0.04), (xk, boom_y, 0.4 - k * 0.04), 0.008, 5))
    P.append(piece(V, 'antennas', ant, 'C_Steel', 'galv_steel', max_lod=1, smooth=50, wear=1.2))
    dish = kit.revolve([(0.02, 0.0), (0.32, 0.05), (0.5, 0.14), (0.52, 0.16)], segs=18, caps=False)
    dish.transform(Matrix.Translation((cx + 1.7, y0 + h + 0.7, -1.2)) @ kit.rot('Z', 70))
    P.append(piece(V, 'dish', dish, 'C_Steel', 'steel_painted_grey', max_lod=0, smooth=40, recalc=False, wear=1.5))
    # the chequered flag on a pole at the course-side corner
    fp = CK.tube((cx - hw, y0, hd), (cx - hw, y0 + 5.2, hd), 0.035, 8)
    P.append(piece(V, 'flag_pole', fp, 'C_Steel', 'galv_steel', max_lod=1, smooth=50))
    rings = []
    for j in range(7):
        u = j / 6
        wave = 0.14 * math.sin(u * math.pi * 2.2)
        rings.append([(cx - hw - 0.04 - u * 1.5, y0 + 4.2 + v * 0.95, hd + wave + (0.012 if s > 0 else -0.012)) for (v, s) in ((0, 1), (1, 1), (1, -1), (0, -1))])
    flag = kit.grid_loft(rings, closed=True, cap0=True, cap1=True)
    P.append(piece(V, 'flag', flag, 'C_Paint', 'chequer', max_lod=1, smooth=40, wear=0.8,
                   local=((cx - hw - 0.04, y0 + 4.2, hd), (-1, 0, 0), (0, 1, 0))))
    # ladder down to the drum pontoon
    lad = Geo()
    lxl, lzl = cx + 0.4, hd + 0.2
    for sx in (-0.25, 0.25):
        lad.extend(CK.tube((lxl + sx, 0.45, lzl), (lxl + sx, y0 + 1.0, lzl), 0.03, 6))
    yy = 0.8
    while yy < y0:
        lad.extend(CK.tube((lxl - 0.25, yy, lzl), (lxl + 0.25, yy, lzl), 0.02, 6, caps=False))
        yy += 0.32
    P.append(piece(V, 'pontoon_ladder', lad, 'C_Steel', 'galv_steel', max_lod=1, smooth=50, wear=1.3))
    pz = lzl + 1.3
    planks = Geo()
    for k in range(9):
        planks.extend(kit.box(0.36, 0.06, 2.4, center=(lxl - 1.6 + k * 0.4, 0.5, pz)))
    planks.extend(kit.box(3.6, 0.12, 0.14, center=(lxl, 0.4, pz - 1.1)))
    planks.extend(kit.box(3.6, 0.12, 0.14, center=(lxl, 0.4, pz + 1.1)))
    P.append(piece(V, 'pontoon_deck', planks, 'C_Build', 'timber_weathered', max_lod=2, smooth=None, wear=1.4))
    drums = Geo()
    for sx in (-1.2, 1.2):
        drums.extend(CK.tube((lxl + sx - 0.1, 0.1, pz - 1.1), (lxl + sx - 0.1, 0.1, pz + 1.1), 0.3, 16))
    P.append(piece(V, 'pontoon_drums', drums, 'C_Paint', 'foam_float', max_lod=2, smooth=45, wear=1.4))
    tyres = Geo()
    for k in range(3):
        tyres.extend(kit.torus(0.3, 0.1, 16, 8).transform(Matrix.Translation((lxl - 1.2 + k * 1.2, 0.35, pz + 1.28)) @ kit.rot('X', 90)))
    P.append(piece(V, 'tyres', tyres, 'C_Paint', 'rubber_black', max_lod=1, smooth=60, wear=1.2))
    return P


def rig_pieces():
    P = []
    V = 'LampRig'
    truss = Geo()
    lx = leg(0, RIG_Y)[0]
    x_tip = BOOM_X + 1.5
    for sz in (-0.5, 0.5):
        truss.extend(CK.tube((lx, RIG_Y + 0.6, sz), (x_tip, RIG_Y + 0.6, sz), 0.05, 8))
        truss.extend(CK.tube((lx, RIG_Y - 0.6, sz), (x_tip, RIG_Y - 0.6, sz), 0.05, 8))
        n = 9
        for k in range(n + 1):
            x = lx + (x_tip - lx) * k / n
            truss.extend(CK.tube((x, RIG_Y - 0.6, sz), (x, RIG_Y + 0.6, sz), 0.03, 6))
            if k < n:
                x2 = lx + (x_tip - lx) * (k + 1) / n
                truss.extend(CK.tube((x, RIG_Y - 0.6, sz), (x2, RIG_Y + 0.6, sz), 0.025, 6))
    for k in range(10):
        x = lx + (x_tip - lx) * k / 9
        truss.extend(CK.tube((x, RIG_Y + 0.6, -0.5), (x, RIG_Y + 0.6, 0.5), 0.025, 6))
        truss.extend(CK.tube((x, RIG_Y - 0.6, -0.5), (x, RIG_Y - 0.6, 0.5), 0.025, 6))
    # the stay back up to the mast
    truss.extend(CK.tube((lx, RIG_Y + 6.0, 0.0), (x_tip + 1.0, RIG_Y + 0.62, 0.0), 0.03, 8))
    P.append(piece(V, 'boom', truss, 'C_Steel', 'steel_painted_grey', max_lod=2, smooth=50, wear=1.4))
    board = kit.box(3.6, 1.6, 0.14, center=(BOOM_X, RIG_Y - 0.1, 0.5))
    fast = [((BOOM_X + sx * 1.6, RIG_Y - 0.1 + sy * 0.68, 0.575), (0, 0, 1), 0.02, 'bolt', True) for sx in (-1, 1) for sy in (-1, 1)]
    P.append(piece(V, 'board', board, 'C_Steel', 'steel_black', max_lod=2, smooth=None, fasteners=fast, wear=1.2, tier='hero'))
    rect = [(-1.86, -0.86), (1.86, -0.86), (1.86, 0.86), (-1.86, 0.86)]
    border = CK.mitred_frame(rect, 0.0, 0.12, 0.02, lambda q: (BOOM_X + q[0], RIG_Y - 0.1 + q[1], 0.58 + q[2]))
    tape = CK.mitred_frame(rect, 0.14, 0.04, 0.008, lambda q: (BOOM_X + q[0], RIG_Y - 0.1 + q[1], 0.575 + q[2]))
    P.append(piece(V, 'border', border, 'C_Paint', 'paint_signal_board', max_lod=1, smooth=None, recalc=False, wear=1.2))
    P.append(piece(V, 'tape', tape, 'C_Paint', 'tape_reflective', max_lod=1, smooth=None, recalc=False, wear=1.2))
    hoods = Geo()
    for c in range(5):
        x = BOOM_X + (c - 2) * 0.62
        for yr in (RIG_Y + 0.32, RIG_Y - 0.2):
            # a half-round hood: the annular half-ring profile, extruded 0.3 m out from the board (closed shell)
            outer = [(0.23 * math.cos(t), 0.23 * math.sin(t)) for t in [math.pi * j / 10 for j in range(11)]]
            inner = [(0.205 * math.cos(t), 0.205 * math.sin(t)) for t in [math.pi * j / 10 for j in range(11)]]
            prof = outer + list(reversed(inner))
            hoods.extend(kit.extrude(prof, 0.3, center=False).translate((x, yr, 0.57)))
    P.append(piece(V, 'visors', hoods, 'C_Steel', 'steel_black', max_lod=1, smooth=45, wear=1.1))
    # the run of cable from the board back along the boom
    cable = kit.sweep(CK.catenary((BOOM_X + 1.7, RIG_Y - 0.9, 0.2), (lx, RIG_Y - 0.9, 0.2), 0.35, 14), 0.02, 5)
    P.append(piece(V, 'cable', cable, 'C_Paint', 'rubber_black', max_lod=0, smooth=60))
    lamps = []
    for c in range(5):
        x = BOOM_X + (c - 2) * 0.62
        g = Geo()
        for yr in (RIG_Y + 0.32, RIG_Y - 0.2):
            g.extend(kit.cylinder(0.19, 0.06, segs=24, axis='z').translate((x, yr, 0.57)))
        P.append(piece(f'StartLamp{c + 1}', 'lenses', g, 'C_Lamp', 'lens_red', max_lod=2, smooth=45, wear=0.6))
        lamps.append({'role': 'startRed', 'column': c + 1, 'at': [round(x, 3), RIG_Y + 0.06, 0.66], 'colour': '#E0432F'})
    gg = Geo()
    for c in range(5):
        x = BOOM_X + (c - 2) * 0.62
        gg.extend(kit.cylinder(0.1, 0.05, segs=16, axis='z').translate((x, RIG_Y - 0.66, 0.57)))
    P.append(piece('StartGreen', 'lenses', gg, 'C_Lamp', 'lens_green', max_lod=2, smooth=45, wear=0.6))
    return P, lamps


def beacon_pieces():
    P = []
    g = Geo()
    g.extend(kit.cylinder(0.24, 0.42, segs=20).translate((0, TOP + 0.12, 0)))
    for y in (48.0, 72.0):
        for k in (1, 2):
            p = Vector(leg(k, y))
            out = Vector((p.x, 0, p.z)).normalized()
            g.extend(kit.cylinder(0.14, 0.24, segs=16).translate(tuple(p + out * 0.32)))
    P.append(piece('Beacons', 'lenses', g, 'C_Lamp', 'lens_red', max_lod=2, smooth=45, wear=0.5))
    housings = Geo()
    for y in (48.0, 72.0):
        for k in (1, 2):
            p = Vector(leg(k, y))
            out = Vector((p.x, 0, p.z)).normalized()
            housings.extend(CK.member(tuple(p), tuple(p + out * 0.3), 0.06, 0.06))
    P.append(piece('Mast', 'beacon_brackets', housings, 'C_Steel', 'steel_black', max_lod=1, smooth=None))
    return P


def anchor_pieces():
    V = 'GuyAnchor'
    P = []
    drum = kit.revolve([(0.12, -0.6), (0.62, -0.5), (0.65, 0.3), (0.55, 0.45), (0.1, 0.48)], segs=28, caps=True)
    P.append(piece(V, 'float', drum, 'C_Paint', 'foam_float', max_lod=2, smooth=40, wear=1.4))
    band = kit.cylinder(0.655, 0.36, segs=28, caps=False).translate((0, -0.05, 0))
    P.append(piece(V, 'hazard', band, 'C_Paint', 'hazard_band', max_lod=2, smooth=40, wear=1.3))
    frame = Geo()
    for a in (0.0, math.pi * 2 / 3, math.pi * 4 / 3):
        frame.extend(CK.tube((math.cos(a) * 0.5, 0.46, math.sin(a) * 0.5), (0, 1.05, 0), 0.03, 6))
    frame.extend(CK.tube((0, 1.05, 0), (0, 1.5, 0), 0.04, 8))
    frame.extend(kit.torus(0.08, 0.02, 12, 5).transform(Matrix.Translation((0, 1.58, 0)) @ kit.rot('X', 90)))
    P.append(piece(V, 'frame', frame, 'C_Steel', 'galv_steel', max_lod=1, smooth=50, wear=1.4))
    return P


def build(args):
    P = []
    mast, guys = mast_pieces()
    P += mast
    P += hut_pieces()
    rig, lamps = rig_pieces()
    P += rig
    P += beacon_pieces()
    P += anchor_pieces()
    return {
        'pieces': P,
        'lodRatios': [1.0, 0.2, 0.05],
        'uvMarginPx': {'C_Paint': 2, 'C_Steel': 2},
        'extras': {
            'heightAboveWater': TOP + 8.12,
            'baseY': BASE,
            'legAzimuths': LEG_AZ,
            'guys': guys,
            'guyAnchorTop': [0, 1.58, 0],
            'hutFloorY': HUT_FLOOR,
        },
        'variantExtras': {
            **{f'StartLamp{i + 1}': {'lamps': [lamps[i]]} for i in range(5)},
            'StartGreen': {'lamps': [{'role': 'startGreen', 'at': [BOOM_X, RIG_Y - 0.66, 0.62], 'colour': '#58C27A'}]},
            'Beacons': {'lamps': [{'role': 'aviation', 'at': [0, TOP + 0.33, 0], 'colour': '#E0432F', 'flashHz': 0.6}]},
        },
    }
