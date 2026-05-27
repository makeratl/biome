// Species templates and organism model

import { CONFIG } from './config.js';

let nextId = 1;

export function createOrganism(species, player, col, row) {
    const template = CONFIG.SPECIES[species];
    if (!template) throw new Error(`Unknown species: ${species}`);

    return {
        id: nextId++,
        species,
        player,
        col,
        row,
        energy: template.energy,
        age: 0,
    };
}

export function getSpeciesTemplate(species) {
    return CONFIG.SPECIES[species] || null;
}

export function getPlantSpecies() {
    return Object.entries(CONFIG.SPECIES)
        .filter(([_, v]) => v.type === 'plant')
        .map(([key, v]) => ({ key, ...v }));
}

export function getHerbivoreSpecies() {
    return Object.entries(CONFIG.SPECIES)
        .filter(([_, v]) => v.type === 'herbivore')
        .map(([key, v]) => ({ key, ...v }));
}

export function getPredatorSpecies() {
    return Object.entries(CONFIG.SPECIES)
        .filter(([_, v]) => v.type === 'predator')
        .map(([key, v]) => ({ key, ...v }));
}

export function getAllSpecies() {
    return Object.entries(CONFIG.SPECIES)
        .map(([key, v]) => ({ key, ...v }));
}
