// Motion-prompt presets for avatar animations. Each baked still is the WAN 2.2
// image-to-video start frame; these describe the *motion* layered on top, keyed by
// category. Templates interpolate the creature's archetype so a fox's victory reads
// differently from a dragon's, and echo the still framing ("dark background,
// centered") so the clip stays on-model with its portrait.
//
// The lab seeds an editable textarea from these; per-key edits persist as overrides
// (avatars/lab-overrides.json, written via POST /lab/overrides) and win over the
// default next session. Server-side categories live in server.py:VIDEO_CATEGORIES.

export const VIDEO_CATEGORIES = ['victory', 'defeat'];

export const CATEGORY_LABEL = { victory: '🏆 Victory', defeat: '💀 Defeat' };

export const DEFAULT_MOTION = {
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
};

// Default motion prompt for a resolved model + category, or '' for an unknown one.
export function motionPrompt(resolved, category) {
    const fn = DEFAULT_MOTION[category];
    return fn ? fn(resolved) : '';
}
