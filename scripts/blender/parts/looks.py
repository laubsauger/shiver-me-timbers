"""
Looks: the surface recipes the parts bake and composite with (docs/speedboat/concept/10 swatches,
STYLE-SPEC §4 palette, §5 wear language).

A look has two halves:
  * `pattern`: a Cycles shader (procedural, object/world space) baked into the PAT pass:
      R = alt1 weight, G = alt2 weight, B = micro-height (metres ×1000)
    Looks that need a surface frame (gauge dials, seat pleats, solar cells, decals) read the
    piece's `lo/lx/ly` object attributes (kit.Piece.local).
  * compositor parameters (bake.composite): base/alt colours (sRGB hex), roughness, metal, and wear
    amounts. Wear is never random: edges (bevel-curvature bake), cavities (local AO), up-facing
    ledges (salt), fasteners (rust streaks below carbon-steel fasteners only), welds (heat tint on
    stainless only), per STYLE-SPEC §5 rules 1–4, dialled toward the user's "heavy salvage wear".
"""
import bpy

# fields: base, alt1, alt2, rough, rough_alt, metal, under (chip/edge colour), rough_under,
# metal_under, edge, chips, scratch, grime, salt, fade, livery (0/1), pattern, opacity, height_scale
_D = dict(alt1='#000000', alt2='#000000', rough=0.5, rough_alt=None, metal=0.0, under='#8E8C84', rough_under=0.7,
          metal_under=0.0, edge=0.0, chips=0.0, scratch=0.0, grime=0.5, salt=0.3, fade=0.0, livery=0.0,
          pattern='none', opacity=1.0, rust=0.0, heat=0.0, streaks=0.0, pits=0.0)


def _L(**kw):
    d = dict(_D)
    d.update(kw)
    if d['rough_alt'] is None:
        d['rough_alt'] = d['rough']
    return d


