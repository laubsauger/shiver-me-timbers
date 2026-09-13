"""
Deck hardware and fittings (concept 02 top plan, 07, 09 top-left; STYLE-SPEC §2 deck layout, §5.3).

Every item is placed from the hull JSON: the rub rail follows the JSON sheer polyline (deck half-beam
+ render flare, raked stem via deckZ), cleats and fillers sit a fixed inboard offset from the sheer at
their station, the aft hatch hardware is laid out between the transom and the cockpit well, grab rails
and padded coaming run along the well edges, the foredeck hatch sits at its LOA fraction.

  rub rail    black rubber D-profile (0.07 tall × 0.05 proud) with a stainless insert and end caps
  cleats      2 stern, 2 spring (midships), 1 bow cleat + bow fairlead; cast stainless horn cleats
  fillers     three stencilled ethanol deck fillers (one per engine) with tethered caps
  vents       four low clamshell vents over the fuel bay, louvre grilles inside
  hatch       two hinges and two flush latches for the aft fuel-bay hatch
  well        stainless grab rails on stanchions + padded vinyl coaming along both sides
  foredeck    Ø 0.50 flush hatch bezel with dogs, bow sidelight (red/green lenses), tow eyes on the transom
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo, Piece


def horn_cleat(L=0.22, h=0.05):
    g = Geo()
    n = 9
    path, radii = [], []
    for i in range(n):
        t = i / (n - 1)
        x = (t - 0.5) * L
        y = h + 0.012 * (abs(2 * t - 1) ** 2)   # horns lift at the tips
        path.append((x, y, 0.0))
        radii.append(0.55 + 0.45 * math.sin(math.pi * t) ** 0.6)
    g.extend(kit.sweep(path, 0.013, 8, radii=radii, up_hint=(0, 1, 0)))
    for sx in (-0.045, 0.045):
        g.extend(kit.cylinder(0.02, h, segs=8, r2=0.013).translate((sx * L / 0.22, 0.0, 0.0)))
    g.extend(kit.box(L * 0.62, 0.008, 0.05, center=(0, 0.004, 0)))
    return g


def clamshell(w=0.24, L=0.30, h=0.075):
    rings = []
    for i in range(9):
        t = i / 8
        z = -L / 2 + L * t
        s = math.sin(math.pi * 0.5 * min(1.0, (t + 0.08) * 1.15))
        ring = []
        for k in range(9):
            a = math.pi * k / 8
            ring.append((math.cos(a) * w / 2 * (0.55 + 0.45 * s), math.sin(a) * h * s, z))
        rings.append(ring)
    g = kit.grid_loft(rings, closed=False)
    # thickness lip + skirt flange
    return g


def build(A):
    pieces = []
    T = A.transom()
    W = A.cockpit_well()
    dy = A.deck_y
    lcg = A.lcg

    def zb(zh):
        return zh - lcg

    # ── rub rail ────────────────────────────────────────────────────────────
    rail = Geo()
    insert = Geo()
    caps = Geo()
    for side in (1, -1):
        pts = A.sheer_polyline(side, z_from=0.02, stride=6)
        path = [(p[0] + side * 0.002, p[1] - 0.035, p[2]) for p in pts]
        path[-1] = (path[-1][0], path[-1][1], path[-1][2] - 0.03)
        # profile in (out, up) → sweep (px = up via nrm, py = along t×nrm = −x for a +z path)
        prof_out_up = [(0.0, -0.035), (0.028, -0.035), (0.046, -0.022), (0.05, 0.0), (0.046, 0.022), (0.028, 0.035), (0.0, 0.035)]
        prof = [(up, -side * out) for (out, up) in prof_out_up]
        if side < 0:
            prof = list(reversed(prof))
        rail.extend(kit.sweep(path, 0, profile=prof, up_hint=(0, 1, 0)))
        ins = [(up, -side * out) for (out, up) in [(0.046, -0.008), (0.056, -0.008), (0.056, 0.008), (0.046, 0.008)]]
        if side < 0:
            ins = list(reversed(ins))
        insert.extend(kit.sweep(path, 0, profile=ins, up_hint=(0, 1, 0)))
        for p in (path[0], path[-1]):
            caps.extend(kit.dome(0.03, 12, 3, h=0.02).transform(Matrix.Translation((p[0] + side * 0.03, p[1], p[2])) @ kit.rot('Z', -90 * side)))
    pieces.append(Piece('rub_rail', rail, 'M_Metal', 'rubber', max_lod=2, smooth=50, wear=1.4, tier='low'))
    pieces.append(Piece('rub_insert', insert, 'M_Metal', 'stainless', max_lod=1, smooth=40, wear=1.5, tier='low'))
    pieces.append(Piece('rub_caps', caps, 'M_Metal', 'stainless', max_lod=0, smooth=50))

    # ── cleats + fairlead ───────────────────────────────────────────────────
    cleats = Geo()
    cfast = []
    for (zh, inset, yaw) in ((0.35, 0.16, 0.0), (6.4, 0.14, 0.0)):
        for side in (1, -1):
            x = side * (A.sheer_half(zh) - inset)
            c = horn_cleat()
            c.transform(Matrix.Translation((x, dy, zb(zh))) @ kit.rot('Y', 90))
            cleats.extend(c)
    bow_z = 11.0
    c = horn_cleat(0.25, 0.055)
    c.transform(Matrix.Translation((0.0, dy, zb(bow_z))) @ kit.rot('Y', 90))
    cleats.extend(c)
    pieces.append(Piece('cleats', cleats, 'M_Metal', 'stainless', max_lod=1, smooth=45, wear=1.3))
    fair = Geo()
    fz = zb(11.55)
    for side in (1, -1):
        horn = kit.sweep([(side * 0.02, dy, fz - 0.06), (side * 0.07, dy + 0.035, fz - 0.02), (side * 0.06, dy + 0.05, fz + 0.04), (side * 0.025, dy + 0.045, fz + 0.06)], 0.012, 8)
        fair.extend(horn)
    fair.extend(kit.box(0.16, 0.01, 0.16, center=(0, dy + 0.005, fz)))
    pieces.append(Piece('fairlead', fair, 'M_Metal', 'stainless', max_lod=0, smooth=45))

    # ── aft fuel-bay hatch hardware, fillers, vents ─────────────────────────
    well_aft_h = W['zAft'] + lcg
    hz0, hz1 = 0.30, min(2.70, well_aft_h - 0.18)
    hx = 0.80
    hinge = Geo()
    for sx in (-0.5, 0.5):
        hg = kit.box(0.16, 0.012, 0.05, center=(sx, dy + 0.006, zb(hz1) + 0.03))
        hg.extend(kit.cylinder(0.011, 0.16, segs=12, axis='x').translate((sx - 0.08, dy + 0.012, zb(hz1))))
        hinge.extend(hg)
    latch = Geo()
    lfast = []
    for sx in (-0.45, 0.45):
        latch.extend(kit.extrude(kit.rounded_rect(0.11, 0.05, 0.012), 0.008).transform(Matrix.Translation((sx, dy + 0.004, zb(hz0) + 0.05)) @ kit.rot('X', -90)))
        latch.extend(kit.cylinder(0.012, 0.008, segs=12).translate((sx + 0.03, dy + 0.006, zb(hz0) + 0.05)))
        lfast += [((sx + s * 0.045, dy + 0.009, zb(hz0) + 0.05), (0, 1, 0), 0.004, 'screw', False) for s in (1, -1)]
    pieces.append(Piece('hatch_hinges', hinge, 'M_Metal', 'stainless', max_lod=1, bevel=(0.002, 1), smooth=35))
    pieces.append(Piece('hatch_latches', latch, 'M_Metal', 'stainless', max_lod=0, bevel=(0.0015, 1), smooth=35, fasteners=lfast))

    fill = Geo()
    tether = Geo()
    stencil = Geo()
    fz_h = hz0 + 0.20
    for k, x in enumerate((-0.55, 0.0, 0.55)):
        base = kit.cylinder(0.062, 0.008, segs=16).translate((x, dy, zb(fz_h)))
        base.extend(kit.cylinder(0.046, 0.016, segs=16).translate((x, dy + 0.008, zb(fz_h))))
        base.extend(kit.box(0.05, 0.008, 0.012, center=(x, dy + 0.028, zb(fz_h))))  # key bar
        fill.extend(base)
        tether.extend(kit.sweep(kit.fillet_path([(x + 0.05, dy + 0.012, zb(fz_h)), (x + 0.085, dy + 0.006, zb(fz_h) + 0.03), (x + 0.07, dy + 0.004, zb(fz_h) + 0.07)], 0.02, 3), 0.0025, 5))
        t = kit.text_geo('ETOH', 0.045)
        t.transform(Matrix.Translation((x, dy + 0.0015, zb(fz_h) + 0.11)) @ kit.rot('X', -90) @ kit.rot('Z', 180))
        stencil.extend(t)
    pieces.append(Piece('fillers', fill, 'M_Metal', 'stainless', max_lod=1, smooth=40, wear=1.3))
    pieces.append(Piece('filler_tethers', tether, 'M_Metal', 'stainless', max_lod=0, smooth=60))
    pieces.append(Piece('filler_stencils', stencil, 'M_Metal', 'paint_white', max_lod=0, smooth=None, recalc=False, wear=1.5))

    vents = Geo()
    grilles = Geo()
    for zh in (hz0 + (hz1 - hz0) * 0.38, hz0 + (hz1 - hz0) * 0.78):
        for side in (1, -1):
            v = clamshell()
            v.transform(Matrix.Translation((side * 0.55, dy + 0.004, zb(zh))))
            vents.extend(v)
            gr = kit.box(0.2, 0.05, 0.01, center=(side * 0.55, dy + 0.028, zb(zh) - 0.14))
            for k in range(4):
                gr.extend(kit.box(0.19, 0.004, 0.012, center=(side * 0.55, dy + 0.01 + k * 0.013, zb(zh) - 0.145)))
            grilles.extend(gr)
    pieces.append(Piece('vents', vents, 'M_Metal', 'stainless_polish', max_lod=2, smooth=60, recalc=False, wear=1.2))
    pieces.append(Piece('vent_grilles', grilles, 'M_Carbon', 'vent_black', max_lod=1, smooth=35))

    # ── cockpit well edges: grab rails + padded coaming ─────────────────────
    rails = Geo()
    pads = Geo()
    rfast = []
    z0w, z1w = W['zAft'] + 0.35, W['zFwd'] - 0.55
    for side in (1, -1):
        x = side * (W['halfWidth'] + 0.10)
        path = kit.fillet_path([(x, dy, z0w), (x, dy + 0.09, z0w + 0.08), (x, dy + 0.09, z1w - 0.08), (x, dy, z1w)], 0.05, 5)
        rails.extend(kit.sweep(path, 0.013, 8))
        for zz in (z0w, z1w):
            rails.extend(kit.cylinder(0.03, 0.01, segs=12).translate((x, dy, zz)))
            rfast += [((x + math.cos(a) * 0.022, dy + 0.01, zz + math.sin(a) * 0.022), (0, 1, 0), 0.004, 'screw', False) for a in (0, 2.1, 4.2)]
        # padded coaming bolster just inside the well edge
        prof = [(0.0, 0.0), (0.0, -0.13), (-0.035, -0.12), (-0.06, -0.08), (-0.065, -0.03), (-0.045, 0.0)]
        rings = []
        for zz in [W['zAft'] + 0.05 + (W['zFwd'] - W['zAft'] - 0.1) * i / 10 for i in range(11)]:
            rings.append([(side * (W['halfWidth'] + px * 1.0) if side > 0 else side * (W['halfWidth'] + px), dy - 0.01 + py, zz) for (px, py) in prof])
        pad = kit.grid_loft(rings, closed=True, cap0=True, cap1=True)
        pads.extend(pad if side > 0 else pad.flip())
    pieces.append(Piece('grab_rails', rails, 'M_Metal', 'stainless', max_lod=1, smooth=50, fasteners=rfast))
    pieces.append(Piece('coaming_pads', pads, 'M_Cockpit', 'vinyl_side', max_lod=1, smooth=40, recalc=False, wear=1.3))

    # ── foredeck hatch, bow sidelight, transom tow eyes ─────────────────────
    hz = A.L * (1 - A.extra['foredeckHatchFromBow'])
    hatch = kit.revolve([(0.25, 0.0), (0.262, 0.004), (0.262, 0.012), (0.25, 0.018), (0.22, 0.018), (0.215, 0.012)], segs=28, caps=False)
    hatch.translate((0, dy, zb(hz)))
    hfast = [((math.cos(a) * 0.237, dy + 0.018, zb(hz) + math.sin(a) * 0.237), (0, 1, 0), 0.005, 'screw', False) for a in [i * math.pi / 6 for i in range(12)]]
    pieces.append(Piece('fore_hatch_bezel', hatch, 'M_Metal', 'alu_bare', max_lod=2, smooth=40, fasteners=hfast, recalc=False))
    lid = kit.cylinder(0.214, 0.012, segs=28).translate((0, dy + 0.002, zb(hz)))
    for a in (0.3, 0.3 + math.pi):
        lid.extend(kit.box(0.12, 0.014, 0.03, center=(math.cos(a) * 0.12, dy + 0.02, zb(hz) + math.sin(a) * 0.12)))
    pieces.append(Piece('fore_hatch_lid', lid, 'M_Metal', 'anodised_black', max_lod=1, bevel=(0.003, 1), smooth=40))
    stem = A.sheer_polyline(1, stride=1)[-1]
    sl = kit.box(0.09, 0.05, 0.10, center=(0, stem[1] + 0.03, stem[2] - 0.22))
    pieces.append(Piece('bow_light_body', sl, 'M_Metal', 'stainless', max_lod=1, bevel=(0.01, 2), smooth=40))
    for side, look in ((1, 'lens_red'), (-1, 'lens_green')):
        ln = kit.box(0.012, 0.035, 0.07, center=(side * 0.05, stem[1] + 0.03, stem[2] - 0.22))
        pieces.append(Piece(f'bow_lens_{side}', ln, 'M_Perspex', look, max_lod=0, bevel=(0.003, 1), smooth=40))
    eyes = Geo()
    for side in (1, -1):
        c = Vector((side * (T['halfBeamTop'] - 0.22), T['topY'] - 0.16, T['z'] - 0.01))
        u = kit.sweep([(0, -0.035, 0), (0, -0.035, -0.05), (0, 0.035, -0.05), (0, 0.035, 0)], 0.009, 8)
        u = kit.sweep(kit.fillet_path([(0, -0.035, 0), (0, -0.035, -0.05), (0, 0.035, -0.05), (0, 0.035, 0)], 0.03, 5), 0.009, 8)
        u.translate(tuple(c))
        eyes.extend(u)
        for yy in (-0.035, 0.035):
            eyes.extend(kit.hex_prism(0.015, 0.012).transform(Matrix.Translation(tuple(c + Vector((0, yy, -0.004)))) @ kit.rot('X', -90)))
    pieces.append(Piece('tow_eyes', eyes, 'M_Metal', 'stainless', max_lod=1, smooth=45))
    return {'pieces': pieces, 'extras': {}}
