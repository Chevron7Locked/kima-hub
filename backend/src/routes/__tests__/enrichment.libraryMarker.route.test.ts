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

    it("leaves the marker when an edit sends no name", async () => {
        const s = await seed("nn", "playable", false);
        expect(await markerMoves(() => put(`/enrichment/artists/${s.artist}/metadata`, { bio: "text" }))).toBe(false);
        expect(await markerMoves(() => put(`/enrichment/albums/${s.album}/metadata`, { year: 1999 }))).toBe(false);
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
