/**
 * After a scan, the artists whose songs or albums it added, changed, flagged missing, brought back or marked corrupt are
 * recounted, the artist a song left included, and no others. Real scanner, temp directory, test database and artist
 * counts; the counts are recomputed in the background, so the test waits for them.
 */

jest.mock("../../utils/logger", () => require("./helpers/scannerMocks").loggerMock());
jest.mock("../../services/featureDetection", () => require("./helpers/scannerMocks").featureDetectionMock());
jest.mock("../../services/acoustidService", () => require("./helpers/scannerMocks").acoustidServiceMock());
jest.mock("../../services/fpcalc", () => require("./helpers/scannerMocks").fpcalcMock());
jest.mock("../../services/coverArtExtractor", () => require("./helpers/scannerMocks").coverArtExtractorMock());
jest.mock("../../services/artwork", () => require("./helpers/scannerMocks").artworkMock());
jest.mock("../../services/imageStorage", () => require("./helpers/scannerMocks").imageStorageMock());

import fs from "fs";
import os from "os";
import path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../../utils/db";
import { MusicScannerService } from "../musicScanner";
import { config } from "../../config";

jest.setTimeout(60_000);

const P = "zz58";
const LONG_AGO = new Date("2001-01-01T00:00:00Z");
const FAR_AHEAD = new Date("2099-01-01T00:00:00Z");
const STALE = 7;

let musicDir: string;

/** One seeded artist with one album, its songs at the given paths, and counts that are wrong until recounted. */
async function seed(
    key: string,
    songs: { file: string; missingSince?: Date; fileModified?: Date }[],
    extraAlbums = 0,
) {
    await prisma.artist.create({
        data: {
            id: `${P}-${key}`, name: `${P} ${key}`, normalizedName: `${P} ${key}`, identityKey: `${P}-${key}-ik`,
            libraryAlbumCount: STALE, totalTrackCount: STALE, countsLastUpdated: LONG_AGO,
        },
    });
    await prisma.album.create({
        data: {
            id: `${P}-${key}-al`, rgMbid: `${P}-${key}-rg`, artistId: `${P}-${key}`, identityKey: `${P}-${key}-ik`, title: `${P} ${key}`,
            primaryType: "Album", location: "LIBRARY",
            tracks: {
                create: songs.map((s, i) => ({
                    id: `${P}-${key}-t${i}`, title: `${P} ${key} ${i}`, trackNo: i + 1, duration: 100, filePath: s.file,
                    fileModified: s.fileModified ?? FAR_AHEAD, fileSize: 1, missingSince: s.missingSince ?? null,
                })),
            },
        },
    });
    for (let n = 0; n < extraAlbums; n++) {
        await prisma.album.create({
            data: {
                id: `${P}-${key}-al${n}`, rgMbid: `${P}-${key}-rg${n}`, artistId: `${P}-${key}`, identityKey: `${P}-${key}-ik${n}`,
                title: `${P} ${key} extra ${n}`, primaryType: "Album", location: "LIBRARY",
                tracks: {
                    create: {
                        id: `${P}-${key}-x${n}`, title: `${P} ${key} x`, trackNo: 1, duration: 100, filePath: `${P}/${key}-x${n}.flac`,
                        fileModified: LONG_AGO, fileSize: 1, missingSince: LONG_AGO,
                    },
                },
            },
        });
    }
}

function putFile(rel: string) {
    const full = path.join(musicDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "dummy audio bytes");
}

/** What the tags of each scanned file say: the file's artist and album, by file name. */
const TAGS: Record<string, { artist: string; album: string }> = {};
function readTags(file: string) {
    const tags = TAGS[path.basename(file)];
    if (!tags) throw new Error(`unreadable ${file}`);
    return {
        common: {
            title: path.basename(file), artist: tags.artist, albumartist: tags.artist, album: tags.album,
            track: { no: 1 }, disk: { no: 1 }, year: 2024, musicbrainz_releasegroupid: `${P}-rg-${tags.album}`,
        },
        format: { duration: 180, codec: "flac" },
        native: {},
    };
}

async function wipe() {
    await prisma.track.deleteMany({ where: { OR: [{ id: { startsWith: P } }, { filePath: { startsWith: P } }] } });
    await prisma.album.deleteMany({ where: { OR: [{ id: { startsWith: P } }, { title: { startsWith: P } }] } });
    await prisma.artist.deleteMany({ where: { OR: [{ id: { startsWith: P } }, { name: { startsWith: P } }] } });
}

