// Tournament mode — pits all available models against each other
// Structure: Quarter-Finals (4) → Semi-Finals (2) → Final (1) = 7 matches

import { postResult, fetchRankings, expectedScore } from './rankings.js';
import { CONFIG } from './config.js';
import { resolveModel } from './model-identity.js';
import { applyAvatar, applyAvatarVideo, setAvatarVideoMode } from './model-avatar.js';
import { listResidentModels } from './ai.js';
import { shortId } from './util.js';
import { BroadcastCarousel } from './broadcast-carousel.js';
import { renderBracketTree } from './bracket-tree.js';
import { openTournamentViewer } from './tournament-viewer.js';
import { LivePublisher } from './live-publish.js';
import { setHeartbeatContext, breadcrumbSync } from './heartbeat.js';
import { serializeBoard } from './state-frame.js';

export class TournamentManager {
    constructor(game) {
        this.game = game;
        this.bracket = null;
        this.running = false;
        this.tournamentId = shortId(8);
        this._currentMatchIdx = null; // index in this.bracket of the match inside _runMatch
        this._live = new LivePublisher(); // pushes live feed to the spectator relay
        this._setupStatsToggle();
    }

    _setupStatsToggle() {
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
        // Reopen the mini live-bracket strip while a tournament is still running.
        if (this.running) {
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
        this._renderLiveBracket();

        const modeLabel = mode === 'lightning' ? 'LIGHTNING' : 'STANDARD';
        this._renderBracket(`Tournament begins! [${modeLabel} — ${this.totalRounds} rounds]`);
        this._show('t-bracket');
        await this._sleep(4000);

        // Shed GPU load during live matches: drop avatars to still portraits so
        // the broadcast flanks + AI cards don't run 5–6 concurrent <video> decode
        // + bounce loops on top of the game canvas + board encode. Prime suspect
        // in the mid-match renderer SIGILL (flat JS heap → GPU-side death). The
        // champion screen restores 'full' for the celebration. Dial to 'plain'
        // to keep video but drop only the bounce machinery.
        setAvatarVideoMode('still');
        // Broadcast PARKED pending a rethink. Confirmed: the live-broadcast machinery
        // (per-turn bracket repaint + board-image encode + dual carousels) does heavy
        // synchronous DOM/canvas work on the game's own main thread during live play,
        // and intermittently stalls it — the freeze scatters across all three, so it's
        // architectural, not a single bad line. Off = the game runs clean to a champion;
        // the spectator updates at match boundaries. Re-enable only after the redesign.
        this._broadcastOff = true;

        // Run every match in round-major order; each winner feeds the next round.
        // Works for any power-of-two field (8 / 16 / 32) since the bracket is a
        // generated tree, not a fixed 7-match list.
        for (const match of this.bracket) {
            this._logMatchMemory('start', match);
            await this._runMatch(match);
            this._propagateWinner(match);
            this._logMatchMemory('end', match);
        }

        this._broadcastOff = false;   // matches done — restore the bracket for the champion screen
        setAvatarVideoMode('full');   // matches done — restore full flourish for the champion screen
        this._showChampion(this._finalMatch().winner);
        this.running = false;
        // Final push: flag the feed done so the spectator flips to the
        // standings/last-champion idle state immediately, not after a stale-out.
        this._live.stopBoardLoop();
        this._live.pushSnapshot(this._buildLiveSnapshot({ done: true }));
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

    // Match-boundary memory probe (Chrome-only; performance.memory is gated).
    // Diagnostic for the long-tournament renderer SIGILL: a monotonic climb in
    // usedJSHeapSize across matches points at a JS-heap leak (and the slope says
    // matches-to-OOM); a flat heap while the tab still dies points at GPU/canvas
    // memory instead. Filter the console with `[mem]`. No-op off Chrome.
    _logMatchMemory(phase, match) {
        if (phase === 'start') this._memMatchSeq = (this._memMatchSeq || 0) + 1;
        // Stamp every heartbeat with where we are, so a crash line in
        // heartbeat.log reads "...during match 14 (Semifinal 1), phase=end".
        setHeartbeatContext({
            match: this._memMatchSeq || null,
            matchLabel: match?.label || '',
            matchPhase: phase,
            bracketSize: this.bracket?.length || null,
        });
        const m = performance.memory;
        if (!m) return;
        const MB = (b) => (b / 1048576).toFixed(1);
        const used = +MB(m.usedJSHeapSize);
        const limit = +MB(m.jsHeapSizeLimit);
        const pct = ((m.usedJSHeapSize / m.jsHeapSizeLimit) * 100).toFixed(0);
        const delta = this._memLastUsed != null ? (used - this._memLastUsed).toFixed(1) : '0.0';
        this._memLastUsed = used;
        console.log(
            `[mem] match ${this._memMatchSeq || '?'} ${phase.padEnd(5)} ` +
            `heap ${used}MB / ${limit}MB (${pct}%)  Δ${delta >= 0 ? '+' : ''}${delta}MB  ` +
            `${match?.label || ''}`.trim()
        );
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
        if (!this._broadcastOff) this._renderMatchFlanks(match);   // broadcast valve: skip flank carousels during the test
        this.game.resetForMatch(this.totalRounds, this.world);
        this.game.setAI(1, match.p1);
        this.game.setAI(2, match.p2);
        // Tune player/model colors from identity + ELO anchor, same as solo/watch
        // (_startMatch does this; the tournament path goes through resetForMatch
        // instead, so apply it here once both fighters are assigned).
        await this.game._applyPlayerPalettes();
        // Per-turn tick = the CHEAP async snapshot push only (spectator gets live
        // scores + board-as-state). The heavy local bracket repaint is no longer on
        // the per-turn path — it was the freeze surface — and runs only at match
        // boundaries (the direct _renderLiveBracket calls in _runMatch).
        this.game._onTournamentTick = () => this._pushLiveSnapshot();
        const promise = this.game.runFullGame();
        this.game.turns.startGame();
        // Stream the live board to the spectator relay for the duration of the match.
        if (!this._broadcastOff) this._live.startBoardLoop();   // broadcast valve: skip the board-push loop during the test
        // Match-level safety net. Per-turn watchdogs already keep any single AI turn
        // from hanging; this guards the rare freeze that isn't a turn (a stuck
        // round-end sequence, a wedged simulation) so the bracket always advances.
        // Generous on purpose — it must never fire during a healthy match.
        const guard = this._startMatchTimer();
        const scores = await Promise.race([promise, guard.promise]);
        clearTimeout(guard.id);   // match resolved (or timed out) — cancel the net
        this.game._onTournamentTick = null;
        this._live.stopBoardLoop();

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

        // Snapshot the ELO each model carried INTO this match (plus the post-match
        // rating + rank movement). The server returns this once; we stash it on the
        // match so the end-of-tournament dashboard can show ELO as of match time —
        // it shifts on upsets, so a later /rankings read would not reconstruct it.
        match.eloResult = res?.result || null;

        // Update live bracket — the result is visible while the result-screen overlay is up
        this._currentMatchIdx = null;
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

        // Medals: the win resolves every pending move — winner's → gold (trained),
        // loser's → silver; bronze is win-independent.
        this.game._renderMedalsEarned?.(document.getElementById('t-result-golds'),
            this.game._medalTally?.(winnerSlot));

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
            statsBtn.textContent = '📊 Full Bracket';
            statsBtn.onclick = () => this._openChampionStage();

            const backBtn = document.createElement('button');
            backBtn.className = 'btn t-champ-btn';
            backBtn.textContent = '← Back to Game';
            backBtn.onclick = () => this._hideAll();

            actionsEl.appendChild(statsBtn);
            actionsEl.appendChild(backBtn);
        }

        this._show('t-champion');
    }

    // Open the full tournament stage — the mirrored bracket graphic (the
    // champion's path traced in gold) plus the ELO-progression + per-match detail
    // below — fed this just-finished tournament's live in-memory data.
    async _openChampionStage() {
        if (!this._pStats) { try { await this._loadParticipantStats(); } catch { /* null ELO ok */ } }
        const champion = this._finalMatch()?.winner || null;
        openTournamentViewer(null, {
            highlight: champion,
            dataset: {
                rounds: this.rounds,
                bracket: this.bracket,
                statOf: (m) => this._statOf(m),
                flat: false,
                totalRounds: this.totalRounds,
                modeLabel: this.mode === 'lightning' ? 'Lightning' : 'Standard',
                formatLabel: this.format?.label || '',
                champion,
                fieldSize: this.rounds[0].length * 2,
                date: null,
            },
        });
    }

    // Move clock for the spectator: remaining-at-push so the page can tick it down
    // locally (immune to clock skew between the two machines). Only while the AI
    // whose turn it is is actually on the clock.
    _liveClock(isLive) {
        const mc = this.game._moveClock;
        const cur = this.game.turns?.currentPlayer;
        if (!isLive || !mc || mc.player !== cur) return null;
        return { remainingMs: Math.max(0, mc.deadline - Date.now()), totalMs: mc.totalMs, player: mc.player };
    }

    // Serialize the live bracket state for the spectator relay. Mirrors what
    // _renderLiveBracket computes for local render, but resolves statOf into a
    // plain map (functions don't serialize) and keeps only renderer-read fields.
    _buildLiveSnapshot({ done = false } = {}) {
        if (!this.bracket) return null;
        const liveIdx   = this._currentMatchIdx;
        const isLive    = liveIdx != null && this.bracket[liveIdx] && !this.bracket[liveIdx].winner;
        const liveRaw   = (isLive && this.game.simulation) ? this.game.simulation.finalScore() : null;
        const liveRound = isLive ? (this.game.turns?.round ?? null) : null;
        const slim = (s) => s ? { 1: { finalScore: s[1].finalScore }, 2: { finalScore: s[2].finalScore } } : null;

        const stats = {}, seen = new Set();
        for (const m of this.bracket) {
            for (const p of [m.p1, m.p2, m.winner]) {
                if (p && !seen.has(p)) { seen.add(p); stats[p] = this._statOf(p); }
            }
        }
        const bracket = this.bracket.map(m => ({
            id: m.id, round: m.round, slot: m.slot, label: m.label,
            p1: m.p1, p2: m.p2, winner: m.winner, scores: slim(m.scores),
        }));

        return {
            tournamentId: this.tournamentId,
            bracket,
            rounds: this.rounds.map(r => r.map(m => m.id)),  // round → match ids
            stats,
            currentMatchIdx: isLive ? liveIdx : null,
            liveScores: slim(liveRaw),
            liveRound,
            banter: isLive ? { 1: this.game._liveBanter?.[1] || null, 2: this.game._liveBanter?.[2] || null } : null,
            // Live turn state for the thinking cockpit: which phase, who's deciding,
            // the move clock (remaining-at-push; spectator ticks it down locally),
            // and per-player cold-model "warming up" flags.
            phase: isLive ? (this.game.turns?.phase ?? null) : null,
            currentPlayer: isLive ? (this.game.turns?.currentPlayer ?? null) : null,
            clock: this._liveClock(isLive),
            loading: isLive ? { 1: !!this.game._loadWatch?.[1], 2: !!this.game._loadWatch?.[2] } : null,
            totalRounds: this.totalRounds,
            modeLabel: this.mode === 'lightning' ? 'Lightning' : 'Standard',
            formatLabel: this.format?.label || '',
            champion: this._finalMatch()?.winner || null,
            fieldSize: this.rounds[0].length * 2,
            // Board-as-state: the live board travels in the snapshot so the
            // spectator draws it locally (shared organism-art), replacing the
            // canvas read-back + WebP push. Only while a match is live.
            board: (isLive && this.game?.grid) ? serializeBoard(this.game.grid) : null,
            done,
        };
    }

    // Cheap, async, fire-and-forget snapshot push for the spectator relay — JSON
    // only (bracket + scores + board-as-state), no synchronous DOM repaint and no
    // canvas read-back. This is the safe per-turn broadcast path; the heavy local
    // bracket repaint (_renderLiveBracket) and flank carousels stay parked behind
    // _broadcastOff. Wired to _onTournamentTick. See docs/headless-broadcast-design.md.
    _pushLiveSnapshot() {
        try { this._live.pushSnapshot(this._buildLiveSnapshot()); } catch (_) { /* never break the match */ }
    }

    // Mini bracket = a live-broadcast strip: a hero card (now playing / up next /
    // champion) over a one-line "up next" + a progress rail that collapses the
    // whole 7-match tree into a row of nodes. Tap the header ⛶ to zoom to full.
    _renderLiveBracket() {
        if (!this.bracket) return;
        // Broadcast valve: during live matches, skip the live-bracket repaint +
        // spectator relay entirely. Two separate freezes localized here (the
        // innerHTML repaint and the snapshot push) with no infinite loop in the JS
        // — i.e. a pathological synchronous reflow of the heavy broadcast DOM. This
        // silences it during play to confirm the subsystem; the bracket still
        // renders at match boundaries (when _broadcastOff is cleared). Reversible.
        if (this._broadcastOff) return;
        breadcrumbSync('lbn.start', { idx: this._currentMatchIdx });

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

        // Mirror this repaint to the spectator relay — piggybacks on every bracket
        // change (match start, round-end, match end, champion), so the public feed
        // updates at exactly the moments the local bracket does.
        breadcrumbSync('lbn.snap', {});
        this._live.pushSnapshot(this._buildLiveSnapshot());
        breadcrumbSync('lbn.done', {});
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

    // Refresh the cached "what's loaded in Ollama" snapshot. Called after each
    // warm/unload so any future readout has a current view of VRAM residency.
    async _renderResidentReadout() {
        this._residentSnapshot = await listResidentModels();
    }

    // ── Bracket display ─────────────────────────────────────────

    _renderBracket(statusText) {
        document.getElementById('t-bracket-status').textContent = statusText;
        this._renderBracketInto(document.getElementById('bracket-grid'));
    }

    // Delegates to the shared bracket-tree renderer with live context — the same
    // graphic the championship screen and historical viewer use.
    _renderBracketInto(grid) {
        if (!grid || !this.rounds) return;
        const liveScores = (this._currentMatchIdx != null && this.game.simulation)
            ? this.game.simulation.finalScore() : null;
        const liveRound = this._currentMatchIdx != null ? this.game.turns?.round : null;
        renderBracketTree(grid, {
            rounds: this.rounds,
            bracket: this.bracket,
            statOf: (m) => this._statOf(m),
            currentMatchIdx: this._currentMatchIdx,
            liveScores,
            liveRound,
            totalRounds: this.totalRounds,
            modeLabel: this.mode === 'lightning' ? 'Lightning' : 'Standard',
            formatLabel: this.format?.label || '',
            initials: this.game?._modelInitials ? (m) => this.game._modelInitials(m) : null,
        });
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

    // ── Tournament-narrative helpers — bracket-level storylines the per-fighter
    // panels don't cover. All null-safe: degrade quietly before seeds/scores land.

    // Every competitor in the opening round.
    _fieldModels() {
        const out = [];
        for (const m of (this.rounds?.[0] || [])) { out.push(m.p1, m.p2); }
        return out.filter(Boolean);
    }

    // Models knocked out — the loser of each completed bout.
    _tEliminated() {
        const out = new Set();
        for (const m of this.bracket) {
            if (m.winner) out.add(m.winner === m.p1 ? m.p2 : m.p1);
        }
        return out;
    }

    // Highest-ELO model still alive (optionally restricted to a pool, e.g. the two
    // finalists). Pre-tournament this is the top seed; it re-points as seeds fall.
    _tFavorite(pool = null) {
        const elim = this._tEliminated();
        let best = null;
        for (const model of (pool || this._fieldModels())) {
            if (!model || elim.has(model)) continue;
            const st = this._statOf(model);
            if (st?.elo == null) continue;
            if (!best || st.elo > best.elo) best = { model, elo: st.elo };
        }
        return best;
    }

    // Chalk vs chaos — completed bouts where the higher seed (lower seed-number)
    // held, vs where the underdog sprung an upset.
    _tMomentum() {
        let chalk = 0, chaos = 0;
        for (const m of this.bracket) {
            if (!m.winner) continue;
            const ws = this._statOf(m.winner)?.seed;
            const ls = this._statOf(m.winner === m.p1 ? m.p2 : m.p1)?.seed;
            if (ws == null || ls == null) continue;
            if (ws < ls) chalk++; else chaos++;
        }
        return { chalk, chaos };
    }

    // The standout bout of THIS tournament: the biggest upset (lowest winner
    // win-prob) if there's been one, else the closest margin. Returns markup/null.
    _tBestBout() {
        let upset = null, closest = null;
        for (const m of this.bracket) {
            if (!m.winner || !m.scores) continue;
            const loser = m.winner === m.p1 ? m.p2 : m.p1;
            const wScore = (m.winner === m.p1 ? m.scores[1] : m.scores[2])?.finalScore;
            const lScore = (m.winner === m.p1 ? m.scores[2] : m.scores[1])?.finalScore;
            if (wScore == null || lScore == null) continue;
            const margin = Math.abs(wScore - lScore);
            if (!closest || margin < closest.margin) closest = { margin, winner: m.winner, loser };
            const wStat = this._statOf(m.winner), lStat = this._statOf(loser);
            if (wStat?.elo != null && lStat?.elo != null) {
                const wp = expectedScore(wStat.elo, lStat.elo);
                if (wp < 0.5 && (!upset || wp < upset.wp)) upset = { wp, winner: m.winner, loser };
            }
        }
        if (upset) return `<b>${this._short(upset.winner)}</b> stunned ${this._short(upset.loser)} · ${Math.round((1 - upset.wp) * 100)}%`;
        if (closest) return `<b>${this._short(closest.winner)}</b> edged ${this._short(closest.loser)} by ${Math.round(closest.margin)}`;
        return null;
    }

    // Tournament Details — the bracket's story at a glance. Anchors the right
    // flank's third slide and opens a fresh match (when there's no last bout yet).
    // Beyond the raw bracket status it carries tournament-level narrative the
    // per-fighter panels don't: who's projected to lift the cup, chalk-vs-chaos
    // momentum, and the standout bout so far. Progress-aware — the headline and
    // foot swap as the bracket fills, so it never sits on an empty 0% state.
    _bcTournamentDetails(liveMatch) {
        const modeLabel = this.mode === 'lightning' ? 'Lightning' : 'Standard';
        const field = (this.rounds?.[0]?.length || 0) * 2;
        const roundMatches = this.rounds?.[liveMatch?.round] || [];
        const roundParticipants = roundMatches.length * 2 || field;
        const roundTitle = this._roundTitle(roundParticipants);
        const inRound = roundMatches.findIndex(m => m.id === liveMatch?.id) + 1;
        const done = this.bracket.filter(m => m.winner).length;
        const total = this.bracket.length;
        const pct = total ? Math.round((done / total) * 100) : 0;
        const isFinal = roundParticipants <= 2;

        // Projected cup-holder. At the final it's the favoured finalist; otherwise
        // the highest-ELO model still standing.
        const fav = isFinal && liveMatch?.p1 && liveMatch?.p2
            ? this._tFavorite([liveMatch.p1, liveMatch.p2])
            : this._tFavorite();
        let favCard = '';
        if (fav) {
            const label = isFinal ? '🏁 PROJECTED CHAMPION' : (done === 0 ? '👑 FAVORITE' : '👑 FAVORITE REMAINING');
            const sub = isFinal ? 'favoured to take the crown'
                : done === 0 ? 'projected to lift the cup' : 'still favoured to win it all';
            favCard = `<div class="bct-fav" style="--bh:${this._modelHue(fav.model)}">
                <span class="bct-fav-k">${label}</span>
                <span class="bct-fav-v">${this._short(fav.model)}<span class="bct-fav-elo">${Math.round(fav.elo)}</span></span>
                <span class="bct-fav-sub">${sub}</span>
            </div>`;
        }

        // Foot narrative: momentum + standout bout. Pre-tournament we coach the
        // reader rather than show an empty result.
        let footZone;
        if (done === 0) {
            footZone = `<div class="bct-best">⚡ Best bout — none played yet</div>`;
        } else {
            const mom = this._tMomentum();
            const best = this._tBestBout();
            const momLine = (mom.chalk || mom.chaos)
                ? `<div class="bct-mom">⚖ Chalk ${mom.chalk} · Chaos ${mom.chaos}</div>` : '';
            const bestLine = best ? `<div class="bct-best">⚡ ${best}</div>` : '';
            footZone = momLine + bestLine;
        }

        const html = `
            <div class="mf-head"><span class="mf-tag mf-tag-tourney">🏟 TOURNAMENT</span><span class="mf-sub">${modeLabel} Bracket</span></div>
            <div class="bct-stage">${roundTitle}</div>
            ${favCard}
            <div class="bcd-grid bcd-grid-3">
                <div class="bcd-cell"><span class="bcd-k">FIELD</span><span class="bcd-v">${field || '—'}</span></div>
                <div class="bcd-cell"><span class="bcd-k">MATCH</span><span class="bcd-v">${inRound > 0 ? inRound : '—'}/${roundMatches.length || '—'}</span></div>
                <div class="bcd-cell"><span class="bcd-k">BOUTS</span><span class="bcd-v">${done}/${total}</span></div>
            </div>
            <div class="bct-prog"><span style="width:${pct}%"></span></div>
            <div class="bct-foot">${pct}% of the bracket decided</div>
            ${footZone}`;
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
