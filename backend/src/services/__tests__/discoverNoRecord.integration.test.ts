/**
 * An album is Discover's only on Kima's own Discover records, and Discover never deletes files without one: Lidarr's tag
 * marks an artist, and a listener can add their own album to a tagged artist. Real test database and the recorded
 * Lidarr (discover-sort.json); where a test needs Lidarr to hold "Out of It" too, the recorded list is edited and the
 * sweep's calls about it are synthesised from the recorded records, marked in the code.
 */
jest.mock("../../utils/logger", () => require("./helpers/scannerMocks").loggerMock());
jest.mock("../artistCountsService", () => ({ ...jest.requireActual("../artistCountsService"), updateArtistCounts: jest.fn().mockResolvedValue(undefined) }));

import { prisma } from "../../utils/db";
import { invalidateSystemSettingsCache } from "../../utils/systemSettings";
import { loadScenario, startLidarrReplay, type LidarrReplay, type LidarrScenario } from "../../__tests__/helpers/lidarrReplay";
import { useLidarr } from "../../__tests__/helpers/lidarrSettings";
import { sortDiscoverAlbums } from "../discovery/sortDiscoverAlbums";
import { clearOrphanedDiscoverAlbums } from "../discovery/discoverClearing";
import { artistIdentityKey } from "../artistIdentity";
import { discoverWeeklyService } from "../discoverWeekly";

jest.setTimeout(120_000);

const P = "cs_";
const USER = `${P}user`;
const BRAD = { name: "Brad Sucks", mbid: "9c070e4f-28c1-4b98-b371-d8514c31ba55" };
const OUT_OF_IT_RG = "16f30346-886a-3144-9377-cbfceb32fd34"; // Lidarr's id for "Out of It"
const ART = `${P}art_brad`;

let lidarr: LidarrReplay;

/** The recorded scenario with Lidarr also holding Out of It's files (an album the listener added in Lidarr's own UI). */
function scenarioHoldingOutOfIt(): LidarrScenario {
    const s: LidarrScenario = JSON.parse(JSON.stringify(loadScenario("discover-sort")));
    const list = s.exchanges.find((e) => e.path === "/api/v1/album?artistId=65")!;
    const ooi = (list.response as any[]).find((a) => a.foreignAlbumId === OUT_OF_IT_RG);
    ooi.statistics.trackFileCount = 11; // EDITED from the recording (0)
    const artist = (s.exchanges.find((e) => e.path === "/api/v1/artist")!.response as any[])[0];
    // SYNTHESISED from the recorded records: what the sweep asks Lidarr about this album.
    s.exchanges.push(
        { seq: 1000, at: "", method: "GET", path: `/api/v1/album?foreignAlbumId=${OUT_OF_IT_RG}`, request: null, status: 200, response: [ooi] },
        { seq: 1001, at: "", method: "GET", path: `/api/v1/album/${ooi.id}`, request: null, status: 200, response: ooi },
        { seq: 1002, at: "", method: "GET", path: `/api/v1/artist/${artist.id}`, request: null, status: 200, response: artist },
        { seq: 1003, at: "", method: "DELETE", path: `/api/v1/album/${ooi.id}?deleteFiles=true&addImportListExclusion=false`, request: null, status: 200, response: {} },
    );
    return s;
}

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.discoveryAlbum.deleteMany({ where: { userId: USER } });
    await prisma.ownedAlbum.deleteMany({ where: { artistId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: USER } });
}

async function artist(id = ART, name = BRAD.name, mbid: string | null = BRAD.mbid) {
    await prisma.artist.create({ data: { id, name, normalizedName: name.toLowerCase(), identityKey: artistIdentityKey(name) ?? id, mbid } });
    return id;
}
async function album(key: string, artistId: string, title: string, rgMbid: string, location: "LIBRARY" | "DISCOVER", ownedAs?: string) {
    await prisma.album.create({ data: { id: `${P}alb_${key}`, rgMbid, artistId, identityKey: `${P}ik_${key}`, title, primaryType: "Album", location } });
    await prisma.track.create({
        data: { id: `${P}trk_${key}`, albumId: `${P}alb_${key}`, title: "t", trackNo: 1, duration: 100, filePath: `${P}nowhere/${key}.mp3`, fileModified: new Date(), fileSize: 1 },
    });
    if (ownedAs) await prisma.ownedAlbum.create({ data: { artistId, rgMbid, source: ownedAs } });
}
const loc = async (key: string) => (await prisma.album.findUniqueOrThrow({ where: { id: `${P}alb_${key}` } })).location;

