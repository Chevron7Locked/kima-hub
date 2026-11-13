// What a stranger holding a share link can see: named fields only. Real database, through the real route.
// Each reply is compared whole, with the expected keys written out, so a field that is not listed fails the test.

import express from "express";
import request from "supertest";
import { prisma } from "../../utils/db";
import shareRoutes from "../share";
import { mountAsServer } from "./helpers/serverMount";

const TAG = "zz-public-share";
const app = mountAsServer(express(), "/share", shareRoutes, "/api/share");
const resolve = (token: string) => request(app).get(`/share/${token}`);

let userId: string;
let artistId: string;
let albumId: string;
let firstTrack: string;
let secondTrack: string;
let playlistId: string;
let firstItem: string;
let secondItem: string;

const link = async (entityType: string, entityId: string) => {
    const token = `${TAG}-${entityType}-${Math.random().toString(36).slice(2)}`;
    await prisma.shareLink.create({ data: { token, entityType, entityId, createdBy: userId } });
    return token;
};

const album = { title: "The Album", coverUrl: "native:albums/cover.jpg", artist: { name: "The Artist" } };
const firstReply = () => ({ id: firstTrack, title: "First", duration: 180, trackNo: 1, discNumber: 1, discSubtitle: "Side A", album });
// An album share lists its tracks without the album, which the share already names once.
const inAlbum = <T extends { album: unknown }>({ album: _album, ...track }: T) => track;
const secondReply = () => ({ id: secondTrack, title: "Second", duration: 200, trackNo: 2, discNumber: 1, discSubtitle: null, album });

beforeAll(async () => {
    userId = (await prisma.user.create({ data: { username: TAG, passwordHash: "x" } })).id;
    artistId = (await prisma.artist.create({ data: { name: "The Artist", normalizedName: TAG, identityKey: TAG } })).id;
    albumId = (
        await prisma.album.create({
            data: { rgMbid: TAG, artistId, title: "The Album", primaryType: "Album", coverUrl: album.coverUrl, location: "LIBRARY" },
        })
    ).id;
    const track = (n: number, title: string, duration: number, discSubtitle: string | null) => ({
        albumId,
        title,
        duration,
        trackNo: n,
        discNumber: 1,
        discSubtitle,
        filePath: `/secret/server/path/${n}.flac`,
        fileModified: new Date(),
        fileSize: 7654321,
        analysisStatus: "failed",
        analysisError: "a private analysis error",
    });
    firstTrack = (await prisma.track.create({ data: track(1, "First", 180, "Side A") })).id;
    secondTrack = (await prisma.track.create({ data: track(2, "Second", 200, null) })).id;
    playlistId = (await prisma.playlist.create({ data: { userId, name: "The Playlist", isPublic: false } })).id;
    // `sort` runs the other way from `rank`, so only following `rank` gives first-then-second.
    firstItem = (await prisma.playlistItem.create({ data: { playlistId, trackId: firstTrack, sort: 1, rank: "a" } })).id;
    secondItem = (await prisma.playlistItem.create({ data: { playlistId, trackId: secondTrack, sort: 0, rank: "b" } })).id;
});

afterAll(async () => {
    await prisma.shareLink.deleteMany({ where: { createdBy: userId } });
    await prisma.playlist.deleteMany({ where: { userId } });
    await prisma.artist.deleteMany({ where: { id: artistId } });
    await prisma.user.deleteMany({ where: { id: userId } });
});

it("a track share has only the listed fields", async () => {
    const res = await resolve(await link("track", firstTrack));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entityType: "track", entity: firstReply(), createdAt: expect.any(String) });
});

it("an album share has only the listed fields", async () => {
    const res = await resolve(await link("album", albumId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
        entityType: "album",
        entity: {
            id: albumId,
            title: "The Album",
            coverUrl: album.coverUrl,
            artist: { name: "The Artist" },
            tracks: [inAlbum(firstReply()), inAlbum(secondReply())],
        },
        createdAt: expect.any(String),
    });
});

