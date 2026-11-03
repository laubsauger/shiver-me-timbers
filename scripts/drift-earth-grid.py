"""
LIGHTS OUT's grid regions (src/drift/getTheDrift/blackout.ts, lifeLayers.ts floodFront): which power grid each place of
the night side belongs to, so the shutdown can put the lights out country by country and grid region by grid region
(the 2026-11-03 review of the master: "the lights should turn off in a more interesting way, so it's more visible that
this is actually a global shutdown. More like country by country").

  Natural Earth 1:10m Cultural Vectors, Admin 0 – Countries and Admin 1 – States, Provinces (v5, public domain:
  https://www.naturalearthdata.com/about/terms-of-use/), as GeoJSON from the project's own repository:
  https://github.com/nvkelso/natural-earth-vector/tree/master/geojson

A UNIT is a country, or — for a country larger than UNIT_KM2 — one of k groups of its provinces (k = its area over
UNIT_KM2, rounded): a "grid region". The provinces are first gathered into the country's own regions where Natural
Earth names them (France's régions, Spain's comunidades, Italy's regioni, England's regions), and those are grouped
by k-means on their centroids, weighted by area, seeded from equal-area runs along the country's long axis — so the units' edges
are real borders, never straight lines. (Germany comes out in four, about its four transmission zones; France in five.)

Writes, on the region maps' grid (lon -25..45, lat 18..68 at 1/100 deg, 7000 x 5000: the Black Marble's lights there,
region-lcw.png, are what the units are weighed by):
  public/drift/earth/grid-units.png        8-bit grey, the unit's id per texel (0: open sea, no unit); grown 8 texels
                                           (~8 km) into the sea so the coast's lights keep their unit
  src/drift/getTheDrift/gridUnits.ts       the units: id, name, the light-weighted centroid (deg), the area (km2) and
                                           the share of the box's light (sum of the lights' radiance, v^2)

  out/drift/data/.venv/bin/python -I scripts/drift-earth-grid.py out/drift/data/raw/naturalearth public/drift/earth
  node scripts/drift-bundle.mjs --manifest-only
"""

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None

RAW = Path(sys.argv[1])
OUT = Path(sys.argv[2])
TS = Path(__file__).resolve().parent.parent / 'src' / 'drift' / 'getTheDrift' / 'gridUnits.ts'

LON0, LON1, LAT0, LAT1 = -25.0, 45.0, 18.0, 68.0
STEP = 0.01
W, H = round((LON1 - LON0) / STEP), round((LAT1 - LAT0) / STEP)
# km2: a country larger than this is split into grid regions of about this size (France 550 000 km2 in five, Spain
# in five, Germany in three or four, Italy in three: steps a seat can see go out one by one from a few hundred km up)
UNIT_KM2 = 110_000
# at most this many grid regions a country (Algeria's 2.3 million km2, nearly all desert, would be 21)
UNIT_MAX = 8
# texels the units grow into the sea: the coast's lights (ports, the 10m coastline a texel off) keep their unit
GROW = 8


def xy(ring):
    return [((lon - LON0) / STEP, (LAT1 - lat) / STEP) for lon, lat in ring]


def polygons(geom):
    if geom['type'] == 'Polygon':
        return [geom['coordinates']]
    if geom['type'] == 'MultiPolygon':
        return geom['coordinates']
    return []


def in_box(geom) -> bool:
    for poly in polygons(geom):
        for lon, lat in poly[0]:
            if LON0 - 1 <= lon <= LON1 + 1 and LAT0 - 1 <= lat <= LAT1 + 1:
                return True
    return False


def rasterize(features) -> np.ndarray:
    """index + 1 of the feature at each texel (0 none), holes cut"""
    img = Image.new('I', (W, H), 0)
    d = ImageDraw.Draw(img)
    for i, f in enumerate(features):
        for poly in polygons(f['geometry']):
            d.polygon(xy(poly[0]), fill=i + 1)
            for hole in poly[1:]:
                d.polygon(xy(hole), fill=0)
    return np.asarray(img, dtype=np.int32)


