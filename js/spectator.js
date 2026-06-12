// Spectator view — a public, read-only broadcast of the live tournament.
//
// The server only relays what the driving browser pushes (see live-publish.js):
//   GET /tournament/live        → { active, done, snapshot, board_rev, age_ms }
//   GET /tournament/live/board  → latest board WebP
// When nothing is live, we fall back to standings + last champion + recent
// results, all from the existing read endpoints. Polling, no SSE — mirrors the
// dashboard's poll loop and stays robust over public DNS.

import { renderBracketTree } from './bracket-tree.js';
import { resolveModel, paramLabel } from './model-identity.js';
import { preloadAvatars, applyAvatar, applyAvatarVideo, teardownClips } from './model-avatar.js';
import { fetchTournament, reconstructBracket } from './rankings.js';
import { BoardFrameView } from './board-frame-view.js';
import { FramePlayer } from './frame-player.js';
import { CONFIG } from './config.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_TOP = 10;   // ELO chart shows the leaders; the field is in the standings

const POLL_MS = 1500;          // live feed cadence
const IDLE_REFRESH_MS = 12000; // how often to re-pull standings while idle
const TICKER_MS = 6000;        // recent-results refresh
const FRAMES_POLL_MS = 300;    // per-step growth stream cadence (board animation)
const STEP_MS = CONFIG.SIM?.ANIMATION_STEP_MS || 100;  // playback pace per sim step
const FRAME_RESYNC_AHEAD = 30; // this far behind ⇒ skip the backlog, resync to the live edge

const $ = (id) => document.getElementById(id);
const short = (m) => (m || '—').replace(/:.*$/, '').split('/').pop().replace(/-cloud$/, '').replace(/-latest$/, '');
const hueOf = (m) => { try { return resolveModel(m).hue; } catch { return 210; } };
const initialsOf = (m) => { try { return resolveModel(m).initials || ''; } catch { return ''; } };
const dot = (m) => `<span class="rank-dot" style="background:hsl(${hueOf(m)},60%,55%)"></span>`;
const escHtml = (t) => String(t).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

preloadAvatars();

let mode = null;            // 'live' | 'idle' | null — current rendered view
let lastBoardRev = -1;
let lastIdleAt = 0;
let lastTickerAt = 0;
let lastBanter = { 1: null, 2: null }; // cached per-side text → slam only on change
let lastSpoken = null;       // side (1|2) that fired the most recent taunt
let lastHeroMatch = null;    // detect match change to reset the banter cache
let camTimer = null;         // broadcast-camera cycle
let camState = 'overview';   // 'overview' (wide) | 'focus' (push in on the live match)
let lastBracketSig = null;   // re-render the tree only when it changes (keeps the camera steady)
let clockState = null;       // { remainingMs, totalMs, player, receivedAt } for the move clock
let activePlayer = null;     // pod currently thinking (1|2|null) — drives the spotlight + ring
let heroMatch = null;        // match the cockpit scaffold is built for (rebuild on change)
let liveDash = null;         // cached /stats/dashboard for the live "tale of the tape" cutaway
let lastLiveDashAt = 0;
let lastLiveSnap = null;     // latest live snapshot, for the cutaway timer to read
let tapeTimer = null;        // periodic stat-cutaway during a live match
let seenWinners = null;      // Set<matchId> already celebrated; null until first snapshot of a tournament
let seenTournamentId = null; // reset the seen-set when a new tournament begins
let celebrating = false;     // an event scene is currently playing
const eventQueue = [];       // pending celebrations (match win / champion)
const boardImg = new Image(); // preloader so swaps don't flicker
let _framePlayer = null;     // per-step growth playback engine (board animation)
let _frameSince = 0;         // highest sim-step seq we've enqueued (drain cursor)
let _framesTimer = null;     // the frame-stream poll interval

// ── poll loop ────────────────────────────────────────────────
async function poll() {
    try {
        const res = await fetch('/tournament/live', { cache: 'no-store' });
        if (!res.ok) throw new Error(res.status);
        const data = await res.json();
        markLive(true);
        if (data.active && data.snapshot) renderLive(data);
        else renderIdle();
    } catch {
        markLive(false);
        renderIdle();
    }
    refreshTicker();
}

function markLive(ok) {
    const pill = $('spec-pill');
    pill.classList.toggle('off', !ok);
    $('spec-pill-text').textContent = ok ? (mode === 'live' ? 'live' : 'standby') : 'offline — retrying';
}

// ── live view ────────────────────────────────────────────────
function ensureLiveScaffold() {
    if (mode === 'live') return;
    mode = 'live';
    const body = $('spec-body');
    body.classList.remove('idle');
    body.classList.add('live');
    // hero / board / bracket are independent blocks so the grid can reflow to a
    // single stacked column on phones (hero first there, board left on desktop).
    body.innerHTML = `
        <div class="panel hero-card hero" id="spec-hero"></div>
        <div class="panel board-panel">
            <div class="panel-label">Live board</div>
            <div class="board-wrap" id="spec-board"><span class="board-empty">waiting for board…</span></div>
        </div>
        <div class="panel bracket-panel">
            <div class="panel-label">Bracket</div>
            <div class="bracket-scroll"><div id="spec-bracket"></div></div>
            <div class="tape" id="spec-tape"></div>
        </div>`;
    lastBoardRev = -1;
    lastBracketSig = null;
    startCamera();
    startCutaway();
}

// ── Broadcast camera ─────────────────────────────────────────
// The mirrored bracket renders at its natural size (great for 8, way too wide
// for 16/32). Rather than scroll-and-clip, we fit it into the panel as a wide
// shot, then cycle: slowly push in on the live match, hold, pull back. Reads
// like a sports feed and keeps every field size presentable. Desktop only —
// phones keep a natural scroll (handled in CSS).
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const isDesktop = () => window.innerWidth > 720;

