// Resetting an artist, album or song's edited metadata wipes an admin's edits, so it
// needs admin like the edit itself. An edit and a reset answer with the same shape, and
// both answer 404 for something that is gone. On the real database with real tokens.

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import { generateToken } from "../../middleware/auth";
import enrichmentRoutes from "../enrichment";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "zz-reset-admin";
const USER = `${P}-member`;
const ADMIN = `${P}-admin`;
const ARTIST = `${P}-artist`;
const ALBUM = `${P}-album`;
const TRACK = `${P}-track`;

const app = () => express().use(express.json()).use("/enrichment", enrichmentRoutes);
const as = (id: string, role: "user" | "admin") =>
    `Bearer ${generateToken({ id, username: id, role, tokenVersion: 0 })}`;

const edit = () =>
    Promise.all([
        prisma.artist.update({ where: { id: ARTIST }, data: { displayName: "edited", hasUserOverrides: true } }),
        prisma.album.update({ where: { id: ALBUM }, data: { displayTitle: "edited", hasUserOverrides: true } }),
        prisma.track.update({ where: { id: TRACK }, data: { displayTitle: "edited", hasUserOverrides: true } }),
    ]);

const edited = async () => [
    (await prisma.artist.findUniqueOrThrow({ where: { id: ARTIST } })).displayName,
    (await prisma.album.findUniqueOrThrow({ where: { id: ALBUM } })).displayTitle,
    (await prisma.track.findUniqueOrThrow({ where: { id: TRACK } })).displayTitle,
];

const resets = [`/enrichment/artists/${ARTIST}/reset`, `/enrichment/albums/${ALBUM}/reset`, `/enrichment/tracks/${TRACK}/reset`];

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
    await prisma.user.create({ data: { id: ADMIN, username: ADMIN, passwordHash: "x", role: "admin", tokenVersion: 0 } });
    await prisma.artist.create({ data: { id: ARTIST, name: ARTIST, normalizedName: ARTIST, identityKey: `${P}_ik` } });
    await prisma.album.create({
        data: { id: ALBUM, rgMbid: `${P}_rg`, artistId: ARTIST, identityKey: `${P}_ak`, title: ALBUM, primaryType: "Album", year: 2024, location: "LIBRARY" },
    });
    await prisma.track.create({
        data: { id: TRACK, albumId: ALBUM, title: TRACK, trackNo: 1, duration: 200, filePath: `${P}/01.flac`, fileModified: new Date(), fileSize: 1000 },
    });
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: TRACK } });
    await prisma.album.deleteMany({ where: { id: ALBUM } });
    await prisma.artist.deleteMany({ where: { id: ARTIST } });
    await prisma.user.deleteMany({ where: { id: { in: [USER, ADMIN] } } });
    await closeEngineConnections();
});

describe("metadata reset is admin-only", () => {
    it("a member gets 403 and the edits stay", async () => {
        await edit();
        for (const path of resets) {
            const res = await request(app()).post(path).set("Authorization", as(USER, "user")).send({});
            expect(res.status).toBe(403);
        }
        expect(await edited()).toEqual(["edited", "edited", "edited"]);
    });

    it("no token is 401", async () => {
        for (const path of resets) {
            expect((await request(app()).post(path).send({})).status).toBe(401);
        }
    });

    it("an admin resets all three", async () => {
        await edit();
        for (const path of resets) {
            const res = await request(app()).post(path).set("Authorization", as(ADMIN, "admin")).send({});
            expect(res.status).toBe(200);
        }
        expect(await edited()).toEqual([null, null, null]);
    });
});

describe("editing and resetting metadata", () => {
    const kinds = [
        { path: `/enrichment/artists/${ARTIST}`, body: { name: "edited" }, key: "artist", has: ["albums"] },
        { path: `/enrichment/albums/${ALBUM}`, body: { title: "edited" }, key: "album", has: ["artist", "tracks"] },
        { path: `/enrichment/tracks/${TRACK}`, body: { title: "edited" }, key: "track", has: ["album"] },
    ];

    it("an edit and a reset send back the same shape", async () => {
        for (const kind of kinds) {
            const edited = await request(app()).put(`${kind.path}/metadata`).set("Authorization", as(ADMIN, "admin")).send(kind.body);
            const reset = await request(app()).post(`${kind.path}/reset`).set("Authorization", as(ADMIN, "admin")).send({});
            expect([edited.status, reset.status]).toEqual([200, 200]);
            expect(Object.keys(edited.body).sort()).toEqual(Object.keys(reset.body[kind.key]).sort());
            for (const field of kind.has) expect(edited.body[field]).toBeDefined();
        }
    });

    it("answers 404 for an edit of something that is gone", async () => {
        for (const [path, body, name] of [
            [`/enrichment/artists/${P}-gone/metadata`, { name: "x" }, "Artist"],
            [`/enrichment/albums/${P}-gone/metadata`, { title: "x" }, "Album"],
            [`/enrichment/tracks/${P}-gone/metadata`, { title: "x" }, "Track"],
        ] as const) {
            const res = await request(app()).put(path).set("Authorization", as(ADMIN, "admin")).send(body);
            expect([res.status, res.body.error]).toEqual([404, `${name} not found`]);
        }
    });
});
