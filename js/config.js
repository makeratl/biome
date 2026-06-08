// Biome — All tunable constants

export const CONFIG = {
    // Grid — these are the Medium defaults / fallback. Per-match world settings
    // (size, hex zoom, rounds) are chosen in the UI and passed through to the
    // grid; see MAPS / HEX_ZOOM / GAME.ROUND_OPTIONS below.
    HEX_SIZE: 11,
    GRID_COLS: 72,
    GRID_ROWS: 38,

    // Selectable grid-size presets (cols × rows). Hex size is independent.
    MAPS: {
        small:  { cols: 48, rows: 26, label: 'Small' },
        medium: { cols: 72, rows: 38, label: 'Medium' },
        large:  { cols: 100, rows: 52, label: 'Large' },
    },
    // Hex-zoom slider range (px radius). Default mirrors HEX_SIZE.
    HEX_ZOOM: { min: 9, max: 22, default: 11 },
    // Auto/"Fit screen" bounds: rows (battlefield height) stays fixed; hex size
    // fills the viewport height; columns fill the width, clamped here. See
    // Game._resolveWorld / _containHex. AUTO_MAX_HEX lets presets grow past the
    // slider's 22px cap to fill large screens crisply.
    FIT: { rows: 38, minCols: 44, maxCols: 150 },
    AUTO_MAX_HEX: 40,

    // Terrain generation
    TERRAIN: {
        ELEVATION_SCALE: 0.045,
        MOISTURE_SCALE: 0.055,
        WATER_THRESHOLD: 0.32,
        FERTILE_MOISTURE: 0.52,
        ROCK_ELEVATION: 0.72,
        ROCK_MOISTURE: 0.28,
        NUTRIENT_REGEN: 0.02,
        MAX_NUTRIENTS: 1.0,
        NUTRIENT_ENERGY_MULT: 45,
        // Decomposition — corpses return nutrients to their cell's soil, so a
        // die-off leaves fertile ground that regrows fast (a recovery refugium).
        // DECOMPOSE: fraction of a corpse's leftover energy recycled. DETRITUS:
        // fraction of its body mass (maxEnergy) recycled even when starved-empty.
        // Compost can pile soil above its terrain cap up to COMPOST_CAP; regen
        // never claws that surplus back, it just tops up toward the terrain cap.
        DECOMPOSE: 0.5,
        DETRITUS: 0.12,
        COMPOST_CAP: 1.6,
    },

    // Terrain nutrient starting values
    NUTRIENTS: {
        WATER: 0,
        FERTILE: 1.0,
        GRASSLAND: 0.65,
        ROCKY: 0.2,
    },

    // Terrain colors (darkened so organisms pop)
    COLORS: {
        WATER: { h: 215, s: 45, l: 28 },
        FERTILE: { h: 130, s: 30, l: 22 },
        GRASSLAND: { h: 80, s: 25, l: 28 },
        ROCKY: { h: 35, s: 10, l: 35 },
        GRID_LINE: 'rgba(0,0,0,0.12)',
    },

    // Player colors (brighter, shifted away from terrain hues)
    PLAYER_1: {
        PRIMARY: { h: 190, s: 80, l: 58 },   // bright cyan — away from green terrain
        SECONDARY: { h: 170, s: 65, l: 50 },  // teal accent
        NAME: 'Player 1',
    },
    PLAYER_2: {
        PRIMARY: { h: 25, s: 85, l: 60 },     // bright orange — away from tan/rocky
        SECONDARY: { h: 10, s: 70, l: 52 },   // warm coral accent
        NAME: 'Player 2',
    },

    // Species defaults
    SPECIES: {
        GRASS: {
            name: 'Sedgeweave',
            role: 'Grass',
            blurb: 'Fast-spreading groundcover — the foundation every food chain grows from.',
            type: 'plant',
            energy: 20,
            maxEnergy: 40,
            energyCost: 0.8,
            nutrientConsumption: 0.04,
            spreadChance: 0.05,
            spreadEnergyCost: 8,
            apCost: 1,
        },
        SHRUB: {
            name: 'Thornbloom',
            role: 'Shrub',
            blurb: 'Hardy bushes that spread slowly but bank far more energy than grass.',
            type: 'plant',
            energy: 30,
            maxEnergy: 70,
            energyCost: 1.0,
            nutrientConsumption: 0.035,
            spreadChance: 0.03,
            spreadEnergyCost: 16,
            apCost: 1,
        },
        TREE: {
            name: 'Spirewood',
            role: 'Tree',
            blurb: 'Towering and slow. Stores the most energy and shrugs off grazers.',
            type: 'plant',
            energy: 50,
            maxEnergy: 120,
            energyCost: 1.2,
            nutrientConsumption: 0.03,
            spreadChance: 0.015,
            spreadEnergyCost: 30,
            apCost: 2,
        },
        GRAZER: {
            name: 'Hopgrazer',
            role: 'Grazer',
            blurb: 'Nimble grazer that eats grass and shrubs — and prefers the enemy’s.',
            type: 'herbivore',
            energy: 40,
            maxEnergy: 100,
            energyCost: 2,
            speed: 2,
            eatAmount: 12,
            reproduceThreshold: 65,
            reproduceCost: 30,
            reproduceChance: 0.13,
            preferEnemy: 0.7,
            diet: ['GRASS', 'SHRUB'],
            apCost: 2,
        },
        BROWSER: {
            name: 'Bramblemaw',
            role: 'Browser',
            blurb: 'Heavy browser that strips shrubs and trees bare, bite by bite.',
            type: 'herbivore',
            energy: 55,
            maxEnergy: 100,
            energyCost: 2.5,
            speed: 1,
            eatAmount: 20,
            reproduceThreshold: 75,
            reproduceCost: 40,
            reproduceChance: 0.12,
            preferEnemy: 0.65,
            diet: ['SHRUB', 'TREE'],
            apCost: 2,
        },
        PREDATOR: {
            name: 'Shadestalker',
            role: 'Predator',
            blurb: 'Swift hunter that culls herbivores to crown the food chain.',
            type: 'predator',
            energy: 65,
            maxEnergy: 120,
            energyCost: 2.5,
            speed: 3,
            huntSuccessBase: 0.30,
            huntHunger: 0.6,        // only hunts below 60% full — sated predators don't over-cull
            eatAmount: 40,
            reproduceThreshold: 75,
            reproduceCost: 50,
            reproduceChance: 0.05,
            apCost: 2,
        },
    },

    // Simulation
    SIM: {
        STEPS_PER_TURN: 20,
        ANIMATION_STEP_MS: 100,
        PLANT_CAP: 2,            // max plants per cell (a correctness invariant)
    },

    // Scoring — incentivize biodiversity over grass monoculture
    SCORING: {
        SPECIES_DIVERSITY_BONUS: 0.10,   // +10% per unique species alive
        TROPHIC_BONUS: 0.25,             // +25% if all 3 trophic levels present
        HERBIVORE_WEIGHT: 2,             // herbivore energy counts 2×
        PREDATOR_WEIGHT: 3,              // predator energy counts 3×
    },

    // Game
    GAME: {
        TOTAL_ROUNDS: 10,
        LIGHTNING_ROUNDS: 10,
        AP_PER_TURN: 4,
        ROUND_OPTIONS: [5, 10, 15, 20],   // selectable round counts (default = TOTAL_ROUNDS)
        // Ollama context window cap. We size num_ctx to the prompt so a large
        // map representation (e.g. the `raw` orientation) isn't SILENTLY
        // front-truncated against Ollama's ~2048 default — but cap it here to
        // bound KV-cache VRAM. mediated/ascii prompts sit well under this.
        // (Used by the Vision Lab; live matches use MODEL_BUDGETS below.)
        NUM_CTX_MAX: 8192,
        // Per-tier Ollama token budgets, keyed by model-identity.js size tier.
        // Larger models earn the headroom for the raw board view + free-placement
        // reasoning; small models stay lean so a 3B isn't asked to fill a context
        // it can't use well. numCtx is the CAP — actual ctx is still sized to the
        // prompt (min 2048). numPredict budgets thinking overhead + JSON output.
        MODEL_BUDGETS: {
            small: { numCtx: 8192,  numPredict: 600 },
            mid:   { numCtx: 8192,  numPredict: 600 },
            large: { numCtx: 16384, numPredict: 800 },
            cloud: { numCtx: 32768, numPredict: 1000 },
        },
    },
};
