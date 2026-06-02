// Biome Analytics — expandable detail views.
//
// Every dashboard card has a ⤢ button that opens a full-screen modal with a
// richer, filterable/searchable/sortable version of that panel, plus a per-model
// drill-in (click any model anywhere) showing its full ELO curve, head-to-head
// record, factor splits, and complete match log.
//
// Panel views (elo / standings / h2h / factors) render straight from the live
// /stats/dashboard payload the main loop already polls — no extra fetch. The
// match log and model drill-in pull from two dedicated endpoints
// (/stats/matches, /stats/model) since they need more than the dashboard sends.
//
// Live-awareness without fighting the user: while the modal is open we never
// silently re-render (that would clobber a half-typed filter or scroll). Instead
// a "↻ New results" pill appears when fresh matches land; clicking it reloads.

import { resolveModel, paramLabel } from './model-identity.js';
import { applyAvatar } from './model-avatar.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

let getLatest = () => null;
let MODAL, BODY, TITLE, TOOLS, BACK, FRESH;
let stack = [];            // view stack; top is what's showing. Back pops.
let refocus = null;        // id of a search box to refocus after a re-render

const short = (m) => (m || '—').replace(/:.*$/, '').split('/').pop().replace(/-cloud$/, '').replace(/-latest$/, '');
const hueOf = (m) => resolveModel(m).hue;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = (id) => document.getElementById(id);

// ── public API ───────────────────────────────────────────────
export function initDetail(latestGetter) {
    getLatest = latestGetter || (() => null);
    MODAL = $('db-modal'); BODY = $('db-modal-body'); TITLE = $('db-modal-title');
    TOOLS = $('db-modal-tools'); BACK = $('db-modal-back'); FRESH = $('db-modal-fresh');

    document.querySelectorAll('.db-expand').forEach(btn =>
        btn.addEventListener('click', () => openPanel(btn.dataset.panel)));
    MODAL.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
    BACK.addEventListener('click', back);
    FRESH.addEventListener('click', () => {
        const v = current();
        if (v) { v.loadedMatches = matchCount(); v.fetched = null; }
        renderCurrent();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !MODAL.hidden) close();
    });
}

// Called by the poll loop on every fresh payload — only flips the "new" pill.
export function notifyDetail(data) {
    if (MODAL.hidden) return;
    const v = current();
    if (v && v.loadedMatches != null && (data?.totals?.matches ?? 0) > v.loadedMatches)
        FRESH.hidden = false;
}

export function openModel(name) {
    const v = mkView('model', short(name));
    v.model = name;
    if (MODAL.hidden) { stack = [v]; openModal(); }
    else stack.push(v);
    renderCurrent();
}

// ── modal plumbing ───────────────────────────────────────────
const PANEL_TITLES = {
    elo: 'ELO Over Time', standings: 'Standings',
    h2h: 'Head to Head', factors: 'By the Numbers', feed: 'Match Log',
};

function mkView(kind, title) {
    return { kind, title, ui: {}, fetched: null, loadedMatches: matchCount() };
}
function current() { return stack[stack.length - 1]; }
function matchCount() { return getLatest()?.totals?.matches ?? 0; }

function openPanel(key) {
    stack = [mkView(key, PANEL_TITLES[key] || key)];
    openModal();
    renderCurrent();
}
function openModal() {
    MODAL.hidden = false;
    document.body.classList.add('db-modal-open');
    requestAnimationFrame(() => MODAL.classList.add('show'));
}
function close() {
    MODAL.classList.remove('show');
    document.body.classList.remove('db-modal-open');
    stack = [];
    setTimeout(() => { MODAL.hidden = true; BODY.innerHTML = ''; }, 180);
}
function back() { if (stack.length > 1) { stack.pop(); renderCurrent(); } }

