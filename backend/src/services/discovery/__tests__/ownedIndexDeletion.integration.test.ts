/**
 * The owned-album snapshot behind Discover's fuzzy ownership check is rebuilt after an album is deleted: pruned when it
 * holds no songs, or cleared out of Discover. Each test reads the answer once (so the snapshot is cached), deletes through
 * the real writer, and asks again. Real database; no Lidarr set up.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { prisma } from "../../../utils/db";
import { config, useMusicFolder } from "../../../config";
import { discoverySeeding } from "../discoverySeeding";
import { forgetOwnedIndex } from "../ownedIndexVersion";
import { clearDiscoverAlbum } from "../discoverClearing";
import { pruneEmptyAlbumsAndArtists } from "../../libraryPrune";
import { artistIdentityKey } from "../../artistIdentity";
import { useNoLidarr } from "../../../__tests__/helpers/lidarrSettings";
import { closeEngineConnections } from "../../../__tests__/helpers/engineConnections";

jest.setTimeout(60_000);

const P = "zz-oid_";
const NAME = `${P}Stephen Malkmus`;
const TITLE = `${P}Pig Lib`;
const USER = `${P}user`;
const startFolder = config.music.musicPath;
let root: string;

async function wipeRows() {
    await prisma.downloadJob.deleteMany({ where: { userId: USER } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: USER } });
    await prisma.ownedAlbum.deleteMany({ where: { artistId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

const seedArtist = () => prisma.artist.create({ data: { id: `${P}ar`, name: NAME, identityKey: artistIdentityKey(NAME) } });
const seedAlbum = (location: "LIBRARY" | "DISCOVER") =>
    prisma.album.create({
        data: { id: `${P}al`, artistId: `${P}ar`, title: TITLE, identityKey: `${P}al`, rgMbid: `${P}rg`, primaryType: "Album", location },
    });

/** The fuzzy check of isAlbumOwned, under a release id no row knows, so only the cached names can answer. */
const owned = () => discoverySeeding.isAlbumOwned(`${P}other-rg`, USER, NAME, TITLE, null);

beforeAll(async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await wipeRows();
    await useNoLidarr();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x" } });
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kima-oid-"));
    useMusicFolder(root);
});
beforeEach(async () => {
    await wipeRows();
    forgetOwnedIndex();
});
afterAll(async () => {
    useMusicFolder(startFolder);
    fs.rmSync(root, { recursive: true, force: true });
    await wipeRows();
    await prisma.user.deleteMany({ where: { id: USER } });
    await closeEngineConnections();
});

describe("the owned-album check reads a deletion at once, not after the snapshot expires", () => {
    it("stops counting a library album the prune removed for holding no songs", async () => {
        await seedArtist();
        await seedAlbum("LIBRARY");
        expect(await owned()).toBe(true);

        await pruneEmptyAlbumsAndArtists();

        expect(await prisma.album.count({ where: { id: `${P}al` } })).toBe(0);
        expect(await owned()).toBe(false);
    });

    it("stops counting an owned album whose Discover album row was cleared away", async () => {
        await seedArtist();
        await seedAlbum("DISCOVER");
        await prisma.track.create({
            data: { id: `${P}t`, albumId: `${P}al`, title: "T", trackNo: 1, duration: 200, filePath: `${P}/t.flac`, fileModified: new Date(), fileSize: 1 },
        });
        // An owned album takes its title from its album row, so clearing the row is what the answer turns on.
        await prisma.ownedAlbum.create({ data: { artistId: `${P}ar`, rgMbid: `${P}rg`, source: "native_scan" } });
        const batch = await prisma.discoveryBatch.create({ data: { userId: USER, weekStart: new Date(), targetSongCount: 1 } });
        await prisma.downloadJob.create({
            data: {
                userId: USER, subject: `${NAME} ${TITLE}`, type: "album", targetMbid: `${P}rg`, status: "completed",
                discoveryBatchId: batch.id, metadata: { currentSource: "soulseek" },
            },
        });
        expect(await owned()).toBe(true);

        const result = await clearDiscoverAlbum({
            rgMbid: `${P}rg`, artistName: NAME, albumTitle: TITLE, artistMbid: null, lidarrAlbumId: null, suggestionId: null,
        });

        expect(result).toEqual({ cleared: true });
        expect(await prisma.album.count({ where: { id: `${P}al` } })).toBe(0);
        expect(await owned()).toBe(false);
    });
});
