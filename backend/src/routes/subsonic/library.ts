// backend/src/routes/subsonic/library.ts
import { Router } from "express";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { mapArtist, mapAlbum, mapSong, firstArtistGenre, wrap } from "./mappers";
import { LEADING_ARTICLES } from "../../services/pgTextRules";

export const libraryRouter = Router();

// Rendered from the ONE canonical article list, which is also what
// `artistSortName` -- and its `kima_sort_name` SQL twin -- strip when writing
// `Artist.sortName`. This file used to carry a private English-only stripper
// AND a separately hardcoded "The A An" advertisement, so the server stripped
// eleven articles across four languages while telling clients it stripped
// three. Clients use this list to sort and render locally, so a client that
// disagrees with the server files the same artist in two different places.
//
// Space-separated and capitalized is what the protocol's own reference
// implementations advertise (Navidrome ships "The El La Los Las Le Les ...").
const IGNORED_ARTICLES = LEADING_ARTICLES
    .map((a) => a.charAt(0).toUpperCase() + a.slice(1))
    .join(" ");

// ===================== ARTISTS =====================

// getIndexes is the legacy alias for getArtists used by DSub and some older clients
libraryRouter.all(["/getArtists.view", "/getIndexes.view"], wrap(async (req, res) => {
    const artists = await prisma.artist.findMany({
        where: { libraryAlbumCount: { gt: 0 } },
        // Ordered by the same stored value the buckets below are keyed on.
        // These used to disagree -- ordering read the raw `name` while
        // bucketing stripped articles -- so "The Beatles" filed correctly
        // under B and then sorted to the BOTTOM of it, behind every genuine
        // B artist, on every client.
        orderBy: { sortName: "asc" },
        select: {
            id: true,
            name: true,
            displayName: true,
            heroUrl: true,
            libraryAlbumCount: true,
            sortName: true,
        },
    });

    const buckets: Record<string, ReturnType<typeof mapArtist>[]> = {};
    for (const a of artists) {
        const first = a.sortName[0]?.toUpperCase() ?? "#";
        const key = /[A-Z]/.test(first) ? first : "#";
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(mapArtist({ ...a, albumCount: a.libraryAlbumCount }));
    }

    const indexes = Object.entries(buckets)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, artistList]) => ({
            "@_name": name,
            artist: artistList,
        }));

    const responseKey = req.path.includes("getIndexes") ? "indexes" : "artists";
    subsonicOk(req, res, {
        [responseKey]: {
            "@_ignoredArticles": IGNORED_ARTICLES,
            index: indexes,
        },
    });
}));

// ===================== FOLDER BROWSING =====================

libraryRouter.all("/getArtist.view", wrap(async (req, res) => {
    const id = req.query.id as string;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const artist = await prisma.artist.findUnique({
        where: { id },
        include: {
            albums: {
                where: { location: "LIBRARY", tracks: { some: {} } },
                orderBy: { year: "desc" },
                include: {
                    _count: { select: { tracks: true } },
                },
            },
        },
    });
    if (!artist) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Artist not found");
    }

    const artistName = artist.displayName || artist.name;
    const genre = firstArtistGenre(artist.genres, artist.userGenres);
    subsonicOk(req, res, {
        artist: {
            ...mapArtist({ ...artist, albumCount: artist.albums.length }),
            album: artist.albums.map((al) =>
                mapAlbum({ ...al, songCount: al._count.tracks, genre }, artistName)
            ),
        },
    });
}));

// ===================== ALBUMS =====================

