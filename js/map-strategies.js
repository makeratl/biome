// Map orientation strategies — how the board is PRESENTED to the model.
//
// (CONFIG is imported only to classify an organism's species → trophic tier when
// rendering the layered ascii-ext creature view — a pure map-formatting need, not
// game logic.)
//
// One source of truth for board representations, consumed by both the live game
// (js/ai.js → js/prompt.js) and the Vision Lab (js/vision-lab.js), the same way
// organism-art.js is shared by the game and the icon lab. Each strategy varies
// ONLY the map-presentation block of the prompt — the lettered-candidate
// placement contract is identical across all of them, so a match's outcome
// isolates the effect of *presentation* alone (which is what we measure in the
// dashboard, tagged per match as `map_strategy`).
//
// A strategy's buildMapBlock(input) is PURE formatting — no game/DOM access. The
// caller (AIPlayer._promptContext) assembles `input`:
//   { grid, candidates, regionSummary, fog }
//   - grid          : the live HexGrid (cells have col,row,terrain,nutrients,organisms)
//   - candidates    : AIPlayer._findCandidates() output [{label,type,cell,...}]
//   - regionSummary : AIPlayer._generateMapSummary() text (the mediated view)
//   - fog           : { viewer, round } | null — fog-of-war context. Only `raw`
//                     reads it (it's the only view that exposes per-cell
//                     occupants); the digested views derive enemy info from the
//                     already-fogged census, so they ignore it. null = show all
//                     (the Vision Lab's raw map preview).
// Each returns the full MAP block INCLUDING its own header.

import { CONFIG } from './config.js';

export const DEFAULT_STRATEGY = 'mediated';

// Glyphs for the ASCII field — one per downsampled bucket of cells.
const TERRAIN_GLYPH = { WATER: '~', FERTILE: 'F', GRASSLAND: 'g', ROCKY: 'r' };
// Creature glyphs for the layered ascii-ext view, by trophic tier. Uppercase =
// the viewer's own; lowercased for the enemy layer. Ordered P<H<X for dominance.
const CREATURE_GLYPH = { plant: 'P', herbivore: 'H', predator: 'X' };
const CREATURE_RANK = { plant: 0, herbivore: 1, predator: 2 };

// ── mediated: today's 9-region terrain summary (heuristic-digested) ──
function buildMediated({ regionSummary }) {
    return `MAP REGIONS:\n${regionSummary}`;
}

// ── raw: every land cell as (col,row) terrain nutrients ──
// Full spatial information, but a flat 1-D list — it neither scales (token /
// context blowup on large boards) nor preserves 2-D structure well. Kept as the
// honest baseline to measure the others against.
//
// Fog of war is a CORRECTNESS INVARIANT here, not just for the digested views:
// because raw exposes exact (col,row) of every occupant, it MUST hide the
// opponent's current-round placements or it leaks the live move to the second
// mover (see CLAUDE.md "Fog of war"). `fog` = { viewer, round }; an organism is
// hidden when it was placed THIS round by someone other than the viewer — the
// same rule the js/ai.js readers (_summarizePlayer/_getCensus/_findCandidates)
// apply. No fog passed (e.g. the Vision Lab's all-revealing raw preview) shows
// every occupant.
function buildRaw({ grid, fog = null }) {
    const visible = (o) => !fog || !(o._placedRound === fog.round && o.player !== fog.viewer);
    const lines = [
        `MAP (raw cells — every land cell as col,row terrain nutrients):`,
        `Grid ${grid.cols}×${grid.rows} (cols 0..${grid.cols - 1} left→right, rows 0..${grid.rows - 1} top→bottom). WATER omitted.`,
    ];
    let water = 0;
    grid.forEach(cell => {
        if (cell.terrain === 'WATER') { water++; return; }
        let s = `  (${cell.col},${cell.row}) ${cell.terrain} ${cell.nutrients.toFixed(2)}`;
        const occ = cell.organisms.filter(visible);
        if (occ.length) {
            s += ' [' + occ.map(o => `P${o.player}:${o.species}`).join(',') + ']';
        }
        lines.push(s);
    });
    lines.push(`(${water} water cells omitted.)`);
    return lines.join('\n');
}

// ── Bucket geometry (shared) ──────────────────────────────────────────────────
// The downsample that turns a hex board into a ~18×10 glyph grid. Exported so the
// ascii / ascii-ext MAP blocks AND the engine's bucket→hex snap (js/ai.js
// _resolveBucket) compute the SAME buckets — if the labels the model reads and
// the cell the engine places into disagreed, bucket placement would be a lie.
const ASCII_MAX_COLS = 18;
const ASCII_MAX_ROWS = 10;

