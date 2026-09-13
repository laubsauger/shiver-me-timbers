"""
Welded stainless roll arch with the radio whip (STYLE-SPEC §2/§4; concept 01c, 04, 09 top-right).

Socket `arch`: JSON renderOnly.cockpit.rollArch (station z, height above deck) + the sheer half-beam
at that station, so the feet always land on the deck inboard of the sheer. Two raked hoops (fore and
aft) of Ø 60 mm tube with bent corners, fore-aft top rails, a mid cross-brace, flanged feet with
bolts, weld beads and heat tint at every joint (welds → compositor heat tint), a welded sleeve repair on
one leg, the solar panel on a frame, the GPS/nav dome with its red band, an all-round white light, the
2.4 m whip on a ratchet mount with its coax clipped down the leg, and a convex hoop mirror.
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo, Piece

R = 0.03  # Ø 60 mm


def build(A):
    a = A.arch()
    z0 = a['z']
    yd = a['deckY']
    yt = a['topY']
    xf = min(a['sheerHalf'] - 0.2, 1.02)   # feet inboard of the sheer
    xt = 0.62                               # top corners
    rake = 0.16                             # tops lean aft
    pieces = []
    welds = []
    tube = Geo()
    hoops = []
    for dz in (-0.22, 0.22):
        base_z = z0 + dz
        top_z = z0 + dz * 0.45 - rake
        path = [(xf, yd, base_z), (xt + 0.06, yt - 0.10, top_z + 0.02), (xt, yt, top_z), (-xt, yt, top_z),
                (-xt - 0.06, yt - 0.10, top_z + 0.02), (-xf, yd, base_z)]
        path = kit.fillet_path(path, 0.14, 5)
        tube.extend(kit.sweep(path, R, 12, caps=True))
        hoops.append((base_z, top_z))
    # fore-aft top rails at the corners and a centre rail carrying the panel
    (bz0, tz0), (bz1, tz1) = hoops
    for x in (xt - 0.02, -xt + 0.02, 0.0):
        tube.extend(kit.sweep([(x, yt, tz0 - 0.02), (x, yt, tz1 + 0.02)], R * (0.8 if x == 0 else 1.0), 14))
        welds += [(x, yt, tz0), (x, yt, tz1)]
    # mid braces between fore and aft legs on each side
    for sx in (1, -1):
        ym = yd + 0.42
        f = (ym - yd) / (yt - yd)
        xa = xf + (xt - xf) * f
        za0 = bz0 + (tz0 - bz0) * f
        za1 = bz1 + (tz1 - bz1) * f
        tube.extend(kit.sweep([(sx * xa, ym, za0), (sx * xa, ym, za1)], R * 0.75, 12))
        welds += [(sx * xa, ym, za0), (sx * xa, ym, za1)]
    pieces.append(Piece('tubes', tube, 'M_Metal', 'stainless', max_lod=2, smooth=60, welds=welds, recalc=False))

    # flanged feet with four bolts each
    feet = Geo()
    ffast = []
    for sx in (1, -1):
        for bz in (bz0, bz1):
            fl = kit.cylinder(0.075, 0.012, segs=16).translate((sx * xf, yd, bz))
            fl.extend(kit.cylinder(0.042, 0.05, segs=12, r2=R + 0.004).translate((sx * xf, yd + 0.012, bz)))
            feet.extend(fl)
            welds.append((sx * xf, yd + 0.06, bz))
            for k in range(4):
                ang = math.pi / 4 + k * math.pi / 2
                p = (sx * xf + math.cos(ang) * 0.055, yd + 0.012, bz + math.sin(ang) * 0.055)
                ffast.append((p, (0, 1, 0), 0.009, 'screw', False))
    pieces.append(Piece('feet', feet, 'M_Metal', 'stainless', max_lod=1, smooth=40, fasteners=ffast, welds=welds))
    bolts = Geo()
    for (p, n, r, k, ru) in ffast:
        bolts.extend(kit.hex_prism(0.011, 0.008).translate(p))
    pieces.append(Piece('foot_bolts', bolts, 'M_Metal', 'stainless', max_lod=0, smooth=35))

    # weld beads: rings where tubes meet
    beads = Geo()
    for w in welds[:6]:  # the top-rail joints the arch close-up sees; the rest are normal-map ripple
        beads.extend(kit.torus(R * 1.05, 0.006, 10, 4).translate(w))
    pieces.append(Piece('weld_beads', beads, 'M_Metal', 'stainless', max_lod=0, smooth=60, welds=welds))

    # salvage: welded sleeve over a cracked port aft leg (09: "welded patches")
    f = 0.35
    ps = Vector((xf + (xt - xf) * f, yd + (yt - yd) * f, bz0 + (tz0 - bz0) * f))
    pe = Vector((xf + (xt - xf) * (f + 0.12), yd + (yt - yd) * (f + 0.12), bz0 + (tz0 - bz0) * (f + 0.12)))
    sleeve = kit.sweep([tuple(ps), tuple(pe)], R + 0.005, 16)
    pieces.append(Piece('sleeve_repair', sleeve, 'M_Metal', 'stainless', max_lod=1, smooth=40, welds=[tuple(ps), tuple(pe)], wear=1.4))
    sbeads = Geo()
    for c in (ps, pe):
        d = (pe - ps).normalized()
        sbeads.extend(kit.torus(R + 0.006, 0.005, 16, 5).transform(Matrix.Translation(c) @ kit.frame((0, 0, 0), d.orthogonal(), d)))
    pieces.append(Piece('sleeve_beads', sbeads, 'M_Metal', 'stainless', max_lod=0, smooth=60, welds=[tuple(ps), tuple(pe)]))

    # solar panel on a frame over the centre rail, tilted slightly aft
    pc = Vector((0.24, yt + R + 0.035, (tz0 + tz1) / 2))
    frame_g = Geo()
    frame_g.extend(kit.box(0.47, 0.022, 0.37, center=tuple(pc)))
    for sx in (-0.18, 0.18):
        frame_g.extend(kit.box(0.02, 0.05, 0.3, center=(pc.x + sx, yt + 0.012, pc.z)))
    pieces.append(Piece('solar_frame', frame_g, 'M_Metal', 'alu_bare', max_lod=2, bevel=(0.003, 1), smooth=35))
    cells = kit.box(0.44, 0.004, 0.34, center=(pc.x, pc.y + 0.012, pc.z))
    pieces.append(Piece('solar_cells', cells, 'M_Cockpit', 'solar_cell', max_lod=2, smooth=35,
                        local=((pc.x, pc.y + 0.014, pc.z), (1, 0, 0), (0, 0, 1))))

    # GPS / nav dome on a short pole at the port top corner
    gp = Vector((xt - 0.02, yt, tz1 + 0.02))
    pole = kit.cylinder(0.018, 0.14, segs=12).translate(tuple(gp))
    pole.extend(kit.cylinder(0.035, 0.03, segs=16).translate(tuple(gp + Vector((0, 0.12, 0)))))
    pieces.append(Piece('gps_pole', pole, 'M_Metal', 'stainless', max_lod=1, bevel=(0.002, 1), smooth=40, welds=[tuple(gp)]))
    dome = Geo()
    base = kit.cylinder(0.075, 0.05, segs=18).translate(tuple(gp + Vector((0, 0.15, 0))))
    dome.extend(base)
    dome.extend(kit.dome(0.075, 18, 5, h=0.07).translate(tuple(gp + Vector((0, 0.2, 0)))))
    pieces.append(Piece('gps_dome', dome, 'M_Cockpit', 'gps_white', max_lod=2, smooth=50,
                    local=(tuple(gp + Vector((0, 0.175, 0))), (1, 0, 0), (0, 1, 0))))

    # all-round white light on the starboard top corner, before the whip
    lp = Vector((-xt + 0.02, yt, tz1 + 0.02))
    lb = kit.cylinder(0.022, 0.16, segs=14).translate(tuple(lp))
    lb.extend(kit.cylinder(0.03, 0.02, segs=16).translate(tuple(lp + Vector((0, 0.16, 0)))))
    lb.extend(kit.cylinder(0.03, 0.012, segs=16).translate(tuple(lp + Vector((0, 0.24, 0)))))
    pieces.append(Piece('light_base', lb, 'M_Metal', 'stainless', max_lod=1, bevel=(0.002, 1), smooth=40, welds=[tuple(lp)]))
    lens = kit.cylinder(0.026, 0.06, segs=16).translate(tuple(lp + Vector((0, 0.18, 0))))
    pieces.append(Piece('light_lens', lens, 'M_Perspex', 'lens_white', max_lod=1, smooth=50))

    # whip antenna on a ratchet mount at the starboard aft corner, coax down the leg with ties
    wp = Vector((-xt - 0.02, yt, tz0 - 0.02))
    mount = kit.box(0.07, 0.05, 0.06, center=tuple(wp + Vector((-0.045, 0.0, 0))))
    mount.extend(kit.cylinder(0.03, 0.045, segs=16, axis='x').translate(tuple(wp + Vector((-0.1, 0.02, 0)))))
    mount.extend(kit.cylinder(0.02, 0.07, segs=14).translate(tuple(wp + Vector((-0.08, 0.04, 0)))))
    pieces.append(Piece('whip_mount', mount, 'M_Metal', 'stainless', max_lod=1, bevel=(0.004, 1), smooth=40))
    spring = kit.helix(0.017, 0.004, 6, 0.12, 6, 4).translate(tuple(wp + Vector((-0.08, 0.11, 0))))
    pieces.append(Piece('whip_spring', spring, 'M_Metal', 'stainless_polish', max_lod=0, smooth=70, recalc=False))
    L = a['antennaLength']
    whip = kit.cylinder(0.011, L, segs=10, r2=0.003)
    whip.transform(Matrix.Translation(tuple(wp + Vector((-0.08, 0.23, 0)))) @ kit.rot('X', -4))
    whip.extend(kit.cylinder(0.016, 0.3, segs=12, r2=0.011).translate(tuple(wp + Vector((-0.08, 0.2, 0)))))
    pieces.append(Piece('whip', whip, 'M_Metal', 'rubber', max_lod=2, smooth=50))
    # coax: from the mount, along the leg (offset), into the deck
    coax_pts = []
    for k in range(13):
        t = k / 12
        p = Vector((-(xt + (xf - xt) * t) - 0.045, yt - 0.02 + (yd - yt) * t, tz0 + (bz0 - tz0) * t))
        coax_pts.append(tuple(p))
    coax_pts[0] = tuple(wp + Vector((-0.1, 0.0, 0.0)))
    coax = kit.sweep(kit.fillet_path(coax_pts, 0.05, 3), 0.007, 8)
    ties = Geo()
    for k in (3, 6, 9):
        c = Vector(coax_pts[k]) + Vector((0.03, 0, 0))
        ties.extend(kit.torus(R + 0.018, 0.004, 14, 4).translate(tuple(c)))
    pieces.append(Piece('coax', coax, 'M_Metal', 'rubber', max_lod=1, smooth=60, recalc=False))
    pieces.append(Piece('cable_ties', ties, 'M_Metal', 'rubber', max_lod=0, smooth=60))

    # convex hoop mirror facing aft from the forward hoop's crossbar (design doc)
    mp = Vector((-0.05, yt - 0.02, tz1 + 0.05))
    stalk = kit.sweep([tuple(mp), tuple(mp + Vector((0, -0.08, 0.06)))], 0.008, 8)
    stalk.extend(kit.torus(0.075, 0.009, 24, 6).transform(Matrix.Translation(tuple(mp + Vector((0, -0.12, 0.08)))) @ kit.rot('X', 70)))
    pieces.append(Piece('mirror_hoop', stalk, 'M_Metal', 'stainless', max_lod=1, smooth=60, welds=[tuple(mp)]))
    glass = kit.dome(0.07, 20, 4, h=0.012)
    glass.transform(Matrix.Translation(tuple(mp + Vector((0, -0.12, 0.08)))) @ kit.rot('X', 70 + 180))
    pieces.append(Piece('mirror_face', glass, 'M_Metal', 'chrome_rod', max_lod=1, smooth=60))
    return {'pieces': pieces, 'extras': {'antennaTip': [float(wp.x - 0.08), float(wp.y + 0.23 + L), float(wp.z - L * math.sin(math.radians(4)))]}}
