// Trophic balance — the single source of truth for "how healthy is this
// ecosystem?", shared by the health orb (js/biosphere.js) and the AI prompt
// (js/prompt.js) so the model reads the SAME evaluation the human sees.
//
// A healthy chain is roughly 9 plants : 3 herbivores : 1 predator — each tier
// about a third of the one below it. Below that ratio a tier has room to grow;
// past it the tier overruns the food beneath it and the whole stack crashes.
//
// Pure: counts in, assessment out. Starvation/events are layered on by callers
// that have them (the orb folds in live starvation; the prompt doesn't need to).

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Assess ONE ecosystem (one player's organisms, or the whole board summed).
export function trophicRead(plants, herbs, preds) {
    plants = plants || 0; herbs = herbs || 0; preds = preds || 0;
    const total = plants + herbs + preds;
    const tiers = (plants > 0) + (herbs > 0) + (preds > 0);
    const idealHerb = plants / 3;
    const idealPred = herbs / 3;

    // Ratio of a tier to what its base can feed. null = no tier present and no
    // base issue; Infinity = the tier exists with NO base beneath it.
    const herbRatio = plants > 0 ? herbs / idealHerb : (herbs > 0 ? Infinity : null);
    const predRatio = herbs > 0 ? preds / idealPred : (preds > 0 ? Infinity : null);

    // Collapse risk: ramps in once a tier exceeds the ~1:3 ratio (small
    // tolerance), saturating ~1.8×; a tier with no base beneath is max risk.
    // Gated by tier size so a 2-on-3 opening doesn't read as collapse.
    const ramp = (r) => (r === Infinity ? 1 : (r == null ? 0 : clamp((r - 1.1) / 0.7, 0, 1)));
    const herbExcess = ramp(herbRatio) * clamp(herbs / 8, 0, 1);
    const predExcess = ramp(predRatio) * clamp(preds / 3, 0, 1);
    const risk = clamp(Math.max(herbExcess, predExcess), 0, 1);

    // Positive balance score (closeness to the ideal pyramid) for calm reads.
    const hScore = plants > 0 ? 1 - clamp(Math.abs(herbs - idealHerb) / Math.max(idealHerb, 1), 0, 1) : 0;
    const rScore = herbs > 0 ? 1 - clamp(Math.abs(preds - idealPred) / Math.max(idealPred, 1), 0, 1) : 0;
    const health = (tiers / 3) * 0.4 + ((hScore + rScore) / 2) * 0.6;

    const noBase = (herbs > 0 && plants === 0) || (preds > 0 && herbs === 0);

    let state;
    if (total === 0) state = 'empty';
    else if (herbs === 0 && preds === 0) state = 'primordial';   // green base, no fauna
    else if (noBase) state = 'collapsing';                        // animals, nothing to eat
    else if (risk > 0.4) state = (herbExcess >= predExcess ? 'overgrazed' : 'top-heavy');
    else if (tiers === 3 && health > 0.6) state = 'balanced';
    else state = 'building';                                       // incomplete but stable

    return {
        plants, herbs, preds, total, tiers,
        idealHerb, idealPred, herbRatio, predRatio,
        risk, health, state, noBase,
        // Headroom under the ideal ratio — "room for ~N more".
        roomHerb: Math.max(0, Math.floor(idealHerb) - herbs),
        roomPred: Math.max(0, Math.floor(idealPred) - preds),
    };
}
