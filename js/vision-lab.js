// AI Vision Lab — a machine-perception bench for Biome.
//
// Two things, side by side:
//   1. REVIEW how a model reads a given vision strategy — ask a freeform prompt
//      ("Read" mode) and see the answer it gives from each vision's representation.
//   2. BENCHMARK models against the visions — run a real game turn ("Play" mode)
//      and compare the moves each (vision × model) makes.
//
// The board on the left is the shared specimen — paint it, simulate it, then fan
// the same board out across selected visions × models into the results grid. The
// real game engine (HexGrid + Renderer + Simulation) and the real AIPlayer prompt
// pipeline are reused so everything stays faithful to actual play.

import { CONFIG } from './config.js';
import { HexGrid } from './grid.js';
import { generateTerrain } from './terrain.js';
import { Renderer } from './renderer.js';
import { Simulation } from './simulation.js';
import { createOrganism } from './species.js';
import { AIPlayer, listOllamaModels, RECOMMENDED_MODELS, prepareResidentSet } from './ai.js';
import { extractJSON } from './util.js';
import { MAP_STRATEGIES, listStrategies, bucketGeometry, parseBucketLabel, cellBucket } from './map-strategies.js';
import { applyAvatar } from './model-avatar.js';
import { resolveModel, paramLabel } from './model-identity.js';

// Lab-specific map presets — deliberately small so a raw per-cell listing stays
// tractable and the whole board is comprehensible at a glance.
const LAB_MAPS = {
    tiny:   { cols: 12, rows: 9,  label: 'Tiny (12×9)' },
    small:  { cols: 16, rows: 12, label: 'Small (16×12)' },
    medium: { cols: 22, rows: 16, label: 'Medium (22×16)' },
};
const LAB_HEX = 24;

// Per-vision chip presentation (glyph + one-line gist). Labels come from the
// shared registry (listStrategies) so they never drift.
const VISION_META = {
    mediated:    { glyph: '◍', desc: '9-region digest' },
    ascii:       { glyph: '▦', desc: 'glyph grid + letters' },
    'ascii-ext': { glyph: '⊞', desc: 'layered · bucket placement' },
    raw:         { glyph: '⊹', desc: 'every cell · exact coords' },
};

const el = (id) => document.getElementById(id);

class VisionLab {
    constructor() {
        this.canvas = el('vl-canvas');
        this.owner = 1;               // brush owner (1 | 2)
        this.brush = null;            // selected species key, or null = inspect
        this.size = 'small';
        this.busy = false;
        this.highlights = [];         // board marking projected from a result card

        // Bench selection state.
        this.selectedModels = new Set();
        this.selectedVisions = new Set(listStrategies().map(s => s.id));
        this.mode = 'read';           // 'read' | 'play'
        this.seat = 1;
        this._models = [];
        this._cardPlays = {};         // cardId → [{col,row,species}] for "apply to board"

        this._buildGrid();
        this._buildBrush();
        this._buildVisionChips();
        this._bind();
        this._loadModels();
        this.regenerate(this._randomSeed());
    }

