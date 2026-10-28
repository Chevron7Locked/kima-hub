/**
 * Names with accents, other alphabets and curly apostrophes must match whatever letter case the listener types,
 * on the database encoding real installs use (SQL_ASCII, where Postgres folds case for ASCII letters only).
 * Real database, real routers and services.
 */

jest.mock("../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../lidarr", () => ({
    lidarrService: {
        isEnabled: jest.fn().mockResolvedValue(true),
        getAlbum: jest.fn(),
        getArtistById: jest.fn(),
        getOrCreateDiscoveryTag: jest.fn(),
        unmonitorAlbum: jest.fn(),
        deleteAlbumById: jest.fn(),
    },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { artistIdentityKey, normalizeArtistName } from "../artistIdentity";
import { containsText, foldedPattern, hasNonAscii, searchRows } from "../textMatch";
import { findScannedAlbum } from "../discovery/discoverClearing";
import { removeDiscoveryAlbum } from "../discovery/lidarrRemoval";
import { lidarrService } from "../lidarr";
import { searchService } from "../search";
import { discoverWeeklyService } from "../discoverWeekly";
import artistRoutes from "../../routes/library/artists";
import { searchRouter } from "../../routes/subsonic/search";
import { playbackRouter } from "../../routes/subsonic/playback";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-nonascii";
const USER = `${P}-user`;

const NAMES = {
    bjork: "Björk",
    beyonce: "Beyoncé",
    ddt: "ДДТ",
    sakamoto: "坂本龍一",
    apostrophe: "Guns N’ Roses",
} as const;
type Key = keyof typeof NAMES;

const TITLES: Record<Key, string> = {
    bjork: "Homogenic Ünïcode",
    beyonce: "Lemonadé",
    ddt: "Актриса Весна",
    sakamoto: "音楽図鑑",
    apostrophe: "Don’t Cry",
};

/** The same text with the case swapped the way a listener might type it. */
const SHOUTED: Record<Key, string> = {
    bjork: "BJÖRK",
    beyonce: "BEYONCÉ",
    ddt: "ддт",
    sakamoto: "坂本龍一",
    apostrophe: "GUNS N’ ROSES",
};

const artistId = (k: Key) => `${P}-art-${k}`;
const albumId = (k: Key) => `${P}-alb-${k}`;
const trackId = (k: Key) => `${P}-trk-${k}`;
const keys = Object.keys(NAMES) as Key[];

async function cleanup() {
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.ownedAlbum.deleteMany({ where: { artistId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.genre.deleteMany({ where: { name: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

function app() {
    const a = express();
    a.use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: "admin" };
        next();
    });
    a.use("/library", artistRoutes);
    a.use("/rest", searchRouter);
    a.use("/rest", playbackRouter);
    return a;
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    for (const k of keys) {
        await prisma.artist.create({
            data: {
                id: artistId(k),
                name: NAMES[k],
                normalizedName: normalizeArtistName(NAMES[k]),
                identityKey: artistIdentityKey(NAMES[k]),
                sortName: NAMES[k].toLowerCase(),
                libraryAlbumCount: 1,
                totalTrackCount: 1,
                genres: k === "bjork" ? ["Électronique"] : [],
            },
        });
        await prisma.album.create({
            data: {
                id: albumId(k),
                rgMbid: `${P}-rg-${k}`,
                artistId: artistId(k),
                identityKey: `${P}-ak-${k}`,
                title: TITLES[k],
                primaryType: "Album",
                location: "LIBRARY",
            },
        });
        await prisma.track.create({
            data: {
                id: trackId(k),
                albumId: albumId(k),
                title: TITLES[k],
                trackNo: 1,
                duration: 200,
                filePath: `${P}/${k}.flac`,
                fileModified: new Date(),
                fileSize: 1,
            },
        });
    }
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
    await prisma.$disconnect();
});

describe("the test database", () => {
    it("is the SQL_ASCII encoding real installs use", async () => {
        const [row] = await prisma.$queryRaw<{ enc: string }[]>`SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = current_database()`;
        expect(row.enc).toBe("SQL_ASCII");
    });
});

describe("textMatch", () => {
    it("folds case in every script and spots non-ASCII text", () => {
        expect(containsText("Björk Guðmundsdóttir", "BJÖRK")).toBe(true);
        expect(containsText("ДДТ", "ддт")).toBe(true);
        expect(containsText("坂本龍一", "龍")).toBe(true);
        expect(containsText(null, "x")).toBe(false);
        expect(hasNonAscii("Björk")).toBe(true);
        expect(hasNonAscii("bjork")).toBe(false);
    });

    it("builds a database pattern that ignores case, escapes symbols and finds decomposed accents", async () => {
        const hits = async (text: string, query: string) =>
            (await prisma.$queryRaw<{ ok: boolean }[]>`SELECT ${text} ~ ${foldedPattern(query)} AS ok`)[0].ok;
        expect(await hits("Homogenic Ünïcode", "ÜNÏCODE")).toBe(true);
        expect(await hits("Актриса Весна", "весна")).toBe(true);
        expect(await hits("Bjo\u0308rk", "BJÖRK")).toBe(true);
        expect(await hits("axb", "a.b")).toBe(false);
        expect(await hits("a.b (live) [x]", "a.b (LIVE) [x]")).toBe(true);
        expect(await hits("Ünïcode", "ünï")).toBe(true);
    });

    it("reads only the page of ids it asks for, however many rows match", async () => {
        const idsOf = jest.fn(async () => [{ id: "b" }, { id: "a" }]);
        const load = jest.fn(async (ids: string[]) => ids.map((id) => ({ id })));
        const got = await searchRows("é", 2, 4, jest.fn(), idsOf, load);
        expect(idsOf).toHaveBeenCalledWith(foldedPattern("é"), { skip: 4, take: 2 });
        expect(got.map((r) => r.id)).toEqual(["b", "a"]);
        expect(load).toHaveBeenCalledWith(["b", "a"]);
    });
});

describe("library artists list", () => {
    it.each(keys)("finds %s whatever the case, by the name filter, on the default and the track-count sort", async (k) => {
        for (const sortBy of ["name", "tracks"]) {
            const res = await request(app()).get("/library/artists").query({ query: SHOUTED[k], sortBy, limit: 50 });
            expect(res.status).toBe(200);
            const ids = res.body.artists.map((a: { id: string }) => a.id);
            expect(ids).toContain(artistId(k));
        }
    });

    it("finds Beyoncé typed without the accent", async () => {
        const res = await request(app()).get("/library/artists").query({ query: "beyonce" });
        expect(res.body.artists.map((a: { id: string }) => a.id)).toContain(artistId("beyonce"));
    });
});

describe("artist by name", () => {
    it.each(keys)("opens %s by its name typed in the other case", async (k) => {
        const res = await request(app()).get(`/library/artists/${encodeURIComponent(SHOUTED[k])}/play-tracks`);
        expect(res.status).toBe(200);
        expect(res.body.tracks.map((t: { id: string }) => t.id)).toContain(trackId(k));
    });
});

describe("Discover clearing finds the scanned album by name", () => {
    it.each(keys)("matches %s's album when the record's id differs and its case does not", async (k) => {
        const found = await findScannedAlbum(
            { rgMbid: `${P}-no-such-id`, artistName: SHOUTED[k], albumTitle: TITLES[k].toUpperCase() },
            "DISCOVER",
        );
        expect(found?.id).toBe(albumId(k));
    });
});

describe("Lidarr removal keeps files the library holds", () => {
    it.each(keys)("sees %s's album as held when named in another case", async (k) => {
        (lidarrService.getAlbum as jest.Mock).mockResolvedValue({ artistId: 1, title: TITLES[k], foreignAlbumId: `${P}-asked-${k}` });
        (lidarrService.getArtistById as jest.Mock).mockResolvedValue({ tags: [5] });
        (lidarrService.getOrCreateDiscoveryTag as jest.Mock).mockResolvedValue(5);
        (lidarrService.deleteAlbumById as jest.Mock).mockClear();
        const outcome = await removeDiscoveryAlbum(1, `${P}-asked-${k}`, {
            artistName: SHOUTED[k],
            albumTitle: TITLES[k].toUpperCase(),
        });
        expect(outcome.removed).toBe(false);
        expect(lidarrService.deleteAlbumById).not.toHaveBeenCalled();
    });
});

describe("search", () => {
    it.each(keys)("finds %s's artist, album and track by the name in the other case", async (k) => {
        const artists = await searchService.searchArtists({ query: SHOUTED[k] });
        expect(artists.map((a) => a.id)).toContain(artistId(k));
        const albums = await searchService.searchAlbums({ query: TITLES[k].toUpperCase() });
        expect(albums.map((a) => a.id)).toContain(albumId(k));
        const tracks = await searchService.searchTracks({ query: TITLES[k].toUpperCase() });
        expect(tracks.map((t) => t.id)).toContain(trackId(k));
    });

    it("filters tracks by a genre in another case and accent form", async () => {
        const genre = await prisma.genre.create({ data: { name: `${P}-Électro` } });
        await prisma.trackGenre.create({ data: { trackId: trackId("beyonce"), genreId: genre.id } });
        const tracks = keys.map((k) => ({ id: trackId(k) })) as any;
        const viaTrackGenre = await searchService.filterTracksByGenre(tracks, `${P}-ÉLECTRO`);
        expect(viaTrackGenre.map((t: any) => t.id)).toEqual([trackId("beyonce")]);
        const viaArtist = await searchService.filterTracksByGenre(tracks, "ÉLECTRONIQUE");
        expect(viaArtist.map((t: any) => t.id)).toEqual([trackId("bjork")]);
    });
});

describe("Subsonic", () => {
    it.each(keys)("getTopSongs finds %s by the name in the other case", async (k) => {
        const res = await request(app()).get("/rest/getTopSongs.view").query({ artist: SHOUTED[k], f: "json" });
        expect(res.status).toBe(200);
        const songs = res.body["subsonic-response"].topSongs?.song ?? [];
        expect(songs.map((s: { id: string }) => s.id)).toContain(trackId(k));
    });

    it("getLyrics finds a non-ASCII title in the other case", async () => {
        await prisma.trackLyrics.create({ data: { track_id: trackId("ddt"), plain_lyrics: "весна", source: "test" } });
        const res = await request(app()).get("/rest/getLyrics.view").query({ artist: "ддт", title: "АКТРИСА", f: "json" });
        expect(res.body["subsonic-response"].lyrics.value ?? res.body["subsonic-response"].lyrics.text).toContain("весна");
    });
});

describe("Discover Weekly", () => {
    it.each(keys)("knows %s is in the library when named in another case", async (k) => {
        const service = discoverWeeklyService as any;
        expect(await service.isArtistInLibrary(SHOUTED[k], undefined)).toBe(true);
    });

    it("finds a Discover album's songs by artist and title in another case", async () => {
        await prisma.album.update({ where: { id: albumId("ddt") }, data: { location: "DISCOVER" } });
        const tracks = await (discoverWeeklyService as any).findDiscoverTracksByName("ддт", TITLES.ddt.toUpperCase());
        expect(tracks.map((t: { id: string }) => t.id)).toEqual([trackId("ddt")]);
        await prisma.album.update({ where: { id: albumId("ddt") }, data: { location: "LIBRARY" } });
    });
});

describe("bounded lookups", () => {
    afterEach(() => jest.restoreAllMocks());

    it("getLyrics with an artist reads one track by id, never a list of tracks", async () => {
        await prisma.trackLyrics.upsert({
            where: { track_id: trackId("bjork") },
            update: {},
            create: { track_id: trackId("bjork"), plain_lyrics: "hunter", source: "test" },
        });
        const many = jest.spyOn(prisma.track, "findMany");
        const res = await request(app()).get("/rest/getLyrics.view").query({ artist: "BJÖRK", title: "ÜNÏCODE", f: "json" });
        expect(JSON.stringify(res.body)).toContain("hunter");
        expect(many).not.toHaveBeenCalled();
    });

    it("getLyrics answers a title-only request with a title no song has, without reading tracks", async () => {
        const many = jest.spyOn(prisma.track, "findMany");
        const res = await request(app()).get("/rest/getLyrics.view").query({ title: "Яблокоzz", f: "json" });
        expect(res.body["subsonic-response"].lyrics).toEqual({});
        expect(many).not.toHaveBeenCalled();
    });

    it("getTopSongs finds an artist by its identity key without listing artists", async () => {
        const many = jest.spyOn(prisma.artist, "findMany");
        const res = await request(app()).get("/rest/getTopSongs.view").query({ artist: "бДДТ".slice(1), f: "json" });
        expect((res.body["subsonic-response"].topSongs?.song ?? []).map((s: { id: string }) => s.id)).toContain(trackId("ddt"));
        expect(many).not.toHaveBeenCalled();
    });

    it("search pages by offset, each page reading only its own rows", async () => {
        const extra = ["Ночь А", "Ночь Б", "Ночь В"];
        for (const [i, title] of extra.entries()) {
            await prisma.album.create({
                data: { id: `${P}-pg-${i}`, rgMbid: `${P}-pg-rg-${i}`, artistId: artistId("ddt"), identityKey: `${P}-pg-ak-${i}`, title, primaryType: "Album", location: "LIBRARY" },
            });
        }
        const album = jest.spyOn(prisma.album, "findMany");
        const first = await searchService.searchAlbums({ query: "ночь", limit: 2, offset: 0 });
        const second = await searchService.searchAlbums({ query: "ночь", limit: 2, offset: 2 });
        expect(first.map((a) => a.title)).toEqual(["Ночь А", "Ночь Б"]);
        expect(second.map((a) => a.title)).toEqual(["Ночь В"]);
        expect(album.mock.calls.every(([args]) => ((args as any).where.id.in as string[]).length <= 2)).toBe(true);
    });
});
