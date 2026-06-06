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
        return `the ${a} erupts in triumphant joy — rearing up tall, head thrown back in exultation, `
            + `chest swelling with pride, every part of it blazing brighter as glowing circuitry and `
            + `bioluminescent accents flare in radiant waves, sparks of energy bursting around it; `
            + `pure exhilaration, hard-won and electric, alive with celebration; bold rising motion, `
            + `dramatic and uplifting, cinematic and emotionally charged`;
    },
    defeat: (resolved) => {
        const a = resolved.family.archetype;
        return `the ${a} is overcome with grief — head bowing low, body sinking and trembling, `
            + `shoulders caving under the unbearable weight of loss; its glow drains to cold, faint `
            + `embers, the light leaving its eyes and guttering out; heartbroken and defeated, every `
            + `line of the body aching with deep sadness and bitter regret, utterly crushed; slow, `
            + `heavy, sinking motion, intimate and tender, cinematic — aching to break your heart`;
    },
    champion: (resolved) => {
        const a = resolved.family.archetype;
        return `the ${a} ascends in crowned glory — rising regal and proud, head held high in awe, a `
            + `radiant golden aura blooming and swelling around it, light and bioluminescent circuitry `
            + `pulsing in majestic waves; reverence and overwhelming triumph, the summit reached at `
            + `last; slow soaring motion, grand and cinematic, a swelling triumphant crescendo`;
    },
};

// Default motion prompt for a resolved model + category, or '' for an unknown one.
export function motionPrompt(resolved, category) {
    const fn = DEFAULT_MOTION[category];
    return fn ? fn(resolved) : '';
}
