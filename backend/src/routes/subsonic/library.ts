import { Router } from "express";
import { prisma, Prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { mapArtist, mapAlbum, mapAlbumChild, mapSong, coverArtId, artistPicture, wrap, clamp, parseIntParam } from "./mappers";
import { effectiveYearSql, getEffectiveYear } from "../../utils/dateFilters";
import { LEADING_ARTICLES, unaccent } from "../../services/pgTextRules";
import { LIBRARY_LOCATION, PLAYABLE_ALBUM_WHERE, albumHasPlayableSongSql } from "../../services/libraryFilters";
import { PLAYABLE_SONG, playableSongSql } from "../../utils/playableSong";
import { listenRows } from "../../services/stats/listens";
import { librarySongGenreTotals, libraryAlbumIdsOfGenre, shownAlbumGenres, shownGenresOfSongs } from "../../utils/genreSql";
import { one } from "../../utils/subsonicParams";
import { libraryChangedAt } from "../../services/libraryChanged";

export const libraryRouter = Router();

// Advertised from the same article list `artistSortName` strips, so clients
// sort and group artists as the server does.
const IGNORED_ARTICLES = LEADING_ARTICLES
    .map((a) => a.charAt(0).toUpperCase() + a.slice(1))
    .join(" ");

// ===================== ARTISTS =====================

/**
 * The index an artist is filed under: the accent-folded first letter of its sort name, upper case. A letter outside A-Z
 * after folding keeps its own index, as Navidrome files it; "#" holds digits, symbols and nameless artists only.
 */
function indexLetter(sortName: string): string {
    const first = [...sortName][0];
    if (first === undefined) return "#";
    const folded = [...unaccent(first)][0]?.toUpperCase() ?? first;
    return /^\p{L}$/u.test(folded) ? folded : "#";
}

// getIndexes is the legacy alias for getArtists used by DSub and some older clients. Which one answers is decided by the
// route it is mounted on, not by the request's path text (a router matches any letter case).
const artistIndexRoute = (key: "artists" | "indexes") => wrap(async (req, res) => {
    // Artists with a playable album, each counting those albums as search3 does (the cached count ignores playability).
    // Ordered by the same sortName the buckets are keyed on.
    const artists = await prisma.$queryRaw<
        { id: string; name: string; displayName: string | null; heroUrl: string | null; userHeroUrl: string | null; sortName: string; albumCount: number }[]
    >`
        SELECT ar.id, ar.name, ar."displayName", ar."heroUrl", ar."userHeroUrl", ar."sortName", COUNT(al.id)::int AS "albumCount"
        FROM "Artist" ar
        JOIN "Album" al ON al."artistId" = ar.id
        WHERE ${albumHasPlayableSongSql("al")}
        GROUP BY ar.id
        ORDER BY ar."sortName" ASC, ar.id ASC`;

    const buckets: Record<string, ReturnType<typeof mapArtist>[]> = {};
    for (const a of artists) {
        const key = indexLetter(a.sortName);
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(mapArtist(a));
    }

    const indexes = Object.entries(buckets)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, artistList]) => ({
            "@_name": name,
            artist: artistList,
        }));

    subsonicOk(req, res, {
        [key]: {
            // When the library a client lists last changed: a scan that changed songs, or an edit of a shown name
            // (services/libraryChanged.ts), never analysis writes, Discover songs or artist syncs.
            "@_lastModified": await libraryChangedAt(),
            "@_ignoredArticles": IGNORED_ARTICLES,
            index: indexes,
        },
    });
});
libraryRouter.all("/getArtists.view", artistIndexRoute("artists"));
libraryRouter.all("/getIndexes.view", artistIndexRoute("indexes"));

// ===================== FOLDER BROWSING =====================

/** An artist's albums by the year a client sees, newest first, an album with no year ahead of them all (as the database ordered a missing year when it sorted descending); a tie keeps the order the database gave. */
function newestShownYearFirst<T extends { year: number | null; originalYear: number | null; displayYear: number | null }>(albums: T[]): T[] {
    return albums
        .map((album, order) => ({ album, order, year: getEffectiveYear(album) || Infinity }))
        .sort((a, b) => b.year - a.year || a.order - b.order)
        .map((x) => x.album);
}

libraryRouter.all("/getArtist.view", wrap(async (req, res) => {
    const id = one(req, "id");
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const artist = await prisma.artist.findUnique({
        where: { id },
        include: {
            albums: {
                where: { tracks: { some: PLAYABLE_SONG } },
                orderBy: [{ sortName: "asc" }, { id: "asc" }],
                include: {
                    _count: { select: { tracks: { where: PLAYABLE_SONG } } },
                },
            },
        },
    });
    if (!artist) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Artist not found");
    }

    const artistName = artist.displayName || artist.name;
    subsonicOk(req, res, {
        artist: {
            ...mapArtist({ ...artist, albumCount: artist.albums.length }),
            album: newestShownYearFirst(artist.albums).map((al) =>
                mapAlbum({ ...al, songCount: al._count.tracks, genres: shownAlbumGenres(al, artist) }, artistName)
            ),
        },
    });
}));

