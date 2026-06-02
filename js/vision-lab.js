// AI Vision Lab — a sandbox for probing how well a model reads our map data.
//
// Composes the real game engine (HexGrid + Renderer + Simulation) WITHOUT a
// Game instance, so the board is genuine. You chat freeform with a local model;
// it answers in prose AND points back at the map (highlight groups / placements)
// the same way the gameplay AI interacts with the board. Two representations are
// switchable so you can compare what the model can do with raw coordinates vs.
// the game's mediated (region summary + lettered candidate) view.

import { CONFIG } from './config.js';
import { HexGrid } from './grid.js';
import { generateTerrain } from './terrain.js';
import { Renderer } from './renderer.js';
import { Simulation } from './simulation.js';
import { createOrganism } from './species.js';
import { AIPlayer, listOllamaModels, RECOMMENDED_MODELS } from './ai.js';
import { extractJSON } from './util.js';

// Lab-specific map presets — deliberately SMALL so a raw per-cell listing is
// tractable for a model and the whole board is comprehensible at a glance.
const LAB_MAPS = {
    tiny:   { cols: 12, rows: 9,  label: 'Tiny (12×9)' },
    small:  { cols: 16, rows: 12, label: 'Small (16×12)' },
    medium: { cols: 22, rows: 16, label: 'Medium (22×16)' },
};
const LAB_HEX = 24;

// Highlight palette — color name → [fill, solid] rgba. Models reference colors
// by name; we resolve to a translucent fill (on the board) + a solid swatch
// (in the legend). Unknown names fall back to white.
const HL_COLORS = {
    green:  ['rgba(70,220,130,0.38)',  'hsl(145,70%,55%)'],
    red:    ['rgba(240,90,90,0.38)',   'hsl(0,75%,60%)'],
    blue:   ['rgba(80,150,250,0.38)',  'hsl(215,80%,62%)'],
    cyan:   ['rgba(70,220,230,0.38)',  'hsl(185,75%,58%)'],
    yellow: ['rgba(245,220,80,0.40)',  'hsl(50,85%,58%)'],
    orange: ['rgba(245,150,60,0.40)',  'hsl(28,85%,58%)'],
    purple: ['rgba(190,120,245,0.38)', 'hsl(275,70%,65%)'],
    pink:   ['rgba(245,120,190,0.38)', 'hsl(325,75%,65%)'],
    white:  ['rgba(255,255,255,0.34)', 'hsl(0,0%,90%)'],
};
function hlColor(name) {
    return HL_COLORS[String(name || '').toLowerCase().trim()] || HL_COLORS.white;
}

const el = (id) => document.getElementById(id);

class VisionLab {
    constructor() {
        this.canvas = el('vl-canvas');
        this.mode = 'raw';            // 'raw' | 'game'
        this.owner = 1;               // brush owner (1 | 2)
        this.brush = null;            // selected species key, or null = inspect
        this.size = 'small';
        this.history = [];            // [{role, content}] dialogue (no maps — re-injected live)
        this.highlights = [];         // [{label, color, cells:[cell]}]
        this._candidates = [];        // last game-view candidate list (label → cell)
        this.busy = false;

        this._buildGrid();
        this._buildBrush();
        this._bind();
        this._loadModels();
        this.regenerate(this._randomSeed());
    }

    // ── World setup ────────────────────────────────────────────
    _buildGrid() {
        const m = LAB_MAPS[this.size];
        this.grid = new HexGrid(m.cols, m.rows, LAB_HEX);
        this.renderer = new Renderer(this.canvas, this.grid);
        this.simulation = new Simulation(this.grid);
    }

    _randomSeed() { return Math.floor(Math.random() * 100000); }

    regenerate(seed) {
        this.seed = seed;
        el('vl-seed').value = seed;
        // Fresh world — wipe organisms (old placements may now sit on water).
        this.grid.forEach(c => { c.organisms = []; });
        generateTerrain(this.grid, seed);
        this.clearHighlights();
        this.render();
        this._refreshCellInfo(null);
    }

    setSize(size) {
        if (!LAB_MAPS[size]) return;
        this.size = size;
        this._buildGrid();
        this.regenerate(this.seed ?? this._randomSeed());
    }

