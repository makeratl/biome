// Biome — main entry point

import { CONFIG } from './config.js';
import { HexGrid } from './grid.js';
import { generateTerrain, TERRAIN_TYPES } from './terrain.js';
import { Renderer } from './renderer.js';
import { Simulation } from './simulation.js';
import { createOrganism, getAllSpecies } from './species.js';
import { TurnManager, PHASE } from './turn.js';
import { AIPlayer, listOllamaModels } from './ai.js';
import { TournamentManager } from './tournament.js';

class Game {
    constructor() {
        this.canvas = document.getElementById('game-canvas');
        this.seed = Math.floor(Math.random() * 100000);
        this.grid = new HexGrid(CONFIG.GRID_COLS, CONFIG.GRID_ROWS, CONFIG.HEX_SIZE);
        this.renderer = new Renderer(this.canvas, this.grid);
        this.simulation = new Simulation(this.grid);
        this.selectedSpecies = null;
        this.simulating = false;
        this.turns = new TurnManager((phase) => this._onPhaseChange(phase));
        this.aiPlayers = {};   // { playerNum: AIPlayer }
        this._aiThinking = false;
        this._scoreHistory = []; // [{ round, p1, p2 }, ...]
        this._matchResolve = null; // set during tournament games
        this.tournament = new TournamentManager(this);

        this._init();
    }

    _init() {
        generateTerrain(this.grid, this.seed);
        this.renderer.render();
        this._buildSpeciesPalette();
        this._bindEvents();
        this._updateWorldInfo();
        this._scoreHistory = [];
        this._updateCensus();

        // Start the game
        this.turns.startGame();

        console.log(`Biome initialized — seed: ${this.seed}`);
    }

    _buildSpeciesPalette() {
        const palette = document.getElementById('species-palette');
        palette.innerHTML = '';

        const species = getAllSpecies();
        for (const sp of species) {
            const card = document.createElement('div');
            card.className = 'species-card';
            card.dataset.species = sp.key;
            card.innerHTML = `
                <div class="name">${sp.name}</div>
                <div class="type">${sp.type}</div>
                <div class="cost">${sp.apCost} AP</div>
            `;
            card.addEventListener('click', () => this._selectSpecies(sp.key, card));
            palette.appendChild(card);
        }
    }

    _selectSpecies(key, card) {
        document.querySelectorAll('.species-card.selected').forEach(c => c.classList.remove('selected'));

        if (this.selectedSpecies === key) {
            this.selectedSpecies = null;
        } else {
            this.selectedSpecies = key;
            card.classList.add('selected');
        }
    }

    _bindEvents() {
        this.canvas.addEventListener('mousemove', (e) => this._onHover(e));
        this.canvas.addEventListener('click', (e) => this._onClick(e));

        document.getElementById('btn-end-turn').addEventListener('click', () => {
            if (this.turns.isPlayerTurn()) {
                this.turns.endTurn();
            }
        });

        document.getElementById('btn-new-game').addEventListener('click', () => {
            this.seed = Math.floor(Math.random() * 100000);
            this.grid = new HexGrid(CONFIG.GRID_COLS, CONFIG.GRID_ROWS, CONFIG.HEX_SIZE);
            this.renderer = new Renderer(this.canvas, this.grid);
            this.simulation = new Simulation(this.grid);
            this.turns = new TurnManager((phase) => this._onPhaseChange(phase));
            this._init();
        });

        document.getElementById('btn-tournament')?.addEventListener('click', () => {
            this._startTournament();
        });

        // AI toggle buttons — each player has its own model dropdown
        for (const btn of document.querySelectorAll('.ai-toggle')) {
            btn.addEventListener('click', () => {
                const p = parseInt(btn.dataset.player);
                if (this.aiPlayers[p]) {
                    this.removeAI(p);
                    btn.textContent = `P${p}: Human`;
                    btn.classList.remove('ai-active');
                } else {
                    const select = document.getElementById(`ai-model-p${p}`);
                    const model = select?.value;
                    if (!model) {
                        this._log('No model selected — is Ollama running?');
                        return;
                    }
                    this.setAI(p, model);
                    // Show truncated model name on button
                    const short = model.replace(/:latest$/, '').slice(0, 16);
                    btn.textContent = `P${p}: ${short}`;
                    btn.title = model;
                    btn.classList.add('ai-active');
                }
            });
        }

        // Populate model dropdown
        this._populateModelDropdown();
    }