async function renderCurrent() {
    const v = current();
    if (!v) return;
    BACK.hidden = stack.length <= 1;
    FRESH.hidden = true;
    TITLE.innerHTML = v.title;
    TOOLS.innerHTML = '';
    v.loadedMatches = matchCount();

    if (v.kind === 'model') return renderModel(v);
    if (v.kind === 'feed') return renderFeedDetail(v);

    const data = getLatest();
    if (!data || !data.totals?.matches) { BODY.innerHTML = emptyMsg('Waiting for the first match.'); return; }
    if (v.kind === 'elo') renderEloDetail(v, data);
    else if (v.kind === 'standings') renderStandings(v, data);
    else if (v.kind === 'h2h') renderH2HDetail(v, data);
    else if (v.kind === 'factors') renderFactorsDetail(v, data);
}

const emptyMsg = (t) => `<div class="dd-empty">${esc(t)}</div>`;
const loadingMsg = () => `<div class="dd-empty">Loading…</div>`;

// ── ELO over time (multi-series, toggleable) ─────────────────
function renderEloDetail(v, data) {
    const order = data.leaderboard.map(r => r.model).filter(m => data.timeline[m]);
    v.ui.hidden = v.ui.hidden || new Set();
    const q = (v.ui.search || '').toLowerCase();

    TOOLS.innerHTML = `<input class="dd-search" id="dd-elo-q" placeholder="filter models…" value="${esc(v.ui.search || '')}">
        <button class="dd-btn" id="dd-elo-all">All</button>
        <button class="dd-btn" id="dd-elo-none">None</button>`;

    const series = order.map(model => {
        const pts = [{ x: 0, y: 1000 }, ...data.timeline[model].map(p => ({ x: p.n, y: p.elo }))];
        return { key: short(model), model, hue: hueOf(model), pts, dim: v.ui.hidden.has(model) };
    });
    const anyVisible = series.some(s => !s.dim);

    BODY.innerHTML = `<div class="dd-elo">
        <div class="dd-chart-host" id="dd-elo-host"></div>
        <div class="dd-legend" id="dd-elo-legend"></div>
    </div>`;
    if (anyVisible) $('dd-elo-host').appendChild(lineChart({ series: series.filter(s => !s.dim) }));
    else $('dd-elo-host').innerHTML = emptyMsg('No models selected.');

    $('dd-elo-legend').innerHTML = order.filter(m => short(m).toLowerCase().includes(q)).map(model => {
        const off = v.ui.hidden.has(model);
        const lb = data.leaderboard.find(r => r.model === model);
        return `<button class="dd-leg${off ? ' off' : ''}" data-model="${esc(model)}" style="--bh:${hueOf(model)}">
            <span class="dd-leg-sw"></span><b>${esc(short(model))}</b><i>${lb ? lb.elo : ''}</i></button>`;
    }).join('') || emptyMsg('No match.');

    $('dd-elo-legend').querySelectorAll('.dd-leg').forEach(b => b.addEventListener('click', () => {
        const m = b.dataset.model;
        v.ui.hidden.has(m) ? v.ui.hidden.delete(m) : v.ui.hidden.add(m);
        renderEloDetail(v, getLatest());
    }));
    wireSearch('dd-elo-q', v, () => renderEloDetail(v, getLatest()));
    $('dd-elo-all').addEventListener('click', () => { v.ui.hidden.clear(); renderEloDetail(v, getLatest()); });
    $('dd-elo-none').addEventListener('click', () => { order.forEach(m => v.ui.hidden.add(m)); renderEloDetail(v, getLatest()); });
}

