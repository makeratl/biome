// Canvas rendering for the hex world

import { CONFIG } from './config.js';
import { TERRAIN_TYPES } from './terrain.js';

export class Renderer {
    constructor(canvas, grid) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.grid = grid;
        this.offsetX = CONFIG.HEX_SIZE + 4;
        this.offsetY = CONFIG.HEX_SIZE + 4;

        // Fog of war — hide one player's new placements from the other
        this._fogRound = -1;
        this._fogPlayer = 0;

        // Placement highlights — glow around newly placed organisms
        this._highlightRound = -1;

        this._resize();
    }

    setFog(round, hiddenPlayer) {
        this._fogRound = round;
        this._fogPlayer = hiddenPlayer;
    }

    clearFog() {
        this._fogRound = -1;
        this._fogPlayer = 0;
    }

    isHidden(org) {
        return org._placedRound === this._fogRound && org.player === this._fogPlayer;
    }

    setHighlightRound(round) {
        this._highlightRound = round;
    }

    clearHighlightRound() {
        this._highlightRound = -1;
    }

    _resize() {
        const size = this.grid.getCanvasSize();
        this.canvas.width = size.width + this.offsetX * 2;
        this.canvas.height = size.height + this.offsetY * 2;
    }

    _terrainColor(cell) {
        const base = CONFIG.COLORS[cell.terrain];
        if (!base) return '#333';

        // Modulate lightness by nutrients (depleted soil gets slightly paler)
        let l = base.l;
        if (cell.terrain !== TERRAIN_TYPES.WATER) {
            const nutrientRatio = cell.nutrients / CONFIG.TERRAIN.MAX_NUTRIENTS;
            l = base.l + (1 - nutrientRatio) * 6;
        }

        // Slight elevation shading
        const elevShade = (cell.elevation - 0.5) * 4;
        l += elevShade;

        return `hsl(${base.h}, ${base.s}%, ${Math.round(l)}%)`;
    }

    _drawHex(cx, cy, fill, stroke) {
        const ctx = this.ctx;
        const corners = this.grid.hexCorners(cx, cy);

        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 6; i++) {
            ctx.lineTo(corners[i].x, corners[i].y);
        }
        ctx.closePath();

        ctx.fillStyle = fill;
        ctx.fill();

        if (stroke) {
            ctx.strokeStyle = stroke;
            ctx.lineWidth = 0.5;
            ctx.stroke();
        }
    }

    drawTerrain() {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        this.grid.forEach((cell) => {
            const { x, y } = this.grid.hexToPixel(cell.col, cell.row);
            const cx = x + this.offsetX;
            const cy = y + this.offsetY;

            this._drawHex(cx, cy, this._terrainColor(cell), CONFIG.COLORS.GRID_LINE);
        });
    }

    drawOrganisms() {
        const ctx = this.ctx;

        this.grid.forEach((cell) => {
            if (cell.organisms.length === 0) return;

            const { x, y } = this.grid.hexToPixel(cell.col, cell.row);
            const cx = x + this.offsetX;
            const cy = y + this.offsetY;

            for (const org of cell.organisms) {
                if (this.isHidden(org)) continue;
                this._drawOrganism(cx, cy, org);
            }
        });
    }

    _playerHSL(player, hueShift = 0, satShift = 0, lightShift = 0) {
        const c = (player === 1 ? CONFIG.PLAYER_1 : CONFIG.PLAYER_2).PRIMARY;
        return `hsl(${c.h + hueShift}, ${Math.max(0, Math.min(100, c.s + satShift))}%, ${Math.max(0, Math.min(100, c.l + lightShift))}%)`;
    }

    _drawOrganism(cx, cy, org) {
        const ctx = this.ctx;
        const spec = CONFIG.SPECIES[org.species];
        if (!spec) return;

        if (spec.type === 'plant') {
            this._drawPlant(ctx, cx, cy, org);
        } else if (spec.type === 'herbivore') {
            this._drawHerbivore(ctx, cx, cy, org);
        } else if (spec.type === 'predator') {
            this._drawPredator(ctx, cx, cy, org);
        }
    }

    _drawPlant(ctx, cx, cy, org) {
        const energyRatio = org.energy / CONFIG.SPECIES[org.species].maxEnergy;
        const p = org.player;

        if (org.species === 'GRASS') {
            // Grass: bright, airy blades — lightest plant
            const h = 4 + energyRatio * 5;
            const fill = this._playerHSL(p, 20, 10, 18);
            ctx.strokeStyle = fill;
            ctx.lineWidth = 2.5;
            ctx.lineCap = 'round';
            // center blade
            ctx.beginPath();
            ctx.moveTo(cx, cy + 3);
            ctx.lineTo(cx, cy - h);
            ctx.stroke();
            // left blade
            ctx.beginPath();
            ctx.moveTo(cx - 1.5, cy + 2);
            ctx.lineTo(cx - 3.5, cy - h + 1.5);
            ctx.stroke();
            // right blade
            ctx.beginPath();
            ctx.moveTo(cx + 1.5, cy + 2);
            ctx.lineTo(cx + 3.5, cy - h + 1.5);
            ctx.stroke();
        } else if (org.species === 'SHRUB') {
            // Shrub: rich saturated bush — mid-tone plant
            const r = 3.5 + energyRatio * 3;
            const fill = this._playerHSL(p, -8, 15, -3);
            const outline = this._playerHSL(p, -12, 5, -18);
            ctx.fillStyle = fill;
            // main body
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
            // two side lobes
            ctx.beginPath();
            ctx.arc(cx - r * 0.65, cy + r * 0.25, r * 0.65, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(cx + r * 0.65, cy + r * 0.25, r * 0.65, 0, Math.PI * 2);
            ctx.fill();
            // top lobe
            ctx.beginPath();
            ctx.arc(cx, cy - r * 0.4, r * 0.55, 0, Math.PI * 2);
            ctx.fill();
            // outline
            ctx.strokeStyle = outline;
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();
        } else if (org.species === 'TREE') {
            // Tree: dark, commanding canopy — heaviest plant
            const canopyR = 4.5 + energyRatio * 5;
            const canopy = this._playerHSL(p, -18, 5, -10);
            const canopyLight = this._playerHSL(p, -12, 10, 2);
            const trunk = this._playerHSL(p, -40, -35, -25);

            // trunk
            ctx.fillStyle = trunk;
            ctx.fillRect(cx - 1.5, cy, 3, canopyR * 0.7);

            // canopy shadow
            ctx.fillStyle = canopy;
            ctx.beginPath();
            ctx.arc(cx, cy - canopyR * 0.15, canopyR, 0, Math.PI * 2);
            ctx.fill();

            // canopy highlight
            ctx.fillStyle = canopyLight;
            ctx.beginPath();
            ctx.arc(cx - canopyR * 0.2, cy - canopyR * 0.35, canopyR * 0.55, 0, Math.PI * 2);
            ctx.fill();

            // outline
            ctx.strokeStyle = this._playerHSL(p, -22, 0, -22);
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.arc(cx, cy - canopyR * 0.15, canopyR, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    _drawHerbivore(ctx, cx, cy, org) {
        const p = org.player;
        const energyRatio = org.energy / CONFIG.SPECIES[org.species].maxEnergy;

        if (org.species === 'GRAZER') {
            // Grazer: fast, bright animal — elongated oval with a head
            const bodyLen = 5.5 + energyRatio * 3;
            const bodyW = 3;
            const fill = this._playerHSL(p, 45, 15, 12);
            const outline = this._playerHSL(p, 40, 5, -12);

            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.ellipse(cx, cy, bodyLen, bodyW, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = outline;
            ctx.lineWidth = 1.0;
            ctx.stroke();

            // head
            ctx.fillStyle = outline;
            ctx.beginPath();
            ctx.arc(cx + bodyLen - 1.5, cy, 2.2, 0, Math.PI * 2);
            ctx.fill();

            // eye
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.arc(cx + bodyLen - 0.5, cy - 0.5, 0.8, 0, Math.PI * 2);
            ctx.fill();
        } else if (org.species === 'BROWSER') {
            // Browser: large, sturdy herbivore — rounded body with horns
            const s = 4 + energyRatio * 3;
            const fill = this._playerHSL(p, -30, 10, -5);
            const outline = this._playerHSL(p, -35, 0, -18);

            ctx.fillStyle = fill;
            // rounded rectangle body
            const r = s * 0.35;
            ctx.beginPath();
            ctx.moveTo(cx - s + r, cy - s * 0.7);
            ctx.arcTo(cx + s, cy - s * 0.7, cx + s, cy + s * 0.7, r);
            ctx.arcTo(cx + s, cy + s * 0.7, cx - s, cy + s * 0.7, r);
            ctx.arcTo(cx - s, cy + s * 0.7, cx - s, cy - s * 0.7, r);
            ctx.arcTo(cx - s, cy - s * 0.7, cx + s, cy - s * 0.7, r);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = outline;
            ctx.lineWidth = 1.0;
            ctx.stroke();

            // head bump
            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.arc(cx + s * 0.85, cy, s * 0.45, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = outline;
            ctx.lineWidth = 0.8;
            ctx.stroke();

            // small horns
            ctx.strokeStyle = outline;
            ctx.lineWidth = 1.2;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(cx + s * 0.7, cy - s * 0.2);
            ctx.lineTo(cx + s * 0.9, cy - s * 0.6);
            ctx.stroke();
        }
    }

    _drawPredator(ctx, cx, cy, org) {
        const p = org.player;
        const energyRatio = org.energy / CONFIG.SPECIES[org.species].maxEnergy;
        const s = 5 + energyRatio * 4;
        // Dark menacing body with bright player-colored accents
        const darkFill = this._playerHSL(p, 0, -30, -30);
        const brightAccent = this._playerHSL(p, 0, 10, 15);

        // Predator: angular diamond / fang shape — largest, most menacing
        ctx.fillStyle = darkFill;
        ctx.beginPath();
        ctx.moveTo(cx, cy - s);              // top point
        ctx.lineTo(cx + s * 0.5, cy - s * 0.2);
        ctx.lineTo(cx + s * 0.8, cy + s * 0.3);
        ctx.lineTo(cx, cy + s * 0.6);        // bottom
        ctx.lineTo(cx - s * 0.8, cy + s * 0.3);
        ctx.lineTo(cx - s * 0.5, cy - s * 0.2);
        ctx.closePath();
        ctx.fill();
        // bright player-colored outline
        ctx.strokeStyle = brightAccent;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // eyes — bright player color
        ctx.fillStyle = brightAccent;
        ctx.beginPath();
        ctx.arc(cx - s * 0.22, cy - s * 0.15, 1.6, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.22, cy - s * 0.15, 1.6, 0, Math.PI * 2);
        ctx.fill();
        // dark pupils
        ctx.fillStyle = '#111';
        ctx.beginPath();
        ctx.arc(cx - s * 0.2, cy - s * 0.15, 0.7, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.2, cy - s * 0.15, 0.7, 0, Math.PI * 2);
        ctx.fill();
    }

    drawPlacementHighlights() {
        if (this._highlightRound < 0) return;

        const ctx = this.ctx;

        this.grid.forEach((cell) => {
            // Find organisms placed this round in this cell
            const newOrgs = cell.organisms.filter(
                o => o._placedRound === this._highlightRound
            );
            if (newOrgs.length === 0) return;

            const { x, y } = this.grid.hexToPixel(cell.col, cell.row);
            const cx = x + this.offsetX;
            const cy = y + this.offsetY;

            // Use the player color of the first new organism in cell
            const player = newOrgs[0].player;
            const c = (player === 1 ? CONFIG.PLAYER_1 : CONFIG.PLAYER_2).PRIMARY;

            // Pulsing glow ring around the hex
            const corners = this.grid.hexCorners(cx, cy);

            // Outer glow
            ctx.save();
            ctx.shadowColor = `hsl(${c.h}, ${c.s}%, ${c.l}%)`;
            ctx.shadowBlur = 8;
            ctx.strokeStyle = `hsla(${c.h}, ${c.s}%, ${c.l + 10}%, 0.8)`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(corners[0].x, corners[0].y);
            for (let i = 1; i < 6; i++) {
                ctx.lineTo(corners[i].x, corners[i].y);
            }
            ctx.closePath();
            ctx.stroke();
            ctx.restore();
        });
    }

    render() {
        this.drawTerrain();
        this.drawOrganisms();
        this.drawPlacementHighlights();
        this._drawBursts();
    }

    // ── Placement burst (animated ring expanding from a cell) ──
    _ensureBursts() {
        if (!this._bursts) {
            this._bursts = [];
            this._burstRafId = null;
        }
    }

    placementBurst(cell, player) {
        if (!cell) return;
        this._ensureBursts();
        const { x, y } = this.grid.hexToPixel(cell.col, cell.row);
        const cx = x + this.offsetX;
        const cy = y + this.offsetY;
        const c = (player === 1 ? CONFIG.PLAYER_1 : CONFIG.PLAYER_2).PRIMARY;
        this._bursts.push({
            cx, cy,
            color: c,
            startedAt: performance.now(),
            duration: 480,
        });
        this._startBurstLoop();
    }

    _startBurstLoop() {
        if (this._burstRafId) return;
        const tick = () => {
            const now = performance.now();
            this._bursts = this._bursts.filter(b => now - b.startedAt < b.duration);
            this.render();
            if (this._bursts.length > 0) {
                this._burstRafId = requestAnimationFrame(tick);
            } else {
                this._burstRafId = null;
            }
        };
        this._burstRafId = requestAnimationFrame(tick);
    }

    _drawBursts() {
        if (!this._bursts || this._bursts.length === 0) return;
        const ctx = this.ctx;
        const now = performance.now();
        const baseSize = CONFIG.HEX_SIZE;

        for (const b of this._bursts) {
            const t = Math.min(1, (now - b.startedAt) / b.duration);
            // ease-out: fast start, slow end
            const eased = 1 - Math.pow(1 - t, 2.5);
            const radius = baseSize * (0.85 + eased * 1.55);
            const alpha = (1 - t) * 0.85;

            ctx.save();
            ctx.shadowColor = `hsl(${b.color.h}, ${b.color.s}%, ${b.color.l}%)`;
            ctx.shadowBlur = 12 * (1 - t * 0.6);
            ctx.strokeStyle = `hsla(${b.color.h}, ${b.color.s}%, ${Math.min(100, b.color.l + 18)}%, ${alpha})`;
            ctx.lineWidth = 2.5 * (1 - t * 0.4);
            ctx.beginPath();
            ctx.arc(b.cx, b.cy, radius, 0, Math.PI * 2);
            ctx.stroke();

            // inner glow ring
            ctx.strokeStyle = `hsla(${b.color.h}, ${b.color.s}%, ${b.color.l}%, ${alpha * 0.4})`;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(b.cx, b.cy, radius * 0.55, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }
    }

    // Get cell from canvas click coordinates
    getCellAtPixel(canvasX, canvasY) {
        const px = canvasX - this.offsetX;
        const py = canvasY - this.offsetY;
        return this.grid.pixelToHex(px, py);
    }

    // Highlight a cell (for hover/selection)
    highlightCell(cell, color = 'rgba(255,255,255,0.3)') {
        const { x, y } = this.grid.hexToPixel(cell.col, cell.row);
        const cx = x + this.offsetX;
        const cy = y + this.offsetY;
        this._drawHex(cx, cy, color, 'rgba(255,255,255,0.6)');
    }
}