it("a playlist share has only the listed fields, in the app's order", async () => {
    const res = await resolve(await link("playlist", playlistId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
        entityType: "playlist",
        entity: {
            id: playlistId,
            name: "The Playlist",
            items: [
                { id: firstItem, sort: 1, track: firstReply() },
                { id: secondItem, sort: 0, track: secondReply() },
            ],
        },
        createdAt: expect.any(String),
    });
});

it("no share reply carries a private value, anywhere in its body", async () => {
    for (const [type, id] of [["track", firstTrack], ["album", albumId], ["playlist", playlistId]] as const) {
        const { text } = await resolve(await link(type, id));

        for (const secret of ["/secret/server/path", "a private analysis error", userId, TAG, "LIBRARY", "7654321", "filePath", "userId", "username"]) {
            expect(text).not.toContain(secret);
        }
    }
});

it("an edited track title shows on a track share, in a playlist and in an album", async () => {
    await prisma.track.update({ where: { id: firstTrack }, data: { displayTitle: "First, edited" } });
    try {
        const track = await resolve(await link("track", firstTrack));
        expect(track.body.entity.title).toBe("First, edited");

        const playlist = await resolve(await link("playlist", playlistId));
        expect(playlist.body.entity.items.map((i: { track: { title: string } }) => i.track.title)).toEqual(["First, edited", "Second"]);

        const albumShare = await resolve(await link("album", albumId));
        expect(albumShare.body.entity.tracks.map((t: { title: string }) => t.title)).toEqual(["First, edited", "Second"]);
    } finally {
        await prisma.track.update({ where: { id: firstTrack }, data: { displayTitle: null } });
    }
});

it("an edited album title shows on an album share and on the album named in a track share", async () => {
    await prisma.album.update({ where: { id: albumId }, data: { displayTitle: "The Album, edited" } });
    try {
        const albumShare = await resolve(await link("album", albumId));
        expect(albumShare.body.entity.title).toBe("The Album, edited");

        const track = await resolve(await link("track", firstTrack));
        expect(track.body.entity.album.title).toBe("The Album, edited");
    } finally {
        await prisma.album.update({ where: { id: albumId }, data: { displayTitle: null } });
    }
});

it("an edited artist name shows on every artist in a reply, under the same key", async () => {
    await prisma.artist.update({ where: { id: artistId }, data: { displayName: "The Artist, edited" } });
    try {
        const track = await resolve(await link("track", firstTrack));
        expect(track.body.entity.album.artist).toEqual({ name: "The Artist, edited" });

        const albumShare = await resolve(await link("album", albumId));
        expect(albumShare.body.entity.artist).toEqual({ name: "The Artist, edited" });

        const playlist = await resolve(await link("playlist", playlistId));
        for (const item of playlist.body.entity.items) {
            expect(item.track.album.artist).toEqual({ name: "The Artist, edited" });
        }
    } finally {
        await prisma.artist.update({ where: { id: artistId }, data: { displayName: null } });
    }
});

it("unknown, expired, spent and emptied links answer as before", async () => {
    const unknown = await resolve(`${TAG}-no-such-token`);
    expect([unknown.status, unknown.body]).toEqual([404, { error: "Share link not found" }]);

    const expiredToken = `${TAG}-expired`;
    await prisma.shareLink.create({ data: { token: expiredToken, entityType: "track", entityId: firstTrack, createdBy: userId, expiresAt: new Date(Date.now() - 1000) } });
    const expired = await resolve(expiredToken);
    expect([expired.status, expired.body]).toEqual([410, { error: "Share link has expired" }]);

    const spentToken = `${TAG}-spent`;
    await prisma.shareLink.create({ data: { token: spentToken, entityType: "track", entityId: firstTrack, createdBy: userId, maxPlays: 2, playCount: 2 } });
    const spent = await resolve(spentToken);
    expect([spent.status, spent.body]).toEqual([410, { error: "Share link play limit reached" }]);

    const gone = await resolve(await link("track", `${TAG}-no-such-track`));
    expect([gone.status, gone.body]).toEqual([404, { error: "Shared content no longer exists" }]);
});

