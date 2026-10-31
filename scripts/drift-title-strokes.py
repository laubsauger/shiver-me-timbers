"""
The pen path of the film's title, "the Drift" in Pinyon Script, for its drawn-on reveal (src/drift/titleInk.ts).

The client's note of 2026-10-31: the title should become "a proper logo drawn on along its strokes like calligraphy /
handwriting over ~1.5–2 s, without going cringy". The filled glyphs are revealed at runtime by a thick stroke mask that
runs along the letters' centrelines up to progress p, so this bake only has to say where the pen goes, in what order
and how wide the ink is there:

  1. render the word with the font (Pillow with raqm: the kerning the browser's canvas applies), 400 px per em;
  2. thin the glyph mask to its centrelines (Zhang–Suen in numpy: no scikit-image needed) and read the ink's
     half-width at every centreline pixel from the distance transform (scipy);
  3. follow the centrelines through hand-placed WAYPOINTS: each stroke is a list of them, a new stroke a pen lift, and
     between two waypoints the pen takes the shortest way along the centreline (Dijkstra over its pixels).

Why waypoints and not an automatic walk: the first version walked the skeleton graph by itself (straightest way on at
every junction, leftmost loose end first). On a script face the thinned staircases make a junction every few pixels,
and the walk came out in 23 pieces in no writing order (the h's stem drawn bottom-up, the f in six bits). A hand knows
the order — t's stem down, the h, the e, then the cross; the D from its top-right entry down the stem, round the
bottom loop, up the bowl, curled in at the end; r, i, f's loop up the hairline and down the shade, t, its cross, the
dot — so the order is written down here and the centreline gives the exact path.

Writes src/drift/titleStrokes.json: { "<text>": { font, advance, strokes: [[[x, y, r], ...], ...] } } in em, from the
text's left end on its baseline, y down (the canvas's `textAlign = 'left'`, `textBaseline = 'alphabetic'` origin), r
the ink's half-width there. A debug sheet (the order as colour, stroke numbers at their starts, any ink no stroke
reaches in red) goes to --debug.

  out/drift/data/.venv/bin/python -I scripts/drift-title-strokes.py [--debug out/drift/review/title_strokes.png]
"""
import argparse
import heapq
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = os.path.join(ROOT, 'public/drift/fonts/PinyonScript-Regular.ttf')
OUT = os.path.join(ROOT, 'src/drift/titleStrokes.json')
TEXT = 'the Drift'
EM = 400  # px per em of the bake
PAD = 200  # px around the text
# the strokes in writing order, as waypoints in the bake's pixels (EM 400, PAD 200: the text's origin lands at
# (214, 512)); read off the debug sheet's grid. Each is snapped to the nearest centreline pixel.
STROKES: list[list[tuple[int, int]]] = [
    # t: from its top down the stem, the turn at the foot, the hairline into the h's foot
    [(361, 290), (218, 471), (211, 505), (287, 497)],
    # h: the stem from the top, up the arch, down the leg; on into the e: up over its eye, round, and out
    [(487, 211), (296, 486), (369, 384), (442, 381), (386, 506), (545, 428), (595, 385), (485, 464), (495, 505),
     (628, 434)],
    # the t's cross
    [(279, 342), (394, 342)],
    # D: from the entry at top right down the stem, round the little loop at the foot, along the base, up the bowl,
    # over the top and down the back, curled in to end inside
    [(1092, 254), (1012, 293), (900, 400), (797, 497), (750, 486), (707, 497), (750, 508), (850, 510), (1000, 430),
     (1027, 350), (1000, 290), (900, 245), (762, 350), (800, 397), (930, 280)],
    # r: the entry hairline up to its knob
    [(1037, 446), (1077, 367)],
    # r: the shoulder and down the stem, out into the i
    [(1076, 388), (1135, 404), (1080, 507), (1148, 472)],
    # i: down from its top, round the foot, up the hairline to the ball it ends in
    [(1220, 391), (1148, 472), (1160, 508), (1265, 437), (1272, 420)],
    # f: from there up the loop's right side, over, down the shade to the foot of the descender, back up and out to
    # the t
    [(1265, 437), (1430, 320), (1472, 205), (1393, 285), (1283, 456), (1170, 650), (1250, 588), (1283, 480),
     (1345, 478), (1390, 455)],
    # t: from its top down the stem, the foot, out
    [(1522, 290), (1372, 505), (1482, 436)],
    # the t's cross, then the i's dot
    [(1440, 342), (1539, 341)],
    [(1264, 326)],
]