// ── Standings (sortable, searchable, with ELO ranking bars) ──
const STAND_COLS = [
    { k: 'rank', label: '#', num: true, get: r => medalOrRank(r.rank), sort: r => r.rank },
    { k: 'model', label: 'Model', get: r => modelCell(r.model, r), sort: r => short(r.model).toLowerCase() },
    { k: 'elo', label: 'ELO', num: true, cls: 'dd-elo-v', get: r => r.elo, sort: r => r.elo },
    { k: 'peak_elo', label: 'Peak', num: true, get: r => r.peak_elo, sort: r => r.peak_elo },
    { k: 'matches', label: 'Games', num: true, get: r => r.matches, sort: r => r.matches },
    { k: 'wins', label: 'W', num: true, get: r => r.wins, sort: r => r.wins },
    { k: 'losses', label: 'L', num: true, get: r => r.losses, sort: r => r.losses },
    { k: 'winrate', label: 'Win%', num: true, get: r => r.winrate + '%', sort: r => r.winrate },
    { k: 'streak', label: 'Streak', num: true, get: r => streakCell(r.streak), sort: r => r.streak },
    { k: 'last_seen', label: 'Last seen', get: r => fmtTime(r.last_seen), sort: r => r.last_seen || '' },
];

function renderStandings(v, data) {
    const ui = v.ui;
    if (!ui.sort) ui.sort = { k: 'elo', dir: -1 };
    const q = (ui.search || '').toLowerCase();

    TOOLS.innerHTML = `<input class="dd-search" id="dd-st-q" placeholder="search model / family…" value="${esc(ui.search || '')}">`;

    let rows = data.leaderboard.filter(r => {
        if (!q) return true;
        const rm = resolveModel(r.model);
        return short(r.model).toLowerCase().includes(q) || (rm.family.label || '').toLowerCase().includes(q);
    });
    const col = STAND_COLS.find(c => c.k === ui.sort.k) || STAND_COLS[2];
    rows = rows.slice().sort((a, b) => {
        const x = col.sort(a), y = col.sort(b);
        return (x < y ? -1 : x > y ? 1 : 0) * ui.sort.dir;
    });

    // ELO ranking bars — quick visual of the spread.
    const elos = data.leaderboard.map(r => r.elo);
    const lo = Math.min(...elos, 1000) - 10, hi = Math.max(...elos, 1000) + 10;
    const bars = data.leaderboard.slice(0, 24).map(r => {
        const pct = Math.round(((r.elo - lo) / (hi - lo)) * 100);
        return `<div class="dd-rankbar db-clickable" data-open-model="${esc(r.model)}" style="--bh:${hueOf(r.model)}">
            <span class="dd-rb-name">${esc(short(r.model))}</span>
            <span class="dd-rb-track"><span class="dd-rb-fill" style="width:${pct}%"></span></span>
            <span class="dd-rb-val">${r.elo}</span></div>`;
    }).join('');

    const head = STAND_COLS.map(c => {
        const active = ui.sort.k === c.k;
        const arrow = active ? (ui.sort.dir < 0 ? ' ▾' : ' ▴') : '';
        return `<th class="dd-th${active ? ' active' : ''}${c.num ? ' num' : ''}" data-sort="${c.k}">${c.label}${arrow}</th>`;
    }).join('');
    const body = rows.map(r => `<tr class="db-clickable" data-open-model="${esc(r.model)}" style="--bh:${resolveModel(r.model).hue}">
        ${STAND_COLS.map(c => `<td class="${c.cls || ''}${c.num ? ' num' : ''}">${c.get(r)}</td>`).join('')}</tr>`).join('');

    BODY.innerHTML = `<div class="dd-stack">
        <details class="dd-graph" open><summary>ELO ranking</summary><div class="dd-rankbars">${bars}</div></details>
        <div class="dd-tablewrap"><table class="dd-table dd-standings"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
        <div class="dd-count">${rows.length} model${rows.length === 1 ? '' : 's'}</div>
    </div>`;

    BODY.querySelectorAll('.dd-th[data-sort]').forEach(th => th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (ui.sort.k === k) ui.sort.dir *= -1;
        else ui.sort = { k, dir: STAND_COLS.find(c => c.k === k).num ? -1 : 1 };
        renderStandings(v, getLatest());
    }));
    wireSearch('dd-st-q', v, () => renderStandings(v, getLatest()));
    paintAvatars(BODY);
}

