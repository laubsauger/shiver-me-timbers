"""
Stage 4 (hair, v2): layered real-time hair strips on a strand-painted atlas.

Atlas (1024², M_PilotHair, two textures):
  T_PilotHair_base  RGB hair albedo (sRGB, hero colour), A coverage (alpha-to-coverage friendly: soft
                    card sides, roots fading in, tips thinning out; no hard slab edge anywhere)
  T_PilotHair_flow  KHR_materials_anisotropy layout: RG strand direction in card space
                    (0.5 + 0.5·dir, card v = root → tip), B anisotropy strength (per strand),
                    A root → tip gradient (the runtime's root occlusion and tip fade)
  Cells: 8 thin strips (~1.1 cm wide in the world), 3 wide base clumps, 3 flyaway wisps, a dense
  cap cell, a bun swirl cell, and the CC0 MakeHuman eyebrow and eyelash textures.

Strands are rasterized in numpy with 2×2 supersampling: each cell is a few sub-clumps whose strands
converge toward their tips, per-strand taper, length, wave and drift, darker roots, sun-bleached
tips, front-to-back order for self-shadowing, and a lateral window so a card has no hard side.

Cards (every card is a tapered strip, 2 tris per segment, facing out of the hair volume):
  cap       the MakeHuman scalp offset 2.5–5 mm, mapped to the dense cap cell (no skin between cards)
  base      wide clumps lying 3–6 mm above the scalp, the silhouette's body
  mid       thin strips in layered clumps, density following the scalp (thicker on the crown)
  flyaway   narrow wisps lifted off the crown and the back: the 80 kn flutter
  fringe    short strips rooted on the feathered hairline, roots transparent (no saw-tooth)
Flow: an 80 kn head wind combs everything straight back, pressed flat on top, falling at the nape,
swept horizontal over the temples; tips lift and curl at the crown. Styles:
  swept   hero: the full stack
  bun     npc_b: hair pulled tight to a knot at the occiput (flat strips converging on it + a bun
          of wrapped strips + a few flyaways at the hairline)
  buzz    npc_c: a clipped buzz cut (cap + short flat tufts)
TEXCOORD_1 = (along card 0 → 1, per-card phase) for the runtime wind sway (root pinned).
Every hair vertex is weighted 100 % to `head_geo` and carries the variant keys (it follows the skull).
"""
import math
import os

import bmesh
import bpy
import numpy as np
from mathutils import Vector

import common as C
import meshops as M
from fit import LOOKS, set_material

SIZE = 1024
CELLS = {}
for i in range(8):
    CELLS[f'strip{i}'] = (i * 96, 0, 96, 512)
for i in range(3):
    CELLS[f'fly{i}'] = (768 + i * 64, 0, 64, 512)
for i in range(3):
    CELLS[f'clump{i}'] = (i * 160, 512, 160, 512)
CELLS['cap'] = (480, 512, 256, 256)
CELLS['bun'] = (736, 512, 256, 256)
CELLS['brow'] = (480, 768, 256, 64)
CELLS['lash'] = (480, 832, 256, 64)
STYLES = ('swept', 'bun', 'buzz')


def cell_uv(name):
    """cell rect -> (u0, v_root, u1, v_tip) in Blender UV space (v up); root at the top of the cell"""
    x, y, w, h = CELLS[name]
    return x / SIZE, 1 - y / SIZE, (x + w) / SIZE, 1 - (y + h) / SIZE


def srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ── strand rasterizer ───────────────────────────────────────────────────────


def _splat(acc, x, y, W, H, wpx, alpha, fields):
    """anti-aliased splat of one strand polyline into the accumulators"""
    cov, wsum = acc['cov'], acc['wsum']
    xi = np.floor(x).astype(int)
    yi = np.floor(y).astype(int)
    r = int(math.ceil(float(wpx.max()) / 2 + 1))
    for ox in range(-r, r + 1):
        for oy in (-1, 0, 1):
            px = xi + ox
            py = yi + oy
            ok = (px >= 0) & (px < W) & (py >= 0) & (py < H)
            if not ok.any():
                continue
            d = np.hypot(px + 0.5 - x, py + 0.5 - y)
            a = np.clip(wpx / 2 + 0.5 - d, 0, 1) * alpha
            m = ok & (a > 0.02)
            if not m.any():
                continue
            pxo, pyo, am = px[m], py[m], a[m]
            prev = cov[pyo, pxo]
            wgt = am * (1 - 0.6 * prev) + 1e-6
            for key, val in fields.items():
                np.add.at(acc[key], (pyo, pxo), (val[m] if hasattr(val, '__len__') else val) * wgt)
            np.add.at(wsum, (pyo, pxo), wgt)
            cov[pyo, pxo] = prev + am * (1 - prev)


