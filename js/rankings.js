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

// ── Past tournaments ─────────────────────────────────────────
// The server keeps every bracket (matches grouped by tournament_id, joined with
// the ELO rating events). These fetch the list, one bracket, and a model's
// participation history for the Recent Tournaments profile strip.

export async function fetchTournaments() {
    try {
        const res = await fetch(`${API}/tournaments`);
        if (!res.ok) return [];
        return await res.json();
    } catch { return []; }
}

export async function fetchTournament(id) {
    try {
        const res = await fetch(`${API}/tournament?id=${encodeURIComponent(id)}`);
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

export async function fetchModelTournaments(model) {
    try {
        const res = await fetch(`${API}/stats/model-tournaments?m=${encodeURIComponent(model)}`);
        if (!res.ok) return [];
        return await res.json();
    } catch { return []; }
}

// Round labels — mirror tournament.js _roundTitle/_matchLabel so a reconstructed
// historical bracket reads identically to a live one.
export function roundTitle(participants) {
    if (participants <= 2) return 'Final';
    if (participants === 4) return 'Semi-Finals';
    if (participants === 8) return 'Quarter-Finals';
    return `Round of ${participants}`;
}
function matchLabel(participants, slot) {
    if (participants <= 2) return 'Final';
    if (participants === 4) return `Semi-Final ${slot + 1}`;
    if (participants === 8) return `QF — Match ${slot + 1}`;
    return `Round of ${participants} — Match ${slot + 1}`;
}

// Turn a /tournament payload's flat, bracket-ordered match list into the
// { rounds, bracket } shape the match dashboard consumes. The server tags each
// match with `participants` (players entering its round, or null for non-bracket
// "qualifier" formats); we bucket by that into depth-rounds, newest-on-top.
export function reconstructBracket(payload) {
    const dbMatches = payload?.matches || [];
    const bracket = dbMatches.map((m, i) => ({
        id: i,
        round: 0,
        slot: 0,
        label: '',
        p1: m.p1,
        p2: m.p2,
        winner: m.winner,
        scores: { 1: { finalScore: m.p1_score || 0 }, 2: { finalScore: m.p2_score || 0 } },
        scoreHistory: null,  // round-by-round populations were never persisted
        eloResult: m.eloResult || null,
        _participants: m.participants ?? null,
    }));

    // Group into depth-rounds. A clean bracket buckets by player count (8 → 4 →
    // 2); a qualifier (participants null) collapses to one flat round.
    const groups = new Map();
    for (const m of bracket) {
        const key = m._participants == null ? 'flat' : m._participants;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
    }
    // A non-power-of-two field (an "Open Draw" / qualifier) has no clean rounds —
    // every match lands in the 'flat' bucket. Render it as one untiered list.
    const flat = groups.size === 1 && groups.has('flat');
    let rounds;
    if (flat) {
        rounds = [bracket];
        bracket.forEach((m, i) => { m.label = `Match ${i + 1}`; });
    } else {
        const keys = [...groups.keys()].filter(k => k !== 'flat').sort((a, b) => b - a);
        rounds = keys.map(k => groups.get(k));
        if (groups.has('flat')) rounds.push(groups.get('flat'));
        rounds.forEach((round) => {
            const participants = round.length * 2;
            round.forEach((m, slot) => { m.label = matchLabel(participants, slot); });
        });
    }
    // Reassign round-depth + slot so the structure matches a live bracket.
    rounds.forEach((round, depth) => round.forEach((m, slot) => { m.round = depth; m.slot = slot; }));

    return { rounds, bracket, flat };
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