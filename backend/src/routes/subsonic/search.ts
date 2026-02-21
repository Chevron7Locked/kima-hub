import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { searchService } from "../../services/search";

export const searchRouter = Router();

function wrap(fn: (req: Request, res: Response) => Promise<void | Response>) {
    return (req: Request, res: Response) => {
        fn(req, res).catch((err: unknown) => {
            if (!res.headersSent) {
                const msg = err instanceof Error ? err.message : "Internal error";
                subsonicError(req, res, SubsonicError.GENERIC, msg);
            }
        });
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function parseIntParam(raw: string | undefined, defaultVal: number): number {
    if (raw === undefined || raw === "") return defaultVal;
    const n = parseInt(raw, 10);
    return isNaN(n) ? defaultVal : n;
}

// ===================== SEARCH =====================

searchRouter.all(["/search3.view", "/search2.view"], wrap(async (req, res) => {
    const query = (req.query.query as string | undefined) ?? "";

    const artistCount = clamp(parseIntParam(req.query.artistCount as string | undefined, 20), 0, 500);
    const albumCount  = clamp(parseIntParam(req.query.albumCount  as string | undefined, 20), 0, 500);
    const songCount   = clamp(parseIntParam(req.query.songCount   as string | undefined, 20), 0, 500);
    const artistOffset = Math.max(0, parseIntParam(req.query.artistOffset as string | undefined, 0));
    const albumOffset  = Math.max(0, parseIntParam(req.query.albumOffset  as string | undefined, 0));
    const songOffset   = Math.max(0, parseIntParam(req.query.songOffset   as string | undefined, 0));

    const isSearch3 = req.path.startsWith("/search3");
    const responseKey = isSearch3 ? "searchResult3" : "searchResult2";

    if (!query.trim()) {
        return subsonicOk(req, res, { [responseKey]: {} });
    }

    const [artists, albums, tracks] = await Promise.all([
        artistCount > 0
            ? searchService.searchArtists({ query, limit: artistCount, offset: artistOffset })
            : Promise.resolve([]),
        albumCount > 0
            ? searchService.searchAlbums({ query, limit: albumCount, offset: albumOffset })
            : Promise.resolve([]),
        songCount > 0
            ? searchService.searchTracks({ query, limit: songCount, offset: songOffset })
            : Promise.resolve([]),
    ]);

    const result: Record<string, unknown> = {};

    if (artists.length > 0) {
        result.artist = artists.map((a) => ({
            "@_id": a.id,
            "@_name": a.name,
            "@_coverArt": `ar-${a.id}`,
        }));
    }

    if (albums.length > 0) {
        result.album = albums.map((al) => ({
            "@_id": al.id,
            "@_name": al.title,
            "@_artist": al.artistName,
            "@_artistId": al.artistId,
            "@_coverArt": al.id,
            "@_year": al.year || undefined,
        }));
    }

    if (tracks.length > 0) {
        result.song = tracks.map((t) => ({
            "@_id": t.id,
            "@_title": t.title,
            "@_album": t.albumTitle,
            "@_artist": t.artistName,
            "@_artistId": t.artistId,
            "@_albumId": t.albumId,
            "@_coverArt": t.albumId,
            "@_duration": t.duration ? Math.round(t.duration) : 0,
            "@_type": "music",
        }));
    }

    return subsonicOk(req, res, { [responseKey]: result });
}));

// ===================== RANDOM SONGS =====================

searchRouter.all("/getRandomSongs.view", wrap(async (req, res) => {
    const size  = clamp(parseIntParam(req.query.size as string | undefined, 10), 1, 500);
    const genre = req.query.genre as string | undefined;
    const fromYear = req.query.fromYear !== undefined && req.query.fromYear !== ""
        ? parseInt(req.query.fromYear as string, 10)
        : undefined;
    const toYear = req.query.toYear !== undefined && req.query.toYear !== ""
        ? parseInt(req.query.toYear as string, 10)
        : undefined;

    const whereConditions: Prisma.Sql[] = [Prisma.sql`t."filePath" IS NOT NULL`];

    if (fromYear !== undefined && toYear !== undefined && !isNaN(fromYear) && !isNaN(toYear)) {
        const lo = Math.min(fromYear, toYear);
        const hi = Math.max(fromYear, toYear);
        whereConditions.push(Prisma.sql`al.year BETWEEN ${lo} AND ${hi}`);
    }

    if (genre) {
        whereConditions.push(Prisma.sql`al.genres::text ILIKE ${"%" + genre + "%"}`);
    }

    const whereClause = Prisma.join(whereConditions, " AND ");

    const rows = await prisma.$queryRaw<{
        id: string;
        title: string;
        trackNo: number | null;
        duration: number | null;
        mime: string | null;
        fileSize: number | null;
        albumId: string;
        albumTitle: string;
        albumYear: number | null;
        artistId: string;
        artistName: string;
    }[]>`
        SELECT t.id, t.title, t."trackNo", t.duration, t.mime, t."fileSize",
               al.id AS "albumId", al.title AS "albumTitle", al.year AS "albumYear",
               ar.id AS "artistId", ar.name AS "artistName"
        FROM "Track" t
        JOIN "Album" al ON t."albumId" = al.id
        JOIN "Artist" ar ON al."artistId" = ar.id
        WHERE ${whereClause}
        ORDER BY RANDOM()
        LIMIT ${size}
    `;

    const songs = rows.map((r) => ({
        "@_id": r.id,
        "@_title": r.title,
        "@_album": r.albumTitle,
        "@_artist": r.artistName,
        "@_artistId": r.artistId,
        "@_albumId": r.albumId,
        "@_coverArt": r.albumId,
        "@_duration": r.duration ? Math.round(r.duration) : 0,
        "@_track": r.trackNo || undefined,
        "@_year": r.albumYear || undefined,
        "@_contentType": r.mime || "audio/mpeg",
        "@_size": r.fileSize ?? undefined,
        "@_type": "music",
    }));

    return subsonicOk(req, res, {
        randomSongs: songs.length > 0 ? { song: songs } : {},
    });
}));