// { bw, bh, cols, rows } — bucket pixel size (bw×bh hexes) and the glyph-grid
// dimensions. `cols`/`rows` can be < max on small boards.
export function bucketGeometry(grid, maxCols = ASCII_MAX_COLS, maxRows = ASCII_MAX_ROWS) {
    const bw = Math.ceil(grid.cols / Math.min(grid.cols, maxCols));
    const bh = Math.ceil(grid.rows / Math.min(grid.rows, maxRows));
    return { bw, bh, cols: Math.ceil(grid.cols / bw), rows: Math.ceil(grid.rows / bh) };
}

// Which bucket a hex falls in.
export function cellBucket(cell, geo) {
    return {
        bx: Math.min(geo.cols - 1, Math.floor(cell.col / geo.bw)),
        by: Math.min(geo.rows - 1, Math.floor(cell.row / geo.bh)),
    };
}

// Bucket id ↔ indices. Column letter (A..) + 1-based row number, e.g. "C2".
export function bucketLabel(bx, by) { return `${String.fromCharCode(65 + bx)}${by + 1}`; }
export function parseBucketLabel(id, geo) {
    const m = /^([A-Za-z])(\d+)$/.exec(String(id || '').trim());
    if (!m) return null;
    const bx = m[1].toUpperCase().charCodeAt(0) - 65;
    const by = parseInt(m[2], 10) - 1;
    if (bx < 0 || bx >= geo.cols || by < 0 || by >= geo.rows) return null;
    return { bx, by };
}

// ── ascii: downsampled glyph field with candidate letters overlaid ──
// Each glyph is the dominant terrain of its bucket, and each candidate's LETTER
// is stamped into the bucket it sits in — the textual twin of the Lab's visual
// letter overlay. Preserves 2-D structure (rows of characters read as a map) AND
// ties the lettered candidates to position, at a near-constant ~few-hundred
// tokens regardless of board size.
function buildAscii({ grid, candidates = [] }) {
    const geo = bucketGeometry(grid);
    const { bw, bh, cols, rows } = geo;

    // Tally terrain per bucket, then resolve each to its dominant glyph.
    const tally = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => ({ WATER: 0, FERTILE: 0, GRASSLAND: 0, ROCKY: 0 })));
    grid.forEach(cell => {
        const { bx, by } = cellBucket(cell, geo);
        const t = tally[by][bx];
        if (t[cell.terrain] !== undefined) t[cell.terrain]++;
    });

    const glyph = tally.map(row => row.map(t => {
        const land = t.FERTILE + t.GRASSLAND + t.ROCKY;
        if (t.WATER > land) return TERRAIN_GLYPH.WATER;
        if (land === 0) return '·';
        const top = ['FERTILE', 'GRASSLAND', 'ROCKY'].reduce((a, b) => (t[b] > t[a] ? b : a), 'FERTILE');
        return TERRAIN_GLYPH[top];
    }));

    // Stamp candidate letters into their buckets (first wins on collision).
    const stamped = new Set();
    for (const c of candidates) {
        if (!c.cell) continue;
        const { bx, by } = cellBucket(c.cell, geo);
        const key = `${bx},${by}`;
        if (stamped.has(key)) continue;
        stamped.add(key);
        glyph[by][bx] = c.label;
    }

    const body = glyph.map(row => '  ' + row.join(' ')).join('\n');
    return [
        `MAP (text grid, top-left = col0/row0; each cell ≈ ${bw}×${bh} hexes):`,
        body,
        `Legend: F fertile · g grassland · r rocky · ~ water · · empty · letters = candidate spots (details in CANDIDATE MOVES).`,
    ].join('\n');
}

