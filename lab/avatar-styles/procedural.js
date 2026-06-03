// Procedural avatar — the always-works fallback for any model, including
// families we've never seen. Draws a family-themed hex emblem from the resolved
// identity (palette + creature glyph + tier ornamentation). Zero assets.
//
// This is the candidate for the eventual shared js/model-avatar.js, same way the
// procedural organism art graduated out of the icon lab. Style contract:
//   meta: { id, label, note }
//   renderInto(ctx, { resolved, size, cx, cy })   // canvas 2D, size = display px

import { hexPath } from '../lab-util.js';

export const meta = {
    id: 'procedural',
    label: 'Procedural',
    note: 'Canvas fallback — family palette + creature glyph + tier rings. Always available.',
};

// Creature glyph per archetype. A hint, not the real art — the generated tier
// carries the detailed creature; this just has to read instantly at any size.
const GLYPH = {
    fox: '🦊', stag: '🦌', dragonfly: '🦋', falcon: '🦅', mantis: '🦗',
    anglerfish: '🐡', heron: '🦢', 'luna moth': '🌙', scarab: '🪲',
    chameleon: '🦎', owl: '🦉', tortoise: '🐢',
    // newer families
    peacock: '🦚', octopus: '🐙', wolf: '🐺', rhino: '🦏', scorpion: '🦂',
    tiger: '🐅', lynx: '🐆', otter: '🦦', panda: '🐼', beaver: '🦫',
    mouse: '🐭', koi: '🐟', horse: '🐴',
};

// Extra concentric rings per tier — the "same creature, more elaborate" cue.
const TIER_RINGS = { small: 0, mid: 1, large: 2, cloud: 2 };

function hsl(h, s, l, a = 1) { return `hsla(${h}, ${s}%, ${l}%, ${a})`; }

export function renderInto(ctx, { resolved, size, cx, cy }) {
    const { palette, family, sizeTier, initials } = resolved;
    const h = palette.hue;
    const ah = palette.accentHue;
    const r = size * 0.46;

    ctx.save();

    // Hex backdrop with a vertical family-hue gradient.
    hexPath(ctx, cx, cy, r);
    const grad = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
    grad.addColorStop(0, hsl(h, palette.sat, Math.min(72, palette.light + 14)));
    grad.addColorStop(1, hsl(h, palette.sat, Math.max(20, palette.light - 18)));
    ctx.fillStyle = grad;
    ctx.fill();

    // Concentric accent rings = size tier. Cloud rings glow.
    ctx.lineWidth = Math.max(1, size * 0.018);
    const rings = TIER_RINGS[sizeTier] || 0;
    for (let i = 0; i < rings; i++) {
        hexPath(ctx, cx, cy, r - (i + 1) * size * 0.055);
        ctx.strokeStyle = hsl(ah, palette.sat, sizeTier === 'cloud' ? 80 : 62, 0.7 - i * 0.18);
        ctx.stroke();
    }
    // Outer rim.
    hexPath(ctx, cx, cy, r);
    ctx.strokeStyle = hsl(ah, palette.sat, sizeTier === 'cloud' ? 78 : 50, 0.9);
    ctx.lineWidth = Math.max(1, size * 0.02);
    ctx.stroke();

    if (sizeTier === 'cloud') {
        ctx.save();
        hexPath(ctx, cx, cy, r);
        ctx.strokeStyle = hsl(ah, 90, 80, 0.6);
        ctx.lineWidth = Math.max(1, size * 0.05);
        ctx.shadowColor = hsl(ah, 90, 70, 0.9);
        ctx.shadowBlur = size * 0.12;
        ctx.stroke();
        ctx.restore();
    }

    // Creature glyph (hidden at very small sizes where it'd be mud).
    const glyph = GLYPH[family.archetype] || '◆';
    if (size >= 30) {
        ctx.font = `${Math.round(size * 0.42)}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(glyph, cx, cy - (size >= 56 ? size * 0.05 : 0));
    }

    // Initials — the legible-at-any-size anchor. Prominent when small, a footer tag when large.
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (size < 30) {
        ctx.font = `700 ${Math.round(size * 0.4)}px -apple-system, system-ui, sans-serif`;
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = size * 0.06;
        ctx.fillText(initials, cx, cy);
    } else {
        ctx.font = `600 ${Math.round(size * 0.13)}px -apple-system, system-ui, sans-serif`;
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = size * 0.04;
        ctx.fillText(initials, cx, cy + r * 0.62);
    }

    ctx.restore();
}
