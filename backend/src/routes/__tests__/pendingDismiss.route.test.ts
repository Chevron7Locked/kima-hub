/**
 * Dismissing a waiting import entry (DELETE /playlists/:id/pending/:trackId) takes the playlist lock like every other
 * write to the playlist, so a scan that is placing the same song cannot add it back after the person said no. The
 * import the playlist came from loses that listing too: its total and its saved listing both shrink, whatever the
 * cached copy of the job held. Real database, real router and Redis; auth via JWT.
 */

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import playlistsRoutes from "../playlists";
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { lockPlaylist, placeFoundSongs } from "../../services/playlistService";
import { getImportJob } from "../../services/spotifyImport";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";
import { mountAsServer } from "./helpers/serverMount";

const MARK = "zz-pending-dismiss";
const JOB = `${MARK}-job`;
const app = mountAsServer(express().use(express.json()), "/playlists", playlistsRoutes, "/api/playlists");
const as = (userId: string) =>
    `Bearer ${jwt.sign({ userId, username: userId, role: "user", tokenVersion: 0 }, process.env.JWT_SECRET!, { expiresIn: "1h" })}`;

let owner: string;
let trackId: string;
let playlistId: string;
let waitingIds: string[];

const listing = (title: string) => ({ artist: "Band", title, album: "Rec", albumMbid: null, artistMbid: null, preMatchedTrackId: null, isrc: null });
const LISTINGS = [listing("one"), listing("two"), listing("three")];

async function cleanup() {
    await redisClient.del(`import:job:${JOB}`);
    await prisma.spotifyImportJob.deleteMany({ where: { id: JOB } });
    await prisma.user.deleteMany({ where: { username: { startsWith: MARK } } });
    await prisma.track.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.album.deleteMany({ where: { title: { startsWith: MARK } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: MARK } } });
}

beforeAll(async () => {
    await waitForRedisReady();
    await cleanup();
    owner = (await prisma.user.create({ data: { username: `${MARK}-owner`, passwordHash: "x" } })).id;
    const artist = await prisma.artist.create({ data: { name: `${MARK} Artist`, identityKey: `${MARK}-artist` } });
    const album = await prisma.album.create({
        data: { rgMbid: `${MARK}-rg`, identityKey: `${MARK}-album`, primaryType: "Album", title: `${MARK} Album`, artistId: artist.id, location: "LIBRARY" },
    });
    trackId = (await prisma.track.create({
        data: { title: `${MARK} Song`, albumId: album.id, trackNo: 1, duration: 100, filePath: `/${MARK}/1.flac`, fileModified: new Date(), fileSize: 1 },
    })).id;
});