libraryRouter.all("/getMusicDirectory.view", wrap(async (req, res) => {
    const id = req.query.id as string | undefined;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    if (id === "1") {
        const artists = await prisma.artist.findMany({
            where: { libraryAlbumCount: { gt: 0 } },
            orderBy: { sortName: "asc" },
            select: { id: true, name: true, displayName: true },
        });

        return subsonicOk(req, res, {
            directory: {
                "@_id": "1",
                "@_name": "Music",
                ...(artists.length > 0
                    ? {
                          child: artists.map((artist) => {
                              const artistName = artist.displayName || artist.name;
                              return {
                                  "@_id": artist.id,
                                  "@_parent": "1",
                                  "@_isDir": true,
                                  "@_title": artistName,
                                  "@_artist": artistName,
                                  "@_coverArt": `ar-${artist.id}`,
                              };
                          }),
                      }
                    : {}),
            },
        });
    }

    const artistId = id.startsWith("artist:")
        ? id.slice("artist:".length)
        : id.startsWith("ar-")
        ? id.slice("ar-".length)
        : id;
    const artist = await prisma.artist.findUnique({
        where: { id: artistId },
        include: {
            albums: {
                where: { location: "LIBRARY", tracks: { some: {} } },
                orderBy: { year: "desc" },
            },
        },
    });

    if (artist) {
        const artistName = artist.displayName || artist.name;
        return subsonicOk(req, res, {
            directory: {
                "@_id": artist.id,
                "@_parent": "1",
                "@_name": artistName,
                ...(artist.albums.length > 0
                    ? {
                          child: artist.albums.map((album) => ({
                              "@_id": album.id,
                              "@_parent": artist.id,
                              "@_isDir": true,
                              "@_title": album.displayTitle || album.title,
                              "@_album": album.displayTitle || album.title,
                              "@_artist": artistName,
                              "@_artistId": artist.id,
                              "@_coverArt": album.id,
                          })),
                      }
                    : {}),
            },
        });
    }

    const albumId = id.startsWith("album:")
        ? id.slice("album:".length)
        : id.startsWith("al-")
        ? id.slice("al-".length)
        : id;
    const album = await prisma.album.findUnique({
        where: { id: albumId },
        include: {
            artist: { select: { id: true, name: true, displayName: true, genres: true, userGenres: true } },
            tracks: {
                orderBy: [
                    { discNumber: { sort: "asc", nulls: "first" } },
                    { trackNo: "asc" },
                ],
            },
        },
    });

    if (!album || album.location !== "LIBRARY") {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Directory not found");
    }

    const artistName = album.artist.displayName || album.artist.name;
    const genre = firstArtistGenre(album.artist.genres, album.artist.userGenres);

    return subsonicOk(req, res, {
        directory: {
            "@_id": album.id,
            "@_parent": album.artist.id,
            "@_name": album.displayTitle || album.title,
            ...(album.tracks.length > 0
                ? {
                      child: album.tracks.map((track) =>
                          mapSong(track, album, artistName, album.artist.id, genre)
                      ),
                  }
                : {}),
        },
    });
}));

libraryRouter.all("/getAlbum.view", wrap(async (req, res) => {
    const id = req.query.id as string;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const album = await prisma.album.findUnique({
        where: { id },
        include: {
            artist: { select: { id: true, name: true, displayName: true, genres: true, userGenres: true } },
            tracks: {
                orderBy: [
                    { discNumber: { sort: "asc", nulls: "first" } },
                    { trackNo: "asc" },
                ],
            },
        },
    });
    if (!album || album.location !== "LIBRARY") {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Album not found");
    }

    const artistName = album.artist.displayName || album.artist.name;
    const genre = firstArtistGenre(album.artist.genres, album.artist.userGenres);
    const totalDuration = album.tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);

    subsonicOk(req, res, {
        album: {
            ...mapAlbum({ ...album, songCount: album.tracks.length, duration: totalDuration, genre }, artistName),
            song: album.tracks.map((t) =>
                mapSong(t, album, artistName, album.artist.id, genre)
            ),
        },
    });
}));

// ===================== SONGS =====================

