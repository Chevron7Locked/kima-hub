/**
 * Which artist an album is filed under. A tag naming several artists names the first (an ID3 frame's values are
 * NUL-separated, each may start with a byte-order mark), paired with that tag's id by position. One album is one
 * artist: the songs of an album folder (disc subfolders included) under one album tag vote with their album artist
 * (their track artist when they have none), and the most common one wins when it covers every song, or more than one
 * song and a quarter of them. With no leader each song keeps its own artist, unless the album is tagged a compilation:
 * then it is Various Artists. Songs with no album tag do not vote.
 * Real scanner, temp directory and test database.
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

const FIRST_ID = "9b3e0c1a-0000-4000-8000-000000000001";
const SECOND_ID = "9b3e0c1a-0000-4000-8000-000000000002";

let musicDir: string;
let tags: Map<string, unknown>;

function place(rel: string, common: Record<string, unknown>, mtime?: Date) {
    const file = path.join(musicDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "dummy audio bytes");
    if (mtime) fs.utimesSync(file, mtime, mtime);
    tags.set(file, { common: { track: { no: 1 }, disk: { no: 1 }, ...common }, format: { duration: 200, codec: "flac" }, native: {} });
}

async function wipe() {
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE "filePath" LIKE 'Vote%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE title LIKE 'Vote%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name LIKE 'Vote%' OR name = 'Various Artists'`);
}

beforeEach(async () => {
    await wipe();
    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "vote-"));
    tags = new Map();
    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockImplementation(async (file: string) => tags.get(file));
});

afterEach(() => fs.rmSync(musicDir, { recursive: true, force: true }));

afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

const scan = () => new MusicScannerService().scanLibrary(musicDir);

async function albumsOf(title: string) {
    const rows = await prisma.album.findMany({
        where: { title },
        select: { artist: { select: { name: true, mbid: true } }, _count: { select: { tracks: true } } },
    });
    return rows.map((r) => ({ artist: r.artist.name, mbid: r.artist.mbid, songs: r._count.tracks }));
}

describe("a tag that names several artists", () => {
    it("files under the first of a frame's NUL-separated values, without the byte-order mark", async () => {
        for (const n of [1, 2, 3]) {
            place(`Vote Glue/Vote Glued Album/0${n}.mp3`, {
                title: `Song ${n}`, album: "Vote Glued Album",
                albumartist: "Vote First\u0000﻿Vote Second", artist: "Vote Second",
            });
        }
        await scan();
        expect(await albumsOf("Vote Glued Album")).toEqual([{ artist: "Vote First", mbid: null, songs: 3 }]);
        expect(await prisma.artist.count({ where: { name: { contains: "﻿" } } })).toBe(0);
    });

    it("counts a featured credit inside a name when pairing ids", async () => {
        place("Vote Feat/Vote Feat Album/01.flac", {
            title: "Song", album: "Vote Feat Album",
            albumartist: "Vote First feat. Vote Guest", albumartists: ["Vote First feat. Vote Guest", "Vote Second"],
            musicbrainz_albumartistid: [FIRST_ID, "9b3e0c1a-0000-4000-8000-000000000003", SECOND_ID],
        });
        await scan();
        expect(await albumsOf("Vote Feat Album")).toEqual([{ artist: "Vote First", mbid: FIRST_ID, songs: 1 }]);
    });

    it("pairs a multi-valued album artist with that tag's ids by position", async () => {
        place("Vote Pair/Vote Paired Album/01.flac", {
            title: "Song", album: "Vote Paired Album",
            albumartist: "Vote First & Vote Second", albumartists: ["Vote First", "Vote Second"],
            musicbrainz_albumartistid: [FIRST_ID, SECOND_ID],
        });
        await scan();
        expect(await albumsOf("Vote Paired Album")).toEqual([{ artist: "Vote First", mbid: FIRST_ID, songs: 1 }]);
    });
});

describe("one album, one artist", () => {
    it("keeps a song whose album artist differs on its album, under the album's artist", async () => {
        for (const n of [1, 2, 3]) {
            place(`Vote Mike/Vote History (1995)/Disc 2/0${n}.flac`, { title: `Song ${n}`, album: "Vote History", albumartist: "Vote Mike" });
        }
        place("Vote Mike/Vote History (1995)/Disc 2/04.flac", { title: "Scream", album: "Vote History", albumartist: "Vote Janet" });
        await scan();
        expect(await albumsOf("Vote History")).toEqual([{ artist: "Vote Mike", mbid: null, songs: 4 }]);
        expect(await prisma.artist.count({ where: { name: "Vote Janet" } })).toBe(0);
    });

    it("counts every disc folder of an album together", async () => {
        place("Vote Band/Vote Double/CD 1/01.flac", { title: "A", album: "Vote Double", albumartist: "Vote Band" });
        place("Vote Band/Vote Double/CD 2/01.flac", { title: "B", album: "Vote Double", albumartist: "Vote Band" });
        place("Vote Band/Vote Double/CD 2/02.flac", { title: "C", album: "Vote Double", albumartist: "Vote Guest" });
        await scan();
        expect(await albumsOf("Vote Double")).toEqual([{ artist: "Vote Band", mbid: null, songs: 3 }]);
    });

    it("takes the winner's MusicBrainz id from the songs that named it", async () => {
        place("Vote Ided/Vote Ided Album/01.flac", { title: "A", album: "Vote Ided Album", albumartist: "Vote Ided", musicbrainz_albumartistid: [FIRST_ID] });
        place("Vote Ided/Vote Ided Album/02.flac", { title: "B", album: "Vote Ided Album", albumartist: "Vote Ided", musicbrainz_albumartistid: [FIRST_ID] });
        place("Vote Ided/Vote Ided Album/03.flac", { title: "C", album: "Vote Ided Album", albumartist: "Vote Other", musicbrainz_albumartistid: [SECOND_ID] });
        await scan();
        expect(await albumsOf("Vote Ided Album")).toEqual([{ artist: "Vote Ided", mbid: FIRST_ID, songs: 3 }]);
    });

    it("leaves each song of an album no artist leads under its own artist, unless it is a compilation", async () => {
        ["Vote One", "Vote Two", "Vote Three"].forEach((artist, i) =>
            place(`Vote Mix/Vote Mixtape/0${i}.flac`, { title: `Song ${i}`, album: "Vote Mixtape", artist }),
        );
        ["Vote One", "Vote Two", "Vote Three"].forEach((artist, i) =>
            place(`Vote Mix/Vote Flagged Mixtape/0${i}.flac`, { title: `Song ${i}`, album: "Vote Flagged Mixtape", artist, compilation: true }),
        );
        await scan();
        const own = await albumsOf("Vote Mixtape");
        expect(own.map((a) => a.artist).sort()).toEqual(["Vote One", "Vote Three", "Vote Two"]);
        expect(await albumsOf("Vote Flagged Mixtape")).toEqual([{ artist: "Various Artists", mbid: null, songs: 3 }]);
    });

    it("leaves loose songs with no album tag, and same-titled albums of different artists, to their own artists", async () => {
        place("Vote Loose/a.mp3", { title: "A", artist: "Vote Loose One" });
        place("Vote Loose/b.mp3", { title: "B", artist: "Vote Loose Two" });
        place("Vote Loose/c.mp3", { title: "C", album: "Vote Greatest Hits", albumartist: "Vote Hits One" });
        place("Vote Loose/d.mp3", { title: "D", album: "Vote Greatest Hits", albumartist: "Vote Hits Two" });
        await scan();
        const artists = await prisma.track.findMany({
            where: { filePath: { startsWith: "Vote Loose/" } },
            select: { filePath: true, album: { select: { artist: { select: { name: true } } } } },
            orderBy: { filePath: "asc" },
        });
        expect(artists.map((t) => t.album.artist.name)).toEqual(["Vote Loose One", "Vote Loose Two", "Vote Hits One", "Vote Hits Two"]);
    });

    it("files a compilation with no album artist under Various Artists", async () => {
        ["Vote Lead", "Vote Lead", "Vote Other"].forEach((artist, i) =>
            place(`Vote Comp/Vote Compilation/0${i}.flac`, { title: `Song ${i}`, album: "Vote Compilation", artist, compilation: true }),
        );
        await scan();
        expect(await albumsOf("Vote Compilation")).toEqual([{ artist: "Various Artists", mbid: null, songs: 3 }]);
    });

    it("files a Singles/ song tagged a compilation under its folder's artist", async () => {
        place("Singles/Vote Folder Artist/Vote Single Comp/01.flac", { title: "A", album: "Vote Single Comp", artist: "Vote Folder Artist", compilation: true });
        await scan();
        expect(await albumsOf("Vote Single Comp")).toEqual([{ artist: "Vote Folder Artist", mbid: null, songs: 1 }]);
    });

    it("keeps different albums in one folder apart, each under its own artist", async () => {
        place("Singles/Vote Playlist/01.flac", { title: "A", album: "Vote Single A", artist: "Vote Alpha" });
        place("Singles/Vote Playlist/02.flac", { title: "B", album: "Vote Single B", artist: "Vote Beta" });
        await scan();
        expect(await albumsOf("Vote Single A")).toEqual([{ artist: "Vote Alpha", mbid: null, songs: 1 }]);
        expect(await albumsOf("Vote Single B")).toEqual([{ artist: "Vote Beta", mbid: null, songs: 1 }]);
    });

    it("files a new song by the votes of the album's songs already scanned", async () => {
        const old = new Date(Date.now() - 86_400_000);
        for (const n of [1, 2, 3]) {
            place(`Vote Grow/Vote Growing/0${n}.flac`, { title: `Song ${n}`, album: "Vote Growing", albumartist: "Vote Grow" }, old);
        }
        await scan();
        place("Vote Grow/Vote Growing/04.flac", { title: "Song 4", album: "Vote Growing", albumartist: "Vote Grow Guest" });
        await scan();
        expect(await albumsOf("Vote Growing")).toEqual([{ artist: "Vote Grow", mbid: null, songs: 4 }]);
    });

    it("asks MusicBrainz again about an artist it could not find once that artist gains a song", async () => {
        await prisma.artist.create({
            data: { name: "Vote Unfound", normalizedName: "vote unfound", identityKey: "voteunfound", enrichmentStatus: "unresolvable", enrichmentFailures: 3 },
        });
        place("Vote Unfound/Vote New Album/01.flac", { title: "A", album: "Vote New Album", albumartist: "Vote Unfound" });
        await scan();
        expect(await prisma.artist.findFirst({ where: { name: "Vote Unfound" }, select: { enrichmentStatus: true, enrichmentFailures: true } }))
            .toEqual({ enrichmentStatus: "pending", enrichmentFailures: 0 });
    });
});
