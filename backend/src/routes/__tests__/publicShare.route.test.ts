// Opening a share link through the real route: the reply's envelope, the refusals, and the visit count. What a share
// holds (its fields, its playable songs, its order) is decided in shareContents and tested there. Real database.

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import shareRoutes from "../share";
import { mountAsServer } from "./helpers/serverMount";
import { expectLog } from "../../__tests__/helpers/expectedLogs";

const TAG = "zz-public-share";
const app = mountAsServer(express(), "/share", shareRoutes, "/api/share");
const resolve = (token: string) => request(app).get(`/share/${token}`);

let userId: string;
let artistId: string;
let albumId: string;
let firstTrack: string;
let corruptTrack: string;
let playlistId: string;

const link = async (entityType: string, entityId: string) => {
    const token = `${TAG}-${entityType}-${Math.random().toString(36).slice(2)}`;
    await prisma.shareLink.create({ data: { token, entityType, entityId, createdBy: userId } });
    return token;
};

beforeAll(async () => {
    userId = (await prisma.user.create({ data: { username: TAG, passwordHash: "x" } })).id;
    artistId = (await prisma.artist.create({ data: { name: "The Artist", normalizedName: TAG, identityKey: TAG } })).id;
    albumId = (await prisma.album.create({ data: { rgMbid: TAG, artistId, title: "The Album", primaryType: "Album", location: "LIBRARY" } })).id;
    const track = (n: number, data: object = {}) => ({
        albumId,
        title: `Song ${n}`,
        duration: 100,
        trackNo: n,
        filePath: `/${TAG}/${n}.flac`,
        fileModified: new Date(),
        fileSize: 1,
        ...data,
    });
    firstTrack = (await prisma.track.create({ data: track(1) })).id;
    corruptTrack = (await prisma.track.create({ data: track(2, { corrupt: true }) })).id;
    playlistId = (await prisma.playlist.create({ data: { userId, name: "The Playlist", isPublic: false } })).id;
    await prisma.playlistItem.create({ data: { playlistId, trackId: firstTrack, sort: 0, rank: "a" } });
});

afterAll(async () => {
    await prisma.shareLink.deleteMany({ where: { createdBy: userId } });
    await prisma.playlist.deleteMany({ where: { userId } });
    await prisma.artist.deleteMany({ where: { id: artistId } });
    await prisma.user.deleteMany({ where: { id: userId } });
});

it.each([
    ["track", () => firstTrack],
    ["album", () => albumId],
    ["playlist", () => playlistId],
])("a %s share is answered with its type, what it holds and when the link was made, and nothing else", async (type, id) => {
    const res = await resolve(await link(type, id()));

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["createdAt", "entity", "entityType"]);
    expect(res.body.entityType).toBe(type);
    expect(res.body.entity.id).toBe(id());
});

it("unknown, expired and emptied links answer as before", async () => {
    const unknown = await resolve(`${TAG}-no-such-token`);
    expect([unknown.status, unknown.body]).toEqual([404, { error: "Share link not found" }]);

    const expiredToken = `${TAG}-expired`;
    await prisma.shareLink.create({ data: { token: expiredToken, entityType: "track", entityId: firstTrack, createdBy: userId, expiresAt: new Date(Date.now() - 1000) } });
    const expired = await resolve(expiredToken);
    expect([expired.status, expired.body]).toEqual([410, { error: "Share link has expired" }]);

    const gone = await resolve(await link("track", `${TAG}-no-such-track`));
    expect([gone.status, gone.body]).toEqual([404, { error: "Shared content no longer exists" }]);
});

it("a share of a song that no longer plays answers as for a deleted one", async () => {
    const res = await resolve(await link("track", corruptTrack));
    expect([res.status, res.body]).toEqual([404, { error: "Shared content no longer exists" }]);
});

// The count a Subsonic app shows as the share's visitCount: one for each time the share is opened, as Navidrome counts.
describe("visits", () => {
    const visits = async (token: string) => (await prisma.shareLink.findUniqueOrThrow({ where: { token } })).playCount;

    it.each([
        ["track", () => firstTrack],
        ["album", () => albumId],
        ["playlist", () => playlistId],
    ])("opening a %s share counts one visit, each time", async (type, id) => {
        const token = await link(type, id());
        expect(await visits(token)).toBe(0);

        expect((await resolve(token)).status).toBe(200);
        expect(await visits(token)).toBe(1);

        await resolve(token);
        await resolve(token);
        expect(await visits(token)).toBe(3);
    });

    it("counts none for a link that is unknown, expired or whose content is gone", async () => {
        const expiredToken = `${TAG}-expired-visits`;
        await prisma.shareLink.create({ data: { token: expiredToken, entityType: "track", entityId: firstTrack, createdBy: userId, expiresAt: new Date(Date.now() - 1000) } });
        const goneToken = await link("track", `${TAG}-no-such-track`);

        await resolve(expiredToken);
        await resolve(goneToken);
        await resolve(`${TAG}-no-such-token`);

        expect([await visits(expiredToken), await visits(goneToken)]).toEqual([0, 0]);
    });

    it("a read asking count=0 (the page card, a check after a playback error) answers in full and counts none", async () => {
        const token = await link("track", firstTrack);
        const read = await request(app).get(`/share/${token}?count=0`);
        expect(read.status).toBe(200);
        expect(read.body.entityType).toBe("track");
        expect(await visits(token)).toBe(0);

        // A page open still adds exactly one, and any other value of the flag is an ordinary open.
        await resolve(token);
        expect(await visits(token)).toBe(1);
        await request(app).get(`/share/${token}?count=1`);
        expect(await visits(token)).toBe(2);
    });

    it("counts none for a HEAD request, which opens nothing", async () => {
        const token = await link("track", firstTrack);
        expect((await request(app).head(`/share/${token}`)).status).toBe(200);
        expect(await visits(token)).toBe(0);
    });

    it("counts none for a cover or a stream of the share", async () => {
        const token = await link("track", firstTrack);
        await request(app).get(`/share/${token}/cover-art/native:albums%2Fx.jpg`);
        await request(app).get(`/share/${token}/stream/${firstTrack}`);
        expect(await visits(token)).toBe(0);
    });

    it("still opens the share, and logs it, when the count cannot be saved", async () => {
        const token = await link("track", firstTrack);
        const logged = expectLog("warn");
        const count = jest.spyOn(prisma.shareLink, "updateMany").mockRejectedValueOnce(new Error("db down"));
        try {
            const res = await resolve(token);
            expect([res.status, res.body.entityType]).toEqual([200, "track"]);
        } finally {
            count.mockRestore();
        }
        expect(logged).toHaveBeenCalledWith(expect.stringContaining("db down"));
        expect(await visits(token)).toBe(0);
    });
});

