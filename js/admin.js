// Control room — schedule & manage headless tournaments. Talks to the LAN-only
// scheduler endpoints in server.py: POST /tournament/schedule, GET /tournament/jobs,
// POST /tournament/jobs/cancel. The runner + game do the actual work; this only
// drives the control plane and reflects state.
import { FORMATS, DEFAULT_FORMAT } from './tournament-format.js';

const $ = (id) => document.getElementById(id);
const POLL_MS = 3000;

// ── format dropdown (single source of truth) ─────────────────────────────────
const fmtSel = $('f-format');
for (const [key, f] of Object.entries(FORMATS)) {
    const o = document.createElement('option');
    o.value = key; o.textContent = f.label || key;
    if (key === DEFAULT_FORMAT) o.selected = true;
    fmtSel.appendChild(o);
}
const fmtLabel = (key) => FORMATS[key]?.label || key;
const MAP_LABEL = { mediated: 'Standard', ascii: 'ASCII', 'ascii-ext': 'ASCII+', raw: 'Raw' };
const cfgText = (c) => c ? `${c.size} · ${fmtLabel(c.format)} · ${c.rounds}r · ${MAP_LABEL[c.mapStrategy] || c.mapStrategy}` : '';

function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}
const esc = (t) => String(t ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// ── schedule form ────────────────────────────────────────────────────────────
$('f-go').addEventListener('click', async () => {
    const when = document.querySelector('input[name=when]:checked').value;
    const body = {
        size: +$('f-size').value, format: $('f-format').value,
        rounds: +$('f-rounds').value, mapStrategy: $('f-map').value,
    };
    if (when === 'interval') body.when = { kind: 'interval', hours: +$('f-hours').value };
    else if (when === 'daily') body.when = { kind: 'daily', time: $('f-time').value };
    else body.when = { kind: 'now' };
    const msg = $('f-msg');
    msg.textContent = 'scheduling…'; msg.style.color = '#8a98ad';
    try {
        const r = await (await fetch('/tournament/schedule', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })).json();
        if (r.ok) {
            msg.textContent = r.job ? '✓ queued — starting shortly' : '✓ schedule added';
            msg.style.color = '#5fe0bc';
            refresh();
        } else { msg.textContent = '✗ ' + (r.error || 'failed'); msg.style.color = '#ff9b9b'; }
    } catch (e) { msg.textContent = '✗ ' + e.message; msg.style.color = '#ff9b9b'; }
});

async function cancel(id) {
    try { await fetch('/tournament/jobs/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); }
    catch {}
    refresh();
}

// ── render ───────────────────────────────────────────────────────────────────
function tag(status) {
    const cls = { running: 'tag-running', queued: 'tag-queued', done: 'tag-done', failed: 'tag-failed' }[status] || 'tag-queued';
    return `<span class="adm-tag ${cls}">${esc(status)}</span>`;
}
function row(inner) { return `<div class="adm-row">${inner}</div>`; }
const empty = (t) => `<div class="adm-empty">${t}</div>`;

async function renderActive(data, live) {
    const el = $('adm-active');
    let html = '';
    const r = data.running;
    if (r) {
        let prog = '';
        if (live?.active && live.snapshot) {
            const s = live.snapshot;
            prog = `<span class="adm-prog">round ${s.liveRound ?? '–'}/${s.totalRounds ?? '?'} · ${esc(s.phase || s.currentMatchIdx != null ? 'match ' + (s.currentMatchIdx + 1) : '…')}</span>`;
        }
        html += row(`${tag('running')}<span class="adm-cfg">${cfgText(r.config)}</span><div class="adm-spacer"></div>${prog}<button class="adm-cancel" data-id="${r.id}">stop</button>`);
    }
    for (const j of data.queue) {
        html += row(`${tag('queued')}<span class="adm-cfg">${cfgText(j.config)}</span><div class="adm-spacer"></div><span class="adm-cfg">${ago(j.created)}</span><button class="adm-cancel" data-id="${j.id}">remove</button>`);
    }
    el.innerHTML = html || empty('nothing running — schedule one above');
}

function renderSchedules(data) {
    const el = $('adm-schedules');
    let html = '';
    for (const s of data.schedules) {
        const w = s.when || {};
        const whenTxt = w.kind === 'interval' ? `every ${w.hours}h` : w.kind === 'daily' ? `daily ${w.time}` : esc(w.kind || '');
        html += row(`<span class="adm-tag tag-sched">${whenTxt}</span><span class="adm-cfg">${cfgText(s.config)}</span><div class="adm-spacer"></div><button class="adm-cancel" data-id="${s.id}">remove</button>`);
    }
    el.innerHTML = html || empty('no recurring schedules');
}

function renderRecent(data) {
    const el = $('adm-recent');
    let html = '';
    for (const j of data.recent) {
        const champ = j.champion ? `<span class="adm-prog">🏆 ${esc(j.champion)}</span>` : (j.error ? `<span class="adm-cfg">${esc(j.error)}</span>` : '');
        html += row(`${tag(j.status)}<span class="adm-cfg">${cfgText(j.config)}</span><div class="adm-spacer"></div>${champ}<span class="adm-cfg">${ago(j.finished)}</span>`);
    }
    el.innerHTML = html || empty('no completed runs yet');
}

async function refresh() {
    let data, live = null;
    try { data = await (await fetch('/tournament/jobs', { cache: 'no-store' })).json(); }
    catch { return; }
    if (data.running) { try { live = await (await fetch('/tournament/live', { cache: 'no-store' })).json(); } catch {} }
    await renderActive(data, live);
    renderSchedules(data);
    renderRecent(data);
    document.querySelectorAll('.adm-cancel').forEach((b) => b.addEventListener('click', () => cancel(b.dataset.id)));
}

refresh();
setInterval(refresh, POLL_MS);
