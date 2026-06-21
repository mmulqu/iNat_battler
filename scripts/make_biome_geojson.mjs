// Emit biome hexes as newline-delimited GeoJSON (GeoJSONSeq) for GDAL → MVT.
// Each feature: hex polygon (h3 cellToBoundary, [lng,lat]) + { biome, h3 }.
//
//   node scripts/make_biome_geojson.mjs <res>           (2 | 3 | 5)
// res2/res3 read the land JSONL (skip ocean/unknown); res5 reads the big land
// file PLUS the coastal-ocean file (keep ocean). Output: biome_res<res>.geojsonl
//
// res5 streams several GB, so this shows a tqdm-style progress bar (%, throughput,
// ETA) driven by bytes consumed across all input files. (Python's tqdm itself is
// used in build_pmtiles.py for the GDAL tiling step that consumes this output.)
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

// Files to stream, in order, with whether ocean hexes are kept.
const inputs = res === "5"
  ? [
      { path: DIR + "/landcover_res5.jsonl", keepOcean: false },        // land
      { path: DIR + "/landcover_res5_coastal.jsonl", keepOcean: true }, // coastal ocean
    ]
  : [{ path: DIR + "/landcover_res" + res + ".jsonl", keepOcean: false }];

for (const { path } of inputs) {
  if (!fs.existsSync(path)) {
    console.error("missing input: " + path);
    process.exit(1);
  }
}

// ---- tqdm-style progress bar (bytes-based, so it has a real %/ETA) -----------
function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return (h ? pad(h) + ":" : "") + pad(m) + ":" + pad(ss);
}
function fmtMB(bytes) {
  return (bytes / 1_048_576).toFixed(0);
}

const totalBytes = inputs.reduce((sum, { path }) => sum + fs.statSync(path).size, 0);
const start = Date.now();
let doneBytes = 0;
let lastRender = 0;

function renderBar(force = false) {
  const now = Date.now();
  if (!force && now - lastRender < 200) return;
  lastRender = now;
  const frac = totalBytes ? Math.min(1, doneBytes / totalBytes) : 0;
  const width = 28;
  const filled = Math.round(frac * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const elapsed = (now - start) / 1000;
  const rate = doneBytes / Math.max(elapsed, 0.001); // bytes/s
  const eta = rate > 0 ? (totalBytes - doneBytes) / rate : 0;
  process.stderr.write(
    "\r  res" + res + " |" + bar + "| " +
    (frac * 100).toFixed(0).padStart(3) + "%  " +
    fmtMB(doneBytes) + "/" + fmtMB(totalBytes) + "MB  " +
    (rate / 1_048_576).toFixed(1) + "MB/s  " +
    "ETA " + fmtTime(eta) + "  written " + written.toLocaleString() + "    "
  );
}

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
  for await (const line of rl) {
    // +1 for the stripped newline; close enough for a smooth byte-based bar.
    doneBytes += Buffer.byteLength(line, "utf8") + 1;
    renderBar();
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

for (const { path, keepOcean } of inputs) {
  await streamFile(path, { keepOcean });
}
doneBytes = totalBytes; // newline accounting undercounts slightly; finish at 100%
renderBar(true);
process.stderr.write("\n");
out.end();
console.log("wrote " + written.toLocaleString() + " features to " + output);
