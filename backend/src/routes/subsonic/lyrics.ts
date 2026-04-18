import { Router } from "express";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { wrap } from "./mappers";
import { logger } from "../../utils/logger";
import { lrclibService } from "../../services/lrclib";
import { rateLimiter } from "../../services/rateLimiter";

export const lyricsRouter = Router();

function utf8ByteLength(value: string): number {
    return Buffer.byteLength(value, "utf8");
}

function hasLyrics(lyrics: { plain_lyrics: string | null; synced_lyrics: string | null } | null | undefined) {
    return Boolean(lyrics && ((lyrics.plain_lyrics && lyrics.plain_lyrics.trim()) || (lyrics.synced_lyrics && lyrics.synced_lyrics.trim())));
}

async function fetchAndStoreLyricsForTrack(track: {
    id: string;
    title: string;
    duration: number;
    album: {
        title: string;
        artist: { name: string };
    };
}) {
    const result = await rateLimiter.execute("lrclib", () =>
        lrclibService.fetchLyrics(
            track.title,
            track.album.artist.name || "",
            track.album.title || "",
            track.duration || 0
        )
    );

    if (!result) {
        await prisma.trackLyrics.upsert({
            where: { track_id: track.id },
            create: {
                track_id: track.id,
                source: "none",
            },
            update: {
                source: "none",
                fetched_at: new Date(),
            },
        });

        return null;
    }

    return prisma.trackLyrics.upsert({
        where: { track_id: track.id },
        create: {
            track_id: track.id,
            plain_lyrics: result.plainLyrics,
            synced_lyrics: result.syncedLyrics,
            source: "lrclib",
            lrclib_id: result.id,
        },
        update: {
            plain_lyrics: result.plainLyrics,
            synced_lyrics: result.syncedLyrics,
            source: "lrclib",
            lrclib_id: result.id,
            fetched_at: new Date(),
        },
    });
}

async function resolveLyricsForTrack(track: {
    id: string;
    title: string;
    duration: number;
    album: {
        title: string;
        artist: { name: string };
    };
}, existing: any) {
    if (hasLyrics(existing)) return existing;

    if (existing && existing.source === "none") {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        if (existing.fetched_at && existing.fetched_at > thirtyDaysAgo) {
            return null;
        }
    }

    try {
        return await fetchAndStoreLyricsForTrack(track);
    } catch (error) {
        logger.error("[SubsonicLyrics] LRCLIB fetch failed", error);
        return existing;
    }
}

async function findFallbackLyricsByTrackMetadata(trackId: string, title: string, artistId: string) {
    return prisma.trackLyrics.findFirst({
        where: {
            track_id: { not: trackId },
            OR: [
                { plain_lyrics: { not: null } },
                { synced_lyrics: { not: null } },
            ],
            track: {
                title: { equals: title, mode: "insensitive" },
                album: { artistId },
            },
        },
    });
}

