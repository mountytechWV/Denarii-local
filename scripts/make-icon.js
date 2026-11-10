#!/usr/bin/env node
// Builds build/icon.ico (the installer, exe and shortcut icon) from
// Logos/icon-512.png with 256, 128, 64, 48, 32, 24 and 16 px layers.
// Run after changing the logo: npm run icon

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'Logos', 'icon-512.png');
const OUTPUT = path.join(ROOT, 'build', 'icon.ico');
const SIZES = [256, 128, 64, 48, 32, 24, 16];

async function main() {
  // png-to-ico is an ES module; its default export only makes 256/48/32/16.
  const { imagesToIco } = await import('png-to-ico');
  const { readPNG, resize } = await import('png-to-ico/lib/png.js');
  const png = await readPNG(SOURCE);
  if (png.width !== png.height || png.width < 256) {
    throw new Error('Expected a square PNG of at least 256 px: ' + SOURCE);
  }
  const images = SIZES.map(s => (s === png.width ? png : resize(png, s, s, 'bicubicInterpolation')));
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, imagesToIco(images));
  console.log('Wrote', path.relative(ROOT, OUTPUT), '(' + SIZES.join(', ') + ' px)');
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
