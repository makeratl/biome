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
        voiceBlock(),
        `STRATEGY: Early rounds plant ${CONFIG.SPECIES.GRASS.name} for foundation. Mid-game diversify — add ${CONFIG.SPECIES.SHRUB.name}, ${CONFIG.SPECIES.GRAZER.name}s. Late-game ensure you have all 3 trophic levels for the ${trophic} bonus.`,
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

function phaseBlock(ctx) {
    const { round, total, ap, strategy: st } = ctx;
    const S = CONFIG.SCORING;
    const div = pct(S.SPECIES_DIVERSITY_BONUS);
    const trophic = mult(S.TROPHIC_BONUS);
    const hw = `×${S.HERBIVORE_WEIGHT}`, pw = `×${S.PREDATOR_WEIGHT}`;
    const multLine = `Your scoring multiplier: ×${st.currentMult.toFixed(2)} (${st.speciesCount} species${st.myHasPlant && st.myHasHerb && st.myHasPred ? ' + trophic chain' : ''}).`;

    let body;
    if (round <= st.earlyEnd) {
        body = `PHASE: EARLY (round ${round}/${total}). You have ${ap} AP.\n`
            + `PRIORITY: Plant grass in DIFFERENT regions (spread seeds wide). Spend most of your AP on grass across separate regions, and at least 1 AP on a shrub for early diversity (+${div} species bonus). Remember: each unique species = +${div} to your final score!`;
    } else if (round <= st.midEnd) {
        body = `PHASE: MID GAME (round ${round}/${total}). You have ${ap} AP.\n${multLine}\n`;
        if (!st.myHasHerb) {
            body += `You have NO HERBIVORES — adding one gives +${div} species bonus and moves toward trophic chain (${trophic}). Herbivore energy also counts ${hw}! Deploy a grazer (2 AP) into enemy territory + 2 grass.`;
        } else if (!st.myHasPred && st.enemyHasHerbs) {
            body += `You have no predators. Enemy has ${ctx.census.enemy.herbs} herbivores. A PREDATOR gives +${div} species bonus AND trophic chain ${trophic} AND its energy counts ${pw}. Deploy one! (2 AP) + 2 grass.`;
        } else if (st.behind && st.enemyHasPlants) {
            body += `You are BEHIND. Send GRAZERS into enemy plant territory to destroy biomass. Mix: 1 grazer (2 AP) + 2 grass (2 AP).`;
        } else {
            body += `Diversify! Add species you don't have yet. Each new species = +${div}. Also plant grass in unclaimed regions.`;
        }
    } else {
        body = `PHASE: LATE GAME (round ${round}/${total}). ${total - round} rounds left. You have ${ap} AP.\n${multLine}\n`;
        if (!st.myHasPred && st.myHasHerb) {
            body += `CRITICAL: Add a PREDATOR for trophic chain bonus (${trophic}) + species bonus (+${div}). This could swing the entire game!`;
        } else if (!st.myHasHerb) {
            body += `Add a GRAZER + PREDATOR if possible to unlock trophic chain (${trophic}). Huge scoring opportunity.`;
        } else if (st.behind) {
            body += `BEHIND — aggressive grazer raids on enemy plants + ensure your diversity bonuses are maximized.`;
        } else {
            body += `Protect your lead. Plant grass, ensure all trophic levels survive. Every species alive = +${div}.`;
        }
    }

    // Round arc adapts to match length — a Lightning game shouldn't be played
    // on the 20-round script.
    if (total <= CONFIG.GAME.LIGHTNING_ROUNDS) {
        body = `(SHORT MATCH — only ${total} rounds. Compress your arc: lock in species diversity early, don't over-invest in grass foundation.)\n` + body;
    }
    return body;
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
    return [
        `Spend ALL ${ctx.ap} AP. Pick a spot letter and a species for each action.`,
        `VALID SPECIES NAMES (use EXACTLY one of these, ALL CAPS):\n  Plants: ${g.plant.join(', ')}\n  Herbivores: ${g.herbivore.join(', ')}\n  Predator: ${g.predator.join(', ')}`,
        `IMPORTANT: Write ORIGINAL reasoning and banter. Reference the CURRENT game state (round ${ctx.round}, your species, the score).`,
        `JSON format:\n{"reasoning":"<strategic analysis>","actions":[{"spot":"A","species":"GRASS"},{"spot":"B","species":"GRAZER"}],"banter":"<competitive comment>"}`,
    ].join('\n\n');
}

function composeUser(ctx) {
    const segments = [
        `Round ${ctx.round}/${ctx.total}. You are Player ${ctx.player}. AP: ${ctx.ap}.`,
        matchContextBlock(ctx),
        matchupBlock(ctx),
        ctx.memory || null,
        phaseBlock(ctx),
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
