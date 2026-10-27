"""
The Drift's BlenderKit assets (palms, wood: the user's picks, 2026-10-27), fetched through the user's own
logged-in BlenderKit add-on and its running client (the GUI Blender starts it): each asset's data by its base
id, a download link from the client for the user's account, the .blend saved into
public/drift/pbr/blenderkit/<name>/ (gitignored: royalty-free models may be used in renders, not passed on).
The api key never leaves the add-on's own calls; nothing of it is printed or written.

  /Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/drift-blenderkit-fetch.py -- public/drift/pbr/blenderkit <base id> ...
"""

import json
import re
import sys
from pathlib import Path

import bpy
import requests

args = sys.argv[sys.argv.index('--') + 1:]
OUT = Path(args[0])
IDS = args[1:]
ADDON = 'bl_ext.user_default.blenderkit'
from importlib import import_module

client_lib = import_module(f'{ADDON}.client_lib')
utils = import_module(f'{ADDON}.utils')
global_vars = import_module(f'{ADDON}.global_vars')

prefs = bpy.context.preferences.addons[ADDON].preferences
scene_id = utils.get_scene_id()
server = getattr(global_vars, 'SERVER', 'https://www.blendkit.com')
OUT.mkdir(parents=True, exist_ok=True)
log = []
for base_id in IDS:
    r = requests.get(f'{server}/api/v1/search/', params={'query': f'asset_base_id:{base_id}'}, timeout=30)
    results = r.json().get('results', [])
    if not results:
        print(f'[bk-fetch] {base_id}: not found', flush=True)
        continue
    a = results[0]
    name = a.get('name', base_id)
    slug = re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_')[:48] or base_id
    info = {
        'base_id': base_id,
        'name': name,
        'type': a.get('assetType'),
        'license': a.get('license'),
        'free': a.get('isFree'),
        'author': (a.get('author') or {}).get('fullName'),
        'files': [f.get('fileType') for f in a.get('files', [])],
    }
    try:
        can, url, filename = client_lib.get_download_url(a, scene_id, prefs.api_key)
    except Exception as e:  # noqa: BLE001 — report and go on to the next
        info['error'] = f'get_download_url: {type(e).__name__}'
        can = False
    if can and url:
        dest = OUT / slug / filename
        dest.parent.mkdir(parents=True, exist_ok=True)
        # (the link is the account's own, signed and short-lived: fetched as it is)
        with requests.get(url, stream=True, timeout=(10, 600)) as resp:
            info['status'] = resp.status_code
            if resp.ok:
                with open(dest, 'wb') as fh:
                    for chunk in resp.iter_content(1 << 20):
                        fh.write(chunk)
        info['saved'] = str(dest) if dest.exists() else None
        info['bytes'] = dest.stat().st_size if dest.exists() else 0
    else:
        info.setdefault('error', 'cannot download (plan or licence)')
    log.append(info)
    print('[bk-fetch]', json.dumps(info), flush=True)
(OUT / 'fetched.json').write_text(json.dumps(log, indent=1))
