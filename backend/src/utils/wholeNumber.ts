/**
 * Strict readers for numbers a client sends as a number or as text. `parseInt("7abc")` reads 7 and `Number("")`
 * reads 0; these read only what is the whole value, and answer NaN for anything else so a route can refuse it.
 */

const WHOLE = /^-?\d+$/;
const PLAIN = /^-?(\d+\.?\d*|\.\d+)$/;

function asText(raw: unknown): string | null {
    if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : null;
    if (typeof raw === "string") return raw.trim();
    return null;
}

/** An integer written in full, as a number or as text such as "7" or " 7 ". NaN for anything else. */
export function wholeNumber(raw: unknown): number {
    if (typeof raw === "number") return Number.isSafeInteger(raw) ? raw : NaN;
    const text = asText(raw);
    const n = text !== null && WHOLE.test(text) ? Number(text) : NaN;
    return Number.isSafeInteger(n) ? n : NaN;
}

/** A plain decimal written in full: no exponent, no hex, no trailing text. NaN for anything else. */
export function plainNumber(raw: unknown): number {
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;
    const text = asText(raw);
    return text !== null && PLAIN.test(text) && text !== "." ? Number(text) : NaN;
}
