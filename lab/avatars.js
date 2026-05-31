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
    SIZE_TIERS, TIER_ORDER,
} from '../js/model-identity.js';
import { makeCanvas } from './lab-util.js';
import * as procedural from './avatar-styles/procedural.js';
import * as generated from './avatar-styles/generated.js';

const STYLE = 'cyber-organic';          // the committed direction
const LORA = STYLE_PRESETS[STYLE].lora;
const STYLE_IDS = Object.keys(STYLE_PRESETS);

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
function stableSeed(key) {           // deterministic default so a row reproduces
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 131 + key.charCodeAt(i)) >>> 0;
    return h % 1000000;
}
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
    for (const name of installed) {
        const r = resolveModel(name);
        if (!groups.has(r.avatarKey)) groups.set(r.avatarKey, { key: r.avatarKey, resolved: r, models: [] });
        groups.get(r.avatarKey).models.push(name);
    }
    return { groups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)), installedCount: installed.length };
}

function paintAvatar(holder, resolved) {
    holder.innerHTML = '';
    holder.appendChild(avatarCanvas(resolved, 96, STYLE));
}

async function generateRow(group, seed, rowEls) {
    const { btn, status, holder } = rowEls;
    btn.disabled = true;
    status.className = 'status-pill working';
    status.textContent = 'generating…';
    try {
        const body = {
            key: group.key, style: STYLE,
            prompt: avatarPrompt(group.resolved, STYLE),
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
        paintAvatar(holder, group.resolved);
        status.className = 'status-pill baked';
        status.textContent = `baked · ${data.seconds}s`;
        btn.textContent = 'Regenerate';
        return true;
    } catch (e) {
        status.className = 'status-pill error';
        status.textContent = 'failed';
        console.error('generate failed', group.key, e);
        return false;
    } finally {
        btn.disabled = !comfyOk;
    }
}

function buildGroupRow(group) {
    const r = group.resolved;
    const baked = bakedKeys.has(group.key);
    const row = el('div', 'grow');

    const holder = el('div', 'grow-av');
    paintAvatar(holder, r);
    row.appendChild(holder);

    const mid = el('div', 'grow-mid');
    mid.appendChild(el('div', 'grow-name',
        `${r.family.label} · ${r.family.archetype} <span class="tier-tag" style="background:${tierColor(r.sizeTier)};color:#0c1013">${r.tier.label}</span>`));
    mid.appendChild(el('div', 'grow-models', group.models.map(m => `<code>${m}</code>`).join(' ')));
    const det = el('details', 'grow-prompt');
    det.appendChild(el('summary', null, `<span class="key-pill">${group.key}</span> prompt`));
    det.appendChild(el('div', 'prompt-text', avatarPrompt(r, STYLE)));
    mid.appendChild(det);
    row.appendChild(mid);

    const ctrl = el('div', 'grow-ctrl');
    const status = el('span', `status-pill ${baked ? 'baked' : 'missing'}`, baked ? 'baked' : 'not generated');
    ctrl.appendChild(status);
    const seedWrap = el('label', 'seed-wrap', 'seed ');
    const seedInput = el('input', 'seed-input');
    seedInput.type = 'number';
    seedInput.value = stableSeed(group.key);
    seedWrap.appendChild(seedInput);
    const dice = el('button', 'dice', '🎲');
    dice.title = 'randomize seed';
    dice.onclick = () => { seedInput.value = Math.floor(Math.random() * 1000000); };
    seedWrap.appendChild(dice);
    ctrl.appendChild(seedWrap);
    const btn = el('button', 'gen-btn', baked ? 'Regenerate' : 'Generate');
    btn.disabled = !comfyOk;
    const rowEls = { btn, status, holder };
    btn.onclick = () => generateRow(group, parseInt(seedInput.value, 10) || 0, rowEls);
    ctrl.appendChild(btn);
    row.appendChild(ctrl);

    row._meta = { group, btn, status, holder, seedInput };
    return row;
}

let GROUPS = [];
function renderDashboard() {
    const wrap = document.getElementById('groups');
    wrap.innerHTML = '';
    for (const g of GROUPS) wrap.appendChild(buildGroupRow(g));
}

async function generateAllMissing() {
    const rows = [...document.querySelectorAll('.grow')].filter(r => !bakedKeys.has(r._meta.group.key));
    const allBtn = document.getElementById('gen-all');
    allBtn.disabled = true;
    const gstatus = document.getElementById('gstatus');
    let done = 0;
    for (const row of rows) {
        const { group, btn, status, holder, seedInput } = row._meta;
        gstatus.textContent = `generating ${done + 1} / ${rows.length} — ${group.key}…`;
        await generateRow(group, parseInt(seedInput.value, 10) || 0, { btn, status, holder });
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

    const { groups, installedCount } = await runningGroups();
    GROUPS = groups;
    document.getElementById('gsummary').textContent =
        `${installedCount} models installed → ${groups.length} unique avatars`;
    renderDashboard();
    updateAllBtn();
    document.getElementById('gen-all').onclick = generateAllMissing;
    document.getElementById('refresh').onclick = async () => {
        await checkHealth();
        const m = await generated.loadManifest(Date.now());
        bakedKeys = new Set(Object.keys(m[STYLE] || {}));
        renderDashboard(); updateAllBtn();
    };

    buildMatrix();
    buildRoster();
})();
