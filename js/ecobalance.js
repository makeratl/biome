// Ecosystem balance — the DERIVED sustainable trophic ratio.
//
// Replaces the old gut-guessed "9 plants : 3 herbivores : 1 predator" pyramid
// with one computed from the game's own energy economy in config.js. The idea:
// a tier is the right size when the energy it must HARVEST each step equals the
// energy the tier beneath it can SUPPLY each step. Express that per individual
// and you get a count ratio — how many prey one consumer needs to live and breed.
//
//   resourcePerConsumer = consumerDemand / (resourceSupply × foragingEff)
//
//     consumerDemand = energyCost + reproduceChance × offspringEnergy
//                      (what one consumer burns to exist + banks into offspring each step)
//     resourceSupply = reproduceChance × offspringEnergy  (croppable production/step)
//                      plants: the SUSTAINABLE energy a plant fixes per step that a
//                      herbivore can graze — regen-limited soil throughput
//                      (NUTRIENT_REGEN × NUTRIENT_ENERGY_MULT), NOT spread rate.
//                      Spread sets how fast the base GROWS, not how much it FEEDS;
//                      at steady state every occupied cell is regen-limited, so this
//                      is what actually supports the herbivore tier.
//     foragingEff    = how much of that production the consumer actually captures:
//                      predators miss hunts (huntSuccess × speed advantage);
//                      plants are stationary so herbivores capture nearly all (HERB_FORAGE_EFF).
//
// Offspring energy matches simulation.js: plant energy×0.5 (:102), herbivore
// reproduceCost×0.6 (:179), predator reproduceCost×0.5 (:263). Every rate is
// PER STEP, so STEPS_PER_TURN cancels in the ratio — it must not appear here.
//
// The ratio is population-weighted across the species actually on the board
// (a tree-heavy base needs more plants per grazer than a grass base, because
// trees produce far less per step), with a flat config tier-average as the
// fallback when a tier is empty. Pure: config + a species-count map in, ratios out.

import { CONFIG } from './config.js';

// Fraction of plant production a herbivore captures. Plants don't flee, so this
// is high; it's the one hand-tuned lever in the model — nudge it to widen or
// tighten how many plants the gauges want per herbivore.
const HERB_FORAGE_EFF = 0.9;

// Realized predation discount. A predator removes whole prey — destroying that
// animal's FUTURE production, not just its surplus — so the herd sustains far
// fewer hunters than naive production-matching implies. This factor (tuned to
// match what the live simulation actually holds, ~5 herbivores per predator)
// is the apex analog of HERB_FORAGE_EFF: the one dial for the predator tier.
const PRED_REALIZED = 0.5;

const EPS = 1e-6;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);

// ── Per-species coefficients, derived fresh from CONFIG on each call ─────────
// Recomputed (not cached) so the ideal tracks LIVE config — including runtime
// preset multipliers from game-dynamics.js, which rebuild CONFIG.SPECIES/TERRAIN.
// Six species, called once per trophic read: the cost is negligible.
function buildCoeffs() {
    const PLANT = {}, HERB = {}, PRED = {};
    // Sustainable per-plant energy throughput: a cell's regen, converted to energy.
    // Every plant at steady state is regen-limited, so this is the food it offers
    // herbivores — independent of how fast (spread) it colonises new ground.
    const plantSupply = CONFIG.TERRAIN.NUTRIENT_REGEN * CONFIG.TERRAIN.NUTRIENT_ENERGY_MULT;
    for (const [sp, s] of Object.entries(CONFIG.SPECIES)) {
        if (s.type === 'plant') {
            PLANT[sp] = { supply: plantSupply };
        } else if (s.type === 'herbivore') {
            const offspring = s.reproduceCost * 0.6;
            HERB[sp] = {
                demand: s.energyCost + s.reproduceChance * offspring,
                supply: s.reproduceChance * offspring,
                speed: s.speed || 1,
            };
        } else if (s.type === 'predator') {
            const offspring = s.reproduceCost * 0.5;
            PRED[sp] = {
                demand: s.energyCost + s.reproduceChance * offspring,
                huntBase: s.huntSuccessBase || 0.45,
                speed: s.speed || 1,
            };
        }
    }
    const tierAvg = (tier, field) => mean(Object.values(tier).map(c => c[field]));
    const AVG = {
        plantSupply: tierAvg(PLANT, 'supply'),
        herbDemand: tierAvg(HERB, 'demand'),
        herbSupply: tierAvg(HERB, 'supply'),
        herbSpeed: tierAvg(HERB, 'speed'),
        predDemand: tierAvg(PRED, 'demand'),
        predHunt: tierAvg(PRED, 'huntBase'),
        predSpeed: tierAvg(PRED, 'speed'),
    };
    return { PLANT, HERB, PRED, AVG };
}

// Predator capture efficiency given the prey it's actually chasing.
const forageEff = (huntBase, predSpeed, preySpeed) =>
    huntBase * Math.min(predSpeed / Math.max(preySpeed, EPS), 1.5);

// Count-weighted mean of a coefficient field over the species present in `tier`.
// Falls back to the flat tier average when no species of that tier are on the board.
function weighted(tier, bySpecies, field, fallback) {
    let wsum = 0, n = 0;
    for (const [sp, count] of Object.entries(bySpecies || {})) {
        const c = tier[sp];
        if (!c || !(count > 0)) continue;   // skip unknown species / absent counts
        wsum += c[field] * count;
        n += count;
    }
    return n > 0 ? wsum / n : fallback;
}

const finalRatios = (plantsPerHerb, herbsPerPred) => ({
    plantsPerHerb: clamp(plantsPerHerb, 1.5, 40),
    herbsPerPred: clamp(herbsPerPred, 1, 20),
});

// Config-default ratios (no species mix) — flat tier averages, computed live.
export function defaultRatios() {
    const { AVG } = buildCoeffs();
    const predForage = forageEff(AVG.predHunt, AVG.predSpeed, AVG.herbSpeed);
    return finalRatios(
        AVG.herbDemand / Math.max(AVG.plantSupply * HERB_FORAGE_EFF, EPS),
        AVG.predDemand / Math.max(AVG.herbSupply * predForage * PRED_REALIZED, EPS),
    );
}

// The sustainable pyramid for the species currently on the board.
// `bySpecies` = { GRASS: n, GRAZER: n, ... } (species KEYS → counts). Empty tiers
// fall back to the flat config average so a primordial board still reads sanely.
export function idealRatios(bySpecies) {
    if (!bySpecies) return defaultRatios();
    const { PLANT, HERB, PRED, AVG } = buildCoeffs();

    const plantSupply = weighted(PLANT, bySpecies, 'supply', AVG.plantSupply);
    const herbDemand = weighted(HERB, bySpecies, 'demand', AVG.herbDemand);
    const herbSupply = weighted(HERB, bySpecies, 'supply', AVG.herbSupply);
    const herbSpeed = weighted(HERB, bySpecies, 'speed', AVG.herbSpeed);
    const predDemand = weighted(PRED, bySpecies, 'demand', AVG.predDemand);
    const predHunt = weighted(PRED, bySpecies, 'huntBase', AVG.predHunt);
    const predSpeed = weighted(PRED, bySpecies, 'speed', AVG.predSpeed);

    const predForage = forageEff(predHunt, predSpeed, herbSpeed);

    return finalRatios(
        herbDemand / Math.max(plantSupply * HERB_FORAGE_EFF, EPS),
        predDemand / Math.max(herbSupply * predForage * PRED_REALIZED, EPS),
    );
}
