// Tournament mode — pits all available models against each other
// Structure: Quarter-Finals (4) → Semi-Finals (2) → Final (1) = 7 matches

import { postResult } from './rankings.js';
import { CONFIG } from './config.js';

export class TournamentManager {
    constructor(game) {
        this.game = game;
        this.bracket = null;
        this.running = false;
        this.tournamentId = crypto.randomUUID().slice(0, 8);
        this._statsOpen = false;
        this._setupStatsToggle();
    }

    _setupStatsToggle() {
        document.getElementById('btn-t-stats')?.addEventListener('click', () => this._toggleStats());
        document.getElementById('btn-t-stats-close')?.addEventListener('click', () => this._toggleStats(false));
    }

    async start(models, mode = 'standard') {
        if (this.running) return;
        this.running = true;
        this.mode = mode;
        this.totalRounds = mode === 'lightning'
            ? CONFIG.GAME.LIGHTNING_ROUNDS
            : CONFIG.GAME.TOTAL_ROUNDS;

        // Shuffle for random seeding
        const seeded = [...models].sort(() => Math.random() - 0.5);
        this.bracket = this._buildBracket(seeded);

        // Show stats toggle button
        document.getElementById('btn-t-stats')?.classList.remove('t-stats-hidden');
        this._renderStats();

        const modeLabel = mode === 'lightning' ? 'LIGHTNING' : 'STANDARD';
        this._renderBracket(`Tournament begins! [${modeLabel} — ${this.totalRounds} rounds]`);
        this._show('t-bracket');
        await this._sleep(4000);

        // Quarter-Finals
        for (const match of this.bracket.slice(0, 4)) {
            await this._runMatch(match);
        }

        // Semi-Finals
        this.bracket[4].p1 = this.bracket[0].winner;
        this.bracket[4].p2 = this.bracket[1].winner;
        await this._runMatch(this.bracket[4]);

        this.bracket[5].p1 = this.bracket[2].winner;
        this.bracket[5].p2 = this.bracket[3].winner;
        await this._runMatch(this.bracket[5]);

        // Final
        this.bracket[6].p1 = this.bracket[4].winner;
        this.bracket[6].p2 = this.bracket[5].winner;
        await this._runMatch(this.bracket[6]);

        this._showChampion(this.bracket[6].winner);
        this.running = false;
    }

    _buildBracket(models) {
        return [
            // Quarter-Finals
            { id: 0, label: 'QF — Match 1', p1: models[0], p2: models[1], winner: null, scores: null, scoreHistory: null },
            { id: 1, label: 'QF — Match 2', p1: models[2], p2: models[3], winner: null, scores: null, scoreHistory: null },
            { id: 2, label: 'QF — Match 3', p1: models[4], p2: models[5], winner: null, scores: null, scoreHistory: null },
            { id: 3, label: 'QF — Match 4', p1: models[6], p2: models[7], winner: null, scores: null, scoreHistory: null },
            // Semi-Finals
            { id: 4, label: 'Semi-Final 1', p1: null, p2: null, winner: null, scores: null, scoreHistory: null },
            { id: 5, label: 'Semi-Final 2', p1: null, p2: null, winner: null, scores: null, scoreHistory: null },
            // Final
            { id: 6, label: 'Final',        p1: null, p2: null, winner: null, scores: null, scoreHistory: null },
        ];
    }

