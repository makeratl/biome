// Training Lab — generate / curate / export UI. Talks to the server's
// /trajectory/* endpoints and the Ollama proxy. Vanilla DOM, no deps.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ── tabs ────────────────────────────────────────────────────────────────
$('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
    $$('.view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== b.dataset.tab));
    stopDashboard();
    stopTrain();
    if (b.dataset.tab === 'curate') loadTurns();
    if (b.dataset.tab === 'dashboard') startDashboard();
    if (b.dataset.tab === 'train') enterTrain();
});

// ── DASHBOARD (default; auto-refreshes with live "win moments") ────────────
let _dbTimer = null;
let _prev = null;        // last snapshot, for delta detection between refreshes
let _lastChange = 0;     // ts of the last refresh that saw new data (live indicator)
let _built = false;      // dashboard skeleton built once; refreshes patch in place
let _teachersKey = '';   // last-rendered by-model signature (skip rebuild if unchanged)
const GOAL_LABEL = { smoke: 'Smoke train', ladder: 'Ladder attempt', robust: 'Robust set' };
const GOAL_ORDER = ['smoke', 'ladder', 'robust'];
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Tween a numeric element from its last value to `to` (ease-out cubic).
function animateCount(el, to) {
    const from = Number(el.dataset.v || 0);
    el.dataset.v = to;
    if (REDUCE || from === to) { el.textContent = to; return; }
    const dur = 700, t0 = performance.now(), ease = (x) => 1 - Math.pow(1 - x, 3);
    (function step(now) {
        const p = Math.min(1, (now - t0) / dur);
        el.textContent = Math.round(from + (to - from) * ease(p));
        if (p < 1) requestAnimationFrame(step); else el.textContent = to;
    })(t0);
}

// A short-lived "+N" tag that rises out of an anchor element.
function ping(anchor, text, small = false) {
    if (!anchor || REDUCE) return;
    const el = document.createElement('div');
    el.className = 'ping' + (small ? ' small' : '');
    el.textContent = text;
    anchor.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
}

// Restart a one-shot CSS animation class on an element.
function flash(el, cls) {
    if (!el || REDUCE) return;
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
}

// In-place patch helpers — only touch the DOM when the value actually changed,
// so CSS transitions / count-ups fire on change and stay still otherwise.
function setText(el, v) { if (el && el.textContent !== String(v)) el.textContent = v; }
function setStyleIf(el, prop, v) { if (el && el.style[prop] !== v) el.style[prop] = v; }

// A burst of confetti from the centre of `originEl` (gravity-pulled, varied).
function confettiBurst(originEl, n) {
    const layer = document.getElementById('fx-layer');
    if (REDUCE || !layer || !originEl) return;
    const r = originEl.getBoundingClientRect();
    const ox = r.left + r.width / 2, oy = r.top + r.height / 2;
    const colors = ['hsl(45,95%,62%)', 'hsl(38,95%,55%)', 'hsl(190,80%,60%)', '#ffffff', 'hsl(140,62%,60%)'];
    for (let i = 0; i < n; i++) {
        const c = document.createElement('i');
        c.className = 'confetti';
        const ang = Math.random() * Math.PI * 2, power = 80 + Math.random() * 170;
        c.style.left = `${ox}px`; c.style.top = `${oy}px`;
        c.style.background = colors[i % colors.length];
        c.style.setProperty('--dx', `${(Math.cos(ang) * power).toFixed(0)}px`);
        c.style.setProperty('--dy', `${(Math.sin(ang) * power + 220).toFixed(0)}px`);
        c.style.setProperty('--rot', `${(Math.random() * 720 - 360).toFixed(0)}deg`);
        c.style.setProperty('--dur', `${(1 + Math.random() * 0.8).toFixed(2)}s`);
        layer.appendChild(c);
        c.addEventListener('animationend', () => c.remove());
    }
}

function goalToast(text) {
    const el = document.createElement('div');
    el.className = 'goal-toast';
    el.textContent = text;
    document.body.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
}

// Medal podium — gold/silver/bronze bars, heights proportional to count. Built
// once (buildPodium); each refresh patches counts + heights in place so the
// count-up only runs on a real change. Gold carries the headline count (#db-gold).
function buildPodium() {
    const tiers = [['gold', '🥇', 'Gold', 'trained'], ['silver', '🥈', 'Silver', 'logged'], ['bronze', '🥉', 'Bronze', 'logged']];
    $('#db-podium').innerHTML = tiers.map(([key, em, lab, sub]) => `
        <div class="pod pod-${key}">
            <div class="pod-n" id="${key === 'gold' ? 'db-gold' : 'pod-n-' + key}">0</div>
            <div class="pod-bar-wrap"><div class="pod-bar" id="pod-bar-${key}" style="height:14px"></div></div>
            <div class="pod-foot"><span class="pod-em">${em}</span><span>${lab}</span></div>
            <div class="pod-sub">${sub}</div>
        </div>`).join('');
}
function updatePodium(s) {
    const max = Math.max(1, s.gold, s.silver, s.bronze);
    const h = (n) => 14 + Math.round((n / max) * 96) + 'px';   // px fill in a 110px track
    animateCount($('#db-gold'), s.gold);
    animateCount($('#pod-n-silver'), s.silver);
    animateCount($('#pod-n-bronze'), s.bronze);
    setStyleIf($('#pod-bar-gold'), 'height', h(s.gold));
    setStyleIf($('#pod-bar-silver'), 'height', h(s.silver));
    setStyleIf($('#pod-bar-bronze'), 'height', h(s.bronze));
}

