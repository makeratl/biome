// Avatar Lab — generation dashboard. The committed style is Cyber-organic; this
// page generates the per-model biome-creature avatars (via the server → ComfyUI
// bridge) for every model currently installed in Ollama, then keeps a roster and
// a style-comparison reference below.
//
// Generation flow: the page POSTs { key, style, prompt, lora, negative, seed } to
// /comfy/generate; server.py injects those into the saved ComfyUI graph, runs it,
// resizes the result into avatars/<style>/<key>.png, and updates the manifest.
// The page then busts the manifest cache and repaints the row.

import { listOllamaModels, RECOMMENDED_MODELS } from '../js/ai.js';
import {
    resolveModel, avatarPrompt, STYLE_PRESETS, NEGATIVE_PROMPT,
    SIZE_TIERS, TIER_ORDER, applyIdentityOverrides,
} from '../js/model-identity.js';
import { loadIdentityOverrides } from '../js/identity-overrides.js';
import { extractJSON } from '../js/util.js';
import { makeCanvas } from './lab-util.js';
import * as procedural from './avatar-styles/procedural.js';
import * as generated from './avatar-styles/generated.js';
import { VIDEO_CATEGORIES, CATEGORY_LABEL, motionPrompt } from './motion.js';

const STYLE = 'cyber-organic';          // the committed direction
const LORA = STYLE_PRESETS[STYLE].lora;
const STYLE_IDS = Object.keys(STYLE_PRESETS);

// Persisted per-key prompt edits + baked clips, loaded in init() and busted on save.
let overrides = {};        // { still:{key:text}, victory:{key:text}, defeat:{key:text} }
let videoManifest = {};    // { victory:{key:rel}, defeat:{key:rel} }
let videoVer = 0;          // bumped on bake so a fresh clip isn't served stale
let videoWorkflow = 'fast'; // header toggle: 'fast' | 'quality'
let previewGroup = null;    // the group whose still the modal is currently showing
let identityOverrides = {}; // { <key>: { label?, archetype?, motif? } } — creature renames/rethemes
let familyTotals = {};      // { <familyId>: count } across all installed models (for the membership badge)
let assistModels = [];      // installed models, ELO-desc, for the AI-assist picker
let rankings = {};          // cached /rankings payload { name: {elo,wins,losses,matches} }
let statModel = '';         // the group member whose stats the studio panel is showing
const statCache = new Map();// name → /stats/model detail (cleared on Refresh)
let pendingMotions = null;  // motion prompts staged by an AI revision, committed on "Save identity"
const rowMetaByKey = new Map(); // key → { group, row, holder, status, btn, promptBox, nameDiv } for cross-updates

async function loadOverrides(bust) {
    const url = '/avatars/lab-overrides.json' + (bust ? `?t=${Date.now()}` : '');
    try { const r = await fetch(url); return r.ok ? await r.json() : {}; } catch { return {}; }
}
async function loadVideoManifest(bust) {
    const url = '/videos/manifest.json' + (bust ? `?t=${Date.now()}` : '');
    try { const r = await fetch(url); return r.ok ? await r.json() : {}; } catch { return {}; }
}
function stillPromptFor(group) {
    return (overrides.still || {})[group.key] || avatarPrompt(group.resolved, STYLE);
}
function motionPromptFor(group, cat) {
    return (overrides[cat] || {})[group.key] || motionPrompt(group.resolved, cat);
}
function videoUrlFor(category, key) {
    const rel = (videoManifest[category] || {})[key];
    return rel ? '/' + rel.replace(/^\/+/, '') + (videoVer ? `?v=${videoVer}` : '') : null;
}
async function saveOverride(kind, key, text) {
    await fetch('/lab/overrides', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, key, text }),
    });
    overrides[kind] = overrides[kind] || {};
    if (text && text.trim()) overrides[kind][key] = text; else delete overrides[kind][key];
}
function flash(btn, msg) {              // brief inline confirmation on a mini-button
    const old = btn.textContent;
    btn.textContent = msg; btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1100);
}
// Cache-bust each open so a freshly-regenerated PNG (same path) shows the latest.
function stillImageUrl(key) { return `/avatars/${STYLE}/${key}.png?t=${Date.now()}`; }

// The studio's left preview hub flips between the still and each clip. Paints the
// stage for the active tab: a baked clip → looping <video>; else the still PNG
// (cache-busted); else the procedural placeholder — with a note explaining gaps.
let studioTab = 'still';
function renderStudioPreview(group) {
    const stage = document.getElementById('preview-stage');
    const note = document.getElementById('preview-note');
    stage.innerHTML = '';
    const stillBaked = bakedKeys.has(group.key);
    if (studioTab === 'still') {
        if (stillBaked) {
            const img = el('img', 'modal-img');
            img.src = stillImageUrl(group.key); img.alt = group.key;
            stage.appendChild(img); note.hidden = true;
        } else {
            const c = avatarCanvas(group.resolved, 480, 'procedural');
            c.classList.add('modal-img'); stage.appendChild(c);
            note.hidden = false;
            note.textContent = 'Procedural placeholder — generate the still to preview the baked image.';
        }
        return;
    }
    const url = videoUrlFor(studioTab, group.key);
    if (url) {
        const v = el('video', 'modal-img');
        v.src = url; v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true; v.controls = true;
        v.play?.().catch(() => { /* autoplay may defer; controls remain */ });
        stage.appendChild(v); note.hidden = true;
    } else if (stillBaked) {
        const img = el('img', 'modal-img');
        img.src = stillImageUrl(group.key); stage.appendChild(img);
        note.hidden = false;
        note.textContent = `No ${CATEGORY_LABEL[studioTab] || studioTab} clip yet — showing the still. Respin to animate it.`;
    } else {
        const c = avatarCanvas(group.resolved, 480, 'procedural');
        c.classList.add('modal-img'); stage.appendChild(c);
        note.hidden = false;
        note.textContent = 'Generate the still first — it’s the animation’s start frame.';
    }
}

// Sync the left controls (status / seed / respin button) and the right contextual
// prompt block to the active tab: still vs the selected clip category.
function syncStudioControls(group) {
    const status = document.getElementById('preview-status');
    const regen = document.getElementById('preview-regen');
    const head = document.getElementById('prompt-head');
    const prompt = document.getElementById('preview-prompt');
    const stillBaked = bakedKeys.has(group.key);
    if (studioTab === 'still') {
        status.className = `status-pill stage-status ${stillBaked ? 'baked' : 'missing'}`;
        status.textContent = stillBaked ? 'baked' : 'not generated';
        regen.disabled = !comfyOk;
        regen.title = stillBaked ? 'Respin still — new random take' : 'Generate still';
        head.textContent = 'Still prompt';
        prompt.value = stillPromptFor(group); prompt.rows = 4;
    } else {
        const url = videoUrlFor(studioTab, group.key);
        status.className = `status-pill stage-status ${url ? 'baked' : (stillBaked ? 'missing' : 'error')}`;
        status.textContent = url ? 'baked' : (stillBaked ? 'not generated' : 'need still first');
        regen.disabled = !comfyOk || !stillBaked;
        regen.title = !stillBaked ? 'Generate the still first' : (url ? 'Respin clip — new random take' : 'Animate clip');
        head.textContent = `${CATEGORY_LABEL[studioTab] || studioTab} motion prompt`;
        prompt.value = motionPromptFor(group, studioTab); prompt.rows = 3;
    }
}

function selectStudioTab(tab) {
    if (!previewGroup) return;
    studioTab = tab;
    document.querySelectorAll('.studio-tab').forEach(b => b.classList.toggle('is-on', b.dataset.tab === tab));
    renderStudioPreview(previewGroup);
    syncStudioControls(previewGroup);
}

// Full-size base-image preview + regeneration for quality review before animating.
function openPreview(group) {
    previewGroup = group;
    studioTab = 'still';
    const r = group.resolved;
    document.getElementById('preview-title').innerHTML =
        `${r.family.label} · ${r.family.archetype} `
        + `<span class="tier-tag" style="background:${tierColor(r.sizeTier)};color:#0c1013">${r.tier.label}</span> `
        + `<span class="key-pill">${group.key}</span>`;
    document.querySelectorAll('.studio-tab').forEach(b => b.classList.toggle('is-on', b.dataset.tab === 'still'));
    // Tint the studio's rim-light + accents with the creature's identity hue.
    document.querySelector('.modal-card.studio').style.setProperty('--hero-hue', r.hue);
    fillIdentityFields(group);
    renderStudioPreview(group);
    syncStudioControls(group);
    statModel = '';                 // default to the top-ranked member each open
    renderStudioStats(group);
    document.getElementById('preview-modal').hidden = false;
}