// ===================== ALBUMS =====================

libraryRouter.all("/getMusicDirectory.view", wrap(async (req, res) => {
    const id = one(req, "id");
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    if (id === "1") {
        const artists = await prisma.artist.findMany({
            where: { albums: { some: PLAYABLE_ALBUM_WHERE } },
            orderBy: [{ sortName: "asc" }, { id: "asc" }],
            select: { id: true, name: true, displayName: true, heroUrl: true, userHeroUrl: true },
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
                                  "@_coverArt": coverArtId(`ar-${artist.id}`, artistPicture(artist)),
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
                where: { tracks: { some: PLAYABLE_SONG } },
                orderBy: [{ sortName: "asc" }, { id: "asc" }],
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
                          child: newestShownYearFirst(artist.albums).map((album) => mapAlbumChild({ ...album, genres: shownAlbumGenres(album, artist) }, artistName)),
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
            artist: { select: { id: true, name: true, normalizedName: true, displayName: true, genres: true, userGenres: true } },
            tracks: {
                where: PLAYABLE_SONG,
                orderBy: [
                    { discNumber: { sort: "asc", nulls: "first" } },
                    { trackNo: "asc" },
                ],
            },
        },
    });

    if (!album || album.location !== LIBRARY_LOCATION) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Directory not found");
    }

    const artistName = album.artist.displayName || album.artist.name;
    const shown = await shownGenresOfSongs(album.tracks.map((t) => ({ id: t.id, album, artist: album.artist })));

    return subsonicOk(req, res, {
        directory: {
            "@_id": album.id,
            "@_parent": album.artist.id,
            "@_name": album.displayTitle || album.title,
            ...(album.tracks.length > 0
                ? {
                      child: album.tracks.map((track) =>
                          mapSong(track, album, artistName, album.artist.id, shown.get(track.id))
                      ),
                  }
                : {}),
        },
    });
}));

libraryRouter.all("/getAlbum.view", wrap(async (req, res) => {
    const id = one(req, "id");
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const album = await prisma.album.findUnique({
        where: { id },
        include: {
            artist: { select: { id: true, name: true, normalizedName: true, displayName: true, genres: true, userGenres: true } },
            tracks: {
                where: PLAYABLE_SONG,
                orderBy: [
                    { discNumber: { sort: "asc", nulls: "first" } },
                    { trackNo: "asc" },
                ],
            },
        },
    });
    if (!album || album.location !== LIBRARY_LOCATION) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Album not found");
    }

    const artistName = album.artist.displayName || album.artist.name;
    const genres = shownAlbumGenres(album, album.artist);
    const shown = await shownGenresOfSongs(album.tracks.map((t) => ({ id: t.id, album, artist: album.artist })));
    const totalDuration = album.tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);

    subsonicOk(req, res, {
        album: {
            ...mapAlbum({ ...album, songCount: album.tracks.length, duration: totalDuration, genres }, artistName),
            song: album.tracks.map((t) =>
                mapSong(t, album, artistName, album.artist.id, shown.get(t.id))
            ),
        },
    });
}));

// ===================== SONGS =====================

libraryRouter.all("/getSong.view", wrap(async (req, res) => {
    const id = one(req, "id");
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const track = await prisma.track.findFirst({
        where: { id, ...PLAYABLE_SONG },
        include: {
            album: {
                include: {
                    artist: { select: { id: true, name: true, normalizedName: true, displayName: true, genres: true, userGenres: true } },
                },
            },
        },
    });
    if (!track) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Song not found");
    }

    const artistName = track.album.artist.displayName || track.album.artist.name;
    const shown = await shownGenresOfSongs([{ id: track.id, album: track.album, artist: track.album.artist }]);
    subsonicOk(req, res, {
        song: mapSong(track, track.album, artistName, track.album.artist.id, shown.get(track.id)),
    });
}));

// ===================== ALBUM LIST =====================

type AlbumWithArtist = {
    id: string;
    title: string;
    displayTitle: string | null;
    year: number | null;
    originalYear: number | null;
    displayYear: number | null;
    genres: unknown;
    userGenres: unknown;
    coverUrl: string | null;
    userCoverUrl: string | null;
    artistId: string;
    createdAt: Date;
    artist: {
        id: string;
        name: string;
        normalizedName?: string | null;
        displayName: string | null;
        genres?: unknown;
        userGenres?: unknown;
    };
    tracks?: { duration: number | null }[];
    // The raw album-list queries count and total the songs themselves.
    songCount?: number;
    totalDuration?: number | bigint;
};

