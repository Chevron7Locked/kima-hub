import { Router } from "express";
import { Prisma } from "@prisma/client";
import { playableSongSql } from "../../utils/playableSong";
import { PLAYABLE_ALBUM_WHERE, albumHasPlayableSongSql, artistHasPlayableSongSql } from "../../services/libraryFilters";
import { prisma } from "../../utils/db";
import { artistIdentityKey } from "../../services/artistIdentity";
import { foldedPattern } from "../../services/textMatch";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { searchService, shownSongTitleSql } from "../../services/search";
import { popularSongs } from "../../services/popularSongs";
import { wrap, clamp, parseIntParam, mapSong, mapAlbum, mapAlbumChild, mapArtist } from "./mappers";
import { shownAlbumGenres, shownGenresOfSongs, songGenreFilterSql } from "../../utils/genreSql";
import { one } from "../../utils/subsonicParams";
import { effectiveYearSql } from "../../utils/dateFilters";

export const searchRouter = Router();

/** What every song list here reads: the song, its album and its artist. */
const SONG_COLUMNS = Prisma.sql`
    t.id, t.title, t."displayTitle", t."trackNo", t."discNumber", t.duration, t.mime, t.bitrate, t."fileSize",
    al.id AS "albumId", al.title AS "albumTitle", al."displayTitle" AS "albumDisplayTitle", al.year AS "albumYear",
    al."originalYear" AS "albumOriginalYear", al."displayYear" AS "albumDisplayYear",
    al."coverUrl" AS "albumCoverUrl", al."userCoverUrl" AS "albumUserCoverUrl",
    al.genres AS "albumGenres", al."userGenres" AS "albumUserGenres",
    ar.id AS "artistId", ar.name AS "artistName", ar."normalizedName" AS "artistNormalizedName", ar."displayName" AS "artistDisplayName",
    ar.genres AS "artistGenres", ar."userGenres" AS "artistUserGenres"`;
const SONG_FROM = Prisma.sql`"Track" t JOIN "Album" al ON t."albumId" = al.id JOIN "Artist" ar ON al."artistId" = ar.id`;
/** The playable-song rule, for the aliases every query here uses. */
const PLAYABLE_SQL = playableSongSql("t", "al");

type SongRow = {
    id: string;
    title: string;
    displayTitle: string | null;
    trackNo: number | null;
    discNumber: number | null;
    duration: number | null;
    mime: string | null;
    bitrate: number | null;
    fileSize: number | null;
    albumId: string;
    albumTitle: string;
    albumDisplayTitle: string | null;
    albumYear: number | null;
    albumOriginalYear: number | null;
    albumDisplayYear: number | null;
    albumCoverUrl: string | null;
    albumUserCoverUrl: string | null;
    albumGenres: unknown;
    albumUserGenres: unknown;
    artistId: string;
    artistName: string;
    artistNormalizedName: string | null;
    artistDisplayName: string | null;
    artistGenres: unknown;
    artistUserGenres: unknown;
};

function songOf(row: SongRow, genres: string[]) {
    return mapSong(
        {
            id: row.id,
            title: row.title,
            displayTitle: row.displayTitle,
            trackNo: row.trackNo,
            discNumber: row.discNumber,
            duration: row.duration,
            filePath: null,
            mime: row.mime,
            bitrate: row.bitrate,
            fileSize: row.fileSize,
        },
        {
            id: row.albumId,
            title: row.albumTitle,
            displayTitle: row.albumDisplayTitle,
            year: row.albumYear,
            originalYear: row.albumOriginalYear,
            displayYear: row.albumDisplayYear,
            coverUrl: row.albumCoverUrl,
            userCoverUrl: row.albumUserCoverUrl,
        },
        row.artistDisplayName || row.artistName,
        row.artistId,
        genres,
    );
}