LOOKS = {
    # ── M_Carbon: painted composite + carbon ────────────────────────────────
    'cowl_bone': _L(base='#E3DCCB', rough=0.26, under='#9A968C', rough_under=0.75, edge=0.75, chips=0.45, scratch=0.55,
                    grime=0.75, salt=0.55, fade=0.12, pattern='orange_peel', streaks=0.6),
    'cowl_livery': _L(base='#E4572E', rough=0.24, under='#E3DCCB', rough_under=0.35, edge=0.9, chips=0.55, scratch=0.6,
                      grime=0.4, salt=0.1, fade=0.03, livery=1.0, pattern='orange_peel', streaks=0.3),
    'cowl_decal': _L(base='#E3DCCB', alt1='#1F4E5F', alt2='#E4572E', rough=0.26, under='#9A968C', edge=0.7, chips=0.35,
                     scratch=0.5, grime=0.7, salt=0.5, fade=0.12, pattern='cowl_decal', streaks=0.6),
    'lower_paint': _L(base='#D6CFBD', rough=0.34, under='#8F9496', rough_under=0.45, metal_under=0.9, edge=0.9, chips=0.55,
                      scratch=0.6, grime=0.9, salt=0.85, fade=0.05, pattern='cast', streaks=0.8, pits=0.5),
    'carbon': _L(base='#141517', alt1='#1F2124', rough=0.2, rough_alt=0.26, under='#3A3D40', rough_under=0.55, edge=0.5,
                 scratch=0.4, grime=0.3, salt=0.08, pattern='weave'),
    'vent_black': _L(base='#1E2022', rough=0.6, under='#55585A', edge=0.4, grime=0.9, salt=0.7, pattern='cast'),
    # ── M_Metal: trim sheet ─────────────────────────────────────────────────
    'stainless': _L(base='#B9BBBA', rough=0.26, metal=1.0, under='#8A8C8B', rough_under=0.45, metal_under=1.0, edge=0.3,
                    scratch=0.6, grime=0.55, salt=0.55, pattern='brushed', heat=0.6, rust=0.25),
    'stainless_polish': _L(base='#C9CBCA', rough=0.12, metal=1.0, under='#9A9C9B', metal_under=1.0, edge=0.3, scratch=0.4,
                           grime=0.35, salt=0.3, pattern='brushed'),
    'alu_bare': _L(base='#A7ADB0', rough=0.42, metal=1.0, under='#C9CCCA', rough_under=0.75, metal_under=0.6, edge=0.3,
                   scratch=0.7, grime=0.7, salt=0.7, pattern='brushed', pits=0.4, streaks=0.5),
    'alu_cast': _L(base='#8C9194', rough=0.55, metal=0.85, under='#B9BCBA', rough_under=0.8, metal_under=0.4, edge=0.4,
                   grime=0.85, salt=0.9, pattern='cast', pits=0.8, streaks=0.6),
    'powder_black': _L(base='#222426', rough=0.52, under='#9EA3A5', rough_under=0.4, metal_under=1.0, edge=0.7, chips=0.2,
                       scratch=0.5, grime=0.4, salt=0.3, pattern='cast', streaks=0.4),
    'anodised_black': _L(base='#1B1C1E', rough=0.34, metal=0.5, under='#A7ADB0', rough_under=0.3, metal_under=1.0, edge=0.7,
                         scratch=0.5, grime=0.5, salt=0.4, pattern='brushed'),
    'chrome_rod': _L(base='#D9DADA', rough=0.07, metal=1.0, grime=0.25, salt=0.2, scratch=0.2, pattern='none'),
    'rubber': _L(base='#121314', rough=0.82, under='#2A2B2C', edge=0.4, scratch=0.5, grime=0.3, salt=0.3, pattern='cast'),
    'zinc': _L(base='#9A9D98', rough=0.75, metal=0.6, under='#D2D3CC', rough_under=0.9, grime=0.6, salt=1.0, pits=1.0,
               pattern='cast'),
    'prop_steel': _L(base='#C3C5C4', rough=0.16, metal=1.0, under='#8F918F', metal_under=1.0, edge=0.6, scratch=0.6,
                     grime=0.3, salt=0.35, pattern='brushed'),
    'brass': _L(base='#AE8A55', rough=0.38, metal=1.0, under='#5E7D63', rough_under=0.8, metal_under=0.0, edge=0.2,
                grime=0.8, salt=0.6, pattern='cast'),
    'steel_zinc': _L(base='#8E918F', rough=0.5, metal=0.8, under='#7A4A2A', rough_under=0.9, metal_under=0.2, edge=0.5,
                     grime=0.7, salt=0.6, rust=1.0, pattern='cast'),
    'paint_white': _L(base='#E8E4D8', rough=0.45, grime=0.4, salt=0.2),
    # ── M_Cockpit ───────────────────────────────────────────────────────────
    'vinyl_black': _L(base='#1C1D1F', alt1='#0E0F10', alt2='#E4572E', rough=0.5, rough_alt=0.7, under='#4A4B4C',
                      rough_under=0.8, edge=0.6, scratch=0.35, grime=0.5, salt=0.2, pattern='pleats'),
    'vinyl_side': _L(base='#1C1D1F', alt1='#0E0F10', alt2='#E4572E', rough=0.52, under='#4A4B4C', rough_under=0.8, edge=0.7,
                     scratch=0.35, grime=0.55, salt=0.2, pattern='piping'),
    'webbing_grey': _L(base='#55595C', alt1='#3E4144', rough=0.88, grime=0.6, salt=0.2, pattern='webbing'),
    'webbing_orange': _L(base='#A8582A', alt1='#7E3F1C', rough=0.9, grime=0.8, salt=0.2, pattern='webbing'),
    'plastic_rugged': _L(base='#2A2C2E', rough=0.62, under='#5C5F61', edge=0.6, scratch=0.5, grime=0.6, salt=0.2,
                         pattern='cast'),
    'gauge_face': _L(base='#1A1B1D', alt1='#E8E4D8', alt2='#D0402E', rough=0.35, grime=0.1, salt=0.0, pattern='gauge'),
    'tablet_screen': _L(base='#0B1A22', alt1='#3F97A6', alt2='#E8C46A', rough=0.08, grime=0.15, salt=0.05,
                        pattern='contours'),
    'hdpe_red': _L(base='#A63F2A', rough=0.55, under='#C98A72', rough_under=0.8, edge=0.6, scratch=0.6, grime=0.8, salt=0.6,
                   fade=0.25, pattern='cast'),
    'case_black': _L(base='#2D2F31', rough=0.58, under='#6B6E70', edge=0.8, scratch=0.6, grime=0.7, salt=0.2, pattern='cast'),
    'rope_blue': _L(base='#2E5078', alt1='#D8D3C6', rough=0.92, grime=0.6, salt=0.5, pattern='rope'),
    'rope_tan': _L(base='#B3A383', alt1='#8C7B5E', rough=0.9, grime=0.7, salt=0.4, pattern='rope'),
    'tape_grey': _L(base='#8E9193', rough=0.6, grime=0.7, salt=0.2, pattern='webbing'),
    'knob_black': _L(base='#1A1B1C', rough=0.4, under='#5A5C5E', edge=0.7, grime=0.5, pattern='knurl', salt=0.2),
    'anod_red': _L(base='#9E2A22', rough=0.3, metal=0.6, under='#B8BCBD', metal_under=1.0, edge=0.8, scratch=0.5,
                   grime=0.4, pattern='brushed'),
    'governor_plate': _L(base='#A9ADAE', alt1='#E0B12E', alt2='#18191A', rough=0.4, metal=1.0, edge=0.4, scratch=0.6,
                         grime=0.7, salt=0.2, pattern='hazard', rust=0.6),
    'vinyl_orange': _L(base='#C9562E', rough=0.45, under='#5A4A44', rough_under=0.8, edge=0.8, scratch=0.4, grime=0.4, salt=0.4,
                       pattern='piping'),
    'alu_frame': _L(base='#A7ADB0', rough=0.38, metal=1.0, under='#C9CCCA', rough_under=0.7, metal_under=0.7, edge=0.4,
                    scratch=0.6, grime=0.5, salt=0.6, pattern='brushed', pits=0.3),
    'label_white': _L(base='#EAE6DA', rough=0.5, grime=0.3, salt=0.1),
    'label_red': _L(base='#C8372D', rough=0.5, grime=0.3, salt=0.1),
    'lamp_amber': _L(base='#F0A63A', rough=0.15, grime=0.1, salt=0.0),
    'lamp_green': _L(base='#58C27A', rough=0.15, grime=0.1, salt=0.0),
    'lamp_red': _L(base='#E0432F', rough=0.15, grime=0.1, salt=0.0),
    'solar_cell': _L(base='#0F1A2E', alt1='#9AA6B2', rough=0.1, rough_alt=0.3, grime=0.35, salt=0.5, pattern='solar'),
    'gps_white': _L(base='#E6E2D6', alt1='#B8322A', rough=0.35, grime=0.5, salt=0.4, fade=0.2, pattern='band'),
    # ── M_Perspex ───────────────────────────────────────────────────────────
    'perspex_smoke': _L(base='#3A4044', rough=0.04, scratch=0.9, grime=0.1, salt=0.15, opacity=0.38, pattern='none'),
    'glass_clear': _L(base='#D5DDE0', rough=0.02, scratch=0.3, grime=0.1, salt=0.1, opacity=0.12),
    'lens_red': _L(base='#C8372D', rough=0.08, scratch=0.3, salt=0.3, opacity=0.75),
    'lens_green': _L(base='#3E9A5C', rough=0.08, scratch=0.3, salt=0.3, opacity=0.75),
    'lens_white': _L(base='#EDEAE0', rough=0.08, scratch=0.3, salt=0.3, opacity=0.6),
}


