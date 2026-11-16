/**
 * An artist's popular songs, asked through `popularSongs` on the suite database and Redis. Only the network is stood in
 * for: Deezer answers with its recorded replies (fixtures/deezer), ListenBrainz with its recorded refusal and a reply
 * shaped as its documentation gives it (fixtures/listenbrainz: that endpoint answers only with a user's token), and
 * MusicBrainz with release-group dates.
 *
 * The order is global popularity joined to the owned playable songs, then this person's own plays, then first-release
 * date. The web asks for previews of the songs the library lacks; Subsonic asks for owned songs only; the owned songs
 * come in the same order either way.
 */
import fs from "fs";
import path from "path";

const mockDeezer = jest.fn();
jest.mock("../httpClient", () => require("./helpers/deezerMocks").httpClientMock(() => mockDeezer));
const mockLbGet = jest.fn();
jest.mock("axios", () => ({ __esModule: true, default: { create: () => ({ get: (...a: unknown[]) => mockLbGet(...a) }) } }));
const mockReleaseGroups = jest.fn();
jest.mock("../musicbrainz", () => ({
    musicBrainzService: { getReleaseGroups: (...a: unknown[]) => mockReleaseGroups(...a) },
}));
jest.mock("../../utils/logger", () => require("./helpers/scannerMocks").loggerMock());
const mockCache = new Map<string, string>();
jest.mock("../../utils/cacheWrapper", () => require("./helpers/deezerMocks").memoryCacheMock(mockCache));

import { prisma } from "../../utils/db";
import { redisClient, waitForRedisReady } from "../../utils/redis";
import { encrypt } from "../../utils/encryption";
import { popularSongs } from "../popularSongs";

jest.setTimeout(60_000);

const P = "pop_";
const id = (s: string) => `${P}${s}`;
const MBID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const ARTIST = { id: id("artist"), name: "Radiohead", mbid: MBID };
const USER = id("user");
const OTHER = id("other");
const NO_TOKEN = id("notoken");

const fixture = (...parts: string[]) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", ...parts), "utf8"));
const DEEZER_SEARCH = fixture("deezer", "artist-search-radiohead.json").body;
const DEEZER_TOP = fixture("deezer", "artist-top-radiohead.json").body;
const LB_REPLY = fixture("listenbrainz", "popularity-radiohead.json").body;
const LB_REFUSAL = fixture("listenbrainz", "popularity-no-token.json");

function deezerAnswers() {
    mockDeezer.mockImplementation(async (_service: string, url: string) =>
        url.endsWith("/search/artist") ? DEEZER_SEARCH : url.endsWith("/artist/399/top") ? DEEZER_TOP : { data: [] },
    );
}
function listenBrainzAnswers() {
    mockLbGet.mockResolvedValue({ data: LB_REPLY });
}
function listenBrainzRefuses() {
    mockLbGet.mockRejectedValue(Object.assign(new Error("Request failed with status code 401"), { response: { status: LB_REFUSAL.status, data: LB_REFUSAL.body } }));
}

/** [id suffix, title, album, trackNo, extra]. */
const SONGS: Array<[string, string, string, number, object?]> = [
    ["airbag", "Airbag", "okc", 1],
    ["paranoid", "Paranoid Android (Remastered)", "okc", 2],
    ["karma", "Karma Police", "okc", 3, { recordingMbid: "dfeb96a7-f78a-4b04-93ce-c39e28c9a173" }],
    ["subterranean", "Subterranean Homesick Alien", "okc", 4],
    ["exit", "Exit Music (For a Film)", "okc", 5],
    ["letdown", "Let Down", "okc", 6],
    ["nosurprises", "No Surprises", "okc", 7],
    ["lucky", "Lucky", "okc", 8],
    ["electioneering", "Electioneering", "okc", 9, { missingSince: new Date() }],
    ["climbing", "Climbing Up the Walls", "okc", 10, { corrupt: true }],
    ["you", "You", "ph", 1],
    ["creep", "Creep", "ph", 2],
    ["eiirp", "Everything In Its Right Place", "disc", 1],
];

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: P } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: P } } });
}

let n = 0;
// Ten minutes apart, further than a song is long, so each play is a listen of its own.
const play = (userId: string, song: string, times = 1) =>
    Array.from({ length: times }, () => ({ id: id(`play_${n++}`), userId, trackId: id(song), playedAt: new Date(Date.now() - n * 600_000) }));

