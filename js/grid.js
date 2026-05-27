// Hex grid math — flat-top hexagons, offset coordinates (col, row)
// Uses "even-q" offset: even columns are not shifted, odd columns shift down

import { CONFIG } from './config.js';

const SQRT3 = Math.sqrt(3);

// Neighbor offsets differ for even vs odd columns (flat-top even-q)
const EVEN_COL_DIRS = [
    { dc: +1, dr:  0 },
    { dc: +1, dr: -1 },
    { dc:  0, dr: -1 },
    { dc: -1, dr: -1 },
    { dc: -1, dr:  0 },
    { dc:  0, dr: +1 },
];

const ODD_COL_DIRS = [
    { dc: +1, dr: +1 },
    { dc: +1, dr:  0 },
    { dc:  0, dr: -1 },
    { dc: -1, dr:  0 },
    { dc: -1, dr: +1 },
    { dc:  0, dr: +1 },
];

export class HexGrid {
    constructor(cols, rows, hexSize) {
        this.cols = cols;
        this.rows = rows;
        this.hexSize = hexSize;
        this.cells = new Map();

        this._initCells();
    }

    _initCells() {
        for (let row = 0; row < this.rows; row++) {
            for (let col = 0; col < this.cols; col++) {
                const key = `${col},${row}`;
                this.cells.set(key, {
                    col, row,
                    terrain: null,
                    elevation: 0,
                    moisture: 0,
                    nutrients: 0,
                    organisms: [],
                });
            }
        }
    }

    getCell(col, row) {
        if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return null;
        return this.cells.get(`${col},${row}`) || null;
    }

    getNeighbors(col, row) {
        const dirs = (col & 1) === 0 ? EVEN_COL_DIRS : ODD_COL_DIRS;
        const neighbors = [];
        for (const d of dirs) {
            const cell = this.getCell(col + d.dc, row + d.dr);
            if (cell) neighbors.push(cell);
        }
        return neighbors;
    }

    // Flat-top hex: offset to pixel center
    hexToPixel(col, row) {
        const size = this.hexSize;
        const x = size * 1.5 * col;
        const y = size * SQRT3 * (row + 0.5 * (col & 1));
        return { x, y };
    }

    // Flat-top hex: pixel to offset (nearest cell)
    pixelToHex(px, py) {
        const size = this.hexSize;
        // Approximate column
        const col = Math.round(px / (size * 1.5));
        // Given column, calculate row
        const row = Math.round(py / (size * SQRT3) - 0.5 * (col & 1));

        // Check this cell and its neighbors to find the closest center
        let bestCell = this.getCell(col, row);
        let bestDist = Infinity;

        const candidates = [{ c: col, r: row }];
        // Also check adjacent columns for edge cases
        for (const dc of [-1, 0, 1]) {
            for (const dr of [-1, 0, 1]) {
                candidates.push({ c: col + dc, r: row + dr });
            }
        }

        for (const { c, r } of candidates) {
            const cell = this.getCell(c, r);
            if (!cell) continue;
            const center = this.hexToPixel(c, r);
            const dx = px - center.x;
            const dy = py - center.y;
            const dist = dx * dx + dy * dy;
            if (dist < bestDist) {
                bestDist = dist;
                bestCell = cell;
            }
        }

        return bestCell;
    }

    hexDistance(col1, row1, col2, row2) {
        // Convert offset to cube, then compute distance
        const [x1, y1, z1] = this._offsetToCube(col1, row1);
        const [x2, y2, z2] = this._offsetToCube(col2, row2);
        return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
    }

    _offsetToCube(col, row) {
        const x = col;
        const z = row - (col - (col & 1)) / 2;
        const y = -x - z;
        return [x, y, z];
    }

    // Get hex corner points for rendering
    hexCorners(cx, cy) {
        const corners = [];
        for (let i = 0; i < 6; i++) {
            const angle = Math.PI / 180 * (60 * i);
            corners.push({
                x: cx + this.hexSize * Math.cos(angle),
                y: cy + this.hexSize * Math.sin(angle),
            });
        }
        return corners;
    }

    // Canvas dimensions needed to display this grid
    getCanvasSize() {
        // Last column position
        const lastCol = this.hexToPixel(this.cols - 1, 0);
        // Last row in an odd column (furthest down)
        const lastRow = this.hexToPixel(1, this.rows - 1);
        return {
            width: lastCol.x + this.hexSize * 2,
            height: lastRow.y + this.hexSize * SQRT3,
        };
    }

    // Iterate all cells
    forEach(fn) {
        this.cells.forEach((cell, key) => fn(cell, key));
    }

    // Get all cells as array
    allCells() {
        return Array.from(this.cells.values());
    }
}
