/**
 * A joint credit with no MusicBrainz ids is filed under its first artist when that artist is already in the library and
 * MusicBrainz knows no artist by the full joint name; the scanner and the re-file both do it. The real MusicBrainz
 * client, rate limiter bypassed, with only its HTTP reply stood in (a search reply in MusicBrainz's own shape); the real
 * database and scanner on a temp directory.
 */

jest.mock("../../utils/logger", () => require("./helpers/scannerMocks").loggerMock());
jest.mock("../../services/featureDetection", () => require("./helpers/scannerMocks").featureDetectionMock());
jest.mock("../../services/acoustidService", () => require("./helpers/scannerMocks").acoustidServiceMock());
jest.mock("../../services/fpcalc", () => require("./helpers/scannerMocks").fpcalcMock());
jest.mock("../../services/coverArtExtractor", () => require("./helpers/scannerMocks").coverArtExtractorMock());
jest.mock("../../services/artwork", () => require("./helpers/scannerMocks").artworkMock());
jest.mock("../../services/artistCountsService", () => require("./helpers/scannerMocks").artistCountsServiceMock());
jest.mock("../../services/imageStorage", () => require("./helpers/scannerMocks").imageStorageMock());

const mockGet = jest.fn();
jest.mock("axios", () => ({ create: () => ({ get: (...args: unknown[]) => mockGet(...args) }) }));

const redisStore = new Map<string, string>();
jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: async (key: string) => redisStore.get(key) ?? null,
        set: async (key: string, value: string) => (redisStore.set(key, value), "OK"),
        setex: async (key: string, _ttl: number, value: string) => (redisStore.set(key, value), "OK"),
        del: async (key: string) => (redisStore.delete(key), 1),
    },
}));
jest.mock("../../services/rateLimiter", () => ({
    INTERACTIVE_PRIORITY: 10,
    rateLimiter: { execute: async (_source: string, fn: () => Promise<unknown>) => fn() },
}));
jest.mock("../../services/sourcePauseController", () => ({
    sourcePauseController: { handleRateLimit: jest.fn().mockResolvedValue(false), getPause: jest.fn().mockResolvedValue(null) },
}));

import fs from "fs";
import os from "os";
import path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../../utils/db";
import { MusicScannerService } from "../musicScanner";
import { refileLibrary } from "../albumRefile";
import { artistIdentityKey } from "../artistIdentity";
import { musicBrainzService } from "../musicbrainz";

jest.setTimeout(60_000);

const LEAD_ID = "5e0a1c2d-0000-4000-8000-000000000001";

