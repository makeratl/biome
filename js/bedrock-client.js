// Bedrock client helpers — the browser side of the optional AWS Bedrock provider.
//
// OFF by default. A localStorage flag ('biome.use-bedrock') decides whether the
// curated Bedrock models join the pool; the server only signs/charges a Bedrock
// call when one of those models is actually selected. Secrets never reach here —
// they live server-side (.env.local → bedrock.py). This module only reads the
// public model list + running cost estimate and exposes the toggle state.

import { isBedrockModel } from './model-identity.js';

export { isBedrockModel };

const STORAGE_KEY = 'biome.use-bedrock';

// Whether the user has switched Bedrock on. Default off (any non-'1' value).
export function bedrockEnabled() {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

export function setBedrockEnabled(on) {
    try {
        localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
    } catch { /* storage unavailable — toggle just won't persist */ }
}

// The curated Bedrock models the server can invoke, Ollama /api/tags-shaped
// ({ name, size, label, vendor, klass }). Returns [] when Bedrock is unconfigured
// server-side (no AWS creds) or on any error — callers treat [] as "unavailable".
export async function listBedrockModels() {
    try {
        const resp = await fetch('/bedrock/models');
        if (!resp.ok) return [];
        const data = await resp.json();
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

// Running session token/cost estimate ({ inputTokens, outputTokens, costUsd, calls }).
export async function fetchBedrockUsage() {
    try {
        const resp = await fetch('/bedrock/usage');
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}
