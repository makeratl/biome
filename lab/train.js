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
    if (b.dataset.tab === 'curate') loadTurns();
    if (b.dataset.tab === 'dashboard') startDashboard();
});

// ── DASHBOARD (default; auto-refreshes with live "win moments") ────────────
let _dbTimer = null;
let _prev = null;        // last snapshot, for delta detection between refreshes
let _lastChange = 0;     // ts of the last refresh that saw new data (live indicator)
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

async function loadDashboard() {
    let s;
    try { s = await (await fetch('/trajectory/stats')).json(); } catch { return; }

    const first = _prev === null;
    const dGold = first ? 0 : s.gold - _prev.gold;
    const dTurns = first ? 0 : s.turns - _prev.turns;
    const dMatches = first ? 0 : s.matches - _prev.matches;

    animateCount($('#db-gold'), s.gold);

    // Goals — mark the nearest unmet one as "next", glow the near-complete ones.
    let nextMarked = false;
    $('#db-goals').innerHTML = GOAL_ORDER.map(k => {
        const target = s.goals[k];
        const pct = Math.min(100, Math.round((s.gold / target) * 100));
        const done = s.gold >= target;
        const isNext = !done && !nextMarked; if (isNext) nextMarked = true;
        const near = !done && pct >= 80;
        return `<div class="goal ${done ? 'done' : ''} ${isNext ? 'next' : ''} ${near ? 'near' : ''}" data-key="${k}">
            <div class="goal-head"><span>${GOAL_LABEL[k]}</span><span>${s.gold} / ${target} ${done ? '✓' : ''}</span></div>
            <div class="goal-bar"><i style="width:${pct}%"></i></div></div>`;
    }).join('');

    // Tiles — self-documenting via tooltips (answers "what is gold/fallback rate?").
    const rate = (n) => s.turns ? Math.round((n / s.turns) * 100) + '%' : '0%';
    const tiles = [
        ['matches', 'Matches', s.matches, 'Completed matches with a recorded outcome.'],
        ['turns', 'Turns', s.turns, 'Total model turns captured across all matches.'],
        ['won', 'Winning turns', s.won_turns, 'Turns played by the side that went on to win the match (quality-agnostic).'],
        ['goldrate', 'Gold rate', rate(s.gold), 'Share of all captured turns the engine certified GOLD: winning side, grew its score lead, stayed in trophic balance (≥0.60). Your signal yield per turn.'],
        ['fbrate', 'Fallback rate', rate(s.fallback_turns), 'Share of turns where the model gave no usable move and the deterministic fallback (plant grass) stepped in. Never gold — a teacher-reliability signal.'],
        ['seeds', 'Distinct seeds', s.distinct_seeds, 'Unique map seeds = data diversity. More varied boards → a more generalizable training set.'],
    ];
    $('#db-tiles').innerHTML = tiles.map(([key, k, v, tip]) =>
        `<div class="tile" data-key="${key}" title="${esc(tip)}"><div class="tile-v">${v}</div><div class="tile-k">${k}</div></div>`).join('');

    const bm = Object.entries(s.gold_by_model || {});
    $('#db-bymodel').innerHTML = bm.length
        ? bm.map(([m, n]) => `<div class="bm-row"><span>${esc(m)}</span><b>${n}</b></div>`).join('')
        : 'No gold yet — run a batch or play a tournament.';

    // ── win moments ──────────────────────────────────────────────────────
    if (!first && dGold > 0) {
        // Good data: the headline celebration.
        flash($('.hero'), 'pop');
        ping($('.hero'), `+${dGold} GOLD`);
        confettiBurst($('.hero'), Math.min(60, 22 + dGold * 8));
        // A crossed goal threshold is a bigger moment still.
        for (const k of GOAL_ORDER) {
            if (_prev.gold < s.goals[k] && s.gold >= s.goals[k]) {
                goalToast(`🎉 ${GOAL_LABEL[k]} goal reached — ${s.goals[k]} gold!`);
                flash($(`.goal[data-key="${k}"]`), 'just-done');
            }
        }
    } else if (!first && (dTurns > 0 || dMatches > 0)) {
        // New data, not yet gold: a gentler "it's flowing" beat.
        if (dTurns > 0) { const t = $('.tile[data-key="turns"]'); flash(t, 'bump'); ping(t, `+${dTurns}`, true); }
        if (dMatches > 0) flash($('.tile[data-key="matches"]'), 'bump');
    }

    if (!first && (dGold > 0 || dTurns > 0 || dMatches > 0)) _lastChange = performance.now();
    const liveOn = _lastChange && (performance.now() - _lastChange) < 30000;
    $('#db-live').classList.toggle('on', !!liveOn);
    $('#db-live-text').textContent = liveOn ? 'capturing' : 'idle';
    $('#db-refresh').textContent = 'auto-refresh · updated ' + new Date().toLocaleTimeString();

    _prev = { gold: s.gold, turns: s.turns, matches: s.matches, won_turns: s.won_turns };
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
        row.className = 'turn-row' + (t.gold ? ' gold' : '') + (t.decision === 'reject' ? ' rej' : '');
        row.dataset.uid = t.turn_uid;
        const badges = [
            t.gold ? '<span class="badge gold">GOLD</span>' : '',
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
            <span>gold: <b>${l.gold}</b></span>
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

initGenerate();
startDashboard();   // default tab
