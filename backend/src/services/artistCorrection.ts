/**
 * Artist names to MusicBrainz identity. resolveArtistMbid is the one checked
 * lookup for any stored artist id; getArtistCorrection repairs a typed name
 * ("of mice" → "Of Mice & Men") before Lidarr or Soulseek acquisition.
 */

import * as fuzz from "fuzzball";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { prisma } from "../utils/db";
import { musicBrainzService } from "./musicbrainz";
import { absent, answered, failureCause, Outcome } from "../utils/outcome";
import { normalizeArtistName } from "./artistIdentity";
import { stripEditionNote } from "../utils/normalization";
import { isGenericAlbumTitle, titlesAgree } from "./albumIdentity";

export interface ArtistCorrection {
    corrected: boolean;
    canonicalName: string;
    mbid?: string;
}

/** 30 days: corrections rarely change. */
const CORRECTION_TTL = 2592000;

/**
 * Strip collaboration/edition noise from an artist name before searching.
 * "Gun N' Roses (feat. Codex)" → "Gun N' Roses"
 * "The Beatles [2009 Remaster]" → "The Beatles"
 */
export function stripArtistSuffixes(name: string): string {
    let cleaned = name
        .replace(
            /\s*[\[(](?:feat|ft|featuring|with)\.?\s+[^\])]*[\])]/gi,
            ""
        )
        .replace(
            /\s*[\[(](?:\d{4} )?(?:remaster|remastered|deluxe|expanded|anniversary|bonus|special|mono|stereo)(?:\s+edition)?[^\])]*[\])]/gi,
            ""
        )
        .trim();
    cleaned = stripEditionNote(cleaned).trim();
    if (!cleaned || cleaned.length < 2) cleaned = name.trim();
    return cleaned;
}

/**
 * Resolve a possibly-messy artist name to its canonical form.
 * Returns null, meaning "keep the original name", when nothing confident was found.
 */
export async function getArtistCorrection(
    artistName: string
): Promise<ArtistCorrection | null> {
    const cacheKey = `mb:correction:${artistName.toLowerCase().trim()}`;

    try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            return cached === "null" ? null : (JSON.parse(cached) as ArtistCorrection);
        }
    } catch (err) {
        logger.warn("Redis get error:", err);
    }

    const cleaned = stripArtistSuffixes(artistName);

    try {
        const found = await musicBrainzService.searchArtist(cleaned, 5);

        if (
            found.kind === "rateLimited" ||
            found.kind === "transient" ||
            found.kind === "permanent"
        ) {
            logger.warn(
                `MB correction ${found.kind} for ${artistName}: ${failureCause(found)}`
            );
            // Do NOT cache failures — a timeout must not freeze a
            // correction (or its absence) for 30 days.
            return null;
        }
        const candidates = found.kind === "answered" ? found.value : [];

        // Token-set scoring gives any name containing the typed words 100, so an
        // artist whose name is exactly what was typed always wins.
        const wanted = normalizeArtistName(cleaned);
        const scored = candidates
            .map((a) => ({
                name: a.name,
                mbid: a.id,
                exact: normalizeArtistName(a.name) === wanted,
                score: fuzzyScore(cleaned, a.name),
            }))
            .filter((c) => c.exact || c.score >= 90)
            .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);

        const best = scored[0];
        if (!best) {
            await redisClient.setex(cacheKey, CORRECTION_TTL, "null");
            return null;
        }

        const result: ArtistCorrection = {
            corrected:
                normalizeArtistName(best.name) !== normalizeArtistName(artistName),
            canonicalName: best.name,
            mbid: best.mbid || undefined,
        };

        await redisClient.setex(cacheKey, CORRECTION_TTL, JSON.stringify(result));
        return result;
    } catch (error: any) {
        logger.warn(
            `MB correction error for ${artistName}: ${error?.message || error}`
        );
        return null;
    }
}

function fuzzyScore(a: string, b: string): number {
    return fuzz.token_set_ratio(
        normalizeArtistName(a),
        normalizeArtistName(b)
    );
}

export interface ResolvedArtist {
    mbid: string;
    name: string;
}

/** Same-named artists whose catalogues are checked before giving up. */
const MAX_CATALOGUE_CHECKS = 3;

/** Resolve an artist's MusicBrainz id from its own discography. */
export async function resolveArtistMbidFromDiscography(
    artistId: string,
    artistName: string
): Promise<Outcome<ResolvedArtist>> {
    const albums = await prisma.album.findMany({
        where: { artistId },
        select: { title: true },
    });
    return resolveArtistMbid(artistName, albums.map((album) => album.title));
}

/**
 * The one way an artist name becomes a MusicBrainz id. A candidate must carry
 * the name, or an alias, exactly once folded. Callers that store the id pass
 * the artist's album titles: the catalogue must hold one, and a shared name
 * with no usable title is refused. Without titles the top name match is used.
 */
export async function resolveArtistMbid(
    artistName: string,
    albumTitles?: string[],
    opts: { interactive?: boolean } = {}
): Promise<Outcome<ResolvedArtist>> {
    const query = stripArtistSuffixes(artistName);
    const wanted = normalizeArtistName(query);
    if (!wanted) return absent({ artistName });

    const found = await musicBrainzService.searchArtist(query, 10, opts);
    if (found.kind !== "answered") return found;

    const named = found.value.filter((candidate: any) =>
        [candidate.name, ...(candidate.aliases ?? []).map((alias: any) => alias.name)].some(
            (name) => typeof name === "string" && normalizeArtistName(name) === wanted
        )
    );
    if (named.length === 0) {
        return absent({ artistName, hits: found.value.length });
    }

    const titles = (albumTitles ?? []).filter((title) => !isGenericAlbumTitle(title));
    if (titles.length === 0) {
        if (albumTitles && named.length > 1) {
            return absent({ artistName, ambiguous: named.length });
        }
        return answered(
            { mbid: named[0].id, name: named[0].name },
            { artistName, by: "name" }
        );
    }

    for (const candidate of named.slice(0, MAX_CATALOGUE_CHECKS)) {
        const catalogue = await musicBrainzService.getAllReleaseGroups(
            candidate.id,
            ["album", "ep", "single"],
            opts
        );
        if (catalogue.kind === "absent") continue;
        if (catalogue.kind !== "answered") return catalogue;
        const match = catalogue.value.find((group: any) =>
            titles.some((title) => titlesAgree(group.title, title))
        );
        if (match) {
            return answered(
                { mbid: candidate.id, name: candidate.name },
                { artistName, by: "catalogue", album: match.title }
            );
        }
    }
    return absent({ artistName, candidates: named.length });
}
