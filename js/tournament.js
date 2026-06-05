// Tournament mode — pits all available models against each other
// Structure: Quarter-Finals (4) → Semi-Finals (2) → Final (1) = 7 matches

import { postResult, fetchRankings, expectedScore } from './rankings.js';
import { CONFIG } from './config.js';
import { resolveModel } from './model-identity.js';
import { applyAvatar, applyAvatarVideo } from './model-avatar.js';
import { listResidentModels } from './ai.js';
import { shortId } from './util.js';
import { BroadcastCarousel } from './broadcast-carousel.js';

export class TournamentManager {
    constructor(game) {
        this.game = game;
        this.bracket = null;
        this.running = false;
        this.tournamentId = shortId(8);
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
        // Field = every competitor in the opening round.
        const field = [];
        for (const m of this.rounds[0]) field.push(m.p1, m.p2);
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

    async start(models, mode = 'standard', world = null, format = null) {
        if (this.running) return;
        this.running = true;
        this.mode = mode;
        // The chosen format (field + seed strategy) already ordered `models` into
        // round-1 pairings — index 2i meets 2i+1 — so the bracket consumes them
        // as-is. No shuffle here; randomness (if any) lives in the seed strategy.
        this.format = format;
        // World settings (grid size / hex zoom / rounds) apply to every match in
        // the bracket. Rounds come from the world picker when provided.
        this.world = world;
        this.totalRounds = (world && world.rounds)
            || (mode === 'lightning' ? CONFIG.GAME.LIGHTNING_ROUNDS : CONFIG.GAME.TOTAL_ROUNDS);

        this.bracket = this._buildBracket(models);

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

        // Run every match in round-major order; each winner feeds the next round.
        // Works for any power-of-two field (8 / 16 / 32) since the bracket is a
        // generated tree, not a fixed 7-match list.
        for (const match of this.bracket) {
            await this._runMatch(match);
            this._propagateWinner(match);
        }

        this._showChampion(this._finalMatch().winner);
        this.running = false;
        // Tournament finished — bracket stays available so user can review
        // results, but the LIVE indicator stops pulsing.
        this.game.setBracketAvailable({
            available: true,
            live: false,
            title: `${this.mode === 'lightning' ? 'Lightning' : 'Standard'} Bracket — Final`,
        });
    }

    // Build a single-elimination tree from a power-of-two field. Produces
    // this.rounds (array of rounds, each an array of match objects) and returns
    // the flat round-major list used as this.bracket. Match `id` equals its flat
    // index, so `this.bracket[id]` stays valid. An 8-field yields the same 7
    // matches / labels as the old hardcoded bracket.
    _buildBracket(models) {
        const size = models.length;
        const rounds = [];
        let n = size, r = 0, id = 0;
        while (n >= 2) {
            const count = n / 2;
            const round = [];
            for (let slot = 0; slot < count; slot++) {
                round.push({ id: id++, round: r, slot, label: '', p1: null, p2: null, winner: null, scores: null, scoreHistory: null });
            }
            rounds.push(round);
            n = count; r++;
        }
        // Seed the first round from the (already-ordered) field.
        rounds[0].forEach((m, i) => { m.p1 = models[2 * i]; m.p2 = models[2 * i + 1]; });
        // Labels, matching the legacy scheme where it existed.
        rounds.forEach((round) => {
            round.forEach((m, si) => { m.label = this._matchLabel(round.length * 2, si); });
        });
        this.rounds = rounds;
        return rounds.flat();
    }

    // Feed a finished match's winner into its child match in the next round.
    _propagateWinner(match) {
        const next = this.rounds[match.round + 1];
        if (!next) return; // final round has no child
        const child = next[Math.floor(match.slot / 2)];
        if (match.slot % 2 === 0) child.p1 = match.winner;
        else                      child.p2 = match.winner;
    }

    _finalMatch() { return this.rounds.at(-1)[0]; }
    _isFinal(match) { return match.round === this.rounds.length - 1; }

    // Round name by participant count — singular section title.
    // 2→Final, 4→Semi-Finals, 8→Quarter-Finals, 16→Round of 16, 32→Round of 32.
    _roundTitle(participants) {
        if (participants <= 2) return 'Final';
        if (participants === 4) return 'Semi-Finals';
        if (participants === 8) return 'Quarter-Finals';
        return `Round of ${participants}`;
    }

    // Per-match label. Preserves the legacy 8-field labels exactly.
    _matchLabel(participants, slot) {
        if (participants <= 2) return 'Final';
        if (participants === 4) return `Semi-Final ${slot + 1}`;
        if (participants === 8) return `QF — Match ${slot + 1}`;
        return `Round of ${participants} — Match ${slot + 1}`;
    }

    async _runMatch(match) {
        const isFinal = this._isFinal(match);

        // Surface in the bracket panel that THIS match is now the live one
        this._currentMatchIdx = match.id;
        this._renderLiveBracket();

        // Warm this match's local models (concurrent with the intro), then play
        // the shared match intro — the same fighting-game VS reveal solo/watch use,
        // which holds with the "warming" shimmer until the models are resident so
        // cold load never eats a player's turn budget or strands an idle board.
        const warm = this.game._warmMatch([match.p1, match.p2]);
        warm.promise?.then(() => this._renderResidentReadout?.());
        await this.game._showMatchIntro({
            p1: { model: match.p1 },
            p2: { model: match.p2 },
            label: match.label.toUpperCase(),
            note: this._matchNote(match),
            isFinal,
            sound: isFinal ? 'champion' : 'vs',
            minMs: 3500,
            skippable: false,
            warmPromise: warm.promise,
            warmLabel: warm.label,
            mode: 'tournament',
            world: this.world,
            rounds: this.totalRounds,
        });

        // Run game
        this._hideAll();
        // Broadcast flanks: two lockstep carousels frame the board (last bout /
        // dossiers / leaderboard / tournament details / fun facts). Rendered once
        // the board is revealed.
        this._renderMatchFlanks(match);
        this.game.resetForMatch(this.totalRounds, this.world);
        this.game.setAI(1, match.p1);
        this.game.setAI(2, match.p2);
        // Tune player/model colors from identity + ELO anchor, same as solo/watch
        // (_startMatch does this; the tournament path goes through resetForMatch
        // instead, so apply it here once both fighters are assigned).
        await this.game._applyPlayerPalettes();
        // Repaint the bracket panel each round-end so the live card carries fresh scores + round counter
        this.game._onTournamentTick = () => this._renderLiveBracket();
        const promise = this.game.runFullGame();
        this.game.turns.startGame();
        // Match-level safety net. Per-turn watchdogs already keep any single AI turn
        // from hanging; this guards the rare freeze that isn't a turn (a stuck
        // round-end sequence, a wedged simulation) so the bracket always advances.
        // Generous on purpose — it must never fire during a healthy match.
        const guard = this._startMatchTimer();
        const scores = await Promise.race([promise, guard.promise]);
        clearTimeout(guard.id);   // match resolved (or timed out) — cancel the net
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
            mode: 'tournament',
            format: this.format?.label || this.format?.id || null,
            map_size: this.world?.mapSize || null,
            rounds: this.world?.rounds ?? null,
            map_strategy: this.world?.mapStrategy || 'mediated',
            match_uid: this.game.matchUid,
            seed: this.game.seed,
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

        // Tier the celebration to the stakes: a colour class on the card drives
        // the winner-name glow / energy bloom + the combatant-card hues; the
        // overlay aurora retints; reveal/KO sounds play; the big tiers (new #1 /
        // massive upset) get a spark burst. Computed up front so the cards and
        // the verdict word can read from it.
        const resultDrama = this.game._resultDrama?.(res?.result) || { tier: 'win', sound: 'victory', event: null };
        const isUpset = resultDrama.tier === 'upset' || resultDrama.tier === 'massive';
        const isThrone = resultDrama.tier === 'throne';

        // Combatant cards — the fighting-game winner / loser reveal. Reuse the
        // VS-intro player card (avatar + ELO), then layer the victor ribbon on the
        // winner and slam a red KO cross-out + DEFEATED stamp on the loser.
        const winnerSlot = match.winner === match.p1 ? 1 : 2;
        const loserSlot  = winnerSlot === 1 ? 2 : 1;
        const wCard = document.getElementById('t-result-winner-card');
        const lCard = document.getElementById('t-result-loser-card');
        wCard.className = `player-card p${winnerSlot} pc-victor`;
        lCard.className = `player-card p${loserSlot} pc-defeated`;
        document.getElementById('t-result-verdict').textContent = isUpset ? 'UPSETS' : 'DEFEATS';
        await Promise.all([
            this.game._renderPlayerCard?.(wCard, { player: winnerSlot, model: match.winner, clip: 'victory' }),
            this.game._renderPlayerCard?.(lCard, { player: loserSlot,  model: loser, clip: 'defeat' }),
        ]);
        // Stamp the cards (render wiped any prior stamp). The role chips are
        // hidden on this screen (CSS) — the ribbon + KO stamp carry the verdict.
        wCard.querySelector('.pc-victor-tag')?.remove();
        lCard.querySelector('.pc-ko')?.remove();
        const vtag = document.createElement('div');
        vtag.className = 'pc-victor-tag';
        vtag.textContent = isThrone ? '♛ CHAMPION' : '★ WINNER';
        wCard.appendChild(vtag);
        const ko = document.createElement('div');
        ko.className = 'pc-ko';
        ko.innerHTML = '<span class="pc-ko-x"></span><span class="pc-ko-tag">DEFEATED</span>';
        lCard.appendChild(ko);

        // Score rows: proportional fill bar (--fill) + a count-up number. The
        // winner row also gets a one-time sheen sweep (driven by .rs-win in CSS).
        const total = Math.max(1, wScore + lScore);
        const wPct = Math.round(wScore / total * 100);
        const scoresEl = document.getElementById('t-result-scores');
        scoresEl.innerHTML =
            `<div class="rs-row rs-win" style="--fill:${wPct}%"><span class="rs-name">${this._short(match.winner)}</span><span class="rs-score" data-to="${wScore}">0</span></div>
             <div class="rs-row rs-lose" style="--fill:${100 - wPct}%"><span class="rs-name">${this._short(loser)}</span><span class="rs-score" data-to="${lScore}">0</span></div>`;
        document.getElementById('t-result-next').textContent =
            isFinal ? 'Revealing the Champion...' : 'Bracket updating...';

        const resultScreen = document.getElementById('t-match-result');
        resultScreen.classList.remove('t-tier-win', 't-tier-promote', 't-tier-throne', 't-tier-upset', 't-tier-massive');
        resultScreen.classList.add(`t-tier-${resultDrama.tier}`);
        document.body.classList.remove('event-throne', 'event-upset', 'event-promote');
        if (resultDrama.event) document.body.classList.add(resultDrama.event);

        this._show('t-match-result');

        // Sequenced beats so the moment BUILDS instead of arriving all at once:
        //   cards slam → the KO stamp lands (thud) → the winner is crowned
        //   (fanfare + sparks) → the scores tally up.
        this._beat(550,  () => this.game._playSound?.('ko'));
        this._beat(1000, () => {
            this.game._playSound?.(resultDrama.sound);
            if (resultDrama.tier !== 'win') this.game._burstSparks?.(resultScreen, resultDrama.tier);
        });
        this._beat(1300, () =>
            scoresEl.querySelectorAll('.rs-score').forEach(el => this.game._countUp?.(el, Number(el.dataset.to))));

        // Hold on the finished tableau so the win actually lands — longer for the
        // big tiers. (Was 3.2s/4.2s and felt anticlimactic.)
        const bigTier = isThrone || resultDrama.tier === 'massive';
        await this._sleep(bigTier ? 6000 : 4600);

        // Clear the result-screen aurora tint before moving on; the bracket
        // headline callouts re-apply their own tints as they fire.
        document.body.classList.remove('event-throne', 'event-upset', 'event-promote');

        // Move to the bracket, then play ONLY the rare headline moments
        // (NEW CHAMPION / UPSET) as a center callout over it. Promotions/demotions
        // already live in the card, so nothing collides.
        this._renderBracket(match.label + ' complete');
        this._show('t-bracket');
        const drama = this.game._celebrateResult?.(res?.result, { headlinesOnly: true }) || 0;
        if (drama) {
            await this.game._waitForCalloutsDone?.();
            await this._sleep(isFinal ? 800 : 1200);
        } else {
            await this._sleep(isFinal ? 1000 : 2600);
        }
    }

    // Generous match-level timeout. Resolves (never rejects) from the current sim
    // score and detaches the game's resolver so a late game-over can't double-fire.
    // Returns { id, promise } so the caller cancels the timer once the match ends.
    _startMatchTimer() {
        const perTurnCeil = (this.game.aiPlayers?.[1]?.timeoutMs?.() ?? 30_000) + 15_000;
        const ms = this.totalRounds * (perTurnCeil * 2 + 20_000) + 60_000;
        let id;
        const promise = new Promise(resolve => {
            id = setTimeout(() => {
                console.error(`[Tournament] match exceeded ${Math.round(ms / 1000)}s ceiling — resolving from current score`);
                this.game._matchResolve = null; // detach: _showGameOver won't resolve a dead promise
                const s = this.game.simulation?.finalScore?.() || { 1: { finalScore: 0 }, 2: { finalScore: 0 } };
                resolve(s);
            }, ms);
        });
        return { id, promise };
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
        if (this._isFinal(match)) return '🏆 Championship Final';
        const next = this.rounds[match.round + 1];
        return `Winner advances to the ${this._roundTitle(next.length * 2)}`;
    }

    _showChampion(winner) {
        document.getElementById('t-champ-name').textContent = this._short(winner);
        const champAva = document.getElementById('t-champ-avatar');
        if (champAva) { applyAvatarVideo(champAva, winner, { category: 'champion', loop: true }); champAva.classList.add('show'); }
        const wins = this.bracket.filter(m => m.winner === winner);
        const path = wins.map(m => m.label).join(' → ');
        const finalScore = (() => {
            const fm = this._finalMatch();
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

        const finalMatch = this._finalMatch();
        const championDone = !!finalMatch?.winner;

        // Hero = the match that matters right now.
        let heroId;
        if (isLive)              heroId = liveIdx;
        else if (championDone)   heroId = finalMatch.id;
        else if (upNextId !== -1) heroId = upNextId;
        else                     heroId = Math.max(0, this.bracket.findIndex(m => !m.winner));

        const liveScores = (isLive && this.game.simulation) ? this.game.simulation.finalScore() : null;
        const liveRound  = isLive ? this.game.turns?.round : null;

        const hero = championDone && heroId === finalMatch.id
            ? this._lbnChampionHero(finalMatch)
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

    // Progress rail — every match as a node, with a gap between rounds
    // (e.g. QF·QF·QF·QF — SF·SF — ★Final). Scales to any bracket size.
    _lbnRail(liveIdx, upNextId, done) {
        const node = (m) => {
            let st = 'pending';
            if (m.winner)             st = 'done';
            else if (m.id === liveIdx) st = 'live';
            else if (m.id === upNextId) st = 'upnext';
            const final = this._isFinal(m) ? ' lbn-node--final' : '';
            return `<span class="lbn-node lbn-node--${st}${final}"></span>`;
        };
        let nodes = '';
        let prevRound = 0;
        for (const m of this.bracket) {
            if (m.round !== prevRound) { nodes += `<span class="lbn-rail-gap"></span>`; prevRound = m.round; }
            nodes += node(m);
        }
        return `<div class="lbn-rail">
            <div class="lbn-rail-nodes">${nodes}</div>
            <span class="lbn-rail-count">${done} / ${this.bracket.length}</span>
        </div>`;
    }

    // Refresh the cached "what's loaded in Ollama" snapshot and repaint the stats
    // panel if it's open. Called after each warm/unload so the readout stays live.
    async _renderResidentReadout() {
        this._residentSnapshot = await listResidentModels();
        if (this._statsOpen) this._renderStats();
    }

    // Compact readout of models currently resident in Ollama + total VRAM — so
    // "how much RAM is in use, and is it valid?" is answerable at a glance.
    _residentReadoutHtml() {
        const models = this._residentSnapshot;
        if (!models) return '';
        if (models.length === 0) {
            return `<div class="tsp-section-title" style="margin-top:14px;">Resident Models</div>
                    <div class="tsp-empty">None loaded</div>`;
        }
        const totalVram = models.reduce((s, m) => s + (m.size_vram || m.size || 0), 0);
        const gb = b => (b / 1073741824).toFixed(1) + ' GB';
        const rows = models.map(m =>
            `<div class="tsp-match-row"><span class="tsp-name">${this._short(m.name)}</span>
             <span class="tsp-bar-score">${gb(m.size_vram || m.size || 0)}</span></div>`).join('');
        return `<div class="tsp-section-title" style="margin-top:14px;">Resident Models · ${gb(totalVram)} VRAM</div>${rows}`;
    }

    _renderStats() {
        const content = document.getElementById('tsp-content');
        if (!content) return;

        const completed = this.bracket ? this.bracket.filter(m => m.winner) : [];

        let html = '';

        // Bracket summary
        html += `<div class="tsp-section-title">Bracket</div>`;
        if (this.bracket) {
            for (const round of this.rounds) {
                html += `<div class="tsp-bracket-section">${this._roundTitle(round.length * 2)}</div>`;
                for (const m of round) {
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

        // Resident-models readout (what Ollama is holding in VRAM right now)
        html += this._residentReadoutHtml();

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

    // One round's column. `matches` is already in pairing order; pairs draw the
    // connector spine. `seed` suppresses the incoming stub (opening round);
    // `mirror` flips every connector to point toward the centre (right half).
    _bracketColumn(matches, titleParticipants, { seed = false, mirror = false } = {}, ctx) {
        const cell = (m) => `<div class="bt-cell">${this._bracketCard(m, ctx)}</div>`;
        let body = '';
        if (matches.length === 1) {
            body = `<div class="bt-pair bt-pair--solo">${cell(matches[0])}</div>`;
        } else {
            for (let i = 0; i < matches.length; i += 2) {
                body += `<div class="bt-pair">${cell(matches[i])}${cell(matches[i + 1])}</div>`;
            }
        }
        const cls = ['bt-round'];
        if (seed) cls.push('bt-round--seed');
        if (mirror) cls.push('bt-round--mirror');
        return `<div class="${cls.join(' ')}">
            <div class="bt-round-label">${this._roundTitle(titleParticipants)}</div>
            <div class="bt-round-body">${body}</div>
        </div>`;
    }

    _renderBracketInto(grid) {
        if (!grid || !this.rounds) return;

        const upNextId = this.bracket.findIndex((m, i) =>
            !m.winner && i !== this._currentMatchIdx && m.p1 && m.p2);
        const liveScores = (this._currentMatchIdx != null && this.game.simulation)
            ? this.game.simulation.finalScore() : null;
        const liveRound = this._currentMatchIdx != null ? this.game.turns?.round : null;
        const ctx = { upNextId, liveScores, liveRound };

        // Mirrored two-sided draw: every round splits in half — the top half of
        // each round flows left→centre, the bottom half flows right→centre — and
        // the two converge on the Final + Champion in the middle. This halves the
        // opening column's height (8 matches/side, not 16) and fills the screen
        // width instead of leaving the right half empty.
        const rounds = this.rounds;
        const lastIdx = rounds.length - 1;
        const finalMatch = rounds[lastIdx][0];
        const inner = rounds.slice(0, lastIdx);   // every round except the Final

        const left = inner.map((round, ri) => {
            const half = round.slice(0, round.length / 2);
            return this._bracketColumn(half, round.length * 2, { seed: ri === 0 }, ctx);
        }).join('');

        // Right half mirrors the left: bottom half of each round, ordered
        // centre→outward (Semis nearest the Final, opening round on the rim).
        const right = inner.map((round, ri) => {
            const half = round.slice(round.length / 2);
            return this._bracketColumn(half, round.length * 2, { seed: ri === 0, mirror: true }, ctx);
        }).reverse().join('');

        const center = `<div class="bt-round bt-round--center">
            <div class="bt-round-label">Final</div>
            <div class="bt-round-body bt-center-body">
                <div class="bt-cell bt-cell--final">${this._bracketCard(finalMatch, ctx)}</div>
                <div class="bt-champ-wrap">${this._championNode()}</div>
            </div>
        </div>`;

        grid.innerHTML = `<div class="bt-stage">
            ${this._bracketStatbar()}
            <div class="bracket-tree bracket-tree--mirror bracket-tree--rounds-${this.rounds.length}">${left}${center}${right}</div>
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
        const fin = this._finalMatch();
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

        const fieldSize = this.rounds[0].length * 2;
        const fmtLabel = this.format?.label ? `${this.format.label} · ` : '';
        return `<div class="bt-statbar">
            <div class="bt-stat">
                <span class="bt-stat-k">Field</span>
                <span class="bt-stat-v">${fieldSize} models · ${fmtLabel}${modeLabel} · ${this.totalRounds} rounds</span>
            </div>
            <div class="bt-stat">
                <span class="bt-stat-k">Progress</span>
                <span class="bt-stat-v">${done} / ${this.bracket.length} matches</span>
            </div>
            ${topSeedChip}
            ${upsetChip}
        </div>`;
    }

    // ── Overlay control ─────────────────────────────────────────

    _show(screenId) {
        // Any full-screen tournament screen (intro / result / bracket / champion)
        // covers the board, so retire the live broadcast flanks while it's up.
        this._hideMatchFlanks();
        const overlay = document.getElementById('tournament-overlay');
        overlay.classList.remove('t-hidden');
        overlay.querySelectorAll('.t-screen').forEach(s => s.classList.add('t-hidden'));
        document.getElementById('t-bracket')?.classList.remove('t-bracket-manual');
        document.getElementById(screenId)?.classList.remove('t-hidden');
    }

    _hideAll() {
        document.getElementById('tournament-overlay')?.classList.add('t-hidden');
        // _runMatch re-renders the flanks right after revealing the board; every
        // other caller (champion close, back-to-game) wants them gone.
        if (!this.running || this._currentMatchIdx == null) this._hideMatchFlanks();
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

    // ── Live broadcast flanks (rotating carousels) ──────────────
    // Two corner panels frame the board during a live match like a fight-night
    // broadcast. Each is a BroadcastCarousel that card-flips through a sequence of
    // panels every 10s. Both flanks start together on the same interval, so they
    // advance in lockstep — the LEFT/RIGHT panel sharing an index form one "slide":
    //   Slide 1: Last Bout (or Tournament Details to open a fresh match) → Head-to-Head
    //   Slide 2: Fighter Dossier P1 → Fighter Dossier P2
    //   Slide 3: Hall of Champions (leaderboard) → Tournament Details
    //   Slide 4: On Deck (next matchup) → Scouting Report (its contestants' storylines)
    //   Slide 5+: randomized around-the-league fun-fact cards (distinct per side)
    // The On Deck slide is dropped (both sides) when nothing's queued — e.g. the
    // final — and the pattern then loops for the length of the match.
    // Stat-driven panels read from a single /stats/dashboard snapshot fetched per
    // match; the opening panels (Last Bout / Head-to-Head) need only local bracket
    // data, so they paint instantly while the snapshot loads.

    _renderMatchFlanks(liveMatch) {
        const liveIdx = liveMatch.id;   // match.id === flat bracket index

        // Previous = the most recent completed bout before this one. Drives the
        // opening left slide; absent (start of the tournament) we open on details.
        let prev = null;
        for (let i = liveIdx - 1; i >= 0; i--) {
            if (this.bracket[i].winner) { prev = this.bracket[i]; break; }
        }
        // On deck = the next match that already has both fighters seeded and
        // hasn't been played. (A cross-round match whose entrant this bout decides
        // isn't shown until propagation fills it.) Feeds the On Deck / Scouting
        // Report slide — omitted entirely when nothing's queued (e.g. the final).
        let next = null;
        for (let i = liveIdx + 1; i < this.bracket.length; i++) {
            const m = this.bracket[i];
            if (m.p1 && m.p2 && !m.winner) { next = m; break; }
        }

        const p1 = liveMatch.p1, p2 = liveMatch.p2;
        if (!this._showFlankShells()) return;

        // Fresh shuffle bag so each match deals a new random fun-fact order.
        this._funBag = null;

        // Lockstep slides: leftPanels[i] and rightPanels[i] flip together. The On
        // Deck / Scouting slide is inserted into BOTH sides or neither, so the two
        // columns stay index-aligned whether or not a next match is queued.
        const leftPanels = [
            { id: 'open1', render: () => prev ? this._bcLastBout(prev) : this._bcTournamentDetails(liveMatch) },
            { id: 'dossier1', render: () => this._bcDossier(p1, p2) },
            { id: 'champions', render: () => this._bcChampions() },
            ...(next ? [{ id: 'onDeck', render: () => this._bcOnDeck(next) }] : []),
            { id: 'funL1', render: () => this._bcHighlight(this._nextFunHighlight()) },
            { id: 'funL2', render: () => this._bcHighlight(this._nextFunHighlight()) },
        ];

        const rightPanels = [
            { id: 'h2h', render: () => this._bcHeadToHead(p1, p2) },
            { id: 'dossier2', render: () => this._bcDossier(p2, p1) },
            { id: 'tourney', render: () => this._bcTournamentDetails(liveMatch) },
            ...(next ? [{ id: 'scout', render: () => this._bcScout(next.p1, next.p2, 'next up') }] : []),
            { id: 'funR1', render: () => this._bcHighlight(this._nextFunHighlight()) },
            { id: 'funR2', render: () => this._bcHighlight(this._nextFunHighlight()) },
        ];

        this._leftCarousel.start(leftPanels);
        this._rightCarousel.start(rightPanels);

        // Pull the shared stats snapshot; later rotations read it once it lands.
        this._loadBroadcastData();
    }

    // Ensure both flank carousels exist and slide their shells back into view
    // (shared by the tournament and watch entry points). Returns false if the
    // host elements are missing.
    _showFlankShells() {
        const leftEl  = document.getElementById('match-flank-prev');
        const rightEl = document.getElementById('match-flank-next');
        if (!leftEl || !rightEl) return false;
        this._leftCarousel  ||= new BroadcastCarousel(leftEl);
        this._rightCarousel ||= new BroadcastCarousel(rightEl);
        for (const el of [leftEl, rightEl]) {
            el.classList.remove('mf-hidden');
            el.setAttribute('aria-hidden', 'false');
            el.classList.remove('mf-enter-anim');
            void el.offsetWidth;
            el.classList.add('mf-enter-anim');
        }
        return true;
    }

    // Public entry: drive the broadcast flanks for a single (non-tournament)
    // watch match. Reuses the tournament carousel renderers with a bracket-free
    // slide set, flipping both flanks in lockstep just like tournament mode:
    //   Slide 1: Scouting Report (these two) → Head-to-Head
    //   Slide 2: Fighter Dossier P1 → Fighter Dossier P2
    //   Slide 3: Hall of Champions → Match Details
    //   Slide 4+: randomized around-the-league fun-fact cards
    showWatchFlanks(p1, p2, world = {}, mode = 'watch') {
        if (!p1 || !p2 || !this._showFlankShells()) return;
        this._funBag = null;

        const leftPanels = [
            { id: 'scout', render: () => this._bcScout(p1, p2, 'tale of the tape') },
            { id: 'dossier1', render: () => this._bcDossier(p1, p2) },
            { id: 'champions', render: () => this._bcChampions() },
            { id: 'funL1', render: () => this._bcHighlight(this._nextFunHighlight()) },
            { id: 'funL2', render: () => this._bcHighlight(this._nextFunHighlight()) },
        ];
        const rightPanels = [
            { id: 'h2h', render: () => this._bcHeadToHead(p1, p2) },
            { id: 'dossier2', render: () => this._bcDossier(p2, p1) },
            { id: 'details', render: () => this._bcMatchDetails(world, mode) },
            { id: 'funR1', render: () => this._bcHighlight(this._nextFunHighlight()) },
            { id: 'funR2', render: () => this._bcHighlight(this._nextFunHighlight()) },
        ];

        this._leftCarousel.start(leftPanels);
        this._rightCarousel.start(rightPanels);
        this._loadBroadcastData();
    }

    // One /stats/dashboard fetch feeds every stat panel (leaderboard, timeline,
    // head-to-head, highlights). Re-fetched each match so standings stay current.
    async _loadBroadcastData() {
        try {
            const r = await fetch('/stats/dashboard', { cache: 'no-store' });
            this._bcData = r.ok ? await r.json() : null;
        } catch (_) { this._bcData = null; }
    }

    _hideMatchFlanks() {
        this._leftCarousel?.stop();
        this._rightCarousel?.stop();
        for (const id of ['match-flank-prev', 'match-flank-next']) {
            const el = document.getElementById(id);
            if (!el) continue;
            el.classList.add('mf-hidden');
            el.setAttribute('aria-hidden', 'true');
        }
    }

    // ── Carousel panel renderers — each returns { html, paint? } ──

    _initials(model) {
        return this.game?._modelInitials
            ? this.game._modelInitials(model)
            : this._short(model).slice(0, 2).toUpperCase();
    }

    _bcLoading(title) {
        return { html: `<div class="mf-head"><span class="mf-tag">${title}</span></div><div class="mf-empty">Gathering standings…</div>` };
    }

    // Leaderboard helpers — match on the stored model name, falling back to the
    // short (normalized) form so version/suffix differences still resolve.
    _bcLeaderboard() { return this._bcData?.leaderboard || []; }
    _bcEntry(model) {
        if (!model) return null;
        const lb = this._bcLeaderboard();
        const n = this._short(model);
        return lb.find(e => e.model === model) || lb.find(e => this._short(e.model) === n) || null;
    }
    _bcTimeline(model) {
        const tl = this._bcData?.timeline || {};
        if (tl[model]) return tl[model];
        const n = this._short(model);
        const key = Object.keys(tl).find(k => this._short(k) === n);
        return key ? tl[key] : [];
    }
    _bcH2H(a, b) {
        const arr = this._bcData?.head_to_head || [];
        const na = this._short(a), nb = this._short(b);
        for (const h of arr) {
            const ha = this._short(h.a), hb = this._short(h.b);
            if (ha === na && hb === nb) return { for: h.a_wins, against: h.b_wins, games: h.games };
            if (ha === nb && hb === na) return { for: h.b_wins, against: h.a_wins, games: h.games };
        }
        return null;
    }

    _bcLastBout(prev) {
        return { html: this._flankPrevHtml(prev), paint: (root) => { this._paintFlankVideos(root, true); this._paintFlankRanks(root); } };
    }

    _bcOnDeck(next) {
        return { html: this._flankNextHtml(next), paint: (root) => { this._paintFlankVideos(root, false); this._paintFlankRanks(root); } };
    }

    // Tournament Details — the bracket at a glance: current stage, field size,
    // where we are in the round, and overall completion. Opens a fresh match (when
    // there's no last bout yet) and anchors the right flank's third slide.
    _bcTournamentDetails(liveMatch) {
        const modeLabel = this.mode === 'lightning' ? 'Lightning' : 'Standard';
        const field = (this.rounds?.[0]?.length || 0) * 2;
        const roundMatches = this.rounds?.[liveMatch?.round] || [];
        const roundTitle = this._roundTitle(roundMatches.length * 2 || field);
        const inRound = roundMatches.findIndex(m => m.id === liveMatch?.id) + 1;
        const done = this.bracket.filter(m => m.winner).length;
        const total = this.bracket.length;
        const pct = total ? Math.round((done / total) * 100) : 0;
        const html = `
            <div class="mf-head"><span class="mf-tag mf-tag-tourney">🏟 TOURNAMENT</span><span class="mf-sub">${modeLabel} Bracket</span></div>
            <div class="bct-stage">${roundTitle}</div>
            <div class="bcd-grid">
                <div class="bcd-cell"><span class="bcd-k">FIELD</span><span class="bcd-v">${field || '—'}</span></div>
                <div class="bcd-cell"><span class="bcd-k">MATCH</span><span class="bcd-v">${inRound > 0 ? inRound : '—'}/${roundMatches.length || '—'}</span></div>
                <div class="bcd-cell"><span class="bcd-k">ROUNDS</span><span class="bcd-v">${this.totalRounds}</span></div>
                <div class="bcd-cell"><span class="bcd-k">BOUTS</span><span class="bcd-v">${done}/${total}</span></div>
            </div>
            <div class="bct-prog"><span style="width:${pct}%"></span></div>
            <div class="bct-foot">${pct}% of the bracket decided</div>`;
        return { html };
    }

    _cap(s) { return s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : ''; }

    // Match Details — the watch-mode counterpart to Tournament Details: format,
    // round count, board size, and map strategy for the single bout on screen.
    _bcMatchDetails(world = {}, mode = 'watch') {
        const modeLabel = mode === 'watch' ? 'Watch Match' : 'Exhibition';
        const rounds = world.rounds || CONFIG.GAME.TOTAL_ROUNDS;
        const lightning = rounds <= CONFIG.GAME.LIGHTNING_ROUNDS;
        let grid = '—';
        try { const d = this.game?._resolveWorld?.(world); if (d) grid = `${d.cols}×${d.rows}`; } catch (_) {}
        const sizeName = ({ auto: 'Fit', small: 'Small', medium: 'Medium', large: 'Large', huge: 'Huge' })[world.mapSize]
            || (world.mapSize ? this._cap(world.mapSize) : 'Medium');
        const strat = this._cap(world.mapStrategy || 'mediated');
        const html = `
            <div class="mf-head"><span class="mf-tag mf-tag-details">🎬 MATCH DETAILS</span><span class="mf-sub">${modeLabel}</span></div>
            <div class="bct-stage">${rounds} Rounds${lightning ? ' ⚡' : ''}</div>
            <div class="bcd-grid">
                <div class="bcd-cell"><span class="bcd-k">SIZE</span><span class="bcd-v">${sizeName}</span></div>
                <div class="bcd-cell"><span class="bcd-k">GRID</span><span class="bcd-v">${grid}</span></div>
                <div class="bcd-cell"><span class="bcd-k">MAP</span><span class="bcd-v">${strat}</span></div>
                <div class="bcd-cell"><span class="bcd-k">FORMAT</span><span class="bcd-v">AI·AI</span></div>
            </div>
            <div class="bct-foot">Two models, one ecosystem — best score wins</div>`;
        return { html };
    }

    // Scouting Report — interesting-facts breakdown of two fighters: the analytic
    // partner to the On Deck card (tournament: the NEXT match's contestants) and
    // the watch-match opener (its two models). Surfaces storylines (favorite,
    // rivalry, hot hand, pedigree, tier clash) computed from the live standings.
    // Each angle is null-safe, so it degrades gracefully before the snapshot lands.
    _bcScout(a, b, sub = 'next up') {
        const ea = this._bcEntry(a), eb = this._bcEntry(b);
        const sa = this._statOf(a) || {}, sb = this._statOf(b) || {};
        const eloA = ea?.elo ?? sa.elo, eloB = eb?.elo ?? sb.elo;
        const sA = this._short(a), sB = this._short(b);
        const facts = [];

        // Favorite by ELO expectation (+ the gap worth bridging).
        if (eloA != null && eloB != null) {
            const pA = expectedScore(eloA, eloB);
            const favPct = Math.round(Math.max(pA, 1 - pA) * 100);
            const fav = pA >= 0.5 ? sA : sB;
            facts.push(favPct <= 53
                ? { ic: '⚖️', tx: `Pick'em — dead even on paper` }
                : { ic: '🎯', tx: `<b>${fav}</b> favored at ${favPct}%` });
            const gap = Math.abs(Math.round(eloA - eloB));
            if (gap >= 60) facts.push({ ic: '⚡', tx: `${gap}-pt ELO gap to bridge` });
        }

        // Series history — rivalry or a fresh meeting.
        const h2h = this._bcH2H(a, b);
        if (h2h && h2h.games > 0) {
            if (h2h.for === h2h.against) facts.push({ ic: '🔄', tx: `Even rivalry, ${h2h.for}-${h2h.against} in ${h2h.games}` });
            else {
                const leadName = h2h.for > h2h.against ? sA : sB;
                const hi = Math.max(h2h.for, h2h.against), lo = Math.min(h2h.for, h2h.against);
                facts.push({ ic: '🔁', tx: `<b>${leadName}</b> leads the series ${hi}-${lo}` });
            }
        } else {
            facts.push({ ic: '🆕', tx: `First-ever meeting` });
        }

        // Hottest hand (or coldest, looking to snap a skid).
        const stA = ea?.streak || 0, stB = eb?.streak || 0;
        const hot = Math.abs(stA) >= Math.abs(stB) ? { n: stA, name: sA } : { n: stB, name: sB };
        if (hot.n >= 2) facts.push({ ic: '🔥', tx: `<b>${hot.name}</b> riding W${hot.n}` });
        else if (hot.n <= -2) facts.push({ ic: '❄️', tx: `<b>${hot.name}</b> out to snap L${-hot.n}` });

        // Pedigree — higher career peak.
        const pkA = ea?.peak_elo, pkB = eb?.peak_elo;
        if (pkA != null && pkB != null && Math.round(pkA) !== Math.round(pkB)) {
            const name = pkA > pkB ? sA : sB;
            facts.push({ ic: '👑', tx: `<b>${name}</b> owns the higher peak (${Math.round(Math.max(pkA, pkB))})` });
        }

        // Tier clash — cloud heavyweight vs local challenger.
        if (String(a).includes('cloud') !== String(b).includes('cloud')) {
            facts.push({ ic: '☁️', tx: `Cloud vs Local showdown` });
        }

        const rows = (facts.length ? facts.slice(0, 4) : [{ ic: '⚔', tx: `Two enter — one advances` }])
            .map(f => `<li class="bcs-fact"><span class="bcs-ic">${f.ic}</span><span class="bcs-tx">${f.tx}</span></li>`).join('');
        const html = `
            <div class="mf-head"><span class="mf-tag mf-tag-scout">🔍 SCOUTING REPORT</span><span class="mf-sub">${sub}</span></div>
            <div class="bcs-vs"><b style="--bh:${this._modelHue(a)}">${sA}</b><span class="bcs-x">vs</span><b style="--bh:${this._modelHue(b)}">${sB}</b></div>
            <ul class="bcs-facts">${rows}</ul>`;
        return { html };
    }

    // Hall of Champions — #1 animated over a compact top-5 list.
    _bcChampions() {
        const lb = this._bcLeaderboard();
        if (!lb.length) return this._bcLoading('🏆 Hall of Champions');
        const top = lb.slice(0, 5);
        const champ = top[0];
        const rows = top.slice(1).map(e => `
            <div class="bcc-row">
                <span class="bcc-rank">${e.rank}</span>
                <span class="bcc-ava mf-av" data-model="${e.model}" style="--bh:${this._modelHue(e.model)}">${this._initials(e.model)}</span>
                <span class="bcc-name">${this._short(e.model)}</span>
                <span class="bcc-elo">${Math.round(e.elo)}</span>
                <span class="bcc-wl">${e.wins}-${e.losses}</span>
            </div>`).join('');
        const html = `
            <div class="mf-head"><span class="mf-tag mf-tag-champ">🏆 HALL OF CHAMPIONS</span><span class="mf-sub">${this._bcData?.totals?.models ?? lb.length} models</span></div>
            <div class="bcc-champ">
                <div class="bcc-champ-ava mf-av" data-champ="${champ.model}" style="--bh:${this._modelHue(champ.model)}">${this._initials(champ.model)}</div>
                <div class="bcc-champ-meta">
                    <div class="bcc-champ-name">♛ ${this._short(champ.model)}</div>
                    <div class="bcc-champ-stats"><span class="bcc-champ-elo">${Math.round(champ.elo)}</span><span class="bcc-champ-wl">${champ.wins}-${champ.losses} · ${champ.winrate}%</span></div>
                </div>
            </div>
            <div class="bcc-rows">${rows}</div>`;
        const paint = (root) => {
            const c = root.querySelector('[data-champ]');
            if (c) applyAvatarVideo(c, c.dataset.champ, { category: 'champion', loop: true, bounce: true });
            root.querySelectorAll('.bcc-ava[data-model]').forEach(el => applyAvatar(el, el.dataset.model));
        };
        return { html, paint };
    }

    // Fighter Dossier — animated portrait + stat grid + ELO sparkline + H2H.
    _bcDossier(model, opp) {
        const e = this._bcEntry(model);
        if (!e) return this._bcLoading('📋 Fighter Dossier');
        const tl = this._bcTimeline(model);
        const streak = e.streak || 0;
        const streakTxt = streak > 0 ? `W${streak}` : streak < 0 ? `L${-streak}` : '—';
        const streakCls = streak > 0 ? 'bcd-hot' : streak < 0 ? 'bcd-cold' : '';
        const h2h = this._bcH2H(model, opp);
        const h2hTxt = h2h ? `${h2h.for}–${h2h.against}` : 'first meeting';
        const tier = String(e.model).includes('cloud') ? 'Cloud' : 'Local';
        const html = `
            <div class="mf-head"><span class="mf-tag mf-tag-dossier">📋 FIGHTER DOSSIER</span><span class="mf-sub">#${e.rank}</span></div>
            <div class="bcd-top">
                <div class="bcd-ava mf-av" data-model="${model}" style="--bh:${this._modelHue(model)}">${this._initials(model)}</div>
                <div class="bcd-id">
                    <div class="bcd-name">${this._short(model)}</div>
                    <div class="bcd-sub">${tier} · peak ${Math.round(e.peak_elo)}</div>
                </div>
            </div>
            <div class="bcd-grid">
                <div class="bcd-cell"><span class="bcd-k">ELO</span><span class="bcd-v">${Math.round(e.elo)}</span></div>
                <div class="bcd-cell"><span class="bcd-k">W-L</span><span class="bcd-v">${e.wins}-${e.losses}</span></div>
                <div class="bcd-cell"><span class="bcd-k">WIN%</span><span class="bcd-v">${e.winrate}%</span></div>
                <div class="bcd-cell"><span class="bcd-k">STREAK</span><span class="bcd-v ${streakCls}">${streakTxt}</span></div>
            </div>
            <canvas class="bcd-spark" width="260" height="38"></canvas>
            <div class="bcd-h2h">vs <b>${this._short(opp)}</b><span class="bcd-h2h-rec">${h2hTxt}</span></div>`;
        const paint = (root) => {
            const a = root.querySelector('.bcd-ava[data-model]');
            if (a) applyAvatarVideo(a, model, { category: 'idle', loop: true, bounce: true });
            const cv = root.querySelector('canvas.bcd-spark');
            if (cv) this._drawSparkline(cv, tl.map(p => p.elo), this._modelHue(model));
        };
        return { html, paint };
    }

    // Head-to-Head — the two current fighters and their series record.
    _bcHeadToHead(p1, p2) {
        const h = this._bcH2H(p1, p2);
        const e1 = this._bcEntry(p1), e2 = this._bcEntry(p2);
        const rec = h ? `${h.for}–${h.against}` : '0–0';
        const note = h ? `${h.games} meeting${h.games === 1 ? '' : 's'}` : 'first meeting';
        const side = (model, e) => `
            <div class="bch-side">
                <div class="bch-ava mf-av" data-model="${model}" style="--bh:${this._modelHue(model)}">${this._initials(model)}</div>
                <div class="bch-name">${this._short(model)}</div>
                <div class="bch-elo">${e ? Math.round(e.elo) : '—'}</div>
            </div>`;
        const html = `
            <div class="mf-head"><span class="mf-tag mf-tag-h2h">⚔ HEAD TO HEAD</span><span class="mf-sub">${note}</span></div>
            <div class="bch-row">
                ${side(p1, e1)}
                <div class="bch-mid"><div class="bch-rec">${rec}</div><div class="bch-rec-k">series</div></div>
                ${side(p2, e2)}
            </div>`;
        const paint = (root) => root.querySelectorAll('.bch-ava[data-model]')
            .forEach(el => applyAvatarVideo(el, el.dataset.model, { category: 'idle', loop: true, bounce: true }));
        return { html, paint };
    }

    // Around-the-League fun-fact picker — a shuffle bag over the highlight kinds.
    // Pulls cycle every card before repeating; on drain it reshuffles, guarding
    // the wrap so adjacent pulls (the two flanks sharing a slide, or a loop seam)
    // never land on the same fact.
    _nextFunHighlight() {
        const KINDS = ['biggest_upset', 'most_improved', 'hot_streak', 'peak'];
        if (!this._funBag || !this._funBag.length) {
            const last = this._lastFun;
            do { this._funBag = this._shuffle(KINDS.slice()); }
            while (last && this._funBag[0] === last);
        }
        const kind = this._funBag.shift();
        this._lastFun = kind;
        return kind;
    }

    _shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // Around-the-League highlight cards from the dashboard's highlights feed.
    _bcHighlight(kind) {
        const meta = {
            biggest_upset: { tag: '⚡ BIGGEST UPSET', cls: 'upset' },
            most_improved: { tag: '📈 MOST IMPROVED', cls: 'improved' },
            hot_streak:    { tag: '🔥 HOT STREAK', cls: 'streak' },
            peak:          { tag: '👑 PEAK RATING', cls: 'peak' },
        }[kind];
        const h = this._bcData?.highlights?.[kind];
        if (!h) {
            return { html: `<div class="mf-head"><span class="mf-tag mf-tag-${meta.cls}">${meta.tag}</span></div><div class="mf-empty">No data yet</div>` };
        }
        let big, sub;
        if (kind === 'biggest_upset')      { big = `${Math.round((1 - (h.win_prob ?? 0.5)) * 100)}%`; sub = `${this._short(h.model)} stunned ${this._short(h.opponent)}`; }
        else if (kind === 'most_improved') { big = `+${h.gain}`; sub = `${this._short(h.model)} · ${h.matches} games · ${Math.round(h.elo)} ELO`; }
        else if (kind === 'hot_streak')    { big = `W${h.streak}`; sub = `${this._short(h.model)} · ${Math.round(h.elo)} ELO`; }
        else                               { big = `${Math.round(h.peak_elo)}`; sub = `${this._short(h.model)} · peak rating`; }
        const html = `
            <div class="mf-head"><span class="mf-tag mf-tag-${meta.cls}">${meta.tag}</span></div>
            <div class="bcl bcl-${meta.cls}">
                <div class="bcl-ava mf-av" data-model="${h.model}" style="--bh:${this._modelHue(h.model)}">${this._initials(h.model)}</div>
                <div class="bcl-scrim"></div>
                <div class="bcl-text">
                    <div class="bcl-big">${big}</div>
                    <div class="bcl-sub">${sub}</div>
                </div>
            </div>`;
        const paint = (root) => {
            const a = root.querySelector('.bcl-ava[data-model]');
            if (a) applyAvatarVideo(a, h.model, { category: 'idle', loop: true, bounce: true });
        };
        return { html, paint };
    }

    // Lightweight area sparkline of a model's ELO progression.
    _drawSparkline(canvas, values, hue) {
        const ctx = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height, pad = 3;
        ctx.clearRect(0, 0, W, H);
        const vals = (values || []).filter(v => v != null);
        if (vals.length < 2) {
            ctx.fillStyle = 'rgba(255,255,255,0.3)';
            ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('no rating history yet', W / 2, H / 2 + 3);
            return;
        }
        const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1, n = vals.length;
        const x = i => pad + (i / (n - 1)) * (W - 2 * pad);
        const y = v => H - pad - ((v - min) / span) * (H - 2 * pad);
        ctx.beginPath();
        ctx.moveTo(x(0), y(vals[0]));
        for (let i = 1; i < n; i++) ctx.lineTo(x(i), y(vals[i]));
        ctx.strokeStyle = `hsl(${hue},70%,62%)`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.lineTo(x(n - 1), H - pad); ctx.lineTo(x(0), H - pad); ctx.closePath();
        ctx.fillStyle = `hsla(${hue},70%,55%,0.14)`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x(n - 1), y(vals[n - 1]), 2.4, 0, Math.PI * 2);
        ctx.fillStyle = `hsl(${hue},75%,66%)`;
        ctx.fill();
    }

    // Boxing-style result replay: winner (victory loop) def. loser (defeat loop).
    _flankPrevHtml(m) {
        const winner = m.winner;
        const loser  = m.winner === m.p1 ? m.p2 : m.p1;
        const wScore = (m.winner === m.p1 ? m.scores?.[1] : m.scores?.[2])?.finalScore;
        const lScore = (m.winner === m.p1 ? m.scores?.[2] : m.scores?.[1])?.finalScore;
        const fmt = v => v != null ? v.toLocaleString() : '—';
        return `<div class="mf-head">
                <span class="mf-tag mf-tag-prev">● LAST BOUT</span>
                <span class="mf-sub">${m.label || ''}</span>
            </div>
            <div class="mf-bout">
                <div class="mf-fighter mf-winner">
                    ${this._flankVid(winner)}
                    <div class="mf-fname">${this._short(winner)}</div>
                    <div class="mf-fscore">${fmt(wScore)}</div>
                    <div class="mf-ribbon mf-ribbon-win">★ WINNER</div>
                </div>
                <div class="mf-mid"><span class="mf-def">def.</span></div>
                <div class="mf-fighter mf-loser">
                    ${this._flankVid(loser)}
                    <div class="mf-fname">${this._short(loser)}</div>
                    <div class="mf-fscore">${fmt(lScore)}</div>
                    <div class="mf-ribbon mf-ribbon-ko">DEFEATED</div>
                </div>
            </div>`;
    }

    // ESPN-style on-deck preview: both fighters loop their entrance clip over a
    // tale-of-the-tape stat deck that flips between ELO / record / seed.
    _flankNextHtml(m) {
        const s1 = this._statOf(m.p1) || {};
        const s2 = this._statOf(m.p2) || {};

        // Each card: P1 value · metric · P2 value, with the leader's side lit.
        const card = (i, key, v1, v2, lead) => {
            const l1 = lead === 1 ? ' mf-sc-lead' : '';
            const l2 = lead === 2 ? ' mf-sc-lead' : '';
            return `<div class="mf-statcard" style="--i:${i}">
                <span class="mf-sc-v mf-sc-l${l1}">${v1}</span>
                <span class="mf-sc-k">${key}</span>
                <span class="mf-sc-v mf-sc-r${l2}">${v2}</span>
            </div>`;
        };
        const eloLead    = (s1.elo != null && s2.elo != null) ? (s1.elo > s2.elo ? 1 : s2.elo > s1.elo ? 2 : 0) : 0;
        const recLead    = (s1.wins - s1.losses) === (s2.wins - s2.losses) ? 0 : ((s1.wins - s1.losses) > (s2.wins - s2.losses) ? 1 : 2);
        // Lower seed number is the better seed; missing seeds don't lead.
        const seedLead   = (s1.seed != null && s2.seed != null) ? (s1.seed < s2.seed ? 1 : s2.seed < s1.seed ? 2 : 0) : 0;
        const eloV   = v => v?.elo != null ? Math.round(v.elo) : '—';
        const recV   = v => (v?.wins != null) ? `${v.wins}-${v.losses}` : '—';
        const seedV  = v => v?.seed != null ? `#${v.seed}` : '—';

        const deck = card(0, '⚡ ELO', eloV(s1), eloV(s2), eloLead)
                   + card(1, '📊 RECORD', recV(s1), recV(s2), recLead)
                   + card(2, '🎖 SEED', seedV(s1), seedV(s2), seedLead);

        return `<div class="mf-head">
                <span class="mf-tag mf-tag-next">ON DECK</span>
                <span class="mf-sub">${m.label || ''}</span>
            </div>
            <div class="mf-bout mf-bout-next">
                <div class="mf-fighter mf-enter">
                    ${this._flankVid(m.p1)}
                    <div class="mf-fname">${this._short(m.p1)}</div>
                </div>
                <div class="mf-mid"><span class="mf-vs">VS</span></div>
                <div class="mf-fighter mf-enter">
                    ${this._flankVid(m.p2)}
                    <div class="mf-fname">${this._short(m.p2)}</div>
                </div>
            </div>
            <div class="mf-statdeck">${deck}</div>`;
    }

    // A video portrait cell — carries the model + emotion so _paintFlankVideos
    // can drop in the looping clip after render (still portrait / initials until).
    // The corner rank chip is a placeholder filled async by _paintFlankRanks so
    // the leaderboard standing is showcased right over the fighter's animation.
    _flankVid(model) {
        const ini = this.game?._modelInitials ? this.game._modelInitials(model) : this._short(model).slice(0, 2).toUpperCase();
        const hue = this._modelHue(model);
        // The rank chip is a sibling of (not inside) .mf-vid so it can ride the
        // top edge of the portrait — .mf-vid clips its clip with overflow:hidden,
        // which would otherwise crop a chip lifted above the frame.
        return `<span class="mf-rank mf-rank-pending" data-rank-for="${model}"><span class="mf-rank-num">·</span></span>
            <div class="mf-vid" data-model="${model}" style="--bh:${hue}">
                <span class="mf-vid-ini">${ini}</span>
            </div>`;
    }

    // Paint each flank cell's looping clip: winners/losers get their result
    // emotion, on-deck fighters loop their entrance. Falls back to the still
    // portrait (then brand-hue + initials) when a clip isn't baked.
    _paintFlankVideos(root, isPrev) {
        if (!root) return;
        root.querySelectorAll('.mf-fighter').forEach(f => {
            const cell = f.querySelector('.mf-vid');
            if (!cell || !cell.dataset.model) return;
            let category = 'intro';
            if (isPrev) category = f.classList.contains('mf-winner') ? 'victory' : 'defeat';
            // Ping-pong the clip (forward → back → forward) so the loop never
            // hard-cuts back to frame one.
            applyAvatarVideo(cell, cell.dataset.model, { category, loop: true, bounce: true });
        });
    }

    // Fill each portrait's corner rank chip with the model's live leaderboard
    // standing (global rank + ELO, a crown for #1). Async — fetches rankings then
    // writes, bailing if the panel was re-rendered for a new matchup meanwhile.
    async _paintFlankRanks(root) {
        if (!root) return;
        const badges = [...root.querySelectorAll('.mf-rank[data-rank-for]')];
        await Promise.all(badges.map(async (b) => {
            const model = b.dataset.rankFor;
            const r = await this.game?._fetchRanking?.(model);
            if (!b.isConnected) return;   // panel flipped away before the fetch landed
            b.classList.remove('mf-rank-pending');
            if (!r || r.rank == null) {
                b.classList.add('mf-rank-unranked');
                b.innerHTML = `<span class="mf-rank-num">NR</span>`;
                return;
            }
            if (r.rank === 1) b.classList.add('mf-rank-one');
            const crown = r.rank === 1 ? `<span class="mf-rank-crown">♛</span>` : `<span class="mf-rank-hash">#</span>`;
            const elo = r.elo != null ? `<span class="mf-rank-elo">${Math.round(r.elo)}</span>` : '';
            b.innerHTML = `${crown}<span class="mf-rank-num">${r.rank}</span>${elo}`;
        }));
    }

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // Fire a one-shot effect after `ms` without blocking the run loop — used to
    // sequence the result-reveal beats (KO stamp, crowning, score tally).
    _beat(ms, fn) { setTimeout(() => { try { fn(); } catch (_) {} }, ms); }
}
