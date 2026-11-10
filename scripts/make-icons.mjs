// Draws the app icons (original artwork: the verification ring on deep violet). No third-party images.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const u32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const chunk = (t, d) => { const b = Buffer.concat([Buffer.from(t), d]); return Buffer.concat([u32(d.length), b, u32(crc(b))]); };
function png(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.concat([u32(w), u32(h), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const INK = hex("#120a26"), DEEP = hex("#0c061c"), CYAN = hex("#18f0ff"), PINK = hex("#ff2e9a"), VOLT = hex("#c6ff1a");
const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
function ringColour(angle) { // conic sweep cyan -> pink -> volt -> cyan
  const t = ((angle / (2 * Math.PI)) + 1) % 1;
  if (t < 1 / 3) return mix(CYAN, PINK, t * 3);
  if (t < 2 / 3) return mix(PINK, VOLT, (t - 1 / 3) * 3);
  return mix(VOLT, CYAN, (t - 2 / 3) * 3);
}
/** scale: ring outer radius as a fraction of half the size (smaller for maskable safe zone). */
function icon(size, scale = 0.78, rounded = false) {
  const px = Buffer.alloc(size * size * 4);
  const c = size / 2, R = c * scale, r = R * 0.72, ss = 3;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let acc = [0, 0, 0], alpha = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const fx = x + (sx + 0.5) / ss - c, fy = y + (sy + 0.5) / ss - c;
      const d = Math.hypot(fx, fy);
      let col = mix(INK, DEEP, Math.min(1, d / (c * 1.4)));
      if (d <= R && d >= r) col = ringColour(Math.atan2(fy, fx));
      else if (d < r && d > r - size * 0.012) col = mix(col, CYAN, 0.35);
      // a small check mark in the centre: the "verified" tick
      const u = fx / R, v = fy / R;
      const onTick = (Math.abs(v - (u * 1.0 + 0.12)) < 0.07 && u > -0.3 && u < -0.05) || (Math.abs(v - (-u * 1.15 + 0.05)) < 0.07 && u >= -0.08 && u < 0.36);
      if (onTick && d < r) col = VOLT;
      let a = 255;
      if (rounded) { const k = size * 0.22, qx = Math.max(Math.abs(fx) - (c - k), 0), qy = Math.max(Math.abs(fy) - (c - k), 0); if (Math.hypot(qx, qy) > k) a = 0; }
      acc = acc.map((s, i) => s + col[i]); alpha += a;
    }
    const n = ss * ss, i = (y * size + x) * 4;
    px[i] = acc[0] / n; px[i + 1] = acc[1] / n; px[i + 2] = acc[2] / n; px[i + 3] = alpha / n;
  }
  return png(size, size, px);
}
function og(w, h) {
  const px = Buffer.alloc(w * h * 4);
  const cx = w * 0.5, cy = h * 0.5;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let col = mix(hex("#2a1462"), DEEP, Math.min(1, Math.hypot(x - cx, (y - cy) * 1.6) / (w * 0.6)));
    if (x % 32 === 0 || y % 32 === 0) col = mix(col, hex("#44337f"), 0.35);
    for (const [ox, rc] of [[-150, PINK], [150, CYAN]]) {
      const d = Math.hypot(x - (cx + ox), y - cy);
      if (d < 130 && d > 100) col = mix(rc, CYAN, 0.2);
    }
    if (Math.abs(y - cy) < 4 && Math.abs(x - cx) < 30) col = VOLT;
    px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = 255;
  }
  return png(w, h, px);
}
mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon-192.png", icon(192));
writeFileSync("public/icons/icon-512.png", icon(512));
writeFileSync("public/icons/maskable-512.png", icon(512, 0.56));
writeFileSync("public/icons/apple-touch-icon.png", icon(180, 0.7));
writeFileSync("public/icons/og.png", og(1200, 630));
console.log("icons written");