libraryRouter.all("/getSong.view", wrap(async (req, res) => {
    const id = req.query.id as string;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const track = await prisma.track.findUnique({
        where: { id },
        include: {
            album: {
                include: {
                    artist: { select: { id: true, name: true, displayName: true, genres: true, userGenres: true } },
                },
            },
        },
    });
    if (!track || track.album.location !== "LIBRARY") {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Song not found");
    }

    const artistName = track.album.artist.displayName || track.album.artist.name;
    const genre = firstArtistGenre(track.album.artist.genres, track.album.artist.userGenres);
    subsonicOk(req, res, {
        song: mapSong(track, track.album, artistName, track.album.artist.id, genre),
    });
}));

// ===================== ALBUM LIST =====================

type AlbumWithArtist = {
    id: string;
    title: string;
    displayTitle: string | null;
    year: number | null;
    coverUrl: string | null;
    userCoverUrl: string | null;
    artistId: string;
    artist: {
        id: string;
        name: string;
        displayName: string | null;
        genres?: unknown;
        userGenres?: unknown;
    };
    _count?: { tracks: number };
    tracks?: { duration: number | null }[];
};

// getAlbumList2 is ID3-tagged; getAlbumList is the legacy folder-based alias
libraryRouter.all(["/getAlbumList2.view", "/getAlbumList.view"], wrap(async (req, res) => {
    const type = (req.query.type as string) || "newest";
    const size = Math.min(parseInt((req.query.size as string) || "10", 10), 500);
    const offset = parseInt((req.query.offset as string) || "0", 10);
    const userId = req.user!.id;

    const albumInclude = {
        artist: { select: { id: true, name: true, displayName: true, genres: true, userGenres: true } },
        _count: { select: { tracks: true } },
        tracks: { where: { corrupt: false }, select: { duration: true } },
    } as const;

    let albums: AlbumWithArtist[] = [];

    switch (type) {
        case "newest":
            albums = await prisma.album.findMany({
                where: { location: "LIBRARY", tracks: { some: {} } },
                orderBy: { lastSynced: "desc" },
                take: size,
                skip: offset,
                include: albumInclude,
            });
            break;

        case "alphabeticalByName":
            albums = await prisma.album.findMany({
                where: { location: "LIBRARY", tracks: { some: {} } },
                orderBy: { sortName: "asc" },
                take: size,
                skip: offset,
                include: albumInclude,
            });
            break;

        case "alphabeticalByArtist":
            albums = await prisma.album.findMany({
                where: { location: "LIBRARY", tracks: { some: {} } },
                // "alphabeticalByArtist" means alphabetical to the user, and a
                // user does not file The Beatles under T.
                orderBy: { artist: { sortName: "asc" } },
                take: size,
                skip: offset,
                include: albumInclude,
            });
            break;

        case "byYear": {
            const fromYear = parseInt(req.query.fromYear as string, 10);
            const toYear = parseInt(req.query.toYear as string, 10);
            if (isNaN(fromYear) || isNaN(toYear)) {
                return subsonicError(req, res, SubsonicError.MISSING_PARAM, "byYear requires fromYear and toYear");
            }
            albums = await prisma.album.findMany({
                where: {
                    location: "LIBRARY",
                    year: {
                        gte: Math.min(fromYear, toYear),
                        lte: Math.max(fromYear, toYear),
                    },
                    tracks: { some: {} },
                },
                orderBy: { year: fromYear <= toYear ? "asc" : "desc" },
                take: size,
                skip: offset,
                include: albumInclude,
            });
            break;
        }

        case "byGenre": {
            const genre = req.query.genre as string;
            if (!genre) {
                return subsonicError(req, res, SubsonicError.MISSING_PARAM, "byGenre requires genre");
            }
            // Genre lives on Artist, not Album — filter via artist's enriched genres
            const rows = await prisma.$queryRaw<AlbumWithArtist[]>`
                SELECT a.id, a.title, a."displayTitle", a.year, a."coverUrl", a."userCoverUrl", a."artistId",
                       json_build_object('id', ar.id, 'name', ar.name, 'displayName', ar."displayName",
                           'genres', ar.genres, 'userGenres', ar."userGenres") as artist,
                       (SELECT COUNT(*)::int FROM "Track" t2 WHERE t2."albumId" = a.id AND t2.corrupt = false) as "songCount",
                       (SELECT COALESCE(SUM(t2.duration), 0) FROM "Track" t2 WHERE t2."albumId" = a.id AND t2.corrupt = false) as "totalDuration"
                FROM "Album" a
                JOIN "Artist" ar ON a."artistId" = ar.id
                WHERE a."location" = 'LIBRARY'
                  AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements_text(
                        COALESCE(NULLIF(NULLIF(ar."userGenres", 'null'::jsonb), '[]'::jsonb), ar.genres)
                    ) g WHERE g ILIKE '%' || ${genre} || '%'
                )
                  AND EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = a.id)
                ORDER BY a."sortName" ASC
                LIMIT ${size} OFFSET ${offset}
            `;
            albums = rows;
            break;
        }

        case "starred":
            albums = await prisma.album.findMany({
                where: {
                    location: "LIBRARY",
                    tracks: {
                        some: {
                            likedBy: { some: { userId } },
                        },
                    },
                },
                orderBy: { sortName: "asc" },
                take: size,
                skip: offset,
                include: albumInclude,
            });
            break;

        case "random": {
            const rows = await prisma.$queryRaw<AlbumWithArtist[]>`
                SELECT a.id, a.title, a."displayTitle", a.year, a."coverUrl", a."userCoverUrl", a."artistId",
                       json_build_object('id', ar.id, 'name', ar.name, 'displayName', ar."displayName",
                           'genres', ar.genres, 'userGenres', ar."userGenres") as artist,
                       (SELECT COUNT(*)::int FROM "Track" t2 WHERE t2."albumId" = a.id AND t2.corrupt = false) as "songCount",
                       (SELECT COALESCE(SUM(t2.duration), 0) FROM "Track" t2 WHERE t2."albumId" = a.id AND t2.corrupt = false) as "totalDuration"
                FROM "Album" a
                JOIN "Artist" ar ON a."artistId" = ar.id
                WHERE a."location" = 'LIBRARY'
                  AND EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = a.id)
                ORDER BY RANDOM()
                LIMIT ${size}
            `;
            albums = rows;
            break;
        }

        case "recent": {
            const rows = await prisma.$queryRaw<AlbumWithArtist[]>`
                SELECT a.id, a.title, a."displayTitle", a.year, a."coverUrl", a."userCoverUrl", a."artistId",
                       json_build_object('id', ar.id, 'name', ar.name, 'displayName', ar."displayName",
                           'genres', ar.genres, 'userGenres', ar."userGenres") as artist,
                       (SELECT COUNT(*)::int FROM "Track" t2 WHERE t2."albumId" = a.id AND t2.corrupt = false) as "songCount",
                       (SELECT COALESCE(SUM(t2.duration), 0) FROM "Track" t2 WHERE t2."albumId" = a.id AND t2.corrupt = false) as "totalDuration"
                FROM "Album" a
                JOIN "Artist" ar ON a."artistId" = ar.id
                JOIN "Track" t ON t."albumId" = a.id
                JOIN "Play" p ON p."trackId" = t.id
                WHERE a."location" = 'LIBRARY'
                  AND p."userId" = ${userId}
                GROUP BY a.id, a.title, a."displayTitle", a.year, a."coverUrl", a."userCoverUrl", a."artistId",
                         ar.id, ar.name, ar."displayName", ar.genres, ar."userGenres"
                ORDER BY MAX(p."playedAt") DESC
                LIMIT ${size} OFFSET ${offset}
            `;
            albums = rows;
            break;
        }

        case "frequent": {
            const rows = await prisma.$queryRaw<AlbumWithArtist[]>`
                SELECT a.id, a.title, a."displayTitle", a.year, a."coverUrl", a."userCoverUrl", a."artistId",
                       json_build_object('id', ar.id, 'name', ar.name, 'displayName', ar."displayName",
                           'genres', ar.genres, 'userGenres', ar."userGenres") as artist,
                       (SELECT COUNT(*)::int FROM "Track" t2 WHERE t2."albumId" = a.id AND t2.corrupt = false) as "songCount",
                       (SELECT COALESCE(SUM(t2.duration), 0) FROM "Track" t2 WHERE t2."albumId" = a.id AND t2.corrupt = false) as "totalDuration"
                FROM "Album" a
                JOIN "Artist" ar ON a."artistId" = ar.id
                JOIN "Track" t ON t."albumId" = a.id
                JOIN "Play" p ON p."trackId" = t.id
                WHERE a."location" = 'LIBRARY'
                  AND p."userId" = ${userId}
                GROUP BY a.id, a.title, a."displayTitle", a.year, a."coverUrl", a."userCoverUrl", a."artistId",
                         ar.id, ar.name, ar."displayName", ar.genres, ar."userGenres"
                ORDER BY COUNT(p.id) DESC
                LIMIT ${size} OFFSET ${offset}
            `;
            albums = rows;
            break;
        }

        default:
            albums = await prisma.album.findMany({
                where: { location: "LIBRARY", tracks: { some: {} } },
                orderBy: { lastSynced: "desc" },
                take: size,
                skip: offset,
                include: albumInclude,
            });
    }

    const albumList = albums.map((a) => {
        const artistName = a.artist.displayName || a.artist.name;
        const genre = firstArtistGenre(a.artist.genres, a.artist.userGenres);
        const songCount = a._count?.tracks
            ?? (a as unknown as { songCount?: number }).songCount
            ?? 0;
        const duration = a.tracks
            ? a.tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0)
            : Number((a as unknown as { totalDuration?: number | bigint }).totalDuration ?? 0);
        return mapAlbum({ ...a, artistId: a.artist.id, songCount, duration, genre }, artistName);
    });

    const key = req.path.includes("getAlbumList2") ? "albumList2" : "albumList";
    subsonicOk(req, res, { [key]: { album: albumList } });
}));

