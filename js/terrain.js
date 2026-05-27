// Procedural terrain generation

import { CONFIG } from './config.js';
import { SimplexNoise } from './noise.js';

const TERRAIN_TYPES = {
    WATER: 'WATER',
    FERTILE: 'FERTILE',
    GRASSLAND: 'GRASSLAND',
    ROCKY: 'ROCKY',
};

function classifyTerrain(elevation, moisture) {
    const t = CONFIG.TERRAIN;
    if (elevation < t.WATER_THRESHOLD) return TERRAIN_TYPES.WATER;
    if (elevation > t.ROCK_ELEVATION) return TERRAIN_TYPES.ROCKY;
    if (moisture < t.ROCK_MOISTURE) return TERRAIN_TYPES.ROCKY;
    if (moisture > t.FERTILE_MOISTURE && elevation < 0.55) return TERRAIN_TYPES.FERTILE;
    return TERRAIN_TYPES.GRASSLAND;
}

export function generateTerrain(grid, seed) {
    const elevNoise = new SimplexNoise(seed);
    const moistNoise = new SimplexNoise(seed + 9999);

    const eScale = CONFIG.TERRAIN.ELEVATION_SCALE;
    const mScale = CONFIG.TERRAIN.MOISTURE_SCALE;

    grid.forEach((cell) => {
        const elevation = elevNoise.octave2D(cell.col * eScale, cell.row * eScale, 2, 0.5);
        const moisture = moistNoise.octave2D(cell.col * mScale, cell.row * mScale, 2, 0.5);

        cell.elevation = elevation;
        cell.moisture = moisture;
        cell.terrain = classifyTerrain(elevation, moisture);
        cell.nutrients = CONFIG.NUTRIENTS[cell.terrain] || 0;
    });

    // Boost nutrients near water edges (fertile shorelines)
    grid.forEach((cell) => {
        if (cell.terrain === TERRAIN_TYPES.WATER) return;
        const neighbors = grid.getNeighbors(cell.col, cell.row);
        const waterNeighbors = neighbors.filter(n => n.terrain === TERRAIN_TYPES.WATER).length;
        if (waterNeighbors > 0) {
            cell.nutrients = Math.min(CONFIG.TERRAIN.MAX_NUTRIENTS, cell.nutrients + waterNeighbors * 0.1);
            if (cell.terrain === TERRAIN_TYPES.GRASSLAND) {
                cell.terrain = TERRAIN_TYPES.FERTILE;
            }
        }
    });
}

export { TERRAIN_TYPES };
