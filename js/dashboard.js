// Biome Analytics — a standalone, auto-refreshing visualizer for the tournament
// database. Polls /stats/dashboard and re-renders every section live, so it can
// sit on a second screen during a tournament and update as matches resolve.
//
// Zero charting deps: the ELO-over-time graph is hand-rolled SVG. Model identity
// (family hue, size, pretty name) and avatars are reused from the game's own
// pure modules so the dashboard and the game speak the same visual language.

import { resolveModel, paramLabel } from './model-identity.js';
import { applyAvatar, preloadAvatars } from './model-avatar.js';
import { initDetail, notifyDetail, openModel } from './dashboard-detail.js';
import { createField, perfSpec, biomeSpec, conditionsSpec, decisivenessSpec } from './dashboard-cloud.js';

const ELO_SUMMARY_TOP = 15;   // summary ELO chart shows the leaders; detail shows all
const fields = {};            // ambient particle fields on the summary panels
let condGroup = 'map_size';   // Match Conditions group-by toggle

const POLL_MS = 4000;
const SVG_NS = 'http://www.w3.org/2000/svg';

preloadAvatars();

let isolated = null;        // model name to isolate in the ELO chart, or null
let lastMatchCount = -1;    // to detect new matches for the live pulse
let lastData = null;
let eloVision = 'all';      // 'all' = global ELO, else a map-vision derived ladder

// 'Standard' = the game's default 'mediated' map vision. The four filters are
// always offered (even with no data yet) so the ladder set is predictable.
const VISION_LABELS = { mediated: 'Standard', ascii: 'ASCII', 'ascii-ext': 'ASCII+', raw: 'Raw' };
const VISION_FILTERS = [['all', 'All'], ['mediated', 'Standard'], ['ascii', 'ASCII'], ['ascii-ext', 'ASCII+'], ['raw', 'Raw']];

// The leaderboard + timeline currently driving the ELO chart and Standings:
// the global rating, or a derived per-vision ladder when one is selected. A
// selected-but-empty vision returns empty (no fallback) so it reads honestly.
function activeLadder(data) {
    if (eloVision === 'all') return { timeline: data.timeline, leaderboard: data.leaderboard };
    const lad = data.vision_ladders?.[eloVision];
    return { timeline: lad?.timeline || {}, leaderboard: lad?.leaderboard || [] };
}

const $ = (id) => document.getElementById(id);
const short = (m) => (m || '—').replace(/:.*$/, '').split('/').pop().replace(/-cloud$/, '').replace(/-latest$/, '');
const hueOf = (m) => resolveModel(m).hue;

// ── poll loop ────────────────────────────────────────────────
async function poll() {
    try {
        const res = await fetch('/stats/dashboard', { cache: 'no-store' });
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        lastData = data;
        render(data);
        notifyDetail(data);
        markLive(true, data.generated_at);
    } catch (e) {
        markLive(false);
    }
}

function markLive(ok, generatedAt) {
    const el = $('db-live');
    const txt = $('db-live-text');
    el.classList.toggle('off', !ok);
    if (ok) {
        const t = generatedAt ? new Date(generatedAt) : new Date();
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        const ss = String(t.getSeconds()).padStart(2, '0');
        txt.textContent = `live · ${hh}:${mm}:${ss}`;
    } else {
        txt.textContent = 'offline — retrying';
    }
}

function render(data) {
    $('t-matches').textContent = data.totals.matches;
    $('t-models').textContent = data.totals.models;

    const newMatch = data.totals.matches > lastMatchCount && lastMatchCount >= 0;
    lastMatchCount = data.totals.matches;

    if (!data.totals.matches) {
        renderEmpty();
        return;
    }

    renderHighlights(data.highlights, data.leaderboard);
    renderEloVisionSeg();
    const ladder = activeLadder(data);
    renderEloChart(ladder.timeline, ladder.leaderboard);
    renderLeaderboard(ladder.leaderboard);
    markStandingsVision();
    renderH2H(data.head_to_head, data.leaderboard);
    renderFactors(data.factors);
    renderFeed(data.recent, newMatch);
    renderFields(data);
}

function renderFields(data) {
    if (!$('db-cloud')) return;
    if (!fields.perf) fields.perf = createField($('db-cloud'), { spec: perfSpec() });
    if (!fields.biome) fields.biome = createField($('db-biome'), { spec: biomeSpec() });
    if (!fields.conditions) fields.conditions = createField($('db-conditions'), { spec: conditionsSpec(condGroup) });
    if (!fields.decisive) fields.decisive = createField($('db-decisive'), { spec: decisivenessSpec() });
    for (const f of Object.values(fields)) f.update(data);
}

