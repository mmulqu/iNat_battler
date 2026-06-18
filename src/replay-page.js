// Standalone battle-highlight video renderer (see docs/battle-highlights-bluesky.md).
//
// Served at /replay/<battleId>. It fetches the deterministic state sequence for
// a battle, redraws it onto a <canvas> as a timed animation (mirroring the live
// DOM/CSS battle effects), and encodes an H.264 MP4 in-browser via the WebCodecs
// VideoEncoder + mp4-muxer. The same page runs in a user's browser (Share
// button) and in headless Chrome (the autonomous bot), producing identical MP4s.
//
// On completion it sets window.__replayResult = { ok, base64, mime, width,
// height, durationMs, bytes } — the headless driver reads base64; the button
// flow reads window.__replayBlob. R2 is never involved.

export const REPLAY_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Battle Highlight</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #11161a; color: #e7eef0;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  .wrap { min-height: 100%; display: grid; place-items: center; gap: 14px; padding: 18px; }
  canvas { width: min(92vw, 360px); height: auto; border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.5); image-rendering: pixelated; background: #000; }
  .bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: center; }
  .status { font-size: 0.9rem; opacity: 0.85; min-height: 1.2em; text-align: center; }
  button { font: inherit; font-weight: 700; border: 0; border-radius: 999px; padding: 10px 18px;
    background: #2f9e8f; color: #04211d; cursor: pointer; }
  button[disabled] { opacity: 0.5; cursor: default; }
  a.dl { text-decoration: none; }
</style>
</head>
<body>
<div class="wrap">
  <canvas id="stage" width="720" height="900"></canvas>
  <div class="status" id="status">Loading battle…</div>
  <div class="bar" id="bar"></div>
</div>
<script type="module">
import { Muxer, ArrayBufferTarget } from "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/+esm";

// ---- config (overridable via query: ?fps=30&w=720&h=900&autostart=0) --------
const Q = new URLSearchParams(location.search);
const FPS = clampInt(Q.get("fps"), 30, 12, 60);
const W = clampInt(Q.get("w"), 720, 240, 1920);
const H = clampInt(Q.get("h"), 900, 240, 1920);
const AUTOSTART = Q.get("autostart") !== "0";
const MAX_SECONDS = clampInt(Q.get("max"), 170, 10, 175); // Bluesky caps at 180s
function clampInt(v, dflt, lo, hi) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; }

const canvas = document.getElementById("stage");
canvas.width = W; canvas.height = H;
const ctx = canvas.getContext("2d", { alpha: false });
ctx.imageSmoothingEnabled = false;
const statusEl = document.getElementById("status");
const barEl = document.getElementById("bar");
const setStatus = (t) => { statusEl.textContent = t; };

// ---- timing constants (ms) — mirror the live playTurnEvents pacing -----------
const INTRO_MS = 1700;
const OUTRO_MS = 3200;
const LUNGE_MS = 560;
const KNOCK_MS = 420;
const FLASH_MS = 380;
const FLOAT_MS = 850;
const FAINT_MS = 650;
const SHAKE_MS = 320;
const HURT_MS = 360;
const HP_TWEEN_MS = 360;

const battleId = decodeURIComponent((location.pathname.split("/replay/")[1] || "").split(/[?#]/)[0]);

// ---------------------------------------------------------------------------
// Load states
// ---------------------------------------------------------------------------
async function loadStates() {
  const res = await fetch("/api/battles/" + encodeURIComponent(battleId) + "/replay?states=1", {
    headers: { accept: "application/json" }, credentials: "include"
  });
  const data = await res.json().catch(() => ({}));
  if (!data || data.available === false || !Array.isArray(data.states)) {
    throw new Error(data && data.reason === "no_replay"
      ? "This battle has no replay data (created before replays were recorded)."
      : (data && data.error) || "Could not load battle replay.");
  }
  return data;
}

// ---------------------------------------------------------------------------
// Sprite preloading
// ---------------------------------------------------------------------------
// Background removal — ported verbatim from the live battle view so videos match
// the website. Flood-fills the light/grey backdrop inward from each 4x4 cell's
// edges and zeroes its alpha, leaving the creature (and any interior light
// areas not connected to the border) intact.
function isLightCellBackground(data, offset) {
  const alpha = data[offset + 3];
  if (alpha === 0) return false;
  const r = data[offset], g = data[offset + 1], b = data[offset + 2];
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max >= 190 && max - min <= 70 && r + g + b >= 590;
}
function alphaKeySpriteSheet(data, width, height) {
  const columns = 4, rows = 4;
  const visited = new Uint8Array(width * height);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x0 = Math.floor((width * column) / columns);
      const x1 = Math.floor((width * (column + 1)) / columns) - 1;
      const y0 = Math.floor((height * row) / rows);
      const y1 = Math.floor((height * (row + 1)) / rows) - 1;
      const queue = [];
      let cursor = 0;
      const push = (x, y) => {
        if (x < x0 || x > x1 || y < y0 || y > y1) return;
        const index = y * width + x;
        if (visited[index]) return;
        if (!isLightCellBackground(data, index * 4)) return;
        visited[index] = 1;
        queue.push(index);
      };
      for (let x = x0; x <= x1; x++) { push(x, y0); push(x, y1); }
      for (let y = y0 + 1; y < y1; y++) { push(x0, y); push(x1, y); }
      while (cursor < queue.length) {
        const index = queue[cursor++];
        data[index * 4 + 3] = 0;
        const x = index % width, y = Math.floor(index / width);
        push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1);
      }
    }
  }
}