// Goals by TRAINING SET — three cumulative datasets the user might train on, each
// racing the same goals (smoke/ladder/robust are dataset-size targets):
//   Champion = gold only · Contender = gold+silver · Player = any medal.
// A LOG scale keeps the small early counts visible and the three tiers distinct
// across the wide 300→10k range. Shared milestone gridlines span all three lanes.
const SET_TIERS = [
    { key: 'champion',  label: 'Champion',  em: '🥇', note: 'gold only', val: s => s.gold },
    { key: 'contender', label: 'Contender', em: '🥈', note: '+ silver',  val: s => s.gold + s.silver },
    { key: 'player',    label: 'Player',    em: '🥉', note: '+ bronze',  val: s => s.gold + s.silver + s.bronze },
];
function _goals(s) { return GOAL_ORDER.map(k => ({ key: k, label: GOAL_LABEL[k], val: s.goals[k] })); }
const _fmtGoal = (n) => n >= 1000 ? (n % 1000 === 0 ? (n / 1000) + 'k' : (n / 1000).toFixed(1) + 'k') : '' + n;
// Honest LINEAR progress toward the tier's next unmet goal: pct = count / nextGoal.
// 29 of 300 reads as ~10%, not the ~40% the old log scale faked. The little goal
// pips carry the full Smoke/Ladder/Robust ladder without distorting the bar.
function laneState(v, goals) {
    const next = goals.find(g => v < g.val);
    const done = goals.filter(g => v >= g.val).length;
    if (!next) return { pct: 100, target: goals[goals.length - 1], done, complete: true };
    return { pct: Math.max(0, Math.min(100, v / next.val * 100)), target: next, done, complete: false };
}
function buildRail(s) {
    const goals = _goals(s);
    const lanes = SET_TIERS.map(t => {
        const pips = goals.map(g => `<i class="pip" title="${esc(g.label)} — ${g.val.toLocaleString()}"></i>`).join('');
        return `
        <div class="rail-lane lane-${t.key}">
            <span class="lane-label"><span class="lane-em">${t.em}</span>${t.label}<span class="lane-note">${t.note}</span></span>
            <span class="lane-track"><i class="lane-fill" id="lane-fill-${t.key}" style="width:0%"></i></span>
            <span class="lane-pips" id="lane-pips-${t.key}">${pips}</span>
            <span class="lane-val"><b id="lane-n-${t.key}">0</b><span class="lane-cap" id="lane-cap-${t.key}"></span></span>
        </div>`;
    }).join('');
    $('#db-rail').innerHTML = `<div class="rail-lanes">${lanes}</div>`;
}
function updateRail(s) {
    const goals = _goals(s);
    for (const t of SET_TIERS) {
        const v = t.val(s);
        const st = laneState(v, goals);
        setStyleIf($('#lane-fill-' + t.key), 'width', st.pct.toFixed(1) + '%');
        animateCount($('#lane-n-' + t.key), v);
        setText($('#lane-cap-' + t.key),
            st.complete ? `/ ${_fmtGoal(st.target.val)} · all goals ✓` : `/ ${_fmtGoal(st.target.val)} · to ${st.target.label}`);
        const pipsEl = $('#lane-pips-' + t.key);
        if (pipsEl) [...pipsEl.children].forEach((dot, i) => {
            dot.classList.toggle('on', i < st.done);
            dot.classList.toggle('next', !st.complete && i === st.done);
        });
    }
}

