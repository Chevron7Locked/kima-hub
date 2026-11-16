/**
 * A person's edit or reset of a shown name, or of a picture that shows in its place, moves the library-changed marker only when a client lists the edited item
 * (Subsonic's `lastModified`): a song with a playable file on a library album, and an album or artist holding one.
 * An edit of a Discover item or of one whose songs are missing or corrupt leaves it, and so does a reset that changes
 * no name a client shows. Real router, real admin token, real database and the real marker.
 */
import express from "express";
import type { Prisma } from "@prisma/client";
import request from "supertest";
import router from "../enrichment";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { markerMoves } from "../../__tests__/helpers/libraryMarker";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import * as settings from "../../utils/systemSettings";
import { redisClient } from "../../utils/redis";
import { mountAsServer } from "./helpers/serverMount";

const P = "elm_";
const ADMIN = `${P}admin`;

const app = express();
app.use(express.json());
mountAsServer(app, "/enrichment", router, "/api/enrichment");
const asAdmin = `Bearer ${generateToken({ id: ADMIN, username: ADMIN, role: "admin", tokenVersion: 0 })}`;
const put = (path: string, body: object) => request(app).put(path).set("Authorization", asAdmin).send(body);
const post = (path: string) => request(app).post(path).set("Authorization", asAdmin);

type Kind = "playable" | "discover" | "missing" | "corrupt";

/** An artist `key` with one album and one song, listed or not as `kind` says; `shown` gives all three an edited name for a reset to clear. */
async function seed(key: string, kind: Kind, shown = true) {
    const artist = await prisma.artist.create({
        data: { id: `${P}art_${key}`, name: `${P}artist ${key}`, normalizedName: `${P}artist ${key}`, identityKey: `${P}ik_${key}`, ...(shown ? { displayName: "Edited" } : {}) },
    });
    const album = await prisma.album.create({
        data: {
            id: `${P}alb_${key}`, rgMbid: `${P}rg_${key}`, artistId: artist.id, identityKey: `${P}ak_${key}`, title: `${P}album ${key}`, primaryType: "Album",
            location: kind === "discover" ? "DISCOVER" : "LIBRARY", ...(shown ? { displayTitle: "Edited" } : {}),
        },
    });
    const track = await prisma.track.create({
        data: {
            id: `${P}t_${key}`, albumId: album.id, title: `${P}song ${key}`, trackNo: 1, duration: 100, filePath: `${P}/${key}/01.flac`, fileModified: new Date(), fileSize: 1,
            ...(kind === "missing" ? { missingSince: new Date() } : {}), ...(kind === "corrupt" ? { corrupt: true } : {}), ...(shown ? { displayTitle: "Edited" } : {}),
        },
    });
    return { artist: artist.id, album: album.id, track: track.id };
}

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
});

beforeEach(cleanup);
afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
    await cleanup();
    await prisma.user.deleteMany({ where: { id: ADMIN } });
    await closeEngineConnections();
    await prisma.$disconnect();
});

const unlisted: Kind[] = ["discover", "missing", "corrupt"];