/** MusicBrainz's search reply for an artist query: the artists it knows by these names. */
const searchReply = (names: string[], limit = 25) => ({
    data: {
        created: "2026-11-01T00:00:00.000Z",
        count: names.length,
        offset: 0,
        artists: names.slice(0, limit).map((name, i) => ({
            id: `5e0a1c2d-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, type: "Group", score: 100 - i, name,
            "sort-name": name, aliases: [{ name: `${name} (alias)`, "sort-name": name, type: null }],
        })),
    },
});

/** The tokens of a name or phrase as MusicBrainz's index holds them: lowercase words, "&" and "+" gone. */
const tokensOf = (text: string) =>
    text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\u2018\u2019]/g, "'")
        .split(/[^a-z0-9']+/).map((t) => t.replace(/^'+|'+$/g, "")).filter(Boolean);
/** Whether the phrase's tokens appear in the name's tokens, in a row. */
const hasPhrase = (name: string, phrase: string) => {
    const have = tokensOf(name);
    const want = tokensOf(phrase);
    return have.some((_, at) => want.every((w, i) => have[at + i] === w));
};
/** The quoted phrases of a query. */
const phrasesOf = (query: string) => [...query.matchAll(/"([^"]*)"/g)].map((m) => m[1]);


/** Artists MusicBrainz "knows"; any other name answers with no artists. `down` makes every call fail like a dropped connection. */
let known: string[];
/** Artists that match every question, listed before the real one, as a common name's namesakes do. */
let crowd: string[];
let down: boolean;
const dropped = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
beforeEach(() => {
    known = [];
    crowd = [];
    down = false;
    mockGet.mockReset();
    mockGet.mockImplementation(async (_url: string, config: { params: { query: string; limit: number } }) => {
        if (down) throw dropped();
        const phrases = phrasesOf(config.params.query);
        const matches = (name: string) => phrases.some((phrase) => hasPhrase(name, phrase));
        const first = phrases.length ? crowd.map((c, i) => `${phrases[0].replace(/"/g, "")} namesake ${i} ${c}`) : [];
        return searchReply([...first, ...known.filter(matches)], config.params.limit);
    });
    redisStore.clear();
});

let musicDir: string;
let tags: Map<string, unknown>;

async function wipe() {
    await prisma.$executeRawUnsafe(`DELETE FROM "OwnedAlbum" WHERE "artistId" IN (SELECT id FROM "Artist" WHERE name LIKE 'Joint%')`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE "filePath" LIKE 'Joint%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE title LIKE 'Joint%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE name LIKE 'Joint%' OR name = 'Various Artists'`);
    await prisma.downloadJob.deleteMany({ where: { userId: "joint_user" } });
    await prisma.discoveryBatch.deleteMany({ where: { userId: "joint_user" } });
    await prisma.user.deleteMany({ where: { id: "joint_user" } });
}

beforeEach(async () => {
    await wipe();
    musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "joint-"));
    tags = new Map();
    (parseFile as jest.Mock).mockReset();
    (parseFile as jest.Mock).mockImplementation(async (file: string) => {
        const found = tags.get(file);
        if (!found) throw new Error("unreadable");
        return found;
    });
});
afterEach(() => fs.rmSync(musicDir, { recursive: true, force: true }));
afterAll(async () => {
    await wipe();
    await prisma.$disconnect();
});

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const lead = (name = "Joint Mike", extra: Record<string, unknown> = {}) =>
    prisma.artist.create({ data: { name, normalizedName: name.toLowerCase(), identityKey: key(name), mbid: LEAD_ID, ...extra } });

function place(rel: string, common: Record<string, unknown>, mtime?: Date) {
    const file = path.join(musicDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "dummy audio bytes");
    if (mtime) fs.utimesSync(file, mtime, mtime);
    tags.set(file, { common: { track: { no: 1 }, disk: { no: 1 }, ...common }, format: { duration: 200, codec: "flac" }, native: {} });
    return file;
}

const scan = () => new MusicScannerService().scanLibrary(musicDir);

async function filing(title: string) {
    const rows = await prisma.album.findMany({ where: { title }, select: { artist: { select: { name: true } }, _count: { select: { tracks: true } } } });
    return rows.map((r) => ({ artist: r.artist.name, songs: r._count.tracks }));
}
const artistCount = (name: string) => prisma.artist.count({ where: { name } });

/** Three songs of an album, every artist and album-artist tag the joint credit, no ids. */
function jointAlbum(folder: string, title: string, credit: string, extra: Record<string, unknown> = {}) {
    for (const n of [1, 2, 3]) place(`${folder}/${title}/0${n}.flac`, { title: `Song ${n}`, album: title, artist: credit, albumartist: credit, ...extra });
}

describe("the scanner", () => {
    it("files a joint credit under its first artist when the library has it and MusicBrainz has no artist by the joint name", async () => {
        const mike = await lead();
        jointAlbum("Joint Hits", "Joint Greatest", "Joint Mike & The Joint Five");

        await scan();

        expect(await filing("Joint Greatest")).toEqual([{ artist: "Joint Mike", songs: 3 }]);
        expect(await artistCount("Joint Mike & The Joint Five")).toBe(0);
        expect((await prisma.album.findFirst({ where: { title: "Joint Greatest" } }))!.artistId).toBe(mike.id);
    });

    it("keeps a one-artist single with the compilation flag and no album artist under the first artist, not Various Artists", async () => {
        await lead();
        place("Joint Singles/Joint Single [Single]/01.flac", {
            title: "The Joint Single", album: "Joint Single [Single]", artist: "Joint Mike & Joint Will", compilation: true,
        });

        await scan();

        expect(await filing("Joint Single [Single]")).toEqual([{ artist: "Joint Mike", songs: 1 }]);
        expect(await artistCount("Various Artists")).toBe(0);
    });

    it("keeps a name whole when MusicBrainz knows an artist by it, though the first name is in the library", async () => {
        await lead("Joint Simon");
        known = ["Joint Simon & Joint Garfunkel"];
        jointAlbum("Joint Duo", "Joint Bridge", "Joint Simon & Joint Garfunkel");

        await scan();

        expect(await filing("Joint Bridge")).toEqual([{ artist: "Joint Simon & Joint Garfunkel", songs: 3 }]);
    });

    it("counts a MusicBrainz alias of the joint name as knowing it", async () => {
        await lead("Joint Simon");
        mockGet.mockImplementation(async () => ({
            data: { count: 1, offset: 0, artists: [{ id: "5e0a1c2d-0000-4000-8000-000000000999", name: "The Joint Duo", score: 100, aliases: [{ name: "Joint Simon and Joint Garfunkel" }] }] },
        }));
        jointAlbum("Joint Duo", "Joint Alias", "Joint Simon & Joint Garfunkel");

        await scan();

        expect(await filing("Joint Alias")).toEqual([{ artist: "Joint Simon & Joint Garfunkel", songs: 3 }]);
    });

    it("keeps a name whole when its first artist is not in the library, without asking MusicBrainz", async () => {
        jointAlbum("Joint Duo", "Joint Stranger", "Joint Nobody & Joint Else");

        await scan();

        expect(await filing("Joint Stranger")).toEqual([{ artist: "Joint Nobody & Joint Else", songs: 3 }]);
        expect(mockGet).not.toHaveBeenCalled();
    });

    it("keeps a name whole when MusicBrainz cannot be reached, and does not crash", async () => {
        await lead();
        down = true;
        jointAlbum("Joint Hits", "Joint Offline", "Joint Mike & The Joint Five");

        const result = await scan();

        expect(await filing("Joint Offline")).toEqual([{ artist: "Joint Mike & The Joint Five", songs: 3 }]);
        expect(result.tracksAdded).toBe(3);
    });

    it("asks MusicBrainz once for a name, however many songs and scans name it", async () => {
        await lead();
        jointAlbum("Joint Hits", "Joint Cached", "Joint Mike & The Joint Five");
        await scan();
        const asked = mockGet.mock.calls.length;
        expect(asked).toBe(1);

        // A new song of the album, and a later scan: the answer is cached.
        place("Joint Hits/Joint Cached/04.flac", { title: "Song 4", album: "Joint Cached", artist: "Joint Mike & The Joint Five", albumartist: "Joint Mike & The Joint Five" });
        await scan();

        expect(mockGet.mock.calls.length).toBe(asked);
        expect(await filing("Joint Cached")).toEqual([{ artist: "Joint Mike", songs: 4 }]);
    });

    it("asks MusicBrainz once for a name spelled \"&\", \"and\" or \"+\", in any case, across albums", async () => {
        await lead();
        jointAlbum("Joint Hits", "Joint Spelled One", "Joint Mike & The Joint Five");
        jointAlbum("Joint Hits", "Joint Spelled Two", "JOINT MIKE and the joint five");
        jointAlbum("Joint Hits", "Joint Spelled Three", "Joint Mike + The Joint Five");

        await scan();

        expect(mockGet).toHaveBeenCalledTimes(1);
        for (const title of ["Joint Spelled One", "Joint Spelled Two", "Joint Spelled Three"]) {
            expect(await filing(title)).toEqual([{ artist: "Joint Mike", songs: 3 }]);
        }
    });

    it("treats \"+\" and \"&\" as the same when comparing with MusicBrainz's name", async () => {
        await lead();
        known = ["Joint Mike + the Joint Mechanics"];
        jointAlbum("Joint Hits", "Joint Mechanics", "Joint Mike & The Joint Mechanics");

        await scan();

        expect(await filing("Joint Mechanics")).toEqual([{ artist: "Joint Mike & The Joint Mechanics", songs: 3 }]);
    });

    it("stops asking MusicBrainz for the rest of the scan once it fails, whatever the names", async () => {
        await lead();
        down = true;
        jointAlbum("Joint Hits", "Joint Down One", "Joint Mike & The Joint Five");
        jointAlbum("Joint Hits", "Joint Down Two", "Joint Mike & Joint Will");
        jointAlbum("Joint Hits", "Joint Down Three", "Joint Mike and Joint Pat");

        await scan();

        expect(mockGet).toHaveBeenCalledTimes(1);
        expect(await filing("Joint Down Two")).toEqual([{ artist: "Joint Mike & Joint Will", songs: 3 }]);
    });

    it("keeps an album together when MusicBrainz fails after some of its songs were filed under the first artist", async () => {
        await lead();
        place("Joint Hits/Joint Midway/01.flac", { title: "Song 1", album: "Joint Midway", artist: "Joint Mike & The Joint Five", albumartist: "Joint Mike & The Joint Five" });
        place("Joint Hits/Joint Midway/02.flac", { title: "Song 2", album: "Joint Midway", artist: "Joint Mike & The Joint Five", albumartist: "Joint Mike & The Joint Five" });
        await scan();
        expect(await filing("Joint Midway")).toEqual([{ artist: "Joint Mike", songs: 2 }]);

        redisStore.clear();
        down = true;
        place("Joint Hits/Joint Midway/03.flac", { title: "Song 3", album: "Joint Midway", artist: "Joint Mike & The Joint Five", albumartist: "Joint Mike & The Joint Five" });
        await scan();

        expect(await filing("Joint Midway")).toEqual([{ artist: "Joint Mike", songs: 3 }]);
        expect(await artistCount("Joint Mike & The Joint Five")).toBe(0);
    });

    it("does not split an album when the first artist appears between scans; the re-file then moves the whole album", async () => {
        jointAlbum("Joint Hits", "Joint Later", "Joint Mike & The Joint Five");
        await scan();
        expect(await filing("Joint Later")).toEqual([{ artist: "Joint Mike & The Joint Five", songs: 3 }]);

        // The first artist's own album arrives with a new song of this one.
        place("Joint Own Dir/Joint Own/01.flac", { title: "Own", album: "Joint Own", artist: "Joint Mike", albumartist: "Joint Mike" });
        place("Joint Hits/Joint Later/04.flac", { title: "Song 4", album: "Joint Later", artist: "Joint Mike & The Joint Five", albumartist: "Joint Mike & The Joint Five" });
        await scan();
        expect(await filing("Joint Later")).toEqual([{ artist: "Joint Mike & The Joint Five", songs: 4 }]);

        await refileLibrary(musicDir);
        expect(await filing("Joint Later")).toEqual([{ artist: "Joint Mike", songs: 4 }]);
        expect(await artistCount("Joint Mike & The Joint Five")).toBe(0);
    });

    it("asks MusicBrainz for the exact name, in each spelling of the joining word, on artist and alias", async () => {
        await lead();
        jointAlbum("Joint Hits", "Joint Phrase", "Joint Mike & The Joint Five");

        await scan();

        const query: string = mockGet.mock.calls[0][1].params.query;
        for (const field of ["artist", "alias"]) {
            for (const phrase of ["joint mike & the joint five", "joint mike and the joint five", "joint mike + the joint five"]) {
                expect(query).toContain(`${field}:"${phrase}"`);
            }
        }
    });

    it("keeps an apostrophe inside a word when asking, so a name with one is found (straight or curly)", async () => {
        await lead("Joint O'Connor");
        known = ["Joint O\u2019Connor & The Joint Five"];
        jointAlbum("Joint Hits", "Joint Apostrophe", "Joint O'Connor & The Joint Five");

        await scan();

        expect(mockGet.mock.calls[0][1].params.query).toContain(`artist:"joint o'connor and the joint five"`);
        expect(await filing("Joint Apostrophe")).toEqual([{ artist: "Joint O'Connor & The Joint Five", songs: 3 }]);
    });

    it("finds a name MusicBrainz holds with accents when the credit has none", async () => {
        await lead("Joint Sin\u00e9ad");
        known = ["Joint Sin\u00e9ad & Joint Duo"];
        jointAlbum("Joint Hits", "Joint Accent", "Joint Sinead & Joint Duo");

        await scan();

        expect(await filing("Joint Accent")).toEqual([{ artist: "Joint Sinead & Joint Duo", songs: 3 }]);
    });

    it("does not split when MusicBrainz has more artists for the name than it returned and none is exactly it", async () => {
        await lead();
        crowd = Array.from({ length: 40 }, (_, i) => `x${i}`);
        known = ["Joint Mike & The Joint Five"];
        jointAlbum("Joint Hits", "Joint Crowded", "Joint Mike & The Joint Five");

        await scan();

        expect(await filing("Joint Crowded")).toEqual([{ artist: "Joint Mike & The Joint Five", songs: 3 }]);
    });

    it("keeps a name whole when the exact artist is among a crowd of namesakes MusicBrainz returned", async () => {
        await lead();
        crowd = ["x1", "x2"];
        known = ["Joint Mike & The Joint Five"];
        jointAlbum("Joint Hits", "Joint Found", "Joint Mike & The Joint Five");

        await scan();

        expect(await filing("Joint Found")).toEqual([{ artist: "Joint Mike & The Joint Five", songs: 3 }]);
    });

    it("files under the longest leading part the library has: \"A & B and C\" under \"A & B\", else \"A\"", async () => {
        await lead("Joint Hall");
        await lead("Joint Hall & Joint Oates", { mbid: null, identityKey: artistIdentityKey("Joint Hall & Joint Oates") });
        jointAlbum("Joint Hits", "Joint Longest", "Joint Hall & Joint Oates and Joint Band");
        jointAlbum("Joint Hits", "Joint Shorter", "Joint Hall and Joint Pals and Joint Band");

        await scan();

        expect(await filing("Joint Longest")).toEqual([{ artist: "Joint Hall & Joint Oates", songs: 3 }]);
        expect(await filing("Joint Shorter")).toEqual([{ artist: "Joint Hall", songs: 3 }]);
    });

    it("does not fail the scan when the MusicBrainz client throws", async () => {
        await lead();
        const spy = jest.spyOn(musicBrainzService, "searchArtist").mockRejectedValue(new Error("redis exploded"));
        jointAlbum("Joint Hits", "Joint Thrown One", "Joint Mike & The Joint Five");
        jointAlbum("Joint Hits", "Joint Thrown Two", "Joint Mike & Joint Will");

        const result = await scan();
        spy.mockRestore();

        expect(result.tracksAdded).toBe(6);
        expect(await filing("Joint Thrown One")).toEqual([{ artist: "Joint Mike & The Joint Five", songs: 3 }]);
        expect(await filing("Joint Thrown Two")).toEqual([{ artist: "Joint Mike & Joint Will", songs: 3 }]);
    });

    it("never files under a placeholder name such as Unknown Artist", async () => {
        await lead("Unknown Artist");
        jointAlbum("Joint Hits", "Joint Placeholder", "Unknown Artist & Joint Will");

        await scan();

        expect(await filing("Joint Placeholder")).toEqual([{ artist: "Unknown Artist & Joint Will", songs: 3 }]);
        expect(mockGet).not.toHaveBeenCalled();
    });

    it("does not let another artist's same-titled loose song in the music root decide a root-level credit", async () => {
        await lead();
        const other = await prisma.artist.create({ data: { name: "Joint Stranger", normalizedName: "joint stranger", identityKey: key("Joint Stranger") } });
        const held = await prisma.album.create({
            data: { artistId: other.id, title: "Joint Rooted", identityKey: key("Joint Rooted"), rgMbid: "temp-joint-rooted", primaryType: "Album", location: "DISCOVER" },
        });
        await prisma.track.create({ data: { albumId: held.id, title: "Joint Held.flac", trackNo: 1, duration: 200, filePath: "Joint Held.flac", fileModified: new Date(), fileSize: 17 } });
        for (const n of [1, 2]) place(`Joint Root ${n}.flac`, { title: `Song ${n}`, album: "Joint Rooted", artist: "Joint Mike & The Joint Five", albumartist: "Joint Mike & The Joint Five" });

        await scan();

        const rows = await prisma.album.findMany({ where: { title: "Joint Rooted", location: "LIBRARY" }, select: { artist: { select: { name: true } } } });
        expect(rows.map((r) => r.artist.name)).toEqual(["Joint Mike"]);
    });

    it("leaves a Discover album under the credit Discover's records match, and does not touch its evidence", async () => {
        await lead();
        await prisma.user.create({ data: { id: "joint_user", username: "joint_user", passwordHash: "x" } });
        const batch = await prisma.discoveryBatch.create({ data: { userId: "joint_user", weekStart: new Date(Date.UTC(2026, 9, 19)), targetSongCount: 10 } });
        await prisma.downloadJob.create({
            data: {
                userId: "joint_user", subject: "Joint Mike & Joint Will - Joint Discover", type: "album", status: "completed",
                discoveryBatchId: batch.id, metadata: { downloadType: "discovery", artistName: "Joint Mike & Joint Will", albumTitle: "Joint Discover" },
            },
        });
        jointAlbum("Joint Discover Dir", "Joint Discover", "Joint Mike & Joint Will");

        await scan();

        const album = await prisma.album.findFirstOrThrow({ where: { title: "Joint Discover" }, select: { location: true, artist: { select: { name: true } } } });
        expect(album).toEqual({ location: "DISCOVER", artist: { name: "Joint Mike & Joint Will" } });
        expect(mockGet).not.toHaveBeenCalled();
    });
});

describe("the re-file", () => {
    async function misfiled(albumTitle: string, jointName: string, extra: Record<string, unknown> = {}) {
        const joint = await prisma.artist.upsert({ where: { identityKey: key(jointName) }, update: {}, create: { name: jointName, normalizedName: jointName.toLowerCase(), identityKey: key(jointName) } });
        const album = await prisma.album.create({
            data: { artistId: joint.id, title: albumTitle, identityKey: key(albumTitle), rgMbid: `temp-joint-${albumTitle}`, primaryType: "Album", location: "LIBRARY", ...extra },
        });
        for (const n of [1, 2, 3]) {
            const rel = `Joint Hits/${albumTitle}/0${n}.flac`;
            place(rel, { title: `Song ${n}`, album: albumTitle, artist: jointName, albumartist: jointName });
            await prisma.track.create({ data: { albumId: album.id, title: rel, trackNo: n, duration: 200, filePath: rel, fileModified: new Date(), fileSize: 17 } });
        }
        return { joint, album };
    }

    it("moves a joint-credit album to the first artist's row and removes the emptied joint-credit artist", async () => {
        const mike = await lead();
        const { album } = await misfiled("Joint Greatest", "Joint Mike & The Joint Five");

        const result = await refileLibrary(musicDir);

        expect(await filing("Joint Greatest")).toEqual([{ artist: "Joint Mike", songs: 3 }]);
        expect((await prisma.album.findUniqueOrThrow({ where: { id: album.id } })).artistId).toBe(mike.id);
        expect(await artistCount("Joint Mike & The Joint Five")).toBe(0);
        expect(result.albumsMoved).toBe(1);
        expect(result.artistsRemoved).toBe(1);
    });

    it("joins the first artist's own copy of the album when it has one", async () => {
        const mike = await lead();
        const own = await prisma.album.create({
            data: { artistId: mike.id, title: "Joint Shared", identityKey: key("Joint Shared"), rgMbid: "temp-joint-own", primaryType: "Album", location: "LIBRARY" },
        });
        await misfiled("Joint Shared", "Joint Mike & Joint Will");

        const result = await refileLibrary(musicDir);

        expect(await filing("Joint Shared")).toEqual([{ artist: "Joint Mike", songs: 3 }]);
        expect(await prisma.track.count({ where: { albumId: own.id } })).toBe(3);
        expect(result.albumsMerged).toBe(1);
        expect(await artistCount("Joint Mike & Joint Will")).toBe(0);
    });

    it("leaves an edited album where it is", async () => {
        await lead();
        await misfiled("Joint Edited", "Joint Mike & The Joint Five", { hasUserOverrides: true });

        const result = await refileLibrary(musicDir);

        expect(await filing("Joint Edited")).toEqual([{ artist: "Joint Mike & The Joint Five", songs: 3 }]);
        expect(result.keptEdited).toBe(1);
        expect(await artistCount("Joint Mike & The Joint Five")).toBe(1);
    });

    it("keeps a name whole when MusicBrainz knows it, when the first artist is missing, and when MusicBrainz is down", async () => {
        await lead("Joint Simon");
        known = ["Joint Simon & Joint Garfunkel"];
        await misfiled("Joint Known", "Joint Simon & Joint Garfunkel");
        await misfiled("Joint Stranger", "Joint Nobody & Joint Else");
        await misfiled("Joint Offline", "Joint Simon & The Joint Five");
        // The third name is asked while MusicBrainz is down.
        mockGet.mockImplementation(async (_url: string, config: { params: { query: string; limit: number } }) => {
            const phrases = phrasesOf(config.params.query);
            if (phrases.some((phrase) => tokensOf(phrase).includes("five"))) throw dropped();
            return searchReply(known.filter((name) => phrases.some((phrase) => hasPhrase(name, phrase))), config.params.limit);
        });

        await refileLibrary(musicDir);

        expect(await filing("Joint Known")).toEqual([{ artist: "Joint Simon & Joint Garfunkel", songs: 3 }]);
        expect(await filing("Joint Stranger")).toEqual([{ artist: "Joint Nobody & Joint Else", songs: 3 }]);
        expect(await filing("Joint Offline")).toEqual([{ artist: "Joint Simon & The Joint Five", songs: 3 }]);
    });
    it("moves an album held under a first-name artist to the whole name when MusicBrainz knows that name", async () => {
        const simon = await lead("Joint Simon");
        known = ["Joint Simon & Joint Garfunkel"];
        const own = await prisma.album.create({
            data: { artistId: simon.id, title: "Joint Old Cut", identityKey: key("Joint Old Cut"), rgMbid: "temp-joint-cut", primaryType: "Album", location: "LIBRARY" },
        });
        for (const n of [1, 2]) {
            const rel = `Joint Duo/Joint Old Cut/0${n}.flac`;
            place(rel, { title: `Song ${n}`, album: "Joint Old Cut", artist: "Joint Simon & Joint Garfunkel", albumartist: "Joint Simon & Joint Garfunkel" });
            await prisma.track.create({ data: { albumId: own.id, title: rel, trackNo: n, duration: 200, filePath: rel, fileModified: new Date(), fileSize: 17 } });
        }

        await refileLibrary(musicDir);

        expect(await filing("Joint Old Cut")).toEqual([{ artist: "Joint Simon & Joint Garfunkel", songs: 2 }]);
    });

    it("leaves an album under the first artist when MusicBrainz cannot be asked", async () => {
        const mike = await lead();
        down = true;
        const own = await prisma.album.create({
            data: { artistId: mike.id, title: "Joint Stay", identityKey: key("Joint Stay"), rgMbid: "temp-joint-stay", primaryType: "Album", location: "LIBRARY" },
        });
        const rel = "Joint Hits/Joint Stay/01.flac";
        place(rel, { title: "Song 1", album: "Joint Stay", artist: "Joint Mike & The Joint Five", albumartist: "Joint Mike & The Joint Five" });
        await prisma.track.create({ data: { albumId: own.id, title: rel, trackNo: 1, duration: 200, filePath: rel, fileModified: new Date(), fileSize: 17 } });

        await refileLibrary(musicDir);

        expect(await filing("Joint Stay")).toEqual([{ artist: "Joint Mike", songs: 1 }]);
    });


    it("asks MusicBrainz nothing about an album Discover's records say is Discover's, and leaves it under its credit", async () => {
        await lead();
        await prisma.user.create({ data: { id: "joint_user", username: "joint_user", passwordHash: "x" } });
        const batch = await prisma.discoveryBatch.create({ data: { userId: "joint_user", weekStart: new Date(Date.UTC(2026, 9, 19)), targetSongCount: 10 } });
        await prisma.downloadJob.create({
            data: {
                userId: "joint_user", subject: "Joint Mike & Joint Will - Joint Held", type: "album", status: "completed",
                discoveryBatchId: batch.id, metadata: { downloadType: "discovery", artistName: "Joint Mike & Joint Will", albumTitle: "Joint Held" },
            },
        });
        await misfiled("Joint Held", "Joint Mike & Joint Will");

        await refileLibrary(musicDir);

        expect(mockGet).not.toHaveBeenCalled();
        expect(await filing("Joint Held")).toEqual([{ artist: "Joint Mike & Joint Will", songs: 3 }]);
    });

    it("asks MusicBrainz nothing about an album with a song Discover holds", async () => {
        await lead();
        await misfiled("Joint Mixed", "Joint Mike & The Joint Five");
        const holder = await prisma.artist.create({ data: { name: "Joint Holder", normalizedName: "joint holder", identityKey: key("Joint Holder") } });
        const held = await prisma.album.create({
            data: { artistId: holder.id, title: "Joint Mixed", identityKey: key("Joint Mixed"), rgMbid: "temp-joint-mixed-d", primaryType: "Album", location: "DISCOVER" },
        });
        await prisma.track.create({ data: { albumId: held.id, title: "Joint Mixed d", trackNo: 9, duration: 200, filePath: "Joint Hits/Joint Mixed/09.flac", fileModified: new Date(), fileSize: 17 } });

        await refileLibrary(musicDir);

        expect(mockGet).not.toHaveBeenCalled();
        expect(await filing("Joint Mixed")).toEqual(expect.arrayContaining([{ artist: "Joint Mike & The Joint Five", songs: 3 }]));
    });

    it("asks MusicBrainz once for a name however many albums carry it", async () => {
        await lead();
        await misfiled("Joint Many One", "Joint Mike & The Joint Five");
        await misfiled("Joint Many Two", "Joint Mike & The Joint Five");
        await misfiled("Joint Many Three", "Joint Mike and The Joint Five");

        await refileLibrary(musicDir);

        expect(mockGet).toHaveBeenCalledTimes(1);
        expect(await filing("Joint Many Three")).toEqual([{ artist: "Joint Mike", songs: 3 }]);
    });

});