// ── Head to head (full matrix, searchable) ───────────────────
function renderH2HDetail(v, data) {
    const q = (v.ui.search || '').toLowerCase();
    let models = data.leaderboard.map(r => r.model);
    if (q) models = models.filter(m => short(m).toLowerCase().includes(q));
    TOOLS.innerHTML = `<input class="dd-search" id="dd-h2h-q" placeholder="filter models…" value="${esc(v.ui.search || '')}">`;

    if (models.length < 2) { BODY.innerHTML = emptyMsg('Not enough models to compare.'); wireSearch('dd-h2h-q', v, () => renderH2HDetail(v, getLatest())); return; }

    const wins = {};
    for (const m of models) wins[m] = {};
    for (const p of data.head_to_head) {
        if (wins[p.a] && p.b in wins) wins[p.a][p.b] = p.a_wins;
        if (wins[p.b] && p.a in wins) wins[p.b][p.a] = p.b_wins;
    }

    let html = `<div class="dd-tablewrap"><table class="dd-table dd-h2h"><thead><tr><th class="dd-h2h-corner"></th>`;
    for (const c of models) html += `<th class="dd-h2h-col"><span class="db-ava db-ava-xs" data-model="${esc(c)}" title="${esc(short(c))}"></span></th>`;
    html += `</tr></thead><tbody>`;
    for (const rm of models) {
        html += `<tr><td class="dd-h2h-rowhdr db-clickable" data-open-model="${esc(rm)}"><span class="db-ava db-ava-xs" data-model="${esc(rm)}"></span><span>${esc(short(rm))}</span></td>`;
        for (const c of models) {
            if (rm === c) { html += `<td class="dd-h2h-self"></td>`; continue; }
            const w = wins[rm]?.[c] ?? 0, l = wins[c]?.[rm] ?? 0, total = w + l;
            if (!total) { html += `<td class="dd-h2h-none">·</td>`; continue; }
            const ratio = w / total;
            const hue = ratio >= 0.5 ? 140 : 0;
            const alpha = (0.12 + Math.abs(ratio - 0.5) * 0.9).toFixed(2);
            html += `<td class="dd-h2h-cell db-clickable" data-open-model="${esc(rm)}"
                style="background:hsla(${hue},60%,45%,${alpha})" title="${esc(short(rm))} ${w}–${l} vs ${esc(short(c))}">${w}-${l}</td>`;
        }
        html += `</tr>`;
    }
    html += `</tbody></table></div>`;
    BODY.innerHTML = html;
    wireSearch('dd-h2h-q', v, () => renderH2HDetail(v, getLatest()));
    paintAvatars(BODY);
}

// ── Factors (match-condition breakdowns) ─────────────────────
function renderFactorsDetail(v, data) {
    const groups = [
        { key: 'mode', title: 'Mode', fmt: k => cap(k) },
        { key: 'map_size', title: 'Map Size', fmt: k => k === 'auto' ? 'Fit screen' : cap(k) },
        { key: 'rounds', title: 'Rounds', fmt: k => `${k} rounds` },
    ];
    let html = '<div class="dd-factor-grid">';
    for (const g of groups) {
        const rows = data.factors[g.key] || [];
        const max = Math.max(1, ...rows.map(r => r.matches));
        html += `<div class="dd-factor-card"><div class="dd-factor-h">${g.title}</div>`;
        if (!rows.length) { html += `<div class="dd-empty">No data</div></div>`; continue; }
        html += `<table class="dd-table dd-factor-table"><thead><tr><th>Value</th><th class="num">Matches</th><th>Share</th><th class="num">Avg margin</th></tr></thead><tbody>`;
        for (const r of rows) {
            const pct = Math.round((r.matches / max) * 100);
            html += `<tr><td>${esc(g.fmt(r.key))}</td><td class="num">${r.matches}</td>
                <td class="dd-f-bar"><span class="dd-bar-track"><span class="dd-bar-fill" style="width:${pct}%"></span></span></td>
                <td class="num">${r.avg_margin}</td></tr>`;
        }
        html += `</tbody></table></div>`;
    }
    html += '</div>';
    BODY.innerHTML = html;
}

