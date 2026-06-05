// Player detail card — the gamified "fighter dossier" that opens when you click a
// player's avatar on the game board (the banter cards). It pulls the same rich
// per-model stats the avatar lab visualises (GET /stats/model: rank, ELO, peak,
// streak, win-splits by vision/rounds/map size, head-to-head) and presents them
// with arcade-cabinet flair — rank badge, win-streak, recent FORM, and a
// "tonight's matchup" head-to-head against the live opponent.
//
// Self-contained: it lazily builds its own modal into <body> on first open and
// owns its open/close (Esc, backdrop, ✕). The caller (game.js) resolves the
// canonical ranking name (its _fetchRanking already handles aliasing) and hands
// it in; this module fetches the heavy detail and renders. Avatar art reuses the
// game's own model-avatar pipeline so the hero plays the baked idle clip.

import { resolveModel, titleCase } from './model-identity.js';
import { applyAvatarVideo, clearAvatar } from './model-avatar.js';

const VISION_LABELS = { mediated: 'Standard', ascii: 'ASCII', raw: 'Raw' };

let modal = null;       // the backdrop element, built once
let openToken = 0;      // guards against a slow fetch painting over a newer open

// ── public entry ─────────────────────────────────────────────────────────────
// opts: { model, charName, prettyName, ranking, opponent }
//   model      raw model id (drives identity + avatar art)
//   charName   in-world name (e.g. "Riotfang")            — caller-supplied
//   prettyName technical name (e.g. "Cohere · Mid")       — caller-supplied
//   ranking    { model: canonicalName, elo, wins, losses, rank } | null
//   opponent   { charName, model } | null  (the live foe, for the H2H line)
export async function openPlayerCard(opts) {
    const { model } = opts;
    if (!model) return;
    ensureModal();
    const token = ++openToken;

    const id = resolveModel(model);
    modal.style.setProperty('--pc-hue', id.hue);
    modal.hidden = false;
    document.body.classList.add('pcm-open');

    // Paint the identity shell immediately (feels instant); fill stats once fetched.
    renderShell(opts, id);

    // Heavy detail keyed by the canonical ranking name (matches the DB model row).
    let detail = null;
    if (opts.ranking?.model) {
        try {
            const r = await fetch('/stats/model?m=' + encodeURIComponent(opts.ranking.model));
            if (r.ok) detail = await r.json();
        } catch { /* offline → identity-only card */ }
    }
    if (token !== openToken) return;            // a newer open superseded us
    renderBody(opts, id, detail);
}

export function closePlayerCard() {
    openToken++;
    if (!modal) return;
    modal.hidden = true;
    document.body.classList.remove('pcm-open');
    const ava = modal.querySelector('.pcm-ava');
    if (ava) clearAvatar(ava);                  // stop the clip decoding
}

// ── modal scaffold ───────────────────────────────────────────────────────────
function ensureModal() {
    if (modal) return;
    modal = document.createElement('div');
    modal.className = 'pcm-backdrop';
    modal.id = 'player-card-modal';
    modal.hidden = true;
    modal.innerHTML = `<div class="pcm-card" role="dialog" aria-modal="true" aria-label="Player detail">
        <button class="pcm-close" title="Close (Esc)" aria-label="Close">✕</button>
        <div class="pcm-scroll"></div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closePlayerCard(); });
    modal.querySelector('.pcm-close').addEventListener('click', closePlayerCard);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal && !modal.hidden) closePlayerCard();
    });
}

// The hero header — identity that's known before any fetch.
function renderShell(opts, id) {
    const { model, charName, prettyName, ranking } = opts;
    const cls = titleCase(id.family.archetype);
    const origin = id.vendor && id.vendor !== '—' ? ` · ${id.vendor}` : '';
    const host = /cloud/i.test(model) ? 'CLOUD' : 'LOCAL';
    let tier = (id.tier?.label || id.sizeTier || '').toUpperCase();
    if (tier === host) tier = '';   // cloud models tier == host → don't show "CLOUD CLOUD"
    const rank = ranking?.rank;
    const badge = rank === 1 ? `<span class="pcm-rank crown">👑 #1</span>`
        : rank ? `<span class="pcm-rank">#${rank}</span>` : '';

    modal.querySelector('.pcm-scroll').innerHTML = `
        <div class="pcm-hero">
            <div class="pcm-ava-wrap"><div class="pcm-ava">${escapeHtml((charName || '?').slice(0, 2).toUpperCase())}</div>${badge}</div>
            <div class="pcm-id">
                <div class="pcm-name">${escapeHtml(charName || prettyName || model)}</div>
                <div class="pcm-sub">${escapeHtml(cls + origin)}</div>
                <div class="pcm-tags">
                    ${tier ? `<span class="pcm-tag tier">${escapeHtml(tier)}</span>` : ''}
                    <span class="pcm-tag host ${host === 'CLOUD' ? 'is-cloud' : ''}">${host}</span>
                    <span class="pcm-tag tech">${escapeHtml(prettyName || model)}</span>
                </div>
                <div class="pcm-role" data-role></div>
            </div>
        </div>
        <div class="pcm-body" data-body><div class="pcm-loading">Pulling the dossier…</div></div>`;

    // Hero avatar art: baked idle clip → still → procedural, same as the board.
    const ava = modal.querySelector('.pcm-ava');
    if (ava) applyAvatarVideo(ava, model, { category: 'idle', loop: true });
}

