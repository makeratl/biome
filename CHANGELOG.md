# Changelog

All notable changes to BIOME will be documented in this file.

## [0.2.0] - 2025-05-27

### Bug Fixes

- **AI plant cap bypass**: `_executeActions`, `_topUpWithGrass`, and `_fallback` could place plants in cells already at the 2-plant cap. All three now enforce the cap. `_fallback` also records actions via `recordAction`.

- **AI candidate filtering too aggressive**: `_findCandidates` skipped all occupied cells, preventing the AI from placing herbivores/predators near plants (where they should be) and from stacking a second plant in a cell with 1 plant. Now filters by organism type: plant candidates allow cells with <2 plants; herbivore/predator candidates allow cells containing plants.

- **Simulation iteration bias**: `_stepHerbivores` and `_stepPredators` iterated cells in deterministic Map insertion order (row-major), giving consistent positional advantage to organisms placed earlier. Both now shuffle cells each step via Fisher-Yates.

### Improvements

- **JSON extraction robustness**: The `extractJSON` function in AI responses now uses a three-tier approach: (1) direct parse, (2) markdown code fence stripping (` ```json ... ``` `), (3) depth-tracked brace matching right-to-left. Previously used a fragile `lastIndexOf('}')` that could match the wrong closing brace.

### Review

- **Fog-of-war**: Audited and confirmed correct. All AI prompt builder methods (`_summarizePlayer`, `_findCandidates`, `_getCensus`) properly skip enemy current-round placements. No leak found.

## [0.1.0] - 2025-05-25

### Added

- Initial release: hex-grid ecosystem strategy game (BIOME)
- Player vs Player and Player vs AI modes
- AI opponent via Ollama LLM integration
- Tournament mode (8-model bracket elimination)
- Procedural terrain generation (Simplex Noise)
- Species: Grass, Shrub, Tree, Grazer, Browser, Predator
- Ecosystem simulation: plant spread, herbivore grazing, predator hunting, nutrient cycling
- Fog of war (hides opponent's current-round placements)
- Scoring: weighted biomass × species diversity bonus × trophic chain bonus
- Model configuration panel with one-click install