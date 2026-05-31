// AI player module for Biome — uses Ollama for strategic decisions

import { CONFIG } from './config.js';
import { createOrganism } from './species.js';

export class AIPlayer {
    constructor(game, playerNumber, options = {}) {
        this.game = game;
        this.player = playerNumber;
        this.model = options.model || 'qwen2.5:14b';
        // Use local proxy endpoint for CORS bypass
        this.ollamaUrl = options.ollamaUrl || '/ollama';
        this._mapSummary = null;
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

        const plantSpots = [], herbSpots = [], predSpots = [];

        grid.forEach(cell => {
            if (cell.terrain === 'WATER') return;

            const plantsHere = cell.organisms.filter(o => CONFIG.SPECIES[o.species]?.type === 'plant').length;

            // Plant candidates: skip cells at plant cap (2)
            if (plantsHere < 2) {
                let ps = cell.nutrients * (cell.terrain === 'FERTILE' ? 1.5 : 1);
                ps += nearby(cell, ownPlants, 3) * 0.08;
                ps -= nearby(cell, enemyHerbs, 4) * 0.15;
                plantSpots.push({ cell, score: ps });
            }

            // Herbivore/predator candidates: any non-water cell (they can share with plants)
            if (cell.organisms.length === 0 || plantsHere > 0) {
                const ep = nearby(cell, enemyPlants, 5);
                const op = nearby(cell, ownPlants, 5);
                const anyPlants = ep + op;
                const danger = nearby(cell, enemyPreds, 4);
                const herbScore = ep * 0.4 + op * 0.15 - danger * 0.3 + (cell.terrain === 'FERTILE' ? 0.2 : 0);
                herbSpots.push({ cell, score: herbScore, nearEnemyPlants: ep, nearOwnPlants: op, nearPreds: danger });

                const eh = nearby(cell, enemyHerbs, 5);
                const oh = nearby(cell, ownHerbs, 5);
                const predScore = eh * 0.5 + oh * 0.2 + (anyPlants > 3 ? 0.1 : 0);
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

        addSpots(plantSpots, 'plant', ['GRASS','SHRUB','TREE'], '1 AP grass/shrub, 2 AP tree', 3, (s) => {
            const c = s.cell;
            const r = this._regionOf(c.col, c.row);
            const herbs = nearby(c, enemyHerbs, 4);
            let d = `${c.terrain.toLowerCase()} in ${r}, nutrients ${c.nutrients.toFixed(1)}`;
            d += herbs > 0 ? `, ${herbs} enemy herbivores nearby (risky)` : ', safe';
            return d;
        });

        addSpots(herbSpots, 'herbivore', ['GRAZER','BROWSER'], '2 AP (energy counts ×2!)', 3, (s) => {
            const r = this._regionOf(s.cell.col, s.cell.row);
            let d = `${r}`;
            if (s.nearEnemyPlants > 0) d += `, ${s.nearEnemyPlants} enemy plants nearby (raid!)`;
            else if (s.nearOwnPlants > 0) d += `, near ${s.nearOwnPlants} of your plants (builds ×2 biomass)`;
            else d += `, open territory`;
            d += s.nearPreds > 0 ? `, ${s.nearPreds} predators (dangerous)` : '';
            d += ` — adds species diversity +10%`;
            return d;
        });

        addSpots(predSpots, 'predator', ['PREDATOR'], '2 AP (energy counts ×3!)', 2, (s) => {
            const r = this._regionOf(s.cell.col, s.cell.row);
            let d = `${r}`;
            if (s.nearEnemyHerbs > 0) d += `, ${s.nearEnemyHerbs} enemy herbivores to hunt`;
            else if (s.nearOwnHerbs > 0) d += `, ${s.nearOwnHerbs} of your herbivores nearby`;
            else d += `, patrolling territory`;
            d += ` — adds species diversity +10%, enables trophic chain ×1.25!`;
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

    // ── Prompt builder ─────────────────────────────────────────

    _buildPrompt(candidates) {
        const tm = this.game.turns;
        const ap = tm.players[this.player].ap;
        const enemy = this.player === 1 ? 2 : 1;
        const round = tm.round;
        const total = tm.totalRounds;

        // Dynamic strategy guidance based on game state
        const myCensus = this._getCensus(this.player);
        const enemyCensus = this._getCensus(enemy);
        const ahead = myCensus.biomass > enemyCensus.biomass * 1.2;
        const behind = enemyCensus.biomass > myCensus.biomass * 1.2;
        const enemyHasPlants = enemyCensus.plants > 20;
        const enemyHasHerbs = enemyCensus.herbs > 5;

        // Score projection — what their current diversity would yield
        const mySpecies = new Set();
        let myHasPlant = false, myHasHerb = false, myHasPred = false;
        this.game.grid.forEach(cell => {
            for (const org of cell.organisms) {
                if (org.player !== this.player) continue;
                mySpecies.add(org.species);
                const t = CONFIG.SPECIES[org.species]?.type;
                if (t === 'plant') myHasPlant = true;
                else if (t === 'herbivore') myHasHerb = true;
                else if (t === 'predator') myHasPred = true;
            }
        });
        const currentMult = (1 + mySpecies.size * 0.10) * (myHasPlant && myHasHerb && myHasPred ? 1.25 : 1);

        // Phase thresholds scale with the match length (rounds is configurable),
        // so a 5- or 15-round game gets sensible early/mid/late guidance.
        const earlyEnd = Math.max(1, Math.round(total * 0.25));
        const midEnd = Math.max(earlyEnd + 1, Math.round(total * 0.65));

        let phaseAdvice;
        if (round <= earlyEnd) {
            phaseAdvice = `PHASE: EARLY (round ${round}/${total}). You have ${ap} AP.
PRIORITY: Plant grass in DIFFERENT regions (spread seeds wide). Spend most of your AP on grass across separate regions, and at least 1 AP on a shrub for early diversity (+10% species bonus). Remember: each unique species = +10% to your final score!`;
        } else if (round <= midEnd) {
            let advice = `PHASE: MID GAME (round ${round}/${total}). You have ${ap} AP.\n`;
            advice += `Your scoring multiplier: ×${currentMult.toFixed(2)} (${mySpecies.size} species${myHasPlant && myHasHerb && myHasPred ? ' + trophic chain' : ''}).\n`;
            if (!myHasHerb) {
                advice += `You have NO HERBIVORES — adding one gives +10% species bonus and moves toward trophic chain (×1.25). Herbivore energy also counts ×2! Deploy a grazer (2 AP) into enemy territory + 2 grass.\n`;
            } else if (!myHasPred && enemyHasHerbs) {
                advice += `You have no predators. Enemy has ${enemyCensus.herbs} herbivores. A PREDATOR gives +10% species bonus AND trophic chain ×1.25 AND its energy counts ×3. Deploy one! (2 AP) + 2 grass.\n`;
            } else if (behind && enemyHasPlants) {
                advice += `You are BEHIND. Send GRAZERS into enemy plant territory to destroy biomass. Mix: 1 grazer (2 AP) + 2 grass (2 AP).`;
            } else {
                advice += `Diversify! Add species you don't have yet. Each new species = +10%. Also plant grass in unclaimed regions.`;
            }
            phaseAdvice = advice;
        } else {
            let advice = `PHASE: LATE GAME (round ${round}/${total}). ${total - round} rounds left. You have ${ap} AP.\n`;
            advice += `Your scoring multiplier: ×${currentMult.toFixed(2)} (${mySpecies.size} species${myHasPlant && myHasHerb && myHasPred ? ' + trophic chain' : ''}).\n`;
            if (!myHasPred && myHasHerb) {
                advice += `CRITICAL: Add a PREDATOR for trophic chain bonus (×1.25) + species bonus (+10%). This could swing the entire game!`;
            } else if (!myHasHerb) {
                advice += `Add a GRAZER + PREDATOR if possible to unlock trophic chain (×1.25). Huge scoring opportunity.`;
            } else if (behind) {
                advice += `BEHIND — aggressive grazer raids on enemy plants + ensure your diversity bonuses are maximized.`;
            } else {
                advice += `Protect your lead. Plant grass, ensure all trophic levels survive. Every species alive = +10%.`;
            }
            phaseAdvice = advice;
        }

        const system = `You are an AI playing Biome, a competitive ecosystem strategy game on a hex grid. You are Player ${this.player}. You have a personality — be competitive, witty, and opinionated about your strategy.

GOAL: Maximize your FINAL SCORE after ${total} rounds.

SCORING (this is critical!):
- Weighted biomass: plant energy ×1, herbivore energy ×2, predator energy ×3
- Species diversity: +10% bonus per unique species alive at game end
- Trophic chain bonus: +25% if you have plants AND herbivores AND predators alive
- Example: 5000 weighted biomass × 1.5 (5 species) × 1.25 (trophic) = 9375 final score
- A diverse ecosystem CRUSHES a grass monoculture in scoring!

SPECIES (in-world name → role, cost, behavior):
- Sedgeweave (Grass, 1 AP): Spreads fast. Foundation of any ecosystem. Essential early.
- Thornbloom (Shrub, 1 AP): Moderate spread, tougher. Adds species diversity bonus.
- Spirewood (Tree, 2 AP): Slow spread, high energy (120 max). Immune to grazers. Great late-game anchor.
- Hopgrazer (Grazer, 2 AP): Eats grass & shrubs, prefers enemy plants. Raider + herbivore energy counts ×2.
- Bramblemaw (Browser, 2 AP): Eats shrubs & trees. Slower but energy counts ×2.
- Shadestalker (Predator, 2 AP): Hunts herbivores. Energy counts ×3! Deploy when enemy has herbivores.

VOICE: In your reasoning and banter, prefer the in-world names (Sedgeweave, Thornbloom, Spirewood, Hopgrazer, Bramblemaw, Shadestalker) — they give your trash-talk personality. Roles (Grass/Shrub/Tree/Grazer/Browser/Predator) are fine too. The action JSON below must still use the technical UPPERCASE keys.

STRATEGY: Early rounds plant Sedgeweave for foundation. Mid-game diversify — add Thornbloom, Hopgrazers. Late-game ensure you have all 3 trophic levels for the ×1.25 bonus.

Respond ONLY with valid JSON. No markdown, no explanation outside the JSON.`;

        let moveText = '';
        for (const c of candidates) {
            moveText += `  ${c.label}) [${c.type}] ${c.description} (${c.ap})\n`;
        }
        if (!moveText) moveText = '  No strong candidates — place grass in the best available fertile spot.\n';

        const user = `Round ${round}/${total}. You are Player ${this.player}. AP: ${ap}.

${phaseAdvice}

MAP REGIONS:
${this._generateMapSummary()}
YOUR ECOSYSTEM: ${this._summarizePlayer(this.player)}
ENEMY ECOSYSTEM: ${this._summarizePlayer(enemy)}

CANDIDATE MOVES:
${moveText}
Spend ALL ${ap} AP. Pick a spot letter and a species for each action.

VALID SPECIES NAMES (use EXACTLY one of these, ALL CAPS):
  Plants: GRASS, SHRUB, TREE
  Herbivores: GRAZER, BROWSER
  Predator: PREDATOR

IMPORTANT: Write ORIGINAL reasoning and banter. Reference the CURRENT game state (round ${round}, your species, the score).

JSON format:
{"reasoning":"<strategic analysis>","actions":[{"spot":"A","species":"GRASS"},{"spot":"B","species":"GRAZER"}],"banter":"<competitive comment>"}`;

        return { system, user };
    }

    // ── Ollama API call ────────────────────────────────────────

    _isCloudModel() {
        return /cloud/i.test(this.model);
    }

    _isThinkingModel() {
        // Cloud models route through Ollama's cloud API which tends to use
        // thinking/chain-of-thought; local thinking models include qwen3, glm, kimi
        return this._isCloudModel() || /qwen3|glm|kimi|minimax/i.test(this.model);
    }

    async _callOllama(system, user) {
        const url = `${this.ollamaUrl}/api/chat`;
        // Some models ignore think:false and still use thinking tokens,
        // so budget enough for thinking overhead + JSON content
        const numPredict = this._isCloudModel() ? 1000 : 600;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ],
                format: 'json',
                stream: false,
                think: false,
                options: { temperature: 0.7, num_predict: numPredict },
            }),
        });

        if (!response.ok) {
            throw new Error(`Ollama ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        const content = data.message.content?.trim() || '';
        const thinking = data.message.thinking?.trim() || '';

        // Try to extract valid JSON from a string. Approaches, in order:
        // 1. Direct parse (model obeyed "respond ONLY with JSON")
        // 2. Strip markdown code fences (```json ... ``` or ``` ... ```)
        // 3. Brace-matching scan right-to-left (for models that wrap JSON in prose)
        const extractJSON = (str) => {
            // Try direct parse first
            try { return JSON.parse(str); } catch {}

            // Strip markdown code fences
            const fenced = str.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
            if (fenced) {
                try { return JSON.parse(fenced[1].trim()); } catch {}
            }

            // Right-to-left brace scan — get the model's final JSON output
            const opens = [...str.matchAll(/\{/g)].map(m => m.index).reverse();
            for (const start of opens) {
                // Find the matching closing brace by tracking depth
                let depth = 0;
                for (let i = start; i < str.length; i++) {
                    if (str[i] === '{') depth++;
                    else if (str[i] === '}') depth--;
                    if (depth === 0) {
                        try { return JSON.parse(str.slice(start, i + 1)); } catch { break; }
                    }
                }
            }
            return null;
        };

        // Prefer content field; fall back to thinking field for models that
        // exhaust their token budget on chain-of-thought
        const result = extractJSON(content) || extractJSON(thinking);
        if (!result) {
            throw new Error(`No valid JSON found in response (content:${content.length}b, thinking:${thinking.length}b)`);
        }
        return result;
    }

    // ── Execute actions ────────────────────────────────────────

    _executeActions(actions, candidates) {
        const tm = this.game.turns;
        const lookup = {};
        for (const c of candidates) lookup[c.label] = c;

        const results = [];

        for (const action of actions) {
            const cand = lookup[action.spot?.toUpperCase()];
            if (!cand) { results.push({ ok: false, msg: `Bad spot: ${action.spot}` }); continue; }

            const species = action.species?.toUpperCase();
            const template = CONFIG.SPECIES[species];
            if (!template) { results.push({ ok: false, msg: `Bad species: ${action.species}` }); continue; }

            if (tm.players[this.player].ap < template.apCost) {
                results.push({ ok: false, msg: `Not enough AP for ${species}` });
                continue;
            }

            const cell = cand.cell;
            if (template.type === 'plant') {
                const existingPlants = cell.organisms.filter(o => CONFIG.SPECIES[o.species]?.type === 'plant').length;
                if (existingPlants >= 2) {
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
        const { system, user } = this._buildPrompt(candidates);
        const ap = this.game.turns.players[this.player].ap;

        console.log(`[AI] Round ${this.game.turns.round}, P${this.player}, ${ap} AP, ${candidates.length} candidates`);
        console.log('[AI] Prompt:', user);

        let response;
        try {
            // Cloud models need longer for network roundtrip;
            // thinking models (qwen3, glm) need longer for chain-of-thought
            const timeoutMs = this._isCloudModel() ? 90_000
                            : this._isThinkingModel() ? 75_000
                            : 30_000;
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`AI timeout (${timeoutMs/1000}s)`)), timeoutMs)
            );
            response = await Promise.race([this._callOllama(system, user), timeout]);
        } catch (err) {
            console.error('[AI] Ollama error:', err.message);
            return this._fallback(candidates);
        }

        if (!response?.actions) {
            console.error('[AI] Bad response (no actions):', JSON.stringify(response));
            return this._fallback(candidates);
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

        return {
            reasoning: response.reasoning || '',
            banter: response.banter || '',
            actions: results,
            model: this.model,
        };
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
            if (existingPlants >= 2) return;
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
    _fallback(candidates) {
        const tm = this.game.turns;
        const plants = candidates.filter(c => c.type === 'plant');
        const results = [];

        for (const c of plants) {
            if (tm.players[this.player].ap < 1) break;
            const existingPlants = c.cell.organisms.filter(o => CONFIG.SPECIES[o.species]?.type === 'plant').length;
            if (existingPlants >= 2) continue;
            tm.spendAP(1);
            const org = createOrganism('GRASS', this.player, c.cell.col, c.cell.row);
            org._placedRound = tm.round;
            c.cell.organisms.push(org);
            tm.recordAction({ type: 'place', species: 'GRASS', col: c.cell.col, row: c.cell.row });
            results.push({ ok: true, cell: c.cell, species: 'GRASS', msg: `Fallback: Grass at (${c.cell.col},${c.cell.row})` });
        }

        this.game.renderer.render();
        return { reasoning: 'LLM unavailable — fallback to grass', actions: results, model: this.model };
    }

    // Post-game final statement
    async getFinalStatement(myScore, enemyScore, won) {
        const result = won ? 'WON' : (myScore.finalScore === enemyScore.finalScore ? 'TIED' : 'LOST');

        const system = `You are an AI who just finished playing Biome, a competitive ecosystem strategy game. You are Player ${this.player}. Give a brief, memorable post-game statement. Be a gracious winner or a defiant loser. Reference specific details from the game. Respond ONLY with valid JSON.`;

        const user = `Game over! You ${result}.

Your final score: ${myScore.finalScore.toLocaleString()} (${myScore.speciesCount} species, multiplier ×${myScore.totalMult.toFixed(2)})
Species: ${myScore.species.join(', ') || 'none'}
${myScore.hasTrophic ? 'You achieved the trophic chain bonus!' : 'No trophic chain bonus.'}

Opponent score: ${enemyScore.finalScore.toLocaleString()} (${enemyScore.speciesCount} species, multiplier ×${enemyScore.totalMult.toFixed(2)})

JSON: {"statement":"<your 1-2 sentence post-game comment, be original and reference the actual scores/species>"}`;

        try {
            const response = await this._callOllama(system, user);
            return response.statement || '';
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
