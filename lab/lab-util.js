// Shared helpers for the icon lab. Kept deliberately small and decoupled from
// the game's HexGrid — a flat-top hex path and terrain-swatch colors are the
// only things duplicated, and they don't touch gameplay.

import { CONFIG } from '../js/config.js';

// Native authoring footprint. All organism art (procedural + candidates) is
// drawn inside a 22×22 box centered at (11, 11) — roughly one on-board hex at
// HEX_SIZE 11. Styles draw in this space; the lab scales it up for the views.
export const BASE_CELL = 22;
export const CENTER = BASE_CELL / 2;

export const TERRAINS = ['FERTILE', 'GRASSLAND', 'ROCKY', 'WATER'];

// Base terrain color as the game would draw it at full nutrients, no elevation
// shading — a representative backdrop swatch.
export function terrainColor(terrain) {
    const c = CONFIG.COLORS[terrain];
    if (!c) return '#333';
    return `hsl(${c.h}, ${c.s}%, ${c.l}%)`;
}

// A device-pixel-ratio-aware canvas whose drawing space is `display` CSS px.
export function makeCanvas(display) {
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(display * dpr);
    canvas.height = Math.round(display * dpr);
    canvas.style.width = display + 'px';
    canvas.style.height = display + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { canvas, ctx, display };
}

// Flat-top hexagon path centered at (cx, cy) with circumradius r — matches the
// game's hex orientation (corners at 0°, 60°, … 300°).
export function hexPath(ctx, cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        const x = cx + r * Math.cos(a);
        const y = cy + r * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
}

// Fill a terrain hex backdrop that fills the canvas, with the subtle grid line.
export function drawTerrainHex(ctx, display, terrain) {
    const cx = display / 2;
    const cy = display / 2;
    hexPath(ctx, cx, cy, display / 2 - 1);
    ctx.fillStyle = terrainColor(terrain);
    ctx.fill();
    ctx.strokeStyle = CONFIG.COLORS.GRID_LINE;
    ctx.lineWidth = 1;
    ctx.stroke();
}

// Set up a canvas ctx so a style can draw in the native 22×22 space and have it
// scaled to fill `display` px. Returns the center to draw around.
export function intoBaseSpace(ctx, display) {
    const scale = display / BASE_CELL;
    ctx.save();
    ctx.scale(scale, scale);
    return { cx: CENTER, cy: CENTER, restore: () => ctx.restore() };
}

// Player tint as an HSL string, same math the game uses (organism-art.playerHSL),
// re-exposed here for candidate styles that want player-matched colors.
export function playerColor(player, hueShift = 0, satShift = 0, lightShift = 0) {
    const c = (player === 1 ? CONFIG.PLAYER_1 : CONFIG.PLAYER_2).PRIMARY;
    const s = Math.max(0, Math.min(100, c.s + satShift));
    const l = Math.max(0, Math.min(100, c.l + lightShift));
    return `hsl(${c.h + hueShift}, ${s}%, ${l}%)`;
}
