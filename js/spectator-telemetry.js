// Spectator ecosystem telemetry band — the broadcast "lower third" under the live
// board: the SAME P1/P2 trophic census bars and the SAME animated ecosystem-mood
// orb the game's HUD console shows, both derived here from the streamed board
// state (per-cell {species, player}) — no extra server data.
//
// Self-contained so it's testable without the page's poll loop: hand telemetryHTML()
// into the board panel once, then call renderTelemetry(board) on every snapshot AND
// every per-step growth frame. The bar logic mirrors Game._renderBiomassTower /
// Game._ecosystemHealth; the orb is js/biosphere.js. Styling (.hc-eco/.bt-*/.bio-*)
// comes from style.css, which the spectator page already links.

import { CONFIG } from './config.js';
import { Biosphere } from './biosphere.js';
import { deserializeBoard } from './state-frame.js';
import { trophicRead } from './trophic.js';

const $ = (id) => document.getElementById(id);

// ── markup ────────────────────────────────────────────────────────────────
const TIER_ROWS = [
    { key: 'pred', icon: '🦅', label: 'Predators' },
    { key: 'herb', icon: '🦌', label: 'Herbivores' },
    { key: 'plant', icon: '🌿', label: 'Plants' },
];
function barRow({ key, icon, label }) {
    const side = (p) => `<div class="bt-bar bt-p${p}" id="bt-bar-${key}-p${p}">`
        + `<span class="bt-track"></span><span class="bt-fill" id="bt-fill-${key}-p${p}"></span>`
        + `<span class="bt-count" id="bt-count-${key}-p${p}">0</span></div>`;
    return `<div class="bt-row" data-tier="${key}">
        <div class="bt-tier-icon">${icon}</div>
        <div class="bt-tier-label">${label}</div>
        <div class="bt-bars">${side(1)}<div class="bt-divider"></div>${side(2)}</div>
    </div>`;
}
export function telemetryHTML() {
    return `<div class="spec-telemetry" id="spec-telemetry" hidden>
        <div class="hc-eco spec-eco">
            ${TIER_ROWS.map(barRow).join('')}
            <div class="bt-health-row">
                <div class="bt-health bt-health-p1" id="bt-health-p1" data-state="ok"><span class="bt-h-tag">P1</span><span class="bt-h-icon">✓</span></div>
                <div class="bt-health bt-health-p2" id="bt-health-p2" data-state="ok"><span class="bt-h-tag">P2</span><span class="bt-h-icon">✓</span></div>
            </div>
        </div>
        <div class="hc-biome spec-biome">
            <div class="bio-orb-wrap">
                <canvas id="bio-orb" class="bio-orb" width="120" height="120" aria-hidden="true"></canvas>
                <div class="bio-rim" id="bio-rim" data-state="dormant"></div>
            </div>
            <div class="bio-caption" id="bio-caption" data-state="dormant"><span class="bio-icon" id="bio-icon">·</span><span class="bio-word" id="bio-word">DORMANT</span></div>
        </div>
    </div>`;
}

// ── data: streamed board → per-player census the bars + orb both read ───────
export function censusFromBoard(board) {
    const blank = () => ({ plants: 0, herbivores: 0, predators: 0, bySpecies: {} });
    const c = { 1: blank(), 2: blank() };
    if (!board) return c;
    let organisms;
    try { ({ organisms } = deserializeBoard(board)); } catch { return c; }
    for (const orgs of organisms.values()) {
        for (const o of orgs) {
            const side = c[o.player];
            if (!side) continue;
            const type = CONFIG.SPECIES?.[o.species]?.type;
            if (type === 'plant') side.plants++;
            else if (type === 'herbivore') side.herbivores++;
            else if (type === 'predator') side.predators++;
            side.bySpecies[o.species] = (side.bySpecies[o.species] || 0) + 1;
        }
    }
    return c;
}

// ── bars: mirror Game._renderBiomassTower so the panel reads identically ────
const ECO_MIN_PCT = 5, ECO_CAP = 100;
function tierHealth(actual, ideal) {
    if (actual <= 0) return ideal <= 0 ? 'empty' : 'under';
    if (ideal <= 0) return 'over';
    const r = actual / ideal;
    return r < 0.5 ? 'under' : r > 1.75 ? 'over' : 'good';
}
function badgeHealth(c) {   // mirrors Game._ecosystemHealth
    const r = trophicRead(c.plants, c.herbivores, c.predators, c.bySpecies);
    if (r.state === 'empty') return { state: 'empty', icon: '–' };
    if (r.baseStarved) return { state: 'collapse', icon: '✕' };
    if (r.apexStarved || r.state === 'overgrazed' || r.state === 'top-heavy') return { state: 'warn', icon: '⚠' };
    return { state: 'ok', icon: '✓' };
}
export function updateEcoBars(census) {
    const S = Math.max(census[1].plants || 0, census[2].plants || 0, 1);
    const w = (v) => (v <= 0 ? 0 : Math.max(ECO_MIN_PCT, Math.min(ECO_CAP, Math.round((v / S) * 100))));
    const idealW = (v) => Math.min(ECO_CAP, Math.round((v / S) * 100));
    for (const p of [1, 2]) {
        const c = census[p];
        const r = trophicRead(c.plants, c.herbivores, c.predators, c.bySpecies);
        const tiers = [
            { key: 'pred', actual: c.predators, ideal: r.idealPred, health: tierHealth(c.predators, r.idealPred) },
            { key: 'herb', actual: c.herbivores, ideal: r.idealHerb, health: tierHealth(c.herbivores, r.idealHerb) },
            { key: 'plant', actual: c.plants, ideal: c.plants, health: c.plants > 0 ? 'good' : 'empty' },
        ];
        for (const t of tiers) {
            const bar = $(`bt-bar-${t.key}-p${p}`), fill = $(`bt-fill-${t.key}-p${p}`), cnt = $(`bt-count-${t.key}-p${p}`);
            if (fill) fill.style.width = `${w(t.actual)}%`;
            if (cnt) cnt.textContent = String(t.actual);
            if (bar) { bar.style.setProperty('--ideal', `${idealW(t.ideal)}%`); bar.dataset.health = t.health; }
        }
        const badge = $(`bt-health-p${p}`);
        if (badge) {
            const st = badgeHealth(c);
            badge.dataset.state = st.state;
            const ic = badge.querySelector('.bt-h-icon');
            if (ic) ic.textContent = st.icon;
        }
    }
}

// ── orb lifecycle ───────────────────────────────────────────────────────────
let _biosphere = null;
function ensureBiosphere() {
    if (_biosphere) return _biosphere;
    const cv = $('bio-orb');
    if (!cv) return null;
    _biosphere = new Biosphere(cv);
    _biosphere.start();
    return _biosphere;
}
export function teardownBiosphere() {
    if (_biosphere) { _biosphere.destroy(); _biosphere = null; }
}

// Drive the whole band from one board (snapshot or per-step frame).
export function renderTelemetry(board) {
    const band = $('spec-telemetry');
    if (!band || !board) return;
    const census = censusFromBoard(board);
    band.hidden = false;
    updateEcoBars(census);
    ensureBiosphere()?.update(census);
}
