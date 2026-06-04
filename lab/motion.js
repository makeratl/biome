// Motion-prompt presets for avatar animations. Each baked still is the WAN 2.2
// image-to-video start frame; these describe the *motion* layered on top, keyed by
// category. Templates interpolate the creature's archetype so a fox's victory reads
// differently from a dragon's, and echo the still framing ("dark background,
// centered") so the clip stays on-model with its portrait.
//
// The lab seeds an editable textarea from these; per-key edits persist as overrides
// (avatars/lab-overrides.json, written via POST /lab/overrides) and win over the
// default next session. Server-side categories live in server.py:VIDEO_CATEGORIES.

// Ordered live-clips first (intro/idle/thinking), then match outcomes
// (victory/defeat/champion), so the lab studio groups them naturally.
export const VIDEO_CATEGORIES = ['intro', 'idle', 'thinking', 'victory', 'defeat', 'champion'];

export const CATEGORY_LABEL = {
    intro: '🎬 Intro', idle: '🌙 Idle', thinking: '🧠 Thinking',
    victory: '🏆 Victory', defeat: '💀 Defeat', champion: '👑 Champion',
};

export const DEFAULT_MOTION = {
    intro: (resolved) => {
        const a = resolved.family.archetype;
        return `the ${a} rises and steps forward into a spotlight, head lifting alert, `
            + `circuitry powering on and energy gathering, settling into a poised ready stance; `
            + `dark background, centered, confident entrance`;
    },
    idle: (resolved) => {
        const a = resolved.family.archetype;
        return `the ${a} breathes calmly in place, its glow softly pulsing, circuitry flickering, `
            + `an occasional subtle head-tilt or blink, watchful and still; dark background, `
            + `centered, seamless subtle loop`;
    },
    thinking: (resolved) => {
        const a = resolved.family.archetype;
        return `the ${a} scans intently, eyes narrowing in focus, circuitry rippling with pulses `
            + `of light as it calculates, faint energy threads tracing the air; dark background, `
            + `centered, restless contemplative loop`;
    },
    victory: (resolved) => {
        const a = resolved.family.archetype;
        return `the ${a} rears up in triumph, head lifting high, glowing circuitry and `
            + `bioluminescent accents flaring brighter, sparks of energy crackling around it, `
            + `slow confident camera push-in; dark background, centered, subtle looping motion`;
    },
    defeat: (resolved) => {
        const a = resolved.family.archetype;
        return `the ${a} staggers and slumps, head lowering, its glow dimming to faint embers, `
            + `wisps of ash and smoke drifting upward, energy fading away; dark background, `
            + `centered, slow mournful motion`;
    },
    champion: (resolved) => {
        const a = resolved.family.archetype;
        return `the ${a} stands crowned in glory, head raised regal and proud, a radiant aura `
            + `blooming around it, golden light and bioluminescent circuitry pulsing in waves, `
            + `slow majestic camera orbit; dark background, centered, triumphant sustained loop`;
    },
};

// Default motion prompt for a resolved model + category, or '' for an unknown one.
export function motionPrompt(resolved, category) {
    const fn = DEFAULT_MOTION[category];
    return fn ? fn(resolved) : '';
}