// ── Studio stats panel ───────────────────────────────────────────────────────
// Fills the space below the preview + tabs with performance infographics for the
// avatar's model(s). Data comes from /stats/model?m=<name> (rank, ELO timeline,
// win-splits, head-to-head). Shared avatars (>1 member model) get switch chips;
// the top-ranked member shows first. Models with no ranked matches get an empty
// state — the lab lists installed models, not only tournament players.

// Order a group's member models by ELO (desc), unranked last, then by name.
function statMembers(group) {
    return [...group.models].sort((a, b) => {
        const ea = rankings[a] ? rankings[a].elo : -Infinity;
        const eb = rankings[b] ? rankings[b].elo : -Infinity;
        return eb - ea || a.localeCompare(b);
    });
}

async function loadStatDetail(name) {
    if (statCache.has(name)) return statCache.get(name);
    let detail = { model: name, found: false };
    try {
        const r = await fetch('/stats/model?m=' + encodeURIComponent(name));
        if (r.ok) detail = await r.json();
    } catch { /* offline — show empty state */ }
    statCache.set(name, detail);
    return detail;
}

async function renderStudioStats(group) {
    const panel = document.getElementById('studio-stats');
    if (!group) { panel.hidden = true; return; }
    const members = statMembers(group);
    if (!members.length) { panel.hidden = true; return; }
    const active = members.includes(statModel) ? statModel : members[0];
    statModel = active;
    panel.hidden = false;

    // Member switch chips (only when the avatar is shared by >1 model).
    const chips = members.length > 1
        ? `<div class="stat-chips">${members.map((m) => {
            const elo = rankings[m] ? `<span class="sc-elo">${Math.round(rankings[m].elo)}</span>` : '';
            return `<button class="stat-chip${m === active ? ' is-on' : ''}" data-model="${m}">${m}${elo}</button>`;
        }).join('')}</div>`
        : '';

    panel.innerHTML = `<div class="stat-head">⚔ Performance</div>${chips}`
        + `<div id="stat-body" class="stat-body"><div class="stat-empty">Loading…</div></div>`;
    panel.querySelectorAll('.stat-chip').forEach((c) => { c.onclick = () => {
        if (c.dataset.model === statModel) return;
        statModel = c.dataset.model;
        renderStudioStats(group);
    }; });

    const detail = await loadStatDetail(active);
    if (previewGroup !== group || statModel !== active) return;   // raced past — drop
    paintStatBody(detail);
}

function paintStatBody(d) {
    const body = document.getElementById('stat-body');
    if (!body) return;
    if (!d.found || !d.matches) {
        body.innerHTML = `<div class="stat-empty">No ranked matches yet — run a `
            + `<a href="/#tournament">tournament</a> to populate this model's record.</div>`;
        return;
    }
    const peak = (d.peak_elo && d.peak_elo > d.elo)
        ? `<span class="stat-peak">▲ peak ${Math.round(d.peak_elo)}</span>` : '';
    const streak = (d.streak && d.streak > 1)
        ? `<span class="stat-streak">🔥 ${d.streak} win streak</span>` : '';
    const wr = d.winrate;
    const wrHue = 0 + Math.round((wr / 100) * 120);   // red→green by winrate

    body.innerHTML = `
        <div class="stat-tiles">
            <div class="stat-tile"><b>#${d.rank}</b><span>rank</span></div>
            <div class="stat-tile"><b>${Math.round(d.elo)}</b><span>ELO</span></div>
            <div class="stat-tile"><b>${d.wins}-${d.losses}</b><span>record</span></div>
            <div class="stat-tile"><b style="color:hsl(${wrHue} 65% 60%)">${wr}%</b><span>winrate</span></div>
        </div>
        <div class="stat-meta">${peak}${streak}</div>
        <div class="stat-grid">
            <div class="stat-col">
                ${eloSpark(d.timeline)}
                ${splitBlock('By vision', d.splits && d.splits.map_strategy, (k) => VISION_LABELS[k] || k)}
                ${splitBlock('By rounds', d.splits && d.splits.rounds, (k) => `${k} rds`)}
            </div>
            <div class="stat-col">
                ${splitBlock('By mode', d.splits && d.splits.mode)}
                ${scoreBlock('By map size', d.splits && d.splits.map_size)}
                ${rivalsBlock(d.h2h)}
            </div>
        </div>`;
}

// Inline-SVG ELO sparkline across the model's rating events (min–max scaled, with
// a dashed 1000-baseline when it falls inside the range).
function eloSpark(timeline) {
    const pts = (timeline || []).map((e) => e.elo).filter((v) => typeof v === 'number');
    if (pts.length < 2) return '';
    const W = 100, H = 30, pad = 2;
    const lo = Math.min(...pts), hi = Math.max(...pts), span = (hi - lo) || 1;
    const x = (i) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
    const y = (v) => pad + (1 - (v - lo) / span) * (H - 2 * pad);
    const line = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const area = `M${x(0).toFixed(1)} ${H} ${line.replace(/^M/, 'L')} L${x(pts.length - 1).toFixed(1)} ${H} Z`;
    const base = (lo <= 1000 && hi >= 1000)
        ? `<line x1="${pad}" x2="${W - pad}" y1="${y(1000).toFixed(1)}" y2="${y(1000).toFixed(1)}"
                 class="spark-base"/>` : '';
    const up = pts[pts.length - 1] >= pts[0];
    return `<div class="stat-spark"><span class="stat-sub">ELO history</span>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark ${up ? 'up' : 'down'}">
            <path d="${area}" class="spark-fill"/>${base}<path d="${line}" class="spark-line"/>
            <circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(pts[pts.length - 1]).toFixed(1)}" r="1.6" class="spark-dot"/>
        </svg></div>`;
}

// The game's "Map vision" (map_strategy) values → the friendly names the game UI
// and dashboards use, so the studio reads the same language everywhere.
const VISION_LABELS = { mediated: 'Standard', ascii: 'ASCII', 'ascii-ext': 'ASCII+', raw: 'Raw' };

// A labelled set of winrate bars for one split dimension (mode / map size / vision).
// keyFmt optionally maps raw split keys to display names (e.g. vision strategies).
function splitBlock(title, rows, keyFmt) {
    if (!rows || !rows.length) return '';
    const bars = rows.map((s) => {
        const hue = Math.round((s.winrate / 100) * 120);
        return `<div class="stat-bar">
            <span class="sb-key">${keyFmt ? keyFmt(s.key) : s.key}</span>
            <span class="sb-track"><span class="sb-fill" style="width:${s.winrate}%;background:hsl(${hue} 60% 50%)"></span></span>
            <span class="sb-val">${s.winrate}% <em>${s.wins}/${s.games}</em></span>
        </div>`;
    }).join('');
    return `<div class="stat-split"><span class="stat-sub">${title}</span>${bars}</div>`;
}

// Compact biome-score magnitude (22022 → "22.0k", 300 → "300").
function fmtScore(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n));
}

// Like splitBlock, but the vertical is the model's AVG biome score (a magnitude),
// not a winrate — used for map size, where board scale drives the score. Bars are
// scaled to the largest row and tinted with the identity hue to read as magnitude
// (distinct from the red→green winrate bars).
function scoreBlock(title, rows) {
    if (!rows || !rows.length) return '';
    const max = Math.max(...rows.map((r) => r.avg_score || 0)) || 1;
    const bars = rows.map((s) => {
        const pct = Math.round(((s.avg_score || 0) / max) * 100);
        return `<div class="stat-bar">
            <span class="sb-key">${s.key}</span>
            <span class="sb-track"><span class="sb-fill sb-fill-biome" style="width:${pct}%"></span></span>
            <span class="sb-val">${fmtScore(s.avg_score || 0)} <em>${s.games}g</em></span>
        </div>`;
    }).join('');
    return `<div class="stat-split"><span class="stat-sub">${title} · avg biome</span>${bars}</div>`;
}

// Top head-to-head rivals (most-played first), with a prettified opponent label.
function rivalsBlock(h2h) {
    if (!h2h || !h2h.length) return '';
    const rows = h2h.slice(0, 4).map((r) => {
        let label = r.opponent;
        try { label = resolveModel(r.opponent).family.label || r.opponent; } catch { /* keep raw */ }
        const lead = r.wins > r.losses ? 'win' : r.wins < r.losses ? 'loss' : 'even';
        return `<div class="stat-rival">
            <span class="sr-opp">vs ${label}</span>
            <span class="sr-rec is-${lead}">${r.wins}-${r.losses}</span>
        </div>`;
    }).join('');
    return `<div class="stat-rivals"><span class="stat-sub">Top rivals</span>${rows}</div>`;
}

