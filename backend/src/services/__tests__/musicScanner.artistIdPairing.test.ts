/**
 * The scanner pairs the artist name it files an album under with that same
 * tag's MusicBrainz id: an album artist with the album-artist id, never the
 * track artist's. Real scanner, temp directory and test database.
 */

jest.mock("../../utils/logger", () => require("./helpers/scannerMocks").loggerMock());
jest.mock("../../services/featureDetection", () => require("./helpers/scannerMocks").featureDetectionMock());
jest.mock("../../services/acoustidService", () => require("./helpers/scannerMocks").acoustidServiceMock());
jest.mock("../../services/fpcalc", () => require("./helpers/scannerMocks").fpcalcMock());
jest.mock("../../services/coverArtExtractor", () => require("./helpers/scannerMocks").coverArtExtractorMock());
jest.mock("../../services/artwork", () => require("./helpers/scannerMocks").artworkMock());
jest.mock("../../services/artistCountsService", () => require("./helpers/scannerMocks").artistCountsServiceMock());
jest.mock("../../services/imageStorage", () => require("./helpers/scannerMocks").imageStorageMock());

import fs from "fs";
import os from "os";
import path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../../utils/db";
import { MusicScannerService } from "../musicScanner";

jest.setTimeout(60_000);

const ALEXIS = "8a2f9b1e-0000-4000-8000-000000000001";
const SAM_COOKE = "8a2f9b1e-0000-4000-8000-000000000002";
const NORTHLANE = "8a2f9b1e-0000-4000-8000-000000000003";
const IN_HEARTS_WAKE = "8a2f9b1e-0000-4000-8000-000000000004";
const NAMES = ["Pairing Alexis", "Pairing Northlane, Pairing IHW", "Pairing Northlane", "Pairing Solo"];

let musicDir: string;

function place(rel: string, common: Record<string, unknown>) {
    const file = path.join(musicDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "dummy audio bytes");
    return [file, { common: { track: { no: 1 }, disk: { no: 1 }, ...common }, format: { duration: 200, codec: "flac" }, native: {} }] as const;
}

async function wipe() {
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE "filePath" LIKE 'Pairing%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE title LIKE 'Pairing%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name = ANY($1::text[])`, NAMES);
}

beforeEach(async () => {
    await wipe();
    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-"));
});

afterEach(() => fs.rmSync(musicDir, { recursive: true, force: true }));

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

async function scan(entries: Array<readonly [string, unknown]>) {
    const byFile = new Map(entries);
    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockImplementation(async (file: string) => byFile.get(file));
    await new MusicScannerService().scanLibrary(musicDir);
}

describe("which MusicBrainz id an artist is filed with", () => {
    it("takes the album artist's id for an album artist, not the track artist's", async () => {
        await scan([
            place("Pairing Alexis/Album/01.flac", {
                title: "Bring It On Home", album: "Pairing Album A",
                albumartist: "Pairing Alexis", musicbrainz_albumartistid: [ALEXIS],
                artist: "Sam Cooke", musicbrainz_artistid: [SAM_COOKE],
            }),
        ]);
        const artist = await prisma.artist.findFirst({ where: { name: "Pairing Alexis" } });
        expect(artist?.mbid).toBe(ALEXIS);
    });

    it("files a joint name tagged with each member's id under its first member and that member's id, never the joint name", async () => {
        await scan([
            place("Pairing Joint/Album/01.flac", {
                title: "Song", album: "Pairing Album B",
                albumartist: "Pairing Northlane, Pairing IHW", musicbrainz_albumartistid: [NORTHLANE, IN_HEARTS_WAKE],
            }),
        ]);
        expect(await prisma.artist.findFirst({ where: { name: "Pairing Northlane, Pairing IHW" } })).toBeNull();
        expect((await prisma.artist.findFirst({ where: { name: "Pairing Northlane" } }))?.mbid).toBe(NORTHLANE);
    });

    it("takes the track artist's own id when there is no album artist", async () => {
        await scan([
            place("Pairing Solo/Album/01.flac", {
                title: "Song", album: "Pairing Album C",
                artist: "Pairing Solo", musicbrainz_artistid: [SAM_COOKE],
            }),
        ]);
        const artist = await prisma.artist.findFirst({ where: { name: "Pairing Solo" } });
        expect(artist?.mbid).toBe(SAM_COOKE);
    });

    it("drops an ISRC tag that is not an ISRC", async () => {
        await scan([
            place("Pairing Solo/Album/02.flac", {
                title: "Song 2", album: "Pairing Album C", artist: "Pairing Solo", isrc: ["PMEDIA"],
            }),
        ]);
        const track = await prisma.track.findFirst({ where: { filePath: path.join("Pairing Solo", "Album", "02.flac") } });
        expect(track).not.toBeNull();
        expect(track?.isrc).toBeNull();
    });
});
