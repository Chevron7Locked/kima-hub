import { Router } from "express";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { wrap } from "./mappers";

export const lyricsRouter = Router();

lyricsRouter.all("/getLyricsBySongId.view", wrap(async (req, res) => {
    const id = req.query.id as string | undefined;
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

    if (!track || !lyrics) {
        return subsonicOk(req, res, { lyricsList: {} });
    }

    const displayArtist = track.album.artist.displayName || track.album.artist.name;
    const displayTitle = track.title;

    const structuredLyrics: Array<Record<string, unknown>> = [];

    if (lyrics.synced_lyrics && lyrics.synced_lyrics.trim()) {
        const lines = lyrics.synced_lyrics
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
                return { start, value: match[4] || "" };
            })
            .filter((line): line is { start: number; value: string } => Boolean(line));

        if (lines.length > 0) {
            structuredLyrics.push({
                displayArtist,
                displayTitle,
                lang: "und",
                synced: true,
                line: lines,
            });
        }
    }

    if (lyrics.plain_lyrics && lyrics.plain_lyrics.trim()) {
        const lines = lyrics.plain_lyrics
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((value) => ({ value }));

        if (lines.length > 0) {
            structuredLyrics.push({
                displayArtist,
                displayTitle,
                lang: "und",
                synced: false,
                line: lines,
            });
        }
    }

    return subsonicOk(req, res, {
        lyricsList: structuredLyrics.length > 0 ? { structuredLyrics } : {},
    });
}));
// getLyrics.view lives in playback.ts.
//
// It was registered here too, but playbackRouter mounts first so this copy was
// dead. playback.ts is also the correct one: Subsonic returns
// <lyrics artist=".." title="..">text</lyrics>, i.e. ATTRIBUTES plus text
// content, which is what its @_artist / @_title / #text shape produces. This
// version emitted artist/title/value as child ELEMENTS, which an XML client
// would not read as the spec describes.
//
// getLyricsBySongId.view above is unique to this file and stays.
