// ELO Rankings data layer — fetches standings/history from the server and exposes
// win-odds helpers. The full-screen "Hall of Champions" view (js/leaderboard.js)
// and the live-match odds badges render from these; this module owns no markup.

const API = '';

export async function fetchRankings() {
    try {
        const res = await fetch(`${API}/rankings`);
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

export async function fetchHistory() {
    try {
        const res = await fetch(`${API}/history`);
        if (!res.ok) return [];
        return await res.json();
    } catch { return []; }
}

export async function postResult(entry) {
    try {
        const res = await fetch(`${API}/tournament-result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(entry),
        });
        return await res.json();
    } catch { return null; }
}

export async function resetRankings() {
    try {
        const res = await fetch(`${API}/reset-rankings`, { method: 'POST' });
        return await res.json();
    } catch { return null; }
}

// Expected score (win probability) for player A vs B — mirrors server _expected().
export function expectedScore(eloA, eloB) {
    return 1 / (1 + 10 ** ((eloB - eloA) / 400));
}

// Fill two per-side containers with odds badges from each player's ranking ({elo} or null).
export function renderOddsInto(p1El, p2El, p1Ranking, p2Ranking) {
    if (!p1El || !p2El) return;
    const e1 = p1Ranking?.elo, e2 = p2Ranking?.elo;
    if (e1 == null || e2 == null) {
        p1El.innerHTML = oddsBadge(null, 'even');
        p2El.innerHTML = oddsBadge(null, 'even');
        return;
    }
    const p1Win = expectedScore(e1, e2);
    const p2Win = 1 - p1Win;
    const diff = p1Win - p2Win;
    const even = Math.abs(diff) < 0.02;
    p1El.innerHTML = oddsBadge(p1Win, even ? 'even' : (diff > 0 ? 'fav' : 'dog'));
    p2El.innerHTML = oddsBadge(p2Win, even ? 'even' : (diff < 0 ? 'fav' : 'dog'));
}

function oddsBadge(prob, tag) {
    if (prob == null) return `<span class="odds-pct">— odds —</span>`;
    const label = tag === 'fav' ? 'FAVORITE' : tag === 'dog' ? 'UNDERDOG' : 'EVEN';
    return `<span class="odds-pct">${Math.round(prob * 100)}%</span><span class="odds-tag odds-${tag}">${label}</span>`;
}