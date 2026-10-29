import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { artistIdentityKey } from "../../services/artistIdentity";
import { foldedPattern } from "../../services/textMatch";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { searchService } from "../../services/search";
import { wrap, clamp, parseIntParam, firstArtistGenre, mapSong } from "./mappers";
import { LIBRARY_LOCATION } from "../../services/libraryFilters";
import { libraryArtistIdsForGenre } from "../../utils/genreSql";

export const searchRouter = Router();

/** What every song list here reads: the song, its album and its artist. */
const SONG_COLUMNS = Prisma.sql`
    t.id, t.title, t."displayTitle", t."trackNo", t."discNumber", t.duration, t.mime, t."fileSize",
    al.id AS "albumId", al.title AS "albumTitle", al."displayTitle" AS "albumDisplayTitle", al.year AS "albumYear",
    ar.id AS "artistId", ar.name AS "artistName", ar."displayName" AS "artistDisplayName",
    ar.genres AS "artistGenres", ar."userGenres" AS "artistUserGenres"`;
const SONG_FROM = Prisma.sql`"Track" t JOIN "Album" al ON t."albumId" = al.id JOIN "Artist" ar ON al."artistId" = ar.id`;
/** Songs a client can play: on a library album, with a file that is present and readable. */
const PLAYABLE_SONG = Prisma.sql`al.location = 'LIBRARY' AND t.corrupt = false AND t."missingSince" IS NULL`;

type SongRow = {
    id: string;
    title: string;
    displayTitle: string | null;
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
};

function songOf(row: SongRow) {
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
            fileSize: row.fileSize,
        },
        { id: row.albumId, title: row.albumTitle, displayTitle: row.albumDisplayTitle, year: row.albumYear },
        row.artistDisplayName || row.artistName,
        row.artistId,
        firstArtistGenre(row.artistGenres, row.artistUserGenres),
    );
}

/** The playable songs among `ids`, in the order given. */
async function playableSongsInOrder(ids: string[]): Promise<SongRow[]> {
    if (ids.length === 0) return [];
    const rows = await prisma.$queryRaw<SongRow[]>`
        SELECT ${SONG_COLUMNS} FROM ${SONG_FROM}
        WHERE t.id = ANY(${ids}::text[]) AND ${PLAYABLE_SONG}`;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => byId.get(id) ?? []);
}

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
    let tracks: SongRow[];

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
                ? prisma.$queryRaw<SongRow[]>`
                      SELECT ${SONG_COLUMNS} FROM ${SONG_FROM}
                      WHERE ${PLAYABLE_SONG}
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
                      .then((rows) => playableSongsInOrder(rows.map((t) => t.id)))
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

    // The albums' artist genres in one query; songs carry their own.
    const artistIds = new Set(albums.map((al) => al.artistId));
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
        result.song = tracks.map(songOf);
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

    const whereConditions: Prisma.Sql[] = [PLAYABLE_SONG];

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
        // Genre lives on Artist, not Album — the artists carrying the genre, matched by genreKey
        // exactly as the web's genre filters do. A genre nothing carries (an empty name, a genre
        // no artist has) matches no song.
        const tagged = await libraryArtistIdsForGenre(genre);
        whereConditions.push(
            tagged.length > 0 ? Prisma.sql`ar.id = ANY(${tagged}::text[])` : Prisma.sql`1 = 0`,
        );
    }

    const whereClause = Prisma.join(whereConditions, " AND ");

    const rows = await prisma.$queryRaw<SongRow[]>`
        SELECT ${SONG_COLUMNS} FROM ${SONG_FROM}
        WHERE ${whereClause}
        ORDER BY RANDOM()
        LIMIT ${size}
    `;
    const songs = rows.map(songOf);

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

    // The artists carrying the genre, matched by genreKey exactly as the web's genre filters do;
    // a genre nothing carries has no songs.
    const genreArtistIds = await libraryArtistIdsForGenre(genre);

    const rows = await prisma.$queryRaw<SongRow[]>`
        SELECT ${SONG_COLUMNS} FROM ${SONG_FROM}
        WHERE ${PLAYABLE_SONG}
          AND ${genreArtistIds.length > 0 ? Prisma.sql`al."artistId" = ANY(${genreArtistIds}::text[])` : Prisma.sql`1 = 0`}
        ORDER BY LOWER(t.title) ASC, t.title ASC
        OFFSET ${offset}
        LIMIT ${count}
    `;
    const songs = rows.map(songOf);

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

    // The exact name is found by its identity key (indexed, built in TypeScript); a display name is compared the same
    // way over the few artists that have one; otherwise the text is matched inside a name with a case-blind pattern,
    // since the database folds ASCII case only.
    const inLibrary = { libraryAlbumCount: { gt: 0 } };
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
             WHERE a."libraryAlbumCount" > 0 AND (a.name ~ ${pattern} OR a."displayName" ~ ${pattern})
             ORDER BY a.id LIMIT 1`;
    }
    const artist = chosenId
        ? await prisma.artist.findUnique({
              where: { id: chosenId },
              select: { id: true },
          })
        : null;

    if (!artist) {
        return subsonicOk(req, res, { topSongs: {} });
    }

    const rows = await prisma.$queryRaw<SongRow[]>`
        SELECT ${SONG_COLUMNS}
        FROM ${SONG_FROM}
        CROSS JOIN LATERAL (SELECT COUNT(*)::int AS plays FROM "Play" pl WHERE pl."trackId" = t.id) p
        WHERE ${PLAYABLE_SONG}
          AND al."artistId" = ${artist.id}
        ORDER BY p.plays DESC, LOWER(t.title) ASC, t.title ASC
        LIMIT ${count}
    `;
    const songs = rows.map(songOf);

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

    const rows = await prisma.$queryRaw<SongRow[]>`
        SELECT ${SONG_COLUMNS} FROM ${SONG_FROM}
        WHERE ${PLAYABLE_SONG}
          AND al."artistId" IN (${Prisma.join(artistIdList, ", ")})
        ORDER BY RANDOM()
        LIMIT ${count}
    `;
    const songs = rows.map(songOf);

    const responseKey = req.path.startsWith("/getSimilarSongs2") ? "similarSongs2" : "similarSongs";
    return subsonicOk(req, res, {
        [responseKey]: songs.length > 0 ? { song: songs } : {},
    });
}));
