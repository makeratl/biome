// Icon Lab — side-by-side evaluation of organism art styles.
// Rows = species, columns = styles, each cell shown at true game scale and
// zoomed, on a terrain hex, in the selected player tint(s) and energy level.

import { CONFIG } from '../js/config.js';
import {
    makeCanvas, drawTerrainHex, intoBaseSpace, TERRAINS, BASE_CELL,
} from './lab-util.js';

import * as gameart from './styles/procedural.js';
import * as emoji from './styles/emoji.js';

// Refined procedural was chosen and graduated into js/organism-art.js, so the
// "Game art" column previews it live. Emoji is kept as a reference column.
const STYLES = [gameart, emoji];

// Species in game order (plants → herbivores → predator).
const SPECIES = Object.entries(CONFIG.SPECIES).map(([key, v]) => ({ key, ...v }));

const GAME_SIZE = 22;   // true on-board scale
const ZOOM_SIZE = 84;

const ENERGY_RATIO = { low: 0.3, mid: 0.6, full: 1.0 };

const state = {
    player: 'both',     // 1 | 2 | 'both'
    energy: 'full',     // low | mid | full
    terrain: 'FERTILE',
};

function energyFor(speciesKey) {
    return CONFIG.SPECIES[speciesKey].maxEnergy * ENERGY_RATIO[state.energy];
}

function playersToShow() {
    return state.player === 'both' ? [1, 2] : [state.player];
}

// One organism on one terrain hex, in one style, at `display` px.
// `energyValue` overrides the global energy setting when provided (absolute
// energy units, not a ratio) — used by the growth strip to walk the life range.
function renderIcon(style, speciesKey, player, display, energyValue) {
    const wrap = document.createElement('div');
    wrap.className = 'icon';
    wrap.style.width = display + 'px';
    wrap.style.height = display + 'px';

    // backdrop terrain hex
    const back = makeCanvas(display);
    drawTerrainHex(back.ctx, display, state.terrain);
    back.canvas.className = 'layer';
    wrap.appendChild(back.canvas);

    const energy = energyValue != null ? energyValue : energyFor(speciesKey);
    const opts = { species: speciesKey, player, energy };

    if (style.meta.substrate === 'svg') {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', display);
        svg.setAttribute('height', display);
        svg.classList.add('layer');
        style.renderInto(svg, opts);
        wrap.appendChild(svg);
    } else {
        const fg = makeCanvas(display);
        const space = intoBaseSpace(fg.ctx, display);
        style.renderInto(fg.ctx, { ...opts, cx: space.cx, cy: space.cy });
        space.restore();
        fg.canvas.className = 'layer';
        wrap.appendChild(fg.canvas);
    }
    return wrap;
}

function renderViewGroup(style, speciesKey, display, label) {
    const group = document.createElement('div');
    group.className = 'viewgroup';

    const icons = document.createElement('div');
    icons.className = 'icons';
    for (const player of playersToShow()) {
        icons.appendChild(renderIcon(style, speciesKey, player, display));
    }
    group.appendChild(icons);

    const cap = document.createElement('div');
    cap.className = 'caption';
    cap.textContent = label;
    group.appendChild(cap);
    return group;
}

function buildMatrix() {
    const matrix = document.getElementById('matrix');
    matrix.innerHTML = '';
    matrix.style.gridTemplateColumns = `var(--rowhead) repeat(${STYLES.length}, 1fr)`;

    // header row
    matrix.appendChild(cell('corner', ''));
    for (const style of STYLES) {
        const h = document.createElement('div');
        h.className = 'colhead';
        h.innerHTML = `<div class="colhead-label">${style.meta.label}</div>` +
            `<div class="colhead-note">${style.meta.note || ''}</div>`;
        matrix.appendChild(h);
    }

    // species rows
    for (const sp of SPECIES) {
        const head = document.createElement('div');
        head.className = 'rowhead';
        head.innerHTML = `<div class="rowhead-name">${sp.name}</div>` +
            `<div class="rowhead-role">${sp.role} · ${sp.type}</div>`;
        matrix.appendChild(head);

        for (const style of STYLES) {
            const c = document.createElement('div');
            c.className = 'cell';
            c.appendChild(renderViewGroup(style, sp.key, GAME_SIZE, '22px'));
            c.appendChild(renderViewGroup(style, sp.key, ZOOM_SIZE, 'zoom'));
            matrix.appendChild(c);
        }
    }
}

// Growth strip — each species walked across its lived energy range in the live
// game art, so the progression reads as a filmstrip. Plants spread in at ~0.25
// of max and mature toward 1.0; the same sweep gives herbivores/predators a
// small→full read too.
const GROWTH_STYLE = gameart;
const STAGES = [0.25, 0.45, 0.65, 0.85, 1.0];