def look(name):
    if name not in LOOKS:
        raise KeyError(f'unknown look {name!r}')
    return LOOKS[name]


# ── pattern shaders (PAT pass) ───────────────────────────────────────────────


class _NT:
    """tiny node-graph helper"""

    def __init__(self, nt):
        self.nt = nt

    def node(self, kind, **inputs):
        n = self.nt.nodes.new(kind)
        for k, v in inputs.items():
            if hasattr(v, 'is_linked') or hasattr(v, 'links'):
                self.nt.links.new(v, n.inputs[k])
            elif isinstance(k, str) and k in n.inputs:
                n.inputs[k].default_value = v
        return n

    def link(self, a, b):
        self.nt.links.new(a, b)

    def math(self, op, a, b=None, clamp=False):
        n = self.nt.nodes.new('ShaderNodeMath')
        n.operation = op
        n.use_clamp = clamp
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                self.nt.links.new(v, n.inputs[i])
        return n.outputs[0]

    def vmath(self, op, a, b=None):
        n = self.nt.nodes.new('ShaderNodeVectorMath')
        n.operation = op
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (tuple, list)):
                n.inputs[i].default_value = v
            else:
                self.nt.links.new(v, n.inputs[i])
        return n.outputs['Value'] if op in ('DOT_PRODUCT', 'LENGTH', 'DISTANCE') else n.outputs['Vector']

    def pos(self):
        return self.nt.nodes.new('ShaderNodeNewGeometry').outputs['Position']

    def attr(self, name, out='Vector'):
        # per-piece data rides as mesh attributes on the slot's joined bake object (bake.bake_slot)
        n = self.nt.nodes.new('ShaderNodeAttribute')
        n.attribute_type = 'GEOMETRY'
        n.attribute_name = 'sb_' + name
        return n.outputs[out]

    def local_uv(self):
        """(u, v) in metres in the piece's local frame (lo, lx, ly object attributes)"""
        d = self.vmath('SUBTRACT', self.pos(), self.attr('lo'))
        return self.vmath('DOT_PRODUCT', d, self.attr('lx')), self.vmath('DOT_PRODUCT', d, self.attr('ly'))

    def noise(self, vec, scale, detail=2.0, rough=0.5):
        n = self.nt.nodes.new('ShaderNodeTexNoise')
        n.noise_dimensions = '3D'
        n.inputs['Scale'].default_value = scale
        n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = rough
        self.nt.links.new(vec, n.inputs['Vector'])
        return n.outputs['Fac']

    def combine(self, r, g, b):
        n = self.nt.nodes.new('ShaderNodeCombineXYZ')
        for i, v in enumerate((r, g, b)):
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                self.nt.links.new(v, n.inputs[i])
        return n.outputs['Vector']

    def smooth(self, e0, e1, x):
        n = self.nt.nodes.new('ShaderNodeMapRange')
        n.interpolation_type = 'SMOOTHSTEP'
        n.inputs['From Min'].default_value = e0
        n.inputs['From Max'].default_value = e1
        self.nt.links.new(x, n.inputs['Value'])
        return n.outputs['Result']