describe("editing a shown name", () => {
    it("moves the marker for an artist, album and song a client lists", async () => {
        const s = await seed("a", "playable", false);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { name: "New" }))).toBe(true);
        expect(await markerMoves(() => put(`/enrichment/albums/${s.album}/metadata`, { title: "New" }))).toBe(true);
        expect(await markerMoves(() => put(`/enrichment/tracks/${s.track}/metadata`, { title: "New" }))).toBe(true);
    });

    it.each(unlisted)("leaves the marker when the item is not listed (%s)", async (kind) => {
        const s = await seed(`u${kind}`, kind, false);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { name: "New" }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/albums/${s.album}/metadata`, { title: "New" }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/tracks/${s.track}/metadata`, { title: "New" }))).toBe(false);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: s.album } })).displayTitle).toBe("New");
    });

    it("leaves the marker when the name sent is the one already shown", async () => {
        const plain = await seed("eq", "playable", false);
        // Sent as the canonical name; sent empty, which clears an override that is not there; sent again as it stands.
        expect(await markerMoves(() => put(`/enrichment/artists/${plain.artist}/metadata`, { name: `${P}artist eq` }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/artists/${plain.artist}/metadata`, { name: "" }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/albums/${plain.album}/metadata`, { title: `${P}album eq` }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/albums/${plain.album}/metadata`, { title: null }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/tracks/${plain.track}/metadata`, { title: `${P}song eq` }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/tracks/${plain.track}/metadata`, { title: "" }))).toBe(false);

        const edited = await seed("eq2", "playable");
        expect(await markerMoves(() => put(`/enrichment/artists/${edited.artist}/metadata`, { name: "Edited" }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/albums/${edited.album}/metadata`, { title: "Edited" }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/tracks/${edited.track}/metadata`, { title: "Edited" }))).toBe(false);
    });

    it("moves the marker when an edit clears a name that was edited, so the original shows again", async () => {
        const s = await seed("clr", "playable");
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { name: "" }))).toBe(true);
        expect(await markerMoves(() => put(`/enrichment/albums/${s.album}/metadata`, { title: null }))).toBe(true);
        expect(await markerMoves(() => put(`/enrichment/tracks/${s.track}/metadata`, { title: "" }))).toBe(true);
    });

    it("leaves the marker when an edit sends no name", async () => {
        const s = await seed("nn", "playable", false);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { bio: "text" }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/albums/${s.album}/metadata`, { rgMbid: "22222222-2222-4222-8222-222222222222" }))).toBe(false);
        // A new MusicBrainz id changes no name a client lists.
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { mbid: "11111111-1111-4111-8111-111111111111" }))).toBe(false);
    });
});

describe("resetting an edit", () => {
    it("moves the marker for a listed artist, album and song whose shown name changes back", async () => {
        const s = await seed("r", "playable");
        expect(await markerMoves(() => post(`/enrichment/artists/${s.artist}/reset`))).toBe(true);
        expect(await markerMoves(() => post(`/enrichment/albums/${s.album}/reset`))).toBe(true);
        expect(await markerMoves(() => post(`/enrichment/tracks/${s.track}/reset`))).toBe(true);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: s.album } })).displayTitle).toBeNull();
    });

    it("leaves the marker when no shown name changes (nothing was edited, or the edit equals the original)", async () => {
        const s = await seed("same", "playable", false);
        expect(await markerMoves(() => post(`/enrichment/artists/${s.artist}/reset`))).toBe(false);
        expect(await markerMoves(() => post(`/enrichment/albums/${s.album}/reset`))).toBe(false);
        expect(await markerMoves(() => post(`/enrichment/tracks/${s.track}/reset`))).toBe(false);

        await prisma.album.update({ where: { id: s.album }, data: { displayTitle: `${P}album same` } });
        expect(await markerMoves(() => post(`/enrichment/albums/${s.album}/reset`))).toBe(false);
    });

    it.each(unlisted)("leaves the marker when the item is not listed (%s)", async (kind) => {
        const s = await seed(`ru${kind}`, kind);
        expect(await markerMoves(() => post(`/enrichment/artists/${s.artist}/reset`))).toBe(false);
        expect(await markerMoves(() => post(`/enrichment/albums/${s.album}/reset`))).toBe(false);
        expect(await markerMoves(() => post(`/enrichment/tracks/${s.track}/reset`))).toBe(false);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: s.album } })).displayTitle).toBeNull();
    });
});

