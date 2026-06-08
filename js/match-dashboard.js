// Match dashboard — the post-game detail view shared by the tournament
// championship screen and the single-game (ranked) game-over overlay. Pure
// render helpers: build HTML from in-memory match data, then paint the canvases.
//
// "ELO as of the time of the match" comes from the snapshot the server returns
// per result (match.eloResult = { p1, p2, winner, winnerWinProb }, each side
// { name, eloBefore, eloAfter, rankBefore, rankAfter }). It is captured at match
// time because ratings shift on upsets — a later /rankings read can't rebuild it.

import { resolveModel } from './model-identity.js';

const short = (m) => (m || '—')
    .replace(/:.*$/, '').split('/').pop()
    .replace(/-cloud$/, '').replace(/-latest$/, '');

const hueOf = (m) => resolveModel(m).hue;

// ── Rank-movement badge (mirrors tournament.js _rankBadge) ──────────
function rankBadge(s) {
    if (!s || s.rankAfter == null) return '';
    const after = s.rankAfter;
    if (s.rankBefore == null) return `<span class="md-rb md-rb-new">NEW · #${after}</span>`;
    const before = s.rankBefore;
    if (after < before) return `<span class="md-rb md-rb-up">${after === 1 ? '👑 ' : '▲ '}#${before} → #${after}</span>`;
    if (after > before) return `<span class="md-rb md-rb-down">▼ #${before} → #${after}</span>`;
    return `<span class="md-rb md-rb-hold">holds #${after}</span>`;
}

// One ELO line: name · eloBefore → eloAfter (Δ) · rank badge. `win` tints the name.
function eloLine(side, win) {
    if (!side) return '';
    const hue = hueOf(side.name);
    const dot = `<span class="md-dot" style="background:hsl(${hue},65%,60%)"></span>`;
    const name = `<span class="md-elo-name ${win ? 'md-win' : ''}">${dot}${short(side.name)}</span>`;
    if (side.eloBefore == null || side.eloAfter == null) {
        return `<div class="md-elo-line">${name}</div>`;
    }
    const delta = side.eloAfter - side.eloBefore;
    const dCls = delta > 0 ? 'md-up' : delta < 0 ? 'md-down' : 'md-flat';
    const dStr = delta > 0 ? `+${delta}` : `${delta}`;
    return `<div class="md-elo-line">
        ${name}
        <span class="md-elo-val">${side.eloBefore} → <b>${side.eloAfter}</b></span>
        <span class="md-elo-delta ${dCls}">${dStr}</span>
        ${rankBadge(side)}
    </div>`;
}

// A full match card: title, winner/loser score bars, per-player ELO-at-match
// lines, and a score-over-time chart. `match` is the in-memory bracket match (or
// a match-like object built for a ranked game). `idx` keys its score-chart canvas.
// `highlight` (a model name) marks the card + that model's row when the model is
// in this match — used to trace one competitor's journey through a past bracket.
export function buildMatchCard(match, idx, highlight) {
    const inMatch = highlight && (match.p1 === highlight || match.p2 === highlight);
    const mineCls = inMatch ? ' md-card-mine' : '';
    const won = inMatch && match.winner === highlight;
    const s1 = match.scores?.[1], s2 = match.scores?.[2];
    const winnerIsP1 = match.winner === match.p1;
    const wName = match.winner;
    const lName = winnerIsP1 ? match.p2 : match.p1;
    const wScore = (winnerIsP1 ? s1?.finalScore : s2?.finalScore) ?? 0;
    const lScore = (winnerIsP1 ? s2?.finalScore : s1?.finalScore) ?? 0;
    const total  = wScore + lScore || 1;
    const wPct   = Math.round(wScore / total * 100);

    // ELO sides ordered winner-first to match the score bars above.
    let eloHtml = '';
    if (match.eloResult) {
        const sides = [match.eloResult.p1, match.eloResult.p2].filter(Boolean);
        const wSide = sides.find(s => s.name === wName);
        const lSide = sides.find(s => s.name === lName);
        eloHtml = `<div class="md-elo">${eloLine(wSide, true)}${eloLine(lSide, false)}</div>`;
    }

    return `<div class="md-card${mineCls}">
        <div class="md-card-title">${match.label || 'Match'}${inMatch ? `<span class="md-card-flag">${won ? 'WON' : 'OUT'}</span>` : ''}</div>
        <div class="md-bar-row">
            <span class="md-bar-name md-bar-name-win">${short(wName)}</span>
            <div class="md-bar-track"><div class="md-bar md-bar-win" style="width:${wPct}%"></div></div>
            <span class="md-bar-score">${wScore.toLocaleString()}</span>
        </div>
        <div class="md-bar-row">
            <span class="md-bar-name md-bar-name-lose">${short(lName)}</span>
            <div class="md-bar-track"><div class="md-bar md-bar-lose" style="width:${100 - wPct}%"></div></div>
            <span class="md-bar-score">${lScore.toLocaleString()}</span>
        </div>
        ${eloHtml}
        ${match.scoreHistory?.length ? `<canvas class="md-chart" data-md-chart="${idx}" width="280" height="60"></canvas>` : ''}
    </div>`;
}

