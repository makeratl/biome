// Baseline style — the live game's procedural canvas art, unchanged.
// Delegates to the shared module so this column always mirrors what ships.

import { drawOrganism } from '../../js/organism-art.js';

export const meta = {
    id: 'gameart',
    label: 'Game art (live)',
    substrate: 'canvas',
    note: 'The live in-game art, from js/organism-art.js. Edit there to iterate.',
};

// cell: a <canvas> 2D context positioned so (cx, cy) is the icon center.
// The organism art is authored around a ~22px hex, so we translate to center
// and let the routines draw at their native scale; the lab scales the canvas
// itself via CSS for the zoomed view.
export function renderInto(ctx, { species, player, energy, cx, cy }) {
    drawOrganism(ctx, cx, cy, { species, player, energy });
}
