"""
Welded aluminium setback bracket for the triple outboards (STYLE-SPEC §2 "welded aluminium bracket with a
small platform", §7 "exposed trim rams and steering tie-bar"; REFERENCES d2 welded truss frame).

Sockets: `transom` (plane, top, keel) and every `engine.<id>` mount plane + clamp top, so the setback,
engine spacing and mounting height all come from the hull JSON. Structure: transom plate with a
through-bolt pattern, box-section side and inner trusses (top chord, bottom chord, diagonals), a
tread platform on top, three engine mount plates with bolt columns, a sloped bottom skin with zinc
anodes, weld beads along every joint, the steering tie-bar with rod ends and a hydraulic steering
ram, and corrugated rigging conduits from through-transom fittings to each engine.
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo, Piece


def bar(a, b, w, h, up=(0, 1, 0)):
    """rectangular box-section bar from a to b (w across, h along `up`)"""
    a, b = Vector(a), Vector(b)
    d = b - a
    L = d.length
    g = kit.box(w, h, L, center=(0, 0, L / 2))
    z = d.normalized()
    x = Vector(up).cross(z)
    if x.length < 1e-6:
        x = Vector((1, 0, 0))
    x.normalize()
    y = z.cross(x)
    M = Matrix.Identity(4)
    for r in range(3):
        M[r][0], M[r][1], M[r][2], M[r][3] = x[r], y[r], z[r], a[r]
    return g.transform(M)


def build(A):
    T = A.transom()
    E = A.engines()
    zT = T['z']
    zM = max(e['mountZ'] for e in E)
    ytop = E[0]['clampTopY'] + 0.03
    ybot_t = ytop - 0.62          # bottom chord at the transom
    ybot_m = ytop - 0.50          # bottom chord at the mount plane
    xs = sorted(e['x'] for e in E)
    half = xs[-1] + 0.30
    webs = [-half, (xs[0] + xs[1]) / 2, (xs[1] + xs[2]) / 2, half]
    pieces = []
    welds = []

    # the hull transom bottom is a V (hull JSON deadrise): nothing on the transom plane may hang below it.
    # V line keel → chine at the transom + 5 cm clearance (keel pad lowering and the strakes' 3 cm flats)
    v_slope = (T['chineY'] - T['keelY']) / max(T['chineHalf'], 1e-6)

    def ybot_at(x):
        return max(ybot_t, T['keelY'] + abs(x) * v_slope + 0.05)

    # transom plate + through bolts
    # transom plate: square top, bottom edge clipped to the hull V (so the corners follow the transom profile)
    pw = half + 0.03
    xb = [-pw + 2 * pw * i / 16 for i in range(17)]
    kink = (ybot_t - T['keelY'] - 0.05) / max(v_slope, 1e-6)
    xb = sorted(set([round(x, 6) for x in xb] + [-kink, kink] if 0 < kink < pw else xb))
    poly = [(x, ybot_at(x) - 0.03) for x in xb] + [(pw, ytop + 0.03), (-pw, ytop + 0.03)]
    tp = kit.extrude(poly, 0.014).translate((0, 0, zT - 0.007))
    bolt_f = []
    for bx in [-half + 0.08 + i * (2 * half - 0.16) / 7 for i in range(8)]:
        for by in (ytop - 0.06, ybot_at(bx) + 0.06):
            bolt_f.append(((bx, by, zT - 0.014), (0, 0, -1), 0.012, 'rivet', False))
    pieces.append(Piece('transom_plate', tp, 'M_Metal', 'alu_bare', max_lod=2, bevel=(0.004, 2), smooth=35, fasteners=bolt_f, tier='low'))
    # hex heads on the top row only (seen from the chase cam); the rest are normal-map domes
    bolts = Geo()
    for (p, n, r, k, ru) in bolt_f[::2]:
        hx = kit.hex_prism(0.017, 0.012)
        hx.transform(Matrix.Translation(p) @ kit.rot('X', -90))
        bolts.extend(hx)
    pieces.append(Piece('transom_bolts', bolts, 'M_Metal', 'steel_zinc', max_lod=0, smooth=35))

    # trusses at each web station: top chord, bottom chord, aft post, two diagonals (box section)
    truss = Geo()
    for x in webs:
        t = 0.05 if abs(x) == half else 0.04
        a_top, b_top = (x, ytop - 0.03, zT - 0.01), (x, ytop - 0.03, zM + 0.02)
        a_bot, b_bot = (x, ybot_at(x) + 0.03, zT - 0.01), (x, ybot_m + 0.03, zM + 0.02)
        truss.extend(bar(a_top, b_top, t, 0.06))
        truss.extend(bar(a_bot, b_bot, t, 0.06))
        # §V98 (§T.192 scan): members that meet at a joint may not share side planes — the post and the second
        # diagonal are 6 mm narrower than the member they butt into (3 mm each side), as a welded box truss is
        truss.extend(bar((x, ybot_m + 0.03, zM + 0.03), (x, ytop - 0.03, zM + 0.03), t - 0.006, 0.05, up=(0, 0, 1)))
        zm = (zT + zM) / 2
        truss.extend(bar((x, ybot_at(x) + 0.06, zT - 0.03), (x, ytop - 0.06, zm), t * 0.8, 0.045, up=(0, 0, 1)))
        truss.extend(bar((x, ytop - 0.06, zm), ((x, ybot_m + 0.06, zM + 0.05)), t * 0.8 - 0.006, 0.045, up=(0, 0, 1)))
        for w in (a_top, a_bot, (x, ytop - 0.03, zm), (x, ybot_m + 0.03, zM + 0.03), (x, ytop - 0.03, zM + 0.03)):
            welds.append(w)
    pieces.append(Piece('truss', truss, 'M_Metal', 'alu_bare', max_lod=2, smooth=35, welds=welds, wear=1.2))
    # weld beads live in the normal map (compositor weld ripple at every `welds` point)

    # tread platform on top (the "small platform")
    plat = kit.box(2 * half + 0.04, 0.012, zT - zM - 0.02, center=(0, ytop + 0.006, (zT + zM) / 2))
    for i in range(10):  # raised tread bars
        zb = zM + 0.05 + i * (zT - zM - 0.1) / 9
        plat.extend(kit.box(2 * half - 0.06, 0.006, 0.012, center=(0, ytop + 0.015, zb)))
    pieces.append(Piece('platform', plat, 'M_Metal', 'alu_bare', max_lod=2, bevel=(0.003, 1), smooth=35, wear=1.4, tier='low'))

    # sloped bottom skin + zinc anodes
    bot = Geo()
    # the skin starts at the clipped transom edge and slopes down to the mount-plane chord
    ring = [(-half, ybot_at(half), zT - 0.03), (0.0, ybot_t, zT - 0.03), (half, ybot_at(half), zT - 0.03),
            (half, ybot_m, zM + 0.02), (0.0, ybot_m, zM + 0.02), (-half, ybot_m, zM + 0.02)]
    bot.extend(kit.grid_loft([[(p[0], p[1], p[2]) for p in ring], [(p[0], p[1] - 0.01, p[2]) for p in ring]], closed=True,
                             cap0=True, cap1=True))
    pieces.append(Piece('bottom_skin', bot, 'M_Metal', 'alu_bare', max_lod=2, smooth=35, wear=1.3, tier='low'))
    zinc = Geo()
    zfast = []
    for x in (xs[0] + 0.33, xs[2] - 0.33):
        zc = (zT + zM) / 2
        yc = (ybot_t + ybot_m) / 2 - 0.035
        zinc.extend(kit.box(0.2, 0.05, 0.09, center=(x, yc, zc)))
        zfast += [((x + s * 0.06, yc - 0.026, zc), (0, -1, 0), 0.01, 'screw', True) for s in (1, -1)]
    pieces.append(Piece('anodes', zinc, 'M_Metal', 'zinc', max_lod=1, bevel=(0.01, 2), smooth=35, fasteners=zfast))

    # engine mount plates with bolt columns
    for e in E:
        mp = kit.box(0.44, 0.52, 0.02, center=(e['x'], e['clampTopY'] - 0.22, e['mountZ'] + 0.01))
        f = []
        bb = Geo()
        for sx in (-0.17, 0.17):
            for by in (-0.05, -0.18, -0.31, -0.40):
                p = (e['x'] + sx + (0.028 if sx > 0 else -0.028), e['clampTopY'] + by, e['mountZ'] - 0.001)
                f.append((p, (0, 0, -1), 0.011, 'rivet', True))
        pieces.append(Piece(f'mount_plate_{e["id"]}', mp, 'M_Metal', 'powder_black', max_lod=2, bevel=(0.004, 2), smooth=35,
                            fasteners=f, wear=1.3))

    # steering tie-bar across the three steering arms + hydraulic steering ram
    arm_y = E[0]['clampTopY'] + 0.09
    arm_z = zM + 0.05
    tb = kit.cylinder(0.016, xs[2] - xs[0] + 0.12, segs=14, axis='x').translate((xs[0] - 0.06, arm_y + 0.03, arm_z))
    for x in xs:
        tb.extend(kit.cylinder(0.026, 0.05, segs=14).translate((x, arm_y + 0.005, arm_z)))
    pieces.append(Piece('tie_bar', tb, 'M_Metal', 'stainless', max_lod=1, bevel=(0.002, 1), smooth=40))
    ram_body = kit.cylinder(0.034, 0.46, segs=16, axis='x').translate((xs[0] + 0.12, ytop + 0.075, zM + 0.20))
    ram_body.extend(kit.cylinder(0.042, 0.04, segs=16, axis='x').translate((xs[0] + 0.10, ytop + 0.075, zM + 0.20)))
    ram_body.extend(kit.cylinder(0.042, 0.04, segs=16, axis='x').translate((xs[0] + 0.56, ytop + 0.075, zM + 0.20)))
    ram_body.extend(kit.box(0.08, 0.06, 0.06, center=(xs[0] + 0.33, ytop + 0.03, zM + 0.20)))
    pieces.append(Piece('steer_ram', ram_body, 'M_Metal', 'powder_black', max_lod=1, bevel=(0.004, 1), smooth=40))
    rod = kit.cylinder(0.014, 0.42, segs=10, axis='x').translate((xs[0] + 0.60, ytop + 0.075, zM + 0.20))
    pieces.append(Piece('steer_rod', rod, 'M_Metal', 'chrome_rod', max_lod=1, smooth=40))
    # hydraulic hoses to the ram (rubber)
    hose = Geo()
    for k, xo in enumerate((0.13, 0.55)):
        a = Vector((xs[0] + xo, ytop + 0.11, zM + 0.20))
        b = Vector((xs[0] + xo + 0.1, ytop + 0.02, zT - 0.02))
        mid = (a + b) / 2 + Vector((0, 0.08, 0))
        hose.extend(kit.sweep([tuple(a * (1 - t) ** 2 + mid * 2 * t * (1 - t) + b * t * t) for t in [i / 10 for i in range(11)]], 0.009, 8))
    # rigging conduits: through-transom fitting → each engine grommet
    fit = Geo()
    for e in E:
        a = Vector((e['x'] * 0.55, ytop - 0.14, zT - 0.015))
        b = Vector((e['x'] + (0.08 if e['id'] == 'P' else -0.08 if e['id'] == 'S' else 0.02), e['clampTopY'] - 0.05, e['mountZ'] + 0.01))
        mid = (a + b) / 2 + Vector((0, -0.12, 0))
        path = [tuple(a * (1 - t) ** 2 + mid * 2 * t * (1 - t) + b * t * t) for t in [i / 9 for i in range(10)]]
        hose.extend(kit.sweep(path, 0.022, 8))
        fit.extend(kit.cylinder(0.04, 0.03, segs=16).transform(Matrix.Translation(tuple(a)) @ kit.rot('X', -90)))
    pieces.append(Piece('conduits', hose, 'M_Metal', 'rubber', max_lod=1, smooth=60, wear=1.2))
    pieces.append(Piece('transom_fittings', fit, 'M_Metal', 'stainless', max_lod=1, bevel=(0.003, 1), smooth=40))
    return {'pieces': pieces, 'extras': {}}