beforeEach(async () => {
    await wipe();
    // Flag mode: a vanished file is flagged and nothing is retired, so a scan's only effects are the ones under test.
    jest.spyOn(config, "music", "get").mockReturnValue({ ...config.music, reconcileMode: "flag" });
    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "scancount-"));
    for (const key of Object.keys(TAGS)) delete TAGS[key];
    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockImplementation(async (file: string) => readTags(file));
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(musicDir, { recursive: true, force: true });
});

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

const row = (id: string) => prisma.artist.findUniqueOrThrow({ where: { id } });
const byName = (name: string) => prisma.artist.findFirstOrThrow({ where: { name } });

async function until(done: () => Promise<boolean>) {
    for (let waited = 0; waited < 20_000; waited += 100) {
        if (await done()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("the recount did not finish");
}
const recounted = async (id: string) => (await row(id)).countsLastUpdated!.getTime() > LONG_AGO.getTime();

it("recounts the artists a scan touched, the artist a song left included, and leaves the others' counts alone", async () => {
    // A: a new song. M: a song whose file is gone. R: a flagged song whose file is back. C: a song changed on disk, now
    // credited to N. K: a song changed on disk that cannot be read. U: nothing in the scan touches it.
    await seed("m", [{ file: `${P}/m.flac` }]);
    await seed("r", [{ file: `${P}/r.flac`, missingSince: LONG_AGO }]);
    putFile(`${P}/r.flac`);
    await seed("c", [{ file: `${P}/c.flac`, fileModified: LONG_AGO }], 1);
    putFile(`${P}/c.flac`);
    TAGS["c.flac"] = { artist: `${P} N`, album: `${P} N album` };
    await seed("k", [{ file: `${P}/k.flac`, fileModified: LONG_AGO }]);
    putFile(`${P}/k.flac`);
    await seed("u", [{ file: `${P}/u.flac` }]);
    putFile(`${P}/u.flac`);
    // G: flagged missing by an earlier scan and still gone, so no count moves.
    await seed("g", [{ file: `${P}/g.flac`, missingSince: LONG_AGO }]);
    putFile(`${P}/a.flac`);
    TAGS["a.flac"] = { artist: `${P} A`, album: `${P} A album` };

    const result = await new MusicScannerService().scanLibrary(musicDir);
    expect(result.tracksAdded).toBe(1);
    expect(result.tracksUpdated).toBe(1);
    expect(result.tracksCorrupt).toBe(1);

    const newArtists = [`${P} A`, `${P} N`];
    await until(async () => {
        const found = await prisma.artist.findMany({ where: { name: { in: newArtists } } });
        return found.length === 2
            && found.every((a) => a.countsLastUpdated)
            && (await Promise.all(["m", "r", "c", "k"].map((k) => recounted(`${P}-${k}`)))).every(Boolean);
    });

    expect((await byName(`${P} A`)).libraryAlbumCount).toBe(1);
    expect((await byName(`${P} A`)).totalTrackCount).toBe(1);
    expect((await byName(`${P} N`)).totalTrackCount).toBe(1);
    // Flagged missing: nothing of M plays now.
    expect(await row(`${P}-m`)).toMatchObject({ libraryAlbumCount: 0, totalTrackCount: 0 });
    // Back: R's song plays again.
    expect(await row(`${P}-r`)).toMatchObject({ libraryAlbumCount: 1, totalTrackCount: 1 });
    // C's song went to N, so C counts nothing.
    expect(await row(`${P}-c`)).toMatchObject({ libraryAlbumCount: 0, totalTrackCount: 0 });
    // K's song could not be read, so it is flagged corrupt and no longer plays.
    expect(await row(`${P}-k`)).toMatchObject({ libraryAlbumCount: 0, totalTrackCount: 0 });
    // U was not touched: its counts are as they were, wrong as they are.
    expect(await row(`${P}-u`)).toMatchObject({ libraryAlbumCount: STALE, totalTrackCount: STALE, countsLastUpdated: LONG_AGO });
    expect(await row(`${P}-g`)).toMatchObject({ libraryAlbumCount: STALE, totalTrackCount: STALE, countsLastUpdated: LONG_AGO });
});