/** Subsonic songs for these rows, each with the genres it shows (its own tags, else its album's). */
async function songsOf(rows: SongRow[]) {
    const genres = await shownGenresOfSongs(
        rows.map((row) => ({
            id: row.id,
            album: { genres: row.albumGenres, userGenres: row.albumUserGenres },
            artist: { name: row.artistName, normalizedName: row.artistNormalizedName, genres: row.artistGenres, userGenres: row.artistUserGenres },
        })),
    );
    return rows.map((row) => songOf(row, genres.get(row.id) ?? []));
}

/** The playable songs among `ids`, in the order given. */
async function playableSongsInOrder(ids: string[]): Promise<SongRow[]> {
    if (ids.length === 0) return [];
    const rows = await prisma.$queryRaw<SongRow[]>`
        SELECT ${SONG_COLUMNS} FROM ${SONG_FROM}
        WHERE t.id = ANY(${ids}::text[]) AND ${PLAYABLE_SQL}`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => byId.get(id) ?? []);
}

type AlbumHit = {
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
    artistName: string;
    artistNormalizedName: string | null;
    artistDisplayName: string | null;
    artistGenres: unknown;
    artistUserGenres: unknown;
    songCount: number;
    duration: number;
};

/** The albums among `ids` that have a playable song, in the order given, each with its playable songs counted and timed. */
async function playableAlbumsInOrder(ids: string[]): Promise<AlbumHit[]> {
    if (ids.length === 0) return [];
    const rows = await prisma.$queryRaw<AlbumHit[]>`
        SELECT al.id, al.title, al."displayTitle", al.year, al."originalYear", al."displayYear", al.genres, al."userGenres", al."coverUrl", al."userCoverUrl", al."artistId", al."createdAt",
               ar.name AS "artistName", ar."normalizedName" AS "artistNormalizedName", ar."displayName" AS "artistDisplayName",
               ar.genres AS "artistGenres", ar."userGenres" AS "artistUserGenres",
               COUNT(t.id)::int AS "songCount", COALESCE(SUM(t.duration), 0)::float8 AS duration
        FROM "Album" al
        JOIN "Artist" ar ON al."artistId" = ar.id
        JOIN "Track" t ON t."albumId" = al.id AND ${PLAYABLE_SQL}
        WHERE al.id = ANY(${ids}::text[])
        GROUP BY al.id, ar.id`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => byId.get(id) ?? []);
}

type ArtistHit = {
    id: string;
    name: string;
    displayName: string | null;
    heroUrl: string | null;
    userHeroUrl: string | null;
    albumCount: number;
};

/** The artists among `ids` that have a playable song, in the order given, each with its playable albums counted. */
async function playableArtistsInOrder(ids: string[]): Promise<ArtistHit[]> {
    if (ids.length === 0) return [];
    const rows = await prisma.$queryRaw<ArtistHit[]>`
        SELECT ar.id, ar.name, ar."displayName", ar."heroUrl", ar."userHeroUrl", COUNT(al.id)::int AS "albumCount"
        FROM "Artist" ar
        JOIN "Album" al ON al."artistId" = ar.id
        WHERE ar.id = ANY(${ids}::text[])
          AND ${albumHasPlayableSongSql("al")}
        GROUP BY ar.id`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => byId.get(id) ?? []);
}

// ===================== SEARCH =====================

// The old `search` call (before search2): song matches by `any`, `artist`, `album` or `title`, paged by `count` and `offset`.
searchRouter.all("/search.view", wrap(async (req, res) => {
    const count = clamp(parseIntParam(one(req, "count"), 20), 0, 500);
    const offset = Math.max(0, parseIntParam(one(req, "offset"), 0));
    const { ids, total } = await searchService.searchSongsByFields({
        any: one(req, "any"),
        artist: one(req, "artist"),
        album: one(req, "album"),
        title: one(req, "title"),
        limit: count,
        offset,
    });
    const songs = await songsOf(await playableSongsInOrder(ids));
    const result: Record<string, unknown> = { "@_offset": offset, "@_totalHits": total };
    if (songs.length > 0) result.match = songs;
    return subsonicOk(req, res, { searchResult: result });
}));

