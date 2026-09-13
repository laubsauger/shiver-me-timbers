"""
DROWNED TOWN ROOFS — Main Street (design doc §5: "roof ridges and gables just awash, a steeple, a water tower";
the Sierra foothill line: a gold-rush main street of clapboard houses, a brick false-front store, a white church).

Each variant is a WHOLE building from its old ground floor (y = 0) to its roof, so the upper storey reads
through clear water where the town sits 6–9 m down; the placement's `floor` puts y = 0 on the measured bench.
The contract's `roofs` table (eave / ridge / top) is checked against this geometry by the course checker, and
the course tests use it to prove roofs and chimneys actually break the surface.

  Gable         two-storey clapboard house, gable end to the street, shingle roof, attic window, gutters, TV aerial
  GableChimney  the same family with a brick chimney and a shed dormer, slate roof
  Hip           a hipped cottage, slate, a salvaged satellite dish
  Shed          brick false-front store: parapet with cornice, corrugated tin shed roof, a faded sign board
  Steeple       white clapboard church: steep nave roof, bell tower with louvred belfry, shingled spire, weathervane
  WaterTower    four braced legs, a riveted tank with a conical roof, catwalk and ladder

Origin = the old ground floor at the plot centre; +Z = the street front.
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo
import course_kit as CK
from course_kit import piece

CONTRACT = CK.load_contract()['roofs']


def slab(corners, t):
    """a thick quad slab from 4 top corners (CCW seen from above), extruded down by t along world −Y"""
    g = Geo()
    top = [g.vert(tuple(c)) for c in corners]
    bot = [g.vert((c[0], c[1] - t, c[2])) for c in corners]
    g.face(tuple(top))
    g.face(tuple(reversed(bot)))
    for i in range(4):
        j = (i + 1) % 4
        g.face((top[j], top[i], bot[i], bot[j]))
    return g


def gable_roof(w, d, eave, ridge, over=0.45, t=0.14):
    """ridge along z (gable ends face ±z); returns (roof slabs, ridge cap, fascias)"""
    hw = w / 2 + over
    hd = d / 2 + over
    slope = (ridge - eave) / (w / 2)
    ye = eave - over * slope
    roof = Geo()
    roof.extend(slab([(-hw, ye, -hd), (-hw, ye, hd), (0, ridge + 0.05, hd), (0, ridge + 0.05, -hd)], t))
    roof.extend(slab([(0, ridge + 0.05, -hd), (0, ridge + 0.05, hd), (hw, ye, hd), (hw, ye, -hd)], t))
    cap = CK.member((0, ridge + 0.08, -hd - 0.02), (0, ridge + 0.08, hd + 0.02), 0.22, 0.1)
    fascia = Geo()
    for sz in (1, -1):
        fascia.extend(CK.member((-hw, ye - 0.08, sz * hd), (0, ridge - 0.03, sz * hd), 0.22, 0.05, up=(0, 0, 1)))
        fascia.extend(CK.member((0, ridge - 0.03, sz * hd), (hw, ye - 0.08, sz * hd), 0.22, 0.05, up=(0, 0, 1)))
    return roof, cap, fascia


def house_body(w, d, eave, windows_z=True):
    """clapboard walls to the eave with the gable triangles, window openings as dark insets with trim"""
    walls = kit.box(w, eave, d, center=(0, eave / 2, 0))
    glass = Geo()
    trim = Geo()
    rows = [2.1, 4.6]
    for y in rows:
        for x in (-w * 0.25, w * 0.25):
            glass.extend(kit.box(1.0, 1.3, 0.04, center=(x, y, d / 2 + 0.005)))
            trim.extend(kit.box(1.2, 0.1, 0.08, center=(x, y - 0.7, d / 2 + 0.03)))
            trim.extend(kit.box(1.2, 0.08, 0.06, center=(x, y + 0.7, d / 2 + 0.02)))
        for z in (-d * 0.25, d * 0.25):
            for sx in (1, -1):
                glass.extend(kit.box(0.04, 1.3, 1.0, center=(sx * (w / 2 + 0.005), y, z)))
                trim.extend(kit.box(0.08, 0.1, 1.2, center=(sx * (w / 2 + 0.03), y - 0.7, z)))
    corners = Geo()
    for sx in (1, -1):
        for sz in (1, -1):
            corners.extend(kit.box(0.14, eave, 0.14, center=(sx * (w / 2 + 0.03), eave / 2, sz * (d / 2 + 0.03))))
    return walls, glass, trim, corners


def gable_ends(w, d, eave, ridge):
    g = Geo()
    for sz in (1, -1):
        z = sz * d / 2
        ids = [g.vert((-w / 2, eave, z)), g.vert((w / 2, eave, z)), g.vert((0, ridge, z))]
        back = [g.vert((-w / 2, eave, z - sz * 0.12)), g.vert((w / 2, eave, z - sz * 0.12)), g.vert((0, ridge, z - sz * 0.12))]
        if sz > 0:
            g.face((ids[0], ids[1], ids[2]))
            g.face((back[2], back[1], back[0]))
        else:
            g.face((ids[2], ids[1], ids[0]))
            g.face((back[0], back[1], back[2]))
        for i in range(3):
            j = (i + 1) % 3
            if sz > 0:
                g.face((ids[j], ids[i], back[i], back[j]))
            else:
                g.face((ids[i], ids[j], back[j], back[i]))
    return g


def gutters(w, d, eave, over=0.45, slope=0.7):
    g = Geo()
    ye = eave - over * slope - 0.12
    for sx in (1, -1):
        g.extend(CK.tube((sx * (w / 2 + over), ye, -d / 2 - over), (sx * (w / 2 + over), ye, d / 2 + over), 0.07, 8))
        g.extend(CK.tube((sx * (w / 2 + over - 0.05), ye, d / 2 + over - 0.1), (sx * (w / 2 + 0.1), 0.2, d / 2 + 0.1), 0.045, 8))
    return g


def build_gable(V, chimney):
    P = []
    w, d = 7.6, 10.0
    dims = CONTRACT[V]
    eave, ridge = dims['eave'], dims['ridge']
    walls, glass, trim, corners = house_body(w, d, eave)
    look = 'clapboard_sage' if not chimney else 'clapboard_ochre'
    P.append(piece(V, 'walls', walls.extend(gable_ends(w, d, eave, ridge)), 'C_Build', look, max_lod=2, smooth=None, wear=1.3))
    P.append(piece(V, 'glass', glass, 'C_Build', 'glass_dark', max_lod=1, smooth=None))
    P.append(piece(V, 'trim', trim.extend(corners), 'C_Paint', 'paint_white_trim', max_lod=1, smooth=None, wear=1.4))
    roof, cap, fascia = gable_roof(w, d, eave, ridge)
    P.append(piece(V, 'roof', roof, 'C_Build', 'shingles_cedar' if not chimney else 'shingles_slate', max_lod=2, smooth=None, wear=1.2, tier='hero'))
    P.append(piece(V, 'ridge_cap', cap.extend(fascia), 'C_Paint', 'paint_white_trim', max_lod=1, smooth=None, wear=1.5))
    P.append(piece(V, 'gutters', gutters(w, d, eave, slope=(ridge - eave) / (w / 2)), 'C_Steel', 'steel_painted_grey', max_lod=0, smooth=50, wear=1.6))
    # attic window in the street gable
    P.append(piece(V, 'attic_glass', kit.box(0.9, 0.9, 0.05, center=(0, eave + (ridge - eave) * 0.4, d / 2 + 0.01)), 'C_Build', 'glass_dark', max_lod=0, smooth=None))
    if chimney:
        top = dims['top']
        ch = kit.box(0.9, top - eave + 1.2, 0.9, center=(w * 0.26, (eave - 1.2 + top) / 2 - 0.12, -d * 0.2))
        ch.extend(kit.box(1.05, 0.14, 1.05, center=(w * 0.26, top - 0.07, -d * 0.2)))
        P.append(piece(V, 'chimney', ch, 'C_Build', 'brick_red', max_lod=2, bevel=(0.01, 1), smooth=None, wear=1.3))
        # shed dormer on the other slope
        slope = (ridge - eave) / (w / 2)
        dx = -w * 0.25
        dy = eave + (w / 2 + dx) * slope
        dorm = kit.box(1.8, 1.3, 2.2, center=(dx, dy + 0.4, d * 0.05))
        P.append(piece(V, 'dormer', dorm, 'C_Build', 'clapboard_ochre', max_lod=1, smooth=None, wear=1.3))
        P.append(piece(V, 'dormer_glass', kit.box(0.05, 0.7, 1.3, center=(dx - 0.91, dy + 0.45, d * 0.05)), 'C_Build', 'glass_dark', max_lod=0, smooth=None))
    else:
        # a TV aerial on the ridge: the last broadcast anyone here received
        aer = Geo()
        mast_top = dims['top'] - 0.02
        aer.extend(CK.tube((0.4, ridge, -d * 0.3), (0.4, mast_top, -d * 0.3), 0.02, 6))
        P.append(piece(V, 'aerial', aer, 'C_Steel', 'galv_steel', max_lod=0, smooth=60))
    return P


def build_hip():
    V = 'Hip'
    P = []
    w, d = 8.4, 8.4
    dims = CONTRACT[V]
    eave, ridge = dims['eave'], dims['ridge']
    walls, glass, trim, corners = house_body(w, d, eave)
    P.append(piece(V, 'walls', walls, 'C_Build', 'clapboard_bone', max_lod=2, smooth=None, wear=1.3))
    P.append(piece(V, 'glass', glass, 'C_Build', 'glass_dark', max_lod=1, smooth=None))
    P.append(piece(V, 'trim', trim.extend(corners), 'C_Paint', 'paint_white_trim', max_lod=1, smooth=None, wear=1.4))
    over = 0.45
    hw, hd = w / 2 + over, d / 2 + over
    slope = (ridge - eave) / (w / 2 - 1.0)
    ye = eave - over * slope
    r = 1.0
    top = ridge + 0.04
    roof = Geo()
    quads = [
        [(-hw, ye, hd), (hw, ye, hd), (r, top, 0), (-r, top, 0)],
        [(hw, ye, -hd), (-hw, ye, -hd), (-r, top, 0), (r, top, 0)],
    ]
    tris = [[(hw, ye, hd), (hw, ye, -hd), (r, top, 0)], [(-hw, ye, -hd), (-hw, ye, hd), (-r, top, 0)]]
    for q in quads:
        roof.extend(slab(q, 0.14))
    for tri in tris:
        g = Geo()
        a = [g.vert(p) for p in tri]
        b = [g.vert((p[0], p[1] - 0.14, p[2])) for p in tri]
        g.face((a[0], a[1], a[2]))
        g.face((b[2], b[1], b[0]))
        for i in range(3):
            j = (i + 1) % 3
            g.face((a[j], a[i], b[i], b[j]))
        roof.extend(g)
    P.append(piece(V, 'roof', roof, 'C_Build', 'shingles_slate', max_lod=2, smooth=None, wear=1.2, tier='hero'))
    cap = CK.member((-r - 0.05, top + 0.05, 0), (r + 0.05, top + 0.05, 0), 0.2, 0.1)
    P.append(piece(V, 'ridge_cap', cap, 'C_Paint', 'paint_white_trim', max_lod=1, smooth=None, wear=1.5))
    # a salvaged satellite dish on a bracket at the eave
    dish = kit.revolve([(0.02, 0.0), (0.3, 0.04), (0.5, 0.12), (0.52, 0.14)], segs=18, caps=False)
    dish.transform(Matrix.Translation((w / 2 - 0.6, ridge - 0.9, hd - 0.4)) @ kit.rot('X', 60))
    arm = CK.tube((w / 2 - 0.6, ridge - 1.6, hd - 0.9), (w / 2 - 0.6, ridge - 0.9, hd - 0.4), 0.025, 6)
    P.append(piece(V, 'dish', dish.extend(arm), 'C_Steel', 'steel_painted_grey', max_lod=0, smooth=40, recalc=False, wear=1.5))
    return P


def build_shed():
    V = 'Shed'
    P = []
    w, d = 9.0, 14.0
    dims = CONTRACT[V]
    eave, ridge, top = dims['eave'], dims['ridge'], dims['top']
    body = kit.box(w, eave, d, center=(0, eave / 2, 0))
    P.append(piece(V, 'brick', body, 'C_Build', 'brick_red', max_lod=2, smooth=None, wear=1.3))
    # false front: the parapet facade to `top`, stepped, with a cornice
    face = kit.box(w + 0.4, top - 0.35, 0.5, center=(0, (top - 0.35) / 2, d / 2 + 0.25))
    face.extend(kit.box(w * 0.5, 0.35, 0.5, center=(0, top - 0.175, d / 2 + 0.25)))
    P.append(piece(V, 'facade', face, 'C_Build', 'brick_red', max_lod=2, smooth=None, wear=1.3))
    cornice = kit.box(w + 0.8, 0.3, 0.8, center=(0, top - 0.5, d / 2 + 0.3))
    cornice.extend(kit.box(w * 0.5 + 0.3, 0.2, 0.7, center=(0, top - 0.02, d / 2 + 0.28)))
    for k in range(9):
        cornice.extend(kit.box(0.18, 0.35, 0.25, center=(-w / 2 + 0.3 + k * (w - 0.6) / 8, top - 0.82, d / 2 + 0.62)))
    P.append(piece(V, 'cornice', cornice, 'C_Paint', 'paint_white_trim', max_lod=1, smooth=None, wear=1.5))
    sign = kit.box(w * 0.7, 1.0, 0.08, center=(0, top - 1.75, d / 2 + 0.54))
    P.append(piece(V, 'sign', sign, 'C_Paint', 'paint_teal_faded', max_lod=1, smooth=None, wear=1.6))
    words = CK.stencil_text('GENERAL STORE', 0.55, 0.03).transform(Matrix.Translation((0, top - 1.75, d / 2 + 0.6)))
    P.append(piece(V, 'sign_words', words, 'C_Paint', 'paint_white_trim', max_lod=0, smooth=None, wear=1.2))
    # upper windows: tall arched-looking sash in the facade
    glass = Geo()
    for x in (-w * 0.3, 0.0, w * 0.3):
        glass.extend(kit.box(1.0, 1.9, 0.05, center=(x, 4.8, d / 2 + 0.51)))
    P.append(piece(V, 'glass', glass, 'C_Build', 'glass_dark', max_lod=1, smooth=None))
    # shed roof: tin, from `ridge` at the facade falling to `eave` at the back, on rafters
    hw = w / 2 + 0.2
    roof = slab([(-hw, eave, -d / 2 - 0.4), (-hw, ridge, d / 2), (hw, ridge, d / 2), (hw, eave, -d / 2 - 0.4)], 0.06)
    P.append(piece(V, 'tin', roof, 'C_Steel', 'tin_roof', max_lod=2, smooth=None, wear=1.2, tier='hero'))
    # a stove pipe through the tin
    pipe = CK.tube((2.0, eave + 0.3, -d * 0.2), (2.0, ridge + 0.9, -d * 0.2), 0.14, 10)
    pipe.extend(kit.cylinder(0.24, 0.12, segs=10).translate((2.0, ridge + 0.9, -d * 0.2)))
    P.append(piece(V, 'stovepipe', pipe, 'C_Steel', 'steel_black', max_lod=1, smooth=45, wear=1.5))
    return P


def build_steeple():
    V = 'Steeple'
    P = []
    w, d = 9.0, 16.0
    dims = CONTRACT[V]
    eave, ridge, top = dims['eave'], dims['ridge'], dims['top']
    walls = kit.box(w, eave, d, center=(0, eave / 2, -1.0))
    walls.extend(gable_ends(w, d, eave, ridge).translate((0, 0, -1.0)))
    P.append(piece(V, 'nave', walls, 'C_Build', 'clapboard_bone', max_lod=2, smooth=None, wear=1.2))
    glass = Geo()
    for z in (-6.5, -3.5, -0.5, 2.5):
        for sx in (1, -1):
            glass.extend(kit.box(0.05, 3.2, 1.1, center=(sx * (w / 2 + 0.005), 4.8, z)))
    P.append(piece(V, 'glass', glass, 'C_Build', 'glass_dark', max_lod=1, smooth=None))
    roof, cap, fascia = gable_roof(w, d, eave, ridge, over=0.35)
    roof.translate((0, 0, -1.0))
    P.append(piece(V, 'roof', roof, 'C_Build', 'shingles_slate', max_lod=2, smooth=None, wear=1.2, tier='hero'))
    P.append(piece(V, 'trim', cap.extend(fascia).translate((0, 0, -1.0)), 'C_Paint', 'paint_white_trim', max_lod=1, smooth=None, wear=1.4))
    # the tower at the street end, belfry louvres, a spire to `top`
    tw = 3.6
    tz = d / 2 - 1.0 + tw / 2 - 0.4
    tower_top = 15.2
    tower = kit.box(tw, tower_top, tw, center=(0, tower_top / 2, tz))
    P.append(piece(V, 'tower', tower, 'C_Build', 'clapboard_bone', max_lod=2, smooth=None, wear=1.2))
    lou = Geo()
    for rot in (0, 90, 180, 270):
        for k in range(5):
            slat = kit.box(1.8, 0.08, 0.3)
            slat.transform(Matrix.Translation((0, 0, tz)) @ kit.rot('Y', rot) @ Matrix.Translation((0, 12.8 + k * 0.32, tw / 2 + 0.05)) @ kit.rot('X', -30))
            lou.extend(slat)
    P.append(piece(V, 'louvres', lou, 'C_Build', 'timber_weathered', max_lod=1, smooth=None, wear=1.3))
    band = kit.box(tw + 0.3, 0.35, tw + 0.3, center=(0, tower_top + 0.17, tz))
    P.append(piece(V, 'tower_trim', band, 'C_Paint', 'paint_white_trim', max_lod=1, smooth=None, wear=1.3))
    spire_h = top - 0.9 - (tower_top + 0.35)
    spire = Geo()
    base = [(-tw / 2 - 0.05, tower_top + 0.35, tz - tw / 2 - 0.05), (tw / 2 + 0.05, tower_top + 0.35, tz - tw / 2 - 0.05),
            (tw / 2 + 0.05, tower_top + 0.35, tz + tw / 2 + 0.05), (-tw / 2 - 0.05, tower_top + 0.35, tz + tw / 2 + 0.05)]
    apex = spire.vert((0, tower_top + 0.35 + spire_h, tz))
    ids = [spire.vert(p) for p in base]
    for i in range(4):
        j = (i + 1) % 4
        spire.face((ids[j], ids[i], apex))
    spire.face(tuple(ids))
    P.append(piece(V, 'spire', spire, 'C_Build', 'shingles_slate', max_lod=2, smooth=None, wear=1.2))
    vane = CK.tube((0, tower_top + 0.3 + spire_h, tz), (0, top, tz), 0.03, 6)
    vane.extend(kit.box(0.9, 0.18, 0.03, center=(0.2, top - 0.35, tz)))
    P.append(piece(V, 'weathervane', vane, 'C_Steel', 'steel_black', max_lod=1, smooth=None, wear=1.5))
    return P


def build_water_tower():
    V = 'WaterTower'
    P = []
    dims = CONTRACT[V]
    eave, ridge, top = dims['eave'], dims['ridge'], dims['top']
    R = 3.2
    legs = Geo()
    spread = 3.4
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        legs.extend(CK.tube((math.cos(a) * spread, 0, math.sin(a) * spread), (math.cos(a) * 2.3, eave, math.sin(a) * 2.3), 0.17, 12))
    brace = Geo()
    for y0, y1 in ((0.5, 5.0), (5.0, 9.5), (9.5, 14.0)):
        for k in range(4):
            a0 = math.pi / 4 + k * math.pi / 2
            a1 = a0 + math.pi / 2
            def lp(a, y):
                s = spread + (2.3 - spread) * (y / eave)
                return (math.cos(a) * s, y, math.sin(a) * s)
            brace.extend(CK.tube(lp(a0, y0), lp(a1, y1), 0.035, 6))
            brace.extend(CK.tube(lp(a1, y0), lp(a0, y1), 0.035, 6))
            brace.extend(CK.tube(lp(a0, y1), lp(a1, y1), 0.06, 8))
    P.append(piece(V, 'legs', legs, 'C_Steel', 'tank_steel', max_lod=2, smooth=45, wear=1.3))
    P.append(piece(V, 'bracing', brace, 'C_Steel', 'galv_steel', max_lod=1, smooth=45, wear=1.4))
    tank = kit.revolve([(0.6, eave - 1.2), (2.4, eave - 0.3), (R, eave), (R, ridge), (R - 0.1, ridge + 0.05)], segs=40, caps=True)
    fast = []
    for yb in (eave + 0.3, (eave + ridge) / 2, ridge - 0.3):
        for k in range(20):
            a = 2 * math.pi * k / 20
            fast.append(((math.cos(a) * (R + 0.01), yb, math.sin(a) * (R + 0.01)), (math.cos(a), 0, math.sin(a)), 0.02, 'rivet', True))
    P.append(piece(V, 'tank', tank, 'C_Steel', 'tank_steel', max_lod=2, smooth=40, fasteners=fast, wear=1.3, tier='hero'))
    cone = kit.revolve([(R + 0.2, ridge - 0.05), (R + 0.15, ridge + 0.05), (0.3, top - 0.25), (0.08, top)], segs=40, caps=True)
    P.append(piece(V, 'roof', cone, 'C_Steel', 'tin_roof', max_lod=2, smooth=40, wear=1.2))
    walk = kit.torus(R + 0.7, 0.05, 40, 5).translate((0, eave + 1.0, 0))
    walk.extend(kit.cylinder(R + 0.75, 0.06, segs=40, caps=True).translate((0, eave - 0.05, 0)))
    for k in range(16):
        a = 2 * math.pi * k / 16
        walk.extend(CK.tube((math.cos(a) * (R + 0.7), eave, math.sin(a) * (R + 0.7)), (math.cos(a) * (R + 0.7), eave + 1.0, math.sin(a) * (R + 0.7)), 0.03, 6))
    P.append(piece(V, 'catwalk', walk, 'C_Steel', 'galv_steel', max_lod=1, smooth=45, wear=1.4))
    lad = Geo()
    for sx in (-0.25, 0.25):
        lad.extend(CK.tube((sx, 0.3, spread + 0.3), (sx, eave, 2.3 + 0.55), 0.03, 6))
    for k in range(40):
        y = 0.6 + k * 0.35
        if y > eave - 0.2:
            break
        z = spread + 0.3 + (2.3 + 0.55 - spread - 0.3) * (y / eave)
        lad.extend(CK.tube((-0.25, y, z), (0.25, y, z), 0.02, 6))
    P.append(piece(V, 'ladder', lad, 'C_Steel', 'galv_steel', max_lod=0, smooth=50, wear=1.4))
    return P


def build(args):
    P = []
    P += build_gable('Gable', chimney=False)
    P += build_gable('GableChimney', chimney=True)
    P += build_hip()
    P += build_shed()
    P += build_steeple()
    P += build_water_tower()
    return {
        'pieces': P,
        'lodRatios': [1.0, 0.3, 0.1],
        'variantExtras': {k: {'eave': v['eave'], 'ridge': v['ridge'], 'top': v['top']} for k, v in CONTRACT.items() if k != 'about'},
        'extras': {'origin': 'old ground floor at the plot centre; +Z = street front'},
    }
