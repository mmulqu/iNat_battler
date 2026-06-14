#!/usr/bin/env node
/**
 * Import H3 tile-biome data (landcover_export/landcover_res{N}.jsonl) into the
 * battler's `tile_biomes` table.
 *
 * The biome-db on Cloudflare was deleted; the JSONL exports are the source of
 * truth. Each line: {"h3": "<index>", "code": <landcover_code>, "biome": "<type>"}.
 *
 * Strategy: stream the JSONL, build multi-row `INSERT OR REPLACE` SQL in chunks,
 * and apply each chunk via `wrangler d1 execute --file`. Progress is tracked in a
 * sidecar file so a crashed/aborted run resumes where it stopped. Works for both
 * --local and --remote with the same code path (no deployed endpoint needed).
 *
 * Usage:
 *   node scripts/import_tile_biomes.mjs <jsonl> <resolution> [--local|--remote] [--all]
 *
 * By default ocean + unknown tiles are SKIPPED (the map never shows them and
 * they're ~71% of the globe — dropping them keeps D1 small and within the $5
 * Cloudflare plan). Pass --all to load every tile including ocean.
 *
 * Examples:
 *   node scripts/import_tile_biomes.mjs ../Biome_cf/landcover_export/landcover_res3.jsonl 3 --local
 *   node scripts/import_tile_biomes.mjs ../Biome_cf/landcover_export/landcover_res5.jsonl 5 --remote
 *
 * Reset a run: delete the <jsonl>.import-progress sidecar.
 */

import fs from "node:fs";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const inputFile = args[0];
const resolution = Number.parseInt(args[1], 10);
const target = args.includes("--remote") ? "--remote" : "--local";
const includeAll = args.includes("--all");
const SKIP_BIOMES = new Set(["ocean", "unknown"]);
const DB_NAME = "inat_battler";
// Rows per wrangler invocation (one .sql file). Smaller for remote to keep the
// HTTP request body modest and well under D1's remote limits.
const CHUNK_ROWS = args.includes("--remote") ? 10000 : 20000;
const STMT_ROWS = 400;    // rows per INSERT statement (D1 caps statement length)

if (!inputFile || Number.isNaN(resolution)) {
  console.error("Usage: node scripts/import_tile_biomes.mjs <jsonl> <resolution> [--local|--remote]");
  process.exit(1);
}
if (!fs.existsSync(inputFile)) {
  console.error(`File not found: ${inputFile}`);
  process.exit(1);
}

const progressFile = `${inputFile}.import-progress`;

function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(progressFile, "utf8"));
  } catch {
    return { chunksDone: 0, rowsDone: 0, startTime: Date.now() };
  }
}
function saveProgress(p) {
  fs.writeFileSync(progressFile, JSON.stringify(p, null, 2));
}

function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

function applyChunk(rows, chunkIndex) {
  // Split into multiple INSERT statements; D1 caps individual statement length
  // (a single 5000-row VALUES list trips SQLITE_TOOBIG).
  let sql = "";
  for (let i = 0; i < rows.length; i += STMT_ROWS) {
    const slice = rows.slice(i, i + STMT_ROWS);
    const values = slice
      .map((r) => `('${sqlEscape(r.h3)}', ${resolution}, ${Number(r.code) || 0}, '${sqlEscape(r.biome || "unknown")}')`)
      .join(",");
    sql += "INSERT OR REPLACE INTO tile_biomes (h3_index, resolution, landcover_code, biome_type) VALUES " + values + ";\n";
  }

  const tmp = path.join(os.tmpdir(), `tile_biomes_chunk_${process.pid}_${chunkIndex}.sql`);
  fs.writeFileSync(tmp, sql);
  try {
    execFileSync(
      "npx",
      ["wrangler", "d1", "execute", DB_NAME, target, `--file=${tmp}`],
      { stdio: ["ignore", "ignore", "inherit"], shell: process.platform === "win32" }
    );
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function main() {
  const progress = loadProgress();
  console.log(`Importing ${inputFile} (res ${resolution}) -> ${DB_NAME} ${target}`);
  if (progress.chunksDone > 0) {
    console.log(`Resuming: ${progress.chunksDone} chunks (${progress.rowsDone.toLocaleString()} rows) already done`);
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(inputFile),
    crlfDelay: Infinity
  });

  let chunk = [];
  let chunkIndex = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row.h3) continue;
    if (!includeAll && SKIP_BIOMES.has(row.biome || "unknown")) continue;
    chunk.push(row);

    if (chunk.length >= CHUNK_ROWS) {
      chunkIndex += 1;
      if (chunkIndex <= progress.chunksDone) { chunk = []; continue; } // skip done
      applyChunk(chunk, chunkIndex);
      progress.chunksDone = chunkIndex;
      progress.rowsDone += chunk.length;
      saveProgress(progress);
      const rate = progress.rowsDone / Math.max(1, (Date.now() - progress.startTime) / 1000);
      process.stdout.write(`\rchunk ${chunkIndex} | ${progress.rowsDone.toLocaleString()} rows | ${rate.toFixed(0)}/s   `);
      chunk = [];
    }
  }
  if (chunk.length > 0) {
    chunkIndex += 1;
    if (chunkIndex > progress.chunksDone) {
      applyChunk(chunk, chunkIndex);
      progress.chunksDone = chunkIndex;
      progress.rowsDone += chunk.length;
      saveProgress(progress);
    }
  }

  console.log(`\nDone. ${progress.rowsDone.toLocaleString()} rows imported across ${progress.chunksDone} chunks.`);
  try { fs.unlinkSync(progressFile); } catch {}
}

main().catch((err) => { console.error("\nFatal:", err); process.exit(1); });
