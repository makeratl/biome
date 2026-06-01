// Tournament formats — the two orthogonal knobs that define a bracket:
//   field  = WHO gets in   (which models, by what selection rule)
//   seed   = HOW they pair (the round-1 matchups, given the field)
// Round count (lightning/standard) and board size are a SEPARATE axis owned by
// the World picker; a format never touches them.
//
// buildField() turns a pool of eligible models + their ratings into the
// pairing-ordered field array that TournamentManager._buildBracket consumes
// (index 2i plays 2i+1 in round 1).

// A model needs at least this many games on record to be a "champion" — keeps a
// fresh-install model sitting at base ELO from claiming a seat it hasn't earned.
export const MIN_GAMES_FOR_CHAMPION = 3;

export const FORMATS = {
    seeded: {
        key: 'seeded',
        label: 'Seeded',
        field: 'topElo',
        seed: 'seeded',
        blurb: 'Top models by rating, classic 1-v-N seeding — favourites kept apart until late.',
    },
    champions: {
        key: 'champions',
        label: 'Champions',
        field: 'champions',
        seed: 'seeded',
        blurb: 'Proven models only — must have earned a rank. Seeded so the best meet last.',
    },
    davidGoliath: {
        key: 'davidGoliath',
        label: 'David vs Goliath',
        field: 'spread',
        seed: 'davidGoliath',
        blurb: 'Strongest drawn straight against weakest. Round one is all mismatch — maximum upset drama.',
    },
    open: {
        key: 'open',
        label: 'Open Draw',
        field: 'random',
        seed: 'random',
        blurb: 'Random field, random pairings. Anything can happen.',
    },
};

export const DEFAULT_FORMAT = 'seeded';
export const BRACKET_SIZES = [8, 16, 32];

// ── Field selection: choose `size` competitors from the eligible pool ────────
// pool: [{ name, elo, games }]. Returns up to `size` pool entries (un-padded).
function selectField(pool, size, strategy, rng) {
    const byEloDesc = (a, b) => b.elo - a.elo;

    if (strategy === 'random') {
        return shuffle([...pool], rng).slice(0, size);
    }

    if (strategy === 'champions') {
        const proven = pool.filter(p => p.games >= MIN_GAMES_FOR_CHAMPION).sort(byEloDesc);
        if (proven.length >= size) return proven.slice(0, size);
        // Not enough proven models to fill the bracket — top up with the next-best
        // by rating so a young leaderboard still fields a full draw.
        const rest = pool.filter(p => !proven.includes(p)).sort(byEloDesc);
        return [...proven, ...rest].slice(0, size);
    }

    if (strategy === 'spread') {
        // David vs Goliath field: a deliberately wide rating spread. Take the top
        // half and the bottom half of the ranked pool so there are genuine
        // favourites AND genuine underdogs (skips the muddy middle when the pool
        // is larger than the bracket).
        const ranked = [...pool].sort(byEloDesc);
        if (ranked.length <= size) return ranked;
        const half = size / 2;
        return [...ranked.slice(0, half), ...ranked.slice(ranked.length - half)];
    }

    // 'topElo' (default): the straightforwardly strongest field.
    return [...pool].sort(byEloDesc).slice(0, size);
}

// ── Seeding: order the selected field into round-1 pairings ──────────────────
// Input: selected field (any order). Output: array where index 2i meets 2i+1.
function orderSeeds(selected, strategy, rng) {
    const n = selected.length;
    const ranked = [...selected].sort((a, b) => b.elo - a.elo); // seed 1 = highest ELO

    if (strategy === 'random') {
        return shuffle([...selected], rng);
    }

    if (strategy === 'davidGoliath') {
        // Pair strongest vs weakest: (1 vs N)(2 vs N-1)… so every round-1 match
        // is a maximal mismatch.
        const out = [];
        for (let i = 0; i < n / 2; i++) { out.push(ranked[i], ranked[n - 1 - i]); }
        return out;
    }

    // 'seeded' (default): standard single-elimination bracket order so the top
    // seeds are maximally separated (1 & 2 can only meet in the final).
    return seedOrder(n).map(s => ranked[s - 1]);
}

// Standard tournament seeding sequence for a power-of-two bracket of `n`.
// n=8 → [1,8,4,5,2,7,3,6]; n=16 → [1,16,8,9,4,13,5,12,2,15,7,10,3,14,6,11].
function seedOrder(n) {
    let order = [1, 2];
    while (order.length < n) {
        const m = order.length * 2 + 1;
        const next = [];
        for (const s of order) { next.push(s, m - s); }
        order = next;
    }
    return order;
}

function shuffle(arr, rng = Math.random) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Build the pairing-ordered field of model names for a tournament.
//   pool      : [{ name, elo, games }] — every eligible model + its rating/record
//   size      : bracket size (8 / 16 / 32)
//   formatKey : key into FORMATS
// Pads with random repeats only when the eligible pool is smaller than `size`,
// so a sparse install still produces a full bracket.
export function buildField(pool, size, formatKey, rng = Math.random) {
    const fmt = FORMATS[formatKey] || FORMATS[DEFAULT_FORMAT];
    let selected = selectField(pool, size, fmt.field, rng);
    if (selected.length === 0) return [];
    while (selected.length < size) {
        selected.push(selected[Math.floor(rng() * selected.length)]);
    }
    return orderSeeds(selected, fmt.seed, rng).map(x => x.name);
}
