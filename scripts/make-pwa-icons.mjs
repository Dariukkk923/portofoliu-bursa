/**
 * Generează iconițele versiunii web (src/web/public/icons) cu același desen ca build/icon.png,
 * fără dependențe. iOS rotunjește singur colțurile, deci apple-touch-icon și varianta „maskable”
 * sunt pătrate pline (maskable are desenul mai mic, ca să rămână în zona sigură).
 *
 *   node scripts/make-pwa-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const SS = 3;
const BG = [42, 111, 208];
const FG = [255, 255, 255];
const BARS = [
  [0.235, 0.22],
  [0.385, 0.34],
  [0.535, 0.28],
  [0.685, 0.5]
];
const BAR_W = 0.09;
const BASE_Y = 0.76;

const roundedRect = (px, py, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  return Math.hypot(px - cx, py - cy) - r;
};

/** kind: 'round' (cu margine transparentă), 'full' (pătrat plin), 'maskable' (pătrat plin, desen redus). */
function sample(x, y, kind) {
  if (kind === 'round' && roundedRect(x, y, 0.06, 0.06, 0.94, 0.94, 0.2) > 0) return null;
  const k = kind === 'maskable' ? 0.7 : 1;
  const tx = (x - 0.5) / k + 0.5;
  const ty = (y - 0.5) / k + 0.5;
  for (const [bx, h] of BARS) {
    if (roundedRect(tx, ty, bx, BASE_Y - h, bx + BAR_W, BASE_Y, 0.03) <= 0) return FG;
  }
  return BG;
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

function png(size, kind) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, kind);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a++;
        }
      }
      const i = py * (size * 4 + 1) + 1 + px * 4;
      if (a > 0) {
        raw[i] = Math.round(r / a);
        raw[i + 1] = Math.round(g / a);
        raw[i + 2] = Math.round(b / a);
        raw[i + 3] = Math.round((a / (SS * SS)) * 255);
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const out = 'src/web/public/icons';
mkdirSync(out, { recursive: true });
const files = [
  ['icon-192.png', 192, 'round'],
  ['icon-512.png', 512, 'round'],
  ['maskable-512.png', 512, 'maskable'],
  ['apple-touch-icon.png', 180, 'full']
];
for (const [name, size, kind] of files) {
  writeFileSync(`${out}/${name}`, png(size, kind));
  console.log(`${out}/${name} (${size}×${size})`);
}