function naturalSize(cam) {
    const el = cam.firstElementChild || cam;   // .bt-stage holds the real content
    return { w: el.scrollWidth, h: el.scrollHeight };
}
function fitTarget(cam, vp) {
    const n = naturalSize(cam), vw = vp.clientWidth, vh = vp.clientHeight;
    if (!n.w || !n.h || !vw || !vh) return { scale: 1, x: 0, y: 0 };
    const scale = Math.min(vw / n.w, vh / n.h, 1);
    return { scale, x: (vw - n.w * scale) / 2, y: (vh - n.h * scale) / 2 };
}
function focusTarget(cam, vp, el) {
    const n = naturalSize(cam), vw = vp.clientWidth, vh = vp.clientHeight;
    const stage = cam.firstElementChild || cam;
    const sr = stage.getBoundingClientRect(), er = el.getBoundingClientRect();
    const cur = sr.width / (n.w || 1) || 1;            // scale currently applied
    const elL = (er.left - sr.left) / cur, elT = (er.top - sr.top) / cur;
    const elW = er.width / cur, elH = er.height / cur;
    const fit = fitTarget(cam, vp).scale;
    let scale = Math.min(vw / (elW * 2.6), vh / (elH * 2.6), 2.1);  // frame match + context
    scale = Math.max(scale, fit * 1.12);                            // always tighter than the wide shot
    const cx = elL + elW / 2, cy = elT + elH / 2;
    let x = vw / 2 - cx * scale, y = vh / 2 - cy * scale;
    x = n.w * scale <= vw ? (vw - n.w * scale) / 2 : clamp(x, vw - n.w * scale, 0);
    y = n.h * scale <= vh ? (vh - n.h * scale) / 2 : clamp(y, vh - n.h * scale, 0);
    return { scale, x, y };
}
function applyCam(cam, t, animate) {
    cam.style.transition = animate ? 'transform 1.5s cubic-bezier(.33,0,.2,1)' : 'none';
    cam.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.scale})`;
}
function positionCamera(animate) {
    const cam = $('spec-bracket'), vp = cam?.parentElement;
    if (!cam || !vp) return;
    if (!isDesktop()) { cam.style.transition = 'none'; cam.style.transform = ''; return; }
    const live = cam.querySelector('.bt-live');
    const t = (camState === 'focus' && live) ? focusTarget(cam, vp, live) : fitTarget(cam, vp);
    applyCam(cam, t, animate);
}
function startCamera() {
    stopCamera();
    camState = 'overview';
    camTimer = setInterval(() => {
        camState = camState === 'overview' ? 'focus' : 'overview';
        positionCamera(true);
    }, 6500);
}
function stopCamera() { if (camTimer) { clearInterval(camTimer); camTimer = null; } }

// One-shot static fit — the idle "last tournament" bracket (no cycle).
function fitInto(cam) {
    const vp = cam?.parentElement;
    if (!cam || !vp) return;
    if (!isDesktop()) { cam.style.transform = ''; return; }
    requestAnimationFrame(() => applyCam(cam, fitTarget(cam, vp), false));
}

// Re-render the tree only when something visible changed, so the camera glides
// uninterrupted between rounds instead of resetting every 1.5s poll.
function bracketSignature(s) {
    return [s.currentMatchIdx, s.liveRound, JSON.stringify(s.liveScores), s.champion || '',
            s.bracket.map(m => `${m.winner || ''}:${m.p1 || ''}:${m.p2 || ''}`).join('|')].join('#');
}

function renderLive(data) {
    ensureLiveScaffold();
    const s = data.snapshot;
    detectEvents(s);   // fire match-win / champion scenes on newly decided matches
    $('spec-sub').textContent = `${s.modeLabel || 'Standard'}${s.formatLabel ? ' · ' + s.formatLabel : ''} · ${s.totalRounds} rounds`;

    // Rebuild the renderer's inputs from the serialized snapshot.
    const byId = {};
    s.bracket.forEach(m => { byId[m.id] = m; });
    const rounds = (s.rounds || []).map(r => r.map(id => byId[id]).filter(Boolean));
    const statOf = (m) => s.stats?.[m] || null;

    const sig = bracketSignature(s);
    if (sig !== lastBracketSig) {
        lastBracketSig = sig;
        renderBracketTree($('spec-bracket'), {
            rounds, bracket: s.bracket, statOf,
            currentMatchIdx: s.currentMatchIdx,
            liveScores: s.liveScores, liveRound: s.liveRound,
            totalRounds: s.totalRounds, modeLabel: s.modeLabel, formatLabel: s.formatLabel,
            highlight: s.champion || null,
        });
        // Re-anchor the camera to the fresh DOM without a jump; the cycle animates from here.
        requestAnimationFrame(() => positionCamera(false));
    }

    // New match → forget the prior bout's taunts so the first lines slam fresh.
    if (s.currentMatchIdx !== lastHeroMatch) {
        lastBanter = { 1: null, 2: null }; lastSpoken = null; lastHeroMatch = s.currentMatchIdx;
        _framePlayer?.reset();   // drop the prior match's queued growth frames
    }
    renderHero(s, statOf);
    // During SIMULATING the per-step frame stream owns the board (animated growth);
    // otherwise draw the snapshot board (placements, pre/post-sim). The snapshot is
    // authoritative at phase boundaries, correcting any stream drift.
    startFrameStream();
    if (s.phase === 'SIMULATING') {
        // board is driven by pollFrames → FramePlayer; leave the frozen snapshot alone
    } else if (s.board) {
        renderBoardFromState(s.board);
    } else {
        swapBoard(data.board_rev);
    }
}

// Draw the live board locally from the serialized board in the snapshot — no image
// fetch, no host-side canvas read-back. Reuses the game's organism-art via
// BoardFrameView. See docs/headless-broadcast-design.md.
let _boardView = null;
function renderBoardFromState(board) {
    const wrap = $('spec-board');
    if (!wrap) return;
    let canvas = wrap.querySelector('canvas.spec-board-canvas');
    if (!canvas) {
        wrap.innerHTML = '';
        canvas = document.createElement('canvas');
        canvas.className = 'spec-board-canvas';
        canvas.id = 'board-img';            // inherit the board image's sizing CSS
        wrap.appendChild(canvas);
        _boardView = new BoardFrameView(canvas);
    }
    _boardView.render({ board });
}

// ── per-step growth stream ───────────────────────────────────
// The engine emits a board frame each simulation step; we drain them (since-seq)
// and play them through a FramePlayer onto the SAME _boardView the snapshot uses,
// so the board ANIMATES the 2s growth cycle instead of jumping. Terrain is already
// cached on _boardView from the snapshot's keyframe board, so the organism-only
// deltas paint correctly. We deliberately do NOT coalesce — every step should show;
// if we fall far behind (hidden tab / slow device) we skip the backlog and resync.
function ensureFramePlayer() {
    if (_framePlayer) return _framePlayer;
    _framePlayer = new FramePlayer();
    _framePlayer.on('sim-step', async (f) => {
        if (_boardView && f.board) _boardView.render({ board: f.board });
        await sleep(STEP_MS);   // the awaited hold IS the playback pacing
    });
    return _framePlayer;
}

async function pollFrames() {
    try {
        const res = await fetch(`/tournament/live/frames?since=${_frameSince}`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const latest = data.latest || 0;
        if (latest - _frameSince > FRAME_RESYNC_AHEAD) {  // way behind → jump to the live edge
            _frameSince = latest;
            ensureFramePlayer().reset();
            return;
        }
        const player = ensureFramePlayer();
        for (const f of (data.frames || [])) {
            player.push({ kind: 'sim-step', seq: f.seq, board: f.board });
            if (f.seq > _frameSince) _frameSince = f.seq;
        }
    } catch { /* ignore — board holds the last frame */ }
}

function startFrameStream() {
    if (!_framesTimer) _framesTimer = setInterval(pollFrames, FRAMES_POLL_MS);
}
function stopFrameStream() {
    if (_framesTimer) { clearInterval(_framesTimer); _framesTimer = null; }
    if (_framePlayer) _framePlayer.reset();
}

// ── Fighter cockpit ──────────────────────────────────────────
// The hero is a VS-screen mid-fight: two pods with portraits + a draining move
// clock around the active thinker. The scaffold (portraits especially) is built
// ONCE per match; each poll only updates the dynamic bits (scores, phase,
// spotlight, clock) so the avatars don't reload and the clock ring doesn't flash.
const RING_C = 2 * Math.PI * 45;   // circumference of the r=45 clock ring

function podHTML(side, model) {
    let r; try { r = resolveModel(model); } catch { r = { hue: 210, initials: '?' }; }
    return `
        <div class="pod pod-p${side}" id="ck-p${side}">
            <div class="pod-avwrap">
                <svg class="clock-ring" viewBox="0 0 100 100" aria-hidden="true">
                    <circle class="cr-track" cx="50" cy="50" r="45"></circle>
                    <circle class="cr-fill" cx="50" cy="50" r="45"></circle>
                </svg>
                <div class="pod-avatar" id="ck-av${side}" style="--bh:${r.hue}">${r.initials || ''}</div>
                <div class="clock-num" id="ck-num${side}"></div>
            </div>
            <div class="pod-name">${short(model)}</div>
            <div class="pod-elo" id="ck-elo${side}"></div>
            <div class="pod-score" id="ck-sc${side}">—</div>
            <div class="pod-state" id="ck-st${side}"></div>
        </div>`;
}

function buildCockpit(m, s, statOf) {
    const hero = $('spec-hero');
    hero.innerHTML = `
        <div class="hero-tag" id="ck-tag"></div>
        <div class="cockpit" id="ck-cockpit">
            ${podHTML(1, m.p1)}
            <div class="cockpit-vs">VS</div>
            ${podHTML(2, m.p2)}
        </div>
        <div class="hero-bar"><i id="ck-bar"></i></div>
        <div id="ck-banter"></div>`;
    applyAvatar($('ck-av1'), m.p1);   // portrait (procedural hue+initials fallback)
    applyAvatar($('ck-av2'), m.p2);
    const elo = (side, model) => { const st = statOf(model); const e = $(`ck-elo${side}`); if (e) e.textContent = st?.elo != null ? `ELO ${Math.round(st.elo)}` : ''; };
    elo(1, m.p1); elo(2, m.p2);
}

function phaseTag(s, m) {
    const round = `R${s.liveRound ?? 1}/${s.totalRounds}`;
    let ph = '';
    if (s.phase === 'SIMULATING') ph = '<span class="ck-ph ck-ph-sim">RESOLVING ECOSYSTEM</span>';
    else if (s.currentPlayer === 1) ph = `<span class="ck-ph ck-ph-p1">P1 ${s.loading?.[1] ? 'WARMING UP' : 'DECIDING'}</span>`;
    else if (s.currentPlayer === 2) ph = `<span class="ck-ph ck-ph-p2">P2 ${s.loading?.[2] ? 'WARMING UP' : 'DECIDING'}</span>`;
    return `<span class="ck-live"><span class="spec-dot"></span>LIVE</span> <span class="ck-meta">${m.label || 'Match'} · ${round}</span> ${ph}`;
}

function updateCockpit(s, m) {
    const ls = s.liveScores;
    const s1 = ls ? ls[1].finalScore : null, s2 = ls ? ls[2].finalScore : null;
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('ck-sc1', s1 != null ? s1.toLocaleString() : '—');
    set('ck-sc2', s2 != null ? s2.toLocaleString() : '—');
    const total = (s1 || 0) + (s2 || 0) || 1;
    const bar = $('ck-bar'); if (bar) bar.style.width = `${Math.round((s1 || 0) / total * 100)}%`;
    $('ck-p1')?.classList.toggle('lead', s1 != null && s2 != null && s1 > s2);
    $('ck-p2')?.classList.toggle('lead', s1 != null && s2 != null && s2 > s1);

    const sim = s.phase === 'SIMULATING';
    activePlayer = sim ? null : (s.currentPlayer || null);
    $('ck-cockpit')?.classList.toggle('simulating', sim);
    for (const p of [1, 2]) {
        const pod = $(`ck-p${p}`); if (!pod) continue;
        const active = activePlayer === p;
        pod.classList.toggle('active', active);
        pod.classList.toggle('dim', sim || (activePlayer != null && !active));
        const st = $(`ck-st${p}`);
        if (st) st.innerHTML = active
            ? `${s.loading?.[p] ? 'WARMING UP' : 'DECIDING'}<span class="dots"><i></i><i></i><i></i></span>`
            : '';
    }
    const tag = $('ck-tag'); if (tag) tag.innerHTML = phaseTag(s, m);
    document.querySelector('.board-panel')?.classList.toggle('resolving', sim);

    // Move clock: store remaining-at-receipt; the local tick decrements it.
    clockState = (s.clock && s.currentPlayer)
        ? { remainingMs: s.clock.remainingMs, totalMs: s.clock.totalMs, player: s.currentPlayer, receivedAt: performance.now() }
        : null;
    tickClock();   // set the ring immediately so it doesn't wait for the next interval

    const bh = $('ck-banter'); if (bh) bh.innerHTML = renderBanter(s.banter, m);
}

function setRing(ring, frac) { ring.style.strokeDashoffset = `${RING_C * (1 - clamp(frac, 0, 1))}`; }

// Runs on a steady ~200ms interval; decrements the active pod's clock locally so
// it ticks smoothly between the sparse phase-change pushes (and across machines).
function tickClock() {
    for (const p of [1, 2]) {
        const ring = document.querySelector(`#ck-p${p} .cr-fill`);
        const num = $(`ck-num${p}`), pod = $(`ck-p${p}`);
        if (!ring) continue;
        if (clockState && clockState.player === p) {
            const remaining = Math.max(0, clockState.remainingMs - (performance.now() - clockState.receivedAt));
            setRing(ring, clockState.totalMs ? remaining / clockState.totalMs : 0);
            if (num) num.textContent = `${Math.ceil(remaining / 1000)}`;
            pod?.classList.toggle('urgent', remaining <= 10000);
        } else if (activePlayer === p) {
            setRing(ring, 1);                       // thinking, clock about to start
            if (num) num.textContent = '';
            pod?.classList.remove('urgent');
        } else {
            setRing(ring, 0);
            if (num) num.textContent = '';
            pod?.classList.remove('urgent');
        }
    }
}