const imgCache = new Map();
function preload(url) {
  if (!url) return Promise.resolve(null);
  if (imgCache.has(url)) return imgCache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        if (!w || !h) { resolve(img); return; }
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const cx = c.getContext("2d", { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        const id = cx.getImageData(0, 0, w, h);
        alphaKeySpriteSheet(id.data, w, h);
        cx.putImageData(id, 0, 0);
        resolve(c); // a canvas; drawImage handles it like an image
      } catch (_) {
        resolve(img); // same-origin only; fall back to raw image on any error
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
  imgCache.set(url, p);
  return p;
}
async function preloadAll(states) {
  const urls = new Set();
  for (const s of states) for (const team of [s.player, s.opponent])
    for (const c of team.creatures) if (c.spriteUrl) urls.add(c.spriteUrl);
  const entries = await Promise.all([...urls].map(async (u) => [u, await preload(u)]));
  return new Map(entries);
}

// ---------------------------------------------------------------------------
// Timeline construction — translate each turn's log into scheduled effects
// ---------------------------------------------------------------------------
const activeName = (team) => team.creatures[team.activeIndex].name;
const getActive = (team) => team.creatures[team.activeIndex];

function sideForName(name, prev) {
  const p = activeName(prev.player), o = activeName(prev.opponent);
  if (name === p && name !== o) return "player";
  if (name === o && name !== p) return "opponent";
  if (prev.player.creatures.some((c) => c.name === name)) return "player";
  return "opponent";
}
function moveAnimRow(creature, moveId) {
  const move = (creature.moves || []).find((m) => m.id === moveId);
  if (move && move.animRow === 4) return 3;          // special row
  if (move && move.category === "special") return 3;
  return 2;                                          // attack row
}
// deterministic per-(turn,side) jitter so re-renders are identical
function jitter(turn, side, salt) {
  let h = 2166136261 ^ salt;
  const s = turn + ":" + side + ":" + salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) / 4294967296) * 2 - 1; // -1..1
}