// Populate the identity editor + AI-assist + queue controls for a group.
function fillIdentityFields(group) {
    const r = group.resolved;
    document.getElementById('preview-family-count').textContent = familyCountLabel(group);
    document.getElementById('preview-name').value = r.family.label;
    document.getElementById('preview-archetype').value = r.family.archetype;
    document.getElementById('preview-motif').value = r.family.promptMotif;
    document.getElementById('assist-note').value = '';
    pendingMotions = null;
    setAssistStatus('', '');
    const iStatus = document.getElementById('identity-status');
    iStatus.className = 'status-pill'; iStatus.textContent = '';
    document.getElementById('assist-go').disabled = !assistModels.length;
    // The approve→queue step only unlocks after a fresh respin in this session.
    const approve = document.getElementById('preview-approve-queue');
    approve.disabled = true;
    approve.dataset.key = '';
    document.getElementById('approve-hint').textContent =
        'Respin the still above, then queue the clip set to match.';
}
function closePreview() {
    document.getElementById('preview-modal').hidden = true;
    document.getElementById('preview-stage').innerHTML = '';   // drop the <img> so it stops decoding
    previewGroup = null;
}

// Repaint a row's thumbnail + status after a modal regen (so the dashboard matches).
function repaintRow(group) {
    const meta = rowMetaByKey.get(group.key);
    if (!meta) return;
    paintAvatar(meta.holder, group.resolved);
    meta.status.className = 'status-pill baked';
    meta.status.textContent = 'baked';
    meta.btn.textContent = 'Regenerate';
    meta.btn.disabled = !comfyOk;
}
// A first bake unlocks the row's clip slots without a full re-render.
function enableRowStudio(group) {
    const meta = rowMetaByKey.get(group.key);
    if (!meta) return;
    meta.row.querySelectorAll('.clip-slot .gen-btn').forEach((b) => { b.disabled = !comfyOk; b.removeAttribute('title'); });
    const hint = meta.row.querySelector('.studio-body .hint');
    if (hint) hint.remove();
}
// Mirror a saved/reset still prompt back into the row's textarea.
function syncRowPrompt(group, text) {
    const meta = rowMetaByKey.get(group.key);
    if (meta && meta.promptBox) {
        meta.promptBox.value = (text && text.trim()) ? text : avatarPrompt(group.resolved, STYLE);
    }
}
// If the modal is showing this group, refresh its preview + controls after a row
// regen / queue update so the studio stays in sync with the dashboard.
function refreshPreviewIfOpen(group) {
    const modal = document.getElementById('preview-modal');
    if (!previewGroup || previewGroup.key !== group.key || modal.hidden) return;
    renderStudioPreview(group);
    syncStudioControls(group);
}

// Toggle the loading veil over the preview while a still/clip is regenerating.
function setStageLoading(on, label) {
    const veil = document.getElementById('stage-loading');
    if (label) document.getElementById('stage-loading-label').textContent = label;
    veil.hidden = !on;
}

// The studio's Respin button — routes to the still or the active clip category.
async function respinFromStudio() {
    const group = previewGroup;
    if (!group) return;
    if (studioTab === 'still') return respinStill(group);
    return respinClip(group, studioTab);
}

async function respinStill(group) {
    const wasBaked = bakedKeys.has(group.key);
    const seed = randomSeed();
    const promptText = document.getElementById('preview-prompt').value;
    const btn = document.getElementById('preview-regen');
    const status = document.getElementById('preview-status');
    btn.disabled = true;
    status.className = 'status-pill stage-status working';
    status.textContent = 'generating…';
    setStageLoading(true, 'Generating still…');
    const actId = pushActivity({ type: 'still', key: group.key, group, label: `${group.resolved.family.label} · still`, status: 'running' });
    try {
        const data = await generateStill(group, seed, promptText);
        renderStudioPreview(group);
        status.className = 'status-pill stage-status baked';
        status.textContent = `baked · ${data.seconds}s`;
        setActivity(actId, { status: 'done', note: `${data.seconds}s` });
        repaintRow(group);
        if (!wasBaked) enableRowStudio(group);
        updateAllBtn();
        // Unlock the approve→queue step now that there's a fresh still to match.
        const approve = document.getElementById('preview-approve-queue');
        approve.disabled = false;
        approve.dataset.key = group.key;
        const existing = VIDEO_CATEGORIES.filter(c => videoUrlFor(c, group.key)).length;
        document.getElementById('approve-hint').textContent = existing
            ? `Approve to queue ${existing} existing clip${existing === 1 ? '' : 's'} for respin off the new still.`
            : `Approve to queue the full ${VIDEO_CATEGORIES.length}-clip set off the new still.`;
        return true;
    } catch (e) {
        status.className = 'status-pill stage-status error';
        status.textContent = 'failed';
        setActivity(actId, { status: 'failed', note: 'failed' });
        console.error('respin still failed', group.key, e);
        return false;
    } finally {
        btn.disabled = !comfyOk;
        setStageLoading(false);
    }
}

async function respinClip(group, category) {
    if (!bakedKeys.has(group.key)) return;
    const seed = randomSeed();
    const promptText = document.getElementById('preview-prompt').value;
    const btn = document.getElementById('preview-regen');
    const status = document.getElementById('preview-status');
    btn.disabled = true;
    status.className = 'status-pill stage-status working';
    status.textContent = `animating… (${videoWorkflow})`;
    setStageLoading(true, `Animating ${CATEGORY_LABEL[category] || category}… (${videoWorkflow})`);
    const actId = pushActivity({ type: 'clip', key: group.key, group, category, label: `${group.resolved.family.label} · ${CATEGORY_LABEL[category] || category} clip`, status: 'running' });
    try {
        const body = {
            key: group.key, category, workflow: videoWorkflow, seed,
            prompt: promptText.trim() || motionPrompt(group.resolved, category),
        };
        const resp = await fetch('/comfy/animate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
        videoManifest = await loadVideoManifest(true); videoVer++;
        renderStudioPreview(group);
        status.className = 'status-pill stage-status baked';
        status.textContent = `baked · ${data.seconds}s`;
        setActivity(actId, { status: 'done', note: `${data.seconds}s` });
        refreshCardStatus(group);   // update the dashboard card's clip dots
    } catch (e) {
        status.className = 'status-pill stage-status error';
        status.textContent = 'failed';
        setActivity(actId, { status: 'failed', note: 'failed' });
        console.error('respin clip failed', group.key, category, e);
    } finally {
        btn.disabled = !comfyOk || !bakedKeys.has(group.key);
        setStageLoading(false);
    }
}

const CLOUD_SEEN = [
    'qwen3.5:cloud', 'deepseek-v3.2:cloud', 'glm-5.1:cloud',
    'kimi-k2.5:cloud', 'minimax-m2.5:cloud', 'nemotron-3-nano:30b-cloud',
];
const UNKNOWN_STRESS = ['yi:34b', 'wizardlm2:7b', 'starcoder2:15b'];
const COMPARE_SET = ['qwen2.5:14b', 'qwen3.5:cloud', 'deepseek-v3.2:cloud', 'llama3.1:8b', 'gemma2:9b'];

let comfyOk = false;
let bakedKeys = new Set();   // avatarKeys present for STYLE in the manifest

function tierColor(t) {
    return { small: '#5ec8d8', mid: '#8bd85e', large: '#d8a55e', cloud: '#c98bd8' }[t] || '#888';
}
// Every generation uses a fresh random seed — a "respin" should give real
// variation, and the seed is an implementation detail we never surface here.
function randomSeed() { return Math.floor(Math.random() * 1000000); }
function el(tag, cls, html) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    if (html != null) d.innerHTML = html;
    return d;
}
function avatarCanvas(resolved, size, kind) {
    const { canvas, ctx } = makeCanvas(size);
    canvas.className = 'av';
    const opts = { resolved, size, cx: size / 2, cy: size / 2 };
    if (kind === 'procedural') procedural.renderInto(ctx, opts);
    else generated.renderInto(ctx, { ...opts, style: kind });
    return canvas;
}

