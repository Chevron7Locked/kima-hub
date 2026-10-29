/**
 * The day's seeded draws made in the database (seededTrackIds, seededKeySql) against the same draws made in memory
 * (drawIds, seededOrder) on a real Postgres. Each mix that draws in the database is checked against the draw its
 * filter, read through Prisma, gives in memory, so the SQL filters are proven to pick the same songs. The library
 * has twelve artists; the mixes with the per-artist cap (all but Rediscover) are checked against that draw capped at 2 per
 * artist, worked out here.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../../../utils/db";
import { getEffectiveDecadeWhereClause } from "../../../utils/dateFilters";
import { NOT_MISSING } from "../../../utils/libraryEligibility";
import { drawIds, getSeededRandom, sampledMix, seededOrder, seededTrackIds, unplayedTrackIds } from "../helpers";
import { generateRandomDiscoveryMix, generateRediscoverMix } from "../discoveryMixes";
import {
    generateDeepCuts,
    generateKeyJourney,
    generateMinorKeyMix,
    generateTempoFlow,
    generateVocalDetox,
} from "../moodMixes";
import { generateEraMix, generateGenreMix } from "../genreMixes";
import { STEADY_BEAT } from "../recipes";

jest.setTimeout(120_000);

const PREFIX = "sdr_";
const TRACKS = 600;
const ALBUMS = 50;
const USER = `${PREFIX}user`;
const OTHER = `${PREFIX}other`;
// A Monday, so Minor Key Mondays runs.
const DAY = "2026-10-19";
const KEYS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const ARTISTS = 12;
/** The decades this library offers a decade mix (worked out once from the fixture, checked against the rule below). */
const PINNED_DECADES = [1980, 1990, 2000];
const tid = (i: number) => `${PREFIX}trk_${String(i).padStart(4, "0")}`;
const mine = Prisma.sql`t.id LIKE ${`${PREFIX}%`}`;

/** A fixed pseudo-random number in [0, 1) for song i and a salt. */
function u(i: number, salt: number): number {
    let x = (i * 2654435761 + salt * 40503) >>> 0;
    x ^= x >>> 15;
    x = Math.imul(x, 2246822519) >>> 0;
    x ^= x >>> 13;
    return (x >>> 0) / 4294967296;
}

async function cleanup() {
    await prisma.play.deleteMany({ where: { userId: { startsWith: PREFIX } } });
    await prisma.track.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.genre.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { id: { startsWith: PREFIX } } });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.createMany({ data: [USER, OTHER].map((id) => ({ id, username: id, passwordHash: "x" })) });
    await prisma.artist.createMany({
        data: Array.from({ length: ARTISTS }, (_, a) => ({ id: `${PREFIX}art_${a}`, name: `Seed Artist ${a}`, identityKey: `${PREFIX}ak_${a}` })),
    });
    await prisma.album.createMany({
        data: Array.from({ length: ALBUMS }, (_, b) => ({
            id: `${PREFIX}alb_${b}`, rgMbid: `${PREFIX}rg_${b}`, artistId: `${PREFIX}art_${b % ARTISTS}`, identityKey: `${PREFIX}ik_${b}`,
            title: `Seed Album ${b}`, primaryType: "Album",
            // Every combination of the three years the effective year reads, across decades.
            displayYear: b % 4 === 0 ? 1980 + (b % 3) * 10 : null,
            originalYear: b % 3 === 0 ? 1990 + (b % 2) * 10 : null,
            year: 1975 + ((b * 7) % 40),
            location: b % 10 === 9 ? "DISCOVER" : "LIBRARY",
        })),
    });
    await prisma.genre.createMany({ data: [0, 1].map((g) => ({ id: `${PREFIX}gen_${g}`, name: `${PREFIX}Genre ${g}` })) });
    await prisma.track.createMany({
        data: Array.from({ length: TRACKS }, (_, i) => ({
            id: tid(i), albumId: `${PREFIX}alb_${i % ALBUMS}`, title: `Seed Track ${i}`, trackNo: 1, duration: 200,
            filePath: `/tmp/${tid(i)}.flac`, fileModified: new Date(), fileSize: 1000,
            missingSince: u(i, 1) < 0.08 ? new Date() : null,
            analysisStatus: u(i, 2) < 0.1 ? "pending" : "completed",
            key: u(i, 3) < 0.1 ? null : KEYS[Math.floor(u(i, 4) * KEYS.length)],
            bpm: u(i, 5) < 0.1 ? null : 60 + Math.round(u(i, 6) * 1200) / 10,
            bpmConfidence: u(i, 7) < 0.15 ? null : Math.round(u(i, 8) * 4000) / 1000,
            instrumentalness: u(i, 9) < 0.1 ? null : u(i, 10),
            keyScale: u(i, 11) < 0.1 ? null : u(i, 12) < 0.45 ? "minor" : "major",
            arousal: u(i, 13) < 0.1 ? null : u(i, 14),
        })),
    });
    await prisma.trackGenre.createMany({
        data: Array.from({ length: TRACKS }, (_, i) => i)
            .filter((i) => u(i, 15) < 0.4)
            .map((i) => ({ trackId: tid(i), genreId: `${PREFIX}gen_${u(i, 16) < 0.6 ? 0 : 1}` })),
    });
    // This listener: a third of the songs played 1 to 4 times; someone else plays another third.
    const plays: { id: string; userId: string; trackId: string }[] = [];
    for (let i = 0; i < TRACKS; i++) {
        const n = u(i, 17) < 0.33 ? 1 + Math.floor(u(i, 18) * 4) : 0;
        for (let k = 0; k < n; k++) plays.push({ id: `${PREFIX}p_${i}_${k}`, userId: USER, trackId: tid(i) });
        if (u(i, 19) < 0.33) plays.push({ id: `${PREFIX}q_${i}`, userId: OTHER, trackId: tid(i) });
    }
    await prisma.play.createMany({ data: plays });
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