function renderHero(s, statOf) {
    const m = s.currentMatchIdx != null ? s.bracket[s.currentMatchIdx] : null;
    const hero = $('spec-hero');
    if (!m) {
        heroMatch = null; clockState = null; activePlayer = null;
        document.querySelector('.board-panel')?.classList.remove('resolving');
        hero.innerHTML = s.champion
            ? `<div class="hero-tag">★ CHAMPION</div><div class="hero-fighters"><div class="hero-side"><div class="hero-name">${short(s.champion)}</div></div></div>`
            : `<div class="hero-tag"><span class="spec-dot"></span>STANDING BY</div>`;
        return;
    }
    if (heroMatch !== s.currentMatchIdx) { heroMatch = s.currentMatchIdx; buildCockpit(m, s, statOf); }
    updateCockpit(s, m);
    lastLiveSnap = s;          // the cutaway timer reads this
    maybeFetchLiveDash();      // keep head-to-head fresh for the tale of the tape
}

// ── Live "tale of the tape" cutaway ──────────────────────────
// A broadcast stat beat: every ~22s, fade a head-to-head comparison of the two
// current fighters over the bracket for ~7s, then back. ELO/seed/record come
// from the live snapshot's stats; the H2H record from a cached /stats/dashboard.
async function maybeFetchLiveDash() {
    const now = Date.now();
    if (now - lastLiveDashAt < 15000) return;
    lastLiveDashAt = now;
    try { liveDash = await (await fetch('/stats/dashboard', { cache: 'no-store' })).json(); } catch { /* keep prior */ }
}

