// Procedural organism art — the canvas drawing routines for every species.
//
// Shared by the game's Renderer and the standalone icon lab (lab/icons.html)
// so both draw from one source of truth. These functions are pure: they take a
// 2D context, a center point, and a plain organism-like object
// { species, player, energy }. No grid, fog, or Renderer state.
//
// Art is authored around a ~22px hex (HEX_SIZE 11), centered at (cx, cy), at
// native scale — the game draws it directly; the lab scales the context up for
// its zoomed views.

import { CONFIG } from './config.js';

// The hex radius the art is authored against. Callers drawing on a board with a
// different hex size should scale the context by (hexSize / BASE_HEX) so the
// creatures grow and shrink with the cells.
export const BASE_HEX = 11;

// Player-tinted HSL color.
export function playerHSL(player, hueShift = 0, satShift = 0, lightShift = 0) {
    const c = (player === 1 ? CONFIG.PLAYER_1 : CONFIG.PLAYER_2).PRIMARY;
    const s = Math.max(0, Math.min(100, c.s + satShift));
    const l = Math.max(0, Math.min(100, c.l + lightShift));
    return `hsl(${c.h + hueShift}, ${s}%, ${l}%)`;
}

function energyRatio(species, energy) {
    return energy / CONFIG.SPECIES[species].maxEnergy;
}

// Soft contact shadow to ground a creature on the terrain.
function groundShadow(ctx, cx, cy, w, h) {
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, w, h, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

// Dispatch an organism to its species drawing routine.
//
// All art is authored facing right. Player 2's organisms are mirrored
// horizontally about their center — so the two sides face opposite ways, an
// extra layer of visual separation on top of the player color tint. The flip
// lives here (not in the Renderer) so every caller — game field, HUD, icon
// lab — stays consistent from one source of truth.
export function drawOrganism(ctx, cx, cy, org) {
    const spec = CONFIG.SPECIES[org.species];
    if (!spec) return;

    const mirror = org.player === 2;
    if (mirror) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(-1, 1);
        cx = 0;
        cy = 0;
    }

    if (spec.type === 'plant') {
        drawPlant(ctx, cx, cy, org);
    } else if (spec.type === 'herbivore') {
        drawHerbivore(ctx, cx, cy, org);
    } else if (spec.type === 'predator') {
        drawPredator(ctx, cx, cy, org);
    }

    if (mirror) ctx.restore();
}

