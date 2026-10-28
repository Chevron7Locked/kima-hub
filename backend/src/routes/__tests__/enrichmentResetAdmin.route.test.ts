// Resetting an artist, album or song's edited metadata wipes an admin's edits, so it
// needs admin like the edit itself. On the real database with real tokens.

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
