"""
SB-12 HERO hull shell (docs/speedboat/hull-log.md): lofted from the physics proxy's own offsets.

Input: the scripts/blender/hullOffsets.ts dump (spec, renderOnly, 241 stations). Everything below is
authored in the HULL frame (x across, y up from the keel baseline, z forward from the transom) and
converted to the body frame (minus the CG) only when a vertex is emitted.

Surface (one quad grid, stations x ring points, so every LOD is a subset of the same vertices and
UVs, and the shell stays one closed manifold for the foam/wetline checker):
  keel      rounded keel line (cutwater radius growing to the stem) with a flatter keel pad aft
            (REFERENCES a7/a8: Donzi/Fountain "pad" bottoms, 15.5 deg against the 24 deg V)
  strakes   3 per side at the JSON chine fractions: flat underside + vertical outboard face,
            small bevel on the running edge, tapered out over 0.6 m before `toZ`
  chine     chine flat (JSON renderOnly.chineFlat) with a bevelled outer edge
  spray     a low spray rail on the forward topsides (fades in at 6.6 m, out by 11.3 m)
  topsides  vertical from the chine, easing into the 8 deg flare (JSON topsideFlareStartAboveChine)
            on a quadratic blend, so the sheer lands exactly on halfBeamAt + flare (checker C3)
  sheer     rounded deck edge (the parts' rub rail covers the deck-hull joint)
  deck      flat at the proxy deck height (the parts sit on it) with the cockpit well cut in:
            rounded aft corners, forward end following the windscreen base curve, lip radius,
            vertical walls, filleted sole
  stem      forward of the last checked station the section is scaled toward a raked, rounded
            stem profile and a round nose, closed by a fan
  transom   flat, with a 4 mm rolled edge (two bevel rings), capped
  plates    starboard bow doubler and aft chine plate: thin closed slabs 3.5 mm proud (LOD0 only;
            the texture paints them onto the shell too, so LOD1/2 still show them)
"""
import math

import bmesh
import bpy

TAN8 = math.tan(math.radians(8.0))
TRANSOM_R = 0.004


def smoothstep(e0, e1, x):
    if e0 == e1:
        return 1.0 if x >= e1 else 0.0
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def hermite(t, p0, m0, p1, m1):
    t2, t3 = t * t, t * t * t
    return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1


# ── ring point names (constant topology; LOD sets are subsets) ───────────────
STRAKE_NAMES = [n for i in range(3) for n in (f's{i}_root', f's{i}_f1', f's{i}_fm', f's{i}_f2', f's{i}_top')]
HALF_NAMES = (['keel_arc', 'keel_tan', 'pad_edge'] + STRAKE_NAMES
              + ['chine_root', 'chine_c1', 'chine_cm', 'chine_c2', 'sr_root', 'sr_out', 'sr_top',
                 'flare_a', 'flare_b', 'flare_c', 'flare_d', 'edge_e1', 'edge_em', 'edge_e2',
                 'deck_a', 'lip0', 'lipm', 'lip1', 'wall_b0', 'sole_m', 'sole_b1'])
LOD_POINTS = [
    None,  # LOD0: every point
    {'keel_tan', 'pad_edge', 's0_root', 's0_f1', 's0_top', 's1_root', 's1_f1', 's1_top', 's2_root', 's2_f1', 's2_top',
     'chine_root', 'chine_c2', 'flare_a', 'flare_c', 'edge_e1', 'edge_e2', 'deck_a', 'lip0', 'lip1', 'wall_b0', 'sole_b1'},
    {'chine_root', 'chine_c2', 'flare_b', 'edge_e1', 'lip0', 'lip1', 'sole_b1'},
]
# longitudinal edges through these points are marked sharp (concave roots; the convex edges carry bevel arcs)
SHARP_POINTS = {'s0_root', 's1_root', 's2_root', 's0_top', 's1_top', 's2_top', 'chine_root', 'sr_root', 'sr_out', 'sr_top'}
# ...and at the coarser LODs, where the bevel arcs are gone, the convex feature corners too
SHARP_POINTS_COARSE = SHARP_POINTS | {'s0_f1', 's1_f1', 's2_f1', 'chine_c2', 'edge_e1', 'lip1', 'wall_b0', 'sole_b1', 'lip0'}

ISLAND_SHELL_P, ISLAND_SHELL_S, ISLAND_DECK, ISLAND_WELL, ISLAND_TRANSOM, ISLAND_PLATE = range(6)
MAT_GELCOAT, MAT_NONSLIP = 0, 1