def zhang_suen(img: np.ndarray) -> np.ndarray:
    """thin a boolean mask to 8-connected one-pixel centrelines"""
    s = np.pad(img.astype(np.uint8), 1)
    while True:
        changed = False
        for step in (0, 1):
            P2 = np.roll(s, 1, 0); P4 = np.roll(s, -1, 1); P6 = np.roll(s, -1, 0); P8 = np.roll(s, 1, 1)
            P3 = np.roll(P2, -1, 1); P5 = np.roll(P6, -1, 1); P7 = np.roll(P6, 1, 1); P9 = np.roll(P2, 1, 1)
            seq = [P2, P3, P4, P5, P6, P7, P8, P9, P2]
            B = sum(seq[:8])
            A = sum(((seq[i] == 0) & (seq[i + 1] == 1)).astype(np.uint8) for i in range(8))
            if step == 0:
                c = (P2 * P4 * P6 == 0) & (P4 * P6 * P8 == 0)
            else:
                c = (P2 * P4 * P8 == 0) & (P2 * P6 * P8 == 0)
            kill = (s == 1) & (B >= 2) & (B <= 6) & (A == 1) & c
            if kill.any():
                s[kill] = 0
                changed = True
        if not changed:
            return s[1:-1, 1:-1].astype(bool)


def rdp(pts: np.ndarray, eps: float) -> np.ndarray:
    if len(pts) < 3:
        return pts
    a, b = pts[0, :2], pts[-1, :2]
    ab = b - a
    n = np.linalg.norm(ab)
    rel = pts[:, :2] - a
    d = np.abs(ab[0] * rel[:, 1] - ab[1] * rel[:, 0]) / n if n > 0 else np.linalg.norm(rel, axis=1)
    d = np.maximum(d, np.abs(pts[:, 2] - (pts[0, 2] + (pts[-1, 2] - pts[0, 2]) * np.linspace(0, 1, len(pts)))))
    i = int(np.argmax(d))
    if d[i] <= eps:
        return pts[[0, -1]]
    return np.vstack([rdp(pts[: i + 1], eps)[:-1], rdp(pts[i:], eps)])


N8 = [(-1, -1, 1.4142), (-1, 0, 1.0), (-1, 1, 1.4142), (0, -1, 1.0), (0, 1, 1.0), (1, -1, 1.4142), (1, 0, 1.0),
      (1, 1, 1.4142)]


