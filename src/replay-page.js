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
const imgCache = new Map();
function preload(url) {
  if (!url) return Promise.resolve(null);
  if (imgCache.has(url)) return imgCache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
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
const TERRAIN_SKY = {
  wetland: ["#7fb6c9", "#a9d3d6"], forest: ["#7fa86a", "#a7c98b"], woodland: ["#7fa86a", "#a7c98b"],
  urban: ["#9aa6b2", "#c3cdd6"], desert: ["#e3c489", "#f0dcae"], default: ["#8fc0a9", "#bfe0c8"]
};
const TERRAIN_GROUND = {
  wetland: "#4f7a5c", forest: "#3f6b3a", urban: "#6b7178", desert: "#caa468", default: "#5b8c5a"
};

function drawBackground(model, terrain) {
  const sky = TERRAIN_SKY[terrain] || TERRAIN_SKY.default;
  const g = ctx.createLinearGradient(0, 0, 0, H * 0.62);
  g.addColorStop(0, sky[0]); g.addColorStop(1, sky[1]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H * 0.62);
  ctx.fillStyle = TERRAIN_GROUND[terrain] || TERRAIN_GROUND.default;
  ctx.fillRect(0, H * 0.62 - 1, W, H - H * 0.62 + 1);
  // subtle ground band highlight
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fillRect(0, H * 0.62 - 1, W, 4);
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
      if (p >= 0) faintP = Math.min(1, easeInOut(Math.min(1, p)));
    }
  }
  if (m.fainted && m.faintStart != null && t >= m.faintStart + FAINT_MS) faintP = 1;

  const yDrop = faintP * SPRITE * 0.42;
  const alpha = 1 - faintP;
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
function renderFrame(model, tl, terrain, t) {
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
  drawBackground(model, terrain);
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

async function encode(model, tl, terrain) {
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
    renderFrame(model, tl, terrain, t);
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
    const tl = buildTimeline(data);
    const model = { player: {}, opponent: {}, caption: "", outro: null, _ci: 0, _anims: [], _imgs: imgs };
    setStatus("Rendering…");
    const t0 = performance.now();
    const { buffer, durationMs } = await encode(model, tl, data.states[0].terrain || "default");
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
    const btn = document.createElement("button"); btn.textContent = "Download MP4";
    btn.onclick = () => a.click();
    barEl.appendChild(btn);
    if (Q.get("download") === "1") a.click();
  } catch (err) {
    console.error(err);
    window.__replayResult = { ok: false, error: String(err && err.message || err) };
    setStatus("Error: " + (err && err.message || err));
  }
}

window.__renderReplay = run;
if (AUTOSTART) run();
</script>
</body>
</html>`;
