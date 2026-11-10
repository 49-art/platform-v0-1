/**
 * Minimal PNG writer (RGB, 8-bit, stored deflate blocks). Used only to draw the SAMPLE member avatars that the
 * seeder creates in sample mode, so the discovery screen has something to show before real members exist.
 * No dependency, no compression: a 256x256 image is ~197 KB, comfortably inside D1's 1 MB row limit.
 */

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (const x of bytes) { a = (a + x) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const body = new Uint8Array(t.length + data.length);
  body.set(t); body.set(data, t.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32(data.length)); out.set(body, 4); out.set(u32(crc32(body)), 4 + body.length);
  return out;
}

/** zlib stream made of stored (type 0) deflate blocks, max 65535 bytes each. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  for (let i = 0; i < raw.length; i += 65535) {
    const slice = raw.subarray(i, Math.min(i + 65535, raw.length));
    const last = i + 65535 >= raw.length ? 1 : 0;
    const len = slice.length;
    blocks.push(new Uint8Array([last, len & 255, len >>> 8, ~len & 255, (~len >>> 8) & 255]), slice);
  }
  blocks.push(u32(adler32(raw)));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}

export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width)); ihdr.set(u32(height), 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlibStored(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** A neon gradient tile with a diagonal "SAMPLE" band: unmistakably not a real person's photo. */
export function sampleAvatar(seed: number, size = 256): Uint8Array {
  const palette: [number, number, number][] = [[57, 255, 20], [255, 16, 240], [0, 255, 255], [255, 240, 0], [255, 94, 0], [173, 0, 255]];
  const a = palette[seed % palette.length]!, b = palette[(seed * 7 + 3) % palette.length]!;
  const rgb = new Uint8Array(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const t = (x + y) / (2 * size);
    const band = Math.abs(x - y) < size * 0.06;
    const i = (y * size + x) * 3;
    rgb[i] = band ? 8 : Math.round(a[0] * (1 - t) + b[0] * t);
    rgb[i + 1] = band ? 8 : Math.round(a[1] * (1 - t) + b[1] * t);
    rgb[i + 2] = band ? 8 : Math.round(a[2] * (1 - t) + b[2] * t);
  }
  return encodePng(size, size, rgb);
}
