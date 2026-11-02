"""
The pen paths of the crawl's copy, glyph by glyph: EB Garamond Italic at weight 560, for the body's written-on reveal
(src/drift/undertime/crawlInk.ts).

The 2026-11-02 review: the survivor's light that writes the copy "follows the line's centre, not the letters' strokes,
so it looks fake", while the title beside it ("the Drift", ../drift-title-strokes.py) is written along its own strokes.
The client's note of 2026-10-31 asked for copy that looks "less stiff" as well. So the body gets what the title has —
the filled glyph revealed by a stroke mask that runs along its centrelines in writing order — but per GLYPH, not per
text: the copy is a placeholder until Dimi's narration arrives and will change, while a glyph's strokes do not. The
crawl draws every body glyph on its own (each turned to its circle of elevation; flatTitles.ts the same on its arc), so
a glyph's path in its own frame is all the runtime needs.

  1. render each glyph with the font at the crawl's weight (the variable font's wght axis at 560: crawl.ts FONTS),
     400 px per em, as the title's bake does;
  2. thin it to its centrelines (Zhang–Suen) and read the ink's half-width from the distance transform — the title
     bake's code, shared by import;
  3. turn the centrelines into a graph (junctions, ends, the chains between them), prune the short spurs a serif or a
     swelling terminal thins into (shorter than 1.6 half-widths of the stroke they leave, plus 6 px: they are inside the
     mask's reach of the stroke anyway), and join through what is left of a junction once its spurs are gone;
  4. order the strokes AUTOMATICALLY, the way a hand starts a letter: the first stroke from the loose end (or, on a
     closed letter, the topmost point) furthest up and left, a closed bowl written counter-clockwise from its top; at
     every junction on the way the straightest way on; when no way on is left, a lift to the next loose end by the same
     rule. Where that order is not the hand's — the italic a and g (bowl first, then the stem), e (the eye's bar first),
     k, B, E, F — the glyph has HAND WAYPOINTS below instead, followed along the centreline by the shortest way, as the
     title's are.

The bake checks what it writes: every polyline stays inside the glyph's ink (sampled every pixel, against the mask
grown by one pixel for the antialiased edge), and it prints how much of each glyph's ink the mask's reach misses (the
runtime brings that up as the pen leaves the glyph, as titleInk.ts does its TAIL).

Writes src/drift/undertime/copyStrokes.json:
  { font, weight, glyphs: { "<ch>": { advance, strokes: [[[x, y, r], ...], ...] } } }
in em, from the glyph's left end (its origin) on its baseline, y down, r the ink's half-width there. A debug sheet (each
glyph with its strokes, the order as colour from dark to light along each, stroke numbers at their starts, a 0.1 em grid
to read waypoints off, ink the mask misses in red) goes to --debug.

  out/drift/data/.venv/bin/python -I scripts/drift-copy-strokes.py [--debug out/drift/review/copy_strokes.png]
"""
import argparse
import importlib.util
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT = os.path.join(ROOT, 'public/drift/fonts/EBGaramond-Italic-VF.ttf')
OUT = os.path.join(ROOT, 'src/drift/undertime/copyStrokes.json')
# the crawl's weight (crawl.ts and flatTitles.ts FONTS: 'italic 560 …')
WEIGHT = 560
EM = 400  # px per em of the bake
PAD = 80  # px around each glyph
# the copy's glyphs and the rest of the alphabet (the copy is a placeholder: new copy should find its glyphs baked)
CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ,.;:\'’-!?'
# the reach titleInk.ts gives the mask (REACH × the half-width, + REACH_PAD em): the coverage check draws the same
REACH = 1.25
REACH_PAD = 1.5  # px at EM
# em: a stroke shorter than this is a pen touch (a dot), written after the letter's strokes
DOT = 0.08
# em: the longest way along the centreline the pen runs on over written ink rather than lift
JOIN = 0.15