    clearOrganisms() {
        this.grid.forEach(c => { c.organisms = []; });
        this.render();
    }

    // ── Render loop (terrain + organisms, then our persistent overlay) ──
    render() {
        this.renderer.render();
        this._drawHighlights();
    }

    _drawHighlights() {
        for (const g of this.highlights) {
            const [fill] = hlColor(g.color);
            for (const cell of g.cells) {
                if (cell) this.renderer.highlightCell(cell, fill);
            }
        }
    }

    clearHighlights() {
        this.highlights = [];
        this._renderLegend();
        if (this.grid) this.render();
    }

    _renderLegend() {
        const box = el('vl-legend');
        if (!this.highlights.length) {
            box.innerHTML = '<span class="vl-legend-empty">No highlights yet — ask the model to mark the map.</span>';
            return;
        }
        box.innerHTML = '';
        for (const g of this.highlights) {
            const [, solid] = hlColor(g.color);
            const row = document.createElement('div');
            row.className = 'vl-legend-row';
            row.innerHTML = `<span class="vl-swatch" style="background:${solid}"></span>` +
                `<span class="vl-legend-label">${escapeHtml(g.label || g.color)}</span>` +
                `<span class="vl-legend-count">${g.cells.filter(Boolean).length} cells</span>`;
            box.appendChild(row);
        }
    }

    // ── Brush / placement UI ───────────────────────────────────
    _buildBrush() {
        const box = el('vl-brush');
        box.innerHTML = '';
        // Inspect (no species) — click to read a cell.
        box.appendChild(this._brushBtn(null, 'Inspect', 'inspect'));
        for (const [key, sp] of Object.entries(CONFIG.SPECIES)) {
            box.appendChild(this._brushBtn(key, `${sp.role}`, sp.type));
        }
        this._syncBrush();
    }

    _brushBtn(key, label, kind) {
        const b = document.createElement('button');
        b.className = `vl-brush-btn vl-kind-${kind}`;
        b.dataset.species = key ?? '';
        b.textContent = label;
        b.addEventListener('click', () => {
            this.brush = key;
            this._syncBrush();
        });
        return b;
    }

    _syncBrush() {
        for (const b of document.querySelectorAll('#vl-brush .vl-brush-btn')) {
            b.classList.toggle('on', (b.dataset.species || null) === this.brush || (!b.dataset.species && this.brush === null));
        }
    }

    _placeAt(cell) {
        if (!cell || cell.terrain === 'WATER') return false;
        const sp = CONFIG.SPECIES[this.brush];
        if (!sp) return false;
        // Plant cap (2 per cell) — a correctness invariant in every placement path.
        if (sp.type === 'plant') {
            const plants = cell.organisms.filter(o => CONFIG.SPECIES[o.species]?.type === 'plant').length;
            if (plants >= 2) return false;
        }
        cell.organisms.push(createOrganism(this.brush, this.owner, cell.col, cell.row));
        return true;
    }

    _cellFromEvent(e) {
        const rect = this.canvas.getBoundingClientRect();
        const sx = this.canvas.width / rect.width;
        const sy = this.canvas.height / rect.height;
        const x = (e.clientX - rect.left) * sx;
        const y = (e.clientY - rect.top) * sy;
        return this.renderer.getCellAtPixel(x, y);
    }

    _refreshCellInfo(cell) {
        const box = el('vl-cell-info');
        if (!cell) { box.textContent = 'Click a cell to inspect it.'; return; }
        const occ = cell.organisms.length
            ? cell.organisms.map(o => `P${o.player} ${CONFIG.SPECIES[o.species]?.role || o.species}`).join(', ')
            : 'empty';
        box.textContent = `(${cell.col},${cell.row}) · ${cell.terrain.toLowerCase()} · nutrients ${cell.nutrients.toFixed(2)} · ${occ}`;
    }

    // ── Simulation ─────────────────────────────────────────────
    async runSteps(n) {
        if (this.busy) return;
        this.busy = true;
        el('vl-run').disabled = true;
        for (let i = 0; i < n; i++) {
            this.simulation.step();
            this.render();
            await sleep(CONFIG.SIM.ANIMATION_STEP_MS);
        }
        el('vl-run').disabled = false;
        this.busy = false;
        this._refreshCellInfo(null);
    }

