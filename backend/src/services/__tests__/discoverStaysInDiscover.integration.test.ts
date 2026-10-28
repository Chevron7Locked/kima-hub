/**
 * Discover songs live only in Discover. Against the real test database: the collection's show choice ("in your library" the library only, "recommended" this listener's own
 * Discover albums, "all" both), every radio, search, and a like or unlike moving the whole album. Only the login and
 * the enrichment trigger a like fires are stand-ins.
 */
jest.mock("../../workers/unifiedEnrichment", () => ({
    triggerEnrichmentNow: jest.fn().mockResolvedValue({ artists: 0, tracks: 0, audioQueued: 0 }),
}));
// The like and unlike routes: a signed-in listener (named by a header here) and a Lidarr that is not set up.
jest.mock("../../middleware/auth", () => {
    const signIn = (req: any, _res: any, next: any) => {
        req.user = { id: req.headers["x-test-user"], role: "admin" };
        next();
    };
    return { requireAuthOrToken: signIn, requireAuth: signIn, requireAdmin: signIn, requireAcquirePermission: signIn };
});
jest.mock("../../services/lidarr", () => ({
    lidarrService: {
        removeDiscoveryTagByMbid: jest.fn().mockResolvedValue(false),
        getArtists: jest.fn().mockResolvedValue([]),
        getOrCreateDiscoveryTag: jest.fn().mockResolvedValue(null),
        removeTagsFromArtist: jest.fn().mockResolvedValue(undefined),
    },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { artistIdentityKey } from "../artistIdentity";
import albumsRouter from "../../routes/library/albums";
import artistsRouter from "../../routes/library/artists";
import tracksRouter from "../../routes/library/tracks";
import { searchService } from "../search";
import discoverRouter from "../../routes/discover";
import { returnToDiscover, takeIntoLibrary } from "../discovery/discoveryAlbumLifecycle";
import { triggerEnrichmentNow } from "../../workers/unifiedEnrichment";

jest.setTimeout(120_000);

const P = "dsd_";
const ME = `${P}me`;
const OTHER = `${P}other`;

/** Album key, its artist key, location, whose current Discover suggestion it is. */
const ALBUMS = [
    { key: "lib", artist: "libart", location: "LIBRARY", suggestedTo: null },
    { key: "mine", artist: "discart", location: "DISCOVER", suggestedTo: ME },
    { key: "theirs", artist: "otherart", location: "DISCOVER", suggestedTo: OTHER },
] as const;
const ARTIST_NAMES: Record<string, string> = {
    libart: "Quorvex Library",
    discart: "Quorvex Suggested",
    otherart: "Quorvex Elsewhere",
};
const trackIds = (album: string) => [0, 1, 2].map((i) => `${P}trk_${album}_${i}`);
const DISCOVER_TRACKS = [...trackIds("mine"), ...trackIds("theirs")];

const app = (userId: string) => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
        req.user = { id: userId } as typeof req.user;
        next();
    });
    a.use("/", albumsRouter);
    a.use("/", artistsRouter);
    a.use("/", tracksRouter);
    return a;
};

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.playlist.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.downloadJob.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.ownedAlbum.deleteMany({ where: { rgMbid: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    for (const id of [ME, OTHER]) await prisma.user.create({ data: { id, username: id, passwordHash: "x" } });
    for (const [key, name] of Object.entries(ARTIST_NAMES)) {
        await prisma.artist.create({
            data: { id: `${P}${key}`, name, normalizedName: name.toLowerCase(), identityKey: artistIdentityKey(name), genres: ["quorvex rock"] },
        });
    }
    for (const album of ALBUMS) {
        await prisma.album.create({
            data: {
                id: `${P}alb_${album.key}`,
                rgMbid: `${P}rg_${album.key}`,
                artistId: `${P}${album.artist}`,
                identityKey: `${P}aik_${album.key}`,
                title: `Quorvex Album ${album.key}`,
                primaryType: "Album",
                year: 1995,
                location: album.location,
            },
        });
        await prisma.track.createMany({
            data: trackIds(album.key).map((id, i) => ({
                id,
                albumId: `${P}alb_${album.key}`,
                title: `Quorvex Song ${album.key} ${i}`,
                trackNo: i + 1,
                duration: 200,
                filePath: `/tmp/${id}.flac`,
                fileModified: new Date(),
                fileSize: 1000,
            })),
        });
        if (album.suggestedTo) {
            await prisma.discoveryAlbum.create({
                data: {
                    userId: album.suggestedTo,
                    rgMbid: `${P}rg_${album.key}`,
                    artistName: ARTIST_NAMES[album.artist],
                    albumTitle: `Quorvex Album ${album.key}`,
                    weekStartDate: new Date(Date.UTC(2026, 9, 19)),
                    status: "ACTIVE",
                },
            });
        }
    }
    // A stale ownership row for a Discover album (left by an old demotion or an unlike): it must not put the album
    // in the library.
    await prisma.ownedAlbum.create({ data: { artistId: `${P}discart`, rgMbid: `${P}rg_mine`, source: "discovery_liked" } });
    // Plays of Discover songs: they feed nothing outside Discover.
    for (const trackId of DISCOVER_TRACKS) await prisma.play.create({ data: { userId: ME, trackId } });
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

const discoverApp = express();
discoverApp.use(express.json());
discoverApp.use("/discover", discoverRouter);
const like = (userId: string, rgMbid: string) =>
    request(discoverApp).post("/discover/like").set("x-test-user", userId).send({ albumId: rgMbid });
const unlike = (userId: string, rgMbid: string) =>
    request(discoverApp).delete("/discover/unlike").set("x-test-user", userId).send({ albumId: rgMbid });

const ownIds = (rows: { id: string }[]) => rows.map((r) => r.id).filter((id) => id.startsWith(P)).sort();

describe("the collection's show choice", () => {
    it.each([
        ["owned", [`${P}alb_lib`]],
        ["discovery", [`${P}alb_mine`]],
        ["all", [`${P}alb_lib`, `${P}alb_mine`]],
        ["something else", [`${P}alb_lib`]],
    ])("albums, %s", async (filter, expected) => {
        const res = await request(app(ME)).get("/albums").query({ filter, limit: 500 });
        expect(res.status).toBe(200);
        expect(ownIds(res.body.albums)).toEqual(expected);
    });

    it.each([
        ["owned", [`${P}libart`]],
        ["discovery", [`${P}discart`]],
        ["all", [`${P}discart`, `${P}libart`]],
    ])("artists, %s, in both sort paths", async (filter, expected) => {
        for (const sortBy of ["name", "tracks"]) {
            const res = await request(app(ME)).get("/artists").query({ filter, sortBy, limit: 500 });
            expect(res.status).toBe(200);
            expect(ownIds(res.body.artists)).toEqual(expected);
        }
    });

    it("counts an artist's Discover albums as this listener's only", async () => {
        const res = await request(app(ME)).get("/artists").query({ filter: "discovery" });
        const card = (res.body.artists as { id: string; albumCount: number }[]).find((a) => a.id === `${P}discart`);
        expect(card?.albumCount).toBe(1);
    });

    it("never shows another listener's Discover albums", async () => {
        const mine = await request(app(ME)).get("/albums").query({ filter: "discovery" });
        const theirs = await request(app(OTHER)).get("/albums").query({ filter: "discovery" });
        expect(ownIds(mine.body.albums)).toEqual([`${P}alb_mine`]);
        expect(ownIds(theirs.body.albums)).toEqual([`${P}alb_theirs`]);
    });
});

describe("radio plays no Discover song", () => {
    it.each([
        { type: "all" },
        { type: "decade", value: "1990" },
        { type: "favorites" },
        { type: "discovery" },
        { type: "genre", value: "quorvex rock" },
        { type: "artist", value: `${P}discart` },
        { type: "artist", value: `${P}libart` },
    ])("%o", async (query) => {
        const res = await request(app(ME)).get("/radio").query({ ...query, limit: 100 });
        expect(res.status).toBe(200);
        const ids = (res.body.tracks as { id: string }[]).map((t) => t.id);
        expect(ids.filter((id) => DISCOVER_TRACKS.includes(id))).toEqual([]);
    });

    it("the genre and artist stations still play the library's songs", async () => {
        for (const query of [{ type: "genre", value: "quorvex rock" }, { type: "artist", value: `${P}libart` }]) {
            const res = await request(app(ME)).get("/radio").query({ ...query, limit: 100 });
            expect(ownIds(res.body.tracks)).toEqual(trackIds("lib").sort());
        }
    });
});

describe("search finds no Discover song, album or artist", () => {
    it("songs", async () => {
        const tracks = await searchService.searchTracks({ query: "Quorvex", limit: 50 });
        expect(ownIds(tracks)).toEqual(trackIds("lib").sort());
    });

    it("albums", async () => {
        const albums = await searchService.searchAlbums({ query: "Quorvex", limit: 50 });
        expect(ownIds(albums)).toEqual([`${P}alb_lib`]);
    });

    it("artists", async () => {
        const artists = await searchService.searchArtists({ query: "Quorvex", limit: 50 });
        expect(ownIds(artists)).toEqual([`${P}libart`]);
    });
});

describe("a like takes the whole album into the library; an unlike puts it back", () => {
    const album = () => prisma.album.findUniqueOrThrow({ where: { id: `${P}alb_mine` } });

    it("moves it, starts enrichment, and back again with the ownership the like gave it", async () => {
        // The stale ownership row from beforeAll is not a like's: start from none.
        await prisma.ownedAlbum.deleteMany({ where: { rgMbid: `${P}rg_mine` } });
        await takeIntoLibrary(await album());
        expect((await album()).location).toBe("LIBRARY");
        expect(triggerEnrichmentNow).toHaveBeenCalled();
        const res = await request(app(ME)).get("/albums").query({ filter: "owned" });
        expect(ownIds(res.body.albums)).toEqual([`${P}alb_lib`, `${P}alb_mine`]);

        expect(await returnToDiscover(await album())).toBe(true);
        expect((await album()).location).toBe("DISCOVER");
        expect(await prisma.ownedAlbum.count({ where: { rgMbid: `${P}rg_mine` } })).toBe(0);
    });

    it("an album the listener already had stays theirs when a like of its suggestion is undone", async () => {
        await prisma.ownedAlbum.create({ data: { artistId: `${P}discart`, rgMbid: `${P}rg_mine`, source: "native_scan" } });
        await takeIntoLibrary(await album());
        expect(await returnToDiscover(await album())).toBe(false);
        expect((await album()).location).toBe("LIBRARY");
        await prisma.ownedAlbum.deleteMany({ where: { rgMbid: `${P}rg_mine` } });
        await prisma.album.update({ where: { id: `${P}alb_mine` }, data: { location: "DISCOVER" } });
    });

    it("stays in the library when the listener requested its download themselves", async () => {
        // The listener liked one Discover song, then asked for the album on their own: the download
        // request makes the album theirs, so undoing the like leaves it in the library.
        await prisma.ownedAlbum.deleteMany({ where: { rgMbid: `${P}rg_mine` } });
        await takeIntoLibrary(await album());
        await prisma.downloadJob.create({
            data: {
                userId: ME,
                subject: "Quorvex Album mine",
                type: "album",
                status: "completed",
                targetMbid: `${P}rg_mine`,
                metadata: { artistName: ARTIST_NAMES.discart, albumTitle: "Quorvex Album mine", downloadType: "library" },
            },
        });
        try {
            expect(await returnToDiscover(await album())).toBe(false);
            expect((await album()).location).toBe("LIBRARY");
            expect(await prisma.ownedAlbum.count({ where: { rgMbid: `${P}rg_mine`, source: "discovery_liked" } })).toBe(1);
        } finally {
            await prisma.downloadJob.deleteMany({ where: { userId: ME, targetMbid: `${P}rg_mine` } });
        }
        // The request gone, the unlike takes the album back.
        expect(await returnToDiscover(await album())).toBe(true);
        expect((await album()).location).toBe("DISCOVER");
    });

    it("stays in the library while a playlist holds its songs", async () => {
        await prisma.ownedAlbum.deleteMany({ where: { rgMbid: `${P}rg_mine` } });
        await takeIntoLibrary(await album());
        const playlist = await prisma.playlist.create({ data: { userId: ME, name: `${P}mix` } });
        await prisma.playlistItem.create({ data: { playlistId: playlist.id, trackId: trackIds("mine")[0], sort: 0 } });
        try {
            expect(await returnToDiscover(await album())).toBe(false);
            expect((await album()).location).toBe("LIBRARY");
        } finally {
            await prisma.playlistItem.deleteMany({ where: { playlistId: playlist.id } });
            await prisma.playlist.delete({ where: { id: playlist.id } });
        }
        // The playlist emptied, the unlike takes the album back.
        expect(await returnToDiscover(await album())).toBe(true);
        expect((await album()).location).toBe("DISCOVER");
    });

    it("stays in the library while another listener's like keeps it, under either id", async () => {
        await prisma.ownedAlbum.deleteMany({ where: { rgMbid: `${P}rg_mine` } });
        await takeIntoLibrary(await album());
        const like = await prisma.discoveryAlbum.create({
            data: {
                userId: OTHER,
                rgMbid: `${P}suggested_as_mine`,
                artistName: ARTIST_NAMES.discart,
                albumTitle: "Quorvex Album mine",
                weekStartDate: new Date(Date.UTC(2026, 9, 19)),
                status: "LIKED",
            },
        });
        try {
            expect(await returnToDiscover(await album(), `${P}suggested_as_mine`)).toBe(false);
            expect((await album()).location).toBe("LIBRARY");
        } finally {
            await prisma.discoveryAlbum.delete({ where: { id: like.id } });
        }
        expect(await returnToDiscover(await album(), `${P}suggested_as_mine`)).toBe(true);
    });

    it("stays in the library while a LIKED suggestion under a different release-group id names the same album", async () => {
        // Discover suggested this album under a second release-group id and a listener liked
        // that suggestion. The album's own suggestion stays ACTIVE and its ownership came from
        // the like, so only the evidence rule can keep the album: it matches by artist and
        // title, not just by id. Undoing the album's own like must leave it in the library.
        await prisma.ownedAlbum.deleteMany({ where: { rgMbid: `${P}rg_mine` } });
        await takeIntoLibrary(await album());
        const likedElsewhere = await prisma.discoveryAlbum.create({
            data: {
                userId: OTHER,
                rgMbid: `${P}rg_liked_by_name`,
                artistName: ARTIST_NAMES.discart,
                albumTitle: "Quorvex Album mine",
                weekStartDate: new Date(Date.UTC(2026, 9, 19)),
                status: "LIKED",
            },
        });
        try {
            expect(await returnToDiscover(await album())).toBe(false);
            expect((await album()).location).toBe("LIBRARY");
            expect(await prisma.ownedAlbum.count({ where: { rgMbid: `${P}rg_mine`, source: "discovery_liked" } })).toBe(1);
        } finally {
            await prisma.discoveryAlbum.delete({ where: { id: likedElsewhere.id } });
        }
        // A suggestion alone is no evidence: with the LIKED record gone, every suggestion for
        // the album is ACTIVE and the album goes back to Discover.
        expect(await returnToDiscover(await album())).toBe(true);
        expect((await album()).location).toBe("DISCOVER");
    });
});

describe("like and unlike through the routes", () => {
    const where = async () => (await prisma.album.findUniqueOrThrow({ where: { id: `${P}alb_theirs` } })).location;
    const likeRows = () => prisma.ownedAlbum.count({ where: { rgMbid: `${P}rg_theirs`, source: "discovery_liked" } });

    beforeAll(async () => {
        // The other album is suggested to both listeners this week.
        await prisma.discoveryAlbum.create({
            data: {
                userId: ME,
                rgMbid: `${P}rg_theirs`,
                artistName: ARTIST_NAMES.otherart,
                albumTitle: "Quorvex Album theirs",
                weekStartDate: new Date(Date.UTC(2026, 9, 19)),
                status: "ACTIVE",
            },
        });
    });

    it("one listener's unlike keeps the album, and its ownership, for another who liked it", async () => {
        expect((await like(ME, `${P}rg_theirs`)).status).toBe(200);
        expect((await like(OTHER, `${P}rg_theirs`)).status).toBe(200);
        expect(await where()).toBe("LIBRARY");

        expect((await unlike(ME, `${P}rg_theirs`)).status).toBe(200);
        expect(await where()).toBe("LIBRARY");
        expect(await likeRows()).toBe(1);
    });

    it("the last unlike puts it back in Discover", async () => {
        expect((await unlike(OTHER, `${P}rg_theirs`)).status).toBe(200);
        expect(await where()).toBe("DISCOVER");
        expect(await likeRows()).toBe(0);
    });

    it("when the suggestion's id is no album's, unlike sends back the album the like brought in, not the listener's own copy", async () => {
        const title = "Quorvex Album twice";
        // The listener's own copy, scanned first, and Discover's download of the same album.
        for (const [key, location] of [["0own", "LIBRARY"], ["twice", "DISCOVER"]] as const) {
            await prisma.album.create({
                data: {
                    id: `${P}alb_${key}`,
                    rgMbid: `${P}rg_${key}`,
                    artistId: `${P}otherart`,
                    identityKey: `${P}aik_${key}`,
                    title,
                    primaryType: "Album",
                    location,
                },
            });
        }
        await prisma.ownedAlbum.create({ data: { artistId: `${P}otherart`, rgMbid: `${P}rg_0own`, source: "native_scan" } });
        await prisma.discoveryAlbum.create({
            data: {
                userId: ME,
                // The id Discover suggested; the scanned album has its own.
                rgMbid: `${P}rg_suggested`,
                artistName: ARTIST_NAMES.otherart,
                albumTitle: title,
                weekStartDate: new Date(Date.UTC(2026, 9, 19)),
                status: "ACTIVE",
            },
        });
        expect((await like(ME, `${P}rg_suggested`)).status).toBe(200);
        const location = async (id: string) => (await prisma.album.findUniqueOrThrow({ where: { id } })).location;
        expect(await location(`${P}alb_twice`)).toBe("LIBRARY");

        expect((await unlike(ME, `${P}rg_suggested`)).status).toBe(200);
        expect(await location(`${P}alb_twice`)).toBe("DISCOVER");
        expect(await location(`${P}alb_0own`)).toBe("LIBRARY");
        expect(await prisma.ownedAlbum.findMany({ where: { rgMbid: { in: [`${P}rg_0own`, `${P}rg_twice`] } }, select: { rgMbid: true, source: true } })).toEqual([
            { rgMbid: `${P}rg_0own`, source: "native_scan" },
        ]);
    });
});

