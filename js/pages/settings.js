(function () {

        // ========== SETTINGS PAGE ==========

        function openSettings() {
            activateSection('settings');
            // Deactivate sidebar nav items since settings isn't in sidebar
            document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
            loadProfileSettings();
            loadTagsData();
            if (typeof window.renderBrokerAccountsList === 'function') {
                try { window.renderBrokerAccountsList(); } catch (e) { /* ignore */ }
            }
            loadIntegrationsSettings();
            loadConflictCopies();
            initDeleteAccountSection();
            initAutoSignInSection();
        }

        function switchSettingsTab(tabId) {
            document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.toggle('active', b.dataset.settingsTab === tabId));
            document.querySelectorAll('.settings-panel').forEach(p => p.classList.toggle('active', p.id === tabId));
            // Refresh the Integrations panel state (Remove Key visibility +
            // "Using Denarii default" badge) whenever the tab is shown, not
            // just when the whole Settings page first opens.
            if (tabId === 'settings-security') {
                try { initDeleteAccountSection(); } catch (e) { /* ignore */ }
                initAutoSignInSection();
            }
            if (tabId === 'settings-integrations') {
                try { loadIntegrationsSettings(); } catch (e) { /* ignore */ }
            }
            if (tabId === 'settings-conflicts') {
                try { loadConflictCopies(); } catch (e) { /* ignore */ }
            }
            if (tabId === 'settings-data') {
                try { loadDataSettings(); } catch (e) { /* ignore */ }
            }
            // Broker cards recount trades, account value and "Updated" from
            // the current trades each time the tab is shown.
            if (tabId === 'settings-broker-accounts' && typeof window.renderBrokerAccountsList === 'function') {
                try { window.renderBrokerAccountsList(); } catch (e) { /* ignore */ }
            }
        }

        // ── Profile Settings ──

        function populateTimezones() {
            const sel = document.getElementById('settings-timezone');
            if (!sel || sel.options.length > 1) return;
            const tzList = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [
                'America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Anchorage','Pacific/Honolulu',
                'America/Toronto','America/Vancouver','America/Sao_Paulo','America/Mexico_City','America/Buenos_Aires',
                'Europe/London','Europe/Paris','Europe/Berlin','Europe/Madrid','Europe/Rome','Europe/Amsterdam','Europe/Zurich','Europe/Moscow','Europe/Istanbul',
                'Asia/Tokyo','Asia/Shanghai','Asia/Hong_Kong','Asia/Singapore','Asia/Seoul','Asia/Kolkata','Asia/Dubai','Asia/Bangkok',
                'Australia/Sydney','Australia/Melbourne','Australia/Perth','Pacific/Auckland','Africa/Johannesburg','Africa/Lagos'
            ];
            const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
            sel.innerHTML = '';
            tzList.forEach(tz => {
                const opt = document.createElement('option');
                try {
                    const offset = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName');
                    opt.textContent = (offset ? '(' + offset.value + ') ' : '') + tz.replace(/_/g, ' ');
                } catch(e) {
                    opt.textContent = tz.replace(/_/g, ' ');
                }
                opt.value = tz;
                if (tz === userTz) opt.selected = true;
                sel.appendChild(opt);
            });
        }

        async function loadProfileSettings() {
            populateTimezones();
            try {
                const auth = await getAuthRecord();
                if (auth) {
                    document.getElementById('settings-username').value = auth.username || '';
                    document.getElementById('settings-firstname').value = auth.firstName || '';
                    document.getElementById('settings-lastname').value = auth.lastName || '';
                    document.getElementById('settings-avatar-name').textContent = auth.firstName && auth.lastName ? auth.firstName + ' ' + auth.lastName : auth.username;

                    const initials = auth.firstName && auth.lastName ? (auth.firstName[0] + auth.lastName[0]).toUpperCase() : (auth.username || '--').substring(0, 2).toUpperCase();
                    document.getElementById('settings-avatar-initials').textContent = initials;

                    if (auth.avatar) {
                        document.getElementById('settings-avatar-img').src = auth.avatar;
                        document.getElementById('settings-avatar-img').style.display = 'block';
                        document.getElementById('settings-avatar-initials').style.display = 'none';
                    } else {
                        document.getElementById('settings-avatar-img').style.display = 'none';
                        document.getElementById('settings-avatar-initials').style.display = '';
                    }

                    if (auth.timezone) document.getElementById('settings-timezone').value = auth.timezone;
                    if (auth.currency) document.getElementById('settings-currency').value = auth.currency;
                }
            } catch(e) { console.error('loadProfileSettings:', e); }
        }

        // ── Avatar Cropper ──
        let _cropperState = { imgSrc: null, naturalW: 0, naturalH: 0, scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0 };

        function handleAvatarUpload(e) {
            const file = e.target.files[0];
            if (!file) return;
            // No size limit now; we'll compress when cropping
            const reader = new FileReader();
            reader.onload = (ev) => {
                const img = new Image();
                img.onload = () => {
                    _cropperState.imgSrc = ev.target.result;
                    _cropperState.naturalW = img.naturalWidth;
                    _cropperState.naturalH = img.naturalHeight;
                    _cropperState.scale = 1;
                    openCropperModal(img);
                };
                img.src = ev.target.result;
            };
            reader.readAsDataURL(file);
            e.target.value = ''; // allow re-upload of same file
        }

        function openCropperModal(img) {
            const viewport = document.getElementById('cropper-viewport');
            const cropImg = document.getElementById('cropper-image');
            const vpSize = 280;

            // Fit image so shorter side fills the viewport
            const ratio = img.naturalWidth / img.naturalHeight;
            let drawW, drawH;
            if (ratio >= 1) {
                drawH = vpSize;
                drawW = vpSize * ratio;
            } else {
                drawW = vpSize;
                drawH = vpSize / ratio;
            }

            _cropperState.baseW = drawW;
            _cropperState.baseH = drawH;
            _cropperState.scale = 1;
            _cropperState.x = (vpSize - drawW) / 2;
            _cropperState.y = (vpSize - drawH) / 2;

            cropImg.src = _cropperState.imgSrc;
            cropImg.style.width = drawW + 'px';
            cropImg.style.height = drawH + 'px';
            cropImg.style.left = _cropperState.x + 'px';
            cropImg.style.top = _cropperState.y + 'px';

            document.getElementById('cropper-zoom').value = 1;
            document.getElementById('avatar-cropper-modal').classList.add('active');
            document.body.classList.add('modal-open');

            // Bind events
            viewport.onpointerdown = cropperPointerDown;
            viewport.onpointermove = cropperPointerMove;
            viewport.onpointerup = cropperPointerUp;
            viewport.onpointerleave = cropperPointerUp;
            document.getElementById('cropper-zoom').oninput = cropperZoom;
        }

        function closeCropperModal() {
            document.getElementById('avatar-cropper-modal').classList.remove('active');
            document.body.classList.remove('modal-open');
        }

        function cropperPointerDown(e) {
            _cropperState.dragging = true;
            _cropperState.startX = e.clientX - _cropperState.x;
            _cropperState.startY = e.clientY - _cropperState.y;
            e.currentTarget.style.cursor = 'grabbing';
            e.currentTarget.setPointerCapture(e.pointerId);
        }

        function cropperPointerMove(e) {
            if (!_cropperState.dragging) return;
            _cropperState.x = e.clientX - _cropperState.startX;
            _cropperState.y = e.clientY - _cropperState.startY;
            clampCropperPosition();
            applyCropperTransform();
        }

        function cropperPointerUp(e) {
            _cropperState.dragging = false;
            if (e.currentTarget) e.currentTarget.style.cursor = 'grab';
        }

        function cropperZoom(e) {
            const vpSize = 280;
            const oldScale = _cropperState.scale;
            const newScale = parseFloat(e.target.value);
            // Zoom centered on viewport center
            const cx = vpSize / 2;
            const cy = vpSize / 2;
            _cropperState.x = cx - (cx - _cropperState.x) * (newScale / oldScale);
            _cropperState.y = cy - (cy - _cropperState.y) * (newScale / oldScale);
            _cropperState.scale = newScale;
            clampCropperPosition();
            applyCropperTransform();
        }

        function clampCropperPosition() {
            const vpSize = 280;
            const w = _cropperState.baseW * _cropperState.scale;
            const h = _cropperState.baseH * _cropperState.scale;
            // Don't let edges go inside viewport
            if (_cropperState.x > 0) _cropperState.x = 0;
            if (_cropperState.y > 0) _cropperState.y = 0;
            if (_cropperState.x < vpSize - w) _cropperState.x = vpSize - w;
            if (_cropperState.y < vpSize - h) _cropperState.y = vpSize - h;
        }

        function applyCropperTransform() {
            const cropImg = document.getElementById('cropper-image');
            const w = _cropperState.baseW * _cropperState.scale;
            const h = _cropperState.baseH * _cropperState.scale;
            cropImg.style.width = w + 'px';
            cropImg.style.height = h + 'px';
            cropImg.style.left = _cropperState.x + 'px';
            cropImg.style.top = _cropperState.y + 'px';
        }

        async function cropAndSaveAvatar() {
            const vpSize = 280;
            const outputSize = 200; // final avatar resolution
            const canvas = document.createElement('canvas');
            canvas.width = outputSize;
            canvas.height = outputSize;
            const ctx = canvas.getContext('2d');

            const img = new Image();
            img.onload = async () => {
                // Map viewport coords back to source image coords
                const displayW = _cropperState.baseW * _cropperState.scale;
                const displayH = _cropperState.baseH * _cropperState.scale;
                const scaleX = img.naturalWidth / displayW;
                const scaleY = img.naturalHeight / displayH;

                const sx = -_cropperState.x * scaleX;
                const sy = -_cropperState.y * scaleY;
                const sw = vpSize * scaleX;
                const sh = vpSize * scaleY;

                // Draw circular clip
                ctx.beginPath();
                ctx.arc(outputSize / 2, outputSize / 2, outputSize / 2, 0, Math.PI * 2);
                ctx.closePath();
                ctx.clip();

                ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outputSize, outputSize);

                // Export as JPEG for smaller size
                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

                // Update UI
                document.getElementById('settings-avatar-img').src = dataUrl;
                document.getElementById('settings-avatar-img').style.display = 'block';
                document.getElementById('settings-avatar-initials').style.display = 'none';

                // Save to auth record
                try {
                    const auth = await getAuthRecord();
                    if (auth) {
                        auth.avatar = dataUrl;
                        await saveAuthRecord(auth);
                        updateSidebarProfile(auth);
                    }
                } catch(err) { console.error(err); }

                closeCropperModal();
            };
            img.src = _cropperState.imgSrc;
        }

        async function removeAvatar() {
            document.getElementById('settings-avatar-img').style.display = 'none';
            document.getElementById('settings-avatar-img').src = '';
            document.getElementById('settings-avatar-initials').style.display = '';
            try {
                const auth = await getAuthRecord();
                if (auth) {
                    delete auth.avatar;
                    await saveAuthRecord(auth);
                    updateSidebarProfile(auth);
                }
            } catch(err) { console.error(err); }
        }

        function updateSidebarProfile(auth) {
            const displayName = auth.firstName && auth.lastName ? auth.firstName + ' ' + auth.lastName : auth.username;
            document.getElementById('profile-display-name').textContent = displayName;
            const initials = auth.firstName && auth.lastName ? (auth.firstName[0] + auth.lastName[0]).toUpperCase() : (auth.username || '--').substring(0, 2).toUpperCase();

            // Update sidebar avatar button (set innerHTML first, then reference child elements)
            const btn = document.getElementById('profile-btn');
            if (auth.avatar) {
                btn.innerHTML = '<img src="' + auth.avatar + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">';
            } else {
                btn.innerHTML = '<span id="profile-initials">' + initials + '</span>';
            }

            // Safely update profile-initials if it exists
            const initialsEl = document.getElementById('profile-initials');
            if (initialsEl) initialsEl.textContent = initials;
        }

        async function saveProfileSettings() {
            const firstName = document.getElementById('settings-firstname').value.trim();
            const lastName = document.getElementById('settings-lastname').value.trim();
            const timezone = document.getElementById('settings-timezone').value;
            const currency = document.getElementById('settings-currency').value;
            const msgEl = document.getElementById('settings-profile-msg');

            try {
                const auth = await getAuthRecord();
                if (!auth) throw new Error('No account found.');
                auth.firstName = firstName;
                auth.lastName = lastName;
                auth.timezone = timezone;
                auth.currency = currency;
                await saveAuthRecord(auth);
                updateSidebarProfile(auth);
                loadProfileSettings();

                msgEl.style.display = 'block';
                msgEl.className = 'alert alert-success';
                msgEl.textContent = 'Profile saved successfully.';
                setTimeout(() => { msgEl.style.display = 'none'; }, 3000);
            } catch(err) {
                msgEl.style.display = 'block';
                msgEl.className = 'alert alert-danger';
                msgEl.textContent = 'Error: ' + err.message;
            }
        }

        // ── Security (Change Password) ──

        async function changePassword() {
            const currentPw = document.getElementById('settings-current-pw').value;
            const newPw = document.getElementById('settings-new-pw').value;
            const confirmPw = document.getElementById('settings-confirm-pw').value;
            const msgEl = document.getElementById('settings-security-msg');

            if (!currentPw) { showSettingsMsg(msgEl, 'Please enter your current password.', true); return; }
            if (newPw.length < 8) { showSettingsMsg(msgEl, 'New password must be at least 8 characters.', true); return; }
            if (newPw !== confirmPw) { showSettingsMsg(msgEl, 'New passwords do not match.', true); return; }

            try {
                const auth = await getAuthRecord();
                if (!auth) throw new Error('No account found.');

                const pwCheck = await DekCrypto.verifySecret(currentPw, auth.passwordHash);
                if (!pwCheck.ok) {
                    showSettingsMsg(msgEl, 'Current password is incorrect.', true);
                    return;
                }

                // Ask for recovery key so we can re-encrypt recoveryData with current journal state
                const recoveryKey = await window.showPromptModal({ message: 'Enter your recovery key to keep it working with your new password.\n\nIf you skip this, your recovery key will only restore data from when the account was created or last reset.', inputType: 'password' });

                if (recoveryKey) {
                    const rkCheck = await DekCrypto.verifySecret(recoveryKey.trim().toUpperCase(), auth.recoveryHash);
                    if (!rkCheck.ok) {
                        showSettingsMsg(msgEl, 'Recovery key is incorrect. Password was NOT changed.', true);
                        return;
                    }
                    // Old unsalted recovery hash that matched: saved with the new password below
                    if (rkCheck.upgrade) auth.recoveryHash = rkCheck.upgrade;
                    // Set pendingRecoveryKey so saveToIndexedDB re-encrypts recoveryData
                    pendingRecoveryKey = recoveryKey.trim().toUpperCase();
                }

                // Update password hash
                auth.passwordHash = await DekCrypto.hashSecret(newPw);

                if (auth.dekVersion === 1 && sessionDek) {
                    // ── DEK account: re-wrap DEK with new password (v2) ──
                    auth.wrappedDekByPassword = await DekCrypto.wrapDekV2(sessionDek, newPw);
                    delete auth.dekPasswordSalt;

                    if (recoveryKey) {
                        auth.wrappedDekByRecovery = await DekCrypto.wrapDekV2(sessionDek, recoveryKey.trim().toUpperCase());
                        delete auth.dekRecoverySalt;
                    }

                    await saveAuthRecord(auth);
                    sessionPassword = newPw;
                    pendingRecoveryKey = null;
                    // No journal re-encryption needed — DEK hasn't changed
                    // No Gemini re-encrypt needed — it's encrypted with the DEK
                } else {
                    // ── Legacy account: re-encrypt journal with new password ──
                    await saveAuthRecord(auth);
                    sessionPassword = newPw;
                    await saveToIndexedDB();
                    pendingRecoveryKey = null;

                    if (typeof DenAriiAI !== 'undefined') {
                        try { await DenAriiAI.reencryptApiKey(); } catch(e) { /* non-fatal */ }
                    }
                    if (typeof TwelveDataKey !== 'undefined') {
                        try { await TwelveDataKey.reencryptApiKey(); } catch(e) { /* non-fatal */ }
                    }
                }

                // ── Stale recovery warning for legacy accounts that skipped recovery key ──
                var _staleRecoveryWarning = '';
                if (!recoveryKey && !(auth.dekVersion === 1)) {
                    try {
                        var _pwJournal = await getJournalRecord(currentAccountId);
                        if (_pwJournal) {
                            var _pwRecTs = _pwJournal.recoveryDataSavedAt ? new Date(_pwJournal.recoveryDataSavedAt).getTime() : 0;
                            var _pwJnlTs = _pwJournal.lastSaved ? new Date(_pwJournal.lastSaved).getTime() : 0;
                            if (_pwJnlTs && _pwRecTs && _pwJnlTs > _pwRecTs) {
                                var _pwDays = Math.round((_pwJnlTs - _pwRecTs) / 86400000);
                                _staleRecoveryWarning = ' Warning: your recovery snapshot is ' + (_pwDays > 0 ? _pwDays + ' day' + (_pwDays !== 1 ? 's' : '') : 'some time') + ' old. If you reset your password with it, you will lose recent data.';
                            } else if (!_pwRecTs && _pwJnlTs) {
                                _staleRecoveryWarning = ' Warning: your recovery snapshot predates freshness tracking and may be significantly older than your current data.';
                            }
                        }
                    } catch (_e) { /* best-effort */ }
                }

                // ── Sync password to Supabase Auth (Supabase-linked accounts only) ──
                var supabasePwSynced = false;
                var supabasePwError = null;
                if (auth.supabaseUid && typeof SupabaseAuth !== 'undefined' && SupabaseAuth.isReady()) {
                    try {
                        var sbResult = await SupabaseAuth.supabaseUpdatePassword(newPw);
                        if (sbResult.error) {
                            supabasePwError = sbResult.error;
                            console.warn('[Denarii] Supabase password sync failed:', sbResult.error);
                        } else {
                            supabasePwSynced = true;
                            console.log('[Denarii] Supabase password synced.');
                        }
                    } catch (e) {
                        supabasePwError = e.message || String(e);
                        console.warn('[Denarii] Supabase password sync error:', supabasePwError);
                    }
                }

                document.getElementById('settings-current-pw').value = '';
                document.getElementById('settings-new-pw').value = '';
                document.getElementById('settings-confirm-pw').value = '';

                // The stored key is the DEK, which a password change keeps.
                var _autoStillOn = false;
                try {
                    if (window.denariiAutoSignIn) {
                        var _autoStatus = await window.denariiAutoSignIn.status();
                        _autoStillOn = !!(_autoStatus && _autoStatus.accountId && _autoStatus.accountId === auth.id);
                    }
                } catch (_e) { /* status only */ }

                var msg;
                if (supabasePwError) {
                    msg = 'Local password updated, but cloud password sync failed: ' + supabasePwError + '. Your cloud sign-in may use the old password.';
                    showSettingsMsg(msgEl, msg, true);
                } else {
                    msg = (auth.dekVersion === 1)
                        ? (recoveryKey ? 'Password updated and recovery key updated.' : 'Password updated.')
                        : (recoveryKey
                            ? 'Password updated and recovery key updated.'
                            : 'Password updated.' + (_staleRecoveryWarning || ' Note: your recovery key will only restore data from when the account was created or last reset.'));
                    if (supabasePwSynced) msg += ' Cloud password also updated.';
                    if (_autoStillOn) msg += ' Automatic sign-in is still on for this computer.';
                    showSettingsMsg(msgEl, msg, _staleRecoveryWarning ? true : false);
                }
            } catch(err) {
                pendingRecoveryKey = null;
                showSettingsMsg(msgEl, 'Error: ' + err.message, true);
            }
        }

        function showSettingsMsg(el, msg, isError) {
            el.style.display = 'block';
            el.className = isError ? 'alert alert-danger' : 'alert alert-success';
            el.textContent = msg;
            if (!isError) setTimeout(() => { el.style.display = 'none'; }, 3000);
        }

        // ── Data (backup / restore of the whole SQLite database) ──
        // window.denariiStore comes from the Electron preload; file paths are
        // chosen in the main process's own save/open dialogs.

        // Like showSettingsMsg, but stays visible so a saved path can be read.
        function showDataMsg(msg, isError) {
            const el = document.getElementById('settings-data-msg');
            if (!el) return;
            el.style.display = 'block';
            el.className = isError ? 'alert alert-danger' : 'alert alert-success';
            el.textContent = msg;
        }

        async function loadDataSettings() {
            const infoEl = document.getElementById('settings-data-info');
            if (!infoEl) return;
            if (!window.denariiStore) {
                infoEl.textContent = 'Backup and restore are available in the Denarii desktop app.';
                return;
            }
            try {
                const info = await window.denariiStore.info();
                const newest = info.autoBackups && info.autoBackups[0];
                infoEl.textContent = 'Database: ' + info.path + '\n' +
                    'Newest automatic backup: ' + (newest ? new Date(newest.at).toLocaleString() : 'none yet');
            } catch (e) {
                infoEl.textContent = 'Could not read database details: ' + (e.message || e);
            }
        }

        async function backupAllData() {
            if (!window.denariiStore) return;
            const btn = document.getElementById('settings-data-backup-btn');
            if (btn) btn.disabled = true;
            try {
                const r = await window.denariiStore.backupTo();
                if (r && r.ok) {
                    showDataMsg('Backup saved to ' + r.path, false);
                    if (typeof window.markLastBackup === 'function') await window.markLastBackup();
                }
                else if (r && !r.cancelled) showDataMsg('Backup failed: ' + (r.error || 'unknown error'), true);
            } catch (e) {
                showDataMsg('Backup failed: ' + (e.message || e), true);
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        async function restoreAllData() {
            if (!window.denariiStore) return;
            if (!confirm('This replaces all accounts and data in this app with the backup. A safety copy of your current data is kept. Denarii will restart.')) return;
            const btn = document.getElementById('settings-data-restore-btn');
            if (btn) btn.disabled = true;
            try {
                // On success the app restarts and this never returns.
                const r = await window.denariiStore.restoreFrom();
                if (r && !r.ok && !r.cancelled) showDataMsg('Restore failed: ' + (r.error || 'unknown error'), true);
            } catch (e) {
                showDataMsg('Restore failed: ' + (e.message || e), true);
            } finally {
                if (btn) btn.disabled = false;
            }
        }

        async function openBackupsFolder() {
            if (!window.denariiStore) return;
            try {
                const r = await window.denariiStore.openBackupsFolder();
                if (r && !r.ok) showDataMsg('Could not open the backups folder: ' + (r.error || 'unknown error'), true);
            } catch (e) {
                showDataMsg('Could not open the backups folder: ' + (e.message || e), true);
            }
        }

        // ── Integrations Settings ──

        async function loadIntegrationsSettings() {
            loadWebullSection();
            loadTwelveDataSettings();
            if (typeof DenAriiAI === 'undefined') return;
            // Ensure the encrypted personal key has been decrypted into
            // memory before we decide whether to show "Remove Key". If the
            // user lands on Integrations before the post-login loadApiKey
            // ran (or after an unload), hasUserKey would otherwise return
            // false and the button would stay hidden even when a key is
            // saved on disk.
            if (typeof DenAriiAI.loadApiKey === 'function') {
                try { await DenAriiAI.loadApiKey('gemini'); } catch (e) { /* non-fatal */ }
            }
            const hasKey = DenAriiAI.hasUserKey('gemini');
            const removeBtn = document.getElementById('settings-integrations-remove-btn');
            if (removeBtn) removeBtn.style.display = hasKey ? '' : 'none';
            const input = document.getElementById('settings-integrations-key');
            if (input) input.value = '';
            DenAriiAI.refreshKeyStatus();
            loadGeminiModelSelect();
        }

        // Fills the Model select from the key's ListModels result. If the list
        // can't load, only the saved/default model is shown, with no error.
        async function loadGeminiModelSelect() {
            const sel = document.getElementById('settings-integrations-model');
            if (!sel || typeof DenAriiAI.getModel !== 'function') return;
            let current = 'gemini-flash-lite-latest';
            try { current = await DenAriiAI.getModel(); } catch (e) { /* keep default */ }
            let names = [];
            if (DenAriiAI.hasUserKey('gemini')) {
                try { names = await DenAriiAI.listModels(); } catch (e) { names = []; }
            }
            if (names.indexOf('gemini-flash-lite-latest') === -1) names.unshift('gemini-flash-lite-latest');
            if (names.indexOf(current) === -1) names.unshift(current);
            sel.innerHTML = '';
            names.forEach(function (name) {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                sel.appendChild(opt);
            });
            sel.value = current;
        }

        async function saveGeminiModel() {
            const sel = document.getElementById('settings-integrations-model');
            const msgEl = document.getElementById('settings-integrations-msg');
            if (!sel) return;
            try {
                await DenAriiAI.setModel(sel.value);
                if (msgEl) showSettingsMsg(msgEl, 'Model saved.', false);
            } catch (err) {
                if (msgEl) showSettingsMsg(msgEl, 'Error saving model: ' + err.message, true);
            }
        }

        async function saveGeminiApiKey() {
            const input = document.getElementById('settings-integrations-key');
            const msgEl = document.getElementById('settings-integrations-msg');
            if (!input || !msgEl) return;
            const key = input.value.trim();
            if (!key) { showSettingsMsg(msgEl, 'Please enter an API key.', true); return; }
            try {
                await DenAriiAI.setApiKey(key);
                loadIntegrationsSettings();
                showSettingsMsg(msgEl, 'API key saved.', false);
            } catch(err) {
                showSettingsMsg(msgEl, 'Error saving key: ' + err.message, true);
            }
        }

        async function removeGeminiApiKey() {
            const msgEl = document.getElementById('settings-integrations-msg');
            try {
                await DenAriiAI.clearApiKey();
                loadIntegrationsSettings();
                if (msgEl) showSettingsMsg(msgEl, 'API key removed.', false);
            } catch(err) {
                if (msgEl) showSettingsMsg(msgEl, 'Error removing key: ' + err.message, true);
            }
        }

        // ── Twelve Data key (Settings → Integrations) ──
        // Stored like the Gemini key, through js/services/market-data-key.js.

        async function loadTwelveDataSettings() {
            if (typeof TwelveDataKey === 'undefined') return;
            try { await TwelveDataKey.loadApiKey(); } catch (e) { /* non-fatal */ }
            const hasKey = TwelveDataKey.hasUserKey();
            const removeBtn = document.getElementById('settings-twelvedata-remove-btn');
            if (removeBtn) removeBtn.style.display = hasKey ? '' : 'none';
            const badge = document.getElementById('twelvedata-key-status-badge');
            if (badge) {
                badge.textContent = hasKey ? 'Personal key saved' : 'Not configured';
                badge.style.color = hasKey ? 'var(--success)' : 'var(--danger)';
            }
            const input = document.getElementById('settings-twelvedata-key');
            if (input) input.value = '';
        }

        async function saveTwelveDataApiKey() {
            const input = document.getElementById('settings-twelvedata-key');
            const msgEl = document.getElementById('settings-twelvedata-msg');
            if (!input || !msgEl) return;
            if (typeof TwelveDataKey === 'undefined') { showSettingsMsg(msgEl, 'Key storage is not available. Refresh and try again.', true); return; }
            const key = input.value.trim();
            if (!key) { showSettingsMsg(msgEl, 'Please enter an API key.', true); return; }
            try {
                await TwelveDataKey.saveApiKey(key);
                loadTwelveDataSettings();
                showSettingsMsg(msgEl, 'API key saved.', false);
            } catch(err) {
                showSettingsMsg(msgEl, 'Error saving key: ' + err.message, true);
            }
        }

        async function removeTwelveDataApiKey() {
            const msgEl = document.getElementById('settings-twelvedata-msg');
            if (typeof TwelveDataKey === 'undefined') return;
            try {
                await TwelveDataKey.clearApiKey();
                loadTwelveDataSettings();
                if (msgEl) showSettingsMsg(msgEl, 'API key removed.', false);
            } catch(err) {
                if (msgEl) showSettingsMsg(msgEl, 'Error removing key: ' + err.message, true);
            }
        }

        // ── Webull (Settings → Integrations) ──
        // UI for window.denariiWebull (electron/webull/). Webull is called only
        // from the main process. The App Key and App Secret are never logged,
        // stored, or rendered back.

        const WEBULL_DEFAULT_APPROVE_MSG = 'Approve Denarii in the Webull app, then tap Check again.';
        const WEBULL_REVOKE_MSG = "Also revoke the App Key in Webull's developer portal if you no longer use it.";
        const WEBULL_GENERIC_MSG = 'Something went wrong.';
        const WEBULL_BUSY_MSG = 'A Webull sync is already running.';
        const WEBULL_NO_LINKS_MSG = 'Link a broker account to Webull in Settings → Broker Accounts to start importing.';
        const WEBULL_HISTORY_START = '2018-05-21';

        // Desktop only: the preload exposes window.denariiWebull.
        function webullUnavailable() {
            return !window.denariiWebull;
        }

        // status: last status() result ({connected:false} or the connected shape), null until loaded
        // busy: a call is in flight; running: main is syncing; cooldownUntil: per-action epoch ms
        const webullUi = {
            status: null,
            busy: false,
            running: false,
            msg: null,
            msgType: 'info',
            cooldownUntil: { connect: 0, check_approval: 0, resend_code: 0 },
            timers: {},
            listening: false
        };

        function webullPanel() {
            const panel = document.getElementById('settings-integrations');
            if (!panel) return null;
            let el = document.getElementById('settings-webull');
            if (!el) {
                el = document.createElement('div');
                el.id = 'settings-webull';
                el.style.cssText = 'margin-top:32px;padding-top:24px;border-top:1px solid var(--border);';
                panel.appendChild(el);
            }
            return el;
        }

        // Calls one preload method. Never throws: failures come back as { ok: false, error }.
        async function webullRequest(method, arg) {
            let res;
            try {
                res = await window.denariiWebull[method](arg);
            } catch (e) {
                res = null;
            }
            return (res && typeof res === 'object') ? res : { ok: false, error: WEBULL_GENERIC_MSG };
        }

        function webullErrorText(res) {
            return (res && typeof res.error === 'string' && res.error) ? res.error : WEBULL_GENERIC_MSG;
        }

        function webullSetMsg(text, type) {
            webullUi.msg = text || null;
            webullUi.msgType = type || 'info';
        }

        function webullSetCooldown(action, untilMs) {
            if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return;
            webullUi.cooldownUntil[action] = Math.max(webullUi.cooldownUntil[action] || 0, untilMs);
            clearTimeout(webullUi.timers[action]);
            webullUi.timers[action] = setTimeout(renderWebullSection, untilMs - Date.now() + 50);
        }

        function webullCoolingDown(action) {
            return (webullUi.cooldownUntil[action] || 0) > Date.now();
        }

        function webullApplyRetryAfter(action, res) {
            if (res && typeof res.retryAfterSec === 'number') {
                webullSetCooldown(action, Date.now() + res.retryAfterSec * 1000);
            }
        }

        function webullTodayUtc() {
            return new Date().toISOString().slice(0, 10);
        }

        function webullJournalName(journalId) {
            const accts = (typeof journalData !== 'undefined' && journalData && Array.isArray(journalData.brokerAccounts)) ? journalData.brokerAccounts : [];
            const a = accts.find(x => x && String(x.id) === String(journalId));
            return a ? (a.displayName || a.broker || 'Broker account') : 'Broker account';
        }

        function webullProgressText(progress) {
            return (typeof WebullSync !== 'undefined' && typeof WebullSync.progressText === 'function') ? WebullSync.progressText(progress) : '';
        }

        // Progress and status events from main. Progress updates the shown
        // status in place; a finished journal or run reloads status for the
        // new last sync time.
        function webullListen() {
            if (webullUi.listening || webullUnavailable() || typeof window.denariiWebull.onStatus !== 'function') return;
            webullUi.listening = true;
            window.denariiWebull.onStatus(webullOnStatus);
        }

        function webullOnStatus(ev) {
            if (!ev || typeof ev !== 'object') return;
            if (ev.kind === 'run') {
                webullUi.running = !!ev.running;
                if (!ev.running) { refreshWebullStatus(); return; }
                renderWebullSection();
                return;
            }
            const s = webullUi.status;
            const link = s && Array.isArray(s.links) ? s.links.find(l => l && l.journalId === ev.journalId) : null;
            if (!link) return;
            if (ev.kind === 'progress') {
                link.progress = ev;
                link.status = 'running';
                renderWebullSection();
            } else if (ev.kind === 'journal') {
                link.status = ev.status || null;
                link.error = ev.error || null;
                if (ev.status !== 'running') { link.progress = null; refreshWebullStatus(); }
                else renderWebullSection();
            }
        }

        // status() without touching the message or busy state.
        async function refreshWebullStatus() {
            if (webullUnavailable()) return;
            const res = await webullRequest('status');
            if (typeof res.connected === 'boolean') webullUi.status = res;
            renderWebullSection();
        }

        async function loadWebullSection() {
            const el = webullPanel();
            if (!el) return;
            const panel = document.getElementById('settings-integrations');
            // Only load when the Integrations panel is actually showing, and
            // never stack a second request on one already in flight.
            if (webullUnavailable() || !panel.classList.contains('active') || webullUi.busy) { renderWebullSection(); return; }
            webullListen();
            webullUi.busy = true;
            webullSetMsg(null);
            renderWebullSection();
            const res = await webullRequest('status');
            webullUi.busy = false;
            if (typeof res.connected === 'boolean') {
                webullUi.status = res;
            } else {
                webullSetMsg(webullErrorText(res), 'danger');
            }
            renderWebullSection();
        }

        // Last sync time, import progress, errors and Sync now for the
        // linked journals. Journals sync one at a time.
        function webullSyncHtml(s, dis) {
            const muted = 'color:var(--text-secondary);font-size:13px;';
            const links = Array.isArray(s.links) ? s.links.filter(l => l && l.journalId) : [];
            if (!links.length) return '<p style="' + muted + 'margin-bottom:16px;">' + escapeHtml(WEBULL_NO_LINKS_MSG) + '</p>';
            const running = webullUi.running || links.some(l => l.status === 'running');
            const last = Math.max.apply(null, links.map(l => Date.parse(l.lastSyncedAt || '')).filter(isFinite).concat(-Infinity));
            let html = '<div style="' + muted + 'margin-bottom:12px;line-height:1.6;">' +
                '<div>Last synced: ' + escapeHtml(isFinite(last) ? new Date(last).toLocaleString() : 'Never') + '</div>';
            links.forEach(l => {
                const text = l.progress ? webullProgressText(l.progress) : '';
                if (text) html += '<div>' + escapeHtml((links.length > 1 ? webullJournalName(l.journalId) + ': ' : '') + text) + '</div>';
            });
            html += '</div>';
            links.forEach(l => {
                if (!l.error || l.status === 'ok' || l.status === 'running') return;
                const type = l.status === 'needs_approval' ? 'warning' : 'danger';
                html += '<div class="alert alert-' + type + '" style="margin-bottom:12px;">' +
                    escapeHtml(webullJournalName(l.journalId) + ': ' + l.error) + '</div>';
            });
            html += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">' +
                '<button class="btn btn-secondary" onclick="syncWebullNow()"' + (running ? ' disabled' : dis()) + '>' + (running ? 'Syncing…' : 'Sync now') + '</button>' +
                '</div>';
            return html;
        }

        function renderWebullSection() {
            const el = webullPanel();
            if (!el) return;
            if (webullUnavailable()) {
                el.style.display = 'none';
                el.innerHTML = '';
                return;
            }
            const s = webullUi.status;
            const busy = webullUi.busy;
            const dis = (action) => (busy || (action && webullCoolingDown(action))) ? ' disabled' : '';
            const muted = 'color:var(--text-secondary);font-size:13px;';
            const revokeNote = '<p style="' + muted + 'margin-top:8px;">' + escapeHtml(WEBULL_REVOKE_MSG) + '</p>';

            let html = '<h3 style="margin-bottom:8px;">Webull</h3>';
            html += '<p style="' + muted + 'margin-bottom:20px;">Denarii only reads your order history and never places trades.</p>';

            if (webullUi.msg) {
                html += '<div class="alert alert-' + webullUi.msgType + '" style="margin-bottom:12px;">' + escapeHtml(webullUi.msg) + '</div>';
            }

            if (!s) {
                if (busy) html += '<p style="' + muted + '">Loading Webull status…</p>';
            } else if (!s.connected) {
                html +=
                    '<div class="form-group">' +
                        '<label for="settings-webull-key">App Key</label>' +
                        '<input type="password" id="settings-webull-key" autocomplete="off">' +
                    '</div>' +
                    '<div class="form-group">' +
                        '<label for="settings-webull-secret">App Secret</label>' +
                        '<input type="password" id="settings-webull-secret" autocomplete="off">' +
                    '</div>' +
                    '<div class="form-group">' +
                        '<label for="settings-webull-start">Import trades starting from</label>' +
                        '<input type="date" id="settings-webull-start" min="' + WEBULL_HISTORY_START + '" max="' + webullTodayUtc() + '">' +
                        '<div style="' + muted + 'margin-top:4px;">Leave empty to import all history.</div>' +
                    '</div>' +
                    '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
                        '<button class="btn btn-primary" onclick="connectWebull()"' + dis('connect') + '>Connect</button>' +
                    '</div>';
            } else {
                html += '<p style="font-weight:600;margin-bottom:12px;">Webull connected · key ••••' + escapeHtml(String(s.last4 || '')) + '</p>';
                if (s.approvalState === 'ok') {
                    const accounts = Array.isArray(s.accounts) ? s.accounts : [];
                    if (accounts.length) {
                        html += '<ul style="margin:0 0 16px 18px;' + muted + '">' +
                            accounts.map(a => '<li>' + escapeHtml(String((a && a.label) || 'Webull account')) + '</li>').join('') +
                            '</ul>';
                    }
                    // Neutral, amber within 3 days of expiry.
                    const expMs = Date.parse(s.approvalExpiresAt || '');
                    if (isFinite(expMs)) {
                        const soon = expMs - Date.now() < 3 * 24 * 60 * 60 * 1000;
                        html += '<p style="font-size:13px;margin-bottom:16px;color:' + (soon ? 'color-mix(in srgb, var(--warning) 50%, var(--text-primary))' : 'var(--text-secondary)') + ';">' +
                            escapeHtml('Webull approval expires ' + new Date(expMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })) + '</p>';
                    }
                    html += webullSyncHtml(s, dis);
                    html += '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
                        '<button class="btn btn-secondary" onclick="disconnectWebull()"' + dis() + '>Disconnect</button>' +
                        '</div>' + revokeNote;
                } else {
                    // Steps shown until an action's own message replaces them.
                    if (!webullUi.msg) {
                        html += '<div class="alert alert-warning" style="margin-bottom:12px;">' +
                            escapeHtml('Your Webull approval has expired or is waiting. Tap "I\'ve approved it, check again". ' +
                                'If it says the approval expired, tap "Send new code", enter the code in the Webull app, then tap "I\'ve approved it, check again".') +
                            '</div>';
                    }
                    html += '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
                        '<button class="btn btn-primary" onclick="checkWebullApproval()"' + dis('check_approval') + '>I\'ve approved it, check again</button>' +
                        '<button class="btn btn-secondary" onclick="resendWebullCode()"' + dis('resend_code') + '>Send new code</button>' +
                        '<button class="btn btn-secondary" onclick="disconnectWebull()"' + dis() + '>Disconnect</button>' +
                        '</div>' + revokeNote;
                }
            }
            el.style.display = '';
            el.innerHTML = html;
        }

        async function connectWebull() {
            if (webullUnavailable() || webullUi.busy || webullCoolingDown('connect')) return;
            const keyEl = document.getElementById('settings-webull-key');
            const secretEl = document.getElementById('settings-webull-secret');
            const startEl = document.getElementById('settings-webull-start');
            if (!keyEl || !secretEl) return;
            let input = { appKey: keyEl.value, appSecret: secretEl.value, startDate: (startEl && startEl.value) || null };
            // Clear the inputs right away; the values live only in `input` until the call finishes.
            keyEl.value = '';
            secretEl.value = '';
            let res;
            try {
                if (!input.appKey.trim() || !input.appSecret.trim()) {
                    res = { ok: false, error: 'Enter a valid App Key and App Secret.' };
                } else {
                    webullUi.busy = true;
                    renderWebullSection();
                    res = await webullRequest('connect', input);
                }
            } finally {
                input.appKey = null;
                input.appSecret = null;
                input = null;
                webullUi.busy = false;
            }
            if (res.ok && res.approvalState) {
                webullUi.status = {
                    connected: true, last4: res.last4 || '', approvalState: res.approvalState, accounts: [],
                    links: (webullUi.status && webullUi.status.links) || []
                };
                webullSetMsg(WEBULL_DEFAULT_APPROVE_MSG, 'info');
            } else {
                webullApplyRetryAfter('connect', res);
                webullSetMsg(webullErrorText(res), 'danger');
            }
            renderWebullSection();
        }

        async function checkWebullApproval() {
            if (webullUi.busy || webullCoolingDown('check_approval') || !webullUi.status || !webullUi.status.connected) return;
            webullUi.busy = true;
            renderWebullSection();
            const res = await webullRequest('checkApproval');
            webullUi.busy = false;
            if (res.ok && res.approvalState) {
                webullUi.status = Object.assign({}, webullUi.status, {
                    approvalState: res.approvalState,
                    accounts: Array.isArray(res.accounts) ? res.accounts : []
                });
                if (res.approvalState === 'ok') webullSetMsg(null);
                else webullSetMsg(res.message || WEBULL_DEFAULT_APPROVE_MSG, 'warning');
                // Main allows one check per 10 seconds.
                if (res.approvalState !== 'ok') webullSetCooldown('check_approval', Date.now() + 10000);
            } else {
                webullApplyRetryAfter('check_approval', res);
                webullSetMsg(webullErrorText(res), 'danger');
            }
            renderWebullSection();
            // checkApproval doesn't return the new expiry or links; status does.
            if (res.ok && res.approvalState === 'ok') loadWebullSection();
        }

        async function resendWebullCode() {
            if (webullUi.busy || webullCoolingDown('resend_code') || !webullUi.status || !webullUi.status.connected) return;
            webullUi.busy = true;
            renderWebullSection();
            const res = await webullRequest('resendCode');
            webullUi.busy = false;
            if (res.ok && res.approvalState) {
                webullUi.status = Object.assign({}, webullUi.status, { approvalState: res.approvalState });
                webullSetMsg(res.message || WEBULL_DEFAULT_APPROVE_MSG, 'info');
                // Main allows one new code per 60 seconds and resets the check cooldown.
                webullSetCooldown('resend_code', Date.now() + 60000);
                webullUi.cooldownUntil.check_approval = 0;
            } else {
                webullApplyRetryAfter('resend_code', res);
                webullSetMsg(webullErrorText(res), 'danger');
            }
            renderWebullSection();
        }

        async function syncWebullNow() {
            if (webullUi.busy || webullUi.running || !webullUi.status || !webullUi.status.connected) return;
            webullUi.busy = true;
            webullSetMsg(null);
            renderWebullSection();
            const res = await webullRequest('syncNow');
            webullUi.busy = false;
            if (res.ok && res.busy) {
                webullSetMsg(WEBULL_BUSY_MSG, 'info');
            } else if (res.ok) {
                webullUi.running = true;
            } else {
                webullSetMsg(webullErrorText(res), 'danger');
            }
            renderWebullSection();
        }

        async function disconnectWebull() {
            if (webullUi.busy) return;
            if (!window.confirm('This permanently deletes your stored Webull keys from Denarii.')) return;
            webullUi.busy = true;
            renderWebullSection();
            const res = await webullRequest('disconnect');
            webullUi.busy = false;
            if (res.ok) {
                webullUi.status = { connected: false };
                webullUi.running = false;
                webullSetMsg(WEBULL_REVOKE_MSG, 'warning');
            } else {
                webullSetMsg(webullErrorText(res), 'danger');
            }
            renderWebullSection();
        }

        // ── Tags Management ──

        let editingTagId = null;
        const DEFAULT_CATEGORIES = ['Setups', 'Mistakes', 'Entry Execution', 'Exit Execution', 'Missed Trades', 'Emotional State'];
        const CATEGORY_COLORS = {
            'Mistakes':         '#E07070',
            'Setups':           '#38BFA1',
            'Entry Execution':  '#F0C060',
            'Exit Execution':   '#6C63FF',
            'Missed Trades':    '#E07070',
            'Emotional State':  '#F97316',
        };
        const EXTRA_COLORS = ['#FF6B9D','#72EFDD','#FFD166','#C77DFF','#06D6A0','#FF8C69','#5B5FEF','#F4A261'];

        // ── Category favorite helpers ──────────────────────────────────────────

        function isSystemCategory(catName) {
            return DEFAULT_CATEGORIES.indexOf(catName) !== -1;
        }

        function ensureCategoryMeta() {
            if (!journalData._categoryMeta) journalData._categoryMeta = {};
        }

        function isCategoryFavorite(catName) {
            ensureCategoryMeta();
            var meta = journalData._categoryMeta[catName];
            return !meta || meta.isFavorite !== false;
        }

        function setCategoryFavorite(catName, isFav) {
            ensureCategoryMeta();
            if (!journalData._categoryMeta[catName]) journalData._categoryMeta[catName] = {};
            journalData._categoryMeta[catName].isFavorite = isFav;
        }

        // ── Starter tags — seeded once for every user account ────────────────────
        // These are treated as normal tags: fully editable and deletable.
        // ensureStarterTags() runs at login. Tags are seeded on first login and
        // re-checked when the bundled version is newer than the stored version,
        // adding only tags that don't already exist (by name + category dedup).
        const STARTER_TAGS_VERSION = 2; // v2: re-seed previously-deleted starter tags as unfavorited
        const STARTER_TAGS = [
            // Mistakes
            { id: 'tag_starter_001', name: 'FOMO Entry',          category: 'Mistakes'        },
            { id: 'tag_starter_002', name: 'Revenge Trade',        category: 'Mistakes'        },
            { id: 'tag_starter_003', name: 'Overtrading',          category: 'Mistakes'        },
            { id: 'tag_starter_004', name: 'Ignored Stop',         category: 'Mistakes'        },
            { id: 'tag_starter_005', name: 'Bought by Accident',   category: 'Mistakes'        },
            // Setups
            { id: 'tag_starter_006', name: 'Gap and Go',           category: 'Setups'          },
            { id: 'tag_starter_007', name: 'ORB',                  category: 'Setups'          },
            { id: 'tag_starter_008', name: 'Pullback',             category: 'Setups'          },
            { id: 'tag_starter_009', name: 'Breakout',             category: 'Setups'          },
            { id: 'tag_starter_010', name: 'Reversal',             category: 'Setups'          },
            // Entry Execution
            { id: 'tag_starter_011', name: 'A+ Entry',             category: 'Entry Execution' },
            { id: 'tag_starter_012', name: 'Early Entry',          category: 'Entry Execution' },
            { id: 'tag_starter_013', name: 'Late Entry',           category: 'Entry Execution' },
            { id: 'tag_starter_014', name: 'Chased Price',         category: 'Entry Execution' },
            { id: 'tag_starter_015', name: 'Scaled In Well',       category: 'Entry Execution' },
            // Exit Execution
            { id: 'tag_starter_016', name: 'Early Exit',           category: 'Exit Execution'  },
            { id: 'tag_starter_017', name: 'Late Exit',            category: 'Exit Execution'  },
            { id: 'tag_starter_018', name: 'Honored Stop',         category: 'Exit Execution'  },
            { id: 'tag_starter_019', name: 'Panic Exit',           category: 'Exit Execution'  },
            { id: 'tag_starter_020', name: 'Cut Winner Too Early', category: 'Exit Execution'  },
            // Missed Trades
            { id: 'tag_starter_021', name: 'Hesitation',           category: 'Missed Trades'   },
            { id: 'tag_starter_022', name: 'No Confidence',        category: 'Missed Trades'   },
            { id: 'tag_starter_023', name: 'Distracted',           category: 'Missed Trades'   },
            { id: 'tag_starter_024', name: 'Too Slow',             category: 'Missed Trades'   },
            { id: 'tag_starter_025', name: 'No Alert Set',         category: 'Missed Trades'   },
            // Emotional State
            { id: 'tag_starter_026', name: 'Confident',            category: 'Emotional State' },
            { id: 'tag_starter_027', name: 'Focused',              category: 'Emotional State' },
            { id: 'tag_starter_028', name: 'Impulsive',            category: 'Emotional State' },
            { id: 'tag_starter_029', name: 'Disciplined',          category: 'Emotional State' },
            { id: 'tag_starter_030', name: 'Revengeful',           category: 'Emotional State' },
        ];

        function getCategories() {
            if (!journalData.tagCategories) journalData.tagCategories = [...DEFAULT_CATEGORIES];
            return journalData.tagCategories;
        }

        /**
         * Seeds starter tags into journalData.
         * Runs on every login but only does work when the stored seed version
         * is older than the bundled STARTER_TAGS_VERSION.
         * Dedup is by name + category (case-insensitive) so it is safe to run
         * against accounts that already have tags (e.g. the Pelosi demo account).
         * Returns true when a save to the local database is needed.
         */
        function ensureStarterTags() {
            // Backfill isStarter on existing tags that match canonical starters
            // by name + category. This handles demo-seeded tags (tag_demo_*) and
            // v1-seeded tags that predate the isStarter field.
            if (journalData.tags && journalData.tags.length > 0) {
                var starterSet = {};
                STARTER_TAGS.forEach(function(s) {
                    starterSet[s.name.toLowerCase() + '|' + s.category.toLowerCase()] = true;
                });
                journalData.tags.forEach(function(t) {
                    if (!t.isStarter) {
                        var key = (t.name || '').trim().toLowerCase() + '|' + (t.category || '').trim().toLowerCase();
                        if (starterSet[key]) t.isStarter = true;
                    }
                });
            }

            // Backfill _categoryMeta for all categories (system and user-created)
            ensureCategoryMeta();
            (journalData.tagCategories || []).forEach(function(cat) {
                if (!journalData._categoryMeta[cat]) {
                    journalData._categoryMeta[cat] = { isFavorite: true };
                }
            });

            // Treat the legacy boolean flag as version 1 so existing users
            // who already received the original seed are not re-seeded until
            // STARTER_TAGS_VERSION is bumped above 1.
            var storedVersion = typeof journalData._starterTagsVersion === 'number'
                ? journalData._starterTagsVersion
                : (journalData._starterTagsSeeded ? 1 : 0);

            if (storedVersion >= STARTER_TAGS_VERSION) return false;

            if (!journalData.tags)           journalData.tags = [];
            if (!journalData.tagCategories)  journalData.tagCategories = [...DEFAULT_CATEGORIES];

            // Ensure all categories referenced by starter tags exist
            var catSet = {};
            journalData.tagCategories.forEach(function(c) { catSet[c] = true; });
            STARTER_TAGS.forEach(function(s) {
                if (!catSet[s.category]) {
                    journalData.tagCategories.push(s.category);
                    catSet[s.category] = true;
                }
            });

            var existing = journalData.tags;
            var deleted = journalData._deletedStarterTagKeys || [];
            var ts = new Date().toISOString();

            for (var i = 0; i < STARTER_TAGS.length; i++) {
                var starter = STARTER_TAGS[i];
                var dkey = starter.name.toLowerCase() + '|' + starter.category.toLowerCase();
                var wasPreviouslyDeleted = deleted.indexOf(dkey) !== -1;
                var alreadyExists = existing.some(function(t) {
                    return t.name.trim().toLowerCase()     === starter.name.toLowerCase() &&
                           t.category.trim().toLowerCase() === starter.category.toLowerCase();
                });
                if (!alreadyExists) {
                    existing.push({
                        id:          starter.id,
                        name:        starter.name,
                        category:    starter.category,
                        description: '',
                        createdAt:   ts,
                        isStarter:   true,
                        isFavorite:  wasPreviouslyDeleted ? false : true,
                    });
                }
            }

            journalData._starterTagsVersion = STARTER_TAGS_VERSION;
            journalData._starterTagsSeeded = true; // keep for backward compat
            return true;
        }

        function getTagCategoryColor(cat) {
            if (CATEGORY_COLORS[cat]) return CATEGORY_COLORS[cat];
            // Assign a consistent color to custom categories based on index
            const cats = getCategories();
            const idx = cats.indexOf(cat);
            if (idx >= 0) return EXTRA_COLORS[idx % EXTRA_COLORS.length];
            return '#7A8BA0';
        }

        function populateCategoryDropdowns() {
            const allCats = getCategories();
            const favCats = allCats.filter(c => isCategoryFavorite(c));

            // Tag form dropdown — only show favorited categories
            const tagSelect = document.getElementById('tag-category-input');
            const currentVal = tagSelect.value;
            tagSelect.innerHTML = favCats.map(c => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join('');
            if (currentVal && favCats.includes(currentVal)) tagSelect.value = currentVal;

            // Filter dropdown — show ALL categories (including unfavorited for management)
            const filterSelect = document.getElementById('tag-filter-category');
            const filterVal = filterSelect.value;
            filterSelect.innerHTML = '<option value="All">All</option>' + allCats.map(c => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join('');
            if (filterVal && (filterVal === 'All' || allCats.includes(filterVal))) filterSelect.value = filterVal;
        }

        function ensureTagsArray() {
            if (!journalData.tags) journalData.tags = [];
        }

        var _tagSortField = 'name';
        var _tagSortDir = 'asc';

        function setTagSort(field) {
            if (_tagSortField === field) {
                _tagSortDir = _tagSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                _tagSortField = field;
                _tagSortDir = 'asc';
            }
            renderTagsTable();
        }

        function loadTagsData() {
            ensureTagsArray();
            getCategories(); // ensure initialized
            populateCategoryDropdowns();
            renderTagsTable();
        }

        function countTagUsage(tagName) {
            if (!journalData.trades) return 0;
            return journalData.trades.filter(t => t.tags && t.tags.some(tag => tag.toLowerCase() === tagName.toLowerCase())).length;
        }

        function renderTagsTable() {
            ensureTagsArray();
            const filter = document.getElementById('tag-filter-category').value;
            const search = (document.getElementById('tag-search-input').value || '').toLowerCase();
            const tbody = document.getElementById('tags-table-body');

            let tags = journalData.tags;
            if (filter !== 'All') tags = tags.filter(t => t.category === filter);
            if (search) tags = tags.filter(t => t.name.toLowerCase().includes(search) || (t.description || '').toLowerCase().includes(search));

            // Update sort indicators
            ['name','category','used','description'].forEach(function(f) {
                var el = document.getElementById('tag-sort-' + f);
                if (el) el.textContent = _tagSortField === f ? (_tagSortDir === 'asc' ? ' ↑' : ' ↓') : '';
            });

            if (tags.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-secondary);">No tags found. Click "+ Add Tag" to create one.</td></tr>';
                return;
            }

            // Pre-compute usage counts for sorting
            var usageCache = {};
            tags.forEach(function(tag) { usageCache[tag.id] = countTagUsage(tag.name); });

            // Sort
            tags = tags.slice().sort(function(a, b) {
                var va, vb;
                switch(_tagSortField) {
                    case 'name':        va = (a.name||'').toLowerCase(); vb = (b.name||'').toLowerCase(); break;
                    case 'category':    va = (a.category||'').toLowerCase(); vb = (b.category||'').toLowerCase(); break;
                    case 'used':        va = usageCache[a.id]||0; vb = usageCache[b.id]||0; return _tagSortDir === 'asc' ? va - vb : vb - va;
                    case 'description': va = (a.description||'').toLowerCase(); vb = (b.description||'').toLowerCase(); break;
                    default:            va = (a.name||'').toLowerCase(); vb = (b.name||'').toLowerCase();
                }
                return _tagSortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
            });

            tbody.innerHTML = tags.map(tag => {
                const used = usageCache[tag.id];
                const color = getTagCategoryColor(tag.category);
                const isStarterTag = tag.isStarter || (typeof tag.id === 'string' && tag.id.startsWith('tag_starter_'));
                const isFav = tag.isFavorite !== false;
                const starIcon = isFav ? '★' : '☆';
                const starColor = isFav ? '#f59e0b' : 'var(--text-secondary)';
                const starTitle = isFav ? 'Unfavorite' : 'Favorite';
                const starBtn = '<button onclick="toggleTagFavorite(\'' + escapeHtml(tag.id) + '\')" title="' + starTitle + '" style="background:transparent;border:none;font-size:16px;cursor:pointer;padding:2px 4px;color:' + starColor + ';">' + starIcon + '</button>';
                const dimStyle = !isFav ? 'opacity:0.5;' : '';
                return '<tr style="' + dimStyle + '">' +
                    '<td style="width:32px;text-align:center;">' + starBtn + '</td>' +
                    '<td style="font-weight:600;">' + escapeHtml(tag.name) + '</td>' +
                    '<td><span class="tag-category-dot" style="background:' + color + ';"></span>' + escapeHtml(tag.category) + '</td>' +
                    '<td>' + used + '</td>' +
                    '<td style="color:var(--text-secondary);font-size:13px;">' + escapeHtml(tag.description || '') + '</td>' +
                    '<td style="position:relative;"><button class="tag-actions-btn" onclick="toggleTagMenu(event,\'' + escapeHtml(tag.id) + '\')">⋯</button></td>' +
                    '</tr>';
            }).join('');
        }

        // Tag context menu
        let _activeTagMenu = null;

        function toggleTagMenu(e, tagId) {
            e.stopPropagation();
            closeTagMenu();
            const tag = (journalData.tags || []).find(t => String(t.id) === String(tagId));
            const isStarterTag = tag && (tag.isStarter || (typeof tag.id === 'string' && tag.id.startsWith('tag_starter_')));
            const btn = e.currentTarget;
            const rect = btn.getBoundingClientRect();
            const menu = document.createElement('div');
            menu.className = 'tag-context-menu';
            menu.style.position = 'fixed';
            menu.style.right = (window.innerWidth - rect.right) + 'px';
            const favLabel = (tag && tag.isFavorite === false) ? 'Favorite' : 'Unfavorite';
            menu.innerHTML =
                (isStarterTag ? '' : '<button onclick="editTag(\'' + tagId + '\')">Edit</button>') +
                '<button onclick="toggleTagFavorite(\'' + tagId + '\')">' + favLabel + '</button>' +
                (isStarterTag ? '' : '<button class="danger" onclick="deleteTag(\'' + tagId + '\')">Delete</button>');
            document.body.appendChild(menu);

            // Position below button, but flip above if near bottom of viewport
            const menuHeight = menu.offsetHeight || 90;
            if (rect.bottom + menuHeight + 8 > window.innerHeight) {
                menu.style.top = (rect.top - menuHeight - 4) + 'px';
            } else {
                menu.style.top = (rect.bottom + 4) + 'px';
            }

            _activeTagMenu = menu;
            setTimeout(() => document.addEventListener('click', closeTagMenu, { once: true }), 0);
        }

        function closeTagMenu() {
            if (_activeTagMenu) {
                _activeTagMenu.remove();
                _activeTagMenu = null;
            }
        }

        function editTag(tagId) {
            closeTagMenu();
            ensureTagsArray();
            const tag = journalData.tags.find(t => t.id === tagId);
            if (!tag) return;
            var isStarterTag = tag.isStarter || (typeof tag.id === 'string' && tag.id.startsWith('tag_starter_'));
            if (isStarterTag) {
                alert('System tags cannot be edited. You can favorite/unfavorite them or create your own tags.');
                return;
            }
            editingTagId = tagId;
            document.getElementById('tag-form-title').textContent = 'Edit Tag';
            document.getElementById('tag-name-input').value = tag.name;
            populateCategoryDropdowns();
            document.getElementById('tag-category-input').value = tag.category;
            document.getElementById('tag-desc-input').value = tag.description || '';
            document.getElementById('tag-form-card').style.display = 'block';
            document.getElementById('tag-name-input').focus();
            _tagGuardOpen(tagId);
        }

        // Batch 2: re-sync guard for the open tag form. A re-sync that
        // replaces the tag reloads a clean form; Save while it is stale keeps
        // this version as a conflict copy and loads the newer one instead.
        function _tagFormSig() {
            return JSON.stringify(['tag-name-input', 'tag-category-input', 'tag-desc-input']
                .map(id => document.getElementById(id).value));
        }

        function _tagStaleSave(tagId) {
            const stored = (journalData.tags || []).find(t => t.id === tagId) || { id: tagId };
            _editorGuardConflict('tag-editor', Object.assign({}, stored, {
                name: document.getElementById('tag-name-input').value.trim(),
                category: document.getElementById('tag-category-input').value,
                description: document.getElementById('tag-desc-input').value.trim()
            }));
            editTag(tagId);
        }

        function _tagGuardOpen(tagId) {
            if (typeof _editorGuardOpen !== 'function') return;
            const openSig = _tagFormSig();
            _editorGuardOpen('tag-editor', 'tags', String(tagId), {
                isOpen: () => editingTagId === tagId && document.getElementById('tag-form-card').style.display !== 'none',
                isDirty: () => _tagFormSig() !== openSig,
                reload: () => editTag(tagId),
                resolve: () => _tagStaleSave(tagId)
            });
        }

        function deleteTag(tagId) {
            closeTagMenu();
            ensureTagsArray();
            const tag = journalData.tags.find(t => t.id === tagId);
            if (!tag) return;

            var isStarterTag = tag.isStarter || (typeof tag.id === 'string' && tag.id.startsWith('tag_starter_'));

            // Starter tags cannot be deleted — toggle favorite instead
            if (isStarterTag) {
                tag.isFavorite = tag.isFavorite === false ? true : false;
                if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                    _saveTagToSupabase(tag);
                }
                saveToIndexedDB();
                renderTagsTable();
                return;
            }

            if (window.confirm('Delete the tag "' + tag.name + '"? This cannot be undone.')) {
                journalData.tags = journalData.tags.filter(t => t.id !== tagId);
                if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                    _deleteTagFromSupabase(tagId);
                }
                saveToIndexedDB();
                renderTagsTable();
            }
        }

        function toggleTagFavorite(tagId) {
            ensureTagsArray();
            const tag = journalData.tags.find(t => String(t.id) === String(tagId));
            if (!tag) return;
            tag.isFavorite = tag.isFavorite === false ? true : false;
            if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                _saveTagToSupabase(tag);
            }
            saveToIndexedDB();
            renderTagsTable();
        }

        function showAddTagForm() {
            editingTagId = null;
            document.getElementById('tag-form-title').textContent = 'Add New Tag';
            document.getElementById('tag-name-input').value = '';
            populateCategoryDropdowns();
            document.getElementById('tag-category-input').value = getCategories()[0] || 'Setups';
            document.getElementById('tag-desc-input').value = '';
            document.getElementById('tag-form-card').style.display = 'block';
            document.getElementById('tag-name-input').focus();
        }

        function cancelTagForm() {
            document.getElementById('tag-form-card').style.display = 'none';
            editingTagId = null;
            if (typeof _editorGuardClose === 'function') _editorGuardClose('tag-editor');
        }

        async function saveTag() {
            ensureTagsArray();
            // Batch 2: changed on another device while open → conflict copy, reload.
            if (editingTagId && typeof _editorGuardStale === 'function' && _editorGuardStale('tag-editor', String(editingTagId)) === true) {
                _tagStaleSave(editingTagId);
                return;
            }
            const name = document.getElementById('tag-name-input').value.trim();
            const category = document.getElementById('tag-category-input').value;
            const description = document.getElementById('tag-desc-input').value.trim();
            const msgEl = document.getElementById('tag-form-msg');

            if (!name) { showSettingsMsg(msgEl, 'Tag name is required.', true); return; }

            const duplicate = journalData.tags.find(t =>
                t.name.trim().toLowerCase() === name.toLowerCase() &&
                t.category.trim().toLowerCase() === category.trim().toLowerCase() &&
                t.id !== editingTagId
            );
            if (duplicate) { showSettingsMsg(msgEl, 'A tag with this name already exists.', true); return; }

            // Capture before cancelTagForm() clears editingTagId
            const wasEditing = !!editingTagId;

            if (editingTagId) {
                const existing = journalData.tags.find(t => t.id === editingTagId);
                if (existing && (existing.isStarter || (typeof existing.id === 'string' && existing.id.startsWith('tag_starter_')))) {
                    showSettingsMsg(msgEl, 'System tags cannot be edited.', true);
                    return;
                }
                const idx = journalData.tags.findIndex(t => t.id === editingTagId);
                if (idx !== -1) {
                    journalData.tags[idx].name = name;
                    journalData.tags[idx].category = category;
                    journalData.tags[idx].description = description;
                    if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                        _saveTagToSupabase(journalData.tags[idx]);
                    }
                }
            } else {
                var newTag = {
                    id: 'tag_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
                    name, category, description,
                    createdAt: new Date().toISOString()
                };
                journalData.tags.push(newTag);
                if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                    _saveTagToSupabase(newTag);
                }
            }

            await saveToIndexedDB();
            cancelTagForm();

            // Reset filter to "All" so the saved tag is always visible regardless of
            // which category was active before — this prevents the table from appearing
            // unchanged after save when the tag belongs to a different filtered category.
            document.getElementById('tag-filter-category').value = 'All';
            document.getElementById('tag-search-input').value = '';
            renderTagsTable();

            // Confirm success with a brief message above the table
            const saveMsg = document.getElementById('tag-save-msg');
            if (saveMsg) {
                const action = wasEditing ? 'updated' : 'saved';
                showSettingsMsg(saveMsg, 'Tag ' + action + ' — "' + name + '" in ' + category + '.', false);
            }
        }

        // ── Category Management ──

        let editingCategoryName = null;

        function openCategoryManager() {
            document.getElementById('category-manage-card').style.display = 'block';
            renderCategoryList();
        }

        function closeCategoryManager() {
            editingCategoryName = null;
            document.getElementById('category-manage-card').style.display = 'none';
        }

        function renderCategoryList() {
            const cats = getCategories();
            const listEl = document.getElementById('category-list');

            if (cats.length === 0) {
                listEl.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;">No categories yet.</p>';
                return;
            }

            listEl.innerHTML = cats.map((cat) => {
                const color    = getTagCategoryColor(cat);
                const tagCount = journalData.tags ? journalData.tags.filter(t => t.category === cat).length : 0;

                // Inline edit mode for this row
                if (editingCategoryName === cat) {
                    return '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--primary);border-radius:8px;margin-bottom:6px;">' +
                        '<span class="tag-category-dot" style="background:' + color + ';flex-shrink:0;"></span>' +
                        '<input id="category-edit-input" type="text" value="' + escapeHtml(cat) + '" ' +
                            'style="flex:1;min-width:0;padding:4px 8px;font-size:14px;font-weight:600;border:1px solid var(--primary);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);" ' +
                            'onkeydown="if(event.key===\'Enter\')saveCategoryEdit(\'' + escapeHtml(cat) + '\');if(event.key===\'Escape\')cancelCategoryEdit();">' +
                        '<button class="btn btn-small btn-primary" onclick="saveCategoryEdit(\'' + escapeHtml(cat) + '\')" style="padding:4px 10px;font-size:12px;flex-shrink:0;">Save</button>' +
                        '<button class="btn btn-small btn-secondary" onclick="cancelCategoryEdit()" style="padding:4px 10px;font-size:12px;flex-shrink:0;">Cancel</button>' +
                        '</div>';
                }

                const isSys = isSystemCategory(cat);
                const isFav = isCategoryFavorite(cat);
                const starHtml = '<button onclick="toggleCategoryFavorite(\'' + escapeHtml(cat) + '\')" title="' + (isFav ? 'Unfavorite' : 'Favorite') + '" style="background:transparent;border:none;font-size:16px;cursor:pointer;padding:2px 4px;color:' + (isFav ? '#f59e0b' : 'var(--text-secondary)') + ';">' + (isFav ? '★' : '☆') + '</button>';
                const dimStyle = !isFav ? 'opacity:0.5;' : '';

                return '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;margin-bottom:6px;' + dimStyle + '">' +
                    '<div style="display:flex;align-items:center;gap:10px;">' +
                    starHtml +
                    '<span class="tag-category-dot" style="background:' + color + ';"></span>' +
                    '<span style="font-weight:600;font-size:14px;">' + escapeHtml(cat) + '</span>' +
                    '<span style="font-size:11px;color:var(--text-secondary);">' + tagCount + ' tag' + (tagCount !== 1 ? 's' : '') + '</span>' +
                    '</div>' +
                    '<button class="tag-actions-btn" onclick="toggleCategoryMenu(event,\'' + escapeHtml(cat) + '\')">⋯</button>' +
                    '</div>';
            }).join('');

            // Auto-focus the edit input when entering edit mode
            if (editingCategoryName) {
                const inp = document.getElementById('category-edit-input');
                if (inp) { inp.focus(); inp.select(); }
            }
        }

        async function toggleCategoryFavorite(catName) {
            setCategoryFavorite(catName, !isCategoryFavorite(catName));
            await saveToIndexedDB();
            renderCategoryList();
            populateCategoryDropdowns();
        }

        function toggleCategoryMenu(e, catName) {
            e.stopPropagation();
            closeTagMenu(); // reuse shared _activeTagMenu slot — closes any open tag or category menu
            const btn  = e.currentTarget;
            const rect = btn.getBoundingClientRect();
            const menu = document.createElement('div');
            menu.className = 'tag-context-menu';
            menu.style.position = 'fixed';
            menu.style.right = (window.innerWidth - rect.right) + 'px';
            var isSysCat = isSystemCategory(catName);
            var favLabel = isCategoryFavorite(catName) ? 'Unfavorite' : 'Favorite';
            menu.innerHTML =
                (isSysCat ? '' : '<button onclick="editCategory(\'' + escapeHtml(catName) + '\')">Edit</button>') +
                '<button onclick="toggleCategoryFavorite(\'' + escapeHtml(catName) + '\')">' + favLabel + '</button>' +
                (isSysCat ? '' : '<button class="danger" onclick="deleteCategory(\'' + escapeHtml(catName) + '\')">Delete</button>');
            document.body.appendChild(menu);

            const menuHeight = menu.offsetHeight || 90;
            if (rect.bottom + menuHeight + 8 > window.innerHeight) {
                menu.style.top = (rect.top - menuHeight - 4) + 'px';
            } else {
                menu.style.top = (rect.bottom + 4) + 'px';
            }

            _activeTagMenu = menu;
            setTimeout(() => document.addEventListener('click', closeTagMenu, { once: true }), 0);
        }

        function editCategory(catName) {
            closeTagMenu();
            if (isSystemCategory(catName)) {
                alert('Default categories cannot be renamed. You can favorite/unfavorite them or create your own categories.');
                return;
            }
            editingCategoryName = catName;
            renderCategoryList();
        }

        function cancelCategoryEdit() {
            editingCategoryName = null;
            renderCategoryList();
        }

        async function saveCategoryEdit(oldName) {
            if (isSystemCategory(oldName)) { cancelCategoryEdit(); return; }
            const inp    = document.getElementById('category-edit-input');
            if (!inp) return;
            const newName = inp.value.trim();
            const msgEl   = document.getElementById('category-form-msg');

            if (!newName) { showSettingsMsg(msgEl, 'Category name is required.', true); return; }

            // No-op rename
            if (newName === oldName) { cancelCategoryEdit(); return; }

            const cats = getCategories();
            if (cats.some(c => c.toLowerCase() === newName.toLowerCase() && c !== oldName)) {
                showSettingsMsg(msgEl, 'A category with this name already exists.', true);
                return;
            }

            // Rename in the category list
            const idx = cats.indexOf(oldName);
            if (idx !== -1) cats[idx] = newName;
            journalData.tagCategories = cats;

            // Migrate _categoryMeta entry to the new name
            if (journalData._categoryMeta && journalData._categoryMeta[oldName]) {
                journalData._categoryMeta[newName] = journalData._categoryMeta[oldName];
                delete journalData._categoryMeta[oldName];
            }

            // Update every tag that references the old category name
            if (journalData.tags) {
                journalData.tags.forEach(t => { if (t.category === oldName) t.category = newName; });
            }

            editingCategoryName = null;
            await saveToIndexedDB();

            renderCategoryList();
            populateCategoryDropdowns();

            // Keep the category filter in sync if it was showing the old name
            const filterSel = document.getElementById('tag-filter-category');
            if (filterSel && filterSel.value === oldName) filterSel.value = newName;
            renderTagsTable();
        }

        async function deleteCategory(catName) {
            closeTagMenu();
            const cats = getCategories();
            if (!cats.includes(catName)) return;

            // System categories cannot be deleted — toggle favorite instead
            if (isSystemCategory(catName)) {
                setCategoryFavorite(catName, !isCategoryFavorite(catName));
                await saveToIndexedDB();
                renderCategoryList();
                populateCategoryDropdowns();
                return;
            }

            const tagCount = journalData.tags ? journalData.tags.filter(t => t.category === catName).length : 0;
            let msg = 'Delete the category "' + catName + '"?';
            if (tagCount > 0) {
                msg += '\n\n' + tagCount + ' tag' + (tagCount !== 1 ? 's' : '') + ' will be moved to "Uncategorized".';
            }
            if (!window.confirm(msg)) return;

            // Ensure "Uncategorized" is in the category list before we reassign tags
            if (!cats.includes('Uncategorized')) cats.push('Uncategorized');

            // Move all tags in this category to "Uncategorized"
            if (journalData.tags) {
                journalData.tags.forEach(t => { if (t.category === catName) t.category = 'Uncategorized'; });
            }

            // Remove the category itself
            const idx = cats.indexOf(catName);
            if (idx !== -1) cats.splice(idx, 1);
            journalData.tagCategories = cats;

            await saveToIndexedDB();

            // Reset the category filter if it was showing the deleted category
            const filterSel = document.getElementById('tag-filter-category');
            if (filterSel && filterSel.value === catName) filterSel.value = 'All';

            renderCategoryList();
            populateCategoryDropdowns();
            renderTagsTable();
        }

        async function addCategory() {
            const input = document.getElementById('new-category-input');
            const name = input.value.trim();
            const msgEl = document.getElementById('category-form-msg');

            if (!name) { showSettingsMsg(msgEl, 'Category name is required.', true); return; }

            const cats = getCategories();
            if (cats.some(c => c.toLowerCase() === name.toLowerCase())) {
                showSettingsMsg(msgEl, 'This category already exists.', true);
                return;
            }

            cats.push(name);
            journalData.tagCategories = cats;
            setCategoryFavorite(name, true);
            await saveToIndexedDB();

            input.value = '';
            msgEl.style.display = 'none';
            renderCategoryList();
            populateCategoryDropdowns();
        }

        // ── Delete Account (authenticated, in-app) ──

        function initDeleteAccountSection() {
            var section = document.getElementById('delete-account-section');
            if (!section) return;
            // Only show when logged in with an active account
            if (currentAccountId) {
                section.style.display = '';
            } else {
                section.style.display = 'none';
            }
        }

        // ── Stay signed in on this computer (electron/auto-signin.js) ──

        var AUTO_SIGNIN_LEGACY_MSG = 'Not available for this account because it uses an older encryption format.';
        var AUTO_SIGNIN_CLOUD_MSG = 'Not available for cloud-linked accounts.';

        // Hidden when this computer cannot protect the key; disabled with a
        // note for legacy (non-DEK) and cloud-linked accounts.
        async function initAutoSignInSection() {
            var section = document.getElementById('autosignin-section');
            var cb = document.getElementById('settings-autosignin');
            var note = document.getElementById('settings-autosignin-note');
            if (!section || !cb) return;
            try {
                var status = (window.denariiAutoSignIn && currentAccountId) ? await window.denariiAutoSignIn.status() : null;
                if (!status || !status.available) { section.style.display = 'none'; return; }
                var auth = await getAuthRecord();
                if (!auth) { section.style.display = 'none'; return; }
                var reason = auth.supabaseUid ? AUTO_SIGNIN_CLOUD_MSG
                    : (auth.dekVersion !== 1 || !sessionDek) ? AUTO_SIGNIN_LEGACY_MSG : '';
                cb.checked = !reason && status.accountId === auth.id;
                cb.disabled = !!reason;
                if (note) { note.textContent = reason; note.style.display = reason ? '' : 'none'; }
                section.style.display = '';
            } catch (e) {
                section.style.display = 'none';
            }
        }

        // Turning on needs the current password; turning off does not.
        async function toggleAutoSignIn(cb) {
            var msgEl = document.getElementById('settings-autosignin-msg');
            var turnOn = cb.checked;
            cb.checked = !turnOn; // unchanged until the change is done
            cb.disabled = true;
            if (msgEl) { msgEl.style.display = 'none'; msgEl.textContent = ''; }
            try {
                if (!window.denariiAutoSignIn) throw new Error('Automatic sign-in is not available.');
                if (!turnOn) {
                    var off = await window.denariiAutoSignIn.disable();
                    if (!off || !off.ok) throw new Error((off && off.error) || 'Could not turn off automatic sign-in.');
                    return;
                }
                var auth = await getAuthRecord();
                if (!auth || auth.supabaseUid || auth.dekVersion !== 1 || !sessionDek) return;
                var pw = await window.showPromptModal({ message: 'Enter your password to stay signed in on this computer.', inputType: 'password' });
                if (!pw) return;
                var pwCheck = await DekCrypto.verifySecret(pw, auth.passwordHash);
                if (!pwCheck.ok) { showSettingsMsg(msgEl, 'Incorrect password.', true); return; }
                var status = await window.denariiAutoSignIn.status();
                if (status && status.accountId && status.accountId !== auth.id) {
                    var other = await getAuthRecordById(status.accountId);
                    if (!confirm('This will replace automatic sign-in for ' + (other ? other.username : 'another account') + '.')) return;
                }
                var on = await window.denariiAutoSignIn.enable(auth.id, sessionDek);
                if (!on || !on.ok) throw new Error((on && on.error) || 'Could not turn on automatic sign-in.');
            } catch (err) {
                showSettingsMsg(msgEl, 'Error: ' + err.message, true);
            } finally {
                await initAutoSignInSection();
            }
        }

        function showDeleteAccountConfirm() {
            document.getElementById('delete-account-confirm').style.display = '';
            document.getElementById('delete-account-pw').value = '';
            var msgEl = document.getElementById('delete-account-msg');
            if (msgEl) { msgEl.style.display = 'none'; msgEl.textContent = ''; }
            document.getElementById('delete-account-pw').focus();
        }

        function hideDeleteAccountConfirm() {
            document.getElementById('delete-account-confirm').style.display = 'none';
            document.getElementById('delete-account-pw').value = '';
            var msgEl = document.getElementById('delete-account-msg');
            if (msgEl) { msgEl.style.display = 'none'; msgEl.textContent = ''; }
        }

        async function deleteAccountAuthenticated() {
            var pw = document.getElementById('delete-account-pw').value;
            var msgEl = document.getElementById('delete-account-msg');
            var btn = document.getElementById('delete-account-btn');

            if (!pw) { showSettingsMsg(msgEl, 'Please enter your password.', true); return; }

            try {
                if (btn) { btn.disabled = true; btn.textContent = 'Deleting...'; }

                // 1. Verify current password against local auth record
                var auth = await getAuthRecord();
                if (!auth) { showSettingsMsg(msgEl, 'No active account found.', true); return; }

                var pwCheck = await DekCrypto.verifySecret(pw, auth.passwordHash);
                if (!pwCheck.ok) {
                    showSettingsMsg(msgEl, 'Incorrect password.', true);
                    return;
                }

                // 2. For cloud-linked accounts, re-authenticate with Supabase
                //    to get a fresh session before server-side deletion
                if (auth.supabaseUid && auth.email) {
                    if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) {
                        showSettingsMsg(msgEl, 'Cloud service is not available. Try again later.', true);
                        return;
                    }
                    var sbResult = await SupabaseAuth.supabaseSignIn(auth.email, pw);
                    if (sbResult.error) {
                        showSettingsMsg(msgEl, 'Cloud re-authentication failed: ' + sbResult.error, true);
                        return;
                    }
                }

                // 3. Delete account (cloud first via _deleteSupabaseAccount, then local)
                var accountId = currentAccountId;
                var username = auth.username;
                await deleteAccount(accountId, username);

                // 4. Clear session state and return to login
                sessionPassword = null;
                sessionDek = null;
                currentAccountId = null;
                currentUsername = null;
                journalData = { trades: [], strategies: [], brokerAccounts: [] };

                // Batch D3: end only this browser's session (scope local).
                if (typeof SupabaseAuth !== 'undefined' && SupabaseAuth.isReady()) {
                    try {
                        var _sbc = SupabaseAuth.getClient();
                        var _so = (_sbc && _sbc.auth) ? _sbc.auth.signOut({ scope: 'local' }) : null;
                        if (_so && typeof _so.catch === 'function') _so.catch(function () {});
                    } catch (_e) { /* already signed out */ }
                }

                document.getElementById('app-container').classList.remove('active');
                document.getElementById('login-screen').classList.remove('hidden');
                showAuthView('login');
            } catch (e) {
                showSettingsMsg(msgEl, 'Deletion failed: ' + (e.message || e), true);
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = 'Permanently Delete'; }
            }
        }

        // ── Conflict Copies (read-only) ──
        // Local versions D3 keeps in this browser when the cloud version wins
        // (auth.js _recordCloudConflict). Clearing removes only that list;
        // cloud data and live records are never touched.

        const CONFLICT_TYPE_LABELS = {
            trades: 'Trade', strategies: 'Strategy', brokerAccounts: 'Broker account', tags: 'Tag',
            noteTemplates: 'Note template', reviews: 'Review', dailyPlanners: 'Daily planner',
            weeklyPlanners: 'Weekly planner', aiOutputHistory: 'Saved report', aiPrompts: 'AI prompt', _meta: 'Setting'
        };

        function _conflictSettingKey() {
            return (typeof currentAccountId !== 'undefined' && currentAccountId) ? 'cloudConflicts:' + currentAccountId : null;
        }

        // Name/date from the kept copy when it decrypts, else the record key.
        function _conflictItemLabel(c, local) {
            if (local && typeof local === 'object' && !Array.isArray(local)) {
                const name = local.symbol || local.name || local.displayName || local.title || local.promptTitle || '';
                const date = String(local.entryDate || local.date || local.createdAt || '').slice(0, 10);
                const label = [name, date].filter(Boolean).join(' · ');
                if (label) return label;
            }
            return String(c.key || '');
        }

        function _conflictRows(list) {
            const encKey = (typeof sessionDek !== 'undefined' && sessionDek) || (typeof sessionPassword !== 'undefined' && sessionPassword) || null;
            return list.slice().reverse().map(c => {
                let local = null;
                if (c && c.local && encKey) { try { local = decrypt(c.local, encKey); } catch (e) { local = null; } }
                const at = c && c.at ? new Date(c.at) : null;
                return {
                    type: CONFLICT_TYPE_LABELS[c && c.domain] || String((c && c.domain) || 'Unknown'),
                    item: _conflictItemLabel(c || {}, local),
                    kept: at && !isNaN(at) ? at.toLocaleString() : ''
                };
            });
        }

        async function loadConflictCopies() {
            const listEl = document.getElementById('settings-conflicts-list');
            const clearBtn = document.getElementById('settings-conflicts-clear-btn');
            if (!listEl) return;
            const key = _conflictSettingKey();
            let list = [];
            try { list = key ? ((await window.getAppSetting(key)) || []) : []; } catch (e) { list = []; }
            if (!Array.isArray(list)) list = [];
            if (clearBtn) clearBtn.disabled = !list.length;
            if (!list.length) {
                listEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">No conflict copies</div>';
                return;
            }
            const cell = 'padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;';
            listEl.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
                '<thead><tr style="color:var(--text-secondary);">' +
                    '<th style="' + cell + '">Data type</th><th style="' + cell + '">Item</th><th style="' + cell + '">Kept</th>' +
                '</tr></thead><tbody>' +
                _conflictRows(list).map(r => '<tr>' +
                    '<td style="' + cell + '">' + escapeHtml(r.type) + '</td>' +
                    '<td style="' + cell + '">' + escapeHtml(r.item) + '</td>' +
                    '<td style="' + cell + 'color:var(--text-secondary);">' + escapeHtml(r.kept) + '</td>' +
                '</tr>').join('') +
                '</tbody></table>';
        }

        function openClearConflictCopies() {
            openModal('conflict-clear-modal');
        }

        async function confirmClearConflictCopies() {
            closeModal('conflict-clear-modal');
            const key = _conflictSettingKey();
            const msgEl = document.getElementById('settings-conflicts-msg');
            if (!key) return;
            try {
                // Let a conflict copy still being written land first.
                if (typeof _conflictChain !== 'undefined') await _conflictChain;
                await window.deleteAppSetting(key);
                if (msgEl) showSettingsMsg(msgEl, 'Conflict copies cleared.', false);
            } catch (e) {
                if (msgEl) showSettingsMsg(msgEl, 'Could not clear conflict copies: ' + (e.message || e), true);
            }
            loadConflictCopies();
        }

        // ── Expose public API to window ──
        window.initDeleteAccountSection = initDeleteAccountSection;
        window.showDeleteAccountConfirm = showDeleteAccountConfirm;
        window.hideDeleteAccountConfirm = hideDeleteAccountConfirm;
        window.deleteAccountAuthenticated = deleteAccountAuthenticated;
        window.openSettings            = openSettings;
        window.switchSettingsTab       = switchSettingsTab;
        window.loadIntegrationsSettings = loadIntegrationsSettings;
        window.loadConflictCopies      = loadConflictCopies;
        window.loadDataSettings        = loadDataSettings;
        window.backupAllData           = backupAllData;
        window.restoreAllData          = restoreAllData;
        window.openBackupsFolder       = openBackupsFolder;
        window.openClearConflictCopies = openClearConflictCopies;
        window.confirmClearConflictCopies = confirmClearConflictCopies;
        window.saveGeminiApiKey        = saveGeminiApiKey;
        window.removeGeminiApiKey      = removeGeminiApiKey;
        window.saveGeminiModel         = saveGeminiModel;
        window.saveTwelveDataApiKey    = saveTwelveDataApiKey;
        window.removeTwelveDataApiKey  = removeTwelveDataApiKey;
        window.connectWebull           = connectWebull;
        window.checkWebullApproval     = checkWebullApproval;
        window.resendWebullCode        = resendWebullCode;
        window.disconnectWebull        = disconnectWebull;
        window.syncWebullNow           = syncWebullNow;
        window.loadProfileSettings     = loadProfileSettings;
        window.saveProfileSettings     = saveProfileSettings;
        window.updateSidebarProfile    = updateSidebarProfile;
        window.changePassword          = changePassword;
        window.toggleAutoSignIn        = toggleAutoSignIn;
        window.handleAvatarUpload      = handleAvatarUpload;
        window.closeCropperModal       = closeCropperModal;
        window.cropAndSaveAvatar       = cropAndSaveAvatar;
        window.removeAvatar            = removeAvatar;
        window.ensureStarterTags       = ensureStarterTags;
        window.ensureStarterTagsExist  = ensureStarterTags; // alias per spec
        window.getCategories           = getCategories;
        window.populateCategoryDropdowns = populateCategoryDropdowns;
        window.loadTagsData            = loadTagsData;
        window.renderTagsTable         = renderTagsTable;
        window.setTagSort              = setTagSort;
        window.toggleTagMenu           = toggleTagMenu;
        window.editTag                 = editTag;
        window.deleteTag               = deleteTag;
        window.toggleTagFavorite       = toggleTagFavorite;
        window.showAddTagForm          = showAddTagForm;
        window.cancelTagForm           = cancelTagForm;
        window.saveTag                 = saveTag;
        window.openCategoryManager     = openCategoryManager;
        window.closeCategoryManager    = closeCategoryManager;
        window.renderCategoryList      = renderCategoryList;
        window.toggleCategoryMenu      = toggleCategoryMenu;
        window.editCategory            = editCategory;
        window.cancelCategoryEdit      = cancelCategoryEdit;
        window.saveCategoryEdit        = saveCategoryEdit;
        window.deleteCategory          = deleteCategory;
        window.addCategory             = addCategory;
        window.toggleCategoryFavorite  = toggleCategoryFavorite;
        window.isCategoryFavorite      = isCategoryFavorite;

})();