function renderEmpty() {
    $('db-highlights').innerHTML = `
        <div class="db-empty-hero">
            <div class="db-empty-mark">📊</div>
            <div class="db-empty-head">Waiting for the first match</div>
            <div class="db-empty-sub">Start a tournament or a ranked Solo/Watch game — this board fills in live as results land.</div>
        </div>`;
    for (const id of ['db-legend', 'db-h2h', 'db-factors', 'db-feed'] ) $(id).innerHTML = '';
    $('db-lb').innerHTML = '';
    $('db-elo-svg').innerHTML = '';
    for (const k of Object.keys(fields)) { fields[k]?.destroy(); delete fields[k]; }
}

// ── highlight cards ──────────────────────────────────────────
function renderHighlights(h, leaderboard) {
    const leader = leaderboard[0];
    const cards = [];

    if (leader) cards.push(card('👑', 'CHAMPION', short(leader.model), `${leader.elo} ELO`, hueOf(leader.model), leader.model));
    if (h.most_improved && h.most_improved.gain > 0)
        cards.push(card('📈', 'MOST IMPROVED', short(h.most_improved.model), `+${h.most_improved.gain} from 1000`, hueOf(h.most_improved.model), h.most_improved.model));
    if (h.biggest_upset)
        cards.push(card('⚡', 'BIGGEST UPSET', short(h.biggest_upset.model), `beat ${short(h.biggest_upset.opponent)} · ${Math.round(h.biggest_upset.win_prob * 100)}% odds`, hueOf(h.biggest_upset.model), h.biggest_upset.model));
    if (h.hot_streak)
        cards.push(card('🔥', 'HOT STREAK', short(h.hot_streak.model), `${h.hot_streak.streak} wins in a row`, hueOf(h.hot_streak.model), h.hot_streak.model));
    else if (h.peak)
        cards.push(card('🏔', 'PEAK ELO', short(h.peak.model), `${h.peak.peak_elo} all-time high`, hueOf(h.peak.model), h.peak.model));

    $('db-highlights').innerHTML = cards.join('');
    paintAvatars($('db-highlights'));
}

function card(icon, label, name, detail, hue, model) {
    return `<div class="db-hl db-clickable" data-open-model="${model}" style="--bh:${hue}">
        <div class="db-hl-icon">${icon}</div>
        <div class="db-hl-body">
            <div class="db-hl-label">${label}</div>
            <div class="db-hl-name"><span class="db-ava db-ava-sm" data-model="${model}"></span>${name}</div>
            <div class="db-hl-detail">${detail}</div>
        </div>
    </div>`;
}

// Vision toggle: All · Standard · ASCII · Raw — always offered. A vision with no
// matches yet selects to an empty (honest) ladder rather than being hidden.
function renderEloVisionSeg() {
    const host = $('db-elo-vision');
    if (!host) return;
    host.innerHTML = VISION_FILTERS.map(([v, label]) =>
        `<button class="db-seg-mini-b${v === eloVision ? ' on' : ''}" data-v="${v}">${label}</button>`).join('');
    host.querySelectorAll('.db-seg-mini-b').forEach(b => b.addEventListener('click', () => {
        eloVision = b.dataset.v;
        isolated = null;                       // a model isolated in one ladder needn't exist in another
        if (lastData) render(lastData);
    }));
}

// Mark the Standings card when it's showing a vision sub-ladder, not the global.
function markStandingsVision() {
    const h = document.querySelector('.db-leaderboard .db-card-head h2');
    if (!h) return;
    h.innerHTML = eloVision === 'all'
        ? 'Standings'
        : `Standings <span class="db-vis-tag">${VISION_LABELS[eloVision]} lens</span>`;
}

