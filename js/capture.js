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

// keepalive lets a POST survive tab-close, but the Fetch spec caps keepalive
// request bodies at 64 KiB — and a turn record (full prompt + raw model response)
// routinely exceeds that for verbose/cloud models, so it would reject and vanish.
// Only use keepalive for small bodies; send large ones as a normal fetch (no cap).
// Biome runs matches back-to-back in one page, so a normal fetch completes fine
// mid-tournament; the only teardown risk is the very last POST before tab-close.
const KEEPALIVE_MAX = 60000;   // stay safely under the 64 KiB keepalive ceiling

function _post(path, body) {
    if (!_enabled) return;
    try {
        const payload = JSON.stringify(body);
        const opts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
        };
        if (payload.length < KEEPALIVE_MAX) opts.keepalive = true;
        fetch(path, opts).catch(() => _drop(path, payload.length));
    } catch (_) { _drop(path, -1); }   // never surface into the game loop
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