// Operational tiles — built once; refreshes patch the values only when changed.
const TILE_DEFS = [
    ['matches', 'Matches', 'Completed matches with a recorded outcome.'],
    ['turns', 'Turns', 'Total model turns captured across all matches.'],
    ['won', 'Winning turns', 'Turns played by the side that went on to win the match (quality-agnostic).'],
    ['goldrate', 'Gold rate', 'Share of all captured turns certified GOLD: a real answer on the WINNING side that grew its score lead AND improved trophic balance. The only tier auto-queued for training — your trainable signal yield per turn.'],
    ['fbrate', 'Fallback rate', 'Share of turns where the model gave no usable move and the deterministic fallback (plant grass) stepped in. Never a medal — a teacher-reliability signal.'],
    ['seeds', 'Distinct seeds', 'Unique map seeds = data diversity. More varied boards → a more generalizable training set.'],
];
function buildTiles() {
    $('#db-tiles').innerHTML = TILE_DEFS.map(([key, k, tip]) =>
        `<div class="tile" data-key="${key}" title="${esc(tip)}"><div class="tile-v" id="tile-${key}">—</div><div class="tile-k">${k}</div></div>`).join('');
}
function updateTiles(s) {
    const rate = (n) => s.turns ? Math.round((n / s.turns) * 100) + '%' : '0%';
    setText($('#tile-matches'), s.matches);
    setText($('#tile-turns'), s.turns);
    setText($('#tile-won'), s.won_turns);
    setText($('#tile-goldrate'), rate(s.gold));
    setText($('#tile-fbrate'), rate(s.fallback_turns));
    setText($('#tile-seeds'), s.distinct_seeds);
}

// Per-teacher stacked quality bars (gold · silver · bronze), sorted by gold then total.
// Re-renders only when the by-model data actually changed (no static bars to churn).
function renderTeachers(s) {
    const sig = JSON.stringify([s.gold_by_model, s.silver_by_model, s.bronze_by_model]);
    if (sig === _teachersKey) return;
    _teachersKey = sig;
    const names = new Set([
        ...Object.keys(s.gold_by_model || {}),
        ...Object.keys(s.silver_by_model || {}),
        ...Object.keys(s.bronze_by_model || {}),
    ]);
    const rows = [...names].map(m => {
        const g = (s.gold_by_model || {})[m] || 0;
        const sv = (s.silver_by_model || {})[m] || 0;
        const b = (s.bronze_by_model || {})[m] || 0;
        return { m, g, sv, b, total: g + sv + b };
    }).sort((a, b) => b.g - a.g || b.total - a.total);
    const el = $('#db-bymodel');
    if (!rows.length) {
        el.classList.add('muted');
        el.innerHTML = 'No medals yet — run a batch or play a tournament.';
        return;
    }
    el.classList.remove('muted');
    const max = Math.max(1, ...rows.map(r => r.total));
    const seg = (n) => n > 0 ? `width:${(n / max) * 100}%` : 'display:none';
    el.innerHTML = rows.map(r => `
        <div class="bm-row">
            <span class="bm-name" title="${esc(r.m)}">${esc(r.m)}</span>
            <span class="bm-bar" title="${r.g} gold · ${r.sv} silver · ${r.b} bronze">
                <i class="seg-gold" style="${seg(r.g)}"></i><i class="seg-silver" style="${seg(r.sv)}"></i><i class="seg-bronze" style="${seg(r.b)}"></i>
            </span>
            <span class="bm-counts"><b>${r.g}</b>·${r.sv}·${r.b}</span>
        </div>`).join('');
}

async function loadDashboard() {
    let s;
    try { s = await (await fetch('/trajectory/stats')).json(); } catch { return; }

    const first = _prev === null;
    const dGold = first ? 0 : s.gold - _prev.gold;
    const dTurns = first ? 0 : s.turns - _prev.turns;
    const dMatches = first ? 0 : s.matches - _prev.matches;

    if (!_built) { buildPodium(); buildRail(s); buildTiles(); _built = true; }
    updatePodium(s);     // idempotent — count-ups only fire on a real change
    updateRail(s);
    updateTiles(s);
    renderTeachers(s);

    // ── win moments ──────────────────────────────────────────────────────
    if (!first && dGold > 0) {
        // New gold is the headline celebration (it's the trainable tier).
        flash($('.hero'), 'pop');
        ping($('.hero'), `+${dGold} GOLD`);
        confettiBurst($('.hero'), Math.min(60, 22 + dGold * 8));
    } else if (!first && (dTurns > 0 || dMatches > 0)) {
        // New data, not yet gold: a gentler "it's flowing" beat.
        if (dTurns > 0) { const t = $('.tile[data-key="turns"]'); flash(t, 'bump'); ping(t, `+${dTurns}`, true); }
        if (dMatches > 0) flash($('.tile[data-key="matches"]'), 'bump');
    }
    // A training set crossing a goal is a milestone for THAT tier — celebrate each.
    if (!first) {
        for (const t of SET_TIERS) {
            const cur = t.val(s), prv = t.val(_prev);
            for (const g of _goals(s)) {
                if (prv < g.val && cur >= g.val) {
                    goalToast(`🎉 ${t.label} set hit ${g.label} — ${g.val.toLocaleString()}!`);
                    flash($('.lane-' + t.key), 'lane-flash');
                }
            }
        }
    }

    if (!first && (dGold > 0 || dTurns > 0 || dMatches > 0)) _lastChange = performance.now();
    const liveOn = _lastChange && (performance.now() - _lastChange) < 30000;
    $('#db-live').classList.toggle('on', !!liveOn);
    $('#db-live-text').textContent = liveOn ? 'capturing' : 'idle';
    $('#db-refresh').textContent = 'auto-refresh · updated ' + new Date().toLocaleTimeString();

    _prev = { gold: s.gold, silver: s.silver, bronze: s.bronze, turns: s.turns, matches: s.matches, won_turns: s.won_turns };
}
function startDashboard() { loadDashboard(); clearInterval(_dbTimer); _dbTimer = setInterval(loadDashboard, 5000); }
function stopDashboard() { clearInterval(_dbTimer); _dbTimer = null; }