// search3 and the legacy search2 answer with the same hits under different keys. Which one answers is decided by the route
// it is mounted on, not by the request's path text (a router matches any letter case).
const searchRoute = (responseKey: "searchResult3" | "searchResult2") => wrap(async (req, res) => {
    const query = one(req, "query") ?? "";

    const artistCount = clamp(parseIntParam(one(req, "artistCount"), 20), 0, 500);
    const albumCount  = clamp(parseIntParam(one(req, "albumCount"), 20), 0, 500);
    const songCount   = clamp(parseIntParam(one(req, "songCount"), 20), 0, 500);
    const artistOffset = Math.max(0, parseIntParam(one(req, "artistOffset"), 0));
    const albumOffset  = Math.max(0, parseIntParam(one(req, "albumOffset"), 0));
    const songOffset   = Math.max(0, parseIntParam(one(req, "songOffset"), 0));

    // OpenSubsonic clients (Symfonium, DSub, Substreamer) sync by paginating
    // search3 over an empty query: `query=`, a missing query, or the literal
    // two-quote string some clients send. That enumerates the library;
    // anything else is a ranked search.
    const trimmed = query.trim();
    const enumerateLibrary = !trimmed || trimmed === "\"\"";

    let artistIds: string[];
    let albumIds: string[];
    let tracks: SongRow[];

    if (enumerateLibrary) {
        [artistIds, albumIds, tracks] = await Promise.all([
            artistCount > 0
                ? prisma.$queryRaw<{ id: string }[]>`
                      SELECT ar.id FROM "Artist" ar
                      WHERE ${artistHasPlayableSongSql("ar")}
                      ORDER BY LOWER(COALESCE(NULLIF(ar."displayName", ''), ar.name)) ASC, ar.id ASC
                      LIMIT ${artistCount} OFFSET ${artistOffset}`
                      .then((rows) => rows.map((r) => r.id))
                : Promise.resolve([]),
            albumCount > 0
                ? prisma.$queryRaw<{ id: string }[]>`
                      SELECT al.id FROM "Album" al
                      WHERE ${albumHasPlayableSongSql("al")}
                      ORDER BY LOWER(COALESCE(NULLIF(al."displayTitle", ''), al.title)) ASC, al.id ASC
                      LIMIT ${albumCount} OFFSET ${albumOffset}`
                      .then((rows) => rows.map((r) => r.id))
                : Promise.resolve([]),
            songCount > 0
                ? prisma.$queryRaw<SongRow[]>`
                      SELECT ${SONG_COLUMNS} FROM ${SONG_FROM}
                      WHERE ${PLAYABLE_SQL}
                      ORDER BY ${shownSongTitleSql("t")} ASC, t.id ASC
                      LIMIT ${songCount} OFFSET ${songOffset}`
                : Promise.resolve([]),
        ]);
    } else {
        [artistIds, albumIds, tracks] = await Promise.all([
            artistCount > 0
                ? searchService
                      .searchArtists({ query, limit: artistCount, offset: artistOffset })
                      .then((rows) => rows.map((a) => a.id))
                : Promise.resolve([]),
            albumCount > 0
                ? searchService
                      .searchAlbums({ query, limit: albumCount, offset: albumOffset })
                      .then((rows) => rows.map((al) => al.id))
                : Promise.resolve([]),
            songCount > 0
                ? searchService
                      .searchTracks({ query, limit: songCount, offset: songOffset })
                      .then((rows) => playableSongsInOrder(rows.map((t) => t.id)))
                : Promise.resolve([]),
        ]);
    }

    // Only library artists and albums with a song that plays, each counted (and the albums timed) by those songs.
    const [artists, albums] = await Promise.all([playableArtistsInOrder(artistIds), playableAlbumsInOrder(albumIds)]);

    const result: Record<string, unknown> = {};

    if (artists.length > 0) {
        result.artist = artists.map(mapArtist);
    }

    if (albums.length > 0) {
        // search3 answers AlbumID3. search2 answers the albums as Child entries, as the spec's searchResult2 does.
        const mapAlbumHit = responseKey === "searchResult2" ? mapAlbumChild : mapAlbum;
        result.album = albums.map((al) =>
            mapAlbumHit(
                {
                    ...al,
                    genres: shownAlbumGenres(al, {
                        name: al.artistName, normalizedName: al.artistNormalizedName, genres: al.artistGenres, userGenres: al.artistUserGenres,
                    }),
                },
                al.artistDisplayName || al.artistName,
            )
        );
    }

    if (tracks.length > 0) {
        result.song = await songsOf(tracks);
    }

    return subsonicOk(req, res, { [responseKey]: result });
});
searchRouter.all("/search3.view", searchRoute("searchResult3"));
searchRouter.all("/search2.view", searchRoute("searchResult2"));

