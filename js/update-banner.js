// Update-ready banner (desktop app). electron/updater.js downloads updates in
// the background and sends { version } through window.denariiUpdate; this
// shows a small non-blocking bar. Restart installs now (the unsaved-changes
// prompt still runs first); Later hides it and the update installs on the
// next normal quit.
(function () {
    function showUpdateBanner(info) {
        if (typeof document === 'undefined' || !document.body) return;
        var version = info && info.version ? String(info.version) : '';
        var old = document.getElementById('update-ready-banner');
        if (old) old.remove();
        var bar = document.createElement('div');
        bar.id = 'update-ready-banner';
        bar.setAttribute('role', 'status');
        bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;' +
            'max-width:calc(100vw - 32px);width:520px;box-sizing:border-box;padding:10px 14px;border-radius:8px;' +
            'background:var(--bg-secondary,#1f2937);color:var(--text-primary,#f9fafb);border:1px solid var(--primary,#3b82f6);' +
            'box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:13px;display:flex;gap:12px;align-items:center;';
        var text = document.createElement('span');
        text.style.flex = '1';
        text.textContent = 'Denarii ' + (version ? version + ' ' : '') + 'is ready. Restart to install.';
        var restart = document.createElement('button');
        restart.type = 'button';
        restart.className = 'btn btn-primary';
        restart.textContent = 'Restart';
        restart.addEventListener('click', function () {
            Promise.resolve(window.denariiUpdate.install()).catch(function (e) {
                console.log('[Denarii] Update install failed:', e && e.message);
            });
        });
        var later = document.createElement('button');
        later.type = 'button';
        later.className = 'btn btn-secondary';
        later.textContent = 'Later';
        later.addEventListener('click', function () { bar.remove(); });
        bar.appendChild(text);
        bar.appendChild(restart);
        bar.appendChild(later);
        document.body.appendChild(bar);
    }

    if (typeof window !== 'undefined' && window.denariiUpdate && window.denariiUpdate.onReady) {
        window.denariiUpdate.onReady(showUpdateBanner);
    }
})();
