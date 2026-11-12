/**
 * A playable song is a song on a library album whose file is there and was read. Every interface that picks songs
 * offers only playable ones; this file seeds one playable song and three that are not (a Discover song, a missing
 * file, a corrupt file) and calls each of those interfaces. An interface that moves onto the rule adds its row to
 * PICKERS (it lists songs) or its route to STREAMS (it plays one). Real database, real routers, real files.
 */
jest.mock("../../config", () => {
    const actual = jest.requireActual("../../config");
    const base = require("path").join(require("os").tmpdir(), `kima-playable-${process.pid}`);
    Object.assign(actual.config.music, { musicPath: `${base}/music`, transcodeCachePath: `${base}/cache` });
    return actual;
});

import express from "express";
import request from "supertest";
import fs from "fs";
import path from "path";
import { prisma } from "../db";
import { config } from "../../config";
import { PLAYABLE_SONG, playableSongSql } from "../libraryEligibility";
import { compatRouter } from "../../routes/subsonic/compat";
import { playbackRouter } from "../../routes/subsonic/playback";
import { searchRouter } from "../../routes/subsonic/search";

const P = "zz-playable";
const USER = `${P}-user`;
const SONG = { playable: `${P}-ok`, discover: `${P}-discover`, missing: `${P}-missing`, corrupt: `${P}-corrupt` } as const;
const UNPLAYABLE: string[] = [SONG.discover, SONG.missing, SONG.corrupt];
const BYTES = Buffer.from("fLaC-playable-song-bytes");

const app = express()
    .use((req: any, _res, next) => {
        req.user = { id: USER, username: USER, role: "user" };
        next();
    })
    .use("/rest", compatRouter, playbackRouter, searchRouter);
const subsonic = (route: string, query: Record<string, string>) =>
    request(app).get(`/rest/${route}`).query({ u: USER, f: "json", ...query });

/** Every interface that lists songs, each answering the ids it offers. */
const PICKERS: Record<string, () => Promise<string[]>> = {
    "the rule as a Prisma where piece": async () =>
        (await prisma.track.findMany({ where: { ...PLAYABLE_SONG, id: { startsWith: P } }, select: { id: true } })).map((t) => t.id),
    "the rule as a SQL fragment": async () =>
        (
            await prisma.$queryRaw<{ id: string }[]>`
                SELECT song.id FROM "Track" song JOIN "Album" a ON a.id = song."albumId"
                WHERE song.id LIKE ${`${P}%`} AND ${playableSongSql("song", "a")}`
        ).map((t) => t.id),
    "the rule as a SQL fragment on the bare table names": async () =>
        (
            await prisma.$queryRaw<{ id: string }[]>`
                SELECT "Track".id FROM "Track" JOIN "Album" ON "Album".id = "Track"."albumId"
                WHERE "Track".id LIKE ${`${P}%`} AND ${playableSongSql("Track", "Album")}`
        ).map((t) => t.id),
    "Subsonic search3 by title": async () => {
        const body = (await subsonic("search3.view", { query: P, songCount: "50" }).expect(200)).body["subsonic-response"];
        return (body.searchResult3.song ?? []).map((s: { id: string }) => s.id);
    },
    "Subsonic search3 over the whole library": async () => {
        const body = (await subsonic("search3.view", { query: "", songCount: "10000", artistCount: "0", albumCount: "0" }).expect(200))
            .body["subsonic-response"];
        return (body.searchResult3.song ?? []).map((s: { id: string }) => s.id).filter((id: string) => id.startsWith(P));
    },
    "Subsonic search3 for an album, which lists only albums with a playable song": async () => {
        const body = (await subsonic("search3.view", { query: "", songCount: "0", artistCount: "0", albumCount: "10000" }).expect(200))
            .body["subsonic-response"];
        const albums: string[] = (body.searchResult3.album ?? []).map((a: { id: string }) => a.id);
        // Each seeded song is alone on its album, so an album listed stands for its song.
        return Object.values(SONG).filter((id) => albums.includes(`${id}-al`));
    },
};

