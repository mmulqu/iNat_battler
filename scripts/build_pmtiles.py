"""Build biomes.pmtiles from per-resolution biome GeoJSON.

Run with the ESRI/arcgis python (has osgeo GDAL 3.7 + pmtiles):
  <esri-env>\python.exe scripts/build_pmtiles.py [--res5]

res2 -> tile z0-4, res3 -> z5-7, res5 -> z8-13 (one MVT layer "biomes").
"""
import os
import sys
import json
import sqlite3
import subprocess
from osgeo import gdal

gdal.UseExceptions()

LAYERS = [
    ("scripts/biome_res2.geojsonl", 0, 4),
    ("scripts/biome_res3.geojsonl", 5, 7),
]
if "--res5" in sys.argv:
    LAYERS.append(("scripts/biome_res5.geojsonl", 8, 11))  # z11 fully resolves ~5km hexes; client overzooms past

tmp = []
for src, minz, maxz in LAYERS:
    out = src.replace(".geojsonl", ".mbtiles")
    if os.path.exists(out):
        os.remove(out)
    print(f"tiling {src} z{minz}-{maxz} -> {out}")
    ds = gdal.VectorTranslate(out, src, options=gdal.VectorTranslateOptions(
        format="MBTiles",
        layerName="biomes",
        datasetCreationOptions=[f"MINZOOM={minz}", f"MAXZOOM={maxz}"],
    ))
    ds = None  # flush + close so the file isn't locked
    tmp.append(out)

merged = "scripts/biomes.mbtiles"
if os.path.exists(merged):
    os.remove(merged)
con = sqlite3.connect(merged)
cur = con.cursor()
cur.execute("CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)")
cur.execute("CREATE UNIQUE INDEX tile_index ON tiles(zoom_level, tile_column, tile_row)")
cur.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
for t in tmp:
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
subprocess.run([sys.executable, convert, merged, out_pmtiles], check=False)  # exits 255 on a notice msg even on success
if not os.path.exists(out_pmtiles):
    raise SystemExit("pmtiles-convert did not produce " + out_pmtiles)
print(f"wrote {out_pmtiles} ({os.path.getsize(out_pmtiles)} bytes)")