// ── shared: model list ────────────────────────────────────────────────────
async function fetchModels() {
    try {
        const r = await fetch('/ollama/api/tags');
        const d = await r.json();
        return (d.models || []).map(m => m.name).sort();
    } catch { return []; }
}

// ── GENERATE ──────────────────────────────────────────────────────────────
async function initGenerate() {
    try {
        const c = await (await fetch('/trajectory/champion')).json();
        $('#champ').innerHTML = c.champion
            ? `🏆 ${esc(c.champion)} — <span class="elo">${c.stats.elo} ELO</span> (${c.stats.wins}W–${c.stats.losses}L)`
            : 'No champion yet — play some matches first.';
    } catch { $('#champ').textContent = 'champion unavailable'; }

    const models = await fetchModels();
    for (const sel of ['#gen-p1', '#gen-p2', '#filter-model']) {
        const el = $(sel);
        if (!el) continue;
        if (sel === '#filter-model') { /* keep "any" */ }
        for (const m of models) {
            const o = document.createElement('option'); o.value = m; o.textContent = m; el.appendChild(o);
        }
    }
    if (models[1]) { $('#gen-p1').value = models[0]; $('#gen-p2').value = models[1]; }

    const rebuild = () => {
        const mode = $('#gen-mode').value;
        const n = Math.max(1, parseInt($('#gen-matches').value || '1', 10));
        $('#watch-models').classList.toggle('hidden', mode !== 'watch');
        let env = `BIOME_GEN=${mode} BIOME_MATCHES=${n} BIOME_TIMEOUT=3600`;
        if (mode === 'watch') env = `BIOME_GEN=watch BIOME_P1="${$('#gen-p1').value}" BIOME_P2="${$('#gen-p2').value}" BIOME_MATCHES=${n} BIOME_TIMEOUT=1200`;
        $('#gen-cmd').textContent = `${env} \\\n  node .claude/skills/run-biome/dev-session.mjs generate`;
    };
    ['#gen-mode', '#gen-p1', '#gen-p2', '#gen-matches'].forEach(s => $(s).addEventListener('input', rebuild));
    rebuild();
}

// ── CURATE ──────────────────────────────────────────────────────────────
let _selUid = null;

async function loadTurns() {
    const gold = $('#gold-only').checked ? '&gold=1' : '';
    const model = $('#filter-model').value ? `&model=${encodeURIComponent($('#filter-model').value)}` : '';
    let d;
    try { d = await (await fetch(`/trajectory/list?limit=300${gold}${model}`)).json(); }
    catch { $('#turn-list').innerHTML = '<p class="muted">server unavailable</p>'; return; }
    $('#curate-count').textContent = `${d.turns.length} shown / ${d.total} total`;
    const list = $('#turn-list');
    list.innerHTML = '';
    if (!d.turns.length) { list.innerHTML = '<p class="muted">No turns captured yet. Run a generation batch.</p>'; return; }
    for (const t of d.turns) {
        const row = document.createElement('div');
        row.className = 'turn-row' + (t.medal ? ' ' + t.medal : '') + (t.decision === 'reject' ? ' rej' : '');
        row.dataset.uid = t.turn_uid;
        const badges = [
            t.medal ? `<span class="badge ${t.medal}">${t.medal.toUpperCase()}</span>` : '',
            t.won_match ? '<span class="badge won">WON</span>' : '',
            t.fallback_reason ? `<span class="badge fb">${esc(t.fallback_reason)}</span>` : '',
        ].join(' ');
        row.innerHTML = `
            <div class="tr-head"><span class="tr-model">${esc(t.model)}</span>${badges}</div>
            <div class="tr-meta">r${t.round} · P${t.player} · vs ${esc(t.opponent_model || '—')} · ${esc(t.trophic_state || '')}</div>
            <div class="tr-reason">${esc(t.reasoning) || '<i>no reasoning</i>'}</div>
            <div class="scorebar"><i style="width:${Math.round((t.label_score || 0) * 100)}%"></i></div>`;
        row.addEventListener('click', () => selectTurn(t.turn_uid, row));
        list.appendChild(row);
    }
}

