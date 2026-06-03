// Candidate style — emoji / glyphs. Near-zero effort, but glyphs can't be
// recolored per player. We surface that honestly with a player-colored
// ownership ring behind the glyph rather than pretending it isn't a problem.
// Drawn on canvas in the native 22×22 space so it sits on the same backdrop.

import { CONFIG } from '../../js/config.js';
import { playerColor } from '../lab-util.js';

export const meta = {
    id: 'emoji',
    label: 'Emoji / glyphs',
    substrate: 'canvas',
    note: 'Glyphs + ownership ring (cannot tint the glyph itself).',
};

const GLYPH = {
    GRASS: '🌿',
    SHRUB: '🪴',
    TREE: '🌳',
    GRAZER: '🦌',
    BROWSER: '🐗',
    PREDATOR: '🐺',
};

export function renderInto(ctx, { species, player, energy, cx, cy }) {
    const e = energy / CONFIG.SPECIES[species].maxEnergy;
    const ring = playerColor(player, 0, 10, 10);

    // ownership ring + faint disc
    ctx.save();
    ctx.fillStyle = playerColor(player, 0, 20, -8);
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    ctx.arc(cx, cy, 9.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = ring;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx, cy, 9.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // glyph (font size in base units; the lab's scale makes it fill the view)
    const size = 11 + e * 4;
    ctx.font = `${size}px "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(GLYPH[species] || '?', cx, cy + 0.5);
}