def shortest(sk: np.ndarray, a: tuple[int, int], b: tuple[int, int]) -> list[tuple[int, int]]:
    """the shortest way from a to b along the centreline (8-connected pixels)"""
    dist = {a: 0.0}
    prev: dict[tuple[int, int], tuple[int, int]] = {}
    heap = [(0.0, a)]
    while heap:
        d, p = heapq.heappop(heap)
        if p == b:
            break
        if d > dist[p]:
            continue
        for dy, dx, w in N8:
            q = (p[0] + dy, p[1] + dx)
            if not sk[q]:
                continue
            nd = d + w
            if nd < dist.get(q, 1e18):
                dist[q] = nd
                prev[q] = p
                heapq.heappush(heap, (nd, q))
    if b not in dist:
        raise SystemExit(f'no centreline path from {a[::-1]} to {b[::-1]} (x, y)')
    path = [b]
    while path[-1] != a:
        path.append(prev[path[-1]])
    return path[::-1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--debug', default=os.path.join(ROOT, 'out/drift/review/title_strokes.png'))
    args = ap.parse_args()
    font = ImageFont.truetype(FONT, EM, layout_engine=ImageFont.Layout.RAQM)
    l, t, r, b = font.getbbox(TEXT, anchor='ls')
    W, H = r - l + 2 * PAD, b - t + 2 * PAD
    ox, by = PAD - l, PAD - t
    assert (ox, by) == (214, 512), f'the waypoints are in a bake whose origin was (214, 512), now {(ox, by)}'
    im = Image.new('L', (W, H), 0)
    ImageDraw.Draw(im).text((ox, by), TEXT, font=font, fill=255, anchor='ls')
    mask = np.array(im) >= 128
    dist = ndimage.distance_transform_edt(mask)
    sk = zhang_suen(mask)
    sky, skx = np.nonzero(sk)

    def snap(x: int, y: int) -> tuple[int, int]:
        k = int(np.argmin((skx - x) ** 2 + (sky - y) ** 2))
        if (skx[k] - x) ** 2 + (sky[k] - y) ** 2 > 12 ** 2:
            raise SystemExit(f'waypoint ({x}, {y}) is {math.dist((x, y), (skx[k], sky[k])):.0f} px off the centreline')
        return int(sky[k]), int(skx[k])

    strokes = []
    for wps in STROKES:
        pts = [snap(x, y) for x, y in wps]
        if len(pts) == 1:  # a dot: a pen touch, as wide as the dot
            pts = [pts[0], (pts[0][0] + 1, pts[0][1])]
            strokes.append(pts)
            continue
        path = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            path += shortest(sk, a, b)[1:]
        strokes.append(path)
    out = []
    for s in strokes:
        pts = np.array([[(x - ox) / EM, (y - by) / EM, max(1.0, dist[y, x]) / EM] for y, x in s])
        out.append(rdp(pts, 1.0 / EM))
    # what the reveal reaches: discs of 1.25× the half-width (+1.5 px) along every stroke, as titleInk.ts draws them
    reach = Image.new('L', (W, H), 0)
    rd = ImageDraw.Draw(reach)
    for s in out:
        for (x0, y0, r0), (x1, y1, r1) in zip(s, s[1:]):
            for k in np.linspace(0, 1, max(2, int(math.dist((x0, y0), (x1, y1)) * EM / 2))):
                x, y, rr = ox + EM * (x0 + (x1 - x0) * k), by + EM * (y0 + (y1 - y0) * k), EM * (r0 + (r1 - r0) * k) * 1.25 + 1.5
                rd.ellipse([x - rr, y - rr, x + rr, y + rr], fill=255)
    missed = mask & (np.array(reach) == 0)
    total = sum(float(np.sum(np.linalg.norm(np.diff(s[:, :2], axis=0), axis=1))) for s in out)
    print(f'{len(out)} strokes, {sum(len(s) for s in out)} points, {total:.2f} em of pen path; '
          f'advance {font.getlength(TEXT) / EM:.4f} em; ink no stroke reaches: {missed.sum() / mask.sum():.2%}')
    data = {}
    if os.path.exists(OUT):
        with open(OUT) as f:
            data = json.load(f)
    data[TEXT] = {
        'font': 'Pinyon Script',
        'advance': round(font.getlength(TEXT) / EM, 4),
        'strokes': [[[round(float(v), 4) for v in p] for p in s] for s in out],
    }
    with open(OUT, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
        f.write('\n')
    if args.debug:
        os.makedirs(os.path.dirname(args.debug), exist_ok=True)
        base = np.stack([np.array(im) // 4] * 3, -1).astype(np.uint8)
        base[missed] = [255, 0, 0]
        dbg = Image.fromarray(base)
        d = ImageDraw.Draw(dbg)
        n = len(out)
        lab = ImageFont.load_default(28)
        for k, s in enumerate(out):
            xy = [(ox + x * EM, by + y * EM) for x, y, _ in s]
            # colour runs along each stroke from dark to light, so its direction shows
            for j, (p0, p1) in enumerate(zip(xy, xy[1:])):
                h = j / max(1, len(xy) - 2)
                hue = k / max(1, n - 1)
                col = (int(80 + 175 * h), int(255 * (1 - hue) * (0.4 + 0.6 * h)), int(255 * hue * (0.4 + 0.6 * h)))
                d.line([p0, p1], fill=col, width=3)
            d.ellipse([xy[0][0] - 6, xy[0][1] - 6, xy[0][0] + 6, xy[0][1] + 6], outline=(255, 255, 255), width=2)
            d.text((xy[0][0] + 8, xy[0][1] - 24), str(k), fill=(255, 255, 255), font=lab)
        dbg.save(args.debug)
        print('debug sheet', args.debug)


if __name__ == '__main__':
    main()
