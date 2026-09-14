"""
Dashboard (concept 05 cockpit POV; REFERENCES c1 Donzi helm, c6, c8 gauges; STYLE-SPEC §2: carbon, three round
gauges, strapped plotter tablet, VHF handset; the Governor and throttle quadrant are their own parts).

Socket `dash` via cockpit_frame.Face (JSON seat → helm chain). Built for the cockpit camera at
0.5–1 m: a bevelled carbon console across the well with a gauge brow, a bolted carbon face panel,
three gauges (bezel, face with ticks/red zone, needle, glass), a rugged tablet strapped on with two
webbing straps, a VHF handset on its clip with a coiled cord, a guarded toggle-switch panel, a kill
switch with its red coiled lanyard, and a strip of gaffer tape over an old crack.
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo, Piece
from cockpit_frame import Face


def build(A, pieces='body'):
    """pieces='body': everything but the gauge glass; 'glass': the gauge glass only. The glass is its own GLB node
    (`GaugeGlass`) because it is the one see-through surface BELOW the sheer inside the well: the runtime draws it
    before the hull's water mask, which would otherwise hide it (src/speedboat/assets/waterMask.ts, §T.192)"""
    out = _build(A)
    keep = (lambda p: p.name == 'gauge_glass') if pieces == 'glass' else (lambda p: p.name != 'gauge_glass')
    return {'pieces': [p for p in out['pieces'] if keep(p)], 'extras': out['extras'] if pieces != 'glass' else {},
            'sockets': out['sockets'] if pieces != 'glass' else {}}


