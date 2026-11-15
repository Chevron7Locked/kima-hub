/**
 * What an album or track metadata edit stores. An emptied or blank title, cover address or genre list removes its
 * override (null, or the empty list a reset writes); a new MusicBrainz id and the rest of the edit are one transaction,
 * so a failed edit leaves the old id. Real router, real admin token and database.
 */
import express from "express";
import request from "supertest";
import router from "../enrichment";
import * as reassign from "../../services/mbidReassign";
import * as ownedIndex from "../../services/discovery/ownedIndexVersion";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "./helpers/serverMount";

const P = "emd_";
const ADMIN = `${P}admin`;
const ARTIST = `${P}art`;
const ALBUM = `${P}alb`;
const TRACK = `${P}trk`;
const RG = "11111111-1111-4111-8111-111111111111";
const RG_NEW = "22222222-2222-4222-8222-222222222222";
const RG_OTHER = "33333333-3333-4333-8333-333333333333";
const AR = "44444444-4444-4444-8444-444444444444";
const AR_NEW = "55555555-5555-4555-8555-555555555555";
const AR_OTHER = "66666666-6666-4666-8666-666666666666";

const app = express();
app.use(express.json());
mountAsServer(app, "/enrichment", router, "/api/enrichment");
const asAdmin = `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 })}`;
const put = (path: string, body: object) => request(app).put(path).set("Authorization", asAdmin).send(body);
const album = () => prisma.album.findUniqueOrThrow({ where: { id: ALBUM } });
const artist = () => prisma.artist.findUniqueOrThrow({ where: { id: ARTIST } });
const track = () => prisma.track.findUniqueOrThrow({ where: { id: TRACK } });

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

/** An album and a song, both carrying an earlier edit that each test removes or replaces. */
async function seed() {
    await prisma.artist.create({
        data: {
            id: ARTIST, name: "The Canonical Artist", normalizedName: "the canonical artist", identityKey: `${P}ik`, mbid: AR,
            displayName: "Earlier Edit", userSummary: "old bio", userHeroUrl: "https://old.example/h.jpg", userGenres: ["old"], hasUserOverrides: true,
        },
    });
    await prisma.album.create({
        data: {
            id: ALBUM, rgMbid: RG, rgMbidSource: "tag", artistId: ARTIST, identityKey: `${P}ak`, title: "Los Canonical", primaryType: "Album", location: "LIBRARY",
            displayTitle: "Earlier Edit", userCoverUrl: "https://old.example/c.jpg", userGenres: ["old"], hasUserOverrides: true,
        },
    });
    await prisma.track.create({
        data: {
            id: TRACK, albumId: ALBUM, title: "Canonical Song", trackNo: 1, duration: 100, filePath: `${P}/01.flac`, fileModified: new Date(), fileSize: 1,
            displayTitle: "Earlier Edit", hasUserOverrides: true,
        },
    });
}

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});
beforeEach(async () => {
    await cleanup();
    await seed();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
    await cleanup();
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await closeEngineConnections();
    await prisma.$disconnect();
});

describe("clearing an album override", () => {
    it.each([["an empty title", ""], ["a blank title", "   "], ["a null title", null]])("%s removes the title override and files the album under its own title", async (_name, title) => {
        await put(`/enrichment/albums/${ALBUM}/metadata`, { title }).expect(200);

        expect(await album()).toMatchObject({ displayTitle: null, sortName: "canonical" });
    });

    it("an empty or null cover address removes the cover override", async () => {
        await put(`/enrichment/albums/${ALBUM}/metadata`, { coverUrl: "" }).expect(200);
        expect((await album()).userCoverUrl).toBeNull();

        await put(`/enrichment/albums/${ALBUM}/metadata`, { coverUrl: "https://new.example/c.jpg" }).expect(200);
        expect((await album()).userCoverUrl).toBe("https://new.example/c.jpg");

        await put(`/enrichment/albums/${ALBUM}/metadata`, { coverUrl: null }).expect(200);
        expect((await album()).userCoverUrl).toBeNull();
    });

    it("a null genre list stores the empty list a reset writes, and a list is stored as sent", async () => {
        await put(`/enrichment/albums/${ALBUM}/metadata`, { genres: ["rock", "ambient"] }).expect(200);
        expect((await album()).userGenres).toEqual(["rock", "ambient"]);

        await put(`/enrichment/albums/${ALBUM}/metadata`, { genres: null }).expect(200);
        expect((await album()).userGenres).toEqual([]);
    });

    it("blank entries of a genre list are dropped", async () => {
        await put(`/enrichment/albums/${ALBUM}/metadata`, { genres: ["rock", "", "  ", "ambient"] }).expect(200);

        expect((await album()).userGenres).toEqual(["rock", "ambient"]);
    });

    it("an edit that sends a field untouched leaves the others as they were", async () => {
        await put(`/enrichment/albums/${ALBUM}/metadata`, { year: 1999 }).expect(200);

        expect(await album()).toMatchObject({ displayYear: 1999, displayTitle: "Earlier Edit", userCoverUrl: "https://old.example/c.jpg", userGenres: ["old"] });
    });
});

