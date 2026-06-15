// Preserve the ring of OCEAN res5 tiles adjacent to land (so marine/high-seas
// observations have claimable water tiles). Streams the full res5 JSONL to build
// the land set, then emits every ocean neighbor of a land hex.
//
//   node scripts/make_coastal_ocean.mjs ../Biome_cf/landcover_export/landcover_res5.jsonl
// -> writes landcover_res5_coastal.jsonl  {h3, code:200, biome:"ocean"}
import fs from "node:fs";
import readline from "node:readline";
import { gridDisk } from "h3-js";

const input = process.argv[2];
if (!input || !fs.existsSync(input)) {
  console.error("usage: node scripts/make_coastal_ocean.mjs <res5.jsonl>");
  process.exit(1);
}
const output = input.replace(/\.jsonl$/, "_coastal.jsonl");

console.log("Pass 1: building land set…");
const land = new Set();
let lines = 0;
let rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
for await (const line of rl) {
  lines += 1;
  if (lines % 5000000 === 0) process.stdout.write("\r  " + lines.toLocaleString() + " lines, land=" + land.size.toLocaleString());
  if (!line) continue;
  // cheap filter before JSON.parse: ocean lines contain "ocean"
  if (line.indexOf('"ocean"') !== -1 || line.indexOf('"unknown"') !== -1) continue;
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  if (row.h3) land.add(row.h3);
}
console.log("\n  land tiles: " + land.size.toLocaleString());

console.log("Pass 2: collecting coastal ocean ring…");
const coastal = new Set();
let i = 0;
for (const h3 of land) {
  i += 1;
  if (i % 100000 === 0) process.stdout.write("\r  " + i.toLocaleString() + "/" + land.size.toLocaleString() + " land, coastal=" + coastal.size.toLocaleString());
  let disk;
  try { disk = gridDisk(h3, 1); } catch { continue; }
  for (const n of disk) {
    if (n !== h3 && !land.has(n)) coastal.add(n);
  }
}
console.log("\n  coastal ocean tiles: " + coastal.size.toLocaleString());

const out = fs.createWriteStream(output);
for (const h3 of coastal) out.write(JSON.stringify({ h3, code: 200, biome: "ocean" }) + "\n");
out.end();
console.log("wrote " + coastal.size.toLocaleString() + " coastal tiles to " + output);
