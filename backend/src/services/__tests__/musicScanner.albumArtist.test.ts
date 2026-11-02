/**
 * Which artist an album is filed under, by the real scanner on a temp directory and test database. A tag naming several
 * artists names the first, paired with that tag's id by position. One album is one artist: the most common album artist
 * wins when it covers every song, or more than one and a quarter of them; otherwise each song keeps its own, except a
 * compilation (Various Artists). Songs with no album tag do not vote.
 */

jest.mock("../../utils/logger", () => require("./helpers/scannerMocks").loggerMock());
jest.mock("../../services/featureDetection", () => require("./helpers/scannerMocks").featureDetectionMock());
jest.mock("../../services/acoustidService", () => require("./helpers/scannerMocks").acoustidServiceMock());
jest.mock("../../services/fpcalc", () => require("./helpers/scannerMocks").fpcalcMock());
jest.mock("../../services/coverArtExtractor", () => require("./helpers/scannerMocks").coverArtExtractorMock());
jest.mock("../../services/artwork", () => require("./helpers/scannerMocks").artworkMock());
jest.mock("../../services/artistCountsService", () => require("./helpers/scannerMocks").artistCountsServiceMock());
jest.mock("../../services/imageStorage", () => require("./helpers/scannerMocks").imageStorageMock());
// Not about joint credits: MusicBrainz does not answer that question here, so such names stay whole.
jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: { searchArtist: async () => ({ kind: "transient", error: { code: "test", message: "unreachable" } }) },
}));