describe("clearing a track override", () => {
    it.each([["an empty title", ""], ["a blank title", "  "], ["a null title", null]])("%s removes the title override", async (_name, title) => {
        await put(`/enrichment/tracks/${TRACK}/metadata`, { title }).expect(200);

        expect((await track()).displayTitle).toBeNull();
    });

    it("a title is stored as sent", async () => {
        await put(`/enrichment/tracks/${TRACK}/metadata`, { title: "New Name" }).expect(200);

        expect((await track()).displayTitle).toBe("New Name");
    });
});

describe("a new MusicBrainz id with the rest of an album edit", () => {
    it("moves the id and stores the edit together", async () => {
        const res = await put(`/enrichment/albums/${ALBUM}/metadata`, { title: "Fresh", rgMbid: ` ${RG_NEW} ` }).expect(200);

        expect(res.body).toMatchObject({ displayTitle: "Fresh", rgMbid: RG_NEW });
        expect(await album()).toMatchObject({ displayTitle: "Fresh", rgMbid: RG_NEW, rgMbidSource: "editor" });
    });

    it("an id is stored in lower case, so a case variant of a held id is the same id", async () => {
        await put(`/enrichment/albums/${ALBUM}/metadata`, { rgMbid: RG_NEW.replace(/2/g, "A").toUpperCase() }).expect(200);

        expect((await album()).rgMbid).toBe(RG_NEW.replace(/2/g, "a"));
    });

    it("an id of an empty or blank text is no change of id", async () => {
        await put(`/enrichment/albums/${ALBUM}/metadata`, { title: "Fresh", rgMbid: "  " }).expect(200);
        await put(`/enrichment/albums/${ALBUM}/metadata`, { rgMbid: null }).expect(200);

        expect(await album()).toMatchObject({ displayTitle: "Fresh", rgMbid: RG });
    });

    it("an id another album holds answers 409 and stores none of the edit", async () => {
        await prisma.album.create({
            data: { id: `${P}other`, rgMbid: RG_OTHER, artistId: ARTIST, identityKey: `${P}ok`, title: "Other", primaryType: "Album", location: "LIBRARY" },
        });

        const res = await put(`/enrichment/albums/${ALBUM}/metadata`, { title: "Fresh", rgMbid: RG_OTHER });

        expect(res.status).toBe(409);
        expect(await album()).toMatchObject({ displayTitle: "Earlier Edit", rgMbid: RG });
    });

    it("an edit that fails after the id moved gives the old id back", async () => {
        const real = reassign.moveAlbumRgMbid;
        // The album goes (as if deleted by someone else) once the id has moved, so the edit that follows has no row.
        jest.spyOn(reassign, "moveAlbumRgMbid").mockImplementation(async (tx, id, newId, opts) => {
            const moved = await real(tx, id, newId, opts);
            await tx.album.delete({ where: { id } });
            return moved;
        });

        const res = await put(`/enrichment/albums/${ALBUM}/metadata`, { title: "Fresh", rgMbid: RG_NEW });

        expect(res.status).toBe(404);
        expect(await album()).toMatchObject({ displayTitle: "Earlier Edit", rgMbid: RG, rgMbidSource: "tag" });
    });
});

describe("an edit that is refused", () => {
    it("stores nothing, the id included, when another field is refused", async () => {
        expectLog("warn");

        const res = await put(`/enrichment/albums/${ALBUM}/metadata`, { title: "Fresh", rgMbid: RG_NEW, genres: "rock" });

        expect(res.status).toBe(400);
        expect(await album()).toMatchObject({ displayTitle: "Earlier Edit", rgMbid: RG });
    });
});