async function selectTurn(uid, row) {
    _selUid = uid;
    $$('.turn-row').forEach(r => r.classList.toggle('sel', r === row));
    const d = $('#turn-detail');
    d.innerHTML = '<p class="muted">loading…</p>';
    let data;
    try { data = await (await fetch(`/trajectory/detail?uid=${encodeURIComponent(uid)}`)).json(); }
    catch { d.innerHTML = '<p class="muted">failed to load</p>'; return; }
    const t = data.turn, l = data.label;
    const raw = (t.response_raw || {}).content || '(no answer — fallback)';
    d.innerHTML = `
        <div class="detail-actions">
            <button class="star" data-dec="gold">★ keep</button>
            <button class="rej" data-dec="reject">✕ reject</button>
        </div>
        <div class="kv">
            <span><b>${esc(t.model)}</b> P${t.player} · round ${t.round}/${t.total_rounds}</span>
            <span>won: <b>${l.won_match}</b></span>
            <span>label: <b>${l.label_score}</b></span>
            <span>margin: <b>${l.margin_norm}</b></span>
            <span>trophic: <b>${esc(l.trophic_state)}</b> ${l.trophic_improved ? '↑' : ''}</span>
            <span>medal: <b>${esc(l.medal || '—')}</b></span>
            <span>seed: ${t.seed}</span>
        </div>
        <div class="block"><h4>Model answer (verbatim)</h4><pre>${esc(raw)}</pre></div>
        <div class="block"><h4>Executed placements</h4><pre>${esc((t.exec || []).map(e => `${e.ok ? '✓' : '✕'} ${e.species || ''} (${e.col},${e.row}) ${e.msg || ''}`).join('\n') || '—')}</pre></div>
        <div class="block"><h4>User prompt (the state the model saw)</h4><pre>${esc(t.prompt?.user || '')}</pre></div>
        <div class="block"><details><summary>System prompt (rules)</summary><pre>${esc(t.prompt?.system || '')}</pre></details></div>`;
    // reflect current manual decision
    if (row?.classList.contains('rej')) $('.rej', d)?.classList.add('on');
    $$('.detail-actions button', d).forEach(b => b.addEventListener('click', () => label(uid, b.dataset.dec, b)));
}

async function label(uid, decision, btn) {
    try {
        await fetch('/trajectory/label', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ turn_uid: uid, decision }),
        });
    } catch {}
    $$('.detail-actions button').forEach(b => b.classList.toggle('on', b === btn));
    // reflect in the list row
    const r = $(`.turn-row[data-uid="${uid}"]`);
    if (r) { r.classList.toggle('rej', decision === 'reject'); r.classList.toggle('gold', decision === 'gold'); }
}

$('#reload').addEventListener('click', loadTurns);
$('#gold-only').addEventListener('change', loadTurns);
$('#filter-model').addEventListener('change', loadTurns);

// ── EXPORT ──────────────────────────────────────────────────────────────
$('#build-btn').addEventListener('click', async () => {
    $('#manifest').textContent = 'building…';
    try {
        const m = await (await fetch('/trajectory/export')).json();
        $('#manifest').textContent = JSON.stringify(m, null, 2);
    } catch { $('#manifest').textContent = 'export failed'; }
});

$('#purge-btn').addEventListener('click', async () => {
    const mode = $('#purge-mode').value;
    if (!confirm(`Compact logs (mode: ${mode})? Originals are backed up to *.jsonl.bak.`)) return;
    $('#purge-out').textContent = 'compacting…';
    try {
        const r = await (await fetch('/trajectory/purge', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode }),
        })).json();
        $('#purge-out').textContent = JSON.stringify(r, null, 2);
    } catch { $('#purge-out').textContent = 'purge failed'; }
});

// ── TRAIN ─────────────────────────────────────────────────────────────────
// One-click distill: pick tier + student base + tag → server exports the tiered
// dataset, runs tools/train_biome.py as a managed job, and (on success) registers
// biome-<tag> via ollama create. Talks to /training/{preflight,start,status,cancel,runs}.
let _trTier = 'champion';
let _trPreflight = null;
let _trPfTimer = null;
let _trStatusTimer = null;
let _trActive = false;       // a run is live → status polling drives the progress card

const TR_TIER_META = {
    champion:  { em: '🥇', label: 'Champion',  note: 'gold only', caveat: 'Real answer on the WINNING side that grew its lead and improved balance — purest signal.' },
    contender: { em: '🥈', label: 'Contender', note: '+ silver',  caveat: 'Adds 2-signal moves from the LOSING side — broader, noisier teacher.' },
    player:    { em: '🥉', label: 'Player',     note: '+ bronze',  caveat: 'Adds single-signal moves — highest volume, lowest purity. Experimental.' },
};
const TR_PHASES = ['exporting', 'training', 'packaging', 'registering', 'done'];
const TR_PHASE_LABEL = { exporting: 'Export', training: 'Train', packaging: 'GGUF', registering: 'Register', done: 'Done' };