// ── Match log (full, filterable) ─────────────────────────────
async function renderFeedDetail(v) {
    if (!v.fetched) {
        BODY.innerHTML = loadingMsg();
        try { v.fetched = await (await fetch('/stats/matches', { cache: 'no-store' })).json(); }
        catch { BODY.innerHTML = emptyMsg('Could not load match log.'); return; }
        if (current() !== v) return; // user navigated away mid-fetch
    }
    const ui = v.ui;
    const all = v.fetched || [];
    const modes = [...new Set(all.map(m => m.mode).filter(Boolean))];
    const maps = [...new Set(all.map(m => m.map_size).filter(Boolean))];
    const q = (ui.search || '').toLowerCase();

    TOOLS.innerHTML = `<input class="dd-search" id="dd-f-q" placeholder="search model…" value="${esc(ui.search || '')}">
        ${selectFor('dd-f-mode', 'mode', modes, ui.mode, cap)}
        ${selectFor('dd-f-map', 'map', maps, ui.map, k => k === 'auto' ? 'fit' : k)}`;

    const rows = all.filter(m => {
        if (ui.mode && m.mode !== ui.mode) return false;
        if (ui.map && m.map_size !== ui.map) return false;
        if (q && !(short(m.winner).toLowerCase().includes(q) || short(m.loser).toLowerCase().includes(q))) return false;
        return true;
    });

    const body = rows.map(m => {
        const wd = m.deltas?.[m.winner], ld = m.deltas?.[m.loser];
        return `<tr>
            <td class="dd-f-time">${fmtTime(m.played_at)}</td>
            <td>${esc(cap(m.mode || ''))}</td>
            <td>${esc(m.map_size === 'auto' ? 'fit' : (m.map_size || '—'))}</td>
            <td class="num">${m.rounds ?? '—'}</td>
            <td class="dd-f-win db-clickable" data-open-model="${esc(m.winner)}"><span class="db-ava db-ava-xs" data-model="${esc(m.winner)}"></span>${esc(short(m.winner))} ${wd ? `<em class="dd-up">+${wd.delta}</em>` : ''}</td>
            <td class="dd-f-lose db-clickable" data-open-model="${esc(m.loser)}"><span class="db-ava db-ava-xs" data-model="${esc(m.loser)}"></span>${esc(short(m.loser))} ${ld ? `<em class="dd-down">${ld.delta}</em>` : ''}</td>
            <td class="num">${fmtScore(m)}</td>
        </tr>`;
    }).join('');

    BODY.innerHTML = `<div class="dd-tablewrap"><table class="dd-table dd-matchlog">
        <thead><tr><th>When</th><th>Mode</th><th>Map</th><th class="num">Rds</th><th>Winner</th><th>Loser</th><th class="num">Score</th></tr></thead>
        <tbody>${body || `<tr><td colspan="7" class="dd-empty">No matches match the filter.</td></tr>`}</tbody></table></div>
        <div class="dd-count">${rows.length} of ${all.length} matches</div>`;

    wireSearch('dd-f-q', v, () => renderFeedDetail(v));
    wireSelect('dd-f-mode', v, 'mode', () => renderFeedDetail(v));
    wireSelect('dd-f-map', v, 'map', () => renderFeedDetail(v));
    paintAvatars(BODY);
}