    _isAIvsAI() {
        return !!(this.aiPlayers[1] && this.aiPlayers[2]);
    }

    _onPhaseChange(phase) {
        const aiVsAi = this._isAIvsAI();

        if (phase === PHASE.PLAYER_1_TURN) {
            this.renderer.clearFog();
            // In AI vs AI, highlight P1's placements this round
            if (aiVsAi) {
                this.renderer.setHighlightRound(this.turns.round);
            } else {
                this.renderer.clearHighlightRound();
            }
            // Check if P1 is AI
            if (this.aiPlayers[1]) {
                this._runAITurn(1);
            }
        } else if (phase === PHASE.PLAYER_2_TURN) {
            if (aiVsAi) {
                // No fog in AI vs AI — keep highlights on so both sets show
                this.renderer.setHighlightRound(this.turns.round);
            } else {
                // Fog of war: hide P1's new placements from P2
                this.renderer.setFog(this.turns.round, 1);
            }
            this.renderer.render();
            this._updateCensus();
            // Check if P2 is AI
            if (this.aiPlayers[2]) {
                this._runAITurn(2);
            } else {
                this._log('P1 placements hidden — place your organisms');
            }
        } else if (phase === PHASE.SIMULATING) {
            // Reveal all, clear fog, keep highlights briefly for the reveal pause
            this.renderer.clearFog();
            this.renderer.render();
            this._updateCensus();
            this._log(aiVsAi ? 'Both AI turns complete — simulating...' : 'All placements revealed!');
            this._updateTurnUI();
            // Clear highlights after a longer pause in AI vs AI so spectator can study
            const revealDelay = aiVsAi ? 2500 : 800;
            setTimeout(() => {
                this.renderer.clearHighlightRound();
                this._runSimulation();
            }, revealDelay);
            return;
        } else if (phase === PHASE.ROUND_END) {
            this.renderer.clearHighlightRound();
            // Brief pause then auto-advance
            setTimeout(() => this.turns.nextRound(), 600);
        } else if (phase === PHASE.GAME_OVER) {
            this.renderer.clearHighlightRound();
            this._showGameOver();
        }

        this._updateTurnUI();
    }