function h2hRecord(a, b) {
    for (const p of (liveDash?.head_to_head || [])) {
        if (p.a === a && p.b === b) return { aw: p.a_wins, bw: p.b_wins };
        if (p.a === b && p.b === a) return { aw: p.b_wins, bw: p.a_wins };
    }
    return null;
}

function buildTape(s) {
    const m = s.currentMatchIdx != null ? s.bracket[s.currentMatchIdx] : null;
    if (!m || !m.p1 || !m.p2) return '';
    const st = (model) => s.stats?.[model] || {};
    const a = st(m.p1), b = st(m.p2), h = h2hRecord(m.p1, m.p2);
    const cmp = (x, y) => (x == null || y == null) ? 0 : x > y ? 1 : y > x ? 2 : 0;
    const row = (label, v1, v2, lead) => `
        <div class="tape-row">
            <span class="tape-v ${lead === 1 ? 'tape-lead' : ''}">${v1}</span>
            <span class="tape-label">${label}</span>
            <span class="tape-v tape-v2 ${lead === 2 ? 'tape-lead' : ''}">${v2}</span>
        </div>`;
    return `
        <div class="tape-head">TALE OF THE TAPE</div>
        <div class="tape-fighters">
            <div class="tape-fighter"><span class="tape-ava" data-model="${m.p1}" style="--bh:${hueOf(m.p1)}"></span><span class="tape-name">${short(m.p1)}</span></div>
            <span class="tape-vs">VS</span>
            <div class="tape-fighter tape-f2"><span class="tape-name">${short(m.p2)}</span><span class="tape-ava" data-model="${m.p2}" style="--bh:${hueOf(m.p2)}"></span></div>
        </div>
        ${row('ELO', a.elo != null ? Math.round(a.elo) : '—', b.elo != null ? Math.round(b.elo) : '—', cmp(a.elo, b.elo))}
        ${row('SEED', a.seed ? '#' + a.seed : '—', b.seed ? '#' + b.seed : '—', cmp(b.seed, a.seed))}
        ${row('RECORD', `${a.wins || 0}-${a.losses || 0}`, `${b.wins || 0}-${b.losses || 0}`, cmp(a.wins, b.wins))}
        ${h ? row('HEAD TO HEAD', h.aw, h.bw, cmp(h.aw, h.bw)) : '<div class="tape-noh2h">First meeting</div>'}`;
}

