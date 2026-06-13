// Bracket tree — the mirrored two-sided tournament graphic (opening rounds flow
// inward from both rims to the Final + Champion node in the centre). Extracted
// from tournament.js so the live tournament, the championship screen, and the
// historical viewer all render from ONE source of truth.
//
// Pure + data-driven: hand it { rounds, bracket, statOf, … } and it writes the
// markup. `statOf(model) → { elo, seed }` is the only data dependency — the live
// caller reads current standings; the historical caller reconstructs entry-ELO +
// seed from each match's stored eloBefore. `highlight` (a model name) traces one
// competitor's path in gold.

import { resolveModel } from './model-identity.js';
import { applyAvatar } from './model-avatar.js';
import { expectedScore } from './rankings.js';

const short = (model) => !model ? '—'
    : model.replace(/:.*$/, '').split('/').pop().replace(/-cloud$/, '').replace(/-latest$/, '');

const modelHue = (model) => resolveModel(model).hue;

function roundTitle(participants) {
    if (participants <= 2) return 'Final';
    if (participants === 4) return 'Semi-Finals';
    if (participants === 8) return 'Quarter-Finals';
    return `Round of ${participants}`;
}

// Hex model badge — carries data-model so paintAvatars can drop in the baked
// portrait after render; until then it shows the brand-hue gradient + initials.
// The seed is rendered as a separate inline number in the row (bt-seedno), NOT a
// pip over the portrait — a sub-9px number on a 20px avatar was unreadable.
function badge(model, opts = {}, initials) {
    const sizeCls = opts.size ? ` bt-badge-${opts.size}` : '';
    if (!model) return `<span class="bt-badge bt-badge-empty${sizeCls}">·</span>`;
    const ini = initials ? initials(model) : short(model).slice(0, 2).toUpperCase();
    const slotCls = opts.slot === 1 ? ' bt-badge-p1' : opts.slot === 2 ? ' bt-badge-p2' : '';
    return `<span class="bt-badge${slotCls}${sizeCls}" data-model="${model}" style="--bh:${modelHue(model)}">${ini}</span>`;
}

function bracketSide(m, isP1, state, ctx, o) {
    const player = isP1 ? m.p1 : m.p2;
    const stat = o.statOf(player);
    const isWin = state === 'done' && m.winner === player;
    const isLose = state === 'done' && m.winner && m.winner !== player;

    let score = null;
    if (state === 'done' && m.scores) {
        score = (isP1 ? m.scores[1] : m.scores[2])?.finalScore;
    } else if (state === 'live' && ctx.liveScores) {
        score = (isP1 ? ctx.liveScores[1] : ctx.liveScores[2])?.finalScore;
    }
    const lead = state === 'live' && ctx.liveScores && score != null
        && score > (isP1 ? ctx.liveScores[2] : ctx.liveScores[1])?.finalScore;

    const cls = ['bt-side'];
    if (isWin) cls.push('bt-win');
    if (isLose) cls.push('bt-lose');
    if (lead) cls.push('bt-lead');
    if (o.highlight && player === o.highlight) cls.push('bt-side-mine');

    const slot = state === 'live' ? (isP1 ? 1 : 2) : undefined;
    const seedEl = stat?.seed != null
        ? `<span class="bt-seedno${stat.seed <= 3 ? ' bt-seedno-top' : ''}">${stat.seed}</span>` : '';
    const elo = stat?.elo != null ? `<span class="bt-elo">${Math.round(stat.elo)}</span>` : '';
    const scoreEl = score != null ? `<span class="bt-score">${score.toLocaleString()}</span>` : '';

    return `<div class="${cls.join(' ')}">
        ${badge(player, { slot }, o.initials)}
        ${seedEl}
        <span class="bt-name">${player ? short(player) : '—'}</span>
        ${elo}
        ${scoreEl}
    </div>`;
}

