// Game-facing avatar resolution. Bridges a model name → its baked cyber-organic
// portrait (from avatars/manifest.json) or a brand-hue procedural fallback, and
// applies it to a DOM element (the tournament hex badges and the AI player cards
// are hex-clipped boxes, so a hex-filling background-image just works).
//
// The lab is where avatars are *created* (lab/avatars.html → server → ComfyUI);
// this module is how the game *consumes* them. They meet at the shared manifest:
// generate in the lab, and the game picks it up (no-cache fetch) on next load.

import { resolveModel } from './model-identity.js';

const MANIFEST_URL = '/avatars/manifest.json';
let manifestPromise = null;
let version = 0;   // bumped on bust so a freshly-baked PNG isn't served stale

// Loaded once and shared. Pass a truthy `bust` to force a refetch (e.g. after the
// lab bakes a new avatar in the same session).
export function loadManifest(bust = false) {
    if (!manifestPromise || bust) {
        if (bust) version++;
        const url = MANIFEST_URL + (bust ? `?t=${bust}` : '');
        manifestPromise = fetch(url)
            .then(r => (r.ok ? r.json() : {}))
            .catch(() => ({}));
    }
    return manifestPromise;
}

// Warm the cache early so the first badge/card paint finds it ready.
export function preloadAvatars() { loadManifest(); }

// Resolved PNG url for a model+style, or null if nothing baked. Requires the
// manifest to be loaded already (callers use applyAvatar, which awaits it).
export function avatarUrl(manifest, modelName, style = 'cyber-organic') {
    const key = resolveModel(modelName).avatarKey;
    const src = (manifest[style] || {})[key];
    if (!src) return null;
    return '/' + src.replace(/^\/+/, '') + (version ? `?v=${version}` : '');
}

// Apply an avatar to a hex-clipped element. Baked → hex-filling background image
// (adds `.has-avatar`, which hides the initials text via CSS). Unbaked → sets the
// element's brand hue (`--bh`) and leaves the existing gradient + initials as the
// procedural fallback. Re-entrant: tags `el.dataset.model` and bails if the slot
// was reassigned to a different model before the manifest resolved.
export async function applyAvatar(el, modelName, { style = 'cyber-organic' } = {}) {
    if (!el) return;
    if (!modelName) { clearAvatar(el); return; }
    const resolved = resolveModel(modelName);
    el.dataset.model = modelName;
    el.style.setProperty('--bh', resolved.hue);   // brand-hue fallback, immediate

    const manifest = await loadManifest();
    if (el.dataset.model !== modelName) return;    // slot changed under us
    const url = avatarUrl(manifest, modelName, style);
    if (url) {
        // Set sizing inline too: some slot selectors (e.g. .ai-overlay.p1 .aic-avatar)
        // use a `background` shorthand that out-specifies a .has-avatar background-size
        // rule and would reset it to `auto`. Inline wins regardless of specificity.
        el.style.backgroundImage = `url("${url}")`;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
        el.classList.add('has-avatar');
    } else {
        el.style.backgroundImage = '';
        el.classList.remove('has-avatar');
    }
}

export function clearAvatar(el) {
    if (!el) return;
    delete el.dataset.model;
    el.style.backgroundImage = '';
    el.style.backgroundSize = '';
    el.style.backgroundPosition = '';
    el.classList.remove('has-avatar');
}