export function drawPlant(ctx, cx, cy, org) {
    const e = energyRatio(org.species, org.energy);
    const p = org.player;

    if (org.species === 'GRASS') {
        // Sedgeweave — a full tuft of curved blades with bright tips.
        const h = 5 + e * 6;
        groundShadow(ctx, cx, cy + 6, 5, 1.4);
        const base = playerHSL(p, 18, 12, 6);
        const tip = playerHSL(p, 24, 18, 26);
        ctx.lineCap = 'round';
        const blades = [-4, -2, 0, 2, 4];
        blades.forEach((dx, i) => {
            const lean = dx * 0.5;
            const bh = h * (0.7 + 0.3 * Math.cos(i));
            const grad = ctx.createLinearGradient(cx + dx, cy + 4, cx + dx + lean, cy - bh);
            grad.addColorStop(0, base);
            grad.addColorStop(1, tip);
            ctx.strokeStyle = grad;
            ctx.lineWidth = 1.8;
            ctx.beginPath();
            ctx.moveTo(cx + dx, cy + 4);
            ctx.quadraticCurveTo(cx + dx + lean * 0.5, cy - bh * 0.4, cx + dx + lean, cy - bh);
            ctx.stroke();
        });
    } else if (org.species === 'SHRUB') {
        // Thornbloom — layered foliage clumps, darker base, bright crown, berries.
        const r = 4 + e * 3.2;
        groundShadow(ctx, cx, cy + r * 0.75, r * 1.1, 1.6);
        const dark = playerHSL(p, -10, 16, -16);
        const mid = playerHSL(p, -6, 16, -4);
        const light = playerHSL(p, -2, 18, 10);
        const clumps = [
            [0, r * 0.25, r],
            [-r * 0.7, r * 0.35, r * 0.7],
            [r * 0.7, r * 0.35, r * 0.7],
            [0, -r * 0.45, r * 0.65],
        ];
        ctx.fillStyle = dark;
        clumps.forEach(([dx, dy, rr]) => {
            ctx.beginPath();
            ctx.arc(cx + dx, cy + dy, rr, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.fillStyle = mid;
        clumps.forEach(([dx, dy, rr]) => {
            ctx.beginPath();
            ctx.arc(cx + dx - rr * 0.15, cy + dy - rr * 0.2, rr * 0.8, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.fillStyle = light;
        ctx.beginPath();
        ctx.arc(cx - r * 0.2, cy - r * 0.4, r * 0.5, 0, Math.PI * 2);
        ctx.fill();
        // berries
        ctx.fillStyle = playerHSL(p, 40, 30, 8);
        [[-r * 0.3, r * 0.1], [r * 0.35, -r * 0.1], [0, r * 0.4]].forEach(([dx, dy]) => {
            ctx.beginPath();
            ctx.arc(cx + dx, cy + dy, 0.9, 0, Math.PI * 2);
            ctx.fill();
        });
    } else if (org.species === 'TREE') {
        // Spirewood — tapered trunk, layered conifer-ish spire canopy.
        const ch = 6 + e * 6;
        const cw = 4 + e * 2.5;
        groundShadow(ctx, cx, cy + ch * 0.55, cw * 1.1, 1.8);
        // trunk
        const trunk = playerHSL(p, -42, -38, -22);
        ctx.fillStyle = trunk;
        ctx.beginPath();
        ctx.moveTo(cx - 1.4, cy + ch * 0.5);
        ctx.lineTo(cx + 1.4, cy + ch * 0.5);
        ctx.lineTo(cx + 0.9, cy - ch * 0.1);
        ctx.lineTo(cx - 0.9, cy - ch * 0.1);
        ctx.closePath();
        ctx.fill();
        // three stacked canopy tiers, dark→light
        const dark = playerHSL(p, -20, 10, -14);
        const light = playerHSL(p, -12, 14, 2);
        const tiers = [
            [cy + ch * 0.15, cw],
            [cy - ch * 0.15, cw * 0.8],
            [cy - ch * 0.45, cw * 0.55],
        ];
        tiers.forEach(([ty, hw], i) => {
            ctx.fillStyle = i === tiers.length - 1 ? light : dark;
            ctx.beginPath();
            ctx.moveTo(cx, ty - ch * 0.35);
            ctx.lineTo(cx + hw, ty + ch * 0.1);
            ctx.lineTo(cx - hw, ty + ch * 0.1);
            ctx.closePath();
            ctx.fill();
        });
        // highlight on the sunlit side
        ctx.fillStyle = light;
        ctx.beginPath();
        ctx.moveTo(cx - 0.5, cy - ch * 0.8);
        ctx.lineTo(cx - cw * 0.45, cy - ch * 0.1);
        ctx.lineTo(cx - 0.5, cy - ch * 0.1);
        ctx.closePath();
        ctx.fill();
    }
}

export function drawHerbivore(ctx, cx, cy, org) {
    const e = energyRatio(org.species, org.energy);
    const p = org.player;

    if (org.species === 'GRAZER') {
        // Hopgrazer — small rounded herbivore with an ear, leg, bright eye.
        const s = 4.5 + e * 2.5;
        groundShadow(ctx, cx, cy + s * 0.7, s * 1.1, 1.4);
        const body = playerHSL(p, 45, 16, 14);
        const out = playerHSL(p, 40, 8, -14);
        // hind legs
        ctx.fillStyle = out;
        ctx.beginPath();
        ctx.ellipse(cx - s * 0.5, cy + s * 0.4, s * 0.32, s * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        // body
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(cx, cy, s, s * 0.72, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = out;
        ctx.stroke();
        // head
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.arc(cx + s * 0.8, cy - s * 0.2, s * 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // ear
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(cx + s * 0.7, cy - s * 0.8, s * 0.16, s * 0.42, -0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // eye
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(cx + s * 0.95, cy - s * 0.3, 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#111';
        ctx.beginPath();
        ctx.arc(cx + s * 1.05, cy - s * 0.3, 0.5, 0, Math.PI * 2);
        ctx.fill();
    } else if (org.species === 'BROWSER') {
        // Bramblemaw — bulky horned herbivore with snout and stout legs.
        const s = 4.5 + e * 3;
        groundShadow(ctx, cx, cy + s * 0.75, s * 1.2, 1.7);
        const body = playerHSL(p, -30, 12, -3);
        const out = playerHSL(p, -35, 4, -18);
        // legs
        ctx.fillStyle = out;
        [-0.6, 0.4].forEach((dx) => {
            ctx.fillRect(cx + s * dx, cy + s * 0.3, s * 0.3, s * 0.6);
        });
        // body
        ctx.fillStyle = body;
        const r = s * 0.45;
        ctx.beginPath();
        ctx.moveTo(cx - s + r, cy - s * 0.6);
        ctx.arcTo(cx + s, cy - s * 0.6, cx + s, cy + s * 0.5, r);
        ctx.arcTo(cx + s, cy + s * 0.5, cx - s, cy + s * 0.5, r);
        ctx.arcTo(cx - s, cy + s * 0.5, cx - s, cy - s * 0.6, r);
        ctx.arcTo(cx - s, cy - s * 0.6, cx + s, cy - s * 0.6, r);
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = 0.9;
        ctx.strokeStyle = out;
        ctx.stroke();
        // back highlight
        ctx.fillStyle = playerHSL(p, -28, 12, 6);
        ctx.beginPath();
        ctx.ellipse(cx - s * 0.2, cy - s * 0.35, s * 0.6, s * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
        // head + snout
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.arc(cx + s * 0.9, cy - s * 0.05, s * 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // horns
        ctx.strokeStyle = playerHSL(p, -38, 0, 24);
        ctx.lineWidth = 1.4;
        ctx.lineCap = 'round';
        [[-0.1, -0.45], [0.25, -0.4]].forEach(([hx, hy]) => {
            ctx.beginPath();
            ctx.moveTo(cx + s * (0.7 + hx), cy - s * 0.3);
            ctx.lineTo(cx + s * (0.85 + hx), cy + s * hy - s * 0.5);
            ctx.stroke();
        });
        // eye
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(cx + s * 1.1, cy - s * 0.1, 0.9, 0, Math.PI * 2);
        ctx.fill();
    }
}

export function drawPredator(ctx, cx, cy, org) {
    const e = energyRatio(org.species, org.energy);
    const p = org.player;
    // Shadestalker — sleek dark hunter, angular crest, glowing eyes, tail.
    const s = 5.5 + e * 4;
    groundShadow(ctx, cx, cy + s * 0.6, s * 1.1, 1.6);
    const dark = playerHSL(p, 0, -28, -32);
    const darker = playerHSL(p, 0, -20, -42);
    const accent = playerHSL(p, 0, 18, 22);
    // tail
    ctx.strokeStyle = darker;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.5, cy + s * 0.2);
    ctx.quadraticCurveTo(cx - s * 1.1, cy + s * 0.1, cx - s * 1.0, cy - s * 0.4);
    ctx.stroke();
    // body — angular crouched silhouette
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.55, cy + s * 0.45);
    ctx.lineTo(cx - s * 0.75, cy - s * 0.15);
    ctx.lineTo(cx - s * 0.2, cy - s * 0.55);   // shoulder
    ctx.lineTo(cx + s * 0.35, cy - s * 0.75);  // neck
    ctx.lineTo(cx + s * 0.85, cy - s * 0.45);  // head top
    ctx.lineTo(cx + s * 0.95, cy - s * 0.05);  // snout
    ctx.lineTo(cx + s * 0.5, cy + s * 0.15);
    ctx.lineTo(cx + s * 0.55, cy + s * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    // ear crest
    ctx.fillStyle = darker;
    ctx.beginPath();
    ctx.moveTo(cx + s * 0.4, cy - s * 0.7);
    ctx.lineTo(cx + s * 0.5, cy - s * 1.05);
    ctx.lineTo(cx + s * 0.62, cy - s * 0.6);
    ctx.closePath();
    ctx.fill();
    // glowing eye
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.arc(cx + s * 0.68, cy - s * 0.32, 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(cx + s * 0.7, cy - s * 0.32, 0.35, 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
}
