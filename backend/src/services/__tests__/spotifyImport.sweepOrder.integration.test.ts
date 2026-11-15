/**
 * An import's first-word artist sweeps offer the matcher every song of the artists they find, in a stable order. Five
 * properties, each checked through the preview (all three sweeps of the per-song lookup) and the M3U import (its fuzzy
 * tier). Real database.
 *
 * - Nothing is cut by id: the right song is found when it has the highest id of an artist with more than 50 songs, and
 *   when the first word is a common one ("the") shared by dozens of artists with lower ids.
 * - The same song comes back whatever order the rows were inserted: 80 songs with one title, inserted highest id first,
 *   match the lowest id.
 * - A word held by more artists than one query can carry ids for still finds its songs, and the songs load in chunks
 *   of at most the chunk size (a small one is passed in), in id order across chunks.
 * - A credit whose first word is short ("DJ Qzsw feat. Someone") still reaches the matcher through the credit sweep.
 * - An artist whose shown name holds the word, and whose stored name does not, reaches the matcher through each sweep.
 */
import { prisma } from "../../utils/db";
import { spotifyImportService, songsOfArtistsHoldingWord } from "../spotifyImport";
import { m3uSongIds } from "../../__tests__/helpers/m3uImport";
import { closeEngineConnections } from "../../__tests__/helpers/engineConnections";

jest.setTimeout(120_000);

const P = "zz-sweep-order";
const USER = `${P}-user`;
const COUNT = 80;

async function cleanup() {
    await prisma.playlist.deleteMany({ where: { userId: USER } });
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { identityKey: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { identityKey: { startsWith: P } } });
}

/** The ids of the songs of `key`, lowest first. */
const idsOf = (key: string) => Array.from({ length: COUNT }, (_, n) => `${P}-${key}-${String(n).padStart(3, "0")}`);
const lowest = (key: string) => idsOf(key)[0];
const highest = (key: string) => idsOf(key)[COUNT - 1];

/**
 * An artist named `artistName` with COUNT songs inserted highest id first, so the order a scan happens to return rows
 * in is the opposite of id order. `titleOf(n)` names song n.
 */
async function seed(key: string, artistName: string, titleOf: (n: number) => string) {
    const artist = await prisma.artist.create({
        data: { name: artistName, normalizedName: artistName.toLowerCase(), identityKey: `${P}-${key}-artist` },
    });
    const album = await prisma.album.create({
        data: { rgMbid: `${P}-${key}-rg`, identityKey: `${P}-${key}-album`, primaryType: "Album", title: `${P} ${key} album`, artistId: artist.id, location: "LIBRARY" },
    });
    for (let n = COUNT - 1; n >= 0; n--) {
        const id = idsOf(key)[n];
        await prisma.track.create({
            data: { id, title: titleOf(n), albumId: album.id, trackNo: n + 1, duration: 100, filePath: `/${P}/${id}.flac`, fileModified: new Date(), fileSize: 1 },
        });
    }
}

/**
 * An artist named `artistName` with one song, `title`, in file `filePath`; `displayName` is the name a person edited it
 * to. Returns the song's id.
 */
async function seedOne(key: string, artistName: string, title: string, filePath = `/${P}/${key}.flac`, displayName?: string) {
    const artist = await prisma.artist.create({
        data: { name: artistName, normalizedName: artistName.toLowerCase(), identityKey: `${P}-${key}-artist`, displayName },
    });
    const album = await prisma.album.create({
        data: { rgMbid: `${P}-${key}-rg`, identityKey: `${P}-${key}-album`, primaryType: "Album", title: `${P} ${key} album`, artistId: artist.id, location: "LIBRARY" },
    });
    const id = `${P}-${key}-one`;
    await prisma.track.create({
        data: { id, title, albumId: album.id, trackNo: 1, duration: 100, filePath, fileModified: new Date(), fileSize: 1 },
    });
    return id;
}

const SAME = (title: string) => () => title;
/** Distinct filler titles, with the wanted one last (so on the highest id). */
const LAST_IS = (title: string) => (n: number) => (n === COUNT - 1 ? title : `lorem ipsum ${n}`);

const previewMatch = async (artist: string, title: string) => {
    const preview = await spotifyImportService.generatePreviewFromDeezer({
        id: "d", title: "d", tracks: [{ deezerId: "t1", title, artist, album: "x" }],
    });
    return preview.matchedTracks[0].localTrack?.id ?? null;
};