describe("a marker that cannot be asked or written", () => {
    /** Each edit and reset that can move the marker, as the call a person makes. */
    const calls: Array<[string, (s: { artist: string; album: string; track: string }) => request.Test]> = [
        ["an artist edit", (s) => put(`/enrichment/artists/${s.artist}/metadata`, { name: "New" })],
        ["an album edit", (s) => put(`/enrichment/albums/${s.album}/metadata`, { title: "New" })],
        ["a song edit", (s) => put(`/enrichment/tracks/${s.track}/metadata`, { title: "New" })],
        ["an artist reset", (s) => post(`/enrichment/artists/${s.artist}/reset`)],
        ["an album reset", (s) => post(`/enrichment/albums/${s.album}/reset`)],
        ["a song reset", (s) => post(`/enrichment/tracks/${s.track}/reset`)],
    ];
    const shownName = async (s: { artist: string; album: string; track: string }) => ({
        artist: (await prisma.artist.findUniqueOrThrow({ where: { id: s.artist } })).displayName,
        album: (await prisma.album.findUniqueOrThrow({ where: { id: s.album } })).displayTitle,
        track: (await prisma.track.findUniqueOrThrow({ where: { id: s.track } })).displayTitle,
    });

    it.each(calls)("%s that is saved answers 200 when the check of whether a client lists it fails, and the failure is logged", async (_name, call) => {
        const s = await seed("ask", "playable", _name.includes("reset"));
        const logged = expectLog("error");
        jest.spyOn(prisma.track, "findFirst").mockRejectedValue(new Error("database went away"));

        await call(s).expect(200);

        expect(logged).toHaveBeenCalled();
        const after = await shownName(s);
        const own = _name.includes("artist") ? "artist" : _name.includes("album") ? "album" : "track";
        expect(after[own]).toBe(_name.includes("reset") ? null : "New");
    });

    it.each(calls)("%s that is saved answers 200 when the marker cannot be written, and the failure is logged", async (_name, call) => {
        const s = await seed("write", "playable", _name.includes("reset"));
        const logged = expectLog("error");
        jest.spyOn(settings, "saveSystemSettings").mockRejectedValue(new Error("settings row locked"));

        await call(s).expect(200);

        expect(logged).toHaveBeenCalled();
        const after = await shownName(s);
        const own = _name.includes("artist") ? "artist" : _name.includes("album") ? "album" : "track";
        expect(after[own]).toBe(_name.includes("reset") ? null : "New");
    });
});

/**
 * What happens to the marker, and what the call answers, when `firstGotIn` (another request's edit) is stored after `call`
 * has begun and before the transaction that stores its own edit. The spy is set inside the work: the marker's own write
 * is a transaction too.
 */
async function overlapped(call: () => request.Test, firstGotIn: () => Promise<unknown>): Promise<{ moved: boolean; status: number }> {
    let status = 0;
    const moved = await markerMoves(async () => {
        const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
        let done = false;
        const spy = jest.spyOn(prisma, "$transaction").mockImplementation((async (...args: unknown[]) => {
            if (!done) {
                done = true;
                await firstGotIn();
            }
            return real(...args);
        }) as never);
        try {
            status = (await call()).status;
        } finally {
            spy.mockRestore();
        }
    });
    return { moved, status };
}

describe("two edits of the same name that overlap", () => {
    // The first request stored the name the second one sends. The second replaces it with itself, so what a client lists
    // did not change by it: it is judged against the name it replaced, not the one it found when it began.
    it("leave the marker alone for the one that replaces a name with itself (edit)", async () => {
        const s = await seed("ov", "playable", false);
        const artist = await overlapped(
            () => put(`/enrichment/artists/${s.artist}/metadata`, { name: "New" }),
            () => prisma.artist.update({ where: { id: s.artist }, data: { displayName: "New" } }),
        );
        const album = await overlapped(
            () => put(`/enrichment/albums/${s.album}/metadata`, { title: "New" }),
            () => prisma.album.update({ where: { id: s.album }, data: { displayTitle: "New" } }),
        );
        const track = await overlapped(
            () => put(`/enrichment/tracks/${s.track}/metadata`, { title: "New" }),
            () => prisma.track.update({ where: { id: s.track }, data: { displayTitle: "New" } }),
        );
        expect([artist, album, track]).toEqual(Array(3).fill({ moved: false, status: 200 }));
    });

    it("leave the marker alone for the one that resets a name another reset already cleared", async () => {
        const s = await seed("ovr", "playable");
        const artist = await overlapped(
            () => post(`/enrichment/artists/${s.artist}/reset`),
            () => prisma.artist.update({ where: { id: s.artist }, data: { displayName: null } }),
        );
        const album = await overlapped(
            () => post(`/enrichment/albums/${s.album}/reset`),
            () => prisma.album.update({ where: { id: s.album }, data: { displayTitle: null } }),
        );
        const track = await overlapped(
            () => post(`/enrichment/tracks/${s.track}/reset`),
            () => prisma.track.update({ where: { id: s.track }, data: { displayTitle: null } }),
        );
        expect([artist, album, track]).toEqual(Array(3).fill({ moved: false, status: 200 }));
    });

    it("still move the marker for the one that changes the name the first stored", async () => {
        const s = await seed("ovm", "playable", false);
        const artist = await overlapped(
            () => put(`/enrichment/artists/${s.artist}/metadata`, { name: "Second" }),
            () => prisma.artist.update({ where: { id: s.artist }, data: { displayName: "First" } }),
        );
        const track = await overlapped(
            () => put(`/enrichment/tracks/${s.track}/metadata`, { title: "Second" }),
            () => prisma.track.update({ where: { id: s.track }, data: { displayTitle: "First" } }),
        );
        expect([artist, track]).toEqual(Array(2).fill({ moved: true, status: 200 }));
    });

    it("answer 404 for an edit or reset of a song that was deleted in between", async () => {
        const s = await seed("ovd", "playable");
        const gone = () => prisma.track.deleteMany({ where: { id: s.track } });
        expect(await overlapped(() => put(`/enrichment/tracks/${s.track}/metadata`, { title: "New" }), gone)).toEqual({ moved: false, status: 404 });

        const t = await seed("ovd2", "playable");
        const goneToo = () => prisma.track.deleteMany({ where: { id: t.track } });
        expect(await overlapped(() => post(`/enrichment/tracks/${t.track}/reset`), goneToo)).toEqual({ moved: false, status: 404 });
    });
});

