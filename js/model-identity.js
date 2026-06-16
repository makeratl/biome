// Model identity — the single source of truth for "given an Ollama model name,
// what is its visual identity in Biome." Pure data + resolver: no DOM, no canvas.
//
// Models arrive as free-form strings (`qwen2.5:14b`, `deepseek-v3.2:cloud`,
// `glm-5.1:cloud`, …) pulled live from whatever Ollama has installed, and new
// ones appear constantly. So we never enumerate models — we recognise the
// *family* from the name, give each family a biome-creature identity, and
// resolve any model (even one that doesn't exist yet) deterministically.
//
// The "collection" axis is size: one family = one creature, and the size tier
// (small → mid → large → cloud) renders the *same* creature progressively more
// elaborate. avatarKey = `${family.id}-${tier}` is the deterministic handle an
// avatar image (or procedural fallback) is keyed on.

// Ordered taxonomy — first `match` wins, so specific patterns must precede
// generic ones. `palette.hue` drives the family colour identity; null hue means
// "derive from a name hash" (the generic fallback). `archetype` + `promptMotif`
// describe the biome creature for image generation.
export const MODEL_FAMILIES = [
    {
        id: 'qwen', label: 'Qwen', vendor: 'Alibaba', match: /qwen|qwq/i,
        palette: { hue: 38, sat: 80, light: 55, accentHue: 22 },
        archetype: 'fox',
        promptMotif: 'a sleek, alert fox with overlapping amber-and-gold scaled plates, sharp inquisitive eyes',
    },
    {
        id: 'llama', label: 'Llama', vendor: 'Meta', match: /llama/i,
        palette: { hue: 215, sat: 70, light: 56, accentHue: 200 },
        archetype: 'stag',
        promptMotif: 'a noble antlered stag, deep cobalt-blue hide, broad branching antlers like a crown',
    },
    {
        id: 'claude', label: 'Claude', vendor: 'Anthropic',
        match: /claude|anthropic|sonnet|haiku|opus|fable/i,
        palette: { hue: 26, sat: 58, light: 54, accentHue: 14 },
        archetype: 'bear',
        promptMotif: 'a steady, thoughtful bear with warm terracotta-and-amber fur, deliberate and watchful, quietly powerful',
    },
    {
        id: 'gemma', label: 'Gemma', vendor: 'Google', match: /gemma/i,
        palette: { hue: 185, sat: 72, light: 52, accentHue: 165 },
        archetype: 'dragonfly',
        promptMotif: 'an iridescent dragonfly with faceted gemstone wings, teal and cyan, jewel-bright body',
    },
    {
        id: 'mistral', label: 'Mistral', vendor: 'Mistral AI', match: /mistral|mixtral|codestral|ministral|magistral|devstral|mathstral/i,
        palette: { hue: 16, sat: 85, light: 56, accentHue: 35 },
        archetype: 'falcon',
        promptMotif: 'a swift falcon mid-stoop, ember-orange and ash-grey feathers swept by wind, fierce focus',
    },
    {
        id: 'phi', label: 'Phi', vendor: 'Microsoft', match: /(^|[^a-z])phi/i,
        palette: { hue: 150, sat: 60, light: 50, accentHue: 130 },
        archetype: 'mantis',
        promptMotif: 'a poised praying mantis, emerald-green carapace with precise geometric segmentation',
    },
    {
        id: 'deepseek', label: 'DeepSeek', vendor: 'DeepSeek', match: /deepseek/i,
        palette: { hue: 245, sat: 65, light: 52, accentHue: 270 },
        archetype: 'anglerfish',
        promptMotif: 'a deep-abyss anglerfish, indigo-black scales, a glowing bioluminescent lure, ancient eyes',
    },
    {
        id: 'glm', label: 'GLM', vendor: 'Zhipu AI', match: /glm|chatglm/i,
        palette: { hue: 278, sat: 58, light: 58, accentHue: 300 },
        archetype: 'heron',
        promptMotif: 'an elegant long-necked heron, violet and amethyst plumage, still and watchful, poised to strike',
    },
    {
        id: 'kimi', label: 'Kimi', vendor: 'Moonshot AI', match: /kimi|moonshot/i,
        palette: { hue: 222, sat: 45, light: 64, accentHue: 210 },
        archetype: 'luna moth',
        promptMotif: 'a luminous luna moth, moonlit pale-blue wings with long trailing tails, soft glowing patterns',
    },
    {
        id: 'minimax', label: 'MiniMax', vendor: 'MiniMax', match: /minimax/i,
        palette: { hue: 328, sat: 70, light: 56, accentHue: 350 },
        archetype: 'scarab',
        promptMotif: 'an armoured scarab beetle, magenta-and-rose iridescent shell, compact and powerful, gleaming',
    },
    {
        id: 'nemotron', label: 'Nemotron', vendor: 'NVIDIA', match: /nemotron|nvidia/i,
        palette: { hue: 96, sat: 75, light: 50, accentHue: 80 },
        archetype: 'chameleon',
        promptMotif: 'a chameleon with vivid NVIDIA-green scales, curled tail, independent swivelling eyes, patient',
    },
    {
        id: 'gpt', label: 'GPT-OSS', vendor: 'OpenAI', match: /gpt|openai|^o[0-9]/i,
        palette: { hue: 205, sat: 18, light: 70, accentHue: 190 },
        archetype: 'owl',
        promptMotif: 'a wise owl, slate-grey and silver feathers, large knowing eyes, geometric feather patterning',
    },
    {
        id: 'gemini', label: 'Gemini', vendor: 'Google', match: /gemini/i,
        palette: { hue: 290, sat: 62, light: 58, accentHue: 250 },
        archetype: 'peacock',
        promptMotif: 'a resplendent peacock, iridescent violet-and-sapphire tail fanned wide, radiant frontier display',
    },
    {
        id: 'lfm2', label: 'LFM', vendor: 'Liquid AI', match: /lfm|liquid/i,
        palette: { hue: 175, sat: 70, light: 52, accentHue: 195 },
        archetype: 'octopus',
        promptMotif: 'a fluid, adaptive octopus, shifting iridescent cyan-and-teal skin, curling intelligent tentacles',
    },
    {
        id: 'cohere', label: 'Command', vendor: 'Cohere', match: /command|cohere|c4ai|aya/i,
        palette: { hue: 352, sat: 72, light: 55, accentHue: 14 },
        archetype: 'wolf',
        promptMotif: 'a steady, commanding wolf, crimson-and-charcoal coat, alert pack-leader poise, intelligent eyes',
    },
    {
        id: 'granite', label: 'Granite', vendor: 'IBM', match: /granite/i,
        palette: { hue: 220, sat: 16, light: 56, accentHue: 205 },
        archetype: 'rhino',
        promptMotif: 'an armoured rhinoceros, granite-grey stone-plated hide, immense and enduring, cool blue glow',
    },
    {
        // Falcon family gets a NON-bird creature — Mistral already owns the falcon.
        id: 'falcon', label: 'Falcon', vendor: 'TII', match: /falcon/i,
        palette: { hue: 45, sat: 62, light: 50, accentHue: 180 },
        archetype: 'scorpion',
        promptMotif: 'a desert scorpion, sand-gold carapace, raised segmented tail with a glowing cyan venom stinger',
    },
    {
        id: 'yi', label: 'Yi', vendor: '01.AI', match: /^yi([:\-]|$)/i,
        palette: { hue: 28, sat: 85, light: 54, accentHue: 38 },
        archetype: 'tiger',
        promptMotif: 'a powerful tiger, burning orange coat with black stripes, muscular and commanding, fierce gaze',
    },
    {
        id: 'exaone', label: 'EXAONE', vendor: 'LG AI', match: /exaone/i,
        palette: { hue: 315, sat: 60, light: 56, accentHue: 332 },
        archetype: 'lynx',
        promptMotif: 'a sleek lynx, magenta-tinged silver fur, tufted ears alert, poised and precise, glowing eyes',
    },
    {
        id: 'olmo', label: 'OLMo', vendor: 'Ai2', match: /olmo|tulu/i,
        palette: { hue: 165, sat: 50, light: 50, accentHue: 185 },
        archetype: 'otter',
        promptMotif: 'a playful river otter, teal-green sleek wet fur, open and curious, holding a glowing pebble',
    },
    {
        id: 'internlm', label: 'InternLM', vendor: 'Shanghai AI Lab', match: /internlm|intern-/i,
        palette: { hue: 210, sat: 12, light: 60, accentHue: 0 },
        archetype: 'panda',
        promptMotif: 'a calm giant panda, monochrome black-and-white fur with subtle circuit etching, serene and grounded',
    },
    {
        id: 'starcoder', label: 'StarCoder', vendor: 'BigCode', match: /starcoder|bigcode/i,
        palette: { hue: 25, sat: 55, light: 45, accentHue: 48 },
        archetype: 'beaver',
        promptMotif: 'an industrious beaver, warm amber-brown fur, builder of intricate structures, focused craftsman',
    },
    {
        id: 'smollm', label: 'SmolLM', vendor: 'Hugging Face', match: /smollm|smol/i,
        palette: { hue: 50, sat: 70, light: 60, accentHue: 38 },
        archetype: 'mouse',
        promptMotif: 'a tiny, clever harvest mouse, golden-yellow fur, oversized bright eyes, nimble and quick',
    },
    {
        id: 'baichuan', label: 'Baichuan', vendor: 'Baichuan', match: /baichuan/i,
        palette: { hue: 5, sat: 70, light: 56, accentHue: 25 },
        archetype: 'koi',
        promptMotif: 'an elegant koi carp, vivid red-and-white scales, flowing fins, serene motion through water',
    },
    {
        id: 'stablelm', label: 'StableLM', vendor: 'Stability AI', match: /stablelm|stable-?code|stability/i,
        palette: { hue: 200, sat: 55, light: 55, accentHue: 215 },
        archetype: 'horse',
        promptMotif: 'a strong, steady stallion, cool steel-blue coat, balanced and grounded, flowing mane, calm power',
    },
    // Generic fallback — always matches last. No fixed hue: derived from a name
    // hash so unknown families still get distinct, stable colours.
    {
        id: 'generic', label: 'Unknown', vendor: '—', match: /.*/,
        palette: { hue: null, sat: 30, light: 58, accentHue: null },
        archetype: 'tortoise',
        promptMotif: 'a stoic hex-shelled tortoise, interlocking hexagonal plates, calm and enduring',
    },
];