let m3uCount = 0;
const m3uMatch = async (artist: string | null, title: string | null, filePath = `/nowhere/${P}-${m3uCount + 1}.mp3`) => {
    const [first] = await m3uSongIds(USER, `${P}-m3u-${++m3uCount}`, [{ filePath, durationSeconds: null, artist, title }]);
    return first ?? null;
};

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: USER, username: USER, passwordHash: "x", role: "user", tokenVersion: 0 } });
});

afterAll(async () => {
    await cleanup();
    await closeEngineConnections();
});

describe("an artist with more than 50 songs, the wanted one on the highest id", () => {
    it("the artist-name-holds-the-first-word sweep finds it", async () => {
        const title = `${P} one wanted`;
        await seed("one", "qzaone band", LAST_IS(title));
        expect(await previewMatch("qzaone", title)).toBe(highest("one"));
    });

    it("the artist-name-starts-with sweep finds it", async () => {
        const title = `${P} two wanted`;
        // The source artist's first five letters begin the library artist; no library artist holds its first word.
        await seed("two", "qzbtwq band", LAST_IS(title));
        expect(await previewMatch("qzbtwz", title)).toBe(highest("two"));
    });

    it("the full-credit first-word sweep finds it", async () => {
        const title = `${P} three wanted`;
        // "V.A." reads as Various Artists for the first two sweeps; only the full credit's first word finds this artist.
        await seed("three", "qzcthree v.a. band", LAST_IS(title));
        expect(await previewMatch("V.A.", title)).toBe(highest("three"));
    });

    it("the M3U fuzzy tier finds it", async () => {
        const title = `${P} four wanted`;
        await seed("four", "qzdfour band", LAST_IS(title));
        expect(await m3uMatch("qzdfour band", title)).toBe(highest("four"));
    });
});

describe("a common first word shared by many artists with lower ids", () => {
    const title = `${P} common wanted`;

    beforeAll(async () => {
        // 60 other "the ..." artists, each with a song whose id sorts before the wanted artist's.
        for (let n = 0; n < 60; n++) {
            const artist = await prisma.artist.create({
                data: { name: `the qzeother ${n}`, normalizedName: `the qzeother ${n}`, identityKey: `${P}-a-other-${n}` },
            });
            const album = await prisma.album.create({
                data: { rgMbid: `${P}-a-other-${n}-rg`, identityKey: `${P}-a-other-${n}-album`, primaryType: "Album", title: `${P} other ${n}`, artistId: artist.id, location: "LIBRARY" },
            });
            await prisma.track.create({
                data: { id: `${P}-a-other-${n}`, title: `${P} other song ${n}`, albumId: album.id, trackNo: 1, duration: 100, filePath: `/${P}/a-other-${n}.flac`, fileModified: new Date(), fileSize: 1 },
            });
        }
        await seed("five", "the qzefive band", LAST_IS(title));
    });

    it("the preview finds the wanted song", async () => {
        expect(await previewMatch("The Qzefive", title)).toBe(highest("five"));
    });

    it("the M3U fuzzy tier finds the wanted song", async () => {
        expect(await m3uMatch("The Qzefive Band", title)).toBe(highest("five"));
    });
});

describe("80 namesake songs inserted highest id first", () => {
    it("the first-word sweeps match the same song", async () => {
        const title = `${P} six song`;
        await seed("six", "qzfsix band", SAME(title));
        expect(await previewMatch("qzfsix", title)).toBe(lowest("six"));
        expect(await previewMatch("qzfsix", title)).toBe(lowest("six"));
    });

    it("the M3U fuzzy tier matches the same song", async () => {
        const title = `${P} seven song`;
        await seed("seven", "qzgseven band", SAME(title));
        expect(await m3uMatch("qzgseven band", title)).toBe(lowest("seven"));
    });
});

