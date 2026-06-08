// Biome — main entry point

import { CONFIG } from './config.js';
import { HexGrid } from './grid.js';
import { generateTerrain, TERRAIN_TYPES } from './terrain.js';
import { Renderer } from './renderer.js';
import { Simulation } from './simulation.js';
import { createOrganism, getAllSpecies } from './species.js';
import { TurnManager, PHASE } from './turn.js';
import { AIPlayer, listOllamaModels, pullModel, deleteModel, fetchRoster, setModelRetired, formatModelSize, RECOMMENDED_MODELS, prepareResidentSet, isCloudModel, isModelResident } from './ai.js';
import { TournamentManager } from './tournament.js';
import { buildField, FORMATS, DEFAULT_FORMAT } from './tournament-format.js';
import { getStrategy } from './map-strategies.js';
import { openCodex } from './codex.js';
import { openLeaderboard } from './leaderboard.js';
import { buildBiomeRosters, repaintBiomeRosterIcons, updateBiomeRosters } from './biome-roster.js';
import { Biosphere } from './biosphere.js';
import { trophicRead } from './trophic.js';
import { setCaptureEnabled, isCaptureEnabled, newMatchUid, captureRound } from './capture.js';
import { MEDAL, liveTier } from './medal.js';
import { DYNAMICS_SCHEMA, PRESETS, applyDynamics, loadDynamics, saveDynamics, resetDynamics, settingValue, activePreset } from './game-dynamics.js';

// Models excluded from tournaments: embeddings, vision / vision-language, and
// code specialists. They can't follow the game's JSON action protocol or aren't
// fair general-reasoning competitors. Shared by the field builder and the
// format picker's live "eligible models" note.
//   *embed*/nomic/mxbai  → embeddings
//   moondream/llava/*-vl → vision & vision-language
//   *coder*/codellama    → code specialists
const TOURNAMENT_EXCLUDE = /embed|nomic|mxbai|moondream|llava|coder|codellama|vision|[-:]vl\b/i;
import { fetchRankings, fetchHistory, postResult, renderOddsInto, expectedScore } from './rankings.js';
import { applyAvatar, applyAvatarVideo, clearAvatar, preloadAvatars } from './model-avatar.js';
import { openPlayerCard } from './player-card.js';
import { resolveModel, titleCase, resolvePlayerPalettes, paramLabel } from './model-identity.js';
import { loadIdentityOverrides } from './identity-overrides.js';
import { shortId } from './util.js';
import { buildSingleMatchDashboard, paintDashboard } from './match-dashboard.js';

preloadAvatars();   // warm avatars/manifest.json so the first badge/card paint is instant
import { playSound, setMuted, isMuted } from './sound.js';

// Callout tones that represent a leaderboard surprise. These get a larger
// entrance animation and a longer hold so the moment reads as a celebration.
const RANK_DRAMA_TONES = new Set(['throne', 'promote', 'upset']);

class Game {
    constructor() {
        this.canvas = document.getElementById('game-canvas');
        this.seed = Math.floor(Math.random() * 100000);
        // Apply the player's persisted Game Dynamics overrides onto CONFIG before
        // any board/species is read. Baseline-clean if nothing was saved.
        this._dynamics = loadDynamics();
        applyDynamics(this._dynamics);
        this.grid = new HexGrid(CONFIG.GRID_COLS, CONFIG.GRID_ROWS, CONFIG.HEX_SIZE);
        this.renderer = new Renderer(this.canvas, this.grid);
        this.simulation = new Simulation(this.grid);
        this.selectedSpecies = null;
        this.simulating = false;
        this.turns = new TurnManager((phase) => this._onPhaseChange(phase));
        this.aiPlayers = {};   // { playerNum: AIPlayer }
        this._aiThinking = false;
        // Retired (benched) models — excluded from tournament fields and the AI
        // opponent pickers. Loaded from the server roster; empty until it resolves.
        this._retired = new Set();
        // Pristine cyan/orange player palette, snapshotted before any match can
        // mutate CONFIG. Human-vs-human and human slots fall back to these.
        this._defaultPalettes = {
            1: { ...CONFIG.PLAYER_1.PRIMARY },
            2: { ...CONFIG.PLAYER_2.PRIMARY },
        };
        this._scoreHistory = []; // [{ round, p1, p2 }, ...]
        this._matchResolve = null; // set during tournament games
        this.tournament = new TournamentManager(this);
        this._init();

    }

    _init() {
        generateTerrain(this.grid, this.seed);
        this.renderer.render();
        this._buildSpeciesPalette();
        buildBiomeRosters();
        this._bindEvents();
        this._initModelConfig();
        this._initSettingsPanel();
        this._initMatchSection();
        this._initLauncher();
        this._initMuteToggle();
        this._initGearMenu();
        this._initActivityTicker();
        this._initConsole();
        this._initAICards();
        this._setMatchCardsActive(false);   // cards stay hidden until a match starts
        this._updateWorldInfo();
        this._scoreHistory = [];
        this.biosphere = new Biosphere(document.getElementById('bio-orb'));
        this.biosphere.start();
        this._updateCensus();
        this._updateTurnUI();

        // Show launcher overlay on first load — game does NOT auto-start
        this._openLauncherWelcome();

        console.log(`Biome initialized — seed: ${this.seed}`);
        this._maybeAutoStart();
    }

    // Headless data-generation entry: `?gen=tournament` or `?gen=watch&p1=..&p2=..`
    // auto-starts a match for the Training Lab generation harness (dev-session.mjs
    // `generate` mode). Capture turns on automatically once an AI is assigned.
    _maybeAutoStart() {
        let params;
        try { params = new URLSearchParams(location.search); } catch (_) { return; }
        const gen = params.get('gen');
        if (!gen) return;
        console.log(`[gen] auto-start requested: ${gen}`);
        if (gen === 'tournament') {
            setTimeout(() => { try { this._startTournament(); } catch (e) { console.error('[gen]', e); } }, 800);
        } else if (gen === 'watch') {
            const p1Model = params.get('p1'), p2Model = params.get('p2');
            if (!p1Model || !p2Model) { console.error('[gen] watch needs p1 & p2'); return; }
            // Loop watch matches so a gauntlet (challenger vs base, N games) runs
            // unattended — _showGameOver re-starts this when each match ends.
            this._genWatch = { mode: 'watch', p1Model, p2Model };
            setTimeout(() => { try { this._startMatch(this._genWatch); } catch (e) { console.error('[gen]', e); } }, 800);
        }
    }

    // ── Activity Ticker (bottom-edge log feed) ──────────────

    _initActivityTicker() {
        this._tickerHistory = [];      // {ts, msg, cls}
        this._tickerVisible = false;
        this._tickerQueue = [];
        this._tickerActive = false;

        const ticker = document.getElementById('activity-ticker');
        if (ticker) {
            ticker.addEventListener('click', () => this._openActivityLog());
        }
        const closeBtn = document.getElementById('btn-alm-close');
        if (closeBtn) closeBtn.addEventListener('click', () => this._closeActivityLog());
        const backdrop = document.querySelector('#activity-log-modal .alm-backdrop');
        if (backdrop) backdrop.addEventListener('click', () => this._closeActivityLog());
    }

    _pushTickerEntry({ msg, cls }) {
        const ticker = document.getElementById('activity-ticker');
        if (!ticker) return;
        ticker.classList.remove('at-hidden');

        const rail = document.getElementById('at-rail');
        if (!rail) return;

        // Insert at the right side; older entries fade out
        const entry = document.createElement('span');
        entry.className = `at-entry ${cls || 'system'}`;
        entry.innerHTML = `<span class="at-text">${msg}</span>`;
        rail.appendChild(entry);

        // Trim — keep only the latest 3 visible
        while (rail.children.length > 3) {
            rail.removeChild(rail.firstChild);
        }

        // Auto-fade after a hold
        setTimeout(() => {
            entry.classList.add('fading');
            setTimeout(() => {
                if (entry.parentNode) entry.parentNode.removeChild(entry);
                if (rail.children.length === 0) ticker.classList.add('at-hidden');
            }, 450);
        }, 4000);
    }

    // ── Moment lock ──────────────────────────────────────────
    // A "moment" is any celebratory overlay that owns the stage: a dramatic
    // callout sequence, the round recap, or the round-transition card. While
    // one is on screen we hush the activity ticker so the bottom feed recedes
    // instead of competing for attention. Ref-counted so overlapping owners
    // (e.g. a callout that runs into the recap) don't un-hush prematurely.
    _beginMoment() {
        this._momentDepth = (this._momentDepth || 0) + 1;
        if (this._momentDepth === 1) {
            document.getElementById('activity-ticker')?.classList.add('at-quiet');
        }
    }

    _endMoment() {
        this._momentDepth = Math.max(0, (this._momentDepth || 0) - 1);
        if (this._momentDepth === 0) {
            document.getElementById('activity-ticker')?.classList.remove('at-quiet');
        }
    }

    _openActivityLog() {
        const modal = document.getElementById('activity-log-modal');
        const body = document.getElementById('alm-body');
        if (!modal || !body) return;
        body.innerHTML = '';
        // Render reverse-chronological (newest at top): flex column-reverse gives this
        for (const e of this._tickerHistory) {
            const div = document.createElement('div');
            div.className = `alm-entry ${e.cls || 'system'}`;
            const t = new Date(e.ts);
            const time = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
            div.innerHTML = `<span class="alm-time">${time}</span>${e.msg}`;
            body.appendChild(div);
        }
        modal.classList.remove('alm-hidden');
    }

    _closeActivityLog() {
        document.getElementById('activity-log-modal')?.classList.add('alm-hidden');
    }

    // ── Cell tooltip (follows cursor on canvas hover) ───────

    _showCellTooltip(cell, mouseX, mouseY) {
        const tip = document.getElementById('cell-tooltip');
        if (!tip) return;
        const terrainEl = document.getElementById('ct-terrain');
        const orgsEl = document.getElementById('ct-organisms');
        const posEl = document.getElementById('ct-position');

        const TERRAIN_LABEL = {
            WATER:     { name: 'Water',     icon: '🌊', cls: 'water' },
            FERTILE:   { name: 'Fertile',   icon: '🌱', cls: 'fertile' },
            GRASSLAND: { name: 'Grassland', icon: '🌾', cls: 'grassland' },
            ROCKY:     { name: 'Rocky',     icon: '⛰', cls: 'rocky' },
        };
        const meta = TERRAIN_LABEL[cell.terrain] || { name: cell.terrain, icon: '◇', cls: '' };
        if (terrainEl) {
            terrainEl.className = `ct-terrain ${meta.cls}`;
            terrainEl.innerHTML = `<span class="ct-t-icon">${meta.icon}</span><span>${meta.name}</span>`;
        }

        const visible = cell.organisms.filter(o => !this.renderer.isHidden(o));
        if (orgsEl) {
            orgsEl.innerHTML = visible.map(o => {
                const t = CONFIG.SPECIES[o.species];
                return `<div class="ct-org-row">
                    <span class="ct-org-dot p${o.player}"></span>
                    <span class="ct-org-name">${t?.name || o.species}</span>
                    <span class="ct-org-energy">${Math.round(o.energy)}E</span>
                </div>`;
            }).join('');
        }

        if (posEl) posEl.textContent = `(${cell.col}, ${cell.row})`;

        // Position near cursor, flip near edges
        tip.classList.remove('ct-hidden');
        const tw = tip.offsetWidth || 180;
        const th = tip.offsetHeight || 70;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let x = mouseX + 14;
        let y = mouseY + 14;
        if (x + tw > vw - 8) x = mouseX - tw - 14;
        if (y + th > vh - 8) y = mouseY - th - 14;
        tip.style.left = `${x}px`;
        tip.style.top = `${y}px`;
    }

    _hideCellTooltip() {
        document.getElementById('cell-tooltip')?.classList.add('ct-hidden');
    }

    // ── Gear Menu (top-right floating, replaces sidebar buttons) ─