// The four raw album-list queries read the same columns in the same row
// shape; only the joins, filter and ordering differ.
const ALBUM_LIST_SELECT = Prisma.sql`
    SELECT a.id, a.title, a."displayTitle", a.year, a."originalYear", a."displayYear", a.genres, a."userGenres", a."coverUrl", a."userCoverUrl", a."artistId", a."createdAt",
           json_build_object('id', ar.id, 'name', ar.name, 'normalizedName', ar."normalizedName", 'displayName', ar."displayName",
               'genres', ar.genres, 'userGenres', ar."userGenres") as artist,
           (SELECT COUNT(*)::int FROM "Track" t2 WHERE t2."albumId" = a.id AND ${playableSongSql("t2", "a")}) as "songCount",
           (SELECT COALESCE(SUM(t2.duration), 0) FROM "Track" t2 WHERE t2."albumId" = a.id AND ${playableSongSql("t2", "a")}) as "totalDuration"
    FROM "Album" a
    JOIN "Artist" ar ON a."artistId" = ar.id
`;

// getAlbumList2 lists AlbumID3; the legacy getAlbumList lists Child folders. Which one answers is decided by the route
// it is mounted on, not by the request's path text (a router matches any letter case).
const albumListRoute = (id3: boolean) => wrap(async (req, res) => {
    const type = one(req, "type") || "newest";
    const size = clamp(parseIntParam(one(req, "size"), 10), 0, 500);
    const offset = Math.max(0, parseIntParam(one(req, "offset"), 0));
    const userId = req.user!.id;

    const albumInclude = {
        artist: { select: { id: true, name: true, normalizedName: true, displayName: true, genres: true, userGenres: true } },
        tracks: { where: PLAYABLE_SONG, select: { duration: true } },
    } as const;

    let albums: AlbumWithArtist[] = [];

    switch (type) {
        case "newest":
            albums = await prisma.album.findMany({
                where: { tracks: { some: PLAYABLE_SONG } },
                orderBy: [{ createdAt: "desc" }, { id: "asc" }],
                take: size,
                skip: offset,
                include: albumInclude,
            });
            break;

        case "alphabeticalByName":
            albums = await prisma.album.findMany({
                where: { tracks: { some: PLAYABLE_SONG } },
                orderBy: [{ sortName: "asc" }, { id: "asc" }],
                take: size,
                skip: offset,
                include: albumInclude,
            });
            break;

        case "alphabeticalByArtist":
            albums = await prisma.album.findMany({
                where: { tracks: { some: PLAYABLE_SONG } },
                // "alphabeticalByArtist" means alphabetical to the user, and a
                // user does not file The Beatles under T.
                orderBy: [{ artist: { sortName: "asc" } }, { id: "asc" }],
                take: size,
                skip: offset,
                include: albumInclude,
            });
            break;

        case "byYear": {
            const fromYear = parseInt(one(req, "fromYear") ?? "", 10);
            const toYear = parseInt(one(req, "toYear") ?? "", 10);
            if (isNaN(fromYear) || isNaN(toYear)) {
                return subsonicError(req, res, SubsonicError.MISSING_PARAM, "byYear requires fromYear and toYear");
            }
            // The year a client sees, as the web shows it: displayYear, else originalYear, else year.
            const shownYear = effectiveYearSql("a");
            albums = await prisma.$queryRaw<AlbumWithArtist[]>(Prisma.sql`
                ${ALBUM_LIST_SELECT}
                WHERE ${shownYear} BETWEEN ${Math.min(fromYear, toYear)} AND ${Math.max(fromYear, toYear)}
                  AND EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = a.id AND ${playableSongSql("t", "a")})
                ORDER BY ${shownYear} ${fromYear <= toYear ? Prisma.sql`ASC` : Prisma.sql`DESC`}, a."sortName" ASC, a.id ASC
                LIMIT ${size} OFFSET ${offset}
            `);
            break;
        }

        case "byGenre": {
            const genre = one(req, "genre");
            if (!genre) {
                return subsonicError(req, res, SubsonicError.MISSING_PARAM, "byGenre requires genre");
            }
            // The albums showing the genre (shownAlbumGenres: their own, else their artist's), so a genre an album
            // shows and this filter agree. A genre nothing shows has no albums.
            const genreAlbumIds = await libraryAlbumIdsOfGenre(genre);
            const rows = await prisma.$queryRaw<AlbumWithArtist[]>(Prisma.sql`
                ${ALBUM_LIST_SELECT}
                WHERE ${genreAlbumIds.length > 0 ? Prisma.sql`a.id = ANY(${genreAlbumIds}::text[])` : Prisma.sql`1 = 0`}
                  AND EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = a.id AND ${playableSongSql("t", "a")})
                ORDER BY a."sortName" ASC, a.id ASC
                LIMIT ${size} OFFSET ${offset}
            `);
            albums = rows;
            break;
        }

        case "starred":
            albums = await prisma.album.findMany({
                where: {
                    tracks: {
                        some: {
                            ...PLAYABLE_SONG,
                            likedBy: { some: { userId } },
                        },
                    },
                },
                orderBy: [{ sortName: "asc" }, { id: "asc" }],
                take: size,
                skip: offset,
                include: albumInclude,
            });
            break;

        case "random": {
            const rows = await prisma.$queryRaw<AlbumWithArtist[]>(Prisma.sql`
                ${ALBUM_LIST_SELECT}
                WHERE EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = a.id AND ${playableSongSql("t", "a")})
                ORDER BY RANDOM()
                LIMIT ${size}
            `);
            albums = rows;
            break;
        }

        case "recent": {
            // Listens, not plays: a song replayed in a burst is one listen, as on the stats pages.
            const rows = await prisma.$queryRaw<AlbumWithArtist[]>(Prisma.sql`
                ${listenRows(userId)}
                ${ALBUM_LIST_SELECT}
                JOIN "Track" t ON t."albumId" = a.id
                JOIN p ON p."trackId" = t.id
                WHERE EXISTS (SELECT 1 FROM "Track" t3 WHERE t3."albumId" = a.id AND ${playableSongSql("t3", "a")})
                GROUP BY a.id, a.title, a."displayTitle", a.year, a."originalYear", a."displayYear", a.genres, a."userGenres", a."coverUrl", a."userCoverUrl", a."artistId", a."createdAt",
                         ar.id, ar.name, ar."displayName", ar.genres, ar."userGenres"
                ORDER BY MAX(p."playedAt") DESC, a.id
                LIMIT ${size} OFFSET ${offset}
            `);
            albums = rows;
            break;
        }

        case "frequent": {
            const rows = await prisma.$queryRaw<AlbumWithArtist[]>(Prisma.sql`
                ${listenRows(userId)}
                ${ALBUM_LIST_SELECT}
                JOIN "Track" t ON t."albumId" = a.id
                JOIN p ON p."trackId" = t.id
                WHERE EXISTS (SELECT 1 FROM "Track" t3 WHERE t3."albumId" = a.id AND ${playableSongSql("t3", "a")})
                GROUP BY a.id, a.title, a."displayTitle", a.year, a."originalYear", a."displayYear", a.genres, a."userGenres", a."coverUrl", a."userCoverUrl", a."artistId", a."createdAt",
                         ar.id, ar.name, ar."displayName", ar.genres, ar."userGenres"
                ORDER BY COUNT(p.id) DESC, a.id
                LIMIT ${size} OFFSET ${offset}
            `);
            albums = rows;
            break;
        }

        default:
            albums = await prisma.album.findMany({
                where: { tracks: { some: PLAYABLE_SONG } },
                orderBy: [{ createdAt: "desc" }, { id: "asc" }],
                take: size,
                skip: offset,
                include: albumInclude,
            });
    }

    // The legacy list gives Child folders, as getMusicDirectory does.
    const albumList = albums.map((a) => {
        const artistName = a.artist.displayName || a.artist.name;
        const genres = shownAlbumGenres(a, a.artist);
        if (!id3) return mapAlbumChild({ ...a, artistId: a.artist.id, genres }, artistName);
        const songCount = a.tracks?.length ?? a.songCount ?? 0;
        const duration = a.tracks
            ? a.tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0)
            : Number(a.totalDuration ?? 0);
        return mapAlbum({ ...a, artistId: a.artist.id, songCount, duration, genres }, artistName);
    });

    subsonicOk(req, res, { [id3 ? "albumList2" : "albumList"]: { album: albumList } });
});
libraryRouter.all("/getAlbumList2.view", albumListRoute(true));
libraryRouter.all("/getAlbumList.view", albumListRoute(false));

// ===================== GENRES =====================

libraryRouter.all("/getGenres.view", wrap(async (req, res) => {
    // librarySongGenreTotals counts the playable songs under the genres they show: their own tags, else their album's.
    const sorted = (await librarySongGenreTotals())
        .sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0)) // code units, not localeCompare: the same order on every host
        .map(({ name, albums, songs }) => ({
            "@_songCount": songs,
            "@_albumCount": albums,
            "#text": name,
        }));

    subsonicOk(req, res, { genres: { genre: sorted } });
}));
// getTopSongs / getSimilarSongs / getSimilarSongs2 live in search.ts.