    // ── Map representations (the switchable core) ──────────────
    buildView() {
        return this.mode === 'game' ? this._buildGameView() : this._buildRawView();
    }

    // RAW: every land cell by (col,row) with terrain + nutrients + occupants.
    // The model must reason spatially and may point at ANY cell.
    _buildRawView() {
        const lines = [];
        lines.push(`Hex grid ${this.grid.cols} cols × ${this.grid.rows} rows (flat-top, even-q offset). Columns 0..${this.grid.cols - 1} left→right, rows 0..${this.grid.rows - 1} top→bottom.`);
        lines.push('Terrain: FERTILE (best soil) > GRASSLAND > ROCKY (poor); WATER is unplaceable. nutrients 0.00–1.00.');
        lines.push('Land cells (col,row terrain nutrients [occupants]):');
        let water = 0;
        this.grid.forEach(cell => {
            if (cell.terrain === 'WATER') { water++; return; }
            let s = `(${cell.col},${cell.row}) ${cell.terrain} ${cell.nutrients.toFixed(2)}`;
            if (cell.organisms.length) {
                s += ' [' + cell.organisms.map(o => `P${o.player}:${o.species}`).join(',') + ']';
            }
            lines.push('  ' + s);
        });
        lines.push(`(${water} water cells omitted.)`);
        return lines.join('\n');
    }

    // GAME: the EXACT representation real matches feed the model — a 9-region
    // terrain summary + per-player ecosystem census + pre-scored, lettered
    // candidate spots. Built via a real AIPlayer over a minimal game shim, so
    // it stays faithful. The model points by candidate LETTER (no coordinates),
    // just like in play.
    _buildGameView() {
        const shim = {
            grid: this.grid,
            turns: { round: 1, totalRounds: CONFIG.GAME.TOTAL_ROUNDS,
                     players: { 1: { ap: CONFIG.GAME.AP_PER_TURN }, 2: { ap: CONFIG.GAME.AP_PER_TURN } } },
        };
        const ai = new AIPlayer(shim, 1, { model: this.model });
        const candidates = ai._findCandidates();
        this._candidates = candidates;

        let moveText = '';
        for (const c of candidates) {
            moveText += `  ${c.label}) [${c.type}] ${c.description} (${c.ap})\n`;
        }
        if (!moveText) moveText = '  (no strong candidates)\n';

        return [
            'This is the mediated view the game itself shows the AI — a coarse 9-region terrain summary plus pre-scored CANDIDATE SPOTS labelled by letter. There are NO raw coordinates here; reference spots by their letter.',
            '',
            'MAP REGIONS:',
            ai._generateMapSummary().replace(/\n$/, ''),
            '',
            `PLAYER 1 ECOSYSTEM: ${ai._summarizePlayer(1)}`,
            `PLAYER 2 ECOSYSTEM: ${ai._summarizePlayer(2)}`,
            '',
            'CANDIDATE SPOTS:',
            moveText.replace(/\n$/, ''),
        ].join('\n');
    }

    _speciesGlossary() {
        return Object.values(CONFIG.SPECIES)
            .map(s => `- ${s.name} (${s.role}, ${s.type}): ${s.blurb}`)
            .join('\n');
    }

    _systemPrompt() {
        const pointing = this.mode === 'game'
            ? 'To highlight cells, reference CANDIDATE SPOT LETTERS via a "spots" array, e.g. "spots":["A","C"]. (No raw coordinates exist in this view.)'
            : 'To highlight cells, reference them by [col,row] via a "cells" array, e.g. "cells":[[3,4],[5,2]].';
        const placing = this.mode === 'game'
            ? 'To suggest a placement, use {"species":"GRASS","spot":"A"}.'
            : 'To suggest a placement, use {"species":"GRASS","col":3,"row":4}.';
        return `You are the analyst in Biome's AI Vision Lab. A human is probing how well you read a hex-grid ecosystem map. Answer their questions about the board, and when useful, MARK the map so they can see what you mean.

SPECIES:
${this._speciesGlossary()}

Placement basics: plants go on land (never WATER), max 2 plants per cell; FERTILE soil and high nutrients grow more biomass; herbivores eat plants, predators hunt herbivores.

Respond ONLY with valid JSON, no prose outside it:
{
  "reply": "<your conversational answer to the human>",
  "highlights": [ { "label": "<short caption>", "color": "<green|red|blue|cyan|yellow|orange|purple|pink|white>", ${this.mode === 'game' ? '"spots": ["A"]' : '"cells": [[col,row]]'} } ],
  "placements": [ ${this.mode === 'game' ? '{"species":"GRASS","spot":"A"}' : '{"species":"GRASS","col":0,"row":0}'} ]
}
${pointing}
${placing}
"highlights" and "placements" are optional — omit or use [] when a question is purely conversational. Use DISTINCT colors for distinct highlight groups. Keep "reply" focused and specific to THIS board.`;
    }

