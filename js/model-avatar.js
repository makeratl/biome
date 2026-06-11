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

// ---- avatar video policy (GPU-load valve) ----
// Concurrent <video> decode plus the bounce frame-capture/canvas-RAF loops are
// the prime suspect in the tournament renderer SIGILL: the crash forensics showed
// a flat ~10 MB JS heap (not OOM) dying mid-match with 6 videos live — a GPU-side
// death, not a JS one. This lets the host dial avatars down to shed that load.
// The spectator runs in its own process and leaves it at 'full'.
//   'full'  — native looping video + ping-pong bounce (richest, heaviest)
//   'plain' — native looping video, but NO bounce frame-capture/canvas RAF
//   'still' — no <video> at all; baked PNG / procedural portrait only (lightest)
let videoMode = 'full';
export function setAvatarVideoMode(mode) { videoMode = mode; }
export function getAvatarVideoMode() { return videoMode; }

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
export async function applyAvatarVideo(el, modelName, { category = 'victory', loop = true, bounce = false } = {}) {
    if (!el) return;
    if (!modelName) { clearAvatar(el); return; }
    await applyAvatar(el, modelName);                  // still portrait underneath
    // GPU-load valve: in 'still' mode stop at the portrait — no <video> decode,
    // no bounce capture loop. Tear down any clip already mounted here so flipping
    // the mode at match start actually sheds the load. See setAvatarVideoMode.
    if (videoMode === 'still') {
        const existing = el.querySelector('video.avatar-clip');
        if (existing) { teardownBounce(existing); existing.pause?.(); existing.remove(); }
        el.querySelector('canvas.avatar-clip-canvas')?.remove();
        return;
    }
    // 'plain' keeps native video but drops the expensive bounce machinery.
    const useBounce = bounce && videoMode === 'full';
    el.dataset.model = modelName;
    const manifest = await loadVideoManifest();
    if (el.dataset.model !== modelName) return;        // slot reassigned under us
    const url = videoUrl(manifest, modelName, category);
    let vid = el.querySelector('video.avatar-clip');
    if (!url) { if (vid) { teardownBounce(vid); vid.remove(); } return; }   // no clip → keep the still
    if (!vid) {
        vid = document.createElement('video');
        vid.className = 'avatar-clip';
        vid.muted = true; vid.playsInline = true; vid.autoplay = true;
        el.appendChild(vid);
    }
    // Bounce overrides native looping (it drives the loop itself).
    vid.loop = loop && !useBounce;
    if (vid.getAttribute('src') !== url) vid.src = url;
    setBounce(vid, useBounce);
    vid.play?.().catch(() => { /* autoplay may be deferred; first frame still shows */ });
}

// Smooth ping-pong (forward → back → forward …). A <video> can't render reverse
// playback — seeking a paused element every frame thrashes the decoder, so the
// time advances but the painted frame locks and jumps. Instead we play the first
// forward leg natively while caching every decoded frame, then hand off to a
// <canvas> driven from that cache: a time cursor bounces end↔start and we blit
// the nearest cached frame, which is buttery in both directions. Needs
// requestVideoFrameCallback (Chromium has it); without it we fall back to a
// plain forward loop. State lives on vid._bounce; teardownBounce cleans it up.
function setBounce(vid, on) {
    if (!on) { teardownBounce(vid); return; }
    if (vid._bounce) return;
    if (typeof vid.requestVideoFrameCallback !== 'function') { vid.loop = true; return; }

    const st = { frames: [], times: [], canvas: null, ctx: null, raf: null };
    vid._bounce = st;
    vid.loop = false;

    const begin = () => {
        if (vid._bounce !== st) return;
        const cap = 320;                                  // cap captured frame size
        const vw = vid.videoWidth || cap, vh = vid.videoHeight || cap;
        const s = Math.min(1, cap / Math.max(vw, vh));
        const cw = Math.max(1, Math.round(vw * s)), ch = Math.max(1, Math.round(vh * s));

        // Cache each decoded frame (synchronous canvas clone keeps them ordered).
        const capture = (now, meta) => {
            if (vid._bounce !== st) return;
            const fc = document.createElement('canvas');
            fc.width = cw; fc.height = ch;
            fc.getContext('2d').drawImage(vid, 0, 0, cw, ch);
            st.frames.push(fc); st.times.push(meta.mediaTime);
            if (vid.currentTime < (vid.duration || Infinity) - 0.04) vid.requestVideoFrameCallback(capture);
        };
        vid.requestVideoFrameCallback(capture);

        // First forward leg done → swap the video for the canvas bouncer.
        vid.addEventListener('ended', () => {
            if (vid._bounce !== st) return;
            if (st.frames.length < 2) { vid.loop = true; vid.currentTime = 0; vid.play?.().catch(() => {}); return; }
            const disp = document.createElement('canvas');
            disp.className = 'avatar-clip avatar-clip-canvas';
            disp.width = cw; disp.height = ch;
            st.canvas = disp; st.ctx = disp.getContext('2d');
            st.ctx.drawImage(st.frames[st.frames.length - 1], 0, 0);   // seamless handoff frame
            vid.style.visibility = 'hidden';
            vid.parentNode?.appendChild(disp);
            runCanvasBounce(vid, st);
        }, { once: true });
    };
    if (vid.readyState >= 1) begin();
    else vid.addEventListener('loadedmetadata', begin, { once: true });
}

// Drive the cached frames at real-time pace, cursor bouncing end↔start.
function runCanvasBounce(vid, st) {
    const { frames, times, ctx } = st;
    const n = frames.length;
    const t0 = times[0], t1 = times[n - 1];
    let cursor = t1, dir = -1, last = null;           // just played forward → reverse first
    const tick = (ts) => {
        if (vid._bounce !== st || !st.canvas?.isConnected) { st.raf = null; return; }
        if (last == null) last = ts;
        cursor += dir * (ts - last) / 1000;
        last = ts;
        if (cursor <= t0) { cursor = t0; dir = 1; }
        else if (cursor >= t1) { cursor = t1; dir = -1; }
        let i = 0; while (i < n - 1 && times[i + 1] <= cursor) i++;
        ctx.drawImage(frames[i], 0, 0);
        st.raf = requestAnimationFrame(tick);
    };
    st.raf = requestAnimationFrame(tick);
}

function teardownBounce(vid) {
    const st = vid._bounce;
    if (!st) return;
    vid._bounce = null;
    if (st.raf) cancelAnimationFrame(st.raf);
    st.canvas?.remove();
    st.frames = []; st.times = [];
    vid.style.visibility = '';
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

// Remove every animated clip (and its bounce machinery) under `root` — used when
// a carousel swaps a panel's content, so departing clips stop decoding instead of
// lingering as detached, still-playing media.
export function teardownClips(root) {
    root?.querySelectorAll?.('video.avatar-clip').forEach(v => { teardownBounce(v); v.pause?.(); v.remove(); });
    root?.querySelectorAll?.('canvas.avatar-clip-canvas').forEach(c => c.remove());
}

export function clearAvatar(el) {
    if (!el) return;
    delete el.dataset.model;
    el.style.backgroundImage = '';
    el.style.backgroundSize = '';
    el.style.backgroundPosition = '';
    const vid = el.querySelector('video.avatar-clip');
    if (vid) { teardownBounce(vid); vid.remove(); }
    el.querySelector('canvas.avatar-clip-canvas')?.remove();
    el.classList.remove('has-avatar');
}
