#!/usr/bin/env node
// Fails (exit 1) if any Webull code contains order-mutation strings, or if
// the read-only allowlist has any non-GET route other than the two token
// POSTs. Scans electron/webull/ (the Webull client used by Denarii Local).
// See docs/webull-local-plan.md section 1.
// Run before every push: npm run check:webull

const fs = require('fs');
const path = require('path');

const ROOTS = [
  path.join(__dirname, '..', 'electron', 'webull'),
];
const FORBIDDEN = [
  'place_order',
  'replace_order',
  'cancel_order',
  '/order/place',
  '/order/cancel',
  '/order/replace',
];
const TOKEN_POSTS = ['POST /auth/tokens/check', 'POST /auth/tokens/create'];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const hits = [];
for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const s of FORBIDDEN) {
        if (line.includes(s)) hits.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${s}`);
      }
    });
  }
}

const { ALLOWLIST } = require('../electron/webull/readonly');
const nonGet = ALLOWLIST.filter(r => r.method !== 'GET').map(r => `${r.method} ${r.path}`).sort();
const allowlistOk = nonGet.length === TOKEN_POSTS.length && nonGet.every((r, i) => r === TOKEN_POSTS[i]);

if (hits.length || !allowlistOk) {
  console.error('Webull read-only check FAILED.');
  if (hits.length) {
    console.error('Forbidden strings:');
    for (const h of hits) console.error('  ' + h);
  }
  if (!allowlistOk) console.error('Non-GET allowlist routes must be exactly ' + TOKEN_POSTS.join(', ') + '; found: ' + (nonGet.join(', ') || 'none'));
  process.exit(1);
}
console.log('Webull read-only check passed (electron/webull/ contains no order-mutation strings; only the token routes may POST).');