function startCutaway() {
    stopCutaway();
    tapeTimer = setInterval(() => {
        const tape = $('spec-tape');
        if (!tape || !lastLiveSnap) return;
        const html = buildTape(lastLiveSnap);
        if (!html) return;
        tape.innerHTML = html;
        paintAvatars(tape);
        tape.classList.add('show');
        setTimeout(() => tape.classList.remove('show'), 7000);
    }, 22000);
}
function stopCutaway() { if (tapeTimer) { clearInterval(tapeTimer); tapeTimer = null; } $('spec-tape')?.classList.remove('show'); }

// Live trash-talk as fighting-game corner callouts. Each fighter's latest line
// slams in from its side; the most-recent speaker's bubble stays lit. The slam
// only fires when the TEXT actually changes — otherwise the 1.5s poll re-render
// would re-trigger it every tick and strobe. lastBanter caches per-side text;
// lastSpoken tracks who fired most recently (reset on match change in renderLive).
function renderBanter(banter, m) {
    if (!banter) return '';
    const esc = (t) => String(t).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    // pass 1: which sides are newly spoken? (updates the "latest speaker")
    const fresh = {};
    for (const side of [1, 2]) {
        const text = banter[side];
        if (text && text !== lastBanter[side]) { fresh[side] = true; lastBanter[side] = text; lastSpoken = side; }
    }
    // pass 2: build the bubbles, emphasizing the most-recent speaker
    const bubble = (who, text, side) => {
        if (!text) return '';
        const cls = ['taunt', `taunt-p${side}`];
        if (fresh[side]) cls.push('taunt-new');
        if (side === lastSpoken) cls.push('taunt-latest');
        return `<div class="${cls.join(' ')}">
            <span class="taunt-who">${short(who)}</span>
            <span class="taunt-say">${esc(text)}</span>
        </div>`;
    };
    const l1 = bubble(m.p1, banter[1], 1);
    const l2 = bubble(m.p2, banter[2], 2);
    return (l1 || l2) ? `<div class="hero-banter">${l1}${l2}</div>` : '';
}

// ── Cinematic event scenes ───────────────────────────────────
// Bracket matches resolve sequentially on the driving browser; each result it
// pushes lands here as a fresh winner in the snapshot. We diff the set of
// decided matches against what we've already shown and fire a full-screen scene
// for each new one — a winner reveal for ordinary matches, a gold champion
// crowning for the final. The winner's video avatar (the celebratory "champion"
// clip) carries the moment; spark volleys punctuate it.
//
// On the first snapshot of a tournament we seed the seen-set SILENTLY, so a
// spectator joining mid-event (or after it ended) doesn't replay finished
// matches. tournamentId change resets the set for the next bracket.
function detectEvents(s) {
    if (!s || !Array.isArray(s.bracket)) return;
    if (s.tournamentId !== seenTournamentId) { seenTournamentId = s.tournamentId; seenWinners = null; }

    const decided = s.bracket.filter(m => m.winner);
    if (seenWinners === null) { seenWinners = new Set(decided.map(m => m.id)); return; }

    const finalId = s.rounds?.at(-1)?.[0];   // the championship match's id
    for (const m of decided) {
        if (seenWinners.has(m.id)) continue;
        seenWinners.add(m.id);
        eventQueue.push({ type: m.id === finalId ? 'champion' : 'match', m, s });
    }
    drainEvents();
}

async function drainEvents() {
    if (celebrating) return;
    const ev = eventQueue.shift();
    if (!ev) return;
    celebrating = true;
    try {
        if (ev.type === 'champion') await celebrateChampion(ev.m, ev.s);
        else await celebrateMatch(ev.m, ev.s);
    } catch { /* a failed scene must never wedge the queue */ }
    celebrating = false;
    drainEvents();   // play anything that queued while this one ran
}

function showScene(host) { host.style.display = 'flex'; requestAnimationFrame(() => host.classList.add('show')); }
async function hideScene(host) {
    host.classList.remove('show');
    await sleep(560);                 // let the opacity fade finish
    teardownClips(host);              // stop/remove the avatar clip's decoder
    host.innerHTML = '';
    host.style.display = 'none';
}

