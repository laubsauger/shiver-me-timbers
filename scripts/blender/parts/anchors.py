"""
Named sockets for the hero parts, derived from the hull JSON (never typed in).

Input is the scripts/blender/hullOffsets.ts dump (spec, renderOnly, engines, 241 stations). Every
socket is returned in the three.js BODY frame (metres, +Y up, bow +Z, origin at the CG), the frame
the GLB is authored in. Port is +X (facing the bow along +Z with +Y up, starboard is -X).

When the physics agent changes deepV12.hull.json, the sheer, transom, engine mounts, prop points,
arch and seat stations here move with it on the next build. Numbers the JSON does not carry yet
(cockpit well, eye, dash, windscreen) come from manifest.json `anchorsNotInHullJson`, each with its
source.
"""
import math


def _interp(stations, key, z):
    n = len(stations)
    L = stations[-1]['z']
    if z <= 0:
        return stations[0][key]
    if z >= L:
        return stations[-1][key]
    t = z / L * (n - 1)
    j = min(int(t), n - 2)
    a, b = stations[j], stations[j + 1]
    f = (z - a['z']) / max(b['z'] - a['z'], 1e-9)
    return a[key] * (1 - f) + b[key] * f


class Anchors:
    def __init__(self, hull, manifest):
        spec = hull['spec']
        self.hull = hull
        self.spec = spec
        self.ro = hull.get('renderOnly') or {}
        self.extra = manifest['anchorsNotInHullJson']
        self.L = spec['length']
        self.lcg = spec['lcgFromTransom']
        self.vcg = spec['vcgAboveKeel']
        self.stations = hull['stations']
        self.flare = math.radians(self.ro.get('topsideFlareDeg', 0.0))
        self.flare_start = self.ro.get('topsideFlareStartAboveChine', 0.0)

    # ── hull frame → body frame ─────────────────────────────────────────────
    def body(self, x, y_hull, z_hull):
        return (x, y_hull - self.vcg, z_hull - self.lcg)

    def z_body(self, z_hull):
        return z_hull - self.lcg

    def y_body(self, y_hull):
        return y_hull - self.vcg

    # ── deck shape (§T.192): camber + aft taper, render-only; the centreline stays on the proxy deck ──
    def deck_drop(self, x, z_hull):
        """how far the deck surface lies below the proxy deck height at (x, hull z), m (≥ 0)"""
        d = self.extra.get('deckShape')
        if not d:
            return 0.0
        u = min(abs(x) / d['crownHalfBeam'], 1.15)
        crown = d['crownAtSheer'] * u * u
        t = min(max(1.0 - z_hull / d['aftTaperLength'], 0.0), 1.0)
        aft = d['aftDrop'] * t * t * (3 - 2 * t)
        return crown + aft

    def deck_surface_y(self, x, z_body):
        """body-frame height of the deck surface at (x, body z): where a part standing on the deck must sit"""
        return self.deck_y - self.deck_drop(x, z_body + self.lcg)

    # ── hull shape queries (hull frame in, body frame out where noted) ─────
    def deck_y_hull(self, z_hull):
        return _interp(self.stations, 'deckY', z_hull)

    def chine_half(self, z_hull):
        return _interp(self.stations, 'chineHalfBeam', z_hull)

    def chine_y_hull(self, z_hull):
        return _interp(self.stations, 'chineY', z_hull)

    def sheer_half(self, z_hull):
        """half-beam at the sheer: chine half-beam + the render-only flare over the top of the topside"""
        b = self.chine_half(z_hull)
        h = max(0.0, self.deck_y_hull(z_hull) - self.chine_y_hull(z_hull) - self.flare_start)
        return b + h * math.tan(self.flare)

    def topside_half_at(self, z_hull, y_hull):
        """half-beam of the topside at height y (hull frame): vertical up to the flare start, then flared"""
        b = self.chine_half(z_hull)
        yc = self.chine_y_hull(z_hull) + self.flare_start
        return b + max(0.0, y_hull - yc) * math.tan(self.flare)

    def sheer_polyline(self, side=1, z_from=0.0, stride=4):
        """deck-edge points (body frame) at the JSON stations, honouring the raked stem (deckZ)"""
        out = []
        st = self.stations
        idx = list(range(0, len(st), stride))
        if idx[-1] != len(st) - 1:
            idx.append(len(st) - 1)
        for i in idx:
            s = st[i]
            if s['z'] < z_from:
                continue
            h = max(0.0, s['deckY'] - s['chineY'] - self.flare_start)
            half = s['deckHalfBeam'] + h * math.tan(self.flare)
            zd = s.get('deckZ', s['z'])
            out.append(self.body(side * half, s['deckY'] - self.deck_drop(half, zd), zd))
        return out

    def sheer_point(self, z_hull, side=1):
        half = self.sheer_half(z_hull)
        return self.body(side * half, self.deck_y_hull(z_hull) - self.deck_drop(half, z_hull), z_hull)

    # ── sockets ─────────────────────────────────────────────────────────────
    @property
    def deck_y(self):
        return self.y_body(self.deck_y_hull(0.0))

    def transom(self):
        return {
            'z': self.z_body(0.0),
            'topY': self.deck_y,
            'halfBeamTop': self.sheer_half(0.0),
            'chineHalf': self.chine_half(0.0),
            'chineY': self.y_body(self.chine_y_hull(0.0)),
            'keelY': self.y_body(0.0),
        }

    def engines(self):
        """Per-engine sockets, ordered starboard → port by x. id P (+x) / C / S (-x)."""
        src = self.hull.get('engines')
        if not src:
            raise SystemExit('[parts] hull JSON has no `engines` block (mount + prop points); rerun hullOffsets.ts')
        ox = self.extra['outboard']
        out = []
        for e in sorted(src, key=lambda e: e['mountX']):
            x = e['mountX']
            eid = 'C' if abs(x) < 1e-6 else ('P' if x > 0 else 'S')
            pp = e['propPoint']
            prop_y = self.y_body(pp['yAboveKeel'])
            cav_y = prop_y + ox['cavPlateAboveProp']
            out.append({
                'id': eid,
                'x': x,
                'mountZ': self.z_body(e['mountZFromTransom']),
                'propX': pp['x'],
                'propY': prop_y,
                'propZ': self.z_body(pp['zFromTransom']),
                'propR': self.spec['propRadius'],
                'cavPlateY': cav_y,
                'clampTopY': cav_y + ox['shaftLength'],
                'model': e.get('model', '?'),
                # counter-rotation: port and centre right-hand, starboard left-hand
                'handed': -1 if eid == 'S' else 1,
            })
        return out

    def engine(self, eid):
        for e in self.engines():
            if e['id'] == eid:
                return e
        raise KeyError(eid)

    def seat(self):
        s = (self.ro.get('cockpit') or {}).get('seats') or [{'x': 0.0, 'zFromTransom': 4.6}]
        z_h = s[0]['zFromTransom']
        return {'x': s[0]['x'], 'z': self.z_body(z_h), 'zHull': z_h, 'soleY': self.deck_y - self.extra['cockpitWell']['soleBelowSheer']}

    def _helm_hull(self):
        h = self.extra['helm']
        sz = self.seat()['zHull']
        return {
            'eye': sz + h['eyeAheadOfSeat'],
            'dashAft': sz + h['dashAftOfSeat'],
            'dashFwd': sz + h['dashFwdOfSeat'],
            'screenCentre': sz + h['screenBaseCentreOfSeat'],
            'screenSide': sz + h['screenBaseSideOfSeat'],
        }

    def cockpit_well(self):
        w = self.extra['cockpitWell']
        jc = (self.ro.get('cockpit') or {}).get('zFromTransom')
        if jc:  # the JSON carries the well station range since the 55–80 % decision
            z_aft, z_fwd = float(jc[0]), float(jc[1])
        else:
            z_aft = self.L * (1 - w['aftFromBow'])
            z_fwd = self.L * (1 - w['fwdFromBow'])
        helm = self._helm_hull()
        seat_z = self.seat()['zHull']
        grown = []
        if helm['dashFwd'] > z_fwd:
            grown.append(f"fwd {z_fwd:.2f}→{helm['dashFwd']:.2f}")
            z_fwd = helm['dashFwd']
        if seat_z - 0.55 < z_aft:
            grown.append(f"aft {z_aft:.2f}→{seat_z - 0.55:.2f}")
            z_aft = seat_z - 0.55
        if grown:
            print(f"[parts] WARNING: JSON seat z {seat_z:.2f} sits outside the {w['aftFromBow']:.0%}–{w['fwdFromBow']:.0%} "
                  f"cockpit; well grown ({', '.join(grown)}) — expect the physics seat/arch update")
        return {
            'zAft': self.z_body(z_aft),
            'zFwd': self.z_body(z_fwd),
            'halfWidth': w['width'] / 2,
            'soleY': self.deck_y - w['soleBelowSheer'],
        }

    def arch(self):
        a = (self.ro.get('cockpit') or {}).get('rollArch') or {'zFromTransom': 4.2, 'heightAboveDeck': 0.9}
        z_h = a['zFromTransom']
        return {
            'z': self.z_body(z_h),
            'zHull': z_h,
            'topY': self.deck_y + a['heightAboveDeck'],
            'deckY': self.deck_y,
            'sheerHalf': self.sheer_half(z_h),
            'antennaLength': self.extra['antenna']['length'],
        }

    def pan_top(self):
        """seat pan top centre (body frame): the pilot frame's origin (pilot-log v2)"""
        s = self.seat()
        return (s['x'], s['soleY'] + self.extra['seat']['panAboveSole'], s['z'])

    def wheel_hub(self):
        """§T.192 ergonomics: the wheel hub relative to the pan top (manifest helm, pilot-log v2 blocker)"""
        h = self.extra['helm']
        x, y, z = self.pan_top()
        return (x, y + h['wheelHubAbovePan'], z + h['wheelHubAheadOfSeat'])

    def throttle_handle(self):
        """§T.192 ergonomics: the middle throttle handle at idle, on the pilot's right (−x), at forearm-rest height"""
        h = self.extra['helm']
        x, y, z = self.pan_top()
        return (x - h['throttleHandleOutboard'], y + h['throttleHandleAbovePan'], z + h['throttleHandleAheadOfSeat'])

    def eye(self):
        h = self.extra['helm']
        return (0.0, self.deck_y + h['eyeAboveSheer'], self.z_body(self._helm_hull()['eye']))

    def dash(self):
        h = self._helm_hull()
        return {'zAft': self.z_body(h['dashAft']), 'zFwd': self.z_body(h['dashFwd']),
                'topY': self.deck_y - self.extra['helm']['dashTopBelowSheer'], 'halfWidth': self.extra['cockpitWell']['width'] / 2}

    def windscreen(self):
        h = self.extra['helm']
        hh = self._helm_hull()
        return {
            'zBaseCentre': self.z_body(hh['screenCentre']),
            'zBaseSide': self.z_body(hh['screenSide']),
            'height': h['screenHeight'],
            'rake': math.radians(h['screenRakeDeg']),
            'halfWidth': self.extra['cockpitWell']['width'] / 2 + 0.12,
            'baseY': self.deck_y,
        }

    def summary(self):
        """what the build prints and the root extras carry, so a hull change is visible in the log"""
        t = self.transom()
        return {
            'transomZ': round(t['z'], 4),
            'deckY': round(self.deck_y, 4),
            'sheerHalfTransom': round(t['halfBeamTop'], 4),
            'engines': [(e['id'], round(e['x'], 3), round(e['mountZ'], 3), round(e['propY'], 3), round(e['propZ'], 3)) for e in self.engines()],
            'archZ': round(self.arch()['z'], 3),
            'seatZ': round(self.seat()['z'], 3),
            'eye': tuple(round(v, 3) for v in self.eye()),
        }