function buildGrowth() {
    const grid = document.getElementById('growth');
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = `var(--rowhead) repeat(${STAGES.length}, 1fr)`;

    // header row: ratio labels
    grid.appendChild(cell('corner', ''));
    for (const ratio of STAGES) {
        const h = document.createElement('div');
        h.className = 'colhead';
        h.innerHTML = `<div class="colhead-label">${Math.round(ratio * 100)}%</div>`;
        grid.appendChild(h);
    }

    for (const sp of SPECIES) {
        const head = document.createElement('div');
        head.className = 'rowhead';
        head.innerHTML = `<div class="rowhead-name">${sp.name}</div>` +
            `<div class="rowhead-role">${sp.role} · ${sp.type}</div>`;
        grid.appendChild(head);

        for (const ratio of STAGES) {
            const c = document.createElement('div');
            c.className = 'cell';
            const group = document.createElement('div');
            group.className = 'viewgroup';
            const icons = document.createElement('div');
            icons.className = 'icons';
            const energy = sp.maxEnergy * ratio;
            for (const player of playersToShow()) {
                icons.appendChild(renderIcon(GROWTH_STYLE, sp.key, player, ZOOM_SIZE, energy));
            }
            group.appendChild(icons);
            c.appendChild(group);
            grid.appendChild(c);
        }
    }
}

function cell(cls, text) {
    const d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    return d;
}

// A small mock board: organisms scattered on hexes at true game scale, in the
// currently selected style, to judge readability in context. Always mixes both
// players regardless of the tint toggle, so contrast is visible.
const SCATTER = [
    [1, 0, 'TREE', 1], [3, 0, 'GRASS', 2], [5, 0, 'GRAZER', 1], [7, 0, 'SHRUB', 2], [9, 0, 'TREE', 2], [11, 0, 'GRASS', 1],
    [0, 1, 'GRASS', 1], [2, 1, 'SHRUB', 1], [4, 1, 'GRASS', 2], [6, 1, 'PREDATOR', 1], [8, 1, 'GRAZER', 2], [10, 1, 'SHRUB', 2],
    [1, 2, 'BROWSER', 2], [3, 2, 'GRASS', 1], [5, 2, 'TREE', 1], [7, 2, 'GRAZER', 1], [9, 2, 'GRASS', 2], [11, 2, 'BROWSER', 1],
    [0, 3, 'SHRUB', 2], [2, 3, 'GRAZER', 2], [4, 3, 'PREDATOR', 2], [6, 3, 'GRASS', 1], [8, 3, 'TREE', 2], [10, 3, 'GRASS', 1],
];

function buildBoard() {
    const board = document.getElementById('board');
    const styleId = document.querySelector('input[name="boardstyle"]:checked')?.value || 'procedural';
    const style = STYLES.find((s) => s.meta.id === styleId);
    board.innerHTML = '';

    const HEX = CONFIG.HEX_SIZE; // 11 → 22px cells, matches the game
    const pad = HEX + 4;
    let maxX = 0, maxY = 0;

    for (const [col, row, species, player] of SCATTER) {
        const x = HEX * 1.5 * col + pad;
        const y = HEX * Math.sqrt(3) * (row + 0.5 * (col & 1)) + pad;
        const icon = renderIcon(style, species, player, GAME_SIZE);
        icon.style.position = 'absolute';
        icon.style.left = (x - GAME_SIZE / 2) + 'px';
        icon.style.top = (y - GAME_SIZE / 2) + 'px';
        board.appendChild(icon);
        maxX = Math.max(maxX, x + pad);
        maxY = Math.max(maxY, y + pad);
    }
    board.style.height = maxY + 'px';
    board.style.maxWidth = maxX + 'px';
}

function renderAll() {
    buildMatrix();
    buildGrowth();
    buildBoard();
}

// --- controls -------------------------------------------------------------
function wireSegmented(containerId, key, after) {
    const container = document.getElementById(containerId);
    container.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-val]');
        if (!btn) return;
        let val = btn.dataset.val;
        if (val === '1' || val === '2') val = Number(val);
        state[key] = val;
        [...container.querySelectorAll('button')].forEach((b) => b.classList.toggle('on', b === btn));
        (after || renderAll)();
    });
}

function wireTerrain() {
    const sel = document.getElementById('terrain');
    TERRAINS.forEach((t) => {
        const o = document.createElement('option');
        o.value = t;
        o.textContent = t.charAt(0) + t.slice(1).toLowerCase();
        sel.appendChild(o);
    });
    sel.value = state.terrain;
    sel.addEventListener('change', () => { state.terrain = sel.value; renderAll(); });
}

function wireBoardStyle() {
    const container = document.getElementById('boardstyle');
    STYLES.forEach((s, i) => {
        const id = `bs_${s.meta.id}`;
        const label = document.createElement('label');
        label.innerHTML =
            `<input type="radio" name="boardstyle" id="${id}" value="${s.meta.id}" ${i === 0 ? 'checked' : ''}> ${s.meta.label}`;
        container.appendChild(label);
    });
    container.addEventListener('change', buildBoard);
}

wireSegmented('player', 'player');
wireSegmented('energy', 'energy');
wireTerrain();
wireBoardStyle();
renderAll();