# the title bake's thinning, simplification and shortest path (one implementation of each; loaded from its file, its
# name has dashes; no bytecode cache left in scripts/)
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location('drift_title_strokes', os.path.join(ROOT, 'scripts/drift-title-strokes.py'))
_title = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_title)
zhang_suen, rdp, shortest, N8 = _title.zhang_suen, _title.rdp, _title.shortest, _title.N8

# HAND WAYPOINTS, in em of the glyph's own frame (x from its origin, y from the baseline, down; read off the debug
# sheet's 0.1 em grid): each stroke a list of them, a new stroke a pen lift; each snapped to the nearest centreline
# pixel, and between two the pen takes the shortest way along the centreline.
HAND: dict[str, list[list[tuple[float, float]]]] = {
    # a: the bowl counter-clockwise from its top right, round and back up its right side, on up to the stem's top, and
    # down the stem to the foot and out (the automatic walk began in the middle of the stem and left the bowl for last)
    'a': [[(0.375, -0.3125), (0.325, -0.3875), (0.05, -0.05), (0.325, -0.18), (0.375, -0.3125), (0.405, -0.4),
           (0.32, -0.1), (0.3375, -0.0375), (0.45, -0.12)]],
    # d: as the a, the stem's top the ascender's
    'd': [[(0.395, -0.35), (0.3125, -0.4), (0.05, -0.05), (0.3375, -0.175), (0.395, -0.35), (0.4625, -0.675),
           (0.3625, -0.05), (0.4875, -0.13)]],
    # e: the eye's bar from its left, up round the top, down the back and round the foot, out
    'e': [[(0.1, -0.245), (0.305, -0.3125), (0.2375, -0.405), (0.0625, -0.15), (0.15, -0.0375), (0.28, -0.1)]],
    # g: the bowl counter-clockwise from its top right; the tail from the bowl's foot down round the lower loop; the ear
    'g': [[(0.3, -0.3625), (0.225, -0.4125), (0.095, -0.1875), (0.1375, -0.105), (0.3, -0.2375), (0.3, -0.3625)],
          [(0.1375, -0.105), (0.2, 0.075), (0.3, 0.1875), (0.1, 0.2625), (-0.0625, 0.1625), (0.1, 0.075)],
          [(0.325, -0.375), (0.4625, -0.38)]],
    # k: the stem down; from it, up round the loop and down the leg, out
    # w: as two u's — down, round, up the middle stem and back down it, round, up to the right top (the automatic walk
    # wrote the right half backwards, from its top)
    'w': [[(0.069, -0.3125), (0.184, -0.381), (0.153, -0.031), (0.325, -0.1), (0.419, -0.356), (0.3875, -0.031),
           (0.575, -0.178), (0.606, -0.381)]],
    # y: as a u — down, round, up the right arm — then back down the arm into the descender and its tail
    'y': [[(0.059, -0.2875), (0.169, -0.397), (0.2375, -0.0425), (0.394, -0.397), (0.2375, -0.0425), (-0.05, 0.228)]],
    'k': [[(0.225, -0.6625), (0.0625, -0.0375)],
          [(0.15, -0.245), (0.2875, -0.3625), (0.4125, -0.3875), (0.3375, -0.245), (0.25, -0.1875), (0.2875, -0.0875),
           (0.35, -0.0375), (0.4375, -0.12)]],
    # B: the stem down from its serif to the foot; then from its top the upper bowl, the waist, the lower bowl, home
    'B': [[(0.1875, -0.6425), (0.275, -0.625), (0.15, -0.05), (0.0, -0.0125)],
          [(0.3375, -0.6375), (0.575, -0.525), (0.475, -0.4), (0.3, -0.3625), (0.425, -0.3625), (0.49, -0.21),
           (0.4, -0.0375), (0.2, -0.025)]],
    # E: the stem down; the top arm out and its serif down; the middle arm and its tick; the foot out along the base
    'E': [[(0.17, -0.6425), (0.2625, -0.625), (0.15, -0.0625), (-0.0125, -0.0125)],
          [(0.325, -0.6375), (0.5875, -0.6425), (0.58, -0.525)],
          [(0.275, -0.3375), (0.5, -0.4125), (0.45, -0.25)],
          [(0.175, -0.025), (0.475, -0.025), (0.525, -0.125)]],
    # F: the stem down to the left of the foot, the foot's right; the top arm; the middle arm and its tick
    'F': [[(0.1875, -0.6425), (0.275, -0.625), (0.1625, -0.05), (0.0, -0.0125)],
          [(0.1625, -0.05), (0.25, -0.0175)],
          [(0.325, -0.6375), (0.5875, -0.6425), (0.595, -0.525)],
          [(0.275, -0.3375), (0.5, -0.405), (0.4625, -0.2625)]],
}


