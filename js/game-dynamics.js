// Game Dynamics — player-tunable balance overrides.
//
// The shipped numbers in config.js are the BASELINE and remain the single
// source of truth. Players tune *multipliers* on top of that baseline; we never
// mutate CONFIG incrementally. Every apply recomputes the tunable CONFIG
// subtrees from a frozen baseline snapshot × the current settings, so:
//   • reset == settings cleared == CONFIG identical to ship values, and
//   • re-applying is idempotent (no drift).
//
// Persisted globally under localStorage['biome.gameDynamics']; applied once at
// startup (before the first board) and again on every change. See
// Game._initSettingsPanel / the constructor's applyDynamics(loadDynamics()).

import { CONFIG } from './config.js';

const STORAGE_KEY = 'biome.gameDynamics';

// Frozen deep-clone of the tunable slice of CONFIG, captured at import — before
// anything (palettes, a match, this module) can mutate CONFIG. config.js does
// no work at load, so this is the pristine ship baseline.
export const BASELINE = structuredClone({
    SPECIES: CONFIG.SPECIES,
    TERRAIN: CONFIG.TERRAIN,
    NUTRIENTS: CONFIG.NUTRIENTS,
    SIM: CONFIG.SIM,
});

// ── Schema ───────────────────────────────────────────────────────────────
// Each slider is a multiplier on baseline (default 1.0) unless kind==='int'
// (an absolute integer, e.g. the plant cap). `targets` names the baseline
// fields the multiplier scales; apply() walks them. This list is the single
// source of truth — the panel renders from it and applyDynamics reads from it.
//
// targets entries:
//   { kind:'species', type|key, field, int? }  scale a species stat
//   { kind:'terrain', field }                  scale a CONFIG.TERRAIN field
//   { kind:'nutrients' }                       scale all starting nutrients
const MULT = { min: 0.5, max: 2.0, step: 0.05, default: 1.0 };

export const DYNAMICS_SCHEMA = [
    // ── Global multipliers ──
    {
        id: 'plantVigor', label: 'Plant Vigor', group: 'Flora',
        hint: 'How fast and hungrily flora spreads.', ...MULT,
        targets: [
            { kind: 'species', type: 'plant', field: 'spreadChance' },
            { kind: 'species', type: 'plant', field: 'nutrientConsumption' },
        ],
    },
    {
        id: 'herbivoreAppetite', label: 'Herbivore Appetite', group: 'Fauna',
        hint: 'How much herbivores strip per bite.', ...MULT,
        targets: [{ kind: 'species', type: 'herbivore', field: 'eatAmount' }],
    },
    {
        id: 'predatorPressure', label: 'Predator Pressure', group: 'Fauna',
        hint: 'Predator kill chance per hunt.', ...MULT,
        targets: [{ kind: 'species', type: 'predator', field: 'huntSuccessBase' }],
    },
    {
        id: 'reproductionRate', label: 'Reproduction Rate', group: 'Fauna',
        hint: 'Breeding frequency across all animals.', ...MULT,
        targets: [
            { kind: 'species', type: 'herbivore', field: 'reproduceChance' },
            { kind: 'species', type: 'predator', field: 'reproduceChance' },
        ],
    },
    {
        id: 'metabolism', label: 'Metabolism', group: 'Fauna',
        hint: 'Per-step upkeep — higher is harsher.', ...MULT,
        targets: [
            { kind: 'species', type: 'herbivore', field: 'energyCost' },
            { kind: 'species', type: 'predator', field: 'energyCost' },
        ],
    },

    // ── Ecosystem knobs ──
    {
        id: 'soilRichness', label: 'Soil Richness', group: 'Soil',
        hint: 'Energy the land yields to plants.', ...MULT,
        targets: [
            { kind: 'terrain', field: 'NUTRIENT_ENERGY_MULT' },
            { kind: 'nutrients' },
        ],
    },
    {
        id: 'regeneration', label: 'Regeneration', group: 'Soil',
        hint: 'How fast depleted soil recovers.', ...MULT,
        targets: [{ kind: 'terrain', field: 'NUTRIENT_REGEN' }],
    },
    {
        id: 'plantCap', label: 'Plant Cap', group: 'Soil',
        hint: 'Max plants per cell.', kind: 'int',
        min: 1, max: 3, step: 1, default: BASELINE.SIM.PLANT_CAP, unit: ' / cell',
    },

    // ── Per-species (advanced) ──
    ...perSpecies('GRASS', [['spreadChance', 'Grass Spread'], ['maxEnergy', 'Grass Max Energy']]),
    ...perSpecies('SHRUB', [['spreadChance', 'Shrub Spread'], ['maxEnergy', 'Shrub Max Energy']]),
    ...perSpecies('TREE', [['spreadChance', 'Tree Spread'], ['maxEnergy', 'Tree Max Energy']]),
    ...perSpecies('GRAZER', [['eatAmount', 'Grazer Bite'], ['speed', 'Grazer Speed', true], ['reproduceChance', 'Grazer Breeding']]),
    ...perSpecies('BROWSER', [['eatAmount', 'Browser Bite'], ['speed', 'Browser Speed', true], ['reproduceChance', 'Browser Breeding']]),
    ...perSpecies('PREDATOR', [['huntSuccessBase', 'Predator Hunt'], ['speed', 'Predator Speed', true], ['reproduceChance', 'Predator Breeding']]),
];

