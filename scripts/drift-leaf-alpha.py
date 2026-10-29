"""
The Drift's forest-edge trees (Poly Haven island trees, CC0): their leaf textures are leaves laid on BLACK with no
alpha — each leaf was modelled to its outline, so the black never showed until scripts/drift-tree-export.py
collapsed the leaves to a few triangles and forest.ts had to cut them out of the colour. Cut by brightness, every
mip level below full size averaged the leaf with the black around it: dark fringes and black specks all through the
crowns (the 2026-10-29 review: "black spots all around underneath").

This writes, next to each tree's leaf diffuse, a real alpha (the leaf where its colour clears the black, opened by a
pixel's feather) and the diffuse with the leaf colour bled out over the black (each background texel takes the mean
of the leaf texels near it, growing outward), so no filter ever pulls black into a leaf:

  <asset>/textures/<asset>_leaves_alpha_2k.png       L, 0..255
  <asset>/textures/<asset>_leaves_diff_bled_2k.png   RGB

  out/drift/data/.venv/bin/python -I scripts/drift-leaf-alpha.py public/drift/pbr island_tree_01 island_tree_02 ...
"""
import sys

import numpy as np
from PIL import Image

root, assets = sys.argv[1], sys.argv[2:]
for asset in assets:
    src = f'{root}/{asset}/textures/{asset}_leaves_diff_2k.jpg'
    rgb = np.asarray(Image.open(src).convert('RGB')).astype(np.float32) / 255
    peak = rgb.max(axis=2)
    # the leaf: clear of the black (JPEG noise sits under ~0.04), feathered over a pixel
    alpha = np.clip((peak - 0.05) / 0.04, 0, 1)
    leaf = alpha > 0.5
    # bleed: background texels take the mean of their leaf neighbours, ring by ring (64 rings: past every mip a
    # crown's leaves are drawn at)
    col = np.where(leaf[..., None], rgb, 0)
    have = leaf.astype(np.float32)
    for _ in range(64):
        s = np.zeros_like(col)
        n = np.zeros_like(have)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            s += np.roll(np.roll(col * have[..., None], dy, 0), dx, 1)
            n += np.roll(np.roll(have, dy, 0), dx, 1)
        grow = (have == 0) & (n > 0)
        if not grow.any():
            break
        col[grow] = s[grow] / n[grow][..., None]
        have[grow] = 1
    # what never got reached (none, in practice): the leaves' mean
    col[have == 0] = rgb[leaf].mean(axis=0)
    Image.fromarray((alpha * 255 + 0.5).astype(np.uint8), 'L').save(f'{root}/{asset}/textures/{asset}_leaves_alpha_2k.png')
    Image.fromarray((np.clip(col, 0, 1) * 255 + 0.5).astype(np.uint8), 'RGB').save(f'{root}/{asset}/textures/{asset}_leaves_diff_bled_2k.png')
    print(f'[leaf-alpha] {asset}: {leaf.mean() * 100:.0f}% leaf', flush=True)