// ── Model drill-in ───────────────────────────────────────────
async function renderModel(v) {
    if (!v.fetched) {
        BODY.innerHTML = loadingMsg();
        try { v.fetched = await (await fetch(`/stats/model?m=${encodeURIComponent(v.model)}`, { cache: 'no-store' })).json(); }
        catch { BODY.innerHTML = emptyMsg('Could not load model.'); return; }
        if (current() !== v) return;
    }
    const d = v.fetched;
    if (!d || !d.found) { BODY.innerHTML = emptyMsg('No record for this model yet.'); return; }

    const rm = resolveModel(v.model), hue = rm.hue;
    TITLE.innerHTML = `<span class="db-ava db-ava-sm" data-model="${esc(v.model)}"></span>${esc(short(v.model))}`;

    // ELO curve with win/loss dots
    const pts = [{ x: 0, y: 1000 }, ...d.timeline.map(p => ({ x: p.n, y: p.elo, result: p.result }))];

    const ui = v.ui;
    const logQ = (ui.logFilter || 'all');
    const log = d.matches_log.filter(m => logQ === 'all' ? true : logQ === 'wins' ? m.winner === v.model : m.loser === v.model);

    BODY.innerHTML = `<div class="dd-stack">
        <div class="dd-model-stats" style="--bh:${hue}">
            ${stat('Rank', '#' + d.rank)}
            ${stat('ELO', d.elo, 'dd-elo-v')}
            ${stat('Peak', d.peak_elo)}
            ${stat('Record', `${d.wins}-${d.losses}`)}
            ${stat('Win rate', d.winrate + '%')}
            ${stat('Streak', streakCell(d.streak))}
            ${stat('Family', `${esc(rm.family.label)} · ${esc(paramLabel(v.model))}`)}
        </div>
        <details class="dd-graph" open><summary>ELO over time</summary><div class="dd-chart-host" id="dd-m-chart"></div></details>
        <div class="dd-two">
            <div class="dd-block"><div class="dd-block-h">Head to head</div>${h2hList(d.h2h)}</div>
            <div class="dd-block"><div class="dd-block-h">Splits</div>${splitsBlock(d.splits)}</div>
        </div>
        <div class="dd-block">
            <div class="dd-block-h">Match log
                <span class="dd-seg" id="dd-m-seg">
                    ${['all', 'wins', 'losses'].map(k => `<button class="dd-seg-b${logQ === k ? ' on' : ''}" data-k="${k}">${cap(k)}</button>`).join('')}
                </span>
            </div>
            <div class="dd-tablewrap" id="dd-m-log"></div>
        </div>
    </div>`;

    $('dd-m-chart').appendChild(lineChart({
        height: 300,
        series: [{ key: short(v.model), model: v.model, hue, pts, bold: true, dots: true, label: false }],
    }));
    $('dd-m-log').innerHTML = modelLog(log, v.model);
    $('dd-m-seg').querySelectorAll('.dd-seg-b').forEach(b => b.addEventListener('click', () => {
        ui.logFilter = b.dataset.k; renderModel(v);
    }));
    paintAvatars(BODY);
    paintAvatars(TITLE);
}

function modelLog(rows, self) {
    if (!rows.length) return emptyMsg('No matches.');
    const body = rows.map(m => {
        const won = m.winner === self;
        const opp = won ? m.loser : m.winner;
        const mine = m.deltas?.[self];
        return `<tr>
            <td class="dd-f-time">${fmtTime(m.played_at)}</td>
            <td class="${won ? 'dd-res-w' : 'dd-res-l'}">${won ? 'WIN' : 'LOSS'}</td>
            <td class="db-clickable" data-open-model="${esc(opp)}"><span class="db-ava db-ava-xs" data-model="${esc(opp)}"></span>${esc(short(opp))}</td>
            <td class="num">${fmtScore(m)}</td>
            <td>${esc(cap(m.mode || ''))} · ${esc(m.map_size === 'auto' ? 'fit' : (m.map_size || '—'))}</td>
            <td class="num">${mine ? (mine.delta >= 0 ? `<em class="dd-up">+${mine.delta}</em>` : `<em class="dd-down">${mine.delta}</em>`) : ''}</td>
            <td class="num dd-elo-v">${mine ? mine.elo : ''}</td>
        </tr>`;
    }).join('');
    return `<table class="dd-table dd-matchlog"><thead><tr><th>When</th><th>Result</th><th>Opponent</th><th class="num">Score</th><th>Conditions</th><th class="num">Δ</th><th class="num">ELO</th></tr></thead><tbody>${body}</tbody></table>`;
}

