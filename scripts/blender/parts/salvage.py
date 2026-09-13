"""
Cockpit salvage dressing (concept 09 bottom-middle; STYLE-SPEC §5.3 "ethanol jerrycans and a spares case
lashed behind the seat with a ratchet strap and rope"). Socket: the well sole behind the JSON seat.

Two 20 L steel-pattern jerrycans (X-pressings, three-bar handles, spout clamp, seam flange) in faded red
HDPE, a black spares case with lid seam, latches, handle and corner guards, a smaller case on top,
orange ratchet straps over the stack to pad eyes on the sole with a ratchet buckle, and blue rope
lashings with a knot. Stays below the arch crossbar (STYLE-SPEC §2 rule 3).
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo, Piece


def jerrycan(M):
    w, h, d = 0.165, 0.47, 0.34
    g = kit.box(w, h, d, center=(0, h / 2, 0))
    g.extend(kit.box(w + 0.01, 0.012, d + 0.01, center=(0, h * 0.5, 0)))  # seam flange
    x = Geo()
    for side in (1, -1):
        for sgn in (1, -1):
            bar = kit.box(0.012, 0.36, 0.02)
            bar.transform(Matrix.Translation((side * (w / 2 + 0.004), h * 0.5, 0)) @ kit.rot('X', sgn * 34))
            x.extend(bar)
    handles = Geo()
    for k in range(3):
        zz = -0.1 + 0.1 * k
        handles.extend(kit.sweep(kit.fillet_path([(0, h, zz - 0.03), (0, h + 0.045, zz - 0.03), (0, h + 0.045, zz + 0.03), (0, h, zz + 0.03)], 0.012, 2), 0.009, 6))
    # §T.192 budget: 16 → 12 sides
    spout = kit.cylinder(0.024, 0.05, segs=12).transform(Matrix.Translation((0, h - 0.01, 0.13)) @ kit.rot('X', 25))
    spout.extend(kit.cylinder(0.03, 0.03, segs=12).transform(Matrix.Translation((0, h + 0.03, 0.15)) @ kit.rot('X', 25)))
    clamp = kit.box(0.03, 0.02, 0.07, center=(0, h + 0.03, 0.10))
    return g.transform(M), x.transform(M), handles.transform(M), spout.transform(M), clamp.transform(M)


def case(M, w, h, d):
    g = kit.box(w, h * 0.62, d, center=(0, h * 0.31, 0))
    lid = kit.box(w, h * 0.36, d, center=(0, h * 0.82, 0))
    hard = Geo()
    for sx in (-w * 0.3, w * 0.3):
        hard.extend(kit.box(0.05, 0.05, 0.02, center=(sx, h * 0.62, d / 2 + 0.01)))
    hard.extend(kit.sweep(kit.fillet_path([(-0.07, h, 0.0), (-0.07, h + 0.03, 0.0), (0.07, h + 0.03, 0.0), (0.07, h, 0.0)], 0.02, 3), 0.012, 6))
    guards = Geo()
    for sx in (-1, 1):
        for sz in (-1, 1):
            for sy in (0.02, h - 0.02):
                guards.extend(kit.box(0.045, 0.045, 0.045, center=(sx * (w / 2 - 0.015), sy, sz * (d / 2 - 0.015))))
    return g.transform(M), lid.transform(M), hard.transform(M), guards.transform(M)


def build(A):
    S = A.seat()
    W = A.cockpit_well()
    ys = W['soleY']
    zc = S['z'] - 0.62
    pieces = []
    cans, xs, hand, spouts, clamps = Geo(), Geo(), Geo(), Geo(), Geo()
    for k, x in enumerate((0.36, 0.545)):
        M = Matrix.Translation((x, ys, zc)) @ kit.rot('Y', 3 - 4 * k)
        a, b, c, d, e = jerrycan(M)
        cans.extend(a)
        xs.extend(b)
        hand.extend(c)
        spouts.extend(d)
        clamps.extend(e)
    pieces.append(Piece('jerrycans', cans, 'M_Cockpit', 'hdpe_red', max_lod=2, bevel=(0.02, 2), smooth=35, wear=1.3))
    pieces.append(Piece('jerry_x', xs, 'M_Cockpit', 'hdpe_red', max_lod=0, bevel=(0.004, 1), smooth=35, wear=1.3))
    pieces.append(Piece('jerry_handles', hand, 'M_Cockpit', 'hdpe_red', max_lod=1, smooth=50, wear=1.5))
    pieces.append(Piece('jerry_spouts', spouts, 'M_Cockpit', 'case_black', max_lod=0, bevel=(0.002, 1), smooth=40))
    pieces.append(Piece('jerry_clamps', clamps, 'M_Metal', 'steel_zinc', max_lod=0, bevel=(0.003, 1), smooth=35))
    # spares case + a smaller case on top
    cw, ch, cd = 0.56, 0.24, 0.38
    Mc = Matrix.Translation((-0.36, ys, zc + 0.01)) @ kit.rot('Y', 6)
    body, lid, hard, guards = case(Mc, cw, ch, cd)
    Ms = Matrix.Translation((-0.40, ys + ch, zc - 0.02)) @ kit.rot('Y', -9)
    b2, l2, h2, g2 = case(Ms, 0.36, 0.16, 0.26)
    body.extend(b2)
    lid.extend(l2)
    hard.extend(h2)  # the small case has no corner guards (a cheaper case, and 350 tris)
    pieces.append(Piece('case_body', body, 'M_Cockpit', 'case_black', max_lod=2, bevel=(0.012, 2), smooth=35, wear=1.3))
    pieces.append(Piece('case_lid', lid, 'M_Cockpit', 'case_black', max_lod=1, bevel=(0.012, 2), smooth=35, wear=1.3))
    pieces.append(Piece('case_hardware', hard, 'M_Metal', 'steel_zinc', max_lod=0, bevel=(0.004, 1), smooth=40))
    pieces.append(Piece('case_guards', guards, 'M_Metal', 'alu_bare', max_lod=0, bevel=(0.006, 1), smooth=35))

    # pad eyes on the sole
    eyes = Geo()
    pads = [(0.22, zc), (0.69, zc), (-0.69, zc + 0.01), (-0.03, zc + 0.01)]
    for (x, z) in pads:
        eyes.extend(kit.box(0.07, 0.006, 0.04, center=(x, ys + 0.003, z)))
        eyes.extend(kit.sweep(kit.fillet_path([(x - 0.02, ys, z), (x - 0.02, ys + 0.03, z), (x + 0.02, ys + 0.03, z), (x + 0.02, ys, z)], 0.015, 2), 0.006, 6))
    pieces.append(Piece('pad_eyes', eyes, 'M_Metal', 'stainless', max_lod=0, smooth=45))

    # ratchet straps over the jerrycans (fore-aft) and over the cases (athwartships)
    straps = Geo()
    top_j = ys + 0.47 + 0.05
    p1 = [(0.22, ys + 0.005, zc), (0.265, top_j - 0.12, zc), (0.28, top_j - 0.01, zc), (0.63, top_j - 0.01, zc),
          (0.645, top_j - 0.12, zc), (0.69, ys + 0.005, zc)]
    straps.extend(kit.ribbon(p1, 0.038, 0.003, [(-1, 0.2, 0), (-1, 0.1, 0), (0, 1, 0), (0, 1, 0), (1, 0.1, 0), (1, 0.2, 0)]))
    # §V98 (§T.192 scan): the strap's centre line lay ON the small case's lid (webbing faces within 1.5 mm of it over
    # 26 cm); it now lies on top of the lid: centre 4 mm up, the 3 mm webbing's underside 2.5 mm clear
    top_c = ys + ch + 0.16 + 0.009
    p2 = [(-0.69, ys + 0.005, zc + 0.01), (-0.655, ys + ch * 0.8, zc + 0.01), (-0.58, top_c - 0.005, zc + 0.01), (-0.22, top_c - 0.005, zc + 0.01),
          (-0.10, ys + ch * 0.95, zc + 0.01), (-0.03, ys + 0.005, zc + 0.01)]
    straps.extend(kit.ribbon(p2, 0.038, 0.003, [(-1, 0.3, 0), (-1, 0.3, 0), (0, 1, 0), (0, 1, 0), (1, 0.6, 0), (1, 0.3, 0)]))
    pieces.append(Piece('ratchet_straps', straps, 'M_Cockpit', 'webbing_orange', max_lod=1, smooth=40, wear=1.4))
    ratchet = kit.box(0.05, 0.03, 0.11)
    ratchet.extend(kit.cylinder(0.012, 0.06, segs=10, axis='x').translate((-0.03, 0.02, 0.03)))
    ratchet.transform(Matrix.Translation((0.66, top_j - 0.09, zc)) @ kit.rot('Z', 80))
    pieces.append(Piece('ratchet', ratchet, 'M_Metal', 'steel_zinc', max_lod=0, bevel=(0.003, 1), smooth=35))

    # blue rope lashing across the stack with a knot
    # rope: from a pad eye, over the small case lid, down the big case end, across the sole to the
    # cans, up and over their handles, down to the far pad eye (every point rests on a surface)
    top_small = ys + ch + 0.16 + 0.008
    rope_path = [(-0.72, ys + 0.03, zc - 0.26), (-0.62, ys + ch * 0.9, zc - 0.20), (-0.52, top_small, zc - 0.10), (-0.26, top_small, zc - 0.02),
                 (-0.10, ys + ch + 0.01, zc + 0.03), (-0.07, ys + 0.12, zc + 0.08), (0.02, ys + 0.012, zc + 0.12), (0.26, ys + 0.012, zc + 0.12),
                 (0.28, ys + 0.30, zc + 0.10), (0.33, ys + 0.485, zc + 0.02), (0.58, ys + 0.485, zc - 0.02), (0.64, ys + 0.30, zc + 0.08), (0.72, ys + 0.03, zc + 0.26)]
    rope = kit.sweep(kit.fillet_path(rope_path, 0.05, 2), 0.0075, 5)
    knot = Geo()
    kc = Vector((-0.10, ys + ch + 0.02, zc + 0.03))
    for k in range(3):
        knot.extend(kit.torus(0.016, 0.0075, 12, 6).transform(Matrix.Translation(kc + Vector((0.006 * k, 0.004 * k, 0))) @ kit.rot('Z', 60 * k) @ kit.rot('X', 35)))
    rope.extend(knot)
    pieces.append(Piece('rope', rope, 'M_Cockpit', 'rope_blue', max_lod=1, smooth=60, recalc=False, wear=1.3))
    return {'pieces': pieces, 'extras': {}}
