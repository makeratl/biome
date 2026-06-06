// AI player module for Biome — uses Ollama for strategic decisions

import { CONFIG } from './config.js';
import { createOrganism } from './species.js';
import { extractJSON } from './util.js';
import { buildTurnPrompt, matchSizeLabel } from './prompt.js';
import { getStrategy } from './map-strategies.js';
import { parseTier } from './model-identity.js';
import { trophicRead } from './trophic.js';
import { captureTurn, isCaptureEnabled } from './capture.js';

// How long a warmed/active model is asked to stay resident in Ollama. Long
// enough to outlast a full match (and the short gap to its next match in a
// bracket) but bounded so an idle model still releases on its own — the
// just-in-time unload in prepareResidentSet is the primary release; this TTL
// is only the backstop if that unload is skipped (abort, crash). NOT -1.
const MATCH_KEEP_ALIVE = '30m';

// Shared cloud test — :cloud models are Ollama Cloud (remote, always warm,
// zero local RAM), so they're skipped by all warm/unload logic.
export function isCloudModel(name) {
    return /cloud/i.test(name || '');
}

export class AIPlayer {
    constructor(game, playerNumber, options = {}) {
        this.game = game;
        this.player = playerNumber;
        this.model = options.model || 'qwen2.5:14b';
        // Use local proxy endpoint for CORS bypass
        this.ollamaUrl = options.ollamaUrl || '/ollama';
        this._mapSummary = null;
        // Fighter intel — populated by the game (Game._syncFighterContext) so the
        // prompt can name the opponent and reference both records/rankings. Each is
        // { isHuman, name, vendor, archetype, tier, elo, rank, wins, losses } or null.
        this.opponent = null;
        this.selfContext = null;
        // Per-turn memory — what this fighter did/said last time it acted, plus a
        // start-of-turn census snapshot, so the next prompt can show "here's what
        // changed while you were away" and feed back its own stated plan/banter.
        // Stateless model calls otherwise have zero continuity between turns.
        // Reset per match: setAI() builds a fresh AIPlayer, so this stays null.
        this.lastTurn = null;
    }

    // One-line "who is this fighter" string for the matchup intel block.
    _describeFighter(f) {
        if (!f) return null;
        if (f.isHuman) return `${f.name} (a human challenger)`;
        let s = f.name;
        const tags = [];
        if (f.vendor) tags.push(`by ${f.vendor}`);
        if (f.archetype) tags.push(f.archetype);
        if (f.tier) tags.push(f.tier);
        if (tags.length) s += ` (${tags.join(', ')})`;
        if (f.elo != null) {
            const rankStr = f.rank ? `ranked #${f.rank}, ` : '';
            const rec = (f.wins != null) ? `, ${f.wins}W–${f.losses}L` : '';
            s += ` — ${rankStr}${f.elo} ELO${rec}`;
        } else {
            s += ' — unranked, no record yet';
        }
        return s;
    }

    // ── Map summary (generated once per game) ──────────────────

    _generateMapSummary() {
        if (this._mapSummary) return this._mapSummary;

        const grid = this.game.grid;
        const cols = grid.cols;
        const rows = grid.rows;
        const regions = {};
        const names = [['NW','N','NE'],['W','C','E'],['SW','S','SE']];

        for (const row of names) for (const n of row) {
            regions[n] = { fertile: 0, grassland: 0, rocky: 0, water: 0, total: 0 };
        }

        grid.forEach(cell => {
            const r = regions[this._regionOf(cell.col, cell.row)];
            r.total++;
            const t = cell.terrain.toLowerCase();
            if (r[t] !== undefined) r[t]++;
        });

        let summary = '';
        for (const [name, r] of Object.entries(regions)) {
            const wp = Math.round(r.water / r.total * 100);
            const fp = Math.round(r.fertile / r.total * 100);
            if (wp > 40) summary += `  ${name}: mostly water (${wp}%), limited land\n`;
            else if (fp > 30) summary += `  ${name}: fertile (${fp}%), good for plants\n`;
            else {
                const top = Object.entries(r).filter(([k]) => k !== 'total')
                    .sort((a,b) => b[1] - a[1])[0];
                summary += `  ${name}: ${top[0]} (${Math.round(top[1]/r.total*100)}%)\n`;
            }
        }

        this._mapSummary = summary;
        return summary;
    }

    _regionOf(col, row) {
        const cols = this.game.grid.cols, rows = this.game.grid.rows;
        const cx = col < cols/3 ? 0 : col < cols*2/3 ? 1 : 2;
        const ry = row < rows/3 ? 0 : row < rows*2/3 ? 1 : 2;
        return [['NW','N','NE'],['W','C','E'],['SW','S','SE']][ry][cx];
    }

    // ── Ecosystem state summary ────────────────────────────────