describe("clearing an artist override", () => {
    it.each([["an empty name", ""], ["a blank name", "   "], ["a null name", null]])("%s removes the name override and files the artist under its own name", async (_name, name) => {
        await put(`/enrichment/artists/${ARTIST}/metadata`, { name }).expect(200);

        expect(await artist()).toMatchObject({ displayName: null, sortName: "canonical artist" });
    });

    it.each([["an empty address", ""], ["a blank address", " "], ["a null address", null]])("%s removes the hero override", async (_name, heroUrl) => {
        await put(`/enrichment/artists/${ARTIST}/metadata`, { heroUrl }).expect(200);
        expect((await artist()).userHeroUrl).toBeNull();

        await put(`/enrichment/artists/${ARTIST}/metadata`, { heroUrl: "https://new.example/h.jpg" }).expect(200);
        expect((await artist()).userHeroUrl).toBe("https://new.example/h.jpg");
    });

    it("an empty or null bio removes the bio override", async () => {
        await put(`/enrichment/artists/${ARTIST}/metadata`, { bio: "" }).expect(200);
        expect((await artist()).userSummary).toBeNull();

        await put(`/enrichment/artists/${ARTIST}/metadata`, { bio: "A new bio" }).expect(200);
        expect((await artist()).userSummary).toBe("A new bio");

        await put(`/enrichment/artists/${ARTIST}/metadata`, { bio: null }).expect(200);
        expect((await artist()).userSummary).toBeNull();
    });

    it("a null genre list stores the empty list a reset writes, a list is stored with its blank entries dropped", async () => {
        await put(`/enrichment/artists/${ARTIST}/metadata`, { genres: ["rock", "", "ambient"] }).expect(200);
        expect((await artist()).userGenres).toEqual(["rock", "ambient"]);

        await put(`/enrichment/artists/${ARTIST}/metadata`, { genres: null }).expect(200);
        expect((await artist()).userGenres).toEqual([]);
    });

    it("an edit that sends one field leaves the others as they were", async () => {
        await put(`/enrichment/artists/${ARTIST}/metadata`, { bio: "Only the bio" }).expect(200);

        expect(await artist()).toMatchObject({ displayName: "Earlier Edit", userHeroUrl: "https://old.example/h.jpg", userGenres: ["old"], mbid: AR });
    });
});

describe("a new MusicBrainz id with the rest of an artist edit", () => {
    afterEach(() => jest.restoreAllMocks());

    it("moves the id and stores the edit together, and forgets the owned index once after the commit", async () => {
        const forget = jest.spyOn(ownedIndex, "forgetOwnedIndex");

        const res = await put(`/enrichment/artists/${ARTIST}/metadata`, { name: "Fresh", mbid: ` ${AR_NEW.toUpperCase()} ` }).expect(200);

        expect(res.body).toMatchObject({ displayName: "Fresh", mbid: AR_NEW });
        expect(await artist()).toMatchObject({ displayName: "Fresh", mbid: AR_NEW });
        expect(forget).toHaveBeenCalledTimes(1);
    });

    it("an id of an empty or blank text, or null, is no change of id", async () => {
        const forget = jest.spyOn(ownedIndex, "forgetOwnedIndex");

        await put(`/enrichment/artists/${ARTIST}/metadata`, { name: "Fresh", mbid: "  " }).expect(200);
        await put(`/enrichment/artists/${ARTIST}/metadata`, { mbid: null }).expect(200);

        expect(await artist()).toMatchObject({ displayName: "Fresh", mbid: AR });
        expect(forget).not.toHaveBeenCalled();
    });

    it("an id another artist holds answers 409, stores none of the edit and forgets nothing", async () => {
        await prisma.artist.create({ data: { id: `${P}other`, name: "Other", normalizedName: "other", identityKey: `${P}oik`, mbid: AR_OTHER } });
        const forget = jest.spyOn(ownedIndex, "forgetOwnedIndex");

        const res = await put(`/enrichment/artists/${ARTIST}/metadata`, { name: "Fresh", mbid: AR_OTHER });

        expect(res.status).toBe(409);
        expect(await artist()).toMatchObject({ displayName: "Earlier Edit", mbid: AR });
        expect(forget).not.toHaveBeenCalled();
    });

    it("an edit that fails after the id moved gives the old id back", async () => {
        const real = reassign.moveArtistMbid;
        // The artist goes (as if deleted by someone else) once the id has moved, so the edit that follows has no row.
        jest.spyOn(reassign, "moveArtistMbid").mockImplementation(async (tx, id, newId) => {
            await real(tx, id, newId);
            await tx.artist.delete({ where: { id } });
        });
        const forget = jest.spyOn(ownedIndex, "forgetOwnedIndex");

        const res = await put(`/enrichment/artists/${ARTIST}/metadata`, { name: "Fresh", mbid: AR_NEW });

        expect(res.status).toBe(404);
        expect(await artist()).toMatchObject({ displayName: "Earlier Edit", mbid: AR });
        expect(forget).not.toHaveBeenCalled();
    });

    it("stores nothing, the id included, when another field is refused, and reads nothing first", async () => {
        expectLog("warn");
        const read = jest.spyOn(prisma.artist, "findUnique");

        const res = await put(`/enrichment/artists/${ARTIST}/metadata`, { name: "Fresh", mbid: AR_NEW, genres: "rock" });

        expect(res.status).toBe(400);
        expect(read).not.toHaveBeenCalled();
        expect(await artist()).toMatchObject({ displayName: "Earlier Edit", mbid: AR });
    });
});