// A link made before a song stopped playing, or after a like moved nothing, shows only what plays. The song's file is
// there in every case, so only the playable-song rule can be the reason for a refusal.
describe("a share of songs that do not play", () => {
    const track = (albumId: string, n: number, data: object = {}) =>
        prisma.track.create({
            data: { albumId, title: `Song ${n}`, duration: 100, trackNo: n, filePath: `/${TAG}/${albumId}-${n}.flac`, fileModified: new Date(), fileSize: 1, ...data },
        }).then((t) => t.id);
    const albumOf = (suffix: string, location: "LIBRARY" | "DISCOVER" = "LIBRARY") =>
        prisma.album.create({ data: { rgMbid: `${TAG}-${suffix}`, identityKey: `${TAG}-${suffix}`, artistId, title: suffix, primaryType: "Album", location } }).then((a) => a.id);

    let mixedAlbum: string;
    let deadAlbum: string;
    let discoverAlbum: string;
    let playable: string;
    let missing: string;
    let corrupt: string;
    let suggested: string;
    let deadSong: string;

    beforeAll(async () => {
        mixedAlbum = await albumOf("mixed");
        playable = await track(mixedAlbum, 1);
        missing = await track(mixedAlbum, 2, { missingSince: new Date() });
        corrupt = await track(mixedAlbum, 3, { corrupt: true });
        deadAlbum = await albumOf("dead");
        deadSong = await track(deadAlbum, 1, { corrupt: true });
        discoverAlbum = await albumOf("discover", "DISCOVER");
        suggested = await track(discoverAlbum, 1);
    });

    const asRefused = { status: 404, body: { error: "Shared content no longer exists" } };
    const refusal = async (type: string, id: string) => {
        const res = await resolve(await link(type, id));
        return { status: res.status, body: res.body };
    };

    it.each(["missing", "corrupt", "suggested"])("a track share of the %s song answers as for a deleted one", async (kind) => {
        const id = { missing, corrupt, suggested }[kind as "missing"];
        expect(await refusal("track", id)).toEqual(asRefused);
    });

    it("a track share of the playable song still shows it", async () => {
        const res = await resolve(await link("track", playable));
        expect(res.status).toBe(200);
        expect(res.body.entity.id).toBe(playable);
    });

    it("an album share lists only its playable songs", async () => {
        const res = await resolve(await link("album", mixedAlbum));
        expect(res.status).toBe(200);
        expect(res.body.entity.tracks.map((t: { id: string }) => t.id)).toEqual([playable]);
    });

    it.each(["dead", "discover"])("an album share of an album with nothing to play (%s) answers as for a deleted one", async (kind) => {
        expect(await refusal("album", kind === "dead" ? deadAlbum : discoverAlbum)).toEqual(asRefused);
    });

    it("a playlist share lists only its playable songs, in the app's order", async () => {
        const list = (await prisma.playlist.create({ data: { userId, name: "Mixed", isPublic: false } })).id;
        for (const [i, trackId] of [suggested, playable, missing, corrupt, firstTrack].entries()) {
            await prisma.playlistItem.create({ data: { playlistId: list, trackId, sort: i, rank: `m${i}` } });
        }
        const res = await resolve(await link("playlist", list));
        expect(res.status).toBe(200);
        expect(res.body.entity.items.map((i: { track: { id: string } }) => i.track.id)).toEqual([playable, firstTrack]);
    });

    it("a playlist share with nothing to play shows an empty list", async () => {
        const list = (await prisma.playlist.create({ data: { userId, name: "Nothing plays", isPublic: false } })).id;
        for (const [i, trackId] of [suggested, missing, corrupt, deadSong].entries()) {
            await prisma.playlistItem.create({ data: { playlistId: list, trackId, sort: i, rank: `n${i}` } });
        }
        const res = await resolve(await link("playlist", list));
        expect(res.status).toBe(200);
        expect(res.body.entity).toEqual({ id: list, name: "Nothing plays", items: [] });
    });
});