    _summarizePlayer(playerNum) {
        const grid = this.game.grid;
        const round = this.game.turns.round;
        let plants = 0, herbs = 0, preds = 0, biomass = 0;
        const byRegion = { plant: {}, herbivore: {}, predator: {} };

        grid.forEach(cell => {
            for (const org of cell.organisms) {
                // Fog: skip enemy's hidden placements
                if (org._placedRound === round && org.player !== this.player) continue;
                if (org.player !== playerNum) continue;

                const type = CONFIG.SPECIES[org.species]?.type;
                const region = this._regionOf(cell.col, cell.row);
                biomass += org.energy;

                if (type === 'plant') { plants++; byRegion.plant[region] = (byRegion.plant[region]||0)+1; }
                else if (type === 'herbivore') { herbs++; byRegion.herbivore[region] = (byRegion.herbivore[region]||0)+1; }
                else if (type === 'predator') { preds++; byRegion.predator[region] = (byRegion.predator[region]||0)+1; }
            }
        });

        let s = `${plants} plants, ${herbs} herbivores, ${preds} predators (${Math.round(biomass)} biomass)`;
        const top = (obj) => Object.entries(obj).sort((a,b) => b[1]-a[1]).slice(0,3)
            .map(([r,c]) => `${r}:${c}`).join(', ');

        if (plants > 0) s += `\n  Plants in: ${top(byRegion.plant)}`;
        if (herbs > 0) s += `\n  Herbivores in: ${top(byRegion.herbivore)}`;
        if (preds > 0) s += `\n  Predators in: ${top(byRegion.predator)}`;
        return s;
    }

    // ── Candidate move scoring ─────────────────────────────────

    _findCandidates() {
        const grid = this.game.grid;
        const round = this.game.turns.round;
        const enemy = this.player === 1 ? 2 : 1;

        // Spatial index — track all organisms by type and owner
        const enemyPlants = [], enemyHerbs = [], enemyPreds = [];
        const ownPlants = [], ownHerbs = [];
        const allPlants = [], allHerbs = [];
        grid.forEach(cell => {
            for (const org of cell.organisms) {
                if (org._placedRound === round && org.player !== this.player) continue;
                const type = CONFIG.SPECIES[org.species]?.type;
                if (type === 'plant') allPlants.push(cell);
                if (type === 'herbivore') allHerbs.push(cell);
                if (org.player === enemy) {
                    if (type === 'plant') enemyPlants.push(cell);
                    else if (type === 'herbivore') enemyHerbs.push(cell);
                    else if (type === 'predator') enemyPreds.push(cell);
                } else if (org.player === this.player) {
                    if (type === 'plant') ownPlants.push(cell);
                    else if (type === 'herbivore') ownHerbs.push(cell);
                }
            }
        });

        const nearby = (cell, targets, maxDist) => {
            let n = 0;
            for (const t of targets) {
                if (Math.abs(cell.col - t.col) + Math.abs(cell.row - t.row) <= maxDist) n++;
            }
            return n;
        };

        // Tiny per-cell deterministic perturbation (≈[0, 0.001)) added to every
        // score. Early game most cells tie on raw nutrients; without this the
        // sort falls back to grid iteration order (top-left→bottom-right), so
        // pickDiverse always grabbed the northern regions first and the AI's
        // whole opening clustered at the top of the map. Far smaller than any
        // real score gap, so it only breaks ties — it never reorders genuinely
        // better spots. Deterministic (no Math.random) for stable replays.
        const tieJitter = (cell) => {
            const h = Math.sin(cell.col * 12.9898 + cell.row * 78.233) * 43758.5453;
            return (h - Math.floor(h)) * 1e-3;
        };

        const plantSpots = [], herbSpots = [], predSpots = [];

        grid.forEach(cell => {
            if (cell.terrain === 'WATER') return;

            const plantsHere = cell.organisms.filter(o => CONFIG.SPECIES[o.species]?.type === 'plant').length;

            // Plant candidates: skip cells at plant cap
            if (plantsHere < CONFIG.SIM.PLANT_CAP) {
                let ps = cell.nutrients * (cell.terrain === 'FERTILE' ? 1.5 : 1);
                ps += nearby(cell, ownPlants, 3) * 0.08;
                ps -= nearby(cell, enemyHerbs, 4) * 0.15;
                ps += tieJitter(cell);
                plantSpots.push({ cell, score: ps });
            }

            // Herbivore/predator candidates: any non-water cell (they can share with plants)
            if (cell.organisms.length === 0 || plantsHere > 0) {
                const ep = nearby(cell, enemyPlants, 5);
                const op = nearby(cell, ownPlants, 5);
                const anyPlants = ep + op;
                const danger = nearby(cell, enemyPreds, 4);
                const herbScore = ep * 0.4 + op * 0.15 - danger * 0.3 + (cell.terrain === 'FERTILE' ? 0.2 : 0) + tieJitter(cell);
                herbSpots.push({ cell, score: herbScore, nearEnemyPlants: ep, nearOwnPlants: op, nearPreds: danger });

                const eh = nearby(cell, enemyHerbs, 5);
                const oh = nearby(cell, ownHerbs, 5);
                const predScore = eh * 0.5 + oh * 0.2 + (anyPlants > 3 ? 0.1 : 0) + tieJitter(cell);
                predSpots.push({ cell, score: predScore, nearEnemyHerbs: eh, nearOwnHerbs: oh });
            }
        });

        plantSpots.sort((a,b) => b.score - a.score);
        herbSpots.sort((a,b) => b.score - a.score);
        predSpots.sort((a,b) => b.score - a.score);

        // Build labeled candidate list — enforce regional diversity
        const candidates = [];

        // Pick top spots spread across different regions
        const pickDiverse = (spots, max) => {
            const picked = [];
            const usedRegions = new Set();
            for (const s of spots) {
                const region = this._regionOf(s.cell.col, s.cell.row);
                if (!usedRegions.has(region)) {
                    picked.push(s);
                    usedRegions.add(region);
                    if (picked.length >= max) break;
                }
            }
            if (picked.length < max) {
                for (const s of spots) {
                    if (!picked.includes(s)) {
                        picked.push(s);
                        if (picked.length >= max) break;
                    }
                }
            }
            return picked;
        };

        const addSpots = (spots, type, speciesList, apNote, max, descFn) => {
            const diverse = pickDiverse(spots, max);
            for (const s of diverse) {
                candidates.push({
                    label: String.fromCharCode(65 + candidates.length),
                    type,
                    species: speciesList,
                    cell: s.cell,
                    description: descFn(s),
                    ap: apNote,
                });
            }
        };

        addSpots(plantSpots, 'plant', ['GRASS','SHRUB','TREE'], '1 AP grass/shrub, 2 AP tree', 5, (s) => {
            const c = s.cell;
            const r = this._regionOf(c.col, c.row);
            const herbs = nearby(c, enemyHerbs, 4);
            let d = `${c.terrain.toLowerCase()} in ${r}, nutrients ${c.nutrients.toFixed(1)}`;
            d += herbs > 0 ? `, ${herbs} enemy herbivores nearby (risky)` : ', safe';
            return d;
        });

        addSpots(herbSpots, 'herbivore', ['GRAZER','BROWSER'], '2 AP (energy counts ×2!)', 3, (s) => {
            const r = this._regionOf(s.cell.col, s.cell.row);
            const hasFood = s.nearEnemyPlants > 0 || s.nearOwnPlants > 0;
            let d = `${r}`;
            if (s.nearEnemyPlants > 0) d += `, ${s.nearEnemyPlants} enemy plants nearby (raid!)`;
            else if (s.nearOwnPlants > 0) d += `, near ${s.nearOwnPlants} of your plants (builds ×2 biomass)`;
            else d += `, no plants in reach (will starve here)`;
            d += s.nearPreds > 0 ? `, ${s.nearPreds} predators (dangerous)` : '';
            // Only dangle the diversity payoff where the creature can actually
            // live to claim it — the bonus counts only for species alive at game
            // end, so a starving placement earns nothing.
            d += hasFood ? ` — survives to add species diversity +10%` : '';
            return d;
        });

        addSpots(predSpots, 'predator', ['PREDATOR'], '2 AP (energy counts ×3!)', 2, (s) => {
            const r = this._regionOf(s.cell.col, s.cell.row);
            const hasPrey = s.nearEnemyHerbs > 0 || s.nearOwnHerbs > 0;
            let d = `${r}`;
            if (s.nearEnemyHerbs > 0) d += `, ${s.nearEnemyHerbs} enemy herbivores to hunt`;
            else if (s.nearOwnHerbs > 0) d += `, ${s.nearOwnHerbs} of your herbivores nearby`;
            else d += `, no prey in reach (will starve here)`;
            d += hasPrey ? ` — survives to add species diversity +10% and complete the trophic chain ×1.25!` : '';
            return d;
        });

        return candidates;
    }