/**
 * The ids of this file's library songs matching a Prisma filter.
 * Library songs only: Discover songs live only in Discover.
 */
async function idsWhere(where: Prisma.TrackWhereInput): Promise<string[]> {
    const rows = await prisma.track.findMany({
        where: { AND: [where, { id: { startsWith: PREFIX } }, { album: { location: "LIBRARY" } }] },
        select: { id: true },
    });
    return rows.map((r) => r.id);
}

/**
 * The first `limit` of `ordered` at most 2 per album artist; while that leaves fewer than 8, 3, then no cap: the mixes'
 * cap (mixes/artistCap.ts), written out here.
 */
async function capped(ordered: string[], limit = 20): Promise<string[]> {
    const rows = await prisma.track.findMany({ where: { id: { in: ordered } }, select: { id: true, album: { select: { artistId: true } } } });
    const artistOf = new Map(rows.map((r) => [r.id, r.album.artistId]));
    for (const cap of [2, 3, Infinity]) {
        const taken = new Map<string, number>();
        const picked: string[] = [];
        for (const id of ordered) {
            if (picked.length === limit) break;
            const n = taken.get(artistOf.get(id)!) ?? 0;
            if (n >= cap) continue;
            taken.set(artistOf.get(id)!, n + 1);
            picked.push(id);
        }
        if (picked.length >= Math.min(limit, 8)) return picked;
    }
    return [];
}

describe("the database draw and the in-memory draw", () => {
    it("pick the same songs in the same order, for any seed and size", async () => {
        const every = await idsWhere(NOT_MISSING);
        expect(every.length).toBeGreaterThan(500);
        for (const seed of [1, 42, 123456789, getSeededRandom(`rediscover-${DAY}`)]) {
            for (const take of [1, 20, 200, TRACKS]) {
                const inDatabase = await seededTrackIds(mine, take, seed);
                expect(inDatabase).toEqual(drawIds(every, take, seed));
                expect(inDatabase).toEqual(seededOrder(every, seed, (id) => id).slice(0, take));
            }
        }
    });

    it("keep the other 19 songs, in order, when one picked song leaves", async () => {
        const day = await seededTrackIds(mine, 20, 42);
        await prisma.track.update({ where: { id: day[7] }, data: { missingSince: new Date() } });
        try {
            const after = await seededTrackIds(mine, 20, 42);
            expect(after.slice(0, 19)).toEqual(day.filter((id) => id !== day[7]));
            expect(after).not.toContain(day[7]);
        } finally {
            await prisma.track.update({ where: { id: day[7] }, data: { missingSince: null } });
        }
    });

    it("repeat for one seed and differ between seeds", async () => {
        const a = await seededTrackIds(mine, 30, 11);
        expect(await seededTrackIds(mine, 30, 11)).toEqual(a);
        expect(await seededTrackIds(mine, 30, 12)).not.toEqual(a);
    });

    it("refuse a take that is not a positive integer", async () => {
        for (const take of [0, -5, 2.5, NaN]) await expect(seededTrackIds(mine, take, 1)).rejects.toThrow(RangeError);
    });
});

