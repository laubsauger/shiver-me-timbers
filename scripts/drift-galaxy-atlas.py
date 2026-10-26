"""
The Drift's galaxy atlas (src/drift/getTheDrift/galaxies.ts): real galaxies from the Hubble archive
(NASA / ESA, public domain and CC BY), each isolated into a 512 px tile of one atlas so the field shows
real variety — grand-design and flocculent spirals, bars, edge-on dust lanes, ellipticals, irregulars,
interacting pairs — instead of one procedural shape copied.

Per image: the sky background subtracted (the median of the frame's border), the galaxy found (the peak of a
heavy blur, near the centre) and measured (where the blurred light falls to a few percent of its peak),
compact foreground stars removed outside the core (bright points standing well above their surroundings,
filled from a wider median), cropped square about the galaxy, faded to black at its edge, its brightest
part normalised to 1.

  out/drift/data/.venv/bin/python -I scripts/drift-galaxy-atlas.py out/drift/data/raw/galaxies public/drift/galaxies
"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None
RAW = Path(sys.argv[1])
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

TILE = 512
COLS, ROWS = 8, 4
# frames that do not isolate: a bright star across the galaxy, a tiny galaxy in a star field, a galaxy that
# fills the whole frame, a noisy background
SKIP = {'edge-on-galaxy-ngc-4289-2009-06-2473.jpg', 'interacting-galaxies-arp-274-2009-06-2467.jpg', 'potw2011a-cotton-wool-galaxy.jpg',
        'irregular-galaxy-ngc-1427a-captured-by-the-hubble-space-tele.jpg', 'glitter-galaxy-an-edge-on-view-of-the-eso-318-13-galaxy.jpg'}
# kinds drawn on a plane of their own in space (seen at their own inclination); the others are billboards
PLANAR = {'spiral', 'barred', 'irregular'}

srgb_to_lin = lambda c: np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
lin_to_srgb = lambda c: np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 0), 1 / 2.4) - 0.055)


def isolate(img: Image.Image) -> np.ndarray:
    a = srgb_to_lin(np.asarray(img.convert('RGB')).astype(np.float32) / 255)
    h, w, _ = a.shape
    b = max(4, min(h, w) // 20)
    border = np.concatenate([a[:b].reshape(-1, 3), a[-b:].reshape(-1, 3), a[:, :b].reshape(-1, 3), a[:, -b:].reshape(-1, 3)])
    a = np.maximum(a - np.median(border, axis=0), 0)
    lum = a @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    # the galaxy: the peak of a heavy blur, searched in the middle 60 % of the frame
    small = Image.fromarray(np.clip(lum / max(lum.max(), 1e-6) * 255, 0, 255).astype(np.uint8))
    blur = np.asarray(small.filter(ImageFilter.GaussianBlur(min(h, w) / 30))).astype(np.float32)
    m = np.zeros_like(blur)
    m[int(h * 0.2):int(h * 0.8), int(w * 0.2):int(w * 0.8)] = 1
    cy, cx = np.unravel_index(np.argmax(blur * m), blur.shape)
    # its extent: where the blurred light falls below 1.2 % of the peak along 16 rays (the upper quartile),
    # with room to spare: the faint outskirts must fade out inside the tile, not be cut by it
    ray = []
    peak = blur[cy, cx]
    for ang in np.linspace(0, 2 * np.pi, 16, endpoint=False):
        r = 0
        rmax = int(min(cx, cy, w - 1 - cx, h - 1 - cy))
        for r in range(4, rmax, 2):
            if blur[int(cy + np.sin(ang) * r), int(cx + np.cos(ang) * r)] < 0.012 * peak:
                break
        ray.append(r)
    R = int(min(np.percentile(ray, 75) * 1.4, cx, cy, w - 1 - cx, h - 1 - cy))
    crop = a[cy - R:cy + R, cx - R:cx + R]
    tile = np.asarray(Image.fromarray(np.clip(lin_to_srgb(crop / max(crop.max(), 1e-6)) * 255, 0, 255).astype(np.uint8)).resize((TILE, TILE), Image.LANCZOS)).astype(np.float32) / 255
    t = srgb_to_lin(tile)
    tl = t @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    yy, xx = np.mgrid[0:TILE, 0:TILE]
    rr = np.hypot(xx - TILE / 2 + 0.5, yy - TILE / 2 + 0.5) / (TILE / 2)
    # foreground stars: compact points well above a 9 px median, outside the core, filled from a 21 px median
    L8 = Image.fromarray(np.clip(lin_to_srgb(tl) * 255, 0, 255).astype(np.uint8))
    med = srgb_to_lin(np.asarray(L8.filter(ImageFilter.MedianFilter(9))).astype(np.float32) / 255)
    star = (tl - med > np.maximum(0.06, med * 1.5)) & (rr > 0.3)
    star = np.asarray(Image.fromarray(star.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(7))) > 0
    wide = np.stack([np.asarray(Image.fromarray(np.clip(lin_to_srgb(t[..., c]) * 255, 0, 255).astype(np.uint8)).filter(ImageFilter.MedianFilter(21))) for c in range(3)], -1)
    t = np.where(star[..., None], srgb_to_lin(wide.astype(np.float32) / 255), t)
    # fade to black: the light at the tile's rim (its outskirts' level) taken off everywhere, so the halo
    # runs out tonally; then a soft geometric fade over the outer 40 % for what remains (no disc edge)
    rim = t[(rr > 0.88) & (rr < 0.98)]
    t = np.maximum(t - np.percentile(rim, 70, axis=0) * 1.1, 0)
    fade = np.clip((1 - rr) / 0.4, 0, 1)
    t = t * (fade * fade * (3 - 2 * fade))[..., None]
    # the brightest part (99.5th percentile inside half the radius) to 1
    core = (t @ np.array([0.2126, 0.7152, 0.0722], np.float32))[rr < 0.5]
    t = t / max(np.percentile(core, 99.5), 1e-4)
    return np.clip(t, 0, 1)


src = [s for s in json.load(open(RAW / 'sources.json')) if s['file'] not in SKIP]
atlas = np.zeros((ROWS * TILE, COLS * TILE, 3), np.float32)
meta = []
for i, s in enumerate(src[: COLS * ROWS]):
    t = isolate(Image.open(RAW / s['file']))
    r, c = divmod(i, COLS)
    atlas[r * TILE:(r + 1) * TILE, c * TILE:(c + 1) * TILE] = t
    lum = t @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    colour = (t.reshape(-1, 3) * lum.reshape(-1, 1)).sum(0) / max(lum.sum(), 1e-6)
    meta.append({'tile': i, 'kind': s['kind'], 'planar': s['kind'] in PLANAR, 'colour': [round(float(x), 3) for x in colour],
                 'title': s['title'], 'source': s['source'], 'licence': s['licence'], 'credit': s['credit']})
    print(i, s['kind'], s['file'])
Image.fromarray(np.clip(lin_to_srgb(atlas) * 255, 0, 255).astype(np.uint8)).save(OUT / 'galaxy-atlas.jpg', quality=93)
(OUT / 'galaxy-atlas.json').write_text(json.dumps({'tile': TILE, 'cols': COLS, 'rows': ROWS, 'galaxies': meta}, indent=1))
print(len(meta), 'tiles')