// ── ascii-ext: layered creature view, bucket addressing, no candidate menu ──
// Three aligned glyph grids in ONE coordinate frame (same bucketing as ascii):
// TERRAIN, the viewer's creatures, the enemy's creatures. The model reads the
// layers and places by naming a BUCKET (column letter + row number, e.g. "C2");
// the engine snaps to the best legal hex inside it (js/ai.js _resolveBucket). The
// goal is spatial play WITHOUT the pre-scored candidate menu — so this strategy
// declares `placement:'bucket'`, which js/prompt.js reads to drop CANDIDATE MOVES
// and swap in the bucket directive.
//
// Fog is a correctness invariant here (the creature layers expose occupants, like
// raw): the enemy layer hides the opponent's current-round placements via the
// same rule the raw view and the js/ai.js readers use.
function buildAsciiExtended({ grid, fog = null }) {
    const geo = bucketGeometry(grid);
    const { bw, bh, cols, rows } = geo;
    const visible = (o) => !fog || !(o._placedRound === fog.round && o.player !== fog.viewer);

    // Terrain layer — dominant glyph per bucket (identical logic to buildAscii).
    const terr = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => ({ WATER: 0, FERTILE: 0, GRASSLAND: 0, ROCKY: 0 })));
    // Creature layers — keep the highest-ranked tier present per bucket, per owner.
    const blank = () => Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
    const mine = blank(), enemy = blank();

    grid.forEach(cell => {
        const { bx, by } = cellBucket(cell, geo);
        const t = terr[by][bx];
        if (t[cell.terrain] !== undefined) t[cell.terrain]++;
        for (const o of cell.organisms) {
            if (!visible(o)) continue;
            const type = CONFIG.SPECIES[o.species]?.type;
            if (CREATURE_RANK[type] === undefined) continue;
            const isViewer = !fog || o.player === fog.viewer;
            const layer = isViewer ? mine : enemy;
            const cur = layer[by][bx];
            if (cur == null || CREATURE_RANK[type] > CREATURE_RANK[cur]) layer[by][bx] = type;
        }
    });

    const terrGlyph = terr.map(row => row.map(t => {
        const land = t.FERTILE + t.GRASSLAND + t.ROCKY;
        if (t.WATER > land) return TERRAIN_GLYPH.WATER;
        if (land === 0) return '·';
        const top = ['FERTILE', 'GRASSLAND', 'ROCKY'].reduce((a, b) => (t[b] > t[a] ? b : a), 'FERTILE');
        return TERRAIN_GLYPH[top];
    }));
    const creatureGlyph = (layer, lower) => layer.map(row => row.map(type =>
        type == null ? '·' : (lower ? CREATURE_GLYPH[type].toLowerCase() : CREATURE_GLYPH[type])));

    const colHdr = '    ' + Array.from({ length: cols }, (_, i) => String.fromCharCode(65 + i)).join(' ');
    const layerText = (title, glyphs) => [
        title, colHdr,
        glyphs.map((row, by) => `${String(by + 1).padStart(2)}  ${row.join(' ')}`).join('\n'),
    ].join('\n');

    return [
        `MAP (layered text grid — three aligned views in ONE coordinate frame; address a bucket by column letter + row number, e.g. C2; each bucket ≈ ${bw}×${bh} hexes):`,
        layerText('TERRAIN:', terrGlyph),
        layerText('YOUR CREATURES (UPPERCASE = you):', creatureGlyph(mine, false)),
        layerText('ENEMY CREATURES (lowercase = enemy):', creatureGlyph(enemy, true)),
        `Legend: terrain F fertile · g grassland · r rocky · ~ water · · empty.  Creatures P plant · H herbivore · X predator (UPPER=you, lower=enemy); a bucket shows its highest tier present.`,
    ].join('\n\n');
}

export const MAP_STRATEGIES = {
    mediated: {
        id: 'mediated',
        label: 'Mediated (regions + candidates)',
        description: 'A coarse 9-region terrain summary — the heuristic-digested view real matches use today.',
        buildMapBlock: buildMediated,
    },
    ascii: {
        id: 'ascii',
        label: 'ASCII field',
        description: 'A downsampled text grid that preserves 2-D layout, with candidate letters stamped on it.',
        buildMapBlock: buildAscii,
    },
    'ascii-ext': {
        id: 'ascii-ext',
        label: 'ASCII Extended (layered)',
        description: 'Three aligned ASCII layers (terrain / yours / enemy) in one frame; the model targets a bucket and the engine snaps to the best legal hex — no candidate menu.',
        buildMapBlock: buildAsciiExtended,
        // Drop the pre-scored candidate menu and switch js/prompt.js to the bucket
        // directive — the model places from the layered map alone.
        placement: 'bucket',
    },
    raw: {
        id: 'raw',
        label: 'Raw cells',
        description: 'Every land cell as col,row terrain nutrients — full info, but does not scale or preserve structure.',
        buildMapBlock: buildRaw,
    },
};

// Resolve an id to a strategy, falling back to the default.
export function getStrategy(id) {
    return MAP_STRATEGIES[id] || MAP_STRATEGIES[DEFAULT_STRATEGY];
}

// [{id, label, description}] in display order — for UI/selectors.
export function listStrategies() {
    return Object.values(MAP_STRATEGIES).map(({ id, label, description }) => ({ id, label, description }));
}
