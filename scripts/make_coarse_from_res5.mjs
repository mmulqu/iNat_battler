// Build res2 + res3 biome GeoJSON for the PMTiles basemap by aggregating UP from
// the res5 tiles. A coarse hex gets the TRUE MAJORITY biome among ALL its res5
// children — ocean included — so the LOD pyramid is honestly classified: hexes
// that are mostly ocean read as ocean, mostly-land read by their dominant land
// biome. Small islands / thin coasts that are minority-land in a coarse hex roll
// up as ocean here and reappear as land at finer zooms. (Earlier this counted
// land children only, which over-painted coastlines as land. Ocean is rendered
// client-side, so this produces no holes.)
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

console.log("Streaming res5 tiles (ocean included)…");
const rl = readline.createInterface({ input: fs.createReadStream(SRC), crlfDelay: Infinity });
let i = 0;
for await (const line of rl) {
  i += 1;
  if (i % 5000000 === 0) process.stdout.write("\r  " + i.toLocaleString() + " lines, res3=" + res3.size + " res2=" + res2.size);
  if (!line) continue;
  if (line.indexOf('"unknown"') !== -1) continue; // keep ocean; only drop unknown
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  if (!row.h3 || !row.biome) continue;
  bump(res3, cellToParent(row.h3, 3), row.biome);
  bump(res2, cellToParent(row.h3, 2), row.biome);
}
console.log("\n  res3 parents: " + res3.size + ", res2 parents: " + res2.size);

// A hex is ocean only when ocean is a true >50% majority of its children.
// Otherwise it's land, colored by its dominant LAND biome — because land is split
// across many biomes, so a plurality vote would call a mostly-land coastal hex
// "ocean" (e.g. Rome/London: ~44% ocean but ~56% land across forest/urban/etc.).
function pickBiome(counts) {
  let total = 0;
  for (const biome of Object.keys(counts)) total += counts[biome];
  const ocean = counts.ocean || 0;
  if (ocean > total / 2) return "ocean";
  let best = null;
  let bestN = -1;
  for (const biome of Object.keys(counts)) {
    if (biome === "ocean") continue;
    if (counts[biome] > bestN) { bestN = counts[biome]; best = biome; }
  }
  return best || "ocean"; // safety: hex with only ocean children
}

function writeGeojson(map, outPath) {
  const out = fs.createWriteStream(outPath);
  let written = 0;
  for (const [h3, counts] of map) {
    const best = pickBiome(counts);
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