describe("a word boundary is any character that is not a letter or digit", () => {
    // The stored name holds the source's word next to punctuation, with or without a space.
    it.each([
        ["slash", "qzislash/other", "Qzislash"],
        ["comma", "qzjcomma, other", "Qzjcomma"],
        ["parenthesis", "(qzkparen)", "Qzkparen"],
        ["leading slash", "x/qzlslash", "Qzlslash"],
    ])("an artist stored as %s is offered to the matcher", async (key, stored, source) => {
        const title = `${P} ${key} wanted`;
        const id = await seedOne(`b-${key.replace(" ", "-")}`, stored, title);
        expect(await previewMatch(source, title)).toBe(id);
        expect(await m3uMatch(source, title)).toBe(id);
    });

    it("a word inside a longer word is not offered", async () => {
        const title = `${P} mother wanted`;
        await seedOne("b-mother", "mother qzpband", title);
        expect(await previewMatch("The Qzpband", title)).toBeNull();
        expect(await m3uMatch("The Qzpband", title)).toBeNull();
    });

    it("a word with a regex metacharacter matches only itself", async () => {
        const wanted = "lorem dot alpha";
        const decoy = "zebra dash omega";
        const id = await seedOne("b-dot", "qzq.x band", wanted);
        await seedOne("b-dash", "qzq-x band", decoy);
        expect(await previewMatch("Qzq.x", wanted)).toBe(id);
        expect(await previewMatch("Qzq.x", decoy)).toBeNull();
        expect(await m3uMatch("Qzq.x", decoy)).toBeNull();
    });

    it("a word ending in plus signs is a word, not a quantifier", async () => {
        const wanted = `${P} plus wanted`;
        const decoy = `${P} plain decoy`;
        const id = await seedOne("b-plus", "qzr++ band", wanted);
        await seedOne("b-plain", "qzr band", decoy);
        expect(await previewMatch("Qzr++", wanted)).toBe(id);
        expect(await previewMatch("Qzr++", decoy)).toBeNull();
    });
});

describe("a word held by more artists than a query can carry ids for", () => {
    const ARTISTS = 32_800; // past Postgres's limit of 32767 bind parameters
    const SONGS = 60;
    const songId = (n: number) => `${P}-wide-${String(n).padStart(5, "0")}`;
    const wanted = "wide wanted";
    const tie = "wide tie";
    const titleOf = (n: number) => (n === 50 ? wanted : n === 5 || n === SONGS - 1 ? tie : `lorem ipsum ${n}`);

    beforeAll(async () => {
        await prisma.artist.createMany({
            data: Array.from({ length: ARTISTS }, (_, n) => ({
                name: `qzwide ${n}`, normalizedName: `qzwide ${n}`, identityKey: `${P}-wide-artist-${n}`,
            })),
        });
        const artist = await prisma.artist.create({
            data: { name: "qzwide band", normalizedName: "qzwide band", identityKey: `${P}-wide-band` },
        });
        const album = await prisma.album.create({
            data: { rgMbid: `${P}-wide-rg`, identityKey: `${P}-wide-album`, primaryType: "Album", title: `${P} wide album`, artistId: artist.id, location: "LIBRARY" },
        });
        await prisma.track.createMany({
            data: Array.from({ length: SONGS }, (_, n) => ({
                id: songId(n), title: titleOf(n), albumId: album.id, trackNo: n + 1, duration: 100,
                filePath: `/${P}/wide/${songId(n)}.flac`, fileModified: new Date(), fileSize: 1,
            })),
        });
        // Autovacuum has not seen 33000 new rows yet; the planner would still think the tables are empty.
        for (const table of ["Artist", "Album", "Track"]) await prisma.$executeRawUnsafe(`ANALYZE "${table}"`);
    });

    it("the preview still finds a song", async () => {
        expect(await previewMatch("Qzwide", wanted)).toBe(songId(50));
    });

    it("the M3U fuzzy tier still finds it", async () => {
        expect(await m3uMatch("Qzwide Band", wanted)).toBe(songId(50));
    });

    it("the lowest id wins a tie", async () => {
        expect(await previewMatch("Qzwide", tie)).toBe(songId(5));
    });

    // The chunk size is passed in (a small one) rather than seeding past 10000 songs.
    it("loads the songs in chunks of at most the chunk size, in id order across chunks", async () => {
        const load = jest.spyOn(prisma.track, "findMany");
        try {
            const songs = await songsOfArtistsHoldingWord("qzwide", {}, [], 7);
            const asked = load.mock.calls.map(([args]) => (args?.where?.id as { in: string[] }).in);
            expect(asked.length).toBe(Math.ceil(SONGS / 7));
            expect(Math.max(...asked.map((ids) => ids.length))).toBe(7);
            expect(songs.map((s) => s.id)).toEqual(Array.from({ length: SONGS }, (_, n) => songId(n)));
        } finally {
            load.mockRestore();
        }
    });
});

