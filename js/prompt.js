// Segmented turn-prompt composition for Biome's AI players.
//
// The prompt a model sees on its turn is assembled from small, ORDERED BLOCKS,
// each a pure function of a normalized context object. Two wins over the old
// single-string builder:
//
//   1. The rulebook (scoring weights, species table, valid-name list, every
//      "+10%"/"×1.25"/"×2" in the strategy text) is DERIVED FROM CONFIG — the
//      model is never briefed from a stale second copy. Tune config, the prompt
//      follows. No drift.
//   2. Match context (format/mode, board scale, round arc, stakes) is a
//      first-class block, so the same builder adapts to a 5-round Lightning
//      skirmish or a 20-round ranked bout instead of assuming one fixed game.
//
// Division of labour: `AIPlayer` owns all game-state + fog reads and hands this
// module a finished `ctx`. This module is PURE formatting — no game/DOM access,
// no fog logic — so it stays trivially testable and the lab can compose, toggle,
// or A/B individual blocks without forking the live builder.

import { CONFIG } from './config.js';

const pct = (x) => `${Math.round(x * 100)}%`;
const mult = (bonus) => `×${(1 + bonus).toFixed(2)}`;

// ── Rule generators (single source of truth = CONFIG) ──────────────

// Group species keys by trophic type, for the "valid names" contract.
function speciesByType(species = CONFIG.SPECIES) {
    const groups = { plant: [], herbivore: [], predator: [] };
    for (const [key, sp] of Object.entries(species)) {
        if (groups[sp.type]) groups[sp.type].push(key);
    }
    return groups;
}

export function rulesScoring(S = CONFIG.SCORING) {
    const exSpecies = 5;
    const divMult = 1 + exSpecies * S.SPECIES_DIVERSITY_BONUS;
    const trophMult = 1 + S.TROPHIC_BONUS;
    const example = Math.round(5000 * divMult * trophMult);
    return [
        'SCORING (this is critical!):',
        `- Weighted biomass: plant energy ×1, herbivore energy ×${S.HERBIVORE_WEIGHT}, predator energy ×${S.PREDATOR_WEIGHT}`,
        `- Species diversity: +${pct(S.SPECIES_DIVERSITY_BONUS)} bonus per unique species alive at game end`,
        `- Trophic chain bonus: +${pct(S.TROPHIC_BONUS)} if you have plants AND herbivores AND predators alive`,
        `- Example: 5000 weighted biomass × ${divMult.toFixed(2)} (${exSpecies} species) × ${trophMult.toFixed(2)} (trophic) = ${example.toLocaleString()} final score`,
        '- A diverse ecosystem CRUSHES a grass monoculture in scoring!',
    ].join('\n');
}

export function rulesSpecies(species = CONFIG.SPECIES, S = CONFIG.SCORING) {
    const weightOf = (type) =>
        type === 'herbivore' ? S.HERBIVORE_WEIGHT : type === 'predator' ? S.PREDATOR_WEIGHT : 1;
    const lines = ['SPECIES (in-world name → role, cost, behavior):'];
    for (const sp of Object.values(species)) {
        let line = `- ${sp.name} (${sp.role}, ${sp.apCost} AP): ${sp.blurb}`;
        const hints = [];
        if (sp.diet?.length) {
            const prey = sp.diet.map(d => species[d]?.role || d).join(' & ');
            hints.push(`eats ${prey}`);
        }
        const w = weightOf(sp.type);
        if (w > 1) hints.push(`energy counts ×${w}`);
        if (sp.type === 'plant' && sp.maxEnergy) hints.push(`stores up to ${sp.maxEnergy} energy`);
        if (hints.length) line += ` (${hints.join('; ')})`;
        lines.push(line);
    }
    return lines.join('\n');
}