type Answer = { status: number; body: Buffer };
const subsonicBody = (res: Answer) => JSON.parse(res.body.toString())["subsonic-response"];
const sendsTheFile = (res: Answer) => expect(res.body.equals(BYTES)).toBe(true);

/** Every Subsonic route that plays one song by id, and what it answers for a playable song. */
const STREAMS: Record<string, { ask: (id: string) => request.Test; plays: (res: Answer) => void }> = {
    "stream.view": { ask: (id) => subsonic("stream.view", { id }), plays: sendsTheFile },
    "download.view": { ask: (id) => subsonic("download.view", { id }), plays: sendsTheFile },
    "getTranscodeStream.view": {
        ask: (id) => subsonic("getTranscodeStream.view", { mediaId: id, mediaType: "song", transcodeParams: "q-original" }),
        plays: sendsTheFile,
    },
    "getTranscodeDecision.view": {
        ask: (id) => subsonic("getTranscodeDecision.view", { mediaId: id, mediaType: "song" }),
        plays: (res) => expect(subsonicBody(res).transcodeDecision.canDirectPlay).toBe(true),
    },
};

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({ data: { id: `${P}-ar`, name: P, identityKey: `${P}-ar`, libraryAlbumCount: 3 } });
    for (const [kind, id] of Object.entries(SONG)) {
        // Each file is on disk, so a refusal can only come from the rule, never from a file the stream could not open.
        const rel = `${P}/${kind}.flac`;
        const file = path.join(config.music.musicPath, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, BYTES);
        await prisma.album.create({
            data: {
                id: `${id}-al`,
                rgMbid: `${id}-rg`,
                identityKey: `${id}-ak`,
                artistId: `${P}-ar`,
                title: `${P} ${kind}`,
                primaryType: "Album",
                location: id === SONG.discover ? "DISCOVER" : "LIBRARY",
            },
        });
        await prisma.track.create({
            data: {
                id,
                albumId: `${id}-al`,
                title: `${P} ${kind}`,
                trackNo: 1,
                duration: 100,
                mime: "audio/flac",
                filePath: rel,
                fileModified: new Date(),
                fileSize: BYTES.length,
                missingSince: id === SONG.missing ? new Date() : null,
                corrupt: id === SONG.corrupt,
            },
        });
    }
});

afterAll(async () => {
    await cleanup();
    fs.rmSync(path.dirname(config.music.musicPath), { recursive: true, force: true });
});

describe.each(Object.entries(PICKERS))("%s", (_name, pick) => {
    it("offers the playable song and none of the Discover, missing or corrupt ones", async () => {
        const ids = await pick();
        expect(ids).toContain(SONG.playable);
        expect(ids.filter((id) => UNPLAYABLE.includes(id))).toEqual([]);
    });
});

describe.each(Object.entries(STREAMS))("Subsonic %s", (_name, { ask, plays }) => {
    const answer = (id: string): Promise<Answer> =>
        ask(id).buffer(true).parse((r, cb) => {
            const chunks: Buffer[] = [];
            r.on("data", (c: Buffer) => chunks.push(c));
            r.on("end", () => cb(null, Buffer.concat(chunks)));
        });

    it("plays the playable song", async () => {
        const res = await answer(SONG.playable);
        expect(res.status).toBe(200);
        plays(res);
    });

    it.each(Object.entries(SONG).filter(([kind]) => kind !== "playable"))("answers not-found for the %s song", async (_kind, id) => {
        const res = await answer(id);
        expect(res.status).toBe(200);
        expect(subsonicBody(res)).toMatchObject({ status: "failed", error: { code: 70 } });
    });
});

it("refuses a table name that is not a plain identifier", () => {
    expect(() => playableSongSql(`t"; DROP TABLE "Track"; --`, "al")).toThrow();
});
