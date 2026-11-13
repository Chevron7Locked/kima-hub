/**
 * The track and artist DELETE routes touch nothing outside the music root, even when the stored path or artist name
 * (an ID3 tag) traverses, or a song sits behind a link leading out. Real database and real files: a temporary music
 * root, with a sibling folder standing for "outside" whose files must survive.
 */

jest.mock("../../../middleware/auth", () => {
    const signIn = (req: any, _res: any, next: any) => {
        req.user = { id: "dtrav_admin", role: "admin" };
        next();
    };
    return { requireAuth: signIn, requireAdmin: signIn, requireAuthOrToken: signIn };
});
jest.mock("../../../config", () => ({
    config: {
        music: { musicPath: require("path").join(require("os").tmpdir(), `kima-dtrav-music-${process.pid}`) },
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
import tracksRoutes from "../tracks";
import artistsRoutes from "../artists";
import { expectLog } from "../../../__tests__/helpers/expectedLogs";
import { mountAsServer } from "../../__tests__/helpers/serverMount";

const P = "dtrav";
const MUSIC = path.resolve(config.music.musicPath);
const OUTSIDE_NAME = `kima-dtrav-outside-${process.pid}`;
const OUTSIDE = path.join(path.dirname(MUSIC), OUTSIDE_NAME);
/** A stored path or tag that climbs out of the music root into the outside folder. */
const EVIL = `../${OUTSIDE_NAME}/evil`;

const app = express();
app.use(express.json());
mountAsServer(app, "/", tracksRoutes, "/api/library");
mountAsServer(app, "/", artistsRoutes, "/api/library");

let n = 0;
/** An artist with one album holding a song at each of `files` (paths as stored, relative to the music root). */
async function artistWith(name: string, files: string[]) {
    n += 1;
    const artist = `${P}_art_${n}`;
    await prisma.artist.create({ data: { id: artist, name, identityKey: `${P}_ik_${n}` } });
    const album = `${P}_alb_${n}`;
    await prisma.album.create({ data: { id: album, rgMbid: `${P}_rg_${n}`, artistId: artist, title: `${P} album ${n}`, primaryType: "Album", location: "LIBRARY" } });
    const songs: string[] = [];
    for (const [i, filePath] of files.entries()) {
        const id = `${P}_t_${n}_${i}`;
        await prisma.track.create({ data: { id, albumId: album, title: `${P} song ${n} ${i}`, trackNo: i + 1, duration: 100, filePath, fileModified: new Date(), fileSize: 10 } });
        songs.push(id);
    }
    return { artist, songs };
}

function put(root: string, file: string) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "x");
}
const exists = (full: string) => fs.existsSync(full);

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeEach(async () => {
    await cleanup();
    fs.rmSync(MUSIC, { recursive: true, force: true });
    fs.rmSync(OUTSIDE, { recursive: true, force: true });
    fs.mkdirSync(MUSIC, { recursive: true });
    fs.mkdirSync(OUTSIDE, { recursive: true });
    put(OUTSIDE, "evil.flac");
    put(OUTSIDE, "one.flac");
    // A link inside the music root that leads out to the outside folder.
    fs.symlinkSync(OUTSIDE, path.join(MUSIC, "Linked"));
});

afterAll(async () => {
    await cleanup();
    fs.rmSync(MUSIC, { recursive: true, force: true });
    fs.rmSync(OUTSIDE, { recursive: true, force: true });
    await closeEngineConnections();
    await prisma.$disconnect();
});

describe("library delete routes stay inside the music root", () => {
    it("DELETE /tracks/:id leaves a file its stored path points to outside the root", async () => {
        expectLog("warn");
        const { songs } = await artistWith("Radiohead", [`${EVIL}.flac`]);

        await request(app).delete(`/tracks/${songs[0]}`);

        expect(exists(path.join(OUTSIDE, "evil.flac"))).toBe(true);
    });

    it("DELETE /tracks/:id refuses a song behind a link leading out, keeping file and row", async () => {
        const { songs } = await artistWith("Linked artist", ["Linked/one.flac"]);

        const res = await request(app).delete(`/tracks/${songs[0]}`);

        expect(res.status).toBe(409);
        expect(exists(path.join(OUTSIDE, "one.flac"))).toBe(true);
        expect(await prisma.track.count({ where: { id: songs[0] } })).toBe(1);
    });

    it("DELETE /artists/:id refuses when any song is behind a link leading out, before touching anything", async () => {
        put(MUSIC, "A/Album/ok.flac");
        const { artist } = await artistWith("A", ["A/Album/ok.flac", "Linked/one.flac"]);

        const res = await request(app).delete(`/artists/${artist}`);

        expect(res.status).toBe(409);
        expect(exists(path.join(MUSIC, "A/Album/ok.flac"))).toBe(true);
        expect(exists(path.join(OUTSIDE, "one.flac"))).toBe(true);
        expect(await prisma.artist.count({ where: { id: artist } })).toBe(1);
    });

    it("DELETE /artists/:id leaves the outside folder alone when the artist name and a song path climb out of the root", async () => {
        expectLog("warn");
        // The name is a tag; it once reached rmSync(recursive, force) through a folder guess. The folder the name
        // points to (music root + name = OUTSIDE/evil) has to exist, with files in it, or deleting it would remove nothing.
        const nameFolder = path.join(MUSIC, EVIL);
        expect(nameFolder).toBe(path.join(OUTSIDE, "evil"));
        put(OUTSIDE, "evil/song.flac");
        put(OUTSIDE, "evil/keep.jpg");
        const { artist } = await artistWith(EVIL, [`${EVIL}.flac`, `${EVIL}/song.flac`]);

        await request(app).delete(`/artists/${artist}`);

        expect(exists(nameFolder)).toBe(true);
        expect(exists(path.join(nameFolder, "song.flac"))).toBe(true);
        expect(exists(path.join(nameFolder, "keep.jpg"))).toBe(true);
        expect(exists(path.join(OUTSIDE, "evil.flac"))).toBe(true);
        expect(exists(path.join(OUTSIDE, "one.flac"))).toBe(true);
    });

    it("DELETE /artists/:id still deletes an ordinary artist folder", async () => {
        // The guard must not break the feature it protects.
        put(MUSIC, "Radiohead/OK Computer/01.flac");
        const { artist } = await artistWith("Radiohead", ["Radiohead/OK Computer/01.flac"]);

        const res = await request(app).delete(`/artists/${artist}`);

        expect(res.status).toBe(200);
        expect(exists(path.join(MUSIC, "Radiohead"))).toBe(false);
        expect(exists(MUSIC)).toBe(true);
        expect(await prisma.artist.count({ where: { id: artist } })).toBe(0);
    });
});