// Per-match card with seed/ELO/score for both sides + state-driven framing.
function bracketCard(m, ctx, o) {
    const isLive = !m.winner && m.id === ctx.currentMatchIdx;
    const state = m.winner ? 'done'
        : isLive ? 'live'
        : (m.id === ctx.upNextId ? 'upnext'
        : (m.p1 && m.p2 ? 'queued' : 'pending'));

    // Upset read — winner's pre-match win probability by ELO. < 0.5 = underdog win.
    let upset = false, bigUpset = false, wp = null;
    if (state === 'done' && m.winner) {
        const wStat = o.statOf(m.winner);
        const lStat = o.statOf(m.winner === m.p1 ? m.p2 : m.p1);
        if (wStat?.elo != null && lStat?.elo != null) {
            wp = expectedScore(wStat.elo, lStat.elo);
            upset = wp < 0.5;
            bigUpset = wp < 0.34;
        }
    }

    const cls = ['bt-card', `bt-${state}`];
    if (state === 'done') cls.push(upset ? 'bt-upset' : 'bt-chalk');
    if (bigUpset) cls.push('bt-upset-big');
    const mine = o.highlight && (m.p1 === o.highlight || m.p2 === o.highlight);
    if (mine) cls.push('bt-card-mine');

    let ribbon = '';
    if (state === 'live') {
        ribbon = `<span class="bt-ribbon bt-ribbon-live">LIVE · R${ctx.liveRound ?? 1}/${ctx.totalRounds}</span>`;
    } else if (state === 'upnext') {
        ribbon = `<span class="bt-ribbon bt-ribbon-next">UP NEXT</span>`;
    } else if (state === 'done' && upset) {
        const pct = wp != null ? ` ${Math.round((1 - wp) * 100)}%` : '';
        ribbon = `<span class="bt-ribbon bt-ribbon-upset">⚡ UPSET${pct}</span>`;
    } else if (state === 'done') {
        ribbon = `<span class="bt-ribbon bt-ribbon-chalk">✓</span>`;
    }

    return `<div class="${cls.join(' ')}">
        ${ribbon}
        ${bracketSide(m, true, state, ctx, o)}
        <div class="bt-card-mid"></div>
        ${bracketSide(m, false, state, ctx, o)}
    </div>`;
}

// One round's column. `seed` suppresses the incoming stub (opening round);
// `mirror` flips every connector to point toward the centre (right half).
function bracketColumn(matches, titleParticipants, { seed = false, mirror = false } = {}, ctx, o) {
    const cell = (m) => `<div class="bt-cell">${bracketCard(m, ctx, o)}</div>`;
    let body = '';
    if (matches.length === 1) {
        body = `<div class="bt-pair bt-pair--solo">${cell(matches[0])}</div>`;
    } else {
        for (let i = 0; i < matches.length; i += 2) {
            body += `<div class="bt-pair">${cell(matches[i])}${cell(matches[i + 1])}</div>`;
        }
    }
    const cls = ['bt-round'];
    if (seed) cls.push('bt-round--seed');
    if (mirror) cls.push('bt-round--mirror');
    return `<div class="${cls.join(' ')}">
        <div class="bt-round-label">${roundTitle(titleParticipants)}</div>
        <div class="bt-round-body">${body}</div>
    </div>`;
}

function championNode(rounds, bracket, o) {
    const fin = rounds[rounds.length - 1][0];
    if (fin?.winner) {
        const stat = o.statOf(fin.winner);
        const wins = bracket.filter(m => m.winner === fin.winner).length;
        const elo = stat?.elo != null ? `<div class="bt-champ-elo">${Math.round(stat.elo)} ELO</div>` : '';
        const seed = stat?.seed != null ? `<span class="bt-champ-seed">Seed ${stat.seed}</span>` : '';
        return `<div class="bt-champ bt-champ-crowned">
            <div class="bt-champ-glow" aria-hidden="true"></div>
            <div class="bt-champ-trophy">🏆</div>
            ${badge(fin.winner, { size: 'lg' }, o.initials)}
            <div class="bt-champ-name">${short(fin.winner)}</div>
            ${elo}
            <div class="bt-champ-record">${seed}<span class="bt-champ-wins">${wins} wins</span></div>
            <div class="bt-champ-plinth" aria-hidden="true"></div>
        </div>`;
    }
    return `<div class="bt-champ bt-champ-tbd">
        <div class="bt-champ-trophy">🏆</div>
        <div class="bt-champ-name">—</div>
        <div class="bt-champ-record">To be crowned</div>
        <div class="bt-champ-plinth" aria-hidden="true"></div>
    </div>`;
}