def render(font: ImageFont.FreeTypeFont, ch: str) -> tuple[np.ndarray, int, int]:
    """the glyph's ink (grey 0..255) with PAD round it, and where its origin lands"""
    l, t, r, b = font.getbbox(ch, anchor='ls')
    W, H = r - l + 2 * PAD, b - t + 2 * PAD
    ox, by = PAD - l, PAD - t
    im = Image.new('L', (W, H), 0)
    ImageDraw.Draw(im).text((ox, by), ch, font=font, fill=255, anchor='ls')
    return np.array(im), ox, by


def nbrs(sk: np.ndarray, p: tuple[int, int]) -> list[tuple[int, int]]:
    return [(p[0] + dy, p[1] + dx) for dy, dx, _ in N8 if sk[p[0] + dy, p[1] + dx]]


def chains(sk: np.ndarray) -> tuple[dict[int, tuple[float, float]], list[dict]]:
    """the centrelines as a graph: nodes (junction clusters and loose ends: id → centre (y, x)) and edges (the pixel
    chains between them, each {a, b, px: [(y, x), ...]} from node a to node b)"""
    deg = ndimage.convolve(sk.astype(int), np.ones((3, 3), int), mode='constant') - 1
    node_mask = sk & (deg != 2)
    lab, n = ndimage.label(node_mask, structure=np.ones((3, 3)))
    # a closed loop with no junction on it (an o's bowl): a node at its topmost pixel
    rest = sk & ~node_mask
    lab_rest, n_rest = ndimage.label(sk, structure=np.ones((3, 3)))
    for comp in range(1, n_rest + 1):
        cm = lab_rest == comp
        if not (cm & node_mask).any():
            ys, xs = np.nonzero(cm)
            k = int(np.argmin(ys * 10000 + xs))
            n += 1
            lab[ys[k], xs[k]] = n
    nodes = {i: tuple(np.mean(np.argwhere(lab == i), axis=0)) for i in range(1, n + 1)}
    edges: list[dict] = []
    seen: set[tuple[int, int]] = set()
    pairs: set[tuple[tuple[int, int], tuple[int, int]]] = set()
    for i in range(1, n + 1):
        for p in map(tuple, np.argwhere(lab == i)):
            for q in nbrs(sk, p):
                if lab[q] == i:
                    continue
                if lab[q] > 0:  # two clusters touching: a one-step edge
                    key = (min(p, q), max(p, q))
                    if key not in pairs:
                        pairs.add(key)
                        edges.append({'a': i, 'b': int(lab[q]), 'px': [p, q]})
                    continue
                if q in seen:
                    continue
                chain = [p, q]
                seen.add(q)
                while True:
                    cur = chain[-1]
                    nxt = [r for r in nbrs(sk, cur) if r != chain[-2] and r not in seen]
                    end = [r for r in nxt if lab[r] > 0]
                    if end:
                        chain.append(end[0])
                        break
                    if not nxt:  # (should not happen on a clean centreline)
                        break
                    chain.append(nxt[0])
                    seen.add(nxt[0])
                b = int(lab[chain[-1]])
                if b == 0:
                    continue
                if b == i and len(chain) < 6:  # a cluster's own staircase back into itself
                    continue
                edges.append({'a': i, 'b': b, 'px': chain})
    del rest
    return nodes, edges