function scoreOf(m, model) {
    if (!m.scores) return null;
    return m.p1 === model ? m.scores[1]?.finalScore : m.scores[2]?.finalScore;
}

async function celebrateMatch(m, s) {
    const host = $('spec-event');
    if (!host || !m.winner) return;
    const winner = m.winner, loser = winner === m.p1 ? m.p2 : m.p1;
    const ws = scoreOf(m, winner), ls = scoreOf(m, loser);
    const hue = hueOf(winner);
    const round = `R${(m.round ?? 0) + 1}/${s.totalRounds}`;
    host.innerHTML = `
        <div class="se-stage event-stage se-match" style="--bh:${hue}; --se-glow:hsl(${hue},70%,60%)">
            <div class="se-kicker">${escHtml(m.label || 'Match')} · ${round}</div>
            <div class="se-ava" id="se-ava">${initialsOf(winner)}</div>
            <div class="se-ribbon">★ Winner</div>
            <div class="se-name">${short(winner)}</div>
            <div class="se-defeats">defeats <s>${short(loser)}</s></div>
            ${ws != null && ls != null ? `<div class="se-score">${Math.round(ws).toLocaleString()} — ${Math.round(ls).toLocaleString()}</div>` : ''}
        </div>`;
    applyAvatarVideo($('se-ava'), winner, { category: 'champion', loop: true, bounce: true });
    showScene(host);
    const stage = host.querySelector('.se-stage');
    setTimeout(() => burstSparks(stage, hue), 650);
    setTimeout(() => burstSparks(stage, hue), 1600);
    await sleep(6200);
    await hideScene(host);
}

async function celebrateChampion(m, s) {
    const host = $('spec-event');
    const champ = s.champion || m.winner;
    if (!host || !champ) return;
    const wins = s.bracket.filter(mm => mm.winner === champ);
    const path = wins.map(mm => mm.label).filter(Boolean).join('  →  ');
    const fs = scoreOf(m, champ);
    host.innerHTML = `
        <div class="se-stage event-stage se-champ" style="--bh:${hueOf(champ)}">
            <div class="se-crown">♛</div>
            <div class="se-kicker">Tournament Champion</div>
            <div class="se-ava" id="se-ava">${initialsOf(champ)}</div>
            <div class="se-name">${short(champ)}</div>
            <div class="se-record">${wins.length} ${wins.length === 1 ? 'win' : 'wins'}${fs != null ? ` · final ${Math.round(fs).toLocaleString()}` : ''}</div>
            ${path ? `<div class="se-path">${escHtml(path)}</div>` : ''}
        </div>`;
    applyAvatarVideo($('se-ava'), champ, { category: 'champion', loop: true, bounce: true });
    showScene(host);
    const stage = host.querySelector('.se-stage');
    [600, 1500, 2700, 4300, 6000].forEach(t => setTimeout(() => burstSparks(stage, 45, true), t));
    await sleep(12000);
    await hideScene(host);
}

// Spark volley reusing the shared .fx-burst / .fx-ring / .spark CSS. Hue is in
// degrees (the CSS reads --tier-h); position jitters so repeated volleys spread.
function burstSparks(host, hueDeg, big = false) {
    if (!host) return;
    const burst = document.createElement('div');
    burst.className = 'fx-burst';
    burst.style.setProperty('--tier-h', hueDeg);
    burst.style.left = `${28 + Math.random() * 44}%`;
    burst.style.top = `${30 + Math.random() * 28}%`;
    const ring = document.createElement('div'); ring.className = 'fx-ring'; burst.appendChild(ring);
    const N = big ? 20 : 14;
    for (let i = 0; i < N; i++) {
        const sp = document.createElement('div'); sp.className = 'spark';
        sp.style.setProperty('--a', `${(360 / N) * i + (Math.random() * 22 - 11)}deg`);
        sp.style.setProperty('--d', `${80 + Math.random() * 70}px`);
        sp.style.animationDelay = `${Math.random() * 90}ms`;
        burst.appendChild(sp);
    }
    host.appendChild(burst);
    setTimeout(() => burst.remove(), 1300);
}

// Swap the board image only when the rev changes, preloading first to avoid flicker.
function swapBoard(rev) {
    if (rev == null || rev === lastBoardRev) return;
    lastBoardRev = rev;
    const url = `/tournament/live/board?rev=${rev}`;
    boardImg.onload = () => {
        const wrap = $('spec-board');
        if (!wrap) return;
        wrap.innerHTML = '';
        boardImg.id = 'board-img';
        wrap.appendChild(boardImg);
    };
    boardImg.onerror = () => {};
    boardImg.src = url;
}

