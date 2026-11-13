import type { Request } from "express";

/**
 * Subsonic request parameters, read in one place.
 *
 * A Subsonic client may repeat any parameter, so Express hands a route a string, an array of strings, or a nested
 * object when a key is sent as `id[x]=`. A route that casts `req.query.id as string` hides that. Every Subsonic route
 * (and its auth and reply helpers) reads its parameters through here instead, and the lint rule in
 * `eslint.config.mjs` refuses a `req.query` read in those files anywhere else.
 *
 * - `one` for a parameter the spec sends once: the first text value, or undefined. A blank value stays "".
 * - `many` for one the spec lets repeat (`id` on star, unstar, createShare, scrobble and the play queue; `time` on
 *   scrobble; `songId`; `songIdToAdd`; `songIndexToRemove`): every non-blank text value, in the order sent.
 */

function textValues(raw: unknown): string[] {
    const list = Array.isArray(raw) ? raw : [raw];
    return list.filter((v): v is string => typeof v === "string");
}

export function one(req: Pick<Request, "query">, name: string): string | undefined {
    return textValues(req.query[name])[0];
}

export function many(req: Pick<Request, "query">, name: string): string[] {
    return textValues(req.query[name]).filter((v) => v !== "");
}
