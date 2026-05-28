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
import { playSound, setMuted, isMuted } from './sound.js';

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
        this._initMuteToggle();
        this._initAICards();
        this._updateWorldInfo();
        this._scoreHistory = [];
        this._updateCensus();
        this._updateTurnUI();

        // Show launcher overlay on first load — game does NOT auto-start
        this._openLauncherWelcome();

        console.log(`Biome initialized — seed: ${this.seed}`);
    }

    _playSound(key) {
        try { playSound(key); } catch (_) { /* audio not ready */ }
    }

    _initMuteToggle() {
        const btn = document.getElementById('mute-toggle');
        if (!btn) return;
        const icon = btn.querySelector('.mt-icon');
        const refresh = () => {
            const muted = isMuted();
            btn.classList.toggle('muted', muted);
            if (icon) icon.textContent = muted ? '🔇' : '🔊';
        };
        refresh();
        btn.addEventListener('click', () => {
            setMuted(!isMuted());
            refresh();
        });
    }

    // ── AI Commentary Cards ──────────────────────────────────

    _initAICards() {
        for (const p of [1, 2]) {
            const toggle = document.getElementById(`aic-reason-toggle-p${p}`);
            const strategy = document.getElementById(`ai-strategy-p${p}`);
            if (!toggle || !strategy) continue;
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                const collapsed = strategy.classList.toggle('aic-reason-collapsed');
                toggle.setAttribute('aria-expanded', String(!collapsed));
            });
            // Hide toggle by default until reasoning text exists
            toggle.style.display = 'none';
        }
        // Initialize identity for whatever players are currently configured
        for (const p of [1, 2]) this._setAICardIdentity(p);
    }

    _setAICardIdentity(playerNum) {
        const avatarEl = document.getElementById(`aic-avatar-p${playerNum}`);
        const nameEl = document.getElementById(`aic-name-p${playerNum}`);
        const statusEl = document.getElementById(`aic-status-p${playerNum}`);
        if (!avatarEl || !nameEl) return;

        const ai = this.aiPlayers[playerNum];
        if (ai) {
            avatarEl.textContent = this._modelInitials(ai.model);
            nameEl.textContent = this._prettyModelName(ai.model);
            if (statusEl) {
                // Show rank/place status (persistent — fetched async below)
                statusEl.textContent = '— ELO · — W —L';
                statusEl.className = 'aic-status';
            }
            // Async populate rank/place
            this._updateAIRankStatus(playerNum);
        } else {
            avatarEl.textContent = `P${playerNum}`;
            nameEl.textContent = `Player ${playerNum}`;
            if (statusEl) {
                statusEl.textContent = 'Human';
                statusEl.className = 'aic-status';
            }
        }
    }

    async _updateAIRankStatus(playerNum) {
        const ai = this.aiPlayers[playerNum];
        const statusEl = document.getElementById(`aic-status-p${playerNum}`);
        if (!ai || !statusEl) return;
        const r = await this._fetchRanking(ai.model);
        // Make sure the AI for this slot didn't change mid-fetch
        if (this.aiPlayers[playerNum]?.model !== ai.model) return;
        if (r) {
            const rankPrefix = r.rank ? `#${r.rank} · ` : '';
            statusEl.textContent = `${rankPrefix}${Math.round(r.elo)} ELO · ${r.wins}W ${r.losses}L`;
        } else {
            statusEl.textContent = 'Unranked';
        }
    }

    _resetAICard(playerNum) {
        const bEl = document.getElementById(`ai-banter-p${playerNum}`);
        const sEl = document.getElementById(`ai-strategy-p${playerNum}`);
        const toggle = document.getElementById(`aic-reason-toggle-p${playerNum}`);
        if (bEl) {
            bEl.textContent = '';
            bEl.classList.remove('entering', 'thinking');
        }
        if (sEl) {
            sEl.textContent = '';
            sEl.classList.add('aic-reason-collapsed');
        }
        if (toggle) {
            toggle.style.display = 'none';
            toggle.setAttribute('aria-expanded', 'false');
        }
        this._setAICardIdentity(playerNum);
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

        // LIVE badge: visible whenever the match is actively progressing
        const liveStates = [PHASE.PLAYER_1_TURN, PHASE.PLAYER_2_TURN, PHASE.SIMULATING, PHASE.ROUND_END];
        this._setLiveBadge(liveStates.includes(phase));

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
            // Snapshot census BEFORE simulation, to compute deltas for recap
            this._preSimSnapshot = this._snapshotCensus();
            // Clear highlights after a longer pause in AI vs AI so spectator can study
            const revealDelay = aiVsAi ? 2500 : 800;
            setTimeout(() => {
                this.renderer.clearHighlightRound();
                this._runSimulation();
            }, revealDelay);
            return;
        } else if (phase === PHASE.ROUND_END) {
            this.renderer.clearHighlightRound();
            // Detect milestones (FIRST PREDATOR, DOMINANCE, COMEBACK, etc.)
            this._detectMilestones();
            // Show recap card with biomass + species deltas (if any milestone fired, defer slightly)
            const calloutsFiring = this._calloutBusy;
            const recapDelay = calloutsFiring ? 1100 : 200;
            if (this._preSimSnapshot) {
                setTimeout(() => this._showRecap(this._preSimSnapshot), recapDelay);
            }
            // Show round transition card, then advance
            const nextRound = this.turns.round + 1;
            if (nextRound <= this.turns.totalRounds) {
                setTimeout(() => this._showRoundTransition(nextRound), 3500);
                setTimeout(() => this.turns.nextRound(), 4700);
            } else {
                setTimeout(() => this.turns.nextRound(), 3500);
            }
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
        this.renderer.placementBurst(cell, player);
        this._playSound('place');
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

    _log(msg, opts = {}) {
        const log = document.getElementById('action-log');
        const entry = document.createElement('div');
        // Heuristic player tagging when caller didn't specify
        let cls = 'entry';
        if (opts.player === 1 || /^P1 /.test(msg)) cls += ' p1';
        else if (opts.player === 2 || /^P2 /.test(msg)) cls += ' p2';
        else cls += ' system';
        entry.className = cls;
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

        // AP chip — only visible during a HUMAN player's turn (no AI for that player)
        const apChip = document.getElementById('ap-chip');
        const apLabel = document.getElementById('ap-chip-label');
        const apValue = document.getElementById('ap-chip-value');
        if (apChip && apLabel && apValue) {
            const isHumanTurn = player && this.turns.isPlayerTurn() && !this.aiPlayers[player];
            if (isHumanTurn) {
                apChip.style.display = '';
                apChip.classList.toggle('p2', player === 2);
                apChip.classList.toggle('depleted', this.turns.currentAP <= 0);
                apLabel.textContent = `P${player}`;
                apValue.textContent = this.turns.currentAP;
            } else {
                apChip.style.display = 'none';
            }
        }

        // End turn button
        const btn = document.getElementById('btn-end-turn');
        btn.disabled = !this.turns.isPlayerTurn();
        if (player) {
            btn.textContent = `End P${player} Turn`;
        } else {
            btn.textContent = 'End Turn';
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

        const nameEl1 = document.getElementById('sb-name-p1');
        const nameEl2 = document.getElementById('sb-name-p2');
        const scoreEl1 = document.getElementById('sb-score-p1');
        const scoreEl2 = document.getElementById('sb-score-p2');
        const roundEl  = document.getElementById('sb-round');
        const leadEl   = document.getElementById('sb-lead');

        if (!nameEl1) return;

        nameEl1.textContent = p1Short;
        nameEl2.textContent = p2Short;

        // Animated ticker for score changes (rather than snap)
        this._animateScoreTo(scoreEl1, s1.finalScore, 1);
        this._animateScoreTo(scoreEl2, s2.finalScore, 2);

        roundEl.textContent = `Round ${round} / ${total}`;

        scoreEl1.classList.toggle('winning', s1.finalScore > s2.finalScore);
        scoreEl2.classList.toggle('winning', s2.finalScore > s1.finalScore);

        const diff = Math.abs(s1.finalScore - s2.finalScore);
        const fmtLead = n => n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n);
        if (diff === 0) {
            leadEl.textContent = 'Tied';
            leadEl.className = 'sb-lead tied';
            leadEl.style.setProperty('--lead-intensity', '0');
        } else {
            // Intensity 0..1 based on margin vs leader's score (capped)
            const leader = Math.max(s1.finalScore, s2.finalScore);
            const intensity = leader > 0 ? Math.min(1, diff / leader / 0.4) : 0;
            leadEl.style.setProperty('--lead-intensity', intensity.toFixed(2));
            if (s1.finalScore > s2.finalScore) {
                leadEl.textContent = `+${fmtLead(diff)}`;
                leadEl.className = 'sb-lead p1';
            } else {
                leadEl.textContent = `+${fmtLead(diff)}`;
                leadEl.className = 'sb-lead p2';
            }
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

    _animateScoreTo(el, target, player) {
        if (!el) return;
        const fmt = n => n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(Math.round(n));
        // Parse current displayed value (may be "—" on first render)
        const parseDisplay = (s) => {
            if (!s || s === '—') return 0;
            if (s.endsWith('k')) return parseFloat(s) * 1000;
            return parseFloat(s) || 0;
        };
        const from = el._lastNumeric != null ? el._lastNumeric : parseDisplay(el.textContent);
        const to = target;
        if (from === to) {
            el.textContent = fmt(to);
            el._lastNumeric = to;
            return;
        }
        // Cancel any in-flight animation
        if (el._tickerRaf) cancelAnimationFrame(el._tickerRaf);

        const duration = 600;
        const t0 = performance.now();
        const easeOut = t => 1 - Math.pow(1 - t, 3);

        const step = (now) => {
            const t = Math.min(1, (now - t0) / duration);
            const v = from + (to - from) * easeOut(t);
            el.textContent = fmt(v);
            if (t < 1) {
                el._tickerRaf = requestAnimationFrame(step);
            } else {
                el._lastNumeric = to;
                el._tickerRaf = null;
            }
        };
        el._tickerRaf = requestAnimationFrame(step);

        // Trigger flash + score sound
        el.classList.remove('score-flash');
        // Re-trigger animation by forcing reflow
        void el.offsetWidth;
        el.classList.add('score-flash');
        setTimeout(() => el.classList.remove('score-flash'), 520);
        this._playSound?.('score');
    }

    _setLiveBadge(visible) {
        const el = document.getElementById('sb-live');
        if (el) el.style.display = visible ? '' : 'none';
    }

    // ── Dramatic callouts (broadcast moments) ────────────────

    _resetMilestones() {
        this._milestones = {
            firstPredator: { 1: false, 2: false },
            firstTrophic:  { 1: false, 2: false },
            dominance:     { 1: false, 2: false },
            comeback:      false,
            extinction:    { 1: {}, 2: {} },
            finalRound:    false,
            decisive:      false,
            // Track last lead-leader to detect comebacks
            lastLeader:    0,
            biggestDeficit: { 1: 0, 2: 0 },
        };
        this._calloutQueue = [];
        this._calloutBusy = false;
    }

    _dispatchCallout({ text, subtitle = '', tone = 'neutral' }) {
        this._calloutQueue = this._calloutQueue || [];
        this._calloutQueue.push({ text, subtitle, tone });
        if (!this._calloutBusy) this._drainCallouts();
    }

    _drainCallouts() {
        if (!this._calloutQueue || this._calloutQueue.length === 0) {
            this._calloutBusy = false;
            return;
        }
        this._calloutBusy = true;
        const { text, subtitle, tone } = this._calloutQueue.shift();

        const el = document.getElementById('callout');
        const tEl = document.getElementById('co-text');
        const sEl = document.getElementById('co-subtitle');
        if (!el || !tEl) { this._calloutBusy = false; return; }

        tEl.textContent = text;
        sEl.textContent = subtitle || '';
        sEl.style.display = subtitle ? '' : 'none';

        el.className = 'co-hidden'; // reset
        void el.offsetWidth;
        el.className = `tone-${tone}`;
        this._playSound('callout');

        // Animation runs ~2.4s; queue next after a short gap
        clearTimeout(this._coTimer);
        this._coTimer = setTimeout(() => {
            el.className = 'co-hidden';
            setTimeout(() => this._drainCallouts(), 220);
        }, 2400);
    }

    _detectMilestones() {
        if (!this._milestones) this._resetMilestones();
        const ms = this._milestones;
        const census = this.simulation.census();
        const scores = this.simulation.finalScore();
        const round = this.turns.round;
        const total = this.turns.totalRounds;

        // FINAL ROUND callout (just once, when round reaches last)
        if (!ms.finalRound && round === total) {
            ms.finalRound = true;
            this._dispatchCallout({ text: 'FINAL ROUND', tone: 'gold' });
        }

        // Track who's currently leading
        const leadDiff = scores[1].finalScore - scores[2].finalScore;
        const currentLeader = leadDiff > 0 ? 1 : (leadDiff < 0 ? 2 : 0);

        // FIRST PREDATOR per player
        for (const p of [1, 2]) {
            if (!ms.firstPredator[p] && census[p].predators > 0) {
                ms.firstPredator[p] = true;
                this._dispatchCallout({
                    text: 'FIRST PREDATOR',
                    subtitle: this._playerTag(p),
                    tone: `p${p}`,
                });
            }
            if (!ms.firstTrophic[p] && census[p].plants > 0 && census[p].herbivores > 0 && census[p].predators > 0) {
                ms.firstTrophic[p] = true;
                this._dispatchCallout({
                    text: 'TROPHIC CHAIN',
                    subtitle: `${this._playerTag(p)} · plant → herbivore → predator`,
                    tone: `p${p}`,
                });
            }
        }

        // DOMINANCE — one player has ≥60% of total biomass
        const totalBiomass = census[1].biomass + census[2].biomass;
        if (totalBiomass > 200) {
            for (const p of [1, 2]) {
                const share = census[p].biomass / totalBiomass;
                if (!ms.dominance[p] && share >= 0.6) {
                    ms.dominance[p] = true;
                    this._dispatchCallout({
                        text: 'ECOSYSTEM DOMINANCE',
                        subtitle: `${this._playerTag(p)} · ${Math.round(share * 100)}% biomass`,
                        tone: `p${p}`,
                    });
                }
                // Reset dominance flag if they slip back under 50% (so a re-take can fire again)
                if (ms.dominance[p] && share < 0.5) ms.dominance[p] = false;
            }
        }

        // COMEBACK — swing from significant deficit to lead
        const totalScore = Math.max(1, scores[1].finalScore + scores[2].finalScore);
        for (const p of [1, 2]) {
            const myScore = scores[p].finalScore;
            const enemyScore = scores[p === 1 ? 2 : 1].finalScore;
            const deficit = enemyScore - myScore;
            ms.biggestDeficit[p] = Math.max(ms.biggestDeficit[p], deficit);
            // Comeback fires if you were down by >25% of current total and now lead
            if (!ms.comeback && ms.biggestDeficit[p] > totalScore * 0.25 && myScore > enemyScore) {
                ms.comeback = true;
                this._dispatchCallout({
                    text: 'COMEBACK',
                    subtitle: this._playerTag(p),
                    tone: `p${p}`,
                });
            }
        }

        // EXTINCTION — player had a species, now has none
        const speciesByPlayer = { 1: {}, 2: {} };
        this.grid.forEach(cell => {
            for (const org of cell.organisms) {
                speciesByPlayer[org.player][org.species] = (speciesByPlayer[org.player][org.species] || 0) + 1;
            }
        });
        for (const p of [1, 2]) {
            const prev = ms.extinction[p];
            // Mark species we've seen alive at any point
            for (const key in speciesByPlayer[p]) {
                if (!prev[key]) prev[key] = 'alive';
            }
            // Detect newly-extinct species
            for (const key in prev) {
                if (prev[key] === 'alive' && !speciesByPlayer[p][key]) {
                    prev[key] = 'extinct';
                    const flavor = CONFIG.SPECIES[key]?.name || key;
                    this._dispatchCallout({
                        text: `EXTINCT: ${flavor.toUpperCase()}`,
                        subtitle: this._playerTag(p),
                        tone: 'alert',
                    });
                }
            }
        }

        // DECISIVE — final 3 rounds, score gap > 30%
        if (!ms.decisive && round >= total - 2 && totalScore > 1000) {
            const gap = Math.abs(leadDiff) / totalScore;
            if (gap > 0.3) {
                ms.decisive = true;
                const leader = leadDiff > 0 ? 1 : 2;
                this._dispatchCallout({
                    text: 'DECISIVE',
                    subtitle: this._playerTag(leader),
                    tone: `p${leader}`,
                });
            }
        }

        ms.lastLeader = currentLeader;
    }

    _playerTag(p) {
        const ai = this.aiPlayers[p];
        if (!ai) return `Player ${p}`;
        const short = ai.model.replace(/:.*$/, '').split('/').pop();
        return `P${p} · ${short}`;
    }

    // ── Round-end recap card ──────────────────────────────────

    _showRecap(prevSnapshot) {
        const census = this.simulation.census();
        const lines = [];

        for (const p of [1, 2]) {
            const before = prevSnapshot[p];
            const after = census[p];
            const biomassDelta = Math.round(after.biomass - before.biomass);
            if (biomassDelta !== 0) {
                lines.push({
                    player: p,
                    tag: this._playerTag(p),
                    label: 'biomass',
                    delta: biomassDelta,
                });
            }
            // Species change deltas
            for (const sp of ['GRASS', 'SHRUB', 'TREE', 'GRAZER', 'BROWSER', 'PREDATOR']) {
                const dBefore = before.bySpecies?.[sp] || 0;
                const dAfter = after.bySpecies?.[sp] || 0;
                const diff = dAfter - dBefore;
                if (diff !== 0 && Math.abs(diff) >= 2) {
                    const flavor = CONFIG.SPECIES[sp]?.name || sp;
                    lines.push({
                        player: p,
                        tag: this._playerTag(p),
                        label: flavor,
                        delta: diff,
                    });
                }
            }
        }

        if (lines.length === 0) return; // nothing notable

        const el = document.getElementById('recap-card');
        const hEl = document.getElementById('rc-header');
        const bEl = document.getElementById('rc-body');
        if (!el || !bEl) return;

        hEl.textContent = `Round ${this.turns.round} Recap`;

        // Sort by biggest delta magnitude, cap to 6 lines
        lines.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
        const top = lines.slice(0, 6);
        bEl.innerHTML = top.map(l => {
            const sign = l.delta > 0 ? '+' : '';
            const dir = l.delta > 0 ? 'up' : 'down';
            return `<div class="rc-line rc-p${l.player}">
                <span class="rc-tag">P${l.player}</span>
                <span style="flex:1;text-align:left;margin-left:6px;">${l.label}</span>
                <span class="rc-delta ${dir}">${sign}${l.delta}</span>
            </div>`;
        }).join('');

        el.className = 'recap-hidden';
        void el.offsetWidth;
        el.className = '';

        clearTimeout(this._recapTimer);
        this._recapTimer = setTimeout(() => el.classList.add('recap-hidden'), 3200);
    }

    _snapshotCensus() {
        const census = this.simulation.census();
        return {
            1: { biomass: census[1].biomass, bySpecies: { ...census[1].bySpecies } },
            2: { biomass: census[2].biomass, bySpecies: { ...census[2].bySpecies } },
        };
    }

    _showRoundTransition(nextRound) {
        const overlay = document.getElementById('round-transition');
        const numEl = document.getElementById('rt-number');
        const subEl = document.getElementById('rt-subline');
        if (!overlay || !numEl) return;

        numEl.textContent = nextRound;

        // Subline shows current leader (if any meaningful margin)
        const scores = this.simulation.finalScore();
        const diff = scores[1].finalScore - scores[2].finalScore;
        const total = Math.max(1, Math.max(scores[1].finalScore, scores[2].finalScore));
        const margin = Math.abs(diff) / total;
        subEl.className = 'rt-subline';
        if (margin > 0.08 && diff > 0) {
            subEl.textContent = 'P1 leading';
            subEl.classList.add('p1');
        } else if (margin > 0.08 && diff < 0) {
            subEl.textContent = 'P2 leading';
            subEl.classList.add('p2');
        } else if (scores[1].finalScore > 0 || scores[2].finalScore > 0) {
            subEl.textContent = 'Neck and neck';
        } else {
            subEl.textContent = '';
        }

        // Restart the animation by toggling class off/on
        overlay.classList.add('rt-hidden');
        void overlay.offsetWidth;
        overlay.classList.remove('rt-hidden');
        this._playSound('round');

        // Auto-hide after the animation completes
        clearTimeout(this._rtHideTimer);
        this._rtHideTimer = setTimeout(() => overlay.classList.add('rt-hidden'), 1500);
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

        // Compute per-category max across both players for magnitude bars
        const maxes = {
            plants: Math.max(census[1].plants, census[2].plants, 1),
            herbivores: Math.max(census[1].herbivores, census[2].herbivores, 1),
            predators: Math.max(census[1].predators, census[2].predators, 1),
            biomass: Math.max(census[1].biomass, census[2].biomass, 1),
        };

        const barRow = (label, value, max) => {
            const pct = Math.round((value / max) * 100);
            return `<div class="info-row bar-row" style="--bar-pct:${pct}%"><span>${label}</span><span>${value}</span></div>`;
        };

        const playerBlock = (label, c, side) => `
            <div class="census-player ${side}">
                <div class="census-label">${label}</div>
                ${barRow('Plants', c.plants, maxes.plants)}
                ${subRows(c.bySpecies, 'plant')}
                ${barRow('Herbivores', c.herbivores, maxes.herbivores)}
                ${subRows(c.bySpecies, 'herbivore')}
                ${barRow('Predators', c.predators, maxes.predators)}
                ${subRows(c.bySpecies, 'predator')}
                <div class="info-row bar-row biomass" style="--bar-pct:${Math.round((c.biomass / maxes.biomass) * 100)}%"><span>Biomass</span><span>${Math.round(c.biomass)}</span></div>
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
        this._playSound('victory');
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

        // Make sure card identity is set (rank/place stays visible permanently)
        this._setAICardIdentity(playerNum);

        const bEl = document.getElementById(`ai-banter-p${playerNum}`);
        const sEl = document.getElementById(`ai-strategy-p${playerNum}`);
        const toggle = document.getElementById(`aic-reason-toggle-p${playerNum}`);
        // Clear previous banter and mark as thinking — placeholder renders "thinking…"
        if (bEl) {
            bEl.textContent = '';
            bEl.classList.add('thinking');
            bEl.classList.remove('entering');
        }
        if (sEl) {
            sEl.textContent = '';
            sEl.classList.add('aic-reason-collapsed');
        }
        if (toggle) {
            toggle.style.display = 'none';
            toggle.setAttribute('aria-expanded', 'false');
        }

        this._updateTurnUI();

        // Brief delay so the UI updates before the async call
        await this._sleep(300);

        const result = await ai.takeTurn();

        this._aiThinking = false;

        // Banter container is no longer "thinking" — placeholder/text takes over
        if (bEl) bEl.classList.remove('thinking');
        if (bEl && result.banter) {
            bEl.textContent = result.banter;
            bEl.classList.remove('entering');
            void bEl.offsetWidth;
            bEl.classList.add('entering');
        } else if (bEl) {
            bEl.textContent = '';
        }
        if (sEl && result.reasoning) {
            sEl.textContent = result.reasoning;
            // Reasoning stays collapsed by default but the toggle becomes available
            if (toggle) toggle.style.display = '';
        }
        // Status stays as rank/place — no temporary overwrite

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
            const match = a.msg.match(/^(?:Auto: |Fallback: )?(\w+) at/);
            if (match) species[match[1]] = (species[match[1]] || 0) + 1;
        }
        const summary = Object.entries(species).map(([s, n]) => `${n}× ${s}`).join(', ');
        if (summary) this._log(`P${playerNum} placed: ${summary}`);

        this.renderer.render();

        // Burst + sound staggered for each successful placement
        for (let i = 0; i < okActions.length; i++) {
            const a = okActions[i];
            if (!a.cell) continue;
            setTimeout(() => {
                this.renderer.placementBurst(a.cell, playerNum);
                this._playSound('place');
            }, i * 140);
        }
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
        this._setAICardIdentity(playerNum);
    }

    removeAI(playerNum) {
        delete this.aiPlayers[playerNum];
        this._log(`P${playerNum} is now Human`);
        this._setAICardIdentity(playerNum);
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

        // Set sensible defaults: prefer cloud models, pick two truly different ones for Watch
        if (this._installedModels.length === 0) return;
        const installed = this._installedModels;
        const cloud = installed.filter(m => m.name.includes('cloud'));
        const first = cloud[0] || installed[0];
        // Find ANY model with a different name than first; fall back to first only if none exists
        const second =
            cloud.find(m => m.name !== first.name)
            || installed.find(m => m.name !== first.name)
            || first;

        const soloP2 = document.getElementById('match-model-p2-solo');
        const watchP1 = document.getElementById('match-model-p1-watch');
        const watchP2 = document.getElementById('match-model-p2-watch');
        // Apply defaults only when user hasn't manually chosen (browser auto-selects
        // the first option on populate, so we can't rely on .value to detect intent)
        if (soloP2 && !soloP2._userSet) soloP2.value = first.name;
        if (watchP1 && !watchP1._userSet) watchP1.value = first.name;
        if (watchP2 && !watchP2._userSet) watchP2.value = second.name;
    }

    _pickDifferentModel(excludeName) {
        if (!this._installedModels || this._installedModels.length === 0) return null;
        const cloud = this._installedModels.filter(m => m.name.includes('cloud') && m.name !== excludeName);
        if (cloud.length > 0) return cloud[0].name;
        const other = this._installedModels.find(m => m.name !== excludeName);
        return other ? other.name : excludeName;
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

        // Track user changes to model pickers — distinguishes user choice from
        // the browser's auto-selected-first-option default
        for (const id of ['match-model-p2-solo', 'match-model-p1-watch', 'match-model-p2-watch']) {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => { el._userSet = true; });
        }

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
            // Enforce different models — auto-swap P2 if both equal and alternatives exist
            if (cfg.p1Model && cfg.p1Model === cfg.p2Model) {
                const alt = this._pickDifferentModel(cfg.p1Model);
                if (alt && alt !== cfg.p1Model) {
                    cfg.p2Model = alt;
                    const watchP2 = document.getElementById('match-model-p2-watch');
                    if (watchP2) watchP2.value = alt;
                }
            }
        }
        this._startMatch(cfg);
    }

    async _startMatch(config) {
        this._lastMatchConfig = config;

        // Trading-card VS screen before play begins (Solo + Watch only)
        if (config.mode === 'solo' || config.mode === 'watch') {
            try { await this._showPrematch(config); } catch (_) { /* ignore */ }
        }

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

        // Clear AI cards (banter, reasoning, identity)
        this._resetAICard(1);
        this._resetAICard(2);
        const log = document.getElementById('action-log');
        if (log) log.innerHTML = '';

        this._collapseMatchSection();
        this._updateCensus();
        this._resetMilestones();
        this._playSound('match-start');
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

    // ── Player Cards (trading-card identity) ─────────────────

    _modelInitials(model) {
        if (!model) return 'AI';
        const clean = model.replace(/:.*$/, '').split('/').pop().replace(/[^a-z0-9]/gi, '');
        if (/^\d/.test(clean)) return clean.slice(0, 2).toUpperCase();
        // Take first letter of name + first letter after first digit OR first 2 letters
        const m = clean.match(/^([a-z]+)/i);
        if (m && m[1].length >= 2) return m[1].slice(0, 2).toUpperCase();
        return clean.slice(0, 2).toUpperCase();
    }

    _prettyModelName(model) {
        if (!model) return 'Human';
        // qwen2.5:14b → Qwen 2.5 14B, deepseek-v3.1:671b-cloud → Deepseek V3.1 (cloud)
        const [base, tag] = model.split(':');
        const niceBase = base.split(/[-_]/).map(p => {
            // Keep version numbers as-is, capitalize letters
            if (/\d/.test(p)) return p.charAt(0).toUpperCase() + p.slice(1);
            return p.charAt(0).toUpperCase() + p.slice(1);
        }).join(' ');
        if (!tag) return niceBase;
        const niceTag = tag.replace('-cloud', '').toUpperCase();
        const cloudTag = tag.includes('cloud') ? ' · Cloud' : '';
        return `${niceBase} ${niceTag}${cloudTag}`.replace(/\s+/g, ' ').trim();
    }

    async _fetchRanking(model) {
        try {
            // Rankings come back as { fullName: { elo, wins, losses } } in leaderboard order.
            // Refetch each call so the displayed ELO reflects recent match results.
            const rankings = await fetchRankings();
            if (!rankings || !model) return null;

            const norm = (m) => m
                ? m.replace(/:.*$/, '').split('/').pop().replace(/-cloud$/, '').replace(/-latest$/, '')
                : '';
            const target = norm(model);

            let rank = 0;
            for (const [name, stats] of Object.entries(rankings)) {
                rank++;
                if (norm(name) === target) {
                    return { model: name, elo: stats.elo, wins: stats.wins, losses: stats.losses, rank };
                }
            }
            return null;
        } catch (_) {
            return null;
        }
    }

    async _renderPlayerCard(target, opts) {
        const el = typeof target === 'string' ? document.getElementById(target) : target;
        if (!el) return;
        const { model, player, isHuman = false, compact = false } = opts;
        el.classList.toggle('compact', compact);

        let initials, displayName, role, meta;
        if (isHuman) {
            initials = 'YOU';
            displayName = 'Player';
            role = `Player ${player}`;
            meta = 'Human';
        } else {
            initials = this._modelInitials(model);
            displayName = this._prettyModelName(model);
            role = `Player ${player}`;
            meta = model.includes('cloud') ? 'Cloud Model' : 'Local Model';
        }

        // Initial render without ELO data, then update once fetched
        el.innerHTML = `
            <div class="pc-role">${role}</div>
            <div class="pc-avatar">${initials}</div>
            <div class="pc-name">${displayName}</div>
            ${isHuman ? '' : `
                <div class="pc-stats">
                    <div class="pc-stat elo"><span class="pc-stat-value" data-elo>—</span><span class="pc-stat-label">ELO</span></div>
                    <div class="pc-stat wins"><span class="pc-stat-value" data-wins>—</span><span class="pc-stat-label">Wins</span></div>
                    <div class="pc-stat losses"><span class="pc-stat-value" data-losses>—</span><span class="pc-stat-label">Loss</span></div>
                </div>
            `}
            <div class="pc-meta">${meta}</div>
        `;

        if (!isHuman && model) {
            const r = await this._fetchRanking(model);
            if (r) {
                const eloEl = el.querySelector('[data-elo]');
                const winsEl = el.querySelector('[data-wins]');
                const lossEl = el.querySelector('[data-losses]');
                if (eloEl) eloEl.textContent = Math.round(r.elo);
                if (winsEl) winsEl.textContent = r.wins;
                if (lossEl) lossEl.textContent = r.losses;
            }
        }
    }

    async _showPrematch(config) {
        const overlay = document.getElementById('tournament-overlay');
        const screen = document.getElementById('match-prematch');
        if (!overlay || !screen) return;

        // Hide other screens, show prematch
        overlay.querySelectorAll('.t-screen').forEach(s => s.classList.add('t-hidden'));
        screen.classList.remove('t-hidden');
        overlay.classList.remove('t-hidden');

        // Render cards
        const p1Opts = config.mode === 'solo'
            ? { player: 1, isHuman: true }
            : { player: 1, model: config.p1Model };
        const p2Opts = { player: 2, model: config.p2Model };
        await Promise.all([
            this._renderPlayerCard('prematch-p1-card', p1Opts),
            this._renderPlayerCard('prematch-p2-card', p2Opts),
        ]);

        // Auto-dismiss + skip-on-click
        return new Promise(resolve => {
            const close = () => {
                overlay.removeEventListener('click', close);
                clearTimeout(timer);
                screen.classList.add('t-hidden');
                overlay.classList.add('t-hidden');
                resolve();
            };
            const timer = setTimeout(close, 2800);
            overlay.addEventListener('click', close);
        });
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

        // Clear AI cards
        this._resetAICard(1);
        this._resetAICard(2);
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
