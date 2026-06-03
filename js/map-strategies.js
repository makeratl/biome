// Map orientation strategies — how the board is PRESENTED to the model.
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
//   { grid, candidates, regionSummary }
//   - grid          : the live HexGrid (cells have col,row,terrain,nutrients,organisms)
//   - candidates    : AIPlayer._findCandidates() output [{label,type,cell,...}]
//   - regionSummary : AIPlayer._generateMapSummary() text (the mediated view)
// Each returns the full MAP block INCLUDING its own header.

export const DEFAULT_STRATEGY = 'mediated';

// Glyphs for the ASCII field — one per downsampled bucket of cells.
const TERRAIN_GLYPH = { WATER: '~', FERTILE: 'F', GRASSLAND: 'g', ROCKY: 'r' };

// ── mediated: today's 9-region terrain summary (heuristic-digested) ──
function buildMediated({ regionSummary }) {
    return `MAP REGIONS:\n${regionSummary}`;
}

// ── raw: every land cell as (col,row) terrain nutrients ──
// Full spatial information, but a flat 1-D list — it neither scales (token /
// context blowup on large boards) nor preserves 2-D structure well. Kept as the
// honest baseline to measure the others against.
function buildRaw({ grid }) {
    const lines = [
        `MAP (raw cells — every land cell as col,row terrain nutrients):`,
        `Grid ${grid.cols}×${grid.rows} (cols 0..${grid.cols - 1} left→right, rows 0..${grid.rows - 1} top→bottom). WATER omitted.`,
    ];
    let water = 0;
    grid.forEach(cell => {
        if (cell.terrain === 'WATER') { water++; return; }
        let s = `  (${cell.col},${cell.row}) ${cell.terrain} ${cell.nutrients.toFixed(2)}`;
        if (cell.organisms.length) {
            s += ' [' + cell.organisms.map(o => `P${o.player}:${o.species}`).join(',') + ']';
        }
        lines.push(s);
    });
    lines.push(`(${water} water cells omitted.)`);
    return lines.join('\n');
}

// ── ascii: downsampled glyph field with candidate letters overlaid ──
// Bucket the board into a ~18×10 glyph grid; each glyph is the dominant terrain
// of its bucket, and each candidate's LETTER is stamped into the bucket it sits
// in — the textual twin of the Lab's visual letter overlay. Preserves 2-D
// structure (rows of characters read as a map) AND ties the lettered candidates
// to position, at a near-constant ~few-hundred tokens regardless of board size.
const ASCII_MAX_COLS = 18;
const ASCII_MAX_ROWS = 10;

function buildAscii({ grid, candidates = [] }) {
    const gCols = Math.min(grid.cols, ASCII_MAX_COLS);
    const gRows = Math.min(grid.rows, ASCII_MAX_ROWS);
    const bw = Math.ceil(grid.cols / gCols);
    const bh = Math.ceil(grid.rows / gRows);
    const cols = Math.ceil(grid.cols / bw);
    const rows = Math.ceil(grid.rows / bh);

    // Tally terrain per bucket, then resolve each to its dominant glyph.
    const tally = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => ({ WATER: 0, FERTILE: 0, GRASSLAND: 0, ROCKY: 0 })));
    grid.forEach(cell => {
        const bx = Math.min(cols - 1, Math.floor(cell.col / bw));
        const by = Math.min(rows - 1, Math.floor(cell.row / bh));
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
        const bx = Math.min(cols - 1, Math.floor(c.cell.col / bw));
        const by = Math.min(rows - 1, Math.floor(c.cell.row / bh));
        const key = `${bx},${by}`;
        if (stamped.has(key)) continue;
        stamped.add(key);
        glyph[by][bx] = c.label;
    }

    const body = glyph.map(row => '  ' + row.join(' ')).join('\n');
    return [
        `MAP (text grid, top-left = col0/row0; each cell ≈ ${bw}×${bh} hexes):`,
        body,
        `Legend: F fertile · g grassland · r rocky · ~ water · · empty · A–H = candidate spots (details in CANDIDATE MOVES).`,
    ].join('\n');
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
