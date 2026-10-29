/**
 * Refreshing an import's matches finds songs by artists whose names carry
 * punctuation: the candidates are looked up by the same normal form the
 * library stores ("Simon & Garfunkel" is kept as "simon and garfunkel").
 * Real database and Redis.
 */
import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { spotifyImportService } from "../spotifyImport";
import { eventBus, type SSEEvent } from "../eventBus";
import { normalizeArtistName } from "../artistIdentity";
import { artistWithTracks, removeImportRows } from "./helpers/spotifyImportRows";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

const P = "sprefresh";
const JOB = `${P}job`;

const cleanup = () => removeImportRows(P);
const artistWithTrack = (key: string, name: string, title: string) =>
    artistWithTracks(P, key, name, [title], normalizeArtistName(name));

const pending = (artist: string, title: string, album: string) => ({
    artist, title, album, albumMbid: null, artistMbid: null, preMatchedTrackId: null, isrc: null,
});

beforeAll(async () => {
    await waitForRedisReady();
    await redisClient.del(`import:job:${JOB}`);
    await cleanup();
    await artistWithTrack("sg", "Simon & Garfunkel", "The Boxer");
    await artistWithTrack("acdc", "AC/DC", "Thunderstruck");
    await prisma.user.create({ data: { id: `${P}usr`, username: `${P}-user`, passwordHash: "x" } });
    await prisma.playlist.create({ data: { id: `${P}pl`, userId: `${P}usr`, name: "Imported" } });
    await prisma.spotifyImportJob.create({
        data: {
            id: JOB, userId: `${P}usr`, spotifyPlaylistId: "37i9dQZF1DWXRqgorJj26U", playlistName: "Rock Classics",
            status: "completed", albumsTotal: 2, tracksTotal: 2, createdPlaylistId: `${P}pl`,
            pendingTracks: [
                pending("Simon & Garfunkel", "The Boxer", "Bridge over Troubled Water"),
                pending("AC/DC", "Thunderstruck", "The Razors Edge"),
            ],
        },
    });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

it("adds songs by artists whose names carry an ampersand or a slash, and tells the owner's devices", async () => {
    const heard: SSEEvent[] = [];
    const stop = eventBus.subscribe(`${P}usr`, { send: (event) => (heard.push(event), true) });
    const result = await spotifyImportService.refreshJobMatches(JOB).finally(stop);
    expect(result.added).toBe(2);
    expect(heard.filter((e) => e.type === "playlist:updated").map((e) => e.payload)).toEqual([{ playlistId: `${P}pl`, deleted: false }]);
    const items = await prisma.playlistItem.findMany({ where: { playlistId: `${P}pl` }, include: { track: true } });
    expect(items.map((i) => i.track.title).sort()).toEqual(["The Boxer", "Thunderstruck"]);
});

it("tells nobody when a later refresh adds nothing", async () => {
    const heard: SSEEvent[] = [];
    const stop = eventBus.subscribe(`${P}usr`, { send: (event) => (heard.push(event), true) });
    const result = await spotifyImportService.refreshJobMatches(JOB).finally(stop);
    expect(result.added).toBe(0);
    expect(heard.filter((e) => e.type === "playlist:updated")).toEqual([]);
});