    // Quick census for a player (respects fog)
    _getCensus(playerNum) {
        const round = this.game.turns.round;
        let plants = 0, herbs = 0, preds = 0, biomass = 0;
        this.game.grid.forEach(cell => {
            for (const org of cell.organisms) {
                if (org._placedRound === round && org.player !== this.player) continue;
                if (org.player !== playerNum) continue;
                const type = CONFIG.SPECIES[org.species]?.type;
                biomass += org.energy;
                if (type === 'plant') plants++;
                else if (type === 'herbivore') herbs++;
                else if (type === 'predator') preds++;
            }
        });
        return { plants, herbs, preds, biomass: Math.round(biomass) };
    }

    // ── Turn-to-turn continuity ────────────────────────────────

    // Stash what this fighter did/said this turn + a start-of-turn census, so the
    // NEXT turn can diff against it. Called from both the normal and fallback paths.
    // `startCensus` is { mine, enemy } captured before this turn's placements.
    _recordTurn(startCensus, reasoning, banter, results) {
        const placed = results
            .filter(r => r.ok && r.cell)
            .map(r => ({ species: r.species, region: this._regionOf(r.cell.col, r.cell.row) }));
        const tidy = (s, n) => {
            const clean = (s || '').replace(/\s+/g, ' ').trim();
            return clean.length > n ? clean.slice(0, n - 1).trimEnd() + '…' : clean;
        };
        this.lastTurn = {
            round: this.game.turns.round,
            plan: tidy(reasoning, 280),
            banter: tidy(banter, 160),
            placed,
            census: startCensus,
        };
    }

    // "Since your last turn…" block — the only thread of continuity across the
    // model's stateless calls. Diffs current census against last turn's snapshot,
    // replays what it deployed, and feeds back its own stated plan/banter. Empty
    // on the first turn (no prior). `myCensus`/`enemyCensus` are this turn's.
    _recentHistoryBlock(myCensus, enemyCensus) {
        const lt = this.lastTurn;
        if (!lt) return '';

        const lines = [`SINCE YOUR LAST TURN (round ${lt.round}):`];

        if (lt.placed.length) {
            const counts = {};
            for (const p of lt.placed) {
                const name = CONFIG.SPECIES[p.species]?.name || p.species;
                const key = `${name}|${p.region}`;
                counts[key] = (counts[key] || 0) + 1;
            }
            const parts = Object.entries(counts).map(([key, n]) => {
                const [name, region] = key.split('|');
                return `${n}× ${name} (${region})`;
            });
            lines.push(`  You deployed: ${parts.join(', ')}`);
        }

        if (lt.plan) lines.push(`  Your stated plan: "${lt.plan}"`);

        const sign = n => (n >= 0 ? `+${n}` : `${n}`);
        const dMine = myCensus.biomass - lt.census.mine.biomass;
        const dEnemy = enemyCensus.biomass - lt.census.enemy.biomass;
        lines.push(`  Board moved since then — your biomass ${lt.census.mine.biomass}→${myCensus.biomass} (${sign(dMine)}), enemy ${lt.census.enemy.biomass}→${enemyCensus.biomass} (${sign(dEnemy)}).`);

        if (lt.banter) lines.push(`  You declared: "${lt.banter}"`);

        return lines.join('\n') + '\n\n';
    }