beforeAll(async () => {
    await waitForRedisReady();
    await cleanup();
    for (const u of [USER, OTHER, NO_TOKEN]) await prisma.user.create({ data: { id: u, username: u, passwordHash: "x" } });
    await prisma.userSettings.create({ data: { userId: USER, listenbrainzToken: encrypt("a-token") } });
    await prisma.artist.create({
        data: { id: ARTIST.id, mbid: MBID, name: ARTIST.name, identityKey: id("ak"), sortName: "radiohead", normalizedName: "radiohead" },
    });
    const albums: Array<[string, string, number, "LIBRARY" | "DISCOVER"]> = [
        ["okc", "OK Computer", 1997, "LIBRARY"],
        ["ph", "Pablo Honey", 1993, "LIBRARY"],
        ["disc", "Kid A", 2000, "DISCOVER"],
    ];
    for (const [a, title, year, location] of albums) {
        await prisma.album.create({
            data: { id: id(a), rgMbid: id(`rg_${a}`), artistId: ARTIST.id, identityKey: id(`ik_${a}`), title, year, primaryType: "Album", location },
        });
    }
    for (const [s, title, album, trackNo, extra] of SONGS) {
        await prisma.track.create({
            data: {
                id: id(s), albumId: id(album), title, trackNo, duration: 200, filePath: `/tmp/${P}${s}.flac`,
                fileModified: new Date(), fileSize: 1, ...extra,
            },
        });
    }
    await prisma.play.createMany({
        data: [
            ...play(USER, "airbag", 3), ...play(USER, "subterranean"), ...play(USER, "karma", 2),
            // Plays of songs that are not playable never rank.
            ...play(USER, "electioneering", 9), ...play(USER, "climbing", 8), ...play(USER, "eiirp", 7),
            // Someone else's plays are not this person's.
            ...play(OTHER, "exit", 10),
        ],
    });
});

afterAll(async () => {
    await cleanup();
    await redisClient.del(`lb:top-rec:${MBID}:50`);
});

beforeEach(async () => {
    mockDeezer.mockReset();
    mockLbGet.mockReset();
    mockReleaseGroups.mockReset();
    mockCache.clear();
    await redisClient.del(`lb:top-rec:${MBID}:50`, "popular:down:listenbrainz", "popular:down:deezer");
    mockReleaseGroups.mockResolvedValue({
        kind: "answered",
        value: [
            { id: id("rg_okc"), "first-release-date": "1997-05-21" },
            { id: id("rg_ph"), "first-release-date": "1993-02-22" },
        ],
        evidence: {},
    });
});

const titles = (songs: Array<{ title: string }>) => songs.map((s) => s.title);
const ask = (opts: { userId?: string; limit?: number; previews?: boolean; deadlineMs?: number } = {}) =>
    popularSongs({ artist: ARTIST, userId: opts.userId ?? USER, limit: opts.limit ?? 50, previews: opts.previews ?? false, deadlineMs: opts.deadlineMs });

describe("the order", () => {
    it("is ListenBrainz's popularity joined to owned songs, then this person's plays, then first-release date", async () => {
        listenBrainzAnswers();
        const songs = await ask();
        expect(titles(songs)).toEqual([
            "Karma Police", "No Surprises", "Paranoid Android (Remastered)", // sitewide popularity, however each is spelled
            "Airbag", "Subterranean Homesick Alien", // this person's plays, most first (Karma Police is already listed)
            "You", "Creep", "Exit Music (For a Film)", "Let Down", "Lucky", // the rest: Pablo Honey (1993) before OK Computer (1997), then track order
        ]);
        expect(songs.map((s) => s.source)).toEqual([
            "global", "global", "global", "own", "own", "release", "release", "release", "release", "release",
        ]);
    });

    it("carries each song's own play count, the person's alone", async () => {
        listenBrainzAnswers();
        const songs = await ask();
        const by = (t: string) => songs.find((s) => s.title === t)!;
        expect(by("Karma Police")).toMatchObject({ trackId: id("karma"), userPlayCount: 2, listeners: 310000, playCount: 5200000 });
        expect(by("Airbag")).toMatchObject({ userPlayCount: 3, playCount: 3 });
        expect(by("Exit Music (For a Film)").userPlayCount).toBe(0);
    });

    it("gives the first-release date of the songs it ordered by it", async () => {
        listenBrainzAnswers();
        const songs = await ask();
        expect(songs.find((s) => s.title === "You")!.releaseDate).toBe("1993-02-22");
        expect(songs.find((s) => s.title === "Lucky")!.releaseDate).toBe("1997-05-21");
    });

    it("stops at the limit", async () => {
        listenBrainzAnswers();
        expect(titles(await ask({ limit: 4 }))).toEqual(["Karma Police", "No Surprises", "Paranoid Android (Remastered)", "Airbag"]);
    });

    it("asks MusicBrainz for dates only when the first two tiers leave room", async () => {
        listenBrainzAnswers();
        await ask({ limit: 5 });
        expect(mockReleaseGroups).not.toHaveBeenCalled();
    });

    it("falls back to the album's year when MusicBrainz has no date", async () => {
        listenBrainzAnswers();
        mockReleaseGroups.mockResolvedValue({ kind: "absent", evidence: {} });
        const songs = await ask();
        expect(titles(songs).slice(5)).toEqual(["You", "Creep", "Exit Music (For a Film)", "Let Down", "Lucky"]);
        expect(songs.find((s) => s.title === "You")!.releaseDate).toBe("1993-01-01");
    });
});