def _resolve(acc, w, h, ss):
    has = acc['wsum'] > 0
    for key, empty in (('lum', 0.0), ('fx', 0.0), ('fy', 1.0), ('grad', 0.0), ('ids', 0.0)):
        acc[key][has] /= acc['wsum'][has]
        acc[key][~has] = empty

    def down(a):
        return a.reshape(h, ss, w, ss).mean(axis=(1, 3))
    cov = acc['cov']
    cov_d = down(cov)
    wts = cov_d + 1e-6
    lum, fx, fy, grad, ids = (down(acc[k] * cov) / wts for k in ('lum', 'fx', 'fy', 'grad', 'ids'))
    ln = np.hypot(fx, fy) + 1e-9
    return lum, cov_d, fx / ln, fy / ln, grad, ids


def raster_cell(rng, w, h, n_strands, length, clumps, clumpiness, wave, width_px, spread=0.34, dense=False, ss=2):
    """supersampled strand raster -> lum, coverage, flow dx, flow dy, root->tip gradient, strand id"""
    W, H = w * ss, h * ss
    acc = {k: np.zeros((H, W)) for k in ('cov', 'lum', 'fx', 'fy', 'wsum', 'grad', 'ids')}
    centres = rng.uniform(0.5 - spread, 0.5 + spread, clumps) * W
    for k in range(n_strands):
        c = centres[rng.integers(clumps)]
        x0 = c + rng.normal(0, 0.11 * W)
        y0 = rng.uniform(-0.15 * H, 1.0 * H) if dense else rng.uniform(0.0, 0.1 * H) + abs(rng.normal(0, 0.04 * H))
        L = rng.uniform(*length) * H
        ns = int(max(16, L / 1.5))
        t = np.linspace(0, 1, ns)
        drift = rng.normal(0, 0.04 * W)
        phase = rng.uniform(0, 2 * math.pi)
        freq = rng.uniform(0.5, 1.6)
        tipx = c + rng.normal(0, 0.025 * W)
        x = x0 + (tipx - x0) * clumpiness * t ** 1.5 + drift * t ** 2 + wave * W * np.sin(2 * math.pi * freq * t + phase) * t
        y = y0 + L * t
        dx = np.gradient(x)
        dy = np.gradient(y)
        dl = np.hypot(dx, dy) + 1e-9
        wpx = (width_px * ss) * rng.uniform(0.65, 1.25) * (1 - t) ** 0.6 + 0.45 * ss
        shade = (0.5 + 0.5 * k / n_strands) * rng.uniform(0.8, 1.18)
        tone = shade * (0.62 + 0.62 * t ** 1.4)  # dark roots, sun-bleached tips
        _splat(acc, x, y, W, H, wpx, 1 - 0.55 * t ** 2.2,
               {'lum': tone, 'fx': dx / dl, 'fy': dy / dl, 'grad': t, 'ids': rng.uniform()})
    lum, cov, fx, fy, grad, ids = _resolve(acc, w, h, ss)
    if not dense:
        # no hard card edge: a lateral window and a root fade-in
        u = (np.arange(w) + 0.5) / w
        v = (np.arange(h) + 0.5) / h
        cov = cov * (smooth(0.0, 0.1, u) * smooth(1.0, 0.9, u))[None] * smooth(0.0, 0.08, v)[:, None]
    return lum, cov, fx, fy, grad, ids


