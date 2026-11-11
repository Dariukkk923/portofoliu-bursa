/**
 * Generează iconița aplicației (build/icon.png, 1024×1024) fără nicio
 * dependență: desenează un pătrat rotunjit albastru cu un grafic de bare alb
 * și scrie fișierul PNG direct. electron-builder derivă din el formatele .ico
 * (Windows) și .icns (macOS).
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const SIZE = 1024;
const SS = 3; // supraeșantionare pentru margini netede
const BG = [42, 111, 208];
const FG = [255, 255, 255];

/** Distanța cu semn față de un dreptunghi rotunjit (negativă în interior). */
function roundedRect(px, py, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  return Math.hypot(px - cx, py - cy) - r;
}

/** Barele graficului: x stânga, înălțime (ca fracțiuni din latura iconiței). */
const BARS = [
  [0.235, 0.22],
  [0.385, 0.34],
  [0.535, 0.28],
  [0.685, 0.5]
];
const BAR_W = 0.09;
const BASE_Y = 0.76;

function sample(x, y) {
  // fundal: pătrat rotunjit cu o mică margine transparentă
  if (roundedRect(x, y, 0.06, 0.06, 0.94, 0.94, 0.2) > 0) return null;
  for (const [bx, h] of BARS) {
    if (roundedRect(x, y, bx, BASE_Y - h, bx + BAR_W, BASE_Y, 0.03) <= 0) return FG;
  }
  return BG;
}

const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample((px + (sx + 0.5) / SS) / SIZE, (py + (sy + 0.5) / SS) / SIZE);
        if (!c) continue;
        r += c[0];
        g += c[1];
        b += c[2];
        a++;
      }
    }
    const i = (py * SIZE + px) * 4;
    if (a > 0) {
      pixels[i] = Math.round(r / a);
      pixels[i + 1] = Math.round(g / a);
      pixels[i + 2] = Math.round(b / a);
      pixels[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
}

// --- scrierea PNG ---------------------------------------------------------
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // 8 biți pe canal
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4); // octetul 0 al fiecărei linii = filtru „None”
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', png);
console.log(`build/icon.png scris (${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(0)} KB)`);