    // ── Chat ───────────────────────────────────────────────────
    async send() {
        if (this.busy) return;
        const input = el('vl-input');
        const question = input.value.trim();
        if (!question) return;
        if (!this.model) { this._appendMsg('system', 'No model selected — is Ollama running?'); return; }

        input.value = '';
        this._appendMsg('user', question);
        const thinking = this._appendMsg('assistant', '…', true);
        this.busy = true;
        el('vl-send').disabled = true;

        const system = this._systemPrompt();
        const map = this.buildView();   // also refreshes this._candidates in game mode
        const userContent = `CURRENT MAP (${this.mode} view):\n${map}\n\n---\nQUESTION: ${question}`;
        const messages = [
            { role: 'system', content: system },
            ...this.history.slice(-6),
            { role: 'user', content: userContent },
        ];

        el('vl-prompt').textContent = `=== SYSTEM ===\n${system}\n\n=== USER ===\n${userContent}`;

        let raw = '';
        try {
            const data = await this._callModel(messages);
            raw = data.message?.content?.trim() || data.message?.thinking?.trim() || '';
            el('vl-response').textContent = raw || '(empty response)';
            const parsed = extractJSON(raw);
            if (!parsed) throw new Error('No JSON in response');

            const reply = (parsed.reply || '').trim() || '(the model returned no reply text)';
            thinking.querySelector('.vl-msg-body').textContent = reply;
            thinking.classList.remove('vl-pending');

            this._applyHighlights(parsed.highlights);
            const placed = this._applyPlacements(parsed.placements);
            if (placed) this.render();

            this.history.push({ role: 'user', content: question });
            this.history.push({ role: 'assistant', content: reply });
        } catch (err) {
            el('vl-response').textContent = raw || String(err);
            thinking.querySelector('.vl-msg-body').textContent = `⚠ ${err.message || err}`;
            thinking.classList.remove('vl-pending');
            thinking.classList.add('vl-error');
        } finally {
            this.busy = false;
            el('vl-send').disabled = false;
        }
    }

