# The Drift: pipelines

Every process that builds the film's data, renders it and checks it, step by step, so that it can be redone on
another machine by a person or a Claude Code session. Paths are relative to the repo root. Each script's header is
the authority on its flags; this page says which to run, in what order, with which inputs, and where the output
lands.

Setting up another machine (Linux, Windows, a GPU check, moving the built data as one bundle, a render queue) is in
[RENDER-NODE.md](RENDER-NODE.md). The working rules and why they exist are in [WORKING-NOTES.md](WORKING-NOTES.md).

Written against the working tree of 2026-10-29. Some features used here (`dome.setFlat`, the sea's `reviewEye`,
`--depth 16`, the ProRes 4444 codec, x264 `mvrange=511`) were still uncommitted that day: on an older checkout they
are missing.

## Contents

1. [Tools](#1-tools)
2. [What the film loads, and what makes it](#2-what-the-film-loads-and-what-makes-it)
3. [Fetch the CC0 assets](#3-fetch-the-cc0-assets)
4. [BlenderKit models: palms and planks](#4-blenderkit-models-palms-and-planks)
5. [Decimate scans (headless Blender)](#5-decimate-scans-headless-blender)
6. [Leaf alpha](#6-leaf-alpha)
7. [Pack textures](#7-pack-textures)
8. [Bakes: clouds, cosmic web, galaxies, Earth, flock](#8-bakes-clouds-cosmic-web-galaxies-earth-flock)
9. [Every drift script, and which are obsolete](#9-every-drift-script-and-which-are-obsolete)
10. [Render](#10-render)
11. [The 8K 12-bit master](#11-the-8k-12-bit-master)
12. [Verify a master](#12-verify-a-master)
13. [Review](#13-review)

## 1. Tools

| tool | for | notes |
|---|---|---|
| Node (24 here) and `npm install` | the page, the render and review drivers | Playwright 1.63 and Vite 6 come from `package.json` |
| Google Chrome, installed | every headless job past the sea's start (~314 s) | Playwright's own Chromium fails to compile some sea shaders; pass `--channel chrome` (the review scripts default to it) |
| ffmpeg and ffprobe (9.0 here) | encoding, checks | libx264; ProRes on VideoToolbox on macOS |
| Python 3 venv | bakes, packing | `out/drift/data/.venv` (below) |
| Blender (5.1 here) | decimation, palm export | run headless: `-b`. macOS path `/Applications/Blender.app/Contents/MacOS/Blender`; elsewhere `blender` |
| Swift (Xcode command-line tools) | the macOS decode check | macOS only |

The Python venv, once per machine:

```sh
mkdir -p out/drift/data
python3 -m venv out/drift/data/.venv
out/drift/data/.venv/bin/pip install numpy pillow tifffile imagecodecs scipy   # scipy: the flock bake
```

Run every Python script with `-I` (isolated: no stray module next to a download is imported). The commands below
assume, from the repo root:

```sh
PY=out/drift/data/.venv/bin/python
B=/Applications/Blender.app/Contents/MacOS/Blender      # elsewhere: B=blender
```

## 2. What the film loads, and what makes it

All of it is gitignored: built or downloaded on each machine, or carried over in the asset bundle (RENDER-NODE.md).

| `public/drift/…` | read by | made by | size |
|---|---|---|---|
| `earth/` | `getTheDrift/earthMaps.ts` | `drift-earth-data.py` (§8) | ~136 MB |
| `web/` | `undertime/webVolume.ts` | `drift-web-volume.py` | ~28 MB |
| `galaxies/` | `getTheDrift/galaxies.ts` | `drift-galaxy-atlas.py` | ~1.4 MB |
| `clouds/` | `wandering/clouds.ts` | `drift-cloud-noise.py` | ~8 MB |
| `flock/` | `wandering/flock.ts` | `drift-flock-bake.py` | ~100 MB at 10 000 birds |
| `pbr/<asset>/` (scans, glTF, maps) | `wandering/*` | `drift-pbr-fetch.py` (§3) | ~1.2 GB of downloads |
| `pbr/<asset>/<asset>_lod.glb` | `forest.ts`, `groundDebris.ts`, `scannedRocks.ts` | `drift-tree-export.py`, `drift-rock-lod.py` (§5) | |
| `pbr/<asset>/<asset>_prop.glb` | `raftProps.ts` | `drift-prop-export.py` (§5) | |
| `pbr/<asset>/<asset>_float.glb` | `getTheDrift/debrisField.ts` (the flood's flotsam) | `drift-prop-export.py` (§5) | |
| `pbr/<tree>/textures/<tree>_leaves_{alpha,diff_bled}_2k.png` | `forest.ts` | `drift-leaf-alpha.py` (§6) | |
| `pbr/packed/*` | `beachMaterial.ts`, `raftLook.ts` | `drift-pbr-pack.py`, `drift-raft-pack.py` (§7) | |
| `pbr/blenderkit/<palm>/<palm>.glb` | `palms.ts` | `drift-blenderkit-fetch.py`, `drift-palm-export.py` (§4) | licence: not to be passed on |
| `pbr/planks/{diffuse,bump}.jpg` | `getTheDrift/debrisField.ts` | copied from a BlenderKit .blend (§4); no script | licence: not to be passed on |

Order: fetch (§3) before decimation (§5), leaf alpha (§6) and packing (§7); BlenderKit (§4) is separate. The bakes
(§8) need nothing but the venv and, for the Earth and the galaxies, their raw downloads.

## 3. Fetch the CC0 assets

Poly Haven (polyhaven.com) and ambientCG (ambientcg.com) scans and models, all CC0, listed in
`scripts/drift-pbr-assets.json`: one row per file, `[asset, path under the asset, url, bytes, md5]` (ambientCG rows
carry no md5). 44 assets, 225 files, ~1.2 GB.

```sh
python3 -I scripts/drift-pbr-fetch.py scripts/drift-pbr-assets.json public/drift/pbr
# ambientCG ships zips: unpack each next to itself
for z in public/drift/pbr/*/*_4K-JPG.zip; do unzip -oq "$z" -d "$(dirname "$z")"; done
```

- Output: `public/drift/pbr/<asset>/<path>`. A file already there at its listed size is skipped, so a rerun only
  fetches what is missing. Each file arrives as `.part` and is renamed only when its size (and md5) match.
- The last line is `done <n> ok <m> bad`. Any `MISMATCH` line is a failed file: rerun.
- **Adding an asset**: append its files' rows. Poly Haven's file API (`https://api.polyhaven.com/files/<asset>`)
  lists each file's url, size and md5; take the 2k glTF and its `include` files for models, the 4k maps for
  surfaces. Then wire it in the module that reads it.

## 4. BlenderKit models: palms and planks

The palms (and the debris planks) are BlenderKit models picked by the user on 2026-10-27. Most are royalty-free,
not CC0: they may be used in renders but **may not be redistributed**, so they stay out of git and out of any shared
bundle that leaves the team.

**Fetch** through the user's own BlenderKit account: Blender's BlenderKit add-on must be installed and logged in,
and its client running (opening the GUI Blender with the add-on starts it). The API key never leaves the add-on.

```sh
"$B" -b -P scripts/drift-blenderkit-fetch.py -- public/drift/pbr/blenderkit <base id> [<base id> ...]
```

Output: `public/drift/pbr/blenderkit/<name>/blend_<uuid>.blend` and `fetched.json` (this run's assets: name,
licence, author, file). The ids used, from the last `fetched.json`:

| base id | name | used as |
|---|---|---|
| `f9c65ca8-8ad7-4b2b-80c1-b3634862da1d` | Palm Tree Medium Dense (CC0) | `palm_tree_medium_dense` |
| `b549671d-9836-4f62-a269-1a3a85902247` | Palm Tree | `palm_tree` |
| `1922ff7e-7b7b-4de9-8649-cb1425b0ffe8` | Bent Palm v1 | `bent_palm_v1` |
| `7a216a19-0bcb-43cc-8d9e-02815496358a` | Palm Pritchardia Pacifica Small | `palm_pritchardia_pacifica_small` |
| `e8089f30-33a7-4a22-9534-fafb6ae92fa3` | PBR Wooden Planks | `planks/` (debris wood) |
| `f755592f-ed51-4d7a-815f-209121d18a64`, `1f9b15c5-1ab0-445c-bc51-59d24dc5c4d9` | Palm Tree 01, Grass | fetched, not used |

**Export** each palm as one .glb (textures embedded, modifiers applied), decimated to a budget where `palms.ts`
says so:

```sh
P=public/drift/pbr/blenderkit
"$B" -b $P/palm_tree_medium_dense/blend_*.blend -P scripts/drift-palm-export.py -- $P/palm_tree_medium_dense/palm_tree_medium_dense.glb
"$B" -b $P/palm_tree/blend_*.blend -P scripts/drift-palm-export.py -- $P/palm_tree/palm_tree.glb
"$B" -b $P/bent_palm_v1/blend_*.blend -P scripts/drift-palm-export.py -- $P/bent_palm_v1/bent_palm_v1.glb 120000
"$B" -b $P/palm_pritchardia_pacifica_small/blend_*.blend -P scripts/drift-palm-export.py -- $P/palm_pritchardia_pacifica_small/palm_pritchardia_pacifica_small.glb 40000
```

**Planks**: `public/drift/pbr/planks/diffuse.jpg` and `bump.jpg` are the PBR Wooden Planks .blend's colour and bump
maps, copied out of it. No script does this yet; `debrisField.ts` reads the two broad planks at fixed uv rectangles
of that atlas.

## 5. Decimate scans (headless Blender)

The scans are far too dense for a forest edge, a beach of debris or a raft of props. Each script imports a glTF,
collapses it to a triangle budget (only if it is over it) and writes one .glb beside the source. Inputs are Poly
Haven's 2k glTFs, `public/drift/pbr/<asset>/<asset>_2k.gltf`.

**Trees, shrubs and ground debris**, `scripts/drift-tree-export.py -- <in.gltf> <out.glb> <budget> [planar°]`.
The budgets the current files were made with:

```sh
while read a n; do
  "$B" -b -P scripts/drift-tree-export.py -- public/drift/pbr/$a/${a}_2k.gltf public/drift/pbr/$a/${a}_lod.glb $n
done <<'EOF'
island_tree_01 90000
island_tree_02 80000
island_tree_03 90000
tree_small_02 90000
pachira_aquatica_01 24000
root_cluster_01 24000
single_root 9000
dead_tree_trunk_02 16000
dead_tree_trunk 14000
bark_debris_01 14000
dry_branches_medium_01 30000
shrub_02 30000
shrub_03 30000
EOF
```

(The last three are under any budget and are exported as they are.) The trees' `_lod.glb` is only their far
version: within a few tens of metres `forest.ts` draws the full 1–2M-triangle scan, because collapsed leaves went to
flickering shards (the 2026-10-29 review). The optional `planar°` argument first merges each flat leaf's triangles
into one outline (a planar dissolve) and collapses only if still over the budget; tried at 12° on `island_tree_01`
it took 1.6M triangles to 1.18M, not far enough, and is not used for the current files.

**Raft props**, `scripts/drift-prop-export.py -- <in.gltf> <out.glb> <budget> [map px, default 1024]`: also cuts
the maps to 1024 px (a 0.8 m crate seen from 5 m fills ~300 px of a 1920 frame).

```sh
while read a n; do
  "$B" -b -P scripts/drift-prop-export.py -- public/drift/pbr/$a/${a}_2k.gltf public/drift/pbr/$a/${a}_prop.glb $n 1024
done <<'EOF'
Barrel_02 8000
wooden_crate_01 8000
wooden_crate_02 8000
metal_jerrycan_green 6000
lifebuoy 6000
wicker_basket_02 9000
pot_enamel_01 5000
wooden_bowl_02 4000
metal_jug 4000
wooden_spoon 2500
EOF
```

**The flood's floating debris** (`getTheDrift/debrisField.ts`: thousands of pieces round the raft, seen from metres
away): the same script, small budgets and 512 px maps, written as `<asset>_float.glb`:

```sh
while read a n; do
  "$B" -b -P scripts/drift-prop-export.py -- public/drift/pbr/$a/${a}_2k.gltf public/drift/pbr/$a/${a}_float.glb $n 512
done <<'EOF'
dead_tree_trunk 500
dead_tree_trunk_02 700
Barrel_02 300
wooden_crate_01 400
wooden_crate_02 400
lifebuoy 400
metal_jerrycan_green 400
EOF
```

and the people's things added for it (Poly Haven CC0, fetched at 1k: their inputs are `${a}_1k.gltf`):

```sh
while read a n; do
  "$B" -b -P scripts/drift-prop-export.py -- public/drift/pbr/$a/${a}_1k.gltf public/drift/pbr/$a/${a}_float.glb $n 512
done <<'EOF'
plastic_monobloc_chair_01 500
old_tyre 500
ocean_buoy 800
plastic_crate_01 1500
plastic_jerrycan 400
industrial_pastic_container 400
rollershutter_door 400
wooden_picnic_table 600
cardboard_box_01 300
vintage_suitcase 400
EOF
```

**Rocks**, `scripts/drift-rock-lod.py` (its two rocks and budgets are in the script; the 4k glTFs):

```sh
"$B" -b --factory-startup -P scripts/drift-rock-lod.py -- public/drift/pbr
```

Only the `?sea` test act places these rocks; the show's coast does not.

Each run prints `[tree-export]`, `[prop-export]` or `[rock-lod]` with the triangle counts before and after.

### Beach dressing (pebbles, shells, wrack): `src/drift/wandering/beachDressing.ts`

The coast's pebbles, conch, scallops and wrack-line leaves, twigs and sticks are CC0 scans (Poly Haven: `lambis_shell`,
`dead_quiver_branch_01`, `dry_quiver_leaf`, plus `namaqualand_boulder_05` and `dry_branches_medium_01` above; ambientCG
`ShellSet001`), cut down to beach props. Arguments: input glTF, output `.glb`, triangle budget, texture size (px).

```sh
P=public/drift/pbr
"$B" -b --factory-startup -P scripts/drift-prop-export.py -- $P/namaqualand_boulder_05/namaqualand_boulder_05_4k.gltf $P/namaqualand_boulder_05/namaqualand_boulder_05_pebble.glb 120 256
"$B" -b --factory-startup -P scripts/drift-prop-export.py -- $P/namaqualand_boulder_05/namaqualand_boulder_05_4k.gltf $P/namaqualand_boulder_05/namaqualand_boulder_05_beach.glb 300 512
"$B" -b --factory-startup -P scripts/drift-prop-export.py -- $P/dead_quiver_branch_01/dead_quiver_branch_01_2k.gltf $P/dead_quiver_branch_01/dead_quiver_branch_01_beach.glb 500 512
"$B" -b --factory-startup -P scripts/drift-prop-export.py -- $P/dry_quiver_leaf/dry_quiver_leaf_2k.gltf $P/dry_quiver_leaf/dry_quiver_leaf_beach.glb 400 512
"$B" -b --factory-startup -P scripts/drift-prop-export.py -- $P/dry_branches_medium_01/dry_branches_medium_01_2k.gltf $P/dry_branches_medium_01/dry_branches_medium_01_beach.glb 1200 512
"$B" -b --factory-startup -P scripts/drift-prop-export.py -- $P/lambis_shell/lambis_shell_2k.gltf $P/lambis_shell/lambis_shell_beach.glb 1500 1024
# the nine ShellSet001 scallops cut into real meshes (outline from the opacity map, dome from the displacement)
"$B" -b --factory-startup -P scripts/drift-shell-export.py -- $P/ShellSet001 $P/ShellSet001/shellset_beach.glb 160
```

No coral scan exists in either CC0 library: the "coral" pebbles are the boulder scan tinted cream/white/grey/pink, the
coral fingers the quiver branch tinted bone-white (the `KINDS` table in `beachDressing.ts`).

## 6. Leaf alpha

The island trees' leaf maps are leaves on black with no alpha. Cut by brightness in the shader, every mip averaged
the leaf with the black: dark fringes and black specks in the crowns (the 2026-10-29 review). This writes a real
alpha and a copy of the colour with the leaf bled out over the black. Run after the fetch:

```sh
$PY -I scripts/drift-leaf-alpha.py public/drift/pbr island_tree_01 island_tree_02 island_tree_03 tree_small_02
```

Input `public/drift/pbr/<tree>/textures/<tree>_leaves_diff_2k.jpg`; output `<tree>_leaves_alpha_2k.png` and
`<tree>_leaves_diff_bled_2k.png` beside it. It prints the leaf share per tree (25 %, 25 %, 25 %, 55 % for these).

## 7. Pack textures

Each surface's maps go into two RGBA textures, so the beach's five layers fit the 16 textures a WebGPU fragment
stage may sample.

```sh
$PY -I scripts/drift-pbr-pack.py public/drift/pbr                            # the beach (needs the ambientCG unzip)
$PY -I scripts/drift-raft-pack.py public/drift/pbr public/drift/pbr/packed   # the film raft's scans
```

- Beach: `public/drift/pbr/packed/<layer>_albedo_rough.png` and `<layer>_normal_ao_h.png` for `sand_dry`
  (ambientCG Ground027), `sand_wet` (Ground061), `rock`, `forest_floor`, `grass` (Poly Haven). Prints each layer's
  albedo luminance and roughness.
- Raft: `public/drift/pbr/packed/raft_<scan>_albedo_rough.webp` and `raft_<scan>_normal_ao_h.webp` for four scans
  at 1024², the height stretched to the full range. It prints each scan's linear mean colour and roughness: copy
  them into `SCANS` in `src/drift/wandering/raftLook.ts` when a scan changes.
- (`scripts/raft-scan-pack.py` is the game's raft pack, not the film's.)

## 8. Bakes: clouds, cosmic web, galaxies, Earth, flock

Every bake is seeded and writes into `public/drift/<name>/`. Rerunning one replaces what the film loads; back the old
output up first if you are experimenting.

**Cloud noise** (Nubis-style tileable 3D noise for the ray-marched cumulus):

```sh
$PY -I scripts/drift-cloud-noise.py public/drift/clouds
```

Output `cloud-shape-128.u8` (128³ RGBA) and `cloud-detail-32.u8` (32³). Every channel is rank-transformed to a
uniform distribution, so the shader's coverage is a direct dial.

**Cosmic web** (Zel'dovich approximation on a 256³ lattice, Act 1's web and Act 2's galaxy positions):

```sh
$PY -I scripts/drift-web-volume.py public/drift/web
# shape: WEB_SLOPE (−2.3), WEB_TRUNCATE (1.6 cells), WEB_DISPLACE (9 cells) in the environment
```

Output `web-256.u8`, `web-64.u8`, `web-particles.u16`, `web-knots.json` (the density peaks: first stars and
galaxies sit there), two preview PNGs. Changing it moves every galaxy of Act 2.

**Galaxy atlas** (32 Hubble galaxies in 512 px tiles):

```sh
$PY -I scripts/drift-galaxy-atlas.py out/drift/data/raw/galaxies public/drift/galaxies
```

Input: the images and `sources.json` in `out/drift/data/raw/galaxies/` (`[{kind, file, title, source, licence,
credit, w, h}]`, Wikimedia Commons / ESA Hubble, public domain or CC BY). That folder is not in the repo. The built
`galaxy-atlas.json` keeps every galaxy's title, source URL, licence and credit, so the list can be rebuilt from it.
Output `galaxy-atlas.jpg` and `galaxy-atlas.json`.

**Earth maps**: sources, licences, the four levels (global, region, near, inset) and the rebuild are in
[earth-data.md](earth-data.md). The raw files go in `out/drift/data/raw/`: the Blue Marble and Black Marble files
under the names the script reads (listed in earth-data.md), `cloud_combined_8192.tif`, the VIIRS day saved as
`wv/viirs_2023-09-08_7000.jpg`, the terrain tiles as `terrarium/<z>_<x>_<y>.png` (all 256 tiles of zoom 4, zoom 7
x 55–80, y 30–57 (728 tiles); for the near level and the inset zoom 9 and 11, and the inset's Sentinel-2 cloudless
tiles as `s2cloudless/11_<row>_<col>.img`: the loops are in earth-data.md, "Downloads"). After a rebuild, publish
the maps to the render boxes with `node scripts/drift-bundle.mjs --manifest-only`:

```sh
mkdir -p out/drift/data/raw/terrarium && cd out/drift/data/raw/terrarium
T=https://s3.amazonaws.com/elevation-tiles-prod/terrarium
for x in $(seq 0 15); do for y in $(seq 0 15); do curl -fsS -o 4_${x}_${y}.png $T/4/$x/$y.png; done; done
for x in $(seq 55 80); do for y in $(seq 30 57); do curl -fsS -o 7_${x}_${y}.png $T/7/$x/$y.png; done; done
cd - && $PY -I scripts/drift-earth-data.py out/drift/data/raw public/drift/earth
```

**Flock** (the sandpipers of w4: a murmuration model, 10 000 birds over 75 s, keyed at 15 Hz). The header is the
history of seven bakes and what each review asked for.

```sh
$PY -I scripts/drift-flock-bake.py public/drift/flock               # the film's flock: 10 000 birds
FLOCK_N=1500 $PY -I scripts/drift-flock-bake.py public/drift/flock  # a quick look while tuning
```

Output `flock-keys.f16` (~100 MB at 10 000 birds), `flock-keys.json` (birds, keys, rate, texture layout) and
`flock-preview.png` (a contact sheet of the flight). The film reads only `public/drift/flock/`, so a `FLOCK_N` test
replaces the film's flock: copy the old keys aside first and rebake at the full count when done. It prints the
flock's state every few seconds (flying, nearest-neighbour distance, polarisation) and, at the end, its altitude
range.

## 9. Every drift script, and which are obsolete

| script | status |
|---|---|
| `drift-pbr-fetch.py` + `drift-pbr-assets.json` | current (§3) |
| `drift-blenderkit-fetch.py`, `drift-palm-export.py` | current (§4) |
| `drift-tree-export.py`, `drift-prop-export.py` | current (§5) |
| `drift-rock-lod.py` | current, but only the `?sea` test act uses its rocks (§5) |
| `drift-leaf-alpha.py` | current (§6) |
| `drift-pbr-pack.py`, `drift-raft-pack.py` | current (§7) |
| `drift-cloud-noise.py`, `drift-web-volume.py`, `drift-galaxy-atlas.py`, `drift-earth-data.py`, `drift-flock-bake.py` | current (§8) |
| `drift-render.mjs` (+ `cine-sink.mjs`, one sink per lane) | current (§10, §11) |
| `drift-queue.mjs` + `drift-render-queue.example.jsonc` | current: the resumable, chunked render queue (§10, §11; RENDER-NODE.md) |
| `drift-node.mjs` (+ `drift-node-lib.mjs`, `drift-node-presets.jsonc`) | current: a render node's one command — sync (pull, npm ci, the bundle from the Mac over SSH, GPU check) and render a preset or queue, with a heartbeat to the dashboard: RENDER-NODE.md |
| `drift-gpu-check.mjs`, `drift-chrome.mjs`, `drift-bundle.mjs`, `drift-node-setup.{sh,ps1}`, `cine-codecs.mjs` | current: render nodes (GPU self-test, browser launch, data bundles, setup, off-Mac codecs): RENDER-NODE.md |
| `drift-review-stills.mjs`, `drift-review-clip.mjs` (+ `drift-review-page.mjs`, shared) | current (§13) |
| `drift-seat-view.py` | current: a master clip as one Horizon 18 seat sees it (§13) |
| `drift-stills.mjs` | superseded for reviews: screenshots of the live dome preview, not the recorder's frames. Use `drift-review-stills.mjs --dome` |
| `cine-mux.mjs`, `raft-scan-pack.py`, `asset-build.mjs`, `scripts/resolve/`, `scripts/blender/` | the game's, not the film's |

The ad-hoc review tools of October 2026 (a tone-map probe and a perspective-only still script in a session's
scratch folder) are obsolete and were not brought into the repo.

## 10. Render

`scripts/drift-render.mjs` renders the dome master with N headless pages on the GPU (lanes), each into its own clip,
joined without re-encoding. In depth, with the measured rates and the machine guards: [../cine/drift-render.md](../cine/drift-render.md).
The flags, from the script's header:

| flag | default | |
|---|---|---|
| `--size` / `--fps` | 2048 / 30 | the square master, px; frame rate |
| `--from` / `--to` | 0 / the show's end | show time, s (`__drift.total` is the end) |
| `--lanes` | 2 | more than 2 needs `--allow-lanes` |
| `--codec` | `x264` | `x264` → .mp4 (8-bit 4:2:0); `prores` / `proreshq` → .mov ProRes 422 HQ (10-bit 4:2:2); `prores4444` → .mov ProRes 4444 (12-bit 4:4:4). Other machines' codecs: RENDER-NODE.md |
| `--depth` | 8 | `16`: 16 bits a channel from page to encoder, ProRes only. An 8-bit capture bands the night sky in any codec, so the 10- and 12-bit masters need it |
| `--ss` | 1 | cube-face supersampling, linear. Faces are also 4× MSAA by default (engine-findings §11). With MSAA: `--ss 2` at 2048², `1.5` at 4096², `1.25` at 8192² (about 23.5 GB peak on the M3 Max; `1` + MSAA if memory is short). `--ss 2` + MSAA at 8192² does not fit in 36 GB |
| `--msaa` | 4 | the faces' MSAA samples: `0` turns it off (less GPU memory; the 8K master on a 24 GB card, RENDER-NODE.md). Queue job field `msaa` |
| `--blur` / `--shutter` | 1 / 0.5 | motion-blur sub-frames a frame (the header suggests 8 for masters; it costs ~8×) and the shutter's share of a frame |
| `--channel` | `chromium` | pass `chrome` for anything from the sea on |
| `--crf` / `--preset` | 18 / medium | x264 |
| `--out` | `out/drift/undertime_<size>_<from>-<to>s.<ext>` | (the name says Undertime; it is the whole show) |
| `--port` | 5288 | the render's own Vite server |
| `--query` | | extra drift.html query, e.g. `sea` |
| `--keep`, `--inflight`, `--queue` | | keep lane clips; frames in flight; sink queue |

A preview, after the user asks for one (previews are x264):

```sh
npm run drift:render -- --size 1024 --fps 30 --lanes 2 --preset veryfast --crf 22 --channel chrome
```

A range: add `--from <s> --to <s>`. One frame at a cut's size, for a point-like element (one frame is
`--to` = `--from` + 1/30 s): `npm run drift:render -- --size 2160 --from 400 --to 400.034 --channel chrome`.

**Long renders go through the render queue**, `scripts/drift-queue.mjs` (written up in
[RENDER-NODE.md](RENDER-NODE.md), "Queue renders"; it runs on the Mac as well as on a node). It splits a job into
chunks of `chunk` seconds of show time, each one `drift-render.mjs` run with its own file, so a stall or a sleep
costs one chunk, not the night. A finished chunk with the right frame count and settings is skipped on a rerun, a
failed one is retried, and the chunks are joined (or kept apart with `"concat": false`). It refuses to start on
battery and keeps the machine awake. Pick `chunk` so one chunk renders in about 25 minutes.

```sh
cp scripts/drift-render-queue.example.jsonc render-queue.jsonc     # then edit the jobs
node scripts/drift-queue.mjs --dry-run                             # what would render, what is done
node scripts/drift-queue.mjs --only <job>
```

A job is `name`, `from`, `to` (show seconds; the show ends at `__drift.total`, 770 s on 2026-10-29) and `size`, plus
any of the render's settings (`fps ss blur shutter codec depth lanes chunk channel crf preset out concat`). The 4K
x264 cut of 2026-10-28 was 4096², ss 1.5, crf 18 veryfast, two lanes, in four chunks.

## 11. The 8K 12-bit master

Only on the user's go. ProRes 4444, 12-bit 4:4:4, from a 16-bit capture, one lane, in short chunks. On the Mac a
queue job renders it directly (VideoToolbox is the only 12-bit ProRes encoder):

```jsonc
{ "name": "film_8k_12bit_mac", "from": 0, "to": 770, "size": 8192, "ss": 1.5, "codec": "prores4444", "depth": 16,
  "lanes": 1, "chunk": 5, "concat": false, "out": "out/drift/masters" }
```

Each chunk of it is this render (the output folder must exist: the render's disk check reads it):

```sh
node scripts/drift-render.mjs --size 8192 --fps 30 --codec prores4444 --depth 16 --channel chrome --lanes 1 --ss 1.25 \
  --from <s> --to <s> --out out/drift/masters/<file>.mov
```

On a Linux or Windows node the master is rendered as lossless 12-bit FFV1 and converted to ProRes 4444 on the Mac:
[RENDER-NODE.md](RENDER-NODE.md), "The 12-bit ProRes 4444 master" (its example job, `film_8k_12bit`, also sets
`"blur": 8`).

What is known about the cost on the Mac, from a benchmark on an M3 Max with 36 GB (2026-10-28, one page, 8192² at
ss 2, 8-bit frames, a fresh page per spot):

| show time | 40 s (Act 1) | 170 s (Act 2) | 300 s (the landing) | 430 s (at sea) | 560 s, 690 s (the coast) |
|---|---|---|---|---|---|
| s a frame | 0.48 | 4.5 | GPU device lost | 3.2 | 1.7–1.8 |

- At the Act 2 and sea rates the show's 23 100 frames take 20–29 h on one lane; budget a day or more.
- The page took nearly all 36 GB of RAM, and the GPU device was lost at one spot (and, in a run that reused one page
  for every spot, at the second spot and then for the rest). Run nothing else on the machine and keep chunks short;
  ss 1.5 needs less memory than the benchmark's ss 2.
- ProRes 4444 at 8192² measured ~28 MiB a frame on a coast frame (black frames are far smaller), so up to ~630 GiB
  for the show. The render's disk check asks for twice a chunk plus 20 GB free.
- Motion blur (`blur` 8) multiplies the time by about 8: settle it with the user before starting.

## 12. Verify a master

Every master, before it is handed over:

1. **Frame count.** `drift-render.mjs` checks each lane clip and the joined file, and `drift-queue.mjs` each chunk
   and the join; both fail on a mismatch. For a file joined by hand:
   `ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 <file>`
   must equal `round((to − from) × fps)`.
2. **ffmpeg decodes it**: `ffmpeg -v error -i <file> -f null -` prints nothing. Necessary, not sufficient.
3. **macOS decodes it.** The user edits in DaVinci on a Mac, which decodes with VideoToolbox. A 4096² x264 master
   that passed every ffmpeg check went "media offline" in DaVinci for 11 s: VideoToolbox fails on vertical motion
   vectors beyond ±512 px, which x264 allows at that size (fixed since by `mvrange=511` in `cine-sink.mjs`). Decode
   every 250-frame window with AVFoundation; any `BAD` line is a broken master:

```swift
// vtgops.swift — swift vtgops.swift <file> [fps]: decode each 250-frame window with AVFoundation, print the failures
import AVFoundation
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let fps = CommandLine.arguments.count > 2 ? Int32(CommandLine.arguments[2])! : 30
let asset = AVURLAsset(url: url)
let track = asset.tracks(withMediaType: .video)[0]
let total = asset.duration.seconds
var g = 0, bad = 0
while Double(g * 250) / Double(fps) < total - 0.01 {
  let reader = try! AVAssetReader(asset: asset)
  reader.timeRange = CMTimeRange(start: CMTime(value: CMTimeValue(g * 250), timescale: fps), duration: CMTime(value: 250, timescale: fps))
  let out = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
  out.alwaysCopiesSampleData = false
  reader.add(out); reader.startReading()
  var n = 0, last = -1.0
  while let sb = out.copyNextSampleBuffer() { last = CMSampleBufferGetPresentationTimeStamp(sb).seconds; n += 1 }
  if reader.status != .completed { bad += 1; print(String(format: "BAD window %d [%.2f s] frames %d last %.3f", g, Double(g * 250) / Double(fps), n, last), reader.error ?? "") }
  g += 1
}
print("windows \(g) bad \(bad)")
```

4. **For the 12-bit master**: `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt,width,height -of csv=p=0 <file>`
   shows ProRes 4444 at the size rendered. Look at a night frame for banding.
5. **In the dome**: play a few chunks in studio-world's Horizon 18 venue (`../studio-world`, venue `dome-h18`; its
   fisheye mapping is the exact inverse of the capture), or reproject one seat's view (§13).

## 13. Review

What the user is shown for review is a **16:9 rectilinear view** of the focus zone, drawn by the film's own pipeline
(faces, AO, bloom, grade) with `dome.setFlat`, not the fisheye master. The master view is for when the point is the
whole scene at once. Stills for looks; short clips for motion and flicker. Limits: clips at most ~30 s and 1280×720
without the user's go (the clip script enforces both).

**Pick the times.** Run `npm run dev` and scrub `drift.html` (the HUD shows the beat and show time), or read the beat
starts in [STATUS.md](STATUS.md). Times are show seconds.

**Stills.** Write a shot list, then run it (640 or 1280 wide for most reviews):

```json
[
  { "name": "shore_545", "t": 545, "fov": 50, "pitch": -8 },
  { "name": "zenith_700", "t": 700, "fov": 90, "pitch": 60 },
  { "name": "raft_chase_400", "t": 400, "fov": 55, "mode": "chase", "back": 9, "side": -3, "up": 2.2 },
  { "name": "raft_aim_400", "t": 400, "fov": 40, "mode": "aim" },
  { "name": "beach_low_600", "t": 600, "fov": 70, "eye": { "dx": 4, "y": 0.6, "yaw": 30 } }
]
```

```sh
node scripts/drift-review-stills.mjs shots.json --width 1280                # → out/drift/review/shots/<name>.png
node scripts/drift-review-stills.mjs shots.json --width 1024 --dome         # the dome master of the same times
node scripts/drift-review-stills.mjs shots.json --setup 'd.params.seaAo = 0' --out out/drift/review/no_ao   # an A/B
node scripts/drift-review-stills.mjs shots.json --query raftplain           # the game's undressed raft
```

- `fov` is the full angle of the square frame the 16:9 view is cut from (deg, default 60); `yaw` (+ left) and `pitch`
  (+ up) aim it from the eye's front, in degrees. The audience's focus zone is ahead, 20–40° up.
- `eye` moves the show's eye (dx, dz m added; y m above the sea; yaw deg added; pitch deg). `mode: "aim"` turns the
  show's eye to the raft; `mode: "chase"` puts the eye `back` m astern, `side` m to the right, `up` m above the sea,
  looking at the raft (+ `ahead` m). Both work only in the sea's scene (from ~314 s); in Acts 1–2 the script warns
  and uses the show's eye. Each still's line prints the raft's pose (x, z m, heading deg) to frame against.
- Faces are supersampled automatically to 2 face texels per output pixel, capped at 4096 px faces (`flatSupersample`), and
  multisampled (4× MSAA); `--ss` overrides. In the 16:9 view each face is scissored to its own frustum, so this is cheap.
- `--post '<js>'` runs a probe after each shot and prints its result, e.g. `--post 'return d.sea.exposure'`.
  (`d.t` is the idle preview's time, not the shot's.)
- The full reference is each script's header and `scripts/drift-review-page.mjs`.

**Clips.**

```sh
node scripts/drift-review-clip.mjs --from 540 --to 548 --width 1280 --shot '{"fov":50,"pitch":-8}'
node scripts/drift-review-clip.mjs --from 395 --to 405 --shot '{"fov":55,"mode":"chase","back":9,"side":-3,"up":2.2}'
node scripts/drift-review-clip.mjs --from 690 --to 700 --width 1024 --dome
```

Output `out/drift/review/clip_<from>-<to>s[_dome].mp4` (or `--out`): H.264 crf 16, 8-bit 4:2:0, which QuickTime and
DaVinci read. It is written as `.part` and renamed only when the received and encoded frame counts both equal
`round((to − from) × fps)`.

**Rules for both.**

- One browser job at a time on a machine; both scripts refuse while a render holds `out/drift/.render.lock`. Each
  starts its own Vite server (stills `--port 5361`, clips `--port 5362`; strict) with no watcher and no HMR.
- They default to `--channel chrome`. Without Chrome installed, `--channel chromium` draws Acts 1–2 correctly but
  breaks the sea.
- Point-like elements (stars, birds, glints) can look right small and wrong at the cut's size: check one frame at the
  cut's size (§10) before concluding anything.
- Judge at more than one time of day where light matters.

**From a seat.** To check horizon lines, the limb and comfort from where people sit, reproject a dome-master clip
(rendered with `drift-render.mjs`) into one Horizon 18 seat's view:

```sh
$PY -I scripts/drift-seat-view.py out/drift/<master>.mp4 out/drift/seat_row5.mp4 --row 5 --seat 0 --eye-level
```

**Sending it.** Name files by subject and show time (`shore_545.png`), say the time and the view (fov, aim, eye) of
each, and pair before/after at the same time and view. Record what the user says in the open-notes file in
`../drift-narrative/wandering-on/` (the live list; [STATUS.md](STATUS.md) points to it).
