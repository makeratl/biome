// Training-data medal tiers — the single source of truth for "how good was this
// move, and does it train?". MIRRORED in traj.py (classify_medal) — change one,
// change both, or the in-game end screen and the exported dataset will disagree.
//
// A move carries two QUALITY signals, both computed live at round end:
//   marginGrew      — the player's score lead grew vs the previous round
//   trophicImproved — a healthier pyramid this round (health up, risk not up,
//                     not collapsing)
// plus `real` (a genuine model answer, not a fallback) and `wonMatch` (resolved
// only when the match ends). The tier is driven by how many quality signals a
// move has; the win only decides gold-vs-silver:
//
//   real == false         → no medal           (fallbacks aren't answers to imitate)
//   2 quality signals     → GOLD if won, else SILVER
//   1 quality signal      → BRONZE              (win or loss — decidable live)
//   0 quality signals     → no medal
//
// Only GOLD is auto-queued for training. Silver/bronze are quality metrics.

export const MEDAL = { GOLD: 'gold', SILVER: 'silver', BRONZE: 'bronze' };

// Full classification — needs the match outcome, so it's the final word at
// match end and in the dataset exporter.
export function classifyMedal({ real, wonMatch, marginGrew, trophicImproved }) {
    if (!real) return null;
    const q = (marginGrew ? 1 : 0) + (trophicImproved ? 1 : 0);
    if (q === 2) return wonMatch ? MEDAL.GOLD : MEDAL.SILVER;
    if (q === 1) return MEDAL.BRONZE;
    return null;
}

// Pre-win view for the in-game tray: bronze is already certain (win-independent),
// but a 2-signal move is still 'pending' — gold if the player wins, silver if not.
export function liveTier({ real, marginGrew, trophicImproved }) {
    if (!real) return null;
    const q = (marginGrew ? 1 : 0) + (trophicImproved ? 1 : 0);
    if (q === 2) return 'pending';
    if (q === 1) return MEDAL.BRONZE;
    return null;
}
