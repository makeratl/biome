// Board-from-StateFrame renderer — draws the live board in ANY view (operator,
// spectator) directly from a serialized StateFrame, using the same shared
// organism-art routines the game uses. This is what replaces the host-side
// canvas read-back + WebP push (live-publish.js): the board travels as state, and
// each viewer draws it locally. See docs/headless-broadcast-design.md.

import { CONFIG } from './config.js';
import { drawOrganism } from './organism-art.js';
import { deserializeBoard } from './state-frame.js';

const SQRT3 = Math.sqrt(3);

// Flat-top even-q hex center — identical math to HexGrid.hexToPixel, inlined so a
// viewer needs no grid instance.
function hexToPixel(col, row, size) {
    return { x: size * 1.5 * col, y: size * SQRT3 * (row + 0.5 * (col & 1)) };
}

function hexPath(ctx, cx, cy, size) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * (60 * i);
        const x = cx + size * Math.cos(a), y = cy + size * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
}

function terrainFill(terrain) {
    const base = CONFIG.COLORS[terrain];
    if (!base) return '#333';
    return `hsl(${base.h}, ${base.s}%, ${base.l}%)`;
}

// A small stateful view: feed it frames, it keeps the terrain backdrop across
// organism-only deltas and repaints. Sizes the canvas to the grid once per dims.
export class BoardFrameView {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this._terrain = null;       // cached "c,r" → terrain across delta frames
        this._dims = null;          // last grid dims, to detect a resize
    }

    // frame.board is the serialized board (full or delta). No-op without one.
    render(frame) {
        const board = frame?.board;
        if (!board) return;
        const { grid, terrain, organisms } = deserializeBoard(board, this._terrain);
        this._terrain = terrain;     // carry terrain forward for the next delta

        const size = grid.hexSize;
        const offX = size + 4, offY = size + 4;
        this._fit(grid, size, offX, offY);

        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Terrain backdrop (every known cell).
        for (const [key, t] of terrain) {
            const [c, r] = key.split(',').map(Number);
            const { x, y } = hexToPixel(c, r, size);
            hexPath(ctx, x + offX, y + offY, size);
            ctx.fillStyle = terrainFill(t);
            ctx.fill();
            ctx.strokeStyle = CONFIG.COLORS.GRID_LINE || 'rgba(0,0,0,.25)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
        }

        // Organisms on top.
        for (const [key, orgs] of organisms) {
            const [c, r] = key.split(',').map(Number);
            const { x, y } = hexToPixel(c, r, size);
            const cx = x + offX, cy = y + offY;
            for (const org of orgs) {
                ctx.save();
                drawOrganism(ctx, cx, cy, org);
                ctx.restore();
            }
        }
    }

    _fit(grid, size, offX, offY) {
        const sig = `${grid.cols}x${grid.rows}x${size}`;
        if (this._dims === sig) return;
        this._dims = sig;
        const last = hexToPixel(grid.cols - 1, 0, size);
        const lastRow = hexToPixel(1, grid.rows - 1, size);
        this.canvas.width = Math.ceil(last.x + offX + size * 2);
        this.canvas.height = Math.ceil(lastRow.y + offY + size * SQRT3);
    }
}