// How creatures actually survive in the simulation — the spatial half of
// strategy the model is otherwise blind to (it only ever saw the scoring math).
// Numbers derive from CONFIG so they track any balance tuning.
export function rulesSurvival(species = CONFIG.SPECIES) {
    const GR = species.GRAZER, BR = species.BROWSER, PR = species.PREDATOR;
    return [
        'THE CYCLE OF LIFE (placement is everything):',
        `- Energy flows UP the chain: plants draw it from the soil, herbivores get it ONLY from plants, ${PR.role}s ONLY from herbivores. A creature placed where its food is not already within reach starves and that AP is wasted — you cannot support a tier before the tier beneath it exists (yours OR the enemy's). The board starts barren, so it has to be grown green before it can feed animals; as a plant base thickens, it can support grazers, then a predator to crown the chain. How fast you climb that arc is your call — just never place a creature ahead of its food.`,
        '- Plants spread on their own into nearby empty, high-nutrient land each step, and soil nutrients regenerate over time — give them fertile ground and room to grow (grassland next to water turns fertile). Up to 2 plants share one cell.',
        `- Herbivores only eat plants within their move range (${GR.role} reaches ${GR.speed} hexes, ${BR.role} ${BR.speed}) and LOSE energy every step — place them with plants nearby or they starve. They prefer the ENEMY's plants (~${pct(GR.preferEnemy)} of the time): drop them next to enemy plants to raid, or beside your own to feed and build ×${CONFIG.SCORING.HERBIVORE_WEIGHT} biomass.`,
        `- ${PR.role}s hunt herbivores within ${PR.speed} hexes and starve fast without prey — only deploy one where herbivores (yours or the enemy's) are already within reach.`,
        `- READ THE PYRAMID: a healthy chain is roughly 9 plants : 3 herbivores : 1 predator — each tier about a third of the one below. UNDER that ratio a tier has room to grow safely; PAST it the tier outruns the food beneath and the whole stack crashes. Two levers fall out of this — when a herd (yours or theirs) outgrows its plants, the predator above it thins the excess back into balance; and a thick, lightly-grazed plant base is a target, so flood it with herbivores to invert it and crash it while you eat. A bonus you can't feed is worthless: a tier that starves scores nothing.`,
    ].join('\n');
}

// The adversarial half of strategy. The other rule blocks teach the model how
// to optimize its OWN plot; this one reframes the game as a fight against an
// opponent that reads the same board and hunts the same weaknesses. The core
// truth — confirmed in simulation.js: a herbivore eating an enemy plant
// TRANSFERS that energy to itself — makes raiding the highest-leverage move in
// the game, not just a comeback tactic. Numbers derive from CONFIG.
export function rulesAdversary(species = CONFIG.SPECIES, S = CONFIG.SCORING) {
    const GR = species.GRAZER, PR = species.PREDATOR;
    return [
        'KNOW YOUR ENEMY (this is a fight, not a garden):',
        `- Your opponent is an AI as sharp as you, reading this exact board and hunting your weak spots. Assume every plant you grow is a target and every herbivore you field is prey. You win by growing a richer ecosystem than theirs AND by bleeding theirs dry — never just one.`,
        `- Raiding is the strongest move in the game, not a last resort: when your ${GR.role} eats an enemy plant it TRANSFERS that energy to itself — their biomass falls and your ×${S.HERBIVORE_WEIGHT} column climbs in the SAME move. A ${PR.role} dropped on their herbivores does the same into your ×${S.PREDATOR_WEIGHT} column. Place hunters where the enemy's plants and herbivores already cluster, and that AP works twice.`,
        `- So defend like you expect to be raided, because you will be: don't pile your whole base into one cluster a single grazer can gut — spread plants across regions, and keep your herbivores out of reach of any predator the enemy can field. A wiped-out tier scores nothing; a resilient, spread ecosystem survives to collect every bonus.`,
    ].join('\n');
}

function voiceBlock(species = CONFIG.SPECIES) {
    const names = Object.values(species).map(s => s.name).join(', ');
    const roles = Object.values(species).map(s => s.role).join('/');
    return `VOICE: In your reasoning and banter, prefer the in-world names (${names}) — they give your trash-talk personality. Roles (${roles}) are fine too. The action JSON below must still use the technical UPPERCASE keys. You know exactly who you are fighting (see MATCHUP) — call your opponent out by name, and let your ELO standing and win/loss record color your confidence (smug if you outrank them, hungry for an upset if you don't).`;
}