// ===================== GENRES =====================

libraryRouter.all("/getGenres.view", wrap(async (req, res) => {
    // Genres live on artists (from enrichment), not on albums.
    const artists = await prisma.artist.findMany({
        where: { libraryAlbumCount: { gt: 0 } },
        select: {
            genres: true,
            userGenres: true,
            libraryAlbumCount: true,
            totalTrackCount: true,
        },
    });

    const genreCounts: Record<string, { albums: number; songs: number }> = {};
    for (const artist of artists) {
        const genres = ((artist.userGenres ?? artist.genres) as string[] | null) || [];
        for (const g of genres) {
            if (!g || g.startsWith("_")) continue;
            if (!genreCounts[g]) genreCounts[g] = { albums: 0, songs: 0 };
            genreCounts[g].albums += artist.libraryAlbumCount;
            genreCounts[g].songs += artist.totalTrackCount;
        }
    }

    const sorted = Object.entries(genreCounts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, counts]) => ({
            "@_songCount": counts.songs,
            "@_albumCount": counts.albums,
            "#text": name,
        }));

    subsonicOk(req, res, { genres: { genre: sorted } });
}));
// getTopSongs / getSimilarSongs / getSimilarSongs2 live in search.ts.
//
// They were also registered here, and libraryRouter mounts first, so these
// copies won and search.ts's were dead. Both of these were the worse
// implementation: getTopSongs derived from play.groupBy, so a library with no
// Play rows returned an empty list forever, while search.ts LEFT JOINs Play so
// unplayed tracks still come back. getSimilarSongs took an UNORDERED slice and
// Fisher-Yates shuffled it -- Postgres returns rows in physical order without
// an ORDER BY, so it served the same rows on every call, merely permuted;
// search.ts uses ORDER BY RANDOM().