// Size tiers — the "collection variant" axis. `elaboration` feeds the image
// prompt so the same creature scales from a lean youngster to a vast elder.
export const SIZE_TIERS = {
    small: { id: 'small', label: 'Small', elaboration: 'a young, lean form — simple, minimal ornamentation, agile' },
    mid: { id: 'mid', label: 'Mid', elaboration: 'a mature adult — balanced detail, confident bearing' },
    large: { id: 'large', label: 'Large', elaboration: 'an elder, powerful form — ornate plating, battle-worn, commanding presence' },
    cloud: { id: 'cloud', label: 'Cloud', elaboration: 'an ethereal celestial form — semi-translucent, crowned, radiating vast glowing energy' },
};

export const TIER_ORDER = ['small', 'mid', 'large', 'cloud'];

// Strip namespace + tag down to the bare base name (mirrors tournament.js _short).
function baseName(name) {
    return (name || '')
        .split('/').pop()
        .replace(/:.*$/, '')
        .replace(/^biome-/, '');   // distilled models: read identity off family+size, not the prefix
}

// Parse a model name into a size tier. Cloud always wins (a hosted giant), then
// explicit parameter counts (`14b`), then word sizes (`medium`), else mid.
// Bedrock models carry the `bedrock:` routing prefix — remote/hosted, no local
// footprint, so they behave like cloud models (no warming, cloud token budget).
export function isBedrockModel(name) {
    return /^bedrock:/i.test(name || '');
}