def pattern_vector(nt, pattern):
    """returns a socket carrying (alt1, alt2, height_mm) for the named pattern"""
    N = _NT(nt)
    P = N.pos()
    if pattern == 'none':
        return N.combine(0, 0, 0)
    if pattern == 'orange_peel':
        return N.combine(0, 0, N.math('MULTIPLY', N.noise(P, 900.0, 1.0), 0.06))
    if pattern == 'cast':
        h = N.math('ADD', N.math('MULTIPLY', N.noise(P, 380.0, 3.0, 0.6), 0.12), N.math('MULTIPLY', N.noise(P, 60.0, 2.0), 0.06))
        return N.combine(0, 0, h)
    if pattern == 'brushed':
        s = N.vmath('MULTIPLY', P, (40.0, 40.0, 1400.0))  # hairlines along world Z (Blender up) → tube runs vary, fine
        h = N.math('MULTIPLY', N.noise(s, 1.0, 2.0), 0.04)
        return N.combine(0, 0, h)
    if pattern == 'weave':
        # 2x2 twill read as a 3D checker of 12 mm tows with a fibre sheen split
        ch = nt.nodes.new('ShaderNodeTexChecker')
        ch.inputs['Scale'].default_value = 1.0 / 0.006
        ch.inputs['Color1'].default_value = (1, 1, 1, 1)
        ch.inputs['Color2'].default_value = (0, 0, 0, 1)
        nt.links.new(P, ch.inputs['Vector'])
        c = ch.outputs['Fac']
        fib = N.noise(N.vmath('MULTIPLY', P, (900.0, 900.0, 900.0)), 1.0, 1.0)
        a1 = N.math('ADD', N.math('MULTIPLY', c, 0.7), N.math('MULTIPLY', fib, 0.3))
        return N.combine(N.math('MULTIPLY', a1, 0.6), 0, N.math('MULTIPLY', c, 0.03))
    if pattern == 'webbing':
        u, v = N.local_uv() if False else (None, None)
        wave = nt.nodes.new('ShaderNodeTexWave')
        wave.wave_type = 'RINGS'
        wave.inputs['Scale'].default_value = 1400.0
        wave.inputs['Distortion'].default_value = 0.0
        nt.links.new(P, wave.inputs['Vector'])
        f = N.noise(P, 1600.0, 1.0)
        a1 = N.math('MULTIPLY', wave.outputs['Fac'], 0.6)
        return N.combine(a1, 0, N.math('ADD', N.math('MULTIPLY', wave.outputs['Fac'], 0.08), N.math('MULTIPLY', f, 0.05)))
    if pattern == 'rope':
        f = N.noise(N.vmath('MULTIPLY', P, (1.0, 1.0, 1.0)), 700.0, 2.0)
        fleck = N.smooth(0.62, 0.7, N.noise(P, 250.0, 1.0))
        return N.combine(fleck, 0, N.math('MULTIPLY', f, 0.4))
    if pattern == 'knurl':
        wa = nt.nodes.new('ShaderNodeTexWave')
        wa.wave_type = 'BANDS'
        wa.bands_direction = 'DIAGONAL'
        wa.inputs['Scale'].default_value = 300.0
        nt.links.new(P, wa.inputs['Vector'])
        return N.combine(0, 0, N.math('MULTIPLY', wa.outputs['Fac'], 0.25))
    # ── local-frame patterns ────────────────────────────────────────────────
    u, v = N.local_uv()
    if pattern == 'gauge':
        # u, v centred on the dial, metres; radius r, angle a (0 at 12 o'clock, clockwise)
        r = N.math('SQRT', N.math('ADD', N.math('MULTIPLY', u, u), N.math('MULTIPLY', v, v)))
        a = N.math('ARCTAN2', u, v)  # atan2(u, v): 0 up
        R = N.attr('dr', 'Fac')  # dial radius (Piece.props)
        rn = N.math('DIVIDE', r, R)
        # major ticks every 30°, minor every 6°, over a 270° sweep
        sweep = N.math('LESS_THAN', N.math('ABSOLUTE', a), 2.36)
        maj = N.math('LESS_THAN', N.math('ABSOLUTE', N.math('SUBTRACT', N.math('FRACT', N.math('DIVIDE', N.math('ADD', a, 3.1416), 0.5236)), 0.5)), 0.035)
        mino = N.math('LESS_THAN', N.math('ABSOLUTE', N.math('SUBTRACT', N.math('FRACT', N.math('DIVIDE', N.math('ADD', a, 3.1416), 0.10472)), 0.5)), 0.06)
        band_maj = N.math('MULTIPLY', N.math('GREATER_THAN', rn, 0.70), N.math('LESS_THAN', rn, 0.90))
        band_min = N.math('MULTIPLY', N.math('GREATER_THAN', rn, 0.80), N.math('LESS_THAN', rn, 0.90))
        ticks = N.math('MAXIMUM', N.math('MULTIPLY', maj, band_maj), N.math('MULTIPLY', mino, band_min))
        ring = N.math('MULTIPLY', N.math('GREATER_THAN', rn, 0.92), N.math('LESS_THAN', rn, 0.94))
        hub = N.math('LESS_THAN', rn, 0.1)
        a1 = N.math('MAXIMUM', N.math('MAXIMUM', N.math('MULTIPLY', ticks, sweep), ring), hub)
        red = N.math('MULTIPLY', N.math('MULTIPLY', N.math('GREATER_THAN', a, 1.45), sweep), N.math('MULTIPLY', N.math('GREATER_THAN', rn, 0.72), N.math('LESS_THAN', rn, 0.9)))
        return N.combine(N.math('MULTIPLY', a1, N.math('SUBTRACT', 1.0, red)), red, 0)
    if pattern == 'contours':
        n1 = N.noise(N.vmath('MULTIPLY', P, (1.0, 1.0, 1.0)), 9.0, 3.0, 0.55)
        lines = N.math('LESS_THAN', N.math('ABSOLUTE', N.math('SUBTRACT', N.math('FRACT', N.math('MULTIPLY', n1, 14.0)), 0.5)), 0.07)
        land = N.smooth(0.52, 0.56, n1)
        grid = N.math('MAXIMUM',
                      N.math('LESS_THAN', N.math('ABSOLUTE', N.math('SUBTRACT', N.math('FRACT', N.math('DIVIDE', u, 0.03)), 0.5)), 0.03),
                      N.math('LESS_THAN', N.math('ABSOLUTE', N.math('SUBTRACT', N.math('FRACT', N.math('DIVIDE', v, 0.03)), 0.5)), 0.03))
        cursor = N.math('LESS_THAN', N.math('SQRT', N.math('ADD', N.math('MULTIPLY', u, u), N.math('MULTIPLY', v, v))), 0.006)
        a1 = N.math('MAXIMUM', N.math('MAXIMUM', lines, N.math('MULTIPLY', land, 0.35)), N.math('MULTIPLY', grid, 0.25))
        return N.combine(a1, cursor, 0)
    if pattern == 'solar':
        cu = N.math('LESS_THAN', N.math('ABSOLUTE', N.math('SUBTRACT', N.math('FRACT', N.math('DIVIDE', u, 0.052)), 0.5)), 0.04)
        cv = N.math('LESS_THAN', N.math('ABSOLUTE', N.math('SUBTRACT', N.math('FRACT', N.math('DIVIDE', v, 0.052)), 0.5)), 0.04)
        bus = N.math('LESS_THAN', N.math('ABSOLUTE', N.math('SUBTRACT', N.math('FRACT', N.math('DIVIDE', v, 0.0104)), 0.5)), 0.05)
        a1 = N.math('MAXIMUM', N.math('MAXIMUM', cu, cv), N.math('MULTIPLY', bus, 0.3))
        return N.combine(a1, 0, N.math('MULTIPLY', a1, 0.05))
    if pattern == 'pleats':
        # horizontal pleats every 55 mm along the local v axis, piping at |u| > 0.17
        ph = N.math('FRACT', N.math('DIVIDE', v, 0.055))
        groove = N.math('LESS_THAN', N.math('ABSOLUTE', N.math('SUBTRACT', ph, 0.5)), 0.04)
        bulge = N.math('SINE', N.math('MULTIPLY', ph, 3.14159))
        pipe = N.math('MULTIPLY', N.math('GREATER_THAN', N.math('ABSOLUTE', u), 0.165), N.math('LESS_THAN', N.math('ABSOLUTE', u), 0.175))
        h = N.math('ADD', N.math('MULTIPLY', bulge, 1.2), N.math('MULTIPLY', N.noise(P, 500.0, 2.0), 0.08))
        return N.combine(groove, pipe, h)
    if pattern == 'piping':
        return N.combine(0, 0, N.math('MULTIPLY', N.noise(P, 500.0, 2.0), 0.08))
    if pattern == 'hazard':
        diag = N.math('FRACT', N.math('DIVIDE', N.math('ADD', u, v), 0.025))
        stripe = N.math('LESS_THAN', diag, 0.5)
        band = N.math('LESS_THAN', v, -0.069)
        return N.combine(N.math('MULTIPLY', band, stripe), N.math('MULTIPLY', band, N.math('SUBTRACT', 1.0, stripe)), 0)
    if pattern == 'band':
        b = N.math('MULTIPLY', N.math('GREATER_THAN', v, -0.012), N.math('LESS_THAN', v, 0.012))
        return N.combine(b, 0, 0)
    if pattern == 'cowl_decal':
        # fictional race mark on the cowl flank: a teal speed chevron pair and an orange bar (no brands)
        c1 = N.math('LESS_THAN', N.math('ABSOLUTE', N.math('SUBTRACT', N.math('ADD', u, N.math('MULTIPLY', N.math('ABSOLUTE', v), 0.9)), 0.00)), 0.022)
        c2 = N.math('LESS_THAN', N.math('ABSOLUTE', N.math('SUBTRACT', N.math('ADD', u, N.math('MULTIPLY', N.math('ABSOLUTE', v), 0.9)), 0.07)), 0.022)
        inv = N.math('LESS_THAN', N.math('ABSOLUTE', v), 0.07)
        chev = N.math('MULTIPLY', N.math('MAXIMUM', c1, c2), inv)
        bar = N.math('MULTIPLY', N.math('MULTIPLY', N.math('GREATER_THAN', u, 0.14), N.math('LESS_THAN', u, 0.36)),
                     N.math('LESS_THAN', N.math('ABSOLUTE', N.math('ADD', v, 0.045)), 0.012))
        return N.combine(chev, bar, 0)
    raise KeyError(f'unknown pattern {pattern!r}')
