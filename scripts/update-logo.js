'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const SOURCE_IMAGE = '/Users/ankitsingh/.gemini/antigravity-ide/brain/4508402c-7634-4703-a817-e9c0dfad0341/.user_uploaded/media_1787166760384.png';

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
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset of image data

  return Buffer.concat([header, entry, pngBuffer]);
}

async function buildIcns(iconsetDir, outputPath) {
  if (process.platform !== 'darwin') {
    console.log('Skipping ICNS generation (not on macOS)');
    return false;
  }

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

  for (const [name, size] of variants) {
    const buffer = await sharp(SOURCE_IMAGE)
      .resize(size, size, { fit: 'fill' })
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(iconsetDir, name), buffer);
  }

  try {
    execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', outputPath]);
    console.log('Generated assets/icon.icns successfully.');
  } catch (error) {
    console.error('iconutil failed:', error.message);
  } finally {
    fs.rmSync(iconsetDir, { recursive: true, force: true });
  }
}

async function main() {
  try {
    console.log('Starting logo conversion from:', SOURCE_IMAGE);

    // 1. Generate icon.png (1024x1024)
    const png1024 = await sharp(SOURCE_IMAGE)
      .resize(1024, 1024, { fit: 'fill' })
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(ASSETS_DIR, 'icon.png'), png1024);
    console.log('Generated assets/icon.png (1024x1024)');

    // 2. Generate icon.ico (256x256)
    const png256 = await sharp(SOURCE_IMAGE)
      .resize(256, 256, { fit: 'fill' })
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(ASSETS_DIR, 'icon.ico'), buildIco(png256, 256));
    console.log('Generated assets/icon.ico (256x256)');

    // 3. Generate icon.icns (macOS)
    await buildIcns(path.join(ASSETS_DIR, 'Synapse.iconset'), path.join(ASSETS_DIR, 'icon.icns'));

    console.log('Logo update completed successfully!');
  } catch (error) {
    console.error('Error updating logo:', error.message);
    process.exit(1);
  }
}

main();
