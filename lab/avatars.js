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
const rowMetaByKey = new Map(); // key → { group, row, holder, status, btn, promptBox } for cross-updates

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

// Paint the modal stage: baked → the 512px PNG (cache-busted); not yet baked →
// the procedural placeholder at size.
function setPreviewStage(group) {
    const stage = document.getElementById('preview-stage');
    stage.innerHTML = '';
    if (bakedKeys.has(group.key)) {
        const img = el('img', 'modal-img');
        img.src = stillImageUrl(group.key);
        img.alt = group.key;
        stage.appendChild(img);
    } else {
        const c = avatarCanvas(group.resolved, 480, 'procedural');
        c.classList.add('modal-img');
        stage.appendChild(c);
    }
}

// Full-size base-image preview + regeneration for quality review before animating.
function openPreview(group) {
    previewGroup = group;
    const r = group.resolved;
    const baked = bakedKeys.has(group.key);
    document.getElementById('preview-title').innerHTML =
        `${r.family.label} · ${r.family.archetype} `
        + `<span class="tier-tag" style="background:${tierColor(r.sizeTier)};color:#0c1013">${r.tier.label}</span> `
        + `<span class="key-pill">${group.key}</span>`;
    setPreviewStage(group);
    document.getElementById('preview-note').hidden = baked;
    document.getElementById('preview-prompt').value = stillPromptFor(group);
    document.getElementById('preview-seed').value = stableSeed(group.key);
    const status = document.getElementById('preview-status');
    status.className = `status-pill ${baked ? 'baked' : 'missing'}`;
    status.textContent = baked ? 'baked' : 'not generated';
    const regen = document.getElementById('preview-regen');
    regen.disabled = !comfyOk;
    regen.textContent = baked ? 'Regenerate' : 'Generate';
    document.getElementById('preview-modal').hidden = false;
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
// If the modal is showing this group, refresh its image + status after a row regen.
function refreshPreviewIfOpen(group) {
    const modal = document.getElementById('preview-modal');
    if (!previewGroup || previewGroup.key !== group.key || modal.hidden) return;
    setPreviewStage(group);
    document.getElementById('preview-note').hidden = bakedKeys.has(group.key);
    const status = document.getElementById('preview-status');
    status.className = 'status-pill baked'; status.textContent = 'baked';
    document.getElementById('preview-regen').textContent = 'Regenerate';
}

async function regenerateFromModal() {
    const group = previewGroup;
    if (!group) return;
    const wasBaked = bakedKeys.has(group.key);
    const seed = parseInt(document.getElementById('preview-seed').value, 10) || 0;
    const promptText = document.getElementById('preview-prompt').value;
    const btn = document.getElementById('preview-regen');
    const status = document.getElementById('preview-status');
    btn.disabled = true;
    status.className = 'status-pill working';
    status.textContent = 'generating…';
    try {
        const data = await generateStill(group, seed, promptText);
        setPreviewStage(group);
        document.getElementById('preview-note').hidden = true;
        status.className = 'status-pill baked';
        status.textContent = `baked · ${data.seconds}s`;
        btn.textContent = 'Regenerate';
        repaintRow(group);
        if (!wasBaked) enableRowStudio(group);
        updateAllBtn();
    } catch (e) {
        status.className = 'status-pill error';
        status.textContent = 'failed';
        console.error('modal regen failed', group.key, e);
    } finally {
        btn.disabled = !comfyOk;
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
    try {
        const data = await generateStill(group, seed, promptBox && promptBox.value);
        paintAvatar(holder, group.resolved);
        status.className = 'status-pill baked';
        status.textContent = `baked · ${data.seconds}s`;
        btn.textContent = 'Regenerate';
        if (!wasBaked) enableRowStudio(group);   // a first bake unlocks its clip slots
        refreshPreviewIfOpen(group);             // keep an open modal in sync
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
    holder.title = 'Click for a full-size preview';
    holder.onclick = () => openPreview(group);
    row.appendChild(holder);

    const mid = el('div', 'grow-mid');
    mid.appendChild(el('div', 'grow-name',
        `${r.family.label} · ${r.family.archetype} <span class="tier-tag" style="background:${tierColor(r.sizeTier)};color:#0c1013">${r.tier.label}</span>`));
    mid.appendChild(el('div', 'grow-models', group.models.map(m => `<code>${m}</code>`).join(' ')));
    const det = el('details', 'grow-prompt');
    det.appendChild(el('summary', null, `<span class="key-pill">${group.key}</span> still prompt`));
    const promptBox = el('textarea', 'prompt-edit');
    promptBox.value = stillPromptFor(group);
    promptBox.rows = 4;
    det.appendChild(promptBox);
    const pctrl = el('div', 'prompt-ctrl');
    const pSave = el('button', 'mini-btn', 'Save');
    const pReset = el('button', 'mini-btn ghost', 'Reset to default');
    pSave.onclick = async () => { await saveOverride('still', group.key, promptBox.value); flash(pSave, 'Saved ✓'); };
    pReset.onclick = async () => {
        await saveOverride('still', group.key, '');
        promptBox.value = avatarPrompt(r, STYLE); flash(pReset, 'Reset ✓');
    };
    pctrl.append(pSave, pReset);
    det.appendChild(pctrl);
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
    const rowEls = { btn, status, holder, promptBox };
    btn.onclick = () => generateRow(group, parseInt(seedInput.value, 10) || 0, rowEls);
    ctrl.appendChild(btn);
    row.appendChild(ctrl);

    // Animation studio spans the full row width (the row is a 3-col grid).
    row.appendChild(buildAnimStudio(group));

    rowMetaByKey.set(group.key, { group, row, holder, status, btn, promptBox });
    row._meta = { group, btn, status, holder, seedInput, promptBox };
    return row;
}

// Per-avatar animation studio: one collapsible block with a Victory + Defeat clip
// slot. Each slot animates the baked still into videos/<category>/<key>.mp4 via the
// WAN i2v bridge and previews the result inline.
function buildAnimStudio(group) {
    const studio = el('details', 'anim-studio');
    const stillBaked = bakedKeys.has(group.key);
    studio.appendChild(el('summary', null,
        `🎬 Animation studio <span class="muted-tag">victory · defeat clips</span>`));
    const body = el('div', 'studio-body');
    if (!stillBaked) {
        body.appendChild(el('p', 'hint', 'Generate this avatar’s still first — the portrait is the animation’s start frame.'));
    }
    for (const cat of VIDEO_CATEGORIES) body.appendChild(buildClipSlot(group, cat));
    studio.appendChild(body);
    return studio;
}

function buildClipSlot(group, category) {
    const slot = el('div', 'clip-slot');
    slot.appendChild(el('div', 'clip-head', CATEGORY_LABEL[category] || category));

    const vid = el('video', 'clip-video');
    vid.muted = true; vid.loop = true; vid.playsInline = true; vid.controls = true;
    const url = videoUrlFor(category, group.key);
    if (url) vid.src = url; else slot.classList.add('no-clip');
    slot.appendChild(vid);

    const motionBox = el('textarea', 'motion-edit');
    motionBox.value = motionPromptFor(group, category);
    motionBox.rows = 3;
    slot.appendChild(motionBox);

    const mctrl = el('div', 'prompt-ctrl');
    const mSave = el('button', 'mini-btn', 'Save');
    const mReset = el('button', 'mini-btn ghost', 'Reset');
    mSave.onclick = async () => { await saveOverride(category, group.key, motionBox.value); flash(mSave, 'Saved ✓'); };
    mReset.onclick = async () => {
        await saveOverride(category, group.key, '');
        motionBox.value = motionPrompt(group.resolved, category); flash(mReset, 'Reset ✓');
    };
    mctrl.append(mSave, mReset);
    slot.appendChild(mctrl);

    const ctrl = el('div', 'clip-ctrl');
    const status = el('span', `status-pill ${url ? 'baked' : 'missing'}`, url ? 'baked' : 'not generated');
    ctrl.appendChild(status);
    const seedWrap = el('label', 'seed-wrap', 'seed ');
    const seedInput = el('input', 'seed-input');
    seedInput.type = 'number';
    seedInput.value = stableSeed(group.key + ':' + category);
    const dice = el('button', 'dice', '🎲');
    dice.title = 'randomize seed';
    dice.onclick = () => { seedInput.value = Math.floor(Math.random() * 1000000); };
    seedWrap.append(seedInput, dice);
    ctrl.appendChild(seedWrap);

    const stillBaked = bakedKeys.has(group.key);
    const btn = el('button', 'gen-btn', url ? 'Regenerate' : 'Animate');
    btn.disabled = !comfyOk || !stillBaked;
    if (!stillBaked) btn.title = 'generate the avatar still first';
    btn.onclick = () => animateClip(group, category,
        parseInt(seedInput.value, 10) || 0, motionBox, { btn, status, vid });
    ctrl.appendChild(btn);
    slot.appendChild(ctrl);
    return slot;
}

async function animateClip(group, category, seed, motionBox, els) {
    const { btn, status, vid } = els;
    btn.disabled = true;
    status.className = 'status-pill working';
    status.textContent = `animating… (${videoWorkflow})`;
    try {
        const body = {
            key: group.key, category, workflow: videoWorkflow, seed,
            prompt: motionBox.value.trim() || motionPrompt(group.resolved, category),
        };
        const resp = await fetch('/comfy/animate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const data = await resp.json();
        if (!resp.ok || data.error) throw new Error(data.error || `HTTP ${resp.status}`);
        videoManifest = await loadVideoManifest(true);
        videoVer++;
        vid.closest('.clip-slot').classList.remove('no-clip');
        vid.src = videoUrlFor(category, group.key);
        vid.load();
        vid.play().catch(() => { /* autoplay may be blocked; controls remain */ });
        status.className = 'status-pill baked';
        status.textContent = `baked · ${data.seconds}s`;
        btn.textContent = 'Regenerate';
        return true;
    } catch (e) {
        status.className = 'status-pill error';
        status.textContent = 'failed';
        console.error('animate failed', group.key, category, e);
        return false;
    } finally {
        btn.disabled = !comfyOk || !bakedKeys.has(group.key);
    }
}

let GROUPS = [];
function renderDashboard() {
    const wrap = document.getElementById('groups');
    wrap.innerHTML = '';
    rowMetaByKey.clear();
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
        frameMedia(winner, 'victory', 'c-hero-frame'),
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
const CONCEPTS = { champion: conceptChampion, versus: conceptVersus, gameover: conceptGameover };

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
    videoManifest = await loadVideoManifest();

    const vq = document.getElementById('vquality');
    if (vq) { vq.value = videoWorkflow; vq.onchange = () => { videoWorkflow = vq.value; }; }

    const modal = document.getElementById('preview-modal');
    document.getElementById('preview-close').onclick = closePreview;
    modal.onclick = (e) => { if (e.target === modal) closePreview(); };  // backdrop click
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closePreview(); });
    document.getElementById('preview-regen').onclick = regenerateFromModal;
    document.getElementById('preview-dice').onclick = () => {
        document.getElementById('preview-seed').value = Math.floor(Math.random() * 1000000);
    };
    document.getElementById('preview-save').onclick = async (e) => {
        if (!previewGroup) return;
        const text = document.getElementById('preview-prompt').value;
        await saveOverride('still', previewGroup.key, text);
        syncRowPrompt(previewGroup, text);
        flash(e.target, 'Saved ✓');
    };
    document.getElementById('preview-reset').onclick = async (e) => {
        if (!previewGroup) return;
        await saveOverride('still', previewGroup.key, '');
        document.getElementById('preview-prompt').value = avatarPrompt(previewGroup.resolved, STYLE);
        syncRowPrompt(previewGroup, '');
        flash(e.target, 'Reset ✓');
    };

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
    renderDashboard();
    updateAllBtn();
    document.getElementById('gen-all').onclick = generateAllMissing;
    document.getElementById('refresh').onclick = async () => {
        await checkHealth();
        const m = await generated.loadManifest(Date.now());
        bakedKeys = new Set(Object.keys(m[STYLE] || {}));
        overrides = await loadOverrides(true);
        videoManifest = await loadVideoManifest(true); videoVer++;
        renderDashboard(); updateAllBtn();
    };

    buildMatrix();
    buildRoster();
})();