import fs from "fs";
import os from "os";
import path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../../utils/db";
import { MusicScannerService, slimMetadata } from "../musicScanner";
import { albumIdentityKey } from "../albumIdentity";

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
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name = 'Unknown Artist' AND NOT EXISTS (SELECT 1 FROM "Album" WHERE "artistId" = "Artist".id)`);
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

    it("files a joint credit tagged with one id per credited artist under its first artist and id", async () => {
        place("Vote Joint/Vote Joint Album/01.flac", {
            title: "Song", album: "Vote Joint Album",
            albumartist: "Vote First & Vote Second", musicbrainz_albumartistid: [FIRST_ID, SECOND_ID],
        });
        place("Vote Band/Vote Band Album/01.flac", {
            title: "Song", album: "Vote Band Album", albumartist: "Vote Simon & Vote Garfunkel", musicbrainz_albumartistid: ["9b3e0c1a-0000-4000-8000-000000000009"],
        });
        await scan();
        expect(await albumsOf("Vote Joint Album")).toEqual([{ artist: "Vote First", mbid: FIRST_ID, songs: 1 }]);
        // One id: a band whose name holds an "&", kept whole.
        expect((await albumsOf("Vote Band Album"))[0].artist).toBe("Vote Simon & Vote Garfunkel");
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

    it("keeps a new song of an album under its lead artist when its files name a joint credit with no id", async () => {
        const old = new Date(Date.now() - 86_400_000);
        const lead = await prisma.artist.create({ data: { name: "Vote Lead", normalizedName: "vote lead", identityKey: "votelead", mbid: FIRST_ID } });
        const duet = await prisma.album.create({
            data: { artistId: lead.id, title: "Vote Duet", identityKey: albumIdentityKey("Vote Duet"), rgMbid: "temp-vote-duet", primaryType: "Album", location: "LIBRARY" },
        });
        place("Vote Lead/Vote Duet/01.flac", { title: "Song 1", album: "Vote Duet", albumartist: "Vote Lead & Vote Guest" }, old);
        await prisma.track.create({
            data: { albumId: duet.id, title: "Song 1", trackNo: 1, duration: 200, filePath: "Vote Lead/Vote Duet/01.flac", fileModified: new Date(), fileSize: 17 },
        });
        place("Vote Lead/Vote Duet/02.flac", { title: "Song 2", album: "Vote Duet", albumartist: "Vote Lead & Vote Guest" });

        await scan();

        expect(await albumsOf("Vote Duet")).toEqual([{ artist: "Vote Lead", mbid: FIRST_ID, songs: 2 }]);
        expect(await prisma.artist.count({ where: { name: "Vote Lead & Vote Guest" } })).toBe(0);
    });

    it("files a joint-credit song of a same-titled album in another folder under its own artist, not the lead's", async () => {
        const old = new Date(Date.now() - 86_400_000);
        const lead = await prisma.artist.create({ data: { name: "Vote Bob", normalizedName: "vote bob", identityKey: "votebob", mbid: FIRST_ID } });
        const live = await prisma.album.create({
            data: { artistId: lead.id, title: "Vote Live", identityKey: albumIdentityKey("Vote Live"), rgMbid: "temp-vote-live", primaryType: "Album", location: "LIBRARY" },
        });
        place("Vote Bob/Vote Live/01.flac", { title: "Song 1", album: "Vote Live", albumartist: "Vote Bob" }, old);
        await prisma.track.create({ data: { albumId: live.id, title: "Song 1", trackNo: 1, duration: 200, filePath: "Vote Bob/Vote Live/01.flac", fileModified: new Date(), fileSize: 17 } });
        place("Vote Bob and Vote Wailers/Vote Live/01.flac", { title: "Song 2", album: "Vote Live", albumartist: "Vote Bob & Vote Wailers" });

        await scan();

        expect((await albumsOf("Vote Live")).map((a) => a.artist).sort()).toEqual(["Vote Bob", "Vote Bob & Vote Wailers"]);
    });

    it("treats a parenthesised featured credit as the same artist when deciding a compilation", async () => {
        place("Vote Feat/Vote Feat Album/01.flac", { title: "S1", album: "Vote Feat Album", artist: "Vote Singer", compilation: true });
        place("Vote Feat/Vote Feat Album/02.flac", { title: "S2", album: "Vote Feat Album", artist: "Vote Singer (feat. Vote Guest)", compilation: true });
        place("Vote Feat/Vote Feat Album/03.flac", { title: "S3", album: "Vote Feat Album", artist: "Vote Singer", compilation: true });
        await scan();
        expect((await albumsOf("Vote Feat Album")).map((a) => a.artist)).not.toContain("Various Artists");
    });

    it("keeps only what filing needs of a changed song's tags: no quality report, only lyrics among the native tags", () => {
        const full = {
            common: { title: "T", track: { no: 1 }, disk: { no: 1 }, lyrics: [{ text: "la" }] },
            format: { duration: 200, codec: "flac", bitrate: 900, sampleRate: 44100 },
            quality: { warnings: [{ message: "x".repeat(1000) }] },
            native: { vorbis: [{ id: "TITLE", value: "T" }, { id: "LYRICS", value: "words" }, { id: "COMMENT", value: "big" }] },
        };
        const slim = slimMetadata(full as never);
        expect(slim).toEqual({
            common: full.common,
            format: { duration: 200, codec: "flac" },
            native: { vorbis: [{ id: "LYRICS", value: "words" }] },
        });
        expect("quality" in slim).toBe(false);
    });

    it("keeps a one-artist album with a stray compilation flag and no album artist under its artist", async () => {
        for (const n of [1, 2, 3]) place(`Vote Solo/Vote Solo Album/0${n}.flac`, { title: `Song ${n}`, album: "Vote Solo Album", artist: "Vote Solo", compilation: true });
        await scan();
        expect(await albumsOf("Vote Solo Album")).toEqual([{ artist: "Vote Solo", mbid: null, songs: 3 }]);
    });

    it("leaves the placeholder artists Unknown Artist and Various Artists as MusicBrainz found them, however many songs they gain", async () => {
        const mark = (name: string) =>
            prisma.artist.upsert({
                where: { identityKey: name.toLowerCase().replace(/[^a-z0-9]/g, "") },
                update: { enrichmentStatus: "unresolvable", enrichmentFailures: 3 },
                create: { name, normalizedName: name.toLowerCase(), identityKey: name.toLowerCase().replace(/[^a-z0-9]/g, ""), enrichmentStatus: "unresolvable", enrichmentFailures: 3 },
            });
        await mark("Unknown Artist");
        await mark("Various Artists");
        place("Vote Loose Unk/01.flac", { title: "A", album: "Vote Unknown Album" });
        place("Vote Loose Va/01.flac", { title: "B", album: "Vote Va Album", albumartist: "Various Artists" });
        await scan();
        const status = (name: string) => prisma.artist.findFirst({ where: { name }, select: { enrichmentStatus: true, enrichmentFailures: true } });
        expect(await status("Unknown Artist")).toEqual({ enrichmentStatus: "unresolvable", enrichmentFailures: 3 });
        expect(await status("Various Artists")).toEqual({ enrichmentStatus: "unresolvable", enrichmentFailures: 3 });
    });

    it("asks MusicBrainz again only when the artist gained an album title, not for another song of an album it has", async () => {
        const old = new Date(Date.now() - 86_400_000);
        const found = await prisma.artist.create({
            data: { name: "Vote Unfound Two", normalizedName: "vote unfound two", identityKey: "voteunfoundtwo", enrichmentStatus: "unresolvable", enrichmentFailures: 3 },
        });
        for (const n of [1, 2]) place(`Vote Unfound Two/Vote Known Album/0${n}.flac`, { title: `S${n}`, album: "Vote Known Album", albumartist: "Vote Unfound Two" }, old);
        await scan();
        await prisma.artist.update({ where: { id: found.id }, data: { enrichmentStatus: "unresolvable", enrichmentFailures: 3 } });

        place("Vote Unfound Two/Vote Known Album/03.flac", { title: "S3", album: "Vote Known Album", albumartist: "Vote Unfound Two" });
        await scan();
        expect((await prisma.artist.findUnique({ where: { id: found.id } }))!.enrichmentStatus).toBe("unresolvable");

        place("Vote Unfound Two/Vote Newer Album/01.flac", { title: "N1", album: "Vote Newer Album", albumartist: "Vote Unfound Two" });
        await scan();
        expect((await prisma.artist.findUnique({ where: { id: found.id } }))!.enrichmentStatus).toBe("pending");
    });

    it("reads a changed song's tags once for the whole scan", async () => {
        const old = new Date(Date.now() - 86_400_000);
        place("Vote Once/Vote Once Album/01.flac", { title: "S1", album: "Vote Once Album", albumartist: "Vote Once" }, old);
        await scan();
        (parseFile as jest.Mock).mockClear();
        place("Vote Once/Vote Once Album/02.flac", { title: "S2", album: "Vote Once Album", albumartist: "Vote Once" });

        await scan();

        const reads = (parseFile as jest.Mock).mock.calls.map((c) => c[0] as string);
        expect(reads.filter((f) => f.endsWith("02.flac"))).toHaveLength(1);
        expect(reads.filter((f) => f.endsWith("01.flac"))).toHaveLength(1);
    });
});