    async _runMatch(match) {
        // Intro screen
        document.getElementById('t-match-label').textContent = match.label.toUpperCase();
        document.getElementById('t-intro-p1').textContent  = this._short(match.p1);
        document.getElementById('t-intro-p2').textContent  = this._short(match.p2);
        document.getElementById('t-intro-note').textContent = this._matchNote(match);
        this._show('t-match-intro');
        await this._sleep(3500);

        // Run game
        this._hideAll();
        this.game.resetForMatch(this.totalRounds);
        this.game.setAI(1, match.p1);
        this.game.setAI(2, match.p2);
        const promise = this.game.runFullGame();
        this.game.turns.startGame();
        const scores = await promise;

        // Record result — capture score history before it gets cleared on next reset
        match.scores = scores;
        match.scoreHistory = [...this.game._scoreHistory];
        match.winner = scores[1].finalScore >= scores[2].finalScore ? match.p1 : match.p2;

        // Log result to server
        const isP1Winner = match.winner === match.p1;
        postResult({
            tournament_id: this.tournamentId,
            round: match.id,
            p1: match.p1,
            p2: match.p2,
            p1_score: scores[1].finalScore,
            p2_score: scores[2].finalScore,
            winner: match.winner,
            mode: this.mode,
        });

        // Update stats panel
        this._renderStats();

        // Result screen
        const loser  = match.winner === match.p1 ? match.p2 : match.p1;
        const wScore = match.winner === match.p1 ? scores[1].finalScore : scores[2].finalScore;
        const lScore = match.winner === match.p1 ? scores[2].finalScore : scores[1].finalScore;

        document.getElementById('t-result-label').textContent  = match.label.toUpperCase() + ' — RESULT';
        document.getElementById('t-result-winner').textContent = this._short(match.winner);
        document.getElementById('t-result-scores').innerHTML   =
            `<div class="rs-row rs-win">${this._short(match.winner)}<span>${wScore.toLocaleString()}</span></div>
             <div class="rs-row rs-lose">${this._short(loser)}<span>${lScore.toLocaleString()}</span></div>`;
        document.getElementById('t-result-next').textContent =
            match.id === 6 ? 'Revealing the Champion...' : 'Bracket updating...';
        this._show('t-match-result');
        await this._sleep(5000);

        // Updated bracket
        this._renderBracket(match.label + ' complete');
        this._show('t-bracket');
        await this._sleep(match.id === 6 ? 1000 : 3000);
    }

    _matchNote(match) {
        if (match.id === 6) return '🏆 Championship Final';
        if (match.id === 4 || match.id === 5) return 'Winner advances to the Final';
        return 'Winner advances to the Semi-Finals';
    }

    _showChampion(winner) {
        document.getElementById('t-champ-name').textContent = this._short(winner);
        const wins = this.bracket.filter(m => m.winner === winner);
        const path = wins.map(m => m.label).join(' → ');
        const finalScore = (() => {
            const fm = this.bracket[6];
            const isP1 = fm.p1 === winner;
            return (isP1 ? fm.scores[1] : fm.scores[2]).finalScore;
        })();
        document.getElementById('t-champ-record').textContent =
            `${wins.length} wins — Final score: ${finalScore.toLocaleString()}`;

        // Action buttons
        const actionsEl = document.getElementById('t-champ-actions');
        if (actionsEl) {
            actionsEl.innerHTML = '';

            const statsBtn = document.createElement('button');
            statsBtn.className = 'btn t-champ-btn';
            statsBtn.textContent = '📊 Full Results';
            statsBtn.onclick = () => this._toggleStats(true);

            const backBtn = document.createElement('button');
            backBtn.className = 'btn t-champ-btn';
            backBtn.textContent = '← Back to Game';
            backBtn.onclick = () => this._hideAll();

            actionsEl.appendChild(statsBtn);
            actionsEl.appendChild(backBtn);
        }

        this._show('t-champion');
    }

    // ── Stats Panel ────────────────────────────────────────────

    _toggleStats(force) {
        this._statsOpen = force !== undefined ? force : !this._statsOpen;
        const panel = document.getElementById('t-stats-panel');
        if (this._statsOpen) {
            panel?.classList.remove('t-stats-hidden');
            this._renderStats();
        } else {
            panel?.classList.add('t-stats-hidden');
        }
    }

