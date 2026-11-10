// ── In-app prompt modal ──────────────────────────────────────────────────────
// Replacement for window.prompt(), which Electron does not support.
//
//   const value = await window.showPromptModal({ title, message, defaultValue,
//       placeholder, inputType, okLabel, cancelLabel });
//
// Same contract as prompt(): resolves to the entered string ('' if OK with an
// empty field) or null on Cancel, Escape or a click on the backdrop.
// inputType 'password' masks the field. Reuses the .modal / .modal-content
// styles. Focus and any text selection (e.g. in a rich-text editor) are put
// back before the promise resolves, so callers can act on them as they did
// after the native prompt.
(function () {
    'use strict';

    var modal = null;
    var titleEl, messageEl, inputEl, okBtn, cancelBtn;
    var pending = null; // { resolve, returnFocus, ranges }

    function build() {
        modal = document.createElement('div');
        modal.id = 'prompt-modal';
        modal.className = 'modal';
        modal.style.zIndex = '4000'; // above other modals and the fullscreen editor
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.innerHTML =
            '<div class="modal-content">' +
                '<h2 id="prompt-modal-title"></h2>' +
                '<p id="prompt-modal-message" style="margin-bottom:12px;white-space:pre-line;"></p>' +
                '<input id="prompt-modal-input" type="text" autocomplete="off" spellcheck="false">' +
                '<div class="modal-buttons">' +
                    '<button type="button" class="btn btn-secondary" id="prompt-modal-cancel"></button>' +
                    '<button type="button" class="btn btn-primary" id="prompt-modal-ok"></button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(modal);

        titleEl = modal.querySelector('#prompt-modal-title');
        messageEl = modal.querySelector('#prompt-modal-message');
        inputEl = modal.querySelector('#prompt-modal-input');
        okBtn = modal.querySelector('#prompt-modal-ok');
        cancelBtn = modal.querySelector('#prompt-modal-cancel');

        okBtn.addEventListener('click', function () { finish(inputEl.value); });
        cancelBtn.addEventListener('click', function () { finish(null); });
        modal.addEventListener('mousedown', function (e) {
            if (e.target === modal) finish(null);
        });
        modal.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                finish(null);
            } else if (e.key === 'Enter' && e.target === inputEl) {
                e.preventDefault();
                e.stopPropagation();
                finish(inputEl.value);
            } else if (e.key === 'Tab') {
                // Keep focus inside the dialog
                var order = [inputEl, cancelBtn, okBtn];
                var i = order.indexOf(document.activeElement);
                e.preventDefault();
                order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length].focus();
            }
        });
    }

    function saveRanges() {
        var sel = window.getSelection ? window.getSelection() : null;
        var ranges = [];
        if (sel) {
            for (var i = 0; i < sel.rangeCount; i++) ranges.push(sel.getRangeAt(i).cloneRange());
        }
        return ranges;
    }

    function restore(returnFocus, ranges) {
        try {
            if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) {
                returnFocus.focus({ preventScroll: true });
            }
            if (ranges.length) {
                var sel = window.getSelection();
                sel.removeAllRanges();
                ranges.forEach(function (r) { sel.addRange(r); });
            }
        } catch (e) { /* element gone; nothing to restore */ }
    }

    function finish(value) {
        if (!pending) return;
        var p = pending;
        pending = null;
        inputEl.value = '';
        modal.classList.remove('active');
        if (!document.querySelector('.modal.active')) document.body.classList.remove('modal-open');
        restore(p.returnFocus, p.ranges);
        p.resolve(value);
    }

    function showPromptModal(opts) {
        opts = opts || {};
        if (!modal) build();
        if (pending) finish(null); // one prompt at a time; the earlier one is cancelled

        return new Promise(function (resolve) {
            pending = {
                resolve: resolve,
                returnFocus: document.activeElement,
                ranges: saveRanges()
            };

            titleEl.textContent = opts.title || '';
            titleEl.style.display = opts.title ? '' : 'none';
            messageEl.textContent = opts.message || '';
            messageEl.style.display = opts.message ? '' : 'none';
            inputEl.type = opts.inputType === 'password' ? 'password' : 'text';
            inputEl.placeholder = opts.placeholder || '';
            inputEl.value = opts.defaultValue != null ? String(opts.defaultValue) : '';
            inputEl.setAttribute('aria-label', opts.title || opts.message || 'Input');
            okBtn.textContent = opts.okLabel || 'OK';
            cancelBtn.textContent = opts.cancelLabel || 'Cancel';

            modal.classList.add('active');
            document.body.classList.add('modal-open');
            inputEl.focus();
            inputEl.select();
        });
    }

    window.showPromptModal = showPromptModal;
})();
