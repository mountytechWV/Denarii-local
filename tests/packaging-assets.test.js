// Redesign foundation (Redesign 1): every font, script, stylesheet and image
// the page loads is a local file in the package.
//  (d) index.html and every CSS file load no http(s):// font, script or style
//      URL, and every url() target exists under vendor/, css/ or img/.
//  (e) package.json build.files packages css/** and img/**.
// The CSP (font-src 'self', img-src 'self' data: blob:) would block anything else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HTML = read('index.html');
const PKG = JSON.parse(read('package.json'));

// Every .css file the app ships: Denarii.css plus css/ and vendor/, recursively.
function cssFiles() {
    const out = ['Denarii.css'];
    const walk = dir => {
        for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const rel = dir + '/' + e.name;
            if (e.isDirectory()) walk(rel);
            else if (e.name.endsWith('.css')) out.push(rel);
        }
    };
    ['css', 'vendor'].forEach(d => { if (fs.existsSync(path.join(ROOT, d))) walk(d); });
    return out;
}

const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
const urlTargets = s => [...stripComments(s).matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map(m => m[2].trim());

test('(d) index.html: no script, stylesheet, font or preconnect from http(s)', () => {
    const tags = [...HTML.matchAll(/<(script|link)\b[^>]*>/gi)].map(m => m[0]);
    assert.ok(tags.length > 0);
    for (const tag of tags) {
        const ref = (/\b(?:src|href)\s*=\s*"([^"]*)"/i.exec(tag) || [])[1] || '';
        assert.doesNotMatch(ref, /^(https?:)?\/\//i, tag);
    }
    assert.doesNotMatch(HTML, /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com/);
    for (const block of HTML.match(/<style\b[\s\S]*?<\/style>/gi) || []) {
        assert.doesNotMatch(block, /@import|url\(\s*['"]?(https?:)?\/\//i);
    }
});

test('(d) index.html: stylesheet links are local and in order (fonts, Denarii.css, then the design system)', () => {
    const hrefs = [...HTML.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1].split('?')[0]);
    assert.deepEqual(hrefs, [
        'vendor/fonts/inter/inter.css',
        'vendor/fonts/archivo-narrow/archivo-narrow.css',
        'Denarii.css',
        'css/denarii-ds.css',
    ]);
    hrefs.forEach(h => assert.ok(fs.existsSync(path.join(ROOT, h)), h));
});

test('(d) CSS files: no @import and no http(s) URL', () => {
    const files = cssFiles();
    assert.ok(files.includes('css/denarii-ds.css'));
    assert.ok(files.includes('vendor/fonts/archivo-narrow/archivo-narrow.css'));
    for (const f of files) {
        const css = stripComments(read(f));
        assert.doesNotMatch(css, /@import/, f);
        assert.doesNotMatch(css, /https?:\/\//, f);
    }
});

test('(d) every url() target in index.html and the CSS files exists under vendor/, css/ or img/', () => {
    const allowed = ['vendor', 'css', 'img'];
    const check = (from, target) => {
        if (/^(data|blob):/i.test(target) || target.startsWith('#')) return;
        const clean = target.split(/[?#]/)[0];
        const abs = clean.startsWith('/')
            ? path.join(ROOT, clean)
            : path.resolve(path.dirname(path.join(ROOT, from)), clean);
        const rel = path.relative(ROOT, abs).split(path.sep).join('/');
        assert.ok(allowed.includes(rel.split('/')[0]), from + ': ' + target + ' -> ' + rel);
        assert.ok(fs.existsSync(abs), from + ': ' + target + ' missing');
    };
    let count = 0;
    for (const f of cssFiles()) urlTargets(read(f)).forEach(t => { check(f, t); count++; });
    urlTargets(HTML).forEach(t => { check('index.html', t); count++; });
    // 7 header images + 5 Inter weights + 3 Archivo Narrow weights.
    assert.ok(count >= 7 + 5 + 3, 'header images and font files are all checked (' + count + ')');
});

test('(d) every theme has a header image, and every font weight file is vendored', () => {
    const ds = read('css/denarii-ds.css');
    const themes = ['denarii-forged', 'soft-dark', 'harbor-light', 'sage-journal', 'dawn-ember', 'warm-midnight', 'blush-power'];
    for (const t of themes) {
        assert.match(ds, new RegExp(':root\\[data-theme="' + t + '"\\]\\s*\\{ --header-image: url\\("\\.\\./img/headers/' + t + '\\.webp"\\); \\}'), t);
    }
    for (const w of [400, 500, 600, 700, 800]) {
        assert.ok(fs.existsSync(path.join(ROOT, 'vendor/fonts/inter/inter-latin-' + w + '-normal.woff2')), 'Inter ' + w);
    }
    for (const w of [500, 600, 700]) {
        assert.ok(fs.existsSync(path.join(ROOT, 'vendor/fonts/archivo-narrow/archivo-narrow-latin-' + w + '-normal.woff2')), 'Archivo Narrow ' + w);
    }
    assert.ok(fs.existsSync(path.join(ROOT, 'vendor/fonts/archivo-narrow/LICENSE')));
    assert.match(read('vendor/fonts/inter/inter.css'), /font-weight: 800;\s*src: url\(inter-latin-800-normal\.woff2\)/);
});

test('(e) build.files packages css/** and img/** with the rest of the app', () => {
    const files = PKG.build.files;
    for (const f of ['index.html', 'Denarii.css', 'css/**', 'img/**', 'js/**', 'vendor/**']) {
        assert.ok(files.includes(f), f);
    }
});

test('(e) font packages are pinned exactly', () => {
    assert.equal(PKG.devDependencies['@fontsource/archivo-narrow'], '5.3.0');
    assert.equal(PKG.devDependencies['@fontsource/inter'], '5.3.0');
});