    // ── Prompt builder ─────────────────────────────────────────

    // Build the turn prompt. This method now only ASSEMBLES the normalized
    // context (it owns all game-state + fog reads); js/prompt.js composes the
    // string from ordered, config-derived blocks. Signature is unchanged, so
    // takeTurn() and the Vision Lab keep calling it as before.
    _buildPrompt(candidates) {
        return buildTurnPrompt(this._promptContext(candidates));
    }

    // Gather everything the prompt blocks need into one plain object. Fog logic
    // stays HERE (in _getCensus / _summarizePlayer), never in the formatter.
    _promptContext(candidates) {
        const tm = this.game.turns;
        const player = this.player;
        const enemy = player === 1 ? 2 : 1;
        const round = tm.round;
        const total = tm.totalRounds;
        const ap = tm.players[player].ap;

        const myCensus = this._getCensus(player);
        const enemyCensus = this._getCensus(enemy);

        // Score projection — what my current diversity would yield. Own board, so
        // no fog concern. Multiplier derives from CONFIG so it tracks any tuning.
        const mySpecies = new Set();
        let myHasPlant = false, myHasHerb = false, myHasPred = false;
        this.game.grid.forEach(cell => {
            for (const org of cell.organisms) {
                if (org.player !== player) continue;
                mySpecies.add(org.species);
                const t = CONFIG.SPECIES[org.species]?.type;
                if (t === 'plant') myHasPlant = true;
                else if (t === 'herbivore') myHasHerb = true;
                else if (t === 'predator') myHasPred = true;
            }
        });
        const trophic = myHasPlant && myHasHerb && myHasPred;
        const currentMult = (1 + mySpecies.size * CONFIG.SCORING.SPECIES_DIVERSITY_BONUS)
            * (trophic ? 1 + CONFIG.SCORING.TROPHIC_BONUS : 1);

        // Phase thresholds scale with match length so a 5- or 20-round game each
        // gets a sensible early/mid/late split.
        const earlyEnd = Math.max(1, Math.round(total * 0.25));
        const midEnd = Math.max(earlyEnd + 1, Math.round(total * 0.65));

        const grid = this.game.grid;
        const mc = this.game.matchContext || {};

        // The map block is produced by the active orientation strategy (shared
        // with the Vision Lab); only PRESENTATION changes, candidates/placement
        // stay constant. An explicit match-context override wins (the lab A/B
        // tests strategies); otherwise we pick by the model's size tier.
        const strategy = getStrategy(mc.mapStrategy || this._tierStrategy());
        const mapBlock = strategy.buildMapBlock({
            grid,
            candidates,
            regionSummary: this._generateMapSummary().replace(/\n+$/, ''),
        });

        return {
            player, enemy, round, total, ap,
            match: { mode: mc.mode || null, modeLabel: mc.modeLabel || null, stakes: mc.stakes || null },
            board: {
                cols: grid.cols, rows: grid.rows,
                sizeLabel: matchSizeLabel(grid.cols, grid.rows),
                mapBlock,
                myEcosystem: this._summarizePlayer(player),
                enemyEcosystem: this._summarizePlayer(enemy),
                candidates,
            },
            census: { mine: myCensus, enemy: enemyCensus },
            // Trophic balance read — same helper that drives the human health
            // orb. Derived from the FOGGED censuses above (enemy current-round
            // placements already hidden), so it only synthesizes numbers the
            // model is already shown — no fog leak.
            trophic: {
                mine: trophicRead(myCensus.plants, myCensus.herbs, myCensus.preds),
                enemy: trophicRead(enemyCensus.plants, enemyCensus.herbs, enemyCensus.preds),
            },
            strategy: {
                ahead: myCensus.biomass > enemyCensus.biomass * 1.2,
                behind: enemyCensus.biomass > myCensus.biomass * 1.2,
                enemyHasPlants: enemyCensus.plants > 20,
                enemyHasHerbs: enemyCensus.herbs > 5,
                myHasPlant, myHasHerb, myHasPred,
                speciesCount: mySpecies.size, currentMult, earlyEnd, midEnd,
            },
            fighters: {
                selfDesc: this._describeFighter(this.selfContext),
                oppDesc: this._describeFighter(this.opponent),
            },
            memory: this.lastTurn ? this._recentHistoryBlock(myCensus, enemyCensus).trim() : '',
            persona: this.persona || null,
        };
    }

    // ── Ollama API call ────────────────────────────────────────

    _isCloudModel() {
        return isCloudModel(this.model);
    }

