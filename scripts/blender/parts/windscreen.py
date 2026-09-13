"""
Wrap-around smoked polycarbonate windscreen in an aluminium frame (STYLE-SPEC §2: 0.40 tall, top raked
35°, base at the helm chain's screen station on the centreline wrapping aft to the sides; REFERENCES
e15 scratched polycarbonate, a6 frame; concept 05 cockpit POV).

Socket `windscreen` (derived from the JSON seat through the helm chain, anchors.py). Plan-view base
curve z(x) = zSide + (zCentre − zSide)(1 − |x/hw|^2.4); every base point rises 0.40 while stepping
inboard by 0.40/tan 35°, height easing to 0.30 at the ends. The glass is a closed 12 mm slab; the
frame is an extruded top channel, a centre post and end posts; the base sits in a rubber gasket on
a screwed aluminium flange.
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo, Piece

COLS = 28
ROWS = 5
THICK = 0.012


def build(A):
    W = A.windscreen()
    hw = W['halfWidth']
    zc, zs = W['zBaseCentre'], W['zBaseSide']
    y0 = W['baseY'] + 0.012
    run_per_h = 1.0 / math.tan(W['rake'])

    def base(x):
        u = min(abs(x) / hw, 1.0)
        return Vector((x, y0, zs + (zc - zs) * (1 - u ** 2.4)))

    def inward(x):
        # plan normal of the base curve, pointing into the cockpit
        e = 1e-4
        a, b = base(x - e), base(x + e)
        t = (b - a).normalized()
        n = Vector((t.z, 0.0, -t.x))
        return n if n.z < 0 else -n

    def height(x):
        u = abs(x) / hw
        return W['height'] * (1.0 - 0.25 * kit.smoothstep(0.55, 1.0, u))

    grid_o, grid_i = [], []
    xs = [hw * (-1 + 2 * c / COLS) for c in range(COLS + 1)]
    for r in range(ROWS + 1):
        f = r / ROWS
        ro, ri = [], []
        for x in xs:
            h = height(x)
            n = inward(x)
            p = base(x) + Vector((0, h * f, 0)) + n * (h * run_per_h * f)
            # the slab's outward normal ≈ −n tilted up; offset half the thickness each way
            sn = (-n * math.sin(W['rake']) + Vector((0, math.cos(W['rake']), 0))).normalized()
            ro.append(tuple(p + sn * THICK * 0.5))
            ri.append(tuple(p - sn * THICK * 0.5))
        grid_o.append(ro)
        grid_i.append(ri)
    g = Geo()
    O = [[g.vert(p) for p in row] for row in grid_o]
    I = [[g.vert(p) for p in row] for row in grid_i]
    for r in range(ROWS):
        for c in range(COLS):
            g.face((O[r][c], O[r][c + 1], O[r + 1][c + 1], O[r + 1][c]))
            g.face((I[r][c], I[r + 1][c], I[r + 1][c + 1], I[r][c + 1]))
    for c in range(COLS):
        g.face((O[0][c], I[0][c], I[0][c + 1], O[0][c + 1]))
        g.face((O[ROWS][c], O[ROWS][c + 1], I[ROWS][c + 1], I[ROWS][c]))
    for r in range(ROWS):
        g.face((O[r][0], O[r + 1][0], I[r + 1][0], I[r][0]))
        g.face((O[r][COLS], I[r][COLS], I[r + 1][COLS], O[r + 1][COLS]))
    pieces = [Piece('glass', g, 'M_Perspex', 'perspex_smoke', max_lod=2, smooth=50, wear=1.2, recalc=False)]

    # top channel: a U-ish extrusion swept along the top edge
    top = [tuple((Vector(grid_o[ROWS][c]) + Vector(grid_i[ROWS][c])) / 2) for c in range(COLS + 1)]
    prof = [(-0.007, -0.013), (0.007, -0.013), (0.007, 0.008), (0.004, 0.011), (-0.004, 0.011), (-0.007, 0.008)]
    frame = kit.sweep(top, 0, profile=prof, up_hint=(0, 1, 0))
    pieces.append(Piece('top_channel', frame, 'M_Metal', 'anodised_black', max_lod=2, smooth=40, wear=1.3))
    posts = Geo()
    ffast = []
    for c in (0, COLS // 2, COLS):
        col = [tuple((Vector(grid_o[r][c]) + Vector(grid_i[r][c])) / 2) for r in range(ROWS + 1)]
        posts.extend(kit.sweep(col, 0, profile=[(-0.012, -0.008), (0.012, -0.008), (0.012, 0.008), (-0.012, 0.008)], up_hint=(0, 0, 1)))
        for r in (1, 3, 5):
            p = Vector(grid_o[min(r, ROWS)][c])
            ffast.append((tuple(p + Vector((0, 0, 0.006))), (0, 0, 1), 0.005, 'screw', False))
    pieces.append(Piece('posts', posts, 'M_Metal', 'anodised_black', max_lod=1, smooth=40, fasteners=ffast))
    # base gasket (rubber) + screwed flange on the deck
    basepath = [tuple(base(x)) for x in xs]
    gasket = kit.sweep(basepath, 0, profile=[(-0.004, -0.02), (0.012, -0.02), (0.012, 0.02), (-0.004, 0.02)], up_hint=(0, 1, 0))
    pieces.append(Piece('gasket', gasket, 'M_Metal', 'rubber', max_lod=1, smooth=40))
    fl_path = [tuple(base(x) + Vector((0, -0.008, 0))) for x in xs]
    flange = kit.sweep(fl_path, 0, profile=[(-0.004, -0.045), (0.004, -0.045), (0.004, 0.045), (-0.004, 0.045)], up_hint=(0, 1, 0))
    bfast = []
    screws = Geo()
    for c in range(1, COLS, 3):
        for side in (1, -1):
            p = base(xs[c]) + inward(xs[c]) * (0.032 * side) + Vector((0, -0.004, 0))
            bfast.append((tuple(p), (0, 1, 0), 0.005, 'screw', False))
    pieces.append(Piece('flange', flange, 'M_Metal', 'alu_bare', max_lod=1, smooth=40, fasteners=bfast, wear=1.3))
    return {'pieces': pieces, 'extras': {}}
