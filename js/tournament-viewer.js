// Tournament stage — the full-screen view of a tournament: the mirrored bracket
// graphic as the hero (one competitor's path traced in gold when highlighting),
// with the ELO-progression graph + per-match ELO cards as the analytical layer
// below. Used both for past tournaments (fetched from the server) and for the
// just-finished one on the championship screen (fed live in-memory data).

import { fetchTournament, reconstructBracket, roundTitle } from './rankings.js';
import { buildTournamentDashboard, paintDashboard } from './match-dashboard.js';
import { renderBracketTree } from './bracket-tree.js';
import { resolveModel } from './model-identity.js';

const short = (m) => (m || '—').replace(/:.*$/, '').split('/').pop().replace(/-cloud$/, '').replace(/-latest$/, '');

let overlay = null;
let onBackCb = null;

function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'tournament-viewer';
    overlay.className = 'tv-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
        <div class="tv-panel">
            <div class="tv-head">
                <button class="tv-back" type="button">← Back</button>
                <div class="tv-title" id="tv-title">Tournament</div>
            </div>
            <div class="tv-body" id="tv-body"></div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.tv-back').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !overlay.hidden) close();
    });
    return overlay;
}

function close() {
    if (overlay) overlay.hidden = true;
    const cb = onBackCb; onBackCb = null;
    if (cb) cb();
}

function fmtDate(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    if (!m) return iso || '';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

// Per-model { elo, seed } reconstructed from a historical bracket: a model's
// entry ELO is the eloBefore it carried into its first match; seeds rank the
// field by that entry rating (best = seed 1) — mirroring the live bracket.
function histStatOf(bracket) {
    const entry = new Map();
    for (const m of bracket) {           // bracket is in flat (chronological) order
        if (!m.eloResult) continue;
        for (const side of [m.eloResult.p1, m.eloResult.p2]) {
            if (!side || side.eloBefore == null) continue;
            if (!entry.has(side.name)) entry.set(side.name, side.eloBefore);
        }
    }
    const seed = new Map();
    [...entry.entries()].sort((a, b) => b[1] - a[1]).forEach(([n], i) => seed.set(n, i + 1));
    return (model) => entry.has(model) ? { elo: entry.get(model), seed: seed.get(model) ?? null } : null;
}

// Render the stage body: bracket tree (real brackets only) + analytical layer.
function renderStage(body, { rounds, bracket, flat, statOf, highlight, modeLabel, formatLabel, totalRounds }) {
    body.innerHTML = `<div class="tv-tree" id="tv-tree"></div><div class="tv-details" id="tv-details"></div>`;
    const tree = body.querySelector('#tv-tree');
    const details = body.querySelector('#tv-details');

    if (!flat) {
        renderBracketTree(tree, {
            rounds, bracket, statOf, highlight,
            modeLabel, formatLabel, totalRounds,
            showStatbar: false,            // the stage header already carries the meta
        });
    } else {
        tree.remove();   // open-draw fields have no bracket to draw
    }

    // Analytical layer: ELO-at-match progression + per-match cards. For a real
    // bracket the tree replaces the text summary (skipBracket); an open draw
    // keeps the dashboard's own match list.
    details.innerHTML = buildTournamentDashboard(rounds, bracket, {
        roundTitle: flat ? () => 'Open Draw' : roundTitle,
        highlight,
        skipBracket: !flat,
    });
    const completed = bracket.filter(m => m.winner);
    paintDashboard(details, { matches: completed, completed });
}

function setTitle(el, { champion, fieldSize, formatLabel, date, highlight }) {
    const champHue = champion ? resolveModel(champion).hue : 200;
    const fmt = formatLabel ? ` · ${formatLabel}` : '';
    const journey = highlight
        ? `<span class="tv-journey" style="color:hsl(${resolveModel(highlight).hue},70%,68%)">${short(highlight)}'s journey</span>`
        : '';
    el.innerHTML = `
        <span class="tv-champ" style="color:hsl(${champHue},70%,68%)">🏆 ${short(champion)}</span>
        <span class="tv-meta">${fieldSize} models${fmt}${date ? ' · ' + date : ''}</span>
        ${journey}`;
}

// Open the stage for a PAST tournament by id (fetches + reconstructs), or — when
// `opts.dataset` is supplied — for a live in-memory tournament (the championship
// screen). opts.highlight traces a model; opts.onBack fires on close.
export async function openTournamentViewer(tournamentId, opts = {}) {
    const el = ensureOverlay();
    onBackCb = opts.onBack || null;
    const body = el.querySelector('#tv-body');
    const title = el.querySelector('#tv-title');
    el.hidden = false;

    // Live dataset path — no fetch.
    if (opts.dataset) {
        const d = opts.dataset;
        setTitle(title, {
            champion: d.champion, fieldSize: d.fieldSize,
            formatLabel: d.formatLabel, date: d.date, highlight: opts.highlight,
        });
        renderStage(body, {
            rounds: d.rounds, bracket: d.bracket, flat: !!d.flat,
            statOf: d.statOf, highlight: opts.highlight || null,
            modeLabel: d.modeLabel || 'Standard', formatLabel: d.formatLabel || '',
            totalRounds: d.totalRounds ?? d.rounds.length,
        });
        body.scrollTop = 0;
        return;
    }

    title.textContent = 'Loading tournament…';
    body.innerHTML = `<div class="md-empty">Loading…</div>`;
    const payload = await fetchTournament(tournamentId);
    if (!payload || payload.found === false || !payload.matches?.length) {
        title.textContent = 'Tournament';
        body.innerHTML = `<div class="md-empty">This tournament could not be loaded.</div>`;
        return;
    }

    const first = payload.matches[0];
    const players = new Set();
    for (const m of payload.matches) { players.add(m.p1); players.add(m.p2); }
    const { rounds, bracket, flat } = reconstructBracket(payload);

    setTitle(title, {
        champion: payload.champion, fieldSize: players.size,
        formatLabel: first.format || '', date: fmtDate(first.played_at),
        highlight: opts.highlight,
    });
    renderStage(body, {
        rounds, bracket, flat,
        statOf: histStatOf(bracket),
        highlight: opts.highlight || null,
        modeLabel: first.mode === 'lightning' ? 'Lightning' : 'Standard',
        formatLabel: first.format || '',
        totalRounds: first.rounds ?? rounds.length,
    });
    body.scrollTop = 0;
}

export function closeTournamentViewer() { close(); }
