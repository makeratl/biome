# Biome

A hex-grid ecosystem strategy game where local LLMs (or humans) compete by
seeding species across procedurally generated terrain, then watch a living
simulation decide the winner. Build biodiversity, exploit food chains, raid your
rival's ecosystem — and climb a persistent ELO ladder of AI models.

No API keys. No build step. Everything runs locally on Ollama + a tiny Python
server.

<p align="center">
  <img src="screenshots/match-hud.png" alt="Live AI vs AI match — biosphere health orb, fighter dossiers, and a real-time score timeline" width="90%">
</p>

## Quick Start

```bash
# 1. Install and start Ollama (only needed for AI players)
#    See: https://ollama.com
ollama serve

# 2. Pull at least one model (default is qwen2.5:14b)
ollama pull qwen2.5:14b

# 3. Start the local server (static files + Ollama proxy + ELO backend)
python3 server.py

# 4. Open the game
open http://localhost:8765
```

A pure human-vs-human game needs no Ollama at all.

## Playing a Match

From the launcher you pick a mode:

- **Solo** — you vs an AI model.
- **Watch** — two AI models fight; you spectate (great for the leaderboard).
- **Tournament** — an 8/16/32-model bracket. See [Tournament Mode](#tournament-mode).

Before the match you set the **map size** (Fit / Small / Medium / Large), the
**round count** (5 / 10 / 15 / 20 — default 10), and the AI's **vision** — how
the board is described to the model:

| Vision | What the model sees |
|--------|---------------------|
| **Mediated** | High-level region summary (the default, easiest for small models) |
| **ASCII** | A text grid of the board |
| **Raw** | Bare coordinates + free placement (rewards larger models) |

<p align="center">
  <img src="screenshots/tournament-setup.png" alt="Match setup — mode, format, map size, rounds, and AI vision" width="55%">
</p>

### Placement Phase

Each round both players take turns placing organisms. You get **4 Action Points
(AP)** per turn. The six species span three trophic tiers:

| Species | Tier | AP | Notes |
|---------|------|----|-------|
| **Sedgeweave** (Grass) | Plant | 1 | Fast-spreading groundcover — the cheap foundation |
| **Thornbloom** (Shrub) | Plant | 1 | Spreads slowly, banks more energy than grass |
| **Spirewood** (Tree) | Plant | 2 | Slow and tall; stores the most energy, shrugs off grazers |
| **Hopgrazer** (Grazer) | Herbivore | 2 | Eats grass & shrubs — and prefers the *enemy's* |
| **Bramblemaw** (Browser) | Herbivore | 2 | Strips shrubs & trees bare, bite by bite |
| **Shadestalker** (Predator) | Predator | 2 | Swift hunter that culls herbivores |

A hard rule the whole engine respects: **at most 2 plants per cell.**

<p align="center">
  <img src="screenshots/placement.png" alt="Placement phase — the species palette and the hex board" width="80%">
</p>

### Simulation Phase

After both players act, the ecosystem runs for **20 steps**:

- **Plants** spread to adjacent cells and draw nutrients from the soil.
- **Herbivores** move toward food, graze (preferring enemy plants), and
  reproduce when their energy is high.
- **Predators** hunt herbivores and breed on successful kills.
- **Organisms** that run out of energy die and decay back into nutrients.

Iteration order is deliberately shuffled each step (Fisher-Yates), so no player
gets a positional edge from placement order.

### Scoring

> **Score = Total Biomass × Species Diversity Bonus × Trophic Chain Bonus**

- **Biomass** — the summed energy of your organisms, with **herbivore energy
  counted 2×** and **predator energy 3×**.
- **Species Diversity** — **+10% per unique species** alive (all six = +60%).
- **Trophic Chain** — **+25%** if you have at least one plant, one herbivore,
  *and* one predator alive simultaneously.

**Key insight:** a monoculture of grass loses badly. Diversify early, build a
full food chain, and graze your rival's plants to starve their herbivores.

### Fog of War

During your turn you can't see where your opponent placed organisms *this*
round. It's a correctness invariant, not just UI — the AI prompt is built so a
model never sees the enemy's current-round moves either.

## Biosphere & Trophic Balance

A living **health orb** reads the board every simulation step and shows the
ecosystem's mood at a glance — plants on the outer ring, herbivores in the
middle, predators at the core. It runs on the same trophic assessment the AI
sees, so humans and models judge health by one shared truth.

<p align="center">
  <img src="screenshots/biosphere-balanced.png" alt="Ecosystem bars and the biosphere orb in a balanced state" width="46%">
  <img src="screenshots/biosphere-atrisk.png" alt="The biosphere orb flagging an at-risk, overgrazed ecosystem" width="46%">
</p>

The orb moves through states as the board evolves: **Dormant → Primordial →
Building → Balanced**, then warns when things tip — **Overgrazed**,
**Top-Heavy**, **At Risk**, **Collapsing** — with named alerts like
*HERBIVORES STARVING* or *COLLAPSING*. The ideal pyramid is roughly 9 plants :
3 herbivores : 1 predator.

## AI Players

Biome runs LLMs through **Ollama** as opponents. Each turn the AI module:

1. **Reads the board** — maps terrain regions, censuses organisms by type and
   owner (fog-of-war respected).
2. **Scores candidates** — rates every legal cell for plant / herbivore /
   predator placement.
3. **Builds a prompt** — board summary, ecosystem health, strategic phase
   advice, opponent intel, and a memory of its own last turn.
4. **Calls the model** via the local proxy and parses the JSON reply with a
   3-tier extractor (direct → strip code fences → brace-matching) that's robust
   to chatty models.
5. **Falls back to heuristics** — if the reply is unusable, it plants grass via a
   deterministic scoring formula so the game never stalls.

### Configuring Models

Toggle a player to AI from the match setup, then pick any model in your Ollama
instance. The default is `qwen2.5:14b`. Open **Manage Models** to see installed
models with sizes, browse a curated recommended list, and **install any of them
with one click** — downloads stream live progress, no terminal needed.

These work well for Biome's structured JSON decisions:

| Model | Size | Notes |
|-------|------|-------|
| `qwen2.5:3b` | ~2 GB | Fast, good for quick matches |
| `qwen2.5:7b` | ~5 GB | Best size/performance ratio |
| `qwen2.5:14b` | ~9 GB | Strong strategy, the default |
| `llama3.1:8b` | ~5 GB | Popular general-purpose model |
| `gemma2:9b` | ~5 GB | Good instruction following |
| `mistral:7b` | ~4 GB | Fast responses |
| `phi3:medium` | ~8 GB | Compact but capable |
| `deepseek-r1:7b` | ~5 GB | Reasoning model, slower but thorough |

**Cloud models** proxied through Ollama work automatically — the AI module
detects them and raises token budgets so they can use the richer Raw vision.

## Rankings, Champions & Fighter Cards

Every AI match is rated. The **server is the source of truth for ELO**
(K-factor 32, base 1000) — results POST to `server.py`, which updates ratings,
records the match, and returns the rank deltas the client animates.

The **Hall of Champions** ranks every model that's played: a top-3 podium plus
standings sliced by size, family, and local-vs-cloud. Each model carries a
**biome-creature identity** — its family (Qwen, Llama, Gemma, …) maps to a baked
creature portrait and a signature hue, with a procedural fallback for families
that don't have art yet.

Click any fighter for a full **dossier**: ELO history, recent form, win-splits
by vision / round count / map size, and the head-to-head record against
tonight's opponent.

<p align="center">
  <img src="screenshots/fighter-card.png" alt="A fighter dossier — ELO history, recent form, by-vision splits, and top rivals" width="55%">
</p>

## Tournament Mode

Pick **Tournament** to run a bracket:

1. Choose the field size (8 / 16 / 32) and a **format** — *Seeded* (best ELO =
   top seed), *Champions* (ranked models only), *David vs Goliath* (smallest vs
   largest), or *Open Draw*.
2. Pick **Standard** (classic) or **Lightning** (10-round matches — faster
   brackets).
3. Quarter-Finals → Semi-Finals → Final play out sequentially.

A live bracket panel surfaces every match's state — completed (winner + margin),
live (running scores + round counter), up-next, and pending. Between bouts an
ESPN-style broadcast carousel rotates recaps, dossiers, and leaderboard
snapshots, and the final match gets a full champion-crowning fanfare. Models are
warmed up concurrently with the intro so no turn budget is lost to cold loads.

<p align="center">
  <img src="screenshots/tournament-ondeck.png" alt="On-deck matchup card with model creature avatars and ELO" width="42%">
</p>

## Game Dynamics

A **balance panel** (in Settings) lets you bend the ecosystem live without
touching code. Sliders apply multipliers over the baseline config — plant vigor,
herbivore appetite, predator pressure, soil richness, reproduction — with
presets (**Balanced**, **Lush**, **Harsh**, **Predator's Reign**). Settings
persist in `localStorage` and re-apply idempotently, so resetting always returns
to baseline.

## Field Guide

An in-game **Field Guide** (How to Play) explains every species, who eats whom,
and the scoring formula — all rendered from the same board art and config the
game uses, so it never drifts from the live balance.

## Training Lab

Biome can turn its own matches into fine-tuning data. The **Training Lab**
(`lab/train.html`) captures per-turn trajectories, scores the moves the engine
says actually worked, and exports a provider-neutral SFT dataset — a pipeline for
distilling the reigning champion's play into smaller models. It's research/dev
tooling; the game itself never depends on it.

<p align="center">
  <img src="screenshots/training-lab.png" alt="Training Lab dashboard — banked gold moves, progress, and gold-by-teacher" width="70%">
</p>

## Architecture

```
biome/
├── index.html              # Game shell (loads js/game.js as a module)
├── style.css               # All styling
├── server.py               # HTTP server: static files + Ollama proxy + ELO/trajectory backend
├── db.py / traj.py         # ELO persistence + training-data export
└── js/
    ├── game.js             # Orchestrator: grid/sim/turns, UI, AI loop, round/tournament drama
    ├── config.js           # All tunable constants (grid, terrain, species, scoring, rounds)
    ├── ai.js               # AIPlayer — prompt builder, Ollama calls, robust JSON parsing, fallback
    ├── simulation.js       # Ecosystem engine — spread, feeding, hunting, reproduction, death
    ├── trophic.js          # Shared ecosystem-health read (AI prompt + biosphere orb)
    ├── biosphere.js        # Animated health orb
    ├── game-dynamics.js    # Balance-slider system (multipliers over baseline config)
    ├── codex.js            # In-game Field Guide
    ├── tournament.js       # TournamentManager — bracket, match execution, live state
    ├── tournament-format.js# Field sizing, seeding, format definitions
    ├── rankings.js         # ELO fetch/render (server holds the math)
    ├── leaderboard.js      # Hall of Champions
    ├── player-card.js      # Fighter dossier modal
    ├── model-identity.js   # Model-family taxonomy → creature + hue
    ├── model-avatar.js     # Baked portraits + emotion clips + procedural fallback
    ├── broadcast-carousel.js# Rotating tournament flank panels
    ├── capture.js          # Fire-and-forget training-data POSTs (never slows the game)
    ├── species.js          # Organism creation + species queries
    ├── organism-art.js     # Per-species drawing (shared by game + icon lab)
    ├── turn.js             # TurnManager state machine
    ├── grid.js / terrain.js / noise.js  # Hex grid + Simplex-noise terrain
    ├── renderer.js         # Canvas drawing (terrain, fog, highlights)
    └── sound.js            # Synthesized SFX bank
```

### Why the Python server exists

The browser never calls Ollama directly. `server.py` is `SimpleHTTPRequestHandler`
plus three jobs:

1. **CORS proxy** — `/ollama/*` → `http://localhost:11434/*`; model pulls stream
   NDJSON so install progress is live.
2. **ELO backend** — match results POST to `/tournament-result`; the server
   computes ratings (K=32, base 1000) and is the single source of truth.
   `/rankings`, `/history`, `/stats/model`, and `/reset-rankings` round it out.
3. **Training capture** — append-only `/trajectory/*` logs, plus an avatar
   generation bridge for baking model portraits.

### Key dependencies

- **Ollama** — local LLM inference, no API keys.
- **Python 3** — `server.py` is standard library only, no pip installs.
- **A modern browser** — ES modules, no bundler.

## Tuning Game Balance

For permanent changes, everything lives in `js/config.js`:

- **Grid** — `GRID_COLS`, `GRID_ROWS`, `HEX_SIZE` (and the `MAPS` presets)
- **Terrain** — water/fertile/grassland/rocky thresholds, nutrient regen
- **Species** — energy, AP cost, spread chance, diet, reproduction thresholds
- **Scoring** — `SPECIES_DIVERSITY_BONUS`, `TROPHIC_BONUS`, weight multipliers
- **Rules** — `TOTAL_ROUNDS`, `ROUND_OPTIONS`, `AP_PER_TURN`, `STEPS_PER_TURN`

For live experiments, use the in-game Game Dynamics panel instead.

## Running Without AI

Set both players to Human for a pure 2-player game — no Ollama needed.
`server.py` only proxies Ollama when an AI actually takes a turn.

## License

MIT