// ---- generation dashboard ----
async function runningGroups() {
    let installed = [];
    try { installed = (await listOllamaModels()).map(m => m.name); } catch { /* offline */ }
    const groups = new Map();
    familyTotals = {};
    for (const name of installed) {
        const r = resolveModel(name);
        familyTotals[r.family.id] = (familyTotals[r.family.id] || 0) + 1;
        if (!groups.has(r.avatarKey)) groups.set(r.avatarKey, { key: r.avatarKey, resolved: r, models: [] });
        groups.get(r.avatarKey).models.push(name);
    }
    return { groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)), installedCount: installed.length };
}

// "3 of 5 Qwen models" — this avatar's tier-share within its family vs the family
// total installed. Collapses to a single count when the family has one avatar.
function familyCountLabel(group) {
    const r = group.resolved;
    const here = group.models.length;
    const total = familyTotals[r.family.id] || here;
    const noun = `${r.family.label} model${total === 1 ? '' : 's'}`;
    return here === total ? `${total} ${noun}` : `${here} of ${total} ${noun}`;
}

function paintAvatar(holder, resolved) {
    holder.innerHTML = '';
    holder.appendChild(avatarCanvas(resolved, 96, STYLE));
}

// Shared still-generation call (row button + modal both use this). Busts the
// manifest and marks the key baked; callers repaint their own UI.
async function generateStill(group, seed, promptText) {
    const body = {
        key: group.key, style: STYLE,
        prompt: (promptText && promptText.trim()) || avatarPrompt(group.resolved, STYLE),
        negative: NEGATIVE_PROMPT, lora: LORA, seed,
    };
    const resp = await fetch('/comfy/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
    await generated.loadManifest(Date.now());   // bust + reload so the new PNG shows
    bakedKeys.add(group.key);
    return data;
}

async function generateRow(group, seed, rowEls) {
    const { btn, status, holder, promptBox } = rowEls;
    const wasBaked = bakedKeys.has(group.key);
    btn.disabled = true;
    status.className = 'status-pill working';
    status.textContent = 'generating…';
    const actId = pushActivity({ type: 'still', key: group.key, group, label: `${group.resolved.family.label} · still`, status: 'running' });
    try {
        const data = await generateStill(group, seed, promptBox && promptBox.value);
        paintAvatar(holder, group.resolved);
        status.className = 'status-pill baked';
        status.textContent = `baked · ${data.seconds}s`;
        btn.textContent = 'Regenerate';
        setActivity(actId, { status: 'done', note: `${data.seconds}s` });
        if (!wasBaked) enableRowStudio(group);   // a first bake unlocks its clip slots
        refreshPreviewIfOpen(group);             // keep an open modal in sync
        return true;
    } catch (e) {
        status.className = 'status-pill error';
        status.textContent = 'failed';
        setActivity(actId, { status: 'failed', note: 'failed' });
        console.error('generate failed', group.key, e);
        return false;
    } finally {
        btn.disabled = !comfyOk;
    }
}

// A compact dashboard card. Editing (prompts, clips, AI respin) all lives in the
// studio modal now; the card is for scanning + a one-click quick still bake.
function buildGroupCard(group) {
    const r = group.resolved;
    const baked = bakedKeys.has(group.key);
    const card = el('div', 'grow-card');
    card.style.setProperty('--card-hue', r.hue);
    card.dataset.family = r.family.id;
    card.dataset.search = (group.models.join(' ') + ' ' + r.family.label + ' '
        + r.family.archetype + ' ' + group.key).toLowerCase();

    const holder = el('div', 'grow-av');
    paintAvatar(holder, r);
    holder.title = 'Open studio';
    holder.onclick = () => openPreview(group);
    card.appendChild(holder);

    const body = el('div', 'card-body');
    const nameDiv = el('div', 'grow-name',
        `${r.family.label} · ${r.family.archetype} `
        + `<span class="tier-tag" style="background:${tierColor(r.sizeTier)};color:#0c1013">${r.tier.label}</span>`);
    body.appendChild(nameDiv);
    body.appendChild(el('div', 'card-fam', `<span class="fam-count">${familyCountLabel(group)}</span>`));
    body.appendChild(el('div', 'grow-models', group.models.map(m => `<code>${m}</code>`).join(' ')));

    const statusRow = el('div', 'card-status');
    const status = el('span', `status-pill ${baked ? 'baked' : 'missing'}`, baked ? 'still baked' : 'no still');
    statusRow.append(status, clipDotsEl(group));
    body.appendChild(statusRow);
    card.appendChild(body);

    const ctrl = el('div', 'card-ctrl');
    const btn = el('button', 'gen-btn', baked ? 'Regenerate' : 'Generate');
    btn.disabled = !comfyOk;
    btn.title = 'Quick bake the still with the default prompt (use the studio to edit it)';
    btn.onclick = () => generateRow(group, randomSeed(), { btn, status, holder });
    ctrl.appendChild(btn);
    const studioBtn = el('button', 'mini-btn studio-btn', '✏️ Studio');
    studioBtn.title = 'Open the studio: rename, AI respin, edit prompts, animate clips';
    studioBtn.onclick = () => openPreview(group);
    ctrl.appendChild(studioBtn);
    card.appendChild(ctrl);

    rowMetaByKey.set(group.key, { group, row: card, holder, status, btn, promptBox: null, nameDiv });
    card._meta = { group, btn, status, holder, promptBox: null };
    return card;
}

// Per-card clip coverage: a dot per category (filled when a clip is baked) + N/6.
function clipDotsEl(group) {
    const wrap = el('div', 'clip-dots');
    let n = 0;
    for (const cat of VIDEO_CATEGORIES) {
        const has = !!videoUrlFor(cat, group.key);
        if (has) n++;
        const d = el('span', 'clip-dot' + (has ? ' on' : ''));
        d.title = `${CATEGORY_LABEL[cat] || cat} · ${has ? 'baked' : 'none'}`;
        wrap.appendChild(d);
    }
    wrap.appendChild(el('span', 'clip-dots-n', `${n}/${VIDEO_CATEGORIES.length}`));
    return wrap;
}

// Refresh a card's still pill + clip dots after a still/clip respin or queue run.
function refreshCardStatus(group) {
    const meta = rowMetaByKey.get(group.key);
    if (!meta || !meta.row) return;
    const baked = bakedKeys.has(group.key);
    if (meta.status) {
        meta.status.className = `status-pill ${baked ? 'baked' : 'missing'}`;
        meta.status.textContent = baked ? 'still baked' : 'no still';
    }
    const old = meta.row.querySelector('.clip-dots');
    if (old) old.replaceWith(clipDotsEl(group));
}

let GROUPS = [];
function renderDashboard() {
    const wrap = document.getElementById('groups');
    wrap.innerHTML = '';
    rowMetaByKey.clear();
    for (const g of GROUPS) wrap.appendChild(buildGroupCard(g));
    applyDashFilter();
}

// ---- dashboard search / filter ----
function populateFamilyFilter() {
    const sel = document.getElementById('dash-family');
    if (!sel) return;
    const fams = new Map();
    for (const g of GROUPS) fams.set(g.resolved.family.id, g.resolved.family.label);
    const cur = sel.value;
    sel.innerHTML = '<option value="">All families</option>';
    [...fams.entries()].sort((a, b) => a[1].localeCompare(b[1])).forEach(([id, label]) => {
        const o = document.createElement('option');
        o.value = id; o.textContent = label;
        sel.appendChild(o);
    });
    sel.value = cur;
}

function applyDashFilter() {
    const q = (document.getElementById('dash-search')?.value || '').trim().toLowerCase();
    const fam = document.getElementById('dash-family')?.value || '';
    const unbakedOnly = document.getElementById('dash-unbaked')?.checked;
    const clipsOnly = document.getElementById('dash-clips')?.checked;
    let shown = 0;
    for (const g of GROUPS) {
        const meta = rowMetaByKey.get(g.key);
        if (!meta || !meta.row) continue;
        const hasClips = VIDEO_CATEGORIES.some(c => videoUrlFor(c, g.key));
        const ok = (!q || meta.row.dataset.search.includes(q))
            && (!fam || meta.row.dataset.family === fam)
            && (!unbakedOnly || !bakedKeys.has(g.key))
            && (!clipsOnly || hasClips);
        meta.row.hidden = !ok;
        if (ok) shown++;
    }
    const count = document.getElementById('dash-count');
    if (count) count.textContent = shown === GROUPS.length ? `${shown} avatars` : `${shown} of ${GROUPS.length}`;
}

async function generateAllMissing() {
    const rows = [...document.querySelectorAll('.grow-card')].filter(r => !bakedKeys.has(r._meta.group.key));
    const allBtn = document.getElementById('gen-all');
    allBtn.disabled = true;
    const gstatus = document.getElementById('gstatus');
    let done = 0;
    for (const row of rows) {
        const { group, btn, status, holder } = row._meta;
        gstatus.textContent = `generating ${done + 1} / ${rows.length} — ${group.key}…`;
        await generateRow(group, randomSeed(), { btn, status, holder });
        done++;
    }
    gstatus.textContent = `done — generated ${done} avatar(s).`;
    allBtn.disabled = false;
    updateAllBtn();
}
function updateAllBtn() {
    const missing = GROUPS.filter(g => !bakedKeys.has(g.key)).length;
    const allBtn = document.getElementById('gen-all');
    allBtn.textContent = missing ? `Generate all missing (${missing})` : 'All generated ✓';
    allBtn.disabled = !comfyOk || missing === 0;
}

// ---- identity editing (rename / retheme a creature) ----
// Saved identities flow back into model-identity.resolveModel via applyIdentityOverrides,
// so a rename shows in the lab AND the game (HUD subtitle, leaderboard, win screens).

// Build the still prompt for a motif without mutating the shared family object.
function stillFromMotif(resolved, motif) {
    return avatarPrompt({ ...resolved, family: { ...resolved.family, promptMotif: motif } }, STYLE);
}
// Re-resolve a group and refresh its row label + the modal title, after a rename.
function refreshRowIdentity(group) {
    group.resolved = resolveModel(group.models[0]);
    const r = group.resolved;
    const meta = rowMetaByKey.get(group.key);
    if (meta && meta.nameDiv) {
        meta.nameDiv.innerHTML =
            `${r.family.label} · ${r.family.archetype} <span class="tier-tag" style="background:${tierColor(r.sizeTier)};color:#0c1013">${r.tier.label}</span>`
            + ` <span class="fam-count">${familyCountLabel(group)}</span>`;
    }
    if (previewGroup && previewGroup.key === group.key) {
        document.getElementById('preview-title').innerHTML =
            `${r.family.label} · ${r.family.archetype} `
            + `<span class="tier-tag" style="background:${tierColor(r.sizeTier)};color:#0c1013">${r.tier.label}</span> `
            + `<span class="key-pill">${group.key}</span>`;
    }
}

async function saveIdentityFromModal() {
    const group = previewGroup;
    if (!group) return;
    const status = document.getElementById('identity-status');
    const label = document.getElementById('preview-name').value.trim();
    const archetype = document.getElementById('preview-archetype').value.trim();
    const motif = document.getElementById('preview-motif').value.trim();
    status.className = 'status-pill working'; status.textContent = 'saving…';
    try {
        await fetch('/lab/identity', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: group.key, label, archetype, motif }),
        });
        const entry = {};
        if (label) entry.label = label;
        if (archetype) entry.archetype = archetype;
        if (motif) entry.motif = motif;
        if (Object.keys(entry).length) identityOverrides[group.key] = entry;
        else delete identityOverrides[group.key];
        applyIdentityOverrides(identityOverrides);

        // An AI revision also stages a still + motion set; commit them so what's
        // shown is what bakes. (A plain rename leaves the prompts untouched.)
        if (pendingMotions) {
            // Rebuild the still from the motif field so this is correct regardless
            // of which tab's prompt is currently showing.
            await saveOverride('still', group.key, motif ? stillFromMotif(group.resolved, motif) : '');
            for (const cat of VIDEO_CATEGORIES) {
                if (pendingMotions[cat]) await saveOverride(cat, group.key, pendingMotions[cat]);
            }
            syncRowMotions(group);
            pendingMotions = null;
        }
        refreshRowIdentity(group);
        syncStudioControls(group);                 // repopulate the visible prompt from saved state
        syncRowPrompt(group, stillPromptFor(group));
        status.className = 'status-pill baked'; status.textContent = 'saved ✓';
    } catch (e) {
        status.className = 'status-pill error'; status.textContent = 'failed';
        console.error('save identity failed', group.key, e);
    }
}

