// Build res2 + res3 biome GeoJSON for the PMTiles basemap by aggregating UP from
// the res5 LAND tiles. A coarse hex gets the majority LAND biome among its land
// children, so ANY hex that touches land appears (recovers coastlines / islands /
// peninsulas like Italy that majority-of-area aggregation drowned as "ocean").
//
//   node scripts/make_coarse_from_res5.mjs
// -> overwrites scripts/biome_res2.geojsonl and scripts/biome_res3.geojsonl
import fs from "node:fs";
import readline from "node:readline";
import { cellToParent, cellToBoundary } from "h3-js";

const SRC = "../Biome_cf/landcover_export/landcover_res5.jsonl";

function bump(map, parent, biome) {
  let counts = map.get(parent);
  if (!counts) { counts = {}; map.set(parent, counts); }
  counts[biome] = (counts[biome] || 0) + 1;
}

const res3 = new Map();
const res2 = new Map();

console.log("Streaming res5 land tiles…");
const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });
let i = 0;
for await (const line of rl) {
  i += 1;
  if (i % 5000000 === 0) process.stdout.write("\r  " + i.toLocaleString() + " lines, res3=" + res3.size + " res2=" + res2.size);
  if (!line) continue;
  if (line.indexOf('"ocean"') !== -1 || line.indexOf('"unknown"') !== -1) continue;
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  if (!row.h3 || !row.biome) continue;
  bump(res3, cellToParent(row.h3, 3), row.biome);
  bump(res2, cellToParent(row.h3, 2), row.biome);
}
console.log("\n  res3 parents: " + res3.size + ", res2 parents: " + res2.size);

function writeGeojson(map, outPath) {
  const out = fs.createWriteStream(outPath);
  let written = 0;
  for (const [h3, counts] of map) {
    let best = null;
    let bestN = -1;
    for (const biome of Object.keys(counts)) {
      if (counts[biome] > bestN) { bestN = counts[biome]; best = biome; }
    }
    const b = cellToBoundary(h3); // [[lat,lng]...]
    const ring = b.map((p) => [Number(p[1].toFixed(5)), Number(p[0].toFixed(5))]);
    ring.push(ring[0]);
    let min = Infinity, max = -Infinity;
    for (const p of ring) { if (p[0] < min) min = p[0]; if (p[0] > max) max = p[0]; }
    if (max - min > 180) continue; // antimeridian
    out.write(JSON.stringify({
      type: "Feature",
      properties: { biome: best },
      geometry: { type: "Polygon", coordinates: [ring] }
    }) + "\n");
    written += 1;
  }
  out.end();
  console.log("wrote " + written + " features to " + outPath);
}

writeGeojson(res2, "scripts/biome_res2.geojsonl");
writeGeojson(res3, "scripts/biome_res3.geojsonl");