    // ── World ──────────────────────────────────────────────────
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
        this.grid.forEach(c => { c.organisms = []; });
        generateTerrain(this.grid, seed);
        this._buildGameAI();
        this.clearHighlights();
        this.render();
        this._refreshCellInfo(null);
    }

    // Minimal-but-faithful game shim so a REAL AIPlayer can build prompts / run
    // turns over the lab board. Two AIPlayers (one per seat) carry their own
    // per-turn memory; a third throwaway is built per Play combo so each runs
    // clean against the same board.
    _buildGameAI() {
        const ap0 = CONFIG.GAME.AP_PER_TURN;
        const shim = {
            grid: this.grid,
            renderer: { render: () => this.render() },
            matchContext: { mapStrategy: 'mediated' },
            turns: {
                round: 1, totalRounds: CONFIG.GAME.TOTAL_ROUNDS, activePlayer: 1,
                players: { 1: { ap: ap0 }, 2: { ap: ap0 } },
                spendAP(n) { this.players[this.activePlayer].ap -= n; },
                recordAction() {},
            },
        };
        this.gpShim = shim;
        this.gpAI = { 1: new AIPlayer(shim, 1, {}), 2: new AIPlayer(shim, 2, {}) };
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

    // ── Render ─────────────────────────────────────────────────
    render() {
        this.renderer.render();
        this._drawHighlights();
    }

    _drawHighlights() {
        for (const cell of this.highlights) {
            if (cell) this.renderer.highlightCell(cell, 'rgba(70,220,230,0.40)');
        }
    }

    clearHighlights() { this.highlights = []; if (this.grid) this.render(); }

    // ── Brush / placement ──────────────────────────────────────
    _buildBrush() {
        const box = el('vl-brush');
        box.innerHTML = '';
        box.appendChild(this._brushBtn(null, 'Inspect', 'inspect'));
        for (const [key, sp] of Object.entries(CONFIG.SPECIES)) {
            box.appendChild(this._brushBtn(key, sp.role, sp.type));
        }
        this._syncBrush();
    }

    _brushBtn(key, label, kind) {
        const b = document.createElement('button');
        b.className = `vl-brush-btn vl-kind-${kind}`;
        b.dataset.species = key ?? '';
        b.textContent = label;
        b.addEventListener('click', () => { this.brush = key; this._syncBrush(); });
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
        if (sp.type === 'plant') {
            const plants = cell.organisms.filter(o => CONFIG.SPECIES[o.species]?.type === 'plant').length;
            if (plants >= 2) return false;
        }
        cell.organisms.push(createOrganism(this.brush, this.owner, cell.col, cell.row));
        return true;
    }

    _cellFromEvent(e) {
        const rect = this.canvas.getBoundingClientRect();
        const sx = this.canvas.width / rect.width, sy = this.canvas.height / rect.height;
        return this.renderer.getCellAtPixel((e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy);
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
        this.busy = true; el('vl-run').disabled = true;
        for (let i = 0; i < n; i++) { this.simulation.step(); this.render(); await sleep(CONFIG.SIM.ANIMATION_STEP_MS); }
        el('vl-run').disabled = false; this.busy = false;
        this._refreshCellInfo(null);
    }

    // ── Vision chips ───────────────────────────────────────────
    _buildVisionChips() {
        const box = el('vl-visions');
        box.innerHTML = '';
        for (const s of listStrategies()) {
            const meta = VISION_META[s.id] || { glyph: '◆', desc: '' };
            const chip = document.createElement('button');
            chip.className = 'vl-vision-chip' + (this.selectedVisions.has(s.id) ? ' on' : '');
            chip.dataset.vision = s.id;
            chip.innerHTML = `<div class="vl-vision-top"><span class="vl-vision-glyph">${meta.glyph}</span>`
                + `<span class="vl-vision-name">${escapeHtml(s.label.replace(/\s*\(.*\)$/, ''))}</span></div>`
                + `<span class="vl-vision-desc">${escapeHtml(meta.desc)}</span>`;
            chip.addEventListener('click', () => {
                if (this.selectedVisions.has(s.id)) this.selectedVisions.delete(s.id);
                else this.selectedVisions.add(s.id);
                chip.classList.toggle('on');
                this._updateMeta();
            });
            box.appendChild(chip);
        }
    }

    // ── Model avatar chips ─────────────────────────────────────
    _buildModelChips() {
        const box = el('vl-models');
        box.innerHTML = '';
        for (const m of this._models) {
            const id = resolveModel(m.name);
            const chip = document.createElement('button');
            chip.className = 'vl-model-chip' + (this.selectedModels.has(m.name) ? ' on' : '');
            chip.dataset.model = m.name;
            chip.style.setProperty('--bh', id.hue);
            const ava = document.createElement('div');
            ava.className = 'vl-ava';
            ava.textContent = id.initials;
            const meta = document.createElement('div');
            meta.className = 'vl-model-meta';
            meta.innerHTML = `<span class="vl-model-name">${escapeHtml(id.displayName)}</span>`
                + `<span class="vl-model-tier">${escapeHtml(paramLabel(m.name))} · ${escapeHtml(id.family.label)}</span>`;
            const check = document.createElement('span');
            check.className = 'vl-model-check'; check.textContent = '✓';
            chip.appendChild(ava); chip.appendChild(meta); chip.appendChild(check);
            chip.addEventListener('click', () => {
                if (this.selectedModels.has(m.name)) this.selectedModels.delete(m.name);
                else this.selectedModels.add(m.name);
                chip.classList.toggle('on');
                this._updateMeta();
            });
            box.appendChild(chip);
            applyAvatar(ava, m.name);   // paints baked portrait if available; else keeps initials + hue
        }
        this._updateMeta();
    }

    _updateMeta() {
        const nm = this.selectedModels.size, nv = this.selectedVisions.size;
        const meta = el('vl-console-meta');
        if (!nm || !nv) { meta.innerHTML = '— select at least one <b>model</b> and one <b>vision</b> —'; return; }
        meta.innerHTML = `<b>${nm * nv}</b> tile${nm * nv > 1 ? 's' : ''} · ${nm} model${nm > 1 ? 's' : ''} × ${nv} vision${nv > 1 ? 's' : ''}`;
    }

    // ── The run ────────────────────────────────────────────────
    async run() {
        if (this.busy) return;
        const models = [...this.selectedModels], visions = [...this.selectedVisions];
        const meta = el('vl-console-meta');
        if (!models.length || !visions.length) { meta.innerHTML = '— select at least one <b>model</b> and one <b>vision</b> —'; return; }
        const question = el('vl-prompt-input').value.trim();
        if (this.mode === 'read' && !question) {
            meta.textContent = 'type a prompt to run in Read mode';
            el('vl-prompt-input').focus();
            return;
        }
        const seat = this.seat;
        const round = Math.max(1, parseInt(el('vl-round').value, 10) || 1);
        const ap = Math.max(1, parseInt(el('vl-ap').value, 10) || CONFIG.GAME.AP_PER_TURN);
        const combos = [];
        for (const model of models) for (const vision of visions) combos.push({ model, vision });

        this.busy = true;
        const runBtn = el('vl-run-cmp');
        runBtn.disabled = true; runBtn.classList.add('is-busy');
        const prog = el('vl-progress'), progBar = prog.querySelector('i');
        prog.classList.add('on'); progBar.style.width = '0%';
        this._renderCards(combos);
        const snap = this.mode === 'play' ? this._snapshotBoard() : null;
        let done = 0;
        try {
            for (const combo of combos) {
                this._cardBegin(combo, 'warming model…');
                try { await prepareResidentSet([combo.model]); } catch { /* warm best-effort */ }
                this._cardStatus(combo, this.mode === 'read' ? 'reading the board…' : 'playing the turn…');
                const t0 = Date.now();
                let out;
                try {
                    out = this.mode === 'read'
                        ? await this._runRead(combo, question, seat, round)
                        : await this._runPlay(combo, seat, round, ap);
                    out.latency = Date.now() - t0;
                } catch (err) { out = { error: err.message || String(err), latency: Date.now() - t0 }; }
                this._fillCard(combo, out);
                if (snap) this._restoreBoard(snap);
                done++;
                progBar.style.width = `${Math.round(done / combos.length * 100)}%`;
                meta.innerHTML = `<b>${done}/${combos.length}</b> complete`;
            }
        } finally {
            this.busy = false;
            runBtn.disabled = false; runBtn.classList.remove('is-busy');
            setTimeout(() => prog.classList.remove('on'), 900);
            this.render();
        }
    }

    // Build a vision's map block over the current board for a seat/round.
    _buildVisionContext(vision, seat, round) {
        const ai = this.gpAI[seat];
        const tm = this.gpShim.turns;
        tm.round = round; tm.activePlayer = seat;
        this.gpShim.matchContext.mapStrategy = vision;
        const candidates = ai._findCandidates();
        const mapBlock = MAP_STRATEGIES[vision].buildMapBlock({
            grid: this.grid, candidates,
            regionSummary: ai._generateMapSummary().replace(/\n+$/, ''),
            fog: { viewer: seat, round },
        });
        return { mapBlock, candidates, ai };
    }

    // READ: ask the model a freeform question using ONLY what this vision shows.
    async _runRead(combo, question, seat, round) {
        const { mapBlock, candidates, ai } = this._buildVisionContext(combo.vision, seat, round);
        const enemy = seat === 1 ? 2 : 1;
        const system = `You are inspecting how an AI reads a Biome hex-grid ecosystem board through ONE "vision" representation. Below is EXACTLY what the model is given for this vision — nothing more. Answer the human's question using ONLY what this representation lets you see. Be concise and specific to THIS board. If (and only if) the representation gives you coordinates, bucket labels, or candidate letters you can point with, include a "cells" array referencing them. Respond ONLY with JSON: {"reply":"<your answer>","cells":["C2",[3,4]]}`;
        const user = `${mapBlock}\n\nYOUR ECOSYSTEM (P${seat}): ${ai._summarizePlayer(seat)}\nENEMY ECOSYSTEM (P${enemy}): ${ai._summarizePlayer(enemy)}\n\n---\nQUESTION: ${question}`;
        const data = await this._callModel(combo.model, [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ]);
        const rawTxt = data.message?.content?.trim() || data.message?.thinking?.trim() || '';
        const parsed = extractJSON(rawTxt) || {};
        const reply = String(parsed.reply || rawTxt || '(no reply)').trim();
        const cells = Array.isArray(parsed.cells)
            ? parsed.cells.map(r => this._resolveRefCell(r, candidates)).filter(Boolean) : [];
        return { mode: 'read', system, user, reply, cells, raw: rawTxt, chars: system.length + user.length };
    }

    // PLAY: run a real game turn through the vision and capture the moves.
    async _runPlay(combo, seat, round, ap) {
        const tm = this.gpShim.turns;
        this.gpShim.matchContext.mapStrategy = combo.vision;
        tm.round = round; tm.activePlayer = seat; tm.players[seat].ap = ap;
        const ai = new AIPlayer(this.gpShim, seat, { model: combo.model });
        const { system, user } = ai._buildPrompt(ai._findCandidates());
        const res = await ai.takeTurn();
        return { mode: 'play', system, user, res, raw: ai._lastRaw, chars: system.length + user.length };
    }

    async _callModel(model, messages) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90_000);
        const chars = messages.reduce((n, m) => n + (m.content?.length || 0), 0);
        const numCtx = Math.min(CONFIG.GAME.NUM_CTX_MAX, Math.max(2048, Math.ceil(chars / 3)));
        try {
            const resp = await fetch('/ollama/api/chat', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
                body: JSON.stringify({
                    model, messages, format: 'json', stream: false, think: false, keep_alive: '30m',
                    options: { temperature: 0.7, num_predict: 1200, num_ctx: numCtx },
                }),
            });
            if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);
            return await resp.json();
        } finally { clearTimeout(timer); }
    }

    // Resolve a model's cell reference — [col,row] / {col,row} / candidate letter
    // / bucket label ("C2") — to a real cell, or null.
    _resolveRefCell(ref, candidates = []) {
        if (Array.isArray(ref) && ref.length >= 2) return this.grid.getCell(+ref[0], +ref[1]);
        if (ref && typeof ref === 'object' && 'col' in ref) return this.grid.getCell(+ref.col, +ref.row);
        const s = String(ref).trim().toUpperCase();
        const cand = candidates.find(c => c.label === s);
        if (cand) return cand.cell;
        const geo = bucketGeometry(this.grid);
        const b = parseBucketLabel(s, geo);
        if (b) {
            let found = null;
            this.grid.forEach(c => {
                if (found || c.terrain === 'WATER') return;
                const cb = cellBucket(c, geo);
                if (cb.bx === b.bx && cb.by === b.by) found = c;
            });
            return found;
        }
        return null;
    }

    // ── Board snapshot / restore (Play isolation) ──────────────
    _snapshotBoard() {
        const cells = {};
        this.grid.forEach(c => { cells[`${c.col},${c.row}`] = c.organisms.map(o => ({ ...o })); });
        const tm = this.gpShim.turns;
        return { cells, ap: { 1: tm.players[1].ap, 2: tm.players[2].ap }, round: tm.round, active: tm.activePlayer };
    }

    _restoreBoard(snap) {
        this.grid.forEach(c => { c.organisms = (snap.cells[`${c.col},${c.row}`] || []).map(o => ({ ...o })); });
        const tm = this.gpShim.turns;
        tm.players[1].ap = snap.ap[1]; tm.players[2].ap = snap.ap[2];
        tm.round = snap.round; tm.activePlayer = snap.active;
    }

    // ── Result cards ───────────────────────────────────────────
    _cardId(combo) { return 'vlc-' + `${combo.vision}-${combo.model}`.replace(/[^a-z0-9]+/gi, '_'); }

    _renderCards(combos) {
        const box = el('vl-results');
        box.innerHTML = '';
        this._cardPlays = {};
        for (const combo of combos) {
            const id = resolveModel(combo.model);
            const card = document.createElement('div');
            card.className = 'vl-card is-queued';
            card.id = this._cardId(combo);
            card.style.setProperty('--bh', id.hue);
            card.innerHTML =
                `<div class="vl-card-head">`
                + `<div class="vl-card-ava" data-ava>${escapeHtml(id.initials)}</div>`
                + `<div class="vl-card-titles"><span class="vl-card-vision">${escapeHtml(this._visionLabel(combo.vision))}</span>`
                + `<span class="vl-card-model">${escapeHtml(id.displayName)}</span></div>`
                + `<span class="vl-card-badge ${this.mode}">${this.mode === 'read' ? 'READ' : 'PLAY'}</span></div>`
                + `<div class="vl-card-screen"><canvas class="vl-card-mini"></canvas><div class="vl-card-scanline"></div><div class="vl-card-beam"></div></div>`
                + `<div class="vl-card-body">${this._loaderHTML('queued', true)}</div>`;
            box.appendChild(card);
            applyAvatar(card.querySelector('[data-ava]'), combo.model);
            this._drawMini(card.querySelector('.vl-card-mini'), []);   // show the board immediately
        }
    }

    _visionLabel(id) {
        const s = listStrategies().find(x => x.id === id);
        return s ? s.label.replace(/\s*\(.*\)$/, '') : id;
    }

    // Loader markup: a queued card shows a waiting dot; an active card shows a
    // spinner (hued to the model) over a shimmering skeleton of the incoming reply.
    _loaderHTML(text, queued = false) {
        if (queued) return `<div class="vl-loader queued"><span class="vl-wait-dot"></span><span class="vl-card-status">${escapeHtml(text)}</span></div>`;
        return `<div class="vl-loader"><span class="vl-spinner"></span><span class="vl-card-status">${escapeHtml(text)}</span></div>`
            + `<div class="vl-skel"><span></span><span></span><span></span></div>`;
    }

    // Flip a card from queued → actively scanning (beam sweep + spinner skeleton).
    _cardBegin(combo, text) {
        const card = el(this._cardId(combo));
        if (!card) return;
        card.classList.remove('is-queued');
        card.classList.add('is-loading');
        card.querySelector('.vl-card-body').innerHTML = this._loaderHTML(text, false);
    }

    _cardStatus(combo, text) {
        const s = el(this._cardId(combo))?.querySelector('.vl-card-status');
        if (s) s.textContent = text;
    }

    _fillCard(combo, out) {
        const card = el(this._cardId(combo));
        if (!card) return;
        card.classList.remove('is-loading', 'is-queued');
        const body = card.querySelector('.vl-card-body');
        const mini = card.querySelector('.vl-card-mini');
        if (out.error) { body.innerHTML = `<div class="vl-card-err">⚠ ${escapeHtml(out.error)}</div>`; return; }

        const tok = Math.ceil(out.chars / 4);
        const metrics = `<div class="vl-card-metrics"><span class="m-tok">~${tok} tok</span>`
            + `<span>${out.latency} ms</span>${out.res?.degraded ? '<span class="m-deg">degraded</span>' : ''}</div>`;

        if (out.mode === 'read') {
            this._drawMini(mini, out.cells || []);
            body.innerHTML = metrics + `<div class="vl-card-reply">${escapeHtml(out.reply)}</div>`;
            this._setFoot(card, combo, out.cells && out.cells.length
                ? [{ label: '⊕ mark on board', fn: () => { this.highlights = out.cells; this.render(); } }] : []);
            return;
        }

        // Play mode.
        const res = out.res;
        const placed = res.actions.filter(a => a.ok);
        const failed = res.actions.filter(a => !a.ok);
        this._drawMini(mini, placed.map(a => a.cell).filter(Boolean));
        const parts = [metrics];
        if (res.reasoning) parts.push(`<div class="vl-card-reply">${escapeHtml(res.reasoning)}</div>`);
        if (res.banter) parts.push(`<div class="vl-card-banter">“${escapeHtml(res.banter)}”</div>`);
        parts.push(`<div class="vl-card-moves"><span class="mv-h">Placed ${placed.length}</span><br>`
            + (placed.length ? placed.map(a => `<span class="mv-ok">${escapeHtml(a.msg)}</span>`).join('<br>') : '<em>— none</em>')
            + (failed.length ? `<br><span class="mv-h">Rejected ${failed.length}</span><br>` + failed.map(a => `<span class="mv-bad">${escapeHtml(a.msg)}</span>`).join('<br>') : '')
            + `</div>`);
        body.innerHTML = parts.join('');

        // Stash the moves so "apply to board" can replay them onto the live board.
        this._cardPlays[this._cardId(combo)] = placed.map(a => ({ col: a.cell.col, row: a.cell.row, species: a.species }));
        this._setFoot(card, combo, placed.length
            ? [{ label: '↧ apply moves', fn: (btn) => { this._applyMoves(combo, this.seat); btn.disabled = true; btn.textContent = '✓ applied'; } }] : []);
    }

    _setFoot(card, combo, actions) {
        let foot = card.querySelector('.vl-card-foot');
        if (foot) foot.remove();
        if (!actions.length) return;
        foot = document.createElement('div');
        foot.className = 'vl-card-foot';
        for (const a of actions) {
            const btn = document.createElement('button');
            btn.className = 'vl-btn ghost';
            btn.textContent = a.label;
            btn.addEventListener('click', () => a.fn(btn));
            foot.appendChild(btn);
        }
        card.appendChild(foot);
    }

    // Replay a Play card's moves onto the live board (permanent — for emulation).
    _applyMoves(combo, seat) {
        const moves = this._cardPlays[this._cardId(combo)] || [];
        for (const mv of moves) {
            const cell = this.grid.getCell(mv.col, mv.row);
            if (!cell || cell.terrain === 'WATER') continue;
            const sp = CONFIG.SPECIES[mv.species];
            if (!sp) continue;
            if (sp.type === 'plant' && cell.organisms.filter(o => CONFIG.SPECIES[o.species]?.type === 'plant').length >= 2) continue;
            cell.organisms.push(createOrganism(mv.species, seat, cell.col, cell.row));
        }
        this.render();
    }

    // Faithful board thumbnail — a true-to-scale flat-top hex render of the
    // SAME grid the specimen shows (matching proportions exactly), with one
    // player-hued dot per occupied cell and a hex ring around `ringCells`.
    _drawMini(canvas, ringCells = []) {
        const g = this.grid;
        const size = g.getCanvasSize();
        // Render at a modest resolution that preserves the board's real aspect;
        // CSS scales it down crisply to the card width.
        const TARGET_W = 360;
        const k = TARGET_W / size.width;
        const W = Math.round(size.width * k), H = Math.round(size.height * k);
        if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
        // Reserve the screen box at the board's real aspect so the full map shows
        // (and never gets clipped by the card's flex column).
        const screen = canvas.parentElement;
        if (screen) screen.style.setProperty('--mini-ar', `${W} / ${H}`);
        const ctx = canvas.getContext('2d');
        const hs = g.hexSize * k, off = g.hexSize * k;
        ctx.clearRect(0, 0, W, H);

        const hexPath = (cx, cy, r = hs) => {
            ctx.beginPath();
            for (let i = 0; i < 6; i++) {
                const a = Math.PI / 180 * (60 * i);
                const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
                i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
            }
            ctx.closePath();
        };
        const center = (c) => { const p = g.hexToPixel(c.col, c.row); return { x: p.x * k + off, y: p.y * k + off }; };

        // terrain
        g.forEach(c => {
            const t = CONFIG.COLORS[c.terrain] || { h: 0, s: 0, l: 18 };
            const { x, y } = center(c);
            hexPath(x, y);
            ctx.fillStyle = `hsl(${t.h},${t.s}%,${t.l}%)`;
            ctx.fill();
        });

        // occupants — dot sized by trophic tier, player-hued
        const rank = { plant: 0, herbivore: 1, predator: 2 };
        const rFrac = { plant: 0.34, herbivore: 0.46, predator: 0.58 };
        g.forEach(c => {
            if (!c.organisms.length) return;
            let top = null, tr = -1;
            for (const o of c.organisms) { const r = rank[CONFIG.SPECIES[o.species]?.type] ?? 0; if (r > tr) { tr = r; top = o; } }
            const type = CONFIG.SPECIES[top.species]?.type || 'plant';
            const pc = top.player === 1 ? CONFIG.PLAYER_1.PRIMARY : CONFIG.PLAYER_2.PRIMARY;
            const { x, y } = center(c);
            ctx.beginPath();
            ctx.fillStyle = `hsl(${pc.h},${pc.s}%,${pc.l}%)`;
            ctx.arc(x, y, hs * (rFrac[type] || 0.34), 0, Math.PI * 2);
            ctx.fill();
        });

        // highlight rings (read-mode "cells", play-mode placements)
        const fresh = new Set(ringCells.map(c => `${c.col},${c.row}`));
        ctx.lineWidth = Math.max(1.25, hs * 0.12); ctx.strokeStyle = '#fff';
        g.forEach(c => {
            if (!fresh.has(`${c.col},${c.row}`)) return;
            const { x, y } = center(c);
            hexPath(x, y, hs * 0.92);
            ctx.stroke();
        });
    }

    // ── Models ─────────────────────────────────────────────────
    async _loadModels() {
        let models = [], live = false;
        try { models = await listOllamaModels(); live = models.length > 0; } catch {}
        if (!models.length) models = RECOMMENDED_MODELS.map(m => ({ name: m.name }));
        this._models = models;
        el('vl-conn').classList.toggle('on', live);
        el('vl-conn').classList.toggle('off', !live);
        el('vl-conn').title = live ? 'Ollama connected' : 'Ollama unreachable — showing recommended names';
        // Default-select a sensible first model.
        const preferred = models.find(m => /qwen2\.5:14b/.test(m.name)) || models[0];
        if (preferred) this.selectedModels.add(preferred.name);
        this._buildModelChips();
        el('vl-models-hint').textContent = live ? 'pick one or more to compare' : 'Ollama offline — start `ollama serve`';
    }

    // ── Events ─────────────────────────────────────────────────
    _bind() {
        el('vl-regen').addEventListener('click', () => this.regenerate(this._randomSeed()));
        el('vl-seed').addEventListener('change', (e) => { const v = parseInt(e.target.value, 10); if (Number.isFinite(v)) this.regenerate(v); });
        el('vl-size').addEventListener('change', (e) => this.setSize(e.target.value));
        el('vl-clear-org').addEventListener('click', () => this.clearOrganisms());
        el('vl-run').addEventListener('click', () => this.runSteps(parseInt(el('vl-steps').value, 10) || 10));

        for (const b of document.querySelectorAll('#vl-owner .vl-owner-btn')) {
            b.addEventListener('click', () => {
                this.owner = +b.dataset.owner;
                for (const x of document.querySelectorAll('#vl-owner .vl-owner-btn')) x.classList.toggle('on', x === b);
            });
        }

        this.canvas.addEventListener('click', (e) => {
            const cell = this._cellFromEvent(e);
            if (!cell) return;
            if (this.brush === null) { this._refreshCellInfo(cell); return; }
            if (this._placeAt(cell)) this.render();
            this._refreshCellInfo(cell);
        });

        for (const b of document.querySelectorAll('#vl-mode button')) {
            b.addEventListener('click', () => {
                this.mode = b.dataset.mode;
                for (const x of document.querySelectorAll('#vl-mode button')) x.classList.toggle('on', x === b);
                el('vl-prompt-input').placeholder = this.mode === 'read'
                    ? 'Ask the model to read this board — e.g. “where are the 3 best spots to plant, and why?”  (⌘/Ctrl+Enter to run)'
                    : 'Play mode runs a real game turn — your prompt is optional context.  (⌘/Ctrl+Enter to run)';
                el('vl-run-cmp').querySelector('.vl-run-label').textContent = this.mode === 'read' ? 'Read' : 'Play';
            });
        }
        for (const b of document.querySelectorAll('#vl-seat button')) {
            b.addEventListener('click', () => {
                this.seat = +b.dataset.seat;
                for (const x of document.querySelectorAll('#vl-seat button')) x.classList.toggle('on', x === b);
            });
        }

        el('vl-run-cmp').addEventListener('click', () => this.run());
        el('vl-prompt-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.run(); }
        });

        window.addEventListener('resize', () => { this.renderer._fit(); this.render(); });
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

window.addEventListener('DOMContentLoaded', () => { window.visionLab = new VisionLab(); });