def plen(px: list[tuple[int, int]]) -> float:
    return float(sum(math.dist(a, b) for a, b in zip(px, px[1:])))


def prune(nodes: dict, edges: list[dict], dist: np.ndarray) -> list[dict]:
    """drop the short spurs a serif or a swelling terminal thins into; join the chains through a junction left with two"""
    for _ in range(3):
        deg: dict[int, int] = {}
        for e in edges:
            deg[e['a']] = deg.get(e['a'], 0) + 1
            deg[e['b']] = deg.get(e['b'], 0) + 1
        keep = []
        for e in edges:
            a, b = e['a'], e['b']
            spur_end = a if deg[a] == 1 and deg[b] >= 3 else b if deg[b] == 1 and deg[a] >= 3 else None
            if spur_end is not None:
                junction = e['px'][-1] if spur_end == a else e['px'][0]
                if plen(e['px']) < 1.6 * dist[junction] + 6:
                    deg[a] -= 1
                    deg[b] -= 1
                    continue
            keep.append(e)
        edges = keep
        # join through nodes now of degree 2 (not a loop's own node)
        changed = True
        while changed:
            changed = False
            deg = {}
            for e in edges:
                deg[e['a']] = deg.get(e['a'], 0) + 1
                deg[e['b']] = deg.get(e['b'], 0) + 1
            for v, d in deg.items():
                if d != 2:
                    continue
                inc = [e for e in edges if e['a'] == v or e['b'] == v]
                if len(inc) != 2 or inc[0] is inc[1]:
                    continue
                e1, e2 = inc
                p1 = e1['px'] if e1['b'] == v else e1['px'][::-1]
                o1 = e1['a'] if e1['b'] == v else e1['b']
                p2 = e2['px'] if e2['a'] == v else e2['px'][::-1]
                o2 = e2['b'] if e2['a'] == v else e2['a']
                edges = [e for e in edges if e is not e1 and e is not e2] + [{'a': o1, 'b': o2, 'px': p1 + p2[1:]}]
                changed = True
                break
    return edges


def heading(px: list[tuple[int, int]]) -> np.ndarray:
    """the unit direction (dy, dx) a chain leaves its first pixel in, over its first ~12 px"""
    k = min(len(px) - 1, 12)
    d = np.array(px[k], float) - np.array(px[0], float)
    n = np.linalg.norm(d)
    return d / n if n > 0 else np.zeros(2)