// Per-model personality lands here (thread 3). For now ctx.persona is null and
// every fighter gets the generic directive — the seam is ready for an override.
function personaDirective(persona) {
    if (persona && persona.directive) return persona.directive;
    return 'You have a personality — be competitive, witty, and opinionated about your strategy.';
}

// ── Human-readable board scale ─────────────────────────────────────

export function matchSizeLabel(cols, rows, maps = CONFIG.MAPS) {
    for (const m of Object.values(maps)) {
        if (m.cols === cols && m.rows === rows) return m.label;
    }
    return `${cols}×${rows}`;
}

// ── System blocks ──────────────────────────────────────────────────

function composeSystem(ctx) {
    const trophic = mult(CONFIG.SCORING.TROPHIC_BONUS);
    return [
        `You are an AI playing Biome, a competitive ecosystem strategy game on a hex grid. You are Player ${ctx.player}. ${personaDirective(ctx.persona)}`,
        `GOAL: Maximize your FINAL SCORE after ${ctx.total} rounds.`,
        rulesScoring(),
        rulesSpecies(),
        rulesSurvival(),
        rulesAdversary(),
        voiceBlock(),
        `STRATEGY: Early rounds plant ${CONFIG.SPECIES.GRASS.name} for foundation, spread WIDE so no single raid can gut you. Mid-game diversify — add ${CONFIG.SPECIES.SHRUB.name}, ${CONFIG.SPECIES.GRAZER.name}s — and start pressuring: drop grazers on the enemy's plant clusters to steal biomass both ways. Late-game lock in all 3 trophic levels for the ${trophic} bonus while raiding to widen the gap.`,
        'Respond ONLY with valid JSON. No markdown, no explanation outside the JSON.',
    ].join('\n\n');
}

// ── User blocks ────────────────────────────────────────────────────

// NEW: tells the model what game it's actually in — format, stakes, and the
// scale of the board. Degrades gracefully: with no match context set (e.g. the
// lab), it still reports battlefield size from the grid.
function matchContextBlock(ctx) {
    const m = ctx.match || {};
    const lines = [];
    if (m.modeLabel) lines.push(`FORMAT: ${m.modeLabel}.`);
    const dims = `${ctx.board.cols}×${ctx.board.rows}`;
    lines.push(ctx.board.sizeLabel === dims
        ? `BATTLEFIELD: ${dims} hexes.`
        : `BATTLEFIELD: ${ctx.board.sizeLabel} (${dims} hexes).`);
    if (m.stakes) lines.push(m.stakes);
    return lines.join('\n');
}

function matchupBlock(ctx) {
    const f = ctx.fighters || {};
    if (!f.selfDesc && !f.oppDesc) return null;
    const enemyNum = ctx.player === 1 ? 2 : 1;
    const lines = ['MATCHUP:'];
    if (f.selfDesc) lines.push(`  You (Player ${ctx.player}): ${f.selfDesc}`);
    if (f.oppDesc) lines.push(`  Opponent (Player ${enemyNum}): ${f.oppDesc}`);
    return lines.join('\n');
}

