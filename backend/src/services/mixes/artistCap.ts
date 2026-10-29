/**
 * The per-artist cap every drawn mix shares: the mood and recipe mixes, and the decade, genre, Random Discovery and
 * More Like mixes. Your Top 20 and Rediscover draw without it.
 */
import { Prisma } from "@prisma/client";
import { UNKNOWN_ARTIST, VARIOUS_ARTISTS_CANONICAL } from "../../utils/artistNormalization";
import { artistIdentityKey } from "../artistIdentity";

/** Fewest songs a mix ships with; a recipe with fewer members has no mix. */
export const MIN_MIX_TRACKS = 8;
/** Songs per artist in a mix; each next cap is used only while the one before leaves fewer than MIN_MIX_TRACKS. */
export const ARTIST_CAPS = [2, 3, Infinity];

/**
 * The identity keys of the album artist rows that name no one (artistSql). Worked out per call, not at load, so the
 * module still loads where artistIdentity is only partly stubbed.
 */
function noOneKeys(): string[] {
    return [artistIdentityKey(VARIOUS_ARTISTS_CANONICAL), artistIdentityKey(UNKNOWN_ARTIST)];
}

/**
 * The artist a song counts toward for the per-artist cap and the one-title-per-artist rule: its album's artist, except
 * on the album artist rows that name no one, Various Artists (every spelling of it is filed under one row) and the
 * Unknown Artist the scanner falls back to, where each song counts as its own artist. So a compilation can fill a mix
 * past the cap, and two songs with one title by different performers both stay. An artist actually named "Unknown
 * Artist" shares that row and is treated the same. A stopgap until each song carries its own artist.
 */
export function artistSql(): Prisma.Sql {
    return Prisma.sql`CASE WHEN ar."identityKey" IN (${Prisma.join(noOneKeys())}) THEN 'song:' || t.id ELSE a."artistId" END`;
}

/** artistSql for an album rather than a song: a compilation by no one counts as its own artist. Aliases a, ar. */
export function albumArtistSql(): Prisma.Sql {
    return Prisma.sql`CASE WHEN ar."identityKey" IN (${Prisma.join(noOneKeys())}) THEN 'album:' || a.id ELSE a."artistId" END`;
}

/** artistSql for a song already read: its id, its album's artist id and that artist's identity key. */
export function songArtistKey(trackId: string, albumArtistId: string, albumArtistIdentityKey: string): string {
    return noOneKeys().includes(albumArtistIdentityKey) ? `song:${trackId}` : albumArtistId;
}

/**
 * The first `limit` of `ordered`, in that order, with the artist cap: at most 2 per artist; while that leaves fewer
 * than MIN_MIX_TRACKS (or than `limit`, if smaller), 3, then no cap.
 */
export function capByArtist(ordered: { id: string; artistId: string }[], limit: number): string[] {
    let picked: string[] = [];
    for (const cap of ARTIST_CAPS) {
        const perArtist = new Map<string, number>();
        picked = [];
        for (const { id, artistId } of ordered) {
            if (picked.length === limit) break;
            const count = perArtist.get(artistId) ?? 0;
            if (count >= cap) continue;
            perArtist.set(artistId, count + 1);
            picked.push(id);
        }
        // A draw asked for fewer than MIN_MIX_TRACKS (a short mood page) keeps its cap once it has them all.
        if (picked.length >= Math.min(limit, MIN_MIX_TRACKS)) break;
    }
    return picked;
}