function buildTimeline(data) {
  const states = data.states;
  const commands = [];   // { t, fn(model) } — instantaneous
  const anims = [];       // { side, kind, start, dur, ...params } — continuous
  const floats = [];      // { side, text, cls, start }
  const shakes = [];      // { start }
  const hurts = [];       // { start }
  let cursor = INTRO_MS;

  const cmd = (t, fn) => commands.push({ t, fn });
  const setHp = (side, t, hp, max) => cmd(t, (m) => { m[side].hp = hp; m[side].max = max; });
  const setActive = (t, side, creature) => cmd(t, (m) => {
    m[side].name = creature.name;
    m[side].types = creature.types || [];
    m[side].spriteUrl = creature.spriteUrl || null;
    m[side].fainted = false;
    m[side].faintStart = null;
    // Marks when this creature took the field; a faint only applies to the
    // creature that was active when it occurred (faints linger in tl.anims).
    m[side].activeSince = t;
  });
  const caption = (t, text) => cmd(t, (m) => { m.caption = text; });

  // Initial actives + HP at intro end.
  const s0 = states[0];
  setActive(0, "player", getActive(s0.player));
  setActive(0, "opponent", getActive(s0.opponent));
  setHp("player", 0, getActive(s0.player).hp, getActive(s0.player).maxHp);
  setHp("opponent", 0, getActive(s0.opponent).hp, getActive(s0.opponent).maxHp);
  caption(0, (s0.player.name || "Your Team") + " vs " + (s0.opponent.name || "Opponent"));

  for (let i = 1; i < states.length; i++) {
    const prev = states[i - 1];
    const next = states[i];
    const turnNum = prev.turn;
    const events = (next.log || []).filter((e) => e.turn === turnNum);
    // local HP tracker for in-turn bar updates (active creatures)
    const hp = {
      player: { hp: getActive(prev.player).hp, max: getActive(prev.player).maxHp },
      opponent: { hp: getActive(prev.opponent).hp, max: getActive(prev.opponent).maxHp }
    };
    // make sure the displayed actives match this turn's starting actives
    setActive(cursor, "player", getActive(prev.player));
    setActive(cursor, "opponent", getActive(prev.opponent));
    let lastTarget = "opponent";

    for (const entry of events) {
      const text = entry.text || "";
      caption(cursor, text);

      let m;
      if ((m = text.match(/^(.+) used (.+) and dealt (\\d+) damage\\.$/))) {
        const actor = sideForName(m[1], prev);
        const target = actor === "player" ? "opponent" : "player";
        const dmg = Number(m[3]);
        const isCrit = Boolean(entry.data && entry.data.crit);
        const actorCreature = getActive(actor === "player" ? prev.player : prev.opponent);
        const row = moveAnimRow(actorCreature, entry.data && entry.data.moveId);
        lastTarget = target;
        anims.push({ side: actor, kind: "lunge", start: cursor, dur: LUNGE_MS, row,
          jx: jitter(turnNum, actor, 1), jy: jitter(turnNum, actor, 2), ja: jitter(turnNum, actor, 3) });
        const hitT = cursor + 280;
        anims.push({ side: target, kind: "knock", start: hitT, dur: KNOCK_MS, dmg,
          jx: jitter(turnNum, target, 4), jy: jitter(turnNum, target, 5) });
        anims.push({ side: target, kind: "flash", start: hitT, dur: FLASH_MS });
        shakes.push({ start: hitT });
        hurts.push({ start: hitT });
        hp[target].hp = Math.max(0, hp[target].hp - dmg);
        setHp(target, hitT, hp[target].hp, hp[target].max);
        floats.push({ side: target, text: "-" + dmg, cls: dmg >= 22 ? "dmg big" : "dmg", start: hitT });
        if (isCrit) floats.push({ side: target, text: "CRIT!", cls: "crit", start: hitT + 60 });
        cursor = hitT + (isCrit ? 780 : 640);
        continue;
      }
      if (text === "A critical hit!") { cursor += 140; continue; }
      if (/^It's super effective!$/.test(text)) {
        floats.push({ side: lastTarget, text: "SUPER EFFECTIVE!", cls: "word eff-strong", start: cursor }); cursor += 340; continue;
      }
      if (/not very effective/.test(text)) {
        floats.push({ side: lastTarget, text: "RESISTED", cls: "word eff-weak", start: cursor }); cursor += 300; continue;
      }
      if ((m = text.match(/^(.+) used (.+), but it missed\\.$/))) {
        const actor = sideForName(m[1], prev);
        anims.push({ side: actor, kind: "lunge", start: cursor, dur: LUNGE_MS, row: 2,
          jx: jitter(turnNum, actor, 1), jy: jitter(turnNum, actor, 2), ja: jitter(turnNum, actor, 3) });
        floats.push({ side: actor === "player" ? "opponent" : "player", text: "MISS", cls: "word miss", start: cursor + 240 });
        cursor += 660; continue;
      }
      if ((m = text.match(/^(.+) fainted\\.$/))) {
        const side = sideForName(m[1], prev);
        anims.push({ side, kind: "faint", start: cursor, dur: FAINT_MS });
        cmd(cursor, (mo) => { mo[side].fainted = true; mo[side].faintStart = cursor; });
        cursor += 720; continue;
      }
      // HP-changing status/heal lines
      let mm;
      if ((mm = text.match(/^(.+?)(?:'s vigor restores|recovered|drained) (\\d+) HP\\.$/)) ||
          (mm = text.match(/^(.+?) recovered (\\d+) HP\\.$/))) {
        const side = sideForName(mm[1], prev);
        hp[side].hp = Math.min(hp[side].max, hp[side].hp + Number(mm[2]));
        setHp(side, cursor, hp[side].hp, hp[side].max);
        floats.push({ side, text: "+" + mm[2], cls: "heal", start: cursor }); cursor += 480; continue;
      }
      if ((mm = text.match(/^(.+?)(?:'s sapped vigor drains|took (?:\\d+) recoil damage|is hurt by poison and loses)? ?(\\d+)? ?HP?\\.?$/)) && /poison|recoil|drains/.test(text)) {
        const side = sideForName(text.split(/'s| is | took /)[0], prev);
        const dm = Number((text.match(/(\\d+)/) || [])[1] || 0);
        if (dm) { hp[side].hp = Math.max(0, hp[side].hp - dm); setHp(side, cursor, hp[side].hp, hp[side].max);
          floats.push({ side, text: "-" + dm, cls: "dmg", start: cursor }); }
        cursor += 480; continue;
      }
      if ((mm = text.match(/^(.+?) (?:was (poisoned)|is (marked) for the hunt|is (stunned)|(raised a shield))\\.$/))) {
        const side = sideForName(mm[1], prev);
        const label = mm[5] ? "SHIELDED" : (mm[2] || mm[3] || mm[4] || "").toUpperCase();
        floats.push({ side, text: label, cls: "word status-fx", start: cursor }); cursor += 420; continue;
      }
      if ((mm = text.match(/^(.+?)'s (vigor|strike|guard|tempo|sense) (rose|fell)\\.$/))) {
        const side = sideForName(mm[1], prev);
        floats.push({ side, text: mm[2].toUpperCase() + (mm[3] === "rose" ? " ▲" : " ▼"),
          cls: mm[3] === "rose" ? "word buff" : "word debuff", start: cursor }); cursor += 420; continue;
      }
      if ((mm = text.match(/^(.+?) is stunned and cannot move\\.$/))) {
        floats.push({ side: sideForName(mm[1], prev), text: "STUNNED!", cls: "word status-fx", start: cursor }); cursor += 520; continue;
      }
      if ((mm = text.match(/^(.+?) used (.+)\\.$/))) {
        const side = sideForName(mm[1], prev);
        anims.push({ side, kind: "lunge", start: cursor, dur: LUNGE_MS, row: 3, brace: true,
          jx: jitter(turnNum, side, 1), jy: jitter(turnNum, side, 2), ja: jitter(turnNum, side, 3) });
        cursor += 420; continue;
      }
      // withdrew/sent in (switch) — update sprite
      if ((mm = text.match(/sent in (.+)\\.$/))) {
        const sideGuess = prev.player.creatures.some((c) => c.name === mm[1]) ? "player" : "opponent";
        const creature = (next[sideGuess] || prev[sideGuess]).creatures.find((c) => c.name === mm[1]);
        if (creature) setActive(cursor, sideGuess, creature);
        cursor += 360; continue;
      }
      cursor += 300;
    }
  }

  // Outro / result card.
  const finalState = states[states.length - 1];
  const result =
    finalState.status === "won" ? (finalState.player.name || "Your Team") + " wins!" :
    finalState.status === "lost" ? (finalState.opponent.name || "Opponent") + " wins!" :
    "Draw";
  cmd(cursor, (m) => { m.caption = result; m.outro = result; });

  const totalMs = cursor + OUTRO_MS;
  commands.sort((a, b) => a.t - b.t);
  return { commands, anims, floats, shakes, hurts, totalMs, intro: {
    a: states[0].player.name || "Your Team", b: states[0].opponent.name || "Opponent" } };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
// --- Pixel backdrop (ported verbatim from the live battle view) --------------
const BATTLE_BIOMES = {
  meadow: { key: "meadow", sky: ["#9fd4e8", "#b5e0ec", "#cdeaf0"], sun: "#f7d978", cloud: "#f4f9f7", hill: "#6fa06b", ground: "#8fbf6f", groundEdge: "#7aae61", groundDark: "#79a85c", groundLight: "#a3cd82", accent: "#e0788a" },
  wetland: { key: "wetland", sky: ["#a3c8d8", "#b9d8e0", "#cfe6e6"], sun: "#f2e2a0", cloud: "#eef6f4", hill: "#5d8a72", ground: "#6fa384", groundEdge: "#5d927a", groundDark: "#54806a", groundLight: "#8cb89c", accent: "#4f7f9d" },
  forest: { key: "forest", sky: ["#7fae9a", "#92bda4", "#a8ccae"], sun: "#e8e3b0", cloud: "#dcebdf", hill: "#3f6b4c", ground: "#5d8752", groundEdge: "#4d7544", groundDark: "#46663c", groundLight: "#739a64", accent: "#b06a45" },
  urban: { key: "urban", sky: ["#b6c3d4", "#c8d2dd", "#dadfe5"], sun: "#f3e9c5", cloud: "#eff2f4", hill: "#7c8894", ground: "#9aa3a3", groundEdge: "#86908f", groundDark: "#7e8887", groundLight: "#b2baba", accent: "#c2554d" },
  night: { key: "night", sky: ["#23304e", "#2d3c5e", "#3a4a6e"], sun: "#e8e6cf", cloud: "#465574", hill: "#1d2a40", ground: "#33485a", groundEdge: "#2a3d4e", groundDark: "#243443", groundLight: "#41586c", accent: "#8ea4c8" }
};
const TERRAIN_BACKDROP = {
  forest: BATTLE_BIOMES.forest, woodland: BATTLE_BIOMES.forest, grassland: BATTLE_BIOMES.meadow,
  agricultural: BATTLE_BIOMES.meadow, shrubland: BATTLE_BIOMES.meadow, desert: BATTLE_BIOMES.meadow,
  urban: BATTLE_BIOMES.urban, wetland: BATTLE_BIOMES.wetland, freshwater: BATTLE_BIOMES.wetland,
  polar: BATTLE_BIOMES.wetland, tundra: BATTLE_BIOMES.wetland
};
function seededPixelRng(seedString) {
  let hash = 2166136261;
  for (let i = 0; i < seedString.length; i++) { hash ^= seedString.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return function () { hash += 0x6d2b79f5; let v = hash; v = Math.imul(v ^ (v >>> 15), v | 1); v ^= v + Math.imul(v ^ (v >>> 7), v | 61); return ((v ^ (v >>> 14)) >>> 0) / 4294967296; };
}
function pickBiome(state) {
  if (state.terrain && TERRAIN_BACKDROP[state.terrain]) return TERRAIN_BACKDROP[state.terrain];
  const types = [].concat(getActive(state.opponent).types || []).concat(getActive(state.player).types || []);
  if (types.includes("Night")) return BATTLE_BIOMES.night;
  if (types.includes("Wetland")) return BATTLE_BIOMES.wetland;
  if (types.includes("Fungus") || types.includes("Decay") || types.includes("Wood")) return BATTLE_BIOMES.forest;
  if (types.includes("Urban")) return BATTLE_BIOMES.urban;
  return BATTLE_BIOMES.meadow;
}
function makePixelBackdropSvg(seedString, biome) {
  const rng = seededPixelRng(seedString + ":" + biome.key);
  const BW = 64, BH = 36;
  let rects = "";
  const px = (x, y, w, h, fill) => { rects += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + fill + '"/>'; };
  const skyH = Math.floor(BH * 0.6);
  for (let band = 0; band < biome.sky.length; band++) {
    const bandTop = Math.floor((skyH * band) / biome.sky.length);
    px(0, bandTop, BW, Math.ceil(skyH / biome.sky.length) + 1, biome.sky[band]);
  }
  const sunX = 5 + Math.floor(rng() * 22), sunY = 3 + Math.floor(rng() * 5);
  px(sunX, sunY, 4, 4, biome.sun); px(sunX + 1, sunY - 1, 2, 1, biome.sun); px(sunX + 1, sunY + 4, 2, 1, biome.sun);
  px(sunX - 1, sunY + 1, 1, 2, biome.sun); px(sunX + 4, sunY + 1, 1, 2, biome.sun);
  const cloudCount = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < cloudCount; i++) {
    const cw = 5 + Math.floor(rng() * 6), cx = Math.floor(rng() * (BW - cw)), cy = 2 + Math.floor(rng() * (skyH - 8));
    px(cx, cy, cw, 2, biome.cloud); px(cx + 1, cy - 1, cw - 2, 1, biome.cloud);
  }
  let hillY = skyH - 4 - Math.floor(rng() * 4);
  for (let x = 0; x < BW; x += 2) { hillY += Math.floor(rng() * 3) - 1; hillY = Math.max(skyH - 9, Math.min(skyH - 2, hillY)); px(x, hillY, 2, skyH - hillY + 1, biome.hill); }
  px(0, skyH, BW, BH - skyH, biome.ground); px(0, skyH, BW, 1, biome.groundEdge);
  for (let i = 0; i < 150; i++) px(Math.floor(rng() * BW), skyH + 1 + Math.floor(rng() * (BH - skyH - 1)), 1, 1, rng() < 0.5 ? biome.groundDark : biome.groundLight);
  for (let i = 0; i < 9; i++) {
    const tx = 1 + Math.floor(rng() * (BW - 3)), ty = skyH + 2 + Math.floor(rng() * (BH - skyH - 5));
    px(tx, ty, 1, 2, biome.accent); px(tx - 1, ty + 1, 1, 1, biome.groundDark); px(tx + 1, ty + 1, 1, 1, biome.groundDark);
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="36" viewBox="0 0 64 36" shape-rendering="crispEdges">' + rects + '</svg>';
}
function loadImage(src) {
  return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
}
// Pre-rasterize the backdrop once (it doesn't animate) into an offscreen canvas,
// scaled to "cover" the portrait frame, crisp pixels.
async function buildBackdrop(seedId, state) {
  const off = document.createElement("canvas");
  off.width = W; off.height = H;
  const octx = off.getContext("2d");
  octx.imageSmoothingEnabled = false;
  const biome = pickBiome(state);
  const svg = makePixelBackdropSvg(seedId, biome);
  const img = await loadImage("data:image/svg+xml," + encodeURIComponent(svg));
  if (img) {
    const scale = Math.max(W / 64, H / 36);
    const dw = 64 * scale, dh = 36 * scale;
    octx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  } else {
    octx.fillStyle = "#" + (biome.sky[0] || "9fd4e8").replace("#", ""); octx.fillRect(0, 0, W, H * 0.6);
    octx.fillStyle = biome.ground; octx.fillRect(0, H * 0.6, W, H * 0.4);
  }
  return off;
}
function drawBackground(model) {
  if (model._bg) ctx.drawImage(model._bg, 0, 0);
  else { ctx.fillStyle = "#9fd4e8"; ctx.fillRect(0, 0, W, H); }
}

function easeInOut(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
// piecewise-linear interpolation across lungeArc keyframes
function lungeOffset(p, lx, ly, arc) {
  const k = [[0, 0, 0], [0.38, 0.62 * lx, ly - arc], [0.58, lx, ly], [0.78, 0.3 * lx, 0.3 * ly], [1, 0, 0]];
  for (let i = 1; i < k.length; i++) {
    if (p <= k[i][0]) {
      const t = (p - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
      return [k[i - 1][1] + (k[i][1] - k[i - 1][1]) * t, k[i - 1][2] + (k[i][2] - k[i - 1][2]) * t];
    }
  }
  return [0, 0];
}
function knockOffset(p, kx, ky) {
  const k = [[0, 0, 0], [0.35, kx, ky], [0.7, 0.35 * kx, 0.35 * ky], [1, 0, 0]];
  for (let i = 1; i < k.length; i++) {
    if (p <= k[i][0]) {
      const t = (p - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
      return [k[i - 1][1] + (k[i][1] - k[i - 1][1]) * t, k[i - 1][2] + (k[i][2] - k[i - 1][2]) * t];
    }
  }
  return [0, 0];
}

const SPRITE = Math.round(W * 0.34);
const POS = {
  opponent: { x: W * 0.70, y: H * 0.34 },
  player: { x: W * 0.32, y: H * 0.70 }
};

function drawCreature(model, side, imgs, t) {
  const m = model[side];
  const base = POS[side];
  let dx = 0, dy = 0, flash = 0, faintP = 0;
  let row = 0; // idle
  let frameDur = 900;

  for (const a of model._anims) {
    if (a.side !== side) continue;
    const p = (t - a.start) / a.dur;
    if (a.kind === "lunge") {
      if (p >= 0 && p <= 1) {
        const dir = side === "player" ? 1 : -1;
        const lx = a.brace ? -dir * (14 + a.jx * 6) : dir * (44 + a.jx * 14);
        const ly = a.brace ? -(5 + Math.abs(a.jy) * 7) : -dir * (24 + a.jy * 10);
        const arc = a.brace ? (3 + Math.abs(a.ja) * 7) : (12 + Math.abs(a.ja) * 24);
        const [ox, oy] = lungeOffset(p, lx, ly, arc);
        dx += ox; dy += oy; row = a.row; frameDur = a.row >= 3 ? 680 : 520;
      }
    } else if (a.kind === "knock") {
      if (p >= 0 && p <= 1) {
        const dir = side === "player" ? -1 : 1;
        const force = Math.min(1.6, 0.8 + (a.dmg || 0) / 40);
        const kx = dir * (10 + Math.abs(a.jx) * 8) * force;
        const ky = -dir * (3 + Math.abs(a.jy) * 7) * force;
        const [ox, oy] = knockOffset(p, kx, ky); dx += ox; dy += oy;
      }
    } else if (a.kind === "flash") {
      if (p >= 0 && p <= 1) flash = Math.max(flash, Math.sin(p * Math.PI));
    } else if (a.kind === "faint") {
      // Only the creature that was active when this faint fired stays down; once
      // the replacement is sent in (activeSince advances past the faint) skip it.
      if (p >= 0 && a.start >= (m.activeSince ?? -Infinity)) faintP = Math.min(1, easeInOut(Math.min(1, p)));
    }
  }
  if (m.fainted && m.faintStart != null && t >= m.faintStart + FAINT_MS) faintP = 1;

  const yDrop = faintP * SPRITE * 0.42;
  const alpha = 1 - faintP;
  m._dbgAlpha = alpha;
  const cx = base.x + dx, cy = base.y + dy + yDrop;

  // shadow platform
  ctx.save();
  ctx.globalAlpha = 0.32 * alpha;
  ctx.fillStyle = "#0c130e";
  ctx.beginPath();
  ctx.ellipse(base.x, base.y + SPRITE * 0.46, SPRITE * 0.34, SPRITE * 0.10, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = alpha;
  const img = m.spriteUrl ? imgs.get(m.spriteUrl) : null;
  if (img && img.width) {
    const fw = img.width / 4, fh = img.height / 4;
    const col = Math.floor(((t % frameDur) / frameDur) * 4) % 4;
    const sx = col * fw, sy = row * fh;
    const scale = Math.min(SPRITE / fw, SPRITE / fh);
    const dw = fw * scale, dh = fh * scale;
    ctx.translate(cx, cy);
    if (side === "opponent") ctx.scale(-1, 1);
    if (flash > 0.02) ctx.filter = "brightness(" + (1 + flash * 1.5).toFixed(2) + ") saturate(1.6)";
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, sx, sy, fw, fh, -dw / 2, -dh, dw, dh);
    ctx.filter = "none";
  } else {
    // dummy "egg" fallback
    ctx.translate(cx, cy);
    const r = SPRITE * 0.32;
    ctx.fillStyle = side === "player" ? "#3d7d6e" : "#7d5a3d";
    if (flash > 0.02) ctx.fillStyle = "#ffffff";
    ctx.beginPath(); ctx.ellipse(0, -r, r, r * 1.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "700 " + Math.round(r * 0.7) + "px ui-sans-serif, system-ui";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText((m.name || "?").slice(0, 2), 0, -r);
  }
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPlate(model, side) {
  const m = model[side];
  const pw = W * 0.52, ph = 86;
  const x = side === "opponent" ? 22 : W - pw - 22;
  const y = side === "opponent" ? 22 : H - ph - 78;
  ctx.save();
  ctx.fillStyle = "rgba(252,253,250,0.92)";
  roundRect(x, y, pw, ph, 12); ctx.fill();
  ctx.fillStyle = "#1a2620";
  ctx.font = "800 26px ui-sans-serif, system-ui";
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(trunc(m.name || "?", 18), x + 16, y + 12);
  ctx.font = "600 15px ui-sans-serif, system-ui";
  ctx.fillStyle = "#5a6b62";
  ctx.fillText((m.types || []).join(" / "), x + 16, y + 42);
  // hp bar (display lerps toward target)
  m.hpShown = m.hpShown == null ? m.hp : m.hpShown + (m.hp - m.hpShown) * 0.25;
  const pct = m.max ? Math.max(0, Math.min(1, m.hpShown / m.max)) : 0;
  const barX = x + 16, barY = y + ph - 20, barW = pw - 32, barH = 10;
  ctx.fillStyle = "rgba(20,28,22,0.18)";
  roundRect(barX, barY, barW, barH, 5); ctx.fill();
  ctx.fillStyle = pct <= 0.25 ? "#d4583f" : pct <= 0.5 ? "#e0a82e" : "#2f9e5a";
  roundRect(barX, barY, Math.max(0, barW * pct), barH, 5); ctx.fill();
  ctx.restore();
}

const FLOAT_STYLE = {
  dmg: { color: "#fff", outline: "#a4392f", size: 46 },
  "dmg big": { color: "#fff", outline: "#a4392f", size: 60 },
  heal: { color: "#fff", outline: "#2f7d42", size: 44 },
  crit: { color: "#ffe066", outline: "#8a2be2", size: 60 },
  "word miss": { color: "#f0f0f0", outline: "#5a6068", size: 30 },
  "word eff-strong": { color: "#eaffe9", outline: "#2e9e4f", size: 30 },
  "word eff-weak": { color: "#e9e9e9", outline: "#6b7178", size: 26 },
  "word buff": { color: "#fff", outline: "#2f7d42", size: 28 },
  "word debuff": { color: "#fff", outline: "#9a4a14", size: 28 },
  "word status-fx": { color: "#fff", outline: "#6a3a8a", size: 28 }
};
function drawFloat(f, t) {
  const p = (t - f.start) / FLOAT_MS;
  if (p < 0 || p > 1) return;
  const st = FLOAT_STYLE[f.cls] || FLOAT_STYLE.dmg;
  const base = POS[f.side];
  const x = base.x, y = base.y - SPRITE * 0.55 - p * 70;
  ctx.save();
  ctx.globalAlpha = p > 0.6 ? (1 - p) / 0.4 : 1;
  ctx.font = "900 " + st.size + "px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.lineWidth = Math.max(3, st.size * 0.12); ctx.strokeStyle = st.outline;
  ctx.lineJoin = "round";
  ctx.strokeText(f.text, x, y); ctx.fillStyle = st.color; ctx.fillText(f.text, x, y);
  ctx.restore();
}

function drawCaption(text) {
  if (!text) return;
  const h = 64;
  ctx.save();
  ctx.fillStyle = "rgba(10,16,12,0.72)";
  ctx.fillRect(0, H - h, W, h);
  ctx.fillStyle = "#eef5f0";
  ctx.font = "600 22px ui-sans-serif, system-ui";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(trunc(text, 56), W / 2, H - h / 2);
  ctx.restore();
}

function drawIntro(intro, p) {
  const a = easeInOut(Math.min(1, p * 1.4));
  ctx.save();
  ctx.fillStyle = "rgba(8,12,10," + (0.7 * (1 - Math.max(0, (p - 0.7) / 0.3))) + ")";
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1 - Math.max(0, (p - 0.7) / 0.3);
  ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = "800 40px ui-sans-serif, system-ui";
  ctx.fillText(trunc(intro.a, 22), W / 2, H * 0.42 - 30 * (1 - a));
  ctx.font = "700 26px ui-sans-serif, system-ui"; ctx.fillStyle = "#9fe0cf";
  ctx.fillText("VS", W / 2, H * 0.5);
  ctx.font = "800 40px ui-sans-serif, system-ui"; ctx.fillStyle = "#fff";
  ctx.fillText(trunc(intro.b, 22), W / 2, H * 0.58 + 30 * (1 - a));
  ctx.restore();
}

function drawOutro(text, p) {
  ctx.save();
  ctx.fillStyle = "rgba(8,12,10," + (0.5 * Math.min(1, p * 2)) + ")";
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = Math.min(1, p * 2);
  ctx.fillStyle = "#ffe066"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = "900 46px ui-sans-serif, system-ui";
  ctx.fillText(trunc(text, 24), W / 2, H * 0.46);
  ctx.font = "700 22px ui-sans-serif, system-ui"; ctx.fillStyle = "#cfe8df";
  ctx.fillText("iNat Battler", W / 2, H * 0.46 + 44);
  ctx.restore();
}

function trunc(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

// ---------------------------------------------------------------------------
// Render one frame at absolute time t (ms)
// ---------------------------------------------------------------------------
function renderFrame(model, tl, t) {
  // apply commands up to t
  while (model._ci < tl.commands.length && tl.commands[model._ci].t <= t) {
    tl.commands[model._ci].fn(model); model._ci++;
  }
  model._anims = tl.anims;

  // stage shake
  let sx = 0, sy = 0;
  for (const s of tl.shakes) {
    const p = (t - s.start) / SHAKE_MS;
    if (p >= 0 && p <= 1) { const a = (1 - p) * 6; sx += Math.sin(p * 40) * a; sy += Math.cos(p * 37) * a * 0.5; }
  }
  ctx.save();
  ctx.translate(sx, sy);
  drawBackground(model);
  // draw opponent (back) then player (front)
  drawCreature(model, "opponent", model._imgs, t);
  drawCreature(model, "player", model._imgs, t);
  drawPlate(model, "opponent");
  drawPlate(model, "player");
  // hurt vignette
  for (const hrt of tl.hurts) {
    const p = (t - hrt.start) / HURT_MS;
    if (p >= 0 && p <= 1) {
      const g = ctx.createRadialGradient(W / 2, H / 2, W * 0.2, W / 2, H / 2, W * 0.7);
      g.addColorStop(0, "rgba(197,79,69,0)"); g.addColorStop(1, "rgba(197,79,69," + (0.5 * (1 - p)) + ")");
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
  }
  for (const f of tl.floats) drawFloat(f, t);
  drawCaption(model.caption);
  ctx.restore();

  // intro / outro overlays (not shaken)
  if (t < INTRO_MS) drawIntro(tl.intro, t / INTRO_MS);
  if (model.outro && t >= tl.totalMs - OUTRO_MS) drawOutro(model.outro, (t - (tl.totalMs - OUTRO_MS)) / OUTRO_MS);
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------
async function pickCodec() {
  const candidates = ["avc1.4D0028", "avc1.4D001F", "avc1.640028", "avc1.42E01F"];
  for (const codec of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, bitrate: 2_800_000, framerate: FPS });
      if (support && support.supported) return codec;
    } catch (_) {}
  }
  return null;
}

async function encode(model, tl) {
  if (typeof VideoEncoder === "undefined") throw new Error("WebCodecs (VideoEncoder) is not available in this browser.");
  const codec = await pickCodec();
  if (!codec) throw new Error("No supported H.264 encoder configuration found.");

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H, frameRate: FPS },
    fastStart: "in-memory"
  });
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { throw e; }
  });
  encoder.configure({ codec, width: W, height: H, bitrate: 2_800_000, framerate: FPS, latencyMode: "quality" });

  const totalMs = Math.min(tl.totalMs, MAX_SECONDS * 1000);
  const totalFrames = Math.ceil((totalMs / 1000) * FPS);
  const usPerFrame = 1_000_000 / FPS;

  for (let i = 0; i < totalFrames; i++) {
    const t = (i / FPS) * 1000;
    renderFrame(model, tl, t);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(i * usPerFrame), duration: Math.round(usPerFrame) });
    encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
    frame.close();
    if (encoder.encodeQueueSize > 12) await new Promise((r) => setTimeout(r, 0));
    if (i % 20 === 0) setStatus("Rendering… " + Math.round((i / totalFrames) * 100) + "%");
  }
  await encoder.flush();
  muxer.finalize();
  const buffer = muxer.target.buffer;
  return { buffer, durationMs: totalMs };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}

async function run() {
  try {
    setStatus("Loading battle…");
    const data = await loadStates();
    setStatus("Loading sprites…");
    const imgs = await preloadAll(data.states);
    const bg = await buildBackdrop(battleId, data.states[0]);
    const tl = buildTimeline(data);
    const model = { player: {}, opponent: {}, caption: "", outro: null, _ci: 0, _anims: [], _imgs: imgs, _bg: bg };

    // Debug: ?still=<ms> renders a single frame (no encode) so a screenshot can
    // inspect an exact moment of the battle.
    if (Q.has("still")) {
      // Re-render any timestamp from a fresh model (commands replay from t=0).
      const renderAt = (ms) => {
        const fresh = { player: {}, opponent: {}, caption: "", outro: null, _ci: 0, _anims: [], _imgs: imgs, _bg: bg };
        renderFrame(fresh, tl, ms);
        return { t: ms, player: { name: fresh.player.name, alpha: fresh.player._dbgAlpha }, opponent: { name: fresh.opponent.name, alpha: fresh.opponent._dbgAlpha } };
      };
      window.__renderAt = renderAt;
      const st = clampInt(Q.get("still"), 4000, 0, 600000);
      const info = renderAt(st);
      window.__replayResult = {
        ok: true, still: true, totalMs: Math.round(tl.totalMs),
        faints: tl.anims.filter((a) => a.kind === "faint").map((a) => ({ side: a.side, start: Math.round(a.start) })),
        ...info
      };
      setStatus("Still frame at " + st + "ms (totalMs=" + Math.round(tl.totalMs) + ")");
      return;
    }
    setStatus("Rendering…");
    const t0 = performance.now();
    const { buffer, durationMs } = await encode(model, tl);
    const blob = new Blob([buffer], { type: "video/mp4" });
    window.__replayBlob = blob;
    window.__replayResult = {
      ok: true, mime: "video/mp4", width: W, height: H,
      durationMs, bytes: buffer.byteLength, base64: bufferToBase64(buffer),
      battleId, encodeMs: Math.round(performance.now() - t0)
    };
    setStatus("Done — " + (buffer.byteLength / 1024 / 1024).toFixed(2) + " MB, " + (durationMs / 1000).toFixed(1) + "s");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "battle-" + battleId + ".mp4"; a.textContent = "Download MP4"; a.className = "dl";
    const dlBtn = document.createElement("button"); dlBtn.textContent = "Download MP4";
    dlBtn.onclick = () => a.click();
    barEl.appendChild(dlBtn);
    if (Q.get("download") === "1") a.click();

    if (Q.get("share") === "1") buildShareUI(data, blob);
  } catch (err) {
    console.error(err);
    window.__replayResult = { ok: false, error: String(err && err.message || err) };
    setStatus("Error: " + (err && err.message || err));
  }
}

function defaultCaption(data) {
  const fin = data.states[data.states.length - 1];
  const pName = data.states[0].player.name || "My team";
  const oName = data.states[0].opponent.name || "the opponent";
  const turns = Math.max(1, fin.turn - 1);
  const outcome = fin.status === "won" ? (pName + " won") : fin.status === "lost" ? (oName + " won") : "A clash";
  return outcome + " in " + turns + " turns! \\u2694\\uFE0F\\uD83E\\uDD8B #iNatBattler";
}

function buildShareUI(data, blob) {
  const wrap = document.querySelector(".wrap");
  const box = document.createElement("div");
  box.style.cssText = "display:grid;gap:10px;width:min(92vw,360px);text-align:left";
  const ta = document.createElement("textarea");
  ta.value = defaultCaption(data);
  ta.rows = 3; ta.maxLength = 280;
  ta.style.cssText = "width:100%;border-radius:10px;border:1px solid #2c3a36;background:#0f1416;color:#e7eef0;padding:8px;font:inherit;box-sizing:border-box";
  const note = document.createElement("div");
  note.className = "status";
  note.textContent = "Shares to the iNat Battler feed (@wildmarch.bsky.social), credited to you.";
  const post = document.createElement("button"); post.textContent = "Share to the feed \\uD83E\\uDD8B";
  const out = document.createElement("div"); out.className = "status";

  post.onclick = async () => {
    post.disabled = true; out.textContent = "Uploading + posting (this can take ~30s)…";
    try {
      const params = new URLSearchParams({ caption: ta.value, w: String(W), h: String(H) });
      const res = await fetch("/api/battles/" + encodeURIComponent(battleId) + "/share-video?" + params, {
        method: "POST", credentials: "include",
        headers: { "content-type": "video/mp4" },
        body: blob
      });
      const data2 = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data2.error || ("Failed (" + res.status + ")"));
      out.innerHTML = "";
      if (data2.brand && data2.brand.webUrl) {
        out.appendChild(document.createTextNode("Posted! "));
        const a = document.createElement("a"); a.href = data2.brand.webUrl; a.target = "_blank"; a.textContent = "View on Bluesky"; a.style.color = "#7fe0cf";
        out.appendChild(a);
        post.textContent = "Shared \\u2713";
      } else {
        throw new Error((data2.brand && data2.brand.error) || "Post failed");
      }
    } catch (err) {
      post.disabled = false;
      out.textContent = "Error: " + (err && err.message || err);
    }
  };

  box.appendChild(ta); box.appendChild(note); box.appendChild(post); box.appendChild(out);
  wrap.appendChild(box);
}

window.__renderReplay = run;
if (AUTOSTART) run();
</script>
</body>
</html>`;