const pic = (name: string) => `https://pictures.example/${name}.jpg`;

describe("setting, clearing or resetting a picture", () => {
    it("moves the marker when a picture the person sets changes what a client shows", async () => {
        const s = await seed("pic", "playable", false);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { heroUrl: pic("a1") }))).toBe(true);
        expect(await markerMoves(() => put(`/enrichment/albums/${s.album}/metadata`, { coverUrl: pic("b1") }))).toBe(true);
        // Another picture in place of the first.
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { heroUrl: pic("a2") }))).toBe(true);
        expect(await markerMoves(() => put(`/enrichment/albums/${s.album}/metadata`, { coverUrl: pic("b2") }))).toBe(true);
    });

    it("moves the marker when clearing a picture brings the found one back", async () => {
        const s = await seed("picclr", "playable", false);
        await prisma.artist.update({ where: { id: s.artist }, data: { userHeroUrl: pic("mine"), heroUrl: pic("found") } });
        await prisma.album.update({ where: { id: s.album }, data: { userCoverUrl: pic("mine"), coverUrl: pic("found") } });
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { heroUrl: null }))).toBe(true);
        expect(await markerMoves(() => put(`/enrichment/albums/${s.album}/metadata`, { coverUrl: null }))).toBe(true);
        expect((await prisma.artist.findUniqueOrThrow({ where: { id: s.artist } })).userHeroUrl).toBeNull();
    });

    it("leaves the marker when the picture shown does not change", async () => {
        const s = await seed("piceq", "playable", false);
        await prisma.artist.update({ where: { id: s.artist }, data: { userHeroUrl: pic("mine"), heroUrl: pic("found") } });
        await prisma.album.update({ where: { id: s.album }, data: { userCoverUrl: pic("mine"), coverUrl: pic("found") } });
        // The same picture sent again.
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { heroUrl: pic("mine") }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/albums/${s.album}/metadata`, { coverUrl: pic("mine") }))).toBe(false);

        // Nothing to clear, and a picture set to the address of the one found.
        const plain = await seed("picnone", "playable", false);
        expect(await markerMoves(() => put(`/enrichment/artists/${plain.artist}/metadata`, { heroUrl: null }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/albums/${plain.album}/metadata`, { coverUrl: null }))).toBe(false);
        await prisma.artist.update({ where: { id: plain.artist }, data: { heroUrl: pic("same") } });
        await prisma.album.update({ where: { id: plain.album }, data: { coverUrl: pic("same") } });
        expect(await markerMoves(() => put(`/enrichment/artists/${plain.artist}/metadata`, { heroUrl: pic("same") }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/albums/${plain.album}/metadata`, { coverUrl: pic("same") }))).toBe(false);
    });

    it("moves the marker once for a name and a picture sent together, and for a picture alone when the name sent is the one shown", async () => {
        const s = await seed("picboth", "playable", false);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { name: "New", heroUrl: pic("a") }))).toBe(true);
        expect(await markerMoves(() => put(`/enrichment/albums/${s.album}/metadata`, { title: "New", coverUrl: pic("b") }))).toBe(true);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { name: "New", heroUrl: pic("a2") }))).toBe(true);
        expect(await markerMoves(() => put(`/enrichment/albums/${s.album}/metadata`, { title: "New", coverUrl: pic("b2") }))).toBe(true);
    });

    it.each(unlisted)("leaves the marker when the item is not listed (%s)", async (kind) => {
        const s = await seed(`picu${kind}`, kind, false);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { heroUrl: pic("a") }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/albums/${s.album}/metadata`, { coverUrl: pic("b") }))).toBe(false);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: s.album } })).userCoverUrl).toBe(pic("b"));
    });

    it("moves the marker when a reset takes a picture the person set away, and not when it shows the same", async () => {
        const s = await seed("picrst", "playable", false);
        await prisma.artist.update({ where: { id: s.artist }, data: { userHeroUrl: pic("mine"), heroUrl: pic("found") } });
        await prisma.album.update({ where: { id: s.album }, data: { userCoverUrl: pic("mine"), coverUrl: pic("found") } });
        expect(await markerMoves(() => post(`/enrichment/artists/${s.artist}/reset`))).toBe(true);
        expect(await markerMoves(() => post(`/enrichment/albums/${s.album}/reset`))).toBe(true);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: s.album } })).userCoverUrl).toBeNull();
        // Reset again: nothing is set, so nothing shown changes.
        expect(await markerMoves(() => post(`/enrichment/artists/${s.artist}/reset`))).toBe(false);
        expect(await markerMoves(() => post(`/enrichment/albums/${s.album}/reset`))).toBe(false);

        const same = await seed("picrsts", "playable", false);
        await prisma.artist.update({ where: { id: same.artist }, data: { userHeroUrl: pic("same"), heroUrl: pic("same") } });
        await prisma.album.update({ where: { id: same.album }, data: { userCoverUrl: pic("same"), coverUrl: pic("same") } });
        expect(await markerMoves(() => post(`/enrichment/artists/${same.artist}/reset`))).toBe(false);
        expect(await markerMoves(() => post(`/enrichment/albums/${same.album}/reset`))).toBe(false);
    });

    it.each(unlisted)("leaves the marker when a reset takes a picture from an item that is not listed (%s)", async (kind) => {
        const s = await seed(`picru${kind}`, kind, false);
        await prisma.artist.update({ where: { id: s.artist }, data: { userHeroUrl: pic("mine") } });
        await prisma.album.update({ where: { id: s.album }, data: { userCoverUrl: pic("mine") } });
        expect(await markerMoves(() => post(`/enrichment/artists/${s.artist}/reset`))).toBe(false);
        expect(await markerMoves(() => post(`/enrichment/albums/${s.album}/reset`))).toBe(false);
    });

    it("judges an edit that overlaps another against the picture it replaced", async () => {
        const s = await seed("picov", "playable", false);
        const artist = await overlapped(
            () => put(`/enrichment/artists/${s.artist}/metadata`, { heroUrl: pic("new") }),
            () => prisma.artist.update({ where: { id: s.artist }, data: { userHeroUrl: pic("new") } }),
        );
        const album = await overlapped(
            () => put(`/enrichment/albums/${s.album}/metadata`, { coverUrl: pic("new") }),
            () => prisma.album.update({ where: { id: s.album }, data: { userCoverUrl: pic("new") } }),
        );
        expect([artist, album]).toEqual(Array(2).fill({ moved: false, status: 200 }));
        const other = await overlapped(
            () => put(`/enrichment/artists/${s.artist}/metadata`, { heroUrl: pic("second") }),
            () => prisma.artist.update({ where: { id: s.artist }, data: { userHeroUrl: pic("first") } }),
        );
        expect(other).toEqual({ moved: true, status: 200 });
    });
});

