"""
Salvaged ethanol V8 outboard (Mercury Racing 450R class, REFERENCES d6/d7/d9; concept 04, 09 bottom-left).

Hangs off `engine.<id>` sockets: mount plane (bracket plate), clamp top (cavitation plate + 30 in
shaft) and the JSON prop point. Local frame: origin at the clamp top on the mount plane, x across,
y up, z toward the bow (the engine hangs aft, −z). The lower unit is proportioned between the mount
plane and the prop point, so a physics change to either re-proportions it.

Parts of the node (one node per engine; the prop is its own node, prop.py):
  cowl (lower chaps / upper cowl / livery top cap with real panel gaps), rear and front vents,
  latches, rigging grommet + hoses, fuel-port cap; midsection foil, anti-ventilation plate, trim tab
  anode, gearcase torpedo, skeg, water-pickup screens; clamp bracket, tilt tube, swivel tube,
  trim rams + tilt ram (chrome rods), steering arm. Salvage story: the starboard engine carries a
  riveted aluminium replacement panel (09 bottom-left); the port one a cleaner repaint.
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo, Piece

SEG = 32

# cowl silhouette table: h, front z, rear z, half width, superellipse exponent (y = y0 + H·h)
COWL = [
    (0.00, -0.190, -0.560, 0.150, 2.6),
    (0.05, -0.140, -0.640, 0.190, 2.9),
    (0.12, -0.105, -0.720, 0.222, 3.2),
    (0.22, -0.085, -0.790, 0.246, 3.6),
    (0.33, -0.075, -0.835, 0.254, 3.8),
    (0.34, -0.074, -0.838, 0.255, 3.8),
    (0.36, -0.058, -0.872, 0.274, 4.0),
    (0.42, -0.052, -0.890, 0.281, 4.2),
    (0.60, -0.048, -0.905, 0.2875, 4.4),
    (0.76, -0.052, -0.902, 0.2860, 4.4),
    (0.80, -0.056, -0.898, 0.2845, 4.3),
    (0.82, -0.058, -0.895, 0.2835, 4.3),
    (0.90, -0.070, -0.880, 0.278, 4.0),
    (0.95, -0.090, -0.860, 0.266, 3.6),
    (0.98, -0.120, -0.830, 0.244, 3.2),
    (0.995, -0.150, -0.800, 0.215, 2.8),
    (1.00, -0.175, -0.770, 0.185, 2.6),
]
TOP_SLOPE = 0.16   # the cap falls toward the rear vent (concept 04)
Y0 = -0.20
H = 0.98


def _cowl_row(h):
    for a, b in zip(COWL[:-1], COWL[1:]):
        if a[0] <= h <= b[0]:
            t = (h - a[0]) / (b[0] - a[0])
            return tuple(a[i] + (b[i] - a[i]) * t for i in range(5))
    return COWL[-1]


def _slope(h, z):
    # the top rolls off rearward: rings above h 0.7 tilt so the aft edge sits lower
    k = kit.smoothstep(0.70, 1.0, h)
    return TOP_SLOPE * k * (z + 0.47)


def cowl_ring(h, inset=0.0, segs=SEG, dy=0.0):
    _, zf, zr, w, n = _cowl_row(h)
    cz = (zf + zr) / 2
    hl = (zf - zr) / 2
    ring = kit.superellipse_ring(max(w - inset, 0.01), max(hl - inset, 0.01), max(hl - inset, 0.01), n, segs, Y0 + H * h + dy, 0.0, cz)
    return [(x, y + _slope(h, z), z) for (x, y, z) in ring]


def cowl_point(h, ang):
    """surface point + outward normal at height fraction h, angle ang (0 = +x flank, π/2 = rear)"""
    _, zf, zr, w, n = _cowl_row(h)
    cz = (zf + zr) / 2
    hl = (zf - zr) / 2
    c, s = math.cos(ang), math.sin(ang)
    x = w * math.copysign(abs(c) ** (2 / n), c)
    z = cz - hl * math.copysign(abs(s) ** (2 / n), s)
    # normal of |x/w|^n + |z/hl|^n = 1
    nx = math.copysign(abs(x / w) ** (n - 1), x) / w
    nz = -math.copysign(abs((cz - z) / hl) ** (n - 1), (cz - z)) / hl
    nrm = Vector((nx, 0.0, nz)).normalized()
    return Vector((x, Y0 + H * h + _slope(h, z), z)), nrm


def cowl_shell(h0, h1, rows, lip0=True, lip1=True, gap=0.004, grooves=()):
    """one cowl panel between h0 and h1 with rolled lips (real panel gaps) and moulded grooves"""
    hs = [(h0 + (h1 - h0) * i / rows, 0.0) for i in range(rows + 1)]
    for hg in grooves:  # a 2.5 cm moulded character groove, 4 mm deep, with crisp shoulders
        hs = [(h, i) for (h, i) in hs if not (hg - 0.024 < h < hg + 0.024)]
        hs += [(hg - 0.018, 0.0), (hg - 0.012, 0.004), (hg + 0.012, 0.004), (hg + 0.018, 0.0)]
    hs = sorted(set(hs))
    rings = []
    if lip0:
        rings.append(cowl_ring(h0, inset=0.012, dy=gap * 0.5))
        rings.append(cowl_ring(h0, inset=0.003, dy=gap * 0.5))
    for i, (h, ins) in enumerate(hs):
        dy = gap * 0.5 if (i == 0 and lip0) else (-gap * 0.5 if (i == len(hs) - 1 and lip1) else 0.0)
        rings.append(cowl_ring(h, inset=ins, dy=dy))
    if lip1:
        rings.append(cowl_ring(h1, inset=0.003, dy=-gap * 0.5))
        rings.append(cowl_ring(h1, inset=0.012, dy=-gap * 0.5))
    return kit.grid_loft(rings, closed=True)


def cowl_top(h0, rows=6):
    hs = [h0 + (1.0 - h0) * (1 - math.cos(0.5 * math.pi * i / rows)) for i in range(rows + 1)]
    rings = [cowl_ring(h0, inset=0.012, dy=0.002), cowl_ring(h0, inset=0.003, dy=0.002)]
    for i, h in enumerate(hs):
        rings.append(cowl_ring(h, dy=0.002 if i == 0 else 0.0))
    g = kit.grid_loft(rings, closed=True, cap1=True)
    return g


def foil_section(chord_le, chord_te, y, thick, segs=12, x0=0.0):
    """symmetric NACA-00xx section in the XZ plane from leading edge z (fwd) to trailing edge z"""
    c = chord_le - chord_te
    pts_top, pts_bot = [], []
    for i in range(segs + 1):
        t = (1 - math.cos(math.pi * i / segs)) / 2  # cosine spacing
        yt = 5 * thick * (0.2969 * math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1036 * t ** 4)
        z = chord_le - t * c
        pts_top.append((x0 + yt * c, y, z))
        pts_bot.append((x0 - yt * c, y, z))
    # ring: +x side leading→trailing, then −x side trailing→leading (CCW seen from +y)
    ring = pts_top[:-1] + [(x0, y, chord_te)] + list(reversed(pts_bot[1:-1]))
    return ring


def _mat_from(origin, x, y):
    return kit.frame(origin, x, y)


def build(A, engine):
    E = A.engine(engine)
    O = Vector((E['x'], E['clampTopY'], E['mountZ']))
    d = E['mountZ'] - E['propZ']           # prop disc aft of the mount plane (0.298 from the JSON)
    yc = E['cavPlateY'] - E['clampTopY']   # cavitation plate
    yp = E['propY'] - E['clampTopY']       # prop axis
    zp = -d
    zs = -0.13                             # steering axis
    pieces = []
    W = Matrix.Translation(O)

    def P(name, geo, slot, look, **kw):
        geo.transform(W)
        if 'local' in kw and kw['local'] is not None:
            o, x, y = kw['local']
            kw['local'] = (tuple(W @ Vector(o)), tuple(x), tuple(y))
        if 'fasteners' in kw:
            kw['fasteners'] = [(tuple(W @ Vector(p)), n, r, k, ru) for (p, n, r, k, ru) in kw['fasteners']]
        pieces.append(Piece(name, geo, slot, look, **kw))

    salvaged = engine == 'S'
    # ── cowl ────────────────────────────────────────────────────────────────
    # §T.200 two-tone (USER: "a band of white on the bottom big bucket section of the engines so they are not totally
    # solid in player color"; concept 04/08): the removable cowl top (upper cowl + cap) wears the livery, the lower cowl
    # "bucket" stays bone with a thin livery pinstripe just under the split line. The lower cowl is one surface lofted
    # in three pieces that share their boundary rings exactly (no gap, no overlap), so the livery mask (M_Carbon
    # baseColor alpha) follows the geometry: bucket bone, 3 cm stripe livery, 6 cm collar bone up to the split
    STRIPE_H0, STRIPE_H1 = 0.25, 0.28
    lower = cowl_shell(0.0, STRIPE_H0, 4, lip0=False, lip1=False)
    # the lower cowl's open bottom is closed by a tray the midsection passes through
    ring0 = cowl_ring(0.0)
    tray = kit.grid_loft([cowl_ring(0.0, inset=0.05, dy=-0.015), ring0], closed=True, cap0=True)
    lower.extend(tray)
    lower_fast = []
    for side in (1, -1):
        for h, ang in ((0.1, 0.25), (0.1, 1.1), (0.31, 0.2), (0.31, 1.2)):
            p, n = cowl_point(h, ang if side > 0 else math.pi - ang)
            lower_fast.append((tuple(p + n * 0.001), tuple(n), 0.006, 'screw', False))
    # the salvage decal (teal chevrons, orange bar) moves from the upper cowl onto the bone bucket, where it still reads
    P('cowl_lower', lower, 'M_Carbon', 'cowl_decal' if engine != 'C' else 'cowl_bone', max_lod=2, smooth=50, recalc=False, wear=1.15,
      fasteners=lower_fast,
      local=(tuple(cowl_point(0.15, 0.05)[0] + Vector((0.0, 0.0, 0.10))), (0, 0, -1), (0, 1, 0)) if engine != 'C' else None)
    P('cowl_stripe', cowl_shell(STRIPE_H0, STRIPE_H1, 1, lip0=False, lip1=False), 'M_Carbon', 'cowl_livery', max_lod=2, smooth=50,
      recalc=False, wear=0.9)
    P('cowl_collar', cowl_shell(STRIPE_H1, 0.34, 1, lip0=False), 'M_Carbon', 'cowl_bone', max_lod=2, smooth=50, recalc=False, wear=1.15)
    upper = cowl_shell(0.36, 0.80, 10, grooves=(0.585,))
    P('cowl_upper', upper, 'M_Carbon', 'cowl_livery', max_lod=2, smooth=50, recalc=False, wear=0.8 if engine == 'P' else 1.0)
    top = cowl_top(0.82)
    P('cowl_top', top, 'M_Carbon', 'cowl_livery', max_lod=2, smooth=50, recalc=False)

    # rear top vent: a recessed louvre box on the cap's rear slope
    pv, nv = cowl_point(0.9, math.pi / 2)
    vent = kit.box(0.22, 0.05, 0.11)
    for k in range(5):
        slat = kit.box(0.205, 0.006, 0.016)
        slat.transform(Matrix.Translation((0, 0.022, -0.045 + k * 0.022)) @ kit.rot('X', 25))
        vent.extend(slat)
    tilt = Matrix.Translation(pv + nv * -0.012) @ kit.frame((0, 0, 0), (1, 0, 0), (Vector((0, 1, 0)) + nv * 0.9).normalized())
    vent.transform(tilt)
    P('vent_rear', vent, 'M_Carbon', 'vent_black', max_lod=1, bevel=(0.003, 1), smooth=35)
    # front "gill" intakes either side of the cap nose (09: dark triangle at the front of the top)
    for side in (1, -1):
        pg, ng = cowl_point(0.87, -math.pi / 2 + side * 0.55)
        gill = kit.extrude([(0.0, 0.0), (0.12, 0.012), (0.12, 0.05), (0.0, 0.022)], 0.02)
        if side < 0:
            gill = gill.mirror_x()
        gill.transform(Matrix.Translation(pg - ng * 0.006) @ kit.frame((0, 0, 0), Vector((side * 0.2, 0.1, 1.0)).normalized(), (0, 1, 0)))
        P(f'gill_{side}', gill, 'M_Carbon', 'vent_black', max_lod=1, bevel=(0.002, 1), smooth=35)
    # cowl latches at the split line, stainless levers
    for side in (1, -1):
        for ang in (0.35, 1.2):
            pl, nl = cowl_point(0.35, ang if side > 0 else math.pi - ang)
            lat = kit.box(0.012, 0.05, 0.03)
            lat.extend(kit.box(0.018, 0.012, 0.036, center=(0.004, 0.02, 0)))
            lat.transform(Matrix.Translation(pl + nl * 0.004) @ kit.frame((0, 0, 0), nl, (0, 1, 0)))
            P('latch', lat, 'M_Metal', 'stainless', max_lod=0, bevel=(0.0015, 1), smooth=35)
    # fuel / primer port cap on the port flank (09: round black cap with a cable loop)
    side = 1 if engine != 'S' else -1
    pc, nc = cowl_point(0.22, (0.35 if side > 0 else math.pi - 0.35))
    cap = kit.cylinder(0.034, 0.018, segs=14)
    cap.extend(kit.cylinder(0.026, 0.028, segs=14).translate((0, -0.003, 0)))  # §V98: not on the collar's base plane
    cap.extend(kit.torus(0.02, 0.004, 10, 4).translate((0, 0.03, 0)))
    cap.transform(Matrix.Translation(pc - nc * 0.004) @ kit.frame((0, 0, 0), Vector((0, 0, 1)).cross(nc), nc))
    P('fuel_cap', cap, 'M_Metal', 'rubber', max_lod=1, bevel=(0.002, 1), smooth=40)
    # rigging grommet at the cowl front and three hoses to the bracket plate
    pr, nr = cowl_point(0.12, -math.pi / 2)
    grom = kit.cylinder(0.05, 0.03, segs=20, r2=0.042)
    grom.transform(Matrix.Translation(pr - nr * 0.01) @ kit.frame((0, 0, 0), (1, 0, 0), nr))
    P('grommet', grom, 'M_Metal', 'rubber', max_lod=1, bevel=(0.004, 2), smooth=40)
    hoses = Geo()
    for k, (hx, hr) in enumerate(((-0.025, 0.012), (0.0, 0.015), (0.028, 0.01))):
        a = pr + Vector((hx, 0.0, 0.02))
        b = Vector((hx * 1.8 + (0.08 if engine == 'P' else -0.08 if engine == 'S' else 0.02), -0.05 - 0.02 * k, -0.005))
        mid = (a + b) / 2 + Vector((0, -0.07 - 0.02 * k, 0.0))
        path = [tuple(a * (1 - t) ** 2 + mid * 2 * t * (1 - t) + b * t * t) for t in [i / 7 for i in range(8)]]
        hoses.extend(kit.sweep(path, hr, 6))
    P('hoses', hoses, 'M_Metal', 'rubber', max_lod=1, smooth=60)

    # ── salvage: riveted aluminium replacement panel on the starboard engine's outboard flank ──
    if salvaged:
        rows, cols = 6, 7
        side_ang = math.pi  # −x flank
        grid_o, grid_i = [], []
        fast = []
        for r in range(rows + 1):
            h = 0.42 + 0.30 * r / rows
            ro, ri = [], []
            for c in range(cols + 1):
                ang = side_ang - 0.55 + 0.95 * c / cols
                p, n = cowl_point(h, ang)
                ro.append(tuple(p + n * 0.004))
                ri.append(tuple(p + n * 0.0005))
                if r in (0, rows) or c in (0, cols):
                    if (r + c) % 1 == 0:
                        fast.append((tuple(p + n * 0.0045 + (Vector((0, 0.012, 0)) if r == 0 else Vector((0, -0.012, 0)) if r == rows else Vector((0, 0, 0)))), tuple(n), 0.0045, 'rivet', True))
            grid_o.append(ro)
            grid_i.append(ri)
        g = Geo()
        io = [[g.vert(p) for p in row] for row in grid_o]
        ii = [[g.vert(p) for p in row] for row in grid_i]
        for r in range(rows):
            for c in range(cols):
                g.face((io[r][c], io[r + 1][c], io[r + 1][c + 1], io[r][c + 1]))
        # edges down to the skin
        ring = [(0, c) for c in range(cols)] + [(r, cols) for r in range(rows)] + [(rows, c) for c in range(cols, 0, -1)] + [(r, 0) for r in range(rows, 0, -1)]
        for k in range(len(ring)):
            (r0, c0), (r1, c1) = ring[k], ring[(k + 1) % len(ring)]
            g.face((io[r0][c0], io[r1][c1], ii[r1][c1], ii[r0][c0]))
        P('salvage_panel', g, 'M_Metal', 'alu_bare', max_lod=1, smooth=40, recalc=False, fasteners=fast, wear=1.3)

    # ── midsection: foil loft from the cavitation plate up into the lower cowl ──
    mid_rings = []
    ys = [yc + 0.01, yc + 0.12, yc + 0.28, yc + 0.45, -0.30, Y0 + 0.02]
    for i, y in enumerate(ys):
        t = i / (len(ys) - 1)
        le = kit.lerp(zp + 0.31, zs + 0.06, t ** 1.2)
        te = kit.lerp(zp - 0.0, zs - 0.44, t ** 1.0)
        mid_rings.append(foil_section(le, te, y, kit.lerp(0.30, 0.44, t), segs=10))
    mid = kit.grid_loft(mid_rings, closed=True, cap0=False, cap1=True)
    P('midsection', mid, 'M_Carbon', 'lower_paint', max_lod=2, smooth=55, recalc=False, wear=1.2)
    # exhaust relief ports: two dark ovals at the midsection trailing flanks
    for side in (1, -1):
        ex = kit.cylinder(0.018, 0.01, segs=12)
        ex.transform(Matrix.Translation((side * 0.042, yc + 0.34, zp + 0.02)) @ Matrix.Diagonal((1.0, 1.0, 2.2, 1.0)) @ kit.rot('Z', side * -90))
        P('exhaust_port', ex, 'M_Carbon', 'vent_black', max_lod=0, smooth=40)

    # ── anti-ventilation plate ──────────────────────────────────────────────
    plate_poly = [(0.07, zp + 0.30), (0.12, zp + 0.18), (0.155, zp + 0.02), (0.15, zp - 0.10), (0.11, zp - 0.13),
                  (-0.11, zp - 0.13), (-0.15, zp - 0.10), (-0.155, zp + 0.02), (-0.12, zp + 0.18), (-0.07, zp + 0.30)]
    plate = kit.extrude([(x, z) for (x, z) in plate_poly], 0.014)
    plate.transform(Matrix.Translation((0, yc, 0)) @ kit.rot('X', 90))
    plate_fast = [((sx * 0.1, yc + 0.0075, zp + 0.1), (0, 1, 0), 0.007, 'screw', False) for sx in (1, -1)]
    P('cav_plate', plate, 'M_Carbon', 'lower_paint', max_lod=2, bevel=(0.004, 2), smooth=35, fasteners=plate_fast)
    # trim-tab anode under the plate aft
    tab = kit.extrude([(0.0, 0.0), (0.09, 0.0), (0.07, -0.05), (0.0, -0.045)], 0.012)
    tab.transform(Matrix.Translation((0.0, yc - 0.007, zp - 0.02)) @ kit.rot('Y', 90))
    P('trim_tab', tab, 'M_Metal', 'zinc', max_lod=1, bevel=(0.002, 1), smooth=35)

    # ── gearcase torpedo + strut + skeg ──────────────────────────────────────
    tr = 0.064
    Lt = min(max(d + 0.03, 0.30), 0.55)
    prof = [(0.001, 0.0), (0.028, 0.012), (0.045, 0.035), (0.058, 0.075), (tr, 0.13), (tr, Lt - 0.03), (0.052, Lt)]
    torp = kit.revolve(prof, segs=20, caps=True)
    torp.transform(Matrix.Translation((0, yp, zp + Lt)) @ kit.rot('X', -90))
    P('torpedo', torp, 'M_Carbon', 'lower_paint', max_lod=2, smooth=60, wear=1.3)
    strut_rings = [foil_section(zp + 0.29, zp + 0.01, y, 0.17, segs=10) for y in (yp + 0.02, yc)]
    strut = kit.grid_loft(strut_rings, closed=True)
    P('strut', strut, 'M_Carbon', 'lower_paint', max_lod=2, smooth=55, recalc=False, wear=1.3)
    skeg_rings = [foil_section(zp + 0.24, zp + 0.05, yp - 0.03, 0.16, segs=8),
                  foil_section(zp + 0.16, zp + 0.02, yp - 0.16, 0.14, segs=8),
                  foil_section(zp + 0.09, zp + 0.0, yp - 0.27, 0.12, segs=8)]
    skeg = kit.grid_loft(skeg_rings, closed=True, cap1=True)
    P('skeg', skeg, 'M_Carbon', 'lower_paint', max_lod=2, smooth=45, recalc=False, wear=1.5)
    # water pickups either side of the strut
    for side in (1, -1):
        scr = kit.box(0.006, 0.05, 0.09)
        for k in range(5):
            scr.extend(kit.box(0.004, 0.004, 0.08, center=(side * 0.003, -0.02 + k * 0.01, 0)))
        scr.transform(Matrix.Translation((side * 0.022, yp + 0.07, zp + 0.17)))
        P('pickup', scr, 'M_Metal', 'alu_cast', max_lod=0, smooth=35)

    # ── clamp bracket, tilt tube, swivel, rams ───────────────────────────────
    clamp = Geo()
    clamp_fast = []
    for side in (1, -1):
        sp = kit.extrude([(0.0, 0.05), (-0.13, 0.05), (-0.16, -0.05), (-0.10, -0.40), (0.0, -0.44)], 0.022)
        sp.transform(Matrix.Translation((side * 0.17, 0, 0)) @ kit.rot('Y', -90))
        clamp.extend(sp)
        for by in (-0.05, -0.18, -0.31):
            clamp_fast.append(((side * 0.17 + side * 0.012, by, -0.03), (side, 0, 0), 0.01, 'screw', True))
    # cross web joining the two clamp plates behind the swivel (the bracket plate itself is Bracket's)
    clamp.extend(kit.box(0.32, 0.05, 0.03, center=(0, -0.36, -0.05)))
    clamp.extend(kit.box(0.32, 0.04, 0.025, center=(0, 0.03, -0.012)))
    P('clamp_bracket', clamp, 'M_Metal', 'powder_black', max_lod=2, bevel=(0.004, 2), smooth=35, fasteners=clamp_fast)
    bolts = Geo()
    for side in (1, -1):
        for by in (-0.05, -0.18, -0.31):
            b = kit.hex_prism(0.014, 0.012)
            b.transform(Matrix.Translation((side * 0.195, by, -0.03)) @ kit.rot('Z', -90 * side))
            bolts.extend(b)
    P('clamp_bolts', bolts, 'M_Metal', 'steel_zinc', max_lod=0, bevel=(0.0015, 1), smooth=35)
    tube = kit.cylinder(0.03, 0.44, segs=16, axis='x').translate((-0.22, 0.02, -0.08))
    for side in (1, -1):
        nut = kit.hex_prism(0.042, 0.03)
        # §V98: the nut straddles the tube end (the end cap used to lie on the port nut's inner face)
        nut.transform(Matrix.Translation((side * 0.22 - 0.015, 0.02, -0.08)) @ kit.rot('Z', -90))
        tube.extend(nut)
    P('tilt_tube', tube, 'M_Metal', 'stainless', max_lod=1, bevel=(0.002, 1), smooth=40)
    swivel = kit.cylinder(0.055, 0.50, segs=18).translate((0, -0.44, zs))
    yoke = kit.box(0.14, 0.06, 0.12, center=(0, 0.02, (zs - 0.08) / 2))
    swivel.extend(yoke)
    swivel.extend(kit.box(0.12, 0.05, 0.10, center=(0, -0.40, zs + 0.02)))
    P('swivel', swivel, 'M_Metal', 'powder_black', max_lod=2, bevel=(0.005, 2), smooth=40)
    # steering arm forward over the clamp top with a ball joint
    arm = kit.box(0.04, 0.03, 0.16, center=(0, 0.075, -0.02))
    arm.extend(kit.dome(0.022, 12, 4).translate((0, 0.09, 0.05)))
    P('steer_arm', arm, 'M_Metal', 'alu_cast', max_lod=1, bevel=(0.004, 2), smooth=40)

    def ram(a, b, r_body, r_rod, split=0.55, name='ram'):
        a, b = Vector(a), Vector(b)
        m = a + (b - a) * split
        body = kit.sweep([tuple(a), tuple(m)], r_body, 14)
        # §V98: the collar starts 4 mm below the barrel's end cap (they shared that plane)
        body.extend(kit.cylinder(r_body * 1.35, 0.03, segs=14).transform(
            Matrix.Translation(a - (b - a).normalized() * 0.004) @ kit.frame((0, 0, 0), (b - a).orthogonal(), (b - a))))
        rod = kit.sweep([tuple(m - (b - a) * 0.02), tuple(b)], r_rod, 10)
        eye = kit.cylinder(r_rod * 1.8, 0.03, segs=12, axis='x').translate((-0.015, 0, 0)).translate(tuple(b))
        P(name + '_body', body, 'M_Metal', 'powder_black', max_lod=1, smooth=45)
        P(name + '_rod', rod, 'M_Metal', 'chrome_rod', max_lod=1, smooth=45)
        P(name + '_eye', eye, 'M_Metal', 'alu_cast', max_lod=0, smooth=40)

    for side in (1, -1):
        ram((side * 0.105, -0.40, -0.035), (side * 0.07, -0.13, zs - 0.03), 0.03, 0.013, name=f'trim_ram_{side}')
    ram((0.0, -0.43, -0.05), (0.0, -0.06, zs - 0.07), 0.042, 0.018, split=0.6, name='tilt_ram')
    # pump/reservoir block between the rams
    pump = kit.box(0.09, 0.14, 0.07, center=(0.0, -0.30, -0.075))  # §V98: 5 mm behind the cross web's face
    pump.extend(kit.cylinder(0.02, 0.03, segs=12).translate((0.0, -0.23, -0.07)))
    P('trim_pump', pump, 'M_Metal', 'alu_cast', max_lod=1, bevel=(0.006, 2), smooth=40)

    extras = {
        'animRole': 'outboard',
        'engine': engine,
        'steerPivot': [E['x'], E['clampTopY'], E['mountZ'] + zs],
        'steerAxis': [0.0, 1.0, 0.0],
        'trimPivot': [E['x'], E['clampTopY'] + 0.02, E['mountZ'] - 0.08],
        'trimAxis': [1.0, 0.0, 0.0],
    }
    return {'pieces': pieces, 'extras': extras}
