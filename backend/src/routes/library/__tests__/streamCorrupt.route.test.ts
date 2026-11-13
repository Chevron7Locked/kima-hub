// The web stream by id plays a Discover song (the Discover page plays through it) but refuses a song whose file is
// missing or could not be read. Real database, real router, real files.
jest.mock("../../../config", () => {
    const actual = jest.requireActual("../../../config");
    const base = require("path").join(require("os").tmpdir(), `kima-stream-corrupt-${process.pid}`);
    Object.assign(actual.config.music, { musicPath: `${base}/music`, transcodeCachePath: `${base}/cache` });
    return actual;
});

import express from "express";
import request from "supertest";
import fs from "fs";
import { prisma } from "../../../utils/db";
import { config } from "../../../config";
import streamingRouter from "../streaming";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";
import { mountAsServer } from "../../__tests__/helpers/serverMount";

const P = "zz-stream-corrupt";
const BYTES = Buffer.from("fLaC-stream-corrupt-bytes");
const app = mountAsServer(
    express().use((req: any, _res, next) => { req.user = { id: `${P}-user`, role: "user" }; next(); }),
    "/library",
    streamingRouter,
    "/api/library",
    { standIn: true },
);

const KINDS = ["playable", "discover", "missing", "corrupt"] as const;

beforeAll(async () => {
    await fs.promises.mkdir(config.music.musicPath, { recursive: true });
    await fs.promises.mkdir(config.music.transcodeCachePath, { recursive: true });
    await prisma.artist.create({ data: { id: `${P}-ar`, name: P, normalizedName: P, identityKey: `${P}-ik` } });
    for (const kind of KINDS) {
        const id = `${P}-${kind}`;
        await prisma.album.create({
            data: { id: `${id}-al`, rgMbid: `${id}-rg`, artistId: `${P}-ar`, identityKey: `${id}-ik`, title: id, primaryType: "Album", location: kind === "discover" ? "DISCOVER" : "LIBRARY" },
        });
        await fs.promises.writeFile(`${config.music.musicPath}/${id}.flac`, BYTES);
        await prisma.track.create({
            data: {
                id, albumId: `${id}-al`, title: id, trackNo: 1, duration: 100, filePath: `${id}.flac`, fileModified: new Date(), fileSize: BYTES.length,
                ...(kind === "missing" ? { missingSince: new Date() } : {}),
                ...(kind === "corrupt" ? { corrupt: true } : {}),
            },
        });
    }
});

afterAll(async () => {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await fs.promises.rm(`${config.music.musicPath}/..`, { recursive: true, force: true });
    await closeEngineConnections();
});

const stream = (id: string) =>
    request(app)
        .get(`/library/tracks/${id}/stream?quality=original`)
        .buffer(true)
        .parse((res, cb) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => cb(null, Buffer.concat(chunks)));
        });

it("plays a playable song", async () => {
    const res = await stream(`${P}-playable`);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(BYTES)).toBe(true);
});

it("still plays a Discover song, which the Discover page plays through this route", async () => {
    const res = await stream(`${P}-discover`);
    expect(res.status).toBe(200);
    expect((res.body as Buffer).equals(BYTES)).toBe(true);
});

it("answers not available for a song whose file is missing", async () => {
    const res = await request(app).get(`/library/tracks/${P}-missing/stream?quality=original`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Track not available" });
});

it("answers not available for a song whose file could not be read, and sends no bytes", async () => {
    const res = await request(app).get(`/library/tracks/${P}-corrupt/stream?quality=original`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Track not available" });
});