async function resetIdentityFromModal() {
    const group = previewGroup;
    if (!group) return;
    await fetch('/lab/identity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: group.key, label: '', archetype: '', motif: '' }),
    });
    delete identityOverrides[group.key];
    applyIdentityOverrides(identityOverrides);
    refreshRowIdentity(group);
    fillIdentityFields(group);
    const status = document.getElementById('identity-status');
    status.className = 'status-pill'; status.textContent = 'reset ✓';
}

// Mirror staged motion prompts into any open row clip textareas.
function syncRowMotions(group) {
    const meta = rowMetaByKey.get(group.key);
    if (!meta) return;
    meta.row.querySelectorAll('.clip-slot').forEach((slot, i) => {
        const cat = VIDEO_CATEGORIES[i];
        const box = slot.querySelector('.motion-edit');
        if (box && cat) box.value = motionPromptFor(group, cat);
    });
}

// ---- AI-assisted re-prompting ----
// Runs on the top-ranked installed model (overridable) via the Ollama proxy. It
// re-authors the creature's name/archetype/motif/motions from a director's note
// while we hold the universe constraints (style, hue, tier) fixed locally.
async function buildAssistModels() {
    let installed = [];
    try { installed = (await listOllamaModels()).map(m => m.name); } catch { /* offline */ }
    let ranked = {};
    try { const r = await fetch('/rankings'); if (r.ok) ranked = await r.json(); } catch { /* no log yet */ }
    rankings = ranked;   // shared with the studio stats panel
    const installedSet = new Set(installed);
    const rankedInstalled = Object.keys(ranked).filter(n => installedSet.has(n));   // ELO-desc
    const rest = installed.filter(n => !rankedInstalled.includes(n));
    assistModels = [...rankedInstalled, ...rest];
    const sel = document.getElementById('assist-model');
    sel.innerHTML = '';
    assistModels.forEach((name, i) => {
        const o = document.createElement('option');
        o.value = name;
        const elo = ranked[name] ? ` · ${Math.round(ranked[name].elo)} ELO` : '';
        o.textContent = (i === 0 ? '★ ' : '') + name + elo;
        sel.appendChild(o);
    });
    document.getElementById('assist-go').disabled = !assistModels.length;
}

function assistSystemPrompt(resolved) {
    const hue = resolved.palette.hue;
    return 'You are the art director for "Biome", a hex-grid ecosystem game where every AI model '
        + 'is one biome creature rendered in a "cyber-organic" style: a bio-mechanical hybrid — organic '
        + 'forms fused with glowing circuitry and metallic filigree, bioluminescent accents, a single '
        + 'centered creature on a dark background, game avatar icon.\n'
        + 'Revise ONE creature from the director note while keeping it inside this universe. HARD constraints:\n'
        + `- Exactly one creature, centered emblem, dark background, cyber-organic style.\n`
        + `- Colour identity hue is ${hue}° — keep that hue dominant.\n`
        + `- Size tier "${resolved.tier.label}": ${resolved.tier.elaboration}.\n`
        + '- No text, no humans, no multiple subjects.\n'
        + 'Return STRICT JSON only, no prose:\n'
        + '{"name":"1-2 word family name","archetype":"the creature in 1-2 words",'
        + '"motif":"one vivid sentence describing the creature (no hue, no style suffix)",'
        + '"motions":{"intro":"…","idle":"…","thinking":"…","victory":"…","defeat":"…","champion":"…"}}\n'
        + 'The six "motions" are looping-animation briefs for game moments — REWRITE ALL SIX to match the '
        + 'revised creature, expressing each emotion through THIS creature\'s specific anatomy and forms. '
        + 'Hit these emotional targets and end every motion with "dark background, centered":\n'
        + '- intro: a confident entrance — rising or stepping forward, circuitry powering on, settling into a poised ready stance.\n'
        + '- idle: calm and watchful, breathing in place, glow softly pulsing, an occasional subtle blink or head-tilt; seamless subtle loop.\n'
        + '- thinking: intense focus — scanning, eyes narrowing, circuitry rippling with pulses as it calculates; restless contemplative loop.\n'
        + '- victory: EXULTANT CELEBRATION — the creature erupts in triumphant joy, rearing up tall, blazing brighter, '
        + 'energy bursting around it; bold rising motion, dramatic and uplifting, the win celebrated with its whole body.\n'
        + '- defeat: GREAT SORROW — the creature is overcome with grief, head bowing low, body sinking and trembling, '
        + 'its glow draining to cold faint embers; slow, heavy, sinking motion, aching and heartbreaking.\n'
        + '- champion: crowned glory — ascending regal and proud, a radiant golden aura swelling around it, '
        + 'light pulsing in majestic waves; slow soaring motion, a grand triumphant crescendo.';
}

