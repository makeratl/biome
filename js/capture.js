// Training-data capture — fire-and-forget POSTs of per-turn trajectories and
// per-round reward signals to the server, which appends them to
// training-data/*.jsonl. The match OUTCOME is stamped server-side by the
// /tournament-result handler (it already has the match_uid + winner + ELO), so
// there's no separate "seal" round-trip here.
//
// Hard rule: capture must NEVER break or slow the game. Every call is gated,
// wrapped in try/catch, and fired without awaiting the game loop.

let _enabled = false;
let _dropped = 0;   // capture POSTs that failed to send — surfaced, never silent

export function setCaptureEnabled(on) { _enabled = !!on; }
export function isCaptureEnabled() { return _enabled; }
export function captureDropped() { return _dropped; }

// A match-scoped id that joins a match's turn/round records to its outcome row.
export function newMatchUid() {
    const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
    return `m_${rnd}`;
}

// Delivery: a PLAIN fetch, deliberately WITHOUT keepalive.
//
// keepalive looks tempting (it lets a POST survive tab-close), but the Fetch spec
// caps the COMBINED body size of all in-flight keepalive requests browser-wide at
// ~64 KiB. A tournament fires capture POSTs in bursts (a round + both players'
// turns, back-to-back), so that shared budget is momentarily exhausted and the
// browser starts REJECTING keepalive fetches — silently dropping gold. (Sizing
// each request under 64 KiB didn't help: the cap is on the SUM, not per-request.)
// Biome runs matches back-to-back in one long-lived tab (foreground or
// background — background tabs still complete fetches), so a plain fetch is the
// reliable path. The only thing we forgo is the very last POST if the tab is
// closed mid-flight — a far smaller loss than bursty mid-tournament drops.
function _post(path, body) {
    if (!_enabled) return;
    let payload;
    try { payload = JSON.stringify(body); }
    catch (_) { return _drop(path, -1); }   // never surface into the game loop
    fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload })
        .then(r => { if (!r || !r.ok) _drop(path, payload.length); })
        .catch(() => _drop(path, payload.length));
}

// A failed capture POST is a silent dataset hole — count it and warn once so a
// gap is visible next time instead of a mystery (this exact bug hid for a while).
function _drop(path, bytes) {
    _dropped += 1;
    try {
        const kb = bytes >= 0 ? `${Math.round(bytes / 1024)} KB` : 'unknown size';
        console.warn(`[capture] POST ${path} failed (${kb}); ${_dropped} dropped this session`);
    } catch (_) { /* console unavailable — still counted */ }
}

export function captureTurn(record) { _post('/trajectory/turn', record); }
export function captureRound(record) { _post('/trajectory/round', record); }
