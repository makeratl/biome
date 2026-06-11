# Headless engine + broadcast — design

Status: **proposal** (no engine code changed yet). Supersedes the in-browser live
broadcast that intermittently froze the game.

## 1. Why

Every tournament freeze we diagnosed had one root: **the code that *runs* the game
and the code that *renders* it share one main thread.** The match loop, the canvas
draw, the per-turn bracket rebuild, the 1.8 s board read-back/encode, and the dual
flank carousels all execute on the same thread, so a slow or wedged render starves
the engine and the whole tab hangs. We proved the engine itself is sound — with the
broadcast valve off (`tournament.js` `_broadcastOff`) the game runs clean to a
champion. The defect is structural, not a single bad line.

## 2. Principle

Invert the dependency:

> The game is an **authority that emits state**. Every view — the operator's screen
> included — is a **subscriber that renders from the feed**. No view is privileged
> or coupled to the engine.

Once rendering is strictly downstream of the engine, a slow/broken/closed view
**cannot** stall the game. The class of bug disappears; it is not patched.

## 3. The seam in Biome

The split falls along an existing, clean boundary.

**Engine (pure, view-agnostic — already DOM-free):**
`simulation.js`, `turn.js`, `grid.js`, `terrain.js`, `noise.js`, `species.js`,
`config.js`, `ai.js` (`AIPlayer` → Ollama), `map-strategies.js`,
`game-dynamics.js`, `trophic.js`, `ecobalance.js`, `medal.js`,
`tournament-format.js`. ELO/history are already server-side (`db.py`).

**View (browser-only):** `renderer.js`, `organism-art.js` (pure draw routines —
reusable by *any* view), the canvas, and all DOM/UI + broadcast code in `game.js`,
`tournament.js`, `spectator.js`.

**The one entangled file is `game.js`** (~5000 lines) — orchestrator that fuses
engine + canvas + UI + broadcast. The work is *separating* it, not rewriting it:
extract a headless **MatchRunner** (drive turn → call AI → step sim → emit
state+events) from the rendering. `spectator.js` already is the subscriber pattern;
we promote it to be the *only* renderer.

```
            ┌─────────────── MatchRunner (headless) ───────────────┐
            │ turn.js · simulation.js · ai.js · scoring · ELO post │
            └───────────────┬──────────────────────────────────────┘
                            │  emits StateFrame + events
                  ┌─────────▼──────────┐  (server relay / SSE)
                  │   broadcast bus    │
                  └───┬───────────┬────┘
        ┌─────────────▼──┐    ┌───▼──────────────┐
        │ operator view  │    │ spectator view(s)│   ← identical subscribers,
        │ (renderer +    │    │ (renderer +      │     render from StateFrame
        │  organism-art) │    │  organism-art)   │
        └────────────────┘    └──────────────────┘
```

## 4. The state feed (the key new artifact)

Today `_buildLiveSnapshot()` carries bracket/scores **but no board**, which is the
whole reason the board-image push exists. To render the board in any view we emit a
compact **StateFrame** instead of a WebP.

`drawOrganism(ctx, cx, cy, org)` needs only `{species, player, energy}` per
organism; the cell supplies `terrain`; the grid supplies geometry (`cols`, `rows`,
`hexSize`). So:

```jsonc
// StateFrame — emitted per turn (board) + on bracket change (meta)
{
  "seq": 1421,                  // monotonic; viewers drop stale frames
  "match": { "id": 3, "p1": "...", "p2": "...", "round": 7, "totalRounds": 10,
             "phase": "DECIDING", "currentPlayer": 2 },
  "grid": { "cols": 72, "rows": 38, "hexSize": 14.0, "seed": 93506 },
  "board": [ /* non-empty cells only */
    { "c": 31, "r": 12, "t": "FERTILE",
      "o": [ ["GRASS", 1, 0.8], ["GRAZER", 2, 0.5] ] }  // [species, player, energyRatio]
  ],
  "scores": { "1": 463, "2": 265 },
  "clock":  { "player": 2, "remainingMs": 18400, "totalMs": 30000 },
  "banter": { "1": null, "2": "..." },
  "bracket": { /* existing _buildLiveSnapshot bracket/stats payload */ }
}
```

Sizing: terrain is static per match → send the **terrain grid once** at match start
(keyed by `seed` + dims; viewers can even regenerate it via `terrain.js`), then
per-turn frames carry **only non-empty cells' organisms** (a delta is a later
optimization). A 72×38 board rarely has more than a few hundred occupied cells;
even verbose JSON is tens of KB and renders crisply at any viewport — and it
**removes the canvas read-back + WebP encode entirely** (one of the stall sources).

Fog of war stays a **render-time** concern in each view (as it is now), but the
authoritative frame must not leak an opponent's current-round placements to a view
that shouldn't see them — preserve the existing fog invariant when serializing.

## 5. Transport

- **Now:** keep HTTP polling (what `spectator.js` already does) — zero new infra.
- **Next:** **SSE** (`text/event-stream`) from the Python server — true push, low
  effort on `http.server` (one streaming response per subscriber, write frames as
  they arrive). WebSockets are the nice-to-have but painful on the stdlib server;
  not worth it yet.

The server already relays the live feed (`/tournament/live`); it becomes the
StateFrame fan-out point.

## 6. Board rendering from state

Drop `live-publish.js` `_pushBoard` (the `drawImage`+`toBlob` every 1.8 s). Each
view owns a `renderer.js` instance and calls `drawOrganisms()` from the StateFrame.
`organism-art.js` is already shared and pure, so operator and spectator draw
identically. No read-back, no encode, no image endpoint.

## 7. Phased migration

