/**
 * A person's edit or reset of a shown name moves the library-changed marker only when a client lists the edited item
 * (Subsonic's `lastModified`): a song with a playable file on a library album, and an album or artist holding one.
 * An edit of a Discover item or of one whose songs are missing or corrupt leaves it, and so does a reset that changes
 * no name a client shows. Real router, real admin token, real database and the real marker.
 */
import express from "express";
import request from "supertest";
import router from "../enrichment";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { markerMoves } from "../../__tests__/helpers/libraryMarker";
import { expectLog } from "../../__tests__/helpers/expectedLogs";
import * as settings from "../../utils/systemSettings";
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
        expect(await markerMoves(() => put(`/enrichment/albums/${s.album}/metadata`, { year: 1999 }))).toBe(false);
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
