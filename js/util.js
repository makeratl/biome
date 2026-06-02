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