def raster_swirl(rng, w, h, n_strands, ss=2):
    """bun cell: strands wound around the cell centre"""
    W, H = w * ss, h * ss
    acc = {k: np.zeros((H, W)) for k in ('cov', 'lum', 'fx', 'fy', 'wsum', 'grad', 'ids')}
    for _k in range(n_strands):
        r0 = rng.uniform(0.1, 0.46) * W
        a0 = rng.uniform(0, 2 * math.pi)
        t = np.linspace(0, 1, 90)
        ang = a0 + rng.uniform(1.2, 3.2) * t
        rr = r0 * (1 - 0.25 * t) + rng.normal(0, 0.01 * W)
        x = W / 2 + rr * np.cos(ang)
        y = H / 2 + rr * np.sin(ang)
        dx, dy = np.gradient(x), np.gradient(y)
        dl = np.hypot(dx, dy) + 1e-9
        tone = rng.uniform(0.55, 1.1) * (0.7 + 0.3 * np.sin(ang * 3) ** 2)
        _splat(acc, x, y, W, H, np.full(len(t), 1.3 * ss), 0.8, {'lum': tone, 'fx': dx / dl, 'fy': dy / dl, 'grad': rr / (W / 2), 'ids': 0.5})
    lum, cov, fx, fy, grad, ids = _resolve(acc, w, h, ss)
    yy, xx = np.mgrid[0:h, 0:w]
    rad = np.hypot(xx + 0.5 - w / 2, yy + 0.5 - h / 2) / (w / 2)
    return lum, cov * smooth(1.0, 0.85, rad), fx, fy, np.clip(rad, 0, 1), ids


def load_mh_texture(path, w, h):
    img = bpy.data.images.load(path, check_existing=False)
    img.scale(w, h)
    px = np.array(img.pixels[:], dtype=np.float64).reshape(h, w, 4)[::-1]
    bpy.data.images.remove(img)
    return px


def build_atlas(cfg, work, user_data):
    rng = np.random.default_rng(2100)
    base = np.zeros((SIZE, SIZE, 4))
    flow = np.zeros((SIZE, SIZE, 4))
    flow[..., 0] = 0.5
    flow[..., 1] = 1.0
    hair = C.hex_lin(cfg['variants']['hero']['hairColor'])
    specs = {}
    for i in range(8):
        # dense, near-parallel strands whose clumps converge to points: an opaque core, strand-y edges
        specs[f'strip{i}'] = dict(n_strands=int(rng.integers(170, 230)), length=(0.62, 0.98), clumps=int(rng.integers(2, 4)),
                                  clumpiness=rng.uniform(0.45, 0.7), wave=rng.uniform(0.004, 0.015), width_px=1.35, spread=0.2)
    for i in range(3):
        specs[f'fly{i}'] = dict(n_strands=int(rng.integers(10, 18)), length=(0.55, 0.98), clumps=2, clumpiness=0.3,
                                wave=rng.uniform(0.04, 0.09), width_px=1.0, spread=0.18)
    for i in range(3):
        specs[f'clump{i}'] = dict(n_strands=int(rng.integers(380, 460)), length=(0.62, 0.98), clumps=int(rng.integers(3, 5)),
                                  clumpiness=rng.uniform(0.55, 0.8), wave=rng.uniform(0.004, 0.015), width_px=1.45, spread=0.28)
    specs['cap'] = dict(n_strands=2600, length=(0.12, 0.3), clumps=30, clumpiness=0.15, wave=0.03, width_px=1.3, dense=True, spread=0.5)
    for name, sp in specs.items():
        x, y, w, h = CELLS[name]
        lum, cov, fx, fy, grad, ids = raster_cell(rng, w, h, **sp)
        gain = 1.3 if name.startswith('strip') or name.startswith('fly') else 1.15  # base clumps sit lower: a shade darker
        if name == 'cap':
            # the undercoat: opaque root-dark hair (never black holes), strands a little lighter on top;
            # the lowest 30 % of the cell fades out, the cap's hairline edge is mapped there
            lum = 0.55 * (1 - cov) + lum * cov
            v = (np.arange(h) + 0.5) / h
            cov = np.ones_like(cov) * smooth(0.9, 0.7, v)[:, None]  # bottom 10 % empty: no bleed from the cell below
            gain = 1.1
        base[y:y + h, x:x + w, :3] = srgb(hair[None, None, :] * lum[..., None] * gain)
        base[y:y + h, x:x + w, 3] = cov
        flow[y:y + h, x:x + w, 0] = 0.5 + 0.5 * fx
        flow[y:y + h, x:x + w, 1] = 0.5 + 0.5 * fy
        flow[y:y + h, x:x + w, 2] = 0.6 + 0.4 * ids
        flow[y:y + h, x:x + w, 3] = grad
    x, y, w, h = CELLS['bun']
    lum, cov, fx, fy, grad, _ids = raster_swirl(rng, w, h, 420)
    base[y:y + h, x:x + w, :3] = srgb(hair[None, None, :] * lum[..., None] * 1.5)
    base[y:y + h, x:x + w, 3] = cov
    flow[y:y + h, x:x + w, 0] = 0.5 + 0.5 * fx
    flow[y:y + h, x:x + w, 1] = 0.5 + 0.5 * fy
    flow[y:y + h, x:x + w, 2] = 0.8
    flow[y:y + h, x:x + w, 3] = grad
    # dilate colour under zero coverage so mips and alpha-to-coverage edges do not pull in black
    for _ in range(8):
        m = base[..., 3] < 0.02
        pad = np.pad(base[..., :3], ((1, 1), (1, 1), (0, 0)), mode='edge')
        avg = (pad[:-2, 1:-1] + pad[2:, 1:-1] + pad[1:-1, :-2] + pad[1:-1, 2:]) / 4
        base[..., :3] = np.where(m[..., None], np.maximum(base[..., :3], avg), base[..., :3])
    for key, cell in (('eyebrowsTexture', 'brow'), ('eyelashesTexture', 'lash')):
        x, y, w, h = CELLS[cell]
        px = load_mh_texture(os.path.join(user_data, cfg['assets']['files'][key]['path']), w, h)
        a = px[..., 3] if px[..., 3].min() < 0.99 else 1 - px[..., :3].mean(axis=2)
        base[y:y + h, x:x + w, :3] = srgb(hair[None, None, :] * (0.55 + 0.6 * px[..., :3].mean(axis=2))[..., None])
        base[y:y + h, x:x + w, 3] = a
        flow[y:y + h, x:x + w] = (0.5, 1.0, 0.8, 0.6)
    save_png(base, os.path.join(work, 'T_PilotHair_base.png'), 'sRGB')
    save_png(flow, os.path.join(work, 'T_PilotHair_flow.png'), 'Non-Color')
    return base


