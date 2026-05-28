// Biome — All tunable constants

export const CONFIG = {
    // Grid
    HEX_SIZE: 11,
    GRID_COLS: 72,
    GRID_ROWS: 38,

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
            type: 'plant',
            energy: 20,
            maxEnergy: 40,
            energyCost: 0.8,
            nutrientConsumption: 0.04,
            spreadChance: 0.18,
            spreadEnergyCost: 8,
            apCost: 1,
        },
        SHRUB: {
            name: 'Thornbloom',
            role: 'Shrub',
            type: 'plant',
            energy: 30,
            maxEnergy: 70,
            energyCost: 1.0,
            nutrientConsumption: 0.035,
            spreadChance: 0.08,
            spreadEnergyCost: 16,
            apCost: 1,
        },
        TREE: {
            name: 'Spirewood',
            role: 'Tree',
            type: 'plant',
            energy: 50,
            maxEnergy: 120,
            energyCost: 1.2,
            nutrientConsumption: 0.03,
            spreadChance: 0.03,
            spreadEnergyCost: 30,
            apCost: 2,
        },
        GRAZER: {
            name: 'Hopgrazer',
            role: 'Grazer',
            type: 'herbivore',
            energy: 40,
            maxEnergy: 100,
            energyCost: 2,
            speed: 2,
            eatAmount: 14,
            reproduceThreshold: 65,
            reproduceCost: 30,
            reproduceChance: 0.2,
            preferEnemy: 0.7,
            diet: ['GRASS', 'SHRUB'],
            apCost: 2,
        },
        BROWSER: {
            name: 'Bramblemaw',
            role: 'Browser',
            type: 'herbivore',
            energy: 55,
            maxEnergy: 100,
            energyCost: 2.5,
            speed: 1,
            eatAmount: 25,
            reproduceThreshold: 75,
            reproduceCost: 40,
            reproduceChance: 0.2,
            preferEnemy: 0.65,
            diet: ['SHRUB', 'TREE'],
            apCost: 2,
        },
        PREDATOR: {
            name: 'Shadestalker',
            role: 'Predator',
            type: 'predator',
            energy: 60,
            maxEnergy: 120,
            energyCost: 3.5,
            speed: 3,
            huntSuccessBase: 0.45,
            eatAmount: 40,
            reproduceThreshold: 90,
            reproduceCost: 50,
            reproduceChance: 0.15,
            apCost: 2,
        },
    },

    // Simulation
    SIM: {
        STEPS_PER_TURN: 20,
        ANIMATION_STEP_MS: 100,
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
        TOTAL_ROUNDS: 20,
        LIGHTNING_ROUNDS: 10,
        AP_PER_TURN: 4,
    },
};