def auto_order(nodes: dict, edges: list[dict], sk: np.ndarray) -> list[list[tuple[int, int]]]:
    """the strokes in a hand's order (step 4 of the docstring)"""
    left = list(range(len(edges)))
    strokes: list[list[tuple[int, int]]] = []
    # up first, then left (y down); after the first stroke, nearer the pen as well (the r's arm from the stem it leaves,
    # not back from its tip; the h's arch from the stem's junction, not up from its exit)
    pen: tuple[float, float] | None = None
    score = lambda yx: yx[0] + 0.5 * yx[1] + (0.5 * math.dist(yx, pen) if pen else 0.0)

    def ccw(px: list[tuple[int, int]]) -> list[tuple[int, int]]:
        """a closed bowl counter-clockwise on the page: leaving its start to the left"""
        return px if heading(px)[1] <= 0 else px[::-1]

    def oriented(e: dict, frm: int) -> list[tuple[int, int]]:
        if e['a'] == e['b']:
            return ccw(e['px'])
        return e['px'] if e['a'] == frm else e['px'][::-1]

    while left:
        deg: dict[int, int] = {}
        for i in left:
            for v in (edges[i]['a'], edges[i]['b']):
                deg[v] = deg.get(v, 0) + 1
        odd = [v for v, d in deg.items() if d % 2 == 1]
        v = min(odd or list(deg), key=lambda u: score(nodes[u]))
        # the first stroke from there: the one that goes down most
        inc = [i for i in left if v in (edges[i]['a'], edges[i]['b'])]
        i = max(inc, key=lambda j: heading(oriented(edges[j], v))[0])
        e = edges[i]
        if e['a'] == e['b'] and deg[v] == 2:
            # a bowl on its own (the o): from its top-left-most point, wherever the junction the thinning left is
            c = e['px'] if e['px'][0] != e['px'][-1] else e['px'][:-1]
            k = min(range(len(c)), key=lambda j: c[j][0] + 0.5 * c[j][1])
            path = ccw(c[k:] + c[:k] + [c[k]])
        else:
            path = oriented(e, v)
        left.remove(i)
        cur = e['b'] if e['a'] == v else e['a']
        while True:
            inc = [j for j in left if cur in (edges[j]['a'], edges[j]['b'])]
            if not inc:
                break
            back = np.array(path[-1], float) - np.array(path[max(0, len(path) - 13)], float)
            nb = np.linalg.norm(back)
            dirn = back / nb if nb > 0 else np.zeros(2)
            j = max(inc, key=lambda k: float(np.dot(dirn, heading(oriented(edges[k], cur)))))
            nxt = oriented(edges[j], cur)
            path += nxt[1:] if nxt[0] == path[-1] else nxt
            left.remove(j)
            cur = edges[j]['b'] if edges[j]['a'] == cur else edges[j]['a']
        strokes.append(path)
        pen = path[-1]
    # dots last (the i's and the j's after their stems: a hand dots them once the letter is written)
    touch = [plen(s) < DOT * EM for s in strokes]
    if not all(touch):
        strokes = [s for s, t in zip(strokes, touch) if not t] + [s for s, t in zip(strokes, touch) if t]
    # no lift where the next stroke begins a short way along the centreline from where the last ended (the t's and the
    # f's cross, cut in two by the stem; the u's right stem, up to its top and back down it): the pen runs on over the
    # ink it has written, as a hand does
    lab, _ = ndimage.label(sk, structure=np.ones((3, 3)))
    joined = [strokes[0]]
    for s in strokes[1:]:
        a, b = joined[-1][-1], s[0]
        if lab[a] == lab[b] and math.dist(a, b) < JOIN * EM:
            way = shortest(sk, a, b)
            if plen(way) < JOIN * EM:
                joined[-1] = joined[-1] + way[1:-1] + s
                continue
        joined.append(s)
    return joined


def hand_order(sk: np.ndarray, wps_em: list[list[tuple[float, float]]], ox: int, by: int) -> list[list[tuple[int, int]]]:
    sky, skx = np.nonzero(sk)

    def snap(x: float, y: float) -> tuple[int, int]:
        X, Y = ox + x * EM, by + y * EM
        k = int(np.argmin((skx - X) ** 2 + (sky - Y) ** 2))
        if (skx[k] - X) ** 2 + (sky[k] - Y) ** 2 > 14 ** 2:
            raise SystemExit(f'waypoint ({x}, {y}) em is {math.dist((X, Y), (skx[k], sky[k])):.0f} px off the centreline '
                             f'(nearest: ({(skx[k] - ox) / EM:.3f}, {(sky[k] - by) / EM:.3f}))')
        return int(sky[k]), int(skx[k])

    out = []
    for wps in wps_em:
        pts = [snap(x, y) for x, y in wps]
        if len(pts) == 1:
            out.append([pts[0], (pts[0][0] + 1, pts[0][1])])
            continue
        path = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            path += shortest(sk, a, b)[1:]
        out.append(path)
    return out


