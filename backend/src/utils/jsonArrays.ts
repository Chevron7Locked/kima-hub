/**
 * The SystemSettings JSON-array guardrails (aiBlockedGenres / aiBlockedArtists)
 * are stored as plain TEXT columns (prisma String?) and cross the DB boundary
 * as strings. These two helpers are the single point where they are
 * stringified / parsed; every consumer deals in string[] only.
 */

export function stringifyStringArray(values: string[] | undefined): string {
    const cleaned = (values ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
    return JSON.stringify(cleaned);
}

export function parseStringArray(value: unknown): string[] {
    if (typeof value !== "string" || value.trim() === "") return [];
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0)
            : [];
    } catch {
        return [];
    }
}
