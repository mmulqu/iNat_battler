// Generates placeholder 4x4 status-effect sprite sheets (256x256 RGBA PNGs,
// 16 frames of 64px read left-to-right, top-to-bottom) into src/assets/.
// These are stand-ins: overwrite the files with generated art using the same
// filenames and grid layout.
//
//   node scripts/make-status-placeholders.mjs

import zlib from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SIZE = 256;
const CELL = 64;
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "assets");

// --- minimal PNG encoder (RGBA, no interlace) -------------------------------

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes) {
  let c = -1;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// --- tiny pixel-drawing helpers ---------------------------------------------

function makeCanvas() {
  return Buffer.alloc(SIZE * SIZE * 4);
}

function px(buf, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

function fillRect(buf, x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) px(buf, Math.round(xx), Math.round(yy), color);
  }
}

function fillCircle(buf, cx, cy, rad, color) {
  for (let yy = Math.floor(cy - rad); yy <= cy + rad; yy += 1) {
    for (let xx = Math.floor(cx - rad); xx <= cx + rad; xx += 1) {
      if ((xx - cx) ** 2 + (yy - cy) ** 2 <= rad * rad) px(buf, Math.round(xx), Math.round(yy), color);
    }
  }
}

function ringCircle(buf, cx, cy, rad, thickness, color) {
  for (let yy = Math.floor(cy - rad - 1); yy <= cy + rad + 1; yy += 1) {
    for (let xx = Math.floor(cx - rad - 1); xx <= cx + rad + 1; xx += 1) {
      const d = Math.sqrt((xx - cx) ** 2 + (yy - cy) ** 2);
      if (Math.abs(d - rad) <= thickness / 2) px(buf, Math.round(xx), Math.round(yy), color);
    }
  }
}

// --- per-status frame painters (ox/oy = cell origin, t = phase 0..1) --------

const PAINTERS = {
  stunned(buf, ox, oy, t) {
    const shadow = [122, 90, 0, 255];
    const star = [255, 216, 74, 255];
    for (let k = 0; k < 3; k += 1) {
      const angle = 2 * Math.PI * (t + k / 3);
      const sx = ox + 32 + Math.round(14 * Math.cos(angle));
      const sy = oy + 22 + Math.round(7 * Math.sin(angle));
      fillRect(buf, sx - 1, sy - 5, 3, 11, shadow);
      fillRect(buf, sx - 5, sy - 1, 11, 3, shadow);
      fillRect(buf, sx - 1, sy - 4, 2, 9, star);
      fillRect(buf, sx - 4, sy - 1, 9, 2, star);
      px(buf, sx, sy, [255, 250, 220, 255]);
    }
  },

  marked(buf, ox, oy, t) {
    const red = [232, 68, 58, 255];
    const dark = [126, 29, 22, 255];
    const r = 12 + Math.round(3 * Math.sin(2 * Math.PI * t));
    ringCircle(buf, ox + 32, oy + 32, r + 1, 2, dark);
    ringCircle(buf, ox + 32, oy + 32, r, 2, red);
    for (const [dx, dy, w, h] of [
      [-1, -r - 5, 3, 9], [-1, r - 4, 3, 9], [-r - 5, -1, 9, 3], [r - 4, -1, 9, 3]
    ]) {
      fillRect(buf, ox + 32 + dx, oy + 32 + dy, w, h, red);
    }
    fillCircle(buf, ox + 32, oy + 32, 2, dark);
  },

  poisoned(buf, ox, oy, t) {
    for (let k = 0; k < 3; k += 1) {
      const progress = (t + k / 3) % 1;
      const bx = ox + 22 + k * 10 + Math.round(3 * Math.sin(2 * Math.PI * (progress * 2 + k)));
      const by = oy + 48 - Math.round(progress * 30);
      const rad = 3 + k;
      const alpha = Math.round(255 * (1 - progress * 0.55));
      fillCircle(buf, bx, by, rad + 1, [74, 36, 99, alpha]);
      fillCircle(buf, bx, by, rad, [155, 89, 201, alpha]);
      px(buf, bx - 1, by - rad + 1, [226, 196, 246, alpha]);
    }
  },

  shielded(buf, ox, oy, t) {
    const dark = [29, 78, 150, 255];
    const blue = [63, 127, 214, 255];
    const shine = [156, 196, 240, 255];
    const shift = Math.round(t * 28);
    for (let row = -14; row <= 16; row += 1) {
      const half = row <= 2 ? 13 : Math.max(0, Math.round(13 - ((row - 2) * 13) / 14));
      for (let dx = -half; dx <= half; dx += 1) {
        const edge = Math.abs(dx) >= half - 1 || row <= -13 || row >= 15 ||
          (row > 2 && Math.abs(dx) >= half - 1);
        const band = ((dx + row + shift) % 28 + 28) % 28 < 4;
        px(buf, ox + 32 + dx, oy + 30 + row, edge ? dark : band ? shine : blue);
      }
    }
  },

  rallied(buf, ox, oy, t) {
    const orange = [240, 138, 46, 255];
    const dark = [150, 70, 10, 255];
    for (let k = 0; k < 2; k += 1) {
      const progress = (t * 2 + k / 2) % 1;
      const baseY = oy + 46 - Math.round(progress * 22);
      const alpha = Math.round(255 * (1 - progress * 0.5));
      for (let d = 0; d < 9; d += 1) {
        for (let th = 0; th < 3; th += 1) {
          px(buf, ox + 32 - d, baseY + d + th + 1, [...dark.slice(0, 3), alpha]);
          px(buf, ox + 32 + d, baseY + d + th + 1, [...dark.slice(0, 3), alpha]);
          px(buf, ox + 32 - d, baseY + d + th, [...orange.slice(0, 3), alpha]);
          px(buf, ox + 32 + d, baseY + d + th, [...orange.slice(0, 3), alpha]);
        }
      }
    }
  }
};

for (const [status, paint] of Object.entries(PAINTERS)) {
  const buf = makeCanvas();
  for (let frame = 0; frame < 16; frame += 1) {
    paint(buf, (frame % 4) * CELL, Math.floor(frame / 4) * CELL, frame / 16);
  }
  const file = path.join(OUT_DIR, `status-${status}.png`);
  writeFileSync(file, encodePng(buf));
  console.log(`wrote ${file}`);
}
