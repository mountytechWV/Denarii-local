// ── Ticker badge ─────────────────────────────────────────────────────────────
// Soft colored circle with a ticker's first letters, shown beside the symbol
// where one symbol is the focus. Appearance only: the color slot comes from a
// hash of the ticker, so nothing is stored and the same ticker always matches.
// Colors live in css/denarii-ds.css (.ds-ticker-badge--0 … --7).

(function () {

    var SLOTS = 8;

    function tickerKey(symbol) {
        return symbol == null ? '' : String(symbol).trim().toUpperCase();
    }

    // First two letters, non-letters dropped: "BRK.B" → "BR", "F" → "F".
    function tickerLetters(symbol) {
        return tickerKey(symbol).replace(/[^A-Z]/g, '').slice(0, 2);
    }

    function tickerSlot(symbol) {
        var key = tickerKey(symbol);
        var h = 0;
        for (var i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
        return h % SLOTS;
    }

    // Badge HTML, or '' when the symbol has no letters. Size in px (default 32).
    function tickerBadge(symbol, size) {
        var letters = tickerLetters(symbol);
        if (!letters) return '';
        var px = Number(size);
        px = isFinite(px) && px > 0 ? Math.round(Math.min(Math.max(px, 16), 96)) : 32;
        return '<span class="ds-ticker-badge ds-ticker-badge--' + tickerSlot(symbol) + '"' +
            ' style="--tb-size:' + px + 'px" aria-hidden="true">' + letters + '</span>';
    }

    tickerBadge.letters = tickerLetters;
    tickerBadge.slot = tickerSlot;
    window.DenariiTickerBadge = tickerBadge;

})();