export function parseTier(name) {
    const lower = (name || '').toLowerCase();
    if (isBedrockModel(name) || /cloud/.test(lower)) return 'cloud';

    const tag = lower.includes(':') ? lower.split(':').slice(1).join(':') : '';
    const search = tag || lower;

    const billions = search.match(/(\d+(?:\.\d+)?)\s*b\b/);
    if (billions) {
        const n = parseFloat(billions[1]);
        if (n < 5) return 'small';
        if (n < 14) return 'mid';
        return 'large';
    }
    if (/\b(mini|small|tiny|nano)\b/.test(search)) return 'small';
    if (/\b(medium|base)\b/.test(search)) return 'mid';
    if (/\b(large|xl|huge|max)\b/.test(search)) return 'large';
    return 'mid';
}

// Short raw parameter label for a stat card — "14B" / "3.5B" / "Cloud", else the
// tier label as a fallback (e.g. "Mid") when the name carries no explicit count.
export function paramLabel(name) {
    const lower = (name || '').toLowerCase();
    if (/cloud/.test(lower)) return 'Cloud';
    const tag = lower.includes(':') ? lower.split(':').slice(1).join(':') : '';
    const m = (tag || lower).match(/(\d+(?:\.\d+)?)\s*b\b/);
    if (m) return `${m[1]}B`;
    return SIZE_TIERS[parseTier(name)].label;
}

