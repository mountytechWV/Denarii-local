// Packaging P2a: the Settings footer shows the package.json version from
// window.denariiApp (electron/main.js 'denarii-app:info'), falling back to
// APP_VERSION outside the desktop app; the Build line is gone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('main registers denarii-app:info behind the isAppUrl guard', () => {
    const src = read('electron/main.js');
    const fn = src.slice(src.indexOf('function registerAppIpc('), src.indexOf('// ── Webull sync'));
    assert.match(fn, /ipcMain\.handle\('denarii-app:info'/);
    assert.match(fn, /!isAppUrl\(url\)\) throw new Error\('Not allowed\.'\)/);
    assert.match(fn, /version: app\.getVersion\(\)/);
    assert.match(src, /registerAppIpc\(\);/);
});

test('preload exposes denariiApp.getInfo', () => {
    assert.match(read('electron/preload.js'), /exposeInMainWorld\('denariiApp',[\s\S]*getInfo: \(\) => ipcRenderer\.invoke\('denarii-app:info'\)/);
});

test('footer uses the app version, falls back to APP_VERSION, no Build line', async () => {
    const src = read('Denarii.js');
    assert.match(src, /const APP_VERSION = 'Denarii vB\.004\.000';/);
    assert.ok(!src.includes("'\nBuild '"));
    const start = src.indexOf("const _verEl = document.getElementById('settings-version-label');");
    const block = src.slice(start, src.indexOf('// Webull (local)', start));
    const run = async (denariiApp) => {
        const el = { textContent: '' };
        const window = { denariiApp };
        const document = { getElementById: () => el };
        await new Function('window', 'document', 'APP_VERSION', block + '\nreturn Promise.resolve();')(window, document, 'Denarii vB.004.000');
        await new Promise(r => setImmediate(r));
        return el.textContent;
    };
    assert.equal(await run(undefined), 'Denarii vB.004.000');
    assert.equal(await run({ getInfo: () => Promise.resolve({ version: '1.0.0' }) }), 'Denarii v1.0.0');
    assert.equal(await run({ getInfo: () => Promise.reject(new Error('x')) }), 'Denarii vB.004.000');
});
