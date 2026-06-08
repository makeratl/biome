# Changelog

All notable changes to BIOME will be documented in this file.

## [Unreleased]

### Added

- **Ranked ELO ladder**: Solo and Watch matches are now rated and feed the same
  live ladder as Tournament play — one continuous rating history across all modes,
  with rank-change celebrations (promotions, throne takeovers, upsets). A ranked
  game ends on a single-match dashboard (score-over-time timeline + ELO delta).
- **SQLite history backend** (`db.py` → `biome.db`): replaces the JSON-replayed
  ELO with a queryable store that *keeps* history. One `rating_events` row per
  player per match records the elo_before → elo_after transition (the time-series
  every dashboard chart reads), computed once incrementally on insert. First boot
  migrates the legacy `tournament_log.json` (kept as a backup). Stdlib `sqlite3`
  only — no new dependency.
- **Tournament viewer & bracket tree**: finished brackets are kept and can be
  re-opened as a full-screen replay — the mirrored bracket graphic (one
  competitor's path traceable in gold) plus per-match ELO cards and a
  rating-progression chart. New modules `bracket-tree.js` (data-driven render,
  one source for live + historical), `tournament-viewer.js` (the full-screen
  view), and `match-dashboard.js` (post-game detail, shared by the championship
  screen and the ranked game-over overlay).
- **Tournament format system** (`tournament-format.js`): six orthogonal formats
  (Qualifier, Seeded, Champions, David vs Goliath, Open Draw, Home Turf) with
  variable field size (8 / 16 / 32) and a **Lightning** (10-round) option.
- **Model identity & presentation**: biome-creature avatars per model family with
  procedural fallback, responsive board layout, bottom-center HUD console, and a
  fighting-game tournament presentation (VS reveals, broadcast carousel,
  champion-crowning fanfare).
- **Model roster**: bench/retire models so they're excluded from tournaments and
  opponent pickers — persisted via `/roster` to `model-roster.json` (orthogonal
  to ELO).
- **New server endpoints**: `/tournaments`, `/tournament?id=`,
  `/stats/model-tournaments`, `/roster`.

### Changed

- **ELO math moved to `db.py`** (incremental, on insert) — `server.py` no longer
  recomputes rankings from the whole log on each read. Standings are unchanged
  (same K=32, base 1000).
- **Bracket rendering extracted** from `tournament.js` into `bracket-tree.js` so
  the live tournament, championship screen, and historical viewer all draw from
  one source of truth.

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