// "MIGHT" stat — a 2..5 bar level derived from parameter scale (cloud giants and
// the largest locals top out; sub-5B models sit lowest). Mirrors parseTier's parse.
export function mightLevel(name) {
    const lower = (name || '').toLowerCase();
    if (/cloud/.test(lower)) return 5;
    const tag = lower.includes(':') ? lower.split(':').slice(1).join(':') : '';
    const search = tag || lower;
    const m = search.match(/(\d+(?:\.\d+)?)\s*b\b/);
    if (m) {
        const n = parseFloat(m[1]);
        if (n < 5) return 2;
        if (n < 14) return 3;
        if (n < 33) return 4;
        return 5;
    }
    if (/\b(mini|small|tiny|nano)\b/.test(search)) return 2;
    if (/\b(large|xl|huge|max)\b/.test(search)) return 4;
    return 3;
}

// Title-case a single word (e.g. archetype "luna moth" → "Luna Moth").
export function titleCase(s) {
    return (s || '').replace(/\b\w/g, c => c.toUpperCase());
}

export function familyFor(name) {
    return MODEL_FAMILIES.find(f => f.match.test(name || '')) || MODEL_FAMILIES[MODEL_FAMILIES.length - 1];
}

// ── Per-avatar identity overrides ───────────────────────────
//
// The lab lets a creature's identity be re-authored (rename the family label,
// retheme its archetype/motif) and persists it to avatars/lab-overrides.json
// under an `identity` bucket keyed by avatarKey (`family-tier`). Both the lab and
// the game load that file at startup and feed the map in here, so a renamed
// creature shows everywhere resolveModel() is consumed (HUD subtitle, leaderboard,
// win screens) — not just in the lab. The store is keyed by avatarKey, matching
// how the baked PNG, clips, and prompt overrides are keyed: one creature, shared
// by every model that resolves to it.
let _identityOverrides = {};   // { <avatarKey>: { label?, archetype?, motif? } }

export function applyIdentityOverrides(map) {
    _identityOverrides = map && typeof map === 'object' ? map : {};
}
export function identityOverrideFor(avatarKey) {
    return _identityOverrides[avatarKey] || null;
}

// 2-letter badge initials (ported from game.js _modelInitials so all callers
// share one rule).
export function modelInitials(model) {
    if (!model) return 'AI';
    const clean = baseName(model).replace(/[^a-z0-9]/gi, '');
    if (!clean) return 'AI';
    if (/^\d/.test(clean)) return clean.slice(0, 2).toUpperCase();
    const m = clean.match(/^([a-z]+)/i);
    if (m && m[1].length >= 2) return m[1].slice(0, 2).toUpperCase();
    return clean.slice(0, 2).toUpperCase();
}