function renderBody(opts, id, d) {
    const body = modal.querySelector('[data-body]');
    const roleEl = modal.querySelector('[data-role]');
    if (!body) return;

    const r = opts.ranking;
    const found = d && d.found && d.matches;
    // Narrative role pill (mirrors the board's _renderRole vocabulary).
    if (roleEl) {
        const role = roleLabel(r, found ? d : null);
        roleEl.textContent = role.text;
        roleEl.className = `pcm-role odds-${role.cls}`;
    }

    if (!found) {
        body.innerHTML = `<div class="pcm-unproven">
            <span class="pcm-unproven-bolt">⚡</span>
            <div><b>Unproven challenger</b><p>No ranked matches logged yet — this fighter's record is a blank slate.</p></div>
        </div>`;
        return;
    }

    const wr = d.winrate;
    const wrHue = Math.round((wr / 100) * 120);
    const peak = (d.peak_elo && d.peak_elo > d.elo) ? `▲ peak ${Math.round(d.peak_elo)}` : `peak ${Math.round(d.peak_elo || d.elo)}`;
    const streakTile = (d.streak && d.streak > 1)
        ? `<div class="pcm-tile hot"><b>🔥 ${d.streak}</b><span>streak</span></div>`
        : `<div class="pcm-tile"><b>${d.wins >= d.losses ? '—' : '—'}</b><span>streak</span></div>`;

    body.innerHTML = `
        <div class="pcm-tiles">
            <div class="pcm-tile"><b>${Math.round(d.elo)}</b><span>ELO</span></div>
            <div class="pcm-tile"><b>${d.wins}-${d.losses}</b><span>record</span></div>
            <div class="pcm-tile"><b style="color:hsl(${wrHue} 70% 62%)">${wr}%</b><span>winrate</span></div>
            ${streakTile}
        </div>
        <div class="pcm-subline"><span>${peak}</span><span>${d.matches} matches</span></div>
        ${formRow(d.timeline)}
        ${matchupRow(opts.opponent, d.h2h)}
        ${spark(d.timeline)}
        <div class="pcm-grid">
            <div class="pcm-col">
                ${winrateBlock('By vision', d.splits && d.splits.map_strategy, (k) => VISION_LABELS[k] || k)}
                ${winrateBlock('By rounds', d.splits && d.splits.rounds, (k) => `${k} rds`)}
            </div>
            <div class="pcm-col">
                ${biomeBlock('By map size', d.splits && d.splits.map_size)}
                ${rivalsBlock(d.h2h)}
            </div>
        </div>`;
}

// ── role / matchup ───────────────────────────────────────────────────────────
function roleLabel(ranking, detail) {
    const rank = ranking?.rank ?? detail?.rank;
    const games = detail ? detail.matches : ((ranking?.wins || 0) + (ranking?.losses || 0));
    const streak = detail?.streak || 0;
    if (rank === 1) return { text: '👑 REIGNING CHAMPION', cls: 'fav' };
    if (streak >= 3) return { text: `🔥 ${streak}-WIN HEATER`, cls: 'fav' };
    if (rank && rank <= 3) return { text: 'TOP CONTENDER', cls: 'fav' };
    if (!rank || games < 3) return { text: 'WILDCARD', cls: 'even' };
    if (detail && detail.winrate >= 60) return { text: 'FAVORITE', cls: 'fav' };
    if (detail && detail.winrate <= 40) return { text: 'UNDERDOG', cls: 'dog' };
    return { text: 'CHALLENGER', cls: 'even' };
}

// Head-to-head against the live opponent, if we share a history with them.
function matchupRow(opponent, h2h) {
    if (!opponent || !opponent.model || !h2h) return '';
    const oppId = resolveModel(opponent.model);
    const oppLabel = opponent.charName || oppId.family.label || opponent.model;
    // Match h2h by prettified family label (h2h opponents are raw model names).
    const rec = h2h.find((x) => {
        try { return resolveModel(x.opponent).family.label === oppId.family.label; } catch { return false; }
    });
    if (!rec) return `<div class="pcm-vs new">Tonight: <b>vs ${escapeHtml(oppLabel)}</b> — first meeting</div>`;
    const lead = rec.wins > rec.losses ? 'win' : rec.wins < rec.losses ? 'loss' : 'even';
    return `<div class="pcm-vs">Tonight: <b>vs ${escapeHtml(oppLabel)}</b>
        <span class="pcm-vs-rec is-${lead}">${rec.wins}–${rec.losses}</span> all-time</div>`;
}

