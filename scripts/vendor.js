#!/usr/bin/env node
// Copies the browser libraries index.html loads from node_modules into
// vendor/<name>/<version>/, with each package's license files, so the app
// runs offline. Versions come from the installed packages (pinned exactly in
// package.json). Run after npm install: npm run vendor

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODULES = path.join(ROOT, 'node_modules');
const VENDOR = path.join(ROOT, 'vendor');

// pkg: npm package; name: vendor/ folder; files: paths inside the package
const LIBS = [
  { pkg: 'lightweight-charts', name: 'lightweight-charts', files: ['dist/lightweight-charts.standalone.production.js'] },
  { pkg: 'plotly.js-dist-min', name: 'plotly',             files: ['plotly.min.js'] },
  { pkg: 'crypto-js',          name: 'crypto-js',          files: ['crypto-js.js'] },
  { pkg: 'papaparse',          name: 'papaparse',          files: ['papaparse.min.js'] },
  { pkg: 'marked',             name: 'marked',             files: ['marked.min.js'] },
  { pkg: 'dompurify',          name: 'dompurify',          files: ['dist/purify.min.js'] },
];

const LICENSE_RE = /^(LICENSE|LICENCE|NOTICE|COPYING)([-.][a-z]+)?$/i;

function pkgDir(pkg) {
  const dir = path.join(MODULES, pkg);
  if (!fs.existsSync(dir)) throw new Error(pkg + ' is not installed. Run npm install first.');
  return dir;
}

function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('  ' + path.relative(ROOT, dest).replace(/\\/g, '/'));
}

function copyLicenses(src, destDir) {
  const found = fs.readdirSync(src).filter(f => LICENSE_RE.test(f));
  if (!found.length) throw new Error('No license file in ' + src);
  for (const f of found) copy(path.join(src, f), path.join(destDir, f));
}

function vendorLib(lib) {
  const src = pkgDir(lib.pkg);
  const version = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version;
  const destDir = path.join(VENDOR, lib.name, version);
  console.log(lib.pkg + '@' + version);
  for (const f of lib.files) copy(path.join(src, f), path.join(destDir, path.basename(f)));
  copyLicenses(src, destDir);
}

// Inter (latin subset) for Plotly chart text; vendor/fonts/inter/inter.css
// is kept in the repo and points at these files.
const INTER_WEIGHTS = [400, 500, 600, 700];

function vendorInter() {
  const src = pkgDir('@fontsource/inter');
  const version = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8')).version;
  const destDir = path.join(VENDOR, 'fonts', 'inter');
  console.log('@fontsource/inter@' + version);
  for (const w of INTER_WEIGHTS) {
    const f = 'inter-latin-' + w + '-normal.woff2';
    copy(path.join(src, 'files', f), path.join(destDir, f));
  }
  copyLicenses(src, destDir);
}

LIBS.forEach(vendorLib);
vendorInter();