describe("a credit whose first word is short still reaches the matcher through the credit sweep", () => {
    it("\"DJ ...\" finds an artist that holds dj", async () => {
        const title = `${P} dj wanted`;
        // The primary "DJ Qzsw" has a first word under the minimum (sweep 1 skips it) and starts no stored name
        // (sweep 2 finds nothing); only the full credit's first word, "dj", reaches this artist.
        const id = await seedOne("c-dj", "the dj qzsw", title);
        expect(await previewMatch("DJ Qzsw feat. Someone", title)).toBe(id);
    });
});

describe("an artist whose shown name holds the word, and whose stored name does not, reaches the matcher", () => {
    // The source artist is never the shown name exactly (the exact-name pass would find that), so each song is
    // found only by the sweep under test.
    it("through the first-word sweep", async () => {
        const title = `${P} shown first`;
        const id = await seedOne("sh-1", "zzstored one", title, undefined, "The Qzone Band");
        expect(await previewMatch("Qzone", title)).toBe(id);
    });

    it("through the five-letter prefix sweep", async () => {
        const title = `${P} shown prefix`;
        const id = await seedOne("sh-2", "zzstored two", title, undefined, "Qztwooo");
        expect(await previewMatch("Qztwoo", title)).toBe(id);
    });

    it("through the credit sweep", async () => {
        const title = `${P} shown credit`;
        const id = await seedOne("sh-3", "zzstored three", title, undefined, "The DJ Qzthree");
        expect(await previewMatch("DJ Qzthree feat. Someone", title)).toBe(id);
    });

    it("through the M3U fuzzy tier", async () => {
        const title = `${P} shown m3u`;
        const id = await seedOne("sh-4", "zzstored four", title, undefined, "Qzfour Alpha Band");
        expect(await m3uMatch("Qzfour Alpha", title)).toBe(id);
    });
});

describe("the five-letter prefix sweep needs three characters", () => {
    it("a two-character source artist does not read every artist that starts with them", async () => {
        const title = `${P} short wanted`;
        await seedOne("s-short", "qysweep band", title);
        expect(await previewMatch("Qy", title)).toBeNull();
    });

    it("a two-character source artist still matches the artist of that name", async () => {
        const title = `${P} short exact`;
        const id = await seedOne("s-exact", "qx", title);
        expect(await previewMatch("Qx", title)).toBe(id);
    });
});

describe("an M3U filename match agrees with the entry", () => {
    const file = (dir: string, name: string) => `/${P}/${dir}/${name}.flac`;

    it("a same-named file by an unrelated artist is not matched, and the right one is", async () => {
        const title = `${P} tier two song`;
        // The unrelated file is created first, so it has the lower id.
        await seedOne("t-other", "qzsother artist", `${P} unrelated song`, file("t-other", "qzs-same-name"));
        const right = await seedOne("t-right", "qzsone artist", title, file("t-right", "qzs-same-name"));
        expect(await m3uMatch("qzsone artist", title, `/nowhere/qzs-same-name.flac`)).toBe(right);
    });

    it("a file only an unrelated artist has is not matched", async () => {
        await seedOne("t-only", "qztonly artist", `${P} only song`, file("t-only", "qzt-only-name"));
        expect(await m3uMatch("qzsnobody", `${P} nothing here`, `/nowhere/qzt-only-name.flac`)).toBeNull();
    });

    it("an entry with no artist or title still matches by filename", async () => {
        const id = await seedOne("t-bare", "qzubare artist", `${P} bare song`, file("t-bare", "qzu-bare-name"));
        expect(await m3uMatch(null, null, `/nowhere/qzu-bare-name.flac`)).toBe(id);
    });

    it("a matching title is not enough when the entry names an artist that differs, but is when it names no artist", async () => {
        const title = `${P} title agrees`;
        const id = await seedOne("t-title", "qzvtitle artist", title, file("t-title", "qzv-title-name"));
        expect(await m3uMatch("qzvwrong artist", title, `/nowhere/qzv-title-name.flac`)).toBeNull();
        expect(await m3uMatch(null, title, `/nowhere/qzv-title-name.flac`)).toBe(id);
    });
});
