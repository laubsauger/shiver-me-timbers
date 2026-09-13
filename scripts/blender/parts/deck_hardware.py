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
    g.extend(kit.sweep(path, 0.013, 6, radii=radii, up_hint=(0, 1, 0)))  # §T.192 budget: 8 → 6 sides
    for sx in (-0.045, 0.045):
        # §V98: the posts start 3 mm below the base plate (their bottoms shared its plane; on the cambered deck nothing buries it)
        g.extend(kit.cylinder(0.02, h + 0.003, segs=8, r2=0.013).translate((sx * L / 0.22, -0.003, 0.0)))
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
    # §T.192 the deck is cambered and falls away aft: everything standing on it asks for the surface at its own (x, z)
    ds = A.deck_surface_y

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
            c.transform(Matrix.Translation((x, ds(x, zb(zh)) - 0.004, zb(zh))) @ kit.rot('Y', 90))  # sunk 4 mm: sits on the camber
            cleats.extend(c)
    bow_z = 11.0
    c = horn_cleat(0.25, 0.055)
    c.transform(Matrix.Translation((0.0, ds(0.0, zb(bow_z)), zb(bow_z))) @ kit.rot('Y', 90))
    cleats.extend(c)
    pieces.append(Piece('cleats', cleats, 'M_Metal', 'stainless', max_lod=1, smooth=45, wear=1.3))
    # §T.192 (USER: the bow is "a bit too blocky"): the square fairlead plate is gone; a tapered stainless STEM HEAD
    # fitting follows the pointed deck plan to the stem, with a raised bow eye at its tip and a fairlead roller slot
    stem_pt = A.sheer_polyline(1, stride=1)[-1]
    z_tip = stem_pt[2] - 0.03
    z_aft = z_tip - 0.42
    fit = Geo()
    ring_pts = []
    n_fit = 8
    for i in range(n_fit + 1):
        zz = z_aft + (z_tip - z_aft) * i / n_fit
        hw_fit = max(0.012, 0.055 * (1 - (i / n_fit) ** 1.6))
        ring_pts.append((zz, hw_fit))
    top_g = Geo()
    top_v = [(top_g.vert((w, ds(w, zz) + 0.008, zz)), top_g.vert((-w, ds(w, zz) + 0.008, zz)),
              top_g.vert((w, ds(w, zz) - 0.004, zz)), top_g.vert((-w, ds(w, zz) - 0.004, zz))) for (zz, w) in ring_pts]
    for i in range(n_fit):
        a, b = top_v[i], top_v[i + 1]
        top_g.face((a[1], a[0], b[0], b[1]))          # top
        top_g.face((a[2], a[3], b[3], b[2]))          # bottom (buried in the deck)
        top_g.face((a[0], a[2], b[2], b[0]))          # +x side
        top_g.face((a[3], a[1], b[1], b[3]))          # −x side
    top_g.face((top_v[0][0], top_v[0][1], top_v[0][3], top_v[0][2]))
    top_g.face((top_v[-1][1], top_v[-1][0], top_v[-1][2], top_v[-1][3]))
    fit.extend(top_g)
    eye_z = z_tip - 0.06
    eye_y = ds(0.0, eye_z) + 0.008
    fit.extend(kit.sweep(kit.fillet_path([(0, eye_y, eye_z - 0.05), (0, eye_y + 0.045, eye_z - 0.04), (0, eye_y + 0.045, eye_z + 0.02), (0, eye_y, eye_z + 0.03)], 0.02, 2), 0.008, 6))
    ffit = [((0.0, ds(0.0, z_aft + 0.08) + 0.008, z_aft + 0.08), (0, 1, 0), 0.006, 'screw', False),
            ((0.0, ds(0.0, z_aft + 0.2) + 0.008, z_aft + 0.2), (0, 1, 0), 0.006, 'screw', False)]
    pieces.append(Piece('stem_head', fit, 'M_Metal', 'stainless_polish', max_lod=1, bevel=(0.002, 1), smooth=40, fasteners=ffit, recalc=True))

    # thin bow rail (a low pulpit): a Ø 22 mm rail each side, 0.18 m over the foredeck edge on three stanchions,
    # meeting over the stem head — it breaks the bow's flat plan the way concept 06b/07 does
    rail_g = Geo()
    rail_pts = {}
    for side in (1, -1):
        pts = []
        for zh in (9.9, 10.6, 11.25):
            x = side * max(0.05, A.sheer_half(zh) - 0.07)
            pts.append((x, ds(x, zb(zh)), zb(zh)))
        rail_pts[side] = pts
        top = [(p[0], p[1] + 0.18, p[2]) for p in pts] + [(side * 0.02, ds(0.0, z_tip - 0.10) + 0.14, z_tip - 0.10)]
        rail_g.extend(kit.sweep(kit.fillet_path(top, 0.10, 3), 0.011, 6))
        for p in pts:
            rail_g.extend(kit.sweep([(p[0], p[1], p[2]), (p[0], p[1] + 0.18, p[2])], 0.009, 8))
            rail_g.extend(kit.cylinder(0.022, 0.006, segs=10).translate((p[0], p[1] - 0.002, p[2])))
    pieces.append(Piece('bow_rail', rail_g, 'M_Metal', 'stainless', max_lod=1, smooth=50, wear=1.2))

    # ── aft fuel-bay hatch hardware, fillers, vents ─────────────────────────
    well_aft_h = W['zAft'] + lcg
    hz0, hz1 = 0.30, min(2.70, well_aft_h - 0.18)
    hx = 0.80
    hinge = Geo()
    for sx in (-0.5, 0.5):
        yh = ds(sx, zb(hz1))
        hg = kit.box(0.16, 0.012, 0.05, center=(sx, yh + 0.006, zb(hz1) + 0.03))
        hg.extend(kit.cylinder(0.011, 0.16, segs=12, axis='x').translate((sx - 0.08, yh + 0.012, zb(hz1))))
        hinge.extend(hg)
    latch = Geo()
    lfast = []
    for sx in (-0.45, 0.45):
        yl = ds(sx, zb(hz0) + 0.05)
        latch.extend(kit.extrude(kit.rounded_rect(0.11, 0.05, 0.012), 0.008).transform(Matrix.Translation((sx, yl + 0.004, zb(hz0) + 0.05)) @ kit.rot('X', -90)))
        latch.extend(kit.cylinder(0.012, 0.008, segs=12).translate((sx + 0.03, yl + 0.006, zb(hz0) + 0.05)))
        lfast += [((sx + s * 0.045, yl + 0.009, zb(hz0) + 0.05), (0, 1, 0), 0.004, 'screw', False) for s in (1, -1)]
    pieces.append(Piece('hatch_hinges', hinge, 'M_Metal', 'stainless', max_lod=1, bevel=(0.002, 1), smooth=35))
    pieces.append(Piece('hatch_latches', latch, 'M_Metal', 'stainless', max_lod=0, bevel=(0.0015, 1), smooth=35, fasteners=lfast))

    fill = Geo()
    tether = Geo()
    stencil = Geo()
    fz_h = hz0 + 0.20
    for k, x in enumerate((-0.55, 0.0, 0.55)):
        yf = ds(x, zb(fz_h)) - 0.004  # sunk 4 mm so the flange sits on the sloping deck all round
        base = kit.cylinder(0.062, 0.012, segs=16).translate((x, yf, zb(fz_h)))
        base.extend(kit.cylinder(0.046, 0.016, segs=16).translate((x, yf + 0.012, zb(fz_h))))
        base.extend(kit.box(0.05, 0.008, 0.012, center=(x, yf + 0.032, zb(fz_h))))  # key bar
        fill.extend(base)
        tether.extend(kit.sweep(kit.fillet_path([(x + 0.05, yf + 0.016, zb(fz_h)), (x + 0.085, yf + 0.010, zb(fz_h) + 0.03), (x + 0.07, yf + 0.008, zb(fz_h) + 0.07)], 0.02, 3), 0.0025, 5))
        t = kit.text_geo('ETOH', 0.045)
        # §V98 (§T.192 scan): a painted stencil is a single-sided card, so it must stand > 2 mm off the deck it lies on
        zt_ = zb(fz_h) + 0.11
        t.transform(Matrix.Translation((x, max(ds(x - 0.09, zt_), ds(x + 0.09, zt_), ds(x, zt_ - 0.03), ds(x, zt_ + 0.03)) + 0.004, zt_)) @ kit.rot('X', -90) @ kit.rot('Z', 180))
        stencil.extend(t)
    pieces.append(Piece('fillers', fill, 'M_Metal', 'stainless', max_lod=1, smooth=40, wear=1.3))
    pieces.append(Piece('filler_tethers', tether, 'M_Metal', 'stainless', max_lod=0, smooth=60))
    pieces.append(Piece('filler_stencils', stencil, 'M_Metal', 'paint_white', max_lod=0, smooth=None, recalc=False, wear=1.5))

    vents = Geo()
    grilles = Geo()
    for zh in (hz0 + (hz1 - hz0) * 0.38, hz0 + (hz1 - hz0) * 0.78):
        for side in (1, -1):
            v = clamshell()
            yv = ds(side * 0.55, zb(zh))
            v.transform(Matrix.Translation((side * 0.55, yv + 0.004, zb(zh))))
            vents.extend(v)
            gr = kit.box(0.2, 0.05, 0.01, center=(side * 0.55, yv + 0.028, zb(zh) - 0.14))
            for k in range(4):
                gr.extend(kit.box(0.19, 0.004, 0.012, center=(side * 0.55, yv + 0.01 + k * 0.013, zb(zh) - 0.145)))
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
        ya, yb_ = ds(x, z0w), ds(x, z1w)
        path = kit.fillet_path([(x, ya, z0w), (x, ya + 0.09, z0w + 0.08), (x, yb_ + 0.09, z1w - 0.08), (x, yb_, z1w)], 0.05, 5)
        rails.extend(kit.sweep(path, 0.013, 8))
        for zz in (z0w, z1w):
            yz = ds(x, zz) - 0.003
            rails.extend(kit.cylinder(0.03, 0.013, segs=12).translate((x, yz, zz)))
            rfast += [((x + math.cos(a) * 0.022, yz + 0.013, zz + math.sin(a) * 0.022), (0, 1, 0), 0.004, 'screw', False) for a in (0, 2.1, 4.2)]
        # padded coaming bolster just inside the well edge. §V98 (§T.192: "z-fighting inside the cockpit"): its back was
        # the well wall's own plane over 2.1 m × 0.11 m; it now stands 3 mm proud of the wall, ON it rather than IN it
        prof = [(px - 0.003, py) for (px, py) in ((0.0, 0.0), (0.0, -0.13), (-0.035, -0.12), (-0.06, -0.08), (-0.065, -0.03), (-0.045, 0.0))]
        rings = []
        for zz in [W['zAft'] + 0.05 + (W['zFwd'] - W['zAft'] - 0.1) * i / 10 for i in range(11)]:
            yp = ds(W['halfWidth'], zz)
            rings.append([(side * (W['halfWidth'] + px * 1.0) if side > 0 else side * (W['halfWidth'] + px), yp - 0.01 + py, zz) for (px, py) in prof])
        pad = kit.grid_loft(rings, closed=True, cap0=True, cap1=True)
        pads.extend(pad if side > 0 else pad.flip())
    pieces.append(Piece('grab_rails', rails, 'M_Metal', 'stainless', max_lod=1, smooth=50, fasteners=rfast))
    pieces.append(Piece('coaming_pads', pads, 'M_Cockpit', 'vinyl_side', max_lod=1, smooth=40, recalc=False, wear=1.3))

    # ── foredeck hatch, bow sidelight, transom tow eyes ─────────────────────
    hz = A.L * (1 - A.extra['foredeckHatchFromBow'])
    hatch = kit.revolve([(0.25, 0.0), (0.262, 0.004), (0.262, 0.012), (0.25, 0.018), (0.22, 0.018), (0.215, 0.012)], segs=28, caps=False)
    yhz = ds(0.0, zb(hz))
    hatch.translate((0, yhz, zb(hz)))
    hfast = [((math.cos(a) * 0.237, yhz + 0.018, zb(hz) + math.sin(a) * 0.237), (0, 1, 0), 0.005, 'screw', False) for a in [i * math.pi / 6 for i in range(12)]]
    pieces.append(Piece('fore_hatch_bezel', hatch, 'M_Metal', 'alu_bare', max_lod=2, smooth=40, fasteners=hfast, recalc=False))
    lid = kit.cylinder(0.214, 0.012, segs=28).translate((0, yhz + 0.002, zb(hz)))
    for a in (0.3, 0.3 + math.pi):
        lid.extend(kit.box(0.12, 0.014, 0.03, center=(math.cos(a) * 0.12, yhz + 0.02, zb(hz) + math.sin(a) * 0.12)))
    pieces.append(Piece('fore_hatch_lid', lid, 'M_Metal', 'anodised_black', max_lod=1, bevel=(0.003, 1), smooth=40))
    stem = A.sheer_polyline(1, stride=1)[-1]
    sl = kit.box(0.09, 0.05, 0.10, center=(0, stem[1] + 0.03, stem[2] - 0.22))
    pieces.append(Piece('bow_light_body', sl, 'M_Metal', 'stainless', max_lod=1, bevel=(0.01, 2), smooth=40))
    for side, look in ((1, 'lens_red'), (-1, 'lens_green')):
        # §V98: lens centred on the body's side face (±6 mm each way), never one face on the other
        ln = kit.box(0.012, 0.035, 0.07, center=(side * 0.045, stem[1] + 0.03, stem[2] - 0.22))
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

    # ── §T.192 transom detail (USER: the transom "could use a bit more"; REFERENCES d2/a1 offshore transoms) ──
    zT = T['z']
    # stainless boarding grab handles either side of the bracket, standing 5 cm off the transom on two pads
    handles = Geo()
    hfast2 = []
    for side in (1, -1):
        hx = side * 0.62
        hy = ds(hx, zT) - 0.13
        path = kit.fillet_path([(hx - 0.11, hy, zT - 0.004), (hx - 0.11, hy, zT - 0.055), (hx + 0.11, hy, zT - 0.055), (hx + 0.11, hy, zT - 0.004)], 0.03, 2)
        handles.extend(kit.sweep(path, 0.011, 6))
        for dx in (-0.11, 0.11):
            handles.extend(kit.cylinder(0.022, 0.008, segs=10).transform(Matrix.Translation((hx + dx, hy, zT + 0.002)) @ kit.rot('X', -90)))
            hfast2.append(((hx + dx + 0.012, hy + 0.012, zT - 0.006), (0, 0, -1), 0.003, 'screw', False))
    pieces.append(Piece('transom_handles', handles, 'M_Metal', 'stainless_polish', max_lod=1, smooth=50, fasteners=hfast2))
    # cockpit drain scuppers low on the transom corners, outboard of the bracket plate: flanged oval outlets
    scup = Geo()
    scup_dark = Geo()
    for side in (1, -1):
        sx_ = side * (T['chineHalf'] - 0.10)
        sy_ = T['chineY'] + 0.14
        M = Matrix.Translation((sx_, sy_, zT + 0.004)) @ Matrix.Diagonal((1.0, 0.62, 1.0, 1.0)) @ kit.rot('X', -90)
        scup.extend(kit.cylinder(0.045, 0.012, segs=16).transform(M))
        # §V98: the dark bore starts 8 mm inside the transom and ends 5 mm proud of the flange face (no shared caps)
        scup_dark.extend(kit.cylinder(0.030, 0.025, segs=14).transform(M @ Matrix.Translation((0, -0.004, 0))))
    pieces.append(Piece('scupper_flanges', scup, 'M_Metal', 'rubber', max_lod=1, bevel=(0.003, 1), smooth=40))
    pieces.append(Piece('scupper_holes', scup_dark, 'M_Carbon', 'vent_black', max_lod=0, smooth=40))
    # hull identification plate (riveted aluminium, stamped HIN), port of the centreline above the bracket
    px_, py_ = 0.36, ds(0.36, zT) - 0.12
    plate = kit.box(0.22, 0.065, 0.003, center=(px_, py_, zT - 0.0015))
    pfast2 = [((px_ + sx * 0.098, py_ + sy * 0.022, zT - 0.003), (0, 0, -1), 0.003, 'rivet', False) for sx in (1, -1) for sy in (1, -1)]
    pieces.append(Piece('hin_plate', plate, 'M_Metal', 'alu_bare', max_lod=1, bevel=(0.0015, 1), smooth=35, fasteners=pfast2, wear=1.3))
    hin = kit.text_geo('SBX12027K526', 0.016)
    hin.transform(Matrix.Translation((px_, py_ - 0.008, zT - 0.006)) @ kit.rot('Y', 180))
    pieces.append(Piece('hin_text', hin, 'M_Metal', 'paint_white', max_lod=0, smooth=None, recalc=False, wear=1.5))
    return {'pieces': pieces, 'extras': {}}
