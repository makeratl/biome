// Ecosystem simulation engine

import { CONFIG } from './config.js';
import { createOrganism } from './species.js';
import { TERRAIN_TYPES } from './terrain.js';

export class Simulation {
    constructor(grid) {
        this.grid = grid;
    }

    // Run N simulation steps
    run(steps) {
        const snapshots = [];
        for (let i = 0; i < steps; i++) {
            this.step();
            snapshots.push(this._snapshot());
        }
        return snapshots;
    }

    step() {
        this._stepPlants();
        this._stepHerbivores();
        this._stepPredators();
        this._regenNutrients();
        this._cleanDead();
    }

    _stepPlants() {
        const grid = this.grid;
        const newOrganisms = [];

        grid.forEach((cell) => {
            if (cell.terrain === TERRAIN_TYPES.WATER) return;

            const plants = cell.organisms.filter(o => CONFIG.SPECIES[o.species]?.type === 'plant');

            for (const plant of plants) {
                const template = CONFIG.SPECIES[plant.species];

                // Consume nutrients
                const consumed = Math.min(cell.nutrients, template.nutrientConsumption);
                cell.nutrients -= consumed;

                // Gain energy from nutrients, lose maintenance cost
                plant.energy += consumed * CONFIG.TERRAIN.NUTRIENT_ENERGY_MULT;
                plant.energy -= template.energyCost;
                plant.energy = Math.min(plant.energy, template.maxEnergy);
                plant.age++;

                // Die if no energy
                if (plant.energy <= 0) {
                    plant.dead = true;
                    continue;
                }

                // Try to spread
                if (plant.energy > template.spreadEnergyCost && Math.random() < template.spreadChance) {
                    const neighbors = grid.getNeighbors(cell.col, cell.row);
                    const viable = neighbors.filter(n =>
                        n.terrain !== TERRAIN_TYPES.WATER &&
                        n.nutrients > 0.05 &&
                        n.organisms.filter(o => CONFIG.SPECIES[o.species]?.type === 'plant').length < 2
                    );

                    if (viable.length > 0) {
                        // Prefer cells with more nutrients
                        viable.sort((a, b) => b.nutrients - a.nutrients);
                        const target = viable[0];
                        plant.energy -= template.spreadEnergyCost;
                        const offspring = createOrganism(plant.species, plant.player, target.col, target.row);
                        offspring.energy = template.energy * 0.5;
                        newOrganisms.push({ cell: target, org: offspring });
                    }
                }
            }
        });

        // Add new organisms to their cells
        for (const { cell, org } of newOrganisms) {
            cell.organisms.push(org);
        }
    }

    _stepHerbivores() {
        const grid = this.grid;
        const moves = [];

        grid.forEach((cell) => {
            const herbivores = cell.organisms.filter(o => {
                const t = CONFIG.SPECIES[o.species]?.type;
                return t === 'herbivore' && !o.dead;
            });

            for (const herb of herbivores) {
                const template = CONFIG.SPECIES[herb.species];
                herb.energy -= template.energyCost;
                herb.age++;

                if (herb.energy <= 0) {
                    herb.dead = true;
                    continue;
                }

                // Look for food in current cell and nearby cells
                const searchRange = template.speed;
                const foodCells = this._findFoodCells(cell, searchRange, template.diet, herb.player, template.preferEnemy);

                if (foodCells.length > 0) {
                    const target = foodCells[0];

                    // Move to target cell
                    if (target.cell !== cell) {
                        moves.push({ org: herb, from: cell, to: target.cell });
                    }

                    // Eat a plant
                    if (target.plant && !target.plant.dead) {
                        const eaten = Math.min(template.eatAmount, target.plant.energy);
                        target.plant.energy -= eaten;
                        herb.energy += eaten;
                        herb.energy = Math.min(herb.energy, template.maxEnergy);
                        if (target.plant.energy <= 0) target.plant.dead = true;
                    }
                } else {
                    // Wander randomly
                    const neighbors = grid.getNeighbors(cell.col, cell.row)
                        .filter(n => n.terrain !== TERRAIN_TYPES.WATER);
                    if (neighbors.length > 0) {
                        const target = neighbors[Math.floor(Math.random() * neighbors.length)];
                        moves.push({ org: herb, from: cell, to: target });
                    }
                }

                // Reproduce
                if (herb.energy > template.reproduceThreshold && Math.random() < template.reproduceChance) {
                    const neighbors = grid.getNeighbors(cell.col, cell.row)
                        .filter(n => n.terrain !== TERRAIN_TYPES.WATER);
                    if (neighbors.length > 0) {
                        herb.energy -= template.reproduceCost;
                        const birthCell = neighbors[Math.floor(Math.random() * neighbors.length)];
                        const offspring = createOrganism(herb.species, herb.player, birthCell.col, birthCell.row);
                        offspring.energy = template.reproduceCost * 0.6;
                        birthCell.organisms.push(offspring);
                    }
                }
            }
        });

        // Execute moves
        for (const { org, from, to } of moves) {
            const idx = from.organisms.indexOf(org);
            if (idx !== -1) {
                from.organisms.splice(idx, 1);
                to.organisms.push(org);
                org.col = to.col;
                org.row = to.row;
            }
        }
    }

