// Small shared helpers with no dependencies.

// Short random hex id. `crypto.randomUUID()` is gated to *secure contexts*
// (HTTPS or localhost), so it's `undefined` — and throws — when Biome is opened
// over plain HTTP on a LAN IP (e.g. http://192.168.0.34:8765). `getRandomValues`
// IS available in insecure contexts, so we mint our short ids from it instead.
export function shortId(len = 8) {
    const bytes = new Uint8Array(Math.ceil(len / 2));
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

// Pull valid JSON out of a model's text. Approaches, in order:
// 1. Direct parse (model obeyed "respond ONLY with JSON")
// 2. Strip markdown code fences (```json … ``` or ``` … ```)
// 3. Brace-matching scan right-to-left (for models that wrap JSON in prose)
// Returns the parsed object, or null if nothing parseable is found. Shared by
// the game AI (ai.js) and the Vision Lab (vision-lab.js).
export function extractJSON(str) {
    if (!str) return null;

    // Try direct parse first
    try { return JSON.parse(str); } catch {}

    // Strip markdown code fences
    const fenced = str.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenced) {
        try { return JSON.parse(fenced[1].trim()); } catch {}
    }

    // Right-to-left brace scan — get the model's final JSON output.
    //
    // Bounded on purpose. The naive form ("try every '{', scan forward to its
    // match") is O(opens × len): when nothing parses it degrades to len² work,
    // run synchronously on the main thread. Large cloud reasoning models (Cogito,
    // Minimax, …) emit tens of thousands of '{' in their chain-of-thought, and
    // this runs on that raw `thinking` blob (see ai.js) — enough to freeze the tab
    // for minutes. The action JSON we want is small and at the END of the output,
    // so we only try the last MAX_OPENS open-braces and cap each forward scan at
    // MAX_SPAN. That keeps a pathological input to a brief bounded cost instead of
    // a hang, while still finding the trailing object in every normal case.
    const MAX_OPENS = 500;       // only the last N '{' — the real object is at the tail
    const MAX_SPAN = 100000;     // a real action object is tiny; bound the forward scan
    const allOpens = [...str.matchAll(/\{/g)].map(m => m.index);
    const opens = allOpens.slice(-MAX_OPENS).reverse();
    for (const start of opens) {
        // Find the matching closing brace by tracking depth
        let depth = 0;
        const end = Math.min(str.length, start + MAX_SPAN);
        for (let i = start; i < end; i++) {
            if (str[i] === '{') depth++;
            else if (str[i] === '}') depth--;
            if (depth === 0) {
                try { return JSON.parse(str.slice(start, i + 1)); } catch { break; }
            }
        }
    }
    return null;
}