function perSpecies(key, fields) {
    return fields.map(([field, label, int]) => ({
        id: `sp.${key}.${field}`, label, group: 'Per-Species', ...MULT,
        targets: [{ kind: 'species', key, field, int: !!int }],
    }));
}

// ── Presets ────────────────────────────────────────────────────────────────
// Each preset is a sparse values map; omitted sliders use their default.
// 'Balanced' == {} == the ship baseline, which is itself tuned to a biome that
// evolves gracefully (no boom-bust collapse) over a normal game. Each variant
// below is validated with dev-logs/sim-harness.mjs to still hold its chain —
// they shift the FEEL of a stable world, they don't break it.
export const PRESETS = {
    'Balanced': {},
    // Generous world: vigorous flora, rich soil, relaxed predators. Big, lively,
    // forgiving — populations swell and the chain is easy to keep whole.
    'Lush': { plantVigor: 1.4, soilRichness: 1.3, regeneration: 1.3, predatorPressure: 0.8 },
    // Lean world: hungry metabolism, poor soil, slow regrowth. Scarce and
    // unforgiving — every tier runs thin, but life still hangs on.
    'Harsh': { metabolism: 1.15, regeneration: 0.85, soilRichness: 0.9, plantVigor: 0.92 },
    // Apex-driven world: fierce, fast-breeding hunters over a churning prey base
    // (richer soil + faster breeding keep the herd feeding the predators).
    "Predator's Reign": { predatorPressure: 1.4, reproductionRate: 1.3, soilRichness: 1.2 },
};

export const DEFAULT_SETTINGS = {};

// ── Apply ────────────────────────────────────────────────────────────────
export function sliderDefault(slider) { return slider.default; }

export function settingValue(settings, slider) {
    const v = settings?.[slider.id];
    return (typeof v === 'number' && isFinite(v)) ? v : slider.default;
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function applyTargetMult(work, t, m) {
    if (t.kind === 'species') {
        for (const key of Object.keys(work.SPECIES)) {
            const sp = work.SPECIES[key];
            if (t.key && t.key !== key) continue;
            if (t.type && sp.type !== t.type) continue;
            if (typeof sp[t.field] !== 'number') continue;
            let val = sp[t.field] * m;
            if (t.int) val = Math.max(1, Math.round(val));
            sp[t.field] = val;
        }
    } else if (t.kind === 'terrain') {
        if (typeof work.TERRAIN[t.field] === 'number') work.TERRAIN[t.field] *= m;
    } else if (t.kind === 'nutrients') {
        for (const k of Object.keys(work.NUTRIENTS)) work.NUTRIENTS[k] *= m;
    }
}

// Recompute the tunable CONFIG subtrees from BASELINE × settings, then publish
// them onto the live CONFIG object. Modules read CONFIG.X live, so replacing the
// subtree references takes effect everywhere on the next read. Idempotent.
export function applyDynamics(settings = {}) {
    const work = structuredClone(BASELINE);

    for (const slider of DYNAMICS_SCHEMA) {
        if (slider.kind === 'int') continue;          // handled below
        const v = settingValue(settings, slider);
        const m = clamp(v, slider.min, slider.max);
        if (m === 1) continue;
        for (const t of slider.targets) applyTargetMult(work, t, m);
    }

    // Plant cap — absolute integer, not a multiplier.
    const capSlider = DYNAMICS_SCHEMA.find(s => s.id === 'plantCap');
    work.SIM.PLANT_CAP = clamp(Math.round(settingValue(settings, capSlider)), capSlider.min, capSlider.max);

    CONFIG.SPECIES = work.SPECIES;
    CONFIG.TERRAIN = work.TERRAIN;
    CONFIG.NUTRIENTS = work.NUTRIENTS;
    CONFIG.SIM = { ...CONFIG.SIM, ...work.SIM };
    return settings;
}

// ── Persistence ──────────────────────────────────────────────────────────
export function loadDynamics() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
}

export function saveDynamics(settings) {
    try {
        // Strip defaults so storage stays sparse (and 'Balanced' persists as {}).
        const sparse = {};
        for (const slider of DYNAMICS_SCHEMA) {
            const v = settingValue(settings, slider);
            if (v !== slider.default) sparse[slider.id] = v;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(sparse));
    } catch (_) { /* localStorage unavailable */ }
}

export function resetDynamics() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    applyDynamics(DEFAULT_SETTINGS);
    return {};
}

// Name of the preset whose values match `settings` exactly, else null.
export function activePreset(settings) {
    for (const [name, preset] of Object.entries(PRESETS)) {
        const match = DYNAMICS_SCHEMA.every(s =>
            settingValue(settings, s) === settingValue(preset, s));
        if (match) return name;
    }
    return null;
}
