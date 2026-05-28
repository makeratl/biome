// Biome — main entry point

import { CONFIG } from './config.js';
import { HexGrid } from './grid.js';
import { generateTerrain, TERRAIN_TYPES } from './terrain.js';
import { Renderer } from './renderer.js';
import { Simulation } from './simulation.js';
import { createOrganism, getAllSpecies } from './species.js';
import { TurnManager, PHASE } from './turn.js';
import { AIPlayer, listOllamaModels, pullModel, formatModelSize, RECOMMENDED_MODELS } from './ai.js';
import { TournamentManager } from './tournament.js';
import { fetchRankings, fetchHistory, renderRankingsPanel, renderHistoryPanel } from './rankings.js';

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
        this._initModelConfig();
        this._initMatchSection();
        this._initLauncher();
        this._updateWorldInfo();
        this._scoreHistory = [];
        this._updateCensus();
        this._updateTurnUI();

        // Show launcher overlay on first load — game does NOT auto-start
        this._openLauncherWelcome();

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
            const subLabel = sp.role.toLowerCase() === sp.type ? sp.type : `${sp.role} · ${sp.type}`;
            card.innerHTML = `
                <div class="name">${sp.name}</div>
                <div class="type">${subLabel}</div>
                <div class="cost">${sp.apCost} AP</div>
            `;
            card.title = `${sp.name} (${sp.role}) — ${sp.type}`;
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
        } else {
            // SETUP / pre-match
            playerEl.textContent = 'Ready';
            playerEl.className = 'player-indicator';
        }

        // Round and AP
        const roundEl = document.getElementById('round-info');
        if (this.turns.round > 0) {
            roundEl.textContent = `Round ${this.turns.round} / ${this.turns.totalRounds}`;
            roundEl.style.visibility = '';
        } else {
            roundEl.style.visibility = 'hidden';
        }

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

        const speciesByType = {
            plant: ['GRASS', 'SHRUB', 'TREE'],
            herbivore: ['GRAZER', 'BROWSER'],
            predator: ['PREDATOR'],
        };

        const subRows = (bySpecies, type) =>
            speciesByType[type]
                .filter(k => bySpecies[k])
                .map(k => `<div class="info-row sub"><span>${CONFIG.SPECIES[k].name}</span><span>${bySpecies[k]}</span></div>`)
                .join('');

        const playerBlock = (label, c, side) => `
            <div class="census-player ${side}">
                <div class="census-label">${label}</div>
                <div class="info-row"><span>Plants</span><span>${c.plants}</span></div>
                ${subRows(c.bySpecies, 'plant')}
                <div class="info-row"><span>Herbivores</span><span>${c.herbivores}</span></div>
                ${subRows(c.bySpecies, 'herbivore')}
                <div class="info-row"><span>Predators</span><span>${c.predators}</span></div>
                ${subRows(c.bySpecies, 'predator')}
                <div class="info-row biomass"><span>Biomass</span><span>${Math.round(c.biomass)}</span></div>
            </div>`;

        el.innerHTML = playerBlock(p1Label, census[1], 'p1') + playerBlock(p2Label, census[2], 'p2');
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
            if (this._lastMatchConfig) {
                this._startMatch(this._lastMatchConfig);
            } else {
                this._expandMatchSection();
                this._openLauncherWelcome();
            }
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

    async _populateModelPickers() {
        const pickerIds = [
            'match-model-p2-solo',
            'match-model-p1-watch',
            'match-model-p2-watch',
        ];
        const selects = pickerIds.map(id => document.getElementById(id)).filter(Boolean);
        if (selects.length === 0) return;

        this._installedModels = await listOllamaModels();

        for (const select of selects) {
            const prevValue = select.value;
            select.innerHTML = '';

            if (this._installedModels.length === 0) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'No models found — is Ollama running?';
                select.appendChild(opt);
                continue;
            }

            for (const m of this._installedModels) {
                const opt = document.createElement('option');
                opt.value = m.name;
                const size = formatModelSize(m.size);
                opt.textContent = size ? `${m.name}  (${size})` : m.name;
                select.appendChild(opt);
            }
            if (prevValue && this._installedModels.some(m => m.name === prevValue)) {
                select.value = prevValue;
            }
        }

        // Set sensible defaults: prefer cloud models, pick two different ones for Watch
        if (this._installedModels.length === 0) return;
        const cloud = this._installedModels.filter(m => m.name.includes('cloud'));
        const first = cloud[0] || this._installedModels[0];
        const second = cloud[1] || (this._installedModels[1] || first);

        const soloP2 = document.getElementById('match-model-p2-solo');
        const watchP1 = document.getElementById('match-model-p1-watch');
        const watchP2 = document.getElementById('match-model-p2-watch');
        if (soloP2 && !soloP2.value) soloP2.value = first.name;
        if (watchP1 && !watchP1.value) watchP1.value = first.name;
        if (watchP2 && !watchP2.value) watchP2.value = second.name;
    }

    // ── Match section (sidebar mode-switcher) ────────────────

    _initMatchSection() {
        this._matchMode = 'solo';
        this._lastMatchConfig = null;

        for (const seg of document.querySelectorAll('.match-mode-segment')) {
            seg.addEventListener('click', () => this._setMatchMode(seg.dataset.mode));
        }

        document.getElementById('btn-start-match').addEventListener('click', () => {
            this._onStartMatchClick();
        });

        document.getElementById('btn-match-expand')?.addEventListener('click', () => {
            this._expandMatchSection();
        });

        this._populateModelPickers();
    }

    _setMatchMode(mode) {
        this._matchMode = mode;
        for (const seg of document.querySelectorAll('.match-mode-segment')) {
            seg.classList.toggle('active', seg.dataset.mode === mode);
        }
        for (const cfg of document.querySelectorAll('.match-config')) {
            cfg.style.display = cfg.dataset.mode === mode ? '' : 'none';
        }
        const startBtn = document.getElementById('btn-start-match');
        if (mode === 'tournament') startBtn.textContent = 'Start Tournament ▶';
        else if (mode === 'watch') startBtn.textContent = 'Start Watch Match ▶';
        else startBtn.textContent = 'Start Match ▶';
    }

    async _onStartMatchClick() {
        // If a match is currently in progress (not game-over), confirm restart
        const running = this.turns.phase && this.turns.phase !== 'SETUP'
            && this.turns.phase !== PHASE.GAME_OVER;
        if (running) {
            const ok = window.confirm('A match is in progress. Start a new match?');
            if (!ok) return;
        }

        if (this._matchMode === 'tournament') {
            this._startTournament();
            return;
        }

        const cfg = { mode: this._matchMode };
        if (this._matchMode === 'solo') {
            cfg.p2Model = document.getElementById('match-model-p2-solo').value;
        } else if (this._matchMode === 'watch') {
            cfg.p1Model = document.getElementById('match-model-p1-watch').value;
            cfg.p2Model = document.getElementById('match-model-p2-watch').value;
        }
        this._startMatch(cfg);
    }

    _startMatch(config) {
        this._lastMatchConfig = config;

        // Reset world: fresh seed, terrain, simulation, turn manager
        this.seed = Math.floor(Math.random() * 100000);
        this.grid = new HexGrid(CONFIG.GRID_COLS, CONFIG.GRID_ROWS, CONFIG.HEX_SIZE);
        this.renderer = new Renderer(this.canvas, this.grid);
        this.simulation = new Simulation(this.grid);
        this.turns = new TurnManager((phase) => this._onPhaseChange(phase));
        this.aiPlayers = {};
        this._matchResolve = null;
        this._scoreHistory = [];
        this.simulating = false;

        generateTerrain(this.grid, this.seed);
        this.renderer.render();
        this._updateWorldInfo();

        // Configure AI players based on mode
        if (config.mode === 'solo' && config.p2Model) {
            this.setAI(2, config.p2Model);
            this._rememberRecentModel(config.p2Model);
        } else if (config.mode === 'watch') {
            if (config.p1Model) {
                this.setAI(1, config.p1Model);
                this._rememberRecentModel(config.p1Model);
            }
            if (config.p2Model) {
                this.setAI(2, config.p2Model);
                this._rememberRecentModel(config.p2Model);
            }
        }

        // Clear overlays
        ['p1', 'p2'].forEach(p => {
            const b = document.getElementById(`ai-banter-${p}`);
            const s = document.getElementById(`ai-strategy-${p}`);
            const lbl = document.querySelector(`#ai-overlay-${p} .ai-overlay-label`);
            if (b) b.textContent = '';
            if (s) s.textContent = '';
            if (lbl) lbl.textContent = p.toUpperCase();
        });
        const log = document.getElementById('action-log');
        if (log) log.innerHTML = '';

        this._collapseMatchSection();
        this._updateCensus();
        this.turns.startGame();

        console.log(`Match started: mode=${config.mode}, p1=${config.p1Model || 'human'}, p2=${config.p2Model || 'human'}`);
    }

    _collapseMatchSection() {
        for (const cfg of document.querySelectorAll('.match-config')) {
            cfg.style.display = 'none';
        }
        const startBtn = document.getElementById('btn-start-match');
        const manageBtn = document.getElementById('btn-manage-models');
        const panel = document.getElementById('model-config-panel');
        const summary = document.getElementById('match-summary');
        if (startBtn) startBtn.style.display = 'none';
        if (manageBtn) manageBtn.style.display = 'none';
        if (panel) panel.style.display = 'none';
        if (summary) {
            summary.style.display = '';
            const cfg = this._lastMatchConfig || {};
            const label = this._matchModeLabel(cfg);
            document.getElementById('ms-mode').textContent = label;
        }
    }

    _expandMatchSection() {
        document.getElementById('match-summary').style.display = 'none';
        document.getElementById('btn-start-match').style.display = '';
        document.getElementById('btn-manage-models').style.display = '';
        this._setMatchMode(this._matchMode);
    }

    _matchModeLabel(cfg) {
        const short = m => m ? m.replace(/:latest$/, '').split('/').pop().slice(0, 14) : 'human';
        if (cfg.mode === 'solo') return `Solo · vs ${short(cfg.p2Model)}`;
        if (cfg.mode === 'watch') return `Watch · ${short(cfg.p1Model)} × ${short(cfg.p2Model)}`;
        if (cfg.mode === 'tournament') return 'Tournament';
        return 'Match';
    }

    _rememberRecentModel(model) {
        if (!model) return;
        try {
            const key = 'biome.recentModels';
            const list = JSON.parse(localStorage.getItem(key) || '[]');
            const filtered = list.filter(m => m !== model);
            filtered.unshift(model);
            localStorage.setItem(key, JSON.stringify(filtered.slice(0, 4)));
        } catch (_) { /* localStorage unavailable */ }
    }

    // ── Launcher overlay (first load) ────────────────────────

    _initLauncher() {
        for (const card of document.querySelectorAll('.launcher-mode-card')) {
            card.addEventListener('click', () => {
                const mode = card.dataset.launcherMode;
                this._closeLauncherWelcome();
                this._setMatchMode(mode);
                if (mode === 'tournament') {
                    // Tournament cards immediately open the existing Standard/Lightning picker
                    this._startTournament();
                }
                // Solo/Watch: user picks model(s) in sidebar then clicks Start Match
            });
        }
    }

    _openLauncherWelcome() {
        const overlay = document.getElementById('tournament-overlay');
        const screen = document.getElementById('launcher-welcome');
        if (!overlay || !screen) return;
        overlay.querySelectorAll('.t-screen').forEach(s => s.classList.add('t-hidden'));
        screen.classList.remove('t-hidden');
        overlay.classList.remove('t-hidden');
    }

    _closeLauncherWelcome() {
        const overlay = document.getElementById('tournament-overlay');
        const screen = document.getElementById('launcher-welcome');
        if (!overlay || !screen) return;
        screen.classList.add('t-hidden');
        overlay.classList.add('t-hidden');
    }

    // ── Model Configuration Panel ───────────────────────────

    _initModelConfig() {
        const btn = document.getElementById('btn-manage-models');
        const panel = document.getElementById('model-config-panel');
        const closeBtn = document.getElementById('btn-mcp-close');
        if (!btn || !panel) return;

        btn.addEventListener('click', () => {
            const visible = panel.style.display !== 'none';
            panel.style.display = visible ? 'none' : 'block';
            if (!visible) this._refreshModelConfig();
        });

        closeBtn.addEventListener('click', () => {
            panel.style.display = 'none';
        });
    }

    async _refreshModelConfig() {
        const installedDiv = document.getElementById('mcp-installed');
        const recommendedDiv = document.getElementById('mcp-recommended');
        const statusDiv = document.getElementById('mcp-status');
        if (!installedDiv || !recommendedDiv) return;

        statusDiv.textContent = 'Checking models...';
        this._installedModels = await listOllamaModels();
        const installedNames = new Set(this._installedModels.map(m => m.name.split(':')[0]));

        // Installed models list
        installedDiv.innerHTML = '';
        if (this._installedModels.length === 0) {
            installedDiv.innerHTML = '<div class="mcp-model-item"><span class="mcp-model-name" style="color:#666;">No models installed</span></div>';
        } else {
            for (const m of this._installedModels) {
                const item = document.createElement('div');
                item.className = 'mcp-model-item';
                const size = formatModelSize(m.size);
                item.innerHTML = `
                    <span class="mcp-model-name">${m.name}</span>
                    <span class="mcp-model-size">${size}</span>
                    <span class="mcp-model-tag mcp-tag-installed">installed</span>
                `;
                installedDiv.appendChild(item);
            }
        }

        // Recommended models list
        recommendedDiv.innerHTML = '';
        for (const rec of RECOMMENDED_MODELS) {
            const baseName = rec.name.split(':')[0];
            const isInstalled = installedNames.has(baseName);
            const item = document.createElement('div');
            item.className = 'mcp-model-item';

            if (isInstalled) {
                item.innerHTML = `
                    <span class="mcp-model-name" style="color:#6a6;">${rec.name}</span>
                    <span class="mcp-model-size">${rec.size}</span>
                    <span class="mcp-model-tag mcp-tag-installed">installed</span>
                `;
            } else {
                const pullBtn = document.createElement('button');
                pullBtn.className = 'mcp-pull-btn';
                pullBtn.textContent = 'Install';
                pullBtn.addEventListener('click', () => this._pullModel(rec.name, pullBtn));
                item.innerHTML = `
                    <span class="mcp-model-name">${rec.name}</span>
                    <span class="mcp-model-size" title="${rec.desc}">${rec.size}</span>
                    <span class="mcp-model-tag mcp-tag-recommended" title="${rec.desc}">rec</span>
                `;
                item.appendChild(pullBtn);
            }
            recommendedDiv.appendChild(item);
        }

        statusDiv.textContent = '';
    }

    async _pullModel(modelName, btn) {
        const statusDiv = document.getElementById('mcp-status');
        btn.disabled = true;
        btn.textContent = 'Pulling...';
        const originalHtml = btn.closest('.mcp-model-item').innerHTML;

        // Replace tag with pulling indicator
        const tag = btn.closest('.mcp-model-item').querySelector('.mcp-tag-recommended');
        if (tag) {
            tag.className = 'mcp-model-tag mcp-tag-pulling';
            tag.textContent = 'pulling';
        }

        const result = await pullModel(modelName, (status, completed, total) => {
            if (status === 'downloading' && total) {
                const pct = Math.round((completed / total) * 100);
                btn.textContent = `${pct}%`;
                statusDiv.textContent = `Downloading ${modelName}: ${pct}%`;
            } else {
                statusDiv.textContent = `${modelName}: ${status}`;
            }
        });

        if (result.success) {
            statusDiv.textContent = `${modelName} installed!`;
            // Refresh everything — pickers + config panel
            await this._populateModelPickers();
            await this._refreshModelConfig();
        } else {
            statusDiv.textContent = `Failed: ${result.error}`;
            btn.disabled = false;
            btn.textContent = 'Install';
            const pullingTag = btn.closest('.mcp-model-item')?.querySelector('.mcp-tag-pulling');
            if (pullingTag) {
                pullingTag.className = 'mcp-model-tag mcp-tag-recommended';
                pullingTag.textContent = 'rec';
            }
        }
    }

    // ── Tournament support ────────────────────────────────────

    resetForMatch(rounds) {
        // Clear all organisms
        this.grid.forEach(cell => { cell.organisms = []; });

        // Fresh terrain
        this.seed = Math.floor(Math.random() * 100000);
        generateTerrain(this.grid, this.seed);

        // Reset turn state
        this.turns.round = 0;
        this.turns.phase = 'SETUP';
        this.turns.totalRounds = rounds || CONFIG.GAME.TOTAL_ROUNDS;
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
        if (this.tournament?.running) return;
        const mode = await this._pickTournamentMode();
        if (!mode) return;

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

        this.tournament.start(field, mode);
    }

    _pickTournamentMode() {
        return new Promise(resolve => {
            const overlay = document.getElementById('tournament-overlay');
            const screen   = document.getElementById('t-mode-select');
            overlay.classList.remove('t-hidden');
            overlay.querySelectorAll('.t-screen').forEach(s => s.classList.add('t-hidden'));
            screen.classList.remove('t-hidden');

            const standardBtn  = document.getElementById('btn-mode-standard');
            const lightningBtn = document.getElementById('btn-mode-lightning');
            const cancelBtn    = document.getElementById('btn-mode-cancel');

            const cleanup = () => {
                standardBtn.removeEventListener('click', onStandard);
                lightningBtn.removeEventListener('click', onLightning);
                cancelBtn.removeEventListener('click', onCancel);
            };

            const pick = (mode) => { cleanup(); screen.classList.add('t-hidden'); resolve(mode); };
            const onStandard  = () => pick('standard');
            const onLightning = () => pick('lightning');
            const onCancel    = () => { cleanup(); overlay.classList.add('t-hidden'); resolve(null); };

            standardBtn.addEventListener('click', onStandard);
            lightningBtn.addEventListener('click', onLightning);
            cancelBtn.addEventListener('click', onCancel);
        });
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.game = new Game();
    setupRankings();
});

async function setupRankings() {
    const btn = document.getElementById('btn-rankings');
    const panel = document.getElementById('rankings-panel');
    const closeBtn = document.getElementById('btn-rankings-close');
    const lbEl = document.getElementById('rk-leaderboard');
    const histEl = document.getElementById('rk-history');
    if (!btn || !panel) return;

    let open = false;
    const toggle = async (force) => {
        open = force !== undefined ? force : !open;
        if (open) {
            panel.classList.remove('rankings-hidden');
            const [rankings, history] = await Promise.all([fetchRankings(), fetchHistory()]);
            renderRankingsPanel(lbEl, rankings);
            renderHistoryPanel(histEl, history);
        } else {
            panel.classList.add('rankings-hidden');
        }
    };
    btn.addEventListener('click', () => toggle());
    closeBtn?.addEventListener('click', () => toggle(false));
}