    // Pick the board-orientation strategy from the model's size tier. Small/mid
    // models reason better from the compact, coordinate-anchored ascii grid
    // (≈constant tokens, whole board visible); large/cloud models can take the
    // full raw cell dump that pairs with free-coordinate placement.
    _tierStrategy() {
        const tier = parseTier(this.model);
        return (tier === 'large' || tier === 'cloud') ? 'raw' : 'ascii';
    }

    // How long a single model call is allowed before we abandon it. Now that the
    // match warms models BEFORE the clock starts (prepareResidentSet), cold-load
    // no longer eats this budget — and in practice both local (2–6s) and cloud
    // (up to ~30s worst case) settle well inside a flat 30s ceiling. One number
    // for everyone keeps the field level. Exposed so the game-level turn watchdog
    // can derive its own (larger) ceiling.
    timeoutMs() {
        return 30_000;
    }

    async _callOllama(system, user, signal) {
        const url = `${this.ollamaUrl}/api/chat`;
        // Token budget scales with the model's size tier (config.MODEL_BUDGETS):
        // big/cloud models get headroom for the raw board view + free-placement
        // reasoning, small models stay lean. numPredict covers thinking overhead
        // (some models ignore think:false) + JSON content.
        const budget = CONFIG.GAME.MODEL_BUDGETS[parseTier(this.model)] || CONFIG.GAME.MODEL_BUDGETS.mid;
        const numPredict = budget.numPredict;
        // Size the context window to the prompt so a large map representation
        // isn't silently front-truncated against Ollama's ~2048 default. Capped
        // by tier to bound VRAM; ~3 chars/token is conservative for coord-heavy text.
        const numCtx = Math.min(budget.numCtx,
            Math.max(2048, Math.ceil((system.length + user.length) / 3)));

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Aborted by takeTurn when the timeout wins, so a hung/slow request is
            // torn down cleanly instead of lingering (which left the proxy writing
            // to a dead socket → BrokenPipeError).
            signal,
            body: JSON.stringify({
                model: this.model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ],
                format: 'json',
                stream: false,
                think: false,
                // Keep the active model resident between this model's own turns —
                // without this Ollama's 5-min default can unload it mid-match
                // (P1 → P2 → back to P1 can exceed 5 min with two large models),
                // forcing a cold reload on the next turn. Cloud models ignore it.
                keep_alive: MATCH_KEEP_ALIVE,
                options: { temperature: 0.7, num_predict: numPredict, num_ctx: numCtx },
            }),
        });

        if (!response.ok) {
            throw new Error(`Ollama ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        const content = data.message.content?.trim() || '';
        const thinking = data.message.thinking?.trim() || '';

        // Prefer content field; fall back to thinking field for models that
        // exhaust their token budget on chain-of-thought. extractJSON is the
        // shared 3-tier parser (direct → strip fences → right-to-left brace scan).
        const result = extractJSON(content) || extractJSON(thinking);
        if (!result) {
            throw new Error(`No valid JSON found in response (content:${content.length}b, thinking:${thinking.length}b)`);
        }
        // Return the parsed action AND the verbatim raw response — capture keeps
        // the raw so training data preserves exactly what the model emitted.
        return {
            parsed: result,
            raw: { content, thinking, model: this.model,
                   options: { temperature: 0.7, num_predict: numPredict, num_ctx: numCtx } },
        };
    }

    // ── Execute actions ────────────────────────────────────────

    _executeActions(actions, candidates) {
        const tm = this.game.turns;
        const grid = this.game.grid;
        const lookup = {};
        for (const c of candidates) lookup[c.label] = c;

        const results = [];

        for (const action of actions) {
            // Resolve the target cell from EITHER a curated candidate letter
            // ({spot:"A"}) OR free coordinates ({col,row}). Free placement gives
            // capable models real spatial agency over the whole board; the
            // lettered menu stays as the always-legal floor for smaller models.
            // Both paths land in the same validation below (water/cap/AP).
            let cell;
            const col = Number(action.col), row = Number(action.row);
            const hasCoords = action.col != null && action.row != null
                && Number.isInteger(col) && Number.isInteger(row);
            if (hasCoords) {
                cell = grid.getCell(col, row);
                if (!cell) { results.push({ ok: false, msg: `Off-board: (${action.col},${action.row})` }); continue; }
                if (cell.terrain === 'WATER') { results.push({ ok: false, msg: `Water cell: (${col},${row})` }); continue; }
            } else {
                const cand = lookup[action.spot?.toUpperCase()];
                if (!cand) { results.push({ ok: false, msg: `Bad spot: ${action.spot}` }); continue; }
                cell = cand.cell;
            }

            const species = action.species?.toUpperCase();
            const template = CONFIG.SPECIES[species];
            if (!template) { results.push({ ok: false, msg: `Bad species: ${action.species}` }); continue; }

            if (tm.players[this.player].ap < template.apCost) {
                results.push({ ok: false, msg: `Not enough AP for ${species}` });
                continue;
            }

            if (template.type === 'plant') {
                const existingPlants = cell.organisms.filter(o => CONFIG.SPECIES[o.species]?.type === 'plant').length;
                if (existingPlants >= CONFIG.SIM.PLANT_CAP) {
                    results.push({ ok: false, msg: `Cell (${cell.col},${cell.row}) already has max plants` });
                    continue;
                }
            }

            tm.spendAP(template.apCost);
            const org = createOrganism(species, this.player, cell.col, cell.row);
            org._placedRound = tm.round;
            cell.organisms.push(org);
            tm.recordAction({ type: 'place', species, col: cell.col, row: cell.row });
            results.push({ ok: true, cell, species, msg: `${template.name} at (${cell.col},${cell.row}) in ${this._regionOf(cell.col, cell.row)}` });
        }

        return results;
    }

    // ── Main entry point ───────────────────────────────────────

    async takeTurn() {
        const candidates = this._findCandidates();
        const enemy = this.player === 1 ? 2 : 1;
        // Snapshot the board as this turn begins — next turn diffs against it for
        // the "since your last turn" recap. Captured before any placements land.
        const startCensus = { mine: this._getCensus(this.player), enemy: this._getCensus(enemy) };
        const { system, user } = this._buildPrompt(candidates);
        const ap = this.game.turns.players[this.player].ap;

        console.log(`[AI] Round ${this.game.turns.round}, P${this.player}, ${ap} AP, ${candidates.length} candidates`);
        console.log('[AI] Prompt:', user);

        let response, raw = null;
        const controller = new AbortController();
        let timer;
        try {
            const timeoutMs = this.timeoutMs();
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort();   // tear the fetch down, don't just abandon it
                    reject(new Error(`AI timeout (${timeoutMs / 1000}s)`));
                }, timeoutMs);
            });
            const out = await Promise.race([this._callOllama(system, user, controller.signal), timeout]);
            response = out.parsed;
            raw = out.raw;
        } catch (err) {
            console.error('[AI] Ollama error:', err.message);
            // Classify so the card can speak to *what* went wrong, not just go mute.
            const msg = err.message || '';
            const reason = /timeout/i.test(msg) ? 'timeout'
                : /no valid json/i.test(msg) ? 'badjson'
                : 'offline';
            const fb = this._fallback(candidates, reason, startCensus);
            this._captureTurn({ system, user, raw: null, parsed: null, results: fb.actions, startCensus, ap, fallbackReason: reason });
            return fb;
        } finally {
            clearTimeout(timer);
        }

        if (!response?.actions) {
            console.error('[AI] Bad response (no actions):', JSON.stringify(response));
            const fb = this._fallback(candidates, 'badjson', startCensus);
            this._captureTurn({ system, user, raw, parsed: response, results: fb.actions, startCensus, ap, fallbackReason: 'badjson' });
            return fb;
        }

        console.log('[AI] Response:', JSON.stringify(response));

        const results = this._executeActions(response.actions, candidates);

        // Log successes and failures
        const ok = results.filter(r => r.ok).length;
        const fail = results.filter(r => !r.ok).length;
        console.log(`[AI] Executed: ${ok} succeeded, ${fail} failed`);
        if (fail > 0) console.log('[AI] Failures:', results.filter(r => !r.ok).map(r => r.msg).join('; '));

        // Safety net: spend any remaining AP on grass
        const leftover = this.game.turns.players[this.player].ap;
        if (leftover > 0) {
            console.log(`[AI] ${leftover} AP unspent — auto-filling with grass`);
            const topUp = this._topUpWithGrass(candidates, results);
            results.push(...topUp);
        }

        this.game.renderer.render();

        this._recordTurn(startCensus, response.reasoning, response.banter, results);
        this._captureTurn({ system, user, raw, parsed: response, results, startCensus, ap, fallbackReason: null });

        return {
            reasoning: response.reasoning || '',
            banter: response.banter || '',
            actions: results,
            model: this.model,
        };
    }

    // Emit one training trajectory record for this turn (fire-and-forget; no-op
    // unless capture is enabled). The training INPUT is the verbatim fog-honest
    // prompt; full-board reward signals live in the separate round/outcome records.
    _captureTurn({ system, user, raw, parsed, results, startCensus, ap, fallbackReason }) {
        if (!isCaptureEnabled()) return;
        try {
            const g = this.game, tm = g.turns;
            const enemy = this.player === 1 ? 2 : 1;
            const turnUid = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID() : `t_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
            captureTurn({
                schema: 1,
                match_uid: g.matchUid || null,
                turn_uid: turnUid,
                seed: g.seed,
                model: this.model,
                player: this.player,
                opponent_model: g.aiPlayers?.[enemy]?.model || null,
                round: tm.round,
                total_rounds: tm.totalRounds,
                ap,
                map_strategy: g.matchContext?.mapStrategy || null,
                map_size: g.grid ? `${g.grid.cols}x${g.grid.rows}` : null,
                prompt: { system, user },
                response_raw: raw,
                response_parsed: parsed
                    ? { reasoning: parsed.reasoning ?? '', actions: parsed.actions ?? [], banter: parsed.banter ?? '' }
                    : null,
                exec: (results || []).map(r => ({
                    ok: !!r.ok, species: r.species ?? null,
                    col: r.cell?.col ?? null, row: r.cell?.row ?? null, msg: r.msg ?? '',
                })),
                start_census: startCensus,
                fallback_reason: fallbackReason || null,
            });
        } catch (_) { /* capture must never break a turn */ }
    }

    // Spend remaining AP on grass spread across different regions
    _topUpWithGrass(existingCandidates, existingResults) {
        const tm = this.game.turns;
        const grid = this.game.grid;
        const results = [];

        const usedCells = new Set(
            existingResults.filter(r => r.ok).map(r => r.msg.match(/\((\d+),(\d+)\)/)).filter(Boolean).map(m => `${m[1]},${m[2]}`)
        );

        let spots = [];
        grid.forEach(cell => {
            if (cell.terrain === 'WATER') return;
            const existingPlants = cell.organisms.filter(o => CONFIG.SPECIES[o.species]?.type === 'plant').length;
            if (existingPlants >= CONFIG.SIM.PLANT_CAP) return;
            if (usedCells.has(`${cell.col},${cell.row}`)) return;
            spots.push({ cell, score: cell.nutrients * (cell.terrain === 'FERTILE' ? 1.5 : 1) });
        });
        spots.sort((a,b) => b.score - a.score);

        // Pick from different regions
        const usedRegions = new Set();
        const diverse = [];
        for (const s of spots) {
            const r = this._regionOf(s.cell.col, s.cell.row);
            if (!usedRegions.has(r)) {
                diverse.push(s);
                usedRegions.add(r);
            }
        }
        // Backfill if needed
        for (const s of spots) {
            if (!diverse.includes(s)) diverse.push(s);
        }

        for (const s of diverse) {
            if (tm.players[this.player].ap < 1) break;
            tm.spendAP(1);
            const org = createOrganism('GRASS', this.player, s.cell.col, s.cell.row);
            org._placedRound = tm.round;
            s.cell.organisms.push(org);
            tm.recordAction({ type: 'place', species: 'GRASS', col: s.cell.col, row: s.cell.row });
            results.push({ ok: true, cell: s.cell, species: 'GRASS', msg: `Auto: Grass at (${s.cell.col},${s.cell.row}) in ${this._regionOf(s.cell.col, s.cell.row)}` });
        }

        return results;
    }

    // Fallback if LLM is unavailable
    _fallback(candidates, reason = 'offline', startCensus = null) {
        const tm = this.game.turns;
        const plants = candidates.filter(c => c.type === 'plant');
        const results = [];

        for (const c of plants) {
            if (tm.players[this.player].ap < 1) break;
            const existingPlants = c.cell.organisms.filter(o => CONFIG.SPECIES[o.species]?.type === 'plant').length;
            if (existingPlants >= CONFIG.SIM.PLANT_CAP) continue;
            tm.spendAP(1);
            const org = createOrganism('GRASS', this.player, c.cell.col, c.cell.row);
            org._placedRound = tm.round;
            c.cell.organisms.push(org);
            tm.recordAction({ type: 'place', species: 'GRASS', col: c.cell.col, row: c.cell.row });
            results.push({ ok: true, cell: c.cell, species: 'GRASS', msg: `Fallback: Grass at (${c.cell.col},${c.cell.row})` });
        }

        this.game.renderer.render();
        if (startCensus) this._recordTurn(startCensus, 'LLM unavailable — fell back to grass.', '', results);
        return {
            reasoning: 'LLM unavailable — fallback to grass',
            actions: results,
            model: this.model,
            degraded: true,
            failReason: reason,
        };
    }

    // Post-game final statement
    async getFinalStatement(myScore, enemyScore, won) {
        const result = won ? 'WON' : (myScore.finalScore === enemyScore.finalScore ? 'TIED' : 'LOST');

        const oppName = this.opponent && !this.opponent.isHuman ? this.opponent.name
            : this.opponent?.isHuman ? this.opponent.name : 'your opponent';

        const system = `You are an AI who just finished playing Biome, a competitive ecosystem strategy game. You are Player ${this.player}. You were up against ${oppName}. Give a brief, memorable post-game statement — name your opponent. Be a gracious winner or a defiant loser. Reference specific details from the game. Respond ONLY with valid JSON.`;

        const user = `Game over! You ${result} against ${oppName}.

Your final score: ${myScore.finalScore.toLocaleString()} (${myScore.speciesCount} species, multiplier ×${myScore.totalMult.toFixed(2)})
Species: ${myScore.species.join(', ') || 'none'}
${myScore.hasTrophic ? 'You achieved the trophic chain bonus!' : 'No trophic chain bonus.'}

Opponent score: ${enemyScore.finalScore.toLocaleString()} (${enemyScore.speciesCount} species, multiplier ×${enemyScore.totalMult.toFixed(2)})

JSON: {"statement":"<your 1-2 sentence post-game comment, be original and reference the actual scores/species>"}`;

        try {
            const out = await this._callOllama(system, user);
            return out.parsed.statement || '';
        } catch {
            return won ? 'A well-played game.' : 'Next time will be different.';
        }
    }
}