// Bracket summary (rounds + matchups), shown above the match cards. `highlight`
// (a model name) glows that model's matches so its path reads at a glance.
function buildBracketSummary(rounds, roundTitle, highlight) {
    if (!rounds?.length) return '';
    const nameCls = (name, isWin, done) =>
        `md-bm-name ${name && name === highlight ? 'md-hl' : ''} ${isWin ? 'md-win' : done ? 'md-lose' : ''}`;
    let html = `<div class="md-section-title">Bracket</div>`;
    for (const round of rounds) {
        html += `<div class="md-bracket-round">${roundTitle(round.length * 2)}</div>`;
        for (const m of round) {
            const done = !!m.winner;
            const mine = highlight && (m.p1 === highlight || m.p2 === highlight);
            html += `<div class="md-bracket-match ${done ? 'md-done' : ''} ${mine ? 'md-bracket-mine' : ''}">
                <span class="${nameCls(m.p1, m.winner === m.p1, done)}">${m.p1 ? short(m.p1) : '—'}</span>
                <span class="md-bm-vs">vs</span>
                <span class="${nameCls(m.p2, m.winner === m.p2, done)}">${m.p2 ? short(m.p2) : '—'}</span>
                ${done ? `<span class="md-bm-tag">✓ ${short(m.winner)}</span>` : ''}
            </div>`;
        }
    }
    return html;
}

// ── ELO progression across the tournament ───────────────────────────
// Each model's rating traced match-by-match: an initial point at its first
// match's eloBefore, then a point at eloAfter after each match it played.
function eloSeries(completed) {
    const series = new Map();
    completed.forEach((m, i) => {
        if (!m.eloResult) return;
        for (const side of [m.eloResult.p1, m.eloResult.p2]) {
            if (!side || side.eloAfter == null) continue;
            if (!series.has(side.name)) series.set(side.name, [{ x: i, elo: side.eloBefore ?? side.eloAfter }]);
            series.get(side.name).push({ x: i + 1, elo: side.eloAfter });
        }
    });
    return series;
}

