#!/usr/bin/env node
'use strict';

/**
 * Generates the Synapse application icon set (PNG / ICNS / ICO) with no external
 * dependencies. Run with `node scripts/generate-icons.js` after changing the mark.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const SS = 4; // supersampling factor for anti-aliasing

// ---------------------------------------------------------------------------
// Minimal RGBA PNG encoder
// ---------------------------------------------------------------------------

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Prefix every scanline with filter type 0 (None).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------
// The mark: rounded-square badge with an indigo gradient and a soundwave glyph
// ---------------------------------------------------------------------------

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ];
}

const GRADIENT_TOP = [99, 102, 241]; // indigo-500
const GRADIENT_BOTTOM = [139, 92, 246]; // violet-500

// Soundwave bar heights as a fraction of the badge, centred horizontally.
const BARS = [0.30, 0.54, 0.86, 0.62, 0.38];

/** True when the point falls inside the soundwave glyph. */
function insideGlyph(u, v, scale) {
  const barWidth = 0.058 * scale;
  const barGap = 0.042 * scale;
  const totalWidth = BARS.length * barWidth + (BARS.length - 1) * barGap;
  const startX = 0.5 - totalWidth / 2;

  for (let i = 0; i < BARS.length; i++) {
    const left = startX + i * (barWidth + barGap);
    const right = left + barWidth;
    if (u < left || u > right) continue;

    const barHeight = BARS[i] * 0.62 * scale;
    const top = 0.5 - barHeight / 2;
    const bottom = 0.5 + barHeight / 2;
    const cap = barWidth / 2;

    const insideVertical = v >= top + cap && v <= bottom - cap;
    const nearCap = Math.min(
      Math.hypot(u - (left + cap), v - (top + cap)),
      Math.hypot(u - (left + cap), v - (bottom - cap))
    );
    if (insideVertical || nearCap <= cap) return true;
  }

  return false;
}

/**
 * Glyph only, on a transparent field. macOS template images are read as a mask
 * (alpha only), so the bars must carry the shape with nothing behind them —
 * a filled badge would flatten to a solid black square in the menu bar.
 */
function sampleTrayGlyph(u, v) {
  return insideGlyph(u, v, 1.45) ? [0, 0, 0, 255] : null;
}

/** Returns [r, g, b, a] for a point in the unit square, or null when outside. */
function sampleIcon(u, v) {
  // Rounded square occupying the middle 88% of the canvas.
  const inset = 0.06;
  const radius = 0.235;
  const x = u - 0.5;
  const y = v - 0.5;
  const half = 0.5 - inset;
  const flat = half - radius;

  const dx = Math.max(Math.abs(x) - flat, 0);
  const dy = Math.max(Math.abs(y) - flat, 0);
  if (Math.abs(x) > half || Math.abs(y) > half) return null;
  if (Math.hypot(dx, dy) > radius) return null;

  if (insideGlyph(u, v, 1)) return [255, 255, 255, 255];

  const [r, g, b] = mix(GRADIENT_TOP, GRADIENT_BOTTOM, v);
  return [r, g, b, 255];
}

function renderIcon(size, sampler = sampleIcon) {
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      // Supersample to soften the rounded edges and glyph.
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const sample = sampler(u, v);
          if (sample) {
            r += sample[0];
            g += sample[1];
            b += sample[2];
            a += sample[3];
          }
        }
      }

      const samples = SS * SS;
      const alpha = a / samples;
      const offset = (y * size + x) * 4;
      // Un-premultiply so edge pixels keep their colour as alpha falls off.
      const weight = alpha > 0 ? 255 / a : 0;
      pixels[offset] = Math.round(r * weight);
      pixels[offset + 1] = Math.round(g * weight);
      pixels[offset + 2] = Math.round(b * weight);
      pixels[offset + 3] = Math.round(alpha);
    }
  }

  return encodePng(pixels, size);
}

// ---------------------------------------------------------------------------
// Container formats
// ---------------------------------------------------------------------------

/** Wraps a PNG in a single-image .ico (Vista+ allows PNG payloads directly). */
function buildIco(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // 0 means 256
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0; // palette size
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32BE(0, 8);
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset of image data

  return Buffer.concat([header, entry, pngBuffer]);
}

/** Builds a .icns via macOS `iconutil`; returns false on other platforms. */
function buildIcns(iconsetDir, outputPath) {
  if (process.platform !== 'darwin') return false;

  const variants = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ];

  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });

  const cache = new Map();
  for (const [name, size] of variants) {
    if (!cache.has(size)) cache.set(size, renderIcon(size));
    fs.writeFileSync(path.join(iconsetDir, name), cache.get(size));
  }

  execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', outputPath]);
  fs.rmSync(iconsetDir, { recursive: true, force: true });
  return true;
}

function main() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  const png1024 = renderIcon(1024);
  fs.writeFileSync(path.join(ASSETS_DIR, 'icon.png'), png1024);
  console.log('assets/icon.png (1024x1024)');

  const png256 = renderIcon(256);
  fs.writeFileSync(path.join(ASSETS_DIR, 'icon.ico'), buildIco(png256, 256));
  console.log('assets/icon.ico (256x256)');

  // Tray icons are drawn at 16pt; ship a 2x asset for Retina displays.
  fs.writeFileSync(path.join(ASSETS_DIR, 'tray-icon.png'), renderIcon(16, sampleTrayGlyph));
  fs.writeFileSync(path.join(ASSETS_DIR, 'tray-icon@2x.png'), renderIcon(32, sampleTrayGlyph));
  console.log('assets/tray-icon.png + @2x (template glyph)');

  const icnsPath = path.join(ASSETS_DIR, 'icon.icns');
  if (buildIcns(path.join(ASSETS_DIR, 'Synapse.iconset'), icnsPath)) {
    console.log('assets/icon.icns');
  } else {
    console.log('assets/icon.icns skipped (requires macOS iconutil)');
  }
}

main();
