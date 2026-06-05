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

// ── DASHBOARD (default; auto-refreshes) ───────────────────────────────────
let _dbTimer = null;
const GOAL_LABEL = { smoke: 'Smoke train', ladder: 'Ladder attempt', robust: 'Robust set' };

async function loadDashboard() {
    let s;
    try { s = await (await fetch('/trajectory/stats')).json(); } catch { return; }
    $('#db-gold').textContent = s.gold;

    const order = ['smoke', 'ladder', 'robust'];
    $('#db-goals').innerHTML = order.map(k => {
        const target = s.goals[k];
        const pct = Math.min(100, Math.round((s.gold / target) * 100));
        const done = s.gold >= target;
        return `<div class="goal ${done ? 'done' : ''}">
            <div class="goal-head"><span>${GOAL_LABEL[k]}</span><span>${s.gold} / ${target} ${done ? '✓' : ''}</span></div>
            <div class="goal-bar"><i style="width:${pct}%"></i></div></div>`;
    }).join('');

    const rate = (n) => s.turns ? Math.round((n / s.turns) * 100) + '%' : '0%';
    const tiles = [
        ['Matches', s.matches], ['Turns', s.turns], ['Winning turns', s.won_turns],
        ['Gold rate', rate(s.gold)], ['Fallback rate', rate(s.fallback_turns)], ['Distinct seeds', s.distinct_seeds],
    ];
    $('#db-tiles').innerHTML = tiles.map(([k, v]) =>
        `<div class="tile"><div class="tile-v">${v}</div><div class="tile-k">${k}</div></div>`).join('');

    const bm = Object.entries(s.gold_by_model || {});
    $('#db-bymodel').innerHTML = bm.length
        ? bm.map(([m, n]) => `<div class="bm-row"><span>${esc(m)}</span><b>${n}</b></div>`).join('')
        : 'No gold yet — run a batch or play a tournament.';
    $('#db-refresh').textContent = 'auto-refresh · updated ' + new Date().toLocaleTimeString();
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
