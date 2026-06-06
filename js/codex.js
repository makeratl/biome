// Field Guide ("Codex") — the game's only player-facing explainer.
//
// Biome uses invented species names (Sedgeweave, Shadestalker…) that mean
// nothing to a newcomer, and a scoreboard whose math is invisible. This modal
// decodes both: it groups the six species into their trophic tiers, draws each
// with the *actual* board art (one source of truth via organism-art.js), shows
// who-eats-whom, and lays out exactly how a round is scored.
//
// Reachable two ways: "How to Play" on the launcher, and a "?" affordance in
// the live HUD so a spectator can decode names without leaving the match.
// Content is derived from CONFIG so it never drifts from balance changes.

import { CONFIG } from './config.js';
import { drawOrganism } from './organism-art.js';

const TIER_ORDER = ['plant', 'herbivore', 'predator'];
const TIER_LABEL = { plant: 'Producers', herbivore: 'Herbivores', predator: 'Predators' };
const TIER_SUB = {
    plant: 'Turn terrain nutrients into living energy, and spread on their own.',
    herbivore: 'Roam the map eating plants. Worth 2× their energy when scored.',
    predator: 'Hunt herbivores. Worth 3× — and they complete the food chain.',
};

let _overlay = null;
let _keyHandler = null;

function speciesIn(type) {
    return Object.entries(CONFIG.SPECIES).filter(([, s]) => s.type === type);
}

// What this species eats — its diet, mapped to display names.
function eatsNames(spec) {
    if (!spec.diet?.length) return [];
    return spec.diet.map(id => CONFIG.SPECIES[id]?.name).filter(Boolean);
}

// What eats this species — herbivores whose diet lists it, plus every predator
// if it's a herbivore. Predators are eaten by nothing.
function eatenByNames(spId, spec) {
    const names = [];
    for (const [id, s] of Object.entries(CONFIG.SPECIES)) {
        if (id === spId) continue;
        if (s.type === 'herbivore' && s.diet?.includes(spId)) names.push(s.name);
        if (s.type === 'predator' && spec.type === 'herbivore') names.push(s.name);
    }
    return names;
}

function relLine(label, names) {
    if (!names.length) return '';
    return `<span class="cdx-rel"><span class="cdx-rel-k">${label}</span> ${names.join(', ')}</span>`;
}

function speciesCardHTML(id, spec) {
    const eats = relLine('Eats', eatsNames(spec));
    const eaten = relLine('Eaten by', eatenByNames(id, spec));
    const rels = (eats || eaten) ? `<div class="cdx-rels">${eats}${eaten}</div>` : '';
    return `
        <div class="cdx-card">
            <canvas class="cdx-icon" data-species="${id}"></canvas>
            <div class="cdx-info">
                <div class="cdx-name-row">
                    <span class="cdx-name">${spec.name}</span>
                    <span class="cdx-meta">${spec.role} · ${spec.apCost} AP</span>
                </div>
                <div class="cdx-blurb">${spec.blurb || ''}</div>
                ${rels}
            </div>
        </div>`;
}

function tierHTML(type) {
    const cards = speciesIn(type).map(([id, s]) => speciesCardHTML(id, s)).join('');
    return `
        <div class="cdx-tier cdx-tier-${type}">
            <div class="cdx-tier-head">
                <span class="cdx-tier-name">${TIER_LABEL[type]}</span>
                <span class="cdx-tier-sub">${TIER_SUB[type]}</span>
            </div>
            <div class="cdx-cards">${cards}</div>
        </div>`;
}

function scoringHTML() {
    const S = CONFIG.SCORING;
    const div = Math.round(S.SPECIES_DIVERSITY_BONUS * 100);
    const tro = Math.round(S.TROPHIC_BONUS * 100);
    return `
        <div class="cdx-scoring">
            <div class="cdx-tier-head">
                <span class="cdx-tier-name">How a round is scored</span>
                <span class="cdx-tier-sub">Highest score wins. Score rewards a living, balanced ecosystem — not a grass monoculture.</span>
            </div>
            <ul class="cdx-score-list">
                <li><b>Weighted energy</b> — sum of every living organism's energy. Herbivores count <b>×${S.HERBIVORE_WEIGHT}</b>, predators <b>×${S.PREDATOR_WEIGHT}</b>.</li>
                <li><b>Diversity bonus</b> — <b>+${div}%</b> for each different species you keep alive.</li>
                <li><b>Food-chain bonus</b> — <b>+${tro}%</b> if all three tiers (plant + herbivore + predator) survive the round.</li>
            </ul>
            <div class="cdx-flow">
                <span class="cdx-flow-node n-plant">Plants</span>
                <span class="cdx-flow-arrow">→</span>
                <span class="cdx-flow-node n-herb">Herbivores</span>
                <span class="cdx-flow-arrow">→</span>
                <span class="cdx-flow-node n-pred">Predators</span>
            </div>
        </div>`;
}

function buildOverlay() {
    const el = document.createElement('div');
    el.id = 'codex-overlay';
    el.className = 'cdx-overlay event-stage cdx-hidden';
    el.innerHTML = `
        <div class="cdx-modal" role="dialog" aria-label="Field Guide">
            <div class="cdx-header">
                <div class="cdx-title">FIELD GUIDE</div>
                <div class="cdx-subtitle">Two rivals seed life on a shared map, then the ecosystem plays itself out. Build the richest, most balanced web of life.</div>
                <button class="cdx-close" aria-label="Close">✕</button>
            </div>
            <div class="cdx-body">
                ${TIER_ORDER.map(tierHTML).join('')}
                ${scoringHTML()}
            </div>
        </div>`;
    document.body.appendChild(el);

    // Close on backdrop click, close button, or Escape.
    el.addEventListener('click', (e) => {
        if (e.target === el || e.target.classList.contains('cdx-close')) closeCodex();
    });
    return el;
}

// Paint each species icon with the real board art — both players, so the
// color/mirroring legend is self-evident.
function paintIcons() {
    const dpr = window.devicePixelRatio || 1;
    const W = 76, H = 46;
    _overlay.querySelectorAll('.cdx-icon').forEach(canvas => {
        const id = canvas.dataset.species;
        canvas.width = W * dpr;
        canvas.height = H * dpr;
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const maxE = CONFIG.SPECIES[id]?.maxEnergy || 40;
        // P1 (left) and P2 (right) — drawn at the art's native scale, centered.
        drawOrganism(ctx, W * 0.32, H * 0.56, { species: id, player: 1, energy: maxE });
        drawOrganism(ctx, W * 0.68, H * 0.56, { species: id, player: 2, energy: maxE });
    });
}

export function openCodex() {
    if (!_overlay) _overlay = buildOverlay();
    _overlay.classList.remove('cdx-hidden');
    paintIcons();
    if (!_keyHandler) {
        _keyHandler = (e) => { if (e.key === 'Escape') closeCodex(); };
        document.addEventListener('keydown', _keyHandler);
    }
}

export function closeCodex() {
    if (_overlay) _overlay.classList.add('cdx-hidden');
    if (_keyHandler) {
        document.removeEventListener('keydown', _keyHandler);
        _keyHandler = null;
    }
}

export function isCodexOpen() {
    return !!_overlay && !_overlay.classList.contains('cdx-hidden');
}
