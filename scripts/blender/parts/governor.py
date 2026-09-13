"""
The "Governor": a scavenged throttle-limiter module bolted onto the dash (user decision; OFF / AIR / FULL
dial). Socket `dash` via cockpit_frame.Face, right of the switch panel, readable from the seat at
~0.6 m. Parts: a bolted steel box with a lid lip, a brushed plate with a hazard band, four hex bolts
(carbon steel: rust halos + streaks), engraved-look raised labels OFF / AIR / FULL and a GOVERNOR
stencil, detent ticks, three status lamps (green / amber / red), and a cable gland with its cable
into the dash. The rotating knob is its own node (governor_dial.py).
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo, Piece
from cockpit_frame import Face

# dial detents (degrees clockwise from 12 o'clock, seen from the seat)
DETENTS = {'OFF': -60.0, 'AIR': 0.0, 'FULL': 60.0}
SIZE = (0.155, 0.17, 0.07)


def socket(A):
    F = Face(A)
    return F, F.matrix(-0.50, F.height * 0.52, 0.006)


def build(A):
    F, M = socket(A)
    w, h, d = SIZE
    pieces = []
    box = kit.box(w, h, d, center=(0, 0, d / 2))
    box.extend(kit.box(w + 0.012, h + 0.012, 0.008, center=(0, 0, 0.004)))  # mounting flange
    pieces.append(Piece('box', box.transform(M), 'M_Cockpit', 'case_black', max_lod=1, bevel=(0.004, 2), smooth=35, tier='cockpit', wear=1.3))
    plate = kit.box(w - 0.012, h - 0.012, 0.003, center=(0, 0, d + 0.0015))
    fast = []
    bolts = Geo()
    for (bx, by) in ((w / 2 - 0.016, h / 2 - 0.016), (-w / 2 + 0.016, h / 2 - 0.016), (w / 2 - 0.016, -h / 2 + 0.016), (-w / 2 + 0.016, -h / 2 + 0.016)):
        p = M @ Vector((bx, by, d + 0.003))
        fast.append((tuple(p), tuple(F.n), 0.006, 'bolt', True))
        bolts.extend(kit.hex_prism(0.0075, 0.006).transform(M @ Matrix.Translation((bx, by, d + 0.003)) @ kit.rot('X', 90)))
    origin = M @ Vector((0, 0, d + 0.003))
    pieces.append(Piece('plate', plate.transform(M), 'M_Cockpit', 'governor_plate', max_lod=1, smooth=35, tier='cockpit', fasteners=fast,
                        local=(tuple(origin), tuple(M.to_3x3() @ Vector((1, 0, 0))), tuple(M.to_3x3() @ Vector((0, 1, 0))))))
    pieces.append(Piece('bolts', bolts, 'M_Metal', 'steel_zinc', max_lod=0, smooth=35, tier='cockpit'))

    # labels around the dial (raised paint, 0.6 mm), dial centre slightly above the plate middle
    dc = Vector((0.0, -0.004, d + 0.003))
    labels = Geo()
    red = Geo()
    for name, ang in DETENTS.items():
        a = math.radians(ang)
        r = 0.05
        t = kit.text_geo(name, 0.016)
        t.transform(Matrix.Translation((dc.x + math.sin(a) * r, dc.y + math.cos(a) * r - 0.004, dc.z + 0.0006)))
        (red if name == 'FULL' else labels).extend(t)
        tick = kit.box(0.0022, 0.009, 0.0008, center=(0, 0.031, 0.0004))
        (red if name == 'FULL' else labels).extend(tick.transform(Matrix.Translation(dc) @ kit.rot('Z', -ang)))
    title = kit.text_geo('GOVERNOR', 0.0105)
    title.transform(Matrix.Translation((0.0, h / 2 - 0.026, d + 0.0036)))
    labels.extend(title)
    pieces.append(Piece('labels', labels.transform(M), 'M_Cockpit', 'label_white', max_lod=0, smooth=None, recalc=False, tier='cockpit'))
    pieces.append(Piece('labels_red', red.transform(M), 'M_Cockpit', 'label_red', max_lod=0, smooth=None, recalc=False, tier='cockpit'))

    lamps = Geo()
    for k, look in enumerate(('lamp_green', 'lamp_amber', 'lamp_red')):
        x = -0.03 + 0.03 * k
        ring = kit.cylinder(0.0085, 0.004, segs=14).transform(M @ Matrix.Translation((x, -0.056, d + 0.003)) @ kit.rot('X', 90))
        lamps.extend(ring)
        lens = kit.dome(0.006, 12, 3, h=0.004).transform(M @ Matrix.Translation((x, -0.056, d + 0.007)) @ kit.rot('X', 90))
        pieces.append(Piece(f'lamp_{k}', lens, 'M_Cockpit', look, max_lod=0, smooth=60, tier='cockpit'))
    skirt = kit.revolve([(0.032, 0.0), (0.033, 0.003), (0.03, 0.006), (0.022, 0.007)], segs=32, caps=True)
    lamps.extend(skirt.transform(M @ Matrix.Translation(dc) @ kit.rot('X', 90)))  # the dial's fixed bezel
    pieces.append(Piece('lamp_rings', lamps, 'M_Metal', 'stainless_polish', max_lod=1, smooth=45, tier='cockpit'))

    gland = kit.cylinder(0.011, 0.018, segs=12).transform(M @ Matrix.Translation((0.045, -h / 2 - 0.016, d * 0.5)) @ kit.rot('X', 180))
    gland.extend(kit.hex_prism(0.0135, 0.008).transform(M @ Matrix.Translation((0.045, -h / 2 - 0.002, d * 0.5)) @ kit.rot('X', 180)))
    pieces.append(Piece('gland', gland, 'M_Metal', 'brass', max_lod=0, smooth=40, tier='cockpit'))
    path = [tuple(M @ Vector(p)) for p in ((0.045, -h / 2 - 0.03, d * 0.5), (0.05, -h / 2 - 0.08, d * 0.45), (0.07, -h / 2 - 0.12, d * 0.2), (0.08, -h / 2 - 0.14, -0.01))]
    cable = kit.sweep(kit.fillet_path(path, 0.03, 4), 0.0055, 8)
    pieces.append(Piece('cable', cable, 'M_Metal', 'rubber', max_lod=0, smooth=60, tier='cockpit'))
    return {'pieces': pieces, 'extras': {}}
