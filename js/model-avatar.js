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

// Warm the caches early so the first badge/card paint finds them ready.
export function preloadAvatars() { loadManifest(); loadVideoManifest(); }

// ---- avatar animation clips (victory/defeat/… emotions) ----
// Generated in the lab (lab/avatars.html → server → ComfyUI WAN i2v) and tracked
// in videos/manifest.json, shape { <category>: { <avatarKey>: path } }. The game
// consumes them the same way it consumes the still PNGs: resolve model → key →
// manifest → clip, else fall back to the still portrait.
const VIDEO_MANIFEST_URL = '/videos/manifest.json';
let videoManifestPromise = null;
let videoVersion = 0;

export function loadVideoManifest(bust = false) {
    if (!videoManifestPromise || bust) {
        if (bust) videoVersion++;
        const url = VIDEO_MANIFEST_URL + (bust ? `?t=${bust}` : '');
        videoManifestPromise = fetch(url)
            .then(r => (r.ok ? r.json() : {}))
            .catch(() => ({}));
    }
    return videoManifestPromise;
}

// Clip url for a model + emotion category, or null if none baked.
export function videoUrl(manifest, modelName, category = 'victory') {
    const key = resolveModel(modelName).avatarKey;
    const src = (manifest[category] || {})[key];
    if (!src) return null;
    return '/' + src.replace(/^\/+/, '') + (videoVersion ? `?v=${videoVersion}` : '');
}

// Apply an animated clip to a hex-clipped element for the given emotion. Always
// paints the still portrait first (instant first frame + fallback), then overlays
// a muted, looping <video> if a clip exists for this model+category. No clip →
// the still stays. Re-entrant via el.dataset.model, like applyAvatar.
export async function applyAvatarVideo(el, modelName, { category = 'victory', loop = true } = {}) {
    if (!el) return;
    if (!modelName) { clearAvatar(el); return; }
    await applyAvatar(el, modelName);                  // still portrait underneath
    el.dataset.model = modelName;
    const manifest = await loadVideoManifest();
    if (el.dataset.model !== modelName) return;        // slot reassigned under us
    const url = videoUrl(manifest, modelName, category);
    let vid = el.querySelector('video.avatar-clip');
    if (!url) { if (vid) vid.remove(); return; }       // no clip → keep the still
    if (!vid) {
        vid = document.createElement('video');
        vid.className = 'avatar-clip';
        vid.muted = true; vid.playsInline = true; vid.autoplay = true;
        el.appendChild(vid);
    }
    vid.loop = loop;
    if (vid.getAttribute('src') !== url) vid.src = url;
    vid.play?.().catch(() => { /* autoplay may be deferred; first frame still shows */ });
}

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
export async function applyAvatar(el, modelName, { style = 'cyber-organic', cover = true } = {}) {
    if (!el) return;
    if (!modelName) { clearAvatar(el); return; }
    const resolved = resolveModel(modelName);
    el.dataset.model = modelName;
    el.style.setProperty('--bh', resolved.hue);   // brand-hue fallback, immediate

    const manifest = await loadManifest();
    if (el.dataset.model !== modelName) return;    // slot changed under us
    const url = avatarUrl(manifest, modelName, style);
    if (url) {
        el.style.backgroundImage = `url("${url}")`;
        // For hex chips, force cover sizing inline: some slot selectors (e.g.
        // .ai-overlay.p1 .aic-avatar) use a `background` shorthand that out-specifies
        // a .has-avatar background-size rule. Callers that style the texture
        // themselves (the scoreboard bleed) pass cover:false.
        if (cover) {
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
        }
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
    const vid = el.querySelector('video.avatar-clip');
    if (vid) vid.remove();
    el.classList.remove('has-avatar');
}
