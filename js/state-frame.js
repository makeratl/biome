// StateFrame — the authoritative, view-agnostic snapshot the (eventually headless)
// engine emits and every view renders from. See docs/headless-broadcast-design.md.
//
// This is the boundary that ends the freeze class: the engine's job is to compute
// state and emit frames; rendering is strictly downstream, so a slow or broken view
// can never stall the engine. Phase 1 wires this in ADDITIVELY alongside the
// existing rendering; later phases move the runner off the UI thread entirely.

// ── emit bus ────────────────────────────────────────────────
// A view subscribes; the engine emits. Subscribers are isolated — one throwing
// never breaks the engine or the other subscribers (the whole point).
const subscribers = new Set();

export function onStateFrame(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);   // unsubscribe handle
}

export function emitStateFrame(frame) {
    for (const fn of subscribers) {
        try { fn(frame); } catch (err) { console.warn('[stateframe] subscriber threw', err); }
    }
}

// ── board serialization ─────────────────────────────────────
// `drawOrganism` (organism-art.js) needs only {species, player, energy} per
// organism; the cell supplies terrain; the grid supplies geometry. So a fully
// renderable board is: dims + per-cell terrain + per-cell organisms.
//
// includeTerrain:true → every cell carries terrain (a complete, standalone backdrop
//   — used for the match-start frame, or any "full" frame).
// includeTerrain:false → only occupied cells, organisms only (a light per-turn
//   delta; the viewer keeps the cached terrain backdrop). Optimization for later.
export function serializeBoard(grid, { includeTerrain = true } = {}) {
    if (!grid) return null;
    const cells = [];
    grid.forEach((cell) => {
        const orgs = cell.organisms;
        const occupied = orgs && orgs.length > 0;
        if (!includeTerrain && !occupied) return;     // delta: skip empty cells
        const entry = { c: cell.col, r: cell.row };
        if (includeTerrain) entry.t = cell.terrain;
        if (occupied) entry.o = orgs.map((o) => [o.species, o.player, o.energy]);
        cells.push(entry);
    });
    return {
        grid: { cols: grid.cols, rows: grid.rows, hexSize: grid.hexSize },
        cells,
        full: includeTerrain,
    };
}

// Rebuild drawable cell records from a board payload: each becomes
// { col, row, terrain, organisms:[{species, player, energy}] } — the exact shape
// the renderer/organism-art read. A view caches the last `full` board's terrain so
// later delta frames (organisms only) still paint the backdrop.
export function deserializeBoard(board, prevTerrain = null) {
    const terrain = prevTerrain ? new Map(prevTerrain) : new Map();
    const organisms = new Map();   // "c,r" → [{species,player,energy}]
    for (const e of board.cells) {
        const key = `${e.c},${e.r}`;
        if (e.t != null) terrain.set(key, e.t);
        if (e.o) organisms.set(key, e.o.map(([species, player, energy]) => ({ species, player, energy })));
    }
    return { grid: board.grid, terrain, organisms };
}

// ── full-frame assembly ─────────────────────────────────────
// Convenience for the engine: stitch the moving parts into one StateFrame. Every
// field is optional so partial frames (e.g. a clock tick) stay cheap. `seq` lets
// viewers drop stale/out-of-order frames.
let _seq = 0;
export function buildFrame({ kind = 'tick', match = null, board = null, scores = null,
                             clock = null, banter = null, bracket = null } = {}) {
    return {
        seq: ++_seq,
        kind,                 // 'match-start' | 'turn' | 'sim-step' | 'round-end' | 'match-end' | 'tick'
        match, board, scores, clock, banter, bracket,
    };
}