    _stepPredators() {
        const grid = this.grid;
        const moves = [];

        grid.forEach((cell) => {
            const predators = cell.organisms.filter(o =>
                CONFIG.SPECIES[o.species]?.type === 'predator' && !o.dead
            );

            for (const pred of predators) {
                const template = CONFIG.SPECIES[pred.species];
                pred.energy -= template.energyCost;
                pred.age++;

                if (pred.energy <= 0) {
                    pred.dead = true;
                    continue;
                }

                // Hunt: find nearby prey
                const preyCells = this._findPreyCells(cell, template.speed);

                if (preyCells.length > 0) {
                    const target = preyCells[0];

                    if (target.cell !== cell) {
                        moves.push({ org: pred, from: cell, to: target.cell });
                    }

                    // Attempt hunt
                    if (target.prey && !target.prey.dead) {
                        const preyTemplate = CONFIG.SPECIES[target.prey.species];
                        const speedAdvantage = template.speed / (preyTemplate?.speed || 1);
                        const huntSuccess = template.huntSuccessBase * Math.min(speedAdvantage, 1.5);

                        if (Math.random() < huntSuccess) {
                            const eaten = Math.min(template.eatAmount, target.prey.energy);
                            target.prey.dead = true;
                            pred.energy += eaten;
                            pred.energy = Math.min(pred.energy, template.maxEnergy);
                        }
                    }
                } else {
                    // Wander
                    const neighbors = grid.getNeighbors(cell.col, cell.row)
                        .filter(n => n.terrain !== TERRAIN_TYPES.WATER);
                    if (neighbors.length > 0) {
                        const target = neighbors[Math.floor(Math.random() * neighbors.length)];
                        moves.push({ org: pred, from: cell, to: target });
                    }
                }

                // Reproduce
                if (pred.energy > template.reproduceThreshold && Math.random() < template.reproduceChance) {
                    const neighbors = grid.getNeighbors(cell.col, cell.row)
                        .filter(n => n.terrain !== TERRAIN_TYPES.WATER);
                    if (neighbors.length > 0) {
                        pred.energy -= template.reproduceCost;
                        const birthCell = neighbors[Math.floor(Math.random() * neighbors.length)];
                        const offspring = createOrganism(pred.species, pred.player, birthCell.col, birthCell.row);
                        offspring.energy = template.reproduceCost * 0.5;
                        birthCell.organisms.push(offspring);
                    }
                }
            }
        });

        for (const { org, from, to } of moves) {
            const idx = from.organisms.indexOf(org);
            if (idx !== -1) {
                from.organisms.splice(idx, 1);
                to.organisms.push(org);
                org.col = to.col;
                org.row = to.row;
            }
        }
    }

    _findFoodCells(origin, range, diet, player, preferEnemy) {
        const grid = this.grid;
        const results = [];

        // BFS from origin up to range
        const visited = new Set();
        const queue = [{ cell: origin, dist: 0 }];
        visited.add(`${origin.col},${origin.row}`);

        while (queue.length > 0) {
            const { cell, dist } = queue.shift();

            // Check for food plants in this cell
            const plants = cell.organisms.filter(o =>
                CONFIG.SPECIES[o.species]?.type === 'plant' &&
                !o.dead &&
                diet.includes(o.species)
            );

            for (const plant of plants) {
                // Score: prefer enemy plants, prefer closer, prefer more energy
                const enemyBonus = (plant.player !== player) ? preferEnemy : (1 - preferEnemy);
                const distPenalty = 1 / (1 + dist);
                const score = enemyBonus * distPenalty * plant.energy;
                results.push({ cell, plant, score });
            }

            if (dist < range) {
                for (const neighbor of grid.getNeighbors(cell.col, cell.row)) {
                    const key = `${neighbor.col},${neighbor.row}`;
                    if (!visited.has(key) && neighbor.terrain !== TERRAIN_TYPES.WATER) {
                        visited.add(key);
                        queue.push({ cell: neighbor, dist: dist + 1 });
                    }
                }
            }
        }

        results.sort((a, b) => b.score - a.score);
        return results;
    }

