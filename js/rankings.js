// ELO Rankings — fetches from server, renders leaderboard UI

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

export function renderRankingsPanel(container, rankings, opts = {}) {
    if (!rankings || !Object.keys(rankings).length) {
        container.innerHTML = '<div class="rk-empty">No matches played yet</div>';
        return;
    }
    const humanHandle = opts.humanHandle || null;

    let html = '<div class="rk-section-title">ELO Leaderboard</div>';
    html += '<table class="rk-table"><thead><tr><th>#</th><th>Model</th><th>ELO</th><th>W</th><th>L</th></tr></thead><tbody>';

    let rank = 1;
    for (const [name, stats] of Object.entries(rankings)) {
        const medal = rank === 1 ? ' 🥇' : rank === 2 ? ' 🥈' : rank === 3 ? ' 🥉' : '';
        const isYou = humanHandle && name === humanHandle;
        html += `<tr class="rk-row${rank <= 3 ? ' rk-top' : ''}${isYou ? ' rk-you' : ''}">
            <td class="rk-rank">${rank}</td>
            <td class="rk-name">${isYou ? '👤 ' : ''}${shorten(name)}${medal}</td>
            <td class="rk-elo">${stats.elo}</td>
            <td class="rk-w">${stats.wins}</td>
            <td class="rk-l">${stats.losses}</td>
        </tr>`;
        rank++;
    }

    html += '</tbody></table>';
    container.innerHTML = html;
}

export function renderHistoryPanel(container, history) {
    if (!history?.length) {
        container.innerHTML = '';
        return;
    }

    let html = '<div class="rk-section-title">Recent Matches</div>';
    const recent = history.slice(-20).reverse();
    for (const m of recent) {
        html += `<div class="rk-match">
            <span class="rk-m-winner">${shorten(m.winner)}</span>
            <span class="rk-m-beat">def.</span>
            <span class="rk-m-loser">${shorten(m.winner === m.p1 ? m.p2 : m.p1)}</span>
            <span class="rk-m-scores">${m.p1_score}–${m.p2_score}</span>
        </div>`;
    }
    container.innerHTML = html;
}

function shorten(model) {
    if (!model) return '—';
    return model.replace(/:.*$/, '').split('/').pop().replace(/-cloud$/, '').replace(/-latest$/, '');
}