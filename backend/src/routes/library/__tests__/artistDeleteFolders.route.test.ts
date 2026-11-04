/**
 * Deleting an artist deletes that artist's song files, then a folder that held them, and each parent, only when what
 * is left anywhere under it is leftovers (cover art, .nfo, .cue, system files). Any other file, or a link, keeps the
 * folder, so music filed by genre or in a shared folder keeps everyone else's files, scanned or not, of any type. Real
 * database and real files in a temporary music root.
 */

jest.mock("../../../utils/logger", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../../middleware/auth", () => {
    const signIn = (req: any, _res: any, next: any) => {
        req.user = { id: "adel_admin", role: "admin" };
        next();
    };
    return { requireAuth: signIn, requireAdmin: signIn, requireAuthOrToken: signIn };
});
jest.mock("../../../config", () => ({
    config: {
        music: { musicPath: require("path").join(require("os").tmpdir(), `kima-adel-music-${process.pid}`) },
        redisUrl: process.env.REDIS_URL,
    },
}));

import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import { prisma } from "../../../utils/db";
import { config } from "../../../config";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";
import artistsRoutes from "../artists";

const P = "adel";
const MUSIC = path.resolve(config.music.musicPath);
const app = () => express().use(express.json()).use("/", artistsRoutes);

let n = 0;
/** An artist, and one album holding a scanned song at each of `files` (paths relative to the music root). */
async function artistWith(name: string, files: string[]) {
    const id = `${P}_art_${++n}`;
    await prisma.artist.create({ data: { id, name, identityKey: `${P}_ik_${n}` } });
    const albumId = `${P}_alb_${n}`;
    await prisma.album.create({ data: { id: albumId, rgMbid: `${P}_rg_${n}`, artistId: id, title: `${name} album`, primaryType: "Album", location: "LIBRARY" } });
    for (const [i, file] of files.entries()) {
        await prisma.track.create({
            data: { id: `${P}_t_${n}_${i}`, albumId, title: `song ${i}`, trackNo: i + 1, duration: 200, filePath: file, fileModified: new Date(), fileSize: 10 },
        });
        put(file);
    }
    return id;
}

function put(file: string) {
    const full = path.join(MUSIC, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "x");
}
const exists = (p: string) => fs.existsSync(path.join(MUSIC, p));

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
    await cleanup();
    fs.rmSync(MUSIC, { recursive: true, force: true });
    fs.mkdirSync(MUSIC, { recursive: true });
});

afterAll(async () => {
    await cleanup();
    fs.rmSync(MUSIC, { recursive: true, force: true });
    await closeEngineConnections();
    await prisma.$disconnect();
});

const del = (id: string) => request(app()).delete(`/artists/${id}`).expect(200);

describe("deleting an artist", () => {
    it("keeps the other artists of a genre folder", async () => {
        const a = await artistWith("Band A", ["Rock/Band A/Album/01.flac"]);
        await artistWith("Band B", ["Rock/Band B/Album/01.flac"]);

        await del(a);

        expect(exists("Rock/Band A")).toBe(false);
        expect(exists("Rock/Band B/Album/01.flac")).toBe(true);
    });

    it("keeps a shared compilation folder holding another song, even one never scanned", async () => {
        const a = await artistWith("Band A", ["Compilations/Mix/01.flac"]);
        put("Compilations/Mix/02.mp3");

        await del(a);

        expect(exists("Compilations/Mix/01.flac")).toBe(false);
        expect(exists("Compilations/Mix/02.mp3")).toBe(true);
    });

    it("removes the artist's own folder with what is left in it, and the parents it empties", async () => {
        const a = await artistWith("Band A", ["Band A/Album/01.flac", "Band A/Album/CD2/01.flac"]);
        put("Band A/Album/cover.jpg");
        put("Other/keep.flac");

        await del(a);

        expect(exists("Band A")).toBe(false);
        expect(exists("Other/keep.flac")).toBe(true);
        expect(fs.existsSync(MUSIC)).toBe(true);
    });

    it("never removes a folder only because it carries the artist's name", async () => {
        const rock = await artistWith("Rock", ["Singles/Rock/01.flac"]);
        put("Rock/Other Band/01.flac");

        await del(rock);

        expect(exists("Singles")).toBe(false);
        expect(exists("Rock/Other Band/01.flac")).toBe(true);
    });

    it("keeps a folder holding any file it does not know as a leftover, whatever its type", async () => {
        const a = await artistWith("Band A", ["Shared/Mix/01.flac"]);
        put("Shared/Mix/02.aiff");
        put("Shared/Mix/mix.m3u");

        await del(a);

        expect(exists("Shared/Mix/02.aiff")).toBe(true);
        expect(exists("Shared/Mix/mix.m3u")).toBe(true);
    });

    it("removes an artist folder holding only leftovers beside the album", async () => {
        const a = await artistWith("Band A", ["Band A/Album/01.flac"]);
        put("Band A/folder.jpg");
        put("Band A/.DS_Store");
        put("Band A/Other Album/cover.png");

        await del(a);

        expect(exists("Band A")).toBe(false);
    });

    it("keeps a folder holding a link, and what the link points at", async () => {
        const a = await artistWith("Band A", ["Band A/Album/01.flac"]);
        put("Elsewhere/song.flac");
        fs.symlinkSync(path.join(MUSIC, "Elsewhere"), path.join(MUSIC, "Band A/Album/linked"));

        await del(a);

        expect(exists("Band A/Album")).toBe(true);
        expect(exists("Elsewhere/song.flac")).toBe(true);
    });

    it("keeps a parent holding another program's empty folder", async () => {
        const a = await artistWith("Band A", ["Rock/Band A/Album/01.flac"]);
        fs.mkdirSync(path.join(MUSIC, "Rock/Band Z"), { recursive: true });

        await del(a);

        expect(exists("Rock/Band A")).toBe(false);
        expect(exists("Rock/Band Z")).toBe(true);
    });

    it("never follows a linked folder out of the music folder", async () => {
        const outside = fs.mkdtempSync(path.join(require("os").tmpdir(), "kima-adel-outside-"));
        try {
            fs.mkdirSync(path.join(outside, "Album"));
            fs.writeFileSync(path.join(outside, "Album", "cover.jpg"), "x");
            fs.symlinkSync(outside, path.join(MUSIC, "Linked"));
            fs.writeFileSync(path.join(outside, "Album", "01.flac"), "x");
            const a = await artistWith("Band A", ["Linked/Album/01.flac"]);

            await request(app()).delete(`/artists/${a}`).expect(409);

            expect(fs.existsSync(path.join(outside, "Album", "cover.jpg"))).toBe(true);
            expect(fs.existsSync(path.join(outside, "Album", "01.flac"))).toBe(true);
        } finally {
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });
});