// ===================== RANDOM SONGS =====================

searchRouter.all("/getRandomSongs.view", wrap(async (req, res) => {
    const size  = clamp(parseIntParam(one(req, "size"), 10), 1, 500);
    const genre = one(req, "genre");
    const fromYearRaw = one(req, "fromYear");
    const toYearRaw = one(req, "toYear");
    const fromYear = fromYearRaw ? parseInt(fromYearRaw, 10) : undefined;
    const toYear = toYearRaw ? parseInt(toYearRaw, 10) : undefined;

    const whereConditions: Prisma.Sql[] = [PLAYABLE_SQL];
    // The year a client sees, as the web shows it: displayYear, else originalYear, else year.
    const shownYear = effectiveYearSql("al");

    if (fromYear !== undefined && !isNaN(fromYear) && toYear !== undefined && !isNaN(toYear)) {
        const lo = Math.min(fromYear, toYear);
        const hi = Math.max(fromYear, toYear);
        whereConditions.push(Prisma.sql`${shownYear} BETWEEN ${lo} AND ${hi}`);
    } else if (fromYear !== undefined && !isNaN(fromYear)) {
        whereConditions.push(Prisma.sql`${shownYear} >= ${fromYear}`);
    } else if (toYear !== undefined && !isNaN(toYear)) {
        whereConditions.push(Prisma.sql`${shownYear} <= ${toYear}`);
    }

    if (genre) {
        // The songs showing the genre: their own tags, else their album's. A genre nothing shows (an empty name, a genre
        // no song has) matches no song.
        whereConditions.push(await songGenreFilterSql(genre, "t", "al"));
    }

    const whereClause = Prisma.join(whereConditions, " AND ");

    const rows = await prisma.$queryRaw<SongRow[]>`
        SELECT ${SONG_COLUMNS} FROM ${SONG_FROM}
        WHERE ${whereClause}
        ORDER BY RANDOM()
        LIMIT ${size}
    `;
    const songs = await songsOf(rows);

    return subsonicOk(req, res, {
        randomSongs: songs.length > 0 ? { song: songs } : {},
    });
}));

// ===================== SONGS BY GENRE =====================

searchRouter.all("/getSongsByGenre.view", wrap(async (req, res) => {
    const genre = one(req, "genre");
    if (!genre) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: genre");
    }

    const count = clamp(parseIntParam(one(req, "count"), 50), 1, 500);
    const offset = Math.max(0, parseIntParam(one(req, "offset"), 0));

    // The songs showing the genre (their own tags, else their album's); a genre nothing shows has no songs.
    const inGenre = await songGenreFilterSql(genre, "t", "al");

    const rows = await prisma.$queryRaw<SongRow[]>`
        SELECT ${SONG_COLUMNS} FROM ${SONG_FROM}
        WHERE ${PLAYABLE_SQL}
          AND ${inGenre}
        ORDER BY ${shownSongTitleSql("t")} ASC, t.id ASC
        OFFSET ${offset}
        LIMIT ${count}
    `;
    const songs = await songsOf(rows);

    return subsonicOk(req, res, {
        songsByGenre: songs.length > 0 ? { song: songs } : {},
    });
}));

// ===================== TOP SONGS =====================