// Fetch available models from Ollama (filters out embedding/vision-only models)
const EMBED_PATTERNS = /embed|nomic|mxbai|bge-|moondream/i;

export async function listOllamaModels() {
    try {
        // Use local proxy instead of direct Ollama URL for CORS
        const resp = await fetch('/ollama/api/tags');
        if (!resp.ok) return [];
        const data = await resp.json();
        const all = data.models
            .map(m => ({ name: m.name, size: m.size }))
            .filter(m => !EMBED_PATTERNS.test(m.name));
        // Sort: cloud models first, then alphabetically
        all.sort((a, b) => {
            const ac = a.name.includes('cloud') ? 0 : 1;
            const bc = b.name.includes('cloud') ? 0 : 1;
            if (ac !== bc) return ac - bc;
            return a.name.localeCompare(b.name);
        });
        return all;
    } catch {
        return [];
    }
}

// Pull a model via Ollama. Returns a promise that resolves when done.
export async function pullModel(modelName, onProgress) {
    try {
        const resp = await fetch('/ollama/api/pull', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: modelName, stream: true }),
        });

        if (!resp.ok) {
            const err = await resp.text();
            throw new Error(`Pull failed: ${resp.status} ${err}`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let lastStatus = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            for (const line of text.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const obj = JSON.parse(line);
                    if (obj.status) lastStatus = obj.status;
                    if (onProgress) onProgress(obj.status, obj.completed, obj.total);
                } catch { /* skip malformed lines */ }
            }
        }
        return { success: true, status: lastStatus };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ── Model residency lifecycle (warming / unloading / inspection) ──────────────