def bake(font: ImageFont.FreeTypeFont, ch: str) -> dict:
    grey, ox, by = render(font, ch)
    mask = grey >= 128
    dist = ndimage.distance_transform_edt(mask)
    sk = zhang_suen(mask)
    if ch in HAND:
        try:
            strokes = hand_order(sk, HAND[ch], ox, by)
        except SystemExit as e:
            raise SystemExit(f'{ch!r}: {e}')
    else:
        nodes, edges = chains(sk)
        edges = prune(nodes, edges, dist)
        strokes = auto_order(nodes, edges, sk)
    # a dot or a tiny piece (a full stop's ball thins to a few pixels): one pen touch, as wide as the ink there
    if not strokes:
        ys, xs = np.nonzero(mask)
        k = int(np.argmax(dist[ys, xs]))
        strokes = [[(int(ys[k]), int(xs[k])), (int(ys[k]) + 1, int(xs[k]))]]
    # pieces of ink no stroke touches (a dot whose centreline is a lone pixel the graph has no chain for)
    reach = Image.new('L', mask.shape[::-1], 0)
    out = []
    for s in strokes:
        pts = np.array([[(x - ox) / EM, (y - by) / EM, max(1.0, dist[y, x]) / EM] for y, x in s])
        out.append(rdp(pts, 1.0 / EM))
    lab, n = ndimage.label(mask, structure=np.ones((3, 3)))
    for comp in range(1, n + 1):
        touched = any(lab[int(round(by + y * EM)), int(round(ox + x * EM))] == comp for s in out for x, y, _ in s)
        if not touched:
            ys, xs = np.nonzero(lab == comp)
            k = int(np.argmax(dist[ys, xs]))
            y, x = int(ys[k]), int(xs[k])
            out.append(np.array([[(x - ox) / EM, (y - by) / EM, dist[y, x] / EM], [(x - ox) / EM, (y + 1 - by) / EM, dist[y, x] / EM]]))
    # what the reveal reaches (as titleInk.ts draws its mask), and whether every polyline stays inside the ink
    rd = ImageDraw.Draw(reach)
    grown = ndimage.binary_dilation(mask, iterations=1)
    outside = 0
    for s in out:
        for (x0, y0, r0), (x1, y1, r1) in zip(s, s[1:]):
            steps = max(2, int(math.dist((x0, y0), (x1, y1)) * EM))
            for k in np.linspace(0, 1, steps):
                x, y = ox + EM * (x0 + (x1 - x0) * k), by + EM * (y0 + (y1 - y0) * k)
                rr = EM * (r0 + (r1 - r0) * k) * REACH + REACH_PAD
                rd.ellipse([x - rr, y - rr, x + rr, y + rr], fill=255)
                outside += not grown[int(round(y)), int(round(x))]
    missed = mask & (np.array(reach) == 0)
    return {
        'advance': font.getlength(ch) / EM,
        'strokes': out,
        'missed': float(missed.sum() / max(1, mask.sum())),
        'outside': outside,
        'debug': (grey, missed, ox, by, sk),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--debug', default=os.path.join(ROOT, 'out/drift/review/copy_strokes.png'))
    ap.add_argument('--only', default='', help='bake just these glyphs into the debug sheet (the JSON is not written)')
    ap.add_argument('--scale', type=float, default=0.5, help='the debug sheet\'s px per bake px')
    args = ap.parse_args()
    font = ImageFont.truetype(FONT, EM, layout_engine=ImageFont.Layout.RAQM)
    font.set_variation_by_axes([WEIGHT])
    chars = args.only or CHARS
    baked = {ch: bake(font, ch) for ch in chars}
    bad = [ch for ch, b in baked.items() if b['outside'] > 0]
    for ch, b in baked.items():
        print(f'{ch!r}: {len(b["strokes"])} strokes, {sum(len(s) for s in b["strokes"])} points, '
              f'ink the mask misses {b["missed"]:.1%}' + (f', {b["outside"]} px of path OUTSIDE the ink' if b['outside'] else ''))
    if bad:
        raise SystemExit(f'pen paths leave the ink in {"".join(bad)!r}')
    if not args.only:
        data = {
            'font': 'EB Garamond Italic',
            'weight': WEIGHT,
            'glyphs': {ch: {'advance': round(b['advance'], 4),
                            'strokes': [[[round(float(v), 4) for v in p] for p in s] for s in b['strokes']]}
                       for ch, b in baked.items()},
        }
        with open(OUT, 'w') as f:
            json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
            f.write('\n')
        print('wrote', os.path.relpath(OUT, ROOT), f'({os.path.getsize(OUT) / 1024:.1f} KB)')
    if args.debug:
        S = args.scale
        CELL = int(2 * EM * S)  # px per cell: 2 em square
        cols = 10
        rows = math.ceil(len(baked) / cols)
        sheet = Image.new('RGB', (cols * CELL, rows * CELL), (0, 0, 0))
        d = ImageDraw.Draw(sheet)
        lab = ImageFont.load_default(16)
        big = ImageFont.load_default(28)
        for idx, (ch, b) in enumerate(baked.items()):
            grey, missed, ox, by, sk = b['debug']
            cx, cy = (idx % cols) * CELL, (idx // cols) * CELL
            # the glyph's origin at (0.5 em, 1.4 em) of the cell
            gx, gy = cx + 0.5 * EM * S, cy + 1.4 * EM * S
            base = np.stack([grey // 4] * 3, -1).astype(np.uint8)
            base[missed] = [255, 0, 0]
            base[ndimage.binary_dilation(sk) & ~missed] = [0, 90, 120]  # the centrelines, unpruned
            g = Image.fromarray(base).resize((int(grey.shape[1] * S), int(grey.shape[0] * S)))
            sheet.paste(g, (int(gx - ox * S), int(gy - by * S)))
            for k in range(-5, 16):  # the 0.1 em grid, the origin's lines brighter
                col = (90, 90, 90) if k == 0 else (32, 32, 32)
                d.line([(gx + k * 0.1 * EM * S, cy), (gx + k * 0.1 * EM * S, cy + CELL)], fill=col)
                d.line([(cx, gy - k * 0.1 * EM * S), (cx + CELL, gy - k * 0.1 * EM * S)], fill=col)
            n = len(b['strokes'])
            for k, s in enumerate(b['strokes']):
                xy = [(gx + x * EM * S, gy + y * EM * S) for x, y, _ in s]
                for j, (p0, p1) in enumerate(zip(xy, xy[1:])):
                    h = j / max(1, len(xy) - 2)
                    hue = k / max(1, n - 1)
                    col = (int(80 + 175 * h), int(255 * (1 - hue) * (0.4 + 0.6 * h)), int(255 * hue * (0.4 + 0.6 * h)))
                    d.line([p0, p1], fill=col, width=3)
                # arrowheads along it, every ~0.08 em, so its direction reads
                run = 0.0
                for p0, p1 in zip(xy, xy[1:]):
                    seg = math.dist(p0, p1)
                    run += seg
                    if run > 0.08 * EM * S and seg > 0:
                        run = 0.0
                        ux, uy = (p1[0] - p0[0]) / seg, (p1[1] - p0[1]) / seg
                        a = 6 * S / 0.5
                        d.polygon([p1, (p1[0] - a * ux - a * 0.6 * uy, p1[1] - a * uy + a * 0.6 * ux),
                                   (p1[0] - a * ux + a * 0.6 * uy, p1[1] - a * uy - a * 0.6 * ux)], fill=(255, 255, 255))
                d.ellipse([xy[0][0] - 4, xy[0][1] - 4, xy[0][0] + 4, xy[0][1] + 4], outline=(255, 255, 255), width=2)
                d.text((xy[0][0] + 6, xy[0][1] - 18), str(k), fill=(255, 255, 255), font=lab)
            d.text((cx + 8, cy + 6), f'{ch}  {n}  miss {b["missed"]:.0%}', fill=(200, 200, 200), font=big)
            d.rectangle([cx, cy, cx + CELL - 1, cy + CELL - 1], outline=(60, 60, 60))
        os.makedirs(os.path.dirname(args.debug), exist_ok=True)
        sheet.save(args.debug)
        print('debug sheet', args.debug)


if __name__ == '__main__':
    main()