// TEMPO only: where you are in the match arc and the principle for this stretch.
// The specific opportunities live in balanceBlock, which reads the live board —
// we hand the model the state + levers and trust it to choose, rather than
// scripting exact AP splits.
function phaseBlock(ctx) {
    const { round, total, ap, strategy: st } = ctx;
    const S = CONFIG.SCORING;
    const div = pct(S.SPECIES_DIVERSITY_BONUS);
    const trophic = mult(S.TROPHIC_BONUS);
    const hasChain = st.myHasPlant && st.myHasHerb && st.myHasPred;
    const multLine = `Scoring multiplier: ×${st.currentMult.toFixed(2)} (${st.speciesCount} species${hasChain ? ' + trophic chain' : ''}).`;

    let phase, tempo;
    if (round <= st.earlyEnd) {
        phase = 'EARLY';
        tempo = `Lay a wide green base — grass across SEPARATE regions so no single raid can gut you, plus a shrub for the species bonus (+${div}). Don't field animals before there are plants to feed them.`;
    } else if (round <= st.midEnd) {
        phase = 'MID GAME';
        tempo = `Your base can feed animals now — climb the chain only where the food is already in reach, and start pressuring the enemy where they're thin. Let the balance read below pick your targets.`;
    } else {
        phase = 'LATE GAME';
        tempo = `${total - round} round(s) left. Lock in all three tiers for the chain bonus (${trophic}) and keep your clusters spread, then widen the gap by raiding — but never feed a tier you can't sustain.`;
    }

    let body = `PHASE: ${phase} (round ${round}/${total}). You have ${ap} AP.\n${multLine}\n${tempo}`;
    if (total <= CONFIG.GAME.LIGHTNING_ROUNDS) {
        body = `(SHORT MATCH — only ${total} rounds. Compress your arc: lock in species diversity early, don't over-invest in grass foundation.)\n` + body;
    }
    return body;
}

// The per-turn balance read — the SAME trophic assessment the human sees in the
// health orb, handed to the model as state + levers (not commands). Fog-safe:
// built from the already-fogged censuses in _promptContext.
function balanceBlock(ctx) {
    const t = ctx.trophic;
    if (!t || !t.mine) return null;
    return [
        'TROPHIC BALANCE (your living board — counts as plants/herbivores/predators):',
        `  You: ${phraseSelf(t.mine)}`,
        `  Enemy: ${phraseEnemy(t.enemy)}`,
    ].join('\n');
}

function phraseSelf(r) {
    const S = CONFIG.SCORING;
    const trio = `${r.plants}p/${r.herbs}h/${r.preds}r`;
    switch (r.state) {
        case 'empty': return 'no ecosystem yet — plant a base.';
        case 'primordial':
            return r.idealHerb >= 2
                ? `green base only (${r.plants} plants, no animals) — it can feed ~${Math.floor(r.idealHerb)} herbivores once you start climbing.`
                : `just a sprout of a base (${r.plants} plants, no animals) — keep growing green before you field animals.`;
        case 'building': {
            let s = `healthy base (${trio}) with room to grow`;
            const adds = [];
            if (r.roomHerb > 0) adds.push(`~${r.roomHerb} more herbivores`);
            if (r.herbs > 0 && r.preds === 0 && r.roomPred > 0) {
                adds.push(`a predator (prey exists — earns ${mult(S.TROPHIC_BONUS)} chain + energy ×${S.PREDATOR_WEIGHT})`);
            }
            return adds.length ? `${s} — the food's there for ${adds.join(' and ')}.` : `${s}.`;
        }
        case 'balanced':
            return `balanced chain (${trio}) — every bonus sustained; protect the spread and don't overload a tier.`;
        case 'overgrazed':
            return `OVERGRAZED — ${r.herbs} herbivores on ${r.plants} plants (${r.herbRatio.toFixed(1)}× what the base feeds). They'll crash it: stop adding herbivores and thicken plants, or drop a predator to thin your own herd before it starves the base.`;
        case 'top-heavy':
            return `TOP-HEAVY — ${r.preds} predators on ${r.herbs} herbivores; they'll starve. Grow the herd before adding more hunters.`;
        case 'collapsing':
            return `your animals have no plant base — they're starving. Plant grass beneath them now.`;
        default: return `${trio}.`;
    }
}

