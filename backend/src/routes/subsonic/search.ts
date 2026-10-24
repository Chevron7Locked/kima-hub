import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { searchService } from "../../services/search";
import { wrap, clamp, parseIntParam, firstArtistGenre, mapSong } from "./mappers";
import { LIBRARY_LOCATION } from "../../services/libraryFilters";
import { artistGenresSql } from "../../utils/genreSql";

export const searchRouter = Router();

// ===================== SEARCH =====================

searchRouter.all(["/search3.view", "/search2.view", "/search.view"], wrap(async (req, res) => {
    const query = (req.query.query as string | undefined) ?? "";

    const artistCount = clamp(parseIntParam(req.query.artistCount as string | undefined, 20), 0, 500);
    const albumCount  = clamp(parseIntParam(req.query.albumCount  as string | undefined, 20), 0, 500);
    const songCount   = clamp(parseIntParam(req.query.songCount   as string | undefined, 20), 0, 500);
    const artistOffset = Math.max(0, parseIntParam(req.query.artistOffset as string | undefined, 0));
    const albumOffset  = Math.max(0, parseIntParam(req.query.albumOffset  as string | undefined, 0));
    const songOffset   = Math.max(0, parseIntParam(req.query.songOffset   as string | undefined, 0));

    const responseKey = req.path.startsWith("/search3")
        ? "searchResult3"
        : req.path.startsWith("/search2")
          ? "searchResult2"
          : "searchResult";

    // OpenSubsonic clients (Symfonium, DSub, Substreamer) sync by paginating
    // search3 over an empty query: `query=`, a missing query, or the literal
    // two-quote string some clients send. That enumerates the library;
    // anything else is a ranked search.
    const trimmed = query.trim();
    const enumerateLibrary = !trimmed || trimmed === "\"\"";

    let artists: { id: string; name: string }[];
    let rawAlbums: { id: string; title: string; artistId: string; artistName: string; year: number | null }[];
    let tracks: { id: string; title: string; artistId: string; artistName: string; albumId: string; albumTitle: string; duration: number | null }[];

    if (enumerateLibrary) {
        [artists, rawAlbums, tracks] = await Promise.all([
            artistCount > 0
                ? prisma.$queryRaw<{ id: string; name: string }[]>`
                      SELECT ar.id, ar.name FROM "Artist" ar
                      WHERE ar."libraryAlbumCount" > 0
                      ORDER BY LOWER(ar.name) ASC, ar.id ASC
                      LIMIT ${artistCount} OFFSET ${artistOffset}`
                : Promise.resolve([]),
            albumCount > 0
                ? prisma.$queryRaw<{ id: string; title: string; artistId: string; artistName: string; year: number | null }[]>`
                      SELECT al.id, al.title, al."artistId", ar.name AS "artistName", al.year
                      FROM "Album" al JOIN "Artist" ar ON al."artistId" = ar.id
                      WHERE al.location = 'LIBRARY'
                      ORDER BY LOWER(al.title) ASC, al.id ASC
                      LIMIT ${albumCount} OFFSET ${albumOffset}`
                : Promise.resolve([]),
            songCount > 0
                ? prisma.$queryRaw<{ id: string; title: string; artistId: string; artistName: string; albumId: string; albumTitle: string; duration: number | null }[]>`
                      SELECT t.id, t.title, al."artistId", ar.name AS "artistName",
                             t."albumId", al.title AS "albumTitle", t.duration
                      FROM "Track" t
                      JOIN "Album" al ON t."albumId" = al.id
                      JOIN "Artist" ar ON al."artistId" = ar.id
                      WHERE al.location = 'LIBRARY' AND t.corrupt = false AND t."missingSince" IS NULL
                      ORDER BY LOWER(t.title) ASC, t.id ASC
                      LIMIT ${songCount} OFFSET ${songOffset}`
                : Promise.resolve([]),
        ]);
    } else {
        [artists, rawAlbums, tracks] = await Promise.all([
            artistCount > 0
                ? searchService
                      .searchArtists({ query, limit: artistCount, offset: artistOffset })
                      .then((rows) => rows.map((a) => ({ id: a.id, name: a.name })))
                : Promise.resolve([]),
            albumCount > 0
                ? searchService
                      .searchAlbums({ query, limit: albumCount, offset: albumOffset })
                      .then((rows) =>
                          rows.map((al) => ({
                              id: al.id,
                              title: al.title,
                              artistId: al.artistId,
                              artistName: al.artistName,
                              year: al.year ?? null,
                          }))
                      )
                : Promise.resolve([]),
            songCount > 0
                ? searchService
                      .searchTracks({ query, limit: songCount, offset: songOffset })
                      .then((rows) =>
                          rows.map((t) => ({
                              id: t.id,
                              title: t.title,
                              artistId: t.artistId,
                              artistName: t.artistName,
                              albumId: t.albumId,
                              albumTitle: t.albumTitle,
                              duration: t.duration ?? null,
                          }))
                      )
                : Promise.resolve([]),
        ]);
    }

    // Exclude DISCOVER albums — only library content is visible via Subsonic.
    // The enumeration path already filters to LIBRARY at the query.
    let albums = rawAlbums;
    if (!enumerateLibrary && rawAlbums.length > 0) {
        const libraryIds = new Set(
            (await prisma.album.findMany({
                where: { id: { in: rawAlbums.map((a) => a.id) }, location: LIBRARY_LOCATION },
                select: { id: true },
            })).map((a) => a.id)
        );
        albums = rawAlbums.filter((a) => libraryIds.has(a.id));
    }

    // Batch-fetch artist genres for all results in one query
    const artistIds = new Set([
        ...albums.map((al) => al.artistId),
        ...tracks.map((t) => t.artistId),
    ]);
    const artistGenreRows = artistIds.size > 0
        ? await prisma.artist.findMany({
              where: { id: { in: [...artistIds] } },
              select: { id: true, genres: true, userGenres: true },
          })
        : [];
    const genreMap = new Map(artistGenreRows.map((a) => [a.id, firstArtistGenre(a.genres, a.userGenres)]));

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
            "@_genre": genreMap.get(al.artistId) || undefined,
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
            "@_genre": genreMap.get(t.artistId) || undefined,
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

    const whereConditions: Prisma.Sql[] = [
        Prisma.sql`t."filePath" IS NOT NULL`,
        Prisma.sql`al.location = 'LIBRARY'`,
    ];

    if (fromYear !== undefined && !isNaN(fromYear) && toYear !== undefined && !isNaN(toYear)) {
        const lo = Math.min(fromYear, toYear);
        const hi = Math.max(fromYear, toYear);
        whereConditions.push(Prisma.sql`al.year BETWEEN ${lo} AND ${hi}`);
    } else if (fromYear !== undefined && !isNaN(fromYear)) {
        whereConditions.push(Prisma.sql`al.year >= ${fromYear}`);
    } else if (toYear !== undefined && !isNaN(toYear)) {
        whereConditions.push(Prisma.sql`al.year <= ${toYear}`);
    }

    if (genre) {
        // Genre lives on Artist, not Album — filter via artist's enriched genres
        whereConditions.push(Prisma.sql`EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${artistGenresSql("ar")}) g WHERE g ILIKE '%' || ${genre} || '%'
        )`);
    }

    const whereClause = Prisma.join(whereConditions, " AND ");

    const rows = await prisma.$queryRaw<{
        id: string;
        title: string;
        trackNo: number | null;
        discNumber: number | null;
        duration: number | null;
        mime: string | null;
        fileSize: number | null;
        albumId: string;
        albumTitle: string;
        albumYear: number | null;
        artistId: string;
        artistName: string;
        artistGenres: unknown;
        artistUserGenres: unknown;
    }[]>`
        SELECT t.id, t.title, t."trackNo", t."discNumber", t.duration, t.mime, t."fileSize",
               al.id AS "albumId", al.title AS "albumTitle", al.year AS "albumYear",
               ar.id AS "artistId", ar.name AS "artistName",
               ar.genres AS "artistGenres", ar."userGenres" AS "artistUserGenres"
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
        "@_discNumber": r.discNumber ?? undefined,
        "@_year": r.albumYear || undefined,
        "@_contentType": r.mime || "audio/mpeg",
        "@_size": r.fileSize ?? undefined,
        "@_type": "music",
        "@_genre": firstArtistGenre(r.artistGenres, r.artistUserGenres) || undefined,
    }));

    return subsonicOk(req, res, {
        randomSongs: songs.length > 0 ? { song: songs } : {},
    });
}));

// ===================== SONGS BY GENRE =====================

searchRouter.all("/getSongsByGenre.view", wrap(async (req, res) => {
    const genre = req.query.genre as string | undefined;
    if (!genre) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: genre");
    }

    const count = clamp(parseIntParam(req.query.count as string | undefined, 50), 1, 500);
    const offset = Math.max(0, parseIntParam(req.query.offset as string | undefined, 0));

    const rows = await prisma.$queryRaw<{
        id: string;
        title: string;
        trackNo: number | null;
        discNumber: number | null;
        duration: number | null;
        mime: string | null;
        fileSize: number | null;
        albumId: string;
        albumTitle: string;
        albumDisplayTitle: string | null;
        albumYear: number | null;
        artistId: string;
        artistName: string;
        artistDisplayName: string | null;
        artistGenres: unknown;
        artistUserGenres: unknown;
    }[]>`
        SELECT t.id, t.title, t."trackNo", t."discNumber", t.duration, t.mime, t."fileSize",
               al.id AS "albumId", al.title AS "albumTitle", al."displayTitle" AS "albumDisplayTitle", al.year AS "albumYear",
               ar.id AS "artistId", ar.name AS "artistName", ar."displayName" AS "artistDisplayName",
               ar.genres AS "artistGenres", ar."userGenres" AS "artistUserGenres"
        FROM "Track" t
        JOIN "Album" al ON t."albumId" = al.id
        JOIN "Artist" ar ON al."artistId" = ar.id
        WHERE t.corrupt = false
          AND t."missingSince" IS NULL
          AND al.location = 'LIBRARY'
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(${artistGenresSql("ar")}) g WHERE g ILIKE '%' || ${genre} || '%'
          )
        ORDER BY LOWER(t.title) ASC, t.title ASC
        OFFSET ${offset}
        LIMIT ${count}
    `;

    const songs = rows.map((row) => {
        const artistName = row.artistDisplayName || row.artistName;
        const songGenre = firstArtistGenre(row.artistGenres, row.artistUserGenres);
        return mapSong(
            {
                id: row.id,
                title: row.title,
                trackNo: row.trackNo,
                discNumber: row.discNumber,
                duration: row.duration,
                filePath: null,
                mime: row.mime,
                fileSize: row.fileSize,
            },
            {
                id: row.albumId,
                title: row.albumTitle,
                displayTitle: row.albumDisplayTitle,
                year: row.albumYear,
            },
            artistName,
            row.artistId,
            songGenre
        );
    });

    return subsonicOk(req, res, {
        songsByGenre: songs.length > 0 ? { song: songs } : {},
    });
}));

// ===================== TOP SONGS =====================

searchRouter.all("/getTopSongs.view", wrap(async (req, res) => {
    const artistParam = req.query.artist as string | undefined;
    if (!artistParam) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: artist");
    }

    const count = clamp(parseIntParam(req.query.count as string | undefined, 50), 1, 500);

    const artist = await prisma.artist.findFirst({
        where: {
            OR: [
                { name: { equals: artistParam, mode: "insensitive" } },
                { displayName: { equals: artistParam, mode: "insensitive" } },
                { name: { contains: artistParam, mode: "insensitive" } },
                { displayName: { contains: artistParam, mode: "insensitive" } },
            ],
            libraryAlbumCount: { gt: 0 },
        },
        select: { id: true, name: true, displayName: true, genres: true, userGenres: true },
    });

    if (!artist) {
        return subsonicOk(req, res, { topSongs: {} });
    }

    const rows = await prisma.$queryRaw<{
        id: string;
        title: string;
        trackNo: number | null;
        discNumber: number | null;
        duration: number | null;
        mime: string | null;
        fileSize: number | null;
        albumId: string;
        albumTitle: string;
        albumDisplayTitle: string | null;
        albumYear: number | null;
        playCount: number;
    }[]>`
        SELECT t.id, t.title, t."trackNo", t."discNumber", t.duration, t.mime, t."fileSize",
               al.id AS "albumId", al.title AS "albumTitle", al."displayTitle" AS "albumDisplayTitle", al.year AS "albumYear",
               COUNT(p.id)::int AS "playCount"
        FROM "Track" t
        JOIN "Album" al ON t."albumId" = al.id
        LEFT JOIN "Play" p ON p."trackId" = t.id
        WHERE al.location = 'LIBRARY'
          AND al."artistId" = ${artist.id}
        GROUP BY t.id, t.title, t."trackNo", t."discNumber", t.duration, t.mime, t."fileSize",
                 al.id, al.title, al."displayTitle", al.year
        ORDER BY "playCount" DESC, LOWER(t.title) ASC, t.title ASC
        LIMIT ${count}
    `;

    const artistName = artist.displayName || artist.name;
    const genre = firstArtistGenre(artist.genres, artist.userGenres);

    const songs = rows.map((row) =>
        mapSong(
            {
                id: row.id,
                title: row.title,
                trackNo: row.trackNo,
                discNumber: row.discNumber,
                duration: row.duration,
                filePath: null,
                mime: row.mime,
                fileSize: row.fileSize,
            },
            {
                id: row.albumId,
                title: row.albumTitle,
                displayTitle: row.albumDisplayTitle,
                year: row.albumYear,
            },
            artistName,
            artist.id,
            genre
        )
    );

    return subsonicOk(req, res, {
        topSongs: songs.length > 0 ? { song: songs } : {},
    });
}));

// ===================== SIMILAR SONGS =====================

searchRouter.all(["/getSimilarSongs2.view", "/getSimilarSongs.view"], wrap(async (req, res) => {
    const id = req.query.id as string | undefined;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const count = clamp(parseIntParam(req.query.count as string | undefined, 50), 1, 500);

    // `id` may be an artist, album or song; clients usually send a song id.
    let artistId: string | null = null;
    const track = await prisma.track.findUnique({
        where: { id },
        select: { album: { select: { artistId: true } } },
    });
    if (track) {
        artistId = track.album.artistId;
    } else {
        const album = await prisma.album.findUnique({
            where: { id },
            select: { artistId: true },
        });
        artistId =
            album?.artistId ??
            (await prisma.artist.findUnique({ where: { id }, select: { id: true } }))?.id ??
            null;
    }

    if (!artistId) {
        const emptyKey = req.path.startsWith("/getSimilarSongs2") ? "similarSongs2" : "similarSongs";
        return subsonicOk(req, res, { [emptyKey]: {} });
    }

    const similarArtists = await prisma.similarArtist.findMany({
        where: {
            fromArtistId: artistId,
            toArtist: { libraryAlbumCount: { gt: 0 } },
        },
        orderBy: { weight: "desc" },
        take: 50,
        select: { toArtistId: true },
    });

    const artistIds = Array.from(
        new Set([artistId, ...similarArtists.map((item) => item.toArtistId)])
    );

    if (artistIds.length === 0) {
        const emptyKey = req.path.startsWith("/getSimilarSongs2") ? "similarSongs2" : "similarSongs";
        return subsonicOk(req, res, { [emptyKey]: {} });
    }

    const artistIdList = artistIds.map((artistId) => Prisma.sql`${artistId}`);

    const rows = await prisma.$queryRaw<{
        id: string;
        title: string;
        trackNo: number | null;
        discNumber: number | null;
        duration: number | null;
        mime: string | null;
        fileSize: number | null;
        albumId: string;
        albumTitle: string;
        albumDisplayTitle: string | null;
        albumYear: number | null;
        artistId: string;
        artistName: string;
        artistDisplayName: string | null;
        artistGenres: unknown;
        artistUserGenres: unknown;
    }[]>`
        SELECT t.id, t.title, t."trackNo", t."discNumber", t.duration, t.mime, t."fileSize",
               al.id AS "albumId", al.title AS "albumTitle", al."displayTitle" AS "albumDisplayTitle", al.year AS "albumYear",
               ar.id AS "artistId", ar.name AS "artistName", ar."displayName" AS "artistDisplayName",
               ar.genres AS "artistGenres", ar."userGenres" AS "artistUserGenres"
        FROM "Track" t
        JOIN "Album" al ON t."albumId" = al.id
        JOIN "Artist" ar ON al."artistId" = ar.id
        WHERE al.location = 'LIBRARY'
          AND al."artistId" IN (${Prisma.join(artistIdList, ", ")})
        ORDER BY RANDOM()
        LIMIT ${count}
    `;

    const songs = rows.map((row) => {
        const artistName = row.artistDisplayName || row.artistName;
        const songGenre = firstArtistGenre(row.artistGenres, row.artistUserGenres);
        return mapSong(
            {
                id: row.id,
                title: row.title,
                trackNo: row.trackNo,
                discNumber: row.discNumber,
                duration: row.duration,
                filePath: null,
                mime: row.mime,
                fileSize: row.fileSize,
            },
            {
                id: row.albumId,
                title: row.albumTitle,
                displayTitle: row.albumDisplayTitle,
                year: row.albumYear,
            },
            artistName,
            row.artistId,
            songGenre
        );
    });

    const responseKey = req.path.startsWith("/getSimilarSongs2") ? "similarSongs2" : "similarSongs";
    return subsonicOk(req, res, {
        [responseKey]: songs.length > 0 ? { song: songs } : {},
    });
}));
