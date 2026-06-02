// Tournament mode — pits all available models against each other
// Structure: Quarter-Finals (4) → Semi-Finals (2) → Final (1) = 7 matches

import { postResult, renderOddsInto, fetchRankings, expectedScore } from './rankings.js';
import { CONFIG } from './config.js';
import { resolveModel } from './model-identity.js';
import { applyAvatar } from './model-avatar.js';
import { prepareResidentSet, isCloudModel, listResidentModels } from './ai.js';

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
        // Intro screen — fighting-game VS reveal: both fighters' cards slam in with
        // their cyber-organic portraits, the final gets a grander gold treatment.
        const isFinal = this._isFinal(match);
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

        // Warm this match's local models BEFORE the game clock starts, so cold
        // load (which can far exceed the 3.5s intro) never eats a player's turn
        // budget. Runs concurrently with the intro animation; we wait for the
        // longer of the two. Cloud models are no-ops inside prepareResidentSet.
        const noteEl = document.getElementById('t-intro-note');
        const realNote = noteEl ? noteEl.textContent : '';
        const localPlayers = [match.p1, match.p2].some(m => m && !isCloudModel(m));
        const prep = prepareResidentSet([match.p1, match.p2])
            .then(r => {
                // Charge complete — drop the powering-up effect and restore the note.
                introScreen.classList.remove('t-warming');
                if (noteEl) noteEl.textContent = realNote;
                this._renderResidentReadout?.();
                return r;
            });
        if (localPlayers) {
            // Fighters "power up" while their models load — runs only as long as
            // the warm actually takes (removed in prep's .then above).
            introScreen.classList.add('t-warming');
            if (noteEl) noteEl.textContent = 'Warming models…';
        }
        await Promise.all([this._sleep(3500), prep]);

        // Run game
        this._hideAll();
        this.game.resetForMatch(this.totalRounds, this.world);
        this.game.setAI(1, match.p1);
        this.game.setAI(2, match.p2);
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
            this.game._renderPlayerCard?.(wCard, { player: winnerSlot, model: match.winner }),
            this.game._renderPlayerCard?.(lCard, { player: loserSlot,  model: loser }),
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

    // Fire a one-shot effect after `ms` without blocking the run loop — used to
    // sequence the result-reveal beats (KO stamp, crowning, score tally).
    _beat(ms, fn) { setTimeout(() => { try { fn(); } catch (_) {} }, ms); }
}