    _onHover(e) {
        if (this.simulating) return;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const cell = this.renderer.getCellAtPixel(x, y);

        this.renderer.render();
        if (cell) {
            const canPlace = this.turns.isPlayerTurn() && this.selectedSpecies && cell.terrain !== TERRAIN_TYPES.WATER;
            const color = canPlace ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.12)';
            this.renderer.highlightCell(cell, color);
            this._updateCellInfo(cell);
        }
    }

    _onClick(e) {
        if (!this.turns.canPlaceOrganism()) return;
        if (this.simulating) return;

        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const cell = this.renderer.getCellAtPixel(x, y);

        if (!cell || !this.selectedSpecies) return;
        if (cell.terrain === TERRAIN_TYPES.WATER) {
            this._log('Cannot place in water');
            return;
        }

        const template = CONFIG.SPECIES[this.selectedSpecies];

        // Check AP
        if (this.turns.currentAP < template.apCost) {
            this._log(`Not enough AP (need ${template.apCost}, have ${this.turns.currentAP})`);
            return;
        }

        // Check plant cap per cell
        if (template.type === 'plant') {
            const existingPlants = cell.organisms.filter(o => CONFIG.SPECIES[o.species]?.type === 'plant');
            if (existingPlants.length >= 2) {
                this._log('Cell already has maximum plants');
                return;
            }
        }

        // Spend AP and place
        this.turns.spendAP(template.apCost);
        const player = this.turns.currentPlayer;
        const org = createOrganism(this.selectedSpecies, player, cell.col, cell.row);
        org._placedRound = this.turns.round;
        cell.organisms.push(org);

        this.renderer.render();
        this._updateCensus();
        this._updateTurnUI();
        this._log(`P${player} placed ${template.name} at (${cell.col}, ${cell.row})`);
    }

    async _runSimulation() {
        this.simulating = true;
        const steps = CONFIG.SIM.STEPS_PER_TURN;

        this._log(`Simulating ${steps} steps...`);

        for (let i = 0; i < steps; i++) {
            this.simulation.step();
            this.renderer.render();
            this._updateCensus();
            await this._sleep(CONFIG.SIM.ANIMATION_STEP_MS);
        }

        this.simulating = false;
        this._log(`Round ${this.turns.round} simulation complete`);
        this.turns.simulationComplete();
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _log(msg) {
        const log = document.getElementById('action-log');
        const entry = document.createElement('div');
        entry.className = 'entry';
        entry.textContent = msg;
        log.insertBefore(entry, log.firstChild);
        while (log.children.length > 60) log.removeChild(log.lastChild);
    }

    _logStyled(msg, className) {
        const log = document.getElementById('action-log');
        const entry = document.createElement('div');
        entry.className = `entry ${className}`;
        entry.textContent = msg;
        log.insertBefore(entry, log.firstChild);
        while (log.children.length > 60) log.removeChild(log.lastChild);
    }

    _updateTurnUI() {
        const player = this.turns.currentPlayer;
        const phase = this.turns.phase;

        // Player indicator
        const playerEl = document.getElementById('current-player');
        if (player && this._aiThinking) {
            const model = this.aiPlayers[player]?.model || 'AI';
            playerEl.textContent = `P${player} ${model} thinking...`;
            playerEl.className = `player-indicator p${player} ai-thinking`;
        } else if (player) {
            const ai = this.aiPlayers[player];
            playerEl.textContent = ai ? `P${player} (${ai.model})` : `Player ${player}`;
            playerEl.className = `player-indicator p${player}`;
        } else if (phase === PHASE.SIMULATING) {
            playerEl.textContent = 'Simulating';
            playerEl.className = 'player-indicator sim';
        } else if (phase === PHASE.GAME_OVER) {
            playerEl.textContent = 'Game Over';
            playerEl.className = 'player-indicator';
        }

        // Round and AP
        const roundEl = document.getElementById('round-info');
        roundEl.textContent = `Round ${this.turns.round} / ${this.turns.totalRounds}`;

        const apEl = document.getElementById('ap-display');
        if (player) {
            apEl.textContent = `${this.turns.currentAP} AP remaining`;
            apEl.style.display = '';
        } else {
            apEl.style.display = 'none';
        }

        // End turn button
        const btn = document.getElementById('btn-end-turn');
        btn.disabled = !this.turns.isPlayerTurn();
        if (player) {
            btn.textContent = `End P${player} Turn`;
        } else {
            btn.textContent = 'End Turn';
        }

        // Fog / highlight indicator
        const fogEl = document.getElementById('fog-indicator');
        if (fogEl) {
            if (this.renderer._fogPlayer > 0) {
                fogEl.textContent = `P${this.renderer._fogPlayer} placements hidden`;
                fogEl.style.display = '';
            } else if (this.renderer._highlightRound >= 0) {
                fogEl.textContent = `Round ${this.renderer._highlightRound} — new placements highlighted`;
                fogEl.style.display = '';
            } else {
                fogEl.style.display = 'none';
            }
        }
    }

    _updateWorldInfo() {
        const info = document.getElementById('info-content');
        const counts = { WATER: 0, FERTILE: 0, GRASSLAND: 0, ROCKY: 0 };
        this.grid.forEach(cell => { counts[cell.terrain]++; });

        info.innerHTML = `
            <div class="info-row"><span>Seed</span><span>${this.seed}</span></div>
            <div class="info-row"><span>Grid</span><span>${CONFIG.GRID_COLS} x ${CONFIG.GRID_ROWS}</span></div>
            <div class="info-divider"></div>
            <div class="info-row"><span>Water</span><span>${counts.WATER}</span></div>
            <div class="info-row"><span>Fertile</span><span>${counts.FERTILE}</span></div>
            <div class="info-row"><span>Grassland</span><span>${counts.GRASSLAND}</span></div>
            <div class="info-row"><span>Rocky</span><span>${counts.ROCKY}</span></div>
        `;
    }

    _updateCellInfo(cell) {
        const cellInfo = document.getElementById('cell-info');
        const visible = cell.organisms.filter(o => !this.renderer.isHidden(o));
        const orgs = visible.map(o => {
            const t = CONFIG.SPECIES[o.species];
            return `P${o.player} ${t?.name || o.species} (${Math.round(o.energy)})`;
        }).join('<br>');

        cellInfo.innerHTML = `
            <div class="info-row"><span>Position</span><span>(${cell.col}, ${cell.row})</span></div>
            <div class="info-row"><span>Terrain</span><span>${cell.terrain}</span></div>
            <div class="info-row"><span>Nutrients</span><span>${cell.nutrients.toFixed(2)}</span></div>
            <div class="info-row"><span>Organisms</span><span>${visible.length}</span></div>
            ${orgs ? `<div class="info-divider"></div><div style="font-size:10px;color:#aaa;">${orgs}</div>` : ''}
        `;
    }

    _updateScoreboard() {
        const scores = this.simulation.finalScore();
        const s1 = scores[1], s2 = scores[2];
        const round = this.turns.round;
        const total = this.turns.totalRounds;

        const p1Short = this.aiPlayers[1]
            ? this.aiPlayers[1].model.replace(/:.*$/, '').split('/').pop()
            : 'Player 1';
        const p2Short = this.aiPlayers[2]
            ? this.aiPlayers[2].model.replace(/:.*$/, '').split('/').pop()
            : 'Player 2';

        const fmt = n => n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n);

        const nameEl1 = document.getElementById('sb-name-p1');
        const nameEl2 = document.getElementById('sb-name-p2');
        const scoreEl1 = document.getElementById('sb-score-p1');
        const scoreEl2 = document.getElementById('sb-score-p2');
        const roundEl  = document.getElementById('sb-round');
        const leadEl   = document.getElementById('sb-lead');

        if (!nameEl1) return;

        nameEl1.textContent = p1Short;
        nameEl2.textContent = p2Short;
        scoreEl1.textContent = fmt(s1.finalScore);
        scoreEl2.textContent = fmt(s2.finalScore);
        roundEl.textContent = `Round ${round} / ${total}`;

        scoreEl1.className = 'sb-score' + (s1.finalScore > s2.finalScore ? ' winning' : '');
        scoreEl2.className = 'sb-score' + (s2.finalScore > s1.finalScore ? ' winning' : '');

        const diff = Math.abs(s1.finalScore - s2.finalScore);
        if (diff === 0) {
            leadEl.textContent = 'Tied';
            leadEl.className = 'sb-lead tied';
        } else if (s1.finalScore > s2.finalScore) {
            leadEl.textContent = `+${fmt(diff)}`;
            leadEl.className = 'sb-lead p1';
        } else {
            leadEl.textContent = `+${fmt(diff)}`;
            leadEl.className = 'sb-lead p2';
        }

        // Record history (one entry per round, overwrite if same round)
        const last = this._scoreHistory[this._scoreHistory.length - 1];
        if (!last || last.round !== round) {
            this._scoreHistory.push({ round, p1: s1.finalScore, p2: s2.finalScore });
        } else {
            last.p1 = s1.finalScore;
            last.p2 = s2.finalScore;
        }
        this._drawScoreChart();
    }

    _drawScoreChart() {
        const canvas = document.getElementById('score-chart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        const history = this._scoreHistory;
        const total = this.turns.totalRounds || 20;

        ctx.clearRect(0, 0, W, H);

        if (history.length < 1) return;

        // Axis guides
        const pad = { t: 4, r: 4, b: 4, l: 4 };
        const gw = W - pad.l - pad.r;
        const gh = H - pad.t - pad.b;

        const maxScore = Math.max(...history.map(h => Math.max(h.p1, h.p2)), 1);

        const xOf = round => pad.l + ((round - 1) / (total - 1)) * gw;
        const yOf = score => pad.t + gh - (score / maxScore) * gh;

        // Subtle grid lines
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = pad.t + (gh / 4) * i;
            ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + gw, y); ctx.stroke();
        }

        // Round tick marks along bottom
        for (let r = 1; r <= total; r += 4) {
            const x = xOf(r);
            ctx.strokeStyle = 'rgba(255,255,255,0.1)';
            ctx.beginPath(); ctx.moveTo(x, pad.t + gh); ctx.lineTo(x, pad.t + gh + 3); ctx.stroke();
        }

        // Draw a player line
        const drawLine = (key, color) => {
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            ctx.beginPath();
            history.forEach((h, i) => {
                const x = xOf(h.round), y = yOf(h[key]);
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            });
            ctx.stroke();

            // Dot at current position
            const last = history[history.length - 1];
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(xOf(last.round), yOf(last[key]), 3, 0, Math.PI * 2);
            ctx.fill();
        };

        drawLine('p1', 'hsl(190, 70%, 60%)');
        drawLine('p2', 'hsl(25, 75%, 62%)');
    }

    _updateCensus() {
        this._updateScoreboard();
        const census = this.simulation.census();
        const el = document.getElementById('census-content');
        if (!el) return;

        const p1Label = this.aiPlayers[1] ? `P1 (${this.aiPlayers[1].model})` : 'Player 1';
        const p2Label = this.aiPlayers[2] ? `P2 (${this.aiPlayers[2].model})` : 'Player 2';

        el.innerHTML = `
            <div class="census-player p1">
                <div class="census-label">${p1Label}</div>
                <div class="info-row"><span>Plants</span><span>${census[1].plants}</span></div>
                <div class="info-row"><span>Herbivores</span><span>${census[1].herbivores}</span></div>
                <div class="info-row"><span>Predators</span><span>${census[1].predators}</span></div>
                <div class="info-row biomass"><span>Biomass</span><span>${Math.round(census[1].biomass)}</span></div>
            </div>
            <div class="census-player p2">
                <div class="census-label">${p2Label}</div>
                <div class="info-row"><span>Plants</span><span>${census[2].plants}</span></div>
                <div class="info-row"><span>Herbivores</span><span>${census[2].herbivores}</span></div>
                <div class="info-row"><span>Predators</span><span>${census[2].predators}</span></div>
                <div class="info-row biomass"><span>Biomass</span><span>${Math.round(census[2].biomass)}</span></div>
            </div>
        `;
    }

    async _showGameOver() {
        const scores = this.simulation.finalScore();

        // Tournament mode: hand result back to the tournament runner
        if (this._matchResolve) {
            const resolve = this._matchResolve;
            this._matchResolve = null;
            resolve(scores);
            return;
        }

        const s1 = scores[1], s2 = scores[2];

        const p1Label = this.aiPlayers[1] ? `P1 (${this.aiPlayers[1].model})` : 'Player 1';
        const p2Label = this.aiPlayers[2] ? `P2 (${this.aiPlayers[2].model})` : 'Player 2';

        let winnerLabel;
        if (s1.finalScore > s2.finalScore) winnerLabel = `${p1Label} wins!`;
        else if (s2.finalScore > s1.finalScore) winnerLabel = `${p2Label} wins!`;
        else winnerLabel = "It's a tie!";

        const breakdown = (label, s, statementId) => {
            let html = `<div class="score-block"><div class="score-name">${label}</div>`;
            html += `<div class="score-row"><span>Weighted biomass</span><span>${Math.round(s.rawBiomass)}</span></div>`;
            html += `<div class="score-row"><span>Species (${s.speciesCount})</span><span>×${s.diversityMult.toFixed(2)}</span></div>`;
            html += `<div class="score-row"><span>Trophic chain</span><span>${s.hasTrophic ? '×' + s.trophicMult.toFixed(2) : '—'}</span></div>`;
            html += `<div class="score-row final"><span>Final Score</span><span>${s.finalScore.toLocaleString()}</span></div>`;
            html += `<div class="score-species">${s.species.join(', ') || 'none'}</div>`;
            html += `<div id="${statementId}" class="final-statement">...</div>`;
            html += `</div>`;
            return html;
        };

        const overlay = document.getElementById('game-over-overlay');
        overlay.style.display = 'flex';
        overlay.querySelector('.winner').textContent = winnerLabel;
        overlay.querySelector('.final-score').innerHTML =
            breakdown(p1Label, s1, 'final-stmt-p1') + breakdown(p2Label, s2, 'final-stmt-p2');

        document.getElementById('btn-play-again').addEventListener('click', () => {
            overlay.style.display = 'none';
            document.getElementById('btn-new-game').click();
        });

        // Request final statements from AI players (in parallel)
        const requests = [];
        for (const p of [1, 2]) {
            const ai = this.aiPlayers[p];
            if (!ai) continue;
            const my = scores[p], enemy = scores[p === 1 ? 2 : 1];
            const won = my.finalScore > enemy.finalScore;
            requests.push(
                ai.getFinalStatement(my, enemy, won).then(stmt => {
                    const el = document.getElementById(`final-stmt-p${p}`);
                    if (el) el.textContent = `"${stmt}"`;
                    // Also update the map overlay
                    const bEl = document.getElementById(`ai-banter-p${p}`);
                    const sEl = document.getElementById(`ai-strategy-p${p}`);
                    if (bEl) bEl.textContent = `"${stmt}"`;
                    if (sEl) sEl.textContent = won ? 'Victory.' : 'Defeated.';
                })
            );
        }
        if (requests.length > 0) await Promise.all(requests);
    }

    // ── AI integration ───────────────────────────────────────

    async _runAITurn(playerNum) {
        const ai = this.aiPlayers[playerNum];
        if (!ai) return;

        this._aiThinking = true;
        this._log(`P${playerNum} AI (${ai.model}) thinking...`);

        // Update overlay label with model name
        const labelEl = document.querySelector(`#ai-overlay-p${playerNum} .ai-overlay-label`);
        if (labelEl) {
            const short = ai.model.replace(/:latest$/, '');
            labelEl.textContent = short;
        }

        // Show thinking state in commentary panel
        const bEl = document.getElementById(`ai-banter-p${playerNum}`);
        const sEl = document.getElementById(`ai-strategy-p${playerNum}`);
        if (bEl) bEl.textContent = 'Thinking...';
        if (sEl) sEl.textContent = '';

        this._updateTurnUI();

        // Brief delay so the UI updates before the async call
        await this._sleep(300);

        const result = await ai.takeTurn();

        this._aiThinking = false;

        // Update commentary panels — keep previous text if LLM returns nothing
        if (bEl && result.banter) bEl.textContent = `"${result.banter}"`;
        else if (bEl) bEl.textContent = '';  // clear "Thinking..."
        if (sEl && result.reasoning) sEl.textContent = result.reasoning;

        // Log banter to action log too
        if (result.banter) {
            this._logStyled(`P${playerNum}: "${result.banter}"`, `banter p${playerNum}`);
        }
        if (result.reasoning) {
            this._logStyled(`P${playerNum} strategy: ${result.reasoning}`, 'strategy');
        }

        // Log individual actions
        const okActions = result.actions.filter(a => a.ok);
        const species = {};
        for (const a of okActions) {
            const match = a.msg.match(/^(?:Auto: )?(\w+) at/);
            if (match) species[match[1]] = (species[match[1]] || 0) + 1;
        }
        const summary = Object.entries(species).map(([s, n]) => `${n}× ${s}`).join(', ');
        if (summary) this._log(`P${playerNum} placed: ${summary}`);

        this.renderer.render();
        this._updateCensus();
        this._updateTurnUI();

        // Longer pause in AI vs AI so spectator can study each player's moves
        const pause = this._isAIvsAI() ? 2000 : 800;
        await this._sleep(pause);
        this.turns.endTurn();
    }

    setAI(playerNum, model) {
        this.aiPlayers[playerNum] = new AIPlayer(this, playerNum, { model });
        this._log(`P${playerNum} is now AI (${model})`);
    }

    removeAI(playerNum) {
        delete this.aiPlayers[playerNum];
        this._log(`P${playerNum} is now Human`);
    }

    async _populateModelDropdown() {
        const selects = [
            document.getElementById('ai-model-p1'),
            document.getElementById('ai-model-p2'),
        ].filter(Boolean);
        if (selects.length === 0) return;

        const models = await listOllamaModels();

        for (const select of selects) {
            select.innerHTML = '';

            if (models.length === 0) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'No models found';
                select.appendChild(opt);
                continue;
            }

            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m.name;
                opt.textContent = m.name;
                select.appendChild(opt);
            }
        }

        // Set defaults — prefer cloud models, pick two different ones
        if (models.length > 0) {
            const cloud = models.filter(m => m.name.includes('cloud'));
            const p1Default = cloud[0] || models[0];
            const p2Default = cloud[1] || cloud[0] || models[Math.min(1, models.length - 1)];

            if (selects[0]) selects[0].value = p1Default.name;
            if (selects[1] && p2Default.name !== p1Default.name) selects[1].value = p2Default.name;
            else if (selects[1]) selects[1].value = models[Math.min(1, models.length - 1)].name;
        }
    }

    // ── Tournament support ────────────────────────────────────

    resetForMatch() {
        // Clear all organisms
        this.grid.forEach(cell => { cell.organisms = []; });

        // Fresh terrain
        this.seed = Math.floor(Math.random() * 100000);
        generateTerrain(this.grid, this.seed);

        // Reset turn state
        this.turns.round = 0;
        this.turns.phase = 'SETUP';
        this.turns.players[1] = { ap: 0, actions: [] };
        this.turns.players[2] = { ap: 0, actions: [] };

        // Clear AI players and callbacks
        this.aiPlayers = {};
        this._matchResolve = null;
        this._scoreHistory = [];
        this.simulating = false;

        // Clear overlays
        ['p1','p2'].forEach(p => {
            const b = document.getElementById(`ai-banter-${p}`);
            const s = document.getElementById(`ai-strategy-${p}`);
            const lbl = document.querySelector(`#ai-overlay-${p} .ai-overlay-label`);
            if (b) b.textContent = '';
            if (s) s.textContent = '';
            if (lbl) lbl.textContent = p.toUpperCase();
        });
        const log = document.getElementById('action-log');
        if (log) log.innerHTML = '';

        this.renderer.clearFog();
        this.renderer.clearHighlightRound();
        this.renderer.render();
        this._updateWorldInfo();
        this._updateCensus();
    }

    // Returns a Promise that resolves with finalScore() when the game ends
    runFullGame() {
        return new Promise(resolve => { this._matchResolve = resolve; });
    }

    async _startTournament() {
        const models = await listOllamaModels();
        const eligible = models
            .filter(m => !m.name.match(/embed|nomic|mxbai|moondream|coder/i))
            .map(m => m.name);

        if (eligible.length < 2) {
            alert('Need at least 2 models for a tournament.');
            return;
        }

        // Pad to 8 with random repeats if fewer than 8 models
        while (eligible.length < 8) eligible.push(eligible[Math.floor(Math.random() * eligible.length)]);
        const field = eligible.slice(0, 8);

        this.tournament.start(field);
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.game = new Game();
});