// Header stat strip — field summary, progress, top seed, biggest upset.
function statbar(rounds, bracket, o) {
    const done = bracket.filter(m => m.winner).length;

    // Top seed in the field (seed === 1 by statOf).
    let topSeedChip = '';
    const field = [];
    for (const m of rounds[0]) { field.push(m.p1, m.p2); }
    const topSeed = field.filter(Boolean).find(p => o.statOf(p)?.seed === 1);
    if (topSeed) {
        const elo = o.statOf(topSeed)?.elo;
        topSeedChip = `<div class="bt-stat">
            <span class="bt-stat-k">Top Seed</span>
            <span class="bt-stat-v">${short(topSeed)}${elo != null ? ` · ${Math.round(elo)}` : ''}</span>
        </div>`;
    }

    // Biggest upset across completed matches (lowest winner win-prob).
    let upsetChip = '', best = null;
    for (const m of bracket) {
        if (!m.winner) continue;
        const wStat = o.statOf(m.winner);
        const lStat = o.statOf(m.winner === m.p1 ? m.p2 : m.p1);
        if (wStat?.elo == null || lStat?.elo == null) continue;
        const wp = expectedScore(wStat.elo, lStat.elo);
        if (wp < 0.5 && (!best || wp < best.wp)) {
            best = { wp, winner: m.winner, loser: m.winner === m.p1 ? m.p2 : m.p1 };
        }
    }
    if (best) {
        upsetChip = `<div class="bt-stat bt-stat-upset">
            <span class="bt-stat-k">⚡ Biggest Upset</span>
            <span class="bt-stat-v">${short(best.winner)} def. ${short(best.loser)} · ${Math.round((1 - best.wp) * 100)}%</span>
        </div>`;
    }

    const fieldSize = rounds[0].length * 2;
    const fmtLabel = o.formatLabel ? `${o.formatLabel} · ` : '';
    return `<div class="bt-statbar">
        <div class="bt-stat">
            <span class="bt-stat-k">Field</span>
            <span class="bt-stat-v">${fieldSize} models · ${fmtLabel}${o.modeLabel} · ${o.totalRounds} rounds</span>
        </div>
        <div class="bt-stat">
            <span class="bt-stat-k">Progress</span>
            <span class="bt-stat-v">${done} / ${bracket.length} matches</span>
        </div>
        ${topSeedChip}
        ${upsetChip}
    </div>`;
}

// Paint baked avatars into the badges after the markup is in the DOM.
export function paintBracketAvatars(scope) {
    scope?.querySelectorAll?.('.bt-badge[data-model]').forEach(el => applyAvatar(el, el.dataset.model));
}

// Render the full mirrored bracket into `container`. opts:
//   rounds, bracket            the bracket data (rounds = [[match…], …])
//   statOf(model)              → { elo, seed } | null
//   currentMatchIdx, liveScores, liveRound   live state (omit for historical)
//   totalRounds, modeLabel, formatLabel      header labels
//   highlight                  a model name to trace in gold (optional)
//   initials(model)            optional initials fn (live passes game's)
//   showStatbar                default true; the stage adds its own header
export function renderBracketTree(container, opts) {
    if (!container || !opts?.rounds?.length) return;
    const o = {
        statOf: opts.statOf || (() => null),
        highlight: opts.highlight || null,
        initials: opts.initials || null,
        modeLabel: opts.modeLabel || 'Standard',
        formatLabel: opts.formatLabel || '',
        totalRounds: opts.totalRounds ?? opts.rounds.length,
    };
    const ctx = {
        upNextId: opts.bracket.findIndex((m, i) => !m.winner && i !== opts.currentMatchIdx && m.p1 && m.p2),
        liveScores: opts.liveScores || null,
        liveRound: opts.liveRound ?? null,
        currentMatchIdx: opts.currentMatchIdx ?? null,
        totalRounds: o.totalRounds,
    };

    const rounds = opts.rounds;
    const lastIdx = rounds.length - 1;
    const finalMatch = rounds[lastIdx][0];
    const inner = rounds.slice(0, lastIdx);

    const left = inner.map((round, ri) =>
        bracketColumn(round.slice(0, round.length / 2), round.length * 2, { seed: ri === 0 }, ctx, o)).join('');
    const right = inner.map((round, ri) =>
        bracketColumn(round.slice(round.length / 2), round.length * 2, { seed: ri === 0, mirror: true }, ctx, o))
        .reverse().join('');

    const center = `<div class="bt-round bt-round--center">
        <div class="bt-round-label">Final</div>
        <div class="bt-round-body bt-center-body">
            <div class="bt-cell bt-cell--final">${bracketCard(finalMatch, ctx, o)}</div>
            <div class="bt-champ-wrap">${championNode(rounds, opts.bracket, o)}</div>
        </div>
    </div>`;

    const statbarHtml = opts.showStatbar === false ? '' : statbar(rounds, opts.bracket, o);
    container.innerHTML = `<div class="bt-stage">
        ${statbarHtml}
        <div class="bracket-tree bracket-tree--mirror bracket-tree--rounds-${rounds.length}">${left}${center}${right}</div>
    </div>`;
    paintBracketAvatars(container);
}
