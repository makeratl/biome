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
        this._currentMatchIdx = null; // index in this.bracket of the match inside _runMatch
        this._setupStatsToggle();
    }

    _setupStatsToggle() {
        document.getElementById('btn-t-stats')?.addEventListener('click', () => this._toggleStats());
        document.getElementById('btn-t-stats-close')?.addEventListener('click', () => this._toggleStats(false));
        document.getElementById('btn-lb-close')?.addEventListener('click', () => this._toggleStats(false));
        document.getElementById('btn-lb-expand')?.addEventListener('click', () => this._showExpandedBracket());
        document.getElementById('btn-be-close')?.addEventListener('click', () => this._hideExpandedBracket());
    }

    _showExpandedBracket() {
        if (!this.bracket) return;
        const modeLabel = this.mode === 'lightning' ? 'Lightning' : 'Standard';
        const status = `${modeLabel} — ${this.totalRounds} rounds`;
        document.getElementById('be-status').textContent = status;
        this._renderBracketInto(document.getElementById('be-grid'));
        document.getElementById('bracket-expanded')?.classList.remove('bracket-expanded-hidden');
        // Hide the mini live-bracket while expanded view is up
        document.getElementById('live-bracket')?.classList.add('live-bracket-hidden');
    }

    _hideExpandedBracket() {
        document.getElementById('bracket-expanded')?.classList.add('bracket-expanded-hidden');
        // Reopen the mini if Stats is still toggled open
        if (this._statsOpen) {
            document.getElementById('live-bracket')?.classList.remove('live-bracket-hidden');
            this._renderLiveBracket();
        }
        this.game._refreshRightStackVisibility?.();
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

        // Enable the BRACKET tab in the right panel and auto-switch to it.
        // Stats menu is always accessible through the gear menu.
        const panelLabel = this.mode === 'lightning' ? 'Lightning' : 'Standard';
        this.game.setBracketAvailable({
            available: true,
            live: true,
            autoSwitch: true,
            title: `${panelLabel} Bracket`,
        });
        this._renderStats();
        this._renderLiveBracket();

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
        // Tournament finished — bracket stays available so user can review
        // results, but the LIVE indicator stops pulsing.
        this.game.setBracketAvailable({
            available: true,
            live: false,
            title: `${this.mode === 'lightning' ? 'Lightning' : 'Standard'} Bracket — Final`,
        });
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

        // Surface in the bracket panel that THIS match is now the live one
        this._currentMatchIdx = match.id;
        this._renderLiveBracket();

        await this._sleep(3500);

        // Run game
        this._hideAll();
        this.game.resetForMatch(this.totalRounds);
        this.game.setAI(1, match.p1);
        this.game.setAI(2, match.p2);
        // Repaint the bracket panel each round-end so the live card carries fresh scores + round counter
        this.game._onTournamentTick = () => this._renderLiveBracket();
        const promise = this.game.runFullGame();
        this.game.turns.startGame();
        const scores = await promise;
        this.game._onTournamentTick = null;

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

        // Update stats panel and live bracket — the panel can show the result while the result-screen overlay is up
        this._currentMatchIdx = null;
        this._renderStats();
        this._renderLiveBracket();

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
        const sidePanel = document.getElementById('t-stats-panel');
        const expanded = document.getElementById('bracket-expanded');

        if (this._statsOpen) {
            // The mini live bracket now lives in the right-panel BRACKET tab,
            // so Stats always opens the detailed side panel (full match history,
            // score charts, etc.). Works pre, during, and post tournament.
            sidePanel?.classList.remove('t-stats-hidden');
            this._renderStats();
        } else {
            sidePanel?.classList.add('t-stats-hidden');
            expanded?.classList.add('bracket-expanded-hidden');
        }
    }

    _renderLiveBracket() {
        if (!this.bracket) return;

        const modeLabel = this.mode === 'lightning' ? 'Lightning' : 'Standard';

        const sections = [
            { label: 'QF', ids: [0, 1, 2, 3] },
            { label: 'SF', ids: [4, 5] },
            { label: 'Final', ids: [6] },
        ];

        // The next match in the run order = lowest-id non-completed match with both slots filled, excluding the live one
        const upNextId = this.bracket.findIndex((m, i) =>
            !m.winner && i !== this._currentMatchIdx && m.p1 && m.p2
        );

        // Live data — only meaningful while a match is in progress
        const liveScores = (this._currentMatchIdx != null && this.game.simulation)
            ? this.game.simulation.finalScore()
            : null;
        const liveRound  = this._currentMatchIdx != null ? this.game.turns?.round : null;

        let html = '';
        for (const sec of sections) {
            html += `<div class="lb-section">${sec.label}</div>`;
            for (const id of sec.ids) {
                html += this._renderLiveMatch(this.bracket[id], id, upNextId, liveScores, liveRound);
            }
        }

        const panelContent = document.getElementById('bt-bracket-content');
        if (panelContent) panelContent.innerHTML = html;

        this.game.setBracketAvailable({
            available: true,
            live: this.running,
            title: `${modeLabel} Bracket`,
        });
    }

    _matchState(m, id, upNextId) {
        if (m.winner) return 'completed';
        if (id === this._currentMatchIdx) return 'live';
        if (!m.p1 || !m.p2) return 'pending';
        return id === upNextId ? 'upnext' : 'queued';
    }

    _renderLiveMatch(m, id, upNextId, liveScores, liveRound) {
        const state = this._matchState(m, id, upNextId);

        // Per-side classes — winner/loser only meaningful once a match completes
        const p1Done   = state === 'completed' && m.winner === m.p1;
        const p2Done   = state === 'completed' && m.winner === m.p2;
        const p1Lost   = state === 'completed' && !p1Done;
        const p2Lost   = state === 'completed' && !p2Done;

        // Live scores — color whichever side is currently leading
        const p1Live   = state === 'live' && liveScores ? liveScores[1].finalScore : null;
        const p2Live   = state === 'live' && liveScores ? liveScores[2].finalScore : null;
        const p1Lead   = state === 'live' && p1Live != null && p2Live != null && p1Live > p2Live;
        const p2Lead   = state === 'live' && p1Live != null && p2Live != null && p2Live > p1Live;

        // Completed margin — winner's score minus loser's score
        const margin = state === 'completed' && m.scores
            ? Math.abs(m.scores[1].finalScore - m.scores[2].finalScore)
            : null;

        const renderSide = (player, isP1) => {
            const win  = isP1 ? p1Done : p2Done;
            const lose = isP1 ? p1Lost : p2Lost;
            const lead = isP1 ? p1Lead : p2Lead;
            const live = isP1 ? p1Live : p2Live;
            const cls  = ['lb-side'];
            if (win)  cls.push('lb-win');
            if (lose) cls.push('lb-lose');
            if (lead) cls.push('lb-leading');
            const score = live != null ? `<span class="lb-score">${live.toLocaleString()}</span>` : '';
            return `<div class="${cls.join(' ')}">
                <span class="lb-name">${player ? this._short(player) : '—'}</span>
                ${score}
            </div>`;
        };

        let status = '';
        if (state === 'live') {
            const r = liveRound ?? 1;
            status = `<div class="lb-status lb-playing">LIVE · R${r}/${this.totalRounds}</div>`;
        } else if (state === 'completed') {
            const marginStr = margin != null && margin > 0 ? ` · +${margin.toLocaleString()}` : '';
            status = `<div class="lb-status lb-completed">✓ ${this._short(m.winner)}${marginStr}</div>`;
        } else if (state === 'upnext') {
            status = `<div class="lb-status lb-upnext">UP NEXT</div>`;
        }
        // 'queued' and 'pending' get no status row — they read as muted

        return `<div class="lb-match lb-${state}">
            ${renderSide(m.p1, true)}
            ${renderSide(m.p2, false)}
            ${status}
        </div>`;
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

        // Keep live bracket in sync if visible
        const liveBracketEl = document.getElementById('live-bracket');
        if (liveBracketEl && !liveBracketEl.classList.contains('live-bracket-hidden')) {
            this._renderLiveBracket();
        }
        // Keep expanded bracket in sync if visible
        const expandedEl = document.getElementById('bracket-expanded');
        if (expandedEl && !expandedEl.classList.contains('bracket-expanded-hidden')) {
            this._renderBracketInto(document.getElementById('be-grid'));
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
        this._renderBracketInto(document.getElementById('bracket-grid'));
    }

    _renderBracketInto(grid) {
        if (!grid || !this.bracket) return;
        grid.innerHTML = '';
        const qf    = this._makeCol('Quarter-Finals', this.bracket.slice(0, 4));
        const conn1 = this._makeConnectorCol(['→ SF1', '→ SF1', '→ SF2', '→ SF2']);
        const sf    = this._makeCol('Semi-Finals', this.bracket.slice(4, 6), 'semi');
        const conn2 = this._makeConnectorCol(['', '→ Final', '']);
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
        document.getElementById('t-bracket')?.classList.remove('t-bracket-manual');
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
