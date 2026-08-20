/**
 * addTracks must accept every real track, regardless of its album's
 * location.
 *
 * The service once scoped adds to albums with location=LIBRARY. A
 * DISCOVER album's tracks stream and queue like any other, so a person
 * adding one to a playlist got a silent 404 ("no playable library
 * tracks") and an empty playlist -- the collection grid surfaced discover
 * albums as first-class cards, and the walkthrough drove straight into
 * this on restored production data.
 *
 * These tests run against the real per-worker database: the bug lived in
 * a Prisma where-clause, which a mocked prisma can only re-assert, not
 * catch.
 */

import { prisma } from "../../utils/db";
import { addTracks } from "../playlistService";

const PREFIX = "pl-addtracks-test";

async function cleanup() {
    // Cascade deletes cover playlist -> items; album cascade covers tracks.
    await prisma.user.deleteMany({ where: { username: { startsWith: PREFIX } } });
    await prisma.artist.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function fixture(location: "LIBRARY" | "DISCOVER") {
    const tag = `${location}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const user = await prisma.user.create({
        data: { username: `${PREFIX}-${tag}`, passwordHash: "x", role: "user" },
    });
    const artist = await prisma.artist.create({
        data: { name: `${PREFIX}-${tag}-artist`, identityKey: `${PREFIX}-${tag}` },
    });
    const album = await prisma.album.create({
        data: {
            artistId: artist.id,
            rgMbid: `${PREFIX}-${tag}-mbid`,
            title: `${PREFIX}-${tag}-album`,
            primaryType: "Album",
            location,
        },
    });
    const track = await prisma.track.create({
        data: {
            albumId: album.id,
            title: `${PREFIX}-${tag}-track`,
            trackNo: 1,
            duration: 100,
            filePath: `/tmp/${PREFIX}-${tag}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
        },
    });
    const playlist = await prisma.playlist.create({
        data: { userId: user.id, name: `${PREFIX}-${tag}-pl` },
    });
    return { track, playlist };
}

describe("playlistService.addTracks across album locations", () => {
    beforeAll(cleanup);
    afterAll(cleanup);

    it("adds a track from a DISCOVER album", async () => {
        const { track, playlist } = await fixture("DISCOVER");

        const result = await addTracks(playlist.id, [track.id]);

        expect(result).toMatchObject({ added: 1, duplicates: 0, rejected: [] });
        const rows = await prisma.playlistItem.findMany({
            where: { playlistId: playlist.id },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].trackId).toBe(track.id);
        expect(rows[0].rank).toBeTruthy();
    });

    it("adds a track from a LIBRARY album", async () => {
        const { track, playlist } = await fixture("LIBRARY");

        const result = await addTracks(playlist.id, [track.id]);

        expect(result).toMatchObject({ added: 1, duplicates: 0, rejected: [] });
    });

    it("rejects only ids that match no track at all", async () => {
        const { playlist } = await fixture("LIBRARY");

        const result = await addTracks(playlist.id, ["nonexistent-track-id"]);

        expect(result).toMatchObject({
            added: 0,
            duplicates: 0,
            rejected: ["nonexistent-track-id"],
        });
    });
});