// ── idle view: the live analytics dashboard, broadcast-styled ────────────────
// Ported natively from the game's dashboard (js/dashboard.js) so it matches the
// spectator's cinematic look: headline highlights, the hand-rolled ELO-over-time
// chart, standings, and a head-to-head grid — all from one /stats/dashboard poll.
async function renderIdle() {
    const now = Date.now();
    if (mode === 'idle' && now - lastIdleAt < IDLE_REFRESH_MS) return; // throttle
    lastIdleAt = now;

    if (mode !== 'idle') {
        mode = 'idle';
        stopCamera();
        stopCutaway();
        stopFrameStream();   // no live match → stop draining growth frames
        const body = $('spec-body');
        body.classList.remove('live');
        body.classList.add('idle');
        body.innerHTML = `
            <div class="dash">
                <div class="dash-highlights" id="dh-hl"></div>
                <div class="dash-grid">
                    <div class="panel dash-chart-panel">
                        <div class="panel-label">ELO progression</div>
                        <svg id="dh-chart" class="dash-chart" preserveAspectRatio="xMidYMid meet" viewBox="0 0 920 420"></svg>
                    </div>
                    <div class="panel dash-standings-panel">
                        <div class="panel-label">Standings</div>
                        <div class="dash-lb-scroll"><table class="dash-lb" id="dh-lb"></table></div>
                    </div>
                    <div class="panel dash-h2h-panel">
                        <div class="panel-label">Head to head</div>
                        <div class="dash-h2h" id="dh-h2h"></div>
                    </div>
                </div>
            </div>`;
    }
    $('spec-sub').textContent = 'standings & analytics';

    try {
        const d = await (await fetch('/stats/dashboard', { cache: 'no-store' })).json();
        if (!d.totals?.matches) {
            $('dh-hl').innerHTML = '<div class="board-empty">no games played yet</div>';
            return;
        }
        renderHighlights(d.highlights || {}, d.leaderboard || []);
        renderEloChart($('dh-chart'), d.timeline || {}, d.leaderboard || []);
        renderDashStandings(d.leaderboard || []);
        renderH2H(d.head_to_head || [], d.leaderboard || []);
    } catch { /* leave whatever's there */ }
}

function paintAvatars(scope) { scope?.querySelectorAll?.('[data-model]').forEach(el => applyAvatar(el, el.dataset.model)); }

function renderHighlights(h, leaderboard) {
    const card = (icon, label, name, detail, model) => `
        <div class="dh-card" style="--bh:${hueOf(model)}">
            <div class="dh-ic">${icon}</div>
            <div class="dh-cbody">
                <div class="dh-clabel">${label}</div>
                <div class="dh-cname"><span class="dh-ava" data-model="${model}"></span>${short(name)}</div>
                <div class="dh-cdetail">${detail}</div>
            </div>
        </div>`;
    const leader = leaderboard[0], cards = [];
    if (leader) cards.push(card('👑', 'CHAMPION', leader.model, `${leader.elo} ELO`, leader.model));
    if (h.most_improved && h.most_improved.gain > 0) cards.push(card('📈', 'MOST IMPROVED', h.most_improved.model, `+${h.most_improved.gain} from 1000`, h.most_improved.model));
    if (h.biggest_upset) cards.push(card('⚡', 'BIGGEST UPSET', h.biggest_upset.model, `beat ${short(h.biggest_upset.opponent)} · ${Math.round(h.biggest_upset.win_prob * 100)}% odds`, h.biggest_upset.model));
    if (h.hot_streak) cards.push(card('🔥', 'HOT STREAK', h.hot_streak.model, `${h.hot_streak.streak} in a row`, h.hot_streak.model));
    else if (h.peak) cards.push(card('🏔', 'PEAK ELO', h.peak.model, `${h.peak.peak_elo} all-time`, h.peak.model));
    const host = $('dh-hl'); host.innerHTML = cards.join(''); paintAvatars(host);
}