class HeroHull:
    def __init__(self, hull, anchors):
        self.hull = hull
        self.A = anchors
        spec = hull['spec']
        self.spec = spec
        self.ro = hull['renderOnly']
        st = hull['stations']
        self.st = st
        self.L = spec['length']
        self.lcg = spec['lcgFromTransom']
        self.vcg = spec['vcgAboveKeel']
        self.tz = [s['z'] for s in st]
        self.Lk = self.tz[-1]
        self.dy = st[0]['deckY']
        self.stem_z = max(s.get('deckZ', s['z']) for s in st)
        self.flare_start = self.ro.get('topsideFlareStartAboveChine', 0.0)
        self.flare_tan = math.tan(math.radians(self.ro.get('topsideFlareDeg', 0.0)))
        self.strakes = sorted(self.ro['strakes'], key=lambda s: s['atChineFraction'])
        self.chine_flat = self.ro['chineFlat']['width']
        # the last station the checker slices (chineHalfBeam > 0.1): the bow extension starts just past it
        zx = self.Lk
        for s in st:
            if s['chineHalfBeam'] <= 0.105:
                zx = s['z']
                break
        self.z_x = zx
        self.z_nose = self.stem_z - 0.07
        self._well_setup()
        self._plates_setup()
        self.number_field = self._number_field()

    # ── station table ───────────────────────────────────────────────────────
    def at(self, z):
        st, tz = self.st, self.tz
        if z <= tz[0]:
            a = st[0]
            return dict(a)
        if z >= tz[-1]:
            return dict(st[-1])
        n = len(tz)
        j = min(int(z / tz[-1] * (n - 1)), n - 2)
        while j > 0 and tz[j] > z:
            j -= 1
        while j < n - 2 and tz[j + 1] < z:
            j += 1
        a, b = st[j], st[j + 1]
        f = (z - a['z']) / max(b['z'] - a['z'], 1e-9)
        return {k: (a[k] * (1 - f) + b[k] * f) if isinstance(a[k], (int, float)) else a[k] for k in a}

    def proxy_sheer_half(self, z):
        s = self.at(z)
        return s['chineHalfBeam'] + max(0.0, s['deckY'] - s['chineY'] - self.flare_start) * self.flare_tan

    def body(self, x, y, z):
        return (x, y - self.vcg, z - self.lcg)

    # ── cockpit well plan (sockets from the parts anchors: JSON well range + windscreen base) ─
    def _well_setup(self):
        A = self.A
        W = A.cockpit_well()
        S = A.windscreen()
        self.well_aft = W['zAft'] + self.lcg
        self.well_half = W['halfWidth']
        self.sole_y = W['soleY'] + self.vcg
        self.well_r_aft = 0.22
        self.lip_r = 0.03
        self.sole_r = 0.03
        # forward end follows the windscreen base curve (windscreen.py), 5 cm inboard so the screen
        # flange lands on the deck: z(x) = zs + (zc - zs)(1 - |x/hw|^2.4)
        self.scr_hw = S['halfWidth']
        m = 0.05
        self.scr_zc = S['zBaseCentre'] + self.lcg - m
        self.scr_zs = S['zBaseSide'] + self.lcg - m
        json_fwd = W['zFwd'] + self.lcg
        self.scr_zc = min(self.scr_zc, json_fwd - 0.01)
        self.well_w_end = 0.16
        self.well_fwd_start = self._scr_z(self.well_half)
        self.well_fwd_end = self._scr_z(self.well_w_end)

    def _scr_z(self, x):
        u = min(abs(x) / self.scr_hw, 1.0)
        return self.scr_zs + (self.scr_zc - self.scr_zs) * (1 - u ** 2.4)

    def _scr_x(self, z):
        f = (z - self.scr_zs) / (self.scr_zc - self.scr_zs)
        return self.scr_hw * max(0.0, 1.0 - f) ** (1 / 2.4)

    def well_width(self, z):
        """opening half-width at hull z, or None outside the well"""
        za, R, hw = self.well_aft, self.well_r_aft, self.well_half
        if z < za - 1e-9 or z > self.well_fwd_end + 1e-9:
            return None
        if z <= za + R:
            d = za + R - z
            return (hw - R) + math.sqrt(max(0.0, R * R - d * d))
        if z <= self.well_fwd_start:
            return hw
        return max(self.well_w_end, min(hw, self._scr_x(z)))

    def well_nominal(self, z):
        """the flat-deck layout of the well columns (matches the adjacent well end ring)"""
        if z < self.well_aft:
            return self.well_half - self.well_r_aft
        return self.well_w_end

    # ── the section ────────────────────────────────────────────────────────
    def half_section(self, z, well=None, nominal=None):
        """+x half of the section at hull z, keel (excluded) → deck centre (excluded).
        Returns ([(name, x, y)], bottom_y, top_y) with names = HALF_NAMES."""
        s = self.at(z)
        ky, b, cy, dy = s['keelY'], max(s['chineHalfBeam'], 1e-3), s['chineY'], s['deckY']
        tanb = (cy - ky) / b
        P = {}
        # keel pad aft: flatter V at the keel, the running V lowered to meet it
        pad_f = 1.0 - smoothstep(3.0, 5.5, z)
        wp = 0.10 * pad_f
        s0 = math.tan(math.radians(15.5)) * pad_f + tanb * (1 - pad_f)

        def Vb(x):
            if x <= wp:
                return ky + x * s0
            return ky + wp * s0 + (x - wp) * tanb

        rk = 0.010 + 0.012 * smoothstep(8.0, 11.3, z)
        alpha = math.atan(s0)
        yc = ky + rk / math.cos(alpha)
        y_bottom = yc - rk
        P['keel_arc'] = (rk * math.sin(alpha / 2), yc - rk * math.cos(alpha / 2))
        xt = rk * math.sin(alpha)
        P['keel_tan'] = (xt, Vb(xt))
        gap = 0.004
        xpad = max(wp, xt + gap)
        P['pad_edge'] = (xpad, Vb(xpad))
        prev = xpad
        wc = min(self.chine_flat, 0.15 * b)
        chine_root = b - wc
        # strakes: flat underside at the root height, vertical outboard face
        strake_defs = []
        for k, sd in enumerate(self.strakes):
            fade = 1.0 - smoothstep(sd['toZ'] - 0.6, sd['toZ'], z)
            w = max(0.004, sd['flatWidth'] * fade)
            x0 = max(sd['atChineFraction'] * b, prev + gap)
            strake_defs.append([x0, w])
            prev = x0 + w
        if prev + gap > chine_root:
            # bow: squeeze the strake roots between the keel and the chine root, keeping order
            lo, hi = xpad + gap, chine_root - gap
            span = sum(w for _, w in strake_defs) + gap * (len(strake_defs) - 1)
            if hi - lo < span:
                raise RuntimeError(f'hero hull: no room for the strakes at z {z:.3f}')
            x = lo
            free = (hi - lo - span) / max(len(strake_defs), 1)
            for sd in strake_defs:
                sd[0] = x + free * 0.5
                x = sd[0] + sd[1] + gap + free * 0.5
        for k, (x0, w) in enumerate(strake_defs):
            yf = Vb(x0)
            yt = Vb(x0 + w)
            depth = yt - yf
            rb = min(0.005, 0.3 * w, 0.3 * depth)
            cxb, cyb = x0 + w - rb, yf + rb
            P[f's{k}_root'] = (x0, yf)
            P[f's{k}_f1'] = (cxb, yf)
            P[f's{k}_fm'] = (cxb + rb * math.sin(math.pi / 4), cyb - rb * math.cos(math.pi / 4))
            P[f's{k}_f2'] = (x0 + w, cyb)
            P[f's{k}_top'] = (x0 + w, yt)
        # chine flat + bevelled outer edge
        yfl = Vb(chine_root)
        rc = min(0.007, 0.3 * wc)
        P['chine_root'] = (chine_root, yfl)
        P['chine_c1'] = (b - rc, yfl)
        P['chine_cm'] = (b - rc + rc * math.sin(math.pi / 4), yfl + rc - rc * math.cos(math.pi / 4))
        P['chine_c2'] = (b, yfl + rc)
        # topsides: vertical, then a C1 blend into the flare
        yk = cy + self.flare_start
        c2y = yfl + rc
        # the knuckle blend may not reach down into the chine bevel + spray rail (JSON flare knuckle can sit
        # only 0.19 m above the chine): ring points must stay ordered or the topside folds into a slit
        h = max(0.02, min(0.2, 0.3 * (dy - cy), yk - max(c2y, cy) - 0.05))

        def xtop(y):
            d = y - yk
            if d <= -h:
                g = 0.0
            elif d >= h:
                g = d
            else:
                g = (d + h) ** 2 / (4 * h)
            return b + self.flare_tan * g

        # the rail sits just above the proxy chine height, so the checker's chine slice (≤ chineY + 5 mm) never sees it
        ysr = max(c2y + 0.010, cy + 0.008)
        sr_f = smoothstep(6.6, 7.4, z) * (1.0 - smoothstep(10.9, 11.3, z))
        room = (yk - h - 0.006) - ysr
        e = max(0.0012, min(0.012 * sr_f, room / 2.2))
        if room < 2.2 * 0.0012 + 0.001:
            raise RuntimeError(f'hero hull: no room for the spray rail under the flare knuckle at z {z:.3f}')
        P['sr_root'] = (xtop(ysr), ysr)
        P['sr_out'] = (xtop(ysr) + e, ysr)
        P['sr_top'] = (xtop(ysr + 2.2 * e), ysr + 2.2 * e)
        re = 0.015
        P['flare_a'] = (xtop(yk - h), yk - h)
        P['flare_b'] = (xtop(yk), yk)
        P['flare_c'] = (xtop(yk + h), yk + h)
        yd = 0.5 * (yk + h + dy - re)
        P['flare_d'] = (xtop(yd), yd)
        xs = xtop(dy)
        P['edge_e1'] = (xtop(dy - re), dy - re)
        P['edge_em'] = (xs - re + re * 0.62, dy - re + re * 0.74)
        P['edge_e2'] = (xs - re, dy)
        # deck + well columns
        e2 = xs - re
        top_y = dy
        if well is not None:
            wn = well
            rl, rs = self.lip_r, self.sole_r
            P['lip0'] = (wn + rl, dy)
            P['lipm'] = (wn + rl * (1 - math.sin(math.pi / 4)), dy - rl * (1 - math.cos(math.pi / 4)))
            P['lip1'] = (wn, dy - rl)
            P['wall_b0'] = (wn, self.sole_y + rs)
            P['sole_m'] = (wn - rs * (1 - math.cos(math.pi / 4)), self.sole_y + rs * (1 - math.sin(math.pi / 4)))
            P['sole_b1'] = (wn - rs, self.sole_y)
            top_y = self.sole_y
        else:
            wn = nominal if nominal is not None else self.well_nominal(z)
            rl = min(self.lip_r, 0.12 * e2)
            wn = max(min(wn, 0.55 * e2 - rl), 0.03)
            rs = min(self.sole_r, 0.2 * wn)
            P['lip0'] = (wn + rl, dy)
            P['lipm'] = (wn + 0.3 * rl, dy)
            P['lip1'] = (wn, dy)
            P['wall_b0'] = (wn - 0.12 * rs, dy)
            P['sole_m'] = (wn - 0.45 * rs - 0.1 * wn, dy)
            P['sole_b1'] = (wn - rs - 0.3 * wn, dy)
        P['deck_a'] = (0.5 * (e2 + P['lip0'][0]), dy)
        pts = [(n, P[n][0], P[n][1]) for n in HALF_NAMES]
        return pts, y_bottom, top_y

    # ── rings ──────────────────────────────────────────────────────────────
    def _ring_from_half(self, half, y_bottom, top_y):
        """full closed ring in the (x, y) plane: keel → +x half → top centre → −x half (CCW seen from +z)"""
        pts = [('keel', 0.0, y_bottom)] + half + [('top', 0.0, top_y)] + [(n + '#S', -x, y) for (n, x, y) in reversed(half)]
        return pts

    def station_list(self):
        """[(z, kind, lod)] kind: 'flat' | 'well' | 'ext' | 'nose' | 'transom0/1/2'. lod = coarsest LOD keeping it."""
        rings = []
        r = TRANSOM_R
        rings.append((0.0, 'transom0', 2))
        rings.append((r * (1 - math.cos(math.pi / 4)), 'transom1', 0))
        rings.append((r, 'transom2', 1))
        base = []
        z = 0.15
        k = 1
        while z < 7.0 - 1e-6:
            base.append((z, 2 if k % 12 == 0 else (1 if k % 4 == 0 else 0)))
            z += 0.15
            k += 1
        z = 7.0
        k = 0
        while z < self.z_x - 0.02:
            base.append((z, 2 if k % 10 == 0 else (1 if k % 4 == 0 else 0)))
            z += 0.07
            k += 1
        for sd in self.strakes:
            for j in range(7):
                base.append((sd['toZ'] - 0.6 + j * 0.1, 1 if j in (0, 6) else 0))
        za, zfe = self.well_aft, self.well_fwd_end
        special = [(za - 0.012, 'flat', 2), (za, 'well', 2)]
        R = self.well_r_aft
        for j, th in enumerate((12, 25, 40, 55, 72)):
            t = math.radians(th)
            special.append((za + R * (1 - math.cos(t)), 'well', 1 if j in (1, 3) else 0))
        special.append((za + R, 'well', 1))
        nx = 12
        for j in range(1, nx):
            x = self.well_half + (self.well_w_end - self.well_half) * (j / nx) ** 0.8
            special.append((self._scr_z(x), 'well', 2 if j == nx // 2 else (1 if j % 3 == 0 else 0)))
        special.append((self.well_fwd_start, 'well', 1))
        special.append((zfe, 'well', 2))
        special.append((zfe + 0.012, 'flat', 2))
        sz = [s[0] for s in special]
        for (zb, lod) in base:
            if any(abs(zb - q) < 0.03 for q in sz):
                continue
            kind = 'well' if (za < zb < zfe) else 'flat'
            special.append((zb, kind, lod))
        special.sort(key=lambda s: s[0])
        dedup = []
        for s in special:
            if dedup and abs(s[0] - dedup[-1][0]) < 0.004:
                if s[2] > dedup[-1][2]:
                    dedup[-1] = (dedup[-1][0], dedup[-1][1], s[2])
                continue
            dedup.append(s)
        rings += dedup
        # bow extension: scaled copies of the last checked section toward the stem profile
        zx = self.z_x
        n_ext = 12
        for j in range(1, n_ext + 1):
            zz = zx + (self.z_nose - zx) * j / n_ext
            rings.append((zz, 'ext', 2 if j in (6, 12) else (1 if j % 3 == 0 else 0)))
        z_close = self.stem_z - 0.015
        for j, ph in enumerate((22, 42, 58, 72)):
            p = math.radians(ph)
            rings.append((self.z_nose + (z_close - self.z_nose) * math.sin(p), 'nose', 1 if j == 3 else 0))
        return rings

    def stem_y(self, z):
        """the proxy's own stem: keel parabola to the forefoot, then the straight raked stem line to the deck
        (JSON stemRake), joined by a small forefoot radius (smooth max) — a clean cutwater, concept 06b/07"""
        spec = self.spec
        Lk = self.Lk
        u = z / Lk
        t = (u - spec['keelRiseStart']) / (1 - spec['keelRiseStart'])
        keel = spec['bowKeelRise'] * t * t if t > 0 else 0.0
        y_ff = self.st[-1]['keelY']
        line = y_ff + (z - Lk) * (self.dy - y_ff) / max(self.stem_z - Lk, 1e-6)
        k = 0.02
        return min(self.dy, 0.5 * (keel + line + math.sqrt((keel - line) ** 2 + k * k)))

    def ring(self, z, kind):
        """closed ring [(name, x, y, z)] for a station"""
        if kind.startswith('transom'):
            half, yb, yt = self.half_section(0.0)
            pts = self._ring_from_half(half, yb, yt)
            r = TRANSOM_R
            th = {'transom0': 0.0, 'transom1': math.pi / 4, 'transom2': math.pi / 2}[kind]
            inset = r * (1 - math.sin(th))
            return [(n, x, y, z) for (n, x, y) in _inset(pts, inset)]
        if kind == 'well':
            w = self.well_width(z)
            if w is None:
                raise RuntimeError(f'hero hull: well ring at z {z:.3f} outside the well')
            half, yb, yt = self.half_section(z, well=w)
            return [(n, x, y, z) for (n, x, y) in self._ring_from_half(half, yb, yt)]
        if kind == 'flat':
            half, yb, yt = self.half_section(z)
            return [(n, x, y, z) for (n, x, y) in self._ring_from_half(half, yb, yt)]
        # ext / nose: scale the z_x section
        half, yb0, yt = self.half_section(self.z_x)
        pts = self._ring_from_half(half, yb0, yt)
        xs0 = max(x for (_, x, _) in pts)
        zc = min(z, self.z_nose)
        xs_t = self.proxy_sheer_half(min(zc, self.Lk))
        sx = xs_t / xs0
        if z > self.z_nose:
            q = (z - self.z_nose) / (self.stem_z - self.z_nose)
            sx *= math.sqrt(max(0.0, 1.0 - q * q))
        dy = self.dy
        sy = (dy - self.stem_y(z)) / (dy - yb0)
        return [(n, x * sx, dy - (dy - y) * sy, z) for (n, x, y) in pts]

    def apex(self):
        return (0.0, self.dy - 0.004, self.stem_z)

    # ── salvage plates (STYLE-SPEC §5.3) ───────────────────────────────────
    def _plates_setup(self):
        self.plates = [
            # starboard bow doubler: aft edge vertical, forward edge raked with the stem
            {'name': 'bow_doubler', 'side': -1, 'z0': 9.55, 'z1': 10.70, 'rake': 0.22, 'd_top': None, 'd_bot': 0.95, 'chine_clear': 0.07},
            # aft starboard chine plate: a long riveted strip just above the chine
            {'name': 'chine_plate', 'side': -1, 'z0': 0.15, 'z1': 2.05, 'rake': 0.0, 'y_lo': 0.05, 'y_hi': 0.27},
        ]

    def plate_outline(self, p, z, f):
        """hull y at parameter f ∈ [0,1] (top → bottom) of plate p at z, and the plate's z range at that height"""
        s = self.at(z)
        if 'd_top' in p:
            # under the pinstripe, down to just above the chine (the spray rail): from the live livery layout
            d_top = self.stripe_bottom_depth(z) + 0.035
            d_bot = min(p['d_bot'], s['deckY'] - s['chineY'] - p['chine_clear'])
            if d_bot < d_top + 0.10 and p['z0'] - 1e-6 <= z <= p['z1'] + 1e-6:
                raise RuntimeError(f"hero hull: bow doubler has no topside room at z {z:.2f} (top {d_top:.3f}, bottom {d_bot:.3f} below deck)")
            d_bot = max(d_bot, d_top + 0.02)
            d = d_top + (d_bot - d_top) * f
            return s['deckY'] - d
        return s['chineY'] + p['y_hi'] + (p['y_lo'] - p['y_hi']) * f

    def topside_x(self, z, y):
        half, _, _ = self.half_section(z)
        # spray rail points are proud of the topside line: interpolate on the base line only
        base = [(x, yy) for (n, x, yy) in half if n in ('chine_c2', 'flare_a', 'flare_b', 'flare_c', 'flare_d', 'edge_e1')]
        for (x0, y0), (x1, y1) in zip(base[:-1], base[1:]):
            if y0 <= y <= y1:
                t = (y - y0) / max(y1 - y0, 1e-9)
                return x0 + (x1 - x0) * t
        return base[-1][0]

    def plate_geo(self, p, nu=18, nv=6):
        """closed slab: outer skin 3.5 mm proud (chamfered 2 mm), back 2 mm inside the shell"""
        side = p['side']
        out_off, back_off, ch = 0.0035, -0.002, 0.002
        grid_o, grid_b, uvs = [], [], []
        for i in range(nv + 1):
            f = i / nv
            row_o, row_b, row_uv = [], [], []
            for j in range(nu + 1):
                g = j / nu
                z_top = p['z1']
                zf = z_top - p['rake'] * f
                z = p['z0'] + (zf - p['z0']) * g
                y = self.plate_outline(p, z, f)
                xb = self.topside_x(z, y)
                edge = (i in (0, nv)) or (j in (0, nu))
                row_o.append((side * (xb + (out_off - (ch if edge else 0.0))), y, z))
                row_b.append((side * (xb + back_off), y, z))
                row_uv.append((z, y))
            grid_o.append(row_o)
            grid_b.append(row_b)
            uvs.append(row_uv)
        return grid_o, grid_b, uvs

    # ── number field (hand-painted race number, STYLE-SPEC §4.3 (a)) ────────
    # ── livery layout: every painted height derives from the live JSON topside (deck − chine) ──
    def _layout_setup(self):
        s0 = self.at(0.0)
        h0 = self.dy - s0['chineY']
        clamp = lambda v, a, b: max(a, min(b, v))  # noqa: E731
        self.band_hidden = 0.03                        # under the rub rail
        self.band_w = clamp(0.24 * h0, 0.12, 0.24)
        self.stripe_gap = clamp(0.035 * h0, 0.02, 0.03)
        self.stripe_t = clamp(0.055 * h0, 0.03, 0.045)
        self.waterline = min(0.60, s0['chineY'] + 0.09)

    def band_lo(self, zn):
        """band bottom, depth below the deck; zn = z / L (numpy-safe). The band narrows 30 % toward the bow"""
        return self.band_hidden + self.band_w * (1.0 - 0.3 * zn ** 1.5)

    def stripe_centre(self, zn):
        return self.band_lo(zn) + self.stripe_gap + self.stripe_t / 2

    def stripe_bottom_depth(self, z):
        return self.stripe_centre(min(max(z / self.stem_z, 0.0), 1.0)) + self.stripe_t / 2

    def boot_y(self, cy):
        """antifoul top (hull y): the rest waterline aft, riding the chine forward (numpy-safe smooth max)"""
        a, b, k = self.waterline, cy + 0.035, 0.05
        return 0.5 * (a + b + ((a - b) ** 2 + k * k) ** 0.5)

    def _number_field(self):
        """STYLE-SPEC §4.3: ~0.6 m numerals on the topsides under the cockpit, shrunk to fit the clear topside
        between the pinstripe and the boot line with margins (fails loud when they cannot fit)"""
        self._layout_setup()
        margin = 0.05
        zc = self.well_aft + 0.9 * (self.well_fwd_end - self.well_aft)
        H = 0.60
        for _ in range(4):
            dw, gap = H * 2 / 3, H * 0.10
            half_w = dw + gap / 2
            zs = [zc - half_w, zc, zc + half_w]
            top = self.dy - max(self.stripe_bottom_depth(z) for z in zs) - margin
            bottom = max(self.boot_y(self.at(z)['chineY']) for z in zs) + margin
            H = min(0.60, top - bottom)
        if H < 0.18:
            raise RuntimeError(f'hero hull: race number has only {H:.2f} m of clear topside (pinstripe → boot line)')
        dw, gap = H * 2 / 3, H * 0.10
        return {'zCentre': zc, 'yCentre': 0.5 * (top + bottom), 'height': round(H, 4), 'digitWidth': round(dw, 4), 'gap': round(gap, 4),
                'clearTop': top + margin, 'clearBottom': bottom - margin, 'zMin': zc - 1.5, 'zMax': zc + 1.5}

    # ── mesh ───────────────────────────────────────────────────────────────
    def build_mesh(self, lod, name):
        """bmesh for LOD n: rings subset, points subset, UV islands, material + island attributes, sharp edges"""
        rings_all = self.station_list()
        rings = [(z, kind) for (z, kind, l) in rings_all if l >= lod]
        keep = LOD_POINTS[lod]
        sharp_set = SHARP_POINTS if lod == 0 else SHARP_POINTS_COARSE
        # LOD0 rings with full data (UV params come from LOD0 geometry)
        data = []
        for (z, kind) in rings:
            pts = self.ring(z, kind)
            data.append((z, kind, pts))
        n_full = len(data[0][2])
        idx = [i for i, p in enumerate(data[0][2]) if keep is None or p[0].split('#')[0] in keep or p[0] in ('keel', 'top')]
        # per-point UV params on the full ring: shell girth from the keel, well girth from the top centre
        bm = bmesh.new()
        uv_layer = bm.loops.layers.uv.new('UVMap')
        isl_layer = bm.faces.layers.int.new('sb_island')
        verts = []
        params = []
        well_gap = self.well_gap()
        for (z, kind, pts) in data:
            girth = [0.0]
            for j in range(n_full - 1):
                a, b = pts[j], pts[j + 1]
                girth.append(girth[-1] + math.hypot(b[1] - a[1], b[2] - a[2]))
            i_top = next(j for j, p in enumerate(pts) if p[0] == 'top')
            row_v, row_p = [], []
            u_well = z + (well_gap if z >= self.well_aft - 1e-6 else 0.0) + (well_gap if z > self.well_fwd_end + 1e-6 else 0.0)
            for j in idx:
                n, x, y, zz = pts[j]
                bx, by, bz = self.body(x, y, zz)
                row_v.append(bm.verts.new((bx, -bz, by)))
                gs = girth[j] if j <= i_top else girth[-1] - girth[j] + math.hypot(pts[-1][1] - pts[0][1], pts[-1][2] - pts[0][2])
                gw = girth[j] - girth[i_top]
                row_p.append({'name': n, 'shell': (zz, gs), 'deck': (zz, x), 'well': (u_well, gw), 'x': x})
            verts.append(row_v)
            params.append((kind, row_p))
        m = len(idx)
        layout = self.uv_layout()

        seg_kind = self._segment_kinds(data[0][2], idx)
        sharp_idx = {k for k, j in enumerate(idx) if data[0][2][j][0].split('#')[0] in sharp_set}
        for r in range(len(data) - 1):
            ka, ra = params[r]
            kb, rb = params[r + 1]
            for k in range(m):
                k2 = (k + 1) % m
                sk = seg_kind[k]
                if sk == 'wellpart':
                    sk = 'well' if (ka == 'well' or kb == 'well') else 'deck'
                if sk == 'shell':
                    island = ISLAND_SHELL_P if (ra[k]['x'] + ra[k2]['x']) >= 0 else ISLAND_SHELL_S
                    key = 'shell'
                    mat = MAT_GELCOAT
                else:
                    island = ISLAND_DECK if sk == 'deck' else ISLAND_WELL
                    key = sk
                    mat = MAT_NONSLIP
                f = bm.faces.new((verts[r][k], verts[r][k2], verts[r + 1][k2], verts[r + 1][k]))
                f.material_index = mat
                f.smooth = True
                f[isl_layer] = island
                corners = [ra[k], ra[k2], rb[k2], rb[k]]
                for loop, pp in zip(f.loops, corners):
                    u, v = pp[key]
                    loop[uv_layer].uv = layout.uv(island, u, v)
            for k in sharp_idx:
                e = bm.edges.get((verts[r][k], verts[r + 1][k]))
                if e is not None:
                    e.smooth = False
        # transom cap (outward −z): reverse ring order
        # fan from an interior point: the section is star-shaped about it, and an ear clip over the
        # collinear deck-edge points leaves zero-area triangles (NaN tangents)
        ring0 = verts[0]
        pts0 = [params[0][1][k] for k in range(m)]
        yc = 0.55 * self.dy
        cx, cy_, cz = self.body(0.0, yc, 0.0)
        centre = bm.verts.new((cx, -cz, cy_))
        for k in range(m):
            k2 = (k + 1) % m
            f = bm.faces.new((ring0[k2], ring0[k], centre))
            f.material_index = MAT_GELCOAT
            f.smooth = True
            f[isl_layer] = ISLAND_TRANSOM
            for loop, kk in zip(f.loops, (k2, k, None)):
                if kk is None:
                    loop[uv_layer].uv = layout.uv(ISLAND_TRANSOM, 0.0, yc)
                else:
                    loop[uv_layer].uv = layout.uv(ISLAND_TRANSOM, pts0[kk]['x'], data[0][2][idx[kk]][2])
        # bow apex fan
        ax, ay, az = self.apex()
        bx, by, bz = self.body(ax, ay, az)
        apex = bm.verts.new((bx, -bz, by))
        last = verts[-1]
        kind_l, rp = params[-1]
        for k in range(m):
            k2 = (k + 1) % m
            sk = seg_kind[k]
            if sk == 'wellpart':
                sk = 'deck'
            f = bm.faces.new((last[k], last[k2], apex))
            f.smooth = True
            if sk == 'shell':
                island = ISLAND_SHELL_P if (rp[k]['x'] + rp[k2]['x']) >= 0 else ISLAND_SHELL_S
                f.material_index = MAT_GELCOAT
                key = 'shell'
            else:
                island = ISLAND_DECK
                f.material_index = MAT_NONSLIP
                key = 'deck'
            f[isl_layer] = island
            u_apex = self.stem_z
            for loop, pp in zip(f.loops, (rp[k], rp[k2], None)):
                if pp is None:
                    a, b = rp[k][key], rp[k2][key]
                    loop[uv_layer].uv = layout.uv(island, u_apex, 0.5 * (a[1] + b[1]))
                else:
                    u, v = pp[key]
                    loop[uv_layer].uv = layout.uv(island, u, v)
        if lod == 0:
            for p in self.plates:
                self._add_plate(bm, uv_layer, isl_layer, p, layout)
        bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='BEAUTY', ngon_method='EAR_CLIP')
        mesh = bpy.data.meshes.new(name)
        bm.to_mesh(mesh)
        bm.free()
        return mesh

    def _segment_kinds(self, full_pts, idx):
        """kind of each kept segment (idx[k] → idx[k+1]) from the longest LOD0 sub-segment it spans"""
        n = len(full_pts)

        def sub_kind(j):
            a = full_pts[j][0].split('#')[0]
            b = full_pts[(j + 1) % n][0].split('#')[0]
            order = ['keel'] + HALF_NAMES + ['top']
            ia, ib = order.index(a), order.index(b)
            lo = min(ia, ib)
            nm = order[lo]
            if lo < order.index('edge_e2'):
                return 'shell'
            if lo < order.index('lip0'):
                return 'deck'
            return 'wellpart'

        out = []
        m = len(idx)
        for k in range(m):
            j0, j1 = idx[k], idx[(k + 1) % m]
            span = []
            j = j0
            while j != j1:
                a, b = full_pts[j], full_pts[(j + 1) % n]
                span.append((math.hypot(b[1] - a[1], b[2] - a[2]), sub_kind(j)))
                j = (j + 1) % n
            best = {}
            for ln, kd in span:
                best[kd] = best.get(kd, 0.0) + ln
            out.append(max(best.items(), key=lambda kv: kv[1])[0])
        return out

    def _add_plate(self, bm, uv_layer, isl_layer, p, layout):
        go, gb, uvs = self.plate_geo(p)
        nv, nu = len(go) - 1, len(go[0]) - 1
        V = lambda P: bm.verts.new(tuple((P[0], -(P[2] - self.lcg), P[1] - self.vcg)))  # noqa: E731
        vo = [[V(P) for P in row] for row in go]
        vb = [[V(P) for P in row] for row in gb]
        faces = []
        for i in range(nv):
            for j in range(nu):
                faces.append(((vo[i][j], vo[i][j + 1], vo[i + 1][j + 1], vo[i + 1][j]),
                              (uvs[i][j], uvs[i][j + 1], uvs[i + 1][j + 1], uvs[i + 1][j]), ''))
                faces.append(((vb[i][j], vb[i + 1][j], vb[i + 1][j + 1], vb[i][j + 1]),
                              (uvs[i][j], uvs[i + 1][j], uvs[i + 1][j + 1], uvs[i][j + 1]), '#back'))
        loop_idx = [(0, j) for j in range(nu)] + [(i, nu) for i in range(nv)] + [(nv, j) for j in range(nu, 0, -1)] + [(i, 0) for i in range(nv, 0, -1)]
        for a in range(len(loop_idx)):
            i0, j0 = loop_idx[a]
            i1, j1 = loop_idx[(a + 1) % len(loop_idx)]
            faces.append(((vo[i0][j0], vb[i0][j0], vb[i1][j1], vo[i1][j1]),
                          (uvs[i0][j0], uvs[i0][j0], uvs[i1][j1], uvs[i1][j1]), '#back'))
        new = []
        for vs, uv, tag in faces:
            f = bm.faces.new(vs)
            f.material_index = MAT_GELCOAT
            f.smooth = True
            f[isl_layer] = ISLAND_PLATE
            for loop, (u, v) in zip(f.loops, uv):
                loop[uv_layer].uv = layout.uv(ISLAND_PLATE, u, v, plate=p['name'] + tag)
            new.append(f)
        # outward: the slab is closed; fix its winding by signed volume
        vol = 0.0
        for f in new:
            cs = [v.co for v in f.verts]
            for i in range(1, len(cs) - 1):
                vol += cs[0].dot(cs[i].cross(cs[i + 1]))
        if vol < 0:
            bmesh.ops.reverse_faces(bm, faces=new)
        for f in new:
            f.normal_update()
        for e in {e for f in new for e in f.edges}:
            if len(e.link_faces) == 2 and e.link_faces[0].normal.dot(e.link_faces[1].normal) < 0.5:
                e.smooth = False

    def well_gap(self):
        return self.dy - self.sole_y

    # ── UV atlas layout (metres → UV), one 2048² atlas shared by both hull slots ─
    def uv_layout(self):
        if getattr(self, '_layout', None) is None:
            self._layout = UVLayout(self)
        return self._layout


def _inset(pts, d):
    """offset a CCW closed (x, y) polygon inward by d along averaged edge normals"""
    if d <= 0:
        return pts
    n = len(pts)
    out = []
    for i in range(n):
        _, x0, y0 = pts[i - 1]
        name, x1, y1 = pts[i]
        _, x2, y2 = pts[(i + 1) % n]
        ex, ey = x2 - x0, y2 - y0
        ln = math.hypot(ex, ey) or 1.0
        nx, ny = ey / ln, -ex / ln   # outward for CCW
        out.append((name, x1 - nx * d, y1 - ny * d))
    return out


class UVLayout:
    """Deterministic atlas: rows of islands in metres, one scale (texel density) for all of them.
       row 0 shell port, row 1 shell starboard, row 2 deck plan, row 3 well unroll + transom + plates.
       The glyph strip of the number (mask texture only) lives over the deck row: M_NonSlip never samples the mask."""

    MARGIN = 0.06

    def __init__(self, H):
        self.H = H
        L = H.stem_z
        dy = H.dy
        m = self.MARGIN
        # extents (metres), measured on a coarse sweep of the LOD0 rings
        g_max = 0.0
        x_max = 0.0
        gw_min, gw_max = 0.0, 0.0
        for (z, kind, _) in H.station_list():
            pts = H.ring(z, kind)
            girth = [0.0]
            for j in range(len(pts) - 1):
                a, b = pts[j], pts[j + 1]
                girth.append(girth[-1] + math.hypot(b[1] - a[1], b[2] - a[2]))
            i_top = next(j for j, p in enumerate(pts) if p[0] == 'top')
            i_e2 = next(j for j, p in enumerate(pts) if p[0] == 'edge_e2')
            g_max = max(g_max, girth[i_e2])
            x_max = max(x_max, max(abs(p[1]) for p in pts))
            if kind == 'well':
                i_lip = next(j for j, p in enumerate(pts) if p[0] == 'lip0')
                gw_min = min(gw_min, girth[i_lip] - girth[i_top])
        gw_max = -gw_min
        self.g_max = g_max
        well_u0 = H.well_aft - 0.02
        well_u1 = H.well_fwd_end + 0.02 + 2 * H.well_gap()
        tw = 2 * (H.at(0.0)['chineHalfBeam'] + 0.2)
        th = dy + 0.02
        plates = {}
        for p in H.plates:
            ys = [H.plate_outline(p, p['z0'], f) for f in (0.0, 1.0)] + [H.plate_outline(p, p['z1'], f) for f in (0.0, 1.0)]
            plates[p['name']] = (p['z0'] - 0.01, min(ys) - 0.01, p['z1'] - p['z0'] + 0.02, max(ys) - min(ys) + 0.02)
        self.rects = {}
        y = m
        self.rects[ISLAND_SHELL_P] = (m, y, -0.01, 0.0)
        y += g_max + m
        self.rects[ISLAND_SHELL_S] = (m, y, -0.01, 0.0)
        y += g_max + m
        self.rects[ISLAND_DECK] = (m, y, -0.01, -x_max)
        deck_h = 2 * x_max
        self.deck_row = (y, deck_h)
        y += deck_h + m
        self.rects[ISLAND_WELL] = (m, y, well_u0, -gw_max)
        well_w = well_u1 - well_u0
        well_h = 2 * gw_max
        x = m + well_w + m
        self.rects[ISLAND_TRANSOM] = (x, y, -tw / 2, 0.0)
        x += tw + m
        self.plate_rects = {}
        py = y
        for name, (pz, pyy, pw, ph) in plates.items():
            self.plate_rects[name] = (x, py, pz, pyy)
            py += ph + m
        # the slabs' hidden back skins and edge walls get their own (5× smaller) rects: sharing the outer
        # skin's texels would bake the inside surface over it
        bx = x
        for name, (pz, pyy, pw, ph) in plates.items():
            self.plate_rects[name + '#back'] = (bx, py, pz, pyy, 0.2)
            bx += pw * 0.2 + m
        py += max(ph for (_, _, _, ph) in plates.values()) * 0.2 + m
        plate_w = max(pw for (_, _, pw, _) in plates.values())
        width = max(m + (L + 0.01) + m, x + plate_w + m)
        height = max(y + max(well_h, th, py - y) + m, width * 0.0)
        self.S = max(width, height)
        self.extent = (width, height)

    def uv(self, island, u, v, plate=None):
        k = 1.0
        if island == ISLAND_PLATE:
            r = self.plate_rects[plate]
            ox, oy, u0, v0 = r[:4]
            k = r[4] if len(r) > 4 else 1.0
        else:
            ox, oy, u0, v0 = self.rects[island]
        return ((ox + (u - u0) * k) / self.S, (oy + (v - v0) * k) / self.S)

    def glyph_rect(self, mask_size, cells=10):
        """(u0, v0, cell_w, cell_h) in Blender UV of the digit strip over the deck row, cell aspect 2:3"""
        y0, h = self.deck_row
        S = self.S
        px = 1.0 / mask_size
        margin_v = 24 * px
        cell_h = min(h / S - 2 * margin_v, 144 * px)
        cell_w = cell_h * 2.0 / 3.0
        strip_w = cells * cell_w
        u0 = (self.MARGIN + 0.2) / S
        if u0 + strip_w > (self.MARGIN + self.H.stem_z) / S:
            raise RuntimeError('hero hull: glyph strip does not fit over the deck row')
        v0 = y0 / S + (h / S - cell_h) / 2
        return (u0, v0, cell_w, cell_h)


def link_lod(H, lod, contract, materials, parent, sb):
    """Hull_LOD<n>: mesh + [M_Gelcoat, M_NonSlip] + foamTarget, weighted normals (flat panels stay flat,
    the bevel arcs carry the highlight; marked concave roots stay crisp)"""
    name = sb.hull_name(contract, lod)
    mesh = H.build_mesh(lod, name)
    for m in materials:
        mesh.materials.append(m)
    obj = sb.link_mesh_object(name, mesh, parent, lod, {'foamTarget': True})
    mod = obj.modifiers.new('WN', 'WEIGHTED_NORMAL')
    mod.keep_sharp = True
    mod.weight = 50
    mod.mode = 'FACE_AREA'
    sb.apply_modifiers(obj)
    return obj