    _initGearMenu() {
        const btn = document.getElementById('btn-gear');
        const dropdown = document.getElementById('gear-dropdown');
        if (!btn || !dropdown) return;

        const setOpen = (open) => {
            btn.setAttribute('aria-expanded', String(open));
            dropdown.classList.toggle('gm-hidden', !open);
        };
        setOpen(false);

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = dropdown.classList.contains('gm-hidden');
            if (open) this._syncMagnifierMenu();
            setOpen(open);
        });

        // Close on outside click
        document.addEventListener('click', (e) => {
            if (dropdown.classList.contains('gm-hidden')) return;
            if (e.target.closest('#gear-menu')) return;
            setOpen(false);
        });

        // Dropdown item actions
        for (const item of dropdown.querySelectorAll('.gm-item')) {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                setOpen(false);
                const action = item.dataset.gm;
                if (action === 'new-match') {
                    this._openLauncherWelcome();
                } else if (action === 'manage-models') {
                    this._openModelConfigModal();
                } else if (action === 'settings') {
                    this._openSettingsModal();
                } else if (action === 'rankings') {
                    // Full-screen Hall of Champions. Opened in-game, so Back drops
                    // the overlay back to the board rather than the launcher welcome.
                    this._showRankingsScene({ onBack: () => this._closeLauncherWelcome() });
                } else if (action === 'labs') {
                    this._openLabsChooser();
                } else if (action === 'field-guide') {
                    openCodex();
                } else if (action === 'magnifier') {
                    this._toggleMagnifier();
                }
            });
        }

        // Reflect magnifier state when the menu opens.
        this._syncMagnifierMenu();
    }

    /** Flip the magnifier loupe on/off and sync the menu indicator. */
    _toggleMagnifier() {
        if (!this.renderer) return;
        this.renderer.setMagnifierEnabled(!this.renderer.isMagnifierEnabled());
        this._syncMagnifierMenu();
    }

    _syncMagnifierMenu() {
        const item = document.querySelector('.gm-item[data-gm="magnifier"]');
        if (item && this.renderer) {
            item.classList.toggle('gm-active', this.renderer.isMagnifierEnabled());
        }
    }

    /** Legacy no-op: the right-edge stack was retired for the bottom-center
     *  HUD console. Tournament code still calls this. */
    _refreshRightStackVisibility() { /* retired — console is always present */ }

    // ── HUD console (bottom-center: scoreline rail + Stats/Bracket) ──

    _initConsole() {
        // Tab switching
        for (const tab of document.querySelectorAll('#hud-console .hc-tab')) {
            tab.addEventListener('click', () => this._activateConsoleTab(tab.dataset.hcTab));
        }

        // Rail toggles the panel open/closed (unless yielding to the dock)
        document.getElementById('hc-rail')?.addEventListener('click', () => {
            if (this._consoleDockYield) return;
            this._setConsoleExpanded(this._consoleCollapsed());
        });

        // Bracket "expand to fullscreen" button
        document.getElementById('bt-bracket-expand')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.tournament?._showExpandedBracket?.();
        });
        // Nav (New Match / Field Guide / Rankings / Labs / Manage Models) now
        // lives in the header gear dropdown — see _initGearMenu.
    }

    _consoleCollapsed() {
        return !!document.getElementById('hud-console')?.classList.contains('hc-collapsed');
    }

    _setConsoleExpanded(expanded, remember = true) {
        const c = document.getElementById('hud-console');
        if (!c) return;
        c.classList.toggle('hc-collapsed', !expanded);
        document.getElementById('hc-rail')?.setAttribute('aria-expanded', String(!!expanded));
        if (remember) this._consoleUserExpanded = !!expanded;
        this._reserveConsoleSpace();
    }

    /**
     * Reserve a bottom band for the open stats console so the board fits ABOVE
     * it and is never overlaid — the mirror of the scoreboard's --header-h band.
     * Collapsed/hidden → 0 (board reclaims the full height; only the tiny handle
     * floats). Open → the panel's rendered height + handle + bottom offset.
     * The console is absolutely positioned, so growing the band shrinks the
     * board (a flex child) while the panel stays pinned at the viewport bottom.
     */
    _reserveConsoleSpace(animate = true) {
        const c = document.getElementById('hud-console');
        let footer = 0;
        if (c && !c.classList.contains('hc-hidden') && !c.classList.contains('hc-collapsed')) {
            const panel = document.getElementById('hc-panel');
            const handle = document.getElementById('hc-rail');
            // scrollHeight gives the panel's natural content height even while
            // its max-height is animating; cap it at the CSS max (62vh).
            const maxPanel = window.innerHeight * 0.62;
            const panelH = Math.min(panel ? panel.scrollHeight : 0, maxPanel);
            const handleH = handle ? handle.offsetHeight : 0;
            const BOTTOM_OFFSET = 40;   // .hud-console { bottom: 40px }
            const BREATH = 10;
            footer = Math.round(panelH + handleH + BOTTOM_OFFSET + BREATH);
        }
        if (animate) {
            this._animateFooterTo(footer);
        } else {
            document.body.style.setProperty('--footer-h', footer + 'px');
            this.renderer?._fit();
            this.renderer?.render();
        }
    }

    /** Smoothly grow/shrink the reserved console band (--footer-h) and keep the
     *  board fitted to the changing space each frame, so it tracks the panel and
     *  never overlaps it. Driven in JS — transitioning a var-backed padding in
     *  CSS doesn't fire reliably (unregistered custom property). One-shot rAF. */
    _animateFooterTo(target) {
        if (this._fitRaf) cancelAnimationFrame(this._fitRaf);
        const from = parseFloat(getComputedStyle(document.body).getPropertyValue('--footer-h')) || 0;
        if (Math.abs(target - from) < 1) {
            document.body.style.setProperty('--footer-h', target + 'px');
            this.renderer?._fit();
            this.renderer?.render();
            return;
        }
        const start = performance.now();
        const DURATION = 340;
        const ease = (t) => 1 - Math.pow(1 - t, 3);   // easeOutCubic — cohesive with the panel slide
        const tick = () => {
            const t = Math.min(1, (performance.now() - start) / DURATION);
            const v = Math.round(from + (target - from) * ease(t));
            document.body.style.setProperty('--footer-h', v + 'px');
            this.renderer?._fit();
            this.renderer?.render();
            if (t < 1) this._fitRaf = requestAnimationFrame(tick);
            else this._fitRaf = null;
        };
        this._fitRaf = requestAnimationFrame(tick);
    }

    /** Show/hide the whole console (hidden on the launcher, shown in a match). */
    _setConsoleVisible(visible) {
        const c = document.getElementById('hud-console');
        if (!c) return;
        c.classList.toggle('hc-hidden', !visible);
        if (visible) {
            this._activateConsoleTab('stats');     // Stats (eco) is always the default
            this._setConsoleExpanded(true);
        } else {
            this._reserveConsoleSpace();           // hidden → release the band
        }
    }

    _activateConsoleTab(target) {
        if (!target) return;
        for (const t of document.querySelectorAll('#hud-console .hc-tab')) {
            const isActive = t.dataset.hcTab === target;
            t.classList.toggle('active', isActive);
            t.setAttribute('aria-selected', String(isActive));
        }
        for (const v of document.querySelectorAll('#hud-console .hc-view')) {
            v.classList.toggle('hc-view-hidden', v.dataset.hcView !== target);
        }
        // Reflect the active tab on the collapse handle
        const meta = { stats: ['⛧', 'Stats'], bracket: ['⚔', 'Bracket'] }[target];
        if (meta) {
            const ico = document.getElementById('hc-handle-icon');
            const lbl = document.getElementById('hc-handle-label');
            if (ico) ico.textContent = meta[0];
            if (lbl) lbl.textContent = meta[1];
        }
        // Picking a tab while collapsed pops the panel open
        if (this._consoleCollapsed() && !this._consoleDockYield) this._setConsoleExpanded(true);
        // Tabs differ in height (bracket vs eco vs menu) — re-reserve if open
        else this._reserveConsoleSpace();
    }

    /** Called by TournamentManager. Shows/hides the Bracket tab + live dot.
     *  Default tab stays Stats (eco) even in tournament — no auto-switch. */
    setBracketAvailable({ available, live = false, title }) {
        const c = document.getElementById('hud-console');
        if (!c) return;
        c.classList.toggle('hc-has-bracket', !!available);
        c.classList.toggle('hc-tournament-live', !!live);

        if (title) {
            const t = document.getElementById('bt-bracket-title');
            if (t) t.textContent = title;
        }

        if (!available) {
            // Tournament cleared — if the bracket tab was active, fall back to Stats
            const bracketTab = document.querySelector('#hud-console .hc-tab[data-hc-tab="bracket"]');
            if (bracketTab?.classList.contains('active')) this._activateConsoleTab('stats');
        }
    }

    /** Yield the bottom-center stage to the species dock during human turns:
     *  lock the console collapsed, then restore the prior state afterward. */
    _syncConsoleToDock(dockActive) {
        const c = document.getElementById('hud-console');
        if (!c || dockActive === this._consoleDockYield) return;
        this._consoleDockYield = dockActive;
        c.classList.toggle('hc-dock-yield', dockActive);
        if (dockActive) {
            this._setConsoleExpanded(false, false);
        } else {
            this._setConsoleExpanded(this._consoleUserExpanded !== false, false);
        }
    }

    _openModelConfigModal() {
        const modal = document.getElementById('model-config-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        this._refreshModelConfig();
    }

    _closeModelConfigModal() {
        const modal = document.getElementById('model-config-modal');
        if (modal) modal.style.display = 'none';
    }

    // ── Settings panel (global, tabbed) — Game Dynamics tab ──────
    _initSettingsPanel() {
        const modal = document.getElementById('settings-modal');
        if (!modal) return;
        document.getElementById('btn-settings-close')?.addEventListener('click', () => this._closeSettingsModal());
        modal.querySelector('.mcm-backdrop')?.addEventListener('click', () => this._closeSettingsModal());
        document.getElementById('btn-settings-reset')?.addEventListener('click', () => {
            this._dynamics = resetDynamics();
            this._renderSettingsValues();
            this._afterDynamicsChange();
        });
        for (const tab of modal.querySelectorAll('.hc-tab[data-settings-tab]')) {
            tab.addEventListener('click', () => this._switchSettingsTab(tab.dataset.settingsTab));
        }
        this._buildSettingsDynamics();
        this._renderSettingsValues();
    }

    _openSettingsModal() {
        const modal = document.getElementById('settings-modal');
        if (!modal) return;
        this._renderSettingsValues();   // reflect any external/default state
        modal.style.display = 'flex';
    }

    _closeSettingsModal() {
        const modal = document.getElementById('settings-modal');
        if (modal) modal.style.display = 'none';
    }

    _switchSettingsTab(name) {
        const modal = document.getElementById('settings-modal');
        if (!modal) return;
        for (const tab of modal.querySelectorAll('.hc-tab[data-settings-tab]')) {
            const on = tab.dataset.settingsTab === name;
            tab.classList.toggle('active', on);
            tab.setAttribute('aria-selected', String(on));
        }
        for (const view of modal.querySelectorAll('.settings-view[data-settings-view]')) {
            view.classList.toggle('hc-view-hidden', view.dataset.settingsView !== name);
        }
    }

    // Build the slider DOM once from DYNAMICS_SCHEMA (single source of truth).
    _buildSettingsDynamics() {
        const presetRow = document.getElementById('settings-preset-row');
        if (presetRow) {
            presetRow.innerHTML = '';
            for (const name of Object.keys(PRESETS)) {
                const btn = document.createElement('button');
                btn.className = 'settings-preset';
                btn.dataset.preset = name;
                btn.textContent = name;
                btn.addEventListener('click', () => {
                    this._dynamics = { ...PRESETS[name] };
                    saveDynamics(this._dynamics);
                    applyDynamics(this._dynamics);
                    this._renderSettingsValues();
                    this._afterDynamicsChange();
                });
                presetRow.appendChild(btn);
            }
        }

        const body = document.getElementById('settings-dynamics-body');
        if (!body) return;
        body.innerHTML = '';

        // Group sliders in declaration order; Per-Species lives in an expander.
        const groups = [];
        const byName = {};
        for (const s of DYNAMICS_SCHEMA) {
            if (!byName[s.group]) { byName[s.group] = []; groups.push(s.group); }
            byName[s.group].push(s);
        }

        const rowHTML = (s) => `
            <div class="settings-row" data-row="${s.id}">
                <label class="settings-row-label" title="${s.hint || ''}">${s.label}</label>
                <input type="range" class="world-range settings-range" data-slider="${s.id}"
                       min="${s.min}" max="${s.max}" step="${s.step}">
                <span class="mw-readout settings-readout" data-readout="${s.id}"></span>
            </div>`;

        for (const group of groups) {
            const rows = byName[group].map(rowHTML).join('');
            if (group === 'Per-Species') {
                const det = document.createElement('details');
                det.className = 'settings-advanced';
                det.innerHTML = `<summary>Per-Species (advanced)</summary>${rows}`;
                body.appendChild(det);
            } else {
                const sec = document.createElement('div');
                sec.className = 'settings-group';
                sec.innerHTML = `<div class="hc-section-label">${group}</div>${rows}`;
                body.appendChild(sec);
            }
        }

        // Wire slider input — live readout + persist + apply.
        for (const input of body.querySelectorAll('.settings-range')) {
            input.addEventListener('input', () => {
                const slider = DYNAMICS_SCHEMA.find(s => s.id === input.dataset.slider);
                if (!slider) return;
                const v = parseFloat(input.value);
                this._dynamics = { ...this._dynamics, [slider.id]: v };
                this._updateSettingsReadout(slider, v);
                saveDynamics(this._dynamics);
                applyDynamics(this._dynamics);
                this._highlightActivePreset();
                this._afterDynamicsChange();
            });
        }
    }

    _fmtDynamic(slider, v) {
        if (slider.kind === 'int') return `${Math.round(v)}${slider.unit || ''}`;
        return `${v.toFixed(2)}×`;
    }

    _updateSettingsReadout(slider, v) {
        const out = document.querySelector(`.settings-readout[data-readout="${slider.id}"]`);
        if (out) {
            out.textContent = this._fmtDynamic(slider, v);
            out.classList.toggle('settings-readout-off', v !== slider.default);
        }
    }

    // Push this._dynamics into every slider + readout, and highlight presets.
    _renderSettingsValues() {
        for (const slider of DYNAMICS_SCHEMA) {
            const v = settingValue(this._dynamics, slider);
            const input = document.querySelector(`.settings-range[data-slider="${slider.id}"]`);
            if (input) input.value = String(v);
            this._updateSettingsReadout(slider, v);
        }
        this._highlightActivePreset();
    }

    _highlightActivePreset() {
        const active = activePreset(this._dynamics);
        for (const btn of document.querySelectorAll('.settings-preset')) {
            btn.classList.toggle('on', btn.dataset.preset === active);
        }
    }

    // Re-render the board when idle so terrain/nutrient-tint changes show; live
    // gameplay values take effect on the next simulation read regardless.
    _afterDynamicsChange() {
        if (!this.simulating) this.renderer?.render();
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
        const overlayEl = document.getElementById(`ai-overlay-p${playerNum}`);
        const avatarEl = document.getElementById(`aic-avatar-p${playerNum}`);
        const nameEl = document.getElementById(`aic-name-p${playerNum}`);
        const subEl = document.getElementById(`aic-subtitle-p${playerNum}`);
        const tierEl = document.getElementById(`aic-tier-p${playerNum}`);
        const statusEl = document.getElementById(`aic-status-p${playerNum}`);
        if (!avatarEl || !nameEl) return;

        const ai = this.aiPlayers[playerNum];
        if (ai) {
            const id = resolveModel(ai.model);
            avatarEl.textContent = this._modelInitials(ai.model);   // fallback under the avatar
            applyAvatarVideo(avatarEl, ai.model, { category: 'idle', loop: true });  // idle loop, else baked PNG, else procedural
            nameEl.textContent = this._prettyModelName(ai.model);
            // The avatar is a tap target → opens the player detail card.
            avatarEl.classList.add('pcm-clickable');
            avatarEl.setAttribute('role', 'button');
            avatarEl.setAttribute('tabindex', '0');
            avatarEl.title = 'View player card';
            avatarEl.onclick = () => this._openPlayerCard(playerNum);
            avatarEl.onkeydown = (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._openPlayerCard(playerNum); }
            };
            // Tint the whole card with the model's brand hue (frame, role glow).
            if (overlayEl) overlayEl.style.setProperty('--aic-hue', id.hue);
            // Subtitle: "Class · Origin" — the creature archetype + the vendor
            // (drop the vendor when it's the unknown-family placeholder).
            if (subEl) {
                const cls = titleCase(id.family.archetype);
                subEl.textContent = id.vendor && id.vendor !== '—' ? `${cls} · ${id.vendor}` : cls;
            }
            // Deployment tier line.
            if (tierEl) tierEl.textContent = /cloud/i.test(ai.model) ? 'CLOUD' : 'LOCAL';
            if (statusEl) {
                // Show rank/place status (persistent — fetched async below)
                statusEl.innerHTML = '<span class="aic-elo">—<i>ELO</i></span>';
                statusEl.className = 'aic-status';
            }
            // Async populate ranking-dependent status + role pill.
            this._updateAICardStats(playerNum);
        } else {
            // Human slots get a card too (for the creature roster), just no AI
            // identity/banter. Tint to the player's own hue.
            clearAvatar(avatarEl);
            avatarEl.classList.remove('pcm-clickable');
            avatarEl.removeAttribute('role'); avatarEl.removeAttribute('tabindex');
            avatarEl.onclick = null; avatarEl.onkeydown = null; avatarEl.title = '';
            avatarEl.textContent = `P${playerNum}`;
            nameEl.textContent = `Player ${playerNum}`;
            if (subEl) subEl.textContent = '';
            if (overlayEl) {
                const hue = (playerNum === 1 ? CONFIG.PLAYER_1 : CONFIG.PLAYER_2).PRIMARY.h;
                overlayEl.style.setProperty('--aic-hue', hue);
            }
            if (tierEl) tierEl.textContent = 'HUMAN';
            const roleEl = document.getElementById(`aic-role-p${playerNum}`);
            if (roleEl) { roleEl.textContent = ''; roleEl.className = 'aic-role'; }
            if (statusEl) {
                statusEl.textContent = 'Human';
                statusEl.className = 'aic-status';
            }
        }
    }

    // Show/hide both player cards and reserve their board gutters. Cards (with
    // the creature roster) appear for AI and human slots alike while a match is
    // running, and vanish on the launcher/menu. Call BEFORE a grid rebuild so
    // the board fits between the cards. _refitBoard recomputes against the new
    // container padding.
    _setMatchCardsActive(active) {
        for (const p of [1, 2]) {
            const el = document.getElementById(`ai-overlay-p${p}`);
            if (el) el.style.display = active ? '' : 'none';
        }
        const container = document.querySelector('.canvas-container');
        if (container) {
            container.classList.toggle('banter-left', active);
            container.classList.toggle('banter-right', active);
        }
        this._refitBoard();
    }

    // Open the gamified player detail card for a banter-card avatar. Resolves the
    // canonical ranking name here (reusing _fetchRanking's aliasing) and hands the
    // live opponent in so the card can show tonight's head-to-head.
    async _openPlayerCard(playerNum) {
        const ai = this.aiPlayers[playerNum];
        if (!ai) return;
        const opp = this.aiPlayers[playerNum === 1 ? 2 : 1];
        const ranking = await this._fetchRanking(ai.model);
        openPlayerCard({
            model: ai.model,
            charName: this._aiCharacterName(ai.model),
            prettyName: this._prettyModelName(ai.model),
            ranking,
            opponent: opp ? { model: opp.model, charName: this._aiCharacterName(opp.model) } : null,
        });
    }

    async _updateAICardStats(playerNum) {
        const ai = this.aiPlayers[playerNum];
        const statusEl = document.getElementById(`aic-status-p${playerNum}`);
        if (!ai) return;
        const r = await this._fetchRanking(ai.model);
        // Make sure the AI for this slot didn't change mid-fetch
        if (this.aiPlayers[playerNum]?.model !== ai.model) return;

        if (r) {
            if (statusEl) {
                const rankHtml = r.rank ? `<span class="aic-rank">#${r.rank}</span>` : '';
                statusEl.className = 'aic-status';
                statusEl.innerHTML =
                    `${rankHtml}` +
                    `<span class="aic-elo">${Math.round(r.elo)}<i>ELO</i></span>` +
                    `<span class="aic-record"><b>${r.wins}</b>W <b>${r.losses}</b>L</span>`;
            }
        } else {
            if (statusEl) {
                statusEl.className = 'aic-status';
                statusEl.innerHTML = '<span class="aic-unranked">Unranked</span>';
            }
        }
        this._renderRole(playerNum, r, this._matchupOdds);
    }

    // The narrative odds/role pill — calls out reigning champ, favorite, underdog,
    // wildcard, etc. from rank + record + live head-to-head odds.
    _renderRole(playerNum, ranking, odds) {
        const el = document.getElementById(`aic-role-p${playerNum}`);
        if (!el) return;
        const pWin = odds ? (playerNum === 1 ? odds.p1Win : odds.p2Win) : null;
        const rank = ranking?.rank;
        const games = (ranking?.wins || 0) + (ranking?.losses || 0);
        let text, cls;
        if (rank === 1) { text = 'REIGNING #1'; cls = 'fav'; }
        else if (pWin != null && pWin >= 0.65) { text = 'HEAVY FAVORITE'; cls = 'fav'; }
        else if (pWin != null && pWin <= 0.35) { text = 'LONGSHOT'; cls = 'dog'; }
        else if (rank && rank <= 3) { text = 'CONTENDER'; cls = 'fav'; }
        else if (!ranking || games < 3) { text = 'WILDCARD'; cls = 'even'; }
        else if (pWin != null) {
            if (Math.abs(pWin - 0.5) < 0.02) { text = 'EVEN'; cls = 'even'; }
            else if (pWin > 0.5) { text = 'FAVORITE'; cls = 'fav'; }
            else { text = 'UNDERDOG'; cls = 'dog'; }
        } else { text = 'CHALLENGER'; cls = 'even'; }
        if (pWin != null) text += ` · ${Math.round(pWin * 100)}%`;
        el.textContent = text;
        el.className = `aic-role odds-${cls}`;
    }

    // Fetch both models' ELO and compute the head-to-head win probability for the
    // pre-match header readout. No-op (and clears odds) unless both slots are ranked AIs.
    async _updateMatchupOdds() {
        const a1 = this.aiPlayers[1], a2 = this.aiPlayers[2];
        if (!a1 || !a2) { this._matchupOdds = null; this._updateScoreboard(); return; }
        const m1 = a1.model, m2 = a2.model;
        const [r1, r2] = await Promise.all([this._fetchRanking(m1), this._fetchRanking(m2)]);
        // Bail if either slot changed mid-fetch.
        if (this.aiPlayers[1]?.model !== m1 || this.aiPlayers[2]?.model !== m2) return;
        if (r1?.elo == null || r2?.elo == null) { this._matchupOdds = null; this._updateScoreboard(); return; }
        const p1Win = expectedScore(r1.elo, r2.elo);
        this._matchupOdds = { p1Win, p2Win: 1 - p1Win };
        this._updateScoreboard();
        // Refresh the card role pills now that live odds exist.
        this._renderRole(1, r1, this._matchupOdds);
        this._renderRole(2, r2, this._matchupOdds);
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
        if (palette) palette.innerHTML = '';

        const dockTiles = document.getElementById('sd-tiles');
        if (dockTiles) dockTiles.innerHTML = '';

        const species = getAllSpecies();
        species.forEach((sp, i) => {
            const hotkey = i + 1; // 1..N keyboard shortcut

            // Legacy palette card (still rendered for any compat needs; hidden)
            if (palette) {
                const card = document.createElement('div');
                card.className = 'species-card';
                card.dataset.species = sp.key;
                const subLabel = sp.role.toLowerCase() === sp.type ? sp.type : `${sp.role} · ${sp.type}`;
                card.innerHTML = `
                    <div class="name">${sp.name}</div>
                    <div class="type">${subLabel}</div>
                    <div class="cost">${sp.apCost} AP</div>
                `;
                card.addEventListener('click', () => this._selectSpecies(sp.key));
                palette.appendChild(card);
            }

            // New canvas-integrated hex dock tile
            if (dockTiles) {
                const tile = document.createElement('button');
                tile.type = 'button';
                tile.className = 'species-tile';
                tile.dataset.species = sp.key;
                tile.dataset.hotkey = String(hotkey);
                const glyph = this._speciesGlyph(sp.key);
                tile.innerHTML = `
                    <span class="st-hotkey">${hotkey <= 9 ? hotkey : ''}</span>
                    <span class="st-cost">${sp.apCost}</span>
                    <span class="st-glyph">${glyph}</span>
                    <span class="st-name">${sp.name}</span>
                    <div class="st-popover">
                        <div class="st-pop-name">${sp.name}</div>
                        <div class="st-pop-role type-${sp.type}">${sp.role} · ${sp.type}</div>
                        <dl class="st-pop-stats">
                            <dt>AP</dt><dd>${sp.apCost}</dd>
                            <dt>Energy</dt><dd>${sp.energy} / ${sp.maxEnergy}</dd>
                            ${sp.diet ? `<dt>Diet</dt><dd>${sp.diet.join(', ')}</dd>` : ''}
                        </dl>
                    </div>
                `;
                tile.addEventListener('click', () => this._selectSpecies(sp.key));
                dockTiles.appendChild(tile);
            }
        });

        this._refreshSpeciesDockState();
    }

    _speciesGlyph(key) {
        // Local glyph map (config doesn't carry one). Easy to swap to SVG later.
        const GLYPHS = {
            GRASS: '🌿',
            SHRUB: '🌵',
            TREE: '🌲',
            GRAZER: '🐇',
            BROWSER: '🦌',
            PREDATOR: '🐺',
        };
        return GLYPHS[key] || '◆';
    }

    _selectSpecies(key) {
        if (this.selectedSpecies === key) {
            this.selectedSpecies = null;
        } else {
            this.selectedSpecies = key;
        }
        // Sync visual selection across both legacy palette + dock
        document.querySelectorAll('.species-card.selected').forEach(c => c.classList.remove('selected'));
        document.querySelectorAll('.species-tile.selected').forEach(c => c.classList.remove('selected'));
        if (this.selectedSpecies) {
            const sel = `[data-species="${this.selectedSpecies}"]`;
            document.querySelectorAll(`.species-card${sel}`).forEach(c => c.classList.add('selected'));
            document.querySelectorAll(`.species-tile${sel}`).forEach(c => c.classList.add('selected'));
        }
    }

    /**
     * Show/hide species dock + update tile affordances based on current turn.
     */
    _refreshSpeciesDockState() {
        const dock = document.getElementById('species-dock');
        if (!dock) return;
        const player = this.turns && this.turns.currentPlayer;
        const isHuman = !!player && this.turns.isPlayerTurn() && !this.aiPlayers[player];
        dock.classList.toggle('sd-hidden', !isHuman);
        this._syncConsoleToDock(isHuman);

        const remainingAP = this.turns && this.turns.currentAP != null
            ? this.turns.currentAP
            : Infinity;
        for (const tile of document.querySelectorAll('.species-tile')) {
            const key = tile.dataset.species;
            const sp = CONFIG.SPECIES[key];
            const cant = sp && sp.apCost > remainingAP;
            tile.classList.toggle('disabled', !!cant);
        }

        const endBtn = document.getElementById('sd-end-turn');
        if (endBtn) endBtn.disabled = !isHuman;
    }

    _bindEvents() {
        this.canvas.addEventListener('mousemove', (e) => this._onHover(e));
        this.canvas.addEventListener('mouseleave', () => {
            this._hideCellTooltip();
            this.renderer?.hideMagnifier();
        });
        this.canvas.addEventListener('click', (e) => this._onClick(e));

        // Keep the board fitted to the window as it resizes (always the current
        // renderer, which is rebuilt per match). Registered once.
        window.addEventListener('resize', () => {
            // Re-render the board crisp to fill the resized viewport (also
            // re-reserves the console band). Debounced to coalesce resize bursts.
            clearTimeout(this._resizeTimer);
            this._resizeTimer = setTimeout(() => this._refitBoard(), 80);
        });

        const endTurn = () => {
            if (this.turns.isPlayerTurn()) this.turns.endTurn();
        };

        document.getElementById('btn-end-turn')?.addEventListener('click', endTurn);
        document.getElementById('sd-end-turn')?.addEventListener('click', endTurn);

        // Keyboard hotkeys: 1-9 select species tiles; Space ends turn.
        document.addEventListener('keydown', (e) => {
            // Don't hijack typing in inputs / textareas / select boxes
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;

            if (e.key >= '1' && e.key <= '9') {
                const tiles = document.querySelectorAll('#sd-tiles .species-tile');
                const idx = parseInt(e.key, 10) - 1;
                const tile = tiles[idx];
                if (tile && !tile.classList.contains('disabled')) {
                    tile.click();
                    e.preventDefault();
                }
            } else if (e.key === ' ' || e.code === 'Space') {
                if (this.turns.isPlayerTurn()) {
                    endTurn();
                    e.preventDefault();
                }
            } else if (e.key === 'm' || e.key === 'M') {
                this._toggleMagnifier();
                e.preventDefault();
            }
        });
    }

    _isAIvsAI() {
        return !!(this.aiPlayers[1] && this.aiPlayers[2]);
    }

    _onPhaseChange(phase) {
        const aiVsAi = this._isAIvsAI();

        // Guided demo narration — a non-blocking banner keyed to each phase beat.
        if (this._demoMode) this._demoBeat(phase);

        // LIVE badge: visible while the match is actively progressing — clears at ROUND_END so summary overlays don't fight for attention
        const liveStates = [PHASE.PLAYER_1_TURN, PHASE.PLAYER_2_TURN, PHASE.SIMULATING];
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
                this._runAITurn(1).catch(e => this._failTurn(1, e));
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
                this._runAITurn(2).catch(e => this._failTurn(2, e));
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
            // Tournament tick — repaint the bracket panel with this round's live scores
            this._onTournamentTick?.();
            // Detect milestones (FIRST PREDATOR, DOMINANCE, COMEBACK, etc.)
            this._detectMilestones();
            // Sequencer owns the round-end timeline: callouts → recap → transition → advance.
            // No fixed setTimeouts — each step awaits the previous overlay's hide.
            this._runRoundEndSequence();
        } else if (phase === PHASE.GAME_OVER) {
            this.renderer.clearHighlightRound();
            // Fire-and-forget, but never silent: a throw inside _showGameOver used
            // to vanish and strand the final board with no result screen. Surface it,
            // and last-ditch-show the scene.
            this._showGameOver().catch(err => {
                console.error('[game-over] _showGameOver threw — result screen suppressed:', err);
                const ov = document.getElementById('game-over-overlay');
                if (ov) ov.style.display = 'flex';
            });
        }

        this._updateTurnUI();
    }

    async _runRoundEndSequence() {
        const isFinalRound = this.turns.round >= this.turns.totalRounds;

        // Step 1 — drain any milestone callouts dispatched synchronously by _detectMilestones
        await this._waitForCalloutsDone();

        // Step 2 — recap card (returns immediately if there's nothing notable to show)
        if (this._preSimSnapshot) {
            await this._showRecap(this._preSimSnapshot);
        }

        // Step 3 — round transition card. Final round still gets a card, with FINAL copy.
        if (isFinalRound) {
            await this._showRoundTransition(null, { isFinalRound: true });
        } else {
            await this._showRoundTransition(this.turns.round + 1);
        }

        // Step 4 — advance the game. For the final round this triggers PHASE.GAME_OVER.
        this.turns.nextRound();
    }

    _onHover(e) {
        if (this.simulating) return;
        const rect = this.canvas.getBoundingClientRect();
        // Map display pixels → bitmap pixels (canvas may be CSS-scaled to fit).
        const sx = this.canvas.width / rect.width;
        const sy = this.canvas.height / rect.height;
        const x = (e.clientX - rect.left) * sx;
        const y = (e.clientY - rect.top) * sy;
        const cell = this.renderer.getCellAtPixel(x, y);

        // Feed the magnifier loupe before render() — its tail paints the loupe.
        if (cell) this.renderer.setMagnifierTarget(cell, e.clientX, e.clientY);
        else this.renderer.hideMagnifier();

        this.renderer.render();
        if (cell) {
            const canPlace = this.turns.isPlayerTurn() && this.selectedSpecies && cell.terrain !== TERRAIN_TYPES.WATER;
            const color = canPlace ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.12)';
            this.renderer.highlightCell(cell, color);
            this._updateCellInfo(cell);
            // The loupe carries its own cell stats, so the floating tooltip would
            // be a redundant second hover display — suppress it while it's on.
            if (this.renderer.isMagnifierEnabled()) this._hideCellTooltip();
            else this._showCellTooltip(cell, e.clientX, e.clientY);
        } else {
            this._hideCellTooltip();
        }
    }

    _onClick(e) {
        if (!this.turns.canPlaceOrganism()) return;
        if (this.simulating) return;

        const rect = this.canvas.getBoundingClientRect();
        // Map display pixels → bitmap pixels (canvas may be CSS-scaled to fit).
        const sx = this.canvas.width / rect.width;
        const sy = this.canvas.height / rect.height;
        const x = (e.clientX - rect.left) * sx;
        const y = (e.clientY - rect.top) * sy;
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
            if (existingPlants.length >= CONFIG.SIM.PLANT_CAP) {
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

        // Reset the causal event tally so this round's recap narrates only what
        // happened during these steps (not cumulative across rounds).
        this.simulation.resetEvents();

        this._log(`Simulating ${steps} steps...`);

        for (let i = 0; i < steps; i++) {
            this.simulation.step();
            this.renderer.render();
            this._updateCensus();
            await this._sleep(CONFIG.SIM.ANIMATION_STEP_MS);
        }

        this.simulating = false;
        this._log(`Round ${this.turns.round} simulation complete`);
        this._captureRound();
        this.turns.simulationComplete();
    }

    // Per-round reward signals (full board — validator-only, never fed to a model
    // as input). Joined to the round's turn records by match_uid + round.
    _captureRound() {
        if (!isCaptureEnabled()) return;
        try {
            const census = this.simulation.census();
            const scores = this.simulation.finalScore();
            const tr = (p) => trophicRead(census[p].plants, census[p].herbivores, census[p].predators, census[p].bySpecies);
            const trophic = { 1: tr(1), 2: tr(2) };
            // Per-player medal signals (marginGrew / trophicImproved). Computed
            // here — the only point that runs EVERY round, including the final one
            // (which jumps straight to GAME_OVER, skipping _detectMilestones). They
            // are captured verbatim so traj.py reads the engine's exact booleans
            // (zero recompute drift) and used to count this match's medals.
            const signals = this._computeRoundSignals(scores, trophic);
            this._countRoundMedals(signals);
            captureRound({
                schema: 1,
                match_uid: this.matchUid || null,
                seed: this.seed,
                round: this.turns.round,
                census,
                events: this.simulation.getEvents ? this.simulation.getEvents() : null,
                final_score: scores,
                score_history: this._scoreHistory[this._scoreHistory.length - 1] || null,
                trophic,
                signals,
            });
        } catch (_) { /* capture must never break the round */ }
    }

    // Per-player quality signals for this round, as deltas vs the previous round.
    // Updates prev* in place. Shared rule with traj.py (see js/medal.js).
    _computeRoundSignals(scores, trophic) {
        if (!this._milestones) this._resetMilestones();
        const ms = this._milestones;
        const out = {};
        for (const p of [1, 2]) {
            const other = p === 1 ? 2 : 1;
            const margin = (scores[p]?.finalScore || 0) - (scores[other]?.finalScore || 0);
            const t = trophic[p] || { health: 0, risk: 1, state: 'empty' };
            const marginGrew = margin > ms.prevMargin[p];
            const trophicImproved = t.health > ms.prevHealth[p]
                && t.risk <= ms.prevRisk[p]
                && t.state !== 'collapsing';
            out[p] = { marginGrew, trophicImproved };
            ms.prevMargin[p] = margin;
            ms.prevHealth[p] = t.health;
            ms.prevRisk[p] = t.risk;
        }
        ms.roundSignals = out;
        return out;
    }

    // Classify + tally this round's medals from the signals + each player's
    // real-answer flag. Runs every round (called from _captureRound). Display is
    // handled separately in _detectMilestones, which reads ms.roundTier.
    _countRoundMedals(signals) {
        const ms = this._milestones;
        if (!ms) return;
        ms.roundTier = { 1: null, 2: null };
        for (const p of [1, 2]) {
            const real = !!(this._roundMoveReal && this._roundMoveReal[p]);
            const sig = signals[p] || {};
            const tier = liveTier({ real, marginGrew: sig.marginGrew, trophicImproved: sig.trophicImproved });
            if (tier === 'pending') ms.pending[p] += 1;
            else if (tier === MEDAL.BRONZE) ms.bronze[p] += 1;
            ms.roundTier[p] = tier;
        }
        this._roundMoveReal = {};   // consumed — reset for next round's turns
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _log(msg, opts = {}) {
        // Legacy action-log (kept for any code that reads from it)
        const log = document.getElementById('action-log');
        let cls;
        if (opts.player === 1 || /^P1 /.test(msg)) cls = 'p1';
        else if (opts.player === 2 || /^P2 /.test(msg)) cls = 'p2';
        else cls = 'system';

        if (log) {
            const entry = document.createElement('div');
            entry.className = `entry ${cls}`;
            entry.textContent = msg;
            log.insertBefore(entry, log.firstChild);
            while (log.children.length > 60) log.removeChild(log.lastChild);
        }

        // New canvas-integrated ticker + persistent history
        this._tickerHistory = this._tickerHistory || [];
        this._tickerHistory.unshift({ ts: Date.now(), msg, cls });
        if (this._tickerHistory.length > 200) this._tickerHistory.length = 200;
        this._pushTickerEntry({ msg, cls });
    }

    _logStyled(msg, className) {
        const log = document.getElementById('action-log');
        if (log) {
            const entry = document.createElement('div');
            entry.className = `entry ${className}`;
            entry.textContent = msg;
            log.insertBefore(entry, log.firstChild);
            while (log.children.length > 60) log.removeChild(log.lastChild);
        }
        this._tickerHistory = this._tickerHistory || [];
        const cls = className.split(' ').find(c => c === 'p1' || c === 'p2') || 'system';
        this._tickerHistory.unshift({ ts: Date.now(), msg, cls });
        if (this._tickerHistory.length > 200) this._tickerHistory.length = 200;
        this._pushTickerEntry({ msg, cls });
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

        // End turn button (legacy, in hidden container)
        const btn = document.getElementById('btn-end-turn');
        if (btn) {
            btn.disabled = !this.turns.isPlayerTurn();
            btn.textContent = player ? `End P${player} Turn` : 'End Turn';
        }

        // Species dock visibility + tile affordance update
        this._refreshSpeciesDockState();
    }

    _updateWorldInfo() {
        const info = document.getElementById('info-content');
        const counts = { WATER: 0, FERTILE: 0, GRASSLAND: 0, ROCKY: 0 };
        this.grid.forEach(cell => { counts[cell.terrain]++; });

        info.innerHTML = `
            <div class="info-row"><span>Seed</span><span>${this.seed}</span></div>
            <div class="info-row"><span>Grid</span><span>${this.grid.cols} x ${this.grid.rows}</span></div>
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

        const p1Short = this._playerTag(1, { withPrefix: false });
        const p2Short = this._playerTag(2, { withPrefix: false });

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

        // Fighting-game HUD: end-cap avatars + score-share health bar.
        this._syncSbAvatar(document.getElementById('sb-ava-p1'), this.aiPlayers[1]?.model);
        this._syncSbAvatar(document.getElementById('sb-ava-p2'), this.aiPlayers[2]?.model);
        const barP1 = document.getElementById('sb-bar-p1');
        if (barP1) {
            const tot = s1.finalScore + s2.finalScore;
            barP1.style.width = (tot > 0 ? (s1.finalScore / tot) * 100 : 50).toFixed(1) + '%';
        }

        // Head-to-head win odds — persistent below the live lead for the whole match,
        // so the ELO-implied favorite stays visible while the actual score plays out.
        const oddsEl = document.getElementById('sb-odds');
        if (oddsEl) {
            if (this._matchupOdds) {
                const { p1Win, p2Win } = this._matchupOdds;
                const favPct = Math.round(Math.max(p1Win, p2Win) * 100);
                if (Math.abs(p1Win - p2Win) < 0.02) {
                    oddsEl.className = 'sb-odds even';
                    oddsEl.innerHTML = `<span class="sb-odds-pct">EVEN</span><span class="sb-odds-tag">ODDS</span>`;
                } else {
                    const favIsP1 = p1Win > p2Win;
                    oddsEl.className = `sb-odds ${favIsP1 ? 'p1' : 'p2'}`;
                    oddsEl.innerHTML = `<span class="sb-odds-pct">${favPct}%</span><span class="sb-odds-arrow">${favIsP1 ? '◀' : '▶'}</span><span class="sb-odds-tag">ODDS</span>`;
                }
                oddsEl.style.display = '';
            } else {
                oddsEl.style.display = 'none';
            }
        }

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

    // Scoreboard end-cap avatar: paint when the slot is an AI (only on model
    // change — applyAvatar refetches otherwise), hide for humans.
    _syncSbAvatar(el, model) {
        if (!el) return;
        if (model) {
            if (el.dataset.model !== model) applyAvatar(el, model, { cover: false });
            el.style.display = '';
        } else {
            clearAvatar(el);
            el.style.display = 'none';
        }
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
            // MEDAL detection — per-player running state for the in-game
            // training-data celebration (see _countRoundMedals / _detectMilestones).
            // pending = 2-signal moves (gold if this side wins, silver if not);
            // bronze = 1-signal moves (win-independent). prev* hold last round's
            // values so each round's signals are a delta. roundTier/roundSignals
            // are this round's computed result, handed from capture to display.
            pending:    { 1: 0, 2: 0 },
            bronze:     { 1: 0, 2: 0 },
            prevMargin: { 1: 0, 2: 0 },
            prevHealth: { 1: 0, 2: 0 },
            prevRisk:   { 1: 1, 2: 1 },
            roundTier:    null,
            roundSignals: null,
        };
        this._calloutQueue = [];
        this._calloutBusy = false;
        // Clear both cards' medal trays for the new match.
        this._renderMedalStars(1);
        this._renderMedalStars(2);
    }

    // Paint a player's on-board card with this match's medal candidates: one
    // GOLD-tinted ☆ per "pending" move (2 quality signals — gold if this side
    // wins, silver if not) and one COPPER ☆ per bronze move (1 signal, already
    // certain). Counts come from _milestones.pending/bronze (filled in
    // _countRoundMedals). `pop` pops the newest star of the named group, then
    // yields to the idle shimmer. Hidden when there's nothing yet.
    _renderMedalStars(playerNum, pop = null) {
        const el = document.getElementById(`aic-golds-p${playerNum}`);
        if (!el) return;
        const ms = this._milestones || {};
        const nPending = (ms.pending?.[playerNum]) || 0;
        const nBronze = (ms.bronze?.[playerNum]) || 0;
        if (nPending <= 0 && nBronze <= 0) { el.hidden = true; el.innerHTML = ''; return; }
        el.hidden = false;
        const total = nPending + nBronze;
        el.setAttribute('aria-label',
            `${nPending} potential gold/silver and ${nBronze} bronze move${total !== 1 ? 's' : ''} this match`);
        // Rebuilt deterministically each round: pending (gold) first, then bronze.
        let html = '';
        for (let i = 0; i < nPending; i++) {
            const popCls = (pop === 'pending' && i === nPending - 1) ? ' pop' : '';
            html += `<span class="aic-medal-star pending${popCls}">☆</span>`;
        }
        for (let i = 0; i < nBronze; i++) {
            const popCls = (pop === 'bronze' && i === nBronze - 1) ? ' pop' : '';
            html += `<span class="aic-medal-star bronze${popCls}">☆</span>`;
        }
        el.innerHTML = html;
    }

    // End-screen medal summary. The match outcome resolves every "pending" move:
    // the winner's become GOLD (captured for training), the loser's become SILVER
    // (strong play, no win); bronze is win-independent. `medals` is
    // {gold, silver, bronze} from _medalTally(). `el` is a screen's medal slot
    // (#go-golds / #t-result-golds). Hidden when nothing to show.
    _renderMedalsEarned(el, medals) {
        if (!el) return;
        const gold = medals?.gold || 0, silver = medals?.silver || 0, bronze = medals?.bronze || 0;
        if (gold <= 0 && silver <= 0 && bronze <= 0) { el.hidden = true; el.innerHTML = ''; return; }
        el.hidden = false;
        const row = (n, cls, label) => {
            if (n <= 0) return '';
            const stars = Array.from({ length: n }, (_, i) =>
                `<span class="gw-star ${cls}" style="animation-delay:${i * 90}ms">★</span>`).join('');
            return `<div class="gw-row"><div class="gw-stars">${stars}</div>` +
                `<div class="gw-label ${cls}">${label}</div></div>`;
        };
        el.innerHTML =
            row(gold, 'gold', `${gold} gold — captured for training`) +
            row(silver, 'silver', `${silver} silver — strong play, no win`) +
            row(bronze, 'bronze', `${bronze} bronze — logged`);
    }

    // Resolve this match's per-tier totals across BOTH players from the live
    // pending/bronze counts + who won. winSlot is 1, 2, or 0 (tie). On a tie
    // nobody won, so every pending move is silver.
    _medalTally(winSlot) {
        const ms = this._milestones || {};
        const pending = ms.pending || { 1: 0, 2: 0 };
        const bronze = ms.bronze || { 1: 0, 2: 0 };
        let gold = 0, silver = 0;
        if (winSlot === 1 || winSlot === 2) {
            const lose = winSlot === 1 ? 2 : 1;
            gold = pending[winSlot] || 0;
            silver = pending[lose] || 0;
        } else {
            silver = (pending[1] || 0) + (pending[2] || 0);
        }
        return { gold, silver, bronze: (bronze[1] || 0) + (bronze[2] || 0) };
    }

    _dispatchCallout({ text, subtitle = '', tone = 'neutral', sound = 'callout' }) {
        this._calloutQueue = this._calloutQueue || [];
        this._calloutQueue.push({ text, subtitle, tone, sound });
        if (!this._calloutBusy) {
            // Starting a fresh drain — create a promise the sequencer can await
            this._calloutsDone = new Promise(resolve => { this._calloutsDoneResolve = resolve; });
            this._beginMoment();
            this._drainCallouts();
        }
    }

    _waitForCalloutsDone() {
        return this._calloutsDone || Promise.resolve();
    }

    _drainCallouts() {
        if (!this._calloutQueue || this._calloutQueue.length === 0) {
            this._finishCalloutDrain();
            return;
        }
        this._calloutBusy = true;
        const { text, subtitle, tone, sound = 'callout' } = this._calloutQueue.shift();

        const el = document.getElementById('callout');
        const tEl = document.getElementById('co-text');
        const sEl = document.getElementById('co-subtitle');
        if (!el || !tEl) { this._finishCalloutDrain(); return; }

        tEl.textContent = text;
        sEl.textContent = subtitle || '';
        sEl.style.display = subtitle ? '' : 'none';

        // Rank-drama tones (a leaderboard surprise) get a bigger entrance and a
        // longer hold so the moment lands as a celebration, not a flicker.
        const isRankDrama = RANK_DRAMA_TONES.has(tone);

        el.className = 'co-hidden'; // reset
        void el.offsetWidth;
        el.className = isRankDrama ? `tone-${tone} co-rank` : `tone-${tone}`;
        this._playSound(sound);

        // Flare any visible event stage to match the headline (upset → magenta,
        // new champion → gold). Cleared when the callout hides. See .event-stage
        // tint rules in style.css.
        const stageTone = tone === 'upset' ? 'event-upset' : (tone === 'throne' ? 'event-throne' : null);
        document.body.classList.remove('event-upset', 'event-throne');
        if (stageTone) document.body.classList.add(stageTone);

        const holdMs = isRankDrama ? 3000 : 2400;
        clearTimeout(this._coTimer);
        this._coTimer = setTimeout(() => {
            el.className = 'co-hidden';
            document.body.classList.remove('event-upset', 'event-throne');
            setTimeout(() => this._drainCallouts(), 220);
        }, holdMs);
    }

    // Drain finished (or aborted) — release the moment lock and resolve any
    // sequencer awaiting the queue. Idempotent guards keep the moment ref-count
    // balanced even on the missing-element early-out.
    _finishCalloutDrain() {
        this._calloutBusy = false;
        this._calloutQueue = [];
        this._endMoment();
        this._calloutsDoneResolve?.();
        this._calloutsDoneResolve = null;
        this._calloutsDone = null;
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

        // MEDAL MOVE — surface the tier this round earned (counted already in
        // _captureRound, which runs every round incl. the final one). A "pending"
        // move is a strong play whose gold/silver fate waits on the match result;
        // bronze is already certain. Pure presentation here — no counting.
        if (isCaptureEnabled() && ms.roundTier) {
            for (const p of [1, 2]) {
                const tier = ms.roundTier[p];
                if (tier === 'pending') {
                    this._renderMedalStars(p, 'pending');
                    this._dispatchCallout({
                        text: 'STRONG MOVE',
                        subtitle: `${this._playerTag(p)} · gold if you win · silver if not`,
                        tone: 'gold',
                        sound: 'score',
                    });
                } else if (tier === MEDAL.BRONZE) {
                    this._renderMedalStars(p, 'bronze');
                    this._dispatchCallout({
                        text: 'BRONZE MOVE',
                        subtitle: `${this._playerTag(p)} · logged for quality metrics`,
                        tone: 'neutral',
                        sound: 'callout',
                    });
                }
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

    _playerTag(p, { withPrefix = true } = {}) {
        const ai = this.aiPlayers[p];
        if (!ai) return `Player ${p}`;
        const short = ai.model.replace(/:.*$/, '').split('/').pop();
        return withPrefix ? `P${p} · ${short}` : short;
    }

    // ── Round-end recap card ──────────────────────────────────

    // Round recap — leads with a causal *story* (who ate whom, which chains
    // broke or completed, who's ahead and why), with the food-chain viz and a
    // compact delta strip as support. The narrative is driven by the
    // simulation's per-round event tally (simulation.getEvents()); the numbers
    // alone never explained *why* the board changed.
    _showRecap(prevSnapshot) {
        const census = this.simulation.census();
        const events = this.simulation.getEvents?.() || null;
        const scores = this.simulation.finalScore();

        const story = this._composeRecapStory(prevSnapshot, census, events, scores);
        const deltas = this._recapDeltas(prevSnapshot, census);

        if (story.lines.length === 0 && deltas.length === 0) return Promise.resolve(); // nothing notable

        this._playSound('recap');

        const el = document.getElementById('recap-card');
        const hEl = document.getElementById('rc-header');
        const bEl = document.getElementById('rc-body');
        if (!el || !bEl) return Promise.resolve();

        hEl.textContent = `Round ${this.turns.round} Recap`;

        let html = '';
        if (story.lines.length) {
            html += `<div class="rc-story">` + story.lines.map(l =>
                `<div class="rc-head rc-p${l.player} ${l.tone || ''}">${l.text}</div>`
            ).join('') + `</div>`;
        }
        if (story.leader) {
            html += `<div class="rc-leader rc-p${story.leader.player}">`
                + `<span class="rc-tag">P${story.leader.player}</span>`
                + `<span class="rc-lead-txt">leads — ${story.leader.reason}</span></div>`;
        } else {
            html += `<div class="rc-leader rc-even">Neck and neck</div>`;
        }
        html += this._renderTrophicChain(census);
        if (deltas.length) {
            html += `<div class="rc-deltas">` + deltas.map(l => {
                const sign = l.delta > 0 ? '+' : '';
                const dir = l.delta > 0 ? 'up' : 'down';
                return `<div class="rc-line rc-p${l.player}">`
                    + `<span class="rc-tag">P${l.player}</span>`
                    + `<span class="rc-dlabel">${l.label}</span>`
                    + `<span class="rc-delta ${dir}">${sign}${l.delta}</span></div>`;
            }).join('') + `</div>`;
        }
        bEl.innerHTML = html;

        el.className = 'recap-hidden';
        void el.offsetWidth;
        el.className = '';

        this._beginMoment();
        return new Promise(resolve => {
            clearTimeout(this._recapTimer);
            this._recapTimer = setTimeout(() => {
                el.classList.add('recap-hidden');
                this._endMoment();
                resolve();
            }, 4200);
        });
    }

    // Roll up species counts into trophic-tier totals (plants/herbivores/predators).
    _tierCounts(bySpecies) {
        let plants = 0, herbivores = 0, predators = 0;
        for (const [sp, n] of Object.entries(bySpecies || {})) {
            const t = CONFIG.SPECIES[sp]?.type;
            if (t === 'plant') plants += n;
            else if (t === 'herbivore') herbivores += n;
            else if (t === 'predator') predators += n;
        }
        return { plants, herbivores, predators };
    }

    // Pick the 1–2 most dramatic *true* events of the round + a "who leads & why" line.
    _composeRecapStory(prevSnapshot, census, events, scores) {
        const cands = [];
        const predName = CONFIG.SPECIES.PREDATOR.name;

        for (const p of [1, 2]) {
            const ev = events?.[p] || {};
            const actor = this._playerTag(p, { withPrefix: false });
            const b = this._tierCounts(prevSnapshot?.[p]?.bySpecies);
            const a = census[p] || {};

            // Collapse — a whole tier present before is gone now (most dramatic).
            if (b.herbivores > 0 && (a.herbivores || 0) === 0) {
                cands.push({ player: p, tone: 'tone-alert', w: 100, text: `${actor}'s herbivores were wiped out — food chain broken` });
            } else if (b.predators > 0 && (a.predators || 0) === 0) {
                cands.push({ player: p, tone: 'tone-alert', w: 95, text: `${actor}'s ${predName}s vanished — top of the chain collapsed` });
            }

            // Food chain completed this round → trophic bonus earned.
            const hadAll = b.plants > 0 && b.herbivores > 0 && b.predators > 0;
            const hasAll = (a.plants || 0) > 0 && (a.herbivores || 0) > 0 && (a.predators || 0) > 0;
            if (!hadAll && hasAll) {
                cands.push({ player: p, tone: 'tone-gold', w: 90, text: `${actor} completed the food chain — +25% bonus` });
            }

            // Predation surge.
            if ((ev.preyKilled || 0) >= 3) {
                cands.push({ player: p, tone: '', w: 50 + ev.preyKilled, text: `${actor}'s ${predName}s hunted down ${ev.preyKilled} herbivores` });
            }
            // Starvation.
            const starved = (ev.herbStarved || 0) + (ev.predStarved || 0);
            if (starved >= 4) {
                cands.push({ player: p, tone: '', w: 38 + starved, text: `${actor} lost ${starved} animals to starvation` });
            }
            // Population surge.
            const born = (ev.herbBorn || 0) + (ev.predBorn || 0);
            if (born >= 4) {
                cands.push({ player: p, tone: '', w: 30 + born, text: `${actor}'s herds bred — ${born} new animals born` });
            }
            // Plant spread.
            if ((ev.plantsSpread || 0) >= 6) {
                cands.push({ player: p, tone: '', w: 20 + Math.floor(ev.plantsSpread / 2), text: `${actor}'s plants spread across ${ev.plantsSpread} new cells` });
            }
            // Grazing pressure.
            if ((ev.plantsEaten || 0) >= 6) {
                cands.push({ player: p, tone: '', w: 18 + Math.floor(ev.plantsEaten / 2), text: `${actor}'s grazers cleared ${ev.plantsEaten} plants` });
            }
        }

        cands.sort((a, b) => b.w - a.w);
        const lines = cands.slice(0, 2);

        // Leader & reason — reuse finalScore()'s multipliers to explain the lead.
        let leader = null;
        const s1 = scores[1].finalScore, s2 = scores[2].finalScore;
        const total = Math.max(1, Math.max(s1, s2));
        const margin = Math.abs(s1 - s2) / total;
        if ((s1 > 0 || s2 > 0) && margin > 0.06) {
            const lp = s1 > s2 ? 1 : 2;
            const op = lp === 1 ? 2 : 1;
            const ls = scores[lp], os = scores[op];
            let reason;
            if (ls.hasTrophic && !os.hasTrophic) reason = 'a complete food chain';
            else if (ls.speciesCount > os.speciesCount) reason = `richer diversity (${ls.speciesCount} species)`;
            else reason = 'greater biomass';
            leader = { player: lp, reason };
        }
        return { lines, leader };
    }

    // Top few species count changes, labelled with their trophic tier so the
    // invented names stop being opaque.
    _recapDeltas(prevSnapshot, census) {
        const lines = [];
        for (const p of [1, 2]) {
            const before = prevSnapshot?.[p];
            const after = census[p];
            if (!before || !after) continue;
            for (const sp of ['GRASS', 'SHRUB', 'TREE', 'GRAZER', 'BROWSER', 'PREDATOR']) {
                const diff = (after.bySpecies?.[sp] || 0) - (before.bySpecies?.[sp] || 0);
                if (Math.abs(diff) >= 2) {
                    const spec = CONFIG.SPECIES[sp];
                    lines.push({ player: p, label: `${spec?.name || sp} · ${spec?.type || ''}`, delta: diff });
                }
            }
        }
        lines.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
        return lines.slice(0, 4);
    }

    _snapshotCensus() {
        const census = this.simulation.census();
        return {
            1: { biomass: census[1].biomass, bySpecies: { ...census[1].bySpecies } },
            2: { biomass: census[2].biomass, bySpecies: { ...census[2].bySpecies } },
        };
    }

    _showRoundTransition(nextRound, { isFinalRound = false } = {}) {
        const overlay = document.getElementById('round-transition');
        const numEl = document.getElementById('rt-number');
        const subEl = document.getElementById('rt-subline');
        const labelEl = overlay?.querySelector('.rt-label');
        if (!overlay || !numEl) return Promise.resolve();

        numEl.textContent = isFinalRound ? 'FINAL' : nextRound;
        if (labelEl) labelEl.textContent = isFinalRound ? 'CHAMPIONSHIP' : 'ROUND';

        // Subline shows current leader (if any meaningful margin)
        const scores = this.simulation.finalScore();
        const diff = scores[1].finalScore - scores[2].finalScore;
        const total = Math.max(1, Math.max(scores[1].finalScore, scores[2].finalScore));
        const margin = Math.abs(diff) / total;
        const prefix = isFinalRound ? 'Last round · ' : '';
        subEl.className = 'rt-subline';
        if (margin > 0.08 && diff > 0) {
            subEl.textContent = `${prefix}${isFinalRound ? 'P1 leads' : 'P1 leading'}`;
            subEl.classList.add('p1');
        } else if (margin > 0.08 && diff < 0) {
            subEl.textContent = `${prefix}${isFinalRound ? 'P2 leads' : 'P2 leading'}`;
            subEl.classList.add('p2');
        } else if (scores[1].finalScore > 0 || scores[2].finalScore > 0) {
            subEl.textContent = `${prefix}Neck and neck`;
        } else {
            subEl.textContent = isFinalRound ? 'Last round' : '';
        }

        // Restart the animation by toggling class off/on (and apply/remove rt-final modifier)
        overlay.classList.toggle('rt-final', isFinalRound);
        overlay.classList.add('rt-hidden');
        void overlay.offsetWidth;
        overlay.classList.remove('rt-hidden');
        this._playSound('round');

        // Final round holds longer so the moment lands — 2.5s instead of 1.5s
        const holdMs = isFinalRound ? 2500 : 1500;
        this._beginMoment();
        return new Promise(resolve => {
            clearTimeout(this._rtHideTimer);
            this._rtHideTimer = setTimeout(() => {
                overlay.classList.add('rt-hidden');
                this._endMoment();
                resolve();
            }, holdMs);
        });
    }

    _drawScoreChart() {
        const canvas = document.getElementById('score-chart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        // Size the bitmap to the canvas's on-screen box (the timeline column
        // grows with the board-width console), DPR-aware so the line stays crisp
        // instead of being stretched from a fixed 320×64. Draw in CSS pixels.
        const dpr = window.devicePixelRatio || 1;
        const W = Math.max(1, Math.round(canvas.clientWidth || 320));
        const H = Math.max(1, Math.round(canvas.clientHeight || 64));
        const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
        if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

        drawLine('p1', `hsl(${CONFIG.PLAYER_1.PRIMARY.h}, 70%, 60%)`);
        drawLine('p2', `hsl(${CONFIG.PLAYER_2.PRIMARY.h}, 75%, 62%)`);
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

        this._renderBiomassTower(census);
        updateBiomeRosters(census);
        this.biosphere?.update(census, this.simulation?.getEvents?.());
    }

    _renderBiomassTower(census) {
        // Trophic pyramid. The ideal width of each tier is DERIVED from the energy
        // economy and the live species mix (via trophicRead → js/ecobalance.js), not
        // a fixed 9:3:1 — a tier is sized to what the tier beneath it can feed, so a
        // tree-heavy base wants a narrower herbivore band than a grass base. Each tier
        // radiates from the central spine: a faint TARGET outline (+ tick) marks the
        // ideal width, a solid FILL marks the actual count, both on one shared scale.
        // A gap between fill and tick = starving tier; fill past the tick = overpopulated.
        const MIN_PCT = 5;     // a nonzero tier always shows a sliver
        const CAP = 100;       // a tier can't fill past its half of the bar

        // Shared scale: the larger plant base spans a full half-width, so both
        // pyramids stay comparable — a bigger healthy biome is a physically
        // bigger pyramid, while P1-vs-P2 within a tier reads off the same ruler.
        const S = Math.max(census[1].plants || 0, census[2].plants || 0, 1);
        const w = (v) => (v <= 0 ? 0 : Math.max(MIN_PCT, Math.min(CAP, Math.round((v / S) * 100))));
        const idealW = (v) => Math.min(CAP, Math.round((v / S) * 100));

        const health = (actual, ideal) => {
            if (actual <= 0) return ideal <= 0 ? 'empty' : 'under';
            if (ideal <= 0) return 'over';              // a tier with nothing beneath to feed it
            const r = actual / ideal;
            if (r < 0.5) return 'under';
            if (r > 1.75) return 'over';
            return 'good';
        };

        for (const p of [1, 2]) {
            const c = census[p];
            const plants = c.plants || 0, herbs = c.herbivores || 0, preds = c.predators || 0;
            // Derived targets cascade down the chain — same read the orb and the
            // per-player badge use, so the whole panel tells one story.
            const r = trophicRead(plants, herbs, preds, c.bySpecies);
            const tiers = [
                { key: 'pred',  actual: preds,  ideal: r.idealPred, health: health(preds, r.idealPred) },
                { key: 'herb',  actual: herbs,  ideal: r.idealHerb, health: health(herbs, r.idealHerb) },
                // The base sets the pyramid's footprint; its only "target" is to exist.
                { key: 'plant', actual: plants, ideal: plants,      health: plants > 0 ? 'good' : 'empty' },
            ];
            for (const t of tiers) {
                const bar = document.getElementById(`bt-bar-${t.key}-p${p}`);
                const fill = document.getElementById(`bt-fill-${t.key}-p${p}`);
                const cnt = document.getElementById(`bt-count-${t.key}-p${p}`);
                if (fill) fill.style.width = `${w(t.actual)}%`;
                if (cnt) cnt.textContent = String(t.actual);
                if (bar) {
                    bar.style.setProperty('--ideal', `${idealW(t.ideal)}%`);
                    bar.dataset.health = t.health;
                }
            }
        }

        for (const p of [1, 2]) {
            const c = census[p];
            const state = this._ecosystemHealth(c);
            const badge = document.getElementById(`bt-health-p${p}`);
            if (!badge) continue;
            badge.dataset.state = state.state;
            const icon = badge.querySelector('.bt-h-icon');
            if (icon) icon.textContent = state.icon;
        }
    }

    _renderTrophicChain(census) {
        const tiers = [
            { key: 'plants',     icon: '🌿', label: 'Plants' },
            { key: 'herbivores', icon: '🦌', label: 'Herbivores' },
            { key: 'predators',  icon: '🦅', label: 'Predators' },
        ];

        const chainRow = (p) => {
            const c = census[p] || {};
            const complete = (c.plants || 0) > 0 && (c.herbivores || 0) > 0 && (c.predators || 0) > 0;
            const nodes = tiers.map((t, i) => {
                const present = (c[t.key] || 0) > 0;
                const cls = present ? 'tc-on' : 'tc-off';
                const connector = i > 0
                    ? `<span class="tc-link ${present && (c[tiers[i-1].key] || 0) > 0 ? 'tc-active' : 'tc-broken'}"></span>`
                    : '';
                return connector + `<span class="tc-node ${cls}" title="${t.label}: ${c[t.key] || 0}">${t.icon}</span>`;
            }).join('');
            const badge = complete
                ? `<span class="tc-badge tc-badge-on">×1.25</span>`
                : `<span class="tc-badge tc-badge-off">chain broken</span>`;
            return `<div class="tc-row tc-p${p}"><span class="tc-row-tag">P${p}</span>${nodes}${badge}</div>`;
        };

        return `
            <div class="trophic-chain">
                <div class="tc-title">Food chain</div>
                ${chainRow(1)}
                ${chainRow(2)}
            </div>
        `;
    }

    _ecosystemHealth(c) {
        // Read the SAME trophic model the info orb uses, so the per-player badge
        // and the central orb tell one coherent story. Base failing (herbivores
        // with nothing to eat) is grave (collapse); a tilt or apex glut is a warn.
        const r = trophicRead(c.plants, c.herbivores, c.predators, c.bySpecies);
        if (r.state === 'empty') return { state: 'empty', icon: '–' };
        // Only a failing BASE (herbivores with nothing to eat) is grave. Predators
        // starving for lack of herbivores is an apex hiccup — a warn, matching the
        // orb's "PREDATORS STARVING". A primordial/building web is simply ok.
        if (r.baseStarved) return { state: 'collapse', icon: '✕' };
        if (r.apexStarved || r.state === 'overgrazed' || r.state === 'top-heavy')
            return { state: 'warn', icon: '⚠' };
        return { state: 'ok', icon: '✓' };
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

        // Retire the live broadcast flanks (a watch match raised them) before the
        // result scene covers the board.
        this.tournament?._hideMatchFlanks();

        // Paint the result scene immediately — before any populate logic that could
        // throw — so a watch/solo match ALWAYS visibly ends. (Regression guard: a
        // downstream throw used to leave the final board with no overlay at all.)
        const overlay = document.getElementById('game-over-overlay');
        if (overlay) overlay.style.display = 'flex';

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

        const winnerEl = overlay?.querySelector('.winner');
        if (winnerEl) winnerEl.textContent = winnerLabel;

        // Winner's portrait, large with a victory glow (AI winner only; a human or
        // tie shows no creature).
        const winnerModel = s1.finalScore > s2.finalScore ? this.aiPlayers[1]?.model
            : s2.finalScore > s1.finalScore ? this.aiPlayers[2]?.model : null;
        const goAva = document.getElementById('go-winner-avatar');
        if (goAva) {
            // Victory clip if the winner has one baked; else the still portrait.
            if (winnerModel) { applyAvatarVideo(goAva, winnerModel, { category: 'victory' }); goAva.classList.add('show'); }
            else { clearAvatar(goAva); goAva.classList.remove('show'); }
        }

        // Medals: the win resolves every pending move — winner's → gold (trained),
        // loser's → silver; bronze is win-independent. Ties make all pending silver.
        const winSlot = s1.finalScore > s2.finalScore ? 1 : s2.finalScore > s1.finalScore ? 2 : 0;
        this._renderMedalsEarned(document.getElementById('go-golds'), this._medalTally(winSlot));

        this._playSound('victory');

        const card = overlay.querySelector('.game-over-card');
        card?.classList.remove('t-tier-win', 't-tier-promote', 't-tier-throne', 't-tier-upset', 't-tier-massive');

        // Reset the match-detail dashboard each game over — hidden until a ranked
        // result lands (the toggle is wired in the _recordCasualResult callback).
        const goDash = document.getElementById('go-dashboard');
        const goDashBtn = document.getElementById('btn-go-dashboard');
        goDash?.classList.add('md-hidden');
        if (goDash) goDash.innerHTML = '';
        if (goDashBtn) goDashBtn.hidden = true;
        const scoreHistorySnapshot = [...this._scoreHistory];

        // Solo + Watch matches now count toward the leaderboard. Post the
        // result, then stage any rank drama (upset / promotion / throne) as its
        // own beat — a short pause after the match-end fanfare so the two don't
        // collide. The callout queue hushes the ticker while it plays.
        this._recordCasualResult(scores).then(res => {
            if (res?.result) {
                // Colour the card to the stakes and, on the big tiers, fire a
                // celebratory spark burst. The tier-scaled SOUND comes from the
                // _celebrateResult callout below (so 'victory' → tier sting builds
                // rather than double-plays the same cue).
                const drama = this._resultDrama(res.result);
                card?.classList.add(`t-tier-${drama.tier}`);
                if (drama.tier !== 'win') this._burstSparks(card, drama.tier);
                setTimeout(() => this._celebrateResult(res.result), 800);

                // Wire the match-detail dashboard — one card with score bars, the
                // ELO each model carried into this match → after, and a score chart.
                const dashMatch = {
                    label: 'Ranked Match',
                    p1: res.result.p1?.name,
                    p2: res.result.p2?.name,
                    winner: res.result.winner,
                    scores: { 1: { finalScore: s1.finalScore }, 2: { finalScore: s2.finalScore } },
                    scoreHistory: scoreHistorySnapshot,
                    eloResult: res.result,
                };
                if (goDashBtn && goDash) {
                    goDashBtn.hidden = false;
                    goDashBtn.onclick = () => {
                        const open = goDash.classList.toggle('md-hidden') === false;
                        if (open && !goDash.dataset.rendered) {
                            goDash.innerHTML = buildSingleMatchDashboard(dashMatch);
                            paintDashboard(goDash, { matches: [dashMatch] });
                            goDash.dataset.rendered = '1';
                        }
                    };
                    delete goDash.dataset.rendered;
                }
            }
        });
        overlay.querySelector('.final-score').innerHTML =
            breakdown(p1Label, s1, 'final-stmt-p1') + breakdown(p2Label, s2, 'final-stmt-p2');

        // Headless gauntlet/generation loop: auto-start the next watch match.
        if (this._genWatch) {
            setTimeout(() => {
                overlay.style.display = 'none';
                try { this._startMatch(this._genWatch); } catch (e) { console.error('[gen]', e); }
            }, 2500);
        }

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

        // Per-turn guard: the finally below ends the turn exactly once. Reset here
        // so a fresh turn can advance again. (Human turns never reach this method,
        // so their manual end-turn flow is untouched.)
        this._turnEnded = false;
        this._aiThinking = true;
        this._log(`P${playerNum} AI (${ai.model}) thinking...`);

        // Make sure card identity is set (rank/place stays visible permanently)
        this._setAICardIdentity(playerNum);

        // Refresh matchup intel before the prompt is built so the fighter always
        // knows who it's up against (and avoids the setup race where P1 is wired
        // before P2 exists). One local rankings fetch — cheap, and keeps rank/record
        // current across sequential tournament matches.
        await this._syncFighterContext();

        const bEl = document.getElementById(`ai-banter-p${playerNum}`);
        const sEl = document.getElementById(`ai-strategy-p${playerNum}`);
        const toggle = document.getElementById(`aic-reason-toggle-p${playerNum}`);
        const avatarEl = document.getElementById(`aic-avatar-p${playerNum}`);
        // Clear previous banter and mark as thinking — placeholder renders "thinking…"
        if (bEl) {
            bEl.textContent = '';
            bEl.classList.add('thinking');
            bEl.classList.remove('entering');
        }
        // Swap the HUD avatar from its idle loop to the thinking clip while the model
        // computes (falls back to the still/procedural if no thinking clip is baked).
        if (avatarEl) applyAvatarVideo(avatarEl, ai.model, { category: 'thinking', loop: true });
        if (sEl) {
            sEl.textContent = '';
            sEl.classList.add('aic-reason-collapsed');
        }
        if (toggle) {
            toggle.style.display = 'none';
            toggle.setAttribute('aria-expanded', 'false');
        }

        // Start the move-clock countdown so the wait has stakes — it ticks toward
        // the same deadline the model call self-limits to.
        this._startThinkingCountdown(playerNum, ai.timeoutMs());
        // If the local model is cold, surface a "loading model…" state until it's
        // resident (runs concurrently with takeTurn, which triggers the load).
        this._startModelLoadWatch(playerNum, ai.model);

        this._updateTurnUI();

        // Brief delay so the UI updates before the async call
        await this._sleep(300);

        try {
            // Game-level watchdog. takeTurn() self-limits (and now aborts) its model
            // call, but if it ever fails to settle at all — a never-resolving await —
            // this forces the turn to fail rather than freeze the entire match (and,
            // in a tournament, the whole bracket). Ceiling sits above the model-call
            // timeout so it only fires on a genuine hang, never a slow-but-fine call.
            const watchdog = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('turn watchdog tripped')), ai.timeoutMs() + 15_000));
            const result = await Promise.race([ai.takeTurn(), watchdog]);

            // Move resolved — stop the clock and drop the thinking state.
            this._stopThinkingCountdown(playerNum);

            // Record whether THIS round's move was a real model answer (not a
            // fallback) for the in-game GOLD MOVE check at round end.
            this._roundMoveReal = this._roundMoveReal || {};
            this._roundMoveReal[playerNum] = !result.degraded;
            if (bEl) { bEl.classList.remove('thinking', 'system'); }
            if (bEl && result.degraded) {
                // The model didn't really answer — speak to it in the game's voice
                // instead of leaving the response area mute.
                bEl.textContent = this._degradedQuip(playerNum, result.failReason);
                bEl.classList.add('system');
                bEl.classList.remove('entering');
                void bEl.offsetWidth;
                bEl.classList.add('entering');
                if (toggle) toggle.style.display = 'none';
            } else if (bEl && result.banter) {
                bEl.textContent = result.banter;
                bEl.classList.remove('entering');
                void bEl.offsetWidth;
                bEl.classList.add('entering');
                if (sEl && result.reasoning) {
                    sEl.textContent = result.reasoning;
                    // Reasoning stays collapsed by default but the toggle becomes available
                    if (toggle) toggle.style.display = '';
                }
            } else if (bEl) {
                bEl.textContent = '';
            }
            // Status stays as rank/place — no temporary overwrite

            // Log banter to action log too
            if (result.degraded) {
                this._logStyled(`P${playerNum} ⚠ ${result.failReason} — fell back to grass`, `banter p${playerNum}`);
            } else if (result.banter) {
                this._logStyled(`P${playerNum}: "${result.banter}"`, `banter p${playerNum}`);
            }
            if (result.reasoning && !result.degraded) {
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
        } catch (err) {
            // A failed AI turn must never freeze the game. Log it and let the finally
            // advance — the player simply forfeits this turn's placements.
            console.error(`[AI] P${playerNum} turn failed — advancing anyway:`, err);
            this._log(`P${playerNum} turn error (${err.message}) — turn skipped`);
            // Speak to the hang in the game's voice rather than leaving it mute.
            this._stopThinkingCountdown(playerNum);
            if (bEl) {
                bEl.classList.remove('thinking');
                bEl.textContent = this._degradedQuip(playerNum, 'hang');
                bEl.classList.add('system');
                void bEl.offsetWidth;
                bEl.classList.add('entering');
            }
            if (toggle) toggle.style.display = 'none';
        } finally {
            this._teardownAITurn(playerNum);
        }
    }

    // End an AI turn exactly once, clearing the "thinking" state regardless of how
    // the turn finished (success, exception, or watchdog). This is the single
    // chokepoint that guarantees the phase machine always advances.
    _teardownAITurn(playerNum) {
        this._aiThinking = false;
        this._stopThinkingCountdown(playerNum);
        this._stopModelLoadWatch(playerNum);
        const bEl = document.getElementById(`ai-banter-p${playerNum}`);
        if (bEl) bEl.classList.remove('thinking');
        // Revert the HUD avatar from its thinking clip back to the idle loop, however
        // the turn finished (success, error, or watchdog) — this is the single clear point.
        const ai = this.aiPlayers[playerNum];
        const avatarEl = document.getElementById(`aic-avatar-p${playerNum}`);
        if (ai && avatarEl) applyAvatarVideo(avatarEl, ai.model, { category: 'idle', loop: true });
        if (this._turnEnded) return;
        this._turnEnded = true;
        this.turns.endTurn();
    }

    // ── Move-clock countdown ─────────────────────────────────────
    // Tick a card's countdown toward the model's deadline so the wait has stakes;
    // it turns "urgent" (hot + pulsing) in the final stretch.
    _startThinkingCountdown(playerNum, totalMs) {
        this._cdTimers = this._cdTimers || {};
        this._stopThinkingCountdown(playerNum);
        const el = document.getElementById(`aic-countdown-p${playerNum}`);
        if (!el) return;
        const numEl = el.querySelector('.aic-cd-num');
        const fillEl = el.querySelector('.aic-cd-bar-fill');
        const start = Date.now();
        // Urgent in the last 20% of the budget (but at least the final 10s).
        const urgentAt = Math.max(10_000, totalMs * 0.2);
        const tick = () => {
            const remaining = Math.max(0, totalMs - (Date.now() - start));
            if (numEl) numEl.textContent = `${Math.ceil(remaining / 1000)}s`;
            if (fillEl) fillEl.style.width = `${(remaining / totalMs) * 100}%`;
            el.classList.toggle('urgent', remaining <= urgentAt);
        };
        tick();
        this._cdTimers[playerNum] = setInterval(tick, 250);
    }

    _stopThinkingCountdown(playerNum) {
        if (this._cdTimers && this._cdTimers[playerNum]) {
            clearInterval(this._cdTimers[playerNum]);
            delete this._cdTimers[playerNum];
        }
        const el = document.getElementById(`aic-countdown-p${playerNum}`);
        if (el) el.classList.remove('urgent');
    }

    // ── Model-load indicator ─────────────────────────────────────
    // A local model that isn't resident in VRAM cold-loads when first called
    // (notably between tournament matches, where the prior models are evicted).
    // While it loads, show a "loading model…" spinner on the card's countdown
    // instead of the move clock; flip to the normal countdown the moment the
    // model goes resident. Cloud models never load locally, so they're skipped.
    async _startModelLoadWatch(playerNum, model) {
        this._loadWatch = this._loadWatch || {};
        this._stopModelLoadWatch(playerNum);
        if (!model || isCloudModel(model)) return;

        // Token guards against a stale async check landing after teardown.
        const token = (this._loadWatchToken = (this._loadWatchToken || 0) + 1);
        const entry = { token, timer: null };
        this._loadWatch[playerNum] = entry;

        const setLoading = (on) => {
            const el = document.getElementById(`aic-countdown-p${playerNum}`);
            if (el) el.classList.toggle('model-loading', on);
            const label = el?.querySelector('.aic-cd-label');
            if (label) label.textContent = on ? 'loading model…' : 'deciding…';
        };
        const finish = () => { this._stopModelLoadWatch(playerNum); };

        // If it's already warm, never flash a loading state.
        const resident = await isModelResident(model);
        if (entry.token !== this._loadWatch[playerNum]?.token) return; // superseded
        if (resident) return;

        setLoading(true);
        entry.timer = setInterval(async () => {
            if (entry.token !== this._loadWatch[playerNum]?.token) { clearInterval(entry.timer); return; }
            if (await isModelResident(model)) finish();
        }, 700);
    }

    _stopModelLoadWatch(playerNum) {
        const entry = this._loadWatch?.[playerNum];
        if (entry?.timer) clearInterval(entry.timer);
        if (this._loadWatch) delete this._loadWatch[playerNum];
        const el = document.getElementById(`aic-countdown-p${playerNum}`);
        if (el) el.classList.remove('model-loading');
        const label = el?.querySelector('.aic-cd-label');
        if (label) label.textContent = 'deciding…';
    }

    // A concise character name for system-voice lines (family label when known,
    // else the properly-cased first word of the display name).
    _aiCharacterName(model) {
        const id = resolveModel(model);
        if (id.family.id !== 'generic') return id.family.label;
        return id.displayName.split(' ')[0] || 'The challenger';
    }

    // Game-friendly announcer line for a degraded turn — keeps the card in-character
    // instead of going silent when the model times out, drops, or babbles.
    _degradedQuip(playerNum, reason) {
        const ai = this.aiPlayers[playerNum];
        const name = ai ? this._aiCharacterName(ai.model) : `Player ${playerNum}`;
        const pools = {
            timeout: [
                `⏱ ${name} overthought it — the clock ran out and instinct scattered grass.`,
                `⏱ Too slow! ${name} missed the window and fell back on muscle memory.`,
                `⏱ ${name} is still calculating… the round moved on without them.`,
            ],
            offline: [
                `📡 Lost contact with ${name} — autopilot planted grass to hold the line.`,
                `📡 ${name} dropped off the grid this round. Instinct took the wheel.`,
                `📡 Signal to ${name} flickered out — a reflex move keeps them in the game.`,
            ],
            badjson: [
                `💬 ${name} muttered something unparseable and defaulted to grass.`,
                `💬 ${name}'s plan came out as gibberish — grass it is.`,
                `💬 ${name} fumbled the playbook; reflexes planted grass instead.`,
            ],
            hang: [
                `🧊 ${name} froze solid — the match pressed on without their move.`,
                `🧊 ${name} locked up completely. No move this round.`,
            ],
        };
        const pool = pools[reason] || pools.offline;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    // Backstop for the fire-and-forget _runAITurn launches in _onPhaseChange: if the
    // promise rejects before its own try/finally can run (e.g. a throw in setup),
    // this still tears the turn down so the match can't stall.
    _failTurn(playerNum, err) {
        console.error(`[AI] P${playerNum} turn crashed before it could run — advancing:`, err);
        this._teardownAITurn(playerNum);
    }

    // Preload this match's local models (skip cloud) and evict any other resident
    // model — keeps peak residency bounded to the current match's models. Awaited
    // before the clock starts so cold load stays out of the per-turn budget.
    async _warmForMatch(models) {
        try {
            return await prepareResidentSet(models);
        } catch (e) {
            console.warn('[warm] prepareResidentSet failed (match continues):', e);
            return null;
        }
    }

    setAI(playerNum, model) {
        this.aiPlayers[playerNum] = new AIPlayer(this, playerNum, { model });
        // An AI is playing → this match produces training trajectories.
        setCaptureEnabled(true);
        this._log(`P${playerNum} is now AI (${model})`);
        this._setAICardIdentity(playerNum);
        // Surface identity in the header immediately — don't wait for the first move.
        this._updateScoreboard();
        this._updateMatchupOdds();
        // Feed both fighters their matchup intel (name/rank/record) for prompts.
        this._syncFighterContext();
    }

    removeAI(playerNum) {
        delete this.aiPlayers[playerNum];
        this._log(`P${playerNum} is now Human`);
        this._setAICardIdentity(playerNum);
        this._matchupOdds = null;
        this._updateScoreboard();
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
        this._retired = await fetchRoster();
        await this._loadModelMeta();   // ranking + record + form, for the cards

        // Retired models are benched — never selectable as an opponent.
        const available = this._installedModels.filter(m => !this._retired.has(m.name));

        for (const select of selects) {
            const prevValue = select.value;
            select.innerHTML = '';

            if (available.length === 0) {
                const opt = document.createElement('option');
                opt.value = '';
                opt.textContent = 'No models available — is Ollama running?';
                select.appendChild(opt);
                continue;
            }

            for (const m of available) {
                const opt = document.createElement('option');
                opt.value = m.name;
                const size = formatModelSize(m.size);
                opt.textContent = size ? `${m.name}  (${size})` : m.name;
                select.appendChild(opt);
            }
            if (prevValue && available.some(m => m.name === prevValue)) {
                select.value = prevValue;
            }
        }

        // Set sensible defaults: prefer cloud models, pick two truly different ones for Watch
        if (available.length === 0) { this._wirePickerPreviews(); return; }
        const installed = available;
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

        this._wirePickerPreviews();
    }

    // ── Rich model cards + ranked picker grid ─────────────────
    // The hidden <select>s hold the chosen value (start logic reads .value); the
    // cards render that choice with ranking/record/form, and the grid modal lets
    // you browse the standings to pick.

    // Human-readable size, or '' for cloud models (which report a placeholder
    // size that rounds to "0 MB" — noise on the card).
    _modelSizeLabel(bytes) {
        const s = formatModelSize(bytes);
        return (!s || s === '0 MB') ? '' : s;
    }

    _slotMap() {
        return {
            'p2-solo':  { selectId: 'match-model-p2-solo',  cardId: 'pcard-p2-solo',  role: 'Opponent' },
            'p1-watch': { selectId: 'match-model-p1-watch', cardId: 'pcard-p1-watch', role: 'Player 1' },
            'p2-watch': { selectId: 'match-model-p2-watch', cardId: 'pcard-p2-watch', role: 'Player 2' },
        };
    }

    // Build name → { elo, rank, wins, losses, games, winrate, form[] } from the
    // server's leaderboard + recent history. Unplayed models get null stats.
    async _loadModelMeta() {
        const [rankings, history] = await Promise.all([
            fetchRankings().catch(() => null),
            fetchHistory().catch(() => []),
        ]);
        const meta = new Map();
        let rank = 0;
        if (rankings) {
            for (const [name, s] of Object.entries(rankings)) {
                rank++;
                const games = s.matches ?? ((s.wins || 0) + (s.losses || 0));
                meta.set(name, {
                    elo: s.elo, rank,
                    wins: s.wins || 0, losses: s.losses || 0, games,
                    winrate: games ? Math.round((s.wins || 0) / games * 100) : null,
                    form: [],
                });
            }
        }
        // Last-5 form (W/L) per model, oldest→newest, from match history.
        for (const m of (history || [])) {
            if (!m || !m.winner) continue;
            for (const name of [m.p1, m.p2]) {
                if (!name) continue;
                let e = meta.get(name);
                if (!e) { e = { elo: null, rank: null, wins: 0, losses: 0, games: 0, winrate: null, form: [] }; meta.set(name, e); }
                e.form.push(m.winner === name ? 'W' : 'L');
            }
        }
        for (const e of meta.values()) e.form = e.form.slice(-5);
        this._modelMeta = meta;
    }

    // Wire each select's change → re-render its card + the watch odds, then paint
    // the current state. (Replaces the old avatar-only preview.)
    _wirePickerPreviews() {
        for (const slot of Object.keys(this._slotMap())) {
            const cfg = this._slotMap()[slot];
            const sel = document.getElementById(cfg.selectId);
            if (!sel) continue;
            if (!sel._cardWired) {
                sel.addEventListener('change', () => { this._renderModelCard(slot); this._renderWatchOdds(); });
                sel._cardWired = true;
            }
            this._renderModelCard(slot);
        }
        this._renderWatchOdds();
    }

    // Render the rich model card for one picker slot. (Named _renderModelCard to
    // avoid colliding with _renderPlayerCard, which renders prematch VS cards.)
    _renderModelCard(slot) {
        const cfg = this._slotMap()[slot];
        if (!cfg) return;
        const card = document.getElementById(cfg.cardId);
        const sel = document.getElementById(cfg.selectId);
        if (!card || !sel) return;

        const open = () => this._openModelGrid(slot);
        const name = sel.value;
        if (!name) {
            card.innerHTML = `<div class="mc-label">${cfg.role}</div>
                <div class="mc-empty">No models found<br><span>Is Ollama running?</span></div>
                <button type="button" class="mc-change">Manage models</button>`;
            card.querySelector('.mc-change').addEventListener('click', () => this._openModelConfigModal?.());
            return;
        }

        const id = resolveModel(name);
        const mt = this._modelMeta?.get(name) || null;
        const ranked = mt && mt.elo != null;
        const sizeM = this._installedModels?.find(m => m.name === name);
        const sizeStr = this._modelSizeLabel(sizeM?.size);

        const rankLine = ranked
            ? `<span class="mc-rank">#${mt.rank}</span><span class="mc-elo">${mt.elo}<i>ELO</i></span>`
            : `<span class="mc-rank mc-unranked">Unranked</span>`;
        const recLine = ranked
            ? `<span class="mc-rec">${mt.wins}–${mt.losses}</span>${mt.winrate != null ? `<span class="mc-wr">${mt.winrate}% WR</span>` : ''}`
            : `<span class="mc-rec mc-dim">no matches yet</span>`;
        const form = (mt?.form?.length)
            ? `<div class="mc-form" title="Recent form (newest right)">${mt.form.map(o => `<i class="mc-pip ${o === 'W' ? 'w' : 'l'}"></i>`).join('')}</div>`
            : '';

        card.innerHTML = `
            <div class="mc-label">${cfg.role}</div>
            <div class="mc-ava" data-ava role="button" tabindex="0" title="Change model"></div>
            <div class="mc-name" title="${name}">${this._prettyModelName(name)}</div>
            <div class="mc-statline">${rankLine}</div>
            <div class="mc-statline mc-recline">${recLine}</div>
            ${form}
            ${sizeStr ? `<div class="mc-size">${sizeStr}</div>` : ''}
            <button type="button" class="mc-change">Change ▾</button>
        `;
        applyAvatar(card.querySelector('[data-ava]'), name);
        card.querySelector('.mc-change').addEventListener('click', open);
        card.querySelector('.mc-ava').addEventListener('click', open);
        card.querySelector('.mc-ava').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        });
    }

    // Win-probability strip between the two Watch cards (from each side's ELO).
    _renderWatchOdds() {
        const vs = document.getElementById('watch-vs');
        if (!vs) return;
        const p1 = document.getElementById('match-model-p1-watch')?.value;
        const p2 = document.getElementById('match-model-p2-watch')?.value;
        const m1 = this._modelMeta?.get(p1), m2 = this._modelMeta?.get(p2);
        if (!m1 || !m2 || m1.elo == null || m2.elo == null) {
            vs.innerHTML = `<span class="mc-vs-word">VS</span>`;
            return;
        }
        const p1win = Math.round(expectedScore(m1.elo, m2.elo) * 100);
        vs.innerHTML = `<span class="mc-vs-word">VS</span>
            <div class="mc-odds">
                <span class="mc-odds-p1">${p1win}%</span>
                <span class="mc-odds-sep">·</span>
                <span class="mc-odds-p2">${100 - p1win}%</span>
            </div>`;
    }

    _openModelGrid(slot) {
        this._gridSlot = slot;
        this._gridSort = this._gridSort || 'elo';
        const modal = document.getElementById('model-grid-modal');
        const cfg = this._slotMap()[slot];
        const title = document.getElementById('mgm-title');
        if (title) title.textContent = `Choose — ${cfg?.role || 'model'}`;
        document.querySelectorAll('#mgm-sort button').forEach(b =>
            b.classList.toggle('on', b.dataset.sort === this._gridSort));
        if (modal) modal.style.display = '';
        this._renderModelGrid();
    }

    _closeModelGrid() {
        const modal = document.getElementById('model-grid-modal');
        if (modal) modal.style.display = 'none';
        this._gridSlot = null;
    }

    _renderModelGrid() {
        const grid = document.getElementById('mgm-grid');
        const slot = this._gridSlot;
        if (!grid || !slot) return;
        const cfg = this._slotMap()[slot];
        const current = document.getElementById(cfg.selectId)?.value;
        // Model in the *other* Watch slot — flagged so you don't pick a mirror match.
        let taken = null;
        if (slot === 'p1-watch') taken = document.getElementById('match-model-p2-watch')?.value;
        else if (slot === 'p2-watch') taken = document.getElementById('match-model-p1-watch')?.value;

        const meta = (n) => this._modelMeta?.get(n);
        const sort = this._gridSort || 'elo';
        const models = [...(this._installedModels || [])].sort((a, b) => {
            if (sort === 'name') return a.name.localeCompare(b.name);
            const ma = meta(a.name), mb = meta(b.name);
            if (sort === 'winrate') {
                const wa = ma?.winrate ?? -1, wb = mb?.winrate ?? -1;
                if (wb !== wa) return wb - wa;
            }
            const ea = ma?.elo ?? -1, eb = mb?.elo ?? -1;   // ranked before unranked
            if (eb !== ea) return eb - ea;
            return a.name.localeCompare(b.name);
        });

        grid.innerHTML = '';
        if (models.length === 0) {
            grid.innerHTML = `<div class="mc-empty">No models installed — open Manage Models to download one.</div>`;
            return;
        }
        for (const m of models) {
            const mt = meta(m.name);
            const ranked = mt && mt.elo != null;
            const sizeStr = this._modelSizeLabel(m.size);
            const isCur = m.name === current;
            const isTaken = taken && m.name === taken;
            const card = document.createElement('button');
            card.type = 'button';
            card.className = `mgm-card${isCur ? ' is-current' : ''}${isTaken ? ' is-taken' : ''}`;
            card.innerHTML = `
                <span class="mgm-c-ava" data-ava></span>
                <span class="mgm-c-body">
                    <span class="mgm-c-top">
                        <span class="mgm-c-name" title="${m.name}">${this._prettyModelName(m.name)}</span>
                        ${ranked ? `<span class="mgm-c-rankbadge">#${mt.rank}</span>` : ''}
                    </span>
                    <span class="mgm-c-meta">
                        ${ranked ? `<span class="mgm-c-elo">${mt.elo} ELO</span><span class="mgm-c-rec">${mt.wins}–${mt.losses}</span>${mt.winrate != null ? `<span class="mgm-c-wr">${mt.winrate}%</span>` : ''}`
                                 : `<span class="mgm-c-dim">unranked</span>`}
                        ${sizeStr ? `<span class="mgm-c-size">${sizeStr}</span>` : ''}
                    </span>
                    ${mt?.form?.length ? `<span class="mgm-c-form">${mt.form.map(o => `<i class="mc-pip ${o === 'W' ? 'w' : 'l'}"></i>`).join('')}</span>` : ''}
                </span>
                ${isCur ? `<span class="mgm-c-badge">Selected</span>` : (isTaken ? `<span class="mgm-c-badge taken">In use</span>` : '')}
            `;
            applyAvatar(card.querySelector('[data-ava]'), m.name);
            card.addEventListener('click', () => this._selectModelForSlot(slot, m.name));
            grid.appendChild(card);
        }
    }

    _selectModelForSlot(slot, name) {
        const cfg = this._slotMap()[slot];
        const sel = document.getElementById(cfg.selectId);
        if (sel) {
            sel.value = name;
            sel._userSet = true;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        this._closeModelGrid();
    }

    _pickDifferentModel(excludeName) {
        if (!this._installedModels || this._installedModels.length === 0) return null;
        const cloud = this._installedModels.filter(m => m.name.includes('cloud') && m.name !== excludeName);
        if (cloud.length > 0) return cloud[0].name;
        const other = this._installedModels.find(m => m.name !== excludeName);
        return other ? other.name : excludeName;
    }

    // ── Random / themed matchup picker ───────────────────────────
    // Pick a model pair by theme and fill the Watch slots (the user reviews +
    // can re-roll, then hits Start). Themes draw on per-model metadata: size
    // tier (resolveModel), local-vs-cloud (isCloudModel), and ELO (_modelMeta).
    _rollMatchup(theme) {
        const models = (this._installedModels || []).map(m => m.name);
        if (models.length < 2) { this._flashRollMsg('Need at least 2 installed models'); return; }
        const pair = this._pickPairForTheme(theme, models);
        if (!pair) { this._flashRollMsg(this._rollFailMsg(theme)); return; }
        this._flashRollMsg('');
        this._applyWatchPick(pair[0], pair[1]);
    }

    _rollSoloOpponent() {
        const models = (this._installedModels || []).map(m => m.name);
        if (!models.length) return;
        const pick = models[Math.floor(Math.random() * models.length)];
        const sel = document.getElementById('match-model-p2-solo');
        if (!sel) return;
        sel.value = pick;
        sel._userSet = true;
        sel.dispatchEvent(new Event('change'));
        this._pulseCard('pcard-p2-solo');
    }

    // Returns [p1, p2] distinct model names for the theme, or null if no pair fits.
    _pickPairForTheme(theme, models) {
        const pick2 = (arr) => {
            if (arr.length < 2) return null;
            const i = Math.floor(Math.random() * arr.length);
            let j = Math.floor(Math.random() * (arr.length - 1));
            if (j >= i) j++;
            return [arr[i], arr[j]];
        };
        const tierRank = { small: 0, mid: 1, large: 2, cloud: 3 };
        const sizeOf = (n) => this._installedModels.find(m => m.name === n)?.size || 0;
        const weight = (n) => (tierRank[resolveModel(n).sizeTier] ?? 1) * 1e13 + sizeOf(n);
        const eloOf = (n) => { const m = this._modelMeta?.get(n); return m && m.elo != null ? m.elo : null; };

        if (theme === 'david') {
            const sorted = [...models].sort((a, b) => weight(a) - weight(b));
            const light = sorted[0], heavy = sorted[sorted.length - 1];
            return (light && heavy && light !== heavy) ? [light, heavy] : null;   // David (P1) vs Goliath (P2)
        }
        if (theme === 'class') {
            // Same size tier first; fall back to same family.
            const group = (keyFn) => {
                const map = {};
                for (const n of models) (map[keyFn(n)] ||= []).push(n);
                const groups = Object.values(map).filter(g => g.length >= 2);
                return groups.length ? pick2(groups[Math.floor(Math.random() * groups.length)]) : null;
            };
            return group(n => resolveModel(n).sizeTier) || group(n => resolveModel(n).family.id);
        }
        if (theme === 'localcloud') {
            const cloud = models.filter(n => isCloudModel(n));
            const local = models.filter(n => !isCloudModel(n));
            if (!cloud.length || !local.length) return null;
            return [local[Math.floor(Math.random() * local.length)], cloud[Math.floor(Math.random() * cloud.length)]];
        }
        if (theme === 'even') {
            const ranked = models.filter(n => eloOf(n) != null);
            const pairs = [];
            for (let i = 0; i < ranked.length; i++) {
                for (let j = i + 1; j < ranked.length; j++) {
                    const p = expectedScore(eloOf(ranked[i]), eloOf(ranked[j]));
                    if (p >= 0.42 && p <= 0.58) pairs.push([ranked[i], ranked[j]]);
                }
            }
            return pairs.length ? pairs[Math.floor(Math.random() * pairs.length)] : null;
        }
        return pick2(models);   // 'random'
    }

    _rollFailMsg(theme) {
        return {
            localcloud: 'Need at least one local and one cloud model',
            even: 'No closely-rated pair yet — play more matches',
            class: 'No two models share a class',
        }[theme] || 'No pair fits that theme';
    }

    _applyWatchPick(p1, p2) {
        const s1 = document.getElementById('match-model-p1-watch');
        const s2 = document.getElementById('match-model-p2-watch');
        if (!s1 || !s2) return;
        s1.value = p1; s2.value = p2;
        s1._userSet = true; s2._userSet = true;
        s1.dispatchEvent(new Event('change'));
        s2.dispatchEvent(new Event('change'));
        this._pulseCard('pcard-p1-watch');
        this._pulseCard('pcard-p2-watch');
    }

    _pulseCard(id) {
        const c = document.getElementById(id);
        if (!c) return;
        c.classList.remove('mc-rolled');
        void c.offsetWidth;   // restart the animation
        c.classList.add('mc-rolled');
    }

    _flashRollMsg(text) {
        const el = document.getElementById('watch-roll-msg');
        if (!el) return;
        el.textContent = text || '';
        if (this._rollMsgTimer) clearTimeout(this._rollMsgTimer);
        if (text) this._rollMsgTimer = setTimeout(() => { el.textContent = ''; }, 2600);
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

        // Random / themed matchup pickers — fill the slots so the user can review
        // (and re-roll) before starting.
        document.getElementById('watch-roll')?.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-roll]');
            if (btn) this._rollMatchup(btn.dataset.roll);
        });
        document.getElementById('solo-roll')?.addEventListener('click', () => this._rollSoloOpponent());

        document.getElementById('btn-match-expand')?.addEventListener('click', () => {
            this._expandMatchSection();
        });

        // Track user changes to model pickers — distinguishes user choice from
        // the browser's auto-selected-first-option default
        for (const id of ['match-model-p2-solo', 'match-model-p1-watch', 'match-model-p2-watch']) {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => { el._userSet = true; });
        }

        // Ranked picker grid: close + sort controls
        document.getElementById('btn-mgm-close')?.addEventListener('click', () => this._closeModelGrid());
        document.querySelector('#model-grid-modal .mgm-backdrop')?.addEventListener('click', () => this._closeModelGrid());
        document.getElementById('mgm-sort')?.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-sort]');
            if (!btn) return;
            this._gridSort = btn.dataset.sort;
            btn.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === btn));
            this._renderModelGrid();
        });

        this._populateModelPickers();
        this._initWorldControls();
        this._initTournamentControls();
    }

    // Tournament format picker: bracket size (8/16/32) + format (field+seed
    // strategy). Round count lives in the shared World picker, not here.
    _initTournamentControls() {
        this._tournamentSize = 8;
        this._tournamentFormat = DEFAULT_FORMAT;

        const bindSeg = (id, set) => {
            const box = document.getElementById(id);
            if (!box) return;
            box.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-val]');
                if (!btn) return;
                set(btn.dataset.val);
                this._syncTournamentControls();
            });
        };
        bindSeg('t-size', (v) => { this._tournamentSize = Number(v); });
        bindSeg('t-format', (v) => { this._tournamentFormat = v; });

        // Hovering a format tile previews its blurb without committing the
        // selection; leaving the grid restores the chosen format's note.
        const fmtBox = document.getElementById('t-format');
        if (fmtBox) {
            fmtBox.addEventListener('mouseover', (e) => {
                const tile = e.target.closest('button[data-val]');
                if (tile) this._setFormatBlurb(tile.dataset.val);
            });
            fmtBox.addEventListener('mouseleave', () => this._setFormatBlurb());
        }
        this._syncTournamentControls();
    }

    // Highlight the active size/format buttons and show the chosen format's note.
    _syncTournamentControls() {
        const mark = (id, val) => {
            const box = document.getElementById(id);
            box?.querySelectorAll('button[data-val]').forEach(b =>
                b.classList.toggle('on', b.dataset.val === String(val)));
        };
        mark('t-size', this._tournamentSize);
        mark('t-format', this._tournamentFormat);
        this._setFormatBlurb();
    }

    // Write the blurb for `formatKey` (defaults to the selected format) into the
    // blurb line: the format's flavour text plus an honest one-liner on the
    // bracket the current install can actually field. Home Turf scopes to local
    // models, so its eligible count excludes cloud contenders.
    _setFormatBlurb(formatKey = this._tournamentFormat) {
        const blurbEl = document.getElementById('t-format-blurb');
        if (!blurbEl) return;
        const fmt = FORMATS[formatKey] || FORMATS[DEFAULT_FORMAT];
        const eligible = this._eligibleModelNames()
            .filter(n => !fmt.localOnly || !isCloudModel(n));
        let note = fmt.blurb;
        if (eligible.length) {
            const cap = this._largestBracketFor(eligible.length);
            const actual = Math.min(this._tournamentSize, cap);
            if (actual < this._tournamentSize) {
                note += ` — only ${eligible.length} eligible models, capped to a ${actual}-model bracket.`;
            } else if (eligible.length < actual) {
                note += ` — ${eligible.length} models, ${actual - eligible.length} slots filled by repeats.`;
            }
        }
        blurbEl.textContent = note;
    }

    // Models that can actually compete: chat models only (no embeddings, vision,
    // or code specialists — they can't follow the JSON action protocol fairly).
    _eligibleModelNames(models = this._installedModels || []) {
        return models
            .filter(m => !TOURNAMENT_EXCLUDE.test(m.name) && !this._retired?.has(m.name))
            .map(m => m.name);
    }

    // World settings: grid size / hex zoom / round count, shared across modes.
    _initWorldControls() {
        this._world = {
            mapSize: 'medium',
            hexZoom: CONFIG.HEX_ZOOM.default,
            rounds: CONFIG.GAME.TOTAL_ROUNDS,
            mapStrategy: 'mediated',   // how the board is presented to the AI (see js/map-strategies.js)
        };
        // In Auto, hex size is computed to fill; a preset uses the slider only
        // if the player actually moved it (otherwise it contain-fits too).
        this._hexZoomTouched = false;

        // Label each map-size button with its grid dimensions (CONFIG is the
        // source of truth, so the start screen always reflects real board sizes).
        for (const b of document.querySelectorAll('#world-mapsize button[data-val]')) {
            const m = CONFIG.MAPS[b.dataset.val];
            const dim = b.querySelector('.ws-seg-dim');
            if (m && dim) dim.textContent = `${m.cols}×${m.rows}`;
        }

        // Segmented controls: highlight the active button and update state.
        const bindSeg = (id, key, parse = (v) => v) => {
            const box = document.getElementById(id);
            if (!box) return;
            const sync = () => {
                for (const b of box.querySelectorAll('button')) {
                    b.classList.toggle('on', parse(b.dataset.val) === this._world[key]);
                }
            };
            box.addEventListener('click', (e) => {
                const btn = e.target.closest('button[data-val]');
                if (!btn) return;
                this._world[key] = parse(btn.dataset.val);
                sync();
                this._updateWorldSummary();
            });
            sync();
        };
        bindSeg('world-mapsize', 'mapSize');
        bindSeg('world-rounds', 'rounds', (v) => Number(v));
        bindSeg('world-mapstrategy', 'mapStrategy');

        // Hex-zoom slider with live px readout.
        const zoom = document.getElementById('world-hexzoom');
        const zoomVal = document.getElementById('world-hexzoom-val');
        if (zoom) {
            zoom.min = CONFIG.HEX_ZOOM.min;
            zoom.max = CONFIG.HEX_ZOOM.max;
            zoom.value = this._world.hexZoom;
            if (zoomVal) zoomVal.textContent = `${this._world.hexZoom}px`;
            zoom.addEventListener('input', () => {
                this._hexZoomTouched = true;
                this._world.hexZoom = Number(zoom.value);
                if (zoomVal) zoomVal.textContent = `${zoom.value}px`;
                this._updateWorldSummary();
            });
        }

        this._updateWorldSummary();
    }

    /** In "Fit screen" mode the hex size is computed, so the slider is inert —
     *  disable it and show "Auto-fit"; restore it for fixed presets. */
    _syncHexZoomEnabled() {
        const zoom = document.getElementById('world-hexzoom');
        const auto = this._world.mapSize === 'auto';
        if (zoom) {
            zoom.disabled = auto;
            zoom.closest('.mw-row')?.classList.toggle('mw-row-disabled', auto);
        }
        // Readout is set in _updateWorldSummary from the resolved hex size so it
        // matches the board (a preset contain-fits until the slider is touched).
    }

    /** One-line plain-language summary of the chosen world settings, shown
     *  under the controls so the player sees exactly what they're committing to. */
    _updateWorldSummary() {
        this._syncHexZoomEnabled();
        const el = document.getElementById('world-summary');
        if (!el) return;
        const w = this._world;
        const lightning = w.rounds <= CONFIG.GAME.LIGHTNING_ROUNDS ? ' ⚡' : '';
        const dims = this._resolveWorld(w);
        const cells = dims.cols * dims.rows;
        const approx = w.mapSize === 'auto' ? '~' : '';
        const sizeNote = w.mapSize === 'auto' ? ' · fits screen' : '';
        el.textContent = `${approx}${dims.cols} × ${dims.rows} board · ${cells.toLocaleString()} hexes${sizeNote} · ${w.rounds} rounds${lightning} · ${dims.hexSize}px`;
        // Keep the hex-zoom readout in sync with the size actually used.
        const zoomVal = document.getElementById('world-hexzoom-val');
        if (zoomVal) zoomVal.textContent = w.mapSize === 'auto' ? 'Auto-fit' : `${dims.hexSize}px`;
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
        // Refresh the format picker's "eligible models" note — the model list may
        // have finished loading since the controls were first initialised.
        if (mode === 'tournament') this._syncTournamentControls?.();
    }

    // Current world settings (grid size / hex zoom / round count), falling back
    // to config defaults if the UI hasn't initialized them yet.
    _worldSettings() {
        return this._world || {
            mapSize: 'medium',
            hexZoom: CONFIG.HEX_ZOOM.default,
            rounds: CONFIG.GAME.TOTAL_ROUNDS,
        };
    }

    // ── Responsive board layout ───────────────────────────────
    // The board fits the viewport: "Fit screen" (auto) keeps rows fixed, fills
    // the height with hex size and the width with columns; presets keep a fixed
    // cols×rows and scale the hex size to fill. See plan: responsive board.

    /** Usable board area = viewport minus the reserved header/footer bands and a
     *  small side margin. Mirrors the bands Renderer._fit() already subtracts. */
    _availableBoard() {
        const bs = getComputedStyle(document.body);
        const headerH = parseFloat(bs.getPropertyValue('--header-h')) || 0;
        const footerH = parseFloat(bs.getPropertyValue('--footer-h')) || 0;
        const SIDE = 16;
        return {
            availW: Math.max(120, window.innerWidth - SIDE * 2),
            availH: Math.max(120, window.innerHeight - headerH - footerH - SIDE),
        };
    }

    /** Largest hex size that fits a fixed cols×rows board in the area, from the
     *  HexGrid geometry (grid.js:getCanvasSize) + Renderer offsets (hexSize+4). */
    _containHex(cols, rows, availW, availH) {
        const SQRT3 = Math.sqrt(3);
        const sW = (availW - 8) / (1.5 * (cols - 1) + 4);
        const sH = (availH - 8) / (SQRT3 * (rows + 0.5) + 2);
        const s = Math.min(sW, sH);
        return Math.max(CONFIG.HEX_ZOOM.min, Math.min(s, CONFIG.AUTO_MAX_HEX));
    }

    /** Resolve world settings → concrete { cols, rows, hexSize } for grid build.
     *  'auto' fits the viewport (fixed rows, fill width with cols); presets keep
     *  fixed dimensions and scale the hex size to fill (slider overrides). */
    _resolveWorld(world) {
        const SQRT3 = Math.sqrt(3);
        const { availW, availH } = this._availableBoard();
        if (world.mapSize === 'auto') {
            const rows = CONFIG.FIT.rows;
            // hex size that fills the available height for those rows
            const sH = (availH - 8) / (SQRT3 * (rows + 0.5) + 2);
            const hexSize = Math.max(CONFIG.HEX_ZOOM.min, Math.min(sH, CONFIG.AUTO_MAX_HEX));
            // columns that fill the available width at that hex size
            const rawCols = Math.floor((availW - 8 - 4 * hexSize) / (1.5 * hexSize) + 1);
            const cols = Math.max(CONFIG.FIT.minCols, Math.min(rawCols, CONFIG.FIT.maxCols));
            return { cols, rows, hexSize: Math.round(hexSize * 10) / 10 };
        }
        const map = CONFIG.MAPS[world.mapSize] || CONFIG.MAPS.medium;
        const hexSize = this._hexZoomTouched
            ? (world.hexZoom || CONFIG.HEX_ZOOM.default)
            : this._containHex(map.cols, map.rows, availW, availH);
        return { cols: map.cols, rows: map.rows, hexSize: Math.round(hexSize * 10) / 10 };
    }

    /** Re-render the live board crisp to fill the current viewport. cols/rows are
     *  locked once the world is generated, so this only adjusts the hex size
     *  (contain-fit) — the board grows/shrinks with the window, never blurred. */
    _refitBoard() {
        if (!this.grid || !this.renderer) return;
        const { availW, availH } = this._availableBoard();
        this.renderer.setHexSize(this._containHex(this.grid.cols, this.grid.rows, availW, availH));
        this._reserveConsoleSpace(false);   // re-reserve console band + render
    }

    async _onStartMatchClick() {
        this._endDemo();   // a manually-started match is never a demo
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

        const cfg = { mode: this._matchMode, world: { ...this._worldSettings() } };
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

        // Kick off model warming as early as possible so cold load overlaps the
        // prematch animation + terrain generation instead of freezing the board.
        // Solo warms only P2 (P1 is human); watch warms both. Awaited just before
        // the clock starts. Best-effort — a warm failure only means the first turn
        // cold-loads inside the (now larger) budget, as before.
        const warmNeeded = config.mode === 'solo' ? [config.p2Model]
                         : config.mode === 'watch' ? [config.p1Model, config.p2Model]
                         : [];
        const warm = this._warmMatch(warmNeeded);
        this._warmPromise = warm.promise || Promise.resolve();

        // Solo matches are ranked under the human's handle — prompt once up front.
        if (config.mode === 'solo') {
            this._humanHandle = await this._ensureHandle();
        }

        // Solo/Watch matches clear any prior tournament state from the panel, then
        // play the shared match intro (which holds for model warming).
        if (config.mode === 'solo' || config.mode === 'watch') {
            this.setBracketAvailable({ available: false });
            const handle = this._humanHandle || this._getHandle() || 'You';
            try {
                await this._showMatchIntro({
                    p1: config.mode === 'solo' ? { isHuman: true, handle } : { model: config.p1Model },
                    p2: { model: config.p2Model },
                    label: 'MATCH BEGINS',
                    sound: 'vs',
                    minMs: 2200,
                    skippable: true,
                    warmPromise: warm.promise,
                    warmLabel: warm.label,
                    mode: config.mode,
                    world: config.world || this._worldSettings(),
                    rounds: (config.world || {}).rounds,
                });
            } catch (_) { /* ignore */ }
        }

        // Show both player cards (with their creature rosters) and reserve their
        // gutters before sizing the world, so the board fits between them. Icons
        // get re-tinted in _applyPlayerPalettes below.
        this._setMatchCardsActive(true);

        // Reset world: fresh seed, terrain, simulation, turn manager.
        // Grid size / hex zoom / round count come from the chosen world settings.
        const world = config.world || this._worldSettings();
        const dims = this._resolveWorld(world);
        this.seed = Math.floor(Math.random() * 100000);
        this._buildBoardCore(dims);
        this.turns = new TurnManager((phase) => this._onPhaseChange(phase));
        this.turns.totalRounds = world.rounds || CONFIG.GAME.TOTAL_ROUNDS;
        this.matchContext = this._describeMatch(config.mode, world.mapStrategy);
        this._resetMatchState();

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

        // Color the board organisms by model identity (anchored higher-rank, with
        // terrain + collision guards). Runs after AI assignment, before play.
        await this._applyPlayerPalettes();

        // Clear AI cards (banter, reasoning, identity)
        this._resetAICard(1);
        this._resetAICard(2);
        const log = document.getElementById('action-log');
        if (log) log.innerHTML = '';

        this._collapseMatchSection();
        this._setConsoleVisible(true);
        this._updateCensus();
        this._resetMilestones();

        // Ensure warming (started at the top of _startMatch) finished before the
        // clock starts, so cold load never eats a player's turn budget.
        try { await this._warmPromise; } catch (_) { /* best-effort */ }

        // Broadcast flanks: a single watch match (AI vs AI) gets the same rotating
        // corner panels as a tournament bout — scouting report, dossiers, standings,
        // match details, fun facts. Solo (human) matches stay clean.
        if (config.mode === 'watch') {
            this.tournament?.showWatchFlanks(config.p1Model, config.p2Model, world, 'watch');
        } else {
            this.tournament?._hideMatchFlanks();
        }

        this._playSound('match-start');
        this.turns.startGame();

        console.log(`Match started: mode=${config.mode}, p1=${config.p1Model || 'human'}, p2=${config.p2Model || 'human'}`);
    }

    // Map each player's model to its identity hue for the board organisms, then
    // write the result into CONFIG.PLAYER_x.PRIMARY — the single source the
    // renderer and organism art already read. Human slots restore the cyan/orange
    // defaults. The higher-ELO model anchors its true hue on a color collision;
    // ELO is a best-effort lookup, falling back to anchoring Player 1.
    async _applyPlayerPalettes() {
        const p1Model = this.aiPlayers[1]?.model || null;
        const p2Model = this.aiPlayers[2]?.model || null;

        let anchor = 1;
        if (p1Model && p2Model) {
            try {
                const [r1, r2] = await Promise.all([
                    this._fetchRanking(p1Model), this._fetchRanking(p2Model),
                ]);
                if (r2 && (!r1 || r2.elo > r1.elo)) anchor = 2;
            } catch (_) { /* anchor stays P1 */ }
        }

        const pal = resolvePlayerPalettes(p1Model, p2Model, {
            anchor,
            fallback: this._defaultPalettes,
        });
        Object.assign(CONFIG.PLAYER_1.PRIMARY, pal[1]);
        Object.assign(CONFIG.PLAYER_2.PRIMARY, pal[2]);
        // Drive the CSS HUD theme (scoreboard, stat bars, census, towers, etc.)
        // off the same hues. Rules keep their own sat/light; only the hue swaps.
        const root = document.documentElement.style;
        root.setProperty('--p1-hue', pal[1].h);
        root.setProperty('--p2-hue', pal[2].h);
        if (this.renderer) this.renderer.render();
        repaintBiomeRosterIcons();   // re-tint roster icons to the resolved hues
    }

    _collapseMatchSection() {
        // Match-section lives inside the launcher overlay now; hide the overlay.
        this._closeLauncherWelcome();
        this._closeModelConfigModal();
    }

    _expandMatchSection() {
        // Re-open match setup with the previously-selected mode.
        this._showLauncherSetup(this._matchMode || 'solo');
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

    // ── Human identity ───────────────────────────────────────

    _getHandle() {
        try { return localStorage.getItem('biome.handle') || null; } catch (_) { return null; }
    }

    // Resolve the human's leaderboard handle, prompting once if none is stored.
    _ensureHandle() {
        const existing = this._getHandle();
        if (existing) return Promise.resolve(existing);
        return new Promise(resolve => {
            const modal = document.getElementById('handle-modal');
            const input = document.getElementById('handle-input');
            const okBtn = document.getElementById('handle-ok');
            const skipBtn = document.getElementById('handle-skip');
            if (!modal || !input || !okBtn) { resolve('You'); return; }

            const finish = (name) => {
                const handle = (name || '').trim().slice(0, 24) || 'You';
                try { localStorage.setItem('biome.handle', handle); } catch (_) {}
                modal.classList.add('modal-hidden');
                okBtn.removeEventListener('click', onOk);
                skipBtn?.removeEventListener('click', onSkip);
                input.removeEventListener('keydown', onKey);
                resolve(handle);
            };
            const onOk = () => finish(input.value);
            const onSkip = () => finish('You');
            const onKey = (e) => { if (e.key === 'Enter') finish(input.value); };

            modal.classList.remove('modal-hidden');
            input.value = '';
            okBtn.addEventListener('click', onOk);
            skipBtn?.addEventListener('click', onSkip);
            input.addEventListener('keydown', onKey);
            setTimeout(() => input.focus(), 50);
        });
    }

    _shortName(n) {
        if (!n) return '—';
        return n.replace(/:.*$/, '').split('/').pop().replace(/-cloud$/, '').replace(/-latest$/, '');
    }

    // ── Ranked results for casual (solo/watch) matches ───────

    // Post a solo/watch result to the leaderboard and return the server's
    // { result, rankings } payload (or null when the match shouldn't count).
    async _recordCasualResult(scores) {
        const cfg = this._lastMatchConfig;
        if (!cfg || (cfg.mode !== 'solo' && cfg.mode !== 'watch')) return null;

        const handle = this._humanHandle || this._getHandle() || 'You';
        const p1Name = this.aiPlayers[1] ? this.aiPlayers[1].model : handle;
        const p2Name = this.aiPlayers[2] ? this.aiPlayers[2].model : handle;
        if (!p1Name || !p2Name || p1Name === p2Name) return null;

        const s1 = scores[1], s2 = scores[2];
        if (s1.finalScore === s2.finalScore) return null; // ties have no ELO winner

        const winner = s1.finalScore > s2.finalScore ? p1Name : p2Name;
        return await postResult({
            tournament_id: shortId(8),
            round: 0,
            p1: p1Name,
            p2: p2Name,
            p1_score: s1.finalScore,
            p2_score: s2.finalScore,
            winner,
            mode: cfg.mode,
            map_size: cfg.world?.mapSize || null,
            rounds: cfg.world?.rounds ?? null,
            map_strategy: cfg.world?.mapStrategy || 'mediated',
            match_uid: this.matchUid,
            seed: this.seed,
        });
    }

    // Turn a server result payload into dramatic callouts: throne change,
    // upset win, and rank promotion/demotion. Reuses the callout queue.
    // headlinesOnly: only the rare big moments (NEW CHAMPION / UPSET) play as
    // center-stage callouts. Promotions/demotions are shown elsewhere (the
    // tournament result card carries a rank badge), so they're skipped here to
    // avoid two overlapping celebrations. Solo/Watch call without the flag and
    // get the full set.
    _celebrateResult(result, { headlinesOnly = false } = {}) {
        if (!result) return 0;
        const sides = [result.p1, result.p2].filter(Boolean);
        const winnerName = result.winner;
        const winSide = sides.find(s => s.name === winnerName);
        const loseSide = sides.find(s => s.name !== winnerName);
        const queue = [];

        // New #1 — highest drama, fires first
        for (const s of sides) {
            if (s.rankAfter === 1 && s.rankBefore !== 1) {
                queue.push({ text: 'NEW CHAMPION 👑', subtitle: `${this._shortName(s.name)} seizes #1`, tone: 'throne', sound: 'champion' });
            }
        }

        // Upset — winner was a long shot
        if (winSide && result.winnerWinProb != null && result.winnerWinProb < 0.35) {
            const massive = result.winnerWinProb < 0.20;
            const gap = (winSide.rankBefore && loseSide?.rankBefore)
                ? `#${winSide.rankBefore} def. #${loseSide.rankBefore}`
                : `${Math.round(result.winnerWinProb * 100)}% odds to win`;
            queue.push({ text: massive ? 'MASSIVE UPSET!' : 'UPSET!', subtitle: gap, tone: 'upset', sound: 'upset' });
        }

        // Promotion / demotion — only when board position actually moved.
        // Skipped in headlinesOnly mode (the result card shows the rank badge).
        if (!headlinesOnly) {
            for (const s of sides) {
                if (s.rankBefore == null || s.rankAfter == null) continue;
                if (s.rankAfter === 1 && s.rankBefore !== 1) continue; // already crowned above
                if (s.rankAfter < s.rankBefore) {
                    queue.push({ text: `PROMOTED ▲  #${s.rankBefore} → #${s.rankAfter}`, subtitle: this._shortName(s.name), tone: 'promote', sound: 'promote' });
                } else if (s.rankAfter > s.rankBefore) {
                    queue.push({ text: `SLIPPED ▼  #${s.rankBefore} → #${s.rankAfter}`, subtitle: this._shortName(s.name), tone: 'demote', sound: 'callout' });
                }
            }
        }

        for (const c of queue) this._dispatchCallout(c);
        return queue.length;
    }

    // Classify a match result into a "drama tier" that drives how loud the
    // winner reveal celebrates. Thresholds intentionally mirror _celebrateResult
    // above so the result screen and the post-bracket headline callouts agree.
    // Returns { tier, sound, event, winnerSide }.
    _resultDrama(result) {
        const dull = { tier: 'win', sound: 'victory', event: null, winnerSide: null };
        if (!result) return dull;
        const sides = [result.p1, result.p2].filter(Boolean);
        const winnerSide = sides.find(s => s.name === result.winner) || null;

        // New #1 — highest drama.
        if (winnerSide && winnerSide.rankAfter === 1 && winnerSide.rankBefore !== 1) {
            return { tier: 'throne', sound: 'champion', event: 'event-throne', winnerSide };
        }
        // Upset — winner was a long shot.
        if (result.winnerWinProb != null && result.winnerWinProb < 0.35) {
            const massive = result.winnerWinProb < 0.20;
            return { tier: massive ? 'massive' : 'upset', sound: 'upset', event: 'event-upset', winnerSide };
        }
        // Promotion — winner climbed the board.
        if (winnerSide && winnerSide.rankBefore != null && winnerSide.rankAfter != null
            && winnerSide.rankAfter < winnerSide.rankBefore) {
            return { tier: 'promote', sound: 'promote', event: 'event-promote', winnerSide };
        }
        return { ...dull, winnerSide };
    }

    // One-shot celebratory particle burst behind a card: an expanding shockwave
    // ring plus a spray of sparks fired at randomized angles. Tinted by tier.
    // Self-cleans after the animation. Plain 'win' tiers are skipped by callers.
    _burstSparks(cardEl, tier = 'win') {
        if (!cardEl) return;
        const burst = document.createElement('div');
        burst.className = `fx-burst fx-tier-${tier}`;
        // Anchor the burst on the winner name (not the card's geometric centre,
        // which can be offset from the centred content). Falls back to the CSS
        // default (50% / 42%) if no focal element is found.
        const focus = cardEl.querySelector('.t-result-winner, .winner');
        if (focus) {
            const cr = cardEl.getBoundingClientRect();
            const fr = focus.getBoundingClientRect();
            burst.style.left = `${Math.round(fr.left + fr.width / 2 - cr.left)}px`;
            burst.style.top  = `${Math.round(fr.top + fr.height / 2 - cr.top)}px`;
        }
        const ring = document.createElement('div');
        ring.className = 'fx-ring';
        burst.appendChild(ring);
        const N = (tier === 'massive' || tier === 'throne') ? 18 : 12;
        for (let i = 0; i < N; i++) {
            const s = document.createElement('div');
            s.className = 'spark';
            // Even angular spread + jitter so it reads organic, not mechanical.
            const ang = (360 / N) * i + (Math.random() * 22 - 11);
            const dist = 70 + Math.random() * 60;
            s.style.setProperty('--a', `${ang}deg`);
            s.style.setProperty('--d', `${dist}px`);
            s.style.animationDelay = `${Math.random() * 80}ms`;
            burst.appendChild(s);
        }
        cardEl.appendChild(burst);
        setTimeout(() => burst.remove(), 1200);
    }

    // Count a number up to `to` over ~700ms, formatted with thousands separators
    // (so it reads "6,687", not the scoreboard's "6.7k"). RAF-driven; cancellable.
    _countUp(el, to) {
        if (!el) return;
        if (el._countRaf) cancelAnimationFrame(el._countRaf);
        const from = 0;
        const dur = 700;
        let start = null;
        const ease = t => 1 - Math.pow(1 - t, 3);
        const step = (ts) => {
            if (start == null) start = ts;
            const t = Math.min(1, (ts - start) / dur);
            const v = Math.round(from + (to - from) * ease(t));
            el.textContent = v.toLocaleString();
            if (t < 1) el._countRaf = requestAnimationFrame(step);
            else el._countRaf = null;
        };
        el._countRaf = requestAnimationFrame(step);
    }

    // Build a compact identity+ranking descriptor for one player slot, shaped for
    // AI prompt intel (Game → AIPlayer.opponent/selfContext). Human slots return a
    // bare { isHuman, name }.
    async _buildFighterDescriptor(playerNum) {
        const ai = this.aiPlayers[playerNum];
        if (!ai) {
            const handle = this._getHandle() || `Player ${playerNum} (human)`;
            return { isHuman: true, name: handle };
        }
        const id = resolveModel(ai.model);
        const r = await this._fetchRanking(ai.model);
        return {
            isHuman: false,
            name: this._prettyModelName(ai.model),
            vendor: id.vendor && id.vendor !== '—' ? id.vendor : null,
            archetype: id.family?.archetype ? titleCase(id.family.archetype) : null,
            tier: /cloud/i.test(ai.model) ? 'cloud' : 'local',
            elo: r ? Math.round(r.elo) : null,
            rank: r ? r.rank : null,
            wins: r ? r.wins : null,
            losses: r ? r.losses : null,
        };
    }

    // Push each AI fighter its own + its opponent's identity/ranking so prompts can
    // play the rivalry. Cheap (one rankings fetch, already cached per call) and
    // ELO is static within a match, so a sync at match setup is enough; _runAITurn
    // lazily ensures it if a slot was swapped without a re-sync.
    // What game is being played — fed into every AI prompt via game.matchContext
    // so the model can adapt strategy and voice to the format and stakes (the
    // prompt builder reads this; absent it, the lab still reports board scale).
    _describeMatch(mode, mapStrategy = 'mediated') {
        const labels = {
            solo: 'Solo ladder match (vs the house AI)',
            watch: 'Watch exhibition (AI vs AI)',
            tournament: 'Tournament — single-elimination bracket',
        };
        const stakes = {
            solo: 'STAKES: ranked ladder match — the result moves both fighters\' ELO.',
            watch: 'STAKES: ranked exhibition — the result still moves ELO.',
            tournament: 'STAKES: single-elimination — lose and you are OUT of the bracket. ELO on the line.',
        };
        return {
            mode, modeLabel: labels[mode] || mode, stakes: stakes[mode] || null,
            mapStrategy: mapStrategy || 'mediated',
        };
    }

    async _syncFighterContext() {
        const descriptors = {};
        for (const p of [1, 2]) descriptors[p] = await this._buildFighterDescriptor(p);
        for (const p of [1, 2]) {
            const ai = this.aiPlayers[p];
            if (!ai) continue;
            ai.selfContext = descriptors[p];
            ai.opponent = descriptors[p === 1 ? 2 : 1];
        }
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

        let initials, displayName, role, meta, lookupName;
        if (isHuman) {
            const handle = opts.handle || this._humanHandle || this._getHandle() || 'You';
            initials = 'YOU';
            displayName = handle;
            role = `Player ${player}`;
            meta = 'Human';
            lookupName = handle;
        } else {
            initials = this._modelInitials(model);
            displayName = this._prettyModelName(model);
            role = `Player ${player}`;
            meta = model.includes('cloud') ? 'Cloud Model' : 'Local Model';
            lookupName = model;
        }

        // Initial render without ELO data, then update once fetched
        el.innerHTML = `
            <div class="pc-role">${role}</div>
            <div class="pc-rank" data-rank></div>
            <div class="pc-avatar">${initials}</div>
            <div class="pc-name">${displayName}</div>
            <div class="pc-stats">
                <div class="pc-stat elo"><span class="pc-stat-value" data-elo>—</span><span class="pc-stat-label">ELO</span></div>
                <div class="pc-stat wins"><span class="pc-stat-value" data-wins>—</span><span class="pc-stat-label">Wins</span></div>
                <div class="pc-stat losses"><span class="pc-stat-value" data-losses>—</span><span class="pc-stat-label">Loss</span></div>
            </div>
            <div class="pc-meta">${meta}</div>
        `;

        // Baked cyber-organic portrait for AI players (humans keep the "YOU" chip).
        // The match-result screen passes opts.clip ('victory'|'defeat') so the hex
        // plays the winner's/loser's animated clip instead of the still (falls back
        // to the still automatically if no clip is baked for that model). The match
        // intro passes clip:'intro' with clipLoop:false so the entrance plays once
        // rather than re-looping; the looping clips (victory/defeat/champion) leave
        // clipLoop undefined and default to true.
        if (!isHuman && model) {
            const avaEl = el.querySelector('.pc-avatar');
            if (opts.clip) applyAvatarVideo(avaEl, model, { category: opts.clip, loop: opts.clipLoop !== false });
            else applyAvatar(avaEl, model);
        }

        if (lookupName) {
            const r = await this._fetchRanking(lookupName);
            if (r) {
                const eloEl = el.querySelector('[data-elo]');
                const winsEl = el.querySelector('[data-wins]');
                const lossEl = el.querySelector('[data-losses]');
                const rankEl = el.querySelector('[data-rank]');
                if (eloEl) eloEl.textContent = Math.round(r.elo);
                if (winsEl) winsEl.textContent = r.wins;
                if (lossEl) lossEl.textContent = r.losses;
                if (rankEl) rankEl.textContent = `#${r.rank}`;
            }
        }
    }

    // Orchestrate model warming for a match: kick off prepareResidentSet for the
    // local models that need loading (cloud models are no-ops) and return the
    // promise plus a label for the warming UI. One warming entry point for every
    // mode — solo/watch and tournament both call this.
    _warmMatch(models) {
        const local = (models || []).filter(m => m && !isCloudModel(m));
        const promise = local.length ? this._warmForMatch(models) : null;
        const label = local.length === 1 ? this._prettyModelName(local[0]) : 'models';
        return { promise, label, hasLocal: local.length > 0 };
    }

    // Unified match intro / onboarding — the fighting-game VS reveal used by every
    // mode (solo, watch, tournament). Renders both fighters' cards, win odds, the
    // slam-in entrance + sound, and (if a local model is still cold-loading) holds
    // the screen with the "warming" shimmer until it's resident, so the board never
    // opens to an idle, frozen-looking state. Resolves when the intro is done.
    //
    // opts: { p1:{model|isHuman,handle}, p2:{model}, label, note, isFinal,
    //         warmPromise, warmLabel, sound, minMs, skippable }
    // Populate the match-intro "ARENA" panel from the match config: game type +
    // stakes, map size/dims/rounds, and the AI's vision (map strategy + meaning).
    // All values are config-derived, so this runs before terrain is generated.
    _renderMatchArena(opts = {}) {
        const panel = document.getElementById('match-arena');
        if (!panel) return;

        const world = opts.world || this._worldSettings();
        const mode = opts.mode || this._matchMode || 'solo';
        const desc = this._describeMatch(mode, world.mapStrategy);

        // Game type — short label + glyph (the modeLabel is the verbose form).
        const TYPE_META = {
            solo: { icon: '⚔', name: 'Solo Ladder' },
            watch: { icon: '📺', name: 'Exhibition' },
            tournament: { icon: '🏆', name: 'Tournament' },
        };
        const type = TYPE_META[mode] || { icon: '◆', name: mode };

        // Map size + grid dimensions (resolved the same way the board will be).
        const dims = this._resolveWorld(world);
        const sizeLabel = world.mapSize === 'auto'
            ? 'Auto-fit'
            : (CONFIG.MAPS[world.mapSize]?.label || 'Custom');

        // Round count + lightning badge for short matches.
        const rounds = opts.rounds ?? world.rounds ?? CONFIG.GAME.TOTAL_ROUNDS;
        const lightning = rounds <= CONFIG.GAME.LIGHTNING_ROUNDS;

        // Vision = map strategy (UI calls it "Map vision"). Friendly names match
        // the dashboard's: mediated → Standard, ascii → ASCII, raw → Raw.
        const strat = getStrategy(world.mapStrategy);
        const VISION_NAMES = { mediated: 'Standard', ascii: 'ASCII', 'ascii-ext': 'ASCII+', raw: 'Raw' };
        const visionName = VISION_NAMES[strat.id] || strat.label;

        const nameEl = document.getElementById('ma-vision-name');
        const descEl = document.getElementById('ma-vision-desc');
        if (nameEl) nameEl.textContent = visionName;
        if (descEl) descEl.textContent = strat.description || '';

        const chips = [
            `<span class="ma-chip"><span class="ma-chip-ico">${type.icon}</span>${type.name}</span>`,
            `<span class="ma-chip"><span class="ma-chip-ico">▦</span>${sizeLabel} · ${dims.cols}×${dims.rows}</span>`,
            `<span class="ma-chip${lightning ? ' ma-chip-fast' : ''}"><span class="ma-chip-ico">${lightning ? '⚡' : '◷'}</span>${rounds} rounds</span>`,
        ];
        const statsEl = document.getElementById('ma-stats');
        if (statsEl) statsEl.innerHTML = chips.join('');

        const stakesEl = document.getElementById('ma-stakes');
        if (stakesEl) stakesEl.textContent = (desc.stakes || '').replace(/^STAKES:\s*/, '');
    }

    async _showMatchIntro(opts = {}) {
        const overlay = document.getElementById('tournament-overlay');
        const screen = document.getElementById('match-intro');
        if (!overlay || !screen) return;

        overlay.querySelectorAll('.t-screen').forEach(s => s.classList.add('t-hidden'));
        screen.classList.remove('t-hidden');
        overlay.classList.remove('t-hidden');
        screen.classList.toggle('t-intro-champ', !!opts.isFinal);
        screen.classList.remove('t-warming');

        const labelEl = document.getElementById('match-intro-label');
        const noteEl = document.getElementById('match-intro-note');
        const baseNote = opts.note || (opts.skippable ? 'Click anywhere to skip' : '');
        if (labelEl) labelEl.textContent = opts.label || '';
        if (noteEl) noteEl.textContent = baseNote;

        // Match-detail panel: game type, map, and the AI's vision (map strategy).
        this._renderMatchArena(opts);

        // Cards (P1 may be human in solo)
        const p1Opts = opts.p1?.isHuman
            ? { player: 1, isHuman: true, handle: opts.p1.handle }
            : { player: 1, model: opts.p1?.model, clip: 'intro', clipLoop: false };
        const p2Opts = { player: 2, model: opts.p2?.model, clip: 'intro', clipLoop: false };
        await Promise.all([
            this._renderPlayerCard('match-intro-p1-card', p1Opts),
            this._renderPlayerCard('match-intro-p2-card', p2Opts),
        ]);

        // Slam-in entrance + sound (reflow re-triggers the animation each time)
        screen.classList.remove('pm-enter');
        void screen.offsetWidth;
        screen.classList.add('pm-enter');
        this._playSound?.(opts.sound || 'vs');

        // Win odds from current ELO
        const p1Lookup = opts.p1?.isHuman ? opts.p1.handle : opts.p1?.model;
        const [r1, r2] = await Promise.all([
            p1Lookup ? this._fetchRanking(p1Lookup) : null,
            opts.p2?.model ? this._fetchRanking(opts.p2.model) : null,
        ]);
        renderOddsInto(
            document.getElementById('match-intro-odds-p1'),
            document.getElementById('match-intro-odds-p2'),
            r1, r2,
        );

        const minMs = opts.minMs ?? 2200;
        const warmPromise = opts.warmPromise || null;
        return new Promise(resolve => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                overlay.removeEventListener('click', onClick);
                screen.classList.remove('t-warming');
                if (noteEl) noteEl.textContent = baseNote;
                screen.classList.add('t-hidden');
                overlay.classList.add('t-hidden');
                resolve();
            };
            const onClick = () => { if (opts.skippable) finish(); };
            overlay.addEventListener('click', onClick);

            (async () => {
                await this._sleep(minMs);           // min on-screen time for the drama
                if (done) return;
                if (warmPromise) {
                    // Still loading? Reveal the warming shimmer and hold until resident.
                    screen.classList.add('t-warming');
                    if (noteEl) noteEl.textContent = `Warming up ${opts.warmLabel || 'models'}…`;
                    try { await warmPromise; } catch (_) { /* best-effort */ }
                    screen.classList.remove('t-warming');
                    if (noteEl) noteEl.textContent = baseNote;
                }
                finish();
            })();
        });
    }

    // ── Launcher overlay (first load) ────────────────────────

    _initLauncher() {
        for (const card of document.querySelectorAll('.launcher-mode-card')) {
            card.addEventListener('click', () => {
                const mode = card.dataset.launcherMode;
                // All modes — including tournament — route through the setup card
                // so the world settings (map size / hex zoom / rounds) are configurable
                // before launch. Tournament's Start button wires to _startTournament().
                this._showLauncherSetup(mode);
            });
        }

        const backBtn = document.getElementById('btn-launcher-setup-back');
        if (backBtn) {
            backBtn.addEventListener('click', () => this._openLauncherWelcome());
        }

        document.getElementById('btn-launcher-howto')?.addEventListener('click', () => openCodex());
        document.getElementById('btn-launcher-demo')?.addEventListener('click', () => this._startDemo());
        document.getElementById('btn-launcher-rankings')?.addEventListener('click', () => this._showRankingsScene());
        document.getElementById('btn-launcher-labs')?.addEventListener('click', () => this._openLabsChooser());
    }

    // ── Labs chooser ─────────────────────────────────────────
    // Front door for the standalone labs (AI Vision Lab, Icon/Avatar labs,
    // Analytics). Each card opens its lab in a near-fullscreen iframe modal
    // (_openLabFrame) so a game in progress is never navigated away — closing
    // the lab returns straight to the live board. Wired once on first open.
    _openLabsChooser() {
        const overlay = document.getElementById('labs-overlay');
        if (!overlay) return;
        if (!overlay._wired) {
            overlay._wired = true;
            for (const c of overlay.querySelectorAll('[data-labs-close]')) {
                c.addEventListener('click', () => overlay.classList.add('labs-hidden'));
            }
            for (const card of overlay.querySelectorAll('.labs-card')) {
                card.addEventListener('click', (e) => {
                    e.preventDefault();
                    overlay.classList.add('labs-hidden');
                    this._openLabFrame(card.dataset.labSrc, card.dataset.labTitle);
                });
            }
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') overlay.classList.add('labs-hidden');
            });
        }
        overlay.classList.remove('labs-hidden');
    }

    // ── Lab frame modal ──────────────────────────────────────
    // Hosts a lab page in a near-fullscreen iframe layered over the game. The
    // game page itself never navigates, so all match state survives; closing
    // unloads the iframe so the lab's timers/audio/network stop.
    _openLabFrame(src, title) {
        if (!src) return;
        const modal = document.getElementById('lab-frame-modal');
        const frame = document.getElementById('lfm-frame');
        if (!modal || !frame) return;
        if (!modal._wired) {
            modal._wired = true;
            document.getElementById('lfm-close')?.addEventListener('click', () => this._closeLabFrame());
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && !modal.classList.contains('lfm-hidden')) this._closeLabFrame();
            });
        }
        const titleEl = document.getElementById('lfm-title');
        const openTab = document.getElementById('lfm-open-tab');
        if (titleEl) titleEl.textContent = title || 'Lab';
        if (openTab) openTab.href = src;
        frame.src = src;
        modal.classList.remove('lfm-hidden');
    }

    _closeLabFrame() {
        const modal = document.getElementById('lab-frame-modal');
        const frame = document.getElementById('lfm-frame');
        if (!modal) return;
        modal.classList.add('lfm-hidden');
        if (frame) frame.src = 'about:blank';   // unload the lab; stop its timers/audio
    }

    // ── Full-screen "Hall of Champions" leaderboard scene ────
    // The primary rankings view, reachable from the launcher welcome and the
    // in-game gear menu. Mirrors _showLauncherSetup's hide-all-then-reveal
    // plumbing; the scene module owns its own content + lens UI. Back defaults to
    // the welcome screen (launcher entry); callers in a live match pass an onBack
    // that drops the overlay back to the board instead.
    _showRankingsScene(opts = {}) {
        const overlay = document.getElementById('tournament-overlay');
        const scene = document.getElementById('launcher-rankings');
        if (!overlay || !scene) return;
        overlay.querySelectorAll('.t-screen').forEach(s => s.classList.add('t-hidden'));
        scene.classList.remove('t-hidden');
        overlay.classList.remove('t-hidden');
        openLeaderboard(scene, {
            humanHandle: this._humanHandle,
            onBack: opts.onBack || (() => this._openLauncherWelcome()),
        });
    }

    // ── Guided demo: a short narrated Watch match ────────────
    // One click from the launcher. Runs a real (small, 3-round) AI-vs-AI match
    // and overlays a plain-language narration at each phase beat so a newcomer
    // can see how placement → simulation → recap → scoring fit together. Needs
    // Ollama like any Watch match; if it's down, we explain rather than hang.
    async _startDemo() {
        if (!this._installedModels || this._installedModels.length === 0) {
            try { this._installedModels = await listOllamaModels(); }
            catch (_) { this._installedModels = []; }
        }
        if (!this._installedModels || this._installedModels.length === 0) {
            this._showDemoNeedsOllama();
            return;
        }

        const p1 = this._installedModels[0].name;
        const p2 = this._pickDifferentModel(p1) || p1;

        this._demoMode = true;
        this._matchMode = 'watch';
        this._startMatch({
            mode: 'watch',
            p1Model: p1,
            p2Model: p2,
            world: { mapSize: 'small', hexZoom: CONFIG.HEX_ZOOM.default, rounds: 3 },
        });
    }

    _showDemoNeedsOllama() {
        let el = document.getElementById('demo-needs-ollama');
        if (!el) {
            el = document.createElement('div');
            el.id = 'demo-needs-ollama';
            el.className = 'cdx-overlay';
            el.innerHTML = `
                <div class="cdx-modal" style="max-width:420px;">
                    <div class="cdx-header">
                        <div class="cdx-title">DEMO NEEDS OLLAMA</div>
                        <div class="cdx-subtitle">The guided demo runs a live AI-vs-AI match, so it needs a local model server.</div>
                        <button class="cdx-close" aria-label="Close">✕</button>
                    </div>
                    <div class="cdx-body" style="gap:10px;">
                        <p style="font-size:13px;line-height:1.55;color:rgba(255,255,255,0.75);margin:0;">
                            Start <b>Ollama</b> (<code>ollama serve</code>) with a model pulled, then try again.
                            Meanwhile, <b>How to Play</b> covers the rules with no server required.
                        </p>
                    </div>
                </div>`;
            document.body.appendChild(el);
            el.addEventListener('click', (e) => {
                if (e.target === el || e.target.classList.contains('cdx-close')) el.classList.add('cdx-hidden');
            });
        }
        el.classList.remove('cdx-hidden');
    }

    _ensureDemoNarrator() {
        let el = document.getElementById('demo-narrator');
        if (!el) {
            el = document.createElement('div');
            el.id = 'demo-narrator';
            el.className = 'demo-narrator dn-hidden';
            el.innerHTML = `
                <span class="dn-tag">DEMO</span>
                <span class="dn-text" id="dn-text"></span>
                <button class="dn-skip" id="dn-skip">Skip</button>`;
            document.body.appendChild(el);
            el.querySelector('#dn-skip').addEventListener('click', () => this._endDemo());
        }
        return el;
    }

    _demoNarrate(text) {
        const el = this._ensureDemoNarrator();
        const t = el.querySelector('#dn-text');
        if (t) t.textContent = text;
        el.classList.remove('dn-hidden');
        // Re-trigger the entrance flash on each new line.
        el.classList.remove('dn-flash');
        void el.offsetWidth;
        el.classList.add('dn-flash');
    }

    _endDemo() {
        this._demoMode = false;
        document.getElementById('demo-narrator')?.classList.add('dn-hidden');
    }

    // Map the current phase + round to one plain-language line. Non-blocking —
    // the match paces itself (AI thinking + the 20-step sim), the banner just
    // narrates over it.
    _demoBeat(phase) {
        const r = this.turns.round;
        if (phase === PHASE.PLAYER_1_TURN) {
            this._demoNarrate(r <= 1
                ? 'Two AIs seed life on a shared map. Each spends Action Points placing species.'
                : `Round ${r}: each side reinforces its ecosystem.`);
        } else if (phase === PHASE.PLAYER_2_TURN) {
            if (r <= 1) this._demoNarrate('Plants are the foundation — they feed herbivores, which feed predators.');
        } else if (phase === PHASE.SIMULATING) {
            this._demoNarrate('Now the ecosystem runs for 20 steps: plants spread, herbivores graze, predators hunt.');
        } else if (phase === PHASE.ROUND_END) {
            this._demoNarrate('The recap below shows what happened this round — and who leads, and why.');
        } else if (phase === PHASE.GAME_OVER) {
            // The game-over scene takes over the screen; bow out gracefully.
            this._endDemo();
        }
    }

    _openLauncherWelcome() {
        const overlay = document.getElementById('tournament-overlay');
        const screen = document.getElementById('launcher-welcome');
        if (!overlay || !screen) return;
        this._setConsoleVisible(false);   // console belongs to an active match
        this._setMatchCardsActive(false); // ...and so do the player cards
        overlay.querySelectorAll('.t-screen').forEach(s => s.classList.add('t-hidden'));
        screen.classList.remove('t-hidden');
        overlay.classList.remove('t-hidden');
    }

    _closeLauncherWelcome() {
        const overlay = document.getElementById('tournament-overlay');
        if (!overlay) return;
        overlay.querySelectorAll('.t-screen').forEach(s => s.classList.add('t-hidden'));
        overlay.classList.add('t-hidden');
    }

    _showLauncherSetup(mode) {
        const overlay = document.getElementById('tournament-overlay');
        const setup = document.getElementById('launcher-setup');
        if (!overlay || !setup) return;
        overlay.querySelectorAll('.t-screen').forEach(s => s.classList.add('t-hidden'));
        setup.classList.remove('t-hidden');
        overlay.classList.remove('t-hidden');
        this._setMatchMode(mode);

        const title = document.getElementById('launcher-setup-title');
        const sub = document.getElementById('launcher-setup-subtitle');
        if (mode === 'tournament') {
            if (title) title.textContent = 'CONFIGURE TOURNAMENT';
            if (sub) sub.textContent = 'Set the board — it applies to every match';
        } else if (mode === 'watch') {
            if (title) title.textContent = 'CONFIGURE WATCH';
            if (sub) sub.textContent = 'Pick two AI models';
        } else {
            if (title) title.textContent = 'CONFIGURE MATCH';
            if (sub) sub.textContent = 'Choose your opponent';
        }
    }

    // ── Model Configuration Panel ───────────────────────────

    _initModelConfig() {
        // Manage Models is opened via the gear menu now; the panel lives in a
        // body-level modal. Wire the close button + backdrop click.
        const closeBtn = document.getElementById('btn-mcp-close');
        if (closeBtn) closeBtn.addEventListener('click', () => this._closeModelConfigModal());

        const backdrop = document.querySelector('#model-config-modal .mcm-backdrop');
        if (backdrop) backdrop.addEventListener('click', () => this._closeModelConfigModal());

        // Warm the retired set so eligibility + pickers honor the bench from the
        // first match setup, before the manager is ever opened.
        fetchRoster().then(set => { this._retired = set; }).catch(() => {});

        // Wire the "pull arbitrary model" add bar.
        const addBtn = document.getElementById('mcp-add-btn');
        const addInput = document.getElementById('mcp-add-input');
        if (addBtn && addInput) {
            const submit = () => {
                const name = addInput.value.trim();
                if (name) this._pullModel(name, addBtn);
            };
            addBtn.addEventListener('click', submit);
            addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        }
    }

    async _refreshModelConfig() {
        const activeDiv = document.getElementById('mcp-active');
        const retiredDiv = document.getElementById('mcp-retired');
        const recommendedDiv = document.getElementById('mcp-recommended');
        const statusDiv = document.getElementById('mcp-status');
        if (!activeDiv || !recommendedDiv) return;

        statusDiv.textContent = 'Checking models…';
        this._installedModels = await listOllamaModels();
        this._retired = await fetchRoster();
        await this._loadModelMeta();   // ranking + record + form for the cards
        const installedBaseNames = new Set(this._installedModels.map(m => m.name.split(':')[0]));

        // Active roster = everything currently installed (retiring deletes the
        // weights, so a retired model normally isn't installed anymore — but if
        // one lingers in both lists, the roster bench wins).
        const active = this._installedModels.filter(m => !this._retired.has(m.name));
        const eloOf = (name) => this._modelMeta?.get(name)?.elo ?? -1;
        active.sort((a, b) => eloOf(b.name) - eloOf(a.name) || a.name.localeCompare(b.name));

        // Retired bench is a graveyard: weights are gone, so these cards are
        // built straight from the roster names (Ollama no longer lists them).
        // Their ELO/record still lives in the DB → still rendered.
        const retired = [...this._retired]
            .sort((a, b) => eloOf(b) - eloOf(a) || a.localeCompare(b))
            .map(name => ({ name }));

        // Active roster
        activeDiv.innerHTML = '';
        if (active.length === 0) {
            activeDiv.innerHTML = '<div class="mcp-empty">No active models — install one below or reactivate a retired model.</div>';
        } else {
            for (const m of active) activeDiv.appendChild(this._modelCard(m, false));
        }

        // Retired bench — section hides itself when empty
        const retiredSection = document.getElementById('mcp-retired-section');
        if (retiredSection) retiredSection.style.display = retired.length ? '' : 'none';
        retiredDiv.innerHTML = '';
        for (const m of retired) retiredDiv.appendChild(this._modelCard(m, true));

        // Recommended (not yet installed)
        recommendedDiv.innerHTML = '';
        for (const rec of RECOMMENDED_MODELS) {
            if (installedBaseNames.has(rec.name.split(':')[0])) continue;
            recommendedDiv.appendChild(this._recommendedCard(rec));
        }
        const recSection = document.getElementById('mcp-recommended-section');
        if (recSection) recSection.style.display = recommendedDiv.children.length ? '' : 'none';

        const countEl = document.getElementById('mcp-count');
        if (countEl) countEl.textContent = `${active.length} active · ${retired.length} retired`;

        statusDiv.textContent = '';
    }

    // A rich roster card: avatar art, identity-hue accent, ELO/rank/record/form,
    // and the per-section action (Retire frees weights + benches / Reactivate
    // re-downloads). Retired cards are built from a bare { name } since their
    // weights — and thus the Ollama tag entry — are gone.
    _modelCard(m, isRetired) {
        const id = resolveModel(m.name);
        const meta = this._modelMeta?.get(m.name) || null;
        const size = this._modelSizeLabel(m.size);
        const cloud = isCloudModel(m.name);

        const card = document.createElement('div');
        card.className = 'mcp-card' + (isRetired ? ' retired' : '');
        card.style.setProperty('--mcp-hue', id.hue);

        let statsHtml;
        if (meta && meta.elo != null) {
            const wr = meta.winrate != null ? ` · ${meta.winrate}%` : '';
            const form = (meta.form || []).map(r => `<span class="mcp-f mcp-f-${r}">${r}</span>`).join('');
            statsHtml = `
                <div class="mcp-card-elo">ELO ${meta.elo}<span class="mcp-card-rank">#${meta.rank}</span></div>
                <div class="mcp-card-rec">${meta.wins}W-${meta.losses}L${wr}</div>
                <div class="mcp-card-form">${form}</div>`;
        } else {
            statsHtml = `<div class="mcp-card-unproven">⚡ Unproven — no ranked matches yet</div>`;
        }

        card.innerHTML = `
            <div class="mcp-card-head">
                <div class="mcp-card-ava-slot"></div>
                <div class="mcp-card-id">
                    <div class="mcp-card-name" title="${m.name}">${id.displayName}</div>
                    <div class="mcp-card-sub">${id.vendor} · ${paramLabel(m.name)}${cloud ? ' ☁' : ''}${size ? ' · ' + size : ''}${isRetired ? ' · weights freed' : ''}</div>
                </div>
                ${isRetired ? '<div class="mcp-card-badge">retired</div>' : ''}
            </div>
            <div class="mcp-card-stats">${statsHtml}</div>
            <div class="mcp-card-actions"></div>`;

        // Avatar art (baked still → procedural hue fallback), same pipeline as the
        // board/player cards. Seed the slot with initials so it never paints blank.
        const ava = document.createElement('div');
        ava.className = 'mcp-card-ava';
        ava.textContent = id.initials;
        card.querySelector('.mcp-card-ava-slot').appendChild(ava);
        applyAvatar(ava, m.name, { style: 'cyber-organic', cover: true }).catch(() => {});

        const actions = card.querySelector('.mcp-card-actions');
        const benchBtn = document.createElement('button');
        if (isRetired) {
            benchBtn.className = 'mcp-act mcp-act-reactivate';
            benchBtn.textContent = 'Reactivate';
            benchBtn.title = 'Re-download the weights and return this model to active competition';
            benchBtn.addEventListener('click', () => this._reactivateModel(m.name, benchBtn));
        } else {
            benchBtn.className = 'mcp-act mcp-act-retire';
            benchBtn.textContent = 'Retire';
            benchBtn.title = 'Free the weights from disk and bench from competition — ELO history is kept';
            benchBtn.addEventListener('click', () => this._retireModel(m.name, benchBtn));
        }
        actions.appendChild(benchBtn);

        return card;
    }

    // A compact "add this" card for a recommended model that isn't installed yet.
    _recommendedCard(rec) {
        const id = resolveModel(rec.name);
        const card = document.createElement('div');
        card.className = 'mcp-card mcp-card-add';
        card.style.setProperty('--mcp-hue', id.hue);
        card.innerHTML = `
            <div class="mcp-card-head">
                <div class="mcp-card-id">
                    <div class="mcp-card-name">${rec.name}</div>
                    <div class="mcp-card-sub" title="${rec.desc}">${rec.desc}</div>
                </div>
            </div>
            <div class="mcp-card-stats"><div class="mcp-card-recsize">${rec.size}</div></div>
            <div class="mcp-card-actions"></div>`;
        const btn = document.createElement('button');
        btn.className = 'mcp-act mcp-act-install';
        btn.textContent = 'Install';
        btn.addEventListener('click', () => this._pullModel(rec.name, btn));
        card.querySelector('.mcp-card-actions').appendChild(btn);
        return card;
    }

    // Retire a model. Destructive: frees the weights from disk (Ollama delete)
    // AND benches it everywhere — but the ELO/record stays in the DB and the
    // model lands in the Retired graveyard so its history survives. Two-click
    // confirm on the button itself (no browser dialog, harness rule).
    async _retireModel(name, btn) {
        const statusDiv = document.getElementById('mcp-status');
        if (!btn.classList.contains('confirming')) {
            btn.classList.add('confirming');
            btn.textContent = 'Retire? Frees weights';
            clearTimeout(btn._confirmTimer);
            btn._confirmTimer = setTimeout(() => {
                btn.classList.remove('confirming');
                btn.textContent = 'Retire';
            }, 4000);
            return;
        }
        clearTimeout(btn._confirmTimer);
        btn.disabled = true;
        btn.classList.remove('confirming');
        btn.textContent = 'Retiring…';
        if (statusDiv) statusDiv.textContent = `Retiring ${name} — freeing weights…`;

        // Delete weights first; only bench once the disk is actually freed, so a
        // failed delete never leaves a "retired" model that's still installed.
        const del = await deleteModel(name);
        if (!del.success) {
            btn.disabled = false;
            btn.textContent = 'Retire';
            if (statusDiv) statusDiv.textContent = `Failed to free weights: ${del.error}`;
            return;
        }
        this._installedModels = this._installedModels.filter(m => m.name !== name);
        const r = await setModelRetired(name, true);
        this._retired = r.success ? new Set(r.retired) : (this._retired.add(name), this._retired);
        await this._populateModelPickers();
        await this._refreshModelConfig();
        if (statusDiv) statusDiv.textContent = `${name} retired — weights freed, ELO history kept.`;
    }

    // Reactivate a retired model: re-download the weights (the graveyard only
    // kept the record, not the bits), then un-bench. Progress shows on the
    // button; for a big model this is a full re-pull.
    async _reactivateModel(name, btn) {
        const statusDiv = document.getElementById('mcp-status');
        btn.disabled = true;
        btn.textContent = 'Fetching…';
        if (statusDiv) statusDiv.textContent = `Reactivating ${name} — re-downloading weights…`;

        const result = await pullModel(name, (status, completed, total) => {
            if (status === 'downloading' && total) {
                const pct = Math.round((completed / total) * 100);
                btn.textContent = `${pct}%`;
                if (statusDiv) statusDiv.textContent = `Re-downloading ${name}: ${pct}%`;
            } else if (statusDiv) {
                statusDiv.textContent = `${name}: ${status}`;
            }
        });

        if (!result.success) {
            btn.disabled = false;
            btn.textContent = 'Reactivate';
            if (statusDiv) statusDiv.textContent = `Reactivate failed: ${result.error} — still retired.`;
            return;
        }
        const r = await setModelRetired(name, false);
        this._retired = r.success ? new Set(r.retired) : (this._retired.delete(name), this._retired);
        await this._populateModelPickers();
        await this._refreshModelConfig();
        if (statusDiv) statusDiv.textContent = `${name} reactivated — back in competition.`;
    }

    // Pull a model by name — from the add bar or a recommended card. DOM-agnostic:
    // progress shows on the triggering button (if any) and the status line.
    async _pullModel(modelName, btn) {
        const statusDiv = document.getElementById('mcp-status');
        const origLabel = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Pulling…'; }

        const result = await pullModel(modelName, (status, completed, total) => {
            if (status === 'downloading' && total) {
                const pct = Math.round((completed / total) * 100);
                if (btn) btn.textContent = `${pct}%`;
                if (statusDiv) statusDiv.textContent = `Downloading ${modelName}: ${pct}%`;
            } else if (statusDiv) {
                statusDiv.textContent = `${modelName}: ${status}`;
            }
        });

        if (result.success) {
            if (statusDiv) statusDiv.textContent = `${modelName} installed!`;
            const input = document.getElementById('mcp-add-input');
            if (input) input.value = '';
            // Refresh pickers + the card grid (the triggering button is replaced here).
            await this._populateModelPickers();
            await this._refreshModelConfig();
        } else {
            if (statusDiv) statusDiv.textContent = `Failed: ${result.error}`;
            if (btn) { btn.disabled = false; btn.textContent = origLabel || 'Install'; }
        }
    }

    // ── Tournament support ────────────────────────────────────

    // Construct a fresh grid + renderer + simulation for the given dimensions.
    // The single board-construction path, shared by _startMatch (always rebuilds)
    // and resetForMatch (rebuilds only when the tournament's world spec differs).
    _buildBoardCore(dims) {
        this.grid = new HexGrid(dims.cols, dims.rows, dims.hexSize);
        this.renderer = new Renderer(this.canvas, this.grid);
        this.simulation = new Simulation(this.grid);
    }

    // Clear per-match tracking state — AI slots, result hooks, score history.
    // Shared by _startMatch and resetForMatch so a fresh match always starts clean.
    _resetMatchState() {
        this.aiPlayers = {};
        this._matchResolve = null;
        this._matchupOdds = null;
        this._scoreHistory = [];
        this.simulating = false;
        // Fresh capture identity per match; disabled until an AI is assigned
        // (setAI re-enables). Human-vs-human matches never capture.
        this.matchUid = newMatchUid();
        setCaptureEnabled(false);
    }

    resetForMatch(rounds, world) {
        // Show both player cards + reserve their gutters before any grid rebuild
        // so the board fits between them (mirrors _startMatch).
        this._setMatchCardsActive(true);
        // Rebuild the grid if a world spec is given (tournament map size / hex
        // zoom can differ); otherwise just clear the existing grid in place.
        if (world) {
            this._buildBoardCore(this._resolveWorld(world));
        } else {
            this.grid.forEach(cell => { cell.organisms = []; });
        }

        // Fresh terrain
        this.seed = Math.floor(Math.random() * 100000);
        generateTerrain(this.grid, this.seed);

        // Reset turn state
        this.turns.round = 0;
        this.turns.phase = 'SETUP';
        this.turns.totalRounds = rounds || CONFIG.GAME.TOTAL_ROUNDS;
        this.matchContext = this._describeMatch('tournament', world?.mapStrategy);
        this.turns.players[1] = { ap: 0, actions: [] };
        this.turns.players[2] = { ap: 0, actions: [] };

        // Clear per-match tracking state (AI slots, result hooks, score history)
        this._resetMatchState();

        // Clear AI cards
        this._resetAICard(1);
        this._resetAICard(2);
        // Reset per-match milestones too — zeroes pending/bronze and clears both
        // medal trays. _startMatch (solo/watch) does this separately; the tournament
        // path goes through resetForMatch, so without this the stars carried across matches.
        this._resetMilestones();
        const log = document.getElementById('action-log');
        if (log) log.innerHTML = '';

        this.renderer.clearFog();
        this.renderer.clearHighlightRound();
        this.renderer.render();
        this._updateWorldInfo();
        this._setConsoleVisible(true);   // tournament matches need the console too
        this._updateCensus();
    }

    // Returns a Promise that resolves with finalScore() when the game ends
    runFullGame() {
        return new Promise(resolve => { this._matchResolve = resolve; });
    }

    // Largest power-of-two bracket the eligible pool can fill without heavy
    // duplication. Floored at 8 (a sparse install still pads up to 8, as before)
    // and capped at 32 — so picking "32" with only 12 models quietly runs a 16.
    _largestBracketFor(poolCount) {
        let best = 8;
        for (const s of [16, 32]) { if (poolCount >= s) best = s; }
        return best;
    }

    async _startTournament() {
        if (this.tournament?.running) return;
        // Rounds (and grid size / hex zoom) come from the World settings picker
        // shared across modes; mode is just a label for the bracket panel.
        const world = { ...this._worldSettings() };
        const mode = world.rounds <= CONFIG.GAME.LIGHTNING_ROUNDS ? 'lightning' : 'standard';

        const models = await listOllamaModels();
        this._installedModels = models;
        const eligible = this._eligibleModelNames(models);

        if (eligible.length < 2) {
            alert('Need at least 2 models for a tournament.');
            return;
        }

        // Build the rating-aware pool, then let the chosen format decide WHO gets
        // in (field strategy) and HOW they pair (seed strategy). Never-played
        // models fall back to the server's base rating with zero games so a fresh
        // install still fields a bracket (and is correctly excluded from a
        // Champions field until it has earned a record).
        const rankings = await fetchRankings().catch(() => null);
        const norm = (m) => m
            ? m.replace(/:.*$/, '').split('/').pop().replace(/-cloud$/, '').replace(/-latest$/, '')
            : '';
        const stats = {};
        if (rankings) {
            for (const [name, s] of Object.entries(rankings)) {
                stats[norm(name)] = { elo: s.elo, games: (s.wins ?? 0) + (s.losses ?? 0) };
            }
        }
        const BASE_ELO = 1000;   // mirrors server.py base rating
        const pool = eligible.map((name) => {
            const s = stats[norm(name)];
            return { name, elo: s?.elo ?? BASE_ELO, games: s?.games ?? 0 };
        });

        const formatKey = this._tournamentFormat || DEFAULT_FORMAT;
        const fmt = FORMATS[formatKey] || FORMATS[DEFAULT_FORMAT];
        // Home Turf (localOnly) scopes the pool to local models before the field
        // is built — cloud contenders sit this one out.
        const scopedPool = fmt.localOnly ? pool.filter(p => !isCloudModel(p.name)) : pool;
        if (scopedPool.length < 2) {
            alert('Need at least 2 local models for a Home Turf tournament.');
            return;
        }

        const size = Math.min(this._tournamentSize || 8, this._largestBracketFor(scopedPool.length));
        const field = buildField(scopedPool, size, formatKey);

        this.tournament.start(field, mode, world, fmt);
    }
}

window.addEventListener('DOMContentLoaded', async () => {
    // Load lab-authored creature renames before anything resolves a model, so the
    // HUD/leaderboard/win screens show the overridden identities.
    await loadIdentityOverrides();
    window.game = new Game();
});

