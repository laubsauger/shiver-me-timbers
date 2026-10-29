"""
The beach's scallop shells (src/drift/wandering/beachDressing.ts): ambientCG's CC0 ShellSet001 — nine scanned
scallops laid out 3 × 3 on one atlas, with colour, normal, roughness, an opacity cut-out and a displacement map —
turned into nine small MESHES, one per shell, written as one .glb:

  - each shell's outline is cut from the opacity map (a grid over its cell, the quads inside it kept), so its edge is
    geometry, not an alpha test (an alpha-tested card of a few centimetres shimmers as the eye moves);
  - its relief (the dome and the ribs) is the displacement map, raised to a scallop's own proportion: the dome about
    a fifth as high as the shell is wide;
  - each mesh is centred on its own footprint, its rim at z = 0 and the dome up (glTF: y up), its plan width
    WIDTH m, and collapsed to `budget` triangles;
  - the maps are cut to `size` px (a 5 cm shell 1 m from the eye spans ~80 px of a 1920 frame: the atlas at 1024
    gives it ~240).

  /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/drift-shell-export.py -- public/drift/pbr/ShellSet001 public/drift/pbr/ShellSet001/shellset_beach.glb [budget per shell, 160] [size, 1024]
"""

import sys
from pathlib import Path

import bpy
import bmesh
import numpy as np

args = sys.argv[sys.argv.index('--') + 1:]
src, out = Path(args[0]), args[1]
budget = int(args[2]) if len(args) > 2 else 160
size = int(args[3]) if len(args) > 3 else 1024
# m: a shell's plan width (the script's unit; beachDressing.ts scales each instance)
WIDTH = 0.05
# the dome's height as a share of the width (a bay scallop: ~1 cm on 5)
DOME = 0.2
# grid cells across a shell's cell of the atlas (its outline is cut at this step)
GRID = 56
# px of the atlas the outline and relief are read at
READ = 768

bpy.ops.wm.read_factory_settings(use_empty=True)
pre = 'ShellSet001_4K-JPG_'


def load(name: str, data: bool) -> bpy.types.Image:
    img = bpy.data.images.load(str(src / f'{pre}{name}.jpg'))
    if data:
        img.colorspace_settings.name = 'Non-Color'
    return img


def read(name: str) -> np.ndarray:
    """one channel of a map at READ², row 0 at the bottom (Blender's v = 0)"""
    img = load(name, True)
    img.scale(READ, READ)
    px = np.empty(READ * READ * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(READ, READ, 4)[:, :, 0]


opacity = read('Opacity')
disp = read('Displacement')


def sample(a: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """bilinear, u and v in 0..1"""
    x = np.clip(u * READ - 0.5, 0, READ - 1.001)
    y = np.clip(v * READ - 0.5, 0, READ - 1.001)
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    tx = x - x0
    ty = y - y0
    return (a[y0, x0] * (1 - tx) * (1 - ty) + a[y0, x0 + 1] * tx * (1 - ty) + a[y0 + 1, x0] * (1 - tx) * ty + a[y0 + 1, x0 + 1] * tx * ty)


# THE MATERIAL, one for all nine (one atlas)
mat = bpy.data.materials.new('shellset')
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
bsdf = nodes['Principled BSDF']
col = nodes.new('ShaderNodeTexImage')
col.image = load('Color', False)
links.new(col.outputs['Color'], bsdf.inputs['Base Color'])
rough = nodes.new('ShaderNodeTexImage')
rough.image = load('Roughness', True)
links.new(rough.outputs['Color'], bsdf.inputs['Roughness'])
nor = nodes.new('ShaderNodeTexImage')
nor.image = load('NormalGL', True)
nmap = nodes.new('ShaderNodeNormalMap')
links.new(nor.outputs['Color'], nmap.inputs['Color'])
links.new(nmap.outputs['Normal'], bsdf.inputs['Normal'])
for img in (col.image, rough.image, nor.image):
    img.scale(size, size)

shells = []
for cy in range(3):
    for cx in range(3):
        # the shell's footprint in its cell: where the opacity is over half
        u0, v0 = cx / 3, cy / 3
        i0, i1 = int(u0 * READ), int((u0 + 1 / 3) * READ)
        j0, j1 = int(v0 * READ), int((v0 + 1 / 3) * READ)
        cell = opacity[j0:j1, i0:i1] > 0.5
        js, iz = np.nonzero(cell)
        ua, ub = (i0 + iz.min() - 2) / READ, (i0 + iz.max() + 3) / READ
        va, vb = (j0 + js.min() - 2) / READ, (j0 + js.max() + 3) / READ
        span = max(ub - ua, vb - va)
        k = WIDTH / (ub - ua)
        us = np.linspace(ua, ua + span, GRID + 1)
        vs = np.linspace(va, va + span, GRID + 1)
        U, V = np.meshgrid(us, vs)
        D = sample(disp, U, V)
        O = sample(opacity, U, V)
        inside = D[O > 0.5]
        rim, top = np.percentile(inside, 4), np.percentile(inside, 99.5)
        Z = np.clip((D - rim) / (top - rim), 0, 1) * DOME * WIDTH
        cu, cv = (ua + ub) / 2, (va + vb) / 2
        bm = bmesh.new()
        uv = bm.loops.layers.uv.new('UVMap')
        verts = {}

        def vert(a: int, b: int):
            if (a, b) not in verts:
                verts[(a, b)] = bm.verts.new(((U[b, a] - cu) * k, (V[b, a] - cv) * k, Z[b, a]))
            return verts[(a, b)]

        for b in range(GRID):
            for a in range(GRID):
                # a quad is kept when its centre is inside the outline
                if sample(opacity, np.array((us[a] + us[a + 1]) / 2), np.array((vs[b] + vs[b + 1]) / 2)) < 0.5:
                    continue
                f = bm.faces.new((vert(a, b), vert(a + 1, b), vert(a + 1, b + 1), vert(a, b + 1)))
                for loop in f.loops:
                    p = loop.vert.co
                    loop[uv].uv = (p.x / k + cu, p.y / k + cv)
        # (a stray island of the cut — a speck of opacity apart from the shell — would be its own floating sliver)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
        me = bpy.data.meshes.new(f'shell_{len(shells)}')
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new(me.name, me)
        bpy.context.scene.collection.objects.link(ob)
        me.materials.append(mat)
        for p in me.polygons:
            p.use_smooth = True
        tris = len(me.polygons)
        if tris > budget:
            m = ob.modifiers.new('lod', 'DECIMATE')
            m.decimate_type = 'COLLAPSE'
            m.ratio = budget / tris
            m.use_collapse_triangulate = True
        shells.append((ob, tris))

bpy.ops.object.select_all(action='DESELECT')
for ob, _ in shells:
    ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_image_format='JPEG', export_jpeg_quality=88, export_apply=True)
print(f'[shell-export] {len(shells)} shells, {sum(t for _, t in shells)} -> <= {budget * len(shells)} triangles, maps {size}px -> {out}', flush=True)