searchRouter.all("/getTopSongs.view", wrap(async (req, res) => {
    const artistParam = one(req, "artist");
    if (!artistParam) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: artist");
    }

    const count = clamp(parseIntParam(one(req, "count"), 50), 1, 500);

    // The exact name is found by its identity key (indexed, built in TypeScript); a display name is compared the same
    // way over the few artists that have one; otherwise the text is matched inside a name with a case-blind pattern,
    // since the database folds ASCII case only.
    const inLibrary = { albums: { some: PLAYABLE_ALBUM_WHERE } };
    const wantedKey = artistIdentityKey(artistParam);
    let chosenId: string | undefined = wantedKey
        ? (await prisma.artist.findFirst({ where: { ...inLibrary, identityKey: wantedKey }, select: { id: true }, orderBy: { id: "asc" } }))?.id
        : (await prisma.artist.findFirst({ where: { ...inLibrary, name: artistParam }, select: { id: true }, orderBy: { id: "asc" } }))?.id;
    if (!chosenId) {
        const named = await prisma.artist.findMany({
            where: { ...inLibrary, displayName: { not: null } },
            select: { id: true, displayName: true },
            orderBy: { id: "asc" },
        });
        chosenId = named.find((a) => (wantedKey ? artistIdentityKey(a.displayName) === wantedKey : a.displayName === artistParam))?.id;
    }
    if (!chosenId) {
        const pattern = foldedPattern(artistParam);
        [{ id: chosenId } = { id: undefined }] = await prisma.$queryRaw<{ id: string | undefined }[]>`
            SELECT a.id FROM "Artist" a
             WHERE ${artistHasPlayableSongSql("a")} AND (a.name ~ ${pattern} OR a."displayName" ~ ${pattern})
             ORDER BY a.id LIMIT 1`;
    }
    const artist = chosenId
        ? await prisma.artist.findUnique({
              where: { id: chosenId },
              select: { id: true, name: true, mbid: true },
          })
        : null;

    if (!artist) {
        return subsonicOk(req, res, { topSongs: {} });
    }

    // The owned songs of the artist's popular-songs list, the order the web artist page shows them in.
    const popular = await popularSongs({ artist, userId: req.user!.id, limit: count, previews: false });
    const songs = await songsOf(await playableSongsInOrder(popular.flatMap((p) => p.trackId ?? [])));

    return subsonicOk(req, res, {
        topSongs: songs.length > 0 ? { song: songs } : {},
    });
}));

// ===================== SIMILAR SONGS =====================

// getSimilarSongs2 and the legacy getSimilarSongs answer with the same songs under different keys, told apart by route.
const similarSongsRoute = (responseKey: "similarSongs2" | "similarSongs") => wrap(async (req, res) => {
    const id = one(req, "id");
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const count = clamp(parseIntParam(one(req, "count"), 50), 1, 500);

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
        return subsonicOk(req, res, { [responseKey]: {} });
    }

    const similarArtists = await prisma.similarArtist.findMany({
        where: {
            fromArtistId: artistId,
            toArtist: { albums: { some: PLAYABLE_ALBUM_WHERE } },
        },
        orderBy: { weight: "desc" },
        take: 50,
        select: { toArtistId: true },
    });

    const artistIds = Array.from(
        new Set([artistId, ...similarArtists.map((item) => item.toArtistId)])
    );
    const artistIdList = artistIds.map((id) => Prisma.sql`${id}`);

    const rows = await prisma.$queryRaw<SongRow[]>`
        SELECT ${SONG_COLUMNS} FROM ${SONG_FROM}
        WHERE ${PLAYABLE_SQL}
          AND al."artistId" IN (${Prisma.join(artistIdList, ", ")})
        ORDER BY RANDOM()
        LIMIT ${count}
    `;
    const songs = await songsOf(rows);

    return subsonicOk(req, res, {
        [responseKey]: songs.length > 0 ? { song: songs } : {},
    });
});
searchRouter.all("/getSimilarSongs2.view", similarSongsRoute("similarSongs2"));
searchRouter.all("/getSimilarSongs.view", similarSongsRoute("similarSongs"));