beforeEach(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    await prisma.systemSettings.upsert({ where: { id: "default" }, create: { id: "default" }, update: {} });
    await prisma.systemSettings.update({ where: { id: "default" }, data: { discoverAlbumsSortedAt: null } });
    invalidateSystemSettingsCache();
});
afterEach(async () => {
    await lidarr?.close();
});
afterAll(async () => {
    await cleanup();
    await prisma.systemSettings.update({ where: { id: "default" }, data: { discoverAlbumsSortedAt: null, lidarrEnabled: false } });
    await prisma.$disconnect();
});

describe("an album the listener added in Lidarr's own interface under a Discover-tagged artist", () => {
    it("stays in the library through the upgrade sort, and the weekly sweep never asks Lidarr to delete it", async () => {
        lidarr = await startLidarrReplay(scenarioHoldingOutOfIt());
        await useLidarr(lidarr.url);
        const a = await artist();
        // The listener's only Brad Sucks album: identified, scanned, no plays yet, and no Discover record of any kind.
        await album("ooi", a, "Out of It", OUT_OF_IT_RG, "LIBRARY", "native_scan");

        await sortDiscoverAlbums();
        expect(await loc("ooi")).toBe("LIBRARY");

        await clearOrphanedDiscoverAlbums();
        expect(lidarr.asked.filter((q) => q.method === "DELETE")).toEqual([]);
    });

    it("already filed as Discover with no Discover record goes back to the library, its files untouched", async () => {
        lidarr = await startLidarrReplay(scenarioHoldingOutOfIt());
        await useLidarr(lidarr.url);
        const a = await artist();
        await album("ooi", a, "Out of It", OUT_OF_IT_RG, "DISCOVER");

        const swept = await clearOrphanedDiscoverAlbums();
        expect(swept).toMatchObject({ cleared: 0, returned: 1, failures: [] });
        expect(await loc("ooi")).toBe("LIBRARY");
        expect(await prisma.ownedAlbum.count({ where: { artistId: a, rgMbid: OUT_OF_IT_RG, source: "native_scan" } })).toBe(1);
        expect(lidarr.asked.filter((q) => q.method === "DELETE")).toEqual([]);
    });
});

describe("albums the upgrade sort returns to the library", () => {
    it("get the ownership row every library album has", async () => {
        lidarr = await startLidarrReplay(loadScenario("discover-sort"));
        await useLidarr(lidarr.url);
        const a = await artist(`${P}art_x`, "Cs Plain Artist", null);
        // Filed as Discover by 1.11's scanner, which marked only the albums it filed in the library; nothing says Discover.
        await album("wrong", a, "Cs Own Record", `${P}rg_wrong`, "DISCOVER");
        const r = await sortDiscoverAlbums();
        expect(r?.toLibrary).toBe(1);
        expect(await loc("wrong")).toBe("LIBRARY");
        expect(await prisma.ownedAlbum.count({ where: { artistId: a, rgMbid: `${P}rg_wrong` } })).toBe(1);
    });
});

describe("Discover's artist check", () => {
    it("does not count an artist whose only albums are Discover's as in the library", async () => {
        const a = await artist(`${P}art_z`, "Cs Discover Only", null);
        await album("donly", a, "Cs D Album", `${P}rg_donly`, "DISCOVER");
        const inLibrary = await (discoverWeeklyService as any).isArtistInLibrary("Cs Discover Only", undefined);
        expect(inLibrary).toBe(false);
    });
});