def main() -> None:
    a0 = [f for f in json.load(open(RAW / 'ne_10m_admin_0_countries.geojson'))['features'] if in_box(f['geometry'])]
    a1 = [f for f in json.load(open(RAW / 'ne_10m_admin_1_states_provinces.geojson'))['features'] if in_box(f['geometry'])]
    print(len(a0), 'countries,', len(a1), 'provinces in the box')
    country = rasterize(a0)
    prov = rasterize(a1)

    lat = LAT1 - (np.arange(H) + 0.5) * STEP
    texel_km2 = (STEP * 111.195) ** 2 * np.cos(np.radians(lat))[:, None] * np.ones((1, W))
    lights = np.asarray(Image.open(OUT / 'region-lcw.png'))[..., 0].astype(np.float64) / 255
    radiance = lights * lights

    # each country's provinces, by its admin-0 code (the province's adm0_a3 against the country's ADM0_A3; a texel the
    # provinces miss but the country covers stays in the country's first unit)
    code0 = [f['properties']['ADM0_A3'] for f in a0]
    names0 = {f['properties']['ADM0_A3']: f['properties']['NAME'] for f in a0}
    lon_c = LON0 + (np.arange(W) + 0.5) * STEP
    LON, LAT = np.meshgrid(lon_c, lat)
    units = np.zeros((H, W), np.int32)
    table = []

    def centroid(mask, weight, near_km=None):
        """the weighted mean place (deg); with `near_km`, taken again over what lies within that of it, twice — the
        unit's main mass, not a point in the sea between it and its islands (Andalusia and the Canaries are one unit)"""
        w = weight[mask]
        if w.sum() <= 0:
            return None
        la, lo = np.radians(LAT[mask]), np.radians(LON[mask])
        p = np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], -1)
        keep = np.ones(len(w), bool)
        for _ in range(3 if near_km else 1):
            v = (p[keep] * w[keep, None]).sum(0)
            v /= np.linalg.norm(v)
            if near_km:
                keep = p @ v > math.cos(near_km / 6371)
                if w[keep].sum() <= 0:
                    break
        return math.degrees(math.asin(v[2])), math.degrees(math.atan2(v[1], v[0]))

    by_country: dict[str, list[int]] = {}
    for j, f in enumerate(a1):
        by_country.setdefault(f['properties']['adm0_a3'], []).append(j)

    for ci, code in enumerate(code0):
        cmask = country == ci + 1
        area = texel_km2[cmask].sum()
        if area <= 0:
            continue
        k = min(UNIT_MAX, max(1, round(area / UNIT_KM2)))
        groups: list[np.ndarray] = []
        provs = by_country.get(code, [])
        if k > 1 and len(provs) >= k:
            # atoms: the provinces gathered into their named regions, where Natural Earth has them
            atoms: dict[str, list[int]] = {}
            for j in provs:
                pr = a1[j]['properties']
                key = pr.get('region') or pr.get('name') or str(j)
                atoms.setdefault(key, []).append(j)
            amask, aarea, acen = [], [], []
            for key, js in atoms.items():
                m = np.isin(prov, np.array(js) + 1) & cmask
                s = texel_km2[m].sum()
                if s <= 0:
                    continue
                c = centroid(m, texel_km2)
                amask.append(m)
                aarea.append(s)
                acen.append(c)
            k = min(k, len(amask))
            pts = np.array([[math.cos(math.radians(c[0])) * c[1], c[0]] for c in acen])
            wts = np.array(aarea)
            # seeds: the atoms ordered along the country's long axis (its area-weighted principal axis) and cut into k runs
            # of equal area, each run's centroid a seed — deterministic, and even in size. (Farthest-apart seeds, tried
            # first, gave Corsica and the Canaries a unit each and left one France unit of 260 000 km2)
            mean = np.average(pts, axis=0, weights=wts)
            cov = np.cov((pts - mean).T, aweights=wts) if len(pts) > 1 else np.eye(2)
            axis = np.linalg.eigh(cov)[1][:, -1]
            order = np.argsort((pts - mean) @ axis)
            cum = np.cumsum(wts[order]) / wts.sum()
            run = np.minimum((cum * k - 1e-9).astype(int), k - 1)
            # (a run one big atom swallowed whole is empty: fewer units)
            cen = np.array([np.average(pts[order[run == g]], axis=0, weights=wts[order[run == g]]) for g in range(k) if (run == g).any()])
            k = len(cen)
            for _ in range(50):
                lab = np.argmin([np.hypot(*(pts - c).T) for c in cen], axis=0)
                new = np.array([np.average(pts[lab == g], axis=0, weights=wts[lab == g]) if (lab == g).any() else cen[g] for g in range(k)])
                if np.allclose(new, cen):
                    break
                cen = new
            for g in range(k):
                m = np.zeros((H, W), bool)
                for i in np.nonzero(lab == g)[0]:
                    m |= amask[i]
                if m.any():
                    groups.append(m)
            # the country's texels no province covers: to the first group
            rest = cmask & ~np.any(groups, axis=0)
            groups[0] |= rest
        else:
            groups = [cmask]
        for g, m in enumerate(groups):
            uid = len(table) + 1
            if uid > 255:
                raise SystemExit('more than 255 units: raise UNIT_KM2 or go to 16 bits')
            units[m & (units == 0)] = uid
            c = centroid(m, radiance, 500) or centroid(m, texel_km2, 500)
            table.append({'id': uid, 'name': names0[code] + (f' {g + 1}/{len(groups)}' if len(groups) > 1 else ''), 'code': code,
                          'lat': c[0], 'lon': c[1], 'km2': float(texel_km2[m].sum()), 'light': float(radiance[m].sum())})

    # grow into the sea: each pass, a texel with no unit takes a neighbour's
    for _ in range(GROW):
        z = units == 0
        if not z.any():
            break
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            nb = np.roll(units, (dy, dx), (0, 1))
            take = z & (units == 0) & (nb > 0)
            units[take] = nb[take]

    total = sum(u['light'] for u in table)
    Image.fromarray(units.astype(np.uint8), 'L').save(OUT / 'grid-units.png', optimize=True)
    print(OUT / 'grid-units.png', units.shape, len(table), 'units')

    rows = '\n'.join(
        f"  [{u['id']}, {json.dumps(u['name'], ensure_ascii=False)}, {u['lat']:.2f}, {u['lon']:.2f}, {round(u['km2'])}, {u['light'] / total:.5f}],"
        for u in table
    )
    TS.write_text(
        f"""/**
 * LIGHTS OUT's grid regions — GENERATED by scripts/drift-earth-grid.py from Natural Earth 1:10m admin-0 and admin-1
 * (public domain); do not edit. The ids are grid-units.png's (public/drift/earth): a country, or for one over
 * {UNIT_KM2} km2 a group of its provinces (a "grid region"), over the region maps' box (lon {LON0:g}..{LON1:g}, lat {LAT0:g}..{LAT1:g}).
 *   [id, name, lat (deg), lon (deg) of the unit's light-weighted centroid, area (km2), share of the box's light]
 */
export const GRID_BOX = {{ lon0: {LON0:g}, lon1: {LON1:g}, lat0: {LAT0:g}, lat1: {LAT1:g}, w: {W}, h: {H} }};
export const GRID_UNITS: ReadonlyArray<readonly [number, string, number, number, number, number]> = [
{rows}
];
"""
    )
    print(TS)


if __name__ == '__main__':
    main()
