// Syntax guard: node --check on every local script index.html loads, so a
// parse error in any app file fails the suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const scripts = [...HTML.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)]
    .map(m => m[1])
    .filter(src => !/^(https?:)?\/\//.test(src))
    .map(src => src.split('?')[0]);

test('index.html loads the app scripts this guard depends on', () => {
    assert.ok(scripts.includes('Denarii.js'));
    assert.ok(scripts.includes('js/pages/snapshot.js'));
});

for (const rel of scripts) {
    test(`${rel} parses`, () => {
        const file = path.join(root, rel);
        assert.ok(fs.existsSync(file), `${rel} is loaded by index.html but missing`);
        const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        assert.equal(res.status, 0, res.stderr);
    });
}

// Main-process files (electron/ and electron/webull/) are not loaded by
// index.html, so they are listed here.
const mainFiles = ['electron', path.join('electron', 'webull')]
    .flatMap(dir => fs.readdirSync(path.join(root, dir))
        .filter(f => f.endsWith('.js'))
        .map(f => path.join(dir, f)));

test('main-process files include the Webull modules', () => {
    for (const f of ['sign.js', 'readonly.js', 'store.js', 'connection.js', 'fetch.js', 'scheduler.js', 'ipc.js']) {
        assert.ok(mainFiles.includes(path.join('electron', 'webull', f)), f);
    }
});

for (const rel of mainFiles) {
    test(`${rel.split(path.sep).join('/')} parses`, () => {
        const res = spawnSync(process.execPath, ['--check', path.join(root, rel)], { encoding: 'utf8' });
        assert.equal(res.status, 0, res.stderr);
    });
}
