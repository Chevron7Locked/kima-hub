/**
 * When a scan brings in songs a Spotify import was waiting for, they join the
 * playlist by the same matching the import used: a multi-word artist with many
 * tracks is searched whole, and a short title never matches another artist.
 */
jest.mock("../notificationService", () => ({
    notificationService: { create: jest.fn() },
}));

import { prisma } from "../../utils/db";
import { spotifyImportService } from "../spotifyImport";
import { eventBus, type SSEEvent } from "../eventBus";
import { artistWithTracks as addArtistWithTracks, removeImportRows } from "./helpers/spotifyImportRows";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const heard: SSEEvent[] = [];
const P = "sprec";

const cleanup = () => removeImportRows(P);
const artistWithTracks = (key: string, name: string, titles: string[]) =>
    addArtistWithTracks(P, key, name, titles, name.toLowerCase());

beforeAll(async () => {
    await cleanup();
    const filler = Array.from({ length: 60 }, (_, i) => `Album Cut ${i + 1}`);
    await artistWithTracks("a", "The Beatles", [...filler, "Let It Be"]);
    await artistWithTracks("b", "Other Band", ["Intro"]);
    await prisma.user.create({ data: { id: `${P}usr`, username: `${P}-user`, passwordHash: "x" } });
    await prisma.playlist.create({ data: { id: `${P}pl`, userId: `${P}usr`, name: "Imported" } });
    await prisma.playlistPendingTrack.createMany({
        data: [
            { playlistId: `${P}pl`, spotifyArtist: "The Beatles", spotifyTitle: "Let It Be", spotifyAlbum: "Let It Be", sort: 0, rank: "a" },
            { playlistId: `${P}pl`, spotifyArtist: "Someone Else", spotifyTitle: "Intro", spotifyAlbum: "Debut", sort: 1, rank: "b" },
        ],
    });
    const stop = eventBus.subscribe(`${P}usr`, { send: (event) => (heard.push(event), true) });
    await spotifyImportService.reconcilePendingTracks().finally(stop);
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
    await prisma.$disconnect();
});

describe("reconciling pending Spotify tracks", () => {
    it("tells the owner's devices the playlist gained songs", () => {
        expect(heard.filter((e) => e.type === "playlist:updated").map((e) => e.payload)).toEqual([{ playlistId: `${P}pl`, deleted: false }]);
    });

    it("finds a song by a multi-word artist who has many other tracks", async () => {
        const items = await prisma.playlistItem.findMany({ where: { playlistId: `${P}pl` }, include: { track: true } });
        expect(items.map((i) => i.track.title)).toContain("Let It Be");
    });

    it("does not give a short title to a different artist, and keeps it waiting", async () => {
        const items = await prisma.playlistItem.findMany({ where: { playlistId: `${P}pl` } });
        expect(items.map((i) => i.trackId)).not.toContain(`${P}bt0`);
        const pending = await prisma.playlistPendingTrack.findMany({ where: { playlistId: `${P}pl` } });
        expect(pending.map((p) => p.spotifyTitle)).toEqual(["Intro"]);
    });

    it("tells nobody when a later pass finds nothing new", async () => {
        const again: SSEEvent[] = [];
        const stop = eventBus.subscribe(`${P}usr`, { send: (event) => (again.push(event), true) });
        await spotifyImportService.reconcilePendingTracks().finally(stop);
        expect(again.filter((e) => e.type === "playlist:updated")).toEqual([]);
    });

    it("reconciling one playlist leaves every other playlist's pending songs alone", async () => {
        await prisma.user.create({ data: { id: `${P}usr2`, username: `${P}-user2`, passwordHash: "x" } });
        await prisma.playlist.create({ data: { id: `${P}pl2`, userId: `${P}usr2`, name: "Someone else's" } });
        await prisma.playlistPendingTrack.create({
            data: { playlistId: `${P}pl2`, spotifyArtist: "The Beatles", spotifyTitle: "Let It Be", spotifyAlbum: "Let It Be", sort: 0, rank: "a" },
        });

        await spotifyImportService.reconcilePendingTracks(`${P}pl`);
        expect(await prisma.playlistItem.count({ where: { playlistId: `${P}pl2` } })).toBe(0);
        expect(await prisma.playlistPendingTrack.count({ where: { playlistId: `${P}pl2` } })).toBe(1);

        await spotifyImportService.reconcilePendingTracks(`${P}pl2`);
        expect(await prisma.playlistItem.count({ where: { playlistId: `${P}pl2` } })).toBe(1);
    });
});