// Concise, wrapping status line under the AI-assist button (kind: ''|working|ok|err).
function setAssistStatus(kind, text) {
    const e = document.getElementById('assist-status');
    e.className = 'assist-status' + (kind ? ' is-' + kind : '');
    e.textContent = text || '';
}

async function runAssist() {
    const group = previewGroup;
    if (!group) return;
    const model = document.getElementById('assist-model').value;
    const note = document.getElementById('assist-note').value.trim();
    if (!model) { setAssistStatus('err', 'Pick a model first'); return; }
    if (!note) { setAssistStatus('err', 'Describe a change first'); return; }
    const btn = document.getElementById('assist-go');
    btn.disabled = true;
    setAssistStatus('working', `Asking ${model.split(':')[0]}…`);
    const r = group.resolved;
    const user = `Current identity:\n- name: ${r.family.label}\n- archetype: ${r.family.archetype}\n`
        + `- motif: ${r.family.promptMotif}\n\nDirector note: ${note}`;
    try {
        const resp = await fetch('/ollama/api/chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: assistSystemPrompt(r) },
                    { role: 'user', content: user },
                ],
                format: 'json', stream: false, think: false,
            }),
        });
        const data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
        // Models often wrap JSON in ```json fences or add prose — extractJSON is
        // the same robust 3-tier parse the game's AIPlayer uses.
        const out = extractJSON(data.message.content);
        if (!out) throw new Error('model returned unparseable output');
        if (out.name) document.getElementById('preview-name').value = out.name;
        if (out.archetype) document.getElementById('preview-archetype').value = out.archetype;
        pendingMotions = (out.motions && typeof out.motions === 'object') ? out.motions : null;
        if (out.motif) {
            document.getElementById('preview-motif').value = out.motif;
            // Snap to the Still tab and show the new still prompt for review.
            selectStudioTab('still');
            document.getElementById('preview-prompt').value = stillFromMotif(r, out.motif);
        }
        // Auto-render the new look so approval is visual: the user approves the
        // image they see, not just the rewritten text. Save identity then keeps it.
        if (comfyOk && out.motif) {
            setAssistStatus('working', 'Drafting the new look…');
            const ok = await respinStill(group);
            setAssistStatus(ok ? 'ok' : 'err', ok
                ? 'New look ready — its win/loss/idle animations were rewritten to match. Review above, then Save identity to keep it all.'
                : 'Revision drafted, but the preview failed — try Respin still.');
        } else if (!comfyOk) {
            setAssistStatus('ok', 'Revision drafted (incl. matching win/loss animations). Connect ComfyUI to render a preview, then Save identity.');
        } else {
            setAssistStatus('ok', 'Revision ready (incl. matching win/loss animations) — review the fields, then Save identity.');
        }
    } catch (e) {
        setAssistStatus('err', 'Failed — try again or pick another model.');
        console.error('AI assist failed', e);
    } finally {
        btn.disabled = false;
    }
}

// ════════════════════════════════════════════════════════════
//  Activity — the single, visible surface for every regeneration
//  job (still respins, single clips, bulk clip-set respins). Each
//  Respin action registers an entry here so the user always sees
//  what's running, what's queued, and what just finished.
// ════════════════════════════════════════════════════════════
let activity = [];          // {id,type,key,group,category?,label,status,startedAt,endedAt,note}
let activitySeq = 0;
let queueRunning = false;   // the bulk clip worker is draining
let queueCancel = false;
let activityTicker = null;  // 1s interval that keeps elapsed-time labels live

function pushActivity(entry) {
    const id = ++activitySeq;
    const a = { id, status: 'queued', startedAt: null, endedAt: null, note: '', ...entry };
    if (a.status === 'running' && !a.startedAt) a.startedAt = Date.now();
    activity.push(a);
    openActivity();
    renderActivity();
    return id;
}
function setActivity(id, patch) {
    const a = activity.find(x => x.id === id);
    if (!a) return;
    Object.assign(a, patch);
    if (a.status === 'running' && !a.startedAt) a.startedAt = Date.now();
    if (['done', 'failed', 'cancelled'].includes(a.status) && !a.endedAt) a.endedAt = Date.now();
    scheduleAutoClear(a);
    renderActivity();
}

// Finished items linger just long enough to be seen, then exit-animate themselves
// out — no manual "clear" needed. Failures hang around longer so they're noticed.
const CLEAR_DELAY = { done: 2600, cancelled: 1200, failed: 9000 };
function scheduleAutoClear(a) {
    if (!CLEAR_DELAY[a.status] || a._clearing) return;
    a._clearing = true;
    setTimeout(() => {
        const it = activity.find(x => x.id === a.id);
        if (!it) return;
        it.exiting = true; renderActivity();           // play the exit animation
        setTimeout(() => {                              // then drop it from the list
            activity = activity.filter(x => x.id !== a.id);
            renderActivity();
            maybeAutoHideActivity();
        }, 340);
    }, CLEAR_DELAY[a.status]);
}
function maybeAutoHideActivity() {
    const live = activity.some(a => a.status === 'running' || a.status === 'queued');
    if (!activity.length && !live) hideActivity();     // all settled → tidy itself away
}

function openActivity() { document.getElementById('activity-panel').hidden = false; }
function hideActivity() { document.getElementById('activity-panel').hidden = true; }
function toggleActivity() {
    const p = document.getElementById('activity-panel');
    p.hidden = !p.hidden;
}
function cancelActivityQueue() {
    queueCancel = true;
    for (const a of activity) if (a.status === 'queued') {
        a.status = 'cancelled'; a.endedAt = Date.now(); scheduleAutoClear(a);
    }
    renderActivity();
}

const ACT_ICON = { queued: '◌', running: '⟳', done: '✓', failed: '✕', cancelled: '–' };
function actElapsed(a) {
    if (a.status === 'queued') return 'queued';
    if (!a.startedAt) return a.status;
    const s = Math.max(0, Math.round(((a.endedAt || Date.now()) - a.startedAt) / 1000));
    return a.status === 'running' ? `${s}s…` : (a.note || `${s}s`);
}
function renderActivity() {
    const running = activity.filter(a => a.status === 'running').length;
    const queued = activity.filter(a => a.status === 'queued').length;
    const done = activity.filter(a => a.status === 'done').length;
    const failed = activity.filter(a => a.status === 'failed').length;

    // Header chip (always visible)
    const chip = document.getElementById('activity-chip');
    const chipText = document.getElementById('activity-chip-text');
    if (chip) {
        chip.className = 'activity-chip ' + (running || queued ? 'is-busy' : 'is-idle');
        chipText.textContent = (running || queued)
            ? `${running} running${queued ? ` · ${queued} queued` : ''}`
            : 'Activity';
    }

    // Panel list
    const list = document.getElementById('activity-list');
    if (list) {
        list.innerHTML = '';
        if (!activity.length) {
            list.appendChild(el('div', 'activity-empty', 'No regenerations yet. Respin a still or clips and they’ll show here.'));
        }
        for (const a of activity.slice(-40)) {
            const item = el('div', `activity-item act-${a.status}${a.exiting ? ' exiting' : ''}`);
            item.innerHTML = `<span class="act-icon">${ACT_ICON[a.status] || '·'}</span>`
                + `<span class="act-label">${a.label}</span>`
                + `<span class="act-note">${actElapsed(a)}</span>`;
            list.appendChild(item);
        }
    }

    // Summary + progress bar
    const summary = document.getElementById('activity-summary');
    if (summary) {
        summary.textContent = (running || queued)
            ? `${running} running · ${queued} queued · ${done} done`
            : (done || failed ? `${done} done${failed ? ` · ${failed} failed` : ''}` : '');
    }
    const total = activity.filter(a => a.status !== 'cancelled').length;
    const fin = done + failed;
    const fill = document.getElementById('activity-bar-fill');
    const bar = document.getElementById('activity-bar');
    if (bar && fill) {
        bar.classList.toggle('on', (running || queued) > 0);
        fill.style.width = total ? `${Math.round((fin / total) * 100)}%` : '0%';
    }

    refreshCardBadges();
    manageActivityTicker();
}
function manageActivityTicker() {
    const anyRunning = activity.some(a => a.status === 'running');
    if (anyRunning && !activityTicker) activityTicker = setInterval(renderActivity, 1000);
    else if (!anyRunning && activityTicker) { clearInterval(activityTicker); activityTicker = null; }
}
// Pulse the dashboard card of any avatar with running/queued work.
function refreshCardBadges() {
    const busy = new Set(activity.filter(a => a.status === 'running' || a.status === 'queued').map(a => a.key));
    rowMetaByKey.forEach((meta, key) => {
        if (meta && meta.row) meta.row.classList.toggle('card-working', busy.has(key));
    });
}

