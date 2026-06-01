// Tournament mode — pits all available models against each other
// Structure: Quarter-Finals (4) → Semi-Finals (2) → Final (1) = 7 matches

import { postResult, renderOddsInto, fetchRankings, expectedScore } from './rankings.js';
import { CONFIG } from './config.js';
import { resolveModel } from './model-identity.js';
import { applyAvatar } from './model-avatar.js';

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

    async _showExpandedBracket() {
        if (!this.bracket) return;
        const modeLabel = this.mode === 'lightning' ? 'Lightning' : 'Standard';
        const status = `${modeLabel} — ${this.totalRounds} rounds`;
        document.getElementById('be-status').textContent = status;
        document.getElementById('bracket-expanded')?.classList.remove('bracket-expanded-hidden');
        // Hide the mini live-bracket while expanded view is up
        document.getElementById('live-bracket')?.classList.add('live-bracket-hidden');
        // Render immediately with whatever we have, then refresh seeds/ELO live
        this._renderBracketInto(document.getElementById('be-grid'));
        await this._loadParticipantStats();
        this._renderBracketInto(document.getElementById('be-grid'));
    }

    // Fetch current ELO for the 8 field models and derive 1–8 seeds (best ELO =
    // seed 1). Cached on this._pStats; refreshable so standings stay current as
    // matches post results. Tolerates a missing/unreachable server (null ELO).
    async _loadParticipantStats() {
        if (!this.bracket) return null;
        const norm = (m) => m
            ? m.replace(/:.*$/, '').split('/').pop().replace(/-cloud$/, '').replace(/-latest$/, '')
            : '';
        const rankings = await fetchRankings();
        const lookup = {};
        if (rankings) {
            for (const [name, s] of Object.entries(rankings)) {
                lookup[norm(name)] = { elo: s.elo, wins: s.wins, losses: s.losses };
            }
        }
        // Field = the 8 quarter-final competitors
        const field = [];
        for (const id of [0, 1, 2, 3]) field.push(this.bracket[id].p1, this.bracket[id].p2);
        const ranked = field
            .filter(Boolean)
            .map(p => ({ key: norm(p), elo: lookup[norm(p)]?.elo ?? null }))
            .filter(x => x.elo != null)
            .sort((a, b) => b.elo - a.elo);
        const seedMap = {};
        ranked.forEach((x, i) => { seedMap[x.key] = i + 1; });

        this._pStats = { norm, lookup, seedMap };
        return this._pStats;
    }

    // Resolve a model's seed / ELO / record (null-safe when stats not loaded).
    _statOf(model) {
        const S = this._pStats;
        if (!model || !S) return null;
        const k = S.norm(model);
        const base = S.lookup[k] || {};
        return { elo: base.elo ?? null, wins: base.wins ?? 0, losses: base.losses ?? 0, seed: S.seedMap[k] ?? null };
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

    async start(models, mode = 'standard', world = null) {
        if (this.running) return;
        this.running = true;
        this.mode = mode;
        // World settings (grid size / hex zoom / rounds) apply to every match in
        // the bracket. Rounds come from the world picker when provided.
        this.world = world;
        this.totalRounds = (world && world.rounds)
            || (mode === 'lightning' ? CONFIG.GAME.LIGHTNING_ROUNDS : CONFIG.GAME.TOTAL_ROUNDS);

        // Shuffle for random seeding
        const seeded = [...models].sort(() => Math.random() - 0.5);
        this.bracket = this._buildBracket(seeded);

        // Pull ELO/seed data for the field so the bracket can show ranking
        // context + detect upsets. Fire-and-forget: repaint bracket screens
        // once it lands (first interstitial may render a beat before seeds).
        this._pStats = null;
        this._loadParticipantStats().then(() => {
            const exp = document.getElementById('bracket-expanded');
            if (exp && !exp.classList.contains('bracket-expanded-hidden')) {
                this._renderBracketInto(document.getElementById('be-grid'));
            }
            const tb = document.getElementById('t-bracket');
            if (tb && !tb.classList.contains('t-hidden')) {
                this._renderBracketInto(document.getElementById('bracket-grid'));
            }
        });

        // Reveal the BRACKET tab in the HUD console. No auto-switch — the
        // console stays on Stats (eco) by default; the bracket is one tap away.
        const panelLabel = this.mode === 'lightning' ? 'Lightning' : 'Standard';
        this.game.setBracketAvailable({
            available: true,
            live: true,
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
        // Intro screen — fighting-game VS reveal: both fighters' cards slam in with
        // their cyber-organic portraits, the final gets a grander gold treatment.
        const isFinal = match.id === 6;
        document.getElementById('t-match-label').textContent = match.label.toUpperCase();
        document.getElementById('t-intro-note').textContent = this._matchNote(match);
        const introScreen = document.getElementById('t-match-intro');
        introScreen.classList.toggle('t-intro-champ', isFinal);
        this._show('t-match-intro');
        await Promise.all([
            this.game._renderPlayerCard('t-intro-p1-card', { player: 1, model: match.p1 }),
            this.game._renderPlayerCard('t-intro-p2-card', { player: 2, model: match.p2 }),
        ]);
        this._renderIntroOdds(match.p1, match.p2); // async — fills the odds line once ELO is fetched
        // Re-trigger the slam-in animation by reflow, with a matching sound sting.
        introScreen.classList.remove('pm-enter');
        void introScreen.offsetWidth;
        introScreen.classList.add('pm-enter');
        this.game._playSound?.(isFinal ? 'champion' : 'vs');

        // Surface in the bracket panel that THIS match is now the live one
        this._currentMatchIdx = match.id;
        this._renderLiveBracket();

        await this._sleep(3500);

        // Run game
        this._hideAll();
        this.game.resetForMatch(this.totalRounds, this.world);
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

        // Log result to server — await so we can celebrate the rank movement it returns
        const res = await postResult({
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

        // Rank movement is shown as a badge inside the card (winner side), not as
        // a separate floating callout — so the result reads as one coherent card.
        const winnerSide = res?.result
            ? [res.result.p1, res.result.p2].find(s => s && s.name === match.winner)
            : null;
        document.getElementById('t-result-rank').innerHTML = this._rankBadge(winnerSide);

        document.getElementById('t-result-scores').innerHTML   =
            `<div class="rs-row rs-win">${this._short(match.winner)}<span>${wScore.toLocaleString()}</span></div>
             <div class="rs-row rs-lose">${this._short(loser)}<span>${lScore.toLocaleString()}</span></div>`;
        document.getElementById('t-result-next').textContent =
            match.id === 6 ? 'Revealing the Champion...' : 'Bracket updating...';
        this._show('t-match-result');

        // Let the result card (with its rank badge) be read on its own — no
        // overlapping celebration on top of it.
        await this._sleep(3200);

        // Move to the bracket, then play ONLY the rare headline moments
        // (NEW CHAMPION / UPSET) as a center callout over it. Promotions/demotions
        // already live in the card, so nothing collides.
        this._renderBracket(match.label + ' complete');
        this._show('t-bracket');
        const drama = this.game._celebrateResult?.(res?.result, { headlinesOnly: true }) || 0;
        if (drama) {
            await this.game._waitForCalloutsDone?.();
            await this._sleep(match.id === 6 ? 800 : 1200);
        } else {
            await this._sleep(match.id === 6 ? 1000 : 2600);
        }
    }

    // Rank-movement badge for the result card (winner side).
    _rankBadge(s) {
        if (!s || s.rankAfter == null) return '';
        const after = s.rankAfter;
        if (s.rankBefore == null) return `<span class="rb-new">NEW · #${after}</span>`;
        const before = s.rankBefore;
        if (after < before) {
            return `<span class="rb-up">${after === 1 ? '👑 ' : '▲ '}#${before} → #${after}</span>`;
        }
        if (after > before) return `<span class="rb-down">▼ #${before} → #${after}</span>`;
        return `<span class="rb-hold">holds #${after}</span>`;
    }

    _matchNote(match) {
        if (match.id === 6) return '🏆 Championship Final';
        if (match.id === 4 || match.id === 5) return 'Winner advances to the Final';
        return 'Winner advances to the Semi-Finals';
    }

    async _renderIntroOdds(p1, p2) {
        const [r1, r2] = await Promise.all([
            p1 ? this.game._fetchRanking(p1) : null,
            p2 ? this.game._fetchRanking(p2) : null,
        ]);
        renderOddsInto(
            document.getElementById('t-intro-odds-p1'),
            document.getElementById('t-intro-odds-p2'),
            r1, r2,
        );
    }

    _showChampion(winner) {
        document.getElementById('t-champ-name').textContent = this._short(winner);
        const champAva = document.getElementById('t-champ-avatar');
        if (champAva) { applyAvatar(champAva, winner); champAva.classList.add('show'); }
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

    // Mini bracket = a live-broadcast strip: a hero card (now playing / up next /
    // champion) over a one-line "up next" + a progress rail that collapses the
    // whole 7-match tree into a row of nodes. Tap the header ⛶ to zoom to full.
    _renderLiveBracket() {
        if (!this.bracket) return;

        const modeLabel = this.mode === 'lightning' ? 'Lightning' : 'Standard';
        const liveIdx   = this._currentMatchIdx;
        const isLive    = liveIdx != null && this.bracket[liveIdx] && !this.bracket[liveIdx].winner;

        const upNextId = this.bracket.findIndex((m, i) =>
            !m.winner && i !== liveIdx && m.p1 && m.p2);

        const championDone = !!this.bracket[6]?.winner;

        // Hero = the match that matters right now.
        let heroId;
        if (isLive)              heroId = liveIdx;
        else if (championDone)   heroId = 6;
        else if (upNextId !== -1) heroId = upNextId;
        else                     heroId = Math.max(0, this.bracket.findIndex(m => !m.winner));

        const liveScores = (isLive && this.game.simulation) ? this.game.simulation.finalScore() : null;
        const liveRound  = isLive ? this.game.turns?.round : null;

        const hero = championDone && heroId === 6
            ? this._lbnChampionHero(this.bracket[6])
            : this._lbnHero(this.bracket[heroId], heroId, { isLive: heroId === liveIdx && isLive, liveScores, liveRound });

        // "Up next" line — only while a match is live and another is queued.
        let nextLine = '';
        if (isLive && upNextId !== -1) {
            const u = this.bracket[upNextId];
            nextLine = `<div class="lbn-next"><span class="lbn-next-tag">UP NEXT</span>
                <b>${this._short(u.p1)}</b><span class="lbn-next-vs">vs</span><b>${this._short(u.p2)}</b></div>`;
        }

        const done = this.bracket.filter(m => m.winner).length;
        const html = `<div class="lbn">
            ${hero}
            ${nextLine}
            ${this._lbnRail(liveIdx, upNextId, done)}
        </div>`;

        const panelContent = document.getElementById('bt-bracket-content');
        if (panelContent) { panelContent.innerHTML = html; this._paintAvatars(panelContent); }

        this.game.setBracketAvailable({
            available: true,
            live: this.running,
            title: `${modeLabel} Bracket`,
        });
    }

    // Hero card for a live / up-next match.
    _lbnHero(m, id, { isLive, liveScores, liveRound }) {
        const state = m.winner ? 'done' : isLive ? 'live' : (m.p1 && m.p2) ? 'upnext' : 'pending';

        const s1 = isLive && liveScores ? liveScores[1].finalScore : null;
        const s2 = isLive && liveScores ? liveScores[2].finalScore : null;
        const lead1 = s1 != null && s2 != null && s1 > s2;
        const lead2 = s1 != null && s2 != null && s2 > s1;

        let tag;
        if (state === 'live')   tag = `<div class="lbn-tag lbn-tag--live"><span class="lbn-livedot"></span>LIVE · R${liveRound ?? 1}/${this.totalRounds}</div>`;
        else if (state === 'upnext') tag = `<div class="lbn-tag lbn-tag--next">UP NEXT</div>`;
        else                    tag = `<div class="lbn-tag lbn-tag--queued">${m.label || 'Match'}</div>`;

        const side = (player, isP1) => {
            const score = isP1 ? s1 : s2;
            const lead  = isP1 ? lead1 : lead2;
            const cls = ['lbn-side'];
            if (lead) cls.push('lbn-lead');
            const slot = state === 'live' ? (isP1 ? 1 : 2) : undefined;
            const st = this._statOf(player);
            const elo = st?.elo != null ? `<span class="lbn-elo">${Math.round(st.elo)}</span>` : '';
            const sc  = score != null ? `<span class="lbn-score">${score.toLocaleString()}</span>` : '';
            return `<div class="${cls.join(' ')}">
                ${this._badge(player, { slot, seed: st?.seed })}
                <span class="lbn-name">${player ? this._short(player) : '—'}</span>
                ${elo}${sc}
            </div>`;
        };

        // VS share bar (live only) — P1 share of combined score, fills cyan→orange.
        let vsbar = '';
        if (state === 'live' && s1 != null && s2 != null) {
            const total = s1 + s2 || 1;
            const p1pct = Math.round((s1 / total) * 100);
            vsbar = `<div class="lbn-vsbar"><span class="lbn-vsbar-p1" style="width:${p1pct}%"></span></div>`;
        }

        return `<div class="lbn-hero lbn-hero--${state}">
            ${tag}
            ${side(m.p1, true)}
            ${vsbar}
            ${side(m.p2, false)}
        </div>`;
    }

    // Hero card when the tournament is decided — crowned champion.
    _lbnChampionHero(fin) {
        const st = this._statOf(fin.winner);
        const wins = this.bracket.filter(m => m.winner === fin.winner).length;
        const elo = st?.elo != null ? `<span class="lbn-champ-elo">${Math.round(st.elo)} ELO</span>` : '';
        return `<div class="lbn-hero lbn-hero--champ">
            <div class="lbn-tag lbn-tag--champ">🏆 CHAMPION</div>
            <div class="lbn-champ-row">
                ${this._badge(fin.winner, { size: 'lg' })}
                <div class="lbn-champ-meta">
                    <div class="lbn-champ-name">${this._short(fin.winner)}</div>
                    <div class="lbn-champ-sub">${elo}<span class="lbn-champ-wins">${wins} wins</span></div>
                </div>
            </div>
        </div>`;
    }

    // Progress rail — the 7 matches as nodes (QF·QF·QF·QF — SF·SF — ★Final).
    _lbnRail(liveIdx, upNextId, done) {
        const order = [0, 1, 2, 3, 4, 5, 6];
        const node = (id) => {
            const m = this.bracket[id];
            let st = 'pending';
            if (m.winner)            st = 'done';
            else if (id === liveIdx) st = 'live';
            else if (id === upNextId) st = 'upnext';
            const final = id === 6 ? ' lbn-node--final' : '';
            return `<span class="lbn-node lbn-node--${st}${final}"></span>`;
        };
        let nodes = '';
        order.forEach((id, i) => {
            if (i === 4 || i === 6) nodes += `<span class="lbn-rail-gap"></span>`;
            nodes += node(id);
        });
        return `<div class="lbn-rail">
            <div class="lbn-rail-nodes">${nodes}</div>
            <span class="lbn-rail-count">${done} / 7</span>
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
        this._paintAvatars(content);

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

        const upNextId = this.bracket.findIndex((m, i) =>
            !m.winner && i !== this._currentMatchIdx && m.p1 && m.p2);
        const liveScores = (this._currentMatchIdx != null && this.game.simulation)
            ? this.game.simulation.finalScore() : null;
        const liveRound = this._currentMatchIdx != null ? this.game.turns?.round : null;
        const ctx = { upNextId, liveScores, liveRound };

        // Round 1 (QF) pairs feed into SF; each pair box draws the connector spine.
        const cell = (id) => `<div class="bt-cell">${this._bracketCard(this.bracket[id], ctx)}</div>`;
        const pair = (a, b) => `<div class="bt-pair">${cell(a)}${cell(b)}</div>`;

        const qf = `<div class="bt-round bt-round--qf">
            <div class="bt-round-label">Quarter-Finals</div>
            <div class="bt-round-body">${pair(0, 1)}${pair(2, 3)}</div>
        </div>`;
        const sf = `<div class="bt-round bt-round--sf">
            <div class="bt-round-label">Semi-Finals</div>
            <div class="bt-round-body">${pair(4, 5)}</div>
        </div>`;
        const fi = `<div class="bt-round bt-round--final">
            <div class="bt-round-label">Final</div>
            <div class="bt-round-body"><div class="bt-pair bt-pair--solo">${cell(6)}</div></div>
        </div>`;
        const champ = `<div class="bt-round bt-round--champ">
            <div class="bt-round-label">Champion</div>
            <div class="bt-round-body">${this._championNode()}</div>
        </div>`;

        grid.innerHTML = `<div class="bt-stage">
            ${this._bracketStatbar()}
            <div class="bracket-tree">${qf}${sf}${fi}${champ}</div>
        </div>`;
        this._paintAvatars(grid);
    }

    // Per-match card with seed/ELO/score for both sides + state-driven framing.
    _bracketCard(m, ctx) {
        const isLive = !m.winner && m.id === this._currentMatchIdx;
        const state = m.winner ? 'done'
            : isLive ? 'live'
            : (m.id === ctx.upNextId ? 'upnext'
            : (m.p1 && m.p2 ? 'queued' : 'pending'));

        // Upset read for completed matches — winner's pre-match win probability
        // by ELO. < 0.5 means the underdog took it; lower = bigger shock.
        let upset = false, bigUpset = false, wp = null;
        if (state === 'done' && m.winner) {
            const wStat = this._statOf(m.winner);
            const lStat = this._statOf(m.winner === m.p1 ? m.p2 : m.p1);
            if (wStat?.elo != null && lStat?.elo != null) {
                wp = expectedScore(wStat.elo, lStat.elo);
                upset = wp < 0.5;
                bigUpset = wp < 0.34;
            }
        }

        const cls = ['bt-card', `bt-${state}`];
        if (state === 'done') cls.push(upset ? 'bt-upset' : 'bt-chalk');
        if (bigUpset) cls.push('bt-upset-big');

        // Status ribbon (top-right)
        let ribbon = '';
        if (state === 'live') {
            ribbon = `<span class="bt-ribbon bt-ribbon-live">LIVE · R${ctx.liveRound ?? 1}/${this.totalRounds}</span>`;
        } else if (state === 'upnext') {
            ribbon = `<span class="bt-ribbon bt-ribbon-next">UP NEXT</span>`;
        } else if (state === 'done' && upset) {
            const pct = wp != null ? ` ${Math.round((1 - wp) * 100)}%` : '';
            ribbon = `<span class="bt-ribbon bt-ribbon-upset">⚡ UPSET${pct}</span>`;
        } else if (state === 'done') {
            ribbon = `<span class="bt-ribbon bt-ribbon-chalk">✓</span>`;
        }

        return `<div class="${cls.join(' ')}">
            ${ribbon}
            ${this._bracketSide(m, true, state, ctx)}
            <div class="bt-card-mid"></div>
            ${this._bracketSide(m, false, state, ctx)}
        </div>`;
    }

    _bracketSide(m, isP1, state, ctx) {
        const player = isP1 ? m.p1 : m.p2;
        const stat = this._statOf(player);
        const isWin = state === 'done' && m.winner === player;
        const isLose = state === 'done' && m.winner && m.winner !== player;

        // Score: completed → final score; live → current sim score
        let score = null;
        if (state === 'done' && m.scores) {
            score = (isP1 ? m.scores[1] : m.scores[2])?.finalScore;
        } else if (state === 'live' && ctx.liveScores) {
            score = (isP1 ? ctx.liveScores[1] : ctx.liveScores[2])?.finalScore;
        }
        const lead = state === 'live' && ctx.liveScores
            && score != null
            && score > (isP1 ? ctx.liveScores[2] : ctx.liveScores[1])?.finalScore;

        const cls = ['bt-side'];
        if (isWin) cls.push('bt-win');
        if (isLose) cls.push('bt-lose');
        if (lead) cls.push('bt-lead');

        // Live match sides carry the P1/P2 accent (cyan/orange) so a running
        // bracket match looks like the live game; everyone else gets their hue.
        const slot = state === 'live' ? (isP1 ? 1 : 2) : undefined;
        const badge = this._badge(player, { slot, seed: stat?.seed });
        const elo = stat?.elo != null ? `<span class="bt-elo">${Math.round(stat.elo)}</span>` : '';
        const scoreEl = score != null ? `<span class="bt-score">${score.toLocaleString()}</span>` : '';

        return `<div class="${cls.join(' ')}">
            ${badge}
            <span class="bt-name">${player ? this._short(player) : '—'}</span>
            ${elo}
            ${scoreEl}
        </div>`;
    }

    _championNode() {
        const fin = this.bracket[6];
        if (fin?.winner) {
            const stat = this._statOf(fin.winner);
            const wins = this.bracket.filter(m => m.winner === fin.winner).length;
            const elo = stat?.elo != null ? `<div class="bt-champ-elo">${Math.round(stat.elo)} ELO</div>` : '';
            const seed = stat?.seed != null ? `<span class="bt-champ-seed">Seed ${stat.seed}</span>` : '';
            return `<div class="bt-champ bt-champ-crowned">
                <div class="bt-champ-glow" aria-hidden="true"></div>
                <div class="bt-champ-trophy">🏆</div>
                ${this._badge(fin.winner, { size: 'lg' })}
                <div class="bt-champ-name">${this._short(fin.winner)}</div>
                ${elo}
                <div class="bt-champ-record">${seed}<span class="bt-champ-wins">${wins} wins</span></div>
                <div class="bt-champ-plinth" aria-hidden="true"></div>
            </div>`;
        }
        return `<div class="bt-champ bt-champ-tbd">
            <div class="bt-champ-trophy">🏆</div>
            <div class="bt-champ-name">—</div>
            <div class="bt-champ-record">To be crowned</div>
            <div class="bt-champ-plinth" aria-hidden="true"></div>
        </div>`;
    }

    // Header stat strip — field summary, progress, top seed, biggest upset.
    _bracketStatbar() {
        const modeLabel = this.mode === 'lightning' ? 'Lightning' : 'Standard';
        const done = this.bracket.filter(m => m.winner).length;

        // Top seed in the field
        let topSeedChip = '';
        if (this._pStats) {
            const top = Object.entries(this._pStats.seedMap).find(([, s]) => s === 1);
            if (top) {
                const elo = this._pStats.lookup[top[0]]?.elo;
                topSeedChip = `<div class="bt-stat">
                    <span class="bt-stat-k">Top Seed</span>
                    <span class="bt-stat-v">${top[0]}${elo != null ? ` · ${Math.round(elo)}` : ''}</span>
                </div>`;
            }
        }

        // Biggest upset across completed matches (lowest winner win-prob)
        let upsetChip = '';
        let best = null;
        for (const m of this.bracket) {
            if (!m.winner) continue;
            const wStat = this._statOf(m.winner);
            const lStat = this._statOf(m.winner === m.p1 ? m.p2 : m.p1);
            if (wStat?.elo == null || lStat?.elo == null) continue;
            const wp = expectedScore(wStat.elo, lStat.elo);
            if (wp < 0.5 && (!best || wp < best.wp)) {
                best = { wp, winner: m.winner, loser: m.winner === m.p1 ? m.p2 : m.p1 };
            }
        }
        if (best) {
            upsetChip = `<div class="bt-stat bt-stat-upset">
                <span class="bt-stat-k">⚡ Biggest Upset</span>
                <span class="bt-stat-v">${this._short(best.winner)} def. ${this._short(best.loser)} · ${Math.round((1 - best.wp) * 100)}%</span>
            </div>`;
        }

        return `<div class="bt-statbar">
            <div class="bt-stat">
                <span class="bt-stat-k">Field</span>
                <span class="bt-stat-v">8 models · ${modeLabel} · ${this.totalRounds} rounds</span>
            </div>
            <div class="bt-stat">
                <span class="bt-stat-k">Progress</span>
                <span class="bt-stat-v">${done} / 7 matches</span>
            </div>
            ${topSeedChip}
            ${upsetChip}
        </div>`;
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

    // Per-model brand hue from the shared taxonomy, so each competitor keeps one
    // colour identity across both bracket views (and unknown models still get a
    // stable hash hue via resolveModel). Live matches add a P1/P2 accent ring.
    _modelHue(model) {
        return resolveModel(model).hue;
    }

    // Hex model badge — carries data-model so _paintAvatars can drop in the baked
    // cyber-organic portrait after render; until/unless one exists it shows the
    // brand-hue gradient + initials (the size-appropriate procedural fallback).
    // slot 1/2 → P1/P2 accent ring (live match). opts: { slot, size:'lg'|'sm', seed }.
    _badge(model, opts = {}) {
        const sizeCls = opts.size ? ` bt-badge-${opts.size}` : '';
        const seedPip = opts.seed != null
            ? `<span class="bt-badge-seed">${opts.seed}</span>` : '';
        if (!model) return `<span class="bt-badge bt-badge-empty${sizeCls}">·</span>`;
        const ini = this.game?._modelInitials
            ? this.game._modelInitials(model)
            : this._short(model).slice(0, 2).toUpperCase();
        const slotCls = opts.slot === 1 ? ' bt-badge-p1' : opts.slot === 2 ? ' bt-badge-p2' : '';
        const data = `data-model="${model}"`;
        return `<span class="bt-badge${slotCls}${sizeCls}" ${data} style="--bh:${this._modelHue(model)}">${ini}${seedPip}</span>`;
    }

    // Drop baked avatars into every badge under `root` (after its innerHTML set).
    _paintAvatars(root) {
        root?.querySelectorAll?.('.bt-badge[data-model]').forEach(el => applyAvatar(el, el.dataset.model));
    }

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
