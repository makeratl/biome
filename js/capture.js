// Training-data capture — fire-and-forget POSTs of per-turn trajectories and
// per-round reward signals to the server, which appends them to
// training-data/*.jsonl. The match OUTCOME is stamped server-side by the
// /tournament-result handler (it already has the match_uid + winner + ELO), so
// there's no separate "seal" round-trip here.
//
// Hard rule: capture must NEVER break or slow the game. Every call is gated,
// wrapped in try/catch, and fired without awaiting the game loop.

let _enabled = false;

export function setCaptureEnabled(on) { _enabled = !!on; }
export function isCaptureEnabled() { return _enabled; }

// A match-scoped id that joins a match's turn/round records to its outcome row.
export function newMatchUid() {
    const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
    return `m_${rnd}`;
}

function _post(path, body) {
    if (!_enabled) return;
    try {
        // keepalive lets the POST survive a navigation/teardown between matches.
        fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            keepalive: true,
        }).catch(() => {});
    } catch (_) { /* never surface into the game loop */ }
}

export function captureTurn(record) { _post('/trajectory/turn', record); }
export function captureRound(record) { _post('/trajectory/round', record); }
