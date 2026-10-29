/**
 * Generates icons/icon{16,32,48,128}.png (an indigo tile with a white
 * "download into tray" glyph). The PNGs are committed, so this only needs to
 * run if you change the design: `npm run icons`.
 *
 * Uses a tiny PNG encoder (zlib + CRC32) so no image library is required.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in unit coordinates (0..1).
const insideRoundedRect = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const insideRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const insideTriangle = (x, y, [ax, ay], [bx, by], [cx, cy]) => {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const insideGlyph = (x, y) =>
  insideRect(x, y, 0.43, 0.17, 0.57, 0.5) || // arrow shaft
  insideTriangle(x, y, [0.27, 0.44], [0.73, 0.44], [0.5, 0.67]) || // arrow head
  insideRect(x, y, 0.2, 0.74, 0.8, 0.84) || // tray bottom
  insideRect(x, y, 0.2, 0.57, 0.3, 0.84) || // tray left
  insideRect(x, y, 0.7, 0.57, 0.8, 0.84); // tray right

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const top = [99, 102, 241]; // #6366f1
  const bottom = [79, 70, 229]; // #4f46e5
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let tile = 0;
      let glyph = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          if (insideRoundedRect(x, y, 0.22)) {
            tile += 1;
            if (insideGlyph(x, y)) glyph += 1;
          }
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE;
      const t = py / (size - 1);
      const bg = top.map((c, i) => Math.round(c + (bottom[i] - c) * t));
      const g = tile ? glyph / tile : 0;
      const offset = (py * size + px) * 4;
      pixels[offset] = Math.round(bg[0] + (255 - bg[0]) * g);
      pixels[offset + 1] = Math.round(bg[1] + (255 - bg[1]) * g);
      pixels[offset + 2] = Math.round(bg[2] + (255 - bg[2]) * g);
      pixels[offset + 3] = Math.round((tile / samples) * 255);
    }
  }
  return pixels;
}

await mkdir(path.join(root, 'icons'), { recursive: true });
for (const size of SIZES) {
  const file = path.join(root, 'icons', `icon${size}.png`);
  await writeFile(file, encodePng(size, render(size)));
  console.log(`Wrote ${path.relative(root, file)}`);
}
