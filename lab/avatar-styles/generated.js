// Generated avatar — baked Comfy PNGs, keyed by style + avatarKey through a
// manifest. On a miss (no image for this style/family/tier yet) it falls back to
// the procedural emblem, so a cell is never blank while a collection is still
// being baked.
//
// The manifest is nested by visual style so multiple styles coexist:
//   { "cyber-organic": { "qwen-large": "avatars/cyber-organic/qwen-large.png" }, … }
// This is the runtime resolution path the game will eventually use:
//   resolveModel(name).avatarKey + chosen style → manifest → PNG, else procedural.

import * as procedural from './procedural.js';

export const meta = {
    id: 'generated',
    label: 'Generated',
    note: 'Baked Comfy portraits via avatars/manifest.json. Falls back to procedural until baked.',
};

let manifestPromise = null;
let version = 0;                  // bumped on each bust so freshly-baked PNGs reload
const imageCache = new Map();     // versioned URL → HTMLImageElement (loaded)

// Loaded once, shared. Pass a truthy `bust` after (re)baking to force a refetch
// and invalidate cached <img>s (their URLs carry the version).
export function loadManifest(bust = false) {
    if (!manifestPromise || bust) {
        if (bust) version++;
        const url = '/avatars/manifest.json' + (bust ? `?t=${bust}` : '');
        manifestPromise = fetch(url)
            .then(r => (r.ok ? r.json() : {}))
            .catch(() => ({}));
    }
    return manifestPromise;
}

function loadImage(src) {
    if (imageCache.has(src)) return imageCache.get(src);
    const img = new Image();
    const p = new Promise((resolve, reject) => {
        img.onload = () => resolve(img);
        img.onerror = reject;
    });
    img.src = src;
    img._ready = p;
    imageCache.set(src, img);
    return img;
}

// Async-friendly: draws the procedural fallback immediately, then upgrades to the
// PNG once both the manifest and image have loaded (so the grid paints instantly
// and fills in art as it arrives). `redraw` is an optional callback to repaint.
export function renderInto(ctx, opts) {
    const { resolved, size, cx, cy, style = 'cyber-organic' } = opts;
    procedural.renderInto(ctx, opts); // immediate floor

    loadManifest().then(manifest => {
        const src = (manifest[style] || {})[resolved.avatarKey];
        if (!src) return; // no baked art for this style yet — keep the fallback
        const url = '/' + src.replace(/^\/+/, '') + (version ? `?v=${version}` : '');
        const img = loadImage(url);
        img._ready.then(() => {
            // Clip to the hex so the square PNG sits in the emblem shape.
            ctx.save();
            ctx.clearRect(cx - size / 2, cy - size / 2, size, size);
            roundHexClip(ctx, cx, cy, size * 0.46);
            ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
            ctx.restore();
            if (typeof opts.onUpgrade === 'function') opts.onUpgrade();
        }).catch(() => { /* keep fallback */ });
    });
}

function roundHexClip(ctx, cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        const x = cx + r * Math.cos(a);
        const y = cy + r * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.clip();
}