// All of these resolve and never throw — warming must never block or fail a
// match. Cloud (:cloud) models have no local footprint, so they're skipped.

// Preload a model into memory WITHOUT generating, and ask Ollama to keep it
// resident. An empty-prompt /api/generate returns once the model is loaded
// (done_reason "load"), so awaiting this moves cold-load time out of the
// per-turn budget. Accepts an AbortSignal so a restart can cancel an in-flight warm.
export async function warmModel(model, { keepAlive = MATCH_KEEP_ALIVE, signal } = {}) {
    if (!model || isCloudModel(model)) return { ok: true, skipped: true };
    try {
        const resp = await fetch('/ollama/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({ model, keep_alive: keepAlive, prompt: '', stream: false }),
        });
        if (!resp.ok) return { ok: false, error: `warm ${resp.status}: ${await resp.text()}` };
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}

// Evict a model from memory immediately (keep_alive:0). Best-effort.
export async function unloadModel(model) {
    if (!model || isCloudModel(model)) return { ok: true, skipped: true };
    try {
        await fetch('/ollama/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, keep_alive: 0, prompt: '', stream: false }),
        });
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e?.message || String(e) };
    }
}

// Models currently resident in Ollama. Each: { name, size, size_vram, expires_at }.
export async function listResidentModels() {
    try {
        const resp = await fetch('/ollama/api/ps');
        if (!resp.ok) return [];
        const data = await resp.json();
        return Array.isArray(data.models) ? data.models : [];
    } catch {
        return [];
    }
}

