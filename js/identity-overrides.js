// Loads the lab-authored identity overrides and feeds them into model-identity so
// renamed/rethemed creatures resolve consistently everywhere. Shared by the game
// (so the HUD/leaderboard/win screens honor a rename) and the avatar lab (so the
// dashboard reflects what it just saved). The `identity` bucket lives in the same
// avatars/lab-overrides.json that holds the still/motion prompt overrides.

import { applyIdentityOverrides } from './model-identity.js';

export async function loadIdentityOverrides(bust) {
    const url = '/avatars/lab-overrides.json' + (bust ? `?t=${Date.now()}` : '');
    let identity = {};
    try {
        const r = await fetch(url);
        if (r.ok) identity = (await r.json()).identity || {};
    } catch { /* offline / not yet written — fall through to empty */ }
    applyIdentityOverrides(identity);
    return identity;
}
