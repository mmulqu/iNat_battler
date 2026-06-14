// Aggregate res3 land-cover JSONL into a res2 layer (majority biome per parent)
// for the zoomed-out / world view. Output: landcover_res2.jsonl next to input.
//
//   node scripts/make_res2_biomes.mjs ../Biome_cf/landcover_export/landcover_res3.jsonl
import fs from "node:fs";
import readline from "node:readline";
import { cellToParent } from "h3-js";

const input = process.argv[2];
if (!input || !fs.existsSync(input)) {
  console.error("usage: node scripts/make_res2_biomes.mjs <res3.jsonl>");
  process.exit(1);
}
const output = input.replace("res3", "res2");

const parents = new Map(); // res2 h3 -> { biomeCounts: Map, code }
const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  if (!row.h3 || !row.biome) continue;
  let parent;
  try { parent = cellToParent(row.h3, 2); } catch { continue; }
  let bucket = parents.get(parent);
  if (!bucket) { bucket = { counts: new Map() }; parents.set(parent, bucket); }
  bucket.counts.set(row.biome, (bucket.counts.get(row.biome) || 0) + 1);
}

const codeFor = { unknown: 0, shrubland: 20, grassland: 30, agricultural: 40, urban: 50, desert: 60, polar: 70, freshwater: 80, wetland: 90, tundra: 100, forest: 116, woodland: 126, ocean: 200 };
const out = fs.createWriteStream(output);
let n = 0;
for (const [h3, bucket] of parents) {
  let best = "unknown";
  let bestN = -1;
  for (const [biome, count] of bucket.counts) {
    if (count > bestN) { bestN = count; best = biome; }
  }
  out.write(JSON.stringify({ h3, code: codeFor[best] ?? 0, biome: best }) + "\n");
  n += 1;
}
out.end();
console.log("wrote " + n + " res2 tiles to " + output);
