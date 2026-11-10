// index.html structure. #app-container is display:none until sign-in
// (Denarii.css .app-container), so anything that must be visible before
// sign-in, or regardless of it, has to sit outside it. A missing </main>
// once left #app-container open to </body> and trapped every popup below
// the workspace inside it (the legal modal among them).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const HTML = read('index.html');
const NAV = read('js/nav.js');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr',
    'path', 'circle', 'line', 'rect', 'polyline', 'polygon', 'ellipse', 'stop', 'use']);

// Walks the tags (comments, scripts and styles blanked). An end tag pops back
// to the nearest open element of its name, as a browser does; every end tag
// that does not match the innermost open element is recorded.
function parse(html) {
    const blank = s => s.replace(/[^\n]/g, ' ');
    const src = html.replace(/<!--[\s\S]*?-->/g, blank).replace(/<(script|style|textarea|pre)\b[\s\S]*?<\/\1>/gi, blank);
    const lineOf = i => src.slice(0, i).split('\n').length;
    const stack = [], elements = [], mismatches = [];
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
    let m;
    while ((m = re.exec(src))) {
        const tag = m[2].toLowerCase();
        if (m[1]) {
            const top = stack[stack.length - 1];
            if (!top || top.tag !== tag) mismatches.push('line ' + lineOf(m.index) + ': </' + tag + '> while <' + (top ? top.tag : 'none') + '> is open');
            const j = stack.map(x => x.tag).lastIndexOf(tag);
            if (j >= 0) stack.length = j;
            continue;
        }
        const el = {
            tag,
            id: (m[3].match(/\bid="([^"]+)"/) || [])[1] || '',
            classes: ((m[3].match(/\bclass="([^"]+)"/) || [])[1] || '').split(/\s+/).filter(Boolean),
            role: (m[3].match(/\brole="([^"]+)"/) || [])[1] || '',
            line: lineOf(m.index),
            ancestors: stack.map(x => x.id || x.tag),
        };
        elements.push(el);
        if (!VOID.has(tag) && !m[4]) stack.push(el);
    }
    return { elements, mismatches, unclosed: stack.map(x => x.tag + (x.id ? '#' + x.id : '')) };
}

const DOC = parse(HTML);
const insideApp = el => el.ancestors.includes('app-container');

test('index.html: every end tag matches its element and nothing is left open', () => {
    assert.deepEqual(DOC.mismatches, []);
    assert.deepEqual(DOC.unclosed, []);
});

test('index.html: <main class="workspace"> is balanced and closes inside .app-shell', () => {
    const opens = (HTML.match(/<main\b/g) || []).length;
    const closes = (HTML.match(/<\/main>/g) || []).length;
    assert.equal(opens, 1);
    assert.equal(closes, 1);
    const main = DOC.elements.find(el => el.tag === 'main');
    assert.deepEqual(main.ancestors.slice(-2), ['app-container', 'div'], 'main sits in .app-shell inside #app-container');
});

test('index.html: #app-container holds only the signed-in app layout', () => {
    const children = DOC.elements.filter(el => el.ancestors[el.ancestors.length - 1] === 'app-container');
    assert.deepEqual(children.map(el => el.classes.join(' ')), ['app-shell']);
});

// Pop-ups that belong to the signed-in layout itself and open only from it:
// the sidebar profile menu, the mobile sidebar backdrop, and each analytics
// page's own pickers and help popovers.
const LAYOUT_OWNED = new Set([
    'profile-popup-overlay', 'profile-popup', 'sidebar-mobile-overlay', 'dash-col-popup',
    'snap-picker-overlay', 'trend-picker-overlay', 'setups-picker-overlay', 'timing-picker-overlay',
    'sym-picker-overlay', 'risk-picker-overlay', 'disc-picker-overlay',
    'trend-help-popover', 'setups-help-popover', 'timing-help-popover',
]);
const POPUP_CLASS = /^(modal|[\w-]*-(overlay|toast|popover|popup)|ai-toast|cmd-bar)$/;

test('index.html: no modal, toast, overlay or popover is inside #app-container', () => {
    const trapped = DOC.elements
        .filter(insideApp)
        .filter(el => el.classes.some(c => POPUP_CLASS.test(c)) || el.role === 'dialog')
        .filter(el => !LAYOUT_OWNED.has(el.id))
        .map(el => 'line ' + el.line + ' ' + el.tag + (el.id ? '#' + el.id : '') + '.' + el.classes.join('.'));
    assert.deepEqual(trapped, []);
});

test('index.html: the popups that used to be trapped are at body level', () => {
    for (const id of ['json-input', 'broker-csv-input', 'avatar-cropper-modal', 'import-account-prompt-modal', 'broker-delete-modal',
        'conflict-clear-modal', 'broker-account-modal', 'broker-account-cash-modal', 'stock-chart-modal', 'prompt-editor-modal',
        'pe-tip-popover', 'ai-toast', 'legal-acceptance-modal', 'note-template-modal', 'cmd-bar-overlay', 'cmd-bar']) {
        const el = DOC.elements.find(e => e.id === id);
        assert.ok(el, id + ' exists');
        assert.deepEqual(el.ancestors, ['html', 'body'], id);
    }
});

// ── Command bar stays closed while locked ──────────────────────────────────

function openCmdBarBox(unlocked) {
    const start = NAV.indexOf('window.openCmdBar = function');
    assert.ok(start >= 0, 'openCmdBar found');
    let depth = 0, end = -1;
    for (let i = NAV.indexOf('{', start); i < NAV.length; i++) {
        if (NAV[i] === '{') depth++;
        else if (NAV[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    const cls = () => { const s = new Set(); return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) }; };
    const app = { classList: cls() };
    if (unlocked) app.classList.add('active');
    const env = {
        window: {}, cmdBar: { classList: cls(), setAttribute: () => {} }, cmdInput: { value: 'x', focus: () => {} },
        cmdOverlay: { classList: cls() }, cmdOpen: false, cmdFocusIndex: 0, rendered: 0,
        renderCmdResults: () => { env.rendered++; }, setTimeout: () => {},
        document: { getElementById: id => (id === 'app-container' ? app : null) },
    };
    new Function('env', 'with (env) { ' + NAV.slice(start, end) + ' }')(env);
    return env;
}

test('openCmdBar: does nothing while the app is locked', () => {
    const env = openCmdBarBox(false);
    env.window.openCmdBar();
    assert.equal(env.cmdOpen, false);
    assert.equal(env.cmdBar.classList.contains('active'), false);
    assert.equal(env.cmdOverlay.classList.contains('active'), false);
    assert.equal(env.rendered, 0);
});

test('openCmdBar: opens once the app is unlocked', () => {
    const env = openCmdBarBox(true);
    env.window.openCmdBar();
    assert.equal(env.cmdOpen, true);
    assert.equal(env.cmdBar.classList.contains('active'), true);
    assert.equal(env.cmdOverlay.classList.contains('active'), true);
    assert.equal(env.rendered, 1);
});