function h2hList(h2h) {
    if (!h2h.length) return emptyMsg('No opponents yet.');
    return `<div class="dd-h2h-list">` + h2h.map(o => {
        const pct = o.winrate;
        return `<div class="dd-h2h-li db-clickable" data-open-model="${esc(o.opponent)}" style="--bh:${hueOf(o.opponent)}">
            <span class="db-ava db-ava-xs" data-model="${esc(o.opponent)}"></span>
            <span class="dd-h2h-li-name">${esc(short(o.opponent))}</span>
            <span class="dd-h2h-li-bar"><span style="width:${pct}%"></span></span>
            <span class="dd-h2h-li-rec"><b>${o.wins}</b>-${o.losses}</span>
        </div>`;
    }).join('') + `</div>`;
}

function splitsBlock(splits) {
    const groups = [
        { key: 'mode', title: 'Mode', fmt: k => cap(k) },
        { key: 'map_size', title: 'Map', fmt: k => k === 'auto' ? 'Fit' : cap(k) },
        { key: 'rounds', title: 'Rounds', fmt: k => `${k}` },
    ];
    let html = '';
    for (const g of groups) {
        const rows = splits[g.key] || [];
        if (!rows.length) continue;
        html += `<div class="dd-split-g"><div class="dd-split-t">${g.title}</div>`;
        for (const r of rows) {
            html += `<div class="dd-split-row">
                <span class="dd-split-k">${esc(g.fmt(r.key))}</span>
                <span class="dd-split-bar"><span style="width:${r.winrate}%"></span></span>
                <span class="dd-split-v">${r.wins}/${r.games} · ${r.winrate}%</span></div>`;
        }
        html += `</div>`;
    }
    return html || emptyMsg('No splits.');
}

// ── small render helpers ─────────────────────────────────────
function stat(label, value, cls = '') {
    return `<div class="dd-stat"><b class="${cls}">${value}</b><span>${esc(label)}</span></div>`;
}
function modelCell(model, r) {
    const rm = resolveModel(model);
    return `<span class="dd-modelcell"><span class="db-ava db-ava-sm" data-model="${esc(model)}"></span>
        <span class="dd-mc-id"><b>${esc(short(model))}</b><i>${esc(rm.family.label)} · ${esc(paramLabel(model))}</i></span></span>`;
}
function medalOrRank(rank) { return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank; }
function streakCell(s) {
    if (s > 0) return `<span class="dd-streak-w">${s}W</span>`;
    if (s < 0) return `<span class="dd-streak-l">${-s}L</span>`;
    return '·';
}
function fmtScore(m) {
    if (m.p1_score == null && m.p2_score == null) return '—';
    const a = Math.round(m.p1_score ?? 0), b = Math.round(m.p2_score ?? 0);
    return m.winner === m.p1 ? `${a}–${b}` : `${b}–${a}`;
}
function selectFor(id, key, opts, cur, fmt) {
    return `<select class="dd-sel" id="${id}"><option value="">All ${key}s</option>` +
        opts.map(o => `<option value="${esc(o)}"${cur === o ? ' selected' : ''}>${esc(fmt ? fmt(o) : o)}</option>`).join('') + `</select>`;
}
function wireSearch(id, v, rerender) {
    const inp = $(id);
    if (!inp) return;
    inp.addEventListener('input', () => { v.ui.search = inp.value; refocus = id; rerender(); });
    // The re-render rebuilds this input, destroying focus. If the keystroke that
    // triggered the re-render came from this box, restore focus and park the caret
    // at the end. The flag avoids stealing focus on a fresh open.
    if (refocus === id) {
        inp.focus();
        const end = inp.value.length;
        try { inp.setSelectionRange(end, end); } catch { }
        refocus = null;
    }
}
function wireSelect(id, v, key, rerender) {
    const sel = $(id);
    if (sel) sel.addEventListener('change', () => { v.ui[key] = sel.value; rerender(); });
}
function paintAvatars(scope) {
    scope?.querySelectorAll?.('[data-model]').forEach(el => applyAvatar(el, el.dataset.model));
}
const cap = (s) => (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    const hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0');
    return `${mon} ${d.getDate()} · ${hh}:${mm}`;
}

