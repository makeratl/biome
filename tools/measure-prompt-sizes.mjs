// Prompt-size / context-need metrics for the three map-orientation strategies.
//
//   node tools/measure-prompt-sizes.mjs
//
// Drives the REAL prompt pipeline (js/ai.js → js/prompt.js → js/map-strategies.js)
// over a synthetic but representative mid-game board, the same way the Vision Lab
// builds a faithful preview from an AIPlayer over a grid shim. So the reported
// system+user sizes are exactly what a model would receive in a live match — no
// hand-faked prompt text. Also doubles as a fog regression check for `raw`.
//
// Token estimates use two ratios: chars/4 (typical English text) and chars/3
// (the conservative ratio js/ai.js uses to size Ollama's num_ctx). The真 budget
// budget the live game would request is min(tierCtxCap, max(2048, ceil(chars/3))).

import { AIPlayer } from '../js/ai.js';
import { CONFIG } from '../js/config.js';
import { MAP_STRATEGIES } from '../js/map-strategies.js';

// ── Deterministic synthetic board ────────────────────────────────────────────
// No Math.random (reproducible). Terrain from a cheap hash so the land/water mix
// and nutrient field are stable across runs; organism population is a fixed
// mid-game density spread over both players.

function hash01(a, b) {
    const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
    return h - Math.floor(h);
}

function terrainOf(col, row) {
    const n = hash01(col, row);
    if (n < 0.24) return 'WATER';
    if (n < 0.45) return 'FERTILE';
    if (n < 0.78) return 'GRASSLAND';
    return 'ROCKY';
}

// Build a HexGrid-shaped shim: cols, rows, forEach(cb), getCell(col,row).
function makeGrid(cols, rows, { round = 3, populate = true } = {}) {
    const cells = [];
    const byKey = new Map();
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const terrain = terrainOf(col, row);
            const cell = {
                col, row, terrain,
                nutrients: terrain === 'WATER' ? 0 : 0.5 + hash01(col + 1, row + 7) * 5.5,
                organisms: [],
            };
            cells.push(cell);
            byKey.set(`${col},${row}`, cell);
        }
    }

    if (populate) {
        // Mid-game density: ~18% of land cells occupied, alternating owners by a
        // hash, a realistic plant/herb/pred mix, mostly from prior rounds with a
        // few CURRENT-round placements (so the fog test has something to hide).
        const species = ['GRASS', 'SHRUB', 'TREE', 'GRAZER', 'BROWSER', 'PREDATOR'];
        for (const cell of cells) {
            if (cell.terrain === 'WATER') continue;
            const r = hash01(cell.col * 3 + 1, cell.row * 5 + 2);
            if (r > 0.18) continue;
            const player = hash01(cell.col + 11, cell.row + 13) < 0.5 ? 1 : 2;
            const sp = species[Math.floor(hash01(cell.col + 2, cell.row + 4) * species.length)];
            // ~12% of occupied cells are this-round placements.
            const placedRound = hash01(cell.col + 31, cell.row + 17) < 0.12 ? round : round - 1;
            cell.organisms.push({ player, species: sp, energy: 8, _placedRound: placedRound });
        }
    }

    return {
        cols, rows,
        forEach: (cb) => cells.forEach(cb),
        getCell: (col, row) => byKey.get(`${col},${row}`) || null,
        _cells: cells,
    };
}

function makeShim(grid, mapStrategy, round) {
    const ap = CONFIG.GAME.AP_PER_TURN;
    return {
        grid,
        turns: { round, totalRounds: CONFIG.GAME.TOTAL_ROUNDS,
                 players: { 1: { ap }, 2: { ap } } },
        matchContext: { mapStrategy },
        renderer: { render() {} },
    };
}

// ── Token helpers ─────────────────────────────────────────────────────────────
const t4 = (s) => Math.ceil(s.length / 4);
const t3 = (s) => Math.ceil(s.length / 3);            // matches ai.js num_ctx sizing
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

// ── 1. Size table across board presets × strategies ──────────────────────────
const STRATEGIES = ['mediated', 'ascii', 'ascii-ext', 'raw'];
const PRESETS = Object.entries(CONFIG.MAPS);   // [['small',{cols,rows,label}], ...]
const ROUND = 3;

console.log('\n=== PROMPT SIZE BY STRATEGY × BOARD ===');
console.log('Full system+user prompt fed to the model (chars, ~tokens). '
    + '"map" = just the map block (the part that varies by strategy).\n');
console.log(pad('board', 16) + pad('strategy', 11) + padL('map ch', 9)
    + padL('full ch', 9) + padL('~tok/4', 8) + padL('~tok/3', 8) + padL('land', 7));
console.log('-'.repeat(76));

const rows = [];
for (const [key, m] of PRESETS) {
    const grid = makeGrid(m.cols, m.rows, { round: ROUND });
    const land = grid._cells.filter(c => c.terrain !== 'WATER').length;
    for (const strat of STRATEGIES) {
        const ai = new AIPlayer(makeShim(grid, strat, ROUND), 1, { model: 'qwen2.5:14b' });
        const cands = ai._findCandidates();
        const mapBlock = MAP_STRATEGIES[strat].buildMapBlock({
            grid, candidates: cands,
            regionSummary: ai._generateMapSummary().replace(/\n+$/, ''),
            fog: { viewer: 1, round: ROUND },
        });
        const { system, user } = ai._buildPrompt(cands);
        const full = system + '\n' + user;
        rows.push({ key, label: `${m.label} ${m.cols}×${m.rows}`, strat, mapBlock, full, land });
        console.log(
            pad(`${m.label} ${m.cols}×${m.rows}`, 16) + pad(strat, 11)
            + padL(mapBlock.length, 9) + padL(full.length, 9)
            + padL(t4(full), 8) + padL(t3(full), 8) + padL(land, 7));
    }
    console.log('-'.repeat(76));
}