// Human-readable name (ported from game.js _prettyModelName).
export function prettyModelName(model) {
    if (!model) return 'Human';
    model = model.replace(/^biome-/, '');   // "Qwen2.5 7b C1", not "Biome Qwen2.5 7b C1"
    const [base, tag] = model.split(':');
    const niceBase = base.split(/[-_]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    if (!tag) return niceBase;
    const niceTag = tag.replace('-cloud', '').toUpperCase();
    const cloudTag = tag.includes('cloud') ? ' · Cloud' : '';
    return `${niceBase} ${niceTag}${cloudTag}`.replace(/\s+/g, ' ').trim();
}

// Stable hash → hue, for the generic family (matches tournament.js _modelHue).
function hashHue(s) {
    let h = 0;
    for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
}

// The one resolver. Returns a complete identity descriptor for any model name.
export function resolveModel(name) {
    const baseFamily = familyFor(name);
    const tier = parseTier(name);
    const short = baseName(name);
    const avatarKey = `${baseFamily.id}-${tier}`;
    // A lab-authored identity override reskins the creature (label / archetype /
    // motif) for this avatarKey. We clone the family so the shared MODEL_FAMILIES
    // entry is never mutated; hue/palette/match stay intact.
    const ov = _identityOverrides[avatarKey];
    const family = ov
        ? {
            ...baseFamily,
            label: ov.label || baseFamily.label,
            archetype: ov.archetype || baseFamily.archetype,
            promptMotif: ov.motif || baseFamily.promptMotif,
        }
        : baseFamily;
    const hue = family.palette.hue != null ? family.palette.hue : hashHue(short);
    const palette = { ...family.palette, hue, accentHue: family.palette.accentHue != null ? family.palette.accentHue : hue };
    return {
        raw: name,
        family,
        vendor: family.vendor,
        displayName: prettyModelName(name),
        sizeTier: tier,
        tier: SIZE_TIERS[tier],
        hue,
        initials: modelInitials(name),
        palette,
        avatarKey,
    };
}

// ── Board palettes: organism color = model identity ─────────
//
// The game board historically painted Player 1 cyan and Player 2 orange. But the
// HUD, avatars, and leaderboard all color by the model's identity hue — so the
// board was the one place that didn't match. resolvePlayerPalettes() maps each
// player's model to its identity hue for the organisms, with two guards:
//
//   1. Terrain legibility — model hues that land in the grassland/fertile green
//      band would camouflage into the board, so we nudge them clear of it.
//   2. Collision — same-family models (two Qwens, etc.) resolve to the SAME hue.
//      When the two players are too close, the higher-ranked model keeps its true
//      hue (the anchor) and the other is rotated away until they're distinct.
//
// Human players have no identity hue, so they fall back to the classic cyan/orange
// and act as the movable side if a model happens to collide with them.

const TERRAIN_HUES = [80, 130];   // grassland + fertile — see CONFIG.COLORS
const TERRAIN_GUARD = 18;         // keep organism hues this far from terrain
const MIN_SEPARATION = 75;        // floor between the two players' hues (so same-family / cool-vs-cool pairs stay distinct after per-species shifts)
const ORG_SAT = 80, ORG_LIGHT = 58;

const norm360 = (h) => ((h % 360) + 360) % 360;
function hueDist(a, b) {
    const d = Math.abs(norm360(a) - norm360(b)) % 360;
    return d > 180 ? 360 - d : d;
}

// Push a hue out of the terrain keep-out band(s), to the nearer legal edge.
function legalizeHue(h, terrainHues = TERRAIN_HUES, guard = TERRAIN_GUARD) {
    h = norm360(h);
    for (let iter = 0; iter < 4; iter++) {
        let moved = false;
        for (const t of terrainHues) {
            let diff = norm360(h) - norm360(t);
            if (diff > 180) diff -= 360;
            if (diff < -180) diff += 360;
            if (Math.abs(diff) < guard) {
                h = norm360(t + (diff >= 0 ? guard : -guard));
                moved = true;
            }
        }
        if (!moved) break;
    }
    return h;
}

// Rotate `moveH` away from `anchorH` to at least `floor`, staying terrain-legal
// and as close to its original hue as possible.
function separateFrom(anchorH, moveH, floor, terrainHues, guard) {
    const candidates = [floor, -floor, floor * 1.4, -floor * 1.4, floor * 1.8, -floor * 1.8];
    let best = null, bestScore = -Infinity;
    for (const off of candidates) {
        const legal = legalizeHue(anchorH + off, terrainHues, guard);
        const sep = hueDist(anchorH, legal);
        const score = (sep >= floor * 0.9 ? 100 : sep) - hueDist(moveH, legal) * 0.1;
        if (score > bestScore) { bestScore = score; best = legal; }
    }
    return best;
}

// Resolve the two board palettes for a match. `p1Model`/`p2Model` are model names
// (or null for a human). Returns { 1: {h,s,l}, 2: {h,s,l} }.
export function resolvePlayerPalettes(p1Model, p2Model, opts = {}) {
    const {
        anchor = 1,                 // which player keeps its true hue on collision (both-model case)
        fallback = { 1: { h: 190, s: 80, l: 58 }, 2: { h: 25, s: 85, l: 60 } },
        terrainHues = TERRAIN_HUES,
        guard = TERRAIN_GUARD,
        minSeparation = MIN_SEPARATION,
    } = opts;

    const slot = (model, fb) => model
        ? { h: legalizeHue(resolveModel(model).hue, terrainHues, guard), s: ORG_SAT, l: ORG_LIGHT }
        : { ...fb };
    const p1 = slot(p1Model, fallback[1]);
    const p2 = slot(p2Model, fallback[2]);

    // Enforce a minimum hue gap between the two sides. Anchor the slot whose
    // color carries identity (a model), preferring the chosen one when both do;
    // a human's generic color is always the one that yields.
    if (hueDist(p1.h, p2.h) < minSeparation) {
        let anchorSlot;
        if (p1Model && p2Model) anchorSlot = anchor === 2 ? 2 : 1;
        else if (p1Model) anchorSlot = 1;
        else if (p2Model) anchorSlot = 2;
        else anchorSlot = 1;
        const keep = anchorSlot === 2 ? p2 : p1;
        const move = anchorSlot === 2 ? p1 : p2;
        move.h = separateFrom(keep.h, move.h, minSeparation, terrainHues, guard);
    }
    return { 1: p1, 2: p2 };
}

// Build the image-generation prompt for a resolved model + chosen visual style.
// The cyber-organic blend is the headline style; the pure styles are for the lab
// to compare against. STYLE_PRESETS describes the suffix + the Comfy LoRA to use.
export const STYLE_PRESETS = {
    'cyber-organic': {
        label: 'Cyber-organic',
        lora: 'qwen/CreatureFeature01_CE_QWEN_AIT3k.safetensors',
        // Style control is the cyber-organic *material* identity only. We deliberately
        // do NOT force composition (no "centered emblem / game avatar icon / rim
        // lighting" — those make the LoRA wrap the subject in a glowing ring/halo).
        // Framing, background, and lighting stay free for the motif to drive.
        suffix: 'bio-mechanical hybrid creature, organic forms fused with glowing circuitry and metallic filigree, '
            + 'bioluminescent accents, sleek living machine, highly detailed',
    },
    'creature-feature': {
        label: 'Creature-feature',
        lora: 'qwen/CreatureFeature01_CE_QWEN_AIT3k.safetensors',
        suffix: 'painterly fantasy creature illustration, rich textures, naturalistic, dark background, '
            + 'centered emblem, game avatar icon, highly detailed, dramatic lighting',
    },
    'cyber-machine': {
        label: 'Cyber-machine',
        lora: 'qwen/qwen_CyberMachine.safetensors',
        suffix: 'sleek cybernetic mechanical creature, polished metal and neon, hard-surface design, '
            + 'dark background, centered emblem, game avatar icon, highly detailed',
    },
};

export const NEGATIVE_PROMPT = 'text, words, letters, watermark, signature, human, person, face, '
    + 'multiple subjects, frame, border, halo, glowing ring, circular frame, medallion, emblem ring, '
    + 'blurry, low quality';

export function avatarPrompt(resolved, styleId = 'cyber-organic') {
    const style = STYLE_PRESETS[styleId] || STYLE_PRESETS['cyber-organic'];
    const { family, tier, palette } = resolved;
    const hueWord = `hue ${palette.hue}° colour identity`;
    return `${family.promptMotif}; ${tier.elaboration}; ${hueWord}; ${style.suffix}`;
}
