"""
Four-blade stainless racing prop (cleaver-style, cupped trailing edge; REFERENCES d4/d6), its own
node so the runtime can spin it (`animRole: propSpin`, `pivot`, `axis`, `handed`, `follows`).

Socket: `engine.<id>.prop` (JSON prop point and radius). Blades are lofted on helical pitch lines
(pitch 0.66 m ≈ 26 in, a 450R-class wheel), skewed back, thickened toward the root, cupped at the
trailing edge. Starboard (S) is left-handed: mirrored in x about the prop axis.
"""
import math

from mathutils import Matrix, Vector

import kit
from kit import Geo, Piece

PITCH = 0.66
BLADES = 4


def blade(R, r_hub, nr=9, nc=7):
    """one blade around +Z (three: forward), centred on the disc plane z = 0, for a RH prop"""
    top, bot = [], []
    for i in range(nr + 1):
        s = i / nr
        s_r = 1 - (1 - s) ** 1.25                    # denser toward the tip where the outline turns
        r = r_hub * 0.92 + (R - r_hub * 0.92) * s_r
        # chord (as an angle) widens to 60 % radius, then rounds off to a cleaver tip
        chord = r * (1.05 + 0.65 * math.sin(math.pi * s_r * 0.9)) * (1.0 - 0.5 * s_r ** 3)
        chord = max(chord, 0.03)
        skew = 0.35 * s_r ** 1.6                       # rad, swept back against rotation
        phi = math.atan2(PITCH, 2 * math.pi * r)     # pitch angle
        t_max = 0.014 * (1 - s_r) + 0.0035 * s_r         # thickness root → tip
        rowt, rowb = [], []
        for j in range(nc + 1):
            c = j / nc                                # 0 leading → 1 trailing
            arc = (0.5 - c) * chord                   # along the helix, metres
            ang = arc / r * math.cos(phi) - skew
            z = -arc * math.sin(phi)
            # cleaver: thin sharp leading edge, blunt thick trailing edge; cup lifts the TE
            th = t_max * (0.25 + 0.75 * c ** 0.7)
            cup = 0.006 * smooth01((c - 0.8) / 0.2) * (0.4 + 0.6 * s_r)
            x, y = r * math.cos(ang), r * math.sin(ang)
            n = Vector((-math.sin(ang) * math.sin(phi), math.cos(ang) * math.sin(phi), math.cos(phi)))
            p = Vector((x, y, z - cup))
            rowt.append(tuple(p + n * th * 0.5))
            rowb.append(tuple(p - n * th * 0.5))
        top.append(rowt)
        bot.append(rowb)
    g = Geo()
    T = [[g.vert(p) for p in row] for row in top]
    B = [[g.vert(p) for p in row] for row in bot]
    for i in range(nr):
        for j in range(nc):
            g.face((T[i][j], T[i + 1][j], T[i + 1][j + 1], T[i][j + 1]))
            g.face((B[i][j], B[i][j + 1], B[i + 1][j + 1], B[i + 1][j]))
    for i in range(nr):  # leading and trailing edges
        g.face((T[i][0], B[i][0], B[i + 1][0], T[i + 1][0]))
        g.face((T[i][nc], T[i + 1][nc], B[i + 1][nc], B[i][nc]))
    for j in range(nc):  # tip and root
        g.face((T[nr][j], B[nr][j], B[nr][j + 1], T[nr][j + 1]))
        g.face((T[0][j], T[0][j + 1], B[0][j + 1], B[0][j]))
    # the grid above winds inward (radial × chord points against the +n offset): flip once
    return g.flip()


def smooth01(x):
    x = min(max(x, 0.0), 1.0)
    return x * x * (3 - 2 * x)


def build(A, engine):
    E = A.engine(engine)
    R = E['propR']
    c = Vector((E['propX'], E['propY'], E['propZ']))
    r_hub = 0.052
    pieces = []
    # hub barrel: forward thrust hub → barrel → exhaust flare → nut
    prof = [(0.05, 0.035), (0.056, 0.02), (r_hub, -0.03), (0.05, -0.10), (0.058, -0.125), (0.052, -0.13),
            (0.032, -0.135), (0.03, -0.165), (0.022, -0.18), (0.001, -0.185)]
    hub = kit.revolve([(r, y) for (r, y) in prof], segs=18, caps=True)
    hub.transform(kit.rot('X', 90))  # +Y → +Z: the profile's y is now z along the prop axis
    blades = Geo()
    for k in range(BLADES):
        b = blade(R, r_hub)
        b.transform(kit.rot('Z', 360.0 * k / BLADES + 20.0))
        blades.extend(b)
    M = Matrix.Translation(c)
    if E['handed'] < 0:
        M = M @ Matrix.Diagonal((-1, 1, 1, 1))
        blades.flip()
    hub.transform(Matrix.Translation(c))
    blades.transform(M)
    pieces.append(Piece('hub', hub, 'M_Metal', 'prop_steel', max_lod=2, smooth=50))
    pieces.append(Piece('blades', blades, 'M_Metal', 'prop_steel', max_lod=2, smooth=180, wear=1.2))
    # splined nut + tab washer (close-up detail)
    nut = kit.hex_prism(0.026, 0.02)
    nut.transform(Matrix.Translation(c + Vector((0, 0, -0.15))) @ kit.rot('X', -90))
    pieces.append(Piece('nut', nut, 'M_Metal', 'stainless', max_lod=0, bevel=(0.002, 1), smooth=35))
    extras = {
        'animRole': 'propSpin',
        'engine': engine,
        'pivot': [c.x, c.y, c.z],
        'axis': [0.0, 0.0, 1.0],
        'handed': int(E['handed']),
        'follows': f'Outboard_{engine}',
    }
    return {'pieces': pieces, 'extras': extras}