**Phase 0 — done.** Broadcast parked (`_broadcastOff = true`); game is stable.

**Phase 1 — decouple in the browser.** The operator tab still *runs* the engine
(keeps Ollama-via-proxy) but renders **nothing privileged** — it shows the same
subscriber view as everyone else, fed by the StateFrame the runner emits.
- Extract `MatchRunner` from `game.js` (turn loop + AI + sim + scoring + ELO post),
  emitting StateFrames; no DOM.
- Add `board` to the emitted frame; build the viewer's board render from it.
- Delete the per-turn bracket rebuild, the flank carousels, and `_pushBoard` from
  the live path. The freeze is gone because the engine no longer renders.
- *Outcome:* freeze-proof game, one renderer shared by operator + spectators.
  *Cost:* moderate; an operator tab must still be the runner.

**Phase 2 — true headless on the server.** Run `MatchRunner` in a **Node sidecar**
on the box (it already has Ollama; call `:11434` directly, no CORS proxy). Server
broadcasts StateFrames via SSE. **No operator tab needed** — everyone opens a
viewer.
- *Outcome:* the real "headless game broadcasting to all views"; maximal
  robustness; tournaments run unattended.
- *Cost:* port the pure engine modules to run under Node (they're already DOM-free
  ES modules — mostly a packaging + entrypoint job), plus the SSE fan-out.

Phase 1 is a strict subset of Phase 2 — the `MatchRunner`/StateFrame boundary is
the same; Phase 2 only changes *where it runs* and *how frames ship*.

## 8. Open questions / risks

- **Engine ↔ DOM coupling in `game.js`.** The extraction's real cost is auditing
  how much engine logic reaches into the DOM today (UI updates mid-turn). The pure
  modules are clean; the orchestrator is the unknown. First task: map `game.js`
  for engine-vs-view responsibilities.
- **AI timeouts off the UI thread.** `ai.js` uses `AbortController` + a 30 s budget
  (the game's challenge). Confirm identical behavior under Node (Phase 2).
- **Capture/training feed.** `capture.js` posts per-turn/round trajectories; in the
  headless model the runner emits these directly (cleaner — no keepalive cap, see
  the capture-keepalive note).
- **Frame size at large maps.** 100×52 boards; validate StateFrame stays light, add
  occupied-cell-only + per-turn delta if needed.
- **One authority.** Exactly one runner per tournament writes ELO; viewers are
  read-only. Already true (operator tab); enforce it in Phase 2.

## 9. Seam audit — done

`game.js` is mapped in [game-js-seam-audit.md](game-js-seam-audit.md). Headline: of
~194 methods, the engine surface is ~30 and the entanglement concentrates in **9 hot
methods** (4 on the critical path: `_runAITurn`, `_runRoundEndSequence`,
`_runSimulation`, `_onPhaseChange`). The freeze is six **timing couplings** where the
engine `await`s view (round-end overlays, the per-sim-step `_sleep`, AI-turn pacing
sleeps, the match-intro gate) plus one **data coupling** (the grid is sized from the
DOM viewport). The tournament `_matchResolve` early-return and the `_onTournamentTick`
hook prove the boundary already half-exists.

**Phase 1 build order** (lowest-risk first, freeze-fix value back-loaded):
1. Lift the ~28 DOM-free methods + peel the ~8 thin ones into a `MatchRunner` module.
2. Make grid sizing pure (inject dims; kill the `getComputedStyle`/`window` reads).
3. ✅ **Define the StateFrame + a tiny emit bus** — `js/state-frame.js` (bus +
   `serializeBoard`/`deserializeBoard` + `buildFrame`), unit-tested round-trip.
4. Rewrite the 4 critical-path methods: delete `render`/`_sleep`/`await-overlay`
   lines, emit a StateFrame instead, let `turns.nextRound()` advance immediately.
   **This is the step that ends the freeze class.** (Not yet done.)
5. ✅ **Board-as-state, spectator renders it** — landed (see below).

### Phase 1 progress — board-as-state (done, needs live verify)

Shipped, additively, with all freeze-prone paths still parked behind `_broadcastOff`:
- `js/state-frame.js` — emit bus + board (de)serialization + frame assembly. Tested.
- `js/board-frame-view.js` — `BoardFrameView` draws a board from a StateFrame using
  the shared `organism-art.js` (terrain backdrop cached across organism deltas). No
  interactive `Renderer`, no canvas read-back.
- `game.js` — `_emitBoardFrame()` emits at `match-start` / each `turn` / each
  `sim-step`, alongside the existing canvas render (additive).
- `tournament.js` — `_buildLiveSnapshot()` now carries `board` (serialized); new
  `_pushLiveSnapshot()` is a cheap **async JSON push** (bracket + scores + board),
  and `_onTournamentTick` is rewired from the heavy per-turn `_renderLiveBracket`
  repaint to this cheap push. The heavy local repaint, flank carousels, and the
  WebP `_pushBoard` loop stay parked.
- `spectator.js` — renders the board locally from `snapshot.board` via
  `BoardFrameView`, falling back to the WebP image when absent.

Net: the **board travels as state**; the spectator draws it itself; the host does no
per-turn heavy repaint and no canvas read-back. Verified to load clean (game smoke =
0 errors; spectator module graph serves). **Needs a live tournament (Ollama) to
confirm the spectator paints the board and the game stays smooth** — the heartbeat
should show no beat-gaps.

**Remaining for a full freeze-proof broadcast:** step 4 (decouple the 4 critical-path
methods' view-blocking `await`s) + re-enabling the host's own bracket/flanks off the
StateFrame, then retiring `_broadcastOff` and `_pushBoard`.