describe("Deezer, when ListenBrainz has nothing for this person", () => {
    it("lists Deezer's rank order, owned or not, for the web; the library's missing songs are previews", async () => {
        listenBrainzRefuses();
        deezerAnswers();
        const songs = await ask({ previews: true, limit: 10 });
        expect(titles(songs)).toEqual([
            "Creep", "Let Down", "Karma Police", "No Surprises", "Jigsaw Falling Into Place", "Exit Music (For a Film)",
            "Everything In Its Right Place", "Paranoid Android (Remastered)", "Weird Fishes / Arpeggi", "All I Need",
        ]);
        const jigsaw = songs.find((s) => s.title === "Jigsaw Falling Into Place")!;
        expect(jigsaw.trackId).toBeNull();
        expect(jigsaw.preview?.previewUrl).toMatch(/^https:\/\/cdnt-preview\.dzcdn\.net\//);
        expect(songs.find((s) => s.title === "Creep")!.trackId).toBe(id("creep"));
    });

    it("does not join a ranked song to an owned one on the word before a hyphen in its title", async () => {
        listenBrainzRefuses();
        mockDeezer.mockImplementation(async (_service: string, url: string) =>
            url.endsWith("/search/artist")
                ? DEEZER_SEARCH
                : url.endsWith("/artist/399/top")
                  ? { data: [{ id: 1, title: "Lucky-Strike", rank: 5, duration: 200, preview: "", album: { title: "Elsewhere", cover_medium: "" } }] }
                  : { data: [] },
        );
        const songs = await ask({ previews: true, limit: 3 });
        expect(songs[0].title).toBe("Lucky-Strike");
        expect(songs[0].trackId).toBeNull();
    });

    it("lists only owned songs for Subsonic, in the order the web saw them", async () => {
        listenBrainzRefuses();
        deezerAnswers();
        const owned = await ask({ previews: false });
        expect(titles(owned)).toEqual([
            "Creep", "Let Down", "Karma Police", "No Surprises", "Exit Music (For a Film)", "Paranoid Android (Remastered)",
            "Airbag", "Subterranean Homesick Alien", "You", "Lucky",
        ]);
        expect(owned.every((s) => s.trackId !== null)).toBe(true);
    });

    it("gives the web and Subsonic the same order for the songs both list", async () => {
        listenBrainzRefuses();
        deezerAnswers();
        const web = (await ask({ previews: true })).filter((s) => s.trackId).map((s) => s.trackId);
        const subsonic = (await ask({ previews: false })).map((s) => s.trackId);
        expect(web).toEqual(subsonic);
    });
});

describe("what is never listed", () => {
    it("is a Discover, missing or corrupt song, though a source ranks it and this person played it", async () => {
        listenBrainzRefuses();
        deezerAnswers();
        const all = [...(await ask({ previews: true })), ...(await ask({ previews: false }))];
        const ids = all.map((s) => s.trackId);
        for (const gone of ["eiirp", "electioneering", "climbing"]) expect(ids).not.toContain(id(gone));
        // Deezer ranks the Discover song: the web gets its preview, never the library copy that is not there.
        expect(all.find((s) => s.title === "Everything In Its Right Place")).toMatchObject({ trackId: null });
    });

    it("is another person's plays counting for this one", async () => {
        listenBrainzRefuses();
        mockDeezer.mockResolvedValue({ data: [] });
        const songs = await ask({ userId: NO_TOKEN });
        // Nobody to rank by: first-release date alone.
        expect(titles(songs).slice(0, 3)).toEqual(["You", "Creep", "Airbag"]);
        expect(songs.every((s) => s.source === "release")).toBe(true);
    });
});

describe("when a source is down", () => {
    it("answers from Deezer once ListenBrainz misses its deadline, then does not wait for it again", async () => {
        deezerAnswers();
        // Answers after the test has moved on; the deadline is 200 ms.
        mockLbGet.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ data: LB_REPLY }), 1500)));

        const started = Date.now();
        const first = await ask({ deadlineMs: 200 });
        expect(Date.now() - started).toBeLessThan(1200);
        expect(titles(first)[0]).toBe("Creep");

        const again = Date.now();
        const second = await ask({ deadlineMs: 200 });
        expect(Date.now() - again).toBeLessThan(200);
        expect(titles(second)).toEqual(titles(first));
        expect(mockLbGet).toHaveBeenCalledTimes(1);

        // The late answer arrives: slow was not down, so ListenBrainz is used again (from its warm cache).
        await new Promise((resolve) => setTimeout(resolve, 1700));
        const third = await ask({ deadlineMs: 200 });
        expect(titles(third)[0]).toBe("Karma Police");
        expect(mockLbGet).toHaveBeenCalledTimes(1);
    });

    it("does not count a refused token as ListenBrainz being down", async () => {
        listenBrainzRefuses();
        deezerAnswers();
        await ask();
        await ask();
        expect(mockLbGet).toHaveBeenCalledTimes(2);
    });

    it("falls to the person's plays and first-release date when both sources are down", async () => {
        mockLbGet.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
        mockDeezer.mockRejectedValue(new Error("connect ECONNREFUSED"));
        const songs = await ask();
        expect(titles(songs).slice(0, 4)).toEqual(["Airbag", "Karma Police", "Subterranean Homesick Alien", "You"]);
        expect(songs.map((s) => s.source).slice(0, 3)).toEqual(["own", "own", "own"]);
    });
});
