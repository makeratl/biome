// Canvas rendering for the hex world

import { CONFIG } from './config.js';
import { TERRAIN_TYPES } from './terrain.js';
import { drawOrganism, BASE_HEX } from './organism-art.js';

export class Renderer {
    constructor(canvas, grid) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.grid = grid;
        this.offsetX = grid.hexSize + 4;
        this.offsetY = grid.hexSize + 4;

        // Fog of war — hide one player's new placements from the other
        this._fogRound = -1;
        this._fogPlayer = 0;

        // Placement highlights — glow around newly placed organisms
        this._highlightRound = -1;

        // Magnifier loupe — a cursor-following lens that re-renders the board
        // vector art at zoom (crisp, not an upscaled snapshot) plus a stats strip
        // for the hovered cell. col/row null means "no current target". `w`/`h`
        // are the zoom-view size; the stats strip adds its own height below.
        // See initMagnifier()/_drawMagnifier().
        this._mag = {
            enabled: false,
            zoom: 2.8,
            w: 248,
            h: 176,
            col: null,
            row: null,
            clientX: 0,
            clientY: 0,
        };

        this._resize();
        this.initMagnifier();
    }

    // ── Magnifier loupe ──

    // Build the loupe widget once and attach it to <body>: a rounded-rect zoom
    // canvas with a cell-stats strip beneath it. DPR-scaled for crispness and
    // pointer-events:none so it never steals hover from the board.
    initMagnifier() {
        if (this._magCanvas) return;
        const dpr = window.devicePixelRatio || 1;
        // Reuse the existing loupe across matches (Renderer is rebuilt per game)
        // so we don't leak a new widget into <body> each time.
        let wrap = document.querySelector('.board-loupe');
        if (!wrap) {
            wrap = document.createElement('div');
            wrap.innerHTML = '<canvas class="bl-view"></canvas><div class="bl-stats"></div>';
            document.body.appendChild(wrap);
        }
        wrap.className = 'board-loupe hidden';
        this._magWrap = wrap;
        this._magStats = wrap.querySelector('.bl-stats');
        const c = wrap.querySelector('.bl-view');
        c.width = this._mag.w * dpr;
        c.height = this._mag.h * dpr;
        c.style.width = this._mag.w + 'px';
        c.style.height = this._mag.h + 'px';
        this._magCanvas = c;
        this._magCtx = c.getContext('2d');

        // Restore persisted enable state — defaults ON (only an explicit '0',
        // i.e. the user turned it off, disables it).
        this._mag.enabled = localStorage.getItem('biome.magnifier') !== '0';
    }

    isMagnifierEnabled() {
        return this._mag.enabled;
    }

    setMagnifierEnabled(on) {
        this._mag.enabled = !!on;
        localStorage.setItem('biome.magnifier', on ? '1' : '0');
        if (!on) this.hideMagnifier();
    }

    // Record the hovered cell + cursor position. The next render() paints it.
    setMagnifierTarget(cell, clientX, clientY) {
        if (!this._mag.enabled || !cell) return;
        this._mag.col = cell.col;
        this._mag.row = cell.row;
        this._mag.clientX = clientX;
        this._mag.clientY = clientY;
    }

    hideMagnifier() {
        this._mag.col = null;
        this._mag.row = null;
        if (this._magWrap) this._magWrap.classList.add('hidden');
    }

    _drawMagnifier() {
        const m = this._mag;
        const mctx = this._magCtx;
        const dpr = window.devicePixelRatio || 1;
        const z = m.zoom * dpr;
        const cell = this.grid.getCell(m.col, m.row);

        // Source centre in board bitmap coords (matches drawTerrain offsets).
        const { x, y } = this.grid.hexToPixel(m.col, m.row);
        const srcX = x + this.offsetX;
        const srcY = y + this.offsetY;

        // Clear + neutral backdrop (so off-board areas read as intentional).
        mctx.setTransform(1, 0, 0, 1, 0, 0);
        mctx.clearRect(0, 0, this._magCanvas.width, this._magCanvas.height);
        mctx.fillStyle = '#0a0d0c';
        mctx.fillRect(0, 0, this._magCanvas.width, this._magCanvas.height);

        // Map board space → centred + zoomed + DPR-crisp. The canvas bounds clip
        // the rectangular view; CSS rounds the corners. No explicit ctx clip.
        mctx.save();
        mctx.setTransform(z, 0, 0, z, (m.w * dpr) / 2 - srcX * z, (m.h * dpr) / 2 - srcY * z);

        // Replay the exact board layers — reusing drawOrganisms() keeps the
        // fog-of-war invariant (isHidden) intact inside the loupe.
        this.drawTerrain(mctx);
        this.drawOrganisms(mctx);
        this.drawPlacementHighlights(mctx);
        this._drawBursts(mctx);

        // Outline the exact hex under the cursor so "the direct square" is clear.
        const corners = this.grid.hexCorners(srcX, srcY);
        mctx.beginPath();
        mctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 6; i++) mctx.lineTo(corners[i].x, corners[i].y);
        mctx.closePath();
        mctx.lineWidth = 1.5 / m.zoom;   // ~constant on-screen weight after zoom
        mctx.strokeStyle = 'rgba(255,255,255,0.9)';
        mctx.stroke();
        mctx.restore();

        // Cell stats strip (fog-respecting).
        if (this._magStats) this._magStats.innerHTML = this._magStatsHTML(cell);

        // Position the whole widget near the cursor, flipping at viewport edges.
        // Unhide first so offsetHeight reflects the stats strip for edge math.
        this._magWrap.classList.remove('hidden');
        const gap = 22;
        const ww = this._magWrap.offsetWidth || m.w;
        const wh = this._magWrap.offsetHeight || m.h;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = m.clientX + gap;
        let top = m.clientY - wh - gap;
        if (left + ww > vw - 8) left = m.clientX - ww - gap;
        if (left < 8) left = 8;
        if (top < 8) top = m.clientY + gap;
        if (top + wh > vh - 8) top = vh - wh - 8;
        this._magWrap.style.left = Math.round(left) + 'px';
        this._magWrap.style.top = Math.round(top) + 'px';
    }

    // Build the loupe's cell-stats strip. Mirrors the floating tooltip's content
    // (terrain, soil, organisms, coords) but lives inside the loupe — and honours
    // the fog invariant via isHidden(), so it never reveals hidden placements.
    _magStatsHTML(cell) {
        if (!cell) return '';
        const TERRAIN = {
            WATER:     { name: 'Water',     icon: '🌊', cls: 'water' },
            FERTILE:   { name: 'Fertile',   icon: '🌱', cls: 'fertile' },
            GRASSLAND: { name: 'Grassland', icon: '🌾', cls: 'grassland' },
            ROCKY:     { name: 'Rocky',     icon: '⛰', cls: 'rocky' },
        };
        const t = TERRAIN[cell.terrain] || { name: cell.terrain, icon: '◇', cls: '' };

        let soil = '';
        if (cell.terrain !== TERRAIN_TYPES.WATER) {
            const pct = Math.round((cell.nutrients / CONFIG.TERRAIN.MAX_NUTRIENTS) * 100);
            soil = `<span class="bl-soil">Soil ${pct}%</span>`;
        }

        const visible = cell.organisms.filter(o => !this.isHidden(o));
        const orgs = visible.length
            ? visible.map(o => {
                const sp = CONFIG.SPECIES[o.species];
                return `<div class="bl-org">
                    <span class="bl-dot p${o.player}"></span>
                    <span class="bl-org-name">${sp?.name || o.species}</span>
                    <span class="bl-org-e">${Math.round(o.energy)}E</span>
                </div>`;
            }).join('')
            : '<div class="bl-empty">No organisms</div>';

        return `
            <div class="bl-head">
                <span class="bl-terrain ${t.cls}">${t.icon} ${t.name}</span>
                <span class="bl-pos">(${cell.col}, ${cell.row})</span>
            </div>
            <div class="bl-sub">${soil}</div>
            <div class="bl-orgs">${orgs}</div>`;
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
        this._fit();
    }

    // Re-render the board at a new hex size (crisp, not a CSS upscale). The grid
    // is (col,row)-keyed and organisms reference cells, so this is pure
    // re-layout — no data changes. Used to grow/shrink the board to fill the
    // viewport (Game._refitBoard) without blurring. Caller renders after.
    setHexSize(s) {
        if (!(s > 0) || s === this.grid.hexSize) return;
        this.grid.hexSize = s;
        this.offsetX = s + 4;
        this.offsetY = s + 4;
        this._resize();
    }

    // Scale the canvas (via CSS) to fit inside its container, preserving aspect
    // ratio. Only ever shrinks (never CSS-upscales — that would blur); use the
    // hex-zoom setting to make a board intrinsically bigger and crisp. Clicks
    // are mapped back to bitmap pixels in the hit-test handlers.
    _fit() {
        const parent = this.canvas.parentElement;
        if (!parent) return;
        // clientWidth/Height include padding; subtract it so the board fits the
        // content area (the reserved header band lives in the top padding).
        const cs = getComputedStyle(parent);
        const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
        const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        const availW = (parent.clientWidth - padX) || this.canvas.width;
        const availH = (parent.clientHeight - padY) || this.canvas.height;
        const scale = Math.min(availW / this.canvas.width, availH / this.canvas.height, 1);
        this.canvas.style.width = Math.round(this.canvas.width * scale) + 'px';
        this.canvas.style.height = Math.round(this.canvas.height * scale) + 'px';
        this._publishBoardRect();
    }

    // Expose the board's live on-screen rect as CSS vars on :root so overlays
    // (tournament screens, game-over, AI banter, expanded bracket) can anchor to
    // the board instead of the viewport — centered ON the world, never a
    // fullscreen takeover. Updated wherever the board is (re)sized: resize,
    // hex-zoom, and the animated footer band all funnel through _fit().
    _publishBoardRect() {
        const r = this.canvas.getBoundingClientRect();
        // Set on <body>, where the --board-* defaults live. Setting on <html>
        // instead would be shadowed: body re-declares the defaults, so its
        // descendants (console, banter) would inherit the body value, not html's.
        const root = document.body.style;
        root.setProperty('--board-l', Math.round(r.left) + 'px');
        root.setProperty('--board-t', Math.round(r.top) + 'px');
        root.setProperty('--board-w', Math.round(r.width) + 'px');
        root.setProperty('--board-h', Math.round(r.height) + 'px');
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

    _drawHex(cx, cy, fill, stroke, ctx = this.ctx) {
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

    drawTerrain(ctx = this.ctx) {
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

        this.grid.forEach((cell) => {
            const { x, y } = this.grid.hexToPixel(cell.col, cell.row);
            const cx = x + this.offsetX;
            const cy = y + this.offsetY;

            this._drawHex(cx, cy, this._terrainColor(cell), CONFIG.COLORS.GRID_LINE, ctx);
        });
    }

    drawOrganisms(ctx = this.ctx) {
        this.grid.forEach((cell) => {
            if (cell.organisms.length === 0) return;

            const { x, y } = this.grid.hexToPixel(cell.col, cell.row);
            const cx = x + this.offsetX;
            const cy = y + this.offsetY;

            for (const org of cell.organisms) {
                if (this.isHidden(org)) continue;
                this._drawOrganism(cx, cy, org, ctx);
            }
        });
    }

    _drawOrganism(cx, cy, org, ctx = this.ctx) {
        // Per-species procedural art lives in js/organism-art.js so the game
        // and the icon lab (lab/icons.html) share one source of truth. Art is
        // authored against BASE_HEX; scale it so creatures track the hex zoom.
        const k = this.grid.hexSize / BASE_HEX;
        if (k === 1) {
            drawOrganism(ctx, cx, cy, org);
            return;
        }
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(k, k);
        drawOrganism(ctx, 0, 0, org);
        ctx.restore();
    }

    drawPlacementHighlights(ctx = this.ctx) {
        if (this._highlightRound < 0) return;

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
        if (this._mag.enabled && this._mag.col != null) this._drawMagnifier();
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

    _drawBursts(ctx = this.ctx) {
        if (!this._bursts || this._bursts.length === 0) return;
        const now = performance.now();
        const baseSize = this.grid.hexSize;

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