    _renderStats() {
        const content = document.getElementById('tsp-content');
        if (!content) return;

        const completed = this.bracket ? this.bracket.filter(m => m.winner) : [];

        let html = '';

        // Bracket summary
        html += `<div class="tsp-section-title">Bracket</div>`;
        if (this.bracket) {
            const sections = [
                { label: 'Quarter-Finals', ids: [0, 1, 2, 3] },
                { label: 'Semi-Finals',    ids: [4, 5] },
                { label: 'Final',          ids: [6] },
            ];
            for (const sec of sections) {
                html += `<div class="tsp-bracket-section">${sec.label}</div>`;
                for (const id of sec.ids) {
                    const m = this.bracket[id];
                    const done = !!m.winner;
                    html += `<div class="tsp-match ${done ? 'tsp-done' : ''}">
                        <div class="tsp-match-label">${m.label}</div>
                        <div class="tsp-match-row">
                            <span class="tsp-name ${m.winner === m.p1 ? 'tsp-win' : done ? 'tsp-lose' : ''}">${m.p1 ? this._short(m.p1) : '—'}</span>
                            <span class="tsp-vs">vs</span>
                            <span class="tsp-name ${m.winner === m.p2 ? 'tsp-win' : done ? 'tsp-lose' : ''}">${m.p2 ? this._short(m.p2) : '—'}</span>
                            ${done ? `<span class="tsp-winner-tag">✓ ${this._short(m.winner)}</span>` : ''}
                        </div>
                    </div>`;
                }
            }
        } else {
            html += `<div class="tsp-empty">No tournament active</div>`;
        }

        // Per-match results
        if (completed.length > 0) {
            html += `<div class="tsp-section-title" style="margin-top:14px;">Match Results</div>`;
            for (const m of completed) {
                const s1 = m.scores[1], s2 = m.scores[2];
                const wScore = m.winner === m.p1 ? s1.finalScore : s2.finalScore;
                const lScore = m.winner === m.p1 ? s2.finalScore : s1.finalScore;
                const loser  = m.winner === m.p1 ? m.p2 : m.p1;
                const total  = wScore + lScore || 1;
                const wPct   = Math.round(wScore / total * 100);
                const lPct   = 100 - wPct;

                html += `<div class="tsp-result-card">
                    <div class="tsp-result-title">${m.label}</div>
                    <div class="tsp-bar-row">
                        <span class="tsp-bar-name tsp-bar-name-win">${this._short(m.winner)}</span>
                        <div class="tsp-bar-track"><div class="tsp-bar tsp-bar-win" style="width:${wPct}%"></div></div>
                        <span class="tsp-bar-score">${wScore.toLocaleString()}</span>
                    </div>
                    <div class="tsp-bar-row">
                        <span class="tsp-bar-name tsp-bar-name-lose">${this._short(loser)}</span>
                        <div class="tsp-bar-track"><div class="tsp-bar tsp-bar-lose" style="width:${lPct}%"></div></div>
                        <span class="tsp-bar-score">${lScore.toLocaleString()}</span>
                    </div>
                    ${m.scoreHistory?.length ? `<canvas class="tsp-chart" data-match-id="${m.id}" width="224" height="48"></canvas>` : ''}
                </div>`;
            }
        }

        content.innerHTML = html;

        // Draw mini charts after DOM update
        for (const m of completed) {
            if (!m.scoreHistory?.length) continue;
            const canvas = content.querySelector(`canvas[data-match-id="${m.id}"]`);
            if (canvas) this._drawMiniChart(canvas, m.scoreHistory);
        }
    }

    _drawMiniChart(canvas, history) {
        if (!history?.length) return;
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        const pad = 4;
        const allScores = history.flatMap(h => [h.p1, h.p2]);
        const maxScore = Math.max(...allScores, 1);
        const n = history.length;

        const xOf = i => pad + (i / Math.max(n - 1, 1)) * (W - pad * 2);
        const yOf = v => H - pad - (v / maxScore) * (H - pad * 2);

        // Subtle mid-line
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad, H / 2); ctx.lineTo(W - pad, H / 2);
        ctx.stroke();

