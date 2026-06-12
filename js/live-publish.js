// LivePublisher — pushes the live tournament feed from the driving browser to the
// server's in-memory relay so the public spectator page can watch in real time.
//
// Two streams:
//   • snapshot JSON — bracket/scoreboard state AND the board-as-state, pushed once
//     per phase change (the spectator draws it via BoardFrameView). No canvas
//     read-back, no WebP — that 1.8s board-encode loop was the freeze surface, retired.
//   • per-step frames — a lightweight { seq, board } pushed PER simulation step so
//     the spectator can animate the 2s growth cycle instead of jumping. Drained from
//     a small server ring buffer and played back through the spectator's FramePlayer.
//
// Fire-and-forget: a failed push must never disturb the tournament loop. We
// deliberately do NOT use `keepalive` — these fire during active play (not on
// unload), so we sidestep the 64 KiB keepalive cap that silently drops large
// bodies (see the capture keepalive note).

export class LivePublisher {
    // POST the current snapshot. `obj` is a plain serializable object built by the
    // tournament manager (see _buildLiveSnapshot) — bracket + scores + board-as-state.
    pushSnapshot(obj) {
        try {
            fetch('/tournament/live', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(obj),
            }).catch(() => {});
        } catch { /* never throw into the game loop */ }
    }

    // POST one per-step board frame to the server's ring buffer. `frame` is a
    // StateFrame from the engine's emit bus; we send only the lightweight bits the
    // spectator needs to animate a step ({ seq, board }). Same fire-and-forget,
    // never-throw discipline — these fire ~20×/turn during simulation.
    pushFrame(frame) {
        if (!frame || !frame.board) return;
        try {
            fetch('/tournament/live/frames', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ seq: frame.seq, board: frame.board }),
            }).catch(() => {});
        } catch { /* never throw into the game loop */ }
    }
}