    _findPreyCells(origin, range) {
        const grid = this.grid;
        const results = [];

        const visited = new Set();
        const queue = [{ cell: origin, dist: 0 }];
        visited.add(`${origin.col},${origin.row}`);

        while (queue.length > 0) {
            const { cell, dist } = queue.shift();

            const prey = cell.organisms.filter(o =>
                CONFIG.SPECIES[o.species]?.type === 'herbivore' && !o.dead
            );

            for (const p of prey) {
                const distPenalty = 1 / (1 + dist);
                results.push({ cell, prey: p, score: distPenalty * p.energy });
            }

            if (dist < range) {
                for (const neighbor of grid.getNeighbors(cell.col, cell.row)) {
                    const key = `${neighbor.col},${neighbor.row}`;
                    if (!visited.has(key) && neighbor.terrain !== TERRAIN_TYPES.WATER) {
                        visited.add(key);
                        queue.push({ cell: neighbor, dist: dist + 1 });
                    }
                }
            }
        }

        results.sort((a, b) => b.score - a.score);
        return results;
    }

    _regenNutrients() {
        this.grid.forEach((cell) => {
            if (cell.terrain === TERRAIN_TYPES.WATER) return;
            const max = CONFIG.NUTRIENTS[cell.terrain] || 0;
            cell.nutrients = Math.min(max, cell.nutrients + CONFIG.TERRAIN.NUTRIENT_REGEN);
        });
    }

    _cleanDead() {
        this.grid.forEach((cell) => {
            cell.organisms = cell.organisms.filter(o => !o.dead);
        });
    }

    // Count organisms by player
    census() {
        const counts = {
            1: { plants: 0, herbivores: 0, predators: 0, biomass: 0 },
            2: { plants: 0, herbivores: 0, predators: 0, biomass: 0 },
        };

        this.grid.forEach((cell) => {
            for (const org of cell.organisms) {
                const type = CONFIG.SPECIES[org.species]?.type;
                const p = counts[org.player];
                if (!p) continue;

                if (type === 'plant') p.plants++;
                else if (type === 'herbivore') p.herbivores++;
                else if (type === 'predator') p.predators++;
                p.biomass += org.energy;
            }
        });

        return counts;
    }

    // Final score with biodiversity multipliers
    finalScore() {
        const S = CONFIG.SCORING;
        const scores = { 1: null, 2: null };

        for (const p of [1, 2]) {
            // Weighted biomass — higher-tier organisms count more
            let weightedBiomass = 0;
            const speciesSet = new Set();
            let hasPlant = false, hasHerb = false, hasPred = false;

            this.grid.forEach((cell) => {
                for (const org of cell.organisms) {
                    if (org.player !== p) continue;
                    const type = CONFIG.SPECIES[org.species]?.type;
                    speciesSet.add(org.species);

                    if (type === 'plant') {
                        weightedBiomass += org.energy;
                        hasPlant = true;
                    } else if (type === 'herbivore') {
                        weightedBiomass += org.energy * S.HERBIVORE_WEIGHT;
                        hasHerb = true;
                    } else if (type === 'predator') {
                        weightedBiomass += org.energy * S.PREDATOR_WEIGHT;
                        hasPred = true;
                    }
                }
            });

            // Diversity bonus: +10% per unique species
            const diversityMult = 1 + speciesSet.size * S.SPECIES_DIVERSITY_BONUS;

            // Trophic bonus: +25% if all three tiers present
            const trophicMult = (hasPlant && hasHerb && hasPred) ? (1 + S.TROPHIC_BONUS) : 1;

            const totalMult = diversityMult * trophicMult;
            const finalScore = Math.round(weightedBiomass * totalMult);

            scores[p] = {
                rawBiomass: weightedBiomass,
                species: [...speciesSet],
                speciesCount: speciesSet.size,
                diversityMult,
                hasTrophic: hasPlant && hasHerb && hasPred,
                trophicMult,
                totalMult,
                finalScore,
            };
        }

        return scores;
    }

    _snapshot() {
        const data = [];
        this.grid.forEach((cell) => {
            if (cell.organisms.length > 0) {
                data.push({
                    col: cell.col,
                    row: cell.row,
                    organisms: cell.organisms.map(o => ({
                        species: o.species,
                        player: o.player,
                        energy: o.energy,
                    })),
                });
            }
        });
        return data;
    }
}
