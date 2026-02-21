// backend/src/routes/subsonic/library.ts
import { Router, Request, Response } from "express";
import { prisma } from "../../utils/db";
import { subsonicOk, subsonicError, SubsonicError } from "../../utils/subsonicResponse";
import { mapArtist, mapAlbum, mapSong } from "./mappers";

export const libraryRouter = Router();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrap(fn: (req: Request, res: Response) => Promise<any>) {
    return (req: Request, res: Response) => {
        fn(req, res).catch((err: unknown) => {
            if (!res.headersSent) {
                const msg = err instanceof Error ? err.message : "Internal error";
                subsonicError(req, res, SubsonicError.GENERIC, msg);
            }
        });
    };
}

const IGNORED_ARTICLES = ["the ", "a ", "an "];

function artistSortKey(name: string): string {
    const lower = name.toLowerCase();
    for (const article of IGNORED_ARTICLES) {
        if (lower.startsWith(article)) return name.slice(article.length);
    }
    return name;
}

// ===================== ARTISTS =====================

// getIndexes is the legacy alias for getArtists used by DSub and some older clients
libraryRouter.all(["/getArtists.view", "/getIndexes.view"], wrap(async (req, res) => {
    const artists = await prisma.artist.findMany({
        where: { libraryAlbumCount: { gt: 0 } },
        orderBy: { name: "asc" },
        select: {
            id: true,
            name: true,
            displayName: true,
            heroUrl: true,
            libraryAlbumCount: true,
        },
    });

    const buckets: Record<string, ReturnType<typeof mapArtist>[]> = {};
    for (const a of artists) {
        const effective = artistSortKey(a.displayName || a.name);
        const first = effective[0]?.toUpperCase() ?? "#";
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

    subsonicOk(req, res, {
        artists: {
            "@_ignoredArticles": "The An A Is Los Las Le Les",
            index: indexes,
        },
    });
}));

libraryRouter.all("/getArtist.view", wrap(async (req, res) => {
    const id = req.query.id as string;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const artist = await prisma.artist.findUnique({
        where: { id },
        include: {
            albums: {
                where: { tracks: { some: {} } },
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
    subsonicOk(req, res, {
        artist: {
            ...mapArtist({ ...artist, albumCount: artist.albums.length }),
            album: artist.albums.map((al) =>
                mapAlbum({ ...al, songCount: al._count.tracks }, artistName)
            ),
        },
    });
}));

// ===================== ALBUMS =====================

libraryRouter.all("/getAlbum.view", wrap(async (req, res) => {
    const id = req.query.id as string;
    if (!id) {
        return subsonicError(req, res, SubsonicError.MISSING_PARAM, "Required parameter is missing: id");
    }

    const album = await prisma.album.findUnique({
        where: { id },
        include: {
            artist: { select: { id: true, name: true, displayName: true } },
            tracks: { orderBy: { trackNo: "asc" } },
        },
    });
    if (!album) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Album not found");
    }

    const artistName = album.artist.displayName || album.artist.name;
    const totalDuration = album.tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);

    subsonicOk(req, res, {
        album: {
            ...mapAlbum({ ...album, songCount: album.tracks.length, duration: totalDuration }, artistName),
            song: album.tracks.map((t) =>
                mapSong(
                    { ...t, fileSize: t.fileSize !== null ? BigInt(t.fileSize) : null },
                    album,
                    artistName,
                    album.artist.id
                )
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
                    artist: { select: { id: true, name: true, displayName: true } },
                },
            },
        },
    });
    if (!track) {
        return subsonicError(req, res, SubsonicError.NOT_FOUND, "Song not found");
    }

    const artistName = track.album.artist.displayName || track.album.artist.name;
    subsonicOk(req, res, {
        song: mapSong(
            { ...track, fileSize: track.fileSize !== null ? BigInt(track.fileSize) : null },
            track.album,
            artistName,
            track.album.artist.id
        ),
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
    };
};

// getAlbumList2 is ID3-tagged; getAlbumList is the legacy folder-based alias
libraryRouter.all(["/getAlbumList2.view", "/getAlbumList.view"], wrap(async (req, res) => {
    const type = (req.query.type as string) || "newest";
    const size = Math.min(parseInt((req.query.size as string) || "10", 10), 500);
    const offset = parseInt((req.query.offset as string) || "0", 10);
    const userId = req.user!.id;

    let albums: AlbumWithArtist[] = [];

    switch (type) {
        case "newest":
            albums = await prisma.album.findMany({
                where: { tracks: { some: {} } },
                // Album has no createdAt; cuid() IDs are time-sortable
                orderBy: { id: "desc" },
                take: size,
                skip: offset,
                include: { artist: { select: { id: true, name: true, displayName: true } } },
            });
            break;

        case "alphabeticalByName":
            albums = await prisma.album.findMany({
                where: { tracks: { some: {} } },
                orderBy: { title: "asc" },
                take: size,
                skip: offset,
                include: { artist: { select: { id: true, name: true, displayName: true } } },
            });
            break;

        case "alphabeticalByArtist":
            albums = await prisma.album.findMany({
                where: { tracks: { some: {} } },
                orderBy: { artist: { name: "asc" } },
                take: size,
                skip: offset,
                include: { artist: { select: { id: true, name: true, displayName: true } } },
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
                    year: {
                        gte: Math.min(fromYear, toYear),
                        lte: Math.max(fromYear, toYear),
                    },
                    tracks: { some: {} },
                },
                orderBy: { year: fromYear <= toYear ? "asc" : "desc" },
                take: size,
                skip: offset,
                include: { artist: { select: { id: true, name: true, displayName: true } } },
            });
            break;
        }

        case "byGenre": {
            const genre = req.query.genre as string;
            if (!genre) {
                return subsonicError(req, res, SubsonicError.MISSING_PARAM, "byGenre requires genre");
            }
            // genres is a JSON array column; use raw query for ILIKE match
            const rows = await prisma.$queryRaw<AlbumWithArtist[]>`
                SELECT a.id, a.title, a."displayTitle", a.year, a."coverUrl", a."userCoverUrl", a."artistId",
                       json_build_object('id', ar.id, 'name', ar.name, 'displayName', ar."displayName") as artist
                FROM "Album" a
                JOIN "Artist" ar ON a."artistId" = ar.id
                WHERE a.genres::text ILIKE ${"%" + genre + "%"}
                  AND EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = a.id)
                ORDER BY a.title ASC
                LIMIT ${size} OFFSET ${offset}
            `;
            albums = rows;
            break;
        }

        case "starred":
            albums = await prisma.album.findMany({
                where: {
                    tracks: {
                        some: {
                            likedBy: { some: { userId } },
                        },
                    },
                },
                orderBy: { title: "asc" },
                take: size,
                skip: offset,
                include: { artist: { select: { id: true, name: true, displayName: true } } },
            });
            break;

        case "random": {
            const rows = await prisma.$queryRaw<AlbumWithArtist[]>`
                SELECT a.id, a.title, a."displayTitle", a.year, a."coverUrl", a."userCoverUrl", a."artistId",
                       json_build_object('id', ar.id, 'name', ar.name, 'displayName', ar."displayName") as artist
                FROM "Album" a
                JOIN "Artist" ar ON a."artistId" = ar.id
                WHERE EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = a.id)
                ORDER BY RANDOM()
                LIMIT ${size}
            `;
            albums = rows;
            break;
        }

        case "recent": {
            const rows = await prisma.$queryRaw<AlbumWithArtist[]>`
                SELECT a.id, a.title, a."displayTitle", a.year, a."coverUrl", a."userCoverUrl", a."artistId",
                       json_build_object('id', ar.id, 'name', ar.name, 'displayName', ar."displayName") as artist
                FROM "Album" a
                JOIN "Artist" ar ON a."artistId" = ar.id
                JOIN "Track" t ON t."albumId" = a.id
                JOIN "Play" p ON p."trackId" = t.id
                WHERE p."userId" = ${userId}
                GROUP BY a.id, a.title, a."displayTitle", a.year, a."coverUrl", a."userCoverUrl", a."artistId",
                         ar.id, ar.name, ar."displayName"
                ORDER BY MAX(p."playedAt") DESC
                LIMIT ${size} OFFSET ${offset}
            `;
            albums = rows;
            break;
        }

        case "frequent": {
            const rows = await prisma.$queryRaw<AlbumWithArtist[]>`
                SELECT a.id, a.title, a."displayTitle", a.year, a."coverUrl", a."userCoverUrl", a."artistId",
                       json_build_object('id', ar.id, 'name', ar.name, 'displayName', ar."displayName") as artist
                FROM "Album" a
                JOIN "Artist" ar ON a."artistId" = ar.id
                JOIN "Track" t ON t."albumId" = a.id
                JOIN "Play" p ON p."trackId" = t.id
                WHERE p."userId" = ${userId}
                GROUP BY a.id, a.title, a."displayTitle", a.year, a."coverUrl", a."userCoverUrl", a."artistId",
                         ar.id, ar.name, ar."displayName"
                ORDER BY COUNT(p.id) DESC
                LIMIT ${size} OFFSET ${offset}
            `;
            albums = rows;
            break;
        }

        default:
            albums = await prisma.album.findMany({
                where: { tracks: { some: {} } },
                orderBy: { id: "desc" },
                take: size,
                skip: offset,
                include: { artist: { select: { id: true, name: true, displayName: true } } },
            });
    }

    const albumList = albums.map((a) => {
        const artistName = a.artist.displayName || a.artist.name;
        return mapAlbum({ ...a, artistId: a.artist.id }, artistName);
    });

    const key = req.path.includes("getAlbumList2") ? "albumList2" : "albumList";
    subsonicOk(req, res, { [key]: { album: albumList } });
}));

// ===================== GENRES =====================

libraryRouter.all("/getGenres.view", wrap(async (req, res) => {
    const albums = await prisma.album.findMany({
        select: {
            genres: true,
            _count: { select: { tracks: true } },
        },
    });

    const genreCounts: Record<string, { albums: number; songs: number }> = {};
    for (const album of albums) {
        if (!album.genres) continue;
        const genres = (album.genres as string[]) || [];
        for (const g of genres) {
            if (!g) continue;
            if (!genreCounts[g]) genreCounts[g] = { albums: 0, songs: 0 };
            genreCounts[g].albums++;
            genreCounts[g].songs += album._count.tracks;
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