// ── ELO over time (hand-rolled SVG) ──────────────────────────
function renderEloChart(timeline, leaderboard) {
    const svg = $('db-elo-svg');
    const W = 920, H = 460;
    const m = { t: 24, r: 120, b: 40, l: 52 };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = '';

    // Summary chart focuses on the leaders — the full field is in the detail view.
    const shown = leaderboard.map(r => r.model).filter(mm => timeline[mm]).slice(0, ELO_SUMMARY_TOP);
    if (!shown.length) {
        text(svg, W / 2, H / 2, eloVision === 'all' ? 'No matches yet' : `No ${VISION_LABELS[eloVision]} matches yet`, 'db-axis-title', 'middle');
        $('db-legend').innerHTML = '';
        return;
    }
    const hiddenCount = leaderboard.filter(r => timeline[r.model]).length - shown.length;

    // Prepend the implicit 1000 origin so every line starts from the baseline.
    const series = {};
    let xMax = 1, yMin = Infinity, yMax = -Infinity;
    for (const model of shown) {
        const pts = [{ n: 0, elo: 1000 }, ...timeline[model].map(p => ({ n: p.n, elo: p.elo }))];
        series[model] = pts;
        for (const p of pts) { xMax = Math.max(xMax, p.n); yMin = Math.min(yMin, p.elo); yMax = Math.max(yMax, p.elo); }
    }
    // Pad the y-domain a touch.
    const pad = Math.max(20, Math.round((yMax - yMin) * 0.08));
    yMin -= pad; yMax += pad;

    const px = (n) => m.l + (n / xMax) * (W - m.l - m.r);
    const py = (e) => m.t + (1 - (e - yMin) / (yMax - yMin)) * (H - m.t - m.b);

    // gridlines + y labels
    const yTicks = niceTicks(yMin, yMax, 5);
    for (const v of yTicks) {
        line(svg, m.l, py(v), W - m.r, py(v), 'db-gridline');
        text(svg, m.l - 8, py(v) + 4, Math.round(v), 'db-axis-label', 'end');
    }
    // 1000 baseline emphasized
    if (1000 >= yMin && 1000 <= yMax) line(svg, m.l, py(1000), W - m.r, py(1000), 'db-gridline db-gridline-base');
    // x labels
    const xTicks = niceTicks(0, xMax, Math.min(8, xMax));
    for (const v of xTicks) {
        const x = px(v);
        text(svg, x, H - m.b + 18, Math.round(v), 'db-axis-label', 'middle');
    }
    text(svg, m.l, H - 6, 'games played →', 'db-axis-title', 'start');
    if (hiddenCount > 0) text(svg, W - m.r, H - 6, `top ${ELO_SUMMARY_TOP} · +${hiddenCount} more in detail →`, 'db-axis-title', 'end');

    // Draw lines (dim non-isolated when isolating)
    const ranked = shown;
    for (const model of ranked) {
        const pts = series[model];
        const hue = hueOf(model);
        const dim = isolated && isolated !== model;
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${px(p.n).toFixed(1)},${py(p.elo).toFixed(1)}`).join(' ');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', `hsl(${hue},70%,60%)`);
        path.setAttribute('stroke-width', dim ? 1 : (isolated === model ? 3 : 2));
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('opacity', dim ? 0.12 : 1);
        path.classList.add('db-line');
        svg.appendChild(path);

        // End dot + label at current standing
        const last = pts[pts.length - 1];
        if (!dim) {
            const cx = px(last.n), cy = py(last.elo);
            const dot = document.createElementNS(SVG_NS, 'circle');
            dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('r', 3.5);
            dot.setAttribute('fill', `hsl(${hue},75%,62%)`);
            svg.appendChild(dot);
            text(svg, cx + 8, cy + 4, `${short(model)} ${last.elo}`, 'db-end-label')
                .setAttribute('fill', `hsl(${hue},70%,72%)`);

            // invisible hover points with native tooltip
            for (const p of pts) {
                if (!p.n) continue;
                const hp = document.createElementNS(SVG_NS, 'circle');
                hp.setAttribute('cx', px(p.n)); hp.setAttribute('cy', py(p.elo)); hp.setAttribute('r', 7);
                hp.setAttribute('fill', 'transparent');
                hp.style.cursor = 'pointer';
                const tt = document.createElementNS(SVG_NS, 'title');
                tt.textContent = `${short(model)} — game ${p.n}: ${p.elo} ELO`;
                hp.appendChild(tt);
                svg.appendChild(hp);
            }
        }
    }

    renderLegend(ranked);
}

function renderLegend(models) {
    const top = models.slice(0, 16);
    $('db-legend').innerHTML = top.map(model => {
        const hue = hueOf(model);
        const off = isolated && isolated !== model;
        return `<button class="db-leg${off ? ' off' : ''}" data-model="${model}" style="--bh:${hue}">
            <span class="db-leg-swatch"></span>${short(model)}</button>`;
    }).join('');
    $('db-legend').querySelectorAll('.db-leg').forEach(b => {
        b.addEventListener('click', () => {
            const m = b.dataset.model;
            isolated = (isolated === m) ? null : m;
            if (lastData) { renderEloChart(lastData.timeline, lastData.leaderboard); }
        });
    });
}

// ── leaderboard table ────────────────────────────────────────
function renderLeaderboard(rows) {
    if (!rows.length) {
        $('db-lb').innerHTML = `<tbody><tr><td class="db-mini-empty" style="padding:28px;text-align:center;">No ${eloVision === 'all' ? '' : VISION_LABELS[eloVision] + ' '}matches yet</td></tr></tbody>`;
        return;
    }
    let html = `<thead><tr>
        <th>#</th><th>Model</th><th>ELO</th><th>Peak</th><th>W-L</th><th>Win%</th><th>Streak</th></tr></thead><tbody>`;
    for (const r of rows) {
        const rm = resolveModel(r.model);
        const medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank;
        const streak = r.streak > 0 ? `<span class="db-streak-w">${r.streak}W</span>`
            : r.streak < 0 ? `<span class="db-streak-l">${-r.streak}L</span>` : '·';
        html += `<tr class="db-clickable" data-open-model="${r.model}" style="--bh:${rm.hue}">
            <td class="db-lb-rank">${medal}</td>
            <td class="db-lb-model">
                <span class="db-ava db-ava-sm" data-model="${r.model}"></span>
                <span class="db-lb-id"><b>${short(r.model)}</b><i>${rm.family.label} · ${paramLabel(r.model)}</i></span>
            </td>
            <td class="db-lb-elo">${r.elo}</td>
            <td class="db-lb-peak">${r.peak_elo}</td>
            <td class="db-lb-wl"><b>${r.wins}</b>-${r.losses}</td>
            <td class="db-lb-wr">${r.winrate}%</td>
            <td class="db-lb-streak">${streak}</td>
        </tr>`;
    }
    html += '</tbody>';
    $('db-lb').innerHTML = html;
    paintAvatars($('db-lb'));
}

// ── head-to-head heatmap ─────────────────────────────────────
function renderH2H(pairs, leaderboard) {
    const models = leaderboard.slice(0, 8).map(r => r.model);   // compact square for the tile; full grid in detail
    if (models.length < 2) { $('db-h2h').innerHTML = '<div class="db-mini-empty">Not enough matchups yet</div>'; return; }

    // Build lookup: wins[a][b] = times a beat b
    const wins = {};
    for (const m of models) wins[m] = {};
    for (const p of pairs) {
        if (wins[p.a] && p.b in wins) wins[p.a][p.b] = p.a_wins;
        if (wins[p.b] && p.a in wins) wins[p.b][p.a] = p.b_wins;
    }

    const cell = (size) => `${size}px`;
    let html = `<table class="db-h2h-table"><thead><tr><th class="db-h2h-corner"></th>`;
    for (const c of models) html += `<th class="db-h2h-colhdr"><span class="db-ava db-ava-xs" data-model="${c}"></span></th>`;
    html += `</tr></thead><tbody>`;
    for (const rmName of models) {
        html += `<tr><td class="db-h2h-rowhdr"><span class="db-ava db-ava-xs" data-model="${rmName}"></span><span>${short(rmName)}</span></td>`;
        for (const c of models) {
            if (rmName === c) { html += `<td class="db-h2h-self"></td>`; continue; }
            const w = wins[rmName]?.[c] ?? 0;
            const l = wins[c]?.[rmName] ?? 0;
            const total = w + l;
            if (!total) { html += `<td class="db-h2h-none" title="${short(rmName)} vs ${short(c)}: no games">·</td>`; continue; }
            const ratio = w / total;                       // 0..1 dominance for row model
            const hue = ratio >= 0.5 ? 140 : 0;            // green if winning, red if losing
            const alpha = (0.12 + Math.abs(ratio - 0.5) * 0.9).toFixed(2);
            html += `<td class="db-h2h-cell" style="background:hsla(${hue},60%,45%,${alpha})"
                title="${short(rmName)} ${w}–${l} vs ${short(c)}">${w}-${l}</td>`;
        }
        html += `</tr>`;
    }
    html += `</tbody></table>`;
    $('db-h2h').innerHTML = html;
    paintAvatars($('db-h2h'));
}

// ── factor breakdowns ────────────────────────────────────────
function renderFactors(factors) {
    const labelMap = {
        map_size: { title: 'Map Size', fmt: (k) => k === 'auto' ? 'Fit screen' : cap(k) },
        rounds: { title: 'Rounds', fmt: (k) => `${k} rounds` },
        mode: { title: 'Mode', fmt: (k) => cap(k) },
    };
    let html = '';
    for (const key of ['mode', 'map_size', 'rounds']) {
        const rows = factors[key] || [];
        const conf = labelMap[key];
        const max = Math.max(1, ...rows.map(r => r.matches));
        html += `<div class="db-factor"><div class="db-factor-title">${conf.title}</div>`;
        if (!rows.length) { html += `<div class="db-mini-empty">—</div></div>`; continue; }
        for (const r of rows) {
            const pct = Math.round((r.matches / max) * 100);
            html += `<div class="db-bar-row">
                <span class="db-bar-label">${conf.fmt(r.key)}</span>
                <span class="db-bar-track"><span class="db-bar-fill" style="width:${pct}%"></span></span>
                <span class="db-bar-val">${r.matches}</span>
            </div>`;
        }
        html += `</div>`;
    }
    $('db-factors').innerHTML = html;
}

// ── live feed ────────────────────────────────────────────────
function renderFeed(recent, flash) {
    if (!recent?.length) { $('db-feed').innerHTML = '<div class="db-mini-empty">No matches yet</div>'; return; }
    let html = '';
    for (const m of recent) {
        const wd = m.deltas?.[m.winner];
        const ld = m.deltas?.[m.loser];
        const wdelta = wd ? `+${wd.delta}` : '';
        const ldelta = ld ? `${ld.delta}` : '';
        html += `<div class="db-feed-row db-clickable" data-open-model="${m.winner}">
            <span class="db-ava db-ava-sm" data-model="${m.winner}"></span>
            <span class="db-feed-win">${short(m.winner)} <em class="db-up">${wdelta}</em></span>
            <span class="db-feed-def">def.</span>
            <span class="db-ava db-ava-sm" data-model="${m.loser}"></span>
            <span class="db-feed-lose">${short(m.loser)} <em class="db-down">${ldelta}</em></span>
            <span class="db-feed-meta">${short3(m)}</span>
        </div>`;
    }
    const feed = $('db-feed');
    feed.innerHTML = html;
    paintAvatars(feed);
    if (flash) {
        const first = feed.firstElementChild;
        if (first) { first.classList.add('db-feed-new'); }
    }
}

function short3(m) {
    const bits = [];
    if (m.mode) bits.push(cap(m.mode));
    if (m.map_size) bits.push(m.map_size === 'auto' ? 'fit' : m.map_size);
    return bits.join(' · ');
}

// ── svg + misc helpers ───────────────────────────────────────
function line(svg, x1, y1, x2, y2, cls) {
    const l = document.createElementNS(SVG_NS, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1);
    l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    if (cls) l.setAttribute('class', cls);
    svg.appendChild(l); return l;
}
function text(svg, x, y, str, cls, anchor) {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y);
    if (cls) t.setAttribute('class', cls);
    if (anchor) t.setAttribute('text-anchor', anchor);
    t.textContent = str;
    svg.appendChild(t); return t;
}
function niceTicks(min, max, count) {
    if (max <= min) return [min];
    const span = max - min;
    const step = niceNum(span / count, true);
    const lo = Math.ceil(min / step) * step;
    const out = [];
    for (let v = lo; v <= max + 1e-6; v += step) out.push(Math.round(v));
    return out;
}
function niceNum(range, round) {
    const exp = Math.floor(Math.log10(range));
    const frac = range / 10 ** exp;
    let nf;
    if (round) nf = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10;
    else nf = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
    return nf * 10 ** exp;
}
const cap = (s) => (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
function paintAvatars(scope) {
    scope?.querySelectorAll?.('[data-model]').forEach(el => applyAvatar(el, el.dataset.model));
}

// ── drill-in: clicking a model anywhere opens its detail view ─
document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-open-model]');
    if (!el) return;
    openModel(el.dataset.openModel);
});

// Match Conditions group-by toggle (map size ↔ rounds)
const condSeg = $('db-cond-seg');
if (condSeg) condSeg.querySelectorAll('.db-seg-mini-b').forEach(b => b.addEventListener('click', () => {
    condGroup = b.dataset.group;
    condSeg.querySelectorAll('.db-seg-mini-b').forEach(x => x.classList.toggle('on', x === b));
    if (fields.conditions) { fields.conditions.setSpec(conditionsSpec(condGroup)); if (lastData) fields.conditions.update(lastData); }
}));

// ── go ───────────────────────────────────────────────────────
initDetail(() => lastData);
poll();
setInterval(poll, POLL_MS);
