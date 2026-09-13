"""
Single centreline bolster seat with a 4-point harness (user decision; STYLE-SPEC §2 seat pan 0.62 above
the sole; REFERENCES c5 bolsters, g8 harness hardware; concept 04/06b black bucket with orange piping).

Socket `seat`: JSON renderOnly.cockpit.seats[0] (station) + the well sole. A welded alloy pedestal
with a footrest bar, a flip-up bolster pan, a raked racing-bucket back lofted from U-sections (wings
and headrest, subdivided once), orange piping along the wing edges, harness slots, and the 4-point
harness lying slack: shoulder straps down the backrest face, lap belts across the pan to a cam-lock
buckle, with adjusters.
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo, Piece

RAKE = math.radians(12)


def back_section(t):
    """front-face U profile (x, forward offset) at height fraction t (0 pan, 1 headrest top)"""
    cx = 0.15 - 0.03 * t
    wing_x = 0.235 - 0.06 * kit.smoothstep(0.55, 1.0, t)
    wing_fwd = 0.12 * math.sin(math.pi * min(1.0, 0.2 + t)) * (1.0 - 0.6 * kit.smoothstep(0.7, 1.0, t)) + 0.02
    return cx, wing_x, wing_fwd


def build(A):
    S = A.seat()
    x0, z0, ys = S['x'], S['z'], S['soleY']
    y_pan = ys + A.extra['seat']['panAboveSole']
    pieces = []

    # ── pedestal ────────────────────────────────────────────────────────────
    frame = Geo()
    legs = [(sx, sz) for sx in (-0.17, 0.17) for sz in (-0.14, 0.14)]
    for (sx, sz) in legs:
        frame.extend(kit.sweep([(x0 + sx, ys + 0.01, z0 + sz), (x0 + sx * 0.9, y_pan - 0.08, z0 + sz * 0.9)], 0.017, 8))
    for sz in (-0.14, 0.14):
        frame.extend(kit.sweep([(x0 - 0.17, ys + 0.25, z0 + sz), (x0 + 0.17, ys + 0.25, z0 + sz)], 0.013, 10))
    for sx in (-0.17, 0.17):
        frame.extend(kit.sweep([(x0 + sx, ys + 0.25, z0 - 0.14), (x0 + sx, ys + 0.25, z0 + 0.14)], 0.013, 10))
    foot = kit.fillet_path([(x0 - 0.2, ys + 0.25, z0 + 0.14), (x0 - 0.22, ys + 0.22, z0 + 0.36), (x0 + 0.22, ys + 0.22, z0 + 0.36), (x0 + 0.2, ys + 0.25, z0 + 0.14)], 0.05, 5)
    frame.extend(kit.sweep(foot, 0.016, 8))
    welds = [(x0 + sx, ys + 0.25, z0 + sz) for (sx, sz) in legs]
    pieces.append(Piece('pedestal', frame, 'M_Metal', 'alu_frame', max_lod=2, smooth=60, welds=welds, wear=1.3))
    base = kit.box(0.44, 0.012, 0.40, center=(x0, ys + 0.006, z0))
    bf = [((x0 + sx, ys + 0.012, z0 + sz), (0, 1, 0), 0.008, 'bolt', True) for sx in (-0.19, 0.19) for sz in (-0.17, 0.17)]
    pieces.append(Piece('base_plate', base, 'M_Metal', 'alu_bare', max_lod=1, bevel=(0.003, 1), smooth=35, fasteners=bf, wear=1.4))
    grip = kit.cylinder(0.021, 0.30, segs=12, axis='x').translate((x0 - 0.15, ys + 0.22, z0 + 0.36))
    pieces.append(Piece('foot_grip', grip, 'M_Metal', 'rubber', max_lod=1, smooth=50))

    # ── bolster pan ─────────────────────────────────────────────────────────
    Mp = Matrix.Translation((x0, y_pan - 0.05, z0 + 0.02)) @ kit.rot('X', -8)
    pan = kit.box(0.44, 0.10, 0.34)
    pieces.append(Piece('pan', pan.transform(Mp), 'M_Cockpit', 'vinyl_black', max_lod=2, bevel=(0.03, 4), smooth=40,
                        local=(tuple(Mp @ Vector((0, 0.05, 0))), (1, 0, 0), tuple((Mp.to_3x3() @ Vector((0, 0, 1))).normalized()))))
    pan_shell = kit.box(0.40, 0.03, 0.30, center=(0, -0.065, 0))
    pieces.append(Piece('pan_shell', pan_shell.transform(Mp), 'M_Carbon', 'carbon', max_lod=1, bevel=(0.008, 2), smooth=40))

    # ── bucket back (U-section loft, subdivided once) ───────────────────────
    H = 0.72
    back_y0 = y_pan - 0.02
    back_z0 = z0 - 0.16
    up = Vector((0, math.cos(RAKE), -math.sin(RAKE)))
    fwd = Vector((0, math.sin(RAKE), math.cos(RAKE)))
    rings = []
    rows = 8
    for i in range(rows + 1):
        t = i / rows
        cx, wx, wf = back_section(t)
        th = 0.075 - 0.02 * t
        c = Vector((x0, back_y0, back_z0)) + up * (H * t)
        # closed ring: front face left→right, then the back face right→left
        front = [(-wx, wf), (-wx + 0.04, wf * 0.55), (-cx, 0.0), (0.0, -0.01), (cx, 0.0), (wx - 0.04, wf * 0.55), (wx, wf)]
        back = [(wx + 0.02, wf - th * 0.6), (cx + 0.02, -th), (0.0, -th - 0.01), (-cx - 0.02, -th), (-wx - 0.02, wf - th * 0.6)]
        ring = [tuple(c + Vector((px, 0, 0)) + fwd * pz) for (px, pz) in front + back]
        rings.append(ring)
    back = kit.grid_loft(rings, closed=True, cap0=True, cap1=True)
    pieces.append(Piece('back', back, 'M_Cockpit', 'vinyl_black', max_lod=2, smooth=180, subsurf=1,
                        local=(tuple(Vector((x0, back_y0, back_z0))), (1, 0, 0), tuple(up))))
    # orange piping along both wing front edges
    piping = Geo()
    for side in (-1, 1):
        path = []
        for i in range(rows + 1):
            t = 0.02 + 0.88 * i / rows  # stop short of the subdivided headrest roll
            cx, wx, wf = back_section(t)
            path.append(tuple(Vector((x0, back_y0, back_z0)) + up * (H * t) + Vector((side * (wx - 0.012), 0, 0)) + fwd * (wf * 0.78)))
        piping.extend(kit.sweep(path, 0.007, 8))
    pieces.append(Piece('piping', piping, 'M_Cockpit', 'vinyl_orange', max_lod=1, smooth=60))
    slots = Geo()
    for side in (-1, 1):
        c = Vector((x0 + side * 0.075, back_y0, back_z0)) + up * (H * 0.86) + fwd * 0.006
        slots.extend(kit.box(0.06, 0.018, 0.02).transform(Matrix.Translation(c) @ kit.frame((0, 0, 0), (1, 0, 0), up)))
    pieces.append(Piece('harness_slots', slots, 'M_Cockpit', 'plastic_rugged', max_lod=0, bevel=(0.003, 1), smooth=35))

    # ── 4-point harness, slack ──────────────────────────────────────────────
    straps = Geo()
    hard = Geo()
    buckle_c = Mp @ Vector((0.0, 0.03, 0.19))
    for side in (-1, 1):
        path, ups = [], []
        for i in range(8, -1, -1):  # from the slot down the backrest face
            t = 0.86 * i / 8
            cx, wx, wf = back_section(t)
            p = Vector((x0 + side * (0.075 - 0.035 * (1 - i / 8)), back_y0, back_z0)) + up * (H * t) + fwd * 0.012
            path.append(tuple(p))
            ups.append(tuple(fwd))
        # over the pan to the buckle. §V98 (§T.192 scan): the two straps converge and overlapped 3 cm wide in ONE plane;
        # the port strap lies on top of the starboard one (6 mm up: 3 mm webbing + clearance)
        lift = 0.006 if side > 0 else 0.0
        pan_top = Mp @ Vector((side * 0.02, 0.058 + lift, -0.05))
        path.append(tuple(pan_top))
        ups.append(tuple((Mp.to_3x3() @ Vector((0, 1, 0))).normalized()))
        path.append(tuple(buckle_c + (Mp.to_3x3() @ Vector((0, lift, 0))) + Vector((side * 0.01, 0.01, -0.02))))
        ups.append(tuple((Mp.to_3x3() @ Vector((0, 1, 0.3))).normalized()))
        straps.extend(kit.ribbon(path, 0.05, 0.003, ups))
        adj = Vector(path[3]) + fwd * 0.006
        hard.extend(kit.box(0.058, 0.03, 0.008).transform(Matrix.Translation(adj) @ kit.frame((0, 0, 0), (1, 0, 0), up)))
        # lap belt from the pan side, across the top
        lap = [tuple(Mp @ Vector((side * 0.24, -0.02, 0.02))), tuple(Mp @ Vector((side * 0.225, 0.052, 0.05))),
               tuple(Mp @ Vector((side * 0.12, 0.057, 0.11))), tuple(buckle_c + Vector((side * 0.03, 0.0, 0.0)))]
        lups = [(side, 0.3, 0), tuple((Mp.to_3x3() @ Vector((side * 0.3, 1, 0))).normalized()), tuple((Mp.to_3x3() @ Vector((0, 1, 0))).normalized()),
                tuple((Mp.to_3x3() @ Vector((0, 1, 0.3))).normalized())]
        straps.extend(kit.ribbon(lap, 0.05, 0.003, lups))
    pieces.append(Piece('harness', straps, 'M_Cockpit', 'webbing_grey', max_lod=1, smooth=40, wear=1.2))
    cam = kit.cylinder(0.038, 0.014, segs=24).transform(Matrix.Translation(buckle_c) @ kit.frame((0, 0, 0), (1, 0, 0), (Mp.to_3x3() @ Vector((0, 1, 0.3))).normalized()))
    cam.extend(kit.cylinder(0.02, 0.008, segs=16).transform(Matrix.Translation(buckle_c + (Mp.to_3x3() @ Vector((0, 0.014, 0.004)))) @ kit.frame((0, 0, 0), (1, 0, 0), (Mp.to_3x3() @ Vector((0, 1, 0.3))).normalized())))
    hard.extend(cam)
    pieces.append(Piece('harness_hardware', hard, 'M_Metal', 'alu_bare', max_lod=0, bevel=(0.002, 1), smooth=40))
    sockets = {
        'seat': {'position': [round(x0, 5), round(y_pan, 5), round(z0, 5)], 'up': [0.0, 1.0, 0.0], 'forward': [0.0, 0.0, 1.0],
                 'about': 'pan top centre at the JSON seat station, body frame: the pilot frame origin (pilot-log v2)'},
        'footrest': {'centre': [round(x0, 5), round(ys + 0.22, 5), round(z0 + 0.36, 5)], 'axis': [1.0, 0.0, 0.0], 'halfLength': 0.15, 'radius': 0.021,
                     'about': 'rubber-gripped foot bar, body frame'},
    }
    return {'pieces': pieces, 'extras': {}, 'sockets': sockets}