describe("an artist's picture left in the cache", () => {
    it("is forgotten without failing a saved edit when the cache cannot be reached", async () => {
        const s = await seed("hero", "playable", false);
        const logged = expectLog("warn");
        jest.spyOn(redisClient, "del").mockRejectedValue(new Error("redis went away"));

        await put(`/enrichment/artists/${s.artist}/metadata`, { name: "New" }).expect(200);

        expect(logged).toHaveBeenCalled();
        expect((await prisma.artist.findUniqueOrThrow({ where: { id: s.artist } })).displayName).toBe("New");
    });
});

/**
 * The genres a client lists for an artist are the ones a person set when they set any, else the enriched ones (getMergedGenres),
 * in that order: Subsonic's getGenres, its genre filters and the genre on every song, album and artist read them. An
 * album's own genres and year are the next describe.
 */
describe("editing or resetting the genres an artist shows", () => {
    const withGenres = async (key: string, kind: Kind, genres: string[], userGenres: string[]) => {
        const s = await seed(key, kind, false);
        await prisma.artist.update({ where: { id: s.artist }, data: { genres, userGenres } });
        return s;
    };

    it("moves the marker when an edit changes the genres shown, in the list or its order", async () => {
        const s = await withGenres("gn", "playable", ["Rock"], []);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { genres: ["Jazz"] }))).toBe(true);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { genres: ["Jazz", "Blues"] }))).toBe(true);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { genres: ["Blues", "Jazz"] }))).toBe(true);
        // Clearing the person's list brings the enriched one back.
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { genres: null }))).toBe(true);
    });

    it("leaves the marker when the genres shown stay the same", async () => {
        const s = await withGenres("gns", "playable", ["Rock", "Pop"], []);
        // The person's list equals the enriched one that was showing; a repeat; a duplicate that is dropped; a clear of nothing.
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { genres: ["Rock", "Pop"] }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { genres: ["Rock", "Pop"] }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { genres: ["Rock", "Pop", "Rock"] }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { genres: null }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { bio: "text" }))).toBe(false);
    });

    it("moves the marker for a name and genres sent together", async () => {
        const s = await withGenres("gnn", "playable", ["Rock"], []);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { name: "New", genres: ["Jazz"] }))).toBe(true);
    });

    it.each(unlisted)("leaves the marker for an artist that is not listed (%s)", async (kind) => {
        const s = await withGenres(`gnu${kind}`, kind, ["Rock"], []);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { genres: ["Jazz"] }))).toBe(false);
        expect((await prisma.artist.findUniqueOrThrow({ where: { id: s.artist } })).userGenres).toEqual(["Jazz"]);
    });

    it("moves the marker when a reset takes the person's genres away and the enriched ones differ, and not otherwise", async () => {
        const s = await withGenres("gnr", "playable", ["Rock"], ["Jazz"]);
        expect(await markerMoves(() => post(`/enrichment/artists/${s.artist}/reset`))).toBe(true);
        expect((await prisma.artist.findUniqueOrThrow({ where: { id: s.artist } })).userGenres).toEqual([]);
        // Nothing of the person's left to take away.
        expect(await markerMoves(() => post(`/enrichment/artists/${s.artist}/reset`))).toBe(false);

        const same = await withGenres("gnrs", "playable", ["Rock"], ["Rock"]);
        expect(await markerMoves(() => post(`/enrichment/artists/${same.artist}/reset`))).toBe(false);

        const hidden = await withGenres("gnru", "discover", ["Rock"], ["Jazz"]);
        expect(await markerMoves(() => post(`/enrichment/artists/${hidden.artist}/reset`))).toBe(false);
    });

    it("judges an edit that overlaps another against the genres it replaced", async () => {
        const s = await withGenres("gno", "playable", ["Rock"], []);
        const same = await overlapped(
            () => put(`/enrichment/artists/${s.artist}/metadata`, { genres: ["Jazz"] }),
            () => prisma.artist.update({ where: { id: s.artist }, data: { userGenres: ["Jazz"] } }),
        );
        expect(same).toEqual({ moved: false, status: 200 });
        const other = await overlapped(
            () => put(`/enrichment/artists/${s.artist}/metadata`, { genres: ["Blues"] }),
            () => prisma.artist.update({ where: { id: s.artist }, data: { userGenres: ["Soul"] } }),
        );
        expect(other).toEqual({ moved: true, status: 200 });
    });

});

