/**
 * editor-toolbar.js — Shared rich-text editor toolbar builder.
 *
 * Canonical toolbar layout used by Reflection, Weekly Planner, and
 * any future contenteditable editor surface.  Produces HTML that uses
 * the rv-toolbar / rv-tb-btn CSS class family.
 *
 * Usage:
 *   var html = EditorToolbar.build(editorId, { templates: false });
 *   container.innerHTML = html + '<div class="rv-editor" id="myEditor" contenteditable="true" spellcheck="true"></div>';
 *
 * Exposed as window.EditorToolbar.
 */
(function (global) {
    'use strict';

    // ── Selection save / restore (editor-aware) ─────────────────────────────
    var _savedRanges = {};  // keyed by editorId

    function saveSel(editorId) {
        var sel = window.getSelection();
        var ed  = document.getElementById(editorId);
        if (sel && sel.rangeCount && ed && ed.contains(sel.getRangeAt(0).commonAncestorContainer)) {
            _savedRanges[editorId] = sel.getRangeAt(0).cloneRange();
        }
    }

    function restoreSel(editorId) {
        var ed = document.getElementById(editorId);
        if (!ed) return;
        var range = _savedRanges[editorId];
        if (!range) { ed.focus(); return; }
        ed.focus();
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    // ── Formatting helpers ───────────────────────────────────────────────────
    function applyFore(color, editorId) {
        restoreSel(editorId);
        document.execCommand('foreColor', false, color);
        var lbl = document.getElementById('et-fore-' + editorId);
        if (lbl) lbl.style.color = color;
    }

    function applyHilite(color, editorId) {
        restoreSel(editorId);
        document.execCommand('hiliteColor', false, color) ||
        document.execCommand('backColor', false, color);
    }

    async function insertLink(editorId) {
        saveSel(editorId); // capture selection before the prompt modal takes focus
        var url = await window.showPromptModal({ message: 'Enter URL:', defaultValue: 'https://' });
        if (url && url.trim() && url.trim() !== 'https://') {
            restoreSel(editorId);
            document.execCommand('createLink', false, url.trim());
        }
    }

    // ── Emoji picker ─────────────────────────────────────────────────────────
    var EMOJI_SET = [
        '🎯','🚀','💰','📈','📉','⚠️','🔥','💎','🧠','👀',
        '✅','❌','⏸️','🔴','🟢','🟡','💡','📌','🏆','💪',
        '😤','😎','🤔','😰','🫡','🎲','📊','⚡','🛑','🔔'
    ];

    function toggleEmojiPicker(editorId) {
        var existing = document.getElementById('et-emoji-' + editorId);
        if (existing) { existing.remove(); return; }

        // Close any other open pickers
        document.querySelectorAll('.et-emoji-picker').forEach(function(p) { p.remove(); });

        var btn = document.querySelector('[data-emoji-for="' + editorId + '"]');
        if (!btn) return;
        saveSel(editorId);

        var picker = document.createElement('div');
        picker.id = 'et-emoji-' + editorId;
        picker.className = 'et-emoji-picker';
        picker.innerHTML = EMOJI_SET.map(function(e) {
            return '<button type="button" class="et-emoji-btn" onmousedown="event.preventDefault()" ' +
                'onclick="EditorToolbar.insertEmoji(\'' + editorId + '\',\'' + e + '\')">' + e + '</button>';
        }).join('');
        btn.parentElement.style.position = 'relative';
        btn.parentElement.appendChild(picker);

        setTimeout(function() {
            document.addEventListener('click', function closePicker(ev) {
                if (!picker.contains(ev.target) && ev.target !== btn) {
                    picker.remove();
                    document.removeEventListener('click', closePicker);
                }
            });
        }, 30);
    }

    function insertEmoji(editorId, emoji) {
        restoreSel(editorId);
        // insertText is unreliable on Safari; fall back to insertHTML
        if (!document.execCommand('insertText', false, emoji)) {
            document.execCommand('insertHTML', false, emoji);
        }
        var picker = document.getElementById('et-emoji-' + editorId);
        if (picker) picker.remove();
    }

    // ── Speech-to-text ───────────────────────────────────────────────────────
    var _sttInstances = {};

    var STT_DESKTOP_TIP = 'To dictate, click in the editor and press Windows key + H. The first time, click the microphone in the Windows voice typing box.';

    // Speech recognition isn't usable in the desktop app, so the button shows
    // the Windows voice typing shortcut instead.
    function _showSttTip(editorId) {
        var existing = document.getElementById('et-stt-tip-' + editorId);
        if (existing) { existing.remove(); return; }
        var btn = document.querySelector('[data-stt-for="' + editorId + '"]');
        if (!btn) return;
        var tip = document.createElement('div');
        tip.id = 'et-stt-tip-' + editorId;
        tip.className = 'et-stt-tip';
        tip.setAttribute('role', 'status');
        tip.textContent = STT_DESKTOP_TIP;
        btn.parentElement.style.position = 'relative';
        btn.parentElement.appendChild(tip);

        var timer = setTimeout(close, 8000);
        function close() {
            clearTimeout(timer);
            tip.remove();
            document.removeEventListener('click', onDocClick);
        }
        function onDocClick(ev) {
            if (!tip.contains(ev.target) && !btn.contains(ev.target)) close();
        }
        setTimeout(function() { document.addEventListener('click', onDocClick); }, 30);
    }

    function toggleSpeech(editorId) {
        if (window.denariiStore) {
            _showSttTip(editorId);
            return;
        }

        var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            alert("Speech-to-text isn't available on this computer.");
            return;
        }

        // Toggle off
        if (_sttInstances[editorId]) {
            _sttInstances[editorId].stop();
            _sttInstances[editorId] = null;
            _setSttActive(editorId, false);
            return;
        }

        var recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = false;
        recognition.lang = navigator.language || 'en-US';

        recognition.onresult = function(event) {
            var transcript = '';
            for (var i = event.resultIndex; i < event.results.length; i++) {
                if (event.results[i].isFinal) {
                    transcript += event.results[i][0].transcript;
                }
            }
            if (transcript) {
                var ed = document.getElementById(editorId);
                if (ed) {
                    ed.focus();
                    // insertText is unreliable on Safari; fall back to insertHTML
                    if (!document.execCommand('insertText', false, transcript)) {
                        document.execCommand('insertHTML', false, transcript.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
                    }
                }
            }
        };

        recognition.onerror = function() {
            _sttInstances[editorId] = null;
            _setSttActive(editorId, false);
        };

        recognition.onend = function() {
            _sttInstances[editorId] = null;
            _setSttActive(editorId, false);
        };

        _sttInstances[editorId] = recognition;
        _setSttActive(editorId, true);
        try {
            recognition.start();
        } catch (e) {
            _sttInstances[editorId] = null;
            _setSttActive(editorId, false);
        }
    }

    function _setSttActive(editorId, active) {
        var btn = document.querySelector('[data-stt-for="' + editorId + '"]');
        if (btn) {
            btn.classList.toggle('rv-tb-stt-active', active);
            var label = active ? 'Stop dictation' : 'Dictate (speech to text)';
            btn.title = label;
            btn.setAttribute('aria-label', label);
        }
    }

    // ── Build toolbar HTML ───────────────────────────────────────────────────
    /**
     * @param {string}  editorId  — id of the contenteditable div
     * @param {Object}  [opts]
     * @param {boolean} [opts.templates]    — show template dropdown (default false)
     * @param {string}  [opts.templateType] — review type for template dropdown
     */
    function build(editorId, opts) {
        opts = opts || {};

        function tb(label, cmd, title, action) {
            return '<button type="button" class="rv-tb-btn" data-cmd="' + cmd + '" title="' + title + '" ' +
                'onmousedown="event.preventDefault()" onclick="' + action + '">' + label + '</button>';
        }
        function sep() { return '<div class="rv-tb-sep"></div>'; }

        var fonts = ['Default','Arial','Georgia','Courier New','Verdana','Times New Roman'];
        var fontSel = '<select class="rv-tb-sel rv-tb-font" title="Font family" ' +
            'onmousedown="EditorToolbar.saveSel(\'' + editorId + '\')" ' +
            'onchange="EditorToolbar.restoreSel(\'' + editorId + '\');document.execCommand(\'fontName\',false,this.value)">' +
            fonts.map(function(f, i) {
                return '<option value="' + (i === 0 ? 'inherit' : f) + '"' + (i === 0 ? ' selected' : '') +
                    ' style="font-family:' + (i === 0 ? 'inherit' : f) + '">' + f + '</option>';
            }).join('') + '</select>';

        var sizes = [['1','Small'],['2','Normal'],['3','Large'],['4','X-Large'],['5','XX-Large'],['6','Huge'],['7','Maximum']];
        var sizeSel = '<select class="rv-tb-sel rv-tb-size" title="Font size" ' +
            'onmousedown="EditorToolbar.saveSel(\'' + editorId + '\')" ' +
            'onchange="EditorToolbar.restoreSel(\'' + editorId + '\');document.execCommand(\'fontSize\',false,this.value)">' +
            '<option value="">Size</option>' +
            sizes.map(function(s) { return '<option value="' + s[0] + '">' + s[1] + '</option>'; }).join('') +
            '</select>';

        var foreColorBtn = '<label class="rv-tb-btn rv-tb-color-btn" title="Text Color" ' +
            'onmousedown="EditorToolbar.saveSel(\'' + editorId + '\')">' +
            '<span class="rv-tb-color-label" id="et-fore-' + editorId + '">A</span>' +
            '<input type="color" value="#e05252" class="rv-tb-color-input" ' +
                'onchange="EditorToolbar.applyFore(this.value,\'' + editorId + '\')">' +
            '</label>';

        var hiliteBtn = '<label class="rv-tb-btn rv-tb-color-btn" title="Highlight" ' +
            'onmousedown="EditorToolbar.saveSel(\'' + editorId + '\')">' +
            '<span class="rv-tb-hilite-label">H</span>' +
            '<input type="color" value="#ffe060" class="rv-tb-color-input" ' +
                'onchange="EditorToolbar.applyHilite(this.value,\'' + editorId + '\')">' +
            '</label>';

        var emojiBtn = '<span style="position:relative;">' +
            '<button type="button" class="rv-tb-btn" title="Insert Emoji" data-emoji-for="' + editorId + '" ' +
                'onmousedown="event.preventDefault()" ' +
                'onclick="EditorToolbar.toggleEmojiPicker(\'' + editorId + '\')">😀</button></span>';

        // The desktop app always shows the button; it opens the Windows + H tip.
        var sttSupported = !!(window.denariiStore || window.SpeechRecognition || window.webkitSpeechRecognition);
        var sttBtn = sttSupported
            ? '<button type="button" class="rv-tb-btn" title="Dictate (speech to text)" aria-label="Dictate (speech to text)" data-stt-for="' + editorId + '" ' +
                'onmousedown="event.preventDefault()" ' +
                'onclick="EditorToolbar.toggleSpeech(\'' + editorId + '\')">' +
                '<svg class="rv-tb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
                    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
                    '<rect x="9" y="2" width="6" height="12" rx="3"/>' +
                    '<path d="M5 10v1a7 7 0 0 0 14 0v-1"/>' +
                    '<line x1="12" y1="18" x2="12" y2="22"/>' +
                    '<line x1="8" y1="22" x2="16" y2="22"/>' +
                '</svg></button>'
            : '';

        var html = '<div class="rv-toolbar">' +
            tb('↩','undo','Undo',   "document.execCommand('undo')") +
            tb('↪','redo','Redo',   "document.execCommand('redo')") +
            sep() +
            tb('<b>B</b>',  'bold',          'Bold',          "document.execCommand('bold')") +
            tb('<i>I</i>',  'italic',        'Italic',        "document.execCommand('italic')") +
            tb('<u>U</u>',  'underline',     'Underline',     "document.execCommand('underline')") +
            tb('<s>S</s>',  'strikethrough', 'Strikethrough', "document.execCommand('strikeThrough')") +
            sep() +
            tb('≡',  'ul',   'Bullet List',   "document.execCommand('insertUnorderedList')") +
            tb('1.', 'ol',   'Numbered List', "document.execCommand('insertOrderedList')") +
            sep() +
            tb('⬅', 'left',   'Align Left',   "document.execCommand('justifyLeft')") +
            tb('↔', 'center', 'Align Center', "document.execCommand('justifyCenter')") +
            tb('➡', 'right',  'Align Right',  "document.execCommand('justifyRight')") +
            sep() +
            tb('H2', 'h2', 'Heading', "document.execCommand('formatBlock',false,'h3')") +
            tb('¶',  'p',  'Paragraph', "document.execCommand('formatBlock',false,'p')") +
            sep() +
            fontSel +
            sizeSel +
            sep() +
            foreColorBtn +
            hiliteBtn +
            sep() +
            tb('🔗', 'link', 'Insert Link', "EditorToolbar.insertLink('" + editorId + "')") +
            tb('✕',  'clear', 'Clear Formatting', "document.execCommand('removeFormat')") +
            sep() +
            emojiBtn +
            sttBtn;

        // Optional template dropdown (for Reflection pages)
        if (opts.templates && opts.templateType) {
            html += sep() +
                '<select class="rv-tb-sel" id="rv-template-select-' + opts.templateType + '" style="width:155px;max-width:155px;" ' +
                    'title="Apply a template" ' +
                    'onchange="window._rvApplyTemplate(\'' + opts.templateType + '\',Number(this.value));this.value=\'\'">' +
                    '<option value="">Template\u2026</option>' +
                '</select>' +
                '<button type="button" class="btn btn-secondary btn-small" style="white-space:nowrap;" ' +
                    'onclick="openNoteTemplateManager()">Templates</button>';
        }

        html += '</div>';
        return html;
    }

    // ── Paste image resize ──────────────────────────────────────────────────
    var _MAX_W = 1200;
    var _MAX_H = 1200;
    var _JPEG_QUALITY = 0.80;
    var _pasteResizeBound = {}; // track bound editors to prevent double-binding

    function bindPasteResize(editorId) {
        if (_pasteResizeBound[editorId]) return;
        var ed = document.getElementById(editorId);
        if (!ed) return;
        _pasteResizeBound[editorId] = true;

        ed.addEventListener('paste', function(e) {
            var items = e.clipboardData && e.clipboardData.items;
            if (!items) return; // no clipboard data — let default handle it

            // Find the first image blob item
            var imageItem = null;
            for (var i = 0; i < items.length; i++) {
                if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
                    imageItem = items[i];
                    break;
                }
            }
            if (!imageItem) return; // no image blob — let text/HTML paste proceed normally

            e.preventDefault();
            var blob = imageItem.getAsFile();
            if (!blob) return;

            var reader = new FileReader();
            reader.onload = function() {
                var img = new Image();
                img.onload = function() {
                    try {
                        var w = img.naturalWidth;
                        var h = img.naturalHeight;

                        // Compute scaled dimensions (never upscale)
                        if (w > _MAX_W || h > _MAX_H) {
                            var ratio = Math.min(_MAX_W / w, _MAX_H / h);
                            w = Math.round(w * ratio);
                            h = Math.round(h * ratio);
                        }

                        var canvas = document.createElement('canvas');
                        canvas.width = w;
                        canvas.height = h;
                        var ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, w, h);

                        // Use JPEG for opaque images, PNG if source has alpha
                        var outputType = 'image/jpeg';
                        var quality = _JPEG_QUALITY;
                        if (imageItem.type === 'image/png') {
                            // Check for actual transparency by sampling alpha channel
                            var hasAlpha = false;
                            try {
                                var pixelData = ctx.getImageData(0, 0, w, h).data;
                                for (var p = 3; p < pixelData.length; p += 4) {
                                    if (pixelData[p] < 255) { hasAlpha = true; break; }
                                }
                            } catch (ex) { /* getImageData can fail on tainted canvas */ }
                            if (hasAlpha) {
                                outputType = 'image/png';
                                quality = undefined;
                            }
                        }

                        var dataUri = canvas.toDataURL(outputType, quality);
                        _insertImageAtCursor(ed, dataUri);
                    } catch (ex) {
                        // Canvas failed — fall back to original unmodified image
                        _insertImageAtCursor(ed, reader.result);
                    }
                };
                img.onerror = function() {
                    // Image decode failed — fall back to original
                    _insertImageAtCursor(ed, reader.result);
                };
                img.src = reader.result;
            };
            reader.onerror = function() {
                // FileReader failed — cannot recover, paste is already prevented
            };
            reader.readAsDataURL(blob);
        });
    }

    function _insertImageAtCursor(ed, dataUri) {
        ed.focus();
        document.execCommand('insertHTML', false, '<img src="' + dataUri + '">');
    }

    // ── Image click-to-enlarge popout ───────────────────────────────────────
    var _popoutBound = {};

    function bindImagePopout(editorId) {
        if (_popoutBound[editorId]) return;
        var ed = document.getElementById(editorId);
        if (!ed) return;
        _popoutBound[editorId] = true;

        ed.addEventListener('click', function(e) {
            if (e.target.tagName === 'IMG' && e.target.src) {
                e.preventDefault();
                _openImgPopout(e.target.src);
            }
        });
    }

    function _openImgPopout(src) {
        var overlay = document.getElementById('img-popout');
        var img = document.getElementById('img-popout-img');
        if (!overlay || !img) return;
        img.src = src;
        overlay.classList.add('active');
        document.body.classList.add('modal-open');
    }

    global.closeImgPopout = function() {
        var overlay = document.getElementById('img-popout');
        if (!overlay) return;
        overlay.classList.remove('active');
        var img = document.getElementById('img-popout-img');
        if (img) img.src = '';
        setTimeout(function() {
            if (!document.querySelector('.modal.active') && !document.querySelector('.img-popout-overlay.active')) {
                document.body.classList.remove('modal-open');
            }
        }, 220);
    };

    // Close on Escape
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            var overlay = document.getElementById('img-popout');
            if (overlay && overlay.classList.contains('active')) {
                global.closeImgPopout();
            }
        }
    });

    // ── Expose ───────────────────────────────────────────────────────────────
    global.EditorToolbar = {
        build:             build,
        saveSel:           saveSel,
        restoreSel:        restoreSel,
        applyFore:         applyFore,
        applyHilite:       applyHilite,
        insertLink:        insertLink,
        toggleEmojiPicker: toggleEmojiPicker,
        insertEmoji:       insertEmoji,
        toggleSpeech:      toggleSpeech,
        bindPasteResize:   bindPasteResize,
        bindImagePopout:   bindImagePopout
    };

    // ── Auto-init toolbar slots present in static HTML ─────────────────────
    // Deferred scripts run after DOM is parsed, so these elements exist now.
    var _autoSlots = [
        { slot: 'tm-toolbar-slot', editor: 'tm-notes' }
    ];
    _autoSlots.forEach(function(cfg) {
        var el = document.getElementById(cfg.slot);
        if (el) {
            el.innerHTML = build(cfg.editor);
            bindPasteResize(cfg.editor);
            bindImagePopout(cfg.editor);
        }
    });

})(window);
