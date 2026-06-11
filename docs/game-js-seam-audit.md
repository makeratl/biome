# `game.js` engine/view seam audit

Sizes the `MatchRunner` extraction in [headless-broadcast-design.md](headless-broadcast-design.md).
Full read of `js/game.js` (5059 lines, ~194 methods, one `Game` class).

## Summary

| Class | Count | ~Line share |
|---|---|---|
| **VIEW** (DOM/canvas/anim/sound/broadcast) | ~138 | ~67% |
| **ENGINE** (turn/AI/sim/scoring/ELO, DOM-free) | ~30 | ~12% |
| **MIXED** (engine entangled with view) | ~26 | ~21% |

The engine surface is small (~30 methods); the entanglement concentrates in **~9 hot
methods**, not smeared across the file. The freeze lives in the MIXED match-loop spine.

**Effort buckets:**
- **Verbatim lifts** (~28 methods, near-zero risk) — already DOM-free.
- **Peel engine lines** (~8 methods, low risk) — engine core is 3–5 lines amid view.
- **Seam rewrites** (~9 methods) — 90% of the effort and *all* the freeze-fix value.

## MatchRunner core (call-flow order)

`resetForMatch`(4930) → `_buildBoardCore`(4908) → `_resetMatchState`(4916) →
`_describeMatch`(4110) → `runFullGame`(4986) → `setAI`(2893) →
`_syncFighterContext`(4127)/`_buildFighterDescriptor`(4082)/`_fetchRanking`(4138) →
`turns.startGame()` → **`_onPhaseChange`(1073)** [hub] → **`_runAITurn`(2560)** →
`_teardownAITurn`(2730) [`turns.endTurn()`] → **`_runSimulation`(1256)**
[`simulation.step()` ×N] → `_captureRound`(1282) → ROUND_END
**`_runRoundEndSequence`(1155)** [`turns.nextRound()`] → GAME_OVER
`_showGameOver`(2399) [`_matchResolve(scores)` early-return 2402–2408] →
`_recordCasualResult`(3917) [ELO post].

> The tournament path's **`_matchResolve` early return at 2403–2408** hands scores back
> *before* any result-screen DOM — proof the seam exists and is partly scaffolded. The
> `_onTournamentTick?.()` hook (1118, 1131, 1152, 2661, 2773, 2816, 2832) plus
> `_liveBanter`/`_moveClock` are the existing proto-emit; the StateFrame bus generalizes them.

## Hard entanglements — engine progression blocks on view (the freeze surface)

These are the points where the engine `await`s a render/overlay/sleep, or reads layout.
Breaking 1–4 is the bulk of the freeze fix.

1. **`_runRoundEndSequence`(1155–1175)** — `turns.nextRound()`(1174) only after `await`
   callouts(1159) + recap(1163) + transition(1168). **Round can't advance until ~8–10 s
   of animation completes; a wedged overlay wedges the match.** *Worst offender.*
2. **`_onPhaseChange` SIMULATING(1123–1126)** — `_runSimulation()` fired inside
   `setTimeout(revealDelay)` (800–2500 ms) — a visual pause gating simulation start.
3. **`_runSimulation` per-step(1267–1272)** — each `step()` followed by `render()` +
   `_updateCensus()` + `await _sleep(ANIMATION_STEP_MS)`. Every sim tick blocks on animation.
4. **`_runAITurn` pacing(2612, 2706)** — `_sleep(300)` pre-call + `_sleep(pause)` up to
   2000 ms in AI-vs-AI "so spectators can study." Turn cadence throttled for spectacle.
5. **`_startMatch` intro(3693)** — `await _showMatchIntro({minMs:2200})` blocks setup on the VS reveal.
6. **`_showGameOver` final statements(2536–2555)** — `await Promise.all(requests)` holds
   game-over open on AI calls (tournament path dodges via the early `_matchResolve` return).
7. **Layout→grid (data coupling)** — `_availableBoard`(3580) reads `getComputedStyle`/
   `window.inner*`; `_resolveWorld`(3604)/`_containHex`(3593) size `cols/rows/hexSize` from
   it. **The grid the engine simulates is sized from the DOM viewport.** Headless must inject
   explicit dims (StateFrame already carries `grid{cols,rows,hexSize,seed}`).

Items 1–6 are *timing* couplings (engine awaits view); 7 is *data* (engine reads layout).

## StateFrame emission points → current code site

| Moment | Site (line) |
|---|---|
| Match start / world ready | `resetForMatch` end (4983) / `_startMatch` (3725) |
| Turn start (phase flip) | `_onPhaseChange` head (1073); `_onTournamentTick` (1152) |
| Move-clock tick | `_startThinkingCountdown` (2765–2773); `_moveClock` (2757) |
| Model warming | `_startModelLoadWatch` (2815) |
| Each placement | `_onClick` (1246, human); `_runAITurn` apply (2680–2700, AI) |
| Banter | `_runAITurn` (2659–2665) |
| Each simulation step | `_runSimulation` loop (1268) |
| Score change | `_updateScoreboard` (1459); `_scoreHistory` push (1541) |
| Round end / recap | `_onPhaseChange` ROUND_END (1128); `_captureRound` (1282) |
| Match end | `_showGameOver` (2399); `_matchResolve` (2406) |
| ELO resolved | `_recordCasualResult` (3930) / tournament post |

## Seam-rewrite targets (the 9)

`_onPhaseChange`(1073), `_runAITurn`(2560), `_runSimulation`(1256),
`_runRoundEndSequence`(1155), `_showGameOver`(2399), `_startMatch`(3668),
`resetForMatch`(4930), `_detectMilestones`(1788), `_init`(84).

**Critical path = `_runAITurn`, `_runRoundEndSequence`, `_runSimulation`, `_onPhaseChange`.**
Fix their view-blocking awaits/sleeps and the structural freeze class is gone.

**The rewrite pattern (per method):** keep the engine statements; delete the
`render`/`_sleep`/`await-overlay` lines; replace each with a StateFrame emit; let the
resolved `_runRoundEndSequence` advance `turns.nextRound()` immediately — animation timing
becomes a *subscriber* concern, decoupled from engine progression.

## Verbatim lifts (DOM-free, move as-is)

`_isAIvsAI`, `_captureRound`, `_computeRoundSignals`, `_countRoundMedals`, `_medalTally`,
`_snapshotCensus`, `_tierCounts`, `_composeRecapStory`, `_recapDeltas`, `_aiCharacterName`,
`_degradedQuip`, `_warmForMatch`, `_warmMatch`, `_buildFighterDescriptor`, `_describeMatch`,
`_syncFighterContext`, `_fetchRanking`, `_recordCasualResult`, `_resultDrama`,
`_resetMatchState`, `runFullGame`, `_largestBracketFor`, `_modelInitials`,
`_prettyModelName`, `_shortName`, `_playerTag`, `_getHandle`, `_celebrateResult`.

## Peel-the-engine-lines

`_buildBoardCore`(4908, inject renderer factory — builds grid+sim only),
`setAI`/`removeAI`(2893/2906), `_teardownAITurn`(2730, peel `turns.endTurn()`),
`_resolveWorld`/`_availableBoard`/`_containHex`(3580–3621, make pure over injected viewport).