describe("each mix that draws in the database picks what its Prisma filter picks in memory", () => {
    const seedOf = (name: string) => getSeededRandom(name);

    it("Rediscover: this listener's songs played two times or fewer, in the library", async () => {
        const counts = await prisma.track.findMany({
            where: { ...NOT_MISSING, album: { location: "LIBRARY" }, id: { startsWith: PREFIX } },
            select: { id: true, _count: { select: { plays: { where: { userId: USER } } } } },
        });
        const underplayed = counts.filter((t) => t._count.plays <= 2).map((t) => t.id);
        const mix = await generateRediscoverMix(USER, DAY);
        expect(mix?.trackIds).toEqual(drawIds(underplayed, 200, seedOf(`rediscover-${DAY}`)).slice(0, 20));
    });

    it("Deep Cuts: songs nobody has played, and songs played three times or fewer when too few are", async () => {
        const seed = seedOf(`deep-cuts-${DAY}`);
        const unplayed = (await unplayedTrackIds({ excludeMissing: true })).filter((id) => id.startsWith(PREFIX));
        expect((await generateDeepCuts(USER, DAY))?.trackIds).toEqual(await capped(drawIds(unplayed, unplayed.length, seed)));

        // Everyone has played every song once more: nobody's songs are unplayed, the low-play songs are drawn.
        await prisma.play.createMany({ data: unplayed.map((id) => ({ id: `${PREFIX}x_${id}`, userId: OTHER, trackId: id })) });
        try {
            const counts = await prisma.track.findMany({
                where: { ...NOT_MISSING, id: { startsWith: PREFIX }, album: { location: "LIBRARY" } },
                select: { id: true, _count: { select: { plays: true } } },
            });
            const lowPlay = counts.filter((t) => t._count.plays <= 3).map((t) => t.id);
            expect((await generateDeepCuts(USER, DAY))?.trackIds).toEqual(await capped(drawIds(lowPlay, lowPlay.length, seed)));
        } finally {
            await prisma.play.deleteMany({ where: { id: { startsWith: `${PREFIX}x_` } } });
        }
    });

    it("Random Discovery: the songs of the day's first album by each of ten artists, at 2 per artist", async () => {
        const albums = await prisma.album.findMany({
            where: { location: "LIBRARY", tracks: { some: NOT_MISSING }, id: { startsWith: PREFIX } },
            select: { id: true, artistId: true },
        });
        const seen = new Set<string>();
        const picked = seededOrder(albums, seedOf(`random-${DAY}`), (a) => a.id)
            .filter((a) => !seen.has(a.artistId) && seen.add(a.artistId))
            .slice(0, 10)
            .map((a) => a.id);
        expect(picked).toHaveLength(10);
        const songs = await idsWhere({ ...NOT_MISSING, albumId: { in: picked } });
        const mix = await generateRandomDiscoveryMix(USER, DAY);
        expect(mix?.trackIds).toEqual(await capped(seededOrder(songs, seedOf(`random-discovery-${DAY}`), (id) => id)));
        expect(mix?.trackIds).toHaveLength(20);
    });

    it("Vocal Detox: the analysed instrumental songs", async () => {
        const matching = await idsWhere({ ...NOT_MISSING, analysisStatus: "completed", instrumentalness: { gte: 0.75 } });
        expect((await generateVocalDetox(USER, DAY))?.trackIds).toEqual(await capped(drawIds(matching, matching.length, seedOf(`vocal-detox-${DAY}`))));
    });

    it("Minor Key Mondays: analysed minor songs at or above the library's median felt energy", async () => {
        const [{ median }] = await prisma.$queryRaw<Array<{ median: number }>>`
            SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY arousal) AS median
            FROM "Track" t JOIN "Album" a ON a.id = t."albumId"
            WHERE t."missingSince" IS NULL AND t."analysisStatus" = 'completed' AND t.arousal IS NOT NULL
              AND a.location = 'LIBRARY'`;
        const matching = await idsWhere({ ...NOT_MISSING, analysisStatus: "completed", keyScale: "minor", arousal: { gte: median } });
        expect((await generateMinorKeyMix(USER, DAY))?.trackIds).toEqual(await capped(drawIds(matching, matching.length, seedOf(`minor-key-${DAY}`))));
    });

    it("Era: the decade by the album's display year, then original year, then year, on every decade it picks", async () => {
        const decades = new Set<number>();
        for (let d = 1; d <= 40; d++) {
            const day = `2026-11-${String(((d - 1) % 30) + 1).padStart(2, "0")}`;
            const mix = await generateEraMix(USER, d <= 30 ? day : `2026-12-${String(d - 30).padStart(2, "0")}`);
            const decade = Number(/^era-(\d+)-/.exec(mix!.id)![1]);
            decades.add(decade);
            const matching = await idsWhere({ ...NOT_MISSING, album: getEffectiveDecadeWhereClause(decade) });
            expect(mix!.trackIds).toEqual(await capped(drawIds(matching, matching.length, seedOf(mix!.id))));
        }
        // A decade is offered when it has 15 songs and its artists can fill 8 songs at 2 each; worked out here from every
        // library song. Every decade picked is one of those, and the 40 days reach several.
        const tracks = await prisma.track.findMany({
            where: { ...NOT_MISSING, album: { location: "LIBRARY" } },
            select: { album: { select: { artistId: true, displayYear: true, originalYear: true, year: true } } },
        });
        const perDecade = new Map<number, Map<string, number>>();
        for (const { album } of tracks) {
            const year = album.displayYear ?? album.originalYear ?? album.year;
            if (!year) continue;
            const decade = Math.floor(year / 10) * 10;
            const artists = perDecade.get(decade) ?? new Map<string, number>();
            artists.set(album.artistId, (artists.get(album.artistId) ?? 0) + 1);
            perDecade.set(decade, artists);
        }
        const reach = (decade: number) => [...(perDecade.get(decade)?.values() ?? [])].reduce((sum, n) => sum + Math.min(n, 2), 0);
        const songs = (decade: number) => [...(perDecade.get(decade)?.values() ?? [])].reduce((sum, n) => sum + n, 0);
        const offered = new Set([...perDecade.keys()].filter((d) => songs(d) >= 15 && reach(d) >= 8));
        expect(decades).toEqual(offered);
        // This library: the 1970s and 2010s songs are by too few artists for 8 at 2 each, and are never picked. The 1980s
        // and 1990s are where the display and original years disagree on some albums.
        expect(decades).toEqual(new Set(PINNED_DECADES));
        for (const thin of [1970, 2010]) expect([thin, songs(thin) > 0, reach(thin) < 8]).toEqual([thin, true, true]);
    });

    it("Genre: the songs of the day's genre", async () => {
        const mix = await generateGenreMix(USER, DAY);
        const genre = /^genre-(.+)-\d{4}-\d{2}-\d{2}$/.exec(mix!.id)![1];
        const matching = await idsWhere({ ...NOT_MISSING, trackGenres: { some: { genreId: genre } } });
        expect(mix!.trackIds).toEqual(await capped(drawIds(matching, matching.length, seedOf(`genre-${genre}-${DAY}`))));
    });

    it("Key Journey and Tempo Flow: every song from the day's draw of their Prisma filters", async () => {
        const keyed = await idsWhere({ ...NOT_MISSING, analysisStatus: "completed", key: { not: null } });
        const keyDraw = new Set(drawIds(keyed, 200, seedOf(`key-journey-${DAY}`)));
        const journey = await generateKeyJourney(USER, DAY);
        expect(journey?.trackIds.length).toBeGreaterThanOrEqual(15);
        expect(journey!.trackIds.filter((id) => !keyDraw.has(id))).toEqual([]);

        const steady = await idsWhere({ ...NOT_MISSING, analysisStatus: "completed", bpm: { not: null }, bpmConfidence: { gte: STEADY_BEAT } });
        const tempoDraw = new Set(drawIds(steady, 200, seedOf(`tempo-flow-${DAY}`)));
        const flow = await generateTempoFlow(USER, DAY);
        expect(flow?.trackIds.length).toBeGreaterThanOrEqual(15);
        expect(flow!.trackIds.filter((id) => !tempoDraw.has(id))).toEqual([]);
    });
});

describe("sampledMix", () => {
    const spec = { id: "m", type: "t", name: "n", description: "d", colorType: "default", seed: 5 };
    const only = (ids: string[]) => Prisma.sql`t.id IN (${Prisma.join(ids)})`;

    it("is `limit` songs when `take` or more match, the first of the day's draw at 2 per artist", async () => {
        const mix = await sampledMix({ ...spec, where: mine, minTracks: 8, limit: 10 });
        expect(mix?.trackIds).toEqual(await capped(await seededTrackIds(mine, TRACKS, 5), 10));
        expect(mix?.trackCount).toBe(10);
    });

    it("is null when fewer than minTracks match, and every match when fewer than `limit` do", async () => {
        const nine = await seededTrackIds(mine, 9, 77);
        expect(await sampledMix({ ...spec, where: only(nine.slice(0, 7)), minTracks: 8, limit: 10 })).toBeNull();
        const mix = await sampledMix({ ...spec, where: only(nine), minTracks: 8, limit: 10 });
        expect(new Set(mix?.trackIds)).toEqual(new Set(nine));
    });
});