lyricsRouter.all("/getLyricsBySongId.view", wrap(async (req, res) => {
    const id = req.query.id as string | undefined;
    const enhanced = String(req.query.enhanced || "false").toLowerCase() === "true";
    const requestId = res.locals.subsonicRequestId as string | undefined;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const [track, lyrics] = await Promise.all([
        prisma.track.findUnique({
            where: { id },
            include: {
                album: {
                    include: {
                        artist: { select: { name: true, displayName: true } },
                    },
                },
            },
        }),
        prisma.trackLyrics.findUnique({ where: { track_id: id } }),
    ]);

    if (!track) {
        logger.debug("[SubsonicLyrics] Track not found for getLyricsBySongId", { requestId, trackId: id });
        return subsonicOk(req, res, { lyricsList: {} });
    }

    let resolvedLyrics = lyrics;
    if (!hasLyrics(resolvedLyrics)) {
        resolvedLyrics = await findFallbackLyricsByTrackMetadata(
            track.id,
            track.title,
            track.album.artistId
        );
    }

    if (!hasLyrics(resolvedLyrics)) {
        resolvedLyrics = await resolveLyricsForTrack(track, lyrics);
    }

    if (!hasLyrics(resolvedLyrics)) {
        logger.debug("[SubsonicLyrics] No lyrics found for getLyricsBySongId", {
            requestId,
            trackId: id,
            title: track.title,
            artistId: track.album.artistId,
        });
        return subsonicOk(req, res, { lyricsList: {} });
    }

    if (!resolvedLyrics) {
        return subsonicOk(req, res, { lyricsList: {} });
    }

    const displayArtist = track.album.artist.displayName || track.album.artist.name;
    const displayTitle = track.title;

    const structuredLyrics: Array<Record<string, unknown>> = [];
    const pushStructured = (entry: Record<string, unknown>) => {
        if (enhanced) {
            entry.kind = "main";
        }
        structuredLyrics.push(entry);
    };

    if (resolvedLyrics.synced_lyrics && resolvedLyrics.synced_lyrics.trim()) {
        const lines = resolvedLyrics.synced_lyrics
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const match = line.match(/^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$/);
                if (!match) return null;
                const min = parseInt(match[1], 10);
                const sec = parseInt(match[2], 10);
                const fracRaw = match[3] || "0";
                const fracMs = fracRaw.length === 1
                    ? parseInt(fracRaw, 10) * 100
                    : fracRaw.length === 2
                    ? parseInt(fracRaw, 10) * 10
                    : parseInt(fracRaw.slice(0, 3), 10);
                const start = min * 60000 + sec * 1000 + fracMs;
                return {
                    "@_start": start,
                    "#text": match[4] || "",
                };
            })
            .filter((line): line is { "@_start": number; "#text": string } => Boolean(line));

        if (lines.length > 0) {
            const entry: Record<string, unknown> = {
                "@_displayArtist": displayArtist,
                "@_displayTitle": displayTitle,
                "@_lang": "und",
                "@_synced": true,
                line: lines,
            };

            if (enhanced) {
                const cueLine = lines.map((line, index) => {
                    const nextStart = index < lines.length - 1 ? lines[index + 1]["@_start"] : undefined;
                    const cue = {
                        start: line["@_start"],
                        ...(nextStart !== undefined ? { end: nextStart } : {}),
                        value: line["#text"],
                        byteStart: 0,
                        byteEnd: Math.max(0, utf8ByteLength(line["#text"]) - 1),
                    };

                    return {
                        index,
                        start: line["@_start"],
                        ...(nextStart !== undefined ? { end: nextStart } : {}),
                        value: line["#text"],
                        cue: [cue],
                    };
                });

                entry.cueLine = cueLine;
            }

            pushStructured(entry);
        }
    }

    if (resolvedLyrics.plain_lyrics && resolvedLyrics.plain_lyrics.trim()) {
        const lines = resolvedLyrics.plain_lyrics
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((value) => ({ "#text": value }));

        if (lines.length > 0) {
            pushStructured({
                "@_displayArtist": displayArtist,
                "@_displayTitle": displayTitle,
                "@_lang": "und",
                "@_synced": false,
                line: lines,
            });
        }
    }

    return subsonicOk(req, res, {
        lyricsList: structuredLyrics.length > 0 ? { structuredLyrics } : {},
    });
}));

lyricsRouter.all("/getLyrics.view", wrap(async (req, res) => {
    const title = req.query.title as string | undefined;
    const artist = req.query.artist as string | undefined;
    const requestId = res.locals.subsonicRequestId as string | undefined;

    if (!title && !artist) {
        return subsonicOk(req, res, { lyrics: {} });
    }

    const track = await prisma.track.findFirst({
        where: {
            ...(title ? { title: { contains: title, mode: "insensitive" } } : {}),
            ...(artist
                ? {
                      album: {
                          artist: {
                              OR: [
                                  { name: { contains: artist, mode: "insensitive" } },
                                  { displayName: { contains: artist, mode: "insensitive" } },
                              ],
                          },
                      },
                  }
                : {}),
        },
        include: {
            album: {
                include: {
                    artist: { select: { name: true, displayName: true } },
                },
            },
        },
    });

    if (!track) {
        logger.debug("[SubsonicLyrics] No track matched getLyrics query", { requestId, title, artist });
        return subsonicOk(req, res, { lyrics: {} });
    }

    const existingLyrics = await prisma.trackLyrics.findUnique({ where: { track_id: track.id } });
    const lyrics = await resolveLyricsForTrack(track, existingLyrics);

    if (!hasLyrics(lyrics)) {
        logger.debug("[SubsonicLyrics] Matched track without lyrics for getLyrics", {
            requestId,
            trackId: track.id,
            title: track.title,
        });
        return subsonicOk(req, res, { lyrics: {} });
    }

    const displayArtist = track.album.artist.displayName || track.album.artist.name;
    const value = lyrics.plain_lyrics || lyrics.synced_lyrics || "";

    return subsonicOk(req, res, {
        lyrics: {
            artist: displayArtist,
            title: track.title,
            value,
        },
    });
}));