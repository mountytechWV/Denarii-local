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
        bar.className = 'update-banner';
        bar.setAttribute('role', 'status');
        var text = document.createElement('span');
        text.className = 'update-banner-text';
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
