// Emit biome hexes as newline-delimited GeoJSON (GeoJSONSeq) for GDAL → MVT.
// Each feature: hex polygon (h3 cellToBoundary, [lng,lat]) + { biome, h3 }.
//
//   node scripts/make_biome_geojson.mjs <res>           (2 | 3 | 5)
// res2/res3 read the land JSONL (skip ocean/unknown); res5 reads the big land
// file PLUS the coastal-ocean file (keep ocean). Output: biome_res<res>.geojsonl
import fs from "node:fs";
import readline from "node:readline";
import { cellToBoundary } from "h3-js";

const res = process.argv[2];
if (!["2", "3", "5"].includes(res)) {
  console.error("usage: node scripts/make_biome_geojson.mjs <2|3|5>");
  process.exit(1);
}
const DIR = "../Biome_cf/landcover_export";
const output = "scripts/biome_res" + res + ".geojsonl";
const out = fs.createWriteStream(output);
let written = 0;

function emit(h3, biome) {
  const b = cellToBoundary(h3); // [[lat,lng], ...]
  // close ring, [lng,lat]
  const ring = b.map((p) => [Number(p[1].toFixed(5)), Number(p[0].toFixed(5))]);
  ring.push(ring[0]);
  // skip antimeridian-spanning hexes (would stripe the map)
  let min = Infinity, max = -Infinity;
  for (const p of ring) { if (p[0] < min) min = p[0]; if (p[0] > max) max = p[0]; }
  if (max - min > 180) return;
  out.write(JSON.stringify({
    type: "Feature",
    properties: res === "5" ? { biome, h3 } : { biome },
    geometry: { type: "Polygon", coordinates: [ring] }
  }) + "\n");
  written += 1;
}

async function streamFile(path, { keepOcean }) {
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  let i = 0;
  for await (const line of rl) {
    i += 1;
    if (i % 2000000 === 0) process.stdout.write("\r  read " + i.toLocaleString() + ", written " + written.toLocaleString());
    if (!line) continue;
    if (line.indexOf('"unknown"') !== -1) continue;
    if (!keepOcean && line.indexOf('"ocean"') !== -1) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row.h3 || !row.biome) continue;
    if (!keepOcean && row.biome === "ocean") continue;
    emit(row.h3, row.biome);
  }
}

if (res === "5") {
  await streamFile(DIR + "/landcover_res5.jsonl", { keepOcean: false });        // land
  await streamFile(DIR + "/landcover_res5_coastal.jsonl", { keepOcean: true }); // coastal ocean
} else {
  await streamFile(DIR + "/landcover_res" + res + ".jsonl", { keepOcean: false });
}
out.end();
console.log("\nwrote " + written.toLocaleString() + " features to " + output);
