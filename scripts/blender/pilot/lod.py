"""
Stage 7 (lod): per-piece triangle targets for LOD0/1/2, merged to one skinned mesh per material.

  * Each piece is collapse-decimated to its target (X symmetry for the symmetric body pieces), its
    variant keys are re-bound from the undecimated source (nearest-surface barycentric), and its
    weights are limited to 4 influences and normalised.
  * Hair is never decimated (a decimated card is a torn card). LOD1 keeps a deterministic 36 % of
    the cards, widened to keep coverage; LOD2 is the scalp cap only.
  * Small pieces drop out where their silhouette no longer reads (pilot_config.json lod budget).
  * Per LOD, pieces with the same material are joined: Pilot_<slot>_LOD<n>. The three hair styles stay
    separate nodes (Hair_swept/bun/buzz_LOD<n>) so the runtime can pick one per variant.
"""
import math

import bmesh
import bpy
import numpy as np

import common as C
import meshops as M

# per piece: ('collapse' | 'islands', LOD0/1/2 triangle targets). 'islands' = UV-island-split collapse. Thin swept parts (straps, bands, rims, cables) and the vest grid have a thickness far
# below their ring spacing and many small UV islands: collapse merged their two faces into overlapping
# sheets, and both collapse and un-subdivide dragged UVs across island seams, so they sampled the
# buckle metal in the atlas (rendered as chrome). Splitting along UV islands before the collapse keeps both;
# their LOD0 is built at LOD0 resolution (target 99999 = as built).
# None = dropped at that LOD.
TARGETS = {
    'Skin': ('collapse', (2300, 900, 460)),
    'Eyes': ('collapse', (172, None, None)),
    'Suit': ('collapse', (2000, 880, 470)),
    'Gaiter': ('islands', (99999, 170, None)),
    'Gloves': ('collapse', (1800, 540, 200)),
    'Boots': ('collapse', (600, 260, 110)),
    'Vest': ('islands', (99999, 600, None)),
    'VestLow': ('islands', (None, None, 260)),
    'VestCollar': ('islands', (99999, 150, None)),
    'Goggles': ('islands', (99999, 420, 180)),
    'GoggleLenses': ('islands', (120, 60, None)),
    'Headset': ('islands', (900, 360, None)),
    'Bottle': ('islands', (300, None, None)),
    'Harness': ('islands', (1050, 420, 200)),
    'DashCable': ('islands', (99999, None, None)),
    'Brows': ('collapse', (140, 100, None)),
    'Lashes': ('collapse', (150, None, None)),
    'HairCap': ('islands', (99999, 200, 140)),
}
# pieces built from another piece's source at far LODs (a collapse of the vest is acceptable at LOD2
# distance, where the pilot is ~20 px tall and the merged faces cannot shade visibly)
ALIAS = {'VestLow': 'Vest'}
SYMMETRIC = {'Skin', 'Suit', 'Gloves', 'Boots', 'Vest', 'VestCollar', 'Harness', 'Eyes', 'Goggles', 'GoggleLenses', 'Gaiter'}
HAIR = ('Hair_swept', 'Hair_bun', 'Hair_buzz')


def split_uv_islands(ob):
    me = ob.data
    if not me.uv_layers:
        return  # untextured (the lens domes): nothing to protect
    uv = me.uv_layers[0]
    bm = bmesh.new()
    bm.from_mesh(me)
    lay = bm.loops.layers.uv[uv.name]
    seams = []
    for e in bm.edges:
        if len(e.link_faces) != 2:
            continue
        f0, f1 = e.link_faces
        same = True
        for v in e.verts:
            u0 = next(l[lay].uv for l in f0.loops if l.vert == v)
            u1 = next(l[lay].uv for l in f1.loops if l.vert == v)
            if (u0 - u1).length > 1e-5:
                same = False
                break
        if not same:
            seams.append(e)
    bmesh.ops.split_edges(bm, edges=seams)
    bm.to_mesh(me)
    bm.free()
    me.update()