def _build(A):
    F = Face(A)
    D, W = F.D, F.W
    hw = W['halfWidth'] - 0.004
    pieces = []

    # ── console shell: side profile extruded across the well ────────────────
    zt, yt = F.top.z, F.top.y
    zb_, yb_ = F.bottom.z, F.bottom.y
    prof = [(zt, yt), (D['zFwd'] + 0.02, D['topY']), (D['zFwd'] + 0.02, W['soleY'] + 0.01), (zb_ - 0.06, W['soleY'] + 0.01),
            (zb_ - 0.06, yb_ - 0.06), (zb_, yb_)]
    poly = [(z, y) for (z, y) in prof]
    shell = kit.extrude(poly, 2 * hw)          # XY = (z, y), extruded along Z = across
    shell.transform(Matrix(((0, 0, 1, 0), (0, 1, 0, 0), (1, 0, 0, 0), (0, 0, 0, 1))))  # swap x↔z: det −1 …
    shell.flip()                                                                       # … so re-wind
    pieces.append(Piece('shell', shell, 'M_Carbon', 'carbon', max_lod=2, bevel=(0.008, 3), smooth=35))
    # gauge brow: a rounded hood over the gauge cluster
    brow_prof = [(0.0, 0.0), (0.0, 0.035), (-0.03, 0.05), (-0.075, 0.045), (-0.09, 0.03), (-0.085, 0.018), (-0.02, 0.012)]
    rings = []
    for k in range(9):
        u = -0.30 + 0.60 * k / 8
        lift = 0.012 * math.cos(math.pi * (k / 8 - 0.5))
        ring = []
        for (a, b) in brow_prof:
            p = F.top + Vector((u, 0, 0)) + Vector((0, 0, 1)) * (-a - 0.0) + Vector((0, 1, 0)) * (b + lift)
            ring.append(tuple(p))
        rings.append(ring)
    brow = kit.grid_loft(rings, closed=True, cap0=True, cap1=True)
    pieces.append(Piece('brow', brow, 'M_Carbon', 'carbon', max_lod=1, bevel=(0.004, 2), smooth=40, tier='cockpit'))

    # ── bolted carbon face panel ────────────────────────────────────────────
    pw, ph = 1.30, F.height - 0.05
    panel = kit.box(pw, ph, 0.006)
    panel.transform(F.matrix(0.0, F.height / 2, 0.003))
    pf = []
    screws = Geo()
    for (su, sv) in ((0.62, 0.03), (-0.62, 0.03), (0.62, ph - 0.03), (-0.62, ph - 0.03), (0.0, ph - 0.03), (0.0, 0.03)):
        M = F.matrix(su, sv + 0.025, 0.006)
        pf.append((tuple(M.translation), tuple(F.n), 0.005, 'screw', False))
        screws.extend(kit.dome(0.0055, 8, 2, h=0.003).transform(M @ kit.rot('X', 90)))
    pieces.append(Piece('face_panel', panel, 'M_Carbon', 'carbon', max_lod=1, bevel=(0.002, 1), smooth=35, tier='cockpit', fasteners=pf))
    pieces.append(Piece('face_screws', screws, 'M_Metal', 'stainless', max_lod=0, smooth=50, tier='cockpit'))

    # ── gauges ──────────────────────────────────────────────────────────────
    needles = Geo()
    bezels = Geo()
    glass = Geo()
    for k, (gu, ang) in enumerate(((0.15, -95.0), (0.0, 12.0), (-0.15, 70.0))):
        gv = F.height - 0.10
        r = 0.056
        M = F.matrix(gu, gv, 0.006)
        cup = kit.revolve([(0.066, -0.02), (0.07, 0.0), (0.071, 0.012), (0.066, 0.02), (0.058, 0.02), (0.057, 0.012)], segs=24)
        bezels.extend(cup.transform(M @ kit.rot('X', 90)))
        face = kit.cylinder(r, 0.004, segs=32).transform(M @ kit.rot('X', 90))
        origin = M @ Vector((0, 0, 0.004))
        pieces.append(Piece(f'gauge_face_{k}', face, 'M_Cockpit', 'gauge_face', max_lod=1, smooth=40, tier='cockpit',
                            local=(tuple(origin), tuple(-F.u), tuple(F.v)), props={'dr': r}))
        nd = kit.extrude([(-0.003, -0.012), (0.003, -0.012), (0.0012, 0.045), (-0.0012, 0.045)], 0.002)
        nd.extend(kit.cylinder(0.007, 0.006, segs=12).transform(kit.rot('X', 90)))
        needles.extend(nd.transform(M @ Matrix.Translation((0, 0, 0.009)) @ kit.rot('Z', -ang)))
        gl = kit.cylinder(0.058, 0.003, segs=32).transform(M @ Matrix.Translation((0, 0, 0.016)) @ kit.rot('X', 90))
        glass.extend(gl)
    pieces.append(Piece('gauge_bezels', bezels, 'M_Metal', 'stainless_polish', max_lod=1, smooth=45, tier='cockpit'))
    pieces.append(Piece('gauge_needles', needles, 'M_Cockpit', 'label_red', max_lod=0, smooth=None, tier='cockpit', recalc=False))
    pieces.append(Piece('gauge_glass', glass, 'M_Perspex', 'glass_clear', max_lod=1, smooth=50, tier='cockpit'))

    # ── rugged tablet strapped to the panel (plotter) ───────────────────────
    tu, tv = 0.44, F.height * 0.48
    Mt = F.matrix(tu, tv, 0.006)
    case = kit.box(0.29, 0.21, 0.028, center=(0, 0, 0.014))
    for (cx, cy) in ((0.13, 0.09), (-0.13, 0.09), (0.13, -0.09), (-0.13, -0.09)):
        # §V98: corner bumpers sink 3 mm into the face panel; at 2 mm their bevelled backs sat exactly on the §V98 plane
        # tolerance from the case back and flipped to a z-fight with the T196 vcg shift (T200 build)
        case.extend(kit.box(0.05, 0.05, 0.037, center=(cx, cy, 0.0155)))
    pieces.append(Piece('tablet_case', case.transform(Mt), 'M_Cockpit', 'plastic_rugged', max_lod=1, bevel=(0.006, 1), smooth=35, tier='cockpit'))
    scr = kit.box(0.235, 0.155, 0.004, center=(0, 0, 0.029)).transform(Mt)
    pieces.append(Piece('tablet_screen', scr, 'M_Cockpit', 'tablet_screen', max_lod=1, smooth=35, tier='cockpit',
                        local=(tuple(Mt @ Vector((0, 0, 0.031))), tuple(-F.u), tuple(F.v))))
    straps = Geo()
    for sx in (-0.07, 0.07):
        path, ups = [], []
        for (y, z) in ((0.16, 0.0), (0.125, 0.036), (0.08, 0.040), (-0.08, 0.040), (-0.125, 0.036), (-0.16, 0.0)):
            path.append(tuple(Mt @ Vector((sx, y, z))))
            ups.append(tuple((Mt.to_3x3() @ Vector((0, 0.0 if abs(y) < 0.1 else (0.6 if y > 0 else -0.6), 1))).normalized()))
        straps.extend(kit.ribbon(path, 0.035, 0.003, ups))
        straps.extend(kit.box(0.045, 0.02, 0.008, center=(sx, -0.03, 0.044)).transform(Mt))  # buckle
    pieces.append(Piece('tablet_straps', straps, 'M_Cockpit', 'webbing_orange', max_lod=1, smooth=40, tier='cockpit', wear=1.3))

    # ── VHF handset on its clip + coiled cord ───────────────────────────────
    vu, vv = 0.25, F.height * 0.52
    Mv = F.matrix(vu, vv, 0.006)
    clip = kit.box(0.05, 0.03, 0.02, center=(0, 0.04, 0.01))
    pieces.append(Piece('vhf_clip', clip.transform(Mv), 'M_Metal', 'anodised_black', max_lod=0, bevel=(0.003, 1), smooth=35, tier='cockpit'))
    hs = kit.box(0.062, 0.115, 0.036, center=(0, 0.0, 0.03))
    hs.extend(kit.box(0.05, 0.03, 0.008, center=(0, 0.035, 0.05)))   # speaker grille pad
    hs.extend(kit.box(0.014, 0.04, 0.012, center=(0.035, 0.0, 0.03)))  # PTT
    pieces.append(Piece('vhf_handset', hs.transform(Mv), 'M_Cockpit', 'plastic_rugged', max_lod=1, bevel=(0.01, 3), smooth=40, tier='cockpit'))
    cord = kit.helix(0.011, 0.0028, 8, 0.20, 7, 4)
    cord.transform(Mv @ Matrix.Translation((0.0, -0.06, 0.026)) @ kit.rot('X', 180) @ kit.rot('Z', 8))
    pieces.append(Piece('vhf_cord', cord, 'M_Metal', 'rubber', max_lod=0, smooth=70, tier='cockpit', recalc=False))

    # ── guarded toggle switches ─────────────────────────────────────────────
    su, sv = -0.31, F.height * 0.45
    Ms = F.matrix(su, sv, 0.006)
    plate = kit.box(0.23, 0.09, 0.006, center=(0, 0, 0.003))
    pfast = [(tuple(Ms @ Vector((x, y, 0.006))), tuple(F.n), 0.004, 'screw', True) for x in (-0.105, 0.105) for y in (-0.035, 0.035)]
    pieces.append(Piece('switch_plate', plate.transform(Ms), 'M_Metal', 'alu_bare', max_lod=1, bevel=(0.002, 1), smooth=35, tier='cockpit', fasteners=pfast))
    togg = Geo()
    guards = Geo()
    for k in range(4):
        x = -0.075 + k * 0.05
        togg.extend(kit.cylinder(0.008, 0.012, segs=12).transform(Ms @ Matrix.Translation((x, -0.01, 0.006)) @ kit.rot('X', 90)))
        togg.extend(kit.cylinder(0.0025, 0.03, segs=8, r2=0.002).transform(Ms @ Matrix.Translation((x, -0.01, 0.016)) @ kit.rot('X', 90 - 25)))
        if k != 2:
            gd = kit.box(0.03, 0.05, 0.004, center=(0, 0.025, 0.0))
            gd.extend(kit.box(0.004, 0.05, 0.028, center=(0.013, 0.025, -0.014)))
            gd.extend(kit.box(0.004, 0.05, 0.028, center=(-0.013, 0.025, -0.014)))
            guards.extend(gd.transform(Ms @ Matrix.Translation((x, -0.03, 0.036)) @ kit.rot('X', -70)))
    pieces.append(Piece('toggles', togg, 'M_Metal', 'stainless_polish', max_lod=0, smooth=45, tier='cockpit'))
    pieces.append(Piece('toggle_guards', guards, 'M_Cockpit', 'label_red', max_lod=0, bevel=(0.0015, 1), smooth=35, tier='cockpit'))

    # ── kill switch + red coiled lanyard ────────────────────────────────────
    Mk = F.matrix(-0.12, 0.06, 0.006)
    ks = kit.cylinder(0.022, 0.018, segs=18).transform(Mk @ kit.rot('X', 90))
    ks.extend(kit.cylinder(0.014, 0.012, segs=14).transform(Mk @ Matrix.Translation((0, 0, 0.018)) @ kit.rot('X', 90)))
    pieces.append(Piece('kill_switch', ks, 'M_Cockpit', 'plastic_rugged', max_lod=0, bevel=(0.002, 1), smooth=40, tier='cockpit'))
    lan = kit.helix(0.009, 0.0022, 7, 0.20, 7, 4)
    lan.transform(Mk @ Matrix.Translation((0.0, -0.012, 0.03)) @ kit.rot('X', 160))
    pieces.append(Piece('kill_lanyard', lan, 'M_Cockpit', 'label_red', max_lod=0, smooth=70, tier='cockpit', recalc=False))

    # ── gaffer tape over an old crack on the brow corner (05) ───────────────
    Mg = F.matrix(-0.22, F.height - 0.035, 0.0075, spin_deg=-9)
    tape = kit.box(0.13, 0.048, 0.0012)
    pieces.append(Piece('gaffer_tape', tape.transform(Mg), 'M_Cockpit', 'tape_grey', max_lod=0, smooth=35, tier='cockpit', wear=1.4))
    # headset cable jack (the pilot's dash cable plugs in here): a threaded socket on the face panel, bottom right
    Mj = F.matrix(0.36, 0.09, 0.006)
    jack = kit.cylinder(0.011, 0.018, segs=10).transform(Mj @ kit.rot('X', 90))
    jack.extend(kit.cylinder(0.016, 0.004, segs=10).transform(Mj @ Matrix.Translation((0, 0, -0.002)) @ kit.rot('X', 90)))  # collar sunk 2 mm: no shared base plane
    pieces.append(Piece('cable_jack', jack, 'M_Metal', 'anodised_black', max_lod=0, smooth=40, tier='cockpit'))
    sockets = {'dashCableAnchor': {'position': [round(c, 5) for c in (Mj @ Vector((0, 0, 0.018)))], 'normal': [round(c, 5) for c in F.n],
                                   'about': 'headset cable jack mouth on the dash face, body frame; normal toward the pilot'}}
    return {'pieces': pieces, 'extras': {'eye': list(A.eye())}, 'sockets': sockets}
