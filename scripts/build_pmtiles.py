"""Build biomes.pmtiles from per-resolution biome GeoJSON, with tqdm progress.

Run with the ESRI/arcgis python (has osgeo GDAL 3.7 + pmtiles + tqdm):
  <esri-env>\\python.exe scripts/build_pmtiles.py            # res2+res3 (fast)
  <esri-env>\\python.exe scripts/build_pmtiles.py --res5     # + finest res5 (slow)

Zoom bands -> one MVT layer "biomes":  res2 z0-2, res3 z3-4, res5 z5-11.

Prerequisites (generate the GeoJSON first):
  node scripts/make_coarse_from_res5.mjs     # writes biome_res2/res3.geojsonl
  node scripts/make_biome_geojson.mjs 5      # writes biome_res5.geojsonl (slow, 5GB stream)

GDAL's VectorTranslate reports progress per source feature, so the tqdm bar
reflects how far through the ~548k res5 hexes it is. The res5 tiling is slow
(GDAL's MVT driver isn't built for this volume) but resumable-by-rerun and the
bar shows it's alive. If it's too slow, tippecanoe is the faster alternative.
"""
import os
import sys
import json
import sqlite3
import subprocess
from osgeo import gdal
from tqdm import tqdm

gdal.UseExceptions()

LAYERS = [
    ("scripts/biome_res2.geojsonl", 0, 2),
    ("scripts/biome_res3.geojsonl", 3, 4),
]
if "--res5" in sys.argv:
    LAYERS.append(("scripts/biome_res5.geojsonl", 5, 11))  # finest scale, kicks in at z5

for src, _, _ in LAYERS:
    if not os.path.exists(src):
        raise SystemExit(f"missing {src} — generate the GeoJSON first (see this file's docstring)")


def gdal_progress_cb(bar):
    """GDAL progress callback -> advance a tqdm bar (scaled to 1000)."""
    last = [0]

    def cb(complete, message, user_data):
        n = int(complete * 1000)
        if n > last[0]:
            bar.update(n - last[0])
            last[0] = n
        return 1  # non-zero keeps GDAL going

    return cb


tmp = []
for src, minz, maxz in LAYERS:
    out = src.replace(".geojsonl", ".mbtiles")
    # Reuse an already-tiled band if its .mbtiles is newer than its .geojsonl, so
    # rebuilding only the coarse bands (after regenerating their GeoJSON) doesn't
    # re-run the slow res5 tiling. Pass --force to rebuild every band.
    if "--force" not in sys.argv and os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(src):
        print(f"reusing {os.path.basename(out)} (newer than its geojsonl; --force to rebuild)")
        tmp.append(out)
        continue
    if os.path.exists(out):
        os.remove(out)
    desc = f"{os.path.basename(src):28s} z{minz}-{maxz}"
    with tqdm(total=1000, desc=desc, bar_format="{l_bar}{bar}| {percentage:3.0f}% [{elapsed}<{remaining}]") as bar:
        ds = gdal.VectorTranslate(
            out, src,
            options=gdal.VectorTranslateOptions(
                format="MBTiles",
                layerName="biomes",
                datasetCreationOptions=[f"MINZOOM={minz}", f"MAXZOOM={maxz}"],
            ),
            callback=gdal_progress_cb(bar),
        )
        ds = None  # flush + close so the file isn't locked
        bar.n = 1000
        bar.refresh()
    tmp.append(out)

# Merge the per-band MBTiles (zoom ranges don't overlap) into one.
merged = "scripts/biomes.mbtiles"
if os.path.exists(merged):
    os.remove(merged)
con = sqlite3.connect(merged)
cur = con.cursor()
cur.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
cur.execute("CREATE UNIQUE INDEX tile_index ON tiles(zoom_level, tile_column, tile_row)")
cur.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
for t in tqdm(tmp, desc="merging bands", bar_format="{l_bar}{bar}| {n}/{total}"):
    cur.execute("ATTACH DATABASE ? AS s", (t,))
    cur.execute("INSERT OR REPLACE INTO tiles SELECT zoom_level, tile_column, tile_row, tile_data FROM s.tiles")
    con.commit()
    cur.execute("DETACH DATABASE s")
maxzoom = max(m for _, _, m in LAYERS)
meta = {
    "name": "biomes",
    "format": "pbf",
    "minzoom": "0",
    "maxzoom": str(maxzoom),
    "bounds": "-180.0,-85.0,180.0,85.0",
    "center": "0,20,2",
    "type": "overlay",
    "json": json.dumps({"vector_layers": [
        {"id": "biomes", "minzoom": 0, "maxzoom": maxzoom, "fields": {"biome": "String", "h3": "String"}}
    ]}),
}
for k, v in meta.items():
    cur.execute("INSERT INTO metadata VALUES (?, ?)", (k, v))
ntiles = cur.execute("SELECT count(*) FROM tiles").fetchone()[0]
con.commit()
con.close()
print(f"merged -> {merged} ({ntiles} tiles)")

out_pmtiles = "scripts/biomes.pmtiles"
if os.path.exists(out_pmtiles):
    os.remove(out_pmtiles)
convert = os.path.join(os.path.dirname(sys.executable), "Scripts", "pmtiles-convert")
print("converting to pmtiles…")
subprocess.run([sys.executable, convert, merged, out_pmtiles], check=False)  # exits 255 on a notice msg even on success
if not os.path.exists(out_pmtiles):
    raise SystemExit("pmtiles-convert did not produce " + out_pmtiles)
print(f"wrote {out_pmtiles} ({os.path.getsize(out_pmtiles) / 1_048_576:.1f} MB)")
print("next: wrangler r2 object put inat-battler-assets/tiles/biomes.pmtiles --file=scripts/biomes.pmtiles --remote, then bump ?v= on the client URL")