// The HF base id: the picked dropdown value, or the custom text field when "Other".
function effectiveBase() {
    const sel = $('#tr-base-sel').value;
    return sel === '__custom__' ? ($('#tr-base').value || '').trim() : sel;
}
// family/size hints from the selected curated option (authoritative; blank for custom).
function trBaseInfo() {
    const sel = $('#tr-base-sel');
    const opt = sel.options[sel.selectedIndex];
    if (!opt || opt.value === '__custom__') return { base: effectiveBase(), family: '', size: '' };
    return { base: opt.value, family: opt.dataset.family || '', size: opt.dataset.size || '' };
}
let _trSuggest = null;   // last /training/suggest-name response (null when overridden)

// Server computes the structured name + lineage/version for the current base+tier.
async function refreshName() {
    const { base, family, size } = trBaseInfo();
    const meta = $('#tr-name-meta');
    const override = ($('#tr-name-override').value || '').trim();
    if (override) {
        const nm = override.startsWith('biome-') ? override : `biome-${override}`;
        setText($('#tr-modelname'), nm); meta.textContent = 'manual name'; _trSuggest = null;
        refreshTrGate(); return;
    }
    if (!base) {
        setText($('#tr-modelname'), 'biome-…'); meta.textContent = ''; _trSuggest = null;
        refreshTrGate(); return;
    }
    try {
        const qs = new URLSearchParams({ base, tier: _trTier, family, size });
        const s = await (await fetch(`/training/suggest-name?${qs}`)).json();
        if (($('#tr-name-override').value || '').trim()) return;   // user typed an override mid-fetch — don't clobber it
        if (s && s.name) {
            _trSuggest = s;
            setText($('#tr-modelname'), s.name);
            const parent = s.parent && s.parent.startsWith('biome-') ? s.parent : 'base';
            meta.textContent = `${s.lineage} · v${s.version} · from ${parent}`;
        } else {
            _trSuggest = null; setText($('#tr-modelname'), 'biome-…'); meta.textContent = s?.error || '';
        }
    } catch { meta.textContent = 'name preview unavailable'; }
    refreshTrGate();
}

function renderTrTiers(pf) {
    const rows = pf.rows_by_tier || {};
    $('#train-tiers').innerHTML = ['champion', 'contender', 'player'].map(k => {
        const m = TR_TIER_META[k];
        const n = rows[k] ?? 0;
        return `<button class="tier-card${k === _trTier ? ' on' : ''}" data-tier="${k}">
            <span class="tier-top"><span class="tier-em">${m.em}</span><b>${m.label}</b><span class="tier-note">${m.note}</span></span>
            <span class="tier-n">${n.toLocaleString()}<span class="tier-rows">rows</span></span>
            <span class="tier-caveat">${m.caveat}</span>
        </button>`;
    }).join('');
    $$('#train-tiers .tier-card').forEach(c => c.addEventListener('click', () => {
        _trTier = c.dataset.tier;
        renderTrTiers(_trPreflight || pf);
        refreshName();   // tier is part of the lineage → recompute the name/version
        refreshTrGate();
    }));
}

function renderPreflight(pf) {
    const dry = $('#tr-dry').checked;
    const minRows = pf.min_rows || 8;
    const rows = (pf.rows_by_tier || {})[_trTier] ?? 0;
    const checks = [
        { ok: pf.deps_ok, soft: dry, label: pf.deps_ok ? 'Training deps installed' : `Training deps missing — run <code>${esc(pf.pip_cmd || 'pip install unsloth trl datasets')}</code>` },
        { ok: !pf.tournament_running, label: pf.tournament_running ? 'A tournament job is active — wait or cancel it' : 'No tournament running' },
        { ok: !pf.training_running || _trActive, label: pf.training_running ? 'A training run is in progress' : 'No other training run' },
        { ok: !pf.gpu_busy, soft: dry, label: pf.gpu_busy
            ? `GPU busy${pf.gpu_holder ? ` — ${esc(pf.gpu_holder.name)} using ${(pf.gpu_holder.used_mb / 1024).toFixed(1)} GB` : ''} (free it to train)`
            : 'GPU has room for a run' },
        { ok: rows >= minRows, soft: dry, label: `${rows.toLocaleString()} rows in <b>${_trTier}</b> tier${rows < minRows ? ` — need ≥ ${minRows}` : ''}` },
    ];
    const gpu = pf.gpu_free_mb != null ? `${(pf.gpu_free_mb / 1024).toFixed(1)} GB VRAM free` : 'VRAM unknown';
    const resident = (pf.resident_models || []).length ? ` · resident: ${esc(pf.resident_models.join(', '))}` : '';
    $('#tr-preflight').innerHTML =
        checks.map(c => `<div class="pf-row ${c.ok ? 'ok' : (c.soft ? 'warn' : 'bad')}">
            <span class="pf-ic">${c.ok ? '✓' : (c.soft ? '•' : '✕')}</span><span>${c.label}</span></div>`).join('')
        + `<div class="pf-gpu muted small">${gpu}${resident}</div>`;
}

