        // Catch any silent errors.
        //
        // Chromium and WebKit intentionally deliver the benign browser-
        // level warning "ResizeObserver loop completed with undelivered
        // notifications" (and the older variant "ResizeObserver loop
        // limit exceeded") as an `error` event on window whenever a
        // ResizeObserver can't finish in one animation frame. It is NOT
        // a real JS exception — it's the spec-defined mechanism that
        // prevents an observer from looping forever. We swallow just
        // that specific message pattern here so it does not surface as
        // a blocking alert during heavy layout-churn paths (e.g. the
        // Dashboard empty-state re-render after a bulk delete, or
        // navigating back into a section whose widgets observe their
        // own size). Every other error still pops the alert so real
        // issues aren't silently lost.
        window.onerror = function(msg, src, line, col, err) {
            var s = String(msg || '');
            if (s.toLowerCase().indexOf('resizeobserver') !== -1) {
                return true; // swallow browser-noise, keep console clean too
            }
            alert('JS Error: ' + msg + '\nLine: ' + line);
            return false;
        };
        window.addEventListener('unhandledrejection', function(e) {
            // Same guard in case the warning ever surfaces as a rejected
            // promise instead of a sync error event.
            var reasonStr = (e && e.reason)
                ? (e.reason.message || String(e.reason))
                : '';
            if (reasonStr.toLowerCase().indexOf('resizeobserver') !== -1) {
                if (e.preventDefault) e.preventDefault();
                return;
            }
            alert('Unhandled promise error: ' + (reasonStr || 'unknown'));
        });

        // Global state
        let journalData = { trades: [], strategies: [], brokerAccounts: [] };
        let db = null;
        let lastBackupTime = null;
        let _journalDirty = false; // Phase 1: set true when journalData is mutated but not yet persisted
        let selectedStrategyColor = '#3b82f6';
        let selectedStrategyForTrade = null;
        let followedRules = [];

        // ── Shared trading-style definitions ─────────────────────────────
        // Single source of truth for trading style values and labels.
        // Used by _populateStyleSelects() to fill every style dropdown.
        const TRADING_STYLES = [
            { value: 'scalping',         label: 'Scalping' },
            { value: 'day_trading',      label: 'Day Trading' },
            { value: 'swing_trading',    label: 'Swing Trading' },
            { value: 'position_trading', label: 'Position Trading' },
            { value: 'leaps',            label: 'LEAPS' },
            { value: 'investing',        label: 'Investing' }
        ];

        // Populate a <select> with trading style options from the shared list.
        // includeAll: when true, prepends an "All Styles" option (for filters).
        function _populateStyleSelect(selectId, includeAll) {
            var sel = document.getElementById(selectId);
            if (!sel) return;
            var cur = sel.value;
            var html = includeAll ? '<option value="all">All Styles</option>' : '';
            for (var i = 0; i < TRADING_STYLES.length; i++) {
                html += '<option value="' + TRADING_STYLES[i].value + '">' + TRADING_STYLES[i].label + '</option>';
            }
            sel.innerHTML = html;
            // Restore previous selection if still valid, else default
            if (cur) sel.value = cur;
        }

        // Populate all style dropdowns that share the standard trading style list.
        function _populateStyleSelects() {
            // Filter dropdowns (include "All Styles")
            var filterIds = [
                'dash-style', 'snap-style', 'trend-style', 'setups-style',
                'timing-style', 'sym-style', 'risk-style', 'disc-style',
                'jnl-filter-style'
            ];
            for (var i = 0; i < filterIds.length; i++) {
                _populateStyleSelect(filterIds[i], true);
            }
            // Assignment dropdowns (no "All" option)
            _populateStyleSelect('ba-trading-style', false);
        }

        // Mounted once here, ahead of the first _populateStyleSelects(), so the
        // Style select exists to be filled and a saved period is never wiped.
        DenariiFilters.mountFilterBar(document.getElementById('dash-filter-bar'), {
            prefix: 'dash',
            onChange: function() { updateDashboard(); }
        });

        // Local database store names
        const STORE_NAME = 'journal';
        const AUTH_STORE  = 'auth';
        const SETTINGS_STORE = 'settings';

        // ── Schema versioning ────────────────────────────────────────────────
        // journalData.version tracks the schema of the persisted data blob.
        // When a future update needs to transform data (rename fields, change
        // structure, etc.), add an entry to SCHEMA_MIGRATIONS keyed by the
        // target version number. Each migration receives journalData, mutates
        // it in place, and returns true if it changed anything.
        const APP_VERSION = 'Denarii vB.004.000';
        const CURRENT_SCHEMA_VERSION = 2;
        const CURRENT_EXPORT_VERSION = 1;

        // ── Legal bundle ─────────────────────────────────────────────────────
        // LEGAL_BUNDLE_VERSION and LEGAL_BUNDLE are defined in js/legal-bundle.js
        // (loaded before this file's dependents). See that file for the full text.
        const SCHEMA_MIGRATIONS = {
            // v2: Recalculate P&L for option trades using 100x contract multiplier.
            // Prior versions calculated options the same as stocks (qty * price diff)
            // instead of (qty * price diff * 100).
            2: function migrateOptionPnl(data) {
                const trades = data.trades;
                if (!Array.isArray(trades) || trades.length === 0) return false;
                let changed = false;
                for (let i = 0; i < trades.length; i++) {
                    const t = trades[i];
                    try {
                        if (t.assetType !== 'option') continue;
                        if (t.entryPrice == null || t.exitPrice == null || t.quantity == null) continue;
                        var mult = _contractMultiplier(t.assetType);
                        var gross = t.type === 'long'
                            ? (t.exitPrice - t.entryPrice) * t.quantity * mult
                            : (t.entryPrice - t.exitPrice) * t.quantity * mult;
                        var newPnl = gross - (t.commissionFees || 0);
                        if (t.pnl !== newPnl) {
                            t.pnl = newPnl;
                            changed = true;
                        }
                    } catch (e) {
                        console.warn('[Migration v2] Skipped trade index ' + i + ':', e);
                    }
                }
                return changed;
            }
        };

        // Storage lives in a SQLite file in the Electron main process
        // (electron/db.js), reached through the preload's window.denariiStore.
        // Store names are the former IndexedDB object stores.
        async function storeGet(storeName, key) {
            return window.denariiStore.get(storeName, key);
        }

        async function storePut(storeName, value, key) {
            return window.denariiStore.put(storeName, key, value);
        }

        async function storeDelete(storeName, key) {
            return window.denariiStore.delete(storeName, key);
        }

        async function storeGetAllKeys(storeName) {
            return window.denariiStore.getAllKeys(storeName);
        }

        async function getSetting(key) {
            return storeGet(SETTINGS_STORE, key);
        }

        async function setSetting(key, value) {
            return storePut(SETTINGS_STORE, value, key);
        }

        // Import from JSON backup
        async function importFromJSON() {
            document.getElementById('json-input').click();
            
            document.getElementById('json-input').onchange = async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                
                const reader = new FileReader();
                reader.onload = async (event) => {
                    try {
                        const fileData = JSON.parse(event.target.result);

                        // ── Import version guards ────────────────────────────
                        // Reject backup files from a newer export format.
                        if (fileData.version && fileData.version > CURRENT_EXPORT_VERSION) {
                            alert('This backup was created by a newer version of Denarii (export format v' + fileData.version + ').\n\nPlease update Denarii before importing this file.');
                            return;
                        }

                        // Only exportBackup's encrypted files have a password.
                        // A plain JSON file's auth block is untrusted and ignored;
                        // the user creates a password for the new account instead.
                        const plainImport = fileData.encrypted !== true;
                        let password;
                        if (plainImport) {
                            password = await window.showPromptModal({ message: 'Create a password for this journal (at least 8 characters):', inputType: 'password' });
                            if (!password) return;
                            if (password.length < 8) {
                                alert('Password must be at least 8 characters.');
                                return;
                            }
                            const confirmPassword = await window.showPromptModal({ message: 'Confirm the password:', inputType: 'password' });
                            if (confirmPassword === null || confirmPassword === undefined) return;
                            if (confirmPassword !== password) {
                                alert('Passwords do not match.');
                                return;
                            }
                        } else {
                            password = await window.showPromptModal({ message: 'Enter the password for this backup:', inputType: 'password' });
                            if (!password) return;
                        }

                        let importedData;
                        let importDek = null;
                        if (!plainImport) {
                            // DEK export: unwrap DEK from export metadata, then decrypt with DEK
                            if (fileData.dekExport && DekCrypto.isWrapReadable(fileData.dekExport.wrappedDekByPassword, fileData.dekExport.dekPasswordSalt)) {
                                importDek = (await DekCrypto.unwrapDekAny(fileData.dekExport.wrappedDekByPassword, fileData.dekExport.dekPasswordSalt, password)).dek;
                                if (!importDek) {
                                    alert('Wrong password!');
                                    return;
                                }
                                var decrypted = decrypt(fileData.data, importDek);
                                if (!decrypted) {
                                    alert('Could not decrypt backup data.');
                                    return;
                                }
                                importedData = decrypted;
                            } else {
                                // Legacy export: decrypt with password directly
                                var decrypted = decrypt(fileData.data, password);
                                if (!decrypted) {
                                    alert('Wrong password!');
                                    return;
                                }
                                importedData = decrypted;
                            }
                        } else {
                            importedData = fileData;
                        }

                        // Reject journal data from a newer schema version.
                        if (importedData.version && importedData.version > CURRENT_SCHEMA_VERSION) {
                            alert('This backup contains data from a newer version of Denarii (schema v' + importedData.version + ').\n\nPlease update Denarii before importing this file.');
                            return;
                        }

                        // ── Phase 1 safety: snapshot + confirmation before import ──
                        await initDB();
                        if (currentAccountId) {
                            var _existingRecord = await getJournalRecord(currentAccountId);
                            if (_existingRecord && _existingRecord.data) {
                                var _tradeCount = 0;
                                try {
                                    var _peek = decrypt(_existingRecord.data, sessionDek || sessionPassword);
                                    if (_peek && Array.isArray(_peek.trades)) _tradeCount = _peek.trades.length;
                                } catch (_e) { /* best-effort count */ }

                                var _confirmMsg = 'Importing this backup will replace your current journal';
                                if (_tradeCount > 0) _confirmMsg += ' (' + _tradeCount + ' trade' + (_tradeCount !== 1 ? 's' : '') + ')';
                                _confirmMsg += '.\n\nA safety snapshot of your current data will be saved before replacing it.\n\nContinue with import?';
                                if (!confirm(_confirmMsg)) return;

                                await snapshotJournalRecord(currentAccountId, 'pre-import');
                            }
                        }

                        journalData = importedData;
                        sessionPassword = password;
                        sessionDek = importDek; // null for legacy imports, DEK hex for DEK imports

                        let authRecord = null;
                        if (fileData.auth && !plainImport) {
                            authRecord = { ...fileData.auth };
                            const incomingUsername = (authRecord.username || '').trim();
                            if (!incomingUsername) {
                                authRecord.username = (await window.showPromptModal({ message: 'Choose a username for this imported journal:' })) || 'trader';
                            }

                            // ── Account ID collision guard ──────────────────────
                            // If a local account already exists with the imported ID,
                            // assign a fresh ID so the existing account is not overwritten.
                            if (authRecord.id) {
                                var _idCollision = await getAuthRecordById(authRecord.id);
                                if (_idCollision) {
                                    authRecord.id = undefined; // saveAuthRecord will generate a new ID
                                }
                            }

                            const clash = await getAuthRecordByUsername(authRecord.username);
                            if (clash) {
                                // Username taken by a different account (or by the
                                // account whose ID we just cleared) — ask for a new one.
                                if (!authRecord.id || clash.id !== authRecord.id) {
                                    const replacement = await window.showPromptModal({ message: 'That username already exists on this device. Choose a different username for the imported journal:', defaultValue: authRecord.username + '-imported' });
                                    if (!replacement) return;
                                    authRecord.username = replacement;
                                }
                            }
                            authRecord = await saveAuthRecord(authRecord);
                        } else {
                            const suggestedUsername = (fileData.auth && typeof fileData.auth.username === 'string') ? fileData.auth.username.trim() : '';
                            const username = (await window.showPromptModal({ message: 'Choose a username for this journal:', defaultValue: suggestedUsername })) || 'trader';
                            const existing = await getAuthRecordByUsername(username);
                            if (existing) {
                                alert('That username already exists on this device. Please import again and choose a different username.');
                                return;
                            }
                            const recoveryKey = generateRecoveryKey();
                            const [passwordHash, recoveryHash] = await Promise.all([
                                DekCrypto.hashSecret(password),
                                DekCrypto.hashSecret(recoveryKey)
                            ]);

                            authRecord = await saveAuthRecord({
                                username,
                                passwordHash,
                                recoveryHash,
                                createdAt: new Date().toISOString()
                            });

                            alert('Data imported!\n\nYour recovery key is:\n' + recoveryKey + '\n\nSAVE THIS KEY! You need it to reset your password.');
                        }

                        currentAccountId = authRecord.id;
                        currentUsername = authRecord.username;
                        await setActiveAccount(authRecord.id);
                        await saveToIndexedDB();
                        // Legal acceptance gate — imported accounts may lack acceptance
                        const _importAuth = await getAuthRecordById(authRecord.id);
                        if (_importAuth && _importAuth.legalAcceptedVersion === LEGAL_BUNDLE_VERSION) {
                            unlockApp();
                        } else {
                            showLegalAcceptanceModal(_importAuth || authRecord, function () { unlockApp(); });
                        }
                    } catch (error) {
                        alert('Error importing file: ' + error.message);
                    }
                };
                reader.readAsText(file);
            };
        }

        // Export backup
        async function exportBackup() {
            var encKey = sessionDek || sessionPassword;
            if (!encKey || !currentAccountId) return;

            const encrypted = encrypt(journalData, encKey);

            let authData = null;
            try { authData = await getAuthRecord(); } catch(e) {}

            const fileData = {
                version: CURRENT_EXPORT_VERSION,
                encrypted: true,
                exportedAt: new Date().toISOString(),
                data: encrypted,
                auth: authData
            };

            // Include DEK wrapping metadata so import can reconstruct access
            // (v1 or v2 wrap as stored; a v2 wrap has no dekPasswordSalt)
            if (DekCrypto.hasPasswordWrap(authData)) {
                fileData.dekExport = { wrappedDekByPassword: authData.wrappedDekByPassword };
                if (authData.dekPasswordSalt) fileData.dekExport.dekPasswordSalt = authData.dekPasswordSalt;
            }
            
            const blob = new Blob([JSON.stringify(fileData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `denarii-backup-${(authData?.username || 'journal').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            
            await markLastBackup();
            
            alert('Backup exported!\n\nThe file is saved where you chose in the save dialog.');
            if (typeof _lockPending !== 'undefined' && _lockPending) {
                document.getElementById('export-modal').classList.remove('active');
                _completeLock();
                return;
            }
            closeExportModal();
        }

        // Records a completed backup (JSON export or .sqlite backup) on the
        // current account's journal record; the Lock reminder reads it.
        async function markLastBackup() {
            if (!currentAccountId) return;
            const data = await getJournalRecord(currentAccountId);
            if (data) {
                data.lastBackup = new Date().toISOString();
                await saveJournalRecord(currentAccountId, data);
                lastBackupTime = data.lastBackup;
                updateLastBackupDisplay();
            }
        }
        window.markLastBackup = markLastBackup;

        // Lock reminder's "Back up now": full .sqlite backup of all data.
        async function backupFromReminder() {
            if (!window.denariiStore) return;
            let r;
            try {
                r = await window.denariiStore.backupTo();
            } catch (e) {
                r = { ok: false, error: e.message || String(e) };
            }
            if (!r || r.cancelled) return; // stay on the reminder
            if (!r.ok) {
                alert('Backup failed: ' + (r.error || 'unknown error'));
                return;
            }
            await markLastBackup();
            alert('Backup saved to ' + r.path);
            closeExportModal();
        }

        function updateLastBackupDisplay() {
            if (lastBackupTime) {
                const date = new Date(lastBackupTime);
                document.getElementById('last-backup-time').textContent = date.toLocaleString();
            }
        }

        // Unlock app
        async function unlockApp() {
            // Account theme first, so the app renders in it (waits 1.5 s at most).
            try {
                if (typeof syncThemeOnSignIn === 'function') await syncThemeOnSignIn(await getAuthRecord());
            } catch(e) {}

            document.getElementById('login-screen').classList.add('hidden');
            document.getElementById('app-container').classList.add('active');

            // Set profile display from account + cache storage mode for
            // dashboard pagination branching (Phase 1 cloud-primary).
            try {
                const auth = await getAuthRecord();
                if (auth) {
                    updateSidebarProfile(auth);
                    window._denariiStorageMode = _resolveStorageMode(auth);
                    window._denariiSupabaseUid = auth.supabaseUid || null;
                    // Batch D2: no cloud baseline this session → bulk cloud writes stay paused.
                    if (typeof _ensureCloudSessionState === 'function') _ensureCloudSessionState();
                }
            } catch(e) {}

            // ── Pre-migration safety snapshot ─────────────────────────────────
            // Deep-copy journalData before any migration/backfill mutates it.
            // If anything throws, restore the snapshot so corrupted data is
            // never persisted over the user's good copy.
            const _preMigrationSnapshot = JSON.parse(JSON.stringify(journalData));

            try {

            let _migrationDirty = false;

            // ── Schema version gate ──────────────────────────────────────────
            // Initialize version if missing (pre-versioning accounts) and run
            // any registered schema migrations in order.
            if (!journalData.version) journalData.version = 1;
            if (journalData.version < CURRENT_SCHEMA_VERSION) {
                for (let v = journalData.version + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
                    if (typeof SCHEMA_MIGRATIONS[v] === 'function') {
                        SCHEMA_MIGRATIONS[v](journalData);
                    }
                }
                journalData.version = CURRENT_SCHEMA_VERSION;
                _migrationDirty = true;
            }

            // Strategy migration — must run before UI renders strategy lists/dropdowns.
            // Ensures demo strategies and any trade-referenced strategies exist as
            // canonical records, without touching any trade execution fields.
            if (!journalData.strategies) journalData.strategies = [];
            {
                const _s1 = ensureDemoStrategiesExist();
                const _s2 = backfillStrategiesFromExistingTrades(journalData.trades || []);
                // Backfill createdBy and isFavorite on strategies that don't have them
                let _s3 = false;
                (journalData.strategies || []).forEach(s => {
                    if (!s.createdBy) {
                        s.createdBy = s.isDemoSeed ? 'System' : (currentUsername || 'User');
                        _s3 = true;
                    }
                    if (s.isFavorite === undefined) {
                        s.isFavorite = true;
                        _s3 = true;
                    }
                });
                // Backfill isFavorite on tags that don't have it
                (journalData.tags || []).forEach(t => {
                    if (t.isFavorite === undefined) {
                        t.isFavorite = true;
                        _s3 = true;
                    }
                });
                if (_s1 || _s2 || _s3) _migrationDirty = true;
            }

            // Reviews store init
            if (!journalData.reviews) journalData.reviews = {};

            // Broker account migration and setup
            if (!journalData.brokerAccounts) journalData.brokerAccounts = [];
            if (window.migrateBrokerAccounts()) _migrationDirty = true;

            // Starter tag seeding — runs once per account (guarded by _starterTagsSeeded flag).
            // Safe for all accounts including Pelosi demo (dedup prevents duplicates).
            if (ensureStarterTags()) _migrationDirty = true;

            // Notes migration — combine legacy entryReason/exitReason/lessons into unified notes field.
            if (migrateNotesFields()) _migrationDirty = true;

            // Seed system note templates on first run.
            if (seedSystemTemplates()) _migrationDirty = true;

            // ── Demo import guard (Phase B + C) ────────────────────────────
            // Auto-seeding on every login is removed. Instead:
            //   - Existing users with Pelosi: flag version, keep data as-is
            //   - Existing users who deleted Pelosi: flag dismissed, do not re-import
            //   - Existing users with their own broker accounts: flag dismissed, never seed
            //   - Truly new accounts: one-time default import from DEMO_BUNDLE,
            //     and for cloud_primary only after this session loaded the cloud
            if (journalData._demoImportVersion === undefined && journalData._demoImportDismissed !== true) {
                var _demoBrokerId = (typeof DEMO_BROKER_ID !== 'undefined') ? DEMO_BROKER_ID : 'ba_demo_pelosi';
                var _hasDemoBroker = (journalData.brokerAccounts || []).some(function (a) {
                    return a.id === _demoBrokerId;
                });
                var _hasOwnBroker = (journalData.brokerAccounts || []).some(function (a) {
                    return a && a.id !== _demoBrokerId;
                });
                // cloud_primary: _cloudWriteAllowed() is _cloudBaselineReady && !_cloudPaused
                var _cloudLoaded = window._denariiStorageMode !== 'cloud_primary'
                    || (typeof _cloudWriteAllowed === 'function' && !!_cloudWriteAllowed());
                if (_hasDemoBroker) {
                    // Existing user with Pelosi — record version, keep data.
                    journalData._demoImportVersion = typeof DEMO_BROKER_DATA_VERSION !== 'undefined' ? DEMO_BROKER_DATA_VERSION : 6;
                    journalData._demoImportedAt = new Date().toISOString();
                    _migrationDirty = true;
                } else if (journalData._demoBrokerVersion) {
                    // Had Pelosi once but deleted it — mark dismissed.
                    journalData._demoImportDismissed = true;
                    _migrationDirty = true;
                } else if (_hasOwnBroker) {
                    // Existing user whose demo flags never reached this copy — not a new account.
                    journalData._demoImportDismissed = true;
                    _migrationDirty = true;
                } else if (!_cloudLoaded) {
                    // cloud_primary without a cloud load this session: the account may
                    // already exist in the cloud, so don't seed.
                    console.warn('[Denarii] Demo import skipped — cloud data not loaded this session.');
                } else if (!(journalData.trades && journalData.trades.length > 0)) {
                    // Truly new account: no demo flags, no demo broker, no trades.
                    // One-time default import from the static bundle (with legacy fallback).
                    var _demoImported = false;
                    if (typeof _importFromDemoBundle === 'function') {
                        _demoImported = _importFromDemoBundle(journalData);
                    }
                    if (!_demoImported && typeof seedDemoBroker === 'function') {
                        _demoImported = seedDemoBroker(journalData);
                        if (_demoImported) {
                            journalData._demoImportVersion = typeof DEMO_BROKER_DATA_VERSION !== 'undefined' ? DEMO_BROKER_DATA_VERSION : 6;
                            journalData._demoImportedAt = new Date().toISOString();
                        }
                    }
                    if (_demoImported) {
                        _migrationDirty = true;
                        // Batch D2: cloud_primary trades reach Supabase only through
                        // per-trade saves, so save the demo trades here. Logged on
                        // failure; never blocks unlock.
                        if (window._denariiStorageMode === 'cloud_primary' && typeof _saveTradesToSupabase === 'function') {
                            var _demoTrades = (journalData.trades || []).filter(function (t) { return t.brokerAccountId === _demoBrokerId; });
                            if (_demoTrades.length) {
                                _saveTradesToSupabase(_demoTrades).then(function (r) {
                                    if (!r || !r.success) { console.warn('[Denarii] Demo trades cloud save failed:', r && r.error); return; }
                                    console.log('[Denarii] Demo trades saved to cloud:', _demoTrades.length);
                                    // Batch D3: the cloud Dashboard may have loaded before
                                    // the upload finished; refetch so it shows the trades.
                                    if (typeof _triggerCloudDashRefresh === 'function') _triggerCloudDashRefresh();
                                    updateDashboard();
                                }, function (e) { console.warn('[Denarii] Demo trades cloud save error:', e.message || e); });
                            }
                        }
                    } else {
                        console.warn('[Denarii] New account demo import failed.');
                    }
                }
            }

            // ── DEK migration for legacy accounts ────────────────────────────
            // On first login after upgrade, re-encrypt journal with a new DEK
            // and store wrapped DEK fields on the auth record.
            if (!sessionDek && sessionPassword && typeof DekCrypto !== 'undefined') {
                try {
                    const _dekAuth = await getAuthRecord();
                    if (_dekAuth && !_dekAuth.dekVersion) {
                        const _dek = DekCrypto.generateDek();

                        _dekAuth.wrappedDekByPassword = await DekCrypto.wrapDekV2(_dek, sessionPassword);
                        delete _dekAuth.dekPasswordSalt;
                        _dekAuth.wrappedDekByRecovery = null; // set when recovery key is next provided
                        _dekAuth.dekRecoverySalt = null;
                        _dekAuth.dekVersion = 1;
                        await saveAuthRecord(_dekAuth);

                        sessionDek = _dek;
                        _migrationDirty = true; // journal will be re-encrypted with DEK by saveToIndexedDB
                        console.info('[Denarii] Legacy account migrated to DEK model.');
                    }
                } catch (_dekErr) {
                    // Non-fatal: leave account in legacy mode, clear sessionDek
                    console.warn('[Denarii] DEK migration skipped:', _dekErr.message || _dekErr);
                    sessionDek = null;
                }
            }

            // ── Single consolidated save ─────────────────────────────────────
            // All migrations mutate journalData in memory. Persist once at the
            // end so a failure mid-chain never leaves the local database partially migrated.
            if (_migrationDirty) await saveToIndexedDB();

            } catch (_migrationErr) {
                // ── Rollback: restore pre-migration data ─────────────────────
                console.error('[Denarii] Migration failed — rolling back:', _migrationErr);
                journalData = _preMigrationSnapshot;
                alert('A data update could not be applied safely. Your existing data has not been changed.\n\nPlease back up your data (Settings → Data → Back up all data) and try updating Denarii to the latest version.\n\nError: ' + (_migrationErr.message || _migrationErr));
            }

            // ── Phase 2A/2B: Blocking cloud migration for migration_pending ──
            // Shows a user-facing overlay during migration, writes to Supabase,
            // verifies, promotes to cloud_primary. On failure, hides overlay and
            // continues with IndexedDB-primary (no user impact).
            if (typeof _runCloudMigration === 'function') {
                try {
                    var _migAuth = await getAuthRecord();
                    if (_migAuth && _migAuth.storageMode === 'migration_pending') {
                        // ── Set migration-running gate ──
                        window._denariiMigrationRunning = true;

                        // Show migration overlay
                        var _migOverlay = document.getElementById('migration-overlay');
                        var _migStatus = document.getElementById('migration-status');
                        var _migBar = document.getElementById('migration-bar');
                        var _migTitle = document.getElementById('migration-title');
                        if (_migOverlay) _migOverlay.style.display = 'flex';

                        var _migResult = await _runCloudMigration(_migAuth, journalData, function (msg, pct) {
                            if (_migStatus) _migStatus.textContent = msg;
                            if (_migBar && typeof pct === 'number') _migBar.style.width = Math.max(pct, 5) + '%';
                        });

                        // ── Clear migration-running gate ──
                        window._denariiMigrationRunning = false;

                        if (_migResult) {
                            // Success — update cached storage mode so cloud
                            // Dashboard pagination activates in this session
                            window._denariiStorageMode = 'cloud_primary';
                            // Batch D2: the migration just wrote and verified every
                            // domain, so this data is the cloud baseline.
                            if (typeof _setCloudBaseline === 'function') _setCloudBaseline(journalData, true);
                            // Success — show brief success message then hide
                            if (_migTitle) _migTitle.textContent = 'Account upgrade complete.';
                            if (_migStatus) _migStatus.textContent = 'Your data is now synced to cloud.';
                            if (_migBar) _migBar.style.width = '100%';
                            console.log('[Denarii] Cloud migration completed successfully.');
                            await new Promise(function (r) { setTimeout(r, 1800); });
                        } else {
                            // Failure — show failure message then continue
                            if (_migTitle) _migTitle.textContent = 'Cloud sync could not complete.';
                            if (_migStatus) _migStatus.textContent = 'Your data is safe locally. We\u2019ll try again next time you sign in.';
                            if (_migBar) { _migBar.style.width = '100%'; _migBar.style.background = 'var(--warning)'; }
                            console.warn('[Denarii] Cloud migration did not complete. Continuing with local data.');
                            await new Promise(function (r) { setTimeout(r, 2500); });
                        }

                        // Hide overlay
                        if (_migOverlay) _migOverlay.style.display = 'none';
                        if (_migBar) _migBar.style.background = '';

                        // ── Flush any saves that were deferred during migration ──
                        if (typeof _migrationSavePending !== 'undefined' && _migrationSavePending) {
                            _migrationSavePending = false;
                            console.log('[Denarii] Flushing deferred save after migration.');
                            await saveToIndexedDB();
                        }
                    }
                } catch (_migErr) {
                    window._denariiMigrationRunning = false;
                    console.warn('[Denarii] Cloud migration error (non-fatal):', _migErr.message || _migErr);
                    var _migOvErr = document.getElementById('migration-overlay');
                    if (_migOvErr) _migOvErr.style.display = 'none';
                    // Flush deferred save on error too
                    if (typeof _migrationSavePending !== 'undefined' && _migrationSavePending) {
                        _migrationSavePending = false;
                        console.log('[Denarii] Flushing deferred save after migration error.');
                        await saveToIndexedDB();
                    }
                }
            }

            // ── Post-migration UI rendering ──────────────────────────────────
            // These read from journalData (either fully migrated or snapshot-
            // restored) but do not mutate it. Kept outside the try block so a
            // rendering error cannot trigger a data rollback.
            updateStrategiesList();
            updateStrategyDropdown();
            window.populateBrokerAccountDropdowns();
            window.renderBrokerAccountsList();
            _populateStyleSelects();
            await _loadDashColPrefs();

            updateDashboard();

            // Apply preferred dashboard view on initial load
            if (_dashViewPrefsLoaded && typeof switchDashView === 'function') {
                var _initView = _dashRememberLastView ? _dashLastView : _dashDefaultView;
                if (_initView && _initView !== 'trades') {
                    switchDashView(_initView);
                }
            }

            updateLastBackupDisplay();
            if (typeof _showCloudLoadBanner === 'function') _showCloudLoadBanner();
            // Pause cloud writes if the Supabase session ends while unlocked (once per page).
            if (typeof _watchCloudSession === 'function') _watchCloudSession();
            if (typeof DenAriiAI !== 'undefined') await DenAriiAI.loadApiKey();

            // Populate version label in Settings sidebar
            const _verEl = document.getElementById('settings-version-label');
            if (_verEl) {
                _verEl.textContent = APP_VERSION;
                // Desktop app: package.json version from main.
                if (window.denariiApp && window.denariiApp.getInfo) {
                    window.denariiApp.getInfo().then(function (info) {
                        if (info && info.version) _verEl.textContent = 'Denarii v' + info.version;
                    }).catch(function () { /* keep APP_VERSION */ });
                }
            }

            // Webull (local): apply batches from main for this account; Lock stops it.
            if (typeof WebullSync !== 'undefined' && WebullSync.startBatchHandler) WebullSync.startBatchHandler(currentAccountId);

            // ── Phase 3: Non-blocking backfill after UI render ──────────────
            // Skip if Phase 2A migration already promoted to cloud_primary
            // (the migration runner already wrote and verified all domains).
            setTimeout(async function () {
                if (typeof _startBackfillIfNeeded === 'function') {
                    var _bfAuth = await getAuthRecord();
                    if (_bfAuth && _bfAuth.storageMode === 'cloud_primary') {
                        console.log('[Denarii] Skipping Phase 3 backfill — account is cloud_primary.');
                        return;
                    }
                    _startBackfillIfNeeded(journalData);
                }
            }, 3000);
        }

        // Batch D3: redraw after a cloud re-sync or a resolved conflict
        // replaced journalData. Pages not on screen redraw when opened.
        window._denariiRefreshUI = async function () {
            try {
                updateStrategiesList();
                updateStrategyDropdown();
                window.populateBrokerAccountDropdowns();
                window.renderBrokerAccountsList();
                _populateStyleSelects();
                await _loadDashColPrefs();
                if (typeof window._invalidateCloudDash === 'function') window._invalidateCloudDash();
                updateDashboard();
            } catch (e) {
                console.warn('[Denarii] Refresh after cloud change failed:', e.message || e);
            }
        };

        function closeExportModal() {
            document.getElementById('export-modal').classList.remove('active');
            if (typeof _lockPending !== 'undefined' && _lockPending) {
                _completeLock();
                return;
            }
            // Phase 1 safety: outside of lock flow, do not reload — just refresh display.
            updateLastBackupDisplay();
        }

        // ========== STRATEGY MANAGEMENT ==========

        let currentStrategyGroups = [];
        let editingStrategyId = null;
        let _seSelectedGroupId = null;

        function showAddStrategyModal() {
            editingStrategyId = null;
            currentStrategyGroups = [];
            _seSelectedGroupId = null;
            document.getElementById('strategy-editor-title').textContent = 'New Strategy';
            document.getElementById('edit-strategy-id').value = '';
            document.getElementById('strategy-name').value = '';
            document.getElementById('strategy-description').value = '';
            selectedStrategyColor = '#3b82f6';
            document.querySelectorAll('#strategy-editor .color-btn').forEach(btn => {
                btn.classList.toggle('selected', btn.dataset.color === '#3b82f6');
            });
            document.getElementById('se-meta-info').style.display = 'none';
            activateSection('strategy-editor');
            _seRenderAll();
        }

        function editStrategy(id) {
            const strategy = journalData.strategies.find(s => String(s.id) === String(id));
            if (!strategy) return;
            if (strategy.isDemoSeed || strategy.createdBy === 'System') {
                alert('System strategies are read-only originals. Use Duplicate to create your own editable copy.');
                return;
            }

            editingStrategyId = id;
            document.getElementById('strategy-editor-title').textContent = 'Edit Strategy';
            document.getElementById('edit-strategy-id').value = id;
            document.getElementById('strategy-name').value = strategy.name;
            document.getElementById('strategy-description').value = strategy.description || '';
            selectedStrategyColor = strategy.color;

            document.querySelectorAll('#strategy-editor .color-btn').forEach(btn => {
                btn.classList.remove('selected');
                if (btn.dataset.color === strategy.color) {
                    btn.classList.add('selected');
                }
            });

            // Show created-by metadata in edit mode
            const metaEl = document.getElementById('se-meta-info');
            const createdByEl = document.getElementById('se-created-by');
            if (metaEl && createdByEl) {
                createdByEl.textContent = strategy.createdBy || 'User';
                metaEl.style.display = '';
            }

            currentStrategyGroups = JSON.parse(JSON.stringify(strategy.groups || []));
            _seSelectedGroupId = currentStrategyGroups.length ? currentStrategyGroups[0].id : null;
            activateSection('strategy-editor');
            _seRenderAll();
            _seGuardOpen(id);
        }

        // Batch 2: re-sync guard for the open strategy. A re-sync that
        // replaces it reloads a clean form; Save while it is stale keeps this
        // version as a conflict copy and loads the newer one instead.
        function _seFormSig() {
            return JSON.stringify([document.getElementById('strategy-name').value,
                document.getElementById('strategy-description').value, selectedStrategyColor, currentStrategyGroups]);
        }

        function _seStaleSave(id) {
            const stored = (journalData.strategies || []).find(s => String(s.id) === String(id)) || { id: id };
            _editorGuardConflict('strategy-editor', Object.assign({}, stored, {
                name: document.getElementById('strategy-name').value,
                description: document.getElementById('strategy-description').value,
                color: selectedStrategyColor,
                groups: JSON.parse(JSON.stringify(currentStrategyGroups))
            }));
            editStrategy(id);
        }

        function _seGuardOpen(id) {
            if (typeof _editorGuardOpen !== 'function') return;
            const openSig = _seFormSig();
            _editorGuardOpen('strategy-editor', 'strategies', String(id), {
                isOpen: () => String(editingStrategyId) === String(id) &&
                    !!document.getElementById('strategy-editor')?.classList.contains('active'),
                isDirty: () => _seFormSig() !== openSig,
                reload: () => editStrategy(id),
                resolve: () => _seStaleSave(id)
            });
        }

        function closeStrategyEditor() {
            if (typeof _editorGuardClose === 'function') _editorGuardClose('strategy-editor');
            document.getElementById('strategy-form').reset();
            selectedStrategyColor = '#3b82f6';
            currentStrategyGroups = [];
            editingStrategyId = null;
            _seSelectedGroupId = null;
            activateSection('strategies');
        }

        // Backward compat alias
        function closeStrategyModal() { closeStrategyEditor(); }

        // ========== RULE CHECKLIST FOR TRADES ==========

        // The old Edit Trade page was removed in Batch C2. Any old caller
        // opens the same trade on Trade Reflection.
        function openEditTradePage(tradeId) { openTradeInReflection(tradeId); }

        // Open Trade Reflection with locked fields unlocked and exit
        // fields focused, so the user can close an open trade.
        function openCloseTrade(tradeId) {
            activateSection('trade-journal');
            selectTradeForJournal(tradeId);
            // Auto-unlock so exit fields are editable immediately
            var unlockBtn = document.getElementById('jnl-unlock-btn');
            if (unlockBtn) unlockBtn.click();
            // Focus exit price for quick entry
            setTimeout(function () {
                var ep = document.getElementById('jnl-exit-price');
                if (ep) ep.focus();
            }, 100);
        }

        // Open one trade on the Trade Reflection page (dashboard row click
        // and the row menu's Edit / Edit / Reflect).
        function openTradeInReflection(tradeId) {
            activateSection('trade-journal');
            selectTradeForJournal(tradeId);
        }

        // Row click opens the trade, except on the checkbox and the ⋮ menu cell.
        function _dashRowClick(evt, tradeId) {
            var target = evt && evt.target;
            if (target && target.closest && target.closest('input, .dt-actions-cell')) return;
            openTradeInReflection(tradeId);
        }

        // Puts a trade back to an earlier copy in place, so references held by
        // the open editor and dashboard rows stay valid.
        function _restoreTradeInPlace(trade, before) {
            Object.keys(trade).forEach(function(k) { delete trade[k]; });
            Object.assign(trade, before);
        }

        // Rounds a trade in place before it is saved: money to cents, prices
        // to 4 decimals, on the trade and its fills (WebullSync.roundTrade,
        // the rule Webull imports use). null stays null, so open trades keep
        // pnl null. If rounding is unavailable the trade saves as is.
        function _roundTradeForSave(trade) {
            if (!trade || typeof WebullSync === 'undefined' || typeof WebullSync.roundTrade !== 'function') return trade;
            try { Object.assign(trade, WebullSync.roundTrade(trade)); } catch (e) { /* save unrounded */ }
            return trade;
        }

        // ========== RULE CHECKLIST FOR TRADES ==========

        function loadStrategyRules(strategyName) {
            if (!strategyName) {
                document.getElementById('strategy-rules-checklist').style.display = 'none';
                selectedStrategyForTrade = null;
                followedRules = [];
                return;
            }

            const strategy = journalData.strategies.find(s => s.name === strategyName);
            if (!strategy || !strategy.groups) {
                document.getElementById('strategy-rules-checklist').style.display = 'none';
                return;
            }

            selectedStrategyForTrade = strategy;
            followedRules = [];
            
            const allRules = strategy.groups.flatMap(g => 
                g.rules.map(r => ({ ...r, groupName: g.name }))
            );

            // For new trades, show only "Always" rules (we don't know outcome yet)
            const applicableRules = allRules.filter(r => r.showWhen === 'always');

            const rulesList = document.getElementById('rules-list');
            rulesList.innerHTML = applicableRules.map(rule => {
                const isMandatory = rule.isMandatory || false;
                const starDisplay = isMandatory ? '★★★★★★' : getStarDisplay(rule.stars);
                const isNote = rule.stars === 0;

                return `
                    <div class="rule-checklist-item ${isNote ? 'note' : ''}">
                        <input type="checkbox"
                               id="rule-${rule.id}"
                               onchange="updateRuleScore()"
                               ${isNote ? 'data-note="true"' : ''}>
                        <label for="rule-${rule.id}">
                            ${rule.text}
                            ${isNote ? ' <em>(note only)</em>' : ''}
                            ${isMandatory ? ' <strong>(MANDATORY)</strong>' : ''}
                            ${!isNote ? ` <span class="rule-stars">${starDisplay}</span>` : ''}
                        </label>
                    </div>
                `;
            }).join('');

            document.getElementById('strategy-rules-checklist').style.display = 'block';
            updateRuleScore();
        }

        function updateRuleScore() {
            if (!selectedStrategyForTrade) return;

            const allRules = selectedStrategyForTrade.groups.flatMap(g => g.rules);
            const applicableRules = allRules.filter(r => r.showWhen === 'always'); // For new trades
            const scoredRules = applicableRules.filter(r => r.stars > 0);
            const mandatoryRules = scoredRules.filter(r => r.isMandatory);
            
            followedRules = [];
            let actualScore = 0;
            let allMandatoryFollowed = true;

            scoredRules.forEach(rule => {
                const checkbox = document.getElementById(`rule-${rule.id}`);
                if (checkbox && checkbox.checked) {
                    followedRules.push(rule.id);
                    actualScore += _effectiveStars(rule);
                } else if (rule.isMandatory) {
                    allMandatoryFollowed = false;
                }
            });

            const maxScore = scoredRules.reduce((sum, r) => sum + _effectiveStars(r), 0);
            const percentage = maxScore > 0 ? (actualScore / maxScore * 100) : 0;
            const grade = calculateGradeWithMandatory(percentage, allMandatoryFollowed);

            document.getElementById('strategy-score').innerHTML = `
                <span class="grade-badge grade-${grade.class}">${grade.letter}</span>
                <span style="margin-left: 8px; color: var(--text-secondary);">
                    ${actualScore}/${maxScore} points (${percentage.toFixed(0)}%)
                </span>
                ${!allMandatoryFollowed ? '<br><span style="color: var(--danger); font-size: 12px;">Mandatory rule(s) not followed</span>' : ''}
            `;
        }

        function calculateGradeWithMandatory(percentage, allMandatoryFollowed) {
            let grade = { letter: 'F', class: 'f' };
            
            if (allMandatoryFollowed) {
                // Eligible for A/A+
                if (percentage >= 100) grade = { letter: 'A+', class: 'a-plus' };
                else if (percentage >= 90) grade = { letter: 'A', class: 'a' };
                else if (percentage >= 80) grade = { letter: 'B', class: 'b' };
                else if (percentage >= 70) grade = { letter: 'C', class: 'c' };
                else if (percentage >= 60) grade = { letter: 'D', class: 'd' };
            } else {
                // Capped at B because mandatory rule(s) failed
                if (percentage >= 80) grade = { letter: 'B', class: 'b' };
                else if (percentage >= 70) grade = { letter: 'C', class: 'c' };
                else if (percentage >= 60) grade = { letter: 'D', class: 'd' };
            }
            
            return grade;
        }

        function calculateGrade(percentage) {
            if (percentage >= 100) return { letter: 'A+', class: 'a-plus' };
            if (percentage >= 90) return { letter: 'A', class: 'a' };
            if (percentage >= 80) return { letter: 'B', class: 'b' };
            if (percentage >= 70) return { letter: 'C', class: 'c' };
            if (percentage >= 60) return { letter: 'D', class: 'd' };
            return { letter: 'F', class: 'f' };
        }

        // Calculate strategy score based on trade outcome (winner/loser/breakeven)
        function calculateStrategyScore(strategy, followedRuleIds, tradePnL) {
            const tradeOutcome = tradePnL > 0 ? 'winner' : tradePnL < 0 ? 'loser' : 'breakeven';
            
            // Get all rules and filter by outcome
            const allRules = strategy.groups.flatMap(g => g.rules);
            const applicableRules = allRules.filter(r => 
                r.showWhen === 'always' || r.showWhen === tradeOutcome
            );
            const scoredRules = applicableRules.filter(r => r.stars > 0);
            const mandatoryRules = scoredRules.filter(r => r.isMandatory);
            
            // Calculate max score from applicable rules (mandatory rules are worth 6 = stored 5 + 1 bonus)
            const maxScore = scoredRules.reduce((sum, r) => sum + _effectiveStars(r), 0);

            // Calculate actual score
            let actualScore = 0;
            let allMandatoryFollowed = true;

            scoredRules.forEach(rule => {
                if (followedRuleIds.includes(rule.id)) {
                    actualScore += _effectiveStars(rule);
                } else if (rule.isMandatory) {
                    allMandatoryFollowed = false;
                    // missed mandatory earns 0 — no subtraction penalty
                }
            });
            
            const percentage = maxScore > 0 ? (actualScore / maxScore * 100) : 0;
            const grade = calculateGradeWithMandatory(percentage, allMandatoryFollowed);
            
            return {
                strategyId: strategy.id,
                strategyName: strategy.name,
                followedRules: [...followedRuleIds],
                actualScore,
                maxScore,
                percentage,
                grade: grade.letter,
                allMandatoryFollowed
            };
        }

        function selectStrategyColor(color) {
            selectedStrategyColor = color;
            document.querySelectorAll('#strategy-editor .color-btn').forEach(btn => {
                btn.classList.remove('selected');
                if (btn.dataset.color === color) {
                    btn.classList.add('selected');
                }
            });
        }

        function addRuleGroup() {
            const groupId = Date.now();
            currentStrategyGroups.push({
                id: groupId,
                name: '',
                rules: []
            });
            _seSelectedGroupId = groupId;
            _seRenderAll();
        }

        function removeRuleGroup(groupId) {
            currentStrategyGroups = currentStrategyGroups.filter(g => g.id !== groupId);
            if (_seSelectedGroupId === groupId) {
                _seSelectedGroupId = currentStrategyGroups.length ? currentStrategyGroups[0].id : null;
            }
            _seRenderAll();
        }

        function addRule(groupId) {
            const group = currentStrategyGroups.find(g => g.id === groupId);
            if (!group) return;

            group.rules.push({
                id: Date.now(),
                text: '',
                isMandatory: false,
                stars: 3,
                showWhen: 'always'
            });
            _seRenderAll();
        }

        function removeRule(groupId, ruleId) {
            const group = currentStrategyGroups.find(g => g.id === groupId);
            if (!group) return;

            group.rules = group.rules.filter(r => r.id !== ruleId);
            _seRenderAll();
        }

        function updateGroupName(groupId, name) {
            const group = currentStrategyGroups.find(g => g.id === groupId);
            if (group) { group.name = name; _seRenderGroupList(); _seRenderPreview(); }
        }

        function updateRuleText(groupId, ruleId, text) {
            const group = currentStrategyGroups.find(g => g.id === groupId);
            if (!group) return;
            const rule = group.rules.find(r => r.id === ruleId);
            if (rule) { rule.text = text; _seRenderPreview(); }
        }

        function updateRuleMandatory(groupId, ruleId, isMandatory) {
            const group = currentStrategyGroups.find(g => g.id === groupId);
            if (!group) return;
            const rule = group.rules.find(r => r.id === ruleId);
            if (rule) {
                rule.isMandatory = isMandatory;
                if (isMandatory) rule.stars = 5;
                _seRenderAll();
            }
        }

        function updateRuleStars(groupId, ruleId, stars) {
            const group = currentStrategyGroups.find(g => g.id === groupId);
            if (!group) return;
            const rule = group.rules.find(r => r.id === ruleId);
            if (rule) rule.stars = stars;
            _seRenderAll();
        }

        function updateRuleShowWhen(groupId, ruleId, showWhen) {
            const group = currentStrategyGroups.find(g => g.id === groupId);
            if (!group) return;
            const rule = group.rules.find(r => r.id === ruleId);
            if (rule) { rule.showWhen = showWhen; _seRenderPreview(); }
        }

        function getStarDisplay(stars) {
            if (stars === 0) return 'Note';
            return '★'.repeat(stars);
        }

        // Mandatory rules are stored with stars=5 and carry a +1 bonus → effective value 6
        function _effectiveStars(rule) {
            return (rule.isMandatory && rule.stars > 0) ? rule.stars + 1 : rule.stars;
        }

        /**
         * Render strategy rules grouped by rule-group into a target element.
         * Shared by the Trade Journal (Reflection) checklists.
         * @param {Object}   strategy      - strategy object with groups/rules
         * @param {string}   outcome       - 'winner' | 'loser' | 'breakeven'
         * @param {number[]} followedRules - array of followed rule IDs
         * @param {string}   idPrefix      - DOM id prefix ('edit-rule-', 'jnl-rule-')
         * @param {string}   onchangeFn    - global function name to call on checkbox change
         * @returns {string} HTML string
         */
        function renderGroupedChecklist(strategy, outcome, followedRules, idPrefix, onchangeFn) {
            var html = '';
            strategy.groups.forEach(function(group) {
                var rules = (group.rules || []).filter(function(r) {
                    return r.showWhen === 'always' || r.showWhen === outcome;
                });
                if (!rules.length) return;
                html += '<div class="rule-checklist-group">';
                html += '<div class="rule-checklist-group-header">' + escapeHtml(group.name || 'Rules') + '</div>';
                rules.forEach(function(rule) {
                    var isMandatory = rule.isMandatory || false;
                    var starDisplay = isMandatory ? '★★★★★★' : getStarDisplay(rule.stars);
                    var isNote = rule.stars === 0;
                    var isChecked = followedRules.includes(rule.id);
                    html += '<div class="rule-checklist-item' + (isNote ? ' note' : '') + '">' +
                        '<input type="checkbox" id="' + idPrefix + rule.id + '" onchange="' + onchangeFn + '()"' +
                        (isChecked ? ' checked' : '') + (isNote ? ' data-note="true"' : '') + '>' +
                        '<label for="' + idPrefix + rule.id + '">' +
                            escapeHtml(rule.text) +
                            (isNote ? ' <em>(note only)</em>' : '') +
                            (isMandatory ? ' <strong>(MANDATORY)</strong>' : '') +
                            (!isNote ? ' <span class="rule-stars">' + starDisplay + '</span>' : '') +
                        '</label></div>';
                });
                html += '</div>';
            });
            return html;
        }

        // ── Strategy Editor: two-panel rendering ─────────────────

        function _seSelectGroup(id) {
            _seSelectedGroupId = id;
            _seRenderGroupList();
            _seRenderGroupEditor();
        }

        function _seRenderAll() {
            _seRenderGroupList();
            _seRenderGroupEditor();
            _seRenderPreview();
        }

        function _seRenderGroupList() {
            const el = document.getElementById('se-group-list');
            if (!el) return;
            if (!currentStrategyGroups.length) {
                el.innerHTML = '<div class="se-gl-empty">No rule groups yet.</div>';
                return;
            }
            el.innerHTML = currentStrategyGroups.map(g => {
                const active = g.id === _seSelectedGroupId ? ' active' : '';
                const name = g.name || '<em>Untitled group</em>';
                const count = g.rules ? g.rules.length : 0;
                return `<div class="se-gl-item${active}" onclick="_seSelectGroup(${g.id})">
                    <span class="se-gl-icon">&#9776;</span>
                    <span class="se-gl-name">${name}</span>
                    <span class="se-gl-count">${count} rule${count !== 1 ? 's' : ''}</span>
                </div>`;
            }).join('');
        }

        function _seRenderGroupEditor() {
            const el = document.getElementById('se-group-editor');
            if (!el) return;
            const group = currentStrategyGroups.find(g => g.id === _seSelectedGroupId);
            if (!group) {
                el.innerHTML = '<div class="se-ge-none">Select a group to edit, or add a new one.</div>';
                return;
            }

            const rulesHtml = group.rules.map(rule => {
                const gid = group.id, rid = rule.id;
                const isMandatory = rule.isMandatory || false;
                const stars = rule.stars || 0;

                let ratingHtml;
                if (isMandatory) {
                    ratingHtml = `<span class="se-rule-mandatory-badge">mandatory</span>
                        <span style="color:#f59e0b;font-size:14px;letter-spacing:0.5px;">★★★★★★</span>`;
                } else {
                    ratingHtml = `<button type="button" class="se-rule-star-note ${stars === 0 ? 'active' : ''}" onclick="updateRuleStars(${gid},${rid},0)">Note</button>` +
                        [1,2,3,4,5].map(n =>
                            `<button type="button" class="se-rule-star ${stars >= n ? 'filled' : ''}" onclick="updateRuleStars(${gid},${rid},${n})">★</button>`
                        ).join('');
                }

                return `<div class="se-rule">
                    <div class="se-rule-primary">
                        <input type="text" placeholder="E.g., Stock gapped up >5% with volume"
                               value="${(rule.text || '').replace(/"/g, '&quot;')}"
                               onchange="updateRuleText(${gid},${rid},this.value)">
                    </div>
                    <div class="se-rule-secondary">
                        <span class="se-rule-ctrl">
                            <label><input type="checkbox" ${isMandatory ? 'checked' : ''} onchange="updateRuleMandatory(${gid},${rid},this.checked)"> Mandatory</label>
                        </span>
                        <span class="se-rule-ctrl se-rule-stars">${ratingHtml}</span>
                        <span class="se-rule-ctrl">
                            <select onchange="updateRuleShowWhen(${gid},${rid},this.value)">
                                <option value="always" ${rule.showWhen === 'always' ? 'selected' : ''}>Always</option>
                                <option value="winner" ${rule.showWhen === 'winner' ? 'selected' : ''}>Winner</option>
                                <option value="loser" ${rule.showWhen === 'loser' ? 'selected' : ''}>Loser</option>
                                <option value="breakeven" ${rule.showWhen === 'breakeven' ? 'selected' : ''}>Break Even</option>
                            </select>
                        </span>
                        <button type="button" class="se-rule-del" title="Delete rule" onclick="removeRule(${gid},${rid})">&#10005;</button>
                    </div>
                </div>`;
            }).join('');

            el.innerHTML = `
                <div class="se-ge-head">
                    <input type="text" placeholder="Group name (e.g., Entry Criteria)"
                           value="${(group.name || '').replace(/"/g, '&quot;')}"
                           onchange="updateGroupName(${group.id}, this.value)">
                    <div class="se-ge-actions">
                        <button type="button" class="btn btn-small btn-secondary" onclick="removeRuleGroup(${group.id})">Remove</button>
                    </div>
                </div>
                ${rulesHtml}
                <button type="button" class="btn btn-small btn-secondary se-rule-add" onclick="addRule(${group.id})">+ Add Rule</button>
            `;
        }

        function _seRenderPreview() {
            const el = document.getElementById('se-preview-body');
            if (!el) return;
            if (!currentStrategyGroups.length) {
                el.innerHTML = '<div class="se-pv-empty">Add rule groups to see a preview of your strategy.</div>';
                return;
            }
            el.innerHTML = currentStrategyGroups.map(g => {
                const groupName = g.name || 'Untitled Group';
                const ruleCount = g.rules ? g.rules.length : 0;
                const rulesHtml = ruleCount ? g.rules.map(r => {
                    const text = r.text || '';
                    const isMandatory = r.isMandatory || false;
                    const stars = r.stars || 0;
                    const showWhen = r.showWhen || 'always';

                    // Inline badges: mandatory + stars/note + showWhen
                    let inlineParts = [];
                    if (isMandatory) inlineParts.push('<span class="se-pv-tag se-pv-tag-mandatory">Mandatory</span>');
                    if (stars > 0) inlineParts.push(`<span class="se-pv-stars">${'★'.repeat(isMandatory ? 6 : stars)}</span>`);
                    else inlineParts.push('<span class="se-pv-tag">Note</span>');
                    const swLabels = { always: 'Always', winner: 'Winners', loser: 'Losers', breakeven: 'Break Even' };
                    inlineParts.push(`<span class="se-pv-tag se-pv-tag-showwhen">${swLabels[showWhen] || showWhen}</span>`);

                    return `<div class="se-pv-rule">
                        <span class="se-pv-bullet${isMandatory ? ' mandatory' : ''}"></span>
                        <div class="se-pv-rule-body">
                            <div class="se-pv-rule-row">
                                <span class="se-pv-rule-text${text ? '' : ' empty'}">${text ? escapeHtml(text) : 'Empty rule'}</span>
                                <span class="se-pv-inline-meta">${inlineParts.join('')}</span>
                            </div>
                        </div>
                    </div>`;
                }).join('') : '<div class="se-pv-no-rules">No rules in this group</div>';

                return `<div class="se-pv-group">
                    <div class="se-pv-group-name">
                        ${escapeHtml(groupName)}
                        <span class="se-pv-group-badge">${ruleCount} rule${ruleCount !== 1 ? 's' : ''}</span>
                    </div>
                    ${rulesHtml}
                </div>`;
            }).join('');
        }

        // Legacy compat — old callers can still invoke renderRuleGroups()
        function renderRuleGroups() { _seRenderAll(); }

        document.getElementById('strategy-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();

            // Batch 2: changed on another device while open → conflict copy, reload.
            if (editingStrategyId && typeof _editorGuardStale === 'function' &&
                _editorGuardStale('strategy-editor', String(editingStrategyId)) === true) {
                _seStaleSave(editingStrategyId);
                return;
            }

            // ── Unique name check ──
            const enteredName = document.getElementById('strategy-name').value;
            const savedName = editingStrategyId ? (journalData.strategies || []).find(s => String(s.id) === String(editingStrategyId))?.name : null;
            const rawName = enteredName === savedName ? enteredName : enteredName.trim();
            if (!rawName) {
                alert('Please enter a strategy name.');
                return;
            }
            const normName = normalizeStrategyName(rawName).toLowerCase();
            if (normName === DenariiFilters.NO_STRATEGY) {
                alert('This name is reserved. Please choose a different name.');
                return;
            }
            const conflict =(journalData.strategies || []).some(s => {
                if (editingStrategyId && String(s.id) === String(editingStrategyId)) return false;
                return normalizeStrategyName(s.name).toLowerCase() === normName;
            });
            if (conflict) {
                alert('A strategy with this name already exists. Please choose a unique name.');
                return;
            }

            const strategyId = editingStrategyId || Date.now();
            const existingStrat = editingStrategyId ? journalData.strategies.find(s => String(s.id) === String(editingStrategyId)) : null;
            const strategy = {
                ...(existingStrat || {}),
                id: strategyId,
                name: rawName,
                description: document.getElementById('strategy-description').value,
                color: selectedStrategyColor,
                groups: currentStrategyGroups.filter(g => g.name && g.rules.some(r => r.text)),
                created: existingStrat ? existingStrat.created : new Date().toISOString(),
                updated: new Date().toISOString(),
                createdBy: existingStrat ? (existingStrat.createdBy || currentUsername || 'User') : (currentUsername || 'User'),
                isFavorite: existingStrat ? (existingStrat.isFavorite !== false) : true
            };

            if (existingStrat && existingStrat.name !== rawName) {
                await _renameStrategyFlow(existingStrat, strategy);
                return;
            }
            if (!existingStrat) DenariiFilters.forgetStrategyRename(rawName);
            if (!existingStrat && _clearDeletedStrategyName(rawName) && typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                await _saveDeletedStrategyKeysToSupabase();
            }

            if (!journalData.strategies) journalData.strategies = [];
            
            if (editingStrategyId) {
                const index = journalData.strategies.findIndex(s => String(s.id) === String(editingStrategyId));
                if (index !== -1) {
                    journalData.strategies[index] = strategy;
                } else {
                    // Deleted on another device: the save keeps it (D3), so list it here too.
                    journalData.strategies.push(strategy);
                }
            } else {
                journalData.strategies.push(strategy);
            }
            
            const wasEdit = !!editingStrategyId;
            if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                var _csRes = await _saveStrategyToSupabase(strategy);
                if (!_csRes.success) console.warn('[CloudSave] Strategy save failed, falling back to cache.');
            }
            await saveToIndexedDB();
            closeStrategyEditor();
            updateStrategiesList();
            updateStrategyDropdown();
        });

        // ── Strategy rename ─────────────────────────────────────────────────────

        // Save stays disabled and re-syncs wait until the rename has finished.
        async function _renameStrategyFlow(existing, updated) {
            if (window._denariiStrategyRenameRunning) return false;
            window._denariiStrategyRenameRunning = true;
            const saveBtn = document.querySelector('#strategy-form button[type="submit"]');
            if (saveBtn) saveBtn.disabled = true;
            try {
                return await _runStrategyRename(existing, updated);
            } finally {
                window._denariiStrategyRenameRunning = false;
                if (saveBtn) saveBtn.disabled = false;
            }
        }

        // journalData stays untouched until the cloud trades have moved, so the
        // backfill and background saves never see a half-finished rename.
        async function _runStrategyRename(existing, updated) {
            const oldName = existing.name;
            const newName = updated.name;
            if (existing.isDemoSeed || existing.createdBy === 'System') {
                alert('System strategies are read-only originals. Use Duplicate to create your own editable copy.');
                return false;
            }

            const trades = journalData.trades || [];
            const newKey = normalizeStrategyName(newName).toLowerCase();
            const oldNorm = normalizeStrategyName(oldName);
            const others = trades.filter(t => t.setupType && t.setupType !== oldName);
            if (others.some(t => normalizeStrategyName(t.setupType).toLowerCase() === newKey)) {
                alert('Some trades already use this name. Please choose a unique name.');
                return false;
            }
            const variants = others.filter(t => normalizeStrategyName(t.setupType) === oldNorm).length;

            const cloud = window._denariiStorageMode === 'cloud_primary';
            let count = trades.length - trades.filter(t => t.setupType !== oldName).length;
            if (cloud) {
                const pre = await _cloudRenamePreflight(existing, newName);
                if (!pre.ok) {
                    alert(pre.message);
                    return false;
                }
                count = pre.count;
            }

            let question = 'Rename "' + oldName + '" to "' + newName + '"?\n\n' +
                count + (count === 1 ? ' trade' : ' trades') + ' will be updated.';
            if (variants > 0) {
                question += '\n\n' + variants + (variants === 1 ? ' trade' : ' trades') +
                    ' with different spacing won\'t be updated and will show as a separate strategy.';
            }
            if (!confirm(question)) return false;

            if (cloud) {
                const moved = await _cloudMoveStrategyTrades(existing.id, oldName, newName);
                if (!moved.ok) {
                    alert(moved.message);
                    return false;
                }
            }

            const changes = _applyStrategyNameToLocal(oldName, newName);
            const index = journalData.strategies.findIndex(s => String(s.id) === String(existing.id));
            journalData.strategies[index] = updated;

            let finishing = false;
            if (cloud) {
                const res = await _saveStrategyToSupabase(updated);
                if (res.conflicts) {
                    // The cloud's strategy is already back in journalData.
                    const reversed = await _cloudReverseStrategyRename(existing.id, oldName, newName);
                    _revertStrategyNameOnLocal(changes, oldName);
                    await saveToIndexedDB();
                    updateStrategiesList();
                    updateStrategyDropdown();
                    _triggerCloudDashRefresh();
                    alert(reversed
                        ? 'This strategy was changed on another device, so it was not renamed. Reload the page and try again.'
                        : 'This strategy was changed on another device, so it was not renamed. Your trades will be put back at your next sign-in.');
                    return false;
                }
                await _saveRenamedReports(changes.reports);
                if (res.success) await _clearStrategyRenameMarker();
                else finishing = true;
            }

            const wasDeleted = _clearDeletedStrategyName(newName);
            if (cloud && wasDeleted) await _saveDeletedStrategyKeysToSupabase();
            await saveToIndexedDB();
            if (!cloud && _journalDirty) {
                _revertStrategyNameOnLocal(changes, oldName);
                journalData.strategies[index] = existing;
                if (wasDeleted) _noteDeletedStrategyName(newName);
                alert('Couldn\'t save the rename. Nothing was changed.');
                return false;
            }

            DenariiFilters.noteStrategyRename(oldName, newName);
            closeStrategyEditor();
            _refreshAfterStrategyRename(oldName);
            if (finishing) alert('Strategy renamed. The new name will finish syncing to your cloud data when the connection returns.');
            return true;
        }

        function _refreshAfterStrategyRename(oldName) {
            updateStrategiesList();
            updateStrategyDropdown();
            document.querySelectorAll('select[id$="-strategy"]').forEach(sel => {
                if (sel.value === oldName) DenariiFilters.populateStrategy(sel, journalData.trades, journalData.strategies);
            });
            if (typeof _triggerCloudDashRefresh === 'function') _triggerCloudDashRefresh();
            updateDashboard();
        }

        // ── Strategy delete ─────────────────────────────────────────────────────

        // Names the backfill must not recreate from leftover trades.
        function _noteDeletedStrategyName(name) {
            const key = normalizeStrategyName(name).toLowerCase();
            const keys = journalData._deletedStrategyKeys || [];
            if (keys.indexOf(key) !== -1) return false;
            journalData._deletedStrategyKeys = keys.concat(key);
            return true;
        }

        function _clearDeletedStrategyName(name) {
            const key = normalizeStrategyName(name).toLowerCase();
            const keys = journalData._deletedStrategyKeys || [];
            if (keys.indexOf(key) === -1) return false;
            journalData._deletedStrategyKeys = keys.filter(k => k !== key);
            return true;
        }

        // A System name comes back with the seed list.
        function _strategyDeleteBlocked(strategy) {
            const key = normalizeStrategyName(strategy.name).toLowerCase();
            return getDemoStrategySeedList().some(s => normalizeStrategyName(s.name).toLowerCase() === key);
        }

        // Resolves true on Delete. Falls back to confirm() on a page without the modal.
        function _strategyDeleteDialog(message, note) {
            const modal = document.getElementById('strategy-delete-modal');
            if (!modal) return Promise.resolve(confirm(message + (note ? '\n\n' + note : '')));
            document.getElementById('strategy-delete-message').textContent = message;
            const noteEl = document.getElementById('strategy-delete-note');
            noteEl.textContent = note;
            noteEl.style.display = note ? '' : 'none';
            return new Promise(resolve => {
                const finish = answer => {
                    modal.removeEventListener('mousedown', outside);
                    closeModal('strategy-delete-modal');
                    resolve(answer);
                };
                const outside = e => { if (e.target === modal) finish(false); };
                modal.addEventListener('mousedown', outside);
                document.getElementById('strategy-delete-cancel').onclick = () => finish(false);
                document.getElementById('strategy-delete-confirm').onclick = () => finish(true);
                openModal('strategy-delete-modal');
            });
        }

        // Re-syncs wait until the delete has finished or been cancelled.
        async function _deleteStrategyFlow(strategy) {
            if (window._denariiStrategyRenameRunning) return false;
            window._denariiStrategyRenameRunning = true;
            try {
                return await _runStrategyDelete(strategy);
            } finally {
                window._denariiStrategyRenameRunning = false;
            }
        }

        // journalData stays untouched until the cloud trades have moved.
        async function _runStrategyDelete(strategy) {
            const name = strategy.name;
            if (strategy.isDemoSeed || strategy.createdBy === 'System' || _strategyDeleteBlocked(strategy)) {
                alert('"' + name + '" is a System strategy or shares its name with one, so it can\'t be deleted. You can remove it from favorites instead.');
                return false;
            }

            const trades = journalData.trades || [];
            const norm = normalizeStrategyName(name);
            const variants = trades.filter(t => t.setupType && t.setupType !== name && normalizeStrategyName(t.setupType) === norm).length;
            const note = variants > 0
                ? variants + (variants === 1 ? ' trade' : ' trades') + ' with different spacing won\'t be changed and will keep that name.'
                : '';

            const cloud = window._denariiStorageMode === 'cloud_primary';
            let count = trades.filter(t => t.setupType === name).length;
            if (cloud) {
                const pre = await _cloudDeletePreflight(strategy);
                if (!pre.ok) {
                    alert(pre.message);
                    return false;
                }
                count = pre.count;
            }

            const confirmed = count > 0
                ? await _strategyDeleteDialog((count === 1
                    ? '1 trade uses this strategy. It will move to No Strategy.'
                    : count + ' trades use this strategy. They will move to No Strategy.') + ' This can\'t be undone.', note)
                : confirm('Delete "' + name + '"?' + (note ? '\n\n' + note : ''));
            if (!confirmed) return false;

            if (cloud) {
                // The dialog may have been open a while: the checks must still hold.
                const again = await _cloudDeletePreflight(strategy);
                if (!again.ok) {
                    alert(again.message);
                    return false;
                }
                if (again.count !== count) {
                    alert('The number of trades using this strategy changed. Nothing was changed. Please try again.');
                    return false;
                }
                const cleared = await _cloudClearStrategyTrades(strategy.id, name, count);
                if (!cleared.ok) {
                    alert(cleared.message);
                    return false;
                }
            }

            const changes = _applyStrategyDeleteToLocal(strategy.id, name);

            let message = '';
            if (cloud) {
                const res = await _deleteStrategyFromSupabase(strategy.id);
                if (res.kept) {
                    _clearDeletedStrategyName(name);
                    message = 'This strategy was changed on another device, so it was kept.' +
                        (count > 0 ? ' Its trades have already moved to No Strategy.' : '');
                }
                await _saveDeletedStrategyKeysToSupabase();
                if (res.success) await _clearStrategyDeleteMarker();
                else message = 'Strategy deleted. It will finish syncing to your cloud data at your next sign-in.';
            }

            await saveToIndexedDB();
            if (!cloud && _journalDirty) {
                _revertStrategyDeleteOnLocal(changes, name);
                alert('Couldn\'t delete this strategy. Nothing was changed.');
                return false;
            }

            DenariiFilters.noteStrategyDeleted(name);
            _refreshAfterStrategyRename(name);
            if (message) alert(message);
            return true;
        }

        // ── Strategy migration helpers ──────────────────────────────────────────

        /**
         * Return a normalised strategy name for comparison/dedup.
         * Trims whitespace and collapses internal runs of spaces.
         * Returns '' for null/undefined/empty input.
         */
        function normalizeStrategyName(name) {
            if (!name || typeof name !== 'string') return '';
            return name.trim().replace(/\s+/g, ' ');
        }

        /** Read the canonical editable strategy store. Always returns an array. */
        function getCanonicalStrategies() {
            return Array.isArray(journalData.strategies) ? journalData.strategies : [];
        }

        /** Persist the canonical strategy store. */
        function saveCanonicalStrategies(strategies) {
            journalData.strategies = Array.isArray(strategies) ? strategies : [];
        }

        /**
         * The fixed list of strategy records that must exist when demo data is present.
         * IDs are in the 1000001–1000013 range — well below any Date.now()-based user ID.
         */
        function getDemoStrategySeedList() {
            // Helpers for compact rule definitions
            var _si = 0; // strategy index counter
            function _r(id, text, mandatory, stars, showWhen) {
                return { id: id, text: text, isMandatory: !!mandatory, stars: stars, showWhen: showWhen || 'always' };
            }
            function _g(si, gi, name, rules) { return { id: si * 100 + gi, name: name, rules: rules }; }
            function _strat(name, color, groups) {
                _si++;
                return {
                    id: 1000000 + _si, name: name, description: '', color: color,
                    groups: groups, created: '2024-07-01T09:30:00.000Z', updated: '2024-07-01T09:30:00.000Z',
                    isDemoSeed: true, createdBy: 'System', isFavorite: true,
                    ruleVersion: 1
                };
            }
            _si = 0;
            return [
                // 1: Support Bounce (id 1000001)
                _strat('Support Bounce', '#3b82f6', [
                    _g(1,1,'Market Context', [
                        _r(10101,'Bounce is occurring at a clear support level',true,3),
                        _r(10102,'Support aligns with higher timeframe level or prior key level',false,2),
                        _r(10103,'Market is not aggressively trending against the setup',false,2)
                    ]),
                    _g(1,2,'Entry Criteria', [
                        _r(10201,'Price shows clear rejection at support',true,3),
                        _r(10202,'Buyers step in with confirmation candle / reclaim',true,3),
                        _r(10203,'Entry is close enough to support to keep risk tight',true,3),
                        _r(10204,'Volume improves on the bounce',false,2)
                    ]),
                    _g(1,3,'Risk / Invalidation', [
                        _r(10301,'Stop is below support / rejection low',true,3),
                        _r(10302,'Trade is avoided if support has already been tested too many times',false,2)
                    ]),
                    _g(1,4,'Management / Exit', [
                        _r(10401,'Take partial into first resistance / VWAP / EMA reclaim',false,2,'winner'),
                        _r(10402,'Exit quickly if support breaks after entry',true,3,'loser'),
                        _r(10403,'Let runner work only if reclaim holds cleanly',false,2)
                    ])
                ]),
                // 2: VWAP Reclaim (id 1000002)
                _strat('VWAP Reclaim', '#10b981', [
                    _g(2,1,'Market Context', [
                        _r(20101,'VWAP is acting as a meaningful intraday pivot',true,3),
                        _r(20102,'Price has spent time below VWAP before reclaim attempt',false,2),
                        _r(20103,'Setup has space to next resistance after reclaim',false,2)
                    ]),
                    _g(2,2,'Entry Criteria', [
                        _r(20201,'Price reclaims VWAP with conviction',true,3),
                        _r(20202,'Candle closes or confirms above VWAP',true,3),
                        _r(20203,'Volume supports reclaim',true,2),
                        _r(20204,'Entry is not too extended above VWAP',true,3)
                    ]),
                    _g(2,3,'Risk / Invalidation', [
                        _r(20301,'Stop is below VWAP or reclaim candle low',true,3),
                        _r(20302,'Avoid if reclaim happens into major resistance overhead',false,2)
                    ]),
                    _g(2,4,'Management / Exit', [
                        _r(20401,'Partial at first push away from VWAP',false,2,'winner'),
                        _r(20402,'Exit if price loses VWAP again',true,3,'loser'),
                        _r(20403,'Hold only while VWAP stays supportive',false,2)
                    ])
                ]),
                // 3: Trend Continuation (id 1000003)
                _strat('Trend Continuation', '#f59e0b', [
                    _g(3,1,'Market Context', [
                        _r(30101,'Trend is already established before entry',true,3),
                        _r(30102,'Higher timeframe supports trend direction',false,2),
                        _r(30103,'No major opposing resistance/support is too close',false,2)
                    ]),
                    _g(3,2,'Entry Criteria', [
                        _r(30201,'Pullback or consolidation forms within the trend',true,3),
                        _r(30202,'Entry occurs on continuation break/reclaim',true,3),
                        _r(30203,'Trend EMAs / structure remain intact',true,3),
                        _r(30204,'Volume confirms continuation',false,2)
                    ]),
                    _g(3,3,'Risk / Invalidation', [
                        _r(30301,'Stop is below pullback low / above pullback high depending direction',true,3),
                        _r(30302,'Avoid if continuation entry is too extended',true,2)
                    ]),
                    _g(3,4,'Management / Exit', [
                        _r(30401,'Partial into next expansion leg',false,2,'winner'),
                        _r(30402,'Exit if trend structure breaks',true,3,'loser'),
                        _r(30403,'Hold runner while higher lows / lower highs continue',false,2)
                    ])
                ]),
                // 4: Reversal (id 1000004)
                _strat('Reversal', '#ef4444', [
                    _g(4,1,'Market Context', [
                        _r(40101,'Setup is occurring at an obvious exhaustion or key level',true,3),
                        _r(40102,'Price is extended into the reversal area',false,2),
                        _r(40103,'There is room for the reversal move back the other way',true,2)
                    ]),
                    _g(4,2,'Entry Criteria', [
                        _r(40201,'Reversal candle or reclaim/break confirms turn',true,3),
                        _r(40202,'Entry waits for confirmation, not blind guessing',true,3),
                        _r(40203,'Volume or momentum shifts in favor of reversal',false,2)
                    ]),
                    _g(4,3,'Risk / Invalidation', [
                        _r(40301,'Stop is beyond the extreme high/low of reversal zone',true,3),
                        _r(40302,'Avoid if trying to reverse a very strong trend with no signal',true,3)
                    ]),
                    _g(4,4,'Management / Exit', [
                        _r(40401,'Take first partial into nearest reclaim area',false,2,'winner'),
                        _r(40402,'Exit fast if reversal confirmation fails',true,3,'loser'),
                        _r(40403,'Be quicker with profits than in continuation setups',false,2)
                    ])
                ]),
                // 5: Earnings Play (id 1000005)
                _strat('Earnings Play', '#8b5cf6', [
                    _g(5,1,'Market Context', [
                        _r(50101,'Earnings catalyst is the reason for the move',true,3),
                        _r(50102,'Stock has elevated volume/liquidity',true,3),
                        _r(50103,'Spread and options/liquidity are acceptable if trading options',true,3),
                        _r(50104,'Daily chart has clean post-earnings space',false,2)
                    ]),
                    _g(5,2,'Entry Criteria', [
                        _r(50201,'Entry follows clear post-earnings structure, not random volatility',true,3),
                        _r(50202,'Direction is confirmed by price action, not headline bias',true,3),
                        _r(50203,'Entry is on breakout, reclaim, or pullback with structure',true,3)
                    ]),
                    _g(5,3,'Risk / Invalidation', [
                        _r(50301,'Risk is reduced because of elevated volatility',true,3),
                        _r(50302,'Avoid oversized position due to event volatility',true,3),
                        _r(50303,'Stop is based on structure, not hope',true,3)
                    ]),
                    _g(5,4,'Management / Exit', [
                        _r(50401,'Take profits faster than usual if move becomes unstable',false,2),
                        _r(50402,'Exit if post-earnings trend loses structure',true,3,'loser'),
                        _r(50403,'Do not overstay once the first clean move is done',false,2)
                    ])
                ]),
                // 6: Failed Breakout (id 1000006)
                _strat('Failed Breakout', '#ec4899', [
                    _g(6,1,'Market Context', [
                        _r(60101,'Price attempts breakout through a clear level',true,3),
                        _r(60102,'Breakout level is meaningful on chart',true,3),
                        _r(60103,'Move is extended enough to trap late entries',false,2)
                    ]),
                    _g(6,2,'Entry Criteria', [
                        _r(60201,'Breakout fails and price comes back below the level',true,3),
                        _r(60202,'Reclaim failure is confirmed, not just one wick',true,3),
                        _r(60203,'Entry is close to the failed level for tight risk',true,3),
                        _r(60204,'Volume fades or rejection volume appears',false,2)
                    ]),
                    _g(6,3,'Risk / Invalidation', [
                        _r(60301,'Stop is above failed breakout high / reclaim area',true,3),
                        _r(60302,'Avoid if price immediately reclaims breakout level again',true,3)
                    ]),
                    _g(6,4,'Management / Exit', [
                        _r(60401,'Partial into first flush away from the level',false,2,'winner'),
                        _r(60402,'Exit if failed breakout thesis is invalidated by reclaim',true,3,'loser'),
                        _r(60403,'Hold remainder only if lower highs continue',false,2)
                    ])
                ]),
                // 7: Double Bottom (id 1000007)
                _strat('Double Bottom', '#3b82f6', [
                    _g(7,1,'Market Context', [
                        _r(70101,'Second test occurs near prior low',true,3),
                        _r(70102,'Support area is clear and meaningful',true,3),
                        _r(70103,'There is room back toward resistance / neckline',false,2)
                    ]),
                    _g(7,2,'Entry Criteria', [
                        _r(70201,'Second bottom holds without breaking down',true,3),
                        _r(70202,'Entry is on reclaim / neckline break / confirmation candle',true,3),
                        _r(70203,'Buyers show clear defense on retest',false,2)
                    ]),
                    _g(7,3,'Risk / Invalidation', [
                        _r(70301,'Stop is below the double bottom low / support zone',true,3),
                        _r(70302,'Avoid if second bottom is too sloppy or undercuts too deeply',false,2)
                    ]),
                    _g(7,4,'Management / Exit', [
                        _r(70401,'Partial into neckline / first resistance',false,2,'winner'),
                        _r(70402,'Exit if support fails after entry',true,3,'loser'),
                        _r(70403,'Hold only if breakout from neckline confirms',false,2)
                    ])
                ]),
                // 8: Gap Fill (id 1000008)
                _strat('Gap Fill', '#10b981', [
                    _g(8,1,'Market Context', [
                        _r(80101,'There is a clear gap to fill from prior session',true,3),
                        _r(80102,'Price has realistic room to reach fill target',true,2),
                        _r(80103,'Market conditions support mean reversion or continuation toward fill',false,2)
                    ]),
                    _g(8,2,'Entry Criteria', [
                        _r(80201,'Entry aligns with direction of the expected fill',true,3),
                        _r(80202,'Price structure confirms move toward gap fill',true,3),
                        _r(80203,'Entry is not taken too close to full fill target',true,2)
                    ]),
                    _g(8,3,'Risk / Invalidation', [
                        _r(80301,'Stop is based on structure opposing the fill thesis',true,3),
                        _r(80302,'Avoid chasing after most of the fill is already done',true,2)
                    ]),
                    _g(8,4,'Management / Exit', [
                        _r(80401,'Partial before full gap fill if momentum stalls',false,2,'winner'),
                        _r(80402,'Exit if structure breaks against fill thesis',true,3,'loser'),
                        _r(80403,'Reduce size as fill target gets close',false,1)
                    ])
                ]),
                // 9: Pullback to EMA (id 1000009)
                _strat('Pullback to EMA', '#f59e0b', [
                    _g(9,1,'Market Context', [
                        _r(90101,'Stock is trending cleanly before pullback',true,3),
                        _r(90102,'EMA being used is acting as dynamic support/resistance',true,3),
                        _r(90103,'Higher timeframe still supports direction',false,2)
                    ]),
                    _g(9,2,'Entry Criteria', [
                        _r(90201,'Price pulls back into EMA, not far through it',true,3),
                        _r(90202,'EMA holds and price confirms continuation',true,3),
                        _r(90203,'Entry is near EMA for favorable risk',true,3),
                        _r(90204,'Volume or candle quality supports bounce/reject',false,2)
                    ]),
                    _g(9,3,'Risk / Invalidation', [
                        _r(90301,'Stop is beyond EMA rejection low/high or local structure',true,3),
                        _r(90302,'Avoid if EMA has already failed multiple times',false,2)
                    ]),
                    _g(9,4,'Management / Exit', [
                        _r(90401,'Partial on push back into trend expansion',false,2,'winner'),
                        _r(90402,'Exit if EMA loses its role and trend breaks',true,3,'loser'),
                        _r(90403,'Hold runner only while trend remains clean',false,2)
                    ])
                ]),
                // 10: Opening Range Break (id 1000010)
                _strat('Opening Range Break', '#ef4444', [
                    _g(10,1,'Market Context', [
                        _r(100101,'Opening range is clearly defined',true,3),
                        _r(100102,'Market/open conditions are active enough for ORB',true,2),
                        _r(100103,'Break has room beyond the range',true,2)
                    ]),
                    _g(10,2,'Entry Criteria', [
                        _r(100201,'Price breaks opening range high/low with confirmation',true,3),
                        _r(100202,'Volume expands on the break',true,3),
                        _r(100203,'Entry is not badly extended beyond the range',true,3),
                        _r(100204,'Break aligns with overall intraday direction',false,2)
                    ]),
                    _g(10,3,'Risk / Invalidation', [
                        _r(100301,'Stop is on the opposite side of the break structure or inside range',true,3),
                        _r(100302,'Avoid breakout if range is already too wide for acceptable risk',false,2)
                    ]),
                    _g(10,4,'Management / Exit', [
                        _r(100401,'Partial on first range expansion move',false,2,'winner'),
                        _r(100402,'Exit if price falls back into range and fails',true,3,'loser'),
                        _r(100403,'Hold only while price stays outside the range',false,2)
                    ])
                ]),
                // 11: Breakout (id 1000011)
                _strat('Breakout', '#8b5cf6', [
                    _g(11,1,'Market Context', [
                        _r(110101,'Breakout level is clear and meaningful',true,3),
                        _r(110102,'Stock has room above the breakout',true,3),
                        _r(110103,'Consolidation/build-up exists before the break',false,2)
                    ]),
                    _g(11,2,'Entry Criteria', [
                        _r(110201,'Price breaks key level with confirmation',true,3),
                        _r(110202,'Volume confirms breakout',true,3),
                        _r(110203,'Entry is not too extended from breakout level',true,3),
                        _r(110204,'Breakout occurs from a tight base / clean structure',false,2)
                    ]),
                    _g(11,3,'Risk / Invalidation', [
                        _r(110301,'Stop is below breakout level / base low',true,3),
                        _r(110302,'Avoid if breakout immediately stalls into resistance',false,2)
                    ]),
                    _g(11,4,'Management / Exit', [
                        _r(110401,'Partial into first expansion',false,2,'winner'),
                        _r(110402,'Exit if breakout fails and re-enters base',true,3,'loser'),
                        _r(110403,'Hold remainder only if breakout level holds on retest',false,2)
                    ])
                ]),
                // 12: Gap N Go (id 1000012)
                _strat('Gap N Go', '#ec4899', [
                    _g(12,1,'Market Context', [
                        _r(120101,'Stock has meaningful gap up from prior close',true,3),
                        _r(120102,'Pre-market volume is elevated / active',true,3),
                        _r(120103,'Pre-market structure is clean, not chaotic',false,2),
                        _r(120104,'Daily chart has room above / no nearby major resistance',false,2)
                    ]),
                    _g(12,2,'Entry Criteria', [
                        _r(120201,'Price breaks pre-market high with intent',true,3),
                        _r(120202,'Break occurs near open with strong momentum',true,3),
                        _r(120203,'Volume expands on the break',true,3),
                        _r(120204,'Entry is not badly extended from the break level',true,3)
                    ]),
                    _g(12,3,'Risk / Invalidation', [
                        _r(120301,'Risk is defined before entry',true,3),
                        _r(120302,'Stop is below valid intraday structure / PMH reclaim level',true,3),
                        _r(120303,'Avoid entry if candle is too extended after breakout',false,2)
                    ]),
                    _g(12,4,'Management / Exit', [
                        _r(120401,'Partial into first expansion',false,2,'winner'),
                        _r(120402,'Exit if PMH breakout fails quickly',true,3,'loser'),
                        _r(120403,'Hold remainder only while momentum and volume stay intact',false,2)
                    ])
                ]),
                // 13: Bull Flag (id 1000013)
                _strat('Bull Flag', '#3b82f6', [
                    _g(13,1,'Market Context', [
                        _r(130101,'Strong impulse leg exists before the flag',true,3),
                        _r(130102,'Flag is orderly, not choppy breakdown',true,3),
                        _r(130103,'Trend context supports continuation',true,2)
                    ]),
                    _g(13,2,'Entry Criteria', [
                        _r(130201,'Entry is on flag break or clean reclaim from flag support',true,3),
                        _r(130202,'Volume contracts in flag and expands on break',false,2),
                        _r(130203,'Entry is near the flag break, not extended',true,3)
                    ]),
                    _g(13,3,'Risk / Invalidation', [
                        _r(130301,'Stop is below flag low / structure low',true,3),
                        _r(130302,'Avoid if flag loses structure or turns into deeper pullback',true,2)
                    ]),
                    _g(13,4,'Management / Exit', [
                        _r(130401,'Partial on first measured push',false,2,'winner'),
                        _r(130402,'Exit if flag fails and loses support',true,3,'loser'),
                        _r(130403,'Hold runner only if continuation remains clean',false,2)
                    ])
                ])
            ];
        }

        /**
         * Guarantee System strategy records exist in the canonical store for ALL users.
         * Adds missing System strategies and patches existing ones that have empty rule groups.
         * Returns true if the store was modified.
         */
        function ensureDemoStrategiesExist() {
            const seedList  = getDemoStrategySeedList();
            const canonical = getCanonicalStrategies();
            const existingMap = {};
            canonical.forEach(s => { existingMap[normalizeStrategyName(s.name)] = s; });
            const deleted = journalData._deletedSystemStrategyKeys || [];

            let changed = false;

            // Add missing System strategies; previously-deleted ones are restored as unfavorited
            const toAdd = seedList.filter(s => {
                var norm = normalizeStrategyName(s.name);
                if (existingMap[norm]) return false;
                return true;
            });
            toAdd.forEach(s => {
                var norm = normalizeStrategyName(s.name);
                if (deleted.indexOf(norm.toLowerCase()) !== -1) {
                    s.isFavorite = false; // was previously deleted — restore as hidden
                }
            });
            if (toAdd.length > 0) {
                canonical.push(...toAdd);
                changed = true;
                console.log('[Denarii] ensureSystemStrategies: added', toAdd.length, 'missing');
            }

            // Patch existing System strategies whose rules are empty or older
            // than the bundled version. User-owned strategies are skipped.
            seedList.forEach(seed => {
                const norm = normalizeStrategyName(seed.name);
                const existing = existingMap[norm];
                if (!existing || !existing.isDemoSeed) return;
                var needsPatch = !existing.groups || existing.groups.length === 0 ||
                    (seed.ruleVersion && (!existing.ruleVersion || existing.ruleVersion < seed.ruleVersion));
                if (needsPatch) {
                    existing.groups = JSON.parse(JSON.stringify(seed.groups));
                    existing.ruleVersion = seed.ruleVersion || 1;
                    existing.updated = new Date().toISOString();
                    changed = true;
                    console.log('[Denarii] ensureSystemStrategies: updated rules for', seed.name, 'to v' + (seed.ruleVersion || 1));
                }
            });

            if (changed) saveCanonicalStrategies(canonical);
            return changed;
        }

        /**
         * Add canonical strategy records for any trade setupType that does not yet
         * have a corresponding record.  Repairs existing saved data without touching
         * any trade execution field.
         * Returns true if the store was modified.
         */
        function backfillStrategiesFromExistingTrades(trades) {
            if (!Array.isArray(trades) || trades.length === 0) return false;

            const canonical = getCanonicalStrategies();
            const existing  = new Set(canonical.map(s => normalizeStrategyName(s.name)));
            const deleted   = new Set(journalData._deletedStrategyKeys || []);
            const COLORS    = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
            const toAdd     = [];
            const seen      = new Set();
            const idBase    = Date.now();

            trades.forEach(t => {
                const raw  = t.setupType;
                if (!raw || typeof raw !== 'string') return;
                const norm = normalizeStrategyName(raw);
                if (!norm || existing.has(norm) || seen.has(norm) || deleted.has(norm.toLowerCase())) return;
                seen.add(norm);
                toAdd.push({
                    id:          idBase + toAdd.length,
                    name:        raw.trim(),
                    description: '',
                    color:       COLORS[toAdd.length % COLORS.length],
                    groups:      [],
                    created:     new Date().toISOString(),
                    updated:     new Date().toISOString(),
                    createdBy:   currentUsername || 'User',
                    isFavorite:  true,
                });
            });

            if (toAdd.length === 0) return false;

            saveCanonicalStrategies(canonical.concat(toAdd));
            console.log('[Denarii] backfillStrategiesFromExistingTrades: added', toAdd.length, 'strategies');
            return true;
        }

        /**
         * Return all canonical strategies sorted alphabetically.
         * Use this as the primary source for filter dropdowns.
         */
        function getStrategyFilterOptions() {
            return getCanonicalStrategies()
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name));
        }

        /**
         * Resilience fallback: merge canonical strategies with any strategy names
         * inferred from trade data that are not yet in the store.
         * Use only as a last resort — canonical store is the source of truth.
         */
        function getSafeStrategyOptionsFallback(trades, strategies) {
            const canonical = Array.isArray(strategies) ? strategies : [];
            const normSet   = new Set(canonical.map(s => normalizeStrategyName(s.name)));
            const extra     = [];
            const seen      = new Set();
            (trades || []).forEach(t => {
                const raw  = t.setupType;
                if (!raw) return;
                const norm = normalizeStrategyName(raw);
                if (!norm || normSet.has(norm) || seen.has(norm)) return;
                seen.add(norm);
                extra.push({ id: 'fb-' + norm, name: raw.trim(), color: '#64748b', groups: [] });
            });
            return canonical.concat(extra);
        }

        // ── End strategy migration helpers ──────────────────────────────────────

        function toggleStrategyFavorite(id) {
            const s = (journalData.strategies || []).find(s => String(s.id) === String(id));
            if (!s) return;
            s.isFavorite = !s.isFavorite;
            if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                _saveStrategyToSupabase(s);
            }
            saveToIndexedDB();
            updateStrategiesList();
            updateStrategyDropdown();
        }

        function deleteStrategy(id) {
            const strat = (journalData.strategies || []).find(s => String(s.id) === String(id));
            if (!strat) return;
            var isSystem = strat.isDemoSeed || strat.createdBy === 'System';

            // System strategies cannot be deleted — toggle favorite instead
            if (isSystem) {
                if (strat.isFavorite === false) {
                    strat.isFavorite = true;
                } else {
                    if (!confirm('Hide this system strategy from selection? You can re-favorite it later.')) return;
                    strat.isFavorite = false;
                }
                if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                    _saveStrategyToSupabase(strat);
                }
                saveToIndexedDB();
                updateStrategiesList();
                updateStrategyDropdown();
                return;
            }

            return _deleteStrategyFlow(strat);
        }

        function duplicateStrategy(id) {
            const original = (journalData.strategies || []).find(s => String(s.id) === String(id));
            if (!original) return;

            // Build a unique name: "Name (Copy)", "Name (Copy 2)", etc.
            // Uses normalized case-insensitive comparison to avoid collisions.
            const existingNorms = new Set((journalData.strategies || []).map(s => normalizeStrategyName(s.name).toLowerCase()));
            let copyName = original.name + ' (Copy)';
            let n = 2;
            while (existingNorms.has(normalizeStrategyName(copyName).toLowerCase())) {
                copyName = original.name + ' (Copy ' + n + ')';
                n++;
            }

            // Deep-clone groups and regenerate all nested IDs so the
            // duplicate never shares group/rule IDs with the source.
            const clonedGroups = JSON.parse(JSON.stringify(original.groups || []));
            let idOffset = 0;
            clonedGroups.forEach(group => {
                group.id = Date.now() + (++idOffset);
                (group.rules || []).forEach(rule => {
                    rule.id = Date.now() + (++idOffset);
                });
            });

            const copy = {
                id:          Date.now(),
                name:        copyName,
                description: original.description || '',
                color:       original.color || '#3b82f6',
                groups:      clonedGroups,
                created:     new Date().toISOString(),
                updated:     new Date().toISOString(),
                createdBy:   currentUsername || 'User',
                isFavorite:  true
            };

            if (!journalData.strategies) journalData.strategies = [];
            journalData.strategies.push(copy);
            if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                _saveStrategyToSupabase(copy);
            }
            saveToIndexedDB();
            updateStrategiesList();
            updateStrategyDropdown();
        }

        // ── Strategy table sort state ──
        let _stratSortCol = null;  // null | 'name' | 'createdBy' | 'trades' | 'pnl' | 'winRate' | 'avgPnl'
        let _stratSortAsc = true;

        function sortStrategiesBy(col) {
            if (_stratSortCol === col) { _stratSortAsc = !_stratSortAsc; }
            else { _stratSortCol = col; _stratSortAsc = true; }
            updateStrategiesList();
        }

        // Trade changes save through saveToIndexedDB; a hidden page redraws when opened.
        function _refreshStrategiesIfVisible() {
            const panel = document.getElementById('strategies');
            if (panel && panel.classList.contains('active')) updateStrategiesList();
        }

        function updateStrategiesList() {
            const strategies = journalData.strategies || [];
            const trades = journalData.trades || [];
            const container = document.getElementById('strategies-list');

            if (strategies.length === 0) {
                container.innerHTML = '<div class="alert alert-info">No strategies defined yet. Click "+ Add Strategy" to create your first one!</div>';
                return;
            }

            // Build trade-stats map keyed by strategy name
            const statsMap = {};
            trades.forEach(t => {
                const name = t.setupType;
                if (!name) return;
                if (!statsMap[name]) {
                    statsMap[name] = { trades: [], pnl: 0, wins: 0 };
                }
                statsMap[name].trades.push(t);
                statsMap[name].pnl += t.pnl;
                if (t.pnl > 0) statsMap[name].wins++;
            });

            const favorites = strategies.filter(s => s.isFavorite !== false);
            const hidden    = strategies.filter(s => s.isFavorite === false);

            // Enrich favorites with computed stats for sorting
            const enriched = favorites.map(s => {
                const st = statsMap[s.name];
                return {
                    s,
                    name: s.name,
                    createdBy: s.createdBy || (s.isDemoSeed ? 'System' : 'User'),
                    tradeCount: st ? st.trades.length : 0,
                    pnl: st ? st.pnl : 0,
                    wins: st ? st.wins : 0,
                    winRate: st && st.trades.length > 0 ? st.wins / st.trades.length * 100 : 0,
                    avgPnl: st && st.trades.length > 0 ? st.pnl / st.trades.length : 0
                };
            });

            // Sort if a column is active
            if (_stratSortCol) {
                const dir = _stratSortAsc ? 1 : -1;
                enriched.sort((a, b) => {
                    let va, vb;
                    switch (_stratSortCol) {
                        case 'name':      va = a.name.toLowerCase(); vb = b.name.toLowerCase(); return va < vb ? -dir : va > vb ? dir : 0;
                        case 'createdBy': va = a.createdBy.toLowerCase(); vb = b.createdBy.toLowerCase(); return va < vb ? -dir : va > vb ? dir : 0;
                        case 'trades':    return (a.tradeCount - b.tradeCount) * dir;
                        case 'pnl':       return (a.pnl - b.pnl) * dir;
                        case 'winRate':   return (a.winRate - b.winRate) * dir;
                        case 'avgPnl':    return (a.avgPnl - b.avgPnl) * dir;
                        default: return 0;
                    }
                });
            }

            function stratRow(e) {
                const s = e.s;
                const fmtMoney = v => (Number(v.toFixed(2)) < 0 ? '-' : '') + '$' +
                    Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const pnlCell = e.tradeCount > 0
                    ? `<td style="color:${e.pnl >= 0 ? 'var(--success)' : 'var(--danger)'};font-weight:600;">${fmtMoney(e.pnl)}</td>`
                    : `<td style="color:var(--text-secondary);">&mdash;</td>`;
                const wrCell = e.tradeCount > 0
                    ? `<td>${e.winRate.toFixed(1)}%</td>`
                    : `<td style="color:var(--text-secondary);">&mdash;</td>`;
                const avgCell = e.tradeCount > 0
                    ? `<td style="color:${e.avgPnl >= 0 ? 'var(--success)' : 'var(--danger)'};font-weight:600;">${fmtMoney(e.avgPnl)}</td>`
                    : `<td style="color:var(--text-secondary);">&mdash;</td>`;

                const isSystem = s.isDemoSeed || s.createdBy === 'System';
                const starBtn = `<button class="btn btn-small" onclick="toggleStrategyFavorite(${s.id})" title="Remove from favorites" style="background:transparent;border:none;font-size:16px;cursor:pointer;padding:2px 4px;color:#f59e0b;">★</button>`;
                const editBtn = isSystem ? '' : `<button class="btn btn-small btn-primary" onclick="editStrategy(${s.id})" style="margin-right:6px;">Edit</button>`;
                const deleteBtn = isSystem ? '' : `<button class="btn btn-small btn-secondary" onclick="deleteStrategy(${s.id})" style="margin-right:6px;">Delete</button>`;
                const dupBtn = `<button class="btn btn-small btn-secondary" onclick="duplicateStrategy(${s.id})">Duplicate</button>`;

                return `
                    <tr>
                        <td><div style="display:flex;align-items:center;gap:8px;">
                            ${starBtn}
                            <div style="width:12px;height:12px;border-radius:3px;background:${s.color};flex-shrink:0;"></div>
                            <strong>${escapeHtml(e.name)}</strong>
                        </div></td>
                        <td style="color:var(--text-secondary);font-size:12px;">${escapeHtml(e.createdBy)}</td>
                        <td>${e.tradeCount}</td>
                        ${pnlCell}
                        ${wrCell}
                        ${avgCell}
                        <td style="text-align:right;white-space:nowrap;">${editBtn}${deleteBtn}${dupBtn}</td>
                    </tr>
                `;
            }

            // Sort header helper
            function sortTh(col, label, align) {
                const active = _stratSortCol === col;
                const arrow = active ? (_stratSortAsc ? ' ▲' : ' ▼') : '';
                const style = (align ? `text-align:${align};` : '') + 'cursor:pointer;user-select:none;' + (active ? 'color:var(--primary);' : '');
                return `<th style="${style}" onclick="sortStrategiesBy('${col}')">${label}${arrow}</th>`;
            }

            let html = '';
            if (enriched.length > 0) {
                html += '<table><thead><tr>' +
                    sortTh('name', 'Strategy') +
                    sortTh('createdBy', 'Created By') +
                    sortTh('trades', 'Trades') +
                    sortTh('pnl', 'P&L') +
                    sortTh('winRate', 'Win Rate') +
                    sortTh('avgPnl', 'Avg P&L') +
                    '<th style="text-align:right;">Actions</th>' +
                '</tr></thead><tbody>';
                enriched.forEach(e => { html += stratRow(e); });
                html += '</tbody></table>';
            } else {
                html += '<div class="alert alert-info">No favorite strategies. Use Add Favorite to restore hidden strategies, or click "+ Add Strategy" to create a new one.</div>';
            }

            container.innerHTML = html;

            // Populate the Add Favorite dropdown menu
            const menu = document.getElementById('strat-add-fav-menu');
            if (menu) {
                if (hidden.length > 0) {
                    menu.innerHTML = hidden.map(s => {
                        const label = s.createdBy || (s.isDemoSeed ? 'System' : 'User');
                        return `<button class="strat-fav-menu-item" onclick="restoreStrategyFavorite(${s.id})">
                            <div style="width:10px;height:10px;border-radius:2px;background:${s.color};flex-shrink:0;"></div>
                            <span style="flex:1;">${escapeHtml(s.name)}</span>
                            <span style="font-size:11px;color:var(--text-secondary);">${escapeHtml(label)}</span>
                        </button>`;
                    }).join('');
                } else {
                    menu.innerHTML = '<div class="strat-fav-menu-empty">No hidden strategies</div>';
                }
            }
        }

        function toggleAddFavoriteMenu() {
            const menu = document.getElementById('strat-add-fav-menu');
            if (!menu) return;
            const opening = !menu.classList.contains('open');
            menu.classList.toggle('open');
            if (opening) {
                // Close on outside click
                setTimeout(() => {
                    document.addEventListener('click', _closeAddFavOutside, { once: true, capture: true });
                }, 30);
            }
        }

        function _closeAddFavOutside(e) {
            const menu = document.getElementById('strat-add-fav-menu');
            const btn  = document.getElementById('strat-add-fav-btn');
            if (menu && !menu.contains(e.target) && btn && !btn.contains(e.target)) {
                menu.classList.remove('open');
            } else if (menu && menu.classList.contains('open')) {
                // Re-attach if click was inside
                setTimeout(() => {
                    document.addEventListener('click', _closeAddFavOutside, { once: true, capture: true });
                }, 30);
            }
        }

        function restoreStrategyFavorite(id) {
            const s = (journalData.strategies || []).find(s => String(s.id) === String(id));
            if (!s) return;
            s.isFavorite = true;
            if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                _saveStrategyToSupabase(s);
            }
            saveToIndexedDB();
            // Close menu
            const menu = document.getElementById('strat-add-fav-menu');
            if (menu) menu.classList.remove('open');
            updateStrategiesList();
            updateStrategyDropdown();
        }

        function updateStrategyDropdown() {
            const strategies = (journalData.strategies || []).filter(s => s.isFavorite !== false)
                .sort((a, b) => DenariiFilters.compareStrategyNames(a.name, b.name));
            const options = '<option value="">Select strategy...</option>' +
                strategies.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('');
            
            document.getElementById('setup-type').innerHTML = options;
            
        }

        // Warn on close when the journal has unsaved in-memory changes (e.g. a
        // failed save). electron/main.js answers this with a Leave/Stay dialog.
        // No backup-age check here: automatic backups run on every launch.
        window.addEventListener('beforeunload', (e) => {
            if (_journalDirty) {
                e.preventDefault();
                e.returnValue = 'You have unsaved changes that may be lost.';
            }
        });

        // Continue with rest of the implementation...
        // (I'll add the rest in the next part - trade form, CSV import, analysis functions)

        const sectionMeta = {
            dashboard: {
                title: 'Dashboard',
                subtitle: 'Review recent performance, spot patterns fast, and jump into the next action without hunting through tabs.'
            },
            journal: {
                title: 'New Trade',
                subtitle: 'Log a trade manually or launch Broker Import from the same workspace so execution review feels fast and natural.'
            },
            'trade-journal': {
                title: 'Trade Reflection',
                subtitle: 'Select a trade, review your execution, and record your thoughts while the memory is still fresh.'
            },
            strategies: {
                title: 'Strategy Management',
                subtitle: 'Build your playbook, define your rules, and score execution based on the strategies you actually trade.'
            },
            'strategy-editor': {
                title: 'Strategy Editor',
                subtitle: 'Define your strategy basics, rule groups, and scoring criteria.'
            },
            settings: {
                title: 'Settings',
                subtitle: 'Manage your profile, security, and tags.'
            },
            'ai-library': {
                title: 'Prompt Library',
                subtitle: 'Browse global AI analysis prompts or build your own. Run any prompt against your trade data in seconds.'
            },
            'ai-run': {
                title: 'Run Analysis',
                subtitle: 'Choose a prompt, apply filters, and send your trade data to Gemini for analysis.'
            },
            'ai-reports': {
                title: 'Saved Reports',
                subtitle: 'Browse, open, and manage AI analysis reports you\'ve saved from Run Analysis.'
            },
            snapshot: {
                title: 'Snapshot',
                subtitle: 'Your customizable analytics dashboard. Add, resize, and rearrange widgets to build the view that fits how you think.'
            }
            ,
            'perf-trends': {
                title: 'Performance Trends',
                subtitle: 'Explore how your trading results change over time. Chart-first deep analysis, fully customizable.'
            }
            ,
            'setups': {
                title: 'Strategy',
                subtitle: 'See which strategies are helping or hurting your trading.'
            }
            ,
            'timing': {
                title: 'Timing',
                subtitle: 'See when your trading is strongest and when it breaks down.'
            }
            ,
            'symbols': {
                title: 'Symbols',
                subtitle: 'Identify which tickers fit your edge, which ones drain you, and where to focus your attention.'
            }
            ,
            'risk': {
                title: 'Risk',
                subtitle: 'Identify where avoidable damage is concentrated, how sizing and stops affect survivability, and where to reduce exposure first.'
            },
            help: {
                title: 'Help',
                subtitle: 'Answers to common questions about using Denarii during the beta.'
            }
            ,
            'discipline': {
                title: 'Discipline',
                subtitle: 'Identify which behavioral mistakes cost the most money and which fix would most improve consistency.'
            }
            ,
            'daily-review': {
                title: 'Daily Reflection',
                subtitle: 'Reflect on today\'s trades, surface patterns, and lock in your next action items.'
            }
            ,
            'weekly-review': {
                title: 'Weekly Reflection',
                subtitle: 'Review the week\'s performance, identify key themes, and plan your focus for next week.'
            }
            ,
            'monthly-review': {
                title: 'Monthly Reflection',
                subtitle: 'Step back and assess your month — what\'s working, what\'s not, and where to push next.'
            }
            ,
            'yearly-review': {
                title: 'Yearly Reflection',
                subtitle: 'Your annual retrospective — measure growth, set goals, and chart the path forward.'
            },
            'daily-planner': {
                title: 'Daily Planner',
                subtitle: 'Set your bias, watchlist, risk limits, and execution plan before the trading day.'
            },
            'weekly-planner': {
                title: 'Weekly Planner',
                subtitle: 'Map your market outlook, opportunities, and execution intent before the week begins.'
            }
        };

        function activateSection(sectionId) {
            // Leaving New Trade (or clicking it again): a complete trade is
            // saved and the form cleared first; an incomplete one asks Stay /
            // Discard. _ntBeforeLeave calls back here once the form is clear.
            var _ntActive = document.querySelector('.tab-content.active');
            if (_ntActive && _ntActive.id === 'journal' && typeof _ntBeforeLeave === 'function' && !_ntBeforeLeave(sectionId)) return;

            // Leaving or returning to the dashboard drops any ticked trades.
            if (typeof _dashResetSelection === 'function') _dashResetSelection();
            document.querySelectorAll('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.tab === sectionId));
            document.querySelectorAll('.tab-content').forEach(panel => panel.classList.toggle('active', panel.id === sectionId));
            // Expose active section for CSS-driven visibility rules
            var ws = document.querySelector('.workspace');
            if (ws) ws.setAttribute('data-section', sectionId);
            refreshHero();

            const meta = sectionMeta[sectionId] || { title: 'Denarii', subtitle: '' };
            const titleEl = document.getElementById('workspace-page-title');
            const subtitleEl = document.getElementById('workspace-page-subtitle');
            if (titleEl) titleEl.textContent = meta.title;
            if (subtitleEl) subtitleEl.textContent = meta.subtitle;


            // Dashboard: apply preferred default view on activation
            if (sectionId === 'dashboard' && _dashViewPrefsLoaded && typeof switchDashView === 'function') {
                var preferredView = _dashRememberLastView ? _dashLastView : _dashDefaultView;
                if (preferredView) {
                    switchDashView(preferredView);
                }
            }

            // Strategy Management: current counts on activation
            if (sectionId === 'strategies') updateStrategiesList();

            // Prompt Library: render on activation
            if (sectionId === 'ai-library') {
                if (typeof AILibrary !== 'undefined') AILibrary.render();
            }

            // Run Analysis: init on activation
            if (sectionId === 'ai-run') {
                if (typeof AIRun !== 'undefined') AIRun.init();
            }

            // Saved Reports: render on activation
            if (sectionId === 'ai-reports') {
                if (typeof AIReports !== 'undefined') AIReports.render();
            }

            // Trade Journal: flush pending autosave when navigating away so
            // edits in the last debounce window are not lost.
            if (sectionId !== 'trade-journal' && typeof window._jnlFlushCommit === 'function') {
                window._jnlFlushCommit();
            }

            // New Trade: restore any saved draft when navigating to the page
            // (after login, when journalData is loaded from the local database).
            if (sectionId === 'journal') {
                if (typeof _ntTryRestoreDraft === 'function') _ntTryRestoreDraft();
                if (typeof _ntPopulateTemplates === 'function') _ntPopulateTemplates();
            }

            // Dashboard: refresh stats + recent-trades list on activation so
            // values updated elsewhere (e.g. Trade Journal autosave) show here
            // without requiring an explicit save click.
            if (sectionId === 'dashboard') {
                if (typeof updateDashboard === 'function') updateDashboard();
            }

            // Journal: always reset to trade selection list on sidebar navigation.
            // Flush any pending commit BEFORE clearing the selected trade id,
            // otherwise the queued _jnlCommitTrade bails on the null id check.
            if (sectionId === 'trade-journal') {
                if (typeof window._jnlFlushCommit === 'function') window._jnlFlushCommit();
                var _outgoingJnlId = window._jnlSelectedTradeId;
                if (_outgoingJnlId && typeof window._jnlClearDraft === 'function') {
                    window._jnlClearDraft(_outgoingJnlId);
                }
                window._jnlSelectedTradeId = null;
                var jnlList = document.getElementById('jnl-view-list');
                var jnlEntry = document.getElementById('jnl-view-entry');
                if (jnlList) jnlList.style.display = '';
                if (jnlEntry) jnlEntry.style.display = 'none';
                initJournalPage();
            }

            // Snapshot: init on activation
            if (sectionId === 'snapshot') {
                if (typeof window._snapInit === 'function') window._snapInit();
            }

            if (sectionId === 'perf-trends') {
                if (typeof window._trendInit === 'function') window._trendInit();
            }

            if (sectionId === 'setups') {
                if (typeof window._setupsInit === 'function') window._setupsInit();
            }

            if (sectionId === 'timing') {
                if (typeof window._timingInit === 'function') window._timingInit();
            }

            if (sectionId === 'symbols') {
                if (typeof window._symbolsInit === 'function') window._symbolsInit();
            }

            if (sectionId === 'risk') {
                if (typeof window._riskInit === 'function') window._riskInit();
            }

            if (sectionId === 'discipline') {
                if (typeof window._disciplineInit === 'function') window._disciplineInit();
            }

            // Settings: load data on activation
            if (sectionId === 'settings') {
                if (typeof window.loadTagsData === 'function') window.loadTagsData();
                if (typeof window.loadIntegrationsSettings === 'function') window.loadIntegrationsSettings();
                if (typeof window.loadProfileSettings === 'function') window.loadProfileSettings();
            }

            // Reviews: init on activation
            if (sectionId === 'daily-review') {
                if (typeof window.initDailyReview === 'function') window.initDailyReview();
            }
            if (sectionId === 'weekly-review') {
                if (typeof window.initWeeklyReview === 'function') window.initWeeklyReview();
            }
            if (sectionId === 'monthly-review') {
                if (typeof window.initMonthlyReview === 'function') window.initMonthlyReview();
            }
            if (sectionId === 'yearly-review') {
                if (typeof window.initYearlyReview === 'function') window.initYearlyReview();
            }

            // Daily Planner: init on activation
            if (sectionId === 'daily-planner') {
                if (typeof window.initDailyPlanner === 'function') window.initDailyPlanner();
            }

            // Daily Planner: flush pending save when navigating away
            if (sectionId !== 'daily-planner' && typeof window._dpFlushSave === 'function') {
                window._dpFlushSave();
            }

            // Weekly Planner: init on activation
            if (sectionId === 'weekly-planner') {
                if (typeof window.initWeeklyPlanner === 'function') window.initWeeklyPlanner();
            }

            // Weekly Planner: flush pending save when navigating away
            if (sectionId !== 'weekly-planner' && typeof window._wpFlushSave === 'function') {
                window._wpFlushSave();
            }

            // Help: reset to default topic (Overview) on every activation
            if (sectionId === 'help') {
                helpSelectTopic('help-overview');
            }

        }

        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => activateSection(item.dataset.tab));
        });

        /** Switch visible help topic in the two-pane Help layout */
        function helpSelectTopic(topicId) {
            document.querySelectorAll('.help-content-panel .help-section').forEach(s => s.style.display = 'none');
            const target = document.getElementById(topicId);
            if (target) target.style.display = '';
            const panel = document.querySelector('.help-content-panel');
            if (panel) panel.scrollTop = 0;
            document.querySelectorAll('.help-nav-btn').forEach(b => b.classList.remove('active'));
            const btn = document.querySelector(`.help-nav-btn[data-help-topic="${topicId}"]`);
            if (btn) btn.classList.add('active');
        }
        document.querySelectorAll('.help-nav-btn').forEach(btn => {
            btn.addEventListener('click', () => helpSelectTopic(btn.dataset.helpTopic));
        });

        // ── Trade planning rows & live metrics ────────────────────────────────

        // ── Combined planned-level rows (target + stop in one row) ────
        function _makeCombinedPlanRow(targetPrice, targetQty, stopPrice, stopQty, recalcFn) {
            var div = document.createElement('div');
            div.className = 'plan-row';
            div.style.cssText = 'display:flex;gap:6px;align-items:center;margin-bottom:6px;';
            div.innerHTML =
                '<span style="font-size:11px;color:var(--text-secondary);flex-shrink:0;width:32px;">TP</span>' +
                '<input type="number" class="target-price" placeholder="Target" step="0.01" style="width:150px;flex:0 1 150px;min-width:0;">' +
                '<input type="number" class="target-qty" placeholder="Qty" step="1" min="0" style="width:80px;flex:0 1 80px;min-width:0;">' +
                '<span style="font-size:11px;color:var(--text-secondary);flex-shrink:0;width:24px;text-align:center;">SL</span>' +
                '<input type="number" class="stop-price" placeholder="Stop" step="0.01" style="width:150px;flex:0 1 150px;min-width:0;">' +
                '<input type="number" class="stop-qty" placeholder="Qty" step="1" min="0" style="width:80px;flex:0 1 80px;min-width:0;">' +
                '<span style="font-size:11px;color:var(--text-secondary);flex:0 0 auto;">R/R</span>' +
                '<span class="plan-rr" style="font-size:11px;font-weight:600;color:var(--text-secondary);flex:0 0 40px;text-align:right;">--</span>' +
                '<button type="button" class="btn btn-small plan-remove-btn" onclick="removePlanRow(this)" ' +
                'style="background:var(--danger);color:var(--on-danger);padding:2px 9px;flex-shrink:0;font-size:15px;line-height:1.3;">\u00d7</button>';
            if (targetPrice != null && targetPrice !== '') div.querySelector('.target-price').value = targetPrice;
            if (targetQty   != null && targetQty   !== '') div.querySelector('.target-qty').value   = targetQty;
            if (stopPrice   != null && stopPrice   !== '') div.querySelector('.stop-price').value   = stopPrice;
            if (stopQty     != null && stopQty     !== '') div.querySelector('.stop-qty').value     = stopQty;
            // Hook up recalc + per-row R/R update
            var _updateRowRR = function () {
                _recalcPlanRowRR(div);
                if (recalcFn) recalcFn();
            };
            div.querySelectorAll('input').forEach(function (inp) {
                inp.addEventListener('input', _updateRowRR);
            });
            _recalcPlanRowRR(div);
            return div;
        }

        // Compute and display R/R for a single plan row
        function _recalcPlanRowRR(rowEl) {
            var rrSpan = rowEl.querySelector('.plan-rr');
            if (!rrSpan) return;
            var tp = parseFloat((rowEl.querySelector('.target-price') || {}).value);
            var sl = parseFloat((rowEl.querySelector('.stop-price') || {}).value);
            // Read entry price and side from the form context
            var card = rowEl.closest('.card') || rowEl.closest('.tab-content');
            var entryEl = card ? (card.querySelector('#entry-price') || card.querySelector('#jnl-entry-price')) : null;
            var sideEl = card ? (card.querySelector('#trade-type') || card.querySelector('#jnl-trade-type')) : null;
            var entry = entryEl ? parseFloat(entryEl.value) : NaN;
            var side = sideEl ? sideEl.value : 'long';
            if (isNaN(tp) || isNaN(sl) || isNaN(entry)) { rrSpan.textContent = '--'; rrSpan.style.color = 'var(--text-secondary)'; return; }
            var risk = side === 'long' ? entry - sl : sl - entry;
            var reward = side === 'long' ? tp - entry : entry - tp;
            if (risk <= 0) { rrSpan.textContent = '--'; rrSpan.style.color = 'var(--text-secondary)'; return; }
            var rr = reward / risk;
            rrSpan.textContent = rr.toFixed(1) + 'R';
            rrSpan.style.color = rr >= 1 ? 'var(--success)' : 'var(--warning)';
        }

        // Recalculate R/R on all plan rows in a container
        function _recalcAllPlanRowRR(containerId) {
            var c = document.getElementById(containerId);
            if (!c) return;
            c.querySelectorAll('.plan-row').forEach(_recalcPlanRowRR);
        }

        function _syncRemoveBtns(container) {
            if (!container) return;
            const rows = container.querySelectorAll('.plan-row');
            rows.forEach(r => {
                const btn = r.querySelector('.plan-remove-btn');
                if (btn) btn.style.visibility = rows.length > 1 ? 'visible' : 'hidden';
            });
        }

        function _getRecalcFn(el) {
            if (!el || !el.closest) return _recalcNewMetrics;
            if (el.closest('#journal-editor-card')) return _jnlRecalcMetrics;
            return _recalcNewMetrics;
        }

        function addPlanRow(containerId, targetPrice, targetQty, stopPrice, stopQty) {
            var c = document.getElementById(containerId);
            if (!c) return;
            var fn = _getRecalcFn(c);
            c.appendChild(_makeCombinedPlanRow(targetPrice, targetQty, stopPrice, stopQty, fn));
            _syncRemoveBtns(c);
            fn();
        }

        function removePlanRow(btn) {
            var row = btn.closest('.plan-row');
            if (!row) return;
            var c = row.parentElement;
            row.remove();
            _syncRemoveBtns(c);
            _getRecalcFn(c)();
        }

        // Legacy wrappers — still called by old rehydrate paths
        function addTargetRow(containerId, price, qty) {
            addPlanRow(containerId, price, qty, '', '');
        }
        function addStopRow(containerId, price, qty) {
            addPlanRow(containerId, '', '', price, qty);
        }
        function removeTargetRow(btn) { removePlanRow(btn); }
        function removeStopRow(btn) { removePlanRow(btn); }

        function _rehydrateRows(containerId, addFn, data) {
            const c = document.getElementById(containerId);
            if (!c) return;
            c.innerHTML = '';
            const rows = (Array.isArray(data) && data.length > 0) ? data : [{}];
            rows.forEach(d => addFn(containerId, d.price != null ? d.price : '', d.qty != null ? d.qty : ''));
        }

        // Rehydrate combined plan rows from separate target/stop arrays
        function _rehydratePlanRows(containerId, targets, stops) {
            var c = document.getElementById(containerId);
            if (!c) return;
            c.innerHTML = '';
            var t = Array.isArray(targets) ? targets : [];
            var s = Array.isArray(stops) ? stops : [];
            var len = Math.max(t.length, s.length, 1);
            for (var i = 0; i < len; i++) {
                var tp = t[i] || {}, sp = s[i] || {};
                addPlanRow(containerId,
                    tp.price != null ? tp.price : '',
                    tp.qty != null ? tp.qty : '',
                    sp.price != null ? sp.price : '',
                    sp.qty != null ? sp.qty : '');
            }
        }

        function _getRowData(containerId, priceClass, qtyClass) {
            const c = document.getElementById(containerId);
            if (!c) return [];
            return Array.from(c.querySelectorAll('.plan-row')).map(row => ({
                price: _sf(row.querySelector('.' + priceClass)),
                qty:   _sf(row.querySelector('.' + qtyClass))
            }));
        }

        function _sf(el) {
            if (!el || el.value === '') return null;
            const v = parseFloat(el.value);
            return isNaN(v) ? null : v;
        }

        function _sfId(id) {
            return _sf(document.getElementById(id));
        }

        function _contractMultiplier(assetType) {
            return assetType === 'option' ? 100 : 1;
        }

        function _computeTradeMetrics(entry, exit_, qty, side, comm, targets, stops, assetType) {
            var mult = _contractMultiplier(assetType);
            const firstPrice = (arr) =>
                (Array.isArray(arr) && arr.length > 0 && arr[0].price != null) ? arr[0].price : null;
            const initTarget = firstPrice(targets);
            const initStop   = firstPrice(stops);

            let tradeRisk = null;
            if (entry != null && initStop != null) {
                const r = side === 'long' ? entry - initStop : initStop - entry;
                if (r > 0) tradeRisk = r;
            }

            let plannedRMultiple = null;
            if (entry != null && initTarget != null && tradeRisk != null && tradeRisk > 0) {
                const reward = side === 'long' ? initTarget - entry : entry - initTarget;
                plannedRMultiple = reward / tradeRisk;
            }

            let netPnl = null;
            if (entry != null && exit_ != null && qty != null) {
                const gross = side === 'long' ? (exit_ - entry) * qty * mult : (entry - exit_) * qty * mult;
                netPnl = gross - (comm || 0);
            }

            let realizedRMultiple = null;
            if (netPnl != null && tradeRisk != null && qty != null && tradeRisk > 0) {
                const riskDollars = tradeRisk * qty * mult;
                if (riskDollars > 0) realizedRMultiple = netPnl / riskDollars;
            }

            let drawdown = null, runup = null;
            if (entry != null && exit_ != null) {
                const adv = side === 'long' ? entry - exit_ : exit_ - entry;
                const fav = side === 'long' ? exit_ - entry : entry - exit_;
                if (adv > 0) drawdown = adv;
                if (fav > 0) runup = fav;
            }

            var totalPlannedRisk = null;
            if (tradeRisk != null && qty != null && tradeRisk > 0) {
                totalPlannedRisk = tradeRisk * qty * mult;
            }

            return { initialTarget: initTarget, tradeRisk, plannedRMultiple, realizedRMultiple, drawdown, runup, totalPlannedRisk, netPnl };
        }

        // ──────────────────────────────────────────────────────────────────────
        // Multi-fill logical trade foundation (Phase 1 — additive only)
        //
        // A logical trade MAY optionally carry an additive `fills` array
        // alongside the existing scalar fields. Each item in `fills` represents
        // one MATCHED ENTRY/EXIT SLICE for part of the same logical trade
        // (e.g. a 10-contract position closed as 4 + 6 at different prices).
        // This is NOT a raw broker execution event stream — each fill already
        // has a paired entry and exit.
        //
        // Shape of one `fills[]` item:
        //   {
        //     quantity:       Number,    // shares/contracts for this slice
        //     entryPrice:     Number,
        //     exitPrice:      Number,
        //     entryTime:      ISO string,
        //     exitTime:       ISO string,
        //     commissionFees: Number,    // dollars attributable to this slice
        //     pnl:            Number,    // net dollar P&L (option-aware, 100x)
        //     source?:        Object     // optional lightweight provenance
        //                                // (e.g. { file, rowIndex }) — only
        //                                // set when already naturally available
        //   }
        //
        // Source-of-truth rules:
        //   • When `fills` is absent or empty, the top-level scalar fields
        //     (entryPrice, exitPrice, entryTime, exitTime, quantity, pnl,
        //     commissionFees, holdSeconds) remain the source of truth.
        //     Legacy saved trades are unaffected.
        //   • When `fills` is non-empty, the scalar fields are DERIVED from
        //     the array by `deriveTradeSummaryFromFills` below, and the
        //     derived values become the source of truth for the rest of the
        //     app. Row-level quantity is preserved per-fill; trade-level
        //     quantity is the sum across fills.
        //   • Option P&L math uses the 100x contract multiplier. All asset-
        //     type-aware math is centralized here via _contractMultiplier so
        //     callers never need to apply the multiplier themselves.
        // ──────────────────────────────────────────────────────────────────────

        /**
         * Canonical derivation: given an array of matched-fill slices and the
         * logical trade's side/asset metadata, return normalized scalar summary
         * fields. This is the single authoritative derivation path for
         * multi-row logical trades.
         *
         * @param {Array}  fills  Matched entry/exit slices (see shape above).
         * @param {Object} meta   { type: 'long'|'short', assetType: string }
         * @returns {Object|null} { quantity, entryPrice, exitPrice, entryTime,
         *                          exitTime, pnl, commissionFees, holdSeconds }
         *                        or null if the fills array is unusable.
         */
        function deriveTradeSummaryFromFills(fills, meta) {
            if (!Array.isArray(fills) || fills.length === 0) return null;
            var side = (meta && meta.type) || 'long';
            var assetType = (meta && meta.assetType) || 'stock';
            var mult = _contractMultiplier(assetType); // option-aware (100x) lives here

            var totalQty = 0;
            var weightedEntryNumer = 0;
            var weightedExitNumer = 0;
            var earliestEntryMs = Infinity;
            var latestExitMs = -Infinity;
            var totalCommissions = 0;
            var totalPnl = 0;
            var totalGrossPnl = 0;

            for (var i = 0; i < fills.length; i++) {
                var f = fills[i] || {};
                var q = Number(f.quantity) || 0;
                if (q <= 0) continue;
                var ep = Number(f.entryPrice) || 0;
                var xp = Number(f.exitPrice) || 0;
                var comm = Number(f.commissionFees) || 0;

                totalQty += q;
                weightedEntryNumer += ep * q;
                weightedExitNumer  += xp * q;
                totalCommissions   += comm;

                // Prefer the fill's stored pnl when provided (keeps per-fill
                // numbers authoritative). Otherwise compute with the same
                // option-aware rule used everywhere else in the app.
                var fillGross = side === 'long'
                    ? (xp - ep) * q * mult
                    : (ep - xp) * q * mult;
                var fillPnl;
                if (f.pnl != null && Number.isFinite(Number(f.pnl))) {
                    fillPnl = Number(f.pnl);
                } else {
                    fillPnl = fillGross - comm;
                }
                totalGrossPnl += fillGross;
                totalPnl += fillPnl;

                var entMs = f.entryTime ? new Date(f.entryTime).getTime() : NaN;
                var extMs = f.exitTime  ? new Date(f.exitTime).getTime()  : NaN;
                if (Number.isFinite(entMs) && entMs < earliestEntryMs) earliestEntryMs = entMs;
                if (Number.isFinite(extMs) && extMs > latestExitMs)    latestExitMs    = extMs;
            }

            if (totalQty <= 0) return null;

            var entryTime = Number.isFinite(earliestEntryMs) ? new Date(earliestEntryMs).toISOString() : null;
            var exitTime  = Number.isFinite(latestExitMs)    ? new Date(latestExitMs).toISOString()    : null;
            var holdSeconds = (Number.isFinite(earliestEntryMs) && Number.isFinite(latestExitMs))
                ? Math.max(0, (latestExitMs - earliestEntryMs) / 1000)
                : 0;

            return {
                quantity:       totalQty,
                entryPrice:     weightedEntryNumer / totalQty, // weighted-avg
                exitPrice:      weightedExitNumer  / totalQty, // weighted-avg
                entryTime:      entryTime,                     // earliest entry
                exitTime:       exitTime,                      // latest exit
                grossPnl:       totalGrossPnl,
                pnl:            totalPnl,
                commissionFees: totalCommissions,
                holdSeconds:    holdSeconds
            };
        }

        /**
         * Single write-path entry point that keeps multi-row trades routed
         * through the canonical derivation. When `trade.fills` is non-empty,
         * rewrites the scalar summary fields on `trade` from the fills array.
         * When `fills` is absent or empty, returns the trade unchanged so
         * legacy scalar-only trades remain the source of truth.
         *
         * Does NOT touch option contract identity fields (symbol, optionType,
         * strike, expiry, contractName) or any other trade metadata — those
         * are trade-level and preserved verbatim.
         */
        function finalizeTradeSummary(trade) {
            if (!trade || !Array.isArray(trade.fills) || trade.fills.length === 0) {
                return trade;
            }
            var summary = deriveTradeSummaryFromFills(trade.fills, {
                type:      trade.type,
                assetType: trade.assetType
            });
            if (!summary) return trade;
            trade.quantity       = summary.quantity;
            trade.entryPrice     = summary.entryPrice;
            trade.exitPrice      = summary.exitPrice;
            trade.entryTime      = summary.entryTime;
            trade.exitTime       = summary.exitTime;
            trade.grossPnl       = summary.grossPnl;
            trade.pnl            = summary.pnl;
            trade.commissionFees = summary.commissionFees;
            trade.holdSeconds    = summary.holdSeconds;
            return trade;
        }

        // Fill rows as typed ({ qty, entryPrice, exitPrice, entryTime,
        // exitTime, fees } strings, the shape _ntFindIncompleteFillRow reads)
        // → canonical fills. Rows without qty or both times are skipped, so
        // callers run _ntFindIncompleteFillRow first. Shared by the Trade
        // Reflection fills editor; no DOM access.
        function _fillsFromRawRows(rawRows, side, assetType) {
            var mult = _contractMultiplier(assetType || 'stock');
            var fills = [];
            (rawRows || []).forEach(function(r) {
                var q  = parseFloat(r.qty) || 0;
                var ep = parseFloat(r.entryPrice) || 0;
                var xp = parseFloat(r.exitPrice) || 0;
                var cm = parseFloat(r.fees) || 0;
                if (q <= 0 || !r.entryTime || !r.exitTime) return;
                var et = new Date(r.entryTime);
                var xt = new Date(r.exitTime);
                if (isNaN(et.getTime()) || isNaN(xt.getTime())) return;
                var gross = side === 'short' ? (ep - xp) * q * mult : (xp - ep) * q * mult;
                fills.push({
                    quantity:       q,
                    entryPrice:     ep,
                    exitPrice:      xp,
                    entryTime:      et.toISOString(),
                    exitTime:       xt.toISOString(),
                    commissionFees: cm,
                    pnl:            gross - cm
                });
            });
            return fills;
        }

        // Splits a trade's fills in two without changing the trade: the
        // marked fills become one new trade (newId), the rest stay on a copy
        // of the original. Both are summarized from their fills and rounded.
        // The new trade carries the trade's identity only, not its
        // reflection (notes, tags, grade, strategy) or import ids. Returns
        // null unless at least one fill is marked and one is left.
        function _splitTradeByFills(trade, fills, markedIdx, newId) {
            if (!trade || !Array.isArray(fills)) return null;
            var marked = {};
            (markedIdx || []).forEach(function(i) { marked[i] = true; });
            var moved = fills.filter(function(f, i) { return marked[i]; });
            var kept  = fills.filter(function(f, i) { return !marked[i]; });
            if (moved.length === 0 || kept.length === 0) return null;
            var now = Date.now();

            var updated = JSON.parse(JSON.stringify(trade));
            updated.fills = JSON.parse(JSON.stringify(kept));
            finalizeTradeSummary(updated);
            updated.notesUpdatedAt = now;
            _roundTradeForSave(updated);

            var created = {
                id:              newId,
                symbol:          trade.symbol,
                type:            trade.type || trade.direction || 'long',
                assetType:       trade.assetType || 'stock',
                optionAction:    trade.optionAction || null,
                optionType:      trade.optionType || null,
                strike:          trade.strike || 0,
                expiry:          trade.expiry || null,
                contractName:    trade.contractName || '',
                brokerAccountId: trade.brokerAccountId || '',
                source:          trade.source || 'manual',
                sourceFile:      trade.sourceFile || '',
                fills:           JSON.parse(JSON.stringify(moved)),
                notesUpdatedAt:  now
            };
            finalizeTradeSummary(created);
            _roundTradeForSave(created);
            return { updated: updated, created: created };
        }

        // ──────────────────────────────────────────────────────────────────────
        // Logical-trade grouping — position-cycle anchored.
        //
        // After matchTradePairs() produces flat matched entry/exit slices,
        // this step collapses slices that belong to the same OPENED POSITION
        // into a single logical trade with a populated `fills[]` array.
        // Non-grouped slices pass through unchanged as legacy single-row
        // trades.
        //
        // Anchoring model:
        //   matchTradePairs tags every slice it produces with a
        //   `_positionId` tracked per contract key. A positionId spans
        //   one position-cycle: the first buy while flat opens a new
        //   positionId; every subsequent buy that adds to the still-open
        //   position inherits that positionId; every sell slice inherits
        //   the open row's positionId; once the running net quantity
        //   returns to 0 the next buy starts a new positionId.
        //
        //   Grouping by positionId is therefore the real definition of
        //   "same opened position":
        //     • A single opening order that partial-fills over seconds,
        //       minutes, or even longer still produces one positionId.
        //     • Multiple trims/exits, however far apart in time, all
        //       inherit the same positionId and stay in the same logical
        //       trade. There is NO exit-time window.
        //     • Re-entering the same contract after flattening starts a
        //       NEW positionId — so distinct round-trips never merge.
        //
        // Grouping criteria (ALL must hold between any two slices in the
        // same bucket; we also require every existing slice in a bucket
        // to satisfy these with a new candidate, preventing accidental
        // cross-identity collapse):
        //   • same symbol
        //   • same assetType
        //   • same side (type: 'long' | 'short')
        //   • same optionType  (or both null/empty for stocks)
        //   • same strike      (or both 0/null for stocks)
        //   • same expiry      (or both null/empty for stocks)
        //   • same contractName when both present (empty on either side
        //     is treated as "no conflict")
        //   • same _positionId (file-scoped by handleBrokerImportFiles
        //     so cross-file batches cannot collide via counter reuse)
        //
        // brokerAccountId is a batch-wide invariant: every slice in one
        // import batch is destined for the single account the user
        // selected in the import dropdown (applied later in
        // confirmBrokerImport), so it is not re-checked here.
        //
        // Canceled/rejected/expired/void rows:
        //   Filtered out upstream in parseCSV. They never reach
        //   matchTradePairs or this grouper, so they cannot influence
        //   grouping and cannot become trades.
        //
        // Commission allocation:
        //   matchTradePairs() already charges each raw row's commission
        //   to exactly ONE slice. Summing slice commissionFees therefore
        //   yields the correct total with no double-counting —
        //   finalizeTradeSummary() simply adds them up. Per-side
        //   attribution is preserved on each fill via
        //   source.entryCommissionFees / source.exitCommissionFees for
        //   future audit/UI needs.
        //
        // Future split/unlink support:
        //   Every fill in a grouped trade is stamped with a stable
        //   per-trade `fillId` ("f1", "f2", ...). A future phase can
        //   address individual rows by fillId to split them back into
        //   separate trades without ambiguity. This phase does not add
        //   any UI for that.
        // ──────────────────────────────────────────────────────────────────────
        function groupMatchedSlicesIntoLogicalTrades(slices) {
            if (!Array.isArray(slices) || slices.length === 0) return slices || [];

            function _normOpt(v) { return (v == null || v === '') ? null : String(v).toUpperCase(); }
            function _normExp(v) { return (v == null || v === '') ? null : String(v); }
            function _normStr(v) { var n = Number(v); return (isFinite(n) && n > 0) ? n : 0; }
            function _normCN(v)  { return (v == null || v === '') ? null : String(v); }

            function _sameIdentity(a, b) {
                if (a.symbol !== b.symbol) return false;
                if ((a.assetType || 'stock') !== (b.assetType || 'stock')) return false;
                if ((a.type || 'long') !== (b.type || 'long')) return false;
                if (_normOpt(a.optionType) !== _normOpt(b.optionType)) return false;
                if (_normStr(a.strike) !== _normStr(b.strike)) return false;
                if (_normExp(a.expiry) !== _normExp(b.expiry)) return false;
                // contractName: require match when both present; empty on
                // either side is treated as "no conflict".
                var cnA = _normCN(a.contractName), cnB = _normCN(b.contractName);
                if (cnA && cnB && cnA !== cnB) return false;
                return true;
            }

            function _samePositionCycle(a, b) {
                // Defensive: if either slice lacks a positionId for any
                // reason, do NOT merge — it's safer to leave them as
                // separate scalar trades than to accidentally collapse
                // distinct round-trips.
                if (a._positionId == null || b._positionId == null) return false;
                return a._positionId === b._positionId;
            }

            // Bucket slices. A slice joins a bucket only if it shares the
            // same contract identity AND the same position-cycle id with
            // EVERY slice already in that bucket. Exit timestamps are not
            // checked — by design. Requiring all-vs-all match prevents
            // any accidental cross-position chaining.
            var buckets = [];
            for (var i = 0; i < slices.length; i++) {
                var s = slices[i];
                var placed = false;
                for (var b = 0; b < buckets.length; b++) {
                    var bucket = buckets[b];
                    var fits = true;
                    for (var k = 0; k < bucket.slices.length; k++) {
                        if (!_sameIdentity(bucket.slices[k], s) ||
                            !_samePositionCycle(bucket.slices[k], s)) {
                            fits = false; break;
                        }
                    }
                    if (fits) {
                        bucket.slices.push(s);
                        placed = true;
                        break;
                    }
                }
                if (!placed) buckets.push({ slices: [s] });
            }

            // Materialize: single-slice buckets pass through unchanged;
            // multi-slice buckets become one logical trade with fills[].
            var output = [];
            for (var bi = 0; bi < buckets.length; bi++) {
                var bslices = buckets[bi].slices;
                if (bslices.length === 1) {
                    output.push(bslices[0]);
                    continue;
                }

                // Chronological ordering by entry then exit — makes fills[]
                // read naturally for human review and keeps fillIds stable.
                var sorted = bslices.slice().sort(function(x, y) {
                    var xe = new Date(x.entryTime).getTime();
                    var ye = new Date(y.entryTime).getTime();
                    if (xe !== ye) return xe - ye;
                    return new Date(x.exitTime).getTime() - new Date(y.exitTime).getTime();
                });
                var head = sorted[0];

                var fills = sorted.map(function(sl, idx) {
                    // Optional lightweight source metadata — only set when
                    // naturally available. Carries per-side commission
                    // attribution so a future audit / unlink UI can show
                    // exactly which dollars came from which raw row.
                    var source = null;
                    if (sl.sourceFile || sl.contractName ||
                        sl.entryCommissionFees != null || sl.exitCommissionFees != null) {
                        source = {};
                        if (sl.sourceFile)            source.file                = sl.sourceFile;
                        if (sl.contractName)          source.contractName        = sl.contractName;
                        if (sl.entryCommissionFees != null) source.entryCommissionFees = sl.entryCommissionFees;
                        if (sl.exitCommissionFees  != null) source.exitCommissionFees  = sl.exitCommissionFees;
                    }
                    var fill = {
                        // Stable per-trade identifier so a future phase can
                        // target individual rows for split/unlink without
                        // relying on array index.
                        fillId:         'f' + (idx + 1),
                        quantity:       Number(sl.quantity) || 0,
                        entryPrice:     Number(sl.entryPrice) || 0,
                        exitPrice:      Number(sl.exitPrice) || 0,
                        entryTime:      sl.entryTime,
                        exitTime:       sl.exitTime,
                        commissionFees: Number(sl.commissionFees) || 0,
                        pnl:            Number(sl.pnl) || 0
                    };
                    if (sl.grossPnl != null) fill.grossPnl = Number(sl.grossPnl);
                    if (sl.feeSource)        fill.feeSource = sl.feeSource;
                    if (source) fill.source = source;
                    return fill;
                });

                // Representative trade-level metadata comes from the
                // earliest slice. Every slice in the bucket has the same
                // contract identity by construction, so no data is lost.
                // Derive feeSource for the grouped trade: use the first
                // slice's value (all slices in a bucket share the same
                // broker and estimation status).
                var _groupFeeSource = head.feeSource || undefined;

                var grouped = {
                    symbol:       head.symbol,
                    type:         head.type || 'long',
                    assetType:    head.assetType || 'stock',
                    optionType:   head.optionType || null,
                    strike:       head.strike || 0,
                    expiry:       head.expiry || null,
                    contractName: head.contractName || '',
                    source:       head.source || 'csv',
                    sourceFile:   head.sourceFile || '',
                    feeSource:    _groupFeeSource,
                    _tempId:      head._tempId,
                    // Multi-row foundation
                    fills:        fills
                    // Scalar summary fields (quantity, entryPrice, exitPrice,
                    // entryTime, exitTime, pnl, commissionFees, holdSeconds)
                    // are written below by finalizeTradeSummary() — the
                    // single canonical derivation path.
                };
                finalizeTradeSummary(grouped);
                output.push(grouped);
            }

            return output;
        }

        function _applyMetrics(prefix, m) {
            // Sign before the $ ("-$1.00"), as in the trades table.
            const $v = (v) => v != null ? (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2) : '--';
            const Rv = (v) => v != null ? v.toFixed(2) + 'R' : '--';
            const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
            set(prefix + 'initial-target', $v(m.initialTarget));
            set(prefix + 'trade-risk',     $v(m.tradeRisk));
            set(prefix + 'planned-r',      Rv(m.plannedRMultiple));
            set(prefix + 'realized-r',     Rv(m.realizedRMultiple));
            set(prefix + 'drawdown',       $v(m.drawdown));
            set(prefix + 'runup',          $v(m.runup));
            set(prefix + 'total-risk',     $v(m.totalPlannedRisk));
            set(prefix + 'realized-pnl',   $v(m.netPnl));
            const rEl = document.getElementById(prefix + 'realized-r');
            if (rEl) rEl.style.color = m.realizedRMultiple == null ? 'var(--text-primary)'
                : m.realizedRMultiple >= 0 ? 'var(--success)' : 'var(--danger)';
            const pnlEl = document.getElementById(prefix + 'realized-pnl');
            if (pnlEl) pnlEl.style.color = m.netPnl == null ? 'var(--text-primary)'
                : m.netPnl >= 0 ? 'var(--success)' : 'var(--danger)';
        }

        // Net / Gross / Fees P&L summary and fee-source badge. Moved from the
        // old Edit Trade page (Batch C2); Trade Reflection calls it with the
        // 'jnl-' prefix. Display only. A missing value (open trade, blank
        // price or quantity, no fees) shows -- instead of $0.00.
        function _updatePnlSummary(prefix, ep, xp, qty, side, comm, assetType, feeSource) {
            var mult = _contractMultiplier(assetType);
            var hasPnl = ep != null && xp != null && qty != null;
            var gross = !hasPnl ? null : side === 'long'
                ? (xp - ep) * qty * mult
                : (ep - xp) * qty * mult;
            var net = hasPnl ? gross - (comm || 0) : null;

            function _fmtPnl(v) {
                if (v == null) return '--';
                // Same format as the trades table P&L column.
                return (v >= 0 ? '+' : '-') + '$' + Math.abs(v).toFixed(2);
            }
            function _pnlColor(v) {
                if (v == null) return 'var(--text-primary)';
                return v >= 0 ? 'var(--success)' : 'var(--danger)';
            }

            var netEl   = document.getElementById(prefix + 'pnl-net');
            var grossEl = document.getElementById(prefix + 'pnl-gross');
            var feesEl  = document.getElementById(prefix + 'pnl-fees');
            var badgeEl = document.getElementById(prefix + 'fee-source-badge');

            if (netEl)   { netEl.textContent = _fmtPnl(net);     netEl.style.color = _pnlColor(net); }
            if (grossEl) { grossEl.textContent = _fmtPnl(gross); grossEl.style.color = _pnlColor(gross); }
            if (feesEl)  { feesEl.textContent = comm > 0 ? '$' + comm.toFixed(2) : '--'; }
            if (badgeEl) {
                if (feeSource === 'estimated') {
                    badgeEl.textContent = 'est.';
                    badgeEl.title = 'Estimated from broker fee schedule. Edit Commission & Fees to override.';
                } else if (feeSource === 'actual') {
                    badgeEl.textContent = 'actual';
                    badgeEl.title = 'Fee data from broker CSV.';
                } else if (feeSource === 'manual') {
                    badgeEl.textContent = 'manual';
                    badgeEl.title = 'User-entered fee.';
                } else {
                    badgeEl.textContent = '';
                    badgeEl.title = '';
                }
                // No badge without a fee to describe.
                badgeEl.style.display = (badgeEl.textContent && comm > 0) ? '' : 'none';
            }
        }

        function _recalcNewMetrics() {
            var _m = _computeTradeMetrics(
                _sfId('entry-price'), _sfId('exit-price'), _sfId('quantity'),
                (document.getElementById('trade-type') || {}).value || 'long',
                _sfId('commission-fees') || 0,
                _getRowData('plan-rows', 'target-price', 'target-qty'),
                _getRowData('plan-rows', 'stop-price',   'stop-qty'),
                (document.getElementById('asset-type') || {}).value || 'stock'
            );
            _applyMetrics('metric-', _m);
            _ntUpdateMetricGain();
            _recalcAllPlanRowRR('plan-rows');
        }


        function _jnlRecalcMetrics() {
            var _m = _computeTradeMetrics(
                _sfId('jnl-entry-price'), _sfId('jnl-exit-price'), _sfId('jnl-quantity'),
                (document.getElementById('jnl-trade-type') || {}).value || 'long',
                _sfId('jnl-commission-fees') || 0,
                _getRowData('jnl-plan-rows', 'target-price', 'target-qty'),
                _getRowData('jnl-plan-rows', 'stop-price',   'stop-qty'),
                (document.getElementById('jnl-asset-type') || {}).value || 'stock'
            );
            _applyMetrics('jnl-metric-', _m);
            _recalcAllPlanRowRR('jnl-plan-rows');
        }

        // Initialize planning rows and live listeners for the new trade form
        (function () {
            addPlanRow('plan-rows');
            ['entry-price', 'exit-price', 'quantity', 'commission-fees'].forEach(function (id) {
                const el = document.getElementById(id);
                if (el) el.addEventListener('input', _recalcNewMetrics);
            });
            const typeEl = document.getElementById('trade-type');
            if (typeEl) typeEl.addEventListener('change', _recalcNewMetrics);
        })();

        // ── End trade planning rows & live metrics ─────────────────────────────

        // ── New Trade autosave (two-layer: draft + real record save) ─────────
        // Draft slot: 'new-trade' while no record exists yet.
        // Once minimum data is met and the record is created, we keep the real
        // trade id and autosave like Edit Trade.
        // The form's trade id: set by the first save attempt and kept (also on
        // a failed save) until the form is cleared, so every save of this form
        // upserts the same id and can never create a second trade.
        var _ntCreatedTradeId = null;
        var _ntCreatedSaved = false;   // that trade has been saved at least once
        var _ntFormDirty = false;      // the user has entered something since the last clear

        // Multi-fill mode on New Trade. Default off: the page renders exactly
        // as it always has. When the user opts in via ntToggleFills(), a
        // repeatable fill-row section appears below the execution fields and
        // the canonical summary inputs become read-only, populated by the
        // derivation helper from the fills.
        var _ntFillsEnabled = false;

        var _NT_DRAFT_KEY = 'new-trade-draft';

        function _ntSaveDraft() {
            var ids = [
                'trade-broker-account','asset-type','symbol','trade-type',
                'quantity','entry-price','exit-price','entry-time','exit-time',
                'commission-fees','setup-type','quick-notes',
                'option-action','option-type-input','strike-input','expiry-input'
            ];
            var core = {};
            ids.forEach(function(id) {
                var el = document.getElementById(id);
                if (el) core[id] = el.value;
            });
            var rulesEl = document.getElementById('rules-list');
            var rules = [];
            if (rulesEl) {
                rulesEl.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
                    if (!cb.checked) return;
                    var m = (cb.id || '').match(/^rule-(.+)$/);
                    if (m) rules.push(m[1]);
                });
            }
            Autosave.save(_NT_DRAFT_KEY, {
                core: core,
                rules: rules,
                targets: _getRowData('plan-rows', 'target-price', 'target-qty'),
                stops:   _getRowData('plan-rows', 'stop-price', 'stop-qty'),
                createdTradeId: _ntCreatedTradeId,
                createdTradeSaved: _ntCreatedSaved,
                // Multi-fill mode persistence
                multiFillEnabled: !!_ntFillsEnabled,
                fills: _ntFillsEnabled ? _ntSerializeFillRows() : [],
                // Reflection fields
                tradeGrade: (document.getElementById('nt-trade-grade') || {}).value || '',
                tags: _ntGetTagsFromRows(),
                notes: _ntGetNotes()
            });
        }

        function _ntClearDraft() {
            Autosave.clear(_NT_DRAFT_KEY);
        }

        // ── Global draft cleanup ────────────────────────────────────
        // Clears ALL localStorage drafts (New Trade, old Edit Trade,
        // Journal notes). Called on lock, account delete, and anywhere
        // stale cross-context drafts must not survive.
        window._clearAllDrafts = function () {
            Autosave.clear(_NT_DRAFT_KEY);
            // Clear all per-trade drafts, including old Edit Trade drafts (etp-draft-)
            try {
                var keys = [];
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    if (k && (k.indexOf('etp-draft-') === 0 || k.indexOf('jnl-notes-draft-') === 0 || k.indexOf('rv-draft-') === 0)) {
                        keys.push(k);
                    }
                }
                keys.forEach(function (k) { localStorage.removeItem(k); });
            } catch (e) {}
        };

        // ── Open-trade helper ────────────────────────────────────
        // A trade is "open" if it lacks exit data. Closed = has both
        // exitTime and a numeric exitPrice.
        function _isOpenTrade(t) {
            return !t.exitTime || t.exitPrice == null;
        }
        window._isOpenTrade = _isOpenTrade;

        // Minimum condition for record creation: symbol + quantity +
        // entry price + entry time.  Exit fields are optional so users
        // can create open (in-progress) trades.
        function _ntCanCreate() {
            return !!(
                (document.getElementById('symbol') || {}).value &&
                parseFloat((document.getElementById('quantity') || {}).value) &&
                parseFloat((document.getElementById('entry-price') || {}).value) &&
                (document.getElementById('entry-time') || {}).value
            );
        }

        // Build a trade object from the current DOM state.
        // Supports open trades (no exit fields) — realized P&L fields
        // are set to null when exit data is missing.
        function _ntBuildTrade(existingId) {
            var entryPrice     = parseFloat(document.getElementById('entry-price').value) || 0;
            var exitPriceRaw   = document.getElementById('exit-price').value;
            var exitPrice      = exitPriceRaw !== '' ? parseFloat(exitPriceRaw) : null;
            var quantity        = parseFloat(document.getElementById('quantity').value) || 0;
            var tradeType      = document.getElementById('trade-type').value;
            var commissionFees = parseFloat(document.getElementById('commission-fees').value) || 0;
            var entryTimeVal   = document.getElementById('entry-time').value;
            var exitTimeVal    = document.getElementById('exit-time').value;
            var entryTime      = entryTimeVal ? new Date(entryTimeVal) : new Date();
            // Exit Time only counts once an exit price is entered; an open
            // trade saves exitTime null.
            var exitTime       = (exitTimeVal && exitPrice != null) ? new Date(exitTimeVal) : null;
            var assetType = document.getElementById('asset-type').value;

            var isOpen = (exitPrice == null || !exitTime);
            var ntMult = _contractMultiplier(assetType);
            var grossPnl, pnl;
            if (isOpen) {
                grossPnl = null;
                pnl = null;
            } else {
                grossPnl = tradeType === 'long'
                    ? (exitPrice - entryPrice) * quantity * ntMult
                    : (entryPrice - exitPrice) * quantity * ntMult;
                pnl = grossPnl - commissionFees;
            }

            var profitTargets = _getRowData('plan-rows', 'target-price', 'target-qty');
            var stopLosses    = _getRowData('plan-rows', 'stop-price', 'stop-qty');
            var tm = isOpen ? {} : _computeTradeMetrics(entryPrice, exitPrice, quantity, tradeType, commissionFees, profitTargets, stopLosses, assetType);

            // Skip strategy scoring for open trades — pnl is not yet known
            var strategyScore = null;
            if (!isOpen && selectedStrategyForTrade) {
                strategyScore = calculateStrategyScore(selectedStrategyForTrade, followedRules, pnl);
            }

            // Multi-fill mode
            var _builtFills = null;
            if (_ntFillsEnabled) {
                var _fillsCollected = _ntReadFillRows();
                if (_fillsCollected.length > 1) _builtFills = _fillsCollected;
            }

            var _trade = {
                id:              existingId || Date.now(),
                symbol:          (document.getElementById('symbol').value || '').toUpperCase(),
                type:            tradeType,
                quantity:        quantity,
                entryPrice:      entryPrice,
                exitPrice:       exitPrice,
                entryTime:       entryTime.toISOString(),
                exitTime:        exitTime ? exitTime.toISOString() : null,
                holdSeconds:     (isOpen || !exitTime) ? null : (exitTime - entryTime) / 1000,
                grossPnl:        grossPnl,
                pnl:             pnl,
                feeSource:       commissionFees > 0 ? 'manual' : undefined,
                brokerAccountId: document.getElementById('trade-broker-account').value || '',
                assetType:       assetType,
                optionAction:    assetType === 'option' ? document.getElementById('option-action').value : null,
                optionType:      assetType === 'option' ? document.getElementById('option-type-input').value : null,
                strike:          assetType === 'option' ? (parseFloat(document.getElementById('strike-input').value) || 0) : 0,
                expiry:          assetType === 'option' ? (document.getElementById('expiry-input').value || null) : null,
                setupType:       document.getElementById('setup-type').value,
                strategyScore:   strategyScore,
                quickNotes:      document.getElementById('quick-notes').value,
                source:          'manual',
                commissionFees:  commissionFees,
                profitTargets:   profitTargets,
                stopLosses:      stopLosses,
                drawdown:          tm.drawdown || null,
                runup:             tm.runup || null,
                initialTarget:     tm.initialTarget || null,
                tradeRisk:         tm.tradeRisk || null,
                plannedRMultiple:  tm.plannedRMultiple || null,
                realizedRMultiple: tm.realizedRMultiple || null,
                tradeGrade:      (document.getElementById('nt-trade-grade') || {}).value || '',
                tags:            _ntGetTagsFromRows(),
                notes:           _ntGetNotes(),
                notesUpdatedAt:  Date.now()
            };
            if (_builtFills) _trade.fills = _builtFills;
            // Skip finalizeTradeSummary for open trades — it derives
            // exit-dependent fields that don't apply yet.
            return _roundTradeForSave(isOpen ? _trade : finalizeTradeSummary(_trade));
        }

        // The trades are fully loaded: always outside cloud_primary; in it,
        // once auth.js has loaded the cloud this session (not paused on this
        // browser's copy). Read-only use of auth.js's flags.
        function _ntTradesLoaded() {
            if (window._denariiStorageMode !== 'cloud_primary') return true;
            return typeof _cloudBaselineReady !== 'undefined' && _cloudBaselineReady === true
                && !(typeof _cloudPaused !== 'undefined' && _cloudPaused);
        }

        // The form's trade was saved before and, with the trades loaded, is no
        // longer there: it was deleted elsewhere.
        function _ntTradeWasDeleted() {
            if (!_ntCreatedTradeId || !_ntCreatedSaved || !_ntTradesLoaded()) return false;
            // Cloud-loaded ids are strings; the form's id may be a number.
            return !(journalData.trades || []).some(function(t) { return String(t.id) === String(_ntCreatedTradeId); });
        }

        async function _ntCommitTrade(opts) {
            opts = opts || {};

            // Multi-fill: a partly filled row would be skipped by
            // _ntReadFillRows, so stop before anything changes. Explicit
            // saves name the row; background autosave just waits. Runs
            // before _ntCanCreate: a missing fill entry leaves the greyed
            // summary blank, which would otherwise return with no message.
            if (_ntFillsEnabled === true) {
                var _badFill = _ntFindIncompleteFillRow(_ntSerializeFillRows());
                if (_badFill) {
                    if (opts.explicit || opts.reportFillErrors) _ntShowFillError(_badFill);
                    return false;
                }
            }
            if (!_ntCanCreate()) return false;

            var _NT_STATUS_ID = 'nt-autosave-status';
            // A clear (Discard, Save) while this save is in flight starts a
            // new form; this save must not mark that form as saved.
            var _ntGen = _ntFormGen;

            // Undone if the cloud save fails; the form and draft keep the input.
            var _ntBefore = null, _ntPushed = false;
            // Matched as strings: after a reload or re-sync the stored id is a
            // string while the form's (draft) id may be a number.
            var existing = _ntCreatedTradeId
                ? journalData.trades.find(function(t) { return String(t.id) === String(_ntCreatedTradeId); })
                : null;
            if (existing) {
                // Update the already-created record under its stored id, so
                // the id type in saved data never changes.
                _ntCreatedTradeId = existing.id;
                _ntBefore = JSON.parse(JSON.stringify(existing));
                var updated = _ntBuildTrade(_ntCreatedTradeId);
                Object.assign(existing, updated);
            } else if (_ntCreatedTradeId && _ntCreatedSaved) {
                // Saved earlier and now missing: never recreate it. The form
                // keeps the input. Once the trades have loaded it was deleted;
                // before that it is a plain failed save, retried later.
                Autosave.showStatus(_NT_STATUS_ID, 'failed');
                if (_ntTradeWasDeleted()) {
                    var _ntStatusEl = document.getElementById(_NT_STATUS_ID);
                    if (_ntStatusEl) _ntStatusEl.textContent = 'This trade was deleted';
                }
                return false;
            } else {
                // First creation, or a retry of one that never saved: the
                // same id every time.
                var trade = _ntBuildTrade(_ntCreatedTradeId);
                _ntCreatedTradeId = trade.id;
                journalData.trades.push(trade);
                _ntPushed = true;
                // The id reaches the draft before the save, so a reload mid-save
                // still continues this trade.
                _ntSaveDraft();
            }

            Autosave.showStatus(_NT_STATUS_ID, 'saving');
            try {
                // Cloud-primary: upsert the new/updated trade to Supabase
                if (_isCloudPrimarySave()) {
                    var _ntTrade = journalData.trades.find(function(t) { return String(t.id) === String(_ntCreatedTradeId); });
                    if (_ntTrade) {
                        var _csRes = await _saveTradeToSupabase(_ntTrade);
                        if (!_csRes.success) {
                            if (_ntPushed) {
                                // Keep _ntCreatedTradeId: the retry reuses it.
                                var _ntIdx = journalData.trades.indexOf(_ntTrade);
                                if (_ntIdx >= 0) journalData.trades.splice(_ntIdx, 1);
                            } else if (_ntBefore) {
                                _restoreTradeInPlace(_ntTrade, _ntBefore);
                            }
                            throw new Error(_csRes.error);
                        }
                        _triggerCloudDashRefresh();
                    }
                }
                await saveToIndexedDB();
            } catch (e) {
                Autosave.showStatus(_NT_STATUS_ID, 'failed');
                return false;
            }
            if (_ntGen === _ntFormGen && !_ntCreatedSaved) {
                _ntCreatedSaved = true;
                if (!opts.explicit) _ntSaveDraft();
            }
            // Keep draft alive after background autosave so a page reload can
            // restore the form (including option-type, asset-type, etc.).
            // Only clear on explicit save (Save Trade / Save & Journal) which
            // resets the form and navigates away.
            if (opts.explicit) _ntClearDraft();
            Autosave.showStatus(_NT_STATUS_ID, 'saved');

            if (opts.explicit) {
                _ntResetForm();
                updateDashboard();
                document.querySelector('[data-tab="dashboard"]').click();
            }
            return true;
        }

        // ── New Trade: Grade pills ──────────────────────────────────
        var _NT_GRADES = ['A+', 'A', 'B', 'C', 'D', 'F'];
        var _NT_GRADE_COLORS = { 'A+': '#22c55e', 'A': '#4ade80', 'B': '#60a5fa', 'C': '#facc15', 'D': '#fb923c', 'F': '#f87171' };

        function _ntRenderGradePills() {
            var container = document.getElementById('nt-grade-pills');
            if (!container) return;
            container.innerHTML = _NT_GRADES.map(function (g) {
                var color = _NT_GRADE_COLORS[g];
                return '<button type="button" class="jnl-grade-pill" data-grade="' + g + '" ' +
                    'style="padding:5px 18px;border-radius:20px;border:1px solid var(--border);background:transparent;' +
                    'color:var(--text-secondary);font-size:14px;font-weight:500;cursor:pointer;' +
                    'transition:background 0.15s,border-color 0.15s,color 0.15s;letter-spacing:0.02em;" ' +
                    'onclick="_ntSelectGrade(\'' + g + '\')">' + g + '</button>';
            }).join('');
        }

        window._ntSelectGrade = function (grade) {
            var input = document.getElementById('nt-trade-grade');
            var current = input ? input.value : '';
            _ntSetGrade(current === grade ? '' : grade);
        };

        function _ntSetGrade(grade) {
            var input = document.getElementById('nt-trade-grade');
            if (input) input.value = grade;
            var container = document.getElementById('nt-grade-pills');
            if (!container) return;
            if (!container.children.length) _ntRenderGradePills();
            container.querySelectorAll('.jnl-grade-pill').forEach(function (btn) {
                var isSelected = btn.dataset.grade === grade;
                var color = _NT_GRADE_COLORS[btn.dataset.grade] || 'var(--accent)';
                btn.style.background  = isSelected ? color : 'transparent';
                btn.style.borderColor = isSelected ? color : 'var(--border)';
                btn.style.color       = isSelected ? '#fff' : 'var(--text-secondary)';
                btn.style.fontWeight  = isSelected ? '700' : '500';
            });
        }

        // ── New Trade: Tags ─────────────────────────────────────────
        window.addNtTagRow = function (category, tagName) {
            var container = document.getElementById('nt-tag-rows');
            if (!container) return;
            var categories = (journalData.tagCategories || []).filter(function (c) {
                return typeof window.isCategoryFavorite === 'function' ? window.isCategoryFavorite(c) : true;
            });
            var tagMap = {};
            (journalData.tags || []).filter(function (t) { return t.isFavorite !== false; }).forEach(function (t) {
                if (!tagMap[t.category]) tagMap[t.category] = [];
                tagMap[t.category].push(t.name);
            });
            var catOpts = categories.map(function (c) {
                return '<option value="' + escapeHtml(c) + '"' + (c === category ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
            }).join('');
            var catTags = category ? (tagMap[category] || []) : [];
            var tagOpts = catTags.map(function (n) {
                return '<option value="' + escapeHtml(n) + '"' + (n === tagName ? ' selected' : '') + '>' + escapeHtml(n) + '</option>';
            }).join('');

            var row = document.createElement('div');
            row.className = 'jnl-tag-row';
            row.innerHTML =
                '<select class="jnl-tag-cat" onchange="_ntOnCategoryChange(this)">' +
                    '<option value="">Select category...</option>' + catOpts +
                '</select>' +
                '<select class="jnl-tag-name"' + (!category ? ' disabled' : '') + '>' +
                    (!category
                        ? '<option value="">Select category first</option>'
                        : '<option value="">Select tag...</option>' + tagOpts) +
                '</select>' +
                '<button type="button" class="btn btn-small plan-remove-btn" onclick="_ntRemoveTagRow(this)" ' +
                'style="background:var(--danger);color:var(--on-danger);padding:2px 9px;flex-shrink:0;font-size:15px;line-height:1.3;">\u00d7</button>';
            container.appendChild(row);
            _ntSyncTagRemoveBtns();
        };

        window._ntRemoveTagRow = function (btn) {
            var row = btn.closest('.jnl-tag-row');
            if (row) row.remove();
            _ntSyncTagRemoveBtns();
        };

        function _ntSyncTagRemoveBtns() {
            var container = document.getElementById('nt-tag-rows');
            if (!container) return;
            var rows = container.querySelectorAll('.jnl-tag-row');
            rows.forEach(function (r) {
                var btn = r.querySelector('.plan-remove-btn');
                if (btn) btn.style.visibility = rows.length > 1 ? 'visible' : 'hidden';
            });
        }

        window._ntOnCategoryChange = function (catSel) {
            var row = catSel.closest('.jnl-tag-row');
            if (!row) return;
            var tagSel = row.querySelector('.jnl-tag-name');
            if (!tagSel) return;
            var category = catSel.value;
            if (!category) {
                tagSel.innerHTML = '<option value="">Select category first</option>';
                tagSel.disabled = true;
                return;
            }
            var catTags = (journalData.tags || []).filter(function (t) { return t.category === category && t.isFavorite !== false; });
            tagSel.disabled = false;
            tagSel.innerHTML = '<option value="">Select tag...</option>' +
                catTags.map(function (t) { return '<option value="' + escapeHtml(t.name) + '">' + escapeHtml(t.name) + '</option>'; }).join('');
        };

        function _ntGetTagsFromRows() {
            var container = document.getElementById('nt-tag-rows');
            if (!container) return [];
            var seen = {};
            var result = [];
            container.querySelectorAll('.jnl-tag-row').forEach(function (row) {
                var cat = (row.querySelector('.jnl-tag-cat') || {}).value || '';
                var tag = (row.querySelector('.jnl-tag-name') || {}).value || '';
                if (tag && cat) {
                    var key = cat + '::' + tag;
                    if (!seen[key]) { seen[key] = true; result.push(tag); }
                }
            });
            return result;
        }

        function _ntInitTagRows(tagNames) {
            var container = document.getElementById('nt-tag-rows');
            if (!container) return;
            container.innerHTML = '';
            var names = Array.isArray(tagNames) ? tagNames.filter(Boolean) : [];
            if (!names.length) return; // no default rows on New Trade
            var tagCatMap = {};
            (journalData.tags || []).forEach(function (t) { tagCatMap[t.name] = t.category || 'Custom'; });
            names.forEach(function (name) { addNtTagRow(tagCatMap[name] || '', name); });
        }

        // ── New Trade: Reflection notes ─────────────────────────────
        function _ntGetNotes() {
            var el = document.getElementById('nt-notes');
            if (!el) return '';
            var html = el.innerHTML.trim();
            return (html === '' || html === '<br>') ? '' : html;
        }

        function _ntSetNotes(content) {
            var el = document.getElementById('nt-notes');
            if (!el) return;
            el.innerHTML = content || '';
        }

        window._ntOnNotesInput = function () {
            _ntFormDirty = true;
            _ntSaveDraft();
            Autosave.showStatus('nt-autosave-status', 'unsaved');
        };

        // Template apply for New Trade reflection editor — mirrors
        // applyNoteTemplate on Trade Reflection (empty → insert, else append
        // with separator + date). Ids are matched as strings via _tmFind.
        window._ntApplyTemplate = function (templateId) {
            if (!templateId) return;
            var tpl = _tmFind(templateId);
            if (!tpl) return;
            var el = document.getElementById('nt-notes');
            if (!el) return;
            var raw = tpl.content || '';
            var tmplHtml = /<[a-z][\s\S]*>/i.test(raw) ? raw : raw.split('\n\n').map(function (p) {
                return p.trim() ? '<p>' + p.replace(/\n/g, '<br>') + '</p>' : '<p><br></p>';
            }).join('');
            if (!_ntGetNotes()) {
                el.innerHTML = tmplHtml;
            } else {
                var months = ['January','February','March','April','May','June',
                              'July','August','September','October','November','December'];
                var d = new Date();
                var sessionDate = months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
                var sep = '------------------------------------------------------------------------------------------------';
                el.innerHTML = el.innerHTML + '<p><br></p><p>' + sep + '</p><p>' + escapeHtml(sessionDate) + '</p>' + tmplHtml;
            }
            el.focus();
            window._ntOnNotesInput();
        };

        // ── Clean Up with AI (New Trade + Trade Reflection) ─────────
        // Bullets or Paragraphs; shared by every reflection editor (marked with
        // data-note-cleanup-format), separate from the planners' choice.
        var NOTE_CLEANUP_FORMAT_KEY = 'denarii_note_cleanup_format';

        window._noteCleanupSavedFormat = function () {
            try { return localStorage.getItem(NOTE_CLEANUP_FORMAT_KEY) === 'paragraphs' ? 'paragraphs' : 'bullets'; }
            catch (e) { return 'bullets'; }
        };

        window.noteCleanupFormatChange = function (val) {
            val = val === 'paragraphs' ? 'paragraphs' : 'bullets';
            try { localStorage.setItem(NOTE_CLEANUP_FORMAT_KEY, val); } catch (e) {}
            document.querySelectorAll('[data-note-cleanup-format]').forEach(function (s) { s.value = val; });
        };

        window._noteCleanupAccount = function () {
            return typeof currentAccountId !== 'undefined' ? currentAccountId : null;
        };

        document.querySelectorAll('[data-note-cleanup-format]').forEach(function (s) { s.value = window._noteCleanupSavedFormat(); });

        // Bumped whenever the New Trade form is cleared or refilled from a draft,
        // so a cleanup that finishes afterwards is not written into another trade.
        var _ntFormGen = 0;
        var _ntCleanupBusy = false;

        function _ntCleanupMsg(text, isError) {
            var el = document.getElementById('nt-cleanup-msg');
            if (!el) return;
            el.textContent = text;
            el.style.color = isError ? 'var(--danger)' : 'var(--text-secondary)';
        }

        // Appends below the notes; the original text is never replaced. Like
        // typing in the notes, this only updates the draft: the trade record
        // takes it on Save Trade.
        window.ntCleanUpAI = function () {
            if (_ntCleanupBusy || typeof _noteCleanup !== 'function') return;
            var ed = document.getElementById('nt-notes');
            if (!ed) return;
            var gen = _ntFormGen, acct = window._noteCleanupAccount();
            var sel = document.getElementById('nt-cleanup-format');
            var btn = document.getElementById('nt-cleanup-btn');
            _ntCleanupBusy = true;
            if (btn) btn.disabled = true;
            _ntCleanupMsg('Cleaning up…');
            return _noteCleanup('trade', ed, sel && sel.value === 'paragraphs' ? 'paragraphs' : 'bullets').then(function (res) {
                _ntCleanupBusy = false;
                if (btn) btn.disabled = false;
                if (!res.ok) { _ntCleanupMsg(res.message, true); return; }
                // The form was saved, cleared or the account changed during the call.
                if (_ntFormGen !== gen || window._noteCleanupAccount() !== acct) {
                    _ntCleanupMsg('Cleanup discarded because the trade changed. Try again.', true);
                    return;
                }
                var cur = document.getElementById('nt-notes');
                if (!cur) return;
                cur.insertAdjacentHTML('beforeend', res.block);
                window._ntOnNotesInput();
                _ntCleanupMsg('Cleaned-up version added below. Click Save Trade to keep it.');
            });
        };

        // Populate template selector for New Trade — same favorites/timeframe
        // rules as the Trade Reflection dropdown.
        function _ntPopulateTemplates() {
            var sel = document.getElementById('nt-template-select');
            if (!sel) return;
            sel.innerHTML = '<option value="">Select template…</option>' +
                _favoriteTemplatesFor('trade').map(function (t) {
                    return '<option value="' + escapeHtml(String(t.id)) + '">' + escapeHtml(t.name) + '</option>';
                }).join('');
        }

        // Init toolbar for New Trade editor. editor-toolbar.js loads after
        // Denarii.js (both deferred), so wait for DOMContentLoaded if needed.
        (function _ntInitToolbar() {
            function mount() {
                var slot = document.getElementById('nt-toolbar-slot');
                if (!slot || typeof EditorToolbar === 'undefined') return;
                slot.innerHTML = EditorToolbar.build('nt-notes');
            }
            if (typeof EditorToolbar !== 'undefined') mount();
            else document.addEventListener('DOMContentLoaded', mount);
        })();

        // Init grade pills
        _ntRenderGradePills();

        function _ntResetForm() {
            var form = document.getElementById('trade-form');
            if (form) form.reset();
            var _planRows = document.getElementById('plan-rows');
            if (_planRows) _planRows.innerHTML = '';
            addPlanRow('plan-rows');
            _recalcNewMetrics();
            toggleOptionFields();
            selectedStrategyForTrade = null;
            followedRules = [];
            document.getElementById('strategy-rules-checklist').style.display = 'none';
            _ntCreatedTradeId = null;
            _ntCreatedSaved = false;
            _ntFormDirty = false;
            if (_ntCommitTimer) { clearTimeout(_ntCommitTimer); _ntCommitTimer = null; }
            // Reset multi-fill mode to off so the next trade starts on the
            // default single-fill UI.
            _ntFillsEnabled = false;
            var _ntFillsBody = document.getElementById('nt-fills-body');
            if (_ntFillsBody) _ntFillsBody.style.display = 'none';
            var _ntFillsBtn = document.getElementById('nt-fills-toggle');
            if (_ntFillsBtn) _ntFillsBtn.textContent = 'Use Multiple Fills';
            var _ntFillsRowsEl = document.getElementById('nt-fills-rows');
            if (_ntFillsRowsEl) _ntFillsRowsEl.innerHTML = '';
            _ntSetSummaryLocked(false);
            // Clear reflection fields
            _ntSetGrade('');
            var ntTagRows = document.getElementById('nt-tag-rows');
            if (ntTagRows) ntTagRows.innerHTML = '';
            _ntSetNotes('');
            _ntFormGen++;
            _ntCleanupMsg('');
            _ntPopulateTemplates();
            _ntClearDraft();
            _ntDraftRestored = false; // allow re-check on next visit
            // Clear the status chip on form reset
            Autosave.showStatus('nt-autosave-status', '');
        }

        var _ntCommitTimer = null;
        var _ntCommitMs = 1000;
        function _ntScheduleCommit() {
            Autosave.showStatus('nt-autosave-status', 'unsaved');
            clearTimeout(_ntCommitTimer);
            _ntCommitTimer = setTimeout(function() {
                _ntCommitTimer = null;
                _ntQueueCommit();
            }, _ntCommitMs);
        }
        function _ntFlushCommit() {
            if (_ntCommitTimer) { clearTimeout(_ntCommitTimer); _ntCommitTimer = null; }
            return _ntQueueCommit();
        }

        // One New Trade save at a time: each waits for the one before it, and
        // background requests made while one is already waiting share it.
        // Explicit saves (opts given) always get their own turn and result.
        var _ntCommitTail = Promise.resolve();
        var _ntCommitWaiting = null;
        function _ntQueueCommit(opts) {
            if (!opts && _ntCommitWaiting) return _ntCommitWaiting;
            var p = _ntCommitTail.then(function() {
                if (_ntCommitWaiting === p) _ntCommitWaiting = null;
                return _ntCommitTrade(opts);
            });
            if (!opts) _ntCommitWaiting = p;
            _ntCommitTail = p.catch(function() {});
            return p;
        }

        // Window-level triggers
        if (!window._ntAutosaveBound) {
            window._ntAutosaveBound = true;
            document.addEventListener('visibilitychange', function() {
                if (document.visibilityState === 'hidden' && _ntCanCreate()) _ntFlushCommit();
            });
            window.addEventListener('pagehide', function() { if (_ntCanCreate()) _ntFlushCommit(); });
            window.addEventListener('beforeunload', function() { if (_ntCanCreate()) _ntFlushCommit(); });
        }

        // Form-scoped delegation
        (function() {
            var form = document.getElementById('trade-form');
            if (!form || form.dataset.ntAutosaveBound) return;
            form.dataset.ntAutosaveBound = '1';
            form.addEventListener('input', function(ev) {
                var t = ev.target;
                if (!t || (t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA' && t.tagName !== 'SELECT')) return;
                _ntFormDirty = true;
                _ntSaveDraft();
                Autosave.showStatus('nt-autosave-status', 'unsaved');
                if (_ntCanCreate()) _ntScheduleCommit();
            });
            form.addEventListener('change', function(ev) {
                if (!ev.target) return;
                _ntFormDirty = true;
                _ntSaveDraft();
                Autosave.showStatus('nt-autosave-status', 'unsaved');
                if (_ntCanCreate()) _ntFlushCommit();
            });
            form.addEventListener('focusout', function(ev) {
                var t = ev.target;
                if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && _ntCanCreate()) {
                    _ntFlushCommit();
                }
            });
        })();

        // Draft restore — runs once when New Trade is first activated (after
        // login, when journalData is already loaded from the local database).
        var _ntDraftRestored = false;
        function _ntTryRestoreDraft() {
            if (_ntDraftRestored) return;
            _ntDraftRestored = true;
            var draft = Autosave.load(_NT_DRAFT_KEY);
            if (draft) _ntApplyDraft(draft);
        }

        function _ntApplyDraft(draft) {
            if (!draft || !draft.core) return;
            _ntFormGen++;

            // ── Stale-context guard ─────────────────────────────────
            // If the draft references a broker account that no longer
            // exists in journalData, it survived a broker/account
            // deletion boundary. Discard it instead of restoring stale
            // fields and locks.
            var draftBroker = draft.core['trade-broker-account'];
            if (draftBroker && draftBroker !== '') {
                var brokerExists = (journalData.brokerAccounts || []).some(function (a) {
                    return String(a.id) === String(draftBroker);
                });
                if (!brokerExists) {
                    _ntClearDraft();
                    return;
                }
            }

            Object.keys(draft.core).forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.value = draft.core[id] != null ? draft.core[id] : '';
            });
            toggleOptionFields();
            _rehydratePlanRows('plan-rows', draft.targets, draft.stops);
            if (Array.isArray(draft.rules) && draft.rules.length) {
                var setupVal = draft.core['setup-type'] || '';
                if (setupVal) {
                    loadStrategyRules(setupVal);
                    var rulesListEl = document.getElementById('rules-list');
                    if (rulesListEl) {
                        rulesListEl.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
                            cb.checked = false;
                        });
                        draft.rules.forEach(function(rid) {
                            var cb = document.getElementById('rule-' + rid);
                            if (cb) cb.checked = true;
                        });
                        if (typeof updateRuleScore === 'function') updateRuleScore();
                    }
                }
            }
            _ntFormDirty = true;
            if (draft.createdTradeId) {
                // Continue the draft's trade id, even before the trades load,
                // so this form never creates a second trade. Older drafts have
                // no createdTradeSaved and count as saved: a trade missing
                // from the loaded list is then never recreated.
                _ntCreatedTradeId = draft.createdTradeId;
                _ntCreatedSaved = draft.createdTradeSaved !== false;
            }

            // Restore multi-fill mode when the previous session had it on.
            // Applied after core fields so any derived recompute wins.
            if (draft.multiFillEnabled) {
                _ntEnsureFillsSection();
                _ntFillsEnabled = true;
                var _body = document.getElementById('nt-fills-body');
                var _btn  = document.getElementById('nt-fills-toggle');
                if (_body) _body.style.display = '';
                if (_btn)  _btn.textContent = 'Use Single Fill';
                _ntSetSummaryLocked(true);
                var _rowsC = document.getElementById('nt-fills-rows');
                if (_rowsC) _rowsC.innerHTML = '';
                if (Array.isArray(draft.fills)) {
                    draft.fills.forEach(function(f) { ntAddFillRow(f); });
                }
                _ntRecomputeFromFills();
            }

            // Restore reflection fields from draft
            if (draft.tradeGrade) _ntSetGrade(draft.tradeGrade);
            if (Array.isArray(draft.tags) && draft.tags.length) _ntInitTagRows(draft.tags);
            if (draft.notes) _ntSetNotes(draft.notes);

            _recalcNewMetrics();
        }

        // ── Multi-fill entry on New Trade ─────────────────────────────────────
        // The UI panel is mounted once directly below the execution-fields row
        // (Qty / Entry / Exit / times / Commission) and above the strategy
        // rules section. It is hidden by default so the standard single-fill
        // experience is unchanged. When the user toggles it on, the summary
        // inputs are locked (readOnly — values still submit with the form)
        // and the derived totals are written into them as rows change. At
        // save time, _ntBuildTrade attaches fills[] when there is more than
        // one valid row and lets finalizeTradeSummary derive the canonical
        // summary scalars, so option 100x math and commission totals stay
        // consistent with the rest of the app.

        function _ntEscAttr(v) {
            return (v == null ? '' : String(v)).replace(/&/g, '&amp;')
                                                .replace(/"/g, '&quot;')
                                                .replace(/</g, '&lt;')
                                                .replace(/>/g, '&gt;');
        }

        function _ntIsoToLocalInput(iso) {
            if (!iso) return '';
            var d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            var p = function(n) { return String(n).padStart(2, '0'); };
            return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate())
                + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
        }

        function _ntSetSummaryLocked(locked) {
            ['quantity','entry-price','exit-price','entry-time','exit-time','commission-fees'].forEach(function(id) {
                var el = document.getElementById(id);
                if (!el) return;
                // readOnly keeps the field in form submission (still required)
                // while preventing direct user edits.
                el.readOnly = !!locked;
                el.style.backgroundColor = locked ? 'var(--bg-secondary)' : '';
                el.style.cursor = locked ? 'not-allowed' : '';
            });
        }

        // Fill grid columns, same widths as the Trade Reflection fills grid:
        // #, Qty, % Pos., 4 price/time inputs, Fees, P&L, % Gain, remove.
        var _NT_FILL_COLS = '28px 72px 62px repeat(4, minmax(0,1fr)) 72px 92px 74px 32px';
        var _NT_CALC_CELL = 'font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
        // Calculated columns are right-aligned so the numbers line up.
        var _NT_CALC_NUM = _NT_CALC_CELL + ' text-align:right;';
        var _NT_CALC_HEAD = 'white-space:nowrap; text-align:right;';

        function _ntEnsureFillsSection() {
            if (document.getElementById('nt-fills-section')) return;
            var anchor = document.getElementById('commission-fees');
            if (!anchor) return;
            var grid = anchor.closest('.form-grid') || anchor.parentElement;
            if (!grid || !grid.parentElement) return;
            var section = document.createElement('div');
            section.id = 'nt-fills-section';
            section.style.margin = '8px 0 16px';
            section.innerHTML = ''
                + '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap;">'
                    + '<div>'
                        + '<label style="margin:0;">Execution Rows</label>'
                        + '<span style="font-size:11px; color:var(--text-secondary); margin-left:6px;">(optional — enable to enter multiple fills for one logical trade)</span>'
                    + '</div>'
                    + '<button id="nt-fills-toggle" type="button" class="btn btn-small btn-secondary" onclick="ntToggleFills()">Use Multiple Fills</button>'
                + '</div>'
                + '<div id="nt-fills-body" style="display:none; background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; padding:10px 12px;">'
                    + '<div class="nt-fills-header" style="display:grid; grid-template-columns:' + _NT_FILL_COLS + '; gap:6px; margin-bottom:6px; font-size:10px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.05em;">'
                        + '<span></span>'
                        + '<span>Qty</span>'
                        + '<span style="' + _NT_CALC_HEAD + '">% Pos.</span>'
                        + '<span>Entry</span>'
                        + '<span>Exit</span>'
                        + '<span>Entry time</span>'
                        + '<span>Exit time</span>'
                        + '<span>Fees</span>'
                        + '<span style="' + _NT_CALC_HEAD + '">P&amp;L</span>'
                        + '<span style="' + _NT_CALC_HEAD + '">% Gain</span>'
                        + '<span></span>'
                    + '</div>'
                    + '<div id="nt-fills-rows"></div>'
                    // Display-only Total row; outside #nt-fills-rows so save,
                    // validation and serialization never see it.
                    + '<div id="nt-fills-total" style="display:none; grid-template-columns:' + _NT_FILL_COLS + '; gap:6px; align-items:center; font-weight:700; border-top:1px solid var(--border); padding-top:6px; font-size:12px;">'
                        + '<span style="font-size:11px; text-align:center;">Total</span>'
                        + '<span data-nt-tot="qty" style="' + _NT_CALC_CELL + '"></span>'
                        + '<span data-nt-tot="pos" style="' + _NT_CALC_NUM + '"></span>'
                        + '<span data-nt-tot="entry" style="' + _NT_CALC_CELL + '"></span>'
                        + '<span data-nt-tot="exit" style="' + _NT_CALC_CELL + '"></span>'
                        + '<span></span>'
                        + '<span></span>'
                        + '<span data-nt-tot="fees" style="' + _NT_CALC_CELL + '"></span>'
                        + '<span data-nt-tot="pnl" style="' + _NT_CALC_NUM + '"></span>'
                        + '<span data-nt-tot="gain" style="' + _NT_CALC_NUM + '"></span>'
                        + '<span></span>'
                    + '</div>'
                    + '<div id="nt-fills-error" style="display:none; margin-top:4px; font-size:12px; color:var(--danger, #f87171);"></div>'
                    + '<div style="display:flex; justify-content:flex-end; margin-top:6px;">'
                        + '<button type="button" class="btn btn-small btn-primary" onclick="ntAddFillRow()" style="padding:2px 10px; font-size:12px;">+ Add Fill Row</button>'
                    + '</div>'
                + '</div>';
            grid.parentElement.insertBefore(section, grid.nextSibling);

            // Any typed change in a fill row recomputes the canonical summary
            // and writes it back to the summary inputs so the user sees live
            // totals while editing. Delegation survives dynamically added rows.
            var body = document.getElementById('nt-fills-body');
            if (body) {
                body.addEventListener('input', function(ev) {
                    if (ev.target && ev.target.closest('.nt-fill-row')) {
                        _ntClearFillError();
                        _ntRecomputeFromFills();
                    }
                });
            }
            // Asset Type (multiplier) and Side (sign) change the calculated cells.
            ['asset-type', 'trade-type'].forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.addEventListener('change', _ntUpdateMetricGain);
            });
        }

        function ntToggleFills() {
            _ntEnsureFillsSection();
            _ntFillsEnabled = !_ntFillsEnabled;
            var body = document.getElementById('nt-fills-body');
            var btn  = document.getElementById('nt-fills-toggle');
            if (_ntFillsEnabled) {
                if (body) body.style.display = '';
                if (btn)  btn.textContent = 'Use Single Fill';
                _ntSetSummaryLocked(true);
                // Seed one row from the current summary values so the user
                // can see what's being captured.
                var rowsC = document.getElementById('nt-fills-rows');
                if (rowsC && rowsC.children.length === 0) {
                    ntAddFillRow({
                        qty:        document.getElementById('quantity').value,
                        entryPrice: document.getElementById('entry-price').value,
                        exitPrice:  document.getElementById('exit-price').value,
                        entryTime:  document.getElementById('entry-time').value,
                        exitTime:   document.getElementById('exit-time').value,
                        fees:       document.getElementById('commission-fees').value
                    });
                }
            } else {
                if (body) body.style.display = 'none';
                if (btn)  btn.textContent = 'Use Multiple Fills';
                _ntSetSummaryLocked(false);
                // Clear rows so re-enabling starts fresh. Summary values
                // entered manually are preserved in their inputs.
                var rowsC2 = document.getElementById('nt-fills-rows');
                if (rowsC2) rowsC2.innerHTML = '';
            }
            _ntUpdateMetricGain();
            _ntSaveDraft();
        }

        function ntAddFillRow(values) {
            _ntEnsureFillsSection();
            values = values || {};
            var container = document.getElementById('nt-fills-rows');
            if (!container) return;
            var idx = container.children.length + 1;
            var row = document.createElement('div');
            row.className = 'nt-fill-row';
            row.style.cssText = 'display:grid; grid-template-columns:' + _NT_FILL_COLS + '; gap:6px; align-items:center; margin-bottom:6px;';
            // Build inputs with NO value attribute, then populate each via
            // the .value property setter once the row is in the DOM.
            // Rationale: setting datetime-local inputs via the HTML `value`
            // attribute after dynamic innerHTML assignment is unreliable
            // across browsers — values in valid "YYYY-MM-DDTHH:MM" form can
            // still be silently rejected, leaving the field blank. The
            // property setter path is authoritative and works for all
            // input types used here (number + datetime-local), so it also
            // makes seeding from the main summary fields reliable.
            row.innerHTML = ''
                + '<span class="nt-fill-idx" style="font-size:11px; color:var(--text-secondary); text-align:center;">#' + idx + '</span>'
                + '<input data-nt-fill="qty"          type="number"         placeholder="Qty"    step="1"    min="1">'
                + '<span data-nt-calc="pos"  style="' + _NT_CALC_NUM + '">--</span>'
                + '<input data-nt-fill="entry-price"  type="number"         placeholder="Entry"  step="0.0001">'
                + '<input data-nt-fill="exit-price"   type="number"         placeholder="Exit"   step="0.0001">'
                + '<input data-nt-fill="entry-time"   type="datetime-local">'
                + '<input data-nt-fill="exit-time"    type="datetime-local">'
                + '<input data-nt-fill="fees"         type="number"         placeholder="Fees"   step="0.01" min="0">'
                + '<span data-nt-calc="pnl"  style="' + _NT_CALC_NUM + '">--</span>'
                + '<span data-nt-calc="gain" style="' + _NT_CALC_NUM + '">--</span>'
                + '<button type="button" class="btn btn-small btn-secondary" onclick="ntRemoveFillRow(this)" style="padding:0 6px; font-size:13px;">✕</button>';
            container.appendChild(row);

            // Now seed each input via the .value property.
            var _assign = function(sel, v) {
                var el = row.querySelector(sel);
                if (!el) return;
                el.value = (v == null || v === '') ? '' : String(v);
            };
            _assign('[data-nt-fill="qty"]',         values.qty);
            _assign('[data-nt-fill="entry-price"]', values.entryPrice);
            _assign('[data-nt-fill="exit-price"]',  values.exitPrice);
            _assign('[data-nt-fill="entry-time"]',  values.entryTime);
            _assign('[data-nt-fill="exit-time"]',   values.exitTime);
            _assign('[data-nt-fill="fees"]',        values.fees);

            _ntRecomputeFromFills();
        }

        function ntRemoveFillRow(btn) {
            var row = btn && btn.closest('.nt-fill-row');
            if (!row) return;
            var container = row.parentElement;
            row.remove();
            // Re-number the remaining rows so labels stay contiguous.
            if (container) {
                container.querySelectorAll('.nt-fill-row .nt-fill-idx').forEach(function(el, i) {
                    el.textContent = '#' + (i + 1);
                });
            }
            _ntRecomputeFromFills();
            _ntSaveDraft();
        }

        function _ntSerializeFillRows() {
            var rows = document.querySelectorAll('#nt-fills-rows .nt-fill-row');
            var out = [];
            rows.forEach(function(r) {
                out.push({
                    qty:        (r.querySelector('[data-nt-fill="qty"]')        || {}).value || '',
                    entryPrice: (r.querySelector('[data-nt-fill="entry-price"]')|| {}).value || '',
                    exitPrice:  (r.querySelector('[data-nt-fill="exit-price"]') || {}).value || '',
                    entryTime:  (r.querySelector('[data-nt-fill="entry-time"]') || {}).value || '',
                    exitTime:   (r.querySelector('[data-nt-fill="exit-time"]')  || {}).value || '',
                    fees:       (r.querySelector('[data-nt-fill="fees"]')       || {}).value || ''
                });
            });
            return out;
        }

        // First fill row the user started but did not finish, as
        // { row: 1-based index, field, key }, or null. A row with no qty
        // and no prices counts as empty and is ignored.
        function _ntFindIncompleteFillRow(rows) {
            var checks = [
                ['qty',        'qty'],
                ['entryPrice', 'entry price'],
                ['exitPrice',  'exit price'],
                ['entryTime',  'entry time'],
                ['exitTime',   'exit time']
            ];
            var keys = { qty: 'qty', entryPrice: 'entry-price', exitPrice: 'exit-price', entryTime: 'entry-time', exitTime: 'exit-time' };
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                if (r.qty === '' && r.entryPrice === '' && r.exitPrice === '') continue;
                for (var j = 0; j < checks.length; j++) {
                    var k = checks[j][0], v = r[k];
                    var ok = (k === 'entryTime' || k === 'exitTime')
                        ? (v !== '' && !isNaN(new Date(v).getTime()))
                        : (v !== '' && isFinite(parseFloat(v)) && (k !== 'qty' || parseFloat(v) > 0));
                    if (!ok) return { row: i + 1, field: checks[j][1], key: keys[k] };
                }
            }
            return null;
        }

        // The one validation bubble for the app: New Trade required fields,
        // New Trade and Reflection fill rows, and Reflection's exit fields.
        // App-styled (Denarii.css .field-bubble), arrow pointing at the field.
        // One at a time; editing that field clears it. opts.host is the
        // positioned box it goes in (default: the input's parent);
        // opts.above puts it above the field.
        function _showFieldBubble(input, message, opts) {
            opts = opts || {};
            _clearFieldBubble();
            var host = opts.host || (input && input.parentNode);
            if (!input || !host) return null;
            if (!host.style.position) host.style.position = 'relative';
            var pop = document.createElement('div');
            pop.id = 'field-bubble';
            pop.className = 'field-bubble' + (opts.above ? ' field-bubble--above' : '');
            pop.setAttribute('role', 'alert');
            pop.dataset.for = input.id || '';
            pop.textContent = message;
            var arrow = document.createElement('span');
            arrow.className = 'field-bubble-arrow';
            pop.appendChild(arrow);
            pop.style.left = (input.offsetLeft || 0) + 'px';
            pop.style.top = ((input.offsetTop || 0) + (opts.above ? 0 : (input.offsetHeight || 0))) + 'px';
            host.appendChild(pop);
            var clear = function() {
                if (document.getElementById('field-bubble') === pop) _clearFieldBubble();
            };
            input.addEventListener('input', clear, { once: true });
            input.addEventListener('change', clear, { once: true });
            return pop;
        }

        // forIds: only remove a bubble pointing at one of these input ids.
        function _clearFieldBubble(forIds) {
            var old = document.getElementById('field-bubble');
            if (!old || !old.parentNode) return;
            if (forIds && forIds.indexOf(old.dataset.for) < 0) return;
            old.parentNode.removeChild(old);
        }

        // Fill-row bubble: "<Field> is required".
        function _fillFieldPopup(input, field) {
            return _showFieldBubble(input, field.charAt(0).toUpperCase() + field.slice(1) + ' is required');
        }

        // New Trade runs with novalidate; this is the browser's check
        // (required, step, number format) shown with the app bubble instead.
        // Read-only (greyed multi-fill summary) and disabled fields are
        // skipped, as the browser skips them.
        function _ntCheckRequired(form) {
            var els = form ? form.querySelectorAll('input, select, textarea') : [];
            for (var i = 0; i < els.length; i++) {
                var el = els[i];
                if (el.disabled || el.readOnly || el.willValidate === false) continue;
                if (!el.checkValidity || el.checkValidity()) continue;
                var msg = el.validationMessage;
                if (el.validity && el.validity.valueMissing) {
                    var group = el.closest && el.closest('.form-group');
                    var label = group && group.querySelector('label');
                    msg = (label ? label.textContent.trim() : 'This field') + ' is required';
                }
                _showFieldBubble(el, msg);
                el.focus();
                return false;
            }
            return true;
        }

        // First field _ntCanCreate is missing, as { el, label }, or null.
        function _ntFirstMissingField() {
            var checks = [
                ['symbol',      function(v) { return !!v; }],
                ['quantity',    function(v) { return !!parseFloat(v); }],
                ['entry-price', function(v) { return !!parseFloat(v); }],
                ['entry-time',  function(v) { return !!v; }]
            ];
            for (var i = 0; i < checks.length; i++) {
                var el = document.getElementById(checks[i][0]);
                if (checks[i][1]((el || {}).value)) continue;
                var group = el && el.closest && el.closest('.form-group');
                var label = group && group.querySelector('label');
                return { el: el, label: label ? label.textContent.trim() : checks[i][0] };
            }
            return null;
        }

        // Leaving New Trade with input in the form. A deleted trade asks to
        // Discard the draft. Complete (_ntCanCreate passes, no half-filled
        // fill row; open trades count): wait for the save, then clear the
        // form and go on. A failed save, or one still running after
        // _NT_LEAVE_TIMEOUT_MS, asks Stay / Leave; a late save still finishes
        // on the same trade id. Incomplete: ask Stay / Discard. Never traps
        // the user. Returns true when the page can switch right away.
        var _ntLeaveTarget = null;   // set while the leave save runs
        var _ntLeaveAnyway = false;  // Leave chosen: let that one switch through
        var _NT_LEAVE_TIMEOUT_MS = 10000;
        function _ntBeforeLeave(target) {
            if (_ntLeaveAnyway || !_ntFormDirty) return true;
            if (_ntLeaveTarget) { _ntLeaveTarget = target; return false; }
            if (_ntTradeWasDeleted()) { _ntAskDeletedLeave(target); return false; }
            var bad = _ntFillsEnabled === true ? _ntFindIncompleteFillRow(_ntSerializeFillRows()) : null;
            var miss = bad ? null : _ntFirstMissingField();
            if (!bad && !miss) {
                _ntLeaveTarget = target;
                var settled = false;
                var finish = function(ok) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    var to = _ntLeaveTarget;
                    _ntLeaveTarget = null;
                    if (ok === true) { _ntResetForm(); activateSection(to); }
                    else if (_ntTradeWasDeleted()) _ntAskDeletedLeave(to);
                    else _ntAskFailedLeave(to);
                };
                var timer = setTimeout(function() { finish(false); }, _NT_LEAVE_TIMEOUT_MS);
                _ntFlushCommit().catch(function() { return false; }).then(finish);
                return false;
            }
            var missing = bad ? 'Row #' + bad.row + ' ' + bad.field : miss.label;
            var text = 'This trade isn’t complete. Missing: ' + missing + '. Stay to finish it, or Discard to clear the form.'
                + (_ntCreatedSaved ? ' The version saved earlier will be kept.' : '');
            _ntConfirmLeave(text, 'Discard', function() {
                // Discard: nothing new is saved; an earlier saved version stays.
                _ntResetForm();
                activateSection(target);
            }, function() {
                if (bad) { _ntShowFillError(bad); return; }
                if (miss.el) { _showFieldBubble(miss.el, miss.label + ' is required'); miss.el.focus(); }
            });
            return false;
        }

        // Save failed (or still running): Leave keeps the form and the draft,
        // with its trade id, so coming back continues the same trade.
        function _ntAskFailedLeave(target) {
            _ntConfirmLeave('Save failed. Stay to retry, or Leave and keep your draft.', 'Leave', function() {
                _ntLeaveAnyway = true;
                try { activateSection(target); } finally { _ntLeaveAnyway = false; }
            }, function() {});
        }

        // Deleted elsewhere: never recreated. Discard clears the form and draft.
        function _ntAskDeletedLeave(target) {
            _ntConfirmLeave('This trade was deleted. Discard this draft?', 'Discard', function() {
                _ntResetForm();
                activateSection(target);
            }, function() {});
        }

        // In-app Stay / <goLabel> confirm, same modal markup as the app's
        // others. "Discard" is styled as destructive, anything else is not.
        function _ntConfirmLeave(text, goLabel, onGo, onStay) {
            var modal = document.getElementById('nt-leave-modal');
            if (!modal) {
                modal = document.createElement('div');
                modal.id = 'nt-leave-modal';
                modal.className = 'modal';
                modal.setAttribute('role', 'dialog');
                modal.setAttribute('aria-modal', 'true');
                modal.innerHTML = '<div class="modal-content" style="max-width:420px;">'
                    + '<p data-nt-leave="text" style="margin:0; color:var(--text-primary);"></p>'
                    + '<div class="modal-buttons" style="justify-content:flex-end;">'
                    + '<button type="button" class="btn btn-secondary btn-small" data-nt-leave="stay">Stay</button>'
                    + '<button type="button" class="btn btn-small" data-nt-leave="go"></button>'
                    + '</div></div>';
                document.body.appendChild(modal);
            }
            modal.querySelector('[data-nt-leave="text"]').textContent = text;
            var close = function() { modal.classList.remove('active'); };
            var stayBtn = modal.querySelector('[data-nt-leave="stay"]');
            var goBtn = modal.querySelector('[data-nt-leave="go"]');
            var danger = goLabel === 'Discard';
            goBtn.textContent = goLabel;
            goBtn.className = 'btn btn-small' + (danger ? '' : ' btn-primary');
            goBtn.style.background = danger ? 'var(--danger)' : '';
            goBtn.style.color = danger ? 'var(--on-danger)' : '';
            stayBtn.onclick = function() { close(); onStay(); };
            goBtn.onclick = function() { close(); onGo(); };
            modal.classList.add('active');
            if (stayBtn.focus) stayBtn.focus();
        }

        function _ntShowFillError(bad) {
            var box = document.getElementById('nt-fills-error');
            if (box) {
                box.textContent = 'Row #' + bad.row + ': ' + bad.field + ' is missing.';
                box.style.display = '';
            }
            var rowEl = document.querySelectorAll('#nt-fills-rows .nt-fill-row')[bad.row - 1];
            var input = rowEl && rowEl.querySelector('[data-nt-fill="' + bad.key + '"]');
            if (input) {
                input.style.borderColor = 'var(--danger, #f87171)';
                _fillFieldPopup(input, bad.field);
                input.focus();
            }
        }

        function _ntClearFillError() {
            _clearFieldBubble();
            var box = document.getElementById('nt-fills-error');
            if (box) { box.textContent = ''; box.style.display = 'none'; }
            document.querySelectorAll('#nt-fills-rows [data-nt-fill]').forEach(function(el) {
                el.style.borderColor = '';
            });
        }

        function _ntReadFillRows() {
            // Returns fills[] in the canonical shape consumed by
            // deriveTradeSummaryFromFills / finalizeTradeSummary. Invalid or
            // incomplete rows are dropped silently.
            var rows = document.querySelectorAll('#nt-fills-rows .nt-fill-row');
            var side = document.getElementById('trade-type').value || 'long';
            var assetType = document.getElementById('asset-type').value || 'stock';
            var mult = _contractMultiplier(assetType);
            var fills = [];
            rows.forEach(function(r) {
                var q  = parseFloat((r.querySelector('[data-nt-fill="qty"]')         || {}).value) || 0;
                var ep = parseFloat((r.querySelector('[data-nt-fill="entry-price"]') || {}).value) || 0;
                var xp = parseFloat((r.querySelector('[data-nt-fill="exit-price"]')  || {}).value) || 0;
                var etStr = (r.querySelector('[data-nt-fill="entry-time"]') || {}).value || '';
                var xtStr = (r.querySelector('[data-nt-fill="exit-time"]')  || {}).value || '';
                var cm = parseFloat((r.querySelector('[data-nt-fill="fees"]') || {}).value) || 0;
                if (q <= 0 || !etStr || !xtStr) return;
                var et = new Date(etStr);
                var xt = new Date(xtStr);
                if (isNaN(et.getTime()) || isNaN(xt.getTime())) return;
                // Option-aware per-row P&L — same rule the rest of the app uses.
                var gross = side === 'long'
                    ? (xp - ep) * q * mult
                    : (ep - xp) * q * mult;
                fills.push({
                    quantity:       q,
                    entryPrice:     ep,
                    exitPrice:      xp,
                    entryTime:      et.toISOString(),
                    exitTime:       xt.toISOString(),
                    commissionFees: cm,
                    pnl:            gross - cm
                });
            });
            return fills;
        }

        // Display-only % of Pos. / P&L / % Gain cells and the Total row, using
        // the Trade Reflection fill math (window._jnlFillMath) so both pages
        // agree. Never read by save, validation or serialization.
        function _ntUpdateFillRowDisplay() {
            var m = window._jnlFillMath;
            var totEl = document.getElementById('nt-fills-total');
            var rows = document.querySelectorAll('#nt-fills-rows .nt-fill-row');
            if (totEl) totEl.style.display = rows.length ? 'grid' : 'none';
            if (!m || !rows.length) return null;
            var side = document.getElementById('trade-type').value || 'long';
            var mult = _contractMultiplier(document.getElementById('asset-type').value || 'stock');
            var raw = function(r, key) { return (r.querySelector('[data-nt-fill="' + key + '"]') || {}).value || ''; };
            var setCell = function(el, text, color, title) {
                if (!el) return;
                el.textContent = text;
                el.style.color = color || '';
                el.title = title || '';
            };
            var totQ = 0, pricedQ = 0, sumEntry = 0, sumExit = 0, totPnl = 0, totFees = 0, anyOpen = false, anyDone = false;
            rows.forEach(function(r) { var q = parseFloat(raw(r, 'qty')) || 0; if (q > 0) totQ += q; });
            rows.forEach(function(r) {
                var q = parseFloat(raw(r, 'qty')) || 0;
                var hasEntry = raw(r, 'entry-price') !== '';
                var hasExit = raw(r, 'exit-price') !== '';
                var ep = parseFloat(raw(r, 'entry-price')) || 0;
                var xp = parseFloat(raw(r, 'exit-price')) || 0;
                var cm = parseFloat(raw(r, 'fees')) || 0;
                totFees += cm;
                var posEl  = r.querySelector('[data-nt-calc="pos"]');
                var pnlEl  = r.querySelector('[data-nt-calc="pnl"]');
                var gainEl = r.querySelector('[data-nt-calc="gain"]');
                if (q > 0 && hasEntry) {
                    pricedQ += q;
                    sumEntry += ep * q;
                    if (hasExit) sumExit += xp * q; else anyOpen = true;
                }
                if (!(q > 0 && hasEntry && hasExit)) {
                    setCell(posEl, '--'); setCell(pnlEl, '--'); setCell(gainEl, '--');
                    return;
                }
                var pnl = m.pnl(side, q, ep, xp, cm, mult);
                var pct = m.gainPct(pnl, ep, q, mult);
                var color = pnl >= 0 ? 'var(--success)' : 'var(--danger)';
                totPnl += pnl;
                anyDone = true;
                setCell(posEl, m.posPct(q, totQ));
                setCell(pnlEl, (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2), color);
                setCell(gainEl, pct == null ? '--' : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%', color);
            });
            var t = m.totals(pricedQ, sumEntry, sumExit, totPnl, anyOpen, mult);
            if (!totEl) return t;
            var tot = function(key) { return totEl.querySelector('[data-nt-tot="' + key + '"]'); };
            setCell(tot('qty'),   totQ > 0 ? String(totQ) : '--');
            setCell(tot('pos'),   m.posPct(totQ, totQ));
            setCell(tot('entry'), t.entry, '', t.entryFull);
            setCell(tot('exit'),  t.exit,  '', t.exitFull);
            setCell(tot('fees'),  '$' + totFees.toFixed(2));
            setCell(tot('pnl'),   anyDone ? t.pnl : '--', anyDone ? (totPnl >= 0 ? 'var(--success)' : 'var(--danger)') : '');
            setCell(tot('gain'),  t.gain, t.gainColor);
            return t;
        }

        // Calculated Metrics "% Gain" for the whole trade, display only.
        // Multiple fills: the fills Total row value. Single fill: the top
        // Quantity / Entry / Exit / Fees run through the same fill math.
        function _ntUpdateMetricGain() {
            var m = window._jnlFillMath;
            var g = null;
            if (_ntFillsEnabled) {
                g = _ntUpdateFillRowDisplay();
            } else if (m) {
                var q = _sfId('quantity'), ep = _sfId('entry-price'), xp = _sfId('exit-price');
                if (q > 0 && ep != null && xp != null) {
                    var side = (document.getElementById('trade-type') || {}).value || 'long';
                    var mult = _contractMultiplier((document.getElementById('asset-type') || {}).value || 'stock');
                    var pnl = m.pnl(side, q, ep, xp, _sfId('commission-fees') || 0, mult);
                    g = m.totals(q, ep * q, xp * q, pnl, false, mult);
                }
            }
            var el = document.getElementById('metric-pct-gain');
            if (!el) return;
            el.textContent = g ? g.gain : '--';
            el.style.color = (g && g.gainColor) || 'var(--text-primary)';
        }

        function _ntRecomputeFromFills() {
            _ntUpdateMetricGain();
            var fills = _ntReadFillRows();
            if (fills.length === 0) return;
            var side = document.getElementById('trade-type').value || 'long';
            var assetType = document.getElementById('asset-type').value || 'stock';
            var summary = deriveTradeSummaryFromFills(fills, { type: side, assetType: assetType });
            if (!summary) return;
            // Write derived canonical values back into the summary inputs.
            var q = document.getElementById('quantity');
            var ep = document.getElementById('entry-price');
            var xp = document.getElementById('exit-price');
            var et = document.getElementById('entry-time');
            var xt = document.getElementById('exit-time');
            var cm = document.getElementById('commission-fees');
            if (q)  q.value  = summary.quantity;
            if (ep) ep.value = summary.entryPrice != null ? Number(summary.entryPrice).toFixed(4) : '';
            if (xp) xp.value = summary.exitPrice  != null ? Number(summary.exitPrice).toFixed(4)  : '';
            if (et) et.value = _ntIsoToLocalInput(summary.entryTime);
            if (xt) xt.value = _ntIsoToLocalInput(summary.exitTime);
            if (cm) cm.value = Number(summary.commissionFees || 0).toFixed(2);
            _recalcNewMetrics();
        }

        // Mount the fills section once the DOM is ready. All other New
        // Trade IIFEs run synchronously at script load (DOM is present by
        // then since Denarii.js lives at the bottom of the body).
        _ntEnsureFillsSection();

        // Save current trade and open its Journal entry page
        async function saveAndOpenJournal() {
            const form = document.getElementById('trade-form');
            if (!_ntCheckRequired(form)) return;

            // Flush any pending autosave then ensure the record exists
            if (_ntCommitTimer) { clearTimeout(_ntCommitTimer); _ntCommitTimer = null; }
            const ok = await _ntQueueCommit({ reportFillErrors: true });
            const tradeId = _ntCreatedTradeId;
            if (!ok || !tradeId) return; // save failed, or safety

            _ntResetForm();
            updateDashboard();
            activateSection('trade-journal');
            selectTradeForJournal(tradeId);
        }

        // Trade form — Save Trade button (explicit save + navigate to dashboard)
        document.getElementById('trade-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!_ntCheckRequired(e.currentTarget)) return;
            if (_ntCommitTimer) { clearTimeout(_ntCommitTimer); _ntCommitTimer = null; }
            const ok = await _ntQueueCommit({ explicit: true });
            if (!ok) return;
        });

        // Broker Import
        // ── Broker profiles ──────────────────────────────────────────────────────
        // Each profile maps logical field names to the ordered list of CSV column
        // header candidates for that broker.  _pickCol() returns the first column
        // that exists and is non-empty in the row.
        //
        // Status flags:
        //   active:   true  → import is enabled; false → import is blocked (shows user message)
        //   verified: true  → headers confirmed against a real sample CSV export
        //
        // To activate a new broker:
        //   1. Obtain a real CSV export from the broker.
        //   2. Populate header arrays with the exact column names from that CSV.
        //   3. Populate requiredHeaders with the minimum set confirmed present.
        //   4. Run _validateBrokerProfile(profile, sampleRow) and confirm valid === true.
        //   5. Set active: true, verified: true.
        //   6. Update the HTML dropdown option (remove disabled + "(Coming Soon)").

        const BROKER_PROFILES = {

            // ── PRODUCTION-READY ──────────────────────────────────────────────
            webull: {
                label:              'Webull',
                active:             true,
                verified:           true,         // confirmed against real Webull filled-orders CSV
                supportsStocks:     true,
                supportsOptions:    true,
                supportsCrypto:     false,
                supportsFutures:    false,
                notes:              'Standard Webull filled-orders CSV export. No commission column.',
                // Column header candidates — _pickCol() uses the first non-empty match
                timestamp:          ['Filled Time', 'Date/Time', 'Time', 'Date'],
                symbol:             ['Symbol', 'Name', 'Instrument'],
                price:              ['Avg Price', 'Price', 'Fill Price', 'Filled Price'],
                action:             ['Side', 'Action', 'Buy/Sell'],
                quantity:           ['Filled', 'Total Qty', 'Qty', 'Quantity', 'Allocation Amount'],
                commission:         [],           // Webull does not export a fees column
                status:             ['Status', 'Order Status'],
                optionSymbolFormat: 'occ',        // SYMBOL + YYMMDD + C|P + 8-digit-strike
                // Validation manifest (used by _validateBrokerProfile)
                requiredHeaders:    ['Filled Time', 'Symbol', 'Avg Price'],
                optionalHeaders:    ['Side', 'Filled', 'Status'],
            },

            // ── PROVISIONAL — not yet verified with real sample CSVs ──────────
            // Headers below are best-effort guesses only.
            // Do not set active: true until headers are confirmed against a real export.

            robinhood: {
                label:              'Robinhood',
                active:             true,
                verified:           true,         // confirmed against real Robinhood account-activity CSVs
                supportsStocks:     true,
                supportsOptions:    true,
                supportsCrypto:     false,        // Robinhood Crypto uses a separate export
                supportsFutures:    false,
                notes:              'Robinhood account-activity CSV. Trans Code carries direction ' +
                                    '(BTO/STC/STO/BTC/Buy/Sell). Activity Date is date-only (no time). ' +
                                    'Options are parsed from the Description field, not OCC symbol format.',
                timestamp:          ['Activity Date'],
                symbol:             ['Instrument'],
                price:              ['Price'],
                action:             ['Trans Code'],
                quantity:           ['Quantity'],
                commission:         [],           // Robinhood is commission-free; regulatory fees embedded in Amount
                status:             [],           // no status column
                optionSymbolFormat: 'description', // parsed from Description, not OCC symbol
                requiredHeaders:    ['Activity Date', 'Instrument', 'Trans Code'],
                optionalHeaders:    ['Process Date', 'Settle Date', 'Description', 'Amount'],
            },

            tastytrade: {
                label:              'tastytrade',
                active:             false,
                verified:           false,
                supportsStocks:     true,
                supportsOptions:    true,
                supportsCrypto:     false,
                supportsFutures:    true,
                notes:              'Placeholder. Requires sample CSV to determine header names. ' +
                                    'tastytrade uses BOT/SLD action codes (already in ACTION_MAP).',
                // ── Populate after verifying a real tastytrade CSV ────────────
                timestamp:          [],
                symbol:             [],
                price:              [],
                action:             [],
                quantity:           [],
                commission:         [],
                optionSymbolFormat: null,
                requiredHeaders:    [],
                optionalHeaders:    [],
            },

            schwab: {
                label:              'Schwab',
                active:             false,
                verified:           false,
                supportsStocks:     true,
                supportsOptions:    true,
                supportsCrypto:     false,
                supportsFutures:    false,
                notes:              'Placeholder. Schwab merged with TD Ameritrade; export format may vary. ' +
                                    'Requires sample CSV validation.',
                // ── Populate after verifying a real Schwab CSV ────────────────
                timestamp:          [],
                symbol:             [],
                price:              [],
                action:             [],
                quantity:           [],
                commission:         [],
                optionSymbolFormat: null,
                requiredHeaders:    [],
                optionalHeaders:    [],
            },

            ibkr: {
                label:              'IBKR',
                active:             false,
                verified:           false,
                supportsStocks:     true,
                supportsOptions:    true,
                supportsCrypto:     false,
                supportsFutures:    true,
                notes:              'Placeholder. IBKR Flex Query CSV format varies by report configuration. ' +
                                    'Requires a standardized sample CSV for header verification.',
                // ── Populate after verifying a real IBKR Flex Query CSV ───────
                timestamp:          [],
                symbol:             [],
                price:              [],
                action:             [],
                quantity:           [],
                commission:         [],
                optionSymbolFormat: null,
                requiredHeaders:    [],
                optionalHeaders:    [],
            },

            // ── PRODUCTION-READY (section-based) ─────────────────────────
            tos: {
                label:              'thinkorswim',
                active:             true,
                verified:           true,         // confirmed against real TOS Account Statement CSVs
                supportsStocks:     true,
                supportsOptions:    true,
                supportsCrypto:     false,        // Phase 1: skip Crypto section
                supportsFutures:    false,        // Phase 1: skip Futures section
                notes:              'TOS Account Statement CSV. Section-based format; ' +
                                    'imports from Account Trade History section only. ' +
                                    'Explicit Pos Effect (TO OPEN/TO CLOSE) and Type ' +
                                    '(STOCK/PUT/CALL/ETF/FUND) columns.',
                timestamp:          ['Exec Time'],
                symbol:             ['Symbol'],
                price:              ['Price'],
                action:             ['Side'],
                quantity:           ['Qty'],
                commission:         [],           // Fees in Cash Balance section, not trade history
                status:             [],
                optionSymbolFormat: 'columns',    // parsed from Type + Strike + Exp columns
                // requiredHeaders validated against the extracted section, not raw line 1
                requiredHeaders:    ['Exec Time', 'Symbol', 'Side', 'Qty', 'Type', 'Price'],
                optionalHeaders:    ['Pos Effect', 'Net Price', 'Order ID', 'Strike', 'Exp', 'Spread'],
                sectionBased:       true,
                sectionName:        'Account Trade History',
            },

        };

        /** Return the first non-empty value from a row for the given header candidates. */
        function _pickCol(row, candidates) {
            for (const key of candidates) {
                const v = row[key];
                if (v !== undefined && v !== null && v !== '') return v;
            }
            return undefined;
        }

        /**
         * Normalize raw CSV action/side strings.
         * matchTradePairs() branches on action.includes('BUY'),
         * action.includes('SELL'), and action.includes('SHORT').
         * 'short' is kept as a distinct value so the matcher can
         * unconditionally open a short position instead of first
         * trying to close an existing long.
         */
        const ACTION_MAP = {
            // Long-form
            'buy':  'buy',  'Buy':  'buy',  'BUY':  'buy',
            'sell': 'sell', 'Sell': 'sell', 'SELL': 'sell',
            // Explicit short-sell (Webull uses "Short" in Side column)
            'short': 'short', 'Short': 'short', 'SHORT': 'short',
            // Single-letter
            'b':    'buy',  'B':    'buy',
            's':    'sell', 'S':    'sell',
            // Legacy broker codes
            'bot':  'buy',  'BOT':  'buy',
            'sld':  'sell', 'SLD':  'sell',
            // Options codes (Robinhood, Tastytrade, etc.)
            'bto':  'buy',  'BTO':  'buy',   // buy to open
            'btc':  'buy',  'BTC':  'buy',   // buy to close
            'sto':  'sell', 'STO':  'sell',  // sell to open
            'stc':  'sell', 'STC':  'sell',  // sell to close
        };

        function normalizeAction(raw) {
            if (!raw) return undefined;
            const trimmed = String(raw).trim();
            return ACTION_MAP[trimmed] !== undefined ? ACTION_MAP[trimmed] : trimmed.toLowerCase();
        }

        /** Return the BROKER_PROFILES entry matching the current UI selection. */
        function getSelectedBrokerProfile() {
            const sel = document.getElementById('broker-import-broker-select');
            const key = sel && sel.value ? sel.value : 'webull';
            var profile = BROKER_PROFILES[key] || BROKER_PROFILES.webull;
            profile._profileKey = key;
            return profile;
        }

        /**
         * Lightweight broker onboarding validation hook.
         * Call before marking a profile active: true to confirm required headers
         * are present in a real sample row from the broker's CSV export.
         *
         * @param {object} profile - A BROKER_PROFILES entry
         * @param {object} sampleRow - One parsed row from Papa.parse (header:true)
         * @returns {{ valid: boolean, missing: string[] }}
         *
         * Onboarding checklist:
         *   1. Parse a real sample CSV with Papa.parse({ header: true }).
         *   2. Pass results.data[0] as sampleRow.
         *   3. Confirm valid === true and missing is empty.
         *   4. Set profile.active = true, profile.verified = true.
         */
        function _validateBrokerProfile(profile, sampleRow) {
            const required = profile.requiredHeaders || [];
            const missing  = required.filter(h => !(h in (sampleRow || {})));
            return { valid: missing.length === 0, missing };
        }

        // ── Broker/header mismatch detection ─────────────────────────────────────
        // Before parsing CSV rows into trades, validate that the file headers
        // match the selected broker profile. Broker-agnostic — works for all
        // profiles in BROKER_PROFILES.

        /**
         * Score how well a set of CSV column headers matches a broker profile.
         * Returns { score, total, missing } where score is the count of
         * required+optional headers found, total is the count checked, and
         * missing lists the required headers NOT found.
         */
        function _scoreBrokerHeaders(profile, fileHeaders) {
            var headerSet = {};
            for (var i = 0; i < fileHeaders.length; i++) {
                headerSet[fileHeaders[i]] = true;
            }
            var required = profile.requiredHeaders || [];
            var optional = profile.optionalHeaders || [];
            var missing = [];
            var score = 0;
            var total = required.length + optional.length;
            for (var ri = 0; ri < required.length; ri++) {
                if (headerSet[required[ri]]) score++;
                else missing.push(required[ri]);
            }
            for (var oi = 0; oi < optional.length; oi++) {
                if (headerSet[optional[oi]]) score++;
            }
            return { score: score, total: total, missing: missing };
        }

        /**
         * Find the best-matching active broker profile for the given file
         * headers. Only considers profiles with requiredHeaders defined.
         * Returns { key, label, score, total } or null if no profile matches
         * any required headers.
         */
        function _detectLikelyBroker(fileHeaders, excludeKey) {
            var best = null;
            for (var key in BROKER_PROFILES) {
                if (key === excludeKey) continue;
                var p = BROKER_PROFILES[key];
                if (!p.requiredHeaders || p.requiredHeaders.length === 0) continue;
                var result = _scoreBrokerHeaders(p, fileHeaders);
                // Must have ALL required headers to be a candidate
                if (result.missing.length > 0) continue;
                if (!best || result.score > best.score) {
                    best = { key: key, label: p.label, score: result.score, total: result.total };
                }
            }
            return best;
        }

        /**
         * Parse only the header row of a CSV file (lightweight preview).
         * Returns a Promise<string[]> of column header names.
         */
        function _parseHeadersOnly(file) {
            return new Promise(function(resolve) {
                Papa.parse(file, {
                    header: true,
                    preview: 1,       // parse only the first data row
                    skipEmptyLines: true,
                    complete: function(results) {
                        resolve(results.meta && results.meta.fields ? results.meta.fields : []);
                    },
                    error: function() { resolve([]); }
                });
            });
        }

        /**
         * Validate file headers against the selected broker profile.
         * Returns { valid, message } where message is a user-facing string
         * when valid is false.
         */
        function _validateFileAgainstBroker(profile, fileHeaders, fileName) {
            var required = profile.requiredHeaders || [];
            if (required.length === 0) {
                return { valid: true, message: '', missing: [], likelyBroker: null, fileName: fileName };
            }
            var result = _scoreBrokerHeaders(profile, fileHeaders);
            if (result.missing.length === 0) {
                return { valid: true, message: '', missing: [], likelyBroker: null, fileName: fileName };
            }
            var likely = _detectLikelyBroker(fileHeaders, profile._profileKey);
            var msg = 'The file "' + (fileName || 'uploaded CSV') + '" does not match the selected broker (' + profile.label + ').\n\n';
            msg += 'Missing required headers: ' + result.missing.join(', ') + '\n';
            if (likely) {
                msg += '\nThis file looks like a ' + likely.label + ' export.';
                msg += '\nPlease select "' + likely.label + '" from the broker dropdown and try again.';
            } else {
                msg += '\nPlease verify you selected the correct broker and uploaded the right CSV file.';
            }
            return {
                valid: false,
                message: msg,
                missing: result.missing,
                likelyBroker: likely,
                fileName: fileName
            };
        }

        /**
         * Build styled HTML for the broker/header mismatch inline warning.
         */
        function _formatHeaderMismatchHtml(check, profile) {
            var h = '<strong>Broker mismatch detected</strong><br>';
            h += 'The file <strong>' + escapeHtml(check.fileName || 'uploaded CSV') + '</strong>';
            h += ' does not match <strong>' + escapeHtml(profile.label) + '</strong>.';
            h += '<div style="margin-top:8px;font-size:12px;">';
            h += 'Missing required headers: ';
            for (var i = 0; i < check.missing.length; i++) {
                if (i > 0) h += ', ';
                h += '<code style="background:rgba(0,0,0,0.1);padding:1px 5px;border-radius:3px;font-size:11px;">'
                   + escapeHtml(check.missing[i]) + '</code>';
            }
            h += '</div>';
            if (check.likelyBroker) {
                h += '<div style="margin-top:8px;padding:6px 10px;border-radius:6px;background:rgba(59,130,246,0.08);font-size:12px;">';
                h += 'This file looks like a <strong>' + escapeHtml(check.likelyBroker.label) + '</strong> export. ';
                h += 'Select <strong>' + escapeHtml(check.likelyBroker.label) + '</strong> from the broker dropdown above and try again.';
                h += '</div>';
            } else {
                h += '<div style="margin-top:8px;font-size:12px;color:var(--text-secondary);">';
                h += 'Please verify you selected the correct broker and uploaded the right CSV file.';
                h += '</div>';
            }
            return h;
        }

        // ── End broker/header mismatch detection ─────────────────────────────────

        // ── End broker profiles ───────────────────────────────────────────────────

        // ── Import summary / diagnostics system ─────────────────────────────────
        // Broker-agnostic. Each import run produces one summary object that
        // tracks what happened to every CSV row without persisting raw data.
        // Robinhood uses it first; Webull and future brokers can adopt it
        // without structural changes.

        const IMPORT_ISSUE_TYPES = {
            recognized_non_trade: 'Recognized non-trade activity',
            unsupported_code:     'Unsupported transaction code',
            missing_required_field: 'Missing required field',
            invalid_row:          'Invalid or empty row',
            parse_warning:        'Parse warning',
            ambiguous_match:      'Ambiguous trade match',
            unmatched_open:       'Unmatched open (no closing trade in file)',
            unmatched_close:      'Closing trade without a matching open in this file'
        };

        // Maximum sample issues stored per type (keeps storage small).
        const MAX_ISSUE_SAMPLES = 5;

        function createImportSummary(broker, fileName) {
            return {
                broker:             broker,
                fileName:           fileName,
                timestamp:          new Date().toISOString(),
                totalRows:          0,
                importedTradeCount: 0,
                skippedRows:        0,
                unsupportedRows:    0,
                warningCount:       0,
                // Grouped counts by issue type
                issueCounts:        {},
                // Capped sample list per issue type: { type, code, symbol, date, message }
                issueSamples:       {}
            };
        }

        function addImportIssue(summary, type, detail) {
            if (!summary) return;
            if (!summary.issueCounts[type])  summary.issueCounts[type]  = 0;
            if (!summary.issueSamples[type]) summary.issueSamples[type] = [];
            summary.issueCounts[type] += 1;
            if (summary.issueSamples[type].length < MAX_ISSUE_SAMPLES) {
                summary.issueSamples[type].push({
                    code:    (detail && detail.code)    || '',
                    symbol:  (detail && detail.symbol)  || '',
                    date:    (detail && detail.date)     || '',
                    message: (detail && detail.message) || ''
                });
            }
        }

        // ── Robinhood-specific helpers ───────────────────────────────────────────

        // Trans codes that represent recognized non-trade broker activity.
        const ROBINHOOD_NON_TRADE_CODES = {
            'ach':   'ACH transfer',
            'slip':  'Stock lending income',
            'gold':  'Robinhood Gold interest',
            'div':   'Dividend',
            'cdiv':  'Cash dividend',
            'spl':   'Stock split',
            'oexp':  'Option expiration',
            'oasgn': 'Option assignment'
        };

        // Parse option contract details from Robinhood Description field.
        // Format: "{SYMBOL} {M/D/YYYY} {Call|Put} ${strike}"
        // Returns { optionType, strike, expiry, contractName } or null.
        var _RH_OPTION_RE = /^([A-Z]{1,6})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(Call|Put)\s+\$?([\d,.]+)$/i;

        function _parseRobinhoodOptionDescription(desc, symbol) {
            if (!desc) return null;
            var m = desc.match(_RH_OPTION_RE);
            if (!m) return null;
            var callPut = m[3].toLowerCase() === 'call' ? 'CALL' : 'PUT';
            var strikeVal = parseFloat(m[4].replace(/,/g, ''));
            // Parse M/D/YYYY date
            var dateParts = m[2].split('/');
            if (dateParts.length !== 3) return null;
            var mo = dateParts[0].padStart(2, '0');
            var dy = dateParts[1].padStart(2, '0');
            var yr = dateParts[2];
            var expiryIso = yr + '-' + mo + '-' + dy;
            // Build OCC-format contractName for compatibility
            var yy = yr.slice(2);
            var strikePadded = String(Math.round(strikeVal * 1000)).padStart(8, '0');
            var occ = (symbol || m[1]).toUpperCase() + yy + mo + dy
                    + (callPut === 'CALL' ? 'C' : 'P') + strikePadded;
            return {
                optionType:   callPut,
                strike:       strikeVal,
                expiry:       expiryIso,
                contractName: occ
            };
        }

        // Check if a Robinhood row is a footer/disclaimer or blank separator.
        function _isRobinhoodFooterRow(row) {
            // All-empty row (blank separator before footer)
            var hasAnyValue = false;
            for (var k in row) {
                if (row[k] != null && String(row[k]).trim() !== '') { hasAnyValue = true; break; }
            }
            if (!hasAnyValue) return true;
            // Footer: contains the disclaimer text
            var desc = row['Description'] || '';
            if (typeof desc === 'string' && desc.indexOf('informational purposes') !== -1) return true;
            // Check all values for disclaimer (sometimes lands in an unnamed column)
            for (var k in row) {
                var v = row[k];
                if (typeof v === 'string' && v.indexOf('informational purposes') !== -1) return true;
            }
            return false;
        }

        // ── thinkorswim (TOS) section-based parser ──────────────────────────────
        // TOS Account Statement CSVs are multi-section documents. Each section
        // has its own header row and column layout. Phase 1 imports only the
        // "Account Trade History" section for stocks, ETFs, funds, and
        // single-leg options.

        /** Read a File object as plain text. Returns a Promise<string>. */
        function _readFileAsText(file) {
            return new Promise(function(resolve, reject) {
                var reader = new FileReader();
                reader.onload = function() { resolve(reader.result || ''); };
                reader.onerror = function() { reject(reader.error); };
                reader.readAsText(file);
            });
        }

        /** TOS month abbreviation → zero-padded month number. */
        var _TOS_MONTHS = {
            'jan':'01','feb':'02','mar':'03','apr':'04','may':'05','jun':'06',
            'jul':'07','aug':'08','sep':'09','oct':'10','nov':'11','dec':'12'
        };

        /**
         * Parse TOS expiry string "DD-Mon-YY" → ISO "YYYY-MM-DD".
         * Returns null on parse failure.
         */
        function _parseTosExpiry(str) {
            if (!str || typeof str !== 'string') return null;
            var parts = str.trim().split('-');
            if (parts.length !== 3) return null;
            var dd = parts[0].padStart(2, '0');
            var mo = _TOS_MONTHS[(parts[1] || '').toLowerCase()];
            if (!mo) return null;
            var yy = parts[2];
            var yr = yy.length === 2 ? '20' + yy : yy;
            return yr + '-' + mo + '-' + dd;
        }

        /** TOS asset type values that Phase 1 supports as importable trades. */
        var _TOS_TRADE_TYPES = { 'STOCK': 1, 'ETF': 1, 'FUND': 1, 'PUT': 1, 'CALL': 1 };

        /**
         * Detect if raw file text is a TOS Account Statement.
         * Checks for "Account Statement for" near the start (with BOM tolerance).
         */
        function _isTosAccountStatement(text) {
            if (!text) return false;
            // Strip BOM and leading whitespace
            var start = text.replace(/^\uFEFF/, '').trimStart().substring(0, 200);
            return start.indexOf('Account Statement for') !== -1;
        }

        // ── TOS Cash Balance fee extraction (Phase 2) ─────────────────────
        // Parses TRD rows from the Cash Balance section to extract per-fill
        // Misc Fees and Commissions & Fees. Returns a Map keyed by composite
        // key for reconciliation against Account Trade History rows.

        /**
         * Parse DESCRIPTION from a Cash Balance TRD row.
         * Format: "BOT +250 APLD @36.04" or "SOLD -1 SPY 100 (Weeklys) 21 APR 26 699 PUT @.27"
         * Returns { side, qty, symbol, price } or null if not confidently parsed.
         */
        var _TOS_CB_DESC_RE = /^(BOT|SOLD)\s+([+-]?[\d,]+)\s+(\S+)\s.*?@([\d,.]+)/;

        function _parseTosDescription(desc) {
            if (!desc) return null;
            var m = desc.match(_TOS_CB_DESC_RE);
            if (!m) return null;
            var side = m[1] === 'BOT' ? 'buy' : 'sell';
            var qty = Math.abs(parseFloat(m[2].replace(/,/g, '')) || 0);
            var symbol = m[3].toUpperCase();
            var price = parseFloat(m[4].replace(/,/g, '')) || 0;
            if (qty <= 0 || !symbol || !Number.isFinite(price)) return null;
            return { side: side, qty: qty, symbol: symbol, price: price };
        }

        /**
         * Build a composite matching key for fee reconciliation.
         * Same key shape used for both Cash Balance TRD rows and
         * Account Trade History rows.
         */
        function _tosFeeKey(date, timeMinute, symbol, qty, price, side) {
            // Normalize: round price to avoid float dust
            return date + '|' + timeMinute + '|' + (symbol || '').toUpperCase()
                 + '|' + qty + '|' + (Math.round(price * 10000) / 10000) + '|' + side;
        }

        /**
         * Extract fee records from the Cash Balance section of a TOS
         * Account Statement. Returns { feeMap, stats }.
         * feeMap: composite-key → { miscFees, commFees, refNum, _used }
         * stats: { trdRowsFound, feeRowsParsed, feeRowsSkipped }
         */
        function _parseTosFeesFromCashBalance(lines) {
            var stats = { trdRowsFound: 0, feeRowsParsed: 0, feeRowsSkipped: 0 };
            var feeMap = {};

            // Find Cash Balance section
            var cbStart = -1;
            var cbHeaderLine = -1;
            for (var i = 0; i < lines.length; i++) {
                if (lines[i].trim().replace(/,+$/, '').trim() === 'Cash Balance') {
                    cbStart = i;
                    cbHeaderLine = i + 1;
                    break;
                }
            }
            if (cbStart === -1 || cbHeaderLine >= lines.length) {
                return { feeMap: feeMap, stats: stats };
            }

            // Extract Cash Balance header + data rows
            var cbHeader = lines[cbHeaderLine];
            var cbDataLines = [];
            for (var j = cbHeaderLine + 1; j < lines.length; j++) {
                var line = lines[j];
                var trimmed = line.trim().replace(/,+$/, '').trim();
                if (trimmed === '') break;
                if (/^[A-Z][A-Za-z &]+,+$/.test(line.trim())) break;
                // Stop at TOTAL row
                if (trimmed.indexOf('TOTAL') !== -1) break;
                cbDataLines.push(line);
            }

            if (cbDataLines.length === 0) return { feeMap: feeMap, stats: stats };

            // Parse with PapaParse
            var cbCsv = cbHeader + '\n' + cbDataLines.join('\n');
            var cbResult = Papa.parse(cbCsv, { header: true, skipEmptyLines: true });
            var cbRows = cbResult.data || [];

            for (var ri = 0; ri < cbRows.length; ri++) {
                var row = cbRows[ri];
                var type = (row['TYPE'] || '').trim().toUpperCase();
                if (type !== 'TRD') continue;
                stats.trdRowsFound++;

                var dateVal = (row['DATE'] || '').trim();
                var timeVal = (row['TIME'] || '').trim();
                var desc    = (row['DESCRIPTION'] || '').trim();
                var refNum  = (row['REF #'] || '').trim();
                var miscRaw = (row['Misc Fees'] || '').trim();
                var commRaw = (row['Commissions & Fees'] || '').trim();

                // Parse description for matching fields
                var parsed = _parseTosDescription(desc);
                if (!parsed) {
                    stats.feeRowsSkipped++;
                    continue;
                }

                // Truncate TIME to minutes (HH:MM from H:MM:SS or HH:MM:SS)
                var timeMinute = timeVal.replace(/:\d{2}$/, '');

                // Parse fee values (stored as negative in TOS, we want positive)
                var miscFees = Math.abs(parseFloat(miscRaw.replace(/[$,]/g, '')) || 0);
                var commFees = Math.abs(parseFloat(commRaw.replace(/[$,]/g, '')) || 0);

                var key = _tosFeeKey(dateVal, timeMinute, parsed.symbol, parsed.qty, parsed.price, parsed.side);

                // If duplicate key exists (e.g. truly identical fills), suffix
                // with an incrementing counter to avoid overwriting.
                var finalKey = key;
                var suffix = 0;
                while (feeMap[finalKey] && !feeMap[finalKey]._used) {
                    suffix++;
                    finalKey = key + '#' + suffix;
                }
                // If all existing entries for this key are already used,
                // use the next available suffix.
                if (feeMap[finalKey] && feeMap[finalKey]._used) {
                    suffix++;
                    finalKey = key + '#' + suffix;
                }

                feeMap[finalKey] = {
                    miscFees: miscFees,
                    commFees: commFees,
                    refNum:   refNum,
                    _used:    false,
                    _key:     key  // base key for lookup
                };
                stats.feeRowsParsed++;
            }

            return { feeMap: feeMap, stats: stats };
        }

        /**
         * Look up a fee record by composite key. Handles duplicate keys
         * by consuming entries in order (first unused match wins).
         * Returns { miscFees, commFees } or null.
         */
        function _lookupTosFee(feeMap, key) {
            // Try exact key first
            if (feeMap[key] && !feeMap[key]._used) {
                feeMap[key]._used = true;
                return feeMap[key];
            }
            // Try suffixed keys for duplicate fills
            for (var s = 1; s < 50; s++) {
                var suffixed = key + '#' + s;
                if (!feeMap[suffixed]) break;
                if (!feeMap[suffixed]._used) {
                    feeMap[suffixed]._used = true;
                    return feeMap[suffixed];
                }
            }
            return null;
        }

        // ── End TOS Cash Balance fee extraction ──────────────────────────────

        /**
         * Parse a TOS Account Statement CSV from raw text.
         * Extracts only the "Account Trade History" section.
         *
         * Returns { trades: [], rawRowCount, skippedRows, summary }
         * in the same shape as parseCSV for pipeline compatibility.
         */
        function _parseTosAccountStatement(fileText, fileName, profile) {
            var summary = createImportSummary('tos', fileName);

            // Strip BOM
            var text = fileText.replace(/^\uFEFF/, '');
            var lines = text.split(/\r?\n/);
            summary.totalRows = lines.length;

            // ── Find the Account Trade History section ────────────────────
            var sectionStart = -1;
            var headerLine = -1;
            for (var i = 0; i < lines.length; i++) {
                if (lines[i].trim().replace(/,+$/, '').trim() === 'Account Trade History') {
                    sectionStart = i;
                    headerLine = i + 1;
                    break;
                }
            }

            if (sectionStart === -1 || headerLine >= lines.length) {
                addImportIssue(summary, 'parse_warning', {
                    message: 'Account Trade History section not found in TOS file'
                });
                summary.warningCount++;
                return { trades: [], rawRowCount: lines.length, skippedRows: 0, summary: summary };
            }

            // ── Extract header + data rows until next section or blank ────
            var headerText = lines[headerLine];
            var dataLines = [];
            for (var j = headerLine + 1; j < lines.length; j++) {
                var line = lines[j];
                // Stop at blank/empty line or next section header
                var trimmed = line.trim().replace(/,+$/, '').trim();
                if (trimmed === '' || trimmed === '') break;
                // Section headers have text in col 1 and commas only after
                // (e.g. "Equities,,,,"). Check if this looks like a new section.
                if (/^[A-Z][A-Za-z &]+,+$/.test(line.trim())) break;
                dataLines.push(line);
            }

            // ── Parse the extracted block with PapaParse ─────────────────
            var csvBlock = headerText + '\n' + dataLines.join('\n');
            var parseResult = Papa.parse(csvBlock, {
                header: true,
                skipEmptyLines: true
            });

            // ── Validate that the section has the expected columns ────────
            var sectionHeaders = (parseResult.meta && parseResult.meta.fields) || [];
            var reqCheck = _scoreBrokerHeaders(profile, sectionHeaders);
            if (reqCheck.missing.length > 0) {
                addImportIssue(summary, 'parse_warning', {
                    message: 'Account Trade History section missing expected columns: ' + reqCheck.missing.join(', ')
                });
                summary.warningCount++;
            }

            // ── Normalize rows into trade objects ────────────────────────
            var trades = [];
            var skippedRows = 0;
            var rows = parseResult.data || [];

            for (var ri = 0; ri < rows.length; ri++) {
                var row = rows[ri];
                var execTime = (row['Exec Time'] || '').trim();
                var symbol   = (row['Symbol'] || '').trim();
                var side     = (row['Side'] || '').trim();
                var qtyRaw   = (row['Qty'] || '').trim();
                var posEffect = (row['Pos Effect'] || '').trim();
                var type     = (row['Type'] || '').trim().toUpperCase();
                var priceRaw = (row['Price'] || '').trim();
                var netPrice = (row['Net Price'] || '').trim();
                var orderId  = (row['Order ID'] || '').trim();
                var strikeRaw = (row['Strike'] || '').trim();
                var expRaw   = (row['Exp'] || '').trim();
                var spread   = (row['Spread'] || '').trim();

                // Skip blank/empty rows
                if (!execTime && !symbol && !side) {
                    skippedRows++;
                    continue;
                }

                // Skip unsupported asset types
                if (!_TOS_TRADE_TYPES[type]) {
                    addImportIssue(summary, 'unsupported_code', {
                        code:    type,
                        symbol:  symbol,
                        date:    execTime,
                        message: 'Unsupported asset type: ' + (type || '(empty)')
                    });
                    summary.unsupportedRows++;
                    skippedRows++;
                    continue;
                }

                // Parse fields
                var quantity = Math.abs(parseFloat(qtyRaw) || 0);
                var price = parseFloat(priceRaw.replace(/[$,]/g, '')) || 0;
                var action = normalizeAction(side);
                var isOption = (type === 'PUT' || type === 'CALL');

                var optionType = null;
                var strike = 0;
                var expiry = null;
                var contractName = '';

                if (isOption) {
                    optionType = type; // 'PUT' or 'CALL'
                    strike = parseFloat(strikeRaw) || 0;
                    expiry = _parseTosExpiry(expRaw);
                    // Build OCC-format contractName
                    if (symbol && expiry && strike > 0) {
                        var eParts = expiry.split('-');
                        var yy = eParts[0].slice(2);
                        var mo = eParts[1];
                        var dd = eParts[2];
                        var strikePadded = String(Math.round(strike * 1000)).padStart(8, '0');
                        contractName = symbol.toUpperCase() + yy + mo + dd
                            + (optionType === 'CALL' ? 'C' : 'P') + strikePadded;
                    }
                }

                // Validate required fields
                if (!symbol || !action || quantity <= 0 || !execTime || !Number.isFinite(price)) {
                    addImportIssue(summary, 'missing_required_field', {
                        symbol:  symbol,
                        date:    execTime,
                        message: 'Missing: ' + [
                            !symbol ? 'symbol' : '',
                            !action ? 'side' : '',
                            quantity <= 0 ? 'qty' : '',
                            !execTime ? 'exec time' : '',
                            !Number.isFinite(price) ? 'price' : ''
                        ].filter(Boolean).join(', ')
                    });
                    skippedRows++;
                    continue;
                }

                trades.push({
                    timestamp:      execTime,
                    symbol:         symbol,
                    action:         action,
                    quantity:       quantity,
                    price:          price,
                    commissionFees: 0,
                    optionType:     optionType,
                    strike:         strike,
                    expiry:         expiry,
                    contractName:   contractName,
                    // TOS additive metadata for future phases
                    tosSpread:      spread || null,
                    tosPosEffect:   posEffect || null,
                    tosNetPrice:    netPrice ? (parseFloat(netPrice.replace(/[$,]/g, '')) || null) : null,
                    tosOrderId:     orderId || null,
                    tosType:        type
                });
            }

            // ── Phase 2: Fee reconciliation from Cash Balance ────────────
            var feeResult = _parseTosFeesFromCashBalance(lines);
            var feesReconciled = 0;
            var feesUnreconciled = 0;

            if (feeResult.stats.feeRowsParsed > 0) {
                for (var fi = 0; fi < trades.length; fi++) {
                    var t = trades[fi];
                    // Build the same composite key as the fee map
                    // Trade History Exec Time is "M/D/YYYY H:MM" — extract date and time parts
                    var tsParts = (t.timestamp || '').split(' ');
                    var tDate = tsParts[0] || '';
                    var tTime = tsParts[1] || '';
                    var feeKey = _tosFeeKey(tDate, tTime, t.symbol, t.quantity, t.price, t.action);
                    var feeRec = _lookupTosFee(feeResult.feeMap, feeKey);

                    if (feeRec) {
                        t.commissionFees = Math.round((feeRec.miscFees + feeRec.commFees) * 100) / 100;
                        t.feeSource = 'actual';
                        if (feeRec.refNum) t.tosRefNum = feeRec.refNum;
                        feesReconciled++;
                    } else {
                        // Leave commissionFees: 0 as safe fallback
                        feesUnreconciled++;
                    }
                }
            } else {
                feesUnreconciled = trades.length;
            }

            // Diagnostics
            if (feeResult.stats.trdRowsFound > 0 || feesReconciled > 0) {
                addImportIssue(summary, 'parse_warning', {
                    message: 'TOS fees: ' + feeResult.stats.trdRowsFound + ' Cash Balance TRD rows found, '
                           + feeResult.stats.feeRowsParsed + ' parsed, '
                           + feesReconciled + ' reconciled, '
                           + feesUnreconciled + ' unreconciled'
                });
            }

            summary.skippedRows = skippedRows;
            summary.importedTradeCount = trades.length;
            summary.warningCount += (summary.issueCounts['parse_warning'] || 0);

            return {
                trades:      trades,
                rawRowCount: rows.length,
                skippedRows: skippedRows,
                summary:     summary
            };
        }

        // ── End TOS section parser ───────────────────────────────────────────────

        // ── End import summary / diagnostics ─────────────────────────────────────

        // ── Broker fallback fee rules ────────────────────────────────────────────
        // Used when a broker CSV does not expose a per-row fee column.
        // Only option fees are estimated in this first pass; stock fee
        // estimation is deferred to a future phase.
        const BROKER_FEE_RULES = {
            webull: {
                option: {
                    // Webull charges no commission on options, but regulatory
                    // fees apply per-contract on both buy and sell legs.
                    regFeePerContract: 0.03915,
                    // Certain index options carry an additional exchange fee.
                    indexSurchargePerContract: 0.07,
                    indexSymbols: ['SPX','XSP','NDX','RUT','VIX','DJX','OEX','XEO']
                }
                // stock: intentionally omitted — not estimated in this pass
            }
        };

        /**
         * Apply fallback fee estimation to matched trade slices when the
         * broker profile has no commission column (commission: []).
         *
         * Mutates slices in place: sets commissionFees, recalculates pnl,
         * and stores grossPnl + feeSource on each affected slice.
         *
         * Only applies to option slices for Webull in this first pass.
         * Stock slices and brokers without a fee rule are left unchanged.
         *
         * @param {object[]} slices - matched trade slices from matchTradePairs
         * @param {string}   profileKey - key into BROKER_PROFILES (e.g. 'webull')
         */
        function _applyFallbackFees(slices, profileKey) {
            var rules = BROKER_FEE_RULES[profileKey];
            if (!rules) return;

            for (var i = 0; i < slices.length; i++) {
                var sl = slices[i];

                // Skip if the slice already carries actual fee data
                // (from a broker CSV column or prior estimation).
                if (sl.commissionFees && sl.feeSource === 'actual') continue;

                if (sl.assetType === 'option' && rules.option) {
                    var r = rules.option;
                    var qty = Number(sl.quantity) || 0;
                    // Fee is charged on both the opening and closing leg,
                    // so 2x per-contract regulatory fee for a round-trip slice.
                    var fee = r.regFeePerContract * qty * 2;
                    // Index-option surcharge (also both legs).
                    var sym = (sl.symbol || '').toUpperCase();
                    if (r.indexSymbols.indexOf(sym) !== -1) {
                        fee += r.indexSurchargePerContract * qty * 2;
                    }
                    fee = Math.round(fee * 100) / 100; // avoid float dust

                    var multiplier = 100; // options always 100x
                    var grossPnl = sl.type === 'long'
                        ? (sl.exitPrice - sl.entryPrice) * qty * multiplier
                        : (sl.entryPrice - sl.exitPrice) * qty * multiplier;

                    sl.commissionFees = fee;
                    sl.grossPnl       = grossPnl;
                    sl.pnl            = grossPnl - fee;
                    sl.feeSource      = 'estimated';
                }
                // Stock slices: intentionally not estimated in this pass.
            }
        }

        const brokerCsvInput = document.getElementById('broker-csv-input');
        const brokerImportUploadArea = document.getElementById('broker-import-upload-area');
        let brokerImportState = null;

        function createEmptyBrokerImportState() {
            return {
                files: [],
                parsedRows: 0,
                matchedTrades: [],
                newTrades: [],
                exactDuplicates: [],
                possibleDuplicates: [],
                duplicateDecisions: {},
                // Phase 3: per-grouped-trade user choice from review step.
                // Keyed by trade._tempId. Values: 'keep' (default) or
                // 'split'. Only applies to matchedTrades where fills.length
                // > 1; confirmBrokerImport honors it when saving.
                splitDecisions: {},
                skippedRows: 0,
                unmatchedRows: 0,
                batchDuplicatesDropped: 0,
                assetTypes: new Set(),
                // Broker-agnostic import diagnostics (one per file, merged
                // into a combined summary for multi-file uploads).
                importSummaries: [],
                // Structured unmatched activity from matchTradePairs.
                // Each entry: { type, symbol, action, quantity, price,
                //   timestamp, optionType, strike, expiry, contractName,
                //   sourceFile, _reviewDecision }
                unmatchedActivity: [],
                // Per-row user decisions: 'skip' (default) or 'manual'
                unmatchedDecisions: {},
            };
        }

        function openBrokerImportModal() {
            resetBrokerImportFlow();
            if (brokerCsvInput) brokerCsvInput.value = '';
            window.populateBrokerAccountDropdowns();
            openModal('broker-import-modal', 'broker-import-trigger');
        }

        function closeBrokerImportModal() {
            closeModal('broker-import-modal');
        }

        function resetBrokerImportFlow() {
            brokerImportState = createEmptyBrokerImportState();
            document.getElementById('broker-import-upload-step').classList.remove('hidden');
            document.getElementById('broker-import-mode-step').classList.add('hidden');
            document.getElementById('broker-import-review-step').classList.add('hidden');
            document.getElementById('broker-import-success-step').classList.add('hidden');
            document.getElementById('broker-import-next-btn').style.display = 'none';
            document.getElementById('broker-import-continue-btn').style.display = 'none';
            document.getElementById('broker-import-back-btn').style.display = 'none';
            document.getElementById('broker-import-footer-left').textContent = '';
            document.getElementById('broker-import-summary-grid').innerHTML = '';
            document.getElementById('broker-import-preview-body').innerHTML = '';
            document.getElementById('broker-import-duplicate-list').innerHTML = '';
            document.getElementById('broker-import-possible-duplicates').classList.add('hidden');
            document.getElementById('broker-import-files').textContent = '';
            var _diagEl = document.getElementById('broker-import-diagnostics');
            if (_diagEl) _diagEl.innerHTML = '';
            var _hwEl = document.getElementById('broker-import-header-warning');
            if (_hwEl) { _hwEl.style.display = 'none'; _hwEl.innerHTML = ''; }
            var _umaEl = document.getElementById('broker-import-unmatched-section');
            if (_umaEl) { _umaEl.innerHTML = ''; _umaEl.style.display = 'none'; }
            updateBrokerImportStepPills(0);
            // NOTE: brokerCsvInput is NOT cleared here. Clearing the <input>
            // before PapaParse reads file content via FileReader can revoke
            // the browser's read-grant for browse-selected files (the grant
            // is tied to the input element, not the File object). Callers
            // that need to clear the input do so explicitly after parsing.
            document.querySelectorAll('input[name="broker-import-mode"]').forEach((input, idx) => {
                input.checked = idx === 0;
            });
        }

        function updateBrokerImportStepPills(activeIndex) {
            document.querySelectorAll('#broker-import-stepper .import-step-pill').forEach((pill, index) => {
                pill.classList.toggle('active', index <= activeIndex);
            });
        }

        if (brokerImportUploadArea && brokerCsvInput) {
            brokerImportUploadArea.addEventListener('click', () => brokerCsvInput.click());
            brokerImportUploadArea.addEventListener('dragover', (e) => {
                e.preventDefault();
                brokerImportUploadArea.style.borderColor = 'var(--primary)';
            });
            brokerImportUploadArea.addEventListener('dragleave', () => {
                brokerImportUploadArea.style.borderColor = 'var(--border)';
            });
            brokerImportUploadArea.addEventListener('drop', (e) => {
                e.preventDefault();
                brokerImportUploadArea.style.borderColor = 'var(--border)';
                // Snapshot into a plain array at the event boundary so no
                // live FileList reference ever leaves this handler.
                const files = e.dataTransfer.files?.length
                    ? Array.from(e.dataTransfer.files) : [];
                if (files.length) checkImportAccountThenProcess(files);
            });
            brokerCsvInput.addEventListener('change', (e) => {
                // Snapshot immediately — the live FileList on e.target is
                // invalidated if the <input> is later cleared/reset.
                const files = e.target.files?.length
                    ? Array.from(e.target.files) : [];
                if (files.length) checkImportAccountThenProcess(files);
            });
        }

        // Clear the header-mismatch warning when the user changes the broker dropdown.
        var _brokerSelect = document.getElementById('broker-import-broker-select');
        if (_brokerSelect) {
            _brokerSelect.addEventListener('change', function() {
                var _hw = document.getElementById('broker-import-header-warning');
                if (_hw) { _hw.style.display = 'none'; _hw.innerHTML = ''; }
            });
        }

        let pendingImportFiles = null;
        // Set to true when the broker-account-modal is opened from the import account dropdown.
        // Cleared on save (auto-selects new account) or cancel.
        let _pendingImportAccountCreate = false;
        let _importAccountPrevVal = '';

        // Wire "+ Add New Account" sentinel in the import account dropdown.
        // mousedown captures the current value before the change event fires.
        const _importAcctSel = document.getElementById('broker-import-account-select');
        if (_importAcctSel) {
            _importAcctSel.addEventListener('mousedown', () => {
                _importAccountPrevVal = _importAcctSel.value;
            });
            _importAcctSel.addEventListener('change', () => {
                if (_importAcctSel.value === '__add_new__') {
                    _importAcctSel.value = _importAccountPrevVal; // revert immediately
                    window._pendingImportAccountCreate = true;
                    window.openBrokerAccountModal();               // reuse existing flow
                }
            });
        }

        function checkImportAccountThenProcess(fileList) {
            // Snapshot immediately — fileList may be a live FileList that
            // becomes empty if the <input> is cleared or reset later.
            const files = Array.from(fileList);
            const accountSelect = document.getElementById('broker-import-account-select');
            const selectedAccount = accountSelect?.value || '';

            if (!selectedAccount || selectedAccount === '__add_new__') {
                pendingImportFiles = files;
                openModal('import-account-prompt-modal');
            } else {
                handleBrokerImportFiles(files);
            }
        }

        function importWithSelectedAccount() {
            closeModal('import-account-prompt-modal');
            const accountSelect = document.getElementById('import-prompt-account-select');
            const mainSelect = document.getElementById('broker-import-account-select');
            if (accountSelect?.value && mainSelect) {
                mainSelect.value = accountSelect.value;
            }
            if (pendingImportFiles) {
                handleBrokerImportFiles(pendingImportFiles);
                pendingImportFiles = null;
            }
        }

        function importWithoutAccount() {
            closeModal('import-account-prompt-modal');
            // Ensure an "Unknown" broker account exists
            window.ensureBrokerAccounts?.();
            let unknown = journalData.brokerAccounts.find(a => a.displayName === 'Unknown');
            if (!unknown) {
                unknown = {
                    id: generateBrokerAccountId(),
                    broker: 'Unknown',
                    accountNumber: '',
                    displayName: 'Unknown',
                    tradingStyle: 'day_trading',
                    color: '#9ca3af',
                    isDefault: false,
                    createdAt: new Date().toISOString()
                };
                journalData.brokerAccounts.push(unknown);
                saveToIndexedDB();
                window.populateBrokerAccountDropdowns();
                window.renderBrokerAccountsList();
            }
            const mainSelect = document.getElementById('broker-import-account-select');
            if (mainSelect) mainSelect.value = unknown.id;
            if (pendingImportFiles) {
                handleBrokerImportFiles(pendingImportFiles);
                pendingImportFiles = null;
            }
        }

        async function handleBrokerImportFiles(files) {
            // files is already a plain Array (snapshotted in
            // checkImportAccountThenProcess). resetBrokerImportFlow() no
            // longer clears the <input> — that is deferred until after
            // PapaParse has finished reading every file via FileReader.
            resetBrokerImportFlow();
            brokerImportState.files = files;
            document.getElementById('broker-import-footer-left').textContent = 'Parsing uploaded file(s)...';
            updateBrokerImportStepPills(0);

            const profile = getSelectedBrokerProfile();

            // Guard: block import for brokers that are not yet active/verified
            if (!profile.active) {
                alert(
                    '"' + profile.label + '" import is not yet available.\n\n' +
                    'This broker profile is provisional and has not been validated against ' +
                    'a real CSV export. Import support will be enabled after sample CSV ' +
                    'validation is complete.\n\n' +
                    'Please select Webull, or contact support to request ' + profile.label + ' validation.'
                );
                document.getElementById('broker-import-footer-left').textContent = '';
                if (brokerCsvInput) brokerCsvInput.value = '';
                return;
            }

            // ── Broker/header mismatch check ─────────────────────────────
            // For flat-CSV brokers: parse header row and validate.
            // For section-based brokers (TOS): read file text and check
            // for the expected format signature instead.
            var _headerWarnEl = document.getElementById('broker-import-header-warning');
            if (_headerWarnEl) { _headerWarnEl.style.display = 'none'; _headerWarnEl.innerHTML = ''; }

            var _isSectionBased = !!profile.sectionBased;

            if (files.length > 0 && !_isSectionBased && profile.requiredHeaders && profile.requiredHeaders.length > 0) {
                var _headerCheckFile = files[0];
                var _fileHeaders = await _parseHeadersOnly(_headerCheckFile);
                var _headerCheck = _validateFileAgainstBroker(profile, _fileHeaders, _headerCheckFile.name);
                if (!_headerCheck.valid) {
                    if (_headerWarnEl) {
                        _headerWarnEl.innerHTML = _formatHeaderMismatchHtml(_headerCheck, profile);
                        _headerWarnEl.style.display = '';
                    }
                    document.getElementById('broker-import-footer-left').textContent = '';
                    if (brokerCsvInput) brokerCsvInput.value = '';
                    return;
                }
            }

            // Section-based broker validation: check that the file is
            // actually a TOS Account Statement before parsing sections.
            if (_isSectionBased && files.length > 0) {
                var _tosCheckText = await _readFileAsText(files[0]);
                if (!_isTosAccountStatement(_tosCheckText)) {
                    if (_headerWarnEl) {
                        // Try to detect if it's a known flat-CSV broker
                        var _flatHeaders = [];
                        try {
                            var _tmpParse = Papa.parse(_tosCheckText.substring(0, 2000), { header: true, preview: 1 });
                            _flatHeaders = (_tmpParse.meta && _tmpParse.meta.fields) || [];
                        } catch (e) { /* ignore */ }
                        var _likely = _detectLikelyBroker(_flatHeaders, profile._profileKey);
                        var _msg = '<strong>File format mismatch</strong><br>';
                        _msg += 'This file does not appear to be a <strong>thinkorswim Account Statement</strong> CSV.';
                        if (_likely) {
                            _msg += '<div style="margin-top:8px;padding:6px 10px;border-radius:6px;background:rgba(59,130,246,0.08);font-size:12px;">';
                            _msg += 'This file looks like a <strong>' + escapeHtml(_likely.label) + '</strong> export. ';
                            _msg += 'Select <strong>' + escapeHtml(_likely.label) + '</strong> from the broker dropdown above and try again.';
                            _msg += '</div>';
                        } else {
                            _msg += '<div style="margin-top:8px;font-size:12px;color:var(--text-secondary);">';
                            _msg += 'TOS Account Statement files start with "Account Statement for..." and contain section headers. ';
                            _msg += 'Please verify you exported from thinkorswim Account Statement.';
                            _msg += '</div>';
                        }
                        _headerWarnEl.innerHTML = _msg;
                        _headerWarnEl.style.display = '';
                    }
                    document.getElementById('broker-import-footer-left').textContent = '';
                    if (brokerCsvInput) brokerCsvInput.value = '';
                    return;
                }
            }

            let tempId = 0;
            for (const file of files) {
                // Branch: section-based (TOS) vs flat-CSV (Webull, Robinhood)
                var parsed;
                if (_isSectionBased) {
                    var _fileText = await _readFileAsText(file);
                    parsed = _parseTosAccountStatement(_fileText, file.name, profile);
                } else {
                    parsed = await parseCSV(file, profile);
                }
                brokerImportState.parsedRows += parsed.rawRowCount;
                brokerImportState.skippedRows += parsed.skippedRows;
                // Collect per-file import summary for diagnostics
                if (parsed.summary) {
                    brokerImportState.importSummaries.push(parsed.summary);
                }
                const matched = matchTradePairs(parsed.trades);
                // Apply fallback fee estimation for brokers without a fee
                // column (e.g. Webull). Only option slices are estimated in
                // this pass. Must run before grouping so per-slice fees are
                // set before deriveTradeSummaryFromFills aggregates them.
                if (Array.isArray(profile.commission) && profile.commission.length === 0) {
                    _applyFallbackFees(matched, profile._profileKey);
                }
                brokerImportState.unmatchedRows += (matched.unmatchedRows || 0);
                // Collect structured unmatched activity
                var _uma = matched.unmatchedActivity || [];
                for (var ui = 0; ui < _uma.length; ui++) {
                    var uRow = _uma[ui];
                    uRow.sourceFile = file.name;
                    uRow._umaId = 'uma_' + (brokerImportState.unmatchedActivity.length + 1);
                    brokerImportState.unmatchedActivity.push(uRow);
                    // Feed into per-file import summary
                    if (parsed.summary) {
                        addImportIssue(parsed.summary, uRow.type, {
                            code:    uRow.action || '',
                            symbol:  uRow.symbol || '',
                            date:    uRow.timestamp || '',
                            message: (uRow.type === 'unmatched_close'
                                ? 'Close without opening leg: '
                                : 'Open position never closed: ')
                                + (uRow.symbol || '?') + ' ' + (uRow.quantity || '') + ' @ $' + (Number(uRow.price) || 0).toFixed(2)
                        });
                    }
                }
                matched.forEach(trade => {
                    trade._tempId = ++tempId;
                    trade.source = 'csv';
                    trade.sourceFile = file.name;
                    // Scope positionId by source file so the per-file
                    // counters in matchTradePairs can't collide across a
                    // multi-file batch (e.g. two files that each happen to
                    // produce positionId=1 for the same contract must NOT
                    // merge; they are distinct round-trips).
                    if (trade._positionId != null) {
                        trade._positionId = file.name + '#' + trade._positionId;
                    }
                    brokerImportState.assetTypes.add(trade.optionType ? 'Options' : 'Equities');
                    brokerImportState.matchedTrades.push(trade);
                });
            }

            // Phase 2: collapse split-fill matched slices into one logical
            // trade with fills[]. Single-slice buckets pass through
            // unchanged, preserving legacy single-row behavior. Duplicate
            // detection, review UI, and confirmBrokerImport all continue to
            // operate on brokerImportState.matchedTrades as before — the
            // only difference is that some entries are now fills-bearing
            // logical trades whose scalars were derived via
            // finalizeTradeSummary().
            brokerImportState.matchedTrades = groupMatchedSlicesIntoLogicalTrades(
                brokerImportState.matchedTrades
            );

            // Phase 2b: remove exact duplicate logical trades that appear
            // across multiple uploaded files (overlapping date ranges).
            // Must run after grouping (so fills are collapsed) and before
            // classifyImportedTrades (so account-level comparison sees a
            // clean batch with no internal duplicates).
            _dedupeImportBatch();

            classifyImportedTrades();
            renderBrokerImportReview();

            // Safe to clear now — FileReader has finished with every file.
            // This allows re-selecting the same CSV to trigger a new change event.
            if (brokerCsvInput) brokerCsvInput.value = '';
        }

        function parseCSV(file, profile) {
            var isRobinhood = profile._profileKey === 'robinhood';
            var summary = createImportSummary(profile._profileKey || profile.label, file.name);

            return new Promise((resolve) => {
                Papa.parse(file, {
                    header: true,
                    skipEmptyLines: true,
                    complete: (results) => {
                        let skippedRows = 0;
                        summary.totalRows = results.data.length;

                        const trades = results.data.map(row => {
                            // ── Robinhood pre-filter: footer/blank rows ──────
                            if (isRobinhood && _isRobinhoodFooterRow(row)) {
                                addImportIssue(summary, 'invalid_row', {
                                    message: 'Footer or blank row'
                                });
                                skippedRows += 1;
                                return null;
                            }

                            // ── Robinhood pre-filter: non-trade activity ─────
                            if (isRobinhood) {
                                var rawCode = _pickCol(row, profile.action) || '';
                                var codeLower = String(rawCode).trim().toLowerCase();
                                var nonTradeLabel = ROBINHOOD_NON_TRADE_CODES[codeLower];
                                if (nonTradeLabel) {
                                    addImportIssue(summary, 'recognized_non_trade', {
                                        code:    rawCode,
                                        symbol:  _pickCol(row, profile.symbol) || '',
                                        date:    _pickCol(row, profile.timestamp) || '',
                                        message: nonTradeLabel
                                    });
                                    skippedRows += 1;
                                    return null;
                                }
                            }

                            let timestamp = _pickCol(row, profile.timestamp);
                            let symbol    = _pickCol(row, profile.symbol);
                            let optionType = null;
                            let strike = 0;
                            let expiry = null;
                            var contractName = '';

                            // ── Option parsing: OCC symbol format (Webull etc.) ──
                            if (!isRobinhood && symbol && symbol.length > 6) {
                                const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
                                if (match) {
                                    contractName = symbol;
                                    symbol = match[1];
                                    const yr = parseInt(match[2].substring(0, 2)) + 2000;
                                    const mo = match[2].substring(2, 4);
                                    const dy = match[2].substring(4, 6);
                                    expiry = `${yr}-${mo}-${dy}`;
                                    optionType = match[3] === 'C' ? 'CALL' : 'PUT';
                                    strike = parseInt(match[4]) / 1000;
                                }
                            }

                            // ── Option parsing: Robinhood Description field ──
                            if (isRobinhood && symbol) {
                                var desc = row['Description'] || '';
                                var optParsed = _parseRobinhoodOptionDescription(desc, symbol);
                                if (optParsed) {
                                    optionType   = optParsed.optionType;
                                    strike       = optParsed.strike;
                                    expiry       = optParsed.expiry;
                                    contractName = optParsed.contractName;
                                }
                            }

                            let priceStr = _pickCol(row, profile.price) || '0';
                            if (typeof priceStr === 'string') priceStr = priceStr.replace('@', '').replace('$', '').trim();

                            // Commission: read from profile column if present; defaults to 0.
                            const rawComm = _pickCol(row, profile.commission);
                            const commissionFees = rawComm != null
                                ? (parseFloat(String(rawComm).replace(/[$,]/g, '').trim()) || 0)
                                : 0;

                            const trade = {
                                timestamp,
                                symbol,
                                contractName: optionType ? contractName : '',
                                action:        normalizeAction(_pickCol(row, profile.action)),
                                quantity:      parseFloat(_pickCol(row, profile.quantity) || 0),
                                price:         parseFloat(priceStr),
                                commissionFees,
                                optionType,
                                strike,
                                expiry
                            };

                            // Explicitly exclude canceled / rejected / expired / void rows.
                            const rawStatus = Array.isArray(profile.status) && profile.status.length
                                ? (_pickCol(row, profile.status) || '')
                                : '';
                            const statusStr = String(rawStatus).trim().toLowerCase();
                            const actionStr = String(trade.action || '').toLowerCase();
                            const isCanceled =
                                statusStr.indexOf('cancel') !== -1 ||
                                statusStr.indexOf('reject') !== -1 ||
                                statusStr.indexOf('expired') !== -1 ||
                                statusStr.indexOf('void') !== -1 ||
                                actionStr.indexOf('cancel') !== -1 ||
                                actionStr.indexOf('reject') !== -1 ||
                                actionStr.indexOf('expired') !== -1 ||
                                actionStr.indexOf('void') !== -1;
                            if (isCanceled) {
                                addImportIssue(summary, 'recognized_non_trade', {
                                    code: _pickCol(row, profile.action) || '',
                                    message: 'Canceled/rejected/expired/void order'
                                });
                                skippedRows += 1;
                                return null;
                            }

                            // ── Catch-all for rows that lack required trade fields ──
                            if (!trade.symbol || !trade.action || !(trade.quantity > 0) || !trade.timestamp || !Number.isFinite(trade.price)) {
                                // Robinhood: check if this is an unknown trans code
                                // that isn't in ACTION_MAP and isn't in the non-trade list
                                var rawAction = _pickCol(row, profile.action) || '';
                                var rawActionLower = String(rawAction).trim().toLowerCase();
                                if (isRobinhood && rawAction && !ROBINHOOD_NON_TRADE_CODES[rawActionLower]
                                    && ACTION_MAP[rawAction.trim()] === undefined) {
                                    addImportIssue(summary, 'unsupported_code', {
                                        code:    rawAction,
                                        symbol:  _pickCol(row, profile.symbol) || '',
                                        date:    _pickCol(row, profile.timestamp) || '',
                                        message: 'Unknown trans code: ' + rawAction.trim()
                                    });
                                    summary.unsupportedRows += 1;
                                } else {
                                    addImportIssue(summary, 'missing_required_field', {
                                        code:    rawAction,
                                        symbol:  trade.symbol || '',
                                        date:    trade.timestamp || '',
                                        message: 'Missing: ' + [
                                            !trade.symbol    ? 'symbol' : '',
                                            !trade.action    ? 'action' : '',
                                            !(trade.quantity > 0) ? 'quantity' : '',
                                            !trade.timestamp ? 'timestamp' : '',
                                            !Number.isFinite(trade.price) ? 'price' : ''
                                        ].filter(Boolean).join(', ')
                                    });
                                }
                                skippedRows += 1;
                                return null;
                            }
                            return trade;
                        }).filter(Boolean);

                        summary.skippedRows = skippedRows;
                        summary.importedTradeCount = trades.length;
                        summary.warningCount = (summary.issueCounts['parse_warning'] || 0)
                                             + (summary.issueCounts['ambiguous_match'] || 0);

                        resolve({
                            trades,
                            rawRowCount: results.data.length,
                            skippedRows,
                            summary
                        });
                    }
                });
            });
        }

        function normalizeTimestamp(value) {
            if (!value) return null;
            const cleaned = String(value).replace(/\s+[A-Z]{2,4}$/, '');
            const parsed = new Date(cleaned);
            return Number.isNaN(parsed.getTime()) ? null : parsed;
        }

        function matchTradePairs(trades) {
            const sorted = [...trades].sort((a, b) => normalizeTimestamp(a.timestamp) - normalizeTimestamp(b.timestamp));
            const matched = [];


            // Separate open queues per contract key:
            //   openLong  — BUYs waiting for a closing SELL  (long trades)
            //   openShort — SELLs waiting for a closing BUY  (short trades)
            const openLong  = {};
            const openShort = {};

            // Position-cycle tracking per contract key, per side.
            // A positionId spans one round-trip: first opening row while
            // flat through the closing rows that return to flat. Pyramids
            // and partial fills inherit the current positionId.
            const positionCounters = {};          // per-key monotonic counter
            const currentPosIdLong  = {};         // active positionId for longs
            const currentPosIdShort = {};         // active positionId for shorts
            const netQtyLong  = {};               // running long qty per key
            const netQtyShort = {};               // running short qty per key

            // Helper: create one matched slice from an opening row and a
            // closing row. Shared by the long and short paths.
            function _emitSlice(openRow, closeRow, qty, side) {
                var entryTime = normalizeTimestamp(openRow.timestamp);
                var exitTime  = normalizeTimestamp(closeRow.timestamp);
                var holdSeconds = entryTime && exitTime
                    ? Math.max(0, (exitTime - entryTime) / 1000) : 0;
                var isOption   = !!(closeRow.optionType || openRow.optionType);
                var multiplier = isOption ? 100 : 1;

                // Commission: per-ROW, charged on first slice only.
                var entryComm = openRow.commissionFees || 0;
                var exitComm  = closeRow.commissionFees || 0;
                var commFees  = entryComm + exitComm;

                var grossPnl = side === 'long'
                    ? (closeRow.price - openRow.price) * qty * multiplier
                    : (openRow.price - closeRow.price) * qty * multiplier;
                var pnl = grossPnl - commFees;

                // feeSource: 'actual' when the CSV provided fee data
                // (including genuinely fee-free rows confirmed by the broker),
                // absent (undefined) when fees are zero and no column existed.
                var feeSource = (openRow.feeSource === 'actual' || closeRow.feeSource === 'actual')
                    ? 'actual'
                    : (commFees > 0 ? 'actual' : undefined);

                matched.push({
                    symbol:     closeRow.symbol,
                    type:       side,
                    assetType:  isOption ? 'option' : 'stock',
                    entryTime:  entryTime ? entryTime.toISOString() : openRow.timestamp,
                    exitTime:   exitTime  ? exitTime.toISOString()  : closeRow.timestamp,
                    holdSeconds,
                    quantity:   qty,
                    entryPrice: openRow.price,
                    exitPrice:  closeRow.price,
                    grossPnl,
                    pnl,
                    commissionFees:      commFees,
                    feeSource:           feeSource,
                    entryCommissionFees: entryComm,
                    exitCommissionFees:  exitComm,
                    optionType:   closeRow.optionType || openRow.optionType,
                    strike:       closeRow.strike     || openRow.strike,
                    expiry:       closeRow.expiry      || openRow.expiry,
                    contractName: closeRow.contractName || openRow.contractName || '',
                    _positionId:  openRow._positionId
                });

                // Zero commissions on consumed rows so split fills don't
                // double-charge (see long-path comment block in prior version).
                openRow.commissionFees  = 0;
                closeRow.commissionFees = 0;
            }

            // Helper: ensure per-key tracking structures exist.
            function _initKey(key) {
                if (!openLong[key])  openLong[key]  = [];
                if (!openShort[key]) openShort[key] = [];
                if (positionCounters[key] == null) positionCounters[key] = 0;
                if (netQtyLong[key]  == null) netQtyLong[key]  = 0;
                if (netQtyShort[key] == null) netQtyShort[key] = 0;
            }

            // Helper: try to close existing positions with this row.
            // Returns without opening new positions — that is deferred
            // to _processOpen so that within a same-timestamp group the
            // "close then open" ordering is guaranteed.
            function _processClose(trade) {
                var action = String(trade.action || '').toUpperCase();
                var key = `${trade.symbol}_${trade.optionType || 'shares'}_${trade.strike || 0}`;
                _initKey(key);

                if (action.includes('BUY')) {
                    // BUY closes open shorts (FIFO).
                    while (trade.quantity > 0 && openShort[key].length > 0) {
                        var openRow = openShort[key][0];
                        var qty = Math.min(openRow.quantity, trade.quantity);
                        _emitSlice(openRow, trade, qty, 'short');
                        openRow.quantity -= qty;
                        trade.quantity   -= qty;
                        netQtyShort[key] -= qty;
                        if (netQtyShort[key] < 0) netQtyShort[key] = 0;
                        if (openRow.quantity === 0) openShort[key].shift();
                    }
                } else if (action.includes('SHORT')) {
                    // Explicit SHORT: always opens a short position.
                    // Never consumes open longs — skip closing entirely.
                    // _processOpen will handle this row.
                } else if (action.includes('SELL')) {
                    // SELL closes open longs (FIFO). Any remainder
                    // becomes a short open via _processOpen.
                    while (trade.quantity > 0 && openLong[key].length > 0) {
                        var openRow = openLong[key][0];
                        var qty = Math.min(openRow.quantity, trade.quantity);
                        _emitSlice(openRow, trade, qty, 'long');
                        openRow.quantity -= qty;
                        trade.quantity   -= qty;
                        netQtyLong[key]  -= qty;
                        if (netQtyLong[key] < 0) netQtyLong[key] = 0;
                        if (openRow.quantity === 0) openLong[key].shift();
                    }
                }
            }

            // Helper: open a new position (or extend an existing one)
            // with any remaining quantity after closing.
            function _processOpen(trade) {
                if (trade.quantity <= 0) return;
                var action = String(trade.action || '').toUpperCase();
                var key = `${trade.symbol}_${trade.optionType || 'shares'}_${trade.strike || 0}`;

                if (action.includes('BUY')) {
                    // Remaining BUY qty opens a long position.
                    if (netQtyLong[key] <= 0) {
                        positionCounters[key] += 1;
                        currentPosIdLong[key]  = positionCounters[key];
                    }
                    openLong[key].push({ ...trade, _positionId: currentPosIdLong[key] });
                    netQtyLong[key] += (Number(trade.quantity) || 0);
                } else if (action.includes('SHORT') || action.includes('SELL')) {
                    // Remaining SELL or explicit SHORT qty opens a
                    // short position.
                    if (netQtyShort[key] <= 0) {
                        positionCounters[key]  += 1;
                        currentPosIdShort[key]  = positionCounters[key];
                    }
                    openShort[key].push({ ...trade, _positionId: currentPosIdShort[key] });
                    netQtyShort[key] += (Number(trade.quantity) || 0);
                }
            }

            // ── Main loop: process in timestamp groups ──────────────
            // Within each group of rows sharing the same filled-time,
            // CLOSE existing positions first (pass 1), then OPEN new
            // positions with remaining qty (pass 2). This prevents
            // same-second close+open sequences from being misread as
            // one continuous position when CSV row order puts all buys
            // before all sells (common in Webull exports).
            var idx = 0;
            while (idx < sorted.length) {
                var groupStart = idx;
                var tsMs = normalizeTimestamp(sorted[idx].timestamp)?.getTime() || 0;
                while (idx < sorted.length) {
                    var nextMs = normalizeTimestamp(sorted[idx].timestamp)?.getTime() || 0;
                    if (nextMs !== tsMs) break;
                    idx++;
                }
                // sorted[groupStart..idx-1] share the same timestamp.

                // Pass 1: close existing positions only.
                for (var gi = groupStart; gi < idx; gi++) {
                    _processClose(sorted[gi]);
                }
                // Pass 2: remaining qty — try to close positions that
                // were opened within this same group, then open new.
                for (var gi = groupStart; gi < idx; gi++) {
                    _processClose(sorted[gi]);  // close intra-group
                    _processOpen(sorted[gi]);    // open with leftover
                }
            }

            // Collect structured unmatched rows instead of just counting.
            // openLong  = BUYs that never got a closing SELL  → unmatched_open
            // openShort = SELLs that never got a closing BUY  → could be
            //   unmatched_open (explicit short) or unmatched_close (sell
            //   without a prior buy in the file). We classify by checking
            //   the original action: if the row entered openShort via
            //   _processOpen with remaining SELL qty (i.e. SELL that
            //   couldn't close a long), it's an unmatched_close.
            //   If it was an explicit SHORT, it's an unmatched_open.
            var unmatchedRows = 0;
            var _unmatchedActivity = [];

            for (var k in openLong) {
                for (var i = 0; i < openLong[k].length; i++) {
                    var row = openLong[k][i];
                    if (row.quantity > 0) {
                        unmatchedRows++;
                        _unmatchedActivity.push({
                            type:         'unmatched_open',
                            symbol:       row.symbol,
                            action:       row.action,
                            quantity:     row.quantity,
                            price:        row.price,
                            timestamp:    row.timestamp,
                            optionType:   row.optionType || null,
                            strike:       row.strike || 0,
                            expiry:       row.expiry || null,
                            contractName: row.contractName || ''
                        });
                    }
                }
            }
            for (var k in openShort) {
                for (var i = 0; i < openShort[k].length; i++) {
                    var row = openShort[k][i];
                    if (row.quantity > 0) {
                        unmatchedRows++;
                        // Classify: explicit SHORT action → unmatched_open
                        // (short position never covered). SELL action that
                        // ended up in openShort because no prior BUY existed
                        // → unmatched_close (close-only row; opening leg is
                        // outside the imported file range).
                        var rawAction = String(row.action || '').toUpperCase();
                        var isExplicitShort = rawAction.includes('SHORT');
                        _unmatchedActivity.push({
                            type:         isExplicitShort ? 'unmatched_open' : 'unmatched_close',
                            symbol:       row.symbol,
                            action:       row.action,
                            quantity:     row.quantity,
                            price:        row.price,
                            timestamp:    row.timestamp,
                            optionType:   row.optionType || null,
                            strike:       row.strike || 0,
                            expiry:       row.expiry || null,
                            contractName: row.contractName || ''
                        });
                    }
                }
            }

            matched.unmatchedRows = unmatchedRows;
            matched.unmatchedActivity = _unmatchedActivity;
            return matched;
        }

        // ── Import diagnostics rendering ──────────────────────────────────
        // Renders the broker-agnostic import summary into the review step.
        // Called from goToImportReview(). Merges per-file summaries into a
        // combined view with grouped issue counts and capped samples.

        function _renderImportDiagnostics() {
            var el = document.getElementById('broker-import-diagnostics');
            if (!el) return;
            var summaries = (brokerImportState && brokerImportState.importSummaries) || [];
            if (summaries.length === 0) { el.innerHTML = ''; return; }

            // Merge issue counts and samples across files
            var mergedCounts  = {};
            var mergedSamples = {};
            var totalUnsupported = 0;
            var broker = '';
            for (var i = 0; i < summaries.length; i++) {
                var s = summaries[i];
                if (!broker) broker = s.broker || '';
                totalUnsupported += (s.unsupportedRows || 0);
                for (var type in s.issueCounts) {
                    mergedCounts[type] = (mergedCounts[type] || 0) + s.issueCounts[type];
                    if (!mergedSamples[type]) mergedSamples[type] = [];
                    var samples = s.issueSamples[type] || [];
                    for (var j = 0; j < samples.length && mergedSamples[type].length < MAX_ISSUE_SAMPLES; j++) {
                        mergedSamples[type].push(samples[j]);
                    }
                }
            }

            // If no issues at all, show nothing
            var hasAnyIssues = false;
            for (var t in mergedCounts) { if (mergedCounts[t] > 0) { hasAnyIssues = true; break; } }
            if (!hasAnyIssues) { el.innerHTML = ''; return; }

            var html = '<div style="margin-top:12px;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);font-size:12px;">';
            html += '<div style="font-weight:600;margin-bottom:8px;color:var(--text-primary);">Import Diagnostics</div>';

            // Broker-specific info banner
            if (broker === 'robinhood') {
                html += '<div style="margin-bottom:8px;padding:6px 10px;border-radius:6px;background:rgba(59,130,246,0.08);color:var(--text-secondary);font-size:11px;">'
                      + 'Robinhood exports date-only timestamps (no time of day). Intraday trade ordering is based on CSV row order.'
                      + '</div>';
            }

            // Grouped issue counts
            for (var type in mergedCounts) {
                var count = mergedCounts[type];
                if (count === 0) continue;
                var label = IMPORT_ISSUE_TYPES[type] || type;
                var color = (type === 'unsupported_code' || type === 'parse_warning')
                    ? 'var(--warning, #eab308)' : 'var(--text-secondary)';
                html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;">';
                html += '<span style="color:' + color + ';">' + escapeHtml(label) + '</span>';
                html += '<span style="font-weight:600;color:' + color + ';">' + count + '</span>';
                html += '</div>';

                // Sample details
                var samples = mergedSamples[type] || [];
                if (samples.length > 0) {
                    html += '<div style="margin:2px 0 6px 12px;color:var(--text-secondary);font-size:11px;">';
                    for (var si = 0; si < samples.length; si++) {
                        var sm = samples[si];
                        var parts = [];
                        if (sm.code)    parts.push(escapeHtml(sm.code));
                        if (sm.symbol)  parts.push(escapeHtml(sm.symbol));
                        if (sm.date)    parts.push(escapeHtml(sm.date));
                        if (sm.message) parts.push(escapeHtml(sm.message));
                        html += '<div>' + parts.join(' · ') + '</div>';
                    }
                    if (count > samples.length) {
                        html += '<div style="font-style:italic;">… and ' + (count - samples.length) + ' more</div>';
                    }
                    html += '</div>';
                }
            }

            html += '</div>';
            el.innerHTML = html;
        }

        // ── Unmatched activity review section ────────────────────────────────
        // Renders structured unmatched rows (opens without closes, closes
        // without opens) in the import review step. Broker-agnostic.
        //
        // Decisions:
        //   unmatched_open  → 'import_open_trade' (default) | 'skip'
        //   unmatched_close → 'skip' (only option — manual completion
        //                     flow not yet implemented)

        var _UNMATCHED_PREVIEW_CAP = 15;

        // Shared row-rendering helper for both open and close tables.
        function _renderUnmatchedRow(row, isOpen) {
            var isClose = !isOpen;
            var badgeBg    = isClose ? 'rgba(234,179,8,0.12)' : 'rgba(59,130,246,0.12)';
            var badgeColor = isClose ? 'var(--warning,#eab308)' : 'var(--primary,#3b82f6)';
            var typeLabel  = isClose ? 'Close' : 'Open';
            var decision   = (brokerImportState.unmatchedDecisions || {})[row._umaId]
                           || (isOpen ? 'import_open_trade' : 'skip');
            var optLabel = row.optionType
                ? ' <span style="font-size:11px;color:var(--text-secondary);">'
                  + escapeHtml((row.optionType || '') + ' $' + (row.strike || 0))
                  + (row.expiry ? ' exp ' + escapeHtml(row.expiry) : '')
                  + '</span>'
                : '';

            var h = '<tr>';
            h += '<td style="padding:5px 8px;"><span style="padding:2px 6px;border-radius:4px;background:' + badgeBg + ';color:' + badgeColor + ';font-size:11px;font-weight:600;">' + typeLabel + '</span></td>';
            h += '<td style="padding:5px 8px;">' + escapeHtml(_displaySymbol(row.symbol) || '') + optLabel + '</td>';
            h += '<td style="padding:5px 8px;">' + escapeHtml(row.action || '') + '</td>';
            h += '<td style="padding:5px 8px;">' + (Number(row.quantity) || 0) + '</td>';
            h += '<td style="padding:5px 8px;">$' + (Number(row.price) || 0).toFixed(2) + '</td>';
            h += '<td style="padding:5px 8px;">' + escapeHtml(row.timestamp || '') + '</td>';
            h += '<td style="padding:5px 8px;">';

            if (isOpen) {
                var importCls = decision === 'import_open_trade' ? 'btn-primary selected' : 'btn-secondary';
                var skipCls   = decision === 'skip' ? 'btn-primary selected' : 'btn-secondary';
                h += '<div style="display:flex;gap:4px;">';
                h += '<button type="button" class="btn btn-small ' + importCls + '" style="padding:2px 8px;font-size:11px;" data-uma-decision="import_open_trade" onclick="setUnmatchedDecision(\'' + row._umaId + '\',\'import_open_trade\',this)">Import Open</button>';
                h += '<button type="button" class="btn btn-small ' + skipCls + '" style="padding:2px 8px;font-size:11px;" data-uma-decision="skip" onclick="setUnmatchedDecision(\'' + row._umaId + '\',\'skip\',this)">Skip</button>';
                h += '</div>';
            } else {
                h += '<span style="font-size:11px;color:var(--text-secondary);">Skipped — opening trade not in file</span>';
            }

            h += '</td>';
            h += '</tr>';
            return h;
        }

        function _renderUnmatchedActivitySection() {
            var el = document.getElementById('broker-import-unmatched-section');
            if (!el) return;
            var items = (brokerImportState && brokerImportState.unmatchedActivity) || [];
            if (items.length === 0) { el.innerHTML = ''; el.style.display = 'none'; return; }
            el.style.display = '';

            // Split into opens and closes
            var opens = [], closes = [];
            for (var i = 0; i < items.length; i++) {
                if (items[i].type === 'unmatched_open') opens.push(items[i]);
                else closes.push(items[i]);
            }

            // Set default decision for opens: import_open_trade
            if (!brokerImportState.unmatchedDecisions) brokerImportState.unmatchedDecisions = {};
            for (var oi = 0; oi < opens.length; oi++) {
                if (!brokerImportState.unmatchedDecisions[opens[oi]._umaId]) {
                    brokerImportState.unmatchedDecisions[opens[oi]._umaId] = 'import_open_trade';
                }
            }

            var html = '';

            // Header
            html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;">';
            html += '<div>';
            html += '<h4 style="margin-bottom:4px;">Unmatched Activity</h4>';
            html += '<p style="font-size:13px;color:var(--text-secondary);">These rows could not be paired into complete round-trip trades.</p>';
            html += '</div>';
            html += '<div style="font-size:12px;color:var(--text-secondary);">';
            if (opens.length > 0) html += '<span style="margin-right:10px;">Opens: <strong>' + opens.length + '</strong></span>';
            if (closes.length > 0) html += '<span>Closes: <strong>' + closes.length + '</strong></span>';
            html += '</div>';
            html += '</div>';

            // ── Unmatched Opens ──────────────────────────────────────────
            if (opens.length > 0) {
                html += '<div style="padding:6px 10px;border-radius:6px;background:rgba(59,130,246,0.08);color:var(--primary,#3b82f6);font-size:12px;margin-bottom:8px;font-weight:600;">';
                html += 'Open Positions (' + opens.length + ') — these will be imported as open trades by default';
                html += '</div>';

                var openPreview = opens.slice(0, _UNMATCHED_PREVIEW_CAP);
                html += '<div class="import-preview-table-wrap" style="margin-bottom:14px;"><table style="font-size:12px;">';
                html += '<thead><tr style="text-align:left;">';
                html += '<th style="padding:6px 8px;">Type</th><th style="padding:6px 8px;">Symbol</th><th style="padding:6px 8px;">Action</th>';
                html += '<th style="padding:6px 8px;">Qty</th><th style="padding:6px 8px;">Price</th><th style="padding:6px 8px;">Date</th><th style="padding:6px 8px;">Decision</th>';
                html += '</tr></thead><tbody>';
                for (var oi = 0; oi < openPreview.length; oi++) {
                    html += _renderUnmatchedRow(openPreview[oi], true);
                }
                html += '</tbody></table></div>';
                if (opens.length > _UNMATCHED_PREVIEW_CAP) {
                    html += '<div style="font-size:11px;color:var(--text-secondary);margin-bottom:10px;font-style:italic;">Showing ' + _UNMATCHED_PREVIEW_CAP + ' of ' + opens.length + ' unmatched opens.</div>';
                }
            }

            // ── Unmatched Closes ─────────────────────────────────────────
            if (closes.length > 0) {
                html += '<div style="padding:6px 10px;border-radius:6px;background:rgba(234,179,8,0.08);color:var(--warning,#eab308);font-size:12px;margin-bottom:8px;font-weight:600;">';
                html += 'Closing Trades Without a Matching Open (' + closes.length + ') — the buy that opened these positions is not in this file';
                html += '</div>';

                var closePreview = closes.slice(0, _UNMATCHED_PREVIEW_CAP);
                html += '<div class="import-preview-table-wrap"><table style="font-size:12px;">';
                html += '<thead><tr style="text-align:left;">';
                html += '<th style="padding:6px 8px;">Type</th><th style="padding:6px 8px;">Symbol</th><th style="padding:6px 8px;">Action</th>';
                html += '<th style="padding:6px 8px;">Qty</th><th style="padding:6px 8px;">Price</th><th style="padding:6px 8px;">Date</th><th style="padding:6px 8px;">Status</th>';
                html += '</tr></thead><tbody>';
                for (var ci = 0; ci < closePreview.length; ci++) {
                    html += _renderUnmatchedRow(closePreview[ci], false);
                }
                html += '</tbody></table></div>';
                if (closes.length > _UNMATCHED_PREVIEW_CAP) {
                    html += '<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;font-style:italic;">Showing ' + _UNMATCHED_PREVIEW_CAP + ' of ' + closes.length + ' unmatched closes.</div>';
                }
            }

            el.innerHTML = html;
        }

        function setUnmatchedDecision(umaId, decision, btn) {
            if (!brokerImportState) return;
            if (!brokerImportState.unmatchedDecisions) brokerImportState.unmatchedDecisions = {};
            brokerImportState.unmatchedDecisions[umaId] = decision;
            var wrap = btn && btn.parentElement;
            if (wrap) {
                wrap.querySelectorAll('.btn').forEach(function(el) {
                    var target = el.getAttribute('data-uma-decision');
                    var isActive = target === decision;
                    el.classList.toggle('btn-primary', isActive);
                    el.classList.toggle('btn-secondary', !isActive);
                    el.classList.toggle('selected', isActive);
                });
            }
        }

        // ── Batch-level dedupe ─────────────────────────────────────────────
        // When multiple CSV files are uploaded together, the same trade can
        // appear in more than one file (overlapping date ranges). Each file
        // is parsed and matched independently, and _positionId is scoped by
        // filename, so groupMatchedSlicesIntoLogicalTrades will not merge
        // cross-file duplicates. This dedupe step removes exact duplicates
        // within the import batch before classifyImportedTrades compares
        // the batch against saved account trades.

        /**
         * Deterministic fingerprint for a logical trade. Covers all fields
         * that define trade identity: contract, direction, size, prices,
         * and times. Within a single broker's CSV batch, duplicate trades
         * from overlapping files produce byte-identical values for all of
         * these after matching/grouping.
         */
        function _tradeFingerprint(t) {
            return [
                t.symbol,
                t.type || 'long',
                t.assetType || 'stock',
                t.optionType || '',
                Number(t.strike || 0),
                t.expiry || '',
                Number(t.quantity),
                Number(t.entryPrice),
                Number(t.exitPrice),
                t.entryTime || '',
                t.exitTime || ''
            ].join('|');
        }

        /**
         * Remove exact duplicate logical trades from the current import
         * batch. Keeps the first occurrence of each fingerprint (from the
         * earliest-processed file) and drops later duplicates.
         *
         * Mutates brokerImportState.matchedTrades in place and sets
         * brokerImportState.batchDuplicatesDropped to the count removed.
         */
        function _dedupeImportBatch() {
            var trades = brokerImportState.matchedTrades;
            var seen = {};
            var kept = [];
            var dropped = 0;
            for (var i = 0; i < trades.length; i++) {
                var fp = _tradeFingerprint(trades[i]);
                if (seen[fp]) {
                    dropped++;
                } else {
                    seen[fp] = true;
                    kept.push(trades[i]);
                }
            }
            brokerImportState.matchedTrades = kept;
            brokerImportState.batchDuplicatesDropped = dropped;
        }

        function tradeSimilarity(existing, incoming) {
            const entryA = new Date(existing.entryTime).getTime();
            const entryB = new Date(incoming.entryTime).getTime();
            const exitA = new Date(existing.exitTime).getTime();
            const exitB = new Date(incoming.exitTime).getTime();

            const sameSymbol = existing.symbol === incoming.symbol;
            const sameType = (existing.type || 'long') === (incoming.type || 'long');
            const sameQty = Number(existing.quantity) === Number(incoming.quantity);
            const sameAsset = (existing.optionType || '') === (incoming.optionType || '') && Number(existing.strike || 0) === Number(incoming.strike || 0);

            const entryDiffSec = Math.abs(entryA - entryB) / 1000;
            const exitDiffSec = Math.abs(exitA - exitB) / 1000;
            const entryPriceDiff = Math.abs(Number(existing.entryPrice) - Number(incoming.entryPrice));
            const exitPriceDiff = Math.abs(Number(existing.exitPrice) - Number(incoming.exitPrice));

            let score = 0;
            if (sameSymbol) score += 40;
            if (sameType) score += 10;
            if (sameQty) score += 15;
            if (sameAsset) score += 10;
            if (entryDiffSec <= 2) score += 15;
            else if (entryDiffSec <= 60) score += 8;
            if (exitDiffSec <= 2) score += 15;
            else if (exitDiffSec <= 60) score += 8;
            if (entryPriceDiff <= 0.001) score += 10;
            else if (entryPriceDiff <= 0.05) score += 5;
            if (exitPriceDiff <= 0.001) score += 10;
            else if (exitPriceDiff <= 0.05) score += 5;

            const exact = sameSymbol && sameType && sameQty && sameAsset && entryDiffSec <= 2 && exitDiffSec <= 2 && entryPriceDiff <= 0.001 && exitPriceDiff <= 0.001;
            // Require at least one time-proximity signal to flag as possible duplicate.
            // Symbol + type + asset + quantity alone (without any time proximity) must
            // not reach "possible" — prevents false flags on unrelated trades of the
            // same ticker.
            const hasTimeProximity = entryDiffSec <= 60 || exitDiffSec <= 60;
            const possible = !exact && score >= 70 && hasTimeProximity;

            return { exact, possible, score };
        }

        function classifyImportedTrades() {
            brokerImportState.newTrades = [];
            brokerImportState.exactDuplicates = [];
            brokerImportState.possibleDuplicates = [];
            brokerImportState.duplicateDecisions = {};

            // Scope comparison to the selected target broker account only.
            // Trades in other broker accounts (including demo) are not relevant
            // when importing into a specific account.
            var _importAccountId = (document.getElementById('broker-import-account-select') || {}).value || '';
            var _scopedTrades = _importAccountId
                ? journalData.trades.filter(function(t) { return t.brokerAccountId === _importAccountId; })
                : journalData.trades;

            for (const incoming of brokerImportState.matchedTrades) {
                let exactMatch = null;
                let possibleMatch = null;
                let possibleScore = 0;

                for (const existing of _scopedTrades) {
                    const similarity = tradeSimilarity(existing, incoming);
                    if (similarity.exact) {
                        exactMatch = existing;
                        break;
                    }
                    if (similarity.possible && similarity.score > possibleScore) {
                        possibleMatch = existing;
                        possibleScore = similarity.score;
                    }
                }

                if (exactMatch) {
                    brokerImportState.exactDuplicates.push({ existing: exactMatch, incoming });
                } else if (possibleMatch) {
                    brokerImportState.possibleDuplicates.push({ existing: possibleMatch, incoming, score: possibleScore });
                    brokerImportState.duplicateDecisions[incoming._tempId] = 'keep-existing';
                } else {
                    brokerImportState.newTrades.push(incoming);
                }
            }
        }

        function renderBrokerImportReview() {
            // Step 2: Mode - show import mode options
            document.getElementById('broker-import-upload-step').classList.add('hidden');
            document.getElementById('broker-import-mode-step').classList.remove('hidden');
            document.getElementById('broker-import-review-step').classList.add('hidden');
            document.getElementById('broker-import-success-step').classList.add('hidden');
            document.getElementById('broker-import-continue-btn').style.display = 'inline-flex';
            document.getElementById('broker-import-next-btn').style.display = 'none';
            document.getElementById('broker-import-back-btn').style.display = 'inline-flex';
            updateBrokerImportStepPills(1);

            renderPossibleDuplicates();
            document.getElementById('broker-import-footer-left').textContent = `${brokerImportState.files.length} file(s) parsed. Choose an import mode.`;
        }

        function goToImportReview() {
            // Step 3: Review - show stats + trade preview + confirm button
            document.getElementById('broker-import-mode-step').classList.add('hidden');
            document.getElementById('broker-import-review-step').classList.remove('hidden');
            document.getElementById('broker-import-continue-btn').style.display = 'none';
            document.getElementById('broker-import-next-btn').style.display = 'inline-flex';
            updateBrokerImportStepPills(2);

            const assetText = Array.from(brokerImportState.assetTypes).join(', ') || 'Unknown';
            // Seed the four decision-sensitive counters with their
            // split-aware values. _recalcBrokerImportCounts() keeps them in
            // sync whenever the user changes an "Import as One Trade" /
            // "Split Into Separate Trades" decision in the preview below.
            document.getElementById('broker-import-summary-grid').innerHTML = `
                <div class="import-stat">
                    <div class="import-stat-label">Rows parsed</div>
                    <div class="import-stat-value">${brokerImportState.parsedRows}</div>
                </div>
                <div class="import-stat">
                    <div class="import-stat-label">Matched trades</div>
                    <div class="import-stat-value" id="broker-import-stat-matched">${_biExpandedCount(brokerImportState.matchedTrades)}</div>
                </div>
                <div class="import-stat">
                    <div class="import-stat-label">New trades</div>
                    <div class="import-stat-value" id="broker-import-stat-new">${_biExpandedCount(brokerImportState.newTrades)}</div>
                </div>
                <div class="import-stat">
                    <div class="import-stat-label">Exact duplicates</div>
                    <div class="import-stat-value" id="broker-import-stat-exact">${_biExpandedCount(brokerImportState.exactDuplicates)}</div>
                </div>
                <div class="import-stat">
                    <div class="import-stat-label">Possible duplicates</div>
                    <div class="import-stat-value" id="broker-import-stat-possible">${_biExpandedCount(brokerImportState.possibleDuplicates)}</div>
                </div>
                <div class="import-stat">
                    <div class="import-stat-label">Asset types</div>
                    <div class="import-stat-value" style="font-size:16px;">${assetText}</div>
                </div>
                ${brokerImportState.batchDuplicatesDropped ? `<div class="import-stat">
                    <div class="import-stat-label">Batch duplicates removed</div>
                    <div class="import-stat-value" style="color:var(--text-secondary);">${brokerImportState.batchDuplicatesDropped}</div>
                </div>` : ''}
                ${brokerImportState.unmatchedRows ? `<div class="import-stat">
                    <div class="import-stat-label">Unmatched rows</div>
                    <div class="import-stat-value" style="color:var(--text-secondary);">${brokerImportState.unmatchedRows}</div>
                </div>` : ''}
            `;

            document.getElementById('broker-import-files').textContent = brokerImportState.files.map(f => f.name).join(', ');

            // Render import diagnostics panel (broker-agnostic)
            _renderImportDiagnostics();

            // Render unmatched activity section
            _renderUnmatchedActivitySection();

            const previewRows = brokerImportState.matchedTrades.slice(0, 25).map(trade => {
                const status = brokerImportState.newTrades.some(t => t._tempId === trade._tempId)
                    ? 'New'
                    : brokerImportState.exactDuplicates.some(d => d.incoming._tempId === trade._tempId)
                        ? 'Duplicate'
                        : 'Possible duplicate';
                const badgeClass = status === 'New' ? 'badge-edge'
                                 : status === 'Duplicate' ? 'badge-leak'
                                 : 'badge-marginal';

                const isGrouped = Array.isArray(trade.fills) && trade.fills.length > 1;
                // Single-fill (or no fills) trades render exactly as before.
                if (!isGrouped) {
                    return `
                        <tr>
                            <td>${_displaySymbol(trade.symbol)}</td>
                            <td>${trade.optionType ? 'Option' : 'Equity'}</td>
                            <td>${trade.quantity}</td>
                            <td>$${Number(trade.entryPrice).toFixed(2)}</td>
                            <td>$${Number(trade.exitPrice).toFixed(2)}</td>
                            <td>${formatImportDate(trade.entryTime)}</td>
                            <td>${formatImportDate(trade.exitTime)}</td>
                            <td><span class="badge ${badgeClass}">${status}</span></td>
                        </tr>
                    `;
                }

                // Grouped trade review treatment — summary row + collapsed
                // detail row (per-fill breakdown) + per-trade "Import as One
                // Trade" / "Split Into Separate Trades" choice. Default is
                // Import as One Trade. Split expands back into individual
                // scalar trades at confirmBrokerImport time.
                const tempId = trade._tempId;
                const decision = brokerImportState.splitDecisions[tempId] || 'keep';
                const pnlColor = Number(trade.pnl) >= 0 ? 'var(--success)' : 'var(--danger)';
                const pnlStr = '$' + Number(trade.pnl || 0).toFixed(2);
                const anyComm = trade.fills.some(f => Number(f.commissionFees) !== 0);

                const fillRowsHtml = trade.fills.map((f, idx) => {
                    const fPnl = Number(f.pnl) || 0;
                    const fColor = fPnl >= 0 ? 'var(--success)' : 'var(--danger)';
                    return `
                        <tr>
                            <td>${idx + 1}</td>
                            <td>${Number(f.quantity) || 0}</td>
                            <td>$${Number(f.entryPrice).toFixed(2)}</td>
                            <td>$${Number(f.exitPrice).toFixed(2)}</td>
                            <td>${formatImportDate(f.entryTime)}</td>
                            <td>${formatImportDate(f.exitTime)}</td>
                            <td style="color:${fColor};">${fPnl >= 0 ? '+' : ''}$${fPnl.toFixed(2)}</td>
                            ${anyComm ? `<td>$${Number(f.commissionFees || 0).toFixed(2)}</td>` : ''}
                        </tr>
                    `;
                }).join('');

                // Active button uses btn-primary (brighter) and .selected;
                // inactive uses btn-secondary (darker). Keeping the class
                // pair in sync with the stored decision is what
                // setSplitDecision() toggles below.
                const keepActive  = decision === 'keep';
                const splitActive = decision === 'split';
                const keepCls  = 'btn btn-small ' + (keepActive  ? 'btn-primary selected' : 'btn-secondary');
                const splitCls = 'btn btn-small ' + (splitActive ? 'btn-primary selected' : 'btn-secondary');

                return `
                    <tr class="bi-group-summary" data-bi-group-id="${tempId}">
                        <td>
                            <div>${_displaySymbol(trade.symbol)}</div>
                            <button type="button" class="btn btn-small btn-secondary" style="margin-top:4px; padding:2px 8px; font-size:11px;"
                                onclick="toggleGroupedFillDetails(${tempId}, this)">
                                <span data-role="caret">▸</span> ${trade.fills.length} fills
                            </button>
                        </td>
                        <td>${trade.optionType ? 'Option' : 'Equity'}</td>
                        <td><strong>${trade.quantity}</strong><div style="font-size:10px; color:var(--text-secondary);">grouped</div></td>
                        <td>$${Number(trade.entryPrice).toFixed(2)}<div style="font-size:10px; color:var(--text-secondary);">wt avg</div></td>
                        <td>$${Number(trade.exitPrice).toFixed(2)}<div style="font-size:10px; color:var(--text-secondary);">wt avg</div></td>
                        <td>${formatImportDate(trade.entryTime)}<div style="font-size:10px; color:var(--text-secondary);">earliest</div></td>
                        <td>${formatImportDate(trade.exitTime)}<div style="font-size:10px; color:var(--text-secondary);">latest</div></td>
                        <td>
                            <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-start;">
                                <span class="badge ${badgeClass}">${status}</span>
                                <div style="font-size:11px; color:${pnlColor}; font-weight:600;">${pnlStr}</div>
                                <div style="display:flex; gap:4px; flex-wrap:wrap;">
                                    <button type="button" data-decision="keep" class="${keepCls}" style="padding:2px 8px; font-size:11px;"
                                        onclick="setSplitDecision(${tempId}, 'keep', this)">Consolidated</button>
                                    <button type="button" data-decision="split" class="${splitCls}" style="padding:2px 8px; font-size:11px;"
                                        onclick="setSplitDecision(${tempId}, 'split', this)">Separate</button>
                                </div>
                            </div>
                        </td>
                    </tr>
                    <tr class="bi-group-detail hidden" data-bi-group-detail-id="${tempId}">
                        <td colspan="8" style="background:var(--bg-secondary, rgba(0,0,0,0.03)); padding:8px 12px;">
                            <table class="import-fill-table" style="width:100%; font-size:12px; border-collapse:collapse;">
                                <thead>
                                    <tr style="text-align:left; color:var(--text-secondary);">
                                        <th style="padding:4px 6px;">#</th>
                                        <th style="padding:4px 6px;">Qty</th>
                                        <th style="padding:4px 6px;">Entry</th>
                                        <th style="padding:4px 6px;">Exit</th>
                                        <th style="padding:4px 6px;">Entry time</th>
                                        <th style="padding:4px 6px;">Exit time</th>
                                        <th style="padding:4px 6px;">P&amp;L</th>
                                        ${anyComm ? '<th style="padding:4px 6px;">Fees</th>' : ''}
                                    </tr>
                                </thead>
                                <tbody>${fillRowsHtml}</tbody>
                            </table>
                        </td>
                    </tr>
                `;
            }).join('');
            document.getElementById('broker-import-preview-body').innerHTML = previewRows || '<tr><td colspan="8">No matched trades found.</td></tr>';

            document.getElementById('broker-import-footer-left').textContent = `${brokerImportState.files.length} file(s) ready for import.`;
        }

        function formatImportDate(value) {
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return value;
            return date.toLocaleString();
        }

        function renderPossibleDuplicates() {
            const container = document.getElementById('broker-import-possible-duplicates');
            const list = document.getElementById('broker-import-duplicate-list');

            if (!brokerImportState.possibleDuplicates.length) {
                container.classList.add('hidden');
                list.innerHTML = '';
                return;
            }

            container.classList.remove('hidden');
            list.innerHTML = brokerImportState.possibleDuplicates.map(item => {
                const decision = brokerImportState.duplicateDecisions[item.incoming._tempId] || 'keep-existing';
                return `
                    <div class="duplicate-card">
                        <div style="display:flex; justify-content:space-between; gap:12px; align-items:center; flex-wrap:wrap;">
                            <strong>${_displaySymbol(item.incoming.symbol)} • Similarity score ${item.score}</strong>
                            <span style="font-size:12px; color:var(--text-secondary);">${formatImportDate(item.incoming.entryTime)}</span>
                        </div>
                        <div class="duplicate-compare">
                            <div class="duplicate-panel">
                                <div style="font-weight:600; margin-bottom:8px;">Existing trade</div>
                                <div>Qty: ${item.existing.quantity}</div>
                                <div>Entry: $${Number(item.existing.entryPrice).toFixed(2)} @ ${formatImportDate(item.existing.entryTime)}</div>
                                <div>Exit: $${Number(item.existing.exitPrice).toFixed(2)} @ ${formatImportDate(item.existing.exitTime)}</div>
                            </div>
                            <div class="duplicate-panel">
                                <div style="font-weight:600; margin-bottom:8px;">Incoming trade</div>
                                <div>Qty: ${item.incoming.quantity}</div>
                                <div>Entry: $${Number(item.incoming.entryPrice).toFixed(2)} @ ${formatImportDate(item.incoming.entryTime)}</div>
                                <div>Exit: $${Number(item.incoming.exitPrice).toFixed(2)} @ ${formatImportDate(item.incoming.exitTime)}</div>
                            </div>
                        </div>
                        <div class="duplicate-actions">
                            <button type="button" class="btn btn-small btn-secondary ${decision === 'keep-existing' ? 'selected' : ''}" onclick="setDuplicateDecision(${item.incoming._tempId}, 'keep-existing', this)">Keep Existing</button>
                            <button type="button" class="btn btn-small btn-warning ${decision === 'replace-existing' ? 'selected' : ''}" onclick="setDuplicateDecision(${item.incoming._tempId}, 'replace-existing', this)">Replace Existing</button>
                            <button type="button" class="btn btn-small btn-primary ${decision === 'import-both' ? 'selected' : ''}" onclick="setDuplicateDecision(${item.incoming._tempId}, 'import-both', this)">Import Both</button>
                        </div>
                    </div>
                `;
            }).join('');
        }

        function setDuplicateDecision(tempId, decision, btn) {
            brokerImportState.duplicateDecisions[tempId] = decision;
            const wrap = btn.parentElement;
            wrap.querySelectorAll('.btn').forEach(el => el.classList.remove('selected'));
            btn.classList.add('selected');
        }

        // Returns the number of saved trades a list of matched-like entries
        // will produce under the current split decisions. A single-fill or
        // "Import as One Trade" entry counts as 1; a grouped entry with
        // "Split Into Separate Trades" counts as its fills.length. Works
        // on both newTrades (bare trade objects) and the duplicate lists
        // ({ existing, incoming } pairs), unwrapping incoming when present.
        function _biExpandedCount(list) {
            if (!Array.isArray(list)) return 0;
            var decisions = (brokerImportState && brokerImportState.splitDecisions) || {};
            var total = 0;
            for (var i = 0; i < list.length; i++) {
                var entry = list[i];
                if (!entry) continue;
                var trade = entry.incoming ? entry.incoming : entry;
                if (!trade) continue;
                var isGrouped = Array.isArray(trade.fills) && trade.fills.length > 1;
                var decision = decisions[trade._tempId] || 'keep';
                if (isGrouped && decision === 'split') {
                    total += trade.fills.length;
                } else {
                    total += 1;
                }
            }
            return total;
        }

        // Recalculate the decision-sensitive review counters in the stat
        // grid so the numbers reflect what will actually be saved under the
        // current in-memory user decisions, before Confirm Import runs.
        function _recalcBrokerImportCounts() {
            if (!brokerImportState) return;
            var set = function(id, val) {
                var el = document.getElementById(id);
                if (el) el.textContent = val;
            };
            set('broker-import-stat-matched',  _biExpandedCount(brokerImportState.matchedTrades));
            set('broker-import-stat-new',      _biExpandedCount(brokerImportState.newTrades));
            set('broker-import-stat-exact',    _biExpandedCount(brokerImportState.exactDuplicates));
            set('broker-import-stat-possible', _biExpandedCount(brokerImportState.possibleDuplicates));
        }

        // Phase 3: per-grouped-trade Import-as-One / Split choice. Updates
        // local state for the current import batch only; no data is written
        // to disk and no existing trades are touched until
        // confirmBrokerImport runs. Also keeps the button pair's visual
        // state (btn-primary / btn-secondary + .selected) perfectly in
        // sync with the stored decision and recalculates the review
        // counters so the user sees the true save-time totals live.
        function setSplitDecision(tempId, decision, btn) {
            if (!brokerImportState) return;
            if (!brokerImportState.splitDecisions) brokerImportState.splitDecisions = {};
            brokerImportState.splitDecisions[tempId] = decision;
            // Swap the primary/secondary styling across the button group
            // so the active one is always bright and the other is always
            // dim, regardless of which button was clicked.
            const wrap = btn && btn.parentElement;
            if (wrap) {
                wrap.querySelectorAll('.btn').forEach(function(el) {
                    var target = el.dataset ? el.dataset.decision : null;
                    var isActive = target === decision;
                    el.classList.toggle('btn-primary',   isActive);
                    el.classList.toggle('btn-secondary', !isActive);
                    el.classList.toggle('selected',      isActive);
                });
            }
            _recalcBrokerImportCounts();
        }

        // Phase 3: expand/collapse the per-fill breakdown for a grouped
        // trade in the import review table.
        function toggleGroupedFillDetails(tempId, btn) {
            const detail = document.querySelector('tr[data-bi-group-detail-id="' + tempId + '"]');
            if (!detail) return;
            const hidden = detail.classList.toggle('hidden');
            if (btn) {
                const caret = btn.querySelector('[data-role="caret"]');
                if (caret) caret.textContent = hidden ? '▸' : '▾';
            }
        }

        function getBrokerImportMode() {
            return document.querySelector('input[name="broker-import-mode"]:checked')?.value || 'add-new';
        }

        async function confirmBrokerImport() {
            const mode = getBrokerImportMode();
            const importAccountId = document.getElementById('broker-import-account-select')?.value || '';

            if (!importAccountId || importAccountId === '__add_new__') {
                alert('Please select an account before importing.');
                return;
            }

            // Replace All clears trades locally only; the cloud rows would come back on the next load.
            if (mode === 'replace-all' && _isCloudPrimarySave()) {
                alert('Replace All Trades is not available for cloud accounts. Choose another import mode.');
                return;
            }

            // Restored if the cloud save fails. Shallow copy: existing trade
            // objects are only removed or added below, never changed.
            const _importTradesBefore = journalData.trades.slice();

            let finalTrades = [];
            let replacedCount = 0;
            // Ids of existing trades replaced in smart-merge; deleted in the cloud below.
            const _replacedIds = [];

            // Monotonic id generator shared across all append paths below so
            // split expansions never collide with sibling insertions.
            const _baseTime = Date.now();
            let _idCounter = 0;
            const _nextId = () => _baseTime + (_idCounter++);

            // Phase 3: honor the per-grouped-trade Keep/Split choice captured
            // in review. For single-fill or keep-grouped trades this returns
            // one finalized trade object (the legacy shape). For split
            // decisions it returns an array of flat scalar trades, one per
            // fill, preserving the row-level quantity / prices / times /
            // pnl / commissionFees and omitting any fills array so split
            // results remain plain backward-compatible scalar trades.
            const _expandForSave = (trade) => {
                const decision = (brokerImportState.splitDecisions || {})[trade._tempId] || 'keep';
                const isGrouped = Array.isArray(trade.fills) && trade.fills.length > 1;
                if (!isGrouped || decision !== 'split') {
                    var _saved = finalizeTradeSummary({
                        ...trade,
                        id: _nextId(),
                        source: 'csv',
                        brokerAccountId: importAccountId
                    });
                    // Ensure grossPnl is stored (derive if missing).
                    if (_saved.grossPnl == null) {
                        _saved.grossPnl = (_saved.pnl || 0) + (_saved.commissionFees || 0);
                    }
                    // Strip import-internal transient fields so they
                    // don't leak into the local database / cloud sync.
                    delete _saved._tempId;
                    delete _saved._positionId;
                    return [_saved];
                }
                return trade.fills.map((f) => {
                    const entryMs = new Date(f.entryTime).getTime();
                    const exitMs  = new Date(f.exitTime).getTime();
                    const holdSec = (isFinite(entryMs) && isFinite(exitMs))
                        ? Math.max(0, (exitMs - entryMs) / 1000)
                        : 0;
                    // Split scalar: preserves option contract identity from
                    // the parent grouped trade verbatim; row values come
                    // directly from the fill. No fills[] attached so the
                    // rest of the app treats this as a normal scalar trade.
                    var _splitPnl  = Number(f.pnl) || 0;
                    var _splitComm = Number(f.commissionFees) || 0;
                    return {
                        symbol:          trade.symbol,
                        type:            trade.type || 'long',
                        assetType:       trade.assetType || 'stock',
                        optionType:      trade.optionType || null,
                        strike:          trade.strike || 0,
                        expiry:          trade.expiry || null,
                        contractName:    trade.contractName || '',
                        source:          'csv',
                        sourceFile:      trade.sourceFile || '',
                        brokerAccountId: importAccountId,
                        id:              _nextId(),
                        quantity:        Number(f.quantity) || 0,
                        entryPrice:      Number(f.entryPrice) || 0,
                        exitPrice:       Number(f.exitPrice) || 0,
                        entryTime:       f.entryTime,
                        exitTime:        f.exitTime,
                        holdSeconds:     holdSec,
                        grossPnl:        f.grossPnl != null ? Number(f.grossPnl) : (_splitPnl + _splitComm),
                        pnl:             _splitPnl,
                        commissionFees:  _splitComm,
                        feeSource:       f.feeSource || trade.feeSource
                    };
                });
            };

            if (mode === 'replace-all') {
                finalTrades = [];
                brokerImportState.matchedTrades.forEach((trade) => {
                    finalTrades.push(..._expandForSave(trade));
                });
                journalData.trades = finalTrades;
            } else {
                const additions = [];

                brokerImportState.newTrades.forEach((trade) => {
                    additions.push(..._expandForSave(trade));
                });

                if (mode === 'import-all') {
                    brokerImportState.exactDuplicates.forEach((item) => {
                        additions.push(..._expandForSave(item.incoming));
                    });
                    brokerImportState.possibleDuplicates.forEach((item) => {
                        additions.push(..._expandForSave(item.incoming));
                    });
                } else if (mode === 'smart-merge') {
                    brokerImportState.possibleDuplicates.forEach((item) => {
                        const decision = brokerImportState.duplicateDecisions[item.incoming._tempId] || 'keep-existing';
                        if (decision === 'replace-existing') {
                            const existingIndex = journalData.trades.findIndex(t => t.id === item.existing.id);
                            if (existingIndex >= 0) {
                                journalData.trades.splice(existingIndex, 1);
                                _replacedIds.push(item.existing.id);
                                replacedCount += 1;
                            }
                            additions.push(..._expandForSave(item.incoming));
                        } else if (decision === 'import-both') {
                            additions.push(..._expandForSave(item.incoming));
                        }
                    });
                }

                journalData.trades.push(...additions);
                finalTrades = additions;
            }

            // ── Import unmatched_open rows marked 'import_open_trade' ─────
            // These become real open trades with null exit data / P&L.
            // unmatched_close rows are never imported here regardless of
            // their decision — only 'skip' and 'manual' are valid for
            // closes, and neither creates a trade.
            //
            // Duplicate guard: for add-new and smart-merge modes, check
            // if an identical open trade already exists in journalData
            // before inserting. For replace-all, dedupe within the batch
            // only (existing trades were already wiped). import-all skips
            // the check by design.
            var _openTradesImported = 0;
            var _openTradesSkippedDupe = 0;
            var _umaDecs = (brokerImportState && brokerImportState.unmatchedDecisions) || {};
            var _umaItems = (brokerImportState && brokerImportState.unmatchedActivity) || [];

            // Reuse _tradeFingerprint for open-trade identity. Build a
            // lightweight pseudo-trade object with the same field names so
            // the fingerprint is byte-identical to what _tradeFingerprint
            // produces for an already-saved open trade (exitPrice: null,
            // exitTime: null).
            function _openTradeFp(sym, qty, price, entryIso, optType, strike, expiry, side) {
                return _tradeFingerprint({
                    symbol:    (sym || '').toUpperCase(),
                    type:      side || 'long',
                    assetType: optType ? 'option' : 'stock',
                    optionType: optType || '',
                    strike:    strike || 0,
                    expiry:    expiry || '',
                    quantity:  qty,
                    entryPrice: price,
                    exitPrice: null,
                    entryTime: entryIso || '',
                    exitTime:  null
                });
            }

            // Collect fingerprints of existing open trades in the target
            // account for duplicate detection (add-new / smart-merge).
            var _existingOpenFps = {};
            if (mode === 'add-new' || mode === 'smart-merge') {
                for (var _ei = 0; _ei < journalData.trades.length; _ei++) {
                    var _et = journalData.trades[_ei];
                    if (_et.brokerAccountId !== importAccountId) continue;
                    if (_et.exitTime || _et.exitPrice != null) continue; // closed trade
                    _existingOpenFps[_tradeFingerprint(_et)] = true;
                }
            }
            // For replace-all: track fingerprints within the batch to
            // prevent intra-batch duplicates (journalData was already
            // replaced, so existing-trade check is not needed).
            var _batchOpenFps = {};

            for (var _ui = 0; _ui < _umaItems.length; _ui++) {
                var _uRow = _umaItems[_ui];
                if (_uRow.type !== 'unmatched_open') continue;
                if (_umaDecs[_uRow._umaId] !== 'import_open_trade') continue;

                var _isOpt = !!_uRow.optionType;
                var _entryTs = normalizeTimestamp(_uRow.timestamp);
                var _entryIso = _entryTs ? _entryTs.toISOString() : (_uRow.timestamp || null);
                // Derive side: explicit short action → 'short', else 'long'
                var _side = String(_uRow.action || '').toUpperCase().includes('SHORT') ? 'short' : 'long';

                var _fp = _openTradeFp(
                    _uRow.symbol, _uRow.quantity, _uRow.price,
                    _entryIso, _uRow.optionType, _uRow.strike, _uRow.expiry, _side
                );

                // Duplicate check: skip if identical open trade exists
                if (mode === 'add-new' || mode === 'smart-merge') {
                    if (_existingOpenFps[_fp]) {
                        _openTradesSkippedDupe++;
                        continue;
                    }
                }
                // Intra-batch dedupe for all modes (prevents double QQQ etc.)
                if (_batchOpenFps[_fp]) {
                    _openTradesSkippedDupe++;
                    continue;
                }
                _batchOpenFps[_fp] = true;

                var _openTrade = {
                    id:              _nextId(),
                    symbol:          (_uRow.symbol || '').toUpperCase(),
                    type:            _side,
                    assetType:       _isOpt ? 'option' : 'stock',
                    quantity:        Number(_uRow.quantity) || 0,
                    entryPrice:      Number(_uRow.price) || 0,
                    entryTime:       _entryIso,
                    exitPrice:       null,
                    exitTime:        null,
                    holdSeconds:     null,
                    grossPnl:        null,
                    pnl:             null,
                    commissionFees:  0,
                    optionType:      _uRow.optionType || null,
                    strike:          _uRow.strike || 0,
                    expiry:          _uRow.expiry || null,
                    contractName:    _uRow.contractName || '',
                    source:          'csv',
                    sourceFile:      _uRow.sourceFile || '',
                    brokerAccountId: importAccountId
                };
                // Push to journalData.trades only. In replace-all mode,
                // journalData.trades IS finalTrades (same reference), so
                // one push is sufficient. In other modes they are separate
                // arrays, so push to both.
                journalData.trades.push(_openTrade);
                if (journalData.trades !== finalTrades) {
                    finalTrades.push(_openTrade);
                }
                _openTradesImported++;
            }

            // In replace-all mode finalTrades is journalData.trades; otherwise
            // it holds exactly the trades added above (same objects).
            finalTrades.forEach(_roundTradeForSave);

            // Cloud-primary: upsert imported trades to Supabase
            if (_isCloudPrimarySave() && journalData.trades.length > 0) {
                // For replace-all mode, upsert the full set. For other modes,
                // upsert only the newly added/replaced trades (finalTrades).
                var _importSaveTrades = (mode === 'replace-all') ? journalData.trades : finalTrades;
                if (_importSaveTrades && _importSaveTrades.length > 0) {
                    var _isRes = await _saveTradesToSupabase(_importSaveTrades);
                    if (!_isRes.success) {
                        journalData.trades = _importTradesBefore;
                        // Saves of more than 500 rows commit in chunks, so earlier chunks may be in the cloud.
                        alert('Failed to save import: ' + (_isRes.error || 'unknown error')
                            + (_importSaveTrades.length > 500
                                ? '\nSome trades may already be saved in the cloud. Reload the page before trying again.'
                                : '\nYour data was not changed. Please try again.'));
                        return;
                    }
                }
                // Smart-merge "replace existing": delete the replaced trades so
                // they don't come back on reload. On failure, remove the new
                // rows again and change nothing.
                if (_replacedIds.length > 0) {
                    var _rdRes = await _deleteTradesFromSupabase(_replacedIds);
                    if (!(_rdRes && _rdRes.success)) {
                        if (_importSaveTrades && _importSaveTrades.length > 0) {
                            try { await _deleteTradesFromSupabase(_importSaveTrades.map(function(t) { return t.id; })); } catch (_) { /* reload re-syncs */ }
                        }
                        journalData.trades = _importTradesBefore;
                        alert('Failed to delete: ' + ((_rdRes && _rdRes.error) || 'unknown error') + '\nYour data was not changed. Please try again.');
                        return;
                    }
                }
                _triggerCloudDashRefresh();
            }
            await saveToIndexedDB();
            updateDashboard();


            document.getElementById('broker-import-review-step').classList.add('hidden');
            document.getElementById('broker-import-success-step').classList.remove('hidden');
            document.getElementById('broker-import-next-btn').style.display = 'none';
            updateBrokerImportStepPills(3);

            // Build compact diagnostics summary for success message
            var diagLines = '';
            var _diag = brokerImportState.importSummaries || [];
            if (_diag.length > 0) {
                var _mc = {};
                for (var _di = 0; _di < _diag.length; _di++) {
                    for (var _dt in _diag[_di].issueCounts) {
                        _mc[_dt] = (_mc[_dt] || 0) + _diag[_di].issueCounts[_dt];
                    }
                }
                var _parts = [];
                for (var _mt in _mc) {
                    if (_mc[_mt] > 0) _parts.push((IMPORT_ISSUE_TYPES[_mt] || _mt) + ': ' + _mc[_mt]);
                }
                if (_parts.length > 0) {
                    diagLines = '<br><br><strong>Diagnostics:</strong> ' + _parts.join(' · ');
                }
            }

            document.getElementById('broker-import-success-message').innerHTML = `
                Import complete.<br><br>
                Added <strong>${mode === 'replace-all' ? journalData.trades.length : finalTrades.length}</strong> trade(s).
                ${brokerImportState.exactDuplicates.length ? `<br>Skipped exact duplicates: <strong>${mode === 'import-all' ? 0 : brokerImportState.exactDuplicates.length}</strong>.` : ''}
                ${replacedCount ? `<br>Replaced existing possible duplicates: <strong>${replacedCount}</strong>.` : ''}
                ${brokerImportState.unmatchedRows ? (function() {
                    var _oc = 0, _cc = 0;
                    var _ua = brokerImportState.unmatchedActivity || [];
                    for (var _i = 0; _i < _ua.length; _i++) {
                        if (_ua[_i].type === 'unmatched_open') _oc++;
                        else if (_ua[_i].type === 'unmatched_close') _cc++;
                    }
                    var _skippedOpens = _oc - _openTradesImported;
                    var lines = '';
                    if (_openTradesImported > 0) {
                        lines += '<br>Imported as open trades: <strong>' + _openTradesImported + '</strong>';
                    }
                    if (_skippedOpens > 0) {
                        lines += '<br>Skipped unmatched opens: <strong>' + _skippedOpens + '</strong>';
                    }
                    if (_cc > 0) {
                        lines += '<br>Skipped closing trades: <strong>' + _cc + '</strong> (matching open not in this file)';
                    }
                    return lines;
                })() : ''}
                ${diagLines}
                <br><br>Denarii has auto-saved your data.
            `;
            document.getElementById('broker-import-footer-left').textContent = 'Import finished successfully.';
            document.querySelector('[data-tab="dashboard"]').click();
        }

        // ========== BROKER ACCOUNT MANAGEMENT — moved to js/pages/broker-accounts.js ==========

        function escapeHtml(str) {
            if (!str) return '';
            return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
        }

        // ── CUSIP display resolution ─────────────────────────────────────────
        // Display-only: resolves CUSIP-like raw symbols to friendlier names.
        // Stored trade.symbol is never mutated. Broker-agnostic.

        // Known CUSIP → display name mappings (add as encountered).
        var CUSIP_DISPLAY_MAP = {
            '307359703': 'FFIE',        // Faraday Future Intelligent Electric
            '74319F305': 'BIOR'         // Biora Therapeutics
        };

        // CUSIP pattern: 6 alphanumeric + 2 digits + 1 alphanumeric check.
        // Matches 9-char strings like 307359703 or 74319F305.
        var _CUSIP_RE = /^[A-Z0-9]{6}\d{2}[A-Z0-9]$/;

        /**
         * Return a display-friendly symbol string. If the raw symbol
         * looks like a CUSIP and has a known mapping, returns the mapped
         * ticker. Otherwise returns the raw symbol unchanged.
         *
         * Usage: _displaySymbol(trade.symbol) in UI rendering only.
         * Never write the result back to trade.symbol.
         */
        function _displaySymbol(raw) {
            if (!raw) return raw;
            var upper = raw.toUpperCase();
            var mapped = CUSIP_DISPLAY_MAP[upper];
            if (mapped) return mapped;
            // If it matches CUSIP pattern but has no mapping, show raw
            // with a visual hint so the user knows it's a CUSIP.
            if (_CUSIP_RE.test(upper) && upper.length === 9) {
                return raw + '*';
            }
            return raw;
        }

        // ========== ASSET TYPE & CONTRACT INFO ==========

        function getAssetType(trade) {
            if (trade.assetType) return trade.assetType;
            if (trade.optionType) return 'option';
            return 'stock';
        }

        function getAssetTypeLabel(trade) {
            const type = getAssetType(trade);
            const labels = { stock: 'Stock', option: 'Option', future: 'Future', crypto: 'Crypto', bond: 'Bond', forex: 'Forex', other: 'Other' };
            return labels[type] || 'Stock';
        }

        function getContractInfoHtml(trade) {
            const type = getAssetType(trade);
            if (type === 'option') {
                const parts = [];
                const cn = trade.contractName || formatContractName(trade);
                if (cn) parts.push(`<span style="font-family:monospace;">${escapeHtml(cn)}</span>`);
                if (trade.optionType) parts.push(trade.optionType);
                if (trade.strike) parts.push(`$${Number(trade.strike).toFixed(2)} strike`);
                if (trade.expiry) parts.push(`exp ${new Date(trade.expiry + 'T00:00:00').toLocaleDateString()}`);
                if (parts.length > 0) {
                    return `<div class="contract-info" style="margin: 2px 0 4px;">${parts.join(' · ')}</div>`;
                }
            }
            return '';
        }

        // Reconstruct contract name from parsed fields (for older imports that didn't save contractName)
        function formatContractName(trade) {
            if (!trade.optionType || !trade.symbol) return '';
            if (trade.contractName) return trade.contractName;
            // Try to reconstruct: SYMBOL + YYMMDD + C/P + strike*1000 padded to 8 digits
            let name = trade.symbol;
            if (trade.expiry) {
                const d = new Date(trade.expiry + 'T00:00:00');
                const yy = String(d.getFullYear()).slice(2);
                const mm = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                name += yy + mm + dd;
            }
            name += trade.optionType === 'CALL' ? 'C' : 'P';
            if (trade.strike) {
                name += String(Math.round(trade.strike * 1000)).padStart(8, '0');
            }
            return name;
        }

        function toggleOptionFields() {
            const assetType = document.getElementById('asset-type').value;
            const row = document.getElementById('option-fields-row');
            if (row) row.style.display = assetType === 'option' ? '' : 'none';
        }

        // ========== JOURNAL PAGE ==========

        // ── Notes migration ───────────────────────────────────────────────────────
        function migrateNotesFields() {
            let changed = false;
            if (!journalData.noteTemplates) { journalData.noteTemplates = []; changed = true; }
            // Backfill sourceType / isFavorite on legacy user templates
            (journalData.noteTemplates || []).forEach(t => {
                if (!t.sourceType) { t.sourceType = 'user'; changed = true; }
                if (t.isFavorite === undefined) { t.isFavorite = false; changed = true; }
                if (!Array.isArray(t.timeframes)) { t.timeframes = []; changed = true; }
            });
            (journalData.trades || []).forEach(trade => {
                if (trade.notes === undefined) {
                    const parts = [];
                    if (trade.entryReason) parts.push('Entry Reason:\n' + trade.entryReason);
                    if (trade.exitReason)  parts.push('Exit Reason:\n'  + trade.exitReason);
                    if (trade.lessons)     parts.push('Lessons Learned:\n' + trade.lessons);
                    trade.notes = parts.join('\n\n');
                    changed = true;
                }
            });
            return changed;
        }

        // ── System template seeding ────────────────────────────────────────────────
        var SYSTEM_TEMPLATES_VERSION = 1; // bump when adding new system templates
        var SYSTEM_TEMPLATE_DEFS = [
            { id: 1,  name: 'Pre-Trade Plan',
              content: 'Setup:\n\nEntry Criteria:\n\nTarget Price:\n\nStop Loss:\n\nRisk/Reward:\n\nPosition Size Rationale:\n\nWhat would invalidate this trade:\n' },
            { id: 2,  name: 'Post-Trade Review',
              content: 'What happened vs my plan:\n\nExecution quality (1-10):\n\nWhat I did well:\n\nWhat I could improve:\n\nKey lesson from this trade:\n' },
            { id: 3,  name: 'Winning Trade Analysis',
              content: 'Why this trade worked:\n\nDid I follow my plan? (Yes / No / Partially):\n\nWhat can I repeat next time:\n\nWas my sizing appropriate:\n\nAnything I got lucky with:\n' },
            { id: 4,  name: 'Losing Trade Analysis',
              content: 'Root cause of the loss:\n\nWas the loss due to (circle): Bad plan / Poor execution / Bad luck / Breaking rules\n\nSignals I ignored:\n\nHow to prevent this next time:\n\nImpact on my trading psychology:\n' },
            { id: 5,  name: 'Breakout Setup',
              content: 'Key level being broken:\n\nVolume at breakout (above/below average):\n\nPre-breakout consolidation length:\n\nFirst target (measured move):\n\nInvalidation level (failed breakout):\n\nTime of day:\n' },
            { id: 6,  name: 'Support / Resistance Bounce',
              content: 'Level (price):\n\nNumber of prior tests:\n\nConfluence factors (MA, trend line, VWAP, etc.):\n\nEntry trigger:\n\nTarget (next resistance/support):\n\nStop (below/above level by):\n' },
            { id: 7,  name: 'Trend Continuation',
              content: 'Trend direction and timeframe:\n\nPullback depth (% or to which level):\n\nReentry trigger:\n\nHigher-timeframe context:\n\nTarget (prior swing high/low or extension):\n\nStop placement:\n' },
            { id: 8,  name: 'Reversal Setup',
              content: 'Why I believe the trend is ending:\n\nKey reversal signals (divergence, exhaustion candle, volume, etc.):\n\nConfirmation I waited for:\n\nTarget (retracement level):\n\nRisk vs reward:\n\nThis is a counter-trend trade — extra justification:\n' },
            { id: 9,  name: 'News Catalyst Trade',
              content: 'News event / catalyst:\n\nExpected market reaction:\n\nActual reaction:\n\nEntry timing relative to news:\n\nIV / spread conditions:\n\nLessons on trading around news:\n' },
            { id: 10, name: 'Earnings Play',
              content: 'Expected move (options-implied):\n\nMy directional bias and reasoning:\n\nStrategy used (long stock, options spread, straddle, etc.):\n\nIV crush risk acknowledged? (Y/N):\n\nActual move post-earnings:\n\nP&L vs expected:\n' },
            { id: 11, name: 'Gap Play',
              content: 'Gap type (common / breakaway / runaway / exhaustion):\n\nGap fill probability assessment:\n\nPre-market volume and price action:\n\nPlan A (gap fills):\n\nPlan B (gap holds and continues):\n\nActual result:\n' },
            { id: 12, name: 'FOMO Trade Review',
              content: 'What made me chase this trade:\n\nHow far was price extended from a proper entry:\n\nWas there still a valid setup? (Y/N):\n\nWhat I should have done instead:\n\nRule I need to add or reinforce:\n' },
            { id: 13, name: 'Revenge Trade Check',
              content: 'Trade I was trying to recover from:\n\nEmotional state when I entered this trade:\n\nDid this trade have a valid setup independent of emotion? (Y/N):\n\nOutcome:\n\nHow to reset emotionally after a loss before trading again:\n' },
            { id: 14, name: 'Weekly Reflection',
              content: 'Total trades this week:\n\nWin rate:\n\nBest trade and why:\n\nWorst trade and why:\n\nBiggest recurring mistake:\n\nWhat I\'ll focus on improving next week:\n\nOverall mental/emotional state this week:\n' },
            { id: 15, name: 'Psychology Check-In',
              content: 'Current confidence level (1-10):\n\nAm I trading to make money or to be right:\n\nAny recent losses affecting my judgment:\n\nBiases I\'m susceptible to today (overconfidence, revenge, FOMO, etc.):\n\nOne rule I commit to following today:\n' },
            { id: 16, name: 'Options Trade',
              content: 'Underlying and expiration:\n\nStrike(s) chosen and reasoning:\n\nStrategy (long call/put, spread, iron condor, etc.):\n\nIV rank at entry:\n\nDelta / Theta / Vega exposure:\n\nMax profit / max loss:\n\nManagement plan (at what P&L do I close early):\n' }
        ];

        function seedSystemTemplates() {
            if (!journalData.noteTemplates) journalData.noteTemplates = [];

            // Treat legacy "has any system template" as version 1
            var storedVersion = typeof journalData._systemTemplatesVersion === 'number'
                ? journalData._systemTemplatesVersion
                : (journalData.noteTemplates.some(function(t) { return t.sourceType === 'system'; }) ? 1 : 0);

            if (storedVersion >= SYSTEM_TEMPLATES_VERSION) return false;

            // Build a set of existing system template names for dedup
            var existingNames = {};
            journalData.noteTemplates.forEach(function(t) {
                if (t.sourceType === 'system') {
                    existingNames[t.name.trim().toLowerCase()] = true;
                }
            });

            SYSTEM_TEMPLATE_DEFS.forEach(function(d) {
                if (!existingNames[d.name.trim().toLowerCase()]) {
                    journalData.noteTemplates.push({
                        id: d.id, name: d.name, content: d.content,
                        sourceType: 'system', isFavorite: false
                    });
                }
            });

            journalData._systemTemplatesVersion = SYSTEM_TEMPLATES_VERSION;
            return true;
        }

        // ── Note templates ─────────────────────────────────────────────────────────
        function renderNoteTemplateChips() { renderNoteTemplateDropdown(); }

        // Dropdown on journal entry page — shows favorites filtered by journal context.
        // context: 'trade' | 'daily' | 'weekly' | 'monthly' | 'yearly' (defaults to 'trade')
        // Legacy templates with no timeframes assigned appear in all contexts.
        function _favoriteTemplatesFor(ctx) {
            return [...(journalData.noteTemplates || [])]
                .filter(t => {
                    if (!t.isFavorite) return false;
                    const tfs = Array.isArray(t.timeframes) ? t.timeframes : [];
                    // No timeframes assigned → show in all contexts (legacy fallback)
                    if (tfs.length === 0) return true;
                    return tfs.includes(ctx);
                })
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        }

        function renderNoteTemplateDropdown(context) {
            // Keep the New Trade dropdown in sync with favorite/save/delete changes
            if (typeof _ntPopulateTemplates === 'function') _ntPopulateTemplates();
            const sel = document.getElementById('jnl-template-select');
            if (!sel) return;
            const templates = _favoriteTemplatesFor(context || 'trade');
            sel.innerHTML = '<option value="">Select template…</option>' +
                templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
        }

        function applyNoteTemplate(id) {
            const tmpl = _tmFind(id);
            if (!tmpl) return;
            const editor = document.getElementById('jnl-notes');
            if (!editor) return;

            // Convert template plain-text → HTML the same way _jnlSetNotes does
            // so appended content renders identically to a fresh insertion.
            const raw = tmpl.content || '';
            let tmplHtml;
            if (!/<[a-z][\s\S]*>/i.test(raw)) {
                tmplHtml = raw.split('\n\n').map(p =>
                    p.trim() ? '<p>' + p.replace(/\n/g, '<br>') + '</p>' : '<p><br></p>'
                ).join('');
            } else {
                tmplHtml = raw;
            }

            const current = _jnlGetNotes();
            if (!current) {
                // Empty reflection → insert cleanly, no separator / no date header.
                _jnlSetNotes(tmplHtml);
            } else {
                // Append to existing content with dashed separator + session date.
                // One date header per journaling session: reuse trade.sessionHeaderDate
                // if already set, otherwise capture today's date and persist it so
                // writing across midnight in the same session keeps the same header.
                const trade = (journalData.trades || []).find(t => t.id === window._jnlSelectedTradeId);
                let sessionDate = trade && trade.sessionHeaderDate;
                if (!sessionDate) {
                    const months = ['January','February','March','April','May','June',
                                    'July','August','September','October','November','December'];
                    const d = new Date();
                    sessionDate = months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
                    if (trade) trade.sessionHeaderDate = sessionDate;
                }
                const sep = '------------------------------------------------------------------------------------------------';
                const appended =
                    '<p><br></p>' +
                    '<p>' + sep + '</p>' +
                    '<p>' + escapeHtml(sessionDate) + '</p>' +
                    tmplHtml;
                editor.innerHTML = editor.innerHTML + appended;
            }
            editor.focus();
            // Persist the appended/inserted content immediately so navigating
            // away before clicking Save Journal Entry doesn't lose the template.
            if (typeof window._jnlSaveDraft === 'function' && window._jnlSelectedTradeId) {
                window._jnlSaveDraft(window._jnlSelectedTradeId, editor.innerHTML);
            }
        }

        // ── Template Manager (2-panel) ─────────────────────────────────────────────
        let _tmFilter = 'all';
        let _tmplSelectedId = null;
        let _tmIsNewDraft = false; // true while + New form is open but not yet saved
        let _tmApplyTarget = null; // 'nt' when opened from New Trade; null → Trade Reflection

        // Template ids can come back from a cloud load as a string or a number:
        // compare as strings, and pass ids to inline handlers with their type kept.
        function _tmSameId(a, b) { return a != null && b != null && String(a) === String(b); }
        function _tmFind(id) { return (journalData.noteTemplates || []).find(t => _tmSameId(t.id, id)); }
        function _tmIdArg(id) { return escapeHtml(JSON.stringify(id)); }

        function openNoteTemplateManager(applyTarget) {
            _tmApplyTarget = applyTarget || null;
            if (!journalData.noteTemplates) journalData.noteTemplates = [];
            _tmFilter = 'all';
            _tmplSelectedId = null;
            _tmIsNewDraft = false;
            // Reset UI state
            setTimeout(() => {
                document.querySelectorAll('.tm-tab').forEach(t => t.classList.remove('active'));
                const allTab = document.querySelector('.tm-tab[data-filter="all"]');
                if (allTab) allTab.classList.add('active');
                const search = document.getElementById('tm-search');
                if (search) search.value = '';
                _tmShowEmptyState();
                tmRenderList();
            }, 0);
            openModal('note-template-modal');
        }

        function _tmShowEmptyState() {
            const emptyState = document.getElementById('tm-empty-state');
            const detail = document.getElementById('tm-detail');
            if (emptyState) emptyState.style.display = '';
            if (detail) detail.style.display = 'none';
        }

        function _tmShowDetail() {
            const emptyState = document.getElementById('tm-empty-state');
            const detail = document.getElementById('tm-detail');
            if (emptyState) emptyState.style.display = 'none';
            if (detail) detail.style.display = 'flex';
        }

        function tmSetFilter(filter, el) {
            _tmFilter = filter;
            document.querySelectorAll('.tm-tab').forEach(t => t.classList.remove('active'));
            if (el) el.classList.add('active');
            tmRenderList();
        }

        function tmGetFilteredTemplates() {
            const search = (document.getElementById('tm-search')?.value || '').trim().toLowerCase();
            return [...(journalData.noteTemplates || [])].filter(t => {
                if (_tmFilter === 'favorites' && !t.isFavorite) return false;
                if (_tmFilter === 'system' && t.sourceType !== 'system') return false;
                if (_tmFilter === 'user' && t.sourceType !== 'user') return false;
                if (search && !t.name.toLowerCase().includes(search)) return false;
                return true;
            }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        }

        function tmRenderList() {
            const list = document.getElementById('tm-list');
            if (!list) return;
            const templates = tmGetFilteredTemplates();
            if (!templates.length) {
                list.innerHTML = '<div style="padding:16px 10px;text-align:center;color:var(--text-secondary);font-size:13px;">No templates found.</div>';
                return;
            }
            list.innerHTML = templates.map(t => `
                <div class="tm-list-item${_tmSameId(t.id, _tmplSelectedId) ? ' active' : ''}" onclick="tmSelectTemplate(${_tmIdArg(t.id)})">
                    <span class="tm-list-item-name">${escapeHtml(t.name)}</span>
                    ${t.sourceType === 'system' ? '<span class="tm-list-item-sys">SYS</span>' : ''}
                    <button type="button" class="tm-list-item-star${t.isFavorite ? ' fav' : ''}"
                        onmousedown="event.stopPropagation()"
                        onclick="event.stopPropagation();tmToggleFavoriteById(${_tmIdArg(t.id)})"
                        title="${t.isFavorite ? 'Remove from favorites' : 'Add to favorites'}">${t.isFavorite ? '★' : '☆'}</button>
                </div>`).join('');
        }

        function tmSelectTemplate(id) {
            _tmIsNewDraft = false;
            _tmplSelectedId = id;
            tmRenderList();
            const tmpl = _tmFind(id);
            if (!tmpl) return;
            _tmShowDetail();
            const badge   = document.getElementById('tm-detail-badge');
            const nameEl  = document.getElementById('tm-detail-name');
            const notesEl = document.getElementById('tm-notes');
            const edWrap  = document.getElementById('tm-editor-wrap');
            const favBtn  = document.getElementById('tm-fav-btn');
            const saveBtn = document.getElementById('tm-save-btn');
            const delBtn  = document.getElementById('tm-delete-btn');
            const dupBtn  = document.getElementById('tm-duplicate-btn');
            const isSys   = tmpl.sourceType === 'system';
            if (badge)  { badge.textContent = isSys ? 'System Template' : 'User Template'; badge.className = 'tm-badge ' + (isSys ? 'sys' : 'usr'); }
            if (nameEl) { nameEl.value = tmpl.name; nameEl.readOnly = isSys; }
            _tmSetNotes(tmpl.content);
            if (notesEl) notesEl.contentEditable = isSys ? 'false' : 'true';
            if (edWrap)  edWrap.classList.toggle('tm-editor-readonly', isSys);
            if (favBtn) { favBtn.textContent = tmpl.isFavorite ? '★' : '☆'; favBtn.classList.toggle('fav', !!tmpl.isFavorite); favBtn.title = tmpl.isFavorite ? 'Remove from favorites' : 'Add to favorites'; }
            if (saveBtn) saveBtn.style.display = isSys ? 'none' : '';
            if (delBtn)  delBtn.style.display  = isSys ? 'none' : '';
            if (dupBtn)  dupBtn.style.display  = '';
            // Populate timeframe checkboxes
            const tfs = Array.isArray(tmpl.timeframes) ? tmpl.timeframes : [];
            document.querySelectorAll('.tm-tf-cb').forEach(cb => {
                cb.checked = tfs.includes(cb.value);
                cb.disabled = isSys;
                const lbl = cb.closest('.tm-tf-label');
                if (lbl) lbl.classList.toggle('disabled', isSys);
            });
            if (isSys) { if (typeof _editorGuardClose === 'function') _editorGuardClose('note-template-editor'); }
            else _tmGuardOpen(id);
        }

        // Batch 2: re-sync guard for the open user template (same rule as
        // the strategy editor).
        function _tmFormSig() {
            return JSON.stringify([document.getElementById('tm-detail-name')?.value || '', _tmGetNotes(),
                Array.from(document.querySelectorAll('.tm-tf-cb:checked')).map(cb => cb.value)]);
        }

        function _tmStaleSave(id) {
            const stored = (journalData.noteTemplates || []).find(t => String(t.id) === String(id)) || { id: id };
            _editorGuardConflict('note-template-editor', Object.assign({}, stored, {
                name: (document.getElementById('tm-detail-name')?.value || '').trim(),
                content: _tmGetNotes(),
                timeframes: Array.from(document.querySelectorAll('.tm-tf-cb:checked')).map(cb => cb.value)
            }));
            tmSelectTemplate(id);
        }

        function _tmGuardOpen(id) {
            if (typeof _editorGuardOpen !== 'function') return;
            const openSig = _tmFormSig();
            _editorGuardOpen('note-template-editor', 'noteTemplates', String(id), {
                isOpen: () => _tmSameId(_tmplSelectedId, id) && !_tmIsNewDraft &&
                    !!document.getElementById('note-template-modal')?.classList.contains('active'),
                isDirty: () => _tmFormSig() !== openSig,
                reload: () => tmSelectTemplate(id),
                resolve: () => _tmStaleSave(id)
            });
        }

        function tmNewTemplate() {
            _tmIsNewDraft = true;
            _tmplSelectedId = null;
            tmRenderList(); // refresh list — no active item
            _tmShowDetail();
            const badge   = document.getElementById('tm-detail-badge');
            const nameEl  = document.getElementById('tm-detail-name');
            const notesEl = document.getElementById('tm-notes');
            const edWrap  = document.getElementById('tm-editor-wrap');
            const favBtn  = document.getElementById('tm-fav-btn');
            const saveBtn = document.getElementById('tm-save-btn');
            const delBtn  = document.getElementById('tm-delete-btn');
            if (badge)  { badge.textContent = 'New Template'; badge.className = 'tm-badge usr'; }
            if (nameEl) { nameEl.value = ''; nameEl.readOnly = false; }
            _tmSetNotes('');
            if (notesEl) notesEl.contentEditable = 'true';
            if (edWrap)  edWrap.classList.remove('tm-editor-readonly');
            if (favBtn)  { favBtn.textContent = '★'; favBtn.classList.add('fav'); favBtn.title = 'Remove from favorites'; }
            if (saveBtn) saveBtn.style.display = '';
            if (delBtn)  delBtn.style.display = 'none'; // nothing to delete until saved
            const dupBtn = document.getElementById('tm-duplicate-btn');
            if (dupBtn)  dupBtn.style.display = 'none'; // nothing to copy until saved
            document.querySelectorAll('.tm-tf-cb').forEach(cb => {
                cb.checked = false;
                cb.disabled = false;
                const lbl = cb.closest('.tm-tf-label');
                if (lbl) lbl.classList.remove('disabled');
            });
            setTimeout(() => { if (nameEl) nameEl.focus(); }, 50);
        }

        function _refreshAllTemplateDropdowns() {
            renderNoteTemplateDropdown();
            ['daily','weekly','monthly','yearly'].forEach(function(t) {
                if (typeof window.renderRvTemplateDropdown === 'function') window.renderRvTemplateDropdown(t);
            });
        }

        async function tmToggleFavorite() {
            if (!_tmplSelectedId) return;
            const tmpl = _tmFind(_tmplSelectedId);
            if (!tmpl) return;
            tmpl.isFavorite = !tmpl.isFavorite;
            if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                _saveNoteTemplateToSupabase(tmpl);
            }
            await saveToIndexedDB();
            _refreshAllTemplateDropdowns();
            tmRenderList();
            const favBtn = document.getElementById('tm-fav-btn');
            if (favBtn) { favBtn.textContent = tmpl.isFavorite ? '★' : '☆'; favBtn.classList.toggle('fav', tmpl.isFavorite); favBtn.title = tmpl.isFavorite ? 'Remove from favorites' : 'Add to favorites'; }
        }

        async function tmToggleFavoriteById(id) {
            const tmpl = _tmFind(id);
            if (!tmpl) return;
            tmpl.isFavorite = !tmpl.isFavorite;
            if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                _saveNoteTemplateToSupabase(tmpl);
            }
            await saveToIndexedDB();
            _refreshAllTemplateDropdowns();
            tmRenderList();
            if (_tmSameId(_tmplSelectedId, id)) {
                const favBtn = document.getElementById('tm-fav-btn');
                if (favBtn) { favBtn.textContent = tmpl.isFavorite ? '★' : '☆'; favBtn.classList.toggle('fav', tmpl.isFavorite); favBtn.title = tmpl.isFavorite ? 'Remove from favorites' : 'Add to favorites'; }
            }
        }

        async function tmSaveTemplate() {
            const nameEl = document.getElementById('tm-detail-name');
            const name = (nameEl?.value || '').trim();
            if (!name) { nameEl?.focus(); return; }

            if (_tmIsNewDraft) {
                // First save: create and persist the new template record
                if (!journalData.noteTemplates) journalData.noteTemplates = [];
                const newId = Date.now();
                const newTmpl = {
                    id: newId,
                    name,
                    content: _tmGetNotes(),
                    sourceType: 'user',
                    isFavorite: true,
                    timeframes: Array.from(document.querySelectorAll('.tm-tf-cb:checked')).map(cb => cb.value)
                };
                journalData.noteTemplates.push(newTmpl);
                _tmIsNewDraft = false;
                _tmplSelectedId = newId;
                // Switch to Mine tab so the new entry is visible in the list
                _tmFilter = 'user';
                document.querySelectorAll('.tm-tab').forEach(t => t.classList.remove('active'));
                const mineTab = document.querySelector('.tm-tab[data-filter="user"]');
                if (mineTab) mineTab.classList.add('active');
                if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                    var _ctRes = await _saveNoteTemplateToSupabase(newTmpl);
                    if (!_ctRes.success) console.warn('[CloudSave] New template save failed, falling back to cache.');
                }
                await saveToIndexedDB();
                tmRenderList();
                renderNoteTemplateDropdown();
                // Update badge and show Delete now that the template exists
                const badge  = document.getElementById('tm-detail-badge');
                const delBtn = document.getElementById('tm-delete-btn');
                if (badge)  { badge.textContent = 'User Template'; badge.className = 'tm-badge usr'; }
                if (delBtn) delBtn.style.display = '';
                return;
            }

            if (!_tmplSelectedId) return;
            // Batch 2: changed on another device while open → conflict copy, reload.
            if (typeof _editorGuardStale === 'function' && _editorGuardStale('note-template-editor', String(_tmplSelectedId)) === true) {
                _tmStaleSave(_tmplSelectedId);
                return;
            }
            const tmpl = _tmFind(_tmplSelectedId);
            if (!tmpl || tmpl.sourceType === 'system') return;
            tmpl.name = name;
            tmpl.content = _tmGetNotes();
            tmpl.timeframes = Array.from(document.querySelectorAll('.tm-tf-cb:checked')).map(cb => cb.value);
            if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                var _etRes = await _saveNoteTemplateToSupabase(tmpl);
                if (!_etRes.success) console.warn('[CloudSave] Template edit save failed, falling back to cache.');
            }
            await saveToIndexedDB();
            tmRenderList();
            renderNoteTemplateDropdown();
        }

        async function tmDeleteTemplate() {
            if (!_tmplSelectedId) return;
            const tmpl = _tmFind(_tmplSelectedId);
            if (!tmpl || tmpl.sourceType === 'system') return;
            if (!confirm(`Delete template "${tmpl.name}"?`)) return;
            var _deletedTmplId = _tmplSelectedId;
            journalData.noteTemplates = journalData.noteTemplates.filter(t => !_tmSameId(t.id, _deletedTmplId));
            _tmplSelectedId = null;
            if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                _deleteNoteTemplateFromSupabase(_deletedTmplId);
            }
            await saveToIndexedDB();
            tmRenderList();
            renderNoteTemplateDropdown();
            _tmShowEmptyState();
        }

        // Copy of the selected template (System or user) as a new user template,
        // opened for editing under Mine. The original is left as it is.
        async function tmDuplicateTemplate() {
            if (_tmIsNewDraft || !_tmplSelectedId) return;
            const src = _tmFind(_tmplSelectedId);
            if (!src) return;
            if (!journalData.noteTemplates) journalData.noteTemplates = [];
            const newId = Date.now();
            const copy = {
                id: newId,
                name: (src.name || 'Template') + ' (copy)',
                content: src.content || '',
                sourceType: 'user',
                isFavorite: true,
                timeframes: Array.isArray(src.timeframes) ? src.timeframes.slice() : []
            };
            journalData.noteTemplates.push(copy);
            _tmFilter = 'user';
            document.querySelectorAll('.tm-tab').forEach(t => t.classList.remove('active'));
            const mineTab = document.querySelector('.tm-tab[data-filter="user"]');
            if (mineTab) mineTab.classList.add('active');
            if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                var _dtRes = await _saveNoteTemplateToSupabase(copy);
                if (!_dtRes.success) console.warn('[CloudSave] Duplicated template save failed, falling back to cache.');
            }
            await saveToIndexedDB();
            _refreshAllTemplateDropdowns();
            tmSelectTemplate(newId);
            const nameEl = document.getElementById('tm-detail-name');
            if (nameEl) { nameEl.focus(); nameEl.select(); }
        }

        function tmApplyTemplate() {
            if (!_tmplSelectedId) return;
            const tmpl = _tmFind(_tmplSelectedId);
            if (!tmpl) return;
            if (_tmApplyTarget === 'nt') {
                closeModal('note-template-modal');
                window._ntApplyTemplate(tmpl.id);
                return;
            }
            if (_jnlGetNotes() && !confirm('Replace current notes with this template?')) return;
            _jnlSetNotes(tmpl.content);
            closeModal('note-template-modal');
            const editor = document.getElementById('jnl-notes');
            if (editor) editor.focus();
        }

        // ── Template editor (rich, mirrors Journal Notes editor) ──────────────────

        let _tmEdSavedRange = null;

        function _tmGetNotes() {
            const el = document.getElementById('tm-notes');
            if (!el) return '';
            const html = el.innerHTML.trim();
            return (html === '' || html === '<br>') ? '' : html;
        }

        function _tmSetNotes(content) {
            const el = document.getElementById('tm-notes');
            if (!el) return;
            if (!content) { el.innerHTML = ''; return; }
            if (!/<[a-z][\s\S]*>/i.test(content)) {
                el.innerHTML = content
                    .split('\n\n')
                    .map(para => para.trim() ? `<p>${para.replace(/\n/g, '<br>')}</p>` : '<p><br></p>')
                    .join('');
            } else {
                el.innerHTML = content;
            }
        }

        function tmEdSaveSelection() {
            const sel = window.getSelection();
            const editor = document.getElementById('tm-notes');
            if (sel && sel.rangeCount && editor && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
                _tmEdSavedRange = sel.getRangeAt(0).cloneRange();
            }
        }

        function tmEdRestoreSelection() {
            const editor = document.getElementById('tm-notes');
            if (!editor || !_tmEdSavedRange) { if (editor) editor.focus(); return; }
            editor.focus();
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(_tmEdSavedRange);
        }

        function tmEdExec(cmd, value) {
            document.getElementById('tm-notes').focus();
            document.execCommand(cmd, false, value !== undefined ? value : null);
            tmEdUpdateToolbar();
        }

        function tmEdApplyFont(val) {
            if (!val) return;
            tmEdRestoreSelection();
            document.execCommand('fontName', false, val);
            tmEdUpdateToolbar();
        }

        function tmEdApplySize(px) {
            if (!px) return;
            tmEdRestoreSelection();
            document.execCommand('fontSize', false, '7');
            const editor = document.getElementById('tm-notes');
            if (editor) {
                editor.querySelectorAll('font[size="7"]').forEach(el => {
                    el.removeAttribute('size');
                    el.style.fontSize = px + 'px';
                });
            }
            tmEdUpdateToolbar();
        }

        function tmEdApplyColor(val) {
            tmEdRestoreSelection();
            document.execCommand('foreColor', false, val);
            const swatch = document.getElementById('tm-color-swatch');
            if (swatch) swatch.style.textDecorationColor = val;
        }

        function tmEdApplyHighlight(val) {
            tmEdRestoreSelection();
            document.execCommand('hiliteColor', false, val);
            const swatch = document.getElementById('tm-hl-swatch');
            if (swatch) { swatch.style.background = val; swatch.style.color = _jnlContrastColor(val); }
        }

        function tmEdUpdateToolbar() {
            const wrap = document.getElementById('tm-editor-wrap');
            if (!wrap) return;
            ['bold', 'italic', 'underline', 'strikeThrough'].forEach(cmd => {
                const btn = wrap.querySelector(`[data-tmcmd="${cmd}"]`);
                if (btn) btn.classList.toggle('active', document.queryCommandState(cmd));
            });
        }

        function tmEdHandleKeydown(e) {
            if (e.ctrlKey || e.metaKey) {
                if (e.key === 'b') { e.preventDefault(); tmEdExec('bold'); }
                else if (e.key === 'i') { e.preventDefault(); tmEdExec('italic'); }
                else if (e.key === 'u') { e.preventDefault(); tmEdExec('underline'); }
                else if (e.key === 'z') { e.preventDefault(); tmEdExec('undo'); }
                else if (e.key === 'y') { e.preventDefault(); tmEdExec('redo'); }
            }
            if (e.key === 'Tab') {
                e.preventDefault();
                document.execCommand('insertHTML', false, '&nbsp;&nbsp;&nbsp;&nbsp;');
            }
        }

        function tmEdOnInput() {
            const el = document.getElementById('tm-notes');
            if (el && el.innerHTML === '<br>') el.innerHTML = '';
        }

        // ── Rich notes editor ──────────────────────────────────────────────────────

        // Save/restore selection so toolbar actions don't lose the cursor/range
        let _jnlSavedRange = null;

        function jnlSaveSelection() {
            const sel = window.getSelection();
            const editor = document.getElementById('jnl-notes');
            if (sel && sel.rangeCount && editor && editor.contains(sel.getRangeAt(0).commonAncestorContainer)) {
                _jnlSavedRange = sel.getRangeAt(0).cloneRange();
            }
        }

        function jnlRestoreSelection() {
            const editor = document.getElementById('jnl-notes');
            if (!editor || !_jnlSavedRange) { if (editor) editor.focus(); return; }
            editor.focus();
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(_jnlSavedRange);
        }

        // Execute a formatting command
        function jnlExec(cmd, value) {
            document.getElementById('jnl-notes').focus();
            document.execCommand(cmd, false, value !== undefined ? value : null);
            jnlUpdateToolbar();
        }

        // Apply font family (restores selection first since select blurs the editor)
        function jnlApplyFont(val) {
            if (!val) return;
            jnlRestoreSelection();
            document.execCommand('fontName', false, val);
            jnlUpdateToolbar();
        }

        // Apply font size in real px. execCommand only accepts 1–7 legacy integers,
        // so we use "7" as a sentinel then immediately swap it for CSS font-size.
        function jnlApplySize(px) {
            if (!px) return;
            jnlRestoreSelection();
            document.execCommand('fontSize', false, '7');
            const editor = document.getElementById('jnl-notes');
            if (editor) {
                editor.querySelectorAll('font[size="7"]').forEach(el => {
                    el.removeAttribute('size');
                    el.style.fontSize = px + 'px';
                });
            }
            jnlUpdateToolbar();
        }

        // Text color
        function jnlApplyColor(val) {
            jnlRestoreSelection();
            document.execCommand('foreColor', false, val);
            const swatch = document.getElementById('jnl-color-swatch');
            if (swatch) swatch.style.textDecorationColor = val;
        }

        // Highlight / background color
        function jnlApplyHighlight(val) {
            jnlRestoreSelection();
            document.execCommand('hiliteColor', false, val);
            const swatch = document.getElementById('jnl-hl-swatch');
            if (swatch) { swatch.style.background = val; swatch.style.color = _jnlContrastColor(val); }
        }

        // Pick a readable contrast color (black or white) for a hex bg
        function _jnlContrastColor(hex) {
            const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
            return (r*299 + g*587 + b*114) / 1000 >= 128 ? '#1a1a1a' : '#ffffff';
        }

        // Highlight active toolbar buttons based on current selection state
        function jnlUpdateToolbar() {
            const cmds = ['bold', 'italic', 'underline', 'strikeThrough'];
            cmds.forEach(cmd => {
                const btn = document.querySelector(`.jnl-toolbar [data-cmd="${cmd}"]`);
                if (btn) btn.classList.toggle('active', document.queryCommandState(cmd));
            });
        }

        // Keyboard shortcuts and Escape-fullscreen
        function jnlHandleKeydown(e) {
            if (e.key === 'Escape') {
                const wrap = document.getElementById('jnl-editor-wrap');
                if (wrap && wrap.classList.contains('jnl-fullscreen')) { e.preventDefault(); jnlToggleFullscreen(); }
                return;
            }
            // Tab inserts 4 spaces instead of navigating away
            if (e.key === 'Tab') {
                e.preventDefault();
                document.execCommand('insertHTML', false, '&nbsp;&nbsp;&nbsp;&nbsp;');
            }
        }

        // Clear empty <br> left by browser so CSS :empty placeholder works
        function jnlOnInput() {
            const el = document.getElementById('jnl-notes');
            if (el && el.innerHTML === '<br>') el.innerHTML = '';
        }

        // Fullscreen toggle
        function jnlToggleFullscreen() {
            const wrap = document.getElementById('jnl-editor-wrap');
            const btn  = document.getElementById('jnl-fs-btn');
            if (!wrap) return;
            const on = wrap.classList.toggle('jnl-fullscreen');
            if (btn) btn.title = on ? 'Exit Fullscreen (Esc)' : 'Fullscreen (Esc to exit)';
            if (btn) btn.textContent = on ? '✕' : '⛶';
            if (on) document.getElementById('jnl-notes').focus();
        }

        // ========== DELETE TRADE ==========

        async function deleteTrade(tradeId) {
            // Ids can arrive as a number (inline onclick) while stored ids are
            // strings (cloud-loaded), so match as strings and use the stored id.
            const trade = journalData.trades.find(t => String(t.id) === String(tradeId));
            if (!trade) return;
            tradeId = trade.id;
            // Open trades have pnl null — show "Open" instead of a dollar amount.
            const pnlText = (trade.pnl == null || isNaN(trade.pnl))
                ? 'Open'
                : `${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}`;
            if (!confirm(`Delete ${_displaySymbol(trade.symbol)} trade (${pnlText})? This cannot be undone.`)) return;

            // Cloud-primary: delete from Supabase first so it doesn't
            // reappear; a failed delete keeps the trade and changes nothing.
            if (_isCloudPrimarySave()) {
                var _cdRes = await _deleteTradeFromSupabase(tradeId);
                if (!(_cdRes && _cdRes.success)) {
                    alert('Failed to delete: ' + ((_cdRes && _cdRes.error) || 'unknown error') + '\nYour data was not changed. Please try again.');
                    return;
                }
                _triggerCloudDashRefresh();
            }
            // A deleted Webull trade is never re-imported by sync.
            if (typeof WebullSync !== 'undefined') WebullSync.noteDeletedTrades(journalData, [trade]);
            journalData.trades = journalData.trades.filter(t => t.id !== tradeId);
            await saveToIndexedDB();
            updateDashboard();

        }

        let _dashPeriod = 'all';

        // Dashboard-specific: sync _dashPeriod from the dropdown so
        // getDashFilteredTrades and the date range label keep working.
        function _syncDashPeriod() {
            var sel = document.getElementById('dash-period');
            _dashPeriod = sel ? sel.value : 'all';
        }

        // Legacy shim — still called by switchDashView for programmatic
        // period changes (save/restore). Sets the dropdown value and fires
        // the same code path as a manual change.
        function setDashPeriod(period) {
            var sel = document.getElementById('dash-period');
            if (sel) sel.value = period;
            _dashPeriod = period;
            updateDashboard();
        }

        function _populateDashStrategies() {
            DenariiFilters.populateStrategy(document.getElementById('dash-strategy'), journalData.trades, journalData.strategies);
        }

        // Local YYYY-MM-DD string for a Date (avoids UTC shift from toISOString)
        function _localDateStr(d) {
            var y = d.getFullYear();
            var m = d.getMonth() + 1;
            var day = d.getDate();
            return y + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
        }

        function getDashFilteredTrades(trades) {
            var state = DenariiFilters.readState('dash');
            state.period = _dashPeriod;
            return DenariiFilters.filterTrades(trades, state, journalData.brokerAccounts, new Date());
        }

        // Gross wins / gross losses, the same rule as Snapshot's calcSnap.
        function _grossProfitFactor(winners, losers) {
            var sumWins = winners.reduce(function(sum, t) { return sum + t.pnl; }, 0);
            var sumLosses = losers.reduce(function(sum, t) { return sum + t.pnl; }, 0);
            return sumLosses ? Math.abs(sumWins / sumLosses) : (sumWins > 0 ? Infinity : 0);
        }

        // Dashboard
        // ========== MODAL MANAGEMENT ==========
        
        function openModal(modalId, returnFocusId = null) {
            const modal = document.getElementById(modalId);
            if (!modal) return;
            
            // Save return focus element
            if (returnFocusId) {
                modal.dataset.returnFocus = returnFocusId;
            } else if (document.activeElement && document.activeElement.id) {
                modal.dataset.returnFocus = document.activeElement.id;
            }
            
            modal.classList.add('active');
            document.body.classList.add('modal-open');
            
            // Focus first focusable element
            setTimeout(() => {
                const firstFocusable = modal.querySelector('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
                if (firstFocusable) firstFocusable.focus();
            }, 250);
        }
        
        function closeModal(modalId) {
            const modal = document.getElementById(modalId);
            if (!modal) return;
            
            modal.classList.remove('active');
            
            // Return focus to element that opened the modal
            const returnId = modal.dataset.returnFocus;
            if (returnId) {
                setTimeout(() => {
                    const returnEl = document.getElementById(returnId);
                    if (returnEl) returnEl.focus();
                    delete modal.dataset.returnFocus;
                }, 250);
            }
            
            // Remove body class if no other modals are open
            setTimeout(() => {
                if (!document.querySelector('.modal.active')) {
                    document.body.classList.remove('modal-open');
                }
            }, 250);
        }
        
        // Global Escape key handler
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;

            const topModal = document.querySelector('.modal.active');
            if (!topModal) return;

            if (topModal.id === 'stock-chart-modal') {
                window.closeStockChart?.();
            }
        });

        // Click-outside-to-close for all modals
        document.addEventListener('DOMContentLoaded', () => {
            document.querySelectorAll('.modal').forEach(modal => {
                modal.addEventListener('mousedown', (e) => {
                    if (e.target !== modal) return;

                    if (modal.id === 'stock-chart-modal') {
                        window.closeStockChart?.();
                    } else {
                        closeModal(modal.id);
                    }
                });
            });
        });

        // ── Dashboard bulk-selection + bulk actions ───────────────────────────
        // A checkbox on each Dashboard trade row feeds a Set of selected
        // trade ids. When at least one row is selected, a bulk action bar
        // renders above the list with Clear, Delete Selected, and Merge
        // Selected. Merge is only enabled when ALL selected trades share
        // the same contract identity (symbol, side, assetType,
        // brokerAccountId — plus optionType/strike/expiry/contractName
        // for options). Incompatible selections show an explicit reason.
        // Merge always requires the user to pick the primary trade and
        // then confirm a summary before any data is written.
        var _dashSelectedIds = new Set();
        var _dashMergePickerActive = false;
        var _dashMergePrimaryId = null;
        // The ids of trades currently visible under the active dashboard
        // filters/sort. Populated by updateDashboard on every render and
        // consumed by the master "Select all visible" checkbox so the
        // toggle only affects visible rows (not hidden/filtered ones).
        var _dashVisibleIds = [];
        // The rows behind _dashVisibleIds (cloud page rows or local trades),
        // used for the Delete Selected confirm text.
        var _dashVisibleTrades = [];
        // Filters + sort + page of the last render. A change clears the
        // selection so ticked rows never outlive what the user can see.
        var _dashSelectionViewKey = null;

        // Clears the selection without re-rendering. Called on filter, sort,
        // page and tab changes and on section navigation.
        function _dashResetSelection() {
            _dashSelectedIds.clear();
            _dashMergePickerActive = false;
            _dashMergePrimaryId = null;
        }

        // Any filter, account, sort or page change clears the selection.
        // _cloudDashGetFilters reads the same inputs as the local filter path.
        function _dashSyncSelectionViewKey(isCloud) {
            var key = JSON.stringify(_cloudDashGetFilters()) + '|'
                + _dashSortField + ':' + _dashSortDir + '|'
                + (isCloud ? _cloudDash.page : 1);
            if (key !== _dashSelectionViewKey) {
                if (_dashSelectionViewKey !== null) _dashResetSelection();
                _dashSelectionViewKey = key;
            }
        }

        function _dashTradesTabActive() {
            var tab = document.querySelector('.dash-view-tab.active');
            return !tab || tab.getAttribute('data-dash-view') === 'trades';
        }

        // Selected ids that are on screen in the Trades table right now.
        function _dashVisibleSelectedIds() {
            if (!_dashTradesTabActive()) return [];
            return _dashVisibleIds.filter(function(id) { return _dashSelectedIds.has(id); });
        }

        // Drops every selected id that is not visible. Delete and Merge
        // call this first so they can only act on rows the user can see.
        function _dashPruneToVisible() {
            var keep = new Set(_dashVisibleSelectedIds());
            Array.from(_dashSelectedIds).forEach(function(id) {
                if (!keep.has(Number(id))) _dashSelectedIds.delete(id);
            });
            return Array.from(keep);
        }

        // Master "select all visible" handler. Called from the checkbox
        // in the trades table header.
        function dashToggleSelectAllVisible(checked) {
            if (checked) {
                _dashVisibleIds.forEach(function(id) { _dashSelectedIds.add(id); });
            } else {
                _dashVisibleIds.forEach(function(id) { _dashSelectedIds.delete(id); });
            }
            // Consistent with per-row toggle: exit merge picker on any
            // selection change so the UI stays in sync with the new set.
            _dashMergePickerActive = false;
            _dashMergePrimaryId = null;
            updateDashboard();
        }

        // Keeps the master checkbox's checked / indeterminate state in
        // sync with the current selection vs the visible set.
        //   • every visible id selected              → checked, not indeterminate
        //   • no visible id selected                 → unchecked, not indeterminate
        //   • some but not all visible ids selected  → unchecked, indeterminate
        function _dashRefreshSelectAllMaster() {
            var masters = [
                document.getElementById('dash-select-all-master'),
                document.getElementById('dash-select-all-tbl')
            ];
            var visible = _dashVisibleIds;
            var n = visible.length;
            var selectedVisible = 0;
            for (var i = 0; i < n; i++) {
                if (_dashSelectedIds.has(visible[i])) selectedVisible++;
            }
            masters.forEach(function (m) {
                if (!m) return;
                if (n === 0 || selectedVisible === 0) {
                    m.checked = false;
                    m.indeterminate = false;
                } else if (selectedVisible === n) {
                    m.checked = true;
                    m.indeterminate = false;
                } else {
                    m.checked = false;
                    m.indeterminate = true;
                }
            });
        }

        function dashToggleTradeSelection(tradeId) {
            // Coerce to Number so the Set entry type matches regardless of
            // whether t.id arrived as a string (Supabase bigint) or number
            // (local Date.now()). The inline onclick always passes a number
            // literal, but the has()/render check uses the original t.id
            // type, so they must agree.
            tradeId = Number(tradeId);
            if (_dashSelectedIds.has(tradeId)) _dashSelectedIds.delete(tradeId);
            else _dashSelectedIds.add(tradeId);
            // Exit merge picker on any selection change so the UI stays
            // consistent with the new set.
            _dashMergePickerActive = false;
            _dashMergePrimaryId = null;
            updateDashboard();
        }

        function dashClearSelection() {
            _dashResetSelection();
            updateDashboard();
        }

        // Drops selected ids whose trade no longer exists or belongs to a
        // hidden broker account. Hidden trades aren't shown, so a selection
        // made before hiding must not reach Merge or Delete Selected.
        function _dashPruneSelection() {
            var hidden = {};
            (journalData.brokerAccounts || []).forEach(function(a) { if (a && a.visible === false) hidden[a.id] = true; });
            var keep = new Set((journalData.trades || [])
                .filter(function(t) { return !hidden[t.brokerAccountId]; })
                .map(function(t) { return Number(t.id); }));
            Array.from(_dashSelectedIds).forEach(function(id) {
                if (!keep.has(Number(id))) _dashSelectedIds.delete(id);
            });
        }

        // Union of the selected trades' Webull order maps ({ orderId: qty }).
        // Quantities add on overlap, so the sync engine's per-order total
        // (it sums across a journal's trades) is the same after a merge.
        function _dashUnionOrderIds(trades) {
            var out = {};
            trades.forEach(function(t) {
                var ids = (t && t.externalOrderIds && typeof t.externalOrderIds === 'object') ? t.externalOrderIds : {};
                Object.keys(ids).forEach(function(id) {
                    out[id] = Math.round(((out[id] || 0) + (Number(ids[id]) || 0)) * 1e8) / 1e8;
                });
            });
            return out;
        }

        // Compatibility check for bulk merge. Returns { ok, reason }.
        function _dashCheckMergeCompat(ids) {
            if (!Array.isArray(ids) || ids.length < 2) {
                return { ok: false, reason: 'Select 2 or more trades to merge.' };
            }
            var trades = ids
                .map(function(id) { return journalData.trades.find(function(t) { return Number(t.id) === Number(id); }); })
                .filter(Boolean);
            if (trades.length < 2) {
                return { ok: false, reason: 'Some selected trades are missing.' };
            }
            // Imported Webull trades merge only with each other and only when
            // closed: the merged trade keeps every absorbed order in
            // externalOrderIds, so the next sync skips them (dashConfirmMerge).
            var wbCount = trades.filter(function(t) { return t.source === 'webull'; }).length;
            if (wbCount > 0 && wbCount < trades.length) {
                return { ok: false, reason: 'Imported Webull trades can only be merged with other imported Webull trades.' };
            }
            if (wbCount > 0) {
                if (trades.some(function(t) { return _isOpenTrade(t) || t.webullPartials != null; })) {
                    return { ok: false, reason: 'Open Webull trades can\'t be merged; merge them after the position is closed.' };
                }
                if (trades.some(function(t) {
                    return !t.externalId || !t.externalOrderIds || typeof t.externalOrderIds !== 'object'
                        || Object.keys(t.externalOrderIds).length === 0;
                })) {
                    return { ok: false, reason: 'This Webull trade is missing its import IDs and can\'t be merged.' };
                }
            }
            var first = trades[0];
            var firstAssetType = first.assetType || (first.optionType ? 'option' : 'stock');
            for (var i = 1; i < trades.length; i++) {
                var t = trades[i];
                var tAssetType = t.assetType || (t.optionType ? 'option' : 'stock');
                if (t.symbol !== first.symbol ||
                    tAssetType !== firstAssetType ||
                    (t.type || 'long') !== (first.type || 'long') ||
                    (t.brokerAccountId || '') !== (first.brokerAccountId || '')) {
                    return {
                        ok: false,
                        reason: 'Selected trades must match symbol, asset type, side, and broker account.'
                    };
                }
                if (firstAssetType === 'option') {
                    if ((t.optionType || null) !== (first.optionType || null)) {
                        return { ok: false, reason: 'Option trades must match option type.' };
                    }
                    if ((Number(t.strike) || 0) !== (Number(first.strike) || 0)) {
                        return { ok: false, reason: 'Option trades must match strike.' };
                    }
                    if ((t.expiry || null) !== (first.expiry || null)) {
                        return { ok: false, reason: 'Option trades must match expiry.' };
                    }
                    var cnA = first.contractName || null;
                    var cnB = t.contractName || null;
                    if (cnA && cnB && cnA !== cnB) {
                        return { ok: false, reason: 'Option trades must match contract name.' };
                    }
                }
            }
            return { ok: true, reason: '' };
        }

        function _dashExpandTradeToFills(t) {
            // Existing fills[] wins; otherwise synthesize one fill from
            // the trade's scalar fields. Each returned fill is a shallow
            // copy so downstream mutations don't touch the original
            // trade's fills references.
            if (Array.isArray(t.fills) && t.fills.length > 0) {
                return t.fills.map(function(f) { return Object.assign({}, f); });
            }
            return [{
                quantity:       Number(t.quantity) || 0,
                entryPrice:     Number(t.entryPrice) || 0,
                exitPrice:      Number(t.exitPrice) || 0,
                entryTime:      t.entryTime,
                exitTime:       t.exitTime,
                commissionFees: Number(t.commissionFees) || 0,
                pnl:            Number(t.pnl) || 0
            }];
        }

        // Confirm text for Delete Selected: exact count, then symbol + date
        // for the first 10 trades and "and N more".
        function _dashDeleteConfirmText(ids) {
            var lines = ids.slice(0, 10).map(function(id) {
                var t = _dashVisibleTrades.find(function(r) { return Number(r.id) === Number(id); })
                    || (journalData.trades || []).find(function(r) { return Number(r.id) === Number(id); });
                if (!t) return '  id ' + id;
                return '  ' + (_displaySymbol(t.symbol) || '?') + '  '
                    + new Date(t.exitTime || t.entryTime).toLocaleDateString();
            });
            if (ids.length > 10) lines.push('  and ' + (ids.length - 10) + ' more');
            return 'Delete ' + ids.length + ' trade' + (ids.length === 1 ? '' : 's')
                + '? This cannot be undone.\n\n' + lines.join('\n');
        }

        async function dashDeleteSelected() {
            var ids = _dashPruneToVisible();
            if (ids.length === 0) { updateDashboard(); return; }
            if (!confirm(_dashDeleteConfirmText(ids))) return;
            // Snapshot: shallow copy is sufficient here because no trade
            // objects are mutated — only array membership changes.
            var _tradesSnapshot = journalData.trades.slice();
            var _wbIgnoredSnapshot = JSON.stringify(journalData.webullIgnoredOrders || null);
            var idSet = {};
            ids.forEach(function(id) { idSet[id] = true; });
            // Deleted Webull trades are never re-imported by sync.
            if (typeof WebullSync !== 'undefined') {
                WebullSync.noteDeletedTrades(journalData, journalData.trades.filter(function(t) { return idSet[t.id]; }));
            }
            journalData.trades = journalData.trades.filter(function(t) { return !idSet[t.id]; });
            try {
                if (_isCloudPrimarySave()) {
                    var _bdRes = await _deleteTradesFromSupabase(ids);
                    if (!(_bdRes && _bdRes.success)) throw new Error((_bdRes && _bdRes.error) || 'unknown error');
                    _triggerCloudDashRefresh();
                }
                await saveToIndexedDB();
            } catch (e) {
                journalData.trades = _tradesSnapshot;
                var _wbIgnored = JSON.parse(_wbIgnoredSnapshot);
                if (_wbIgnored) journalData.webullIgnoredOrders = _wbIgnored; else delete journalData.webullIgnoredOrders;
                alert('Failed to delete: ' + (e && e.message ? e.message : 'unknown error') + '\nYour data was not changed. Please try again.');
                return;
            }
            _dashSelectedIds.clear();
            _dashMergePickerActive = false;
            _dashMergePrimaryId = null;
            updateDashboard();
        }

        function dashStartMergePicker() {
            var ids = _dashPruneToVisible();
            var compat = _dashCheckMergeCompat(ids);
            if (!compat.ok) { alert('Cannot merge: ' + compat.reason); return; }
            _dashMergePickerActive = true;
            // Default primary = the earliest entry-time trade. The user
            // can change this in the picker before confirming.
            var trades = ids
                .map(function(id) { return journalData.trades.find(function(t) { return Number(t.id) === Number(id); }); })
                .filter(Boolean)
                .sort(function(a, b) { return new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime(); });
            _dashMergePrimaryId = trades.length ? trades[0].id : null;
            updateDashboard();
        }

        function dashCancelMergePicker() {
            _dashMergePickerActive = false;
            _dashMergePrimaryId = null;
            updateDashboard();
        }

        function dashSetMergePrimary(tradeId) {
            _dashMergePrimaryId = tradeId;
            updateDashboard();
        }

        async function dashConfirmMerge() {
            var ids = _dashPruneToVisible();
            var compat = _dashCheckMergeCompat(ids);
            if (!compat.ok) { alert('Cannot merge: ' + compat.reason); return; }
            var primaryId = _dashMergePrimaryId;
            if (primaryId == null || !_dashSelectedIds.has(primaryId)) {
                alert('Please choose the primary trade first.');
                return;
            }
            var primary = journalData.trades.find(function(t) { return Number(t.id) === Number(primaryId); });
            if (!primary) { alert('Primary trade not found.'); return; }
            var others = ids
                .filter(function(id) { return Number(id) !== Number(primaryId); })
                .map(function(id) { return journalData.trades.find(function(t) { return Number(t.id) === Number(id); }); })
                .filter(Boolean);

            // Combine fills from all selected trades (primary first,
            // then each absorbed trade in selection order).
            var combinedFills = _dashExpandTradeToFills(primary);
            others.forEach(function(t) {
                combinedFills = combinedFills.concat(_dashExpandTradeToFills(t));
            });

            var msg = 'Merge ' + ids.length + ' trades?\n\n'
                + '  Primary (kept):  ' + primary.symbol + '  id ' + primary.id + '\n'
                + '  Absorbed:        ' + others.length + ' trade'
                    + (others.length === 1 ? '' : 's') + '\n'
                + '  Combined fills:  ' + combinedFills.length + '\n\n'
                + 'Strategy / setup / notes / tags / grade from the primary trade are kept. '
                + 'Journal context from the absorbed trades is NOT merged in this phase — '
                + 'absorbed trades will be removed.\n\nContinue?';
            if (!confirm(msg)) return;

            // Sort combined fills chronologically so fills[] reads in
            // natural order, then re-stamp stable fillIds.
            combinedFills.sort(function(a, b) {
                return new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime();
            });
            combinedFills.forEach(function(f, i) { f.fillId = 'f' + (i + 1); });

            // Deep snapshot before mutation. Required because
            // finalizeTradeSummary mutates the primary trade object
            // in-place (fills, scalar fields, notesUpdatedAt).
            var _tradesSnapshot = JSON.parse(JSON.stringify(journalData.trades));

            // Webull merge (compat guarantees all-or-none): keep every order
            // ID with its quantity; externalId stays the primary's.
            var _isWebullMerge = primary.source === 'webull';
            if (_isWebullMerge) {
                primary.externalOrderIds = _dashUnionOrderIds([primary].concat(others));
                // Cloud-loaded rows carry direction, not type; finalize prices by type.
                if (!primary.type && primary.direction) primary.type = primary.direction;
            }

            primary.fills = combinedFills;
            finalizeTradeSummary(primary);
            _roundTradeForSave(primary);
            primary.notesUpdatedAt = Date.now();

            // Remove absorbed trades only after all mutations are staged.
            // Their Webull orders are never re-imported as separate trades.
            var _wbIgnoredSnapshot = JSON.stringify(journalData.webullIgnoredOrders || null);
            if (typeof WebullSync !== 'undefined') WebullSync.noteDeletedTrades(journalData, others);
            var absorbedSet = {};
            others.forEach(function(t) { absorbedSet[t.id] = true; });
            journalData.trades = journalData.trades.filter(function(t) { return !absorbedSet[t.id]; });

            // Merges check each cloud result: a failed primary save
            // deletes nothing; a failed delete puts the primary row back.
            var _deleteFailed = false;
            try {
                // Cloud-primary: upsert merged primary, delete absorbed trades
                if (_isCloudPrimarySave()) {
                    var _saveRes = await _saveTradeToSupabase(primary);
                    if (!(_saveRes && _saveRes.success)) {
                        throw new Error((_saveRes && _saveRes.error) || 'cloud save failed');
                    }
                    var _absorbedIds = others.map(function(t) { return t.id; });
                    if (_absorbedIds.length > 0) {
                        var _delRes = await _deleteTradesFromSupabase(_absorbedIds);
                        if (!(_delRes && _delRes.success)) {
                            _deleteFailed = true;
                            throw new Error((_delRes && _delRes.error) || 'cloud delete failed');
                        }
                    }
                    _triggerCloudDashRefresh();
                }
                await saveToIndexedDB();
            } catch (e) {
                journalData.trades = _tradesSnapshot;
                var _wbIgnored = JSON.parse(_wbIgnoredSnapshot);
                if (_wbIgnored) journalData.webullIgnoredOrders = _wbIgnored; else delete journalData.webullIgnoredOrders;
                if (_deleteFailed) {
                    var _origPrimary = _tradesSnapshot.find(function(t) { return Number(t.id) === Number(primary.id); });
                    if (_origPrimary) { try { await _saveTradeToSupabase(_origPrimary); } catch (_) { /* reload re-syncs */ } }
                    alert('Failed to save merge: ' + (e && e.message ? e.message : 'unknown error')
                        + '\nNothing was merged. Reload the page and try again.');
                    return;
                }
                alert('Failed to save merge: ' + (e && e.message ? e.message : 'unknown error')
                    + '\nYour data was not changed. Please try again.');
                return;
            }
            _dashSelectedIds.clear();
            _dashMergePickerActive = false;
            _dashMergePrimaryId = null;
            updateDashboard();
            alert('Merged ' + ids.length + ' trades into one logical trade ('
                + combinedFills.length + ' fills).');
        }

        function _dashBuildBulkActionBar(sorted) {
            if (_dashSelectedIds.size === 0) return '';

            // Resolve the selected trades (some may have been filtered
            // off the current visible list).
            var selectedIds = Array.from(_dashSelectedIds);
            var selectedTrades = selectedIds
                .map(function(id) { return journalData.trades.find(function(t) { return Number(t.id) === Number(id); }); })
                .filter(Boolean);
            var n = selectedTrades.length;

            if (_dashMergePickerActive) {
                // Picker UI: heading, explanatory sentence, radio list,
                // confirm/cancel. The whole panel is a column flex with
                // align-items:flex-start + text-align:left so every
                // child — heading, sentence, radio rows, buttons —
                // anchors cleanly to the left edge. Each candidate row
                // is an explicit start-justified flex so the radio
                // never floats to the middle of the panel.
                // Candidate rows use plain inline-flow (no flex, no
                // width:100%), so the radio input and its label text
                // sit next to each other naturally, flush to the left
                // of their block label. Inline overrides undo the
                // global `label` rule in Denarii.css that would
                // otherwise force uppercase/bold/secondary styling
                // meant for form field labels.
                var rowsHtml = selectedTrades.map(function(t) {
                    var isPrimary = t.id === _dashMergePrimaryId;
                    var entryStr = new Date(t.entryTime).toLocaleString();
                    var exitStr  = new Date(t.exitTime).toLocaleString();
                    var entryPx  = '$' + Number(t.entryPrice || 0).toFixed(2);
                    var exitPx   = '$' + Number(t.exitPrice  || 0).toFixed(2);
                    var pnlStr   = (t.pnl >= 0 ? '+' : '') + '$' + Number(t.pnl || 0).toFixed(2);
                    var label = (_displaySymbol(t.symbol) || '?') + ' · '
                        + 'QTY ' + (t.quantity || 0) + ' · '
                        + 'Entry ' + entryStr + ' @ ' + entryPx + ' · '
                        + 'Exit '  + exitStr  + ' @ ' + exitPx  + ' · '
                        + pnlStr;
                    // Radio must explicitly reset width/padding/border/
                    // background because Denarii.css has a global
                    // `input, select, textarea { width:100%; padding:10px 12px;
                    // border:1px solid var(--border); background:var(--bg-secondary); }`
                    // rule meant for text/number inputs. Without the reset,
                    // each radio renders as a full-width padded bordered box,
                    // which is what was pushing the radio into a detached
                    // middle column away from its label text.
                    return '<label style="display:block; padding:4px 0; margin:0; font-size:12px; font-weight:400; text-transform:none; letter-spacing:0; color:var(--text-primary); cursor:pointer; text-align:left;">'
                        + '<input type="radio" name="dash-merge-primary" '
                            + (isPrimary ? 'checked' : '')
                            + ' onclick="dashSetMergePrimary(' + t.id + ')"'
                            + ' style="width:auto; padding:0; border:0; background:transparent; margin:0 6px 0 0; vertical-align:middle; box-sizing:border-box;">'
                        + '<span style="vertical-align:middle;">' + escapeHtml(label) + '</span>'
                        + '</label>';
                }).join('');
                return ''
                    + '<div class="dash-bulk-bar" style="background:rgba(59, 130, 246, 0.10); border:1px solid rgba(59, 130, 246, 0.35); border-radius:6px; padding:10px 12px; margin-bottom:10px; text-align:left;">'
                        + '<div style="font-weight:600; font-size:13px; margin-bottom:6px;">Pick the primary trade to merge into:</div>'
                        + '<div style="font-size:11px; color:var(--text-secondary); margin-bottom:8px;">'
                            + 'The primary trade keeps its strategy, setup, notes, tags, and grade. The other selected trades are absorbed into the primary and will no longer appear as separate trades.'
                        + '</div>'
                        + '<div style="margin-bottom:8px;">' + rowsHtml + '</div>'
                        + '<div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-start;">'
                            + '<button type="button" class="btn btn-small btn-primary" onclick="dashConfirmMerge()">Confirm Merge</button>'
                            + '<button type="button" class="btn btn-small btn-secondary" onclick="dashCancelMergePicker()">Cancel</button>'
                        + '</div>'
                    + '</div>';
            }

            // Normal bulk action bar.
            var compat = _dashCheckMergeCompat(selectedIds);
            var canMerge = compat.ok;
            var mergeBtn = canMerge
                ? '<button type="button" class="btn btn-small btn-primary" onclick="dashStartMergePicker()">Merge Selected</button>'
                : '<button type="button" class="btn btn-small btn-secondary" disabled style="opacity:0.6; cursor:not-allowed;" title="' + escapeHtml(compat.reason) + '">Merge Selected</button>';
            var reasonLine = canMerge
                ? ''
                : '<div style="font-size:11px; color:var(--text-secondary); margin-top:6px;">' + escapeHtml(compat.reason) + '</div>';
            return ''
                + '<div class="dash-bulk-bar" style="background:rgba(59, 130, 246, 0.08); border:1px solid rgba(59, 130, 246, 0.30); border-radius:6px; padding:8px 12px; margin-bottom:10px; display:flex; flex-direction:column; gap:4px;">'
                    + '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">'
                        + '<span style="font-weight:600; font-size:13px;">' + n + ' selected</span>'
                        + '<button type="button" class="btn btn-small btn-secondary" onclick="dashClearSelection()">Clear</button>'
                        + '<span style="flex:1;"></span>'
                        + '<button type="button" class="btn btn-small btn-secondary" onclick="dashDeleteSelected()" style="color:var(--danger);">Delete Selected</button>'
                        + mergeBtn
                    + '</div>'
                    + reasonLine
                + '</div>';
        }

        // ── Shared inline day-trade drill-down renderer ─────────────────
        // Returns an HTML string for a compact inline trade list for a
        // single day. Used by Day View, Week View, and Calendar inline
        // drill-down surfaces. Filters to the current dashboard context.
        function _renderDayTradeList(dateStr) {
            var allTrades = journalData.trades || [];
            var globalFiltered = (typeof getGlobalFilteredTrades === 'function')
                ? getGlobalFilteredTrades(allTrades.slice()) : allTrades.slice();
            var trades = (typeof getDashFilteredTrades === 'function')
                ? getDashFilteredTrades(globalFiltered) : globalFiltered;

            var dayTrades = trades.filter(function (t) {
                return DenariiFilters.localDayKey(t.exitTime || t.entryTime) === dateStr;
            }).sort(function (a, b) {
                return new Date(a.exitTime || a.entryTime) - new Date(b.exitTime || b.entryTime);
            });

            if (dayTrades.length === 0) return '';

            // Sum realized P&L only from closed trades
            var netPnl = 0;
            var openCount = 0;
            dayTrades.forEach(function (t) {
                if (_isOpenTrade(t)) openCount++;
                else netPnl += (t.pnl || 0);
            });
            var pnlCls = netPnl > 0 ? 'dd-pnl-pos' : netPnl < 0 ? 'dd-pnl-neg' : '';

            // Readable date header
            var dateObj = new Date(dateStr + 'T12:00:00');
            var dateLabel = dateObj.toLocaleDateString('en-US', {
                weekday: 'long', month: 'short', day: 'numeric', year: 'numeric'
            });
            var pnlSign = netPnl >= 0 ? '+' : '-';
            var pnlStr = pnlSign + '$' + Math.abs(netPnl).toFixed(2);
            if (openCount) pnlStr += ' (' + openCount + ' open)';

            var html = '<div class="day-drilldown">';
            html += '<div class="dd-header">';
            html += '<span class="dd-date">' + escapeHtml(dateLabel) + '</span>';
            html += '<span class="dd-summary">' + dayTrades.length + ' trade' + (dayTrades.length !== 1 ? 's' : '') +
                ' &middot; <span class="' + pnlCls + '">' + pnlStr + '</span></span>';
            html += '</div>';

            // Trade rows
            html += '<div class="dd-trades">';
            html += '<div class="dd-row dd-row-header">';
            html += '<span>Time</span><span>Symbol</span><span>Side</span><span style="text-align:right">P&L</span><span></span>';
            html += '</div>';

            dayTrades.forEach(function (t) {
                var exitD = new Date(t.exitTime || t.entryTime);
                var hh = exitD.getHours(), mm = exitD.getMinutes();
                var timeStr = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
                var open = _isOpenTrade(t);
                var pnl = open ? null : (t.pnl || 0);
                var rowPnlCls = open ? '' : (pnl > 0 ? 'dd-pnl-pos' : pnl < 0 ? 'dd-pnl-neg' : '');
                var sideLabel = t.type === 'short' ? 'Short' : 'Long';
                if ((t.assetType || 'stock') === 'option' && t.optionType) {
                    sideLabel += ' ' + t.optionType;
                }
                var pnlFmt = open ? 'Open' : ((pnl >= 0 ? '+' : '-') + '$' + Math.abs(pnl).toFixed(2));

                html += '<div class="dd-row dd-row-clickable" onclick="activateSection(\'trade-journal\');selectTradeForJournal(' + t.id + ')">';
                html += '<span>' + timeStr + '</span>';
                html += '<span class="dd-symbol">' + escapeHtml(_displaySymbol(t.symbol) || '') + '</span>';
                html += '<span>' + sideLabel + '</span>';
                html += '<span class="' + rowPnlCls + '" style="text-align:right;font-weight:600;">' + pnlFmt + '</span>';
                html += '<span class="dd-actions">';
                html += '<button class="btn btn-small btn-secondary" onclick="event.stopPropagation();openChartForTrade(' + t.id + ')">Chart</button>';
                html += '</span>';
                html += '</div>';
            });

            html += '</div>'; // .dd-trades
            html += '</div>'; // .day-drilldown
            return html;
        }

        // ── Dashboard column configuration ──────────────────────
        var _DASH_COLUMNS = [
            { key: 'select',     label: '',               sortField: null,         defaultOn: true,  locked: true },
            { key: 'exitTime',   label: 'Date',           sortField: 'exitTime',   defaultOn: true },
            { key: 'symbol',     label: 'Symbol',         sortField: 'symbol',     defaultOn: true },
            { key: 'assetType',  label: 'Type',           sortField: 'assetType',  defaultOn: true },
            { key: 'type',       label: 'Side',           sortField: 'type',       defaultOn: true },
            { key: 'quantity',   label: 'Qty',            sortField: 'quantity',   defaultOn: true },
            { key: 'entryPrice', label: 'Entry',          sortField: 'entryPrice', defaultOn: true },
            { key: 'exitPrice',  label: 'Exit',           sortField: 'exitPrice',  defaultOn: true },
            { key: 'broker',     label: 'Account',        sortField: 'broker',     defaultOn: true },
            { key: 'pnl',        label: 'P&L',            sortField: 'pnl',        defaultOn: true },
            { key: 'setupType',  label: 'Strategy',       sortField: 'setupType',  defaultOn: false },
            { key: 'fees',       label: 'Fees',           sortField: null,         defaultOn: false },
            { key: 'grade',      label: 'Trade Grade',    sortField: null,         defaultOn: false },
            { key: 'stratGrade', label: 'Strategy Grade', sortField: null,         defaultOn: false },
            { key: 'tags',       label: 'Tags',           sortField: null,         defaultOn: false },
            { key: 'actions',    label: '',               sortField: null,         defaultOn: true,  locked: true }
        ];
        var _dashVisibleCols = new Set(_DASH_COLUMNS.filter(function(c){ return c.defaultOn; }).map(function(c){ return c.key; }));

        // ── Dashboard view preference state ──────────────────────
        var _dashDefaultView = 'trades';       // 'trades' | 'calendar' | 'dayview' | 'weekview'
        var _dashRememberLastView = false;
        var _dashLastView = 'trades';
        var _dashViewPrefsLoaded = false;

        // Load saved column + view prefs — called from the init flow after db is open,
        // before the first updateDashboard() call.
        // Batch D3: columns, default view and "remember last view" are per
        // account and synced (journalData.dashPrefs → user_meta). The device
        // settings are the fallback for an account that never saved them;
        // the last view stays per device.
        async function _loadDashColPrefs() {
            var dp = (journalData && journalData.dashPrefs && typeof journalData.dashPrefs === 'object') ? journalData.dashPrefs : {};
            try {
                var saved = Array.isArray(dp.visibleCols) ? dp.visibleCols : await getSetting('dashVisibleCols');
                if (Array.isArray(saved) && saved.length > 0) {
                    _dashVisibleCols = new Set(saved);
                    _DASH_COLUMNS.forEach(function(c){ if (c.locked) _dashVisibleCols.add(c.key); });
                }
            } catch(e) { /* use defaults */ }
            // View prefs
            try {
                var dv = dp.defaultView || await getSetting('dashDefaultView');
                if (dv) _dashDefaultView = dv;
                var rl = (dp.rememberLastView === true || dp.rememberLastView === false) ? dp.rememberLastView : await getSetting('dashRememberLastView');
                if (rl === true || rl === false) _dashRememberLastView = rl;
                var lv = await getSetting('dashLastView');
                if (lv) _dashLastView = lv;
                _dashViewPrefsLoaded = true;
            } catch(e) { /* use defaults */ }
        }

        function _dashSaveColPrefs() {
            setSetting('dashVisibleCols', Array.from(_dashVisibleCols));
            _dashSaveSyncedPrefs({ visibleCols: Array.from(_dashVisibleCols) });
        }

        // Batch D3: per-account copy, saved with the journal (user_meta dashPrefs).
        function _dashSaveSyncedPrefs(patch) {
            journalData.dashPrefs = Object.assign({}, journalData.dashPrefs || {}, patch);
            saveToIndexedDB();
        }

        function _dashIsColVisible(key) {
            return _dashVisibleCols.has(key);
        }

        // Broker-account display names for the Account column (cell + sort).
        function _dashBrokerMap() {
            var map = {};
            (journalData.brokerAccounts || []).forEach(function(a) { map[a.id] = a.displayName || a.broker || ''; });
            return map;
        }

        function _dashBrokerName(t, map) {
            return map[t.brokerAccountId] || '';
        }

        // ── Dashboard preferences popup ──────────────────────────
        var _DASH_VIEW_OPTIONS = [
            { value: 'trades',   label: 'Trades' },
            { value: 'calendar', label: 'Calendar' },
            { value: 'dayview',  label: 'Day View' },
            { value: 'weekview', label: 'Week View' }
        ];

        window._dashToggleColPopup = function(evt) {
            evt.stopPropagation();
            var popup = document.getElementById('dash-col-popup');
            if (!popup) return;
            var wasOpen = popup.classList.contains('open');
            _dashCloseColPopup();
            if (wasOpen) return;

            // ── View section ──
            var html = '<div class="dash-col-popup-title">View</div>';
            html += '<div class="dash-col-popup-item" style="gap:10px;">'
                + '<span style="white-space:nowrap;font-size:13px;">Default view</span>'
                + '<select id="dash-pref-default-view" onchange="_dashSetDefaultView(this.value)" style="flex:1;min-width:0;font-size:12px;padding:4px 8px;border-radius:5px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);">';
            _DASH_VIEW_OPTIONS.forEach(function(o) {
                html += '<option value="' + o.value + '"' + (o.value === _dashDefaultView ? ' selected' : '') + '>' + o.label + '</option>';
            });
            html += '</select></div>';

            var remChecked = _dashRememberLastView ? ' checked' : '';
            html += '<label class="dash-col-popup-item" style="white-space:nowrap;">'
                + '<input type="checkbox"' + remChecked + ' onchange="_dashSetRememberLastView(this.checked)">'
                + 'Remember last view'
                + '</label>';

            // ── Columns section ──
            html += '<div class="dash-col-popup-title">Columns</div>';
            _DASH_COLUMNS.forEach(function(col) {
                if (col.locked) return;
                var checked = _dashVisibleCols.has(col.key) ? ' checked' : '';
                html += '<label class="dash-col-popup-item">'
                    + '<input type="checkbox"' + checked + ' onchange="_dashToggleCol(\'' + col.key + '\',this.checked)">'
                    + escapeHtml(col.label)
                    + '</label>';
            });
            popup.innerHTML = html;
            popup.classList.add('open');
        };

        window._dashSetDefaultView = function(val) {
            _dashDefaultView = val;
            setSetting('dashDefaultView', val);
            _dashSaveSyncedPrefs({ defaultView: val });
        };

        window._dashSetRememberLastView = function(on) {
            _dashRememberLastView = on;
            setSetting('dashRememberLastView', on);
            _dashSaveSyncedPrefs({ rememberLastView: on });
            if (on) {
                // Immediately persist the currently active dashboard tab
                var activeTab = document.querySelector('.dash-view-tab.active');
                var current = activeTab ? activeTab.getAttribute('data-dash-view') : 'trades';
                _dashLastView = current;
                setSetting('dashLastView', current);
            }
        };

        window._dashToggleCol = function(key, on) {
            if (on) { _dashVisibleCols.add(key); } else { _dashVisibleCols.delete(key); }
            // If the hidden column was the active sort, reset to default
            if (!on && _dashSortField === key) {
                _dashSortField = 'exitTime';
                _dashSortDir = 'desc';
            }
            _dashSaveColPrefs();
            updateDashboard();
        };

        function _dashCloseColPopup() {
            var popup = document.getElementById('dash-col-popup');
            if (popup) popup.classList.remove('open');
        }

        // ── Dashboard table sort state ──────────────────────────
        var _dashSortField = 'exitTime';
        var _dashSortDir   = 'desc';
        var _dashOpenMenuId = null; // trade id whose 3-dot menu is open

        // ── Cloud-primary Dashboard state (Phase 1 pagination + Phase 2 metrics)
        // For cloud_primary accounts, the Dashboard Trades table fetches
        // one page from Supabase, and top metric cards are computed from
        // a lightweight Supabase aggregate fetch across ALL matching trades.
        var _cloudDash = {
            tradesPage: [],       // current page of mapped trade objects
            totalCount: 0,        // total trades matching current filters
            page: 1,
            pageSize: 50,
            loading: false,
            generation: 0,        // race-condition guard: stale responses discarded
            _prevFilters: null,   // JSON string — detect filter changes
            _prevSort: null,      // "field:dir" — detect sort changes
            // Phase 2: aggregate metrics from Supabase
            metrics: {
                totalTrades: 0, closedTrades: 0, totalPnl: 0,
                winCount: 0, lossCount: 0, winRate: 0,
                avgWin: 0, avgLoss: 0, profitFactor: 0
            },
            metricsReady: false,  // true after first successful metrics fetch
            failed: false         // Batch D3: last page fetch failed → use the local list until online again
        };
        var _cloudDashDirty = true;        // true ⇒ next updateDashboard fetches page
        var _cloudDashMetricsDirty = true;  // true ⇒ next updateDashboard fetches metrics

        // Exposed on window so auth.js cloud-save helpers can invalidate
        // the Dashboard after trade mutations without accessing scoped vars.
        window._invalidateCloudDash = function () {
            _cloudDashDirty = true;
            _cloudDashMetricsDirty = true;
            _cloudDash.failed = false;
        };

        // Batch D3: offline, paused (cloud not loaded) or after a failed page
        // fetch, the Dashboard uses this browser's trades — the same data the
        // metric cards then use — instead of an empty cloud page.
        function _cloudDashActive() {
            return window._denariiStorageMode === 'cloud_primary'
                && typeof SupabaseAuth !== 'undefined'
                && SupabaseAuth.isReady()
                && !(typeof _cloudPaused !== 'undefined' && _cloudPaused)
                && !(typeof navigator !== 'undefined' && navigator.onLine === false)
                && !_cloudDash.failed;
        }

        window.addEventListener('online', function () {
            window._invalidateCloudDash();
            if (document.getElementById('app-container') && document.getElementById('app-container').classList.contains('active')) updateDashboard();
        });
        window.addEventListener('offline', function () {
            if (document.getElementById('app-container') && document.getElementById('app-container').classList.contains('active')) updateDashboard();
        });

        // Build a filters object from current Dashboard DOM state.
        // Mirrors getDashFilteredTrades() logic but produces a
        // declarative object for the Supabase query.
        function _cloudDashGetFilters() {
            var f = {};
            f.brokerAccountId = window.filterBrokerAccountId || 'all';

            var now = new Date();
            var todayStr = _localDateStr(now);

            if (_dashPeriod === 'today') {
                f.dateFrom = todayStr; f.dateTo = todayStr;
            } else if (_dashPeriod === 'week') {
                var ws = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
                var we = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 6);
                f.dateFrom = _localDateStr(ws); f.dateTo = _localDateStr(we);
            } else if (_dashPeriod === 'month') {
                f.dateFrom = now.getFullYear() + '-' + (now.getMonth() + 1 < 10 ? '0' : '') + (now.getMonth() + 1) + '-01';
                f.dateTo = _localDateStr(new Date(now.getFullYear(), now.getMonth() + 1, 0));
            } else if (_dashPeriod === 'ytd') {
                f.dateFrom = now.getFullYear() + '-01-01'; f.dateTo = todayStr;
            } else if (_dashPeriod === 'custom') {
                f.dateFrom = (document.getElementById('dash-from') || {}).value || null;
                f.dateTo   = (document.getElementById('dash-to')   || {}).value || null;
            }
            // 'all' ⇒ no date filter (dateFrom/dateTo stay undefined)

            var styleVal = (document.getElementById('dash-style') || {}).value || 'all';
            if (styleVal !== 'all') {
                f.styledBrokerAccountIds = (journalData.brokerAccounts || [])
                    .filter(function(a) { return a.tradingStyle === styleVal; })
                    .map(function(a) { return String(a.id); });
            }

            f.assetType = (document.getElementById('dash-asset-type') || {}).value || 'all';
            f.strategy  = (document.getElementById('dash-strategy') || {}).value || 'all';
            f.symbol    = ((document.getElementById('dash-symbol') || {}).value || '').toUpperCase() || null;

            // Visible broker inclusion — when "All Accounts" is selected,
            // collect IDs of visible brokers so the Supabase query only
            // returns their trades. This excludes both hidden brokers AND
            // deleted/orphaned broker trades that remain in Supabase.
            if (f.brokerAccountId === 'all') {
                var _allBrokers = journalData.brokerAccounts || [];
                var _vIds = _allBrokers
                    .filter(function (a) { return a.visible !== false; })
                    .map(function (a) { return a.id; });
                // Only set when the user has broker accounts — if zero
                // brokers exist, leave unfiltered for legacy accounts.
                if (_allBrokers.length > 0) f.visibleBrokerAccountIds = _vIds;
            }

            return f;
        }

        // Async: fetch page + optionally metrics from Supabase, then re-render.
        // Reads _cloudDashMetricsDirty to decide whether to include the
        // aggregate metrics fetch. Page fetch always runs.
        async function _cloudDashFetchAndRender() {
            if (!_cloudDashActive()) return;
            var gen = ++_cloudDash.generation;
            _cloudDash.loading = true;

            // Capture and clear metrics-dirty before any async work
            var fetchMetrics = _cloudDashMetricsDirty;
            _cloudDashMetricsDirty = false;

            // Show immediate loading state in the table
            var el = document.getElementById('recent-trades');
            if (el) {
                el.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:40px;">Loading trades\u2026</p>';
            }

            var client = SupabaseAuth.getClient();
            var userId = window._denariiSupabaseUid;
            if (!client || !userId) {
                console.warn('[CloudDash] No Supabase client or userId — skipping fetch.');
                _cloudDash.loading = false;
                return;
            }

            var filters = _cloudDashGetFilters();
            var sort = { field: _dashSortField, dir: _dashSortDir };

            // Fetch page rows + optionally aggregate metrics in parallel
            var promises = [
                _fetchCloudDashPage(client, userId, filters, sort, _cloudDash.page, _cloudDash.pageSize)
            ];
            if (fetchMetrics) {
                promises.push(_fetchCloudDashMetrics(client, userId, filters));
            }

            var results = await Promise.all(promises);

            // Stale-response guard
            if (gen !== _cloudDash.generation) return;

            _cloudDash.loading = false;

            // Apply page results
            var pageResult = results[0];
            if (!pageResult.error) {
                _cloudDash.tradesPage = pageResult.rows;
                _cloudDash.totalCount = pageResult.totalCount;
            } else {
                console.warn('[CloudDash] Page fetch failed — rendering from cache.');
                _cloudDash.failed = true;
            }

            // Apply metrics results (Phase 2)
            if (fetchMetrics && results[1]) {
                if (!results[1].error) {
                    _cloudDash.metrics = results[1];
                    _cloudDash.metricsReady = true;
                } else {
                    console.warn('[CloudDash] Metrics fetch failed — keeping previous metrics.');
                }
            }

            // Re-render dashboard; dirty flags are already clear so
            // this won't trigger another fetch.
            updateDashboard();
        }

        // ── Cloud pagination controls ───────────────────────────────
        window._cloudDashPrevPage = function () {
            if (_cloudDash.page > 1) {
                _cloudDash.page--;
                _cloudDashDirty = true;
                updateDashboard();
            }
        };
        window._cloudDashNextPage = function () {
            var totalPages = Math.max(1, Math.ceil(_cloudDash.totalCount / _cloudDash.pageSize));
            if (_cloudDash.page < totalPages) {
                _cloudDash.page++;
                _cloudDashDirty = true;
                updateDashboard();
            }
        };

        window._dashSetSort = function (field) {
            if (_dashSortField === field) {
                _dashSortDir = _dashSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                _dashSortField = field;
                _dashSortDir = (field === 'symbol' || field === 'assetType' || field === 'type' || field === 'setupType') ? 'asc' : 'desc';
            }
            // Cloud: reset to page 1 on sort change (dirty set below via filter detection)
            if (_cloudDashActive()) { _cloudDash.page = 1; _cloudDashDirty = true; }
            updateDashboard();
        };

        window._dashToggleMenu = function (tradeId, evt) {
            evt.stopPropagation();
            var wasOpen = _dashOpenMenuId === tradeId;
            _dashCloseMenu();
            if (wasOpen) return;
            _dashOpenMenuId = tradeId;
            var menu = document.getElementById('dt-menu-' + tradeId);
            if (!menu) return;
            var btn = evt.currentTarget;
            var rect = btn.getBoundingClientRect();
            menu.classList.add('dt-menu-open');
            var menuH = menu.offsetHeight || 120;
            var spaceBelow = window.innerHeight - rect.bottom;
            if (spaceBelow < menuH + 8) {
                menu.style.top = (rect.top - menuH - 4) + 'px';
            } else {
                menu.style.top = (rect.bottom + 4) + 'px';
            }
            menu.style.right = (window.innerWidth - rect.right) + 'px';
            menu.style.left = '';
        };

        function _dashCloseMenu() {
            if (_dashOpenMenuId !== null) {
                var prev = document.getElementById('dt-menu-' + _dashOpenMenuId);
                if (prev) {
                    prev.classList.remove('dt-menu-open');
                    prev.style.top = '';
                    prev.style.right = '';
                }
                _dashOpenMenuId = null;
            }
        }

        // ── New Trade dropdown menu ──────────────────────────────
        window._dashToggleNewTradeMenu = function (evt) {
            evt.stopPropagation();
            var menu = document.getElementById('dash-newtrade-menu');
            if (!menu) return;
            var wasOpen = menu.classList.contains('dt-menu-open');
            _dashCloseMenu();
            _dashCloseNewTradeMenu();
            if (!wasOpen) menu.classList.add('dt-menu-open');
        };
        function _dashCloseNewTradeMenu() {
            var menu = document.getElementById('dash-newtrade-menu');
            if (menu) menu.classList.remove('dt-menu-open');
        }

        // Close menus on any click outside
        document.addEventListener('click', function () { _dashCloseMenu(); _dashCloseNewTradeMenu(); _dashCloseColPopup(); });

        // Stat card money: sign before the $ ("-$1.00", "$2.00"), as on Account Value.
        function _dashFmtMoney(v) {
            v = Number(v) || 0;
            return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
        }

        function updateDashboard() {
            _syncDashPeriod();
            _dashCloseMenu();

            // ── Cloud-primary: detect filter/sort changes ──
            // Filter changes trigger both page + metrics refresh.
            // Sort changes trigger only page refresh (metrics are sort-independent).
            // Page changes (prev/next) set _cloudDashDirty externally.
            var _isCloudDash = _cloudDashActive();
            if (_isCloudDash) {
                var _cdFilters = JSON.stringify(_cloudDashGetFilters());
                var _cdSort = _dashSortField + ':' + _dashSortDir;
                if (_cdFilters !== _cloudDash._prevFilters) {
                    _cloudDash.page = 1;
                    _cloudDashDirty = true;
                    _cloudDashMetricsDirty = true;
                    _cloudDash._prevFilters = _cdFilters;
                }
                if (_cdSort !== _cloudDash._prevSort) {
                    _cloudDash.page = 1;
                    _cloudDashDirty = true;
                    _cloudDash._prevSort = _cdSort;
                }
                // Trigger async fetch if page or metrics need refreshing
                if ((_cloudDashDirty || _cloudDashMetricsDirty) && !_cloudDash.loading) {
                    _cloudDashDirty = false;
                    _cloudDashFetchAndRender();
                }
            }

            _dashSyncSelectionViewKey(_isCloudDash);

            // Sanitize bulk-selection state: drop any id that is no
            // longer present in journalData.trades (deleted, merged
            // away, etc.) or whose broker account is hidden.
            if (_dashSelectedIds.size > 0) {
                _dashPruneSelection();
                if (_dashSelectedIds.size === 0) {
                    _dashMergePickerActive = false;
                    _dashMergePrimaryId = null;
                }
            }

            _populateDashStrategies();
            DenariiFilters.syncDates('dash');

            // ── Metrics ──────────────────────────────────────────────
            // Local path: computed from journalData.trades (unchanged).
            // Cloud path: overridden with Supabase aggregate metrics
            // once available, so metric cards reflect ALL matching
            // trades across the full Supabase dataset.
            const allTrades = journalData.trades || [];
            const globalFiltered = window.getGlobalFilteredTrades?.(allTrades) ?? allTrades;
            const trades = getDashFilteredTrades(globalFiltered);

            // Local metrics (also used as fallback before cloud metrics arrive)
            const closedTrades = trades.filter(t => !_isOpenTrade(t));
            const totalPnL = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
            const winners = closedTrades.filter(t => (t.pnl || 0) > 0);
            const losers = closedTrades.filter(t => (t.pnl || 0) < 0);
            const winRate = closedTrades.length > 0 ? (winners.length / closedTrades.length * 100).toFixed(1) : 0;
            const avgWin = winners.length > 0 ? winners.reduce((sum, t) => sum + t.pnl, 0) / winners.length : 0;
            const avgLoss = losers.length > 0 ? losers.reduce((sum, t) => sum + t.pnl, 0) / losers.length : 0;
            const profitFactor = _grossProfitFactor(winners, losers);

            // ── Cloud metric override (Phase 2) ──
            // When Supabase aggregate metrics are available, use them
            // instead of the locally-computed values above.
            var _mTotalTrades = trades.length;
            var _mWinCount    = winners.length;
            var _mLossCount   = losers.length;
            var _mTotalPnL    = totalPnL;
            var _mWinRate     = winRate;
            var _mAvgWin      = avgWin;
            var _mAvgLoss     = avgLoss;
            var _mProfitFactor = profitFactor;

            if (_isCloudDash && _cloudDash.metricsReady) {
                var _cm = _cloudDash.metrics;
                _mTotalTrades  = _cm.totalTrades;
                _mWinCount     = _cm.winCount;
                _mLossCount    = _cm.lossCount;
                _mTotalPnL     = _cm.totalPnl;
                _mWinRate      = _cm.closedTrades > 0 ? (_cm.winCount / _cm.closedTrades * 100).toFixed(1) : 0;
                _mAvgWin       = _cm.avgWin;
                _mAvgLoss      = _cm.avgLoss;
                _mProfitFactor = _cm.profitFactor;
            }

            // Account Value card — practical account-value summary.
            // Reuses getAccountCashSummary() (broker-accounts.js) so the
            // formula stays in one place. Per-account rule (applied
            // uniformly regardless of whether openingBalanceDate is
            // set, so older closed-trade P&L is never excluded):
            //     openingBalance + netCashFlow + realizedPnlAllTime
            // When the global account filter is "all" (or unset), sum
            // the per-account value across every visible (non-hidden)
            // broker account so the Dashboard shows a true aggregate
            // instead of asking the user to select one.
            const _dashAcctId = window.filterBrokerAccountId;
            const _accountValueFor = function (acctId) {
                if (typeof getAccountCashSummary !== 'function') return null;
                const s = getAccountCashSummary(acctId);
                if (!s) return null;
                return (Number(s.openingBalance)         || 0)
                     + (Number(s.netCashFlow)            || 0)
                     + (Number(s.realizedPnlAllTime)     || 0)
                     - (Number(s.accruedRecurringFees)   || 0);
            };
            let _accountValueNumber = null;
            if (!_dashAcctId || _dashAcctId === 'all') {
                // Aggregate across visible (non-archived) broker accounts.
                const _allAccts = (journalData && Array.isArray(journalData.brokerAccounts))
                    ? journalData.brokerAccounts
                    : [];
                const _visibleAccts = _allAccts.filter(a => a && a.visible !== false);
                if (_visibleAccts.length > 0) {
                    _accountValueNumber = 0;
                    for (let _i = 0; _i < _visibleAccts.length; _i++) {
                        const _v = _accountValueFor(_visibleAccts[_i].id);
                        if (typeof _v === 'number' && isFinite(_v)) _accountValueNumber += _v;
                    }
                }
            } else {
                const _v = _accountValueFor(_dashAcctId);
                if (typeof _v === 'number' && isFinite(_v)) _accountValueNumber = _v;
            }
            let _accountValueValueHtml;
            if (_accountValueNumber == null) {
                _accountValueValueHtml = '<div class="stat-value neutral" style="font-size:15px;color:var(--text-secondary);">No account data</div>';
            } else {
                const _cav = _accountValueNumber;
                const _cavClass = _cav >= 0 ? 'positive' : 'negative';
                const _cavStr   = (_cav < 0 ? '-$' : '$') + Math.abs(_cav).toFixed(2);
                _accountValueValueHtml = '<div class="stat-value ' + _cavClass + '">' + _cavStr + '</div>';
            }

            document.getElementById('dashboard-stats').innerHTML = `
                <div class="stat-card">
                    <div class="stat-label">Total Trades</div>
                    <div class="stat-value neutral">${_mTotalTrades}</div>
                    <div class="stat-subtitle">${_mWinCount}W / ${_mLossCount}L</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Total P&L</div>
                    <div class="stat-value ${_mTotalPnL >= 0 ? 'positive' : 'negative'}">${_dashFmtMoney(_mTotalPnL)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Win Rate</div>
                    <div class="stat-value ${_mWinRate >= 50 ? 'positive' : 'negative'}">${_mWinRate}%</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Profit Factor</div>
                    <div class="stat-value ${_mProfitFactor >= 2 ? 'positive' : _mProfitFactor >= 1 ? 'neutral' : 'negative'}">${isFinite(_mProfitFactor) ? _mProfitFactor.toFixed(2) : '∞'}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Avg Win</div>
                    <div class="stat-value positive">${_dashFmtMoney(_mAvgWin)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Avg Loss</div>
                    <div class="stat-value negative">${_dashFmtMoney(_mAvgLoss)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Account Value</div>
                    ${_accountValueValueHtml}
                </div>
            `;

            // ── Cloud loading state: show spinner while fetch is in flight ──
            if (_isCloudDash && _cloudDash.loading) {
                document.getElementById('recent-trades').innerHTML =
                    '<p style="text-align:center;color:var(--text-secondary);padding:40px;">Loading trades\u2026</p>';
                _dashVisibleIds = [];
                _dashVisibleTrades = [];
                _dashRefreshSelectAllMaster();
                if (typeof window._calendarRefresh === 'function') window._calendarRefresh();
                if (typeof window._dayViewRefresh === 'function') window._dayViewRefresh();
                if (typeof window._weekViewRefresh === 'function') window._weekViewRefresh();
                return;
            }

            // ── Empty state (local only — cloud uses totalCount) ──
            if (!_isCloudDash && trades.length === 0) {
                document.getElementById('recent-trades').innerHTML = allTrades.length === 0
                    ? `<p style="text-align:center;color:var(--text-secondary);padding:40px;">No trades yet. Add a trade manually or import from CSV to get started.</p>`
                    : `<p style="text-align:center;color:var(--text-secondary);padding:40px;">No trades match the current filter.</p>`;
                _dashVisibleIds = [];
                _dashVisibleTrades = [];
                _dashRefreshSelectAllMaster();
                return;
            }

            // ── Sort / data source ──
            var _sf = _dashSortField, _sd = _dashSortDir;
            var sorted;
            if (_isCloudDash) {
                // Cloud: trades are pre-sorted server-side
                sorted = _cloudDash.tradesPage;
            } else {
                // Local: client-side sort of full filtered array
                var _sortBrokerMap = _sf === 'broker' ? _dashBrokerMap() : null;
                sorted = [...trades].sort(function (a, b) {
                    var va, vb;
                    switch (_sf) {
                        case 'symbol':    va = (a.symbol||'').toLowerCase(); vb = (b.symbol||'').toLowerCase(); return _sd === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
                        case 'assetType': va = getAssetType(a); vb = getAssetType(b); return _sd === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
                        case 'type':      va = (a.type||a.direction||''); vb = (b.type||b.direction||''); return _sd === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
                        case 'setupType': va = (a.setupType||'').toLowerCase(); vb = (b.setupType||'').toLowerCase(); return _sd === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
                        case 'broker':    va = _dashBrokerName(a, _sortBrokerMap).toLowerCase(); vb = _dashBrokerName(b, _sortBrokerMap).toLowerCase(); return _sd === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
                        case 'quantity':  va = a.quantity||0; vb = b.quantity||0; break;
                        case 'entryPrice':va = a.entryPrice||0; vb = b.entryPrice||0; break;
                        case 'exitPrice': va = a.exitPrice||0; vb = b.exitPrice||0; break;
                        case 'pnl':       va = a.pnl||0; vb = b.pnl||0; break;
                        case 'exitTime':  va = new Date(a.exitTime||a.entryTime); vb = new Date(b.exitTime||b.entryTime); break;
                        default:          va = new Date(a.exitTime||a.entryTime); vb = new Date(b.exitTime||b.entryTime);
                    }
                    return _sd === 'asc' ? va - vb : vb - va;
                });
            }

            // Track the currently visible (filtered+sorted) trade ids so
            // the master "Select all visible" checkbox only affects these.
            _dashVisibleIds = sorted.map(function(t) { return Number(t.id); });
            _dashVisibleTrades = sorted;

            var _dashBulkBarHtml = _dashBuildBulkActionBar(sorted);

            // ── Sort arrow helper ──
            function _thHtml(label, field) {
                var cls = _sf === field ? ' dt-sort-active' : '';
                var arrow = _sf === field ? (_sd === 'asc' ? '&#9650;' : '&#9660;') : '&#8597;';
                return '<th class="' + cls + '" onclick="_dashSetSort(\'' + field + '\')">' + label + ' <span class="dt-sort-arrow">' + arrow + '</span></th>';
            }

            if (sorted.length === 0) {
                document.getElementById('recent-trades').innerHTML =
                    '<p style="text-align:center;color:var(--text-secondary);padding:40px;">No trades match the current filter.</p>';
            } else {
                // Build broker-account lookup for Account column
                var _brokerMap = _dashBrokerMap();

                var tbl = _dashBulkBarHtml;
                tbl += '<div class="dash-table-wrap"><table class="dash-table"><thead><tr>';

                // ── Column-driven header ──
                _DASH_COLUMNS.forEach(function(col) {
                    if (!_dashIsColVisible(col.key)) return;
                    if (col.key === 'select') {
                        tbl += '<th class="dt-no-sort" style="width:36px;padding-left:14px;"><input type="checkbox" id="dash-select-all-tbl" onclick="dashToggleSelectAllVisible(this.checked)" style="width:15px;height:15px;cursor:pointer;"></th>';
                    } else if (col.key === 'actions') {
                        tbl += '<th class="dt-no-sort" style="width:40px;"></th>';
                    } else if (col.sortField) {
                        tbl += _thHtml(col.label, col.sortField);
                    } else {
                        tbl += '<th class="dt-no-sort">' + escapeHtml(col.label) + '</th>';
                    }
                });

                tbl += '</tr></thead><tbody>';

                // ── Column-driven rows ──
                sorted.forEach(function (t) {
                    var isSelected = _dashSelectedIds.has(Number(t.id));
                    var rowStyle = ' style="cursor:pointer;' + (isSelected ? 'background:rgba(59,130,246,0.06);' : '') + '"';
                    var open = _isOpenTrade(t);

                    tbl += '<tr' + rowStyle + ' onclick="_dashRowClick(event, ' + t.id + ')">';

                    _DASH_COLUMNS.forEach(function(col) {
                        if (!_dashIsColVisible(col.key)) return;
                        switch (col.key) {
                            case 'select':
                                tbl += '<td style="padding-left:14px;"><input type="checkbox" class="dash-trade-check" ' + (isSelected ? 'checked' : '') + ' onclick="dashToggleTradeSelection(' + t.id + ')" style="width:15px;height:15px;cursor:pointer;"></td>';
                                break;
                            case 'exitTime':
                                tbl += '<td>' + escapeHtml(new Date(t.exitTime || t.entryTime).toLocaleDateString()) + '</td>';
                                break;
                            case 'symbol':
                                tbl += '<td class="dt-sym">' + escapeHtml(_displaySymbol(t.symbol) || '') + '</td>';
                                break;
                            case 'assetType':
                                tbl += '<td><span class="asset-badge ' + getAssetType(t) + '">' + getAssetTypeLabel(t) + '</span></td>';
                                break;
                            case 'type':
                                // Cloud page rows (_mapSupabaseTradeRow) carry direction, not type.
                                tbl += '<td>' + ((t.type || t.direction) === 'long' ? 'Long' : 'Short') + '</td>';
                                break;
                            case 'quantity':
                                tbl += '<td>' + (t.quantity || '') + '</td>';
                                break;
                            case 'entryPrice':
                                tbl += '<td>$' + (t.entryPrice != null ? t.entryPrice.toFixed(2) : '') + '</td>';
                                break;
                            case 'exitPrice':
                                var exitCell = open
                                    ? '<span style="color:var(--primary);font-weight:600;">Open</span>'
                                    : '$' + (t.exitPrice != null ? t.exitPrice.toFixed(2) : '');
                                tbl += '<td>' + exitCell + '</td>';
                                break;
                            case 'pnl':
                                var pnlCls = open ? '' : (t.pnl >= 0 ? 'profit' : 'loss');
                                var pnlStr = open ? '\u2014' : ((t.pnl >= 0 ? '+' : '-') + '$' + Math.abs(t.pnl).toFixed(2));
                                tbl += '<td class="dt-pnl trade-pnl ' + pnlCls + '">' + pnlStr + '</td>';
                                break;
                            case 'setupType':
                                tbl += '<td>' + escapeHtml(t.setupType || '') + '</td>';
                                break;
                            case 'fees':
                                var feeVal = t.commissionFees != null ? '$' + Number(t.commissionFees).toFixed(2) : '';
                                tbl += '<td>' + feeVal + '</td>';
                                break;
                            case 'broker':
                                tbl += '<td>' + escapeHtml(_dashBrokerName(t, _brokerMap)) + '</td>';
                                break;
                            case 'grade':
                                tbl += '<td>' + escapeHtml(t.tradeGrade || '') + '</td>';
                                break;
                            case 'stratGrade':
                                var sg = (t.strategyScore && t.strategyScore.grade) ? t.strategyScore.grade : '';
                                tbl += '<td>' + escapeHtml(sg) + '</td>';
                                break;
                            case 'tags':
                                var tagHtml = '';
                                if (Array.isArray(t.tags) && t.tags.length > 0) {
                                    tagHtml = '<div class="dt-tags-cell">';
                                    var maxShow = 3;
                                    for (var ti = 0; ti < Math.min(t.tags.length, maxShow); ti++) {
                                        tagHtml += '<span class="dt-tag-pill">' + escapeHtml(t.tags[ti].text || t.tags[ti].name || '') + '</span>';
                                    }
                                    if (t.tags.length > maxShow) tagHtml += '<span class="dt-tag-pill">+' + (t.tags.length - maxShow) + '</span>';
                                    tagHtml += '</div>';
                                }
                                tbl += '<td>' + tagHtml + '</td>';
                                break;
                            case 'actions':
                                tbl += '<td class="dt-actions-cell">';
                                tbl += '<button class="dt-dots-btn" onclick="_dashToggleMenu(' + t.id + ',event)">&#8942;</button>';
                                tbl += '<div class="dt-menu" id="dt-menu-' + t.id + '">';
                                if (open) {
                                    tbl += '<button class="dt-menu-item" onclick="openCloseTrade(' + t.id + ')">Close Trade</button>';
                                }
                                tbl += '<button class="dt-menu-item" onclick="openTradeInReflection(' + t.id + ')">' + (open ? 'Edit' : 'Edit / Reflect') + '</button>';
                                tbl += '<button class="dt-menu-item" onclick="openChartForTrade(' + t.id + ')">Chart</button>';
                                tbl += '<button class="dt-menu-item dt-menu-item--danger" onclick="deleteTrade(' + t.id + ')">Delete</button>';
                                tbl += '</div></td>';
                                break;
                        }
                    });

                    tbl += '</tr>';
                });

                tbl += '</tbody></table></div>';

                // ── Cloud pagination controls ──
                if (_isCloudDash) {
                    var _cpTotalPages = Math.max(1, Math.ceil(_cloudDash.totalCount / _cloudDash.pageSize));
                    var _cpPrevDis = _cloudDash.page <= 1;
                    var _cpNextDis = _cloudDash.page >= _cpTotalPages;
                    tbl += '<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:12px 0;font-size:13px;color:var(--text-secondary);">';
                    tbl += '<button onclick="_cloudDashPrevPage()"' + (_cpPrevDis ? ' disabled' : '') + ' style="padding:4px 12px;border-radius:5px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);cursor:' + (_cpPrevDis ? 'default' : 'pointer') + ';opacity:' + (_cpPrevDis ? '0.4' : '1') + ';">Previous</button>';
                    tbl += '<span>Page ' + _cloudDash.page + ' of ' + _cpTotalPages + ' \u00B7 ' + _cloudDash.totalCount + ' trades</span>';
                    tbl += '<button onclick="_cloudDashNextPage()"' + (_cpNextDis ? ' disabled' : '') + ' style="padding:4px 12px;border-radius:5px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);cursor:' + (_cpNextDis ? 'default' : 'pointer') + ';opacity:' + (_cpNextDis ? '0.4' : '1') + ';">Next</button>';
                    tbl += '</div>';
                }

                document.getElementById('recent-trades').innerHTML = tbl;
            }

            // Keep the master "Select all visible" checkbox's checked /
            // indeterminate state consistent with the rendered list.
            _dashRefreshSelectAllMaster();

            // Refresh calendar / day view / week view if their tab is visible
            if (typeof window._calendarRefresh === 'function') window._calendarRefresh();
            if (typeof window._dayViewRefresh === 'function') window._dayViewRefresh();
            if (typeof window._weekViewRefresh === 'function') window._weekViewRefresh();
        }

        // ── Analysis helper functions live in js/pages/analytics-helpers.js ──


        // New Trade entry/exit times start blank; only the user fills them.
        const now = new Date();
        now.setMinutes(now.getMinutes() - now.getTimezoneOffset());

        // ── PROFILE POPUP ──
        function toggleProfilePopup() {
            const popup = document.getElementById('profile-popup');
            const overlay = document.getElementById('profile-popup-overlay');
            const isActive = popup.classList.contains('active');
            if (isActive) {
                closeProfilePopup();
            } else {
                popup.classList.add('active');
                overlay.classList.add('active');
            }
        }
        function closeProfilePopup() {
            document.getElementById('profile-popup').classList.remove('active');
            document.getElementById('profile-popup-overlay').classList.remove('active');
            document.getElementById('theme-submenu').classList.remove('active');
        }
        // Close popup on Escape
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') closeProfilePopup();
        });

        // ── HERO MESSAGE SYSTEM ──
        const heroMessages = [
            {
                title: "Master the process. The results will follow.",
                body: "The market tests more than your strategy—it tests your patience, discipline, and mindset. Journaling turns experience into awareness, and awareness into control."
            },
            {
                title: "Become the trader you trust.",
                body: "Every trade is a reflection of your decisions. Journaling helps you see them clearly—and improve them deliberately."
            },
            {
                title: "Clarity creates confidence.",
                body: "When you understand your trades, hesitation fades. Journaling turns uncertainty into structure."
            },
            {
                title: "Execution reveals everything.",
                body: "Your entries, exits, and mistakes all tell a story. Journaling is how you learn to read it."
            },
            {
                title: "Progress lives in the review.",
                body: "Most traders move on. The best traders look back—and learn."
            },
            {
                title: "Awareness precedes improvement.",
                body: "If you can't see your patterns, you can't change them. Journaling makes them visible."
            },
            {
                title: "Trade with intention.",
                body: "Random trades create random results. A defined process creates consistency."
            }
        ];

        let lastHeroMessage = null;

        function getRandomHeroMessage() {
            const pool = lastHeroMessage
                ? heroMessages.filter(m => m !== lastHeroMessage)
                : heroMessages;
            return pool[Math.floor(Math.random() * pool.length)];
        }

        function initHero() {
            lastHeroMessage = getRandomHeroMessage();
            const titleEl = document.getElementById('hero-title');
            const copyEl  = document.getElementById('hero-copy');
            if (titleEl) titleEl.textContent = lastHeroMessage.title;
            if (copyEl)  copyEl.textContent  = lastHeroMessage.body;
        }

        function refreshHero() {
            lastHeroMessage = getRandomHeroMessage();
            const titleEl = document.getElementById('hero-title');
            const copyEl = document.getElementById('hero-copy');
            if (titleEl) titleEl.textContent = lastHeroMessage.title;
            if (copyEl) copyEl.textContent = lastHeroMessage.body;
        }

        // ── App settings helpers — used by AI service layer ──────────────────
        window.getAppSetting    = getSetting;
        window.setAppSetting    = setSetting;
        window.deleteAppSetting = function(key) { return storeDelete(SETTINGS_STORE, key); };