    async _callModel(messages) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90_000);
        try {
            const resp = await fetch('/ollama/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    model: this.model,
                    messages,
                    format: 'json',
                    stream: false,
                    think: false,
                    keep_alive: '30m',
                    options: { temperature: 0.7, num_predict: 1200 },
                }),
            });
            if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
            return await resp.json();
        } finally {
            clearTimeout(timer);
        }
    }

    _resolveCell(ref) {
        // [col,row] pair (raw) or candidate letter (game).
        if (Array.isArray(ref) && ref.length >= 2) return this.grid.getCell(+ref[0], +ref[1]);
        if (ref && typeof ref === 'object' && 'col' in ref) return this.grid.getCell(+ref.col, +ref.row);
        const cand = this._candidates.find(c => c.label === String(ref).toUpperCase().trim());
        return cand ? cand.cell : null;
    }

    _applyHighlights(groups) {
        this.highlights = [];
        if (Array.isArray(groups)) {
            for (const g of groups) {
                const refs = g.cells || g.spots || g.refs || [];
                const cells = refs.map(r => this._resolveCell(r)).filter(Boolean);
                if (cells.length) this.highlights.push({ label: g.label, color: g.color, cells });
            }
        }
        this._renderLegend();
        this.render();
    }

    _applyPlacements(placements) {
        if (!el('vl-apply').checked || !Array.isArray(placements)) return false;
        let any = false;
        for (const p of placements) {
            const species = String(p.species || '').toUpperCase();
            const sp = CONFIG.SPECIES[species];
            if (!sp) continue;
            const cell = ('spot' in p) ? this._resolveCell(p.spot) : this.grid.getCell(+p.col, +p.row);
            if (!cell || cell.terrain === 'WATER') continue;
            if (sp.type === 'plant') {
                const plants = cell.organisms.filter(o => CONFIG.SPECIES[o.species]?.type === 'plant').length;
                if (plants >= 2) continue;
            }
            cell.organisms.push(createOrganism(species, this.owner, cell.col, cell.row));
            any = true;
        }
        return any;
    }

    _appendMsg(role, text, pending = false) {
        const wrap = document.createElement('div');
        wrap.className = `vl-msg vl-msg-${role}${pending ? ' vl-pending' : ''}`;
        wrap.innerHTML = `<span class="vl-msg-role">${role === 'user' ? 'You' : role === 'assistant' ? 'Model' : 'Lab'}</span><div class="vl-msg-body"></div>`;
        wrap.querySelector('.vl-msg-body').textContent = text;
        const chat = el('vl-chat');
        chat.appendChild(wrap);
        chat.scrollTop = chat.scrollHeight;
        return wrap;
    }

    // ── Models ─────────────────────────────────────────────────
    async _loadModels() {
        const sel = el('vl-model');
        let models = [];
        try { models = await listOllamaModels(); } catch {}
        if (!models.length) {
            models = RECOMMENDED_MODELS.map(m => ({ name: m.name }));
            this._appendMsg('system', 'Could not reach Ollama — showing recommended model names. Start `ollama serve` to chat.');
        }
        sel.innerHTML = '';
        for (const m of models) {
            const o = document.createElement('option');
            o.value = m.name; o.textContent = m.name;
            sel.appendChild(o);
        }
        const preferred = models.find(m => /qwen2\.5:14b/.test(m.name)) || models[0];
        this.model = preferred?.name || '';
        sel.value = this.model;
    }

    // ── Events ─────────────────────────────────────────────────
    _bind() {
        el('vl-regen').addEventListener('click', () => this.regenerate(this._randomSeed()));
        el('vl-seed').addEventListener('change', (e) => {
            const v = parseInt(e.target.value, 10);
            if (Number.isFinite(v)) this.regenerate(v);
        });
        el('vl-size').addEventListener('change', (e) => this.setSize(e.target.value));
        el('vl-model').addEventListener('change', (e) => { this.model = e.target.value; });

        for (const b of document.querySelectorAll('#vl-mode .vl-mode-btn')) {
            b.addEventListener('click', () => {
                this.mode = b.dataset.mode;
                for (const x of document.querySelectorAll('#vl-mode .vl-mode-btn')) x.classList.toggle('on', x === b);
            });
        }
        for (const b of document.querySelectorAll('#vl-owner .vl-owner-btn')) {
            b.addEventListener('click', () => {
                this.owner = +b.dataset.owner;
                for (const x of document.querySelectorAll('#vl-owner .vl-owner-btn')) x.classList.toggle('on', x === b);
            });
        }

        el('vl-clear-hl').addEventListener('click', () => this.clearHighlights());
        el('vl-clear-org').addEventListener('click', () => this.clearOrganisms());
        el('vl-run').addEventListener('click', () => this.runSteps(parseInt(el('vl-steps').value, 10) || 10));

        el('vl-send').addEventListener('click', () => this.send());
        el('vl-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
        });

        this.canvas.addEventListener('click', (e) => {
            const cell = this._cellFromEvent(e);
            if (!cell) return;
            if (this.brush === null) { this._refreshCellInfo(cell); return; }
            if (this._placeAt(cell)) this.render();
            this._refreshCellInfo(cell);
        });

        el('vl-inspect-toggle').addEventListener('click', () => {
            el('vl-inspector').classList.toggle('open');
        });

        window.addEventListener('resize', () => { this.renderer._fit(); this.render(); });
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

window.addEventListener('DOMContentLoaded', () => { window.visionLab = new VisionLab(); });