def save_png(arr, path, colorspace):
    h, w, _ = arr.shape
    img = bpy.data.images.new(os.path.basename(path).split('.')[0], w, h, alpha=True)
    img.colorspace_settings.name = colorspace
    img.pixels.foreach_set(np.clip(arr[::-1], 0, 1).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


# ── cards ───────────────────────────────────────────────────────────────────


def head_frame(rig):
    hb = rig.data.bones['head']
    m = np.array(hb.matrix_local)
    up = m[:3, 1]
    fwd = m[:3, 2]  # the head bone's Z points out of the face
    left = np.cross(up, fwd)
    return np.array(hb.head_local), up / np.linalg.norm(up), fwd / np.linalg.norm(fwd), left / np.linalg.norm(left)


class Scalp:
    def __init__(self, skin):
        self.co = C.coords(skin)
        self.tris = M.tris_of(skin)
        self.w = C.group_weights(skin, ['scalp'])
        self.n = M.vertex_normals(self.co, self.tris)
        self.bvh = M.bvh_of([skin])
        # distance along the head surface to the hairline (MakeHuman's scalp group edge)
        self.hairline = M.surface_distance(self.co, M.edges_of(skin), self.w < 0.5)
        from mathutils.kdtree import KDTree
        self.kd = KDTree(len(self.co))
        for i, p in enumerate(self.co):
            self.kd.insert(Vector(p), i)
        self.kd.balance()

    def hairline_dist(self, p):
        return float(self.hairline[self.kd.find(Vector(p))[1]])

    def sample(self, rng, count, feather=False, density=None):
        tw = self.w[self.tris]
        if feather:
            sel = self.tris[(tw.min(axis=1) < 0.5) & (tw.max(axis=1) > 0.5)]
        else:
            sel = self.tris[tw.min(axis=1) > 0.5]
        a, b, c = self.co[sel[:, 0]], self.co[sel[:, 1]], self.co[sel[:, 2]]
        area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
        if density is not None:
            area = area * density((a + b + c) / 3)
        cand = rng.choice(len(sel), size=count, p=area / area.sum())
        u, v = rng.uniform(size=count), rng.uniform(size=count)
        flip = u + v > 1
        u[flip], v[flip] = 1 - u[flip], 1 - v[flip]
        pts = a[cand] + (b[cand] - a[cand]) * u[:, None] + (c[cand] - a[cand]) * v[:, None]
        nrm = self.n[sel[cand, 0]] + self.n[sel[cand, 1]] + self.n[sel[cand, 2]]
        return pts, nrm / np.linalg.norm(nrm, axis=1, keepdims=True)


def poisson(pts, nrm, r_min, cap=None):
    keep = []
    for i, p in enumerate(pts):
        if all(np.linalg.norm(p - pts[j]) >= r_min for j in keep[-500:]):
            keep.append(i)
            if cap and len(keep) >= cap:
                break
    return pts[keep], nrm[keep]


class CardSet:
    def __init__(self):
        self.verts, self.faces, self.uvs, self.uv2, self.nrm = [], [], [], [], []

    def strip(self, path, side_axes, widths, cell, rng, root_normal=None):
        u0, vr, u1, vt = cell_uv(cell)
        if rng.uniform() < 0.5:
            u0, u1 = u1, u0
        base = len(self.verts)
        phase = rng.uniform()
        n = len(path)
        for k, q in enumerate(path):
            t = k / (n - 1)
            hw = widths[k] / 2
            for sgn, uu in ((-1, u0), (1, u1)):
                # the UV keeps the full cell width at every ring: the taper is geometric, so the strands
                # converge with the card instead of being cropped
                self.verts.append(q + side_axes[k] * hw * sgn)
                self.uvs.append((uu, vr + (vt - vr) * t))
                self.uv2.append((t, phase))
                self.nrm.append(root_normal)
        for k in range(n - 1):
            a = base + 2 * k
            self.faces.append((a, a + 1, a + 3, a + 2))


def unit(v):
    return v / max(np.linalg.norm(v), 1e-12)


def comb_dir(p, n, origin, up, fwd, left, style, knot=None):
    rel = p - origin
    back = np.clip((-(rel @ fwd)) / 0.08, -1, 1)
    side = rel @ left
    if style == 'bun' and knot is not None:
        d = knot - p
    else:
        # 80 kn head wind: straight back, pressed down at the back of the skull, horizontal over the temples
        d = -fwd * 1.0 - up * (0.1 + 0.75 * max(back, 0) ** 1.6) + left * np.sign(side) * 0.12 * min(abs(side) / 0.08, 1)
        # over the forehead "back" is into the skull: comb up and over instead of down the brow
        d = d + up * 1.1 * max(0.0, 0.2 - back)
    d = d - (d @ n) * n
    return d / max(np.linalg.norm(d), 1e-9)


def grow(scalp, p, n, d, length, segs, lift_deg, press, curl_deg, rng, noise, min_h):
    """a strand path from p: leaves the scalp at lift_deg, bends back onto the skull (press) and curls its
    tip up (curl_deg); every point stays min_h[segment] outside the scalp"""
    path = [p - n * 0.0005]  # rooted on the scalp surface
    lift = math.radians(lift_deg)
    dirv = d * math.cos(lift) + n * math.sin(lift)
    for s in range(segs):
        t = (s + 1) / segs
        dirv = dirv + rng.normal(0, noise, 3) + d * 0.2 - n * press * (1 - t)
        if t > 0.55:
            dirv = dirv + n * math.sin(math.radians(curl_deg)) * (t - 0.55) * 2.2
        dirv /= np.linalg.norm(dirv)
        q = path[-1] + dirv * (length / segs)
        loc, _nn, _i, _dist = scalp.bvh.find_nearest(Vector(q))
        if loc is not None and (q - np.array(loc)) @ n < min_h[s]:
            q = np.array(loc) + n * min_h[s]
        path.append(q)
    return np.array(path)


def card_axes(path, n, rolls):
    axes = []
    for k in range(len(path)):
        tng = path[min(k + 1, len(path) - 1)] - path[max(k - 1, 0)]
        tng /= max(np.linalg.norm(tng), 1e-9)
        sa = np.cross(n, tng)
        sa /= max(np.linalg.norm(sa), 1e-9)
        r = math.radians(rolls[k])
        axes.append(sa * math.cos(r) + n * math.sin(r))
    return axes


def build_cards(skin, rig, style, rng, report):
    origin, up, fwd, left = head_frame(rig)
    scalp = Scalp(skin)
    cs = CardSet()
    # the bun sits high on the back of the crown (reads from the front and the chase cam): the scalp
    # point furthest along up-and-back, lifted off the skull by the knot's own radius
    dirk = unit(up * 0.75 - fwd * 0.65)
    ks = int(np.argmax((scalp.co - origin) @ dirk))
    knot = scalp.co[ks] + dirk * 0.02

    def density(c):
        top = np.clip(((c - origin) @ up - 0.04) / 0.08, 0, 1)
        return 0.55 + 0.45 * top  # thicker on the crown, thinning toward the hairline and nape

    def layer(name, count, r_min, length, width, segs, lift, press, curl, roll, cells, min_h, feather=False, taper=0.3):
        pts, nrm = scalp.sample(rng, count * 6, feather=feather, density=density)
        pts, nrm = poisson(pts, nrm, r_min, cap=count)
        for p, n in zip(pts, nrm):
            rel = p - origin
            back = float(np.clip((-(rel @ fwd)) / 0.08, -1, 1))
            crown = math.exp(-((back - 0.2) / 0.4) ** 2) * float(rel @ up > 0.06)
            d = comb_dir(p, n, origin, up, fwd, left, style, knot)
            if feather:
                p = p + d * 0.008  # hairline strips root just behind the hairline: the cap, not a root, meets the skin
            L = rng.uniform(*length)
            if style == 'bun':
                L = min(L, max(np.linalg.norm(knot - p) * 1.05, 0.02))
            # within ~3.5 cm of the hairline the hair lies on the skull: roots on the surface, lift and
            # stand-off fade to a quarter, so the hairline meets the skin instead of hovering over it
            hk = float(np.clip(scalp.hairline_dist(p) / 0.035, 0.25, 1.0))
            lf = rng.uniform(*lift) * (1.3 if back < -0.5 else 1.0) * hk
            mh = [m * (0.35 + 0.65 * hk) for m in min_h]
            path = grow(scalp, p, n, d, L, segs, lf, press, rng.uniform(*curl) * crown * hk, rng, 0.08 * hk, mh)
            wd = rng.uniform(*width)
            widths = [wd * (1 - (1 - taper) * (k / segs) ** 1.2) for k in range(segs + 1)]
            rolls = [rng.normal(0, roll) * (0.4 + 0.6 * k / segs) for k in range(segs + 1)]
            cs.strip(path, card_axes(path, n, rolls), widths, cells[int(rng.integers(len(cells)))], rng, n)
        report[f'{style}.{name}'] = len(pts)

    strips = [f'strip{i}' for i in range(8)]
    clumps = [f'clump{i}' for i in range(3)]
    flies = [f'fly{i}' for i in range(3)]
    if style == 'swept':
        layer('base', 120, 0.018, (0.055, 0.078), (0.024, 0.03), 4, (2, 6), 0.1, (0, 8), 8, clumps, [0.003, 0.004, 0.005, 0.005], taper=0.45)
        layer('mid', 225, 0.0108, (0.05, 0.085), (0.013, 0.017), 4, (2, 6), 0.22, (0, 10), 14, strips, [0.005, 0.007, 0.008, 0.009], taper=0.7)
        layer('fringe', 40, 0.011, (0.03, 0.045), (0.011, 0.014), 3, (3, 8), 0.1, (0, 0), 10, strips, [0.003, 0.005, 0.006], feather=True, taper=0.7)
        layer('flyaway', 34, 0.02, (0.05, 0.08), (0.004, 0.006), 3, (10, 22), 0.03, (12, 28), 40, flies, [0.008, 0.012, 0.015], taper=0.35)
    elif style == 'bun':
        layer('pulled', 150, 0.014, (0.06, 0.12), (0.012, 0.018), 4, (0, 3), 0.18, (0, 0), 6, strips + clumps[:1], [0.0025, 0.003, 0.0035, 0.004], taper=0.4)
        layer('flyaway', 12, 0.02, (0.03, 0.05), (0.004, 0.006), 3, (2, 8), 0.1, (0, 6), 25, flies, [0.003, 0.005, 0.006], feather=True, taper=0.35)
        # the knot: strips wrapped around a flattened sphere on the crown
        n_knot = 0
        for ring in range(4):
            rr = 0.036 - ring * 0.007
            for j in range(12 - ring * 2):
                a0 = j / (12 - ring * 2) * 2 * math.pi + ring * 0.4
                pts = []
                for k in range(4):
                    a = a0 + k * 0.55
                    axis_b = unit(up * 0.8 - fwd * 0.6)
                    e1 = left
                    e2 = unit(np.cross(axis_b, e1))
                    v = e1 * math.cos(a) * rr + e2 * math.sin(a) * rr
                    out = axis_b * (0.006 + 0.028 * (ring / 3)) * (0.7 + 0.3 * math.cos(a - a0 - 0.8))
                    pts.append(knot + v + out)
                pts = np.array(pts)
                cs.strip(pts, card_axes(pts, unit(up * 0.8 - fwd * 0.6), [8.0] * 4), [0.022 - ring * 0.003] * 4, 'bun', rng, unit(pts[1] - knot))
                n_knot += 1
        report['bun.knot'] = n_knot
    elif style == 'buzz':
        layer('tuft', 230, 0.0105, (0.012, 0.022), (0.012, 0.016), 2, (4, 12), 0.1, (0, 0), 14, strips, [0.0025, 0.0035], taper=0.6)
    return np.array(cs.verts), cs.faces, cs.uvs, cs.uv2, np.array(cs.nrm)


def press_under_strap(ob):
    """the goggle strap compresses the hair: card vertices within the band and outside its inner face
    are pushed 1.5 mm under it (the strap's `goggle_strap` faces on the Goggles mesh)"""
    gog = bpy.data.objects.get('Goggles')
    if gog is None:
        return 0
    from mathutils.bvhtree import BVHTree
    gco = C.coords(gog)
    looks = np.empty(len(gog.data.polygons), dtype=np.int32)
    gog.data.attributes['look'].data.foreach_get('value', looks)
    polys = [tuple(p.vertices) for p in gog.data.polygons if looks[p.index] == LOOKS['goggle_strap']]
    if not polys:
        return 0
    bvh = BVHTree.FromPolygons([tuple(map(float, v)) for v in gco], polys)
    centre = gco[np.unique(np.concatenate([np.array(p) for p in polys]))].mean(axis=0)
    co = C.coords(ob)
    moved = 0
    for i, p in enumerate(co):
        d = p - centre
        r = np.linalg.norm(d)
        if r < 1e-6:
            continue
        hit = bvh.ray_cast(Vector(centre), Vector(d / r), r + 0.03)[0]
        if hit is None:
            continue
        r_in = np.linalg.norm(np.array(hit) - centre)  # the strap's inner face along this ray
        if r > r_in - 0.0015:
            co[i] = centre + d / r * (r_in - 0.0015)
            moved += 1
    C.set_coords(ob, co)
    return moved


def build_shell(skin, name):
    w = C.group_weights(skin, ['scalp'])
    fm = M.face_mask_from_verts(skin, w > 0.6, 'all')
    shell = M.subset_copy(skin, fm, name)
    co = C.coords(shell)
    tris = M.tris_of(shell)
    ww = C.group_weights(shell, ['scalp'])
    n = M.vertex_normals(co, tris)
    # the cap lies on the scalp at the hairline and rises to 3 mm (under the strips) 2.5 cm inside it
    hl = M.surface_distance(co, M.edges_of(shell), M.boundary_verts(shell))
    C.set_coords(shell, co + n * (0.0004 + 0.0026 * np.clip(hl / 0.025, 0, 1))[:, None])
    if shell.data.shape_keys:
        shell.shape_key_clear()
    # planar UV into the cap cell (head seen from above); vertices near the cap's edge (scalp weight
    # falling off) slide into the cell's fade band, so the cap meets the skin without a shelf
    u0, v0, u1, v1 = cell_uv('cap')
    co = C.coords(shell)
    mn, mx = co.min(axis=0), co.max(axis=0)
    # MakeHuman's scalp weights are hard 0/1: the feather comes from the distance to the cap's
    # boundary along its surface (Dijkstra over edges), fading over the last 14 mm
    dist = M.surface_distance(co, M.edges_of(shell), M.boundary_verts(shell))
    edge = np.clip(1.0 - dist / 0.014, 0, 1)
    me = shell.data
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    uv = me.uv_layers.new(name='UVMap')
    loops = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get('vertex_index', loops)
    p = co[loops]
    su = (p[:, 0] - mn[0]) / max(mx[0] - mn[0], 1e-6)
    sv = (p[:, 1] - mn[1]) / max(mx[1] - mn[1], 1e-6) * 0.68 + 0.02
    sv = sv * (1 - edge[loops]) + (0.72 + 0.16 * edge[loops]) * edge[loops]
    arr = np.stack([u0 + su * (u1 - u0), v0 + sv * (v1 - v0)], axis=1)
    uv.data.foreach_set('uv', arr.astype(np.float32).ravel())
    return shell


def finish_hair_object(ob, skin, rig):
    for g in list(ob.vertex_groups):
        ob.vertex_groups.remove(g)
    M.rigid_weights(ob, 'head_geo')
    set_material(ob, 'M_PilotHair')
    attr = ob.data.attributes.get('look') or ob.data.attributes.new('look', 'INT', 'FACE')
    attr.data.foreach_set('value', np.full(len(ob.data.polygons), LOOKS['hair'], dtype=np.int32))
    M.transfer_variant_keys(skin, ob)
    ob.parent = rig
    for m in list(ob.modifiers):
        ob.modifiers.remove(m)
    ob.modifiers.new('Armature', 'ARMATURE').object = rig


def remap_uv(ob, cell):
    u0, vr, u1, vt = cell_uv(cell)
    me = ob.data
    uv = me.uv_layers.active
    arr = np.empty(len(uv.data) * 2)
    uv.data.foreach_get('uv', arr)
    arr = arr.reshape(-1, 2)
    arr[:, 0] = u0 + np.clip(arr[:, 0], 0, 1) * (u1 - u0)
    arr[:, 1] = vt + np.clip(arr[:, 1], 0, 1) * (vr - vt)
    uv.data.foreach_set('uv', arr.ravel())
    uv.name = 'UVMap'


def run(cfg, work, args):
    rep = C.load(work, 'stage_rig')
    import body
    user_data, _t = body.enable_mpfb(cfg)
    build_atlas(cfg, work, user_data)
    rig = bpy.data.objects['PilotRig']
    skin = bpy.data.objects['ScalpSrc']  # the full scalp (the rendered Skin has it cut away under the cap)
    out = {}
    counts = {}
    for style, seed in (('swept', 7), ('bun', 11), ('buzz', 13)):
        rng = np.random.default_rng(seed)
        v, f, uvs, uv2, root_n = build_cards(skin, rig, style, rng, counts)
        name = f'Hair_{style}'
        ob = C.mesh_object(name, v, f)
        me = ob.data
        uv = me.uv_layers.new(name='UVMap')
        uvw = me.uv_layers.new(name='UVWind')
        loops = np.empty(len(me.loops), dtype=np.int64)
        me.loops.foreach_get('vertex_index', loops)
        uv.data.foreach_set('uv', np.asarray(uvs, dtype=np.float32)[loops].ravel())
        uvw.data.foreach_set('uv', np.asarray(uv2, dtype=np.float32)[loops].ravel())
        M.shade_smooth(ob)
        # every card faces out of the hair volume (consistent winding), so one-sided lighting and
        # back-face normal flips agree across cards
        origin, hup, _f, _l = head_frame(rig)
        centre = origin + hup * 0.075
        bm = bmesh.new()
        bm.from_mesh(me)
        flip = [fc for fc in bm.faces if fc.normal.dot(fc.calc_center_median() - Vector(centre)) < 0]
        bmesh.ops.reverse_faces(bm, faces=flip, flip_multires=False)
        bm.to_mesh(me)
        bm.free()
        # shading normals lean 70 % toward the scalp normal under each card: the strips shade as one
        # volume instead of flat splinters. Every card faces out of the volume (winding above), so a
        # double-sided runtime shows front faces from outside the head
        me.update()
        geo_n = np.array([list(vv.normal) for vv in me.vertices])
        blend = root_n * 0.7 + geo_n * 0.3
        blend /= np.linalg.norm(blend, axis=1, keepdims=True)
        me.normals_split_custom_set_from_vertices([tuple(map(float, x)) for x in blend])
        pressed = press_under_strap(ob)
        counts[f'{style}.pressedUnderStrap'] = pressed
        ob['hairStyle'] = style
        finish_hair_object(ob, skin, rig)
        out[name] = C.tri_count(ob)
    shell = build_shell(skin, 'HairCap')
    shell.data.uv_layers.new(name='UVWind')
    finish_hair_object(shell, skin, rig)
    out['HairCap'] = C.tri_count(shell)
    for ob, cell in ((bpy.data.objects['Brows'], 'brow'), (bpy.data.objects['Lashes'], 'lash')):
        remap_uv(ob, cell)
        if 'UVWind' not in ob.data.uv_layers:
            ob.data.uv_layers.new(name='UVWind')
    bpy.data.objects.remove(skin, do_unlink=True)
    rep['hair'] = {'tris': out, 'cards': counts}
    print(f'[pilot] hair: {out} cards {counts}')
    C.save(work, 'stage_hair', rep)