// Normalize a model name for residency comparison — /api/ps may report a
// `:latest` tag the caller's bare name omits (mirrors tournament.js norm).
function _normModel(name) {
    return String(name || '').replace(/:latest$/, '');
}

// Is this model currently loaded in Ollama? Cloud models are always "ready"
// (no local VRAM load), so they report resident. Drives the per-turn "loading
// model…" indicator: an empty /api/ps (cold, or unreachable) reads as not
// resident, which the watcher self-corrects once the model finishes loading.
export async function isModelResident(model) {
    if (!model || isCloudModel(model)) return true;
    const target = _normModel(model);
    const resident = await listResidentModels();
    return resident.some(m => _normModel(m.name) === target);
}

// "Warm the next match only" lifecycle. Given the local models the upcoming
// match needs, evicts every OTHER resident local model and warms the needed
// ones that aren't already resident — keeping peak residency at the match's
// model count. ps-driven so it self-heals partial prior state (e.g. an aborted
// warm). A winner advancing is in `neededModels`, so it's never unloaded/reloaded.
// Returns { warmed:[], unloaded:[], failures:[] }. Never throws.
export async function prepareResidentSet(neededModels, { signal } = {}) {
    const needed = [...new Set((neededModels || []).filter(m => m && !isCloudModel(m)))];
    const neededNorm = new Set(needed.map(_normModel));

    const resident = await listResidentModels();
    const residentNorm = new Set(resident.map(m => _normModel(m.name)));

    const toUnload = resident
        .map(m => m.name)
        .filter(name => !neededNorm.has(_normModel(name)));
    const toWarm = needed.filter(m => !residentNorm.has(_normModel(m)));

    const [unloadRes, warmRes] = await Promise.all([
        Promise.all(toUnload.map(m => unloadModel(m))),
        Promise.all(toWarm.map(m => warmModel(m, { signal }))),
    ]);

    const failures = warmRes
        .map((r, i) => (r && !r.ok && !r.skipped) ? { model: toWarm[i], error: r.error } : null)
        .filter(Boolean);
    if (failures.length) {
        console.warn('[warm] some models failed to preload (match continues):', failures);
    }
    return { warmed: toWarm, unloaded: toUnload, failures };
}

// Human-readable model sizes
export function formatModelSize(bytes) {
    if (!bytes) return '';
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)} MB`;
}

// Recommended models curated for Biome — good instruction following + JSON mode
export const RECOMMENDED_MODELS = [
    { name: 'qwen2.5:3b',       desc: 'Fast, small — good for quick matches',       size: '~2 GB' },
    { name: 'qwen2.5:7b',       desc: 'Balanced — best size/performance ratio',      size: '~5 GB' },
    { name: 'qwen2.5:14b',      desc: 'Strong strategy — the default model',         size: '~9 GB' },
    { name: 'llama3.1:8b',      desc: 'Popular general-purpose model',               size: '~5 GB' },
    { name: 'gemma2:9b',        desc: 'Google model, good instruction following',    size: '~5 GB' },
    { name: 'mistral:7b',       desc: 'Fast responses, decent strategy',             size: '~4 GB' },
    { name: 'phi3:medium',      desc: 'Microsoft model, compact but capable',        size: '~8 GB' },
    { name: 'deepseek-r1:7b',   desc: 'Reasoning model — slower but thorough',       size: '~5 GB' },
];