export function drawEloProgression(canvas, completed) {
    if (!canvas) return;
    const series = eloSeries(completed);
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (series.size === 0) return;

    const pad = { l: 6, r: 6, t: 8, b: 8 };
    const xs = [], es = [];
    for (const pts of series.values()) for (const p of pts) { xs.push(p.x); es.push(p.elo); }
    const xMax = Math.max(...xs, 1);
    let eMin = Math.min(...es), eMax = Math.max(...es);
    if (eMax - eMin < 20) { eMin -= 10; eMax += 10; } // avoid a flat squashed line
    const xOf = x => pad.l + (x / xMax) * (W - pad.l - pad.r);
    const yOf = e => H - pad.b - ((e - eMin) / (eMax - eMin)) * (H - pad.t - pad.b);

    // baseline at 1000 (the rating floor) when it's in range
    if (eMin <= 1000 && eMax >= 1000) {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pad.l, yOf(1000)); ctx.lineTo(W - pad.r, yOf(1000)); ctx.stroke();
    }

    for (const [name, pts] of series) {
        const hue = hueOf(name);
        ctx.strokeStyle = `hsl(${hue}, 65%, 60%)`;
        ctx.lineWidth = 1.75;
        ctx.beginPath();
        pts.forEach((p, i) => {
            const x = xOf(p.x), y = yOf(p.elo);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
        const last = pts[pts.length - 1];
        ctx.fillStyle = `hsl(${hue}, 65%, 62%)`;
        ctx.beginPath(); ctx.arc(xOf(last.x), yOf(last.elo), 2.5, 0, Math.PI * 2); ctx.fill();
    }
}

// Legend chips for the progression chart (hue → model), final ELO descending.
function eloLegend(completed) {
    const last = new Map();
    for (const m of completed) {
        if (!m.eloResult) continue;
        for (const side of [m.eloResult.p1, m.eloResult.p2]) {
            if (side?.eloAfter != null) last.set(side.name, side.eloAfter);
        }
    }
    if (last.size === 0) return '';
    const rows = [...last.entries()].sort((a, b) => b[1] - a[1]).map(([name, elo]) =>
        `<span class="md-leg"><span class="md-dot" style="background:hsl(${hueOf(name)},65%,60%)"></span>${short(name)} <b>${elo}</b></span>`).join('');
    return `<div class="md-legend">${rows}</div>`;
}

// ── Public builders ─────────────────────────────────────────────────

// Tournament dashboard: bracket → ELO progression → per-match cards.
// `roundTitle(participants)` is supplied by the caller. `highlight` (a model
// name) traces one competitor's path — used by the historical viewer opened
// from a model's profile.
export function buildTournamentDashboard(rounds, bracket, { roundTitle, highlight, skipBracket = false } = {}) {
    const completed = bracket ? bracket.filter(m => m.winner) : [];
    const rt = roundTitle || ((n) => `Round of ${n}`);

    // The full bracket graphic (renderBracketTree) can stand in for the text
    // summary; skipBracket lets the stage show the tree and keep only the
    // analytical layer (ELO progression + per-match cards) here.
    let html = skipBracket ? '' : buildBracketSummary(rounds, rt, highlight);

    const hasElo = completed.some(m => m.eloResult);
    if (hasElo) {
        html += `<div class="md-section-title">ELO Progression <span class="md-sub">(rating at each match)</span></div>
            <canvas class="md-elo-chart" data-md-elo width="300" height="120"></canvas>
            ${eloLegend(completed)}`;
    }

    if (completed.length) {
        html += `<div class="md-section-title">Match Results</div>`;
        completed.forEach((m, i) => { html += buildMatchCard(m, i, highlight); });
    } else {
        html += `<div class="md-empty">No completed matches yet.</div>`;
    }
    return html;
}

// Single ranked match: just the one card. `match` is the match-like object the
// caller assembles from the game result + score history.
export function buildSingleMatchDashboard(match) {
    return `<div class="md-section-title">Match Detail</div>${buildMatchCard(match, 0)}`;
}

// Paint every canvas the builders emitted. Pass the same match list used to build.
export function paintDashboard(container, { matches = [], completed = null } = {}) {
    if (!container) return;
    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        if (!m.scoreHistory?.length) continue;
        const canvas = container.querySelector(`canvas[data-md-chart="${i}"]`);
        if (canvas) drawScoreChart(canvas, m.scoreHistory);
    }
    const eloCanvas = container.querySelector('canvas[data-md-elo]');
    if (eloCanvas) drawEloProgression(eloCanvas, completed || matches.filter(m => m.winner));
}

// Score-over-time line (P1 cyan vs P2 amber). Shared with the live result card.
export function drawScoreChart(canvas, history) {
    if (!canvas || !history?.length) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const pad = 4;
    const allScores = history.flatMap(h => [h.p1, h.p2]);
    const maxScore = Math.max(...allScores, 1);
    const n = history.length;
    const xOf = i => pad + (i / Math.max(n - 1, 1)) * (W - pad * 2);
    const yOf = v => H - pad - (v / maxScore) * (H - pad * 2);

    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, H / 2); ctx.lineTo(W - pad, H / 2); ctx.stroke();

    const drawLine = (key, color) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        history.forEach((h, i) => {
            const x = xOf(i), y = yOf(h[key]);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        ctx.stroke();
        const last = history[history.length - 1];
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(xOf(n - 1), yOf(last[key]), 2.5, 0, Math.PI * 2); ctx.fill();
    };
    drawLine('p1', 'hsl(180, 60%, 55%)');
    drawLine('p2', 'hsl(25, 75%, 62%)');
}