/**
 * An album shows the year `displayYear ?? originalYear ?? year` and its own merged genres (the person's list when set, else the
 * enriched one) to Subsonic clients, so an edit or a reset that changes either moves the marker, and one that does not
 * (a year under a displayYear or an originalYear, a repeat) does not.
 */
describe("editing or resetting the year and genres an album shows", () => {
    const withAlbum = async (key: string, kind: Kind, data: Prisma.AlbumUpdateInput) => {
        const s = await seed(key, kind, false);
        await prisma.album.update({ where: { id: s.album }, data });
        return s;
    };
    const editAlbum = (id: string, body: Record<string, unknown>) => put(`/enrichment/albums/${id}/metadata`, body);

    it("moves the marker when an edit changes the year shown", async () => {
        const s = await withAlbum("yr", "playable", { year: 2005 });
        expect(await markerMoves(() => editAlbum(s.album, { year: 1999 }))).toBe(true);
        expect(await markerMoves(() => editAlbum(s.album, { year: 2001 }))).toBe(true);
        // Clearing the person's year brings the stored one back.
        expect(await markerMoves(() => editAlbum(s.album, { year: null }))).toBe(true);
    });

    it("leaves the marker when the year shown stays the same", async () => {
        const s = await withAlbum("yrs", "playable", { year: 2005 });
        // A year equal to the one showing; a repeat; a clear of nothing.
        expect(await markerMoves(() => editAlbum(s.album, { year: 2005 }))).toBe(false);
        expect(await markerMoves(() => editAlbum(s.album, { year: 2005 }))).toBe(false);
        expect(await markerMoves(() => editAlbum(s.album, { year: null }))).toBe(false);
    });

    it("judges the year by what is shown: an original year under the person's, or over the file's", async () => {
        const s = await withAlbum("yro", "playable", { year: 2005, originalYear: 1990 });
        // 1990 shows already.
        expect(await markerMoves(() => editAlbum(s.album, { year: 1990 }))).toBe(false);
        expect(await markerMoves(() => editAlbum(s.album, { year: 1975 }))).toBe(true);
        // Clearing brings back 1990, which differs from 1975.
        expect(await markerMoves(() => editAlbum(s.album, { year: null }))).toBe(true);
    });

    it("moves the marker when an edit changes the genres shown, and not when they stay", async () => {
        const s = await withAlbum("agn", "playable", { genres: ["Rock"] });
        expect(await markerMoves(() => editAlbum(s.album, { genres: ["Jazz"] }))).toBe(true);
        expect(await markerMoves(() => editAlbum(s.album, { genres: ["Blues", "Jazz"] }))).toBe(true);
        expect(await markerMoves(() => editAlbum(s.album, { genres: ["Jazz", "Blues"] }))).toBe(true);
        expect(await markerMoves(() => editAlbum(s.album, { genres: ["Jazz", "Blues"] }))).toBe(false);
        expect(await markerMoves(() => editAlbum(s.album, { genres: null }))).toBe(true);
        expect(await markerMoves(() => editAlbum(s.album, { genres: null }))).toBe(false);

        const same = await withAlbum("agns", "playable", { genres: ["Rock", "Pop"] });
        expect(await markerMoves(() => editAlbum(same.album, { genres: ["Rock", "Pop"] }))).toBe(false);
    });

    it("moves the marker when a reset takes the person's year or genres away and what shows differs, and not otherwise", async () => {
        const s = await withAlbum("ar", "playable", { year: 2005, displayYear: 1975, genres: ["Rock"], userGenres: ["Jazz"] });
        expect(await markerMoves(() => post(`/enrichment/albums/${s.album}/reset`))).toBe(true);
        const after = await prisma.album.findUniqueOrThrow({ where: { id: s.album } });
        expect(after.displayYear).toBeNull();
        expect(after.userGenres).toEqual([]);
        expect(await markerMoves(() => post(`/enrichment/albums/${s.album}/reset`))).toBe(false);

        const years = await withAlbum("ary", "playable", { year: 2005, displayYear: 1975 });
        expect(await markerMoves(() => post(`/enrichment/albums/${years.album}/reset`))).toBe(true);
        const genres = await withAlbum("arg", "playable", { genres: ["Rock"], userGenres: ["Jazz"] });
        expect(await markerMoves(() => post(`/enrichment/albums/${genres.album}/reset`))).toBe(true);
        // A year and genres that already equal what the reset brings back.
        const same = await withAlbum("arsame", "playable", { year: 2005, displayYear: 2005, genres: ["Rock"], userGenres: ["Rock"] });
        expect(await markerMoves(() => post(`/enrichment/albums/${same.album}/reset`))).toBe(false);
    });

    it.each(unlisted)("leaves the marker for an album that is not listed (%s)", async (kind) => {
        const s = await withAlbum(`ayu${kind}`, kind, { year: 2005, genres: ["Rock"] });
        expect(await markerMoves(() => editAlbum(s.album, { year: 1999 }))).toBe(false);
        expect(await markerMoves(() => editAlbum(s.album, { genres: ["Jazz"] }))).toBe(false);
        expect(await markerMoves(() => post(`/enrichment/albums/${s.album}/reset`))).toBe(false);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: s.album } })).displayYear).toBeNull();
    });
});