def decimated(src, name, spec, symmetric):
    mode, target = spec
    ob = src.copy()
    ob.data = src.data.copy()
    ob.name = name
    ob.data.name = name
    C.link(ob)
    ob.parent = src.parent
    if ob.data.shape_keys:
        base = M.get_key(ob, 'Basis')
        ob.shape_key_clear()
        C.set_coords(ob, base)
    for m in list(ob.modifiers):
        ob.modifiers.remove(m)
    tris = C.tri_count(ob)
    if mode == 'islands' and target < tris:
        # split along UV island borders so collapse can neither drag UVs across islands nor fold a
        # strap's top face onto its bottom face (they are different islands), then weld back
        split_uv_islands(ob)
        mod = ob.modifiers.new('dec', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = target / tris
        mod.use_collapse_triangulate = True
        C.select_only([ob])
        bpy.ops.object.modifier_apply(modifier=mod.name)
        M.weld(ob, 2e-4)
    elif mode == 'collapse' and target < tris:
        mod = ob.modifiers.new('dec', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = target / tris
        mod.use_symmetry = symmetric
        mod.symmetry_axis = 'X'
        mod.use_collapse_triangulate = True
        C.select_only([ob])
        bpy.ops.object.modifier_apply(modifier=mod.name)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method='BEAUTY', ngon_method='EAR_CLIP')
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.validate(clean_customdata=False)
    if src.data.shape_keys:
        M.transfer_variant_keys(src, ob)
    return ob


def hair_lod(src, name, keep, widen, rng_seed):
    """keep a deterministic subset of cards (each card = a connected strip), widened about its spine"""
    ob = src.copy()
    ob.data = src.data.copy()
    ob.name = name
    ob.data.name = name
    C.link(ob)
    ob.parent = src.parent
    for m in list(ob.modifiers):
        ob.modifiers.remove(m)
    shapes = M.all_shapes(ob)
    ob.shape_key_clear()
    C.set_coords(ob, shapes['Basis'])
    me = ob.data
    n_faces = len(me.polygons)
    loops = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get('vertex_index', loops)
    # cards were emitted as consecutive vertex runs: card id from connectivity
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    card = -np.ones(len(bm.verts), dtype=np.int64)
    cid = 0
    for v in bm.verts:
        if card[v.index] >= 0:
            continue
        stack = [v]
        card[v.index] = cid
        while stack:
            cur = stack.pop()
            for e in cur.link_edges:
                o = e.other_vert(cur)
                if card[o.index] < 0:
                    card[o.index] = cid
                    stack.append(o)
        cid += 1
    rng = np.random.default_rng(rng_seed)
    keep_cards = rng.uniform(size=cid) < keep
    drop = [v for v in bm.verts if not keep_cards[card[v.index]]]
    bmesh.ops.delete(bm, geom=drop, context='VERTS')
    bm.verts.ensure_lookup_table()
    kept_idx = np.nonzero(keep_cards[card])[0]
    bm.to_mesh(me)
    bm.free()
    for key, co in shapes.items():
        co = co[kept_idx]
        # widen: pairs (2 verts per ring) move apart about their midpoint
        c2 = co.reshape(-1, 2, 3) if len(co) % 2 == 0 else None
        if c2 is not None and widen != 1.0:
            mid = c2.mean(axis=1, keepdims=True)
            c2 = mid + (c2 - mid) * widen
            co = c2.reshape(-1, 3)
        shapes[key] = co
    C.set_coords(ob, shapes['Basis'])
    M.set_all_shapes(ob, shapes)
    return ob


def run(cfg, work, args):
    rep = C.load(work, 'stage_anim')
    rig = bpy.data.objects['PilotRig']
    deform = {b.name for b in rig.data.bones if b.use_deform} | {'Root'}
    root = bpy.data.objects.new('SB_Pilot', None)
    C.link(root)
    lods = []
    for level in range(3):
        g = bpy.data.objects.new(f'LOD{level}', None)
        C.link(g)
        g.parent = root
        g['lodLevel'] = level
        lods.append(g)
    sources = {o.name: o for o in bpy.data.objects if o.type == 'MESH'}
    missing = [k for k in TARGETS if ALIAS.get(k, k) not in sources]
    if missing:
        raise SystemExit(f'[pilot] lod: pieces missing {missing}')
    extra = [k for k in sources if k not in TARGETS and k not in HAIR]
    if extra:
        raise SystemExit(f'[pilot] lod: pieces without LOD targets {extra}')
    report = {'tris': [], 'pieces': {}}
    for level in range(3):
        per_mat = {}
        for name, (mode, tg) in TARGETS.items():
            if tg[level] is None:
                continue
            ob = decimated(sources[ALIAS.get(name, name)], f'{name}_L{level}', (mode, tg[level]), ALIAS.get(name, name) in SYMMETRIC)
            per_mat.setdefault(ob.data.materials[0].name, []).append(ob)
            report['pieces'].setdefault(name, [None, None, None])[level] = C.tri_count(ob)
        hair_nodes = []
        if level < 2:
            for hname in HAIR:
                src = sources[hname]
                h = hair_lod(src, f'{hname}_LOD{level}', 1.0 if level == 0 else 0.36, 1.0 if level == 0 else 1.55, 5 + level)
                hair_nodes.append(h)
        joined = []
        for slot, objs in sorted(per_mat.items()):
            j = M.join(objs, f'Pilot_{slot}_LOD{level}')
            joined.append(j)
        for ob in joined + hair_nodes:
            n_empty = M.limit_and_normalize(ob, 4, deform)
            if n_empty:
                raise SystemExit(f'[pilot] lod: {ob.name} has {n_empty} unweighted vertices')
            ob.parent = lods[level]
            ob['lodLevel'] = level
            if ob.name.startswith('Hair_'):
                ob['hairStyle'] = ob.name.split('_')[1]
            for m in list(ob.modifiers):
                ob.modifiers.remove(m)
            ob.modifiers.new('Armature', 'ARMATURE').object = rig
        tris = sum(C.tri_count(o) for o in joined)
        hair_t = {h.name: C.tri_count(h) for h in hair_nodes}
        worst = tris + (max(hair_t.values()) if hair_t else 0)
        report['tris'].append({'common': tris, 'hair': hair_t, 'worstVariant': worst})
        print(f'[pilot] lod{level}: {tris} tris common + hair {hair_t} -> worst variant {worst}')
    for o in sources.values():
        bpy.data.objects.remove(o, do_unlink=True)
    rig.parent = root
    sock = bpy.data.objects.new('PilotSeatSocket', None)
    C.link(sock)
    sock.parent = root
    C.purge()
    rep['lod'] = report
    C.save(work, 'stage_lod', rep)