function refreshTrGate() {
    const pf = _trPreflight;
    if (!pf) return;
    renderPreflight(pf);
    const dry = $('#tr-dry').checked;
    const minRows = pf.min_rows || 8;
    const rows = (pf.rows_by_tier || {})[_trTier] ?? 0;
    const override = ($('#tr-name-override').value || '').trim();
    const nameOk = !!override || !!_trSuggest;        // an overridden or a server-suggested name
    const baseOk = !!effectiveBase();
    const hardOk = !pf.tournament_running && !pf.training_running;   // never bypassable
    const softOk = dry || (pf.deps_ok && rows >= minRows && !pf.gpu_busy);  // dry-run skips deps/rows/GPU
    $('#tr-start').disabled = !(baseOk && nameOk && hardOk && softOk && !_trActive);
}

async function loadPreflight() {
    let pf;
    try { pf = await (await fetch('/training/preflight')).json(); } catch { return; }
    _trPreflight = pf;
    renderTrTiers(pf);
    refreshTrGate();
}

async function loadTrRuns() {
    let d;
    try { d = await (await fetch('/training/runs')).json(); } catch { return; }
    const runs = d.runs || [];
    const el = $('#tr-runs');
    if (!runs.length) { el.classList.add('muted'); el.innerHTML = 'No runs yet.'; return; }
    el.classList.remove('muted');
    el.innerHTML = runs.map(r => {
        const when = r.finished ? new Date(r.finished * 1000).toLocaleString() : '—';
        const st = r.status === 'done' ? 'ok' : (r.status === 'failed' ? 'bad' : 'warn');
        const what = r.model ? `<code>${esc(r.model)}</code>` : (r.dry_run ? '<i>dry-run</i>' : '<i>—</i>');
        return `<div class="run-row ${st}">
            <span class="run-status">${esc(r.status)}</span>${what}
            <span class="run-meta muted small">${esc(r.tier)} · ${r.rows ?? '—'} rows · ${esc(r.base || '')}</span>
            <span class="run-when muted small">${when}</span>
            ${r.error ? `<span class="run-err">${esc(r.error)}</span>` : ''}
        </div>`;
    }).join('');
}

function renderRun(job) {
    if (!job) return;
    $('#tr-progress-card').classList.remove('hidden');
    const phase = job.phase || 'exporting';
    const failed = job.status === 'failed';
    const dry = job.config && job.config.dry_run;
    const phases = dry ? ['exporting', 'training', 'done'] : TR_PHASES;
    const curIdx = phases.indexOf(phase);
    $('#tr-stepper').innerHTML = phases.map((p, i) => {
        const done = phase === 'done' || i < curIdx;
        const state = failed ? (i < curIdx ? 'done' : (i === curIdx ? 'bad' : ''))
                             : (done ? 'done' : (i === curIdx ? 'cur' : ''));
        return `<span class="step ${state}">${TR_PHASE_LABEL[p]}</span>`;
    }).join('<span class="step-sep"></span>');
    const pg = job.progress || {};
    const pct = pg.total ? Math.round(pg.step / pg.total * 100) : (phase === 'done' ? 100 : 0);
    setStyleIf($('#tr-progbar-fill'), 'width', pct + '%');
    $('#tr-progbar-fill').className = failed ? 'bad' : (phase === 'done' ? 'done' : '');
    const bits = [];
    if (pg.total) bits.push(`step ${pg.step}/${pg.total}`);
    if (pg.loss != null) bits.push(`loss ${pg.loss.toFixed(3)}`);
    if (job.rows != null) bits.push(`${job.rows.toLocaleString()} rows`);
    setText($('#tr-progmeta'), bits.join(' · ') || phase);
    if (job.log != null) {   // slim recent omits log → keep last
        const logEl = $('#tr-log');
        // Stick to the bottom (tail -f) so new lines stay visible, but don't yank
        // the user back down if they've scrolled up to read earlier output.
        const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
        logEl.textContent = job.log;
        if (atBottom) logEl.scrollTop = logEl.scrollHeight;
    }
    const done = $('#tr-done');
    if (job.status === 'done') {
        done.classList.remove('hidden', 'bad');
        if (job.model) {
            done.innerHTML = `✓ <b>${esc(job.model)}</b> registered — now in the model pool.
                <button id="tr-eval" class="primary small">Evaluate vs ${esc((job.config.base || 'base').split('/').pop())} →</button>`;
            $('#tr-eval').addEventListener('click', () => evalNewModel(job.model));
        } else {
            done.innerHTML = `✓ Dry-run valid — ${(job.rows || 0).toLocaleString()} rows for <b>${esc(job.config.tier)}</b>. Uncheck dry-run to train for real.`;
        }
    } else if (failed) {
        done.classList.remove('hidden'); done.classList.add('bad');
        done.innerHTML = `✕ Run failed: ${esc(job.error || 'unknown')}`;
    } else {
        done.classList.add('hidden');
    }
}