// ── recent FORM (last results, newest right) ─────────────────────────────────
function formRow(timeline) {
    const t = (timeline || []).filter((e) => e.result === 'W' || e.result === 'L');
    if (!t.length) return '';
    const last = t.slice(-12);
    const pips = last.map((e) => `<span class="pcm-pip ${e.result === 'W' ? 'w' : 'l'}" title="${e.result === 'W' ? 'Win' : 'Loss'} vs ${escapeHtml(e.opponent || '')}"></span>`).join('');
    return `<div class="pcm-form"><span class="pcm-form-label">recent form</span><span class="pcm-pips">${pips}</span></div>`;
}

// ── stat-viz (gamified twins of the lab's blocks) ────────────────────────────
function fmtScore(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n)); }

function winrateBlock(title, rows, keyFmt) {
    if (!rows || !rows.length) return '';
    const bars = rows.map((s) => {
        const hue = Math.round((s.winrate / 100) * 120);
        return `<div class="pcm-bar">
            <span class="pcm-bk">${escapeHtml(String(keyFmt ? keyFmt(s.key) : s.key))}</span>
            <span class="pcm-bt"><span class="pcm-bf" style="width:${s.winrate}%;background:hsl(${hue} 62% 50%)"></span></span>
            <span class="pcm-bv">${s.winrate}% <em>${s.wins}/${s.games}</em></span>
        </div>`;
    }).join('');
    return `<div class="pcm-split"><span class="pcm-sub2">${title}</span>${bars}</div>`;
}

function biomeBlock(title, rows) {
    if (!rows || !rows.length) return '';
    const max = Math.max(...rows.map((r) => r.avg_score || 0)) || 1;
    const bars = rows.map((s) => {
        const pct = Math.round(((s.avg_score || 0) / max) * 100);
        return `<div class="pcm-bar">
            <span class="pcm-bk">${escapeHtml(String(s.key))}</span>
            <span class="pcm-bt"><span class="pcm-bf biome" style="width:${pct}%"></span></span>
            <span class="pcm-bv">${fmtScore(s.avg_score || 0)} <em>${s.games}g</em></span>
        </div>`;
    }).join('');
    return `<div class="pcm-split"><span class="pcm-sub2">${title} · avg biome</span>${bars}</div>`;
}

function rivalsBlock(h2h) {
    if (!h2h || !h2h.length) return '';
    const rows = h2h.slice(0, 4).map((rec) => {
        let label = rec.opponent;
        try { label = resolveModel(rec.opponent).family.label || rec.opponent; } catch { /* raw */ }
        const lead = rec.wins > rec.losses ? 'win' : rec.wins < rec.losses ? 'loss' : 'even';
        return `<div class="pcm-rival"><span>vs ${escapeHtml(label)}</span>
            <span class="pcm-rrec is-${lead}">${rec.wins}-${rec.losses}</span></div>`;
    }).join('');
    return `<div class="pcm-split"><span class="pcm-sub2">Top rivals</span>${rows}</div>`;
}

// Inline-SVG ELO sparkline (min–max scaled, dashed 1000 baseline, end dot).
function spark(timeline) {
    const pts = (timeline || []).map((e) => e.elo).filter((v) => typeof v === 'number');
    if (pts.length < 2) return '';
    const W = 100, H = 30, pad = 2;
    const lo = Math.min(...pts), hi = Math.max(...pts), span = (hi - lo) || 1;
    const x = (i) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
    const y = (v) => pad + (1 - (v - lo) / span) * (H - 2 * pad);
    const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const area = `M${x(0).toFixed(1)} ${H} ${line.replace(/^M/, 'L')} L${x(pts.length - 1).toFixed(1)} ${H} Z`;
    const base = (lo <= 1000 && hi >= 1000)
        ? `<line x1="${pad}" x2="${W - pad}" y1="${y(1000).toFixed(1)}" y2="${y(1000).toFixed(1)}" class="pcm-spark-base"/>` : '';
    const up = pts[pts.length - 1] >= pts[0];
    return `<div class="pcm-spark"><span class="pcm-sub2">ELO history</span>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="pcm-svg ${up ? 'up' : 'down'}">
            <path d="${area}" class="pcm-spark-fill"/>${base}<path d="${line}" class="pcm-spark-line"/>
            <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(pts[pts.length - 1]).toFixed(1)}" r="1.7" class="pcm-spark-dot"/>
        </svg></div>`;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
