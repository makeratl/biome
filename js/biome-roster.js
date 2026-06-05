// Creature roster — the per-player species indicators that live inside each
// player's AI/banter card (#aic-roster-p1 / -p2). Six chips in tier order, each
// a mini procedural creature icon over a live count; a species the player has
// none of is dimmed, so the strip doubles as a legend ("the whole web, and what
// you've grown"). No scores here — the scoreboard owns those.
//
// Pure presentation: reads simulation.census() — the same public HUD data the
// biomass tower renders — and the shared organism art. It never feeds the AI
// prompt builders, so it sits outside the fog-of-war invariant.
//
// Lifecycle: buildBiomeRosters() once (DOM + initial paint); repaint icons after
// the per-match player palettes resolve; updateBiomeRosters() diffs counts every
// census tick WITHOUT repainting the canvases.

import { CONFIG } from './config.js';
import { drawOrganism } from './organism-art.js';

// Tier order, left → right: plants, herbivores, predator.
const SPECIES_ORDER = ['GRASS', 'SHRUB', 'TREE', 'GRAZER', 'BROWSER', 'PREDATOR'];
const ICON = 26;        // icon display size, CSS px
const BASE_CELL = 22;   // organism-art authoring footprint (one hex @ HEX_SIZE 11)

// Paint one species at the player's tint into its canvas, scaled from the 22px
// authoring space up to ICON px. A healthy mid-mature energy so plants show
// grown form and animals read clearly. (Mirrors lab-util's intoBaseSpace, kept
// local so gameplay doesn't import the lab.)
function paintIcon(canvas, species, player) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = (ICON / BASE_CELL) * dpr;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const energy = (CONFIG.SPECIES[species]?.maxEnergy || 100) * 0.7;
    drawOrganism(ctx, BASE_CELL / 2, BASE_CELL / 2, { species, player, energy });
}

function makeIconCanvas(id) {
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.id = id;
    canvas.className = 'br-icon';
    canvas.width = Math.round(ICON * dpr);
    canvas.height = Math.round(ICON * dpr);
    canvas.style.width = ICON + 'px';
    canvas.style.height = ICON + 'px';
    return canvas;
}

function buildPanel(player) {
    const root = document.getElementById(`aic-roster-p${player}`);
    if (!root) return;
    root.innerHTML = '';

    for (const species of SPECIES_ORDER) {
        const spec = CONFIG.SPECIES[species];
        const cell = document.createElement('div');
        cell.className = `br-cell br-tier-${spec?.type || 'plant'} br-dim`;
        cell.id = `br-p${player}-${species}`;
        cell.title = spec?.name || species;

        const canvas = makeIconCanvas(`br-icon-p${player}-${species}`);
        cell.appendChild(canvas);
        paintIcon(canvas, species, player);

        const count = document.createElement('span');
        count.className = 'br-count';
        count.id = `br-count-p${player}-${species}`;
        count.textContent = '0';
        cell.appendChild(count);

        root.appendChild(cell);
    }
}

// Build both players' roster strips + paint the 12 icons once. Idempotent.
export function buildBiomeRosters() {
    buildPanel(1);
    buildPanel(2);
}

// Repaint all icons — call after the per-match player palettes resolve so the
// tints match (drawOrganism reads CONFIG.PLAYER_x.PRIMARY live).
export function repaintBiomeRosterIcons() {
    for (const player of [1, 2]) {
        for (const species of SPECIES_ORDER) {
            const canvas = document.getElementById(`br-icon-p${player}-${species}`);
            if (canvas) paintIcon(canvas, species, player);
        }
    }
}

// Per-tick diff: counts + dim state. No canvas repaint.
export function updateBiomeRosters(census) {
    if (!census) return;
    for (const player of [1, 2]) {
        const by = census[player]?.bySpecies || {};
        for (const species of SPECIES_ORDER) {
            const n = by[species] || 0;
            const countEl = document.getElementById(`br-count-p${player}-${species}`);
            if (countEl && countEl.textContent !== String(n)) countEl.textContent = String(n);
            const cell = document.getElementById(`br-p${player}-${species}`);
            if (cell) cell.classList.toggle('br-dim', n === 0);
        }
    }
}
