// Deterministic icon generator. Run with: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../apps/extension/public');

const BG = [0x0a, 0x0a, 0x0a];
const ACCENT = [0xe6, 0x19, 0x19];
const FG = [0xea, 0xea, 0xea];

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const source = (y * size + x) * 4;
      const target = rowStart + 1 + x * 4;
      raw[target] = pixels[source];
      raw[target + 1] = pixels[source + 1];
      raw[target + 2] = pixels[source + 2];
      raw[target + 3] = pixels[source + 3];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** A screen outline with an attached tab, in the CRT palette. */
function draw(size, stroke, border) {
  const pixels = Buffer.alloc(size * size * 4);
  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    pixels[i] = color[0];
    pixels[i + 1] = color[1];
    pixels[i + 2] = color[2];
    pixels[i + 3] = 255;
  };
  const s = (value) => Math.round((value / 128) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, BG);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (x < border || y < border || x >= size - border || y >= size - border) set(x, y, ACCENT);
  }
  const screen = { x0: s(26), y0: s(46), x1: s(102), y1: s(96) };
  for (let y = screen.y0; y <= screen.y1; y++) {
    for (let x = screen.x0; x <= screen.x1; x++) {
      const edge = x - screen.x0 < stroke || screen.x1 - x < stroke || y - screen.y0 < stroke || screen.y1 - y < stroke;
      if (edge) set(x, y, FG);
    }
  }
  const tab = { x0: s(26), y0: s(22), x1: s(70), y1: s(42) };
  for (let y = tab.y0; y <= tab.y1; y++) for (let x = tab.x0; x <= tab.x1; x++) set(x, y, FG);
  return pixels;
}

mkdirSync(outDir, { recursive: true });
for (const [size, stroke, border] of [[128, 4, 6], [48, 2, 3], [16, 1, 1]]) {
  const file = resolve(outDir, `icon-${size}.png`);
  writeFileSync(file, png(size, draw(size, stroke, border)));
  console.log(`wrote ${file}`);
}