// ---- respin approval → bulk clip queue ----
function approveAndQueue() {
    const group = previewGroup;
    if (!group) return;
    // Default: respin the existing clip set; if none exist yet, the full set.
    const existing = VIDEO_CATEGORIES.filter(c => videoUrlFor(c, group.key));
    enqueueClips(group, existing.length ? existing : [...VIDEO_CATEGORIES]);
    document.getElementById('preview-approve-queue').disabled = true;
    document.getElementById('approve-hint').textContent = 'Queued — watch the Activity panel (top-right).';
}

function enqueueClips(group, categories) {
    for (const cat of categories) {
        pushActivity({
            type: 'clip', key: group.key, group, category: cat,
            label: `${group.resolved.family.label} · ${CATEGORY_LABEL[cat] || cat} clip`,
        });
    }
    if (!queueRunning) processQueue();
}

async function processQueue() {
    queueRunning = true; queueCancel = false;
    while (true) {
        const job = activity.find(a => a.status === 'queued' && a.type === 'clip');
        if (!job) break;
        if (queueCancel) { setActivity(job.id, { status: 'cancelled' }); continue; }
        setActivity(job.id, { status: 'running' });
        try {
            const data = await animateForQueue(job.group, job.category);
            setActivity(job.id, { status: 'done', note: `${data.seconds}s` });
            refreshCardStatus(job.group);       // update the card's clip dots
            refreshPreviewIfOpen(job.group);    // and the studio if it's open on this avatar
        } catch (e) {
            setActivity(job.id, { status: 'failed', note: String(e.message || e).slice(0, 40) });
            console.error('queue animate failed', job.group.key, job.category, e);
        }
    }
    queueRunning = false;
    renderActivity();
}

