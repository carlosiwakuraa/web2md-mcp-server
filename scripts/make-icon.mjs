// Gera icon.png (512x512) sem dependências: fundo azul arredondado com uma seta
// para baixo (página -> Markdown). Uso: node scripts/make-icon.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const N = 512;
const S = 256; // as formas são definidas num espaço 256x256 e escaladas
const px = Buffer.alloc(N * N * 4);

function inRoundedRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), S - 1 - r);
  const cy = Math.min(Math.max(y, r), S - 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inArrow(x, y) {
  // haste
  if (x >= 108 && x <= 148 && y >= 56 && y <= 140) return true;
  // ponta (triângulo)
  if (y >= 130 && y <= 196) {
    const half = (196 - y) * 0.95;
    if (Math.abs(x - 128) <= half) return true;
  }
  // base
  return x >= 68 && x <= 188 && y >= 208 && y <= 224;
}

for (let py = 0; py < N; py++) {
  for (let pxx = 0; pxx < N; pxx++) {
    const x = (pxx * S) / N;
    const y = (py * S) / N;
    const o = (py * N + pxx) * 4;
    if (!inRoundedRect(x, y, 48)) continue; // transparente
    if (inArrow(x, y)) {
      px.set([255, 255, 255, 255], o);
    } else {
      const t = y / S; // gradiente vertical
      px.set([Math.round(37 + 20 * t), Math.round(99 + 10 * t), Math.round(235 - 40 * t), 255], o);
    }
  }
}

const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // profundidade
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("../icon.png", import.meta.url), png);
console.log(`icon.png gerado (${png.length} bytes)`);