// ── 2. Context-budget headroom ────────────────────────────────────────────────
// What the live game would request (ai.js): num_ctx = min(tierCap, max(2048,
// ceil(chars/3))). Show raw on the largest board against each tier's cap.
console.log('\n=== num_ctx the live game requests (chars/3, capped per tier) ===');
const big = rows.find(r => r.key === 'large' && r.strat === 'raw');
console.log(`raw on ${big.label}: prompt ${big.full.length} ch → wants num_ctx ${t3(big.full)}`);
for (const [tier, b] of Object.entries(CONFIG.GAME.MODEL_BUDGETS)) {
    const want = Math.min(b.numCtx, Math.max(2048, t3(big.full)));
    const fits = t3(big.full) <= b.numCtx ? 'fits' : `TRUNCATES (cap ${b.numCtx})`;
    console.log(`  ${pad(tier, 6)} cap ${padL(b.numCtx, 6)} → grants ${padL(want, 6)}  ${fits}`);
}

// ── 3. Fog regression check ───────────────────────────────────────────────────
// raw must hide the opponent's CURRENT-round placements from the viewer, while
// the viewer still sees its own current-round and everyone's prior-round pieces.
console.log('\n=== FOG CHECK (raw strategy) ===');
{
    const grid = makeGrid(10, 8, { populate: false });
    const round = 2;
    const put = (col, row, player, placedRound) => {
        const c = grid.getCell(col, row);
        c.terrain = 'GRASSLAND';   // raw omits WATER cells, so keep test cells land
        c.organisms.push({ player, species: 'GRAZER', _placedRound: placedRound });
    };
    put(1, 1, 1, round);       // viewer's own, this round  → visible
    put(2, 2, 1, round - 1);   // viewer's own, prior round → visible
    put(3, 3, 2, round - 1);   // enemy, prior round        → visible
    put(4, 4, 2, round);       // enemy, THIS round         → HIDDEN

    const block = MAP_STRATEGIES.raw.buildMapBlock({ grid, fog: { viewer: 1, round } });
    const noFog = MAP_STRATEGIES.raw.buildMapBlock({ grid });   // lab preview: all revealed

    const checks = [
        ['viewer own current-round visible',   block.includes('(1,1) ') && block.match(/\(1,1\)[^\n]*P1:GRAZER/)],
        ['viewer own prior-round visible',     !!block.match(/\(2,2\)[^\n]*P1:GRAZER/)],
        ['enemy prior-round visible',          !!block.match(/\(3,3\)[^\n]*P2:GRAZER/)],
        ['enemy CURRENT-round HIDDEN',          !block.match(/\(4,4\)[^\n]*P2:GRAZER/)],
        ['no-fog preview reveals enemy move',  !!noFog.match(/\(4,4\)[^\n]*P2:GRAZER/)],
    ];
    let ok = true;
    for (const [name, pass] of checks) {
        console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
        ok = ok && pass;
    }
    console.log(ok ? '\n  ✓ fog invariant holds for raw' : '\n  ✗ FOG LEAK');
    if (!ok) process.exitCode = 1;
}

// ── 4. Fog check — ascii-ext layered view ─────────────────────────────────────
// The creature layers expose occupants, so the ENEMY layer must hide the
// opponent's current-round placements. Glyphs: P/H/X (UPPER=viewer, lower=enemy);
// on this 10-wide board the bucket column headers are A..J, so uppercase 'P' and
// lowercase 'h'/'x' never collide with a header letter.
console.log('\n=== FOG CHECK (ascii-ext layered view) ===');
{
    const grid = makeGrid(10, 8, { populate: false });
    const round = 2;
    const put = (col, row, player, species, placedRound) => {
        const c = grid.getCell(col, row);
        c.terrain = 'GRASSLAND';
        c.organisms.push({ player, species, _placedRound: placedRound });
    };
    put(1, 1, 1, 'GRASS', round);        // viewer plant, this round  → YOURS, 'P'
    put(4, 3, 2, 'GRAZER', round - 1);   // enemy herb, prior round   → ENEMY, 'h'
    put(7, 5, 2, 'PREDATOR', round);     // enemy predator, THIS round → HIDDEN from P1

    const seg = (block, title) => (block.split('\n\n').find(s => s.startsWith(title)) || '');
    const p1 = MAP_STRATEGIES['ascii-ext'].buildMapBlock({ grid, fog: { viewer: 1, round } });
    const p2 = MAP_STRATEGIES['ascii-ext'].buildMapBlock({ grid, fog: { viewer: 2, round } });

    const checks = [
        ['viewer current-round in YOURS',      seg(p1, 'YOUR CREATURES').includes('P')],
        ['enemy prior-round in ENEMY',          seg(p1, 'ENEMY CREATURES').includes('h')],
        ['enemy CURRENT-round HIDDEN',         !seg(p1, 'ENEMY CREATURES').includes('x')],
        ['control: P2 sees its own predator',   seg(p2, 'YOUR CREATURES').includes('X')],
    ];
    let ok = true;
    for (const [name, pass] of checks) {
        console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
        ok = ok && pass;
    }
    console.log(ok ? '\n  ✓ fog invariant holds for ascii-ext' : '\n  ✗ FOG LEAK');
    if (!ok) process.exitCode = 1;
}
console.log();
