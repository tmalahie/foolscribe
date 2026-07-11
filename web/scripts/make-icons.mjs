/**
 * Génère les icônes PWA (PNG) sans dépendance : fond zinc-900, croche ambre
 * dessinée au pixel. Lancé une fois, résultats commités dans public/icons/.
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync } from 'zlib';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../public/icons');

// --- Encodeur PNG minimal (RGBA, sans filtre) -------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtre none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Dessin : croche ambre sur fond sombre -----------------------------------
const BG = [0x18, 0x18, 0x1b]; // zinc-900
const FG = [0xfb, 0xbf, 0x24]; // amber-400

function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const sign = (x1, y1, x2, y2, x3, y3) =>
    (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let color = BG;
      // Tête de note
      if (inEllipse(x, y, 0.44 * s, 0.68 * s, 0.14 * s, 0.105 * s)) color = FG;
      // Hampe
      if (x >= 0.545 * s && x <= 0.585 * s && y >= 0.24 * s && y <= 0.68 * s)
        color = FG;
      // Crochet (drapeau)
      if (
        inTriangle(
          x,
          y,
          [0.545 * s, 0.24 * s],
          [0.76 * s, 0.34 * s],
          [0.545 * s, 0.46 * s],
        )
      )
        color = FG;
      const i = (y * s + x) * 4;
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = 255;
    }
  }
  return encodePng(s, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'icon-192.png'), drawIcon(192));
writeFileSync(join(OUT_DIR, 'icon-512.png'), drawIcon(512));
writeFileSync(join(OUT_DIR, 'apple-touch-icon.png'), drawIcon(180));
console.log(`Icônes générées dans ${OUT_DIR}`);