// ── SVG line chart (shared by ELO panel + model curve) ───────
function lineChart({ width = 1080, height = 480, series, baseline = 1000, xTitle = 'games played →' }) {
    const m = { t: 22, r: 132, b: 38, l: 56 };
    let xMax = 1, yMin = Infinity, yMax = -Infinity;
    for (const s of series) for (const p of s.pts) { xMax = Math.max(xMax, p.x); yMin = Math.min(yMin, p.y); yMax = Math.max(yMax, p.y); }
    if (!isFinite(yMin)) { yMin = 980; yMax = 1020; }
    const pad = Math.max(20, Math.round((yMax - yMin) * 0.08)); yMin -= pad; yMax += pad;
    const px = n => m.l + (n / xMax) * (width - m.l - m.r);
    const py = e => m.t + (1 - (e - yMin) / (yMax - yMin)) * (height - m.t - m.b);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'dd-svg');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    for (const val of niceTicks(yMin, yMax, 6)) {
        mkline(svg, m.l, py(val), width - m.r, py(val), 'db-gridline');
        mktext(svg, m.l - 8, py(val) + 4, Math.round(val), 'db-axis-label', 'end');
    }
    if (baseline >= yMin && baseline <= yMax) mkline(svg, m.l, py(baseline), width - m.r, py(baseline), 'db-gridline db-gridline-base');
    for (const val of niceTicks(0, xMax, Math.min(10, xMax))) mktext(svg, px(val), height - m.b + 18, Math.round(val), 'db-axis-label', 'middle');
    mktext(svg, m.l, height - 6, xTitle, 'db-axis-title', 'start');

    for (const s of series) {
        if (!s.pts.length) continue;
        const d = s.pts.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d); path.setAttribute('fill', 'none');
        path.setAttribute('stroke', `hsl(${s.hue},70%,60%)`);
        path.setAttribute('stroke-width', s.bold ? 3 : 2);
        path.setAttribute('stroke-linejoin', 'round'); path.setAttribute('stroke-linecap', 'round');
        svg.appendChild(path);

        const last = s.pts[s.pts.length - 1];
        mkcircle(svg, px(last.x), py(last.y), 3.5, `hsl(${s.hue},75%,62%)`);
        if (s.label !== false) {
            const t = mktext(svg, px(last.x) + 8, py(last.y) + 4, `${s.key} ${Math.round(last.y)}`, 'db-end-label');
            t.setAttribute('fill', `hsl(${s.hue},70%,72%)`);
        }
        if (s.dots) for (const p of s.pts) {
            if (!p.x) continue;
            mkcircle(svg, px(p.x), py(p.y), 3, p.result === 'W' ? 'hsl(140,60%,58%)' : 'hsl(2,72%,60%)');
        }
    }
    return svg;
}
function mkline(svg, x1, y1, x2, y2, cls) {
    const l = document.createElementNS(SVG_NS, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    if (cls) l.setAttribute('class', cls);
    svg.appendChild(l); return l;
}
function mktext(svg, x, y, str, cls, anchor) {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y);
    if (cls) t.setAttribute('class', cls);
    if (anchor) t.setAttribute('text-anchor', anchor);
    t.textContent = str; svg.appendChild(t); return t;
}
function mkcircle(svg, cx, cy, r, fill) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', r); c.setAttribute('fill', fill);
    svg.appendChild(c); return c;
}
function niceTicks(min, max, count) {
    if (max <= min) return [min];
    const step = niceNum((max - min) / count, true);
    const lo = Math.ceil(min / step) * step, out = [];
    for (let val = lo; val <= max + 1e-6; val += step) out.push(Math.round(val));
    return out;
}
function niceNum(range, round) {
    const exp = Math.floor(Math.log10(range)), frac = range / 10 ** exp;
    let nf;
    if (round) nf = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
    else nf = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
    return nf * 10 ** exp;
}