beforeEach(async () => {
    await redisClient.del(`import:job:${JOB}`);
    await prisma.spotifyImportJob.deleteMany({ where: { id: JOB } });
    await prisma.playlist.deleteMany({ where: { userId: owner } });
    playlistId = (await prisma.playlist.create({ data: { userId: owner, name: `${MARK} list` } })).id;
    waitingIds = [];
    for (const [i, l] of LISTINGS.entries()) {
        waitingIds.push((await prisma.playlistPendingTrack.create({
            data: { playlistId, spotifyArtist: l.artist, spotifyTitle: l.title, spotifyAlbum: l.album, sort: i, rank: `a${i}` },
        })).id);
    }
    await prisma.spotifyImportJob.create({
        data: {
            id: JOB, userId: owner, spotifyPlaylistId: "pl", playlistName: "Imported", status: "completed", albumsTotal: 0,
            tracksTotal: 3, tracksMatched: 0, createdPlaylistId: playlistId, pendingTracks: LISTINGS,
        },
    });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

const dismiss = (id: string) => request(app).delete(`/playlists/${playlistId}/pending/${id}`).set("Authorization", as(owner));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Holds the playlist's lock the way a scan does, until `release()`. */
async function holdLock() {
    let release!: () => void;
    let locked!: () => void;
    const hasLock = new Promise<void>((r) => (locked = r));
    const gate = new Promise<void>((r) => (release = r));
    const done = prisma.$transaction(async (tx) => {
        await lockPlaylist(tx, playlistId);
        locked();
        await gate;
    }, { timeout: 30_000 });
    await hasLock;
    return { release, done };
}

describe("DELETE /playlists/:id/pending/:trackId", () => {
    it("waits for the playlist lock, so a scan in the middle of placing the song is not overtaken", async () => {
        const held = await holdLock();
        const response = dismiss(waitingIds[0]).then((res) => res);
        await wait(300);
        expect(await prisma.playlistPendingTrack.count({ where: { id: waitingIds[0] } })).toBe(1);
        held.release();
        await held.done;
        expect((await response).status).toBe(200);
        expect(await prisma.playlistPendingTrack.count({ where: { id: waitingIds[0] } })).toBe(0);
    });

    it("leaves the song out of the playlist whichever of a dismissal and a scan runs first", async () => {
        for (let round = 0; round < 5; round += 1) {
            await prisma.playlistItem.deleteMany({ where: { playlistId } });
            const entry = await prisma.playlistPendingTrack.create({
                data: { playlistId, spotifyArtist: "Band", spotifyTitle: `again ${round}`, spotifyAlbum: "Rec", sort: 9, rank: `b${round}` },
            });
            const [res] = await Promise.all([dismiss(entry.id), placeFoundSongs(playlistId, [{ trackId, pendingId: entry.id }])]);
            const placed = await prisma.playlistItem.count({ where: { playlistId } });
            // Dismissed first: gone and not added. Placed first: it is on the playlist and the dismissal finds nothing.
            expect(placed).toBe(res.status === 200 ? 0 : 1);
            expect(await prisma.playlistPendingTrack.count({ where: { id: entry.id } })).toBe(0);
        }
    });

    it("answers not found once the entry has been answered or dismissed", async () => {
        expect((await dismiss(waitingIds[0])).status).toBe(200);
        expect((await dismiss(waitingIds[0])).status).toBe(404);
    });

    it("takes the listing off the import: the total drops by one and the saved listing loses that entry", async () => {
        const res = await dismiss(waitingIds[1]);
        expect(res.status).toBe(200);
        const job = await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: JOB } });
        expect(job.tracksTotal).toBe(2);
        expect((job.pendingTracks as ReturnType<typeof listing>[]).map((l) => l.title)).toEqual(["one", "three"]);
    });

    it("shows the new counts to a reader of the job even when a copy of the job was cached before", async () => {
        expect((await getImportJob(JOB))!.tracksTotal).toBe(3); // caches the job
        await dismiss(waitingIds[0]);
        const job = (await getImportJob(JOB))!;
        expect(job.tracksTotal).toBe(2);
        expect(job.pendingTracks.map((l) => l.title)).toEqual(["two", "three"]);
    });

    it("drops only one copy of a listing the import held twice", async () => {
        await prisma.spotifyImportJob.update({ where: { id: JOB }, data: { tracksTotal: 4, pendingTracks: [LISTINGS[0], LISTINGS[0], LISTINGS[1], LISTINGS[2]] } });
        await dismiss(waitingIds[0]);
        const job = await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: JOB } });
        expect(job.tracksTotal).toBe(3);
        expect((job.pendingTracks as ReturnType<typeof listing>[]).map((l) => l.title)).toEqual(["one", "two", "three"]);
    });

    it("dismisses on a playlist no import made, touching no job", async () => {
        await prisma.spotifyImportJob.update({ where: { id: JOB }, data: { createdPlaylistId: null } });
        expect((await dismiss(waitingIds[0])).status).toBe(200);
        expect((await prisma.spotifyImportJob.findUniqueOrThrow({ where: { id: JOB } })).tracksTotal).toBe(3);
    });
});
