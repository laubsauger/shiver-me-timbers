"""
The Drift's sea-level PBR assets (Act 3's beach, rocks, ground and low plants): CC0 photogrammetry scans and
models from Poly Haven (polyhaven.com, CC0) and ambientCG (ambientcg.com, CC0), downloaded by the list in
scripts/drift-pbr-assets.json — [asset, path, url, bytes, md5] — into public/drift/pbr/<asset>/ (gitignored).
Sizes and Poly Haven's md5s are checked; a file already there at its size is skipped. ambientCG's zips are
unpacked by the caller.

  python3 -I scripts/drift-pbr-fetch.py scripts/drift-pbr-assets.json public/drift/pbr
"""
import json, hashlib, os, sys, urllib.request
plan = json.load(open(sys.argv[1]))
root = sys.argv[2]
ok = bad = 0
for asset, rel, url, size, md5 in plan:
    dest = os.path.join(root, asset, rel)
    assert os.path.realpath(dest).startswith(os.path.realpath(root) + os.sep), dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.exists(dest) and os.path.getsize(dest) == size:
        ok += 1
        continue
    req = urllib.request.Request(url, headers={'User-Agent': 'drift-pbr-fetch/1.0'})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest + '.part', 'wb') as f:
        h = hashlib.md5()
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
            h.update(b)
    got = os.path.getsize(dest + '.part')
    if (md5 and h.hexdigest() != md5) or (size and got != size):
        print('MISMATCH', asset, rel, got, size, h.hexdigest(), md5, flush=True)
        bad += 1
        continue
    os.replace(dest + '.part', dest)
    ok += 1
    print('ok', asset, rel, round(got / 1e6, 1), flush=True)
print('done', ok, 'ok', bad, 'bad', flush=True)