// Jump to Generate → watch with the new model prefilled as P1 (its base HF id
// rarely maps 1:1 to an ollama tag, so P2 is left for you to pick).
function evalNewModel(model) {
    $$('#tabs button').forEach(x => x.classList.toggle('on', x.dataset.tab === 'generate'));
    $$('.view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== 'generate'));
    stopTrain();
    const el = $('#gen-p1');
    if (![...el.options].some(o => o.value === model)) {
        const o = document.createElement('option'); o.value = model; o.textContent = model; el.appendChild(o);
    }
    $('#gen-mode').value = 'watch';
    el.value = model;
    $('#gen-mode').dispatchEvent(new Event('input'));
}

async function startTrain() {
    const info = trBaseInfo();
    const override = ($('#tr-name-override').value || '').trim();
    const body = {
        tier: _trTier,
        base: info.base,
        family: info.family,
        size: info.size,
        name_override: override,
        epochs: parseFloat($('#tr-epochs').value) || 2.0,
        lora_r: parseInt($('#tr-lora-r').value, 10) || 16,
        lora_alpha: parseInt($('#tr-lora-alpha').value, 10) || 32,
        quant: ($('#tr-quant').value || 'q4_k_m').trim(),
        load_4bit: $('#tr-4bit').checked,
        dry_run: $('#tr-dry').checked,
        free_gpu: $('#tr-freegpu').checked,
        offline: $('#tr-offline').checked,
    };
    $('#tr-start').disabled = true;
    let res;
    try {
        res = await (await fetch('/training/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })).json();
    } catch { refreshTrGate(); return; }
    if (!res.ok) {
        $('#tr-progress-card').classList.remove('hidden');
        const done = $('#tr-done');
        done.classList.remove('hidden'); done.classList.add('bad');
        done.innerHTML = `✕ ${esc(res.error || 'could not start')}`;
        refreshTrGate();
        return;
    }
    _trActive = true;
    $('#tr-cancel').classList.remove('hidden');
    pollStatus();
}

async function pollStatus() {
    let d;
    try { d = await (await fetch('/training/status')).json(); } catch { return; }
    if (d.running) {
        _trActive = true;
        $('#tr-cancel').classList.remove('hidden');
        renderRun(d.running);
    } else if (_trActive) {
        // settled since the last poll — render the final state, stop, refresh.
        const last = d.recent && d.recent[0];
        if (last) renderRun(last);
        _trActive = false;
        $('#tr-cancel').classList.add('hidden');
        loadTrRuns();
        loadPreflight();
    }
}

function enterTrain() {
    refreshName();
    loadPreflight();
    loadTrRuns();
    pollStatus();   // reconnect to an in-flight run, if any
    clearInterval(_trPfTimer);
    _trPfTimer = setInterval(() => { if (!_trActive) loadPreflight(); }, 5000);
    clearInterval(_trStatusTimer);
    _trStatusTimer = setInterval(pollStatus, 2000);
}
function stopTrain() {
    clearInterval(_trPfTimer); _trPfTimer = null;
    clearInterval(_trStatusTimer); _trStatusTimer = null;
}

$('#tr-base').addEventListener('input', refreshName);
$('#tr-base-sel').addEventListener('change', () => {
    $('#tr-base-custom-wrap').classList.toggle('hidden', $('#tr-base-sel').value !== '__custom__');
    refreshName();
});
$('#tr-name-edit').addEventListener('click', () => {
    $('#tr-name-override-wrap').classList.toggle('hidden');
    refreshName();
});
$('#tr-name-override').addEventListener('input', refreshName);
$('#tr-dry').addEventListener('change', refreshTrGate);
$('#tr-start').addEventListener('click', startTrain);
$('#tr-recheck').addEventListener('click', loadPreflight);
$('#tr-cancel').addEventListener('click', async () => {
    $('#tr-cancel').disabled = true;
    try { await fetch('/training/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch {}
    setTimeout(() => { $('#tr-cancel').disabled = false; }, 1000);
});

initGenerate();
startDashboard();   // default tab
