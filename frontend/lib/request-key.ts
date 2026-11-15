/**
 * A fresh random key for one request that may be retried. Not crypto.randomUUID: it exists only on HTTPS pages, and many
 * servers are reached over plain HTTP, where getRandomValues still works.
 */
export function newRequestKey(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