        const drawLine = (key, color) => {
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            history.forEach((h, i) => {
                const x = xOf(i), y = yOf(h[key]);
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            });
            ctx.stroke();
            const last = history[history.length - 1];
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(xOf(n - 1), yOf(last[key]), 2.5, 0, Math.PI * 2);
            ctx.fill();
        };

        drawLine('p1', 'hsl(180, 60%, 55%)');
        drawLine('p2', 'hsl(25, 75%, 62%)');
    }

    // ── Bracket display ─────────────────────────────────────────

    _renderBracket(statusText) {
        document.getElementById('t-bracket-status').textContent = statusText;
        const grid = document.getElementById('bracket-grid');
        grid.innerHTML = '';

        // Quarter-Finals column
        const qf    = this._makeCol('Quarter-Finals', this.bracket.slice(0, 4));
        const conn1 = this._makeConnectorCol(['→ SF1', '→ SF1', '→ SF2', '→ SF2']);
        // Semi-Finals column
        const sf    = this._makeCol('Semi-Finals', this.bracket.slice(4, 6), 'semi');
        const conn2 = this._makeConnectorCol(['', '→ Final', '']);
        // Final column
        const fi    = this._makeCol('Final', [this.bracket[6]], 'final');

        [qf, conn1, sf, conn2, fi].forEach(el => grid.appendChild(el));
    }

    _makeCol(title, matches, extraClass = '') {
        const col = document.createElement('div');
        col.className = `bracket-col ${extraClass}`;

        const lbl = document.createElement('div');
        lbl.className = 'bc-label';
        lbl.textContent = title;
        col.appendChild(lbl);

        const matchesWrap = document.createElement('div');
        matchesWrap.className = 'bc-matches';

        for (const m of matches) {
            const box = document.createElement('div');
            box.className = 'bc-match' + (m.winner ? ' bc-done' : '');

            const p1 = document.createElement('div');
            p1.className = 'bc-player' +
                (m.winner === m.p1 ? ' bc-win' : m.winner ? ' bc-lose' : '');
            p1.textContent = m.p1 ? this._short(m.p1) : '—';

            const divider = document.createElement('div');
            divider.className = 'bc-divider';

            const p2 = document.createElement('div');
            p2.className = 'bc-player' +
                (m.winner === m.p2 ? ' bc-win' : m.winner ? ' bc-lose' : '');
            p2.textContent = m.p2 ? this._short(m.p2) : '—';

            box.appendChild(p1);
            box.appendChild(divider);
            box.appendChild(p2);

            if (m.winner) {
                const badge = document.createElement('div');
                badge.className = 'bc-winner-badge';
                badge.textContent = '✓ ' + this._short(m.winner);
                box.appendChild(badge);
            }

            matchesWrap.appendChild(box);
        }

        col.appendChild(matchesWrap);
        return col;
    }

    _makeConnectorCol(lines) {
        const col = document.createElement('div');
        col.className = 'bracket-connector-col';
        for (const line of lines) {
            const div = document.createElement('div');
            div.className = 'bc-conn-line';
            div.textContent = line;
            col.appendChild(div);
        }
        return col;
    }

    // ── Overlay control ─────────────────────────────────────────

    _show(screenId) {
        const overlay = document.getElementById('tournament-overlay');
        overlay.classList.remove('t-hidden');
        overlay.querySelectorAll('.t-screen').forEach(s => s.classList.add('t-hidden'));
        document.getElementById(screenId)?.classList.remove('t-hidden');
    }

    _hideAll() {
        document.getElementById('tournament-overlay')?.classList.add('t-hidden');
    }

    _short(model) {
        if (!model) return '—';
        return model
            .replace(/:.*$/, '')
            .split('/').pop()
            .replace(/-cloud$/, '')
            .replace(/-latest$/, '');
    }

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