function phraseEnemy(r) {
    const S = CONFIG.SCORING;
    const trio = `${r.plants}p/${r.herbs}h/${r.preds}r`;
    const fatBase = r.plants >= 8 && (r.state === 'primordial' ||
        (r.herbRatio != null && r.herbRatio !== Infinity && r.herbRatio < 0.6));
    switch (r.state) {
        case 'empty': return 'nothing on the board yet.';
        case 'primordial':
            return r.plants >= 8
                ? `plant-heavy, ungrazed (${r.plants} plants, no animals) — flood their cluster with herbivores to steal biomass into your ×${S.HERBIVORE_WEIGHT} column and stall their base.`
                : `barely started (${r.plants} plants, no animals) — outgrow them and contest the open ground.`;
        case 'building':
            if (fatBase) return `thick, lightly-grazed base (${trio}) — raid it: herbivores on their plants bleed biomass both ways${r.preds === 0 ? ', and they have no predator to punish you' : ''}.`;
            return `${trio}${r.preds === 0 ? ' — no predator guards their herd, so your grazers raid freely' : ' — press their thinnest tier'}.`;
        case 'balanced':
            return `balanced and resilient (${trio}) — no easy crack; chip the edges of their spread, not the core.`;
        case 'overgrazed':
            return `OVERGRAZING — ${r.herbs} herbivores on ${r.plants} plants${r.preds === 0 ? ', no predator' : ''}. Their base is already crashing; a predator on their herd scores ×${S.PREDATOR_WEIGHT} AND hastens it, and your herbivores raid their plants unpunished.`;
        case 'top-heavy':
            return `TOP-HEAVY (${trio}) — predators starving on too few herbivores; let them collapse and outgrow them.`;
        case 'collapsing':
            return `their animals have no base — starving on their own; don't waste AP, just outgrow them.`;
        default: return `${trio}.`;
    }
}

function boardBlock(ctx) {
    // The map block comes from the active orientation strategy (see
    // js/map-strategies.js); it carries its own header. The ecosystem lines are
    // strategy-independent.
    return `${ctx.board.mapBlock}\n\nYOUR ECOSYSTEM: ${ctx.board.myEcosystem}\nENEMY ECOSYSTEM: ${ctx.board.enemyEcosystem}`;
}

function candidatesBlock(candidates) {
    let moveText = '';
    for (const c of candidates) moveText += `  ${c.label}) [${c.type}] ${c.description} (${c.ap})\n`;
    if (!moveText) moveText = '  No strong candidates — place grass in the best available fertile spot.\n';
    return `CANDIDATE MOVES:\n${moveText.replace(/\n$/, '')}`;
}

function directiveBlock(ctx) {
    const g = speciesByType();
    const maxCol = ctx.board.cols - 1, maxRow = ctx.board.rows - 1;
    return [
        `Spend ALL ${ctx.ap} AP. For each action pick a species AND where to place it — EITHER a CANDIDATE letter (a safe, pre-vetted spot) OR exact "col" and "row" to place anywhere on land (col 0..${maxCol}, row 0..${maxRow}; never on water). Use coordinates when the candidate spots don't reach where you want to play.`,
        `VALID SPECIES NAMES (use EXACTLY one of these, ALL CAPS):\n  Plants: ${g.plant.join(', ')}\n  Herbivores: ${g.herbivore.join(', ')}\n  Predator: ${g.predator.join(', ')}`,
        `IMPORTANT: Write ORIGINAL reasoning and banter. Reference the CURRENT game state (round ${ctx.round}, your species, the score).`,
        `JSON format (each action uses EITHER "spot" OR "col"+"row"):\n{"reasoning":"<strategic analysis>","actions":[{"spot":"A","species":"GRASS"},{"col":6,"row":2,"species":"GRAZER"}],"banter":"<competitive comment>"}`,
    ].join('\n\n');
}

function composeUser(ctx) {
    const segments = [
        `Round ${ctx.round}/${ctx.total}. You are Player ${ctx.player}. AP: ${ctx.ap}.`,
        matchContextBlock(ctx),
        matchupBlock(ctx),
        ctx.memory || null,
        phaseBlock(ctx),
        balanceBlock(ctx),
        boardBlock(ctx),
        candidatesBlock(ctx.board.candidates),
        directiveBlock(ctx),
    ];
    return segments.filter(Boolean).join('\n\n');
}

// ── Public entry ───────────────────────────────────────────────────

// Assemble the full turn prompt from `ctx`. Returns { system, user } plus the
// ordered `segments` (handy for the lab to show block boundaries later).
export function buildTurnPrompt(ctx) {
    const system = composeSystem(ctx);
    const user = composeUser(ctx);
    return { system, user };
}