async function animateForQueue(group, category) {
    const body = {
        key: group.key, category, workflow: videoWorkflow,
        seed: randomSeed(),
        prompt: motionPromptFor(group, category),
    };
    const resp = await fetch('/comfy/animate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
    videoManifest = await loadVideoManifest(true);
    videoVer++;
    return data;
}

// ---- match-ending concept explorer ----
// A lab-only sandbox staging how the victory/defeat clips could drive the game's
// end-of-match moments — using the REAL baked clips so we can judge compositions
// and discuss integration before touching game code. Mirrors the actual end
// screens: _showChampion (#t-champ-avatar), the .pc-victor/.pc-defeated result
// cards, and the solo game-over card (#go-winner-avatar).
let conceptType = 'champion';
function groupByKey(key) { return GROUPS.find(g => g.key === key) || GROUPS[0]; }

const TIER_FLAVOR = {
    win:     { head: 'VICTORY',      tag: 'WINNER' },
    promote: { head: 'PROMOTED ▲',   tag: 'WINNER' },
    upset:   { head: 'UPSET!',       tag: 'GIANT-SLAYER' },
    throne:  { head: 'NEW CHAMPION', tag: 'CHAMPION 👑' },
};

// A looping clip if one is baked, else the still image, else the procedural emblem.
function conceptMedia(group, category, size = 320) {
    const clip = videoUrlFor(category, group.key);
    if (clip) {
        const v = el('video', 'concept-media');
        v.src = clip; v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
        v.play?.().catch(() => { /* controls-free; autoplay may defer */ });
        return v;
    }
    if (bakedKeys.has(group.key)) {
        const i = el('img', 'concept-media'); i.src = stillImageUrl(group.key); return i;
    }
    const c = avatarCanvas(group.resolved, size, 'procedural'); c.classList.add('concept-media'); return c;
}
function frameMedia(group, category, extraCls) {
    const f = el('div', 'c-frame' + (extraCls ? ' ' + extraCls : ''));
    f.appendChild(conceptMedia(group, category));
    return f;
}
function conceptScorebar() {
    const bar = el('div', 'c-scorebar');
    bar.innerHTML = `<span class="c-score-w">142</span>`
        + `<span class="c-score-track"><span class="c-score-fill" style="width:59%"></span></span>`
        + `<span class="c-score-l">97</span>`;
    return bar;
}
function conceptChampion(winner, _loser, flavor) {
    const wrap = el('div', 'c-champion');
    wrap.append(el('div', 'c-aura'), el('div', 'c-crown', '👑'),
        frameMedia(winner, 'champion', 'c-hero-frame'),
        el('div', 'c-name', winner.resolved.displayName),
        el('div', 'c-sub', flavor.tag));
    return wrap;
}
function conceptVersus(winner, loser, flavor) {
    const wrap = el('div', 'c-versus');

    // Victor — slams in from the left, ribbon stamps on, a shockwave ring pops.
    const wCard = el('div', 'c-card c-victor');
    const wFrame = frameMedia(winner, 'victory');
    wFrame.appendChild(el('span', 'c-ring'));               // celebratory shockwave
    wCard.append(el('div', 'c-ribbon', '★ ' + flavor.tag), wFrame,
        el('div', 'c-card-name', winner.resolved.displayName));

    // Defeated — slams in from the right; two red slashes carve an X, then a
    // DEFEATED stamp slams over (cues from the game's .pc-ko-x / pc-stamp).
    const lCard = el('div', 'c-card c-defeated');
    const lFrame = frameMedia(loser, 'defeat');
    const ko = el('div', 'c-ko');
    ko.append(el('span', 'c-ko-x'), el('span', 'c-ko-tag', 'DEFEATED'));
    lFrame.appendChild(ko);
    lCard.append(lFrame, el('div', 'c-card-name', loser.resolved.displayName));

    wrap.append(wCard, el('div', 'c-vs', 'VS'), lCard);
    const stack = el('div', 'c-versus-wrap');
    stack.append(wrap, conceptScorebar());
    return stack;
}
function conceptGameover(winner, loser, flavor) {
    const card = el('div', 'c-go-card');
    card.append(
        el('div', 'c-go-head', flavor.head),
        frameMedia(winner, 'victory', 'c-go-media'),
        el('div', 'c-go-name', `${winner.resolved.displayName} wins`),
        el('div', 'c-go-vs', `def. ${loser.resolved.displayName}`),
        conceptScorebar(),
        el('div', 'c-go-statement', '“The ecosystem favored the bold.” — placeholder final statement'));
    return card;
}
// In-play: the two live clips that ride the HUD during a match — idle (resting on
// the board) and thinking (computing a move) — shown side by side so each loop can
// be judged. Uses winner→idle, loser→thinking so both pickers matter.
function conceptInplay(winner, loser, _flavor) {
    const wrap = el('div', 'c-inplay');
    const col = (group, cat, cap) => {
        const c = el('div', 'c-inplay-col');
        c.append(frameMedia(group, cat), el('div', 'c-inplay-cap', cap),
            el('div', 'c-card-name', group.resolved.displayName));
        return c;
    };
    wrap.append(col(winner, 'idle', '🌙 Idle · resting on the board'),
        col(loser, 'thinking', '🧠 Thinking · computing a move'));
    return wrap;
}
const CONCEPTS = { champion: conceptChampion, versus: conceptVersus, gameover: conceptGameover, inplay: conceptInplay };

function renderConcept() {
    const stage = document.getElementById('concept-stage');
    const body = document.getElementById('concept-body');
    const tier = document.getElementById('concept-tier').value;
    const flavor = TIER_FLAVOR[tier] || TIER_FLAVOR.win;
    const winner = groupByKey(document.getElementById('concept-winner').value);
    const loser = groupByKey(document.getElementById('concept-loser').value);
    stage.className = 'concept-stage c-tier-' + tier;   // hidden is a property, untouched
    body.innerHTML = '';
    body.appendChild((CONCEPTS[conceptType] || conceptChampion)(winner, loser, flavor));
}
function fillConceptSelect(sel, preferCategory) {
    sel.innerHTML = '';
    for (const g of GROUPS) {
        const o = document.createElement('option');
        o.value = g.key;
        o.textContent = g.resolved.displayName + (videoUrlFor(preferCategory, g.key) ? ' ●' : '');
        sel.appendChild(o);
    }
}
function openConcepts() {
    if (!GROUPS.length) return;
    const winSel = document.getElementById('concept-winner');
    const loseSel = document.getElementById('concept-loser');
    fillConceptSelect(winSel, 'victory');
    fillConceptSelect(loseSel, 'defeat');
    // defaults: someone with a victory clip as winner, a different avatar as loser
    const wDef = GROUPS.find(g => videoUrlFor('victory', g.key)) || GROUPS.find(g => bakedKeys.has(g.key)) || GROUPS[0];
    const lDef = GROUPS.find(g => videoUrlFor('defeat', g.key) && g.key !== wDef.key)
        || GROUPS.find(g => g.key !== wDef.key) || wDef;
    winSel.value = wDef.key; loseSel.value = lDef.key;
    document.getElementById('concept-stage').hidden = false;
    renderConcept();
}
function closeConcepts() {
    document.getElementById('concept-stage').hidden = true;
    document.getElementById('concept-body').innerHTML = '';   // stop video decoding
}

// ---- reference sections (collapsed) ----
function buildMatrix() {
    const matrix = document.getElementById('matrix');
    if (!matrix) return;
    matrix.innerHTML = '';
    matrix.style.gridTemplateColumns = `var(--rowhead) repeat(${STYLE_IDS.length + 1}, 1fr)`;
    matrix.appendChild(el('div', 'corner', '<div class="colhead-label">Model</div>'));
    matrix.appendChild(el('div', 'colhead', '<div class="colhead-label">Procedural</div>'));
    for (const id of STYLE_IDS) {
        matrix.appendChild(el('div', 'colhead',
            `<div class="colhead-label">${STYLE_PRESETS[id].label}${id === STYLE ? ' ★' : ''}</div>`));
    }
    for (const name of COMPARE_SET) {
        const r = resolveModel(name);
        matrix.appendChild(el('div', 'rowhead', `<div class="rowhead-name">${r.displayName}</div>`
            + `<div class="kv"><span class="key-pill">${r.avatarKey}</span></div>`));
        const mk = (kind) => { const c = el('div', 'mcell'); c.appendChild(avatarCanvas(r, 84, kind)); return c; };
        matrix.appendChild(mk('procedural'));
        for (const id of STYLE_IDS) matrix.appendChild(mk(id));
    }
}

async function buildRoster() {
    let installed = [];
    try { installed = (await listOllamaModels()).map(m => m.name); } catch { /* offline */ }
    const all = [...installed, ...RECOMMENDED_MODELS.map(m => m.name), ...CLOUD_SEEN, ...UNKNOWN_STRESS];
    const seen = new Set();
    const rows = document.getElementById('rows');
    if (!rows) return;
    rows.innerHTML = '';
    for (const name of all) {
        if (seen.has(name)) continue;
        seen.add(name);
        const r = resolveModel(name);
        const row = el('div', 'rrow');
        const hero = el('div', 'rrow-hero');
        hero.appendChild(avatarCanvas(r, 56, 'procedural'));
        row.appendChild(hero);
        row.appendChild(el('div', 'rrow-meta',
            `<div class="rrow-name">${r.displayName} <span class="rrow-vendor">${r.vendor}</span></div>`
            + `<div class="rrow-kv">${r.family.label} · ${r.family.archetype} · <span class="key-pill">${r.avatarKey}</span></div>`));
        rows.appendChild(row);
    }
}

// ---- init ----
async function checkHealth() {
    try {
        const r = await fetch('/comfy/health');
        comfyOk = (await r.json()).comfy === true;
    } catch { comfyOk = false; }
    const pill = document.getElementById('comfy-pill');
    pill.className = 'status-pill ' + (comfyOk ? 'baked' : 'error');
    pill.textContent = comfyOk ? 'ComfyUI :8188 connected' : 'ComfyUI offline (start on :8188)';
}

(async function init() {
    await checkHealth();
    const manifest = await generated.loadManifest();
    bakedKeys = new Set(Object.keys(manifest[STYLE] || {}));
    overrides = await loadOverrides();
    identityOverrides = await loadIdentityOverrides();   // also applies them to resolveModel
    videoManifest = await loadVideoManifest();

    const vq = document.getElementById('vquality');
    if (vq) { vq.value = videoWorkflow; vq.onchange = () => { videoWorkflow = vq.value; }; }

    const modal = document.getElementById('preview-modal');
    document.getElementById('preview-close').onclick = closePreview;
    modal.onclick = (e) => { if (e.target === modal) closePreview(); };  // backdrop click
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closePreview(); });
    document.getElementById('preview-regen').onclick = respinFromStudio;
    document.querySelectorAll('.studio-tab').forEach((t) => { t.onclick = () => selectStudioTab(t.dataset.tab); });
    // Save/Reset act on whichever prompt is showing — the still, or the active clip.
    document.getElementById('preview-save').onclick = async (e) => {
        if (!previewGroup) return;
        const text = document.getElementById('preview-prompt').value;
        if (studioTab === 'still') { await saveOverride('still', previewGroup.key, text); syncRowPrompt(previewGroup, text); }
        else { await saveOverride(studioTab, previewGroup.key, text); syncRowMotions(previewGroup); }
        flash(e.target, 'Saved ✓');
    };
    document.getElementById('preview-reset').onclick = async (e) => {
        if (!previewGroup) return;
        if (studioTab === 'still') {
            await saveOverride('still', previewGroup.key, '');
            document.getElementById('preview-prompt').value = avatarPrompt(previewGroup.resolved, STYLE);
            syncRowPrompt(previewGroup, '');
        } else {
            await saveOverride(studioTab, previewGroup.key, '');
            document.getElementById('preview-prompt').value = motionPrompt(previewGroup.resolved, studioTab);
            syncRowMotions(previewGroup);
        }
        flash(e.target, 'Reset ✓');
    };

    // Identity editing + AI assist + respin-queue wiring.
    document.getElementById('identity-save').onclick = saveIdentityFromModal;
    document.getElementById('identity-reset').onclick = resetIdentityFromModal;
    document.getElementById('assist-go').onclick = runAssist;
    document.getElementById('preview-approve-queue').onclick = approveAndQueue;
    document.getElementById('activity-chip').onclick = toggleActivity;
    document.getElementById('activity-cancel').onclick = cancelActivityQueue;
    document.getElementById('activity-hide').onclick = hideActivity;
    renderActivity();   // paint the idle chip
    await buildAssistModels();

    document.getElementById('open-concepts').onclick = openConcepts;
    document.getElementById('concept-close').onclick = closeConcepts;
    document.getElementById('concept-replay').onclick = renderConcept;   // re-trigger the reveal
    document.getElementById('concept-winner').onchange = renderConcept;
    document.getElementById('concept-loser').onchange = renderConcept;
    document.getElementById('concept-tier').onchange = renderConcept;
    document.querySelectorAll('.concept-tab').forEach((t) => { t.onclick = () => {
        conceptType = t.dataset.concept;
        document.querySelectorAll('.concept-tab').forEach((x) => x.classList.toggle('is-on', x === t));
        renderConcept();
    }; });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !document.getElementById('concept-stage').hidden) closeConcepts();
    });

    const { groups, installedCount } = await runningGroups();
    GROUPS = groups;
    document.getElementById('gsummary').textContent =
        `${installedCount} models installed → ${groups.length} unique avatars`;
    populateFamilyFilter();
    renderDashboard();
    updateAllBtn();
    document.getElementById('gen-all').onclick = generateAllMissing;
    document.getElementById('dash-search').oninput = applyDashFilter;
    document.getElementById('dash-family').onchange = applyDashFilter;
    document.getElementById('dash-unbaked').onchange = applyDashFilter;
    document.getElementById('dash-clips').onchange = applyDashFilter;
    document.getElementById('refresh').onclick = async () => {
        await checkHealth();
        const m = await generated.loadManifest(Date.now());
        bakedKeys = new Set(Object.keys(m[STYLE] || {}));
        overrides = await loadOverrides(true);
        identityOverrides = await loadIdentityOverrides(true);   // reapply renames
        videoManifest = await loadVideoManifest(true); videoVer++;
        statCache.clear(); await buildAssistModels();            // refresh ELO/stats too
        GROUPS = (await runningGroups()).groups;                 // re-resolve labels/counts
        populateFamilyFilter();
        renderDashboard(); updateAllBtn();
    };

    buildMatrix();
    buildRoster();
})();