// Hand-rolled ELO-over-time SVG (ported from dashboard.js, non-interactive).
function renderEloChart(svg, timeline, leaderboard) {
    if (!svg) return;
    const W = 920, H = 420, m = { t: 20, r: 132, b: 34, l: 48 };
    svg.innerHTML = '';
    const shown = leaderboard.map(r => r.model).filter(mm => timeline[mm]?.length).slice(0, CHART_TOP);
    if (!shown.length) { svgText(svg, W / 2, H / 2, 'No matches yet', 'dh-axis-title', 'middle'); return; }
    const series = {}; let xMax = 1, yMin = Infinity, yMax = -Infinity;
    for (const model of shown) {
        const pts = [{ n: 0, elo: 1000 }, ...timeline[model].map(p => ({ n: p.n, elo: p.elo }))];
        series[model] = pts;
        for (const p of pts) { xMax = Math.max(xMax, p.n); yMin = Math.min(yMin, p.elo); yMax = Math.max(yMax, p.elo); }
    }
    const pad = Math.max(20, Math.round((yMax - yMin) * 0.08)); yMin -= pad; yMax += pad;
    const px = (n) => m.l + (n / xMax) * (W - m.l - m.r);
    const py = (e) => m.t + (1 - (e - yMin) / (yMax - yMin)) * (H - m.t - m.b);
    for (const v of niceTicks(yMin, yMax, 5)) { svgLine(svg, m.l, py(v), W - m.r, py(v), 'dh-grid'); svgText(svg, m.l - 8, py(v) + 4, Math.round(v), 'dh-axis-label', 'end'); }
    if (1000 >= yMin && 1000 <= yMax) svgLine(svg, m.l, py(1000), W - m.r, py(1000), 'dh-grid dh-grid-base');
    for (const v of niceTicks(0, xMax, Math.min(8, xMax))) svgText(svg, px(v), H - m.b + 18, Math.round(v), 'dh-axis-label', 'middle');
    svgText(svg, m.l, H - 5, 'games played →', 'dh-axis-title', 'start');
    for (const model of shown) {
        const pts = series[model], hue = hueOf(model);
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${px(p.n).toFixed(1)},${py(p.elo).toFixed(1)}`).join(' ');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d); path.setAttribute('fill', 'none');
        path.setAttribute('stroke', `hsl(${hue},70%,60%)`); path.setAttribute('stroke-width', 2);
        path.setAttribute('stroke-linejoin', 'round'); path.setAttribute('stroke-linecap', 'round');
        svg.appendChild(path);
        const last = pts[pts.length - 1], cx = px(last.n), cy = py(last.elo);
        const dotEl = document.createElementNS(SVG_NS, 'circle');
        dotEl.setAttribute('cx', cx); dotEl.setAttribute('cy', cy); dotEl.setAttribute('r', 3.5);
        dotEl.setAttribute('fill', `hsl(${hue},75%,62%)`); svg.appendChild(dotEl);
        svgText(svg, cx + 7, cy + 4, `${short(model)} ${last.elo}`, 'dh-end').setAttribute('fill', `hsl(${hue},70%,72%)`);
    }
}

function renderDashStandings(rows) {
    const lb = $('dh-lb'); if (!lb) return;
    if (!rows.length) { lb.innerHTML = '<tbody><tr><td class="dh-empty">No matches yet</td></tr></tbody>'; return; }
    let html = '<thead><tr><th>#</th><th>Model</th><th>ELO</th><th>W–L</th><th>Win%</th><th>Strk</th></tr></thead><tbody>';
    for (const r of rows) {
        const rm = resolveModel(r.model);
        const medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : r.rank;
        const streak = r.streak > 0 ? `<span class="dh-sw">${r.streak}W</span>` : r.streak < 0 ? `<span class="dh-sl">${-r.streak}L</span>` : '·';
        html += `<tr style="--bh:${rm.hue}">
            <td class="dh-lb-rank">${medal}</td>
            <td class="dh-lb-model"><span class="dh-ava dh-ava-sm" data-model="${r.model}"></span><span class="dh-lb-id"><b>${short(r.model)}</b><i>${rm.family.label} · ${paramLabel(r.model)}</i></span></td>
            <td class="dh-lb-elo">${r.elo}</td>
            <td class="dh-lb-wl"><b>${r.wins}</b>-${r.losses}</td>
            <td class="dh-lb-wr">${r.winrate}%</td>
            <td>${streak}</td>
        </tr>`;
    }
    html += '</tbody>'; lb.innerHTML = html; paintAvatars(lb);
}

function renderH2H(pairs, leaderboard) {
    const host = $('dh-h2h'); if (!host) return;
    const models = leaderboard.slice(0, 8).map(r => r.model);
    if (models.length < 2) { host.innerHTML = '<div class="dh-empty">Not enough matchups yet</div>'; return; }
    const wins = {}; for (const mm of models) wins[mm] = {};
    for (const p of pairs) { if (wins[p.a] && p.b in wins) wins[p.a][p.b] = p.a_wins; if (wins[p.b] && p.a in wins) wins[p.b][p.a] = p.b_wins; }
    let html = '<table class="dh-h2h-table"><thead><tr><th></th>';
    for (const c of models) html += `<th><span class="dh-ava dh-ava-xs" data-model="${c}"></span></th>`;
    html += '</tr></thead><tbody>';
    for (const rn of models) {
        html += `<tr><td class="dh-h2h-row"><span class="dh-ava dh-ava-xs" data-model="${rn}"></span>${short(rn)}</td>`;
        for (const c of models) {
            if (rn === c) { html += '<td class="dh-h2h-self"></td>'; continue; }
            const w = wins[rn]?.[c] ?? 0, l = wins[c]?.[rn] ?? 0, total = w + l;
            if (!total) { html += '<td class="dh-h2h-none">·</td>'; continue; }
            const ratio = w / total, hue = ratio >= 0.5 ? 140 : 0, alpha = (0.12 + Math.abs(ratio - 0.5) * 0.9).toFixed(2);
            html += `<td class="dh-h2h-cell" style="background:hsla(${hue},60%,45%,${alpha})" title="${short(rn)} ${w}–${l} vs ${short(c)}">${w}-${l}</td>`;
        }
        html += '</tr>';
    }
    html += '</tbody></table>'; host.innerHTML = html; paintAvatars(host);
}

// ── SVG + tick helpers (ported from dashboard.js) ────────────
function svgLine(svg, x1, y1, x2, y2, cls) {
    const l = document.createElementNS(SVG_NS, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    if (cls) l.setAttribute('class', cls); svg.appendChild(l); return l;
}
function svgText(svg, x, y, str, cls, anchor) {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', x); t.setAttribute('y', y);
    if (cls) t.setAttribute('class', cls); if (anchor) t.setAttribute('text-anchor', anchor);
    t.textContent = str; svg.appendChild(t); return t;
}
function niceTicks(min, max, count) {
    if (max <= min) return [min];
    const step = niceNum((max - min) / count, true);
    const out = []; for (let v = Math.ceil(min / step) * step; v <= max + 1e-6; v += step) out.push(Math.round(v));
    return out;
}
function niceNum(range, round) {
    const exp = Math.floor(Math.log10(range)), frac = range / 10 ** exp;
    const nf = round ? (frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10) : (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10);
    return nf * 10 ** exp;
}

// ── recent-results ticker (both views) ───────────────────────
async function refreshTicker() {
    const now = Date.now();
    if (now - lastTickerAt < TICKER_MS) return;
    lastTickerAt = now;
    try {
        const matches = await (await fetch('/stats/matches?limit=8', { cache: 'no-store' })).json();
        $('spec-ticker').innerHTML = (matches || []).map(m => {
            const ws = m.winner === m.p1 ? m.p1_score : m.p2_score;
            const ls = m.winner === m.p1 ? m.p2_score : m.p1_score;
            return `<span class="tk-item"><b>${short(m.winner)}</b> <span class="tk-loser">def. ${short(m.loser)}</span><span class="tk-sc">${Math.round(ws)}–${Math.round(ls)}</span></span>`;
        }).join('');
    } catch { /* leave prior ticker */ }
}

// Refit the camera (and idle bracket) when the window resizes across sizes.
let _rz;
window.addEventListener('resize', () => {
    clearTimeout(_rz);
    _rz = setTimeout(() => { if (mode === 'live') positionCamera(false); }, 160);
});

poll();
setInterval(poll, POLL_MS);
setInterval(tickClock, 200);   // smooth local countdown for the move clock
