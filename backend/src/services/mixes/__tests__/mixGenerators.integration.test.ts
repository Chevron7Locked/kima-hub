/**
 * Every exported mix generator, run against a real Postgres holding a 3,000
 * track synthetic library (see src/__tests__/fixtures/syntheticLibrary.ts;
 * ids are handed out in energy order, so reading "the first N rows" would show
 * as ids bunched at the front).
 *
 * For each generator, over 40 different dates (or 40 repeated calls where the
 * mix does not take a date), the suite checks:
 *   1. size   - the documented number of tracks, no repeats;
 *   2. clause - every returned track satisfies the clause the generator's
 *               `where` states, re-written here by hand and checked against the
 *               stored row;
 *   3. files  - no track whose file is missing is returned;
 *   4. spread - together the calls reach the first and the last third of the
 *               ids that match, and well beyond one pool;
 *   5. repeat - a seeded mix returns identical tracks for the same date and
 *               different ones for another date; an unseeded one varies.
 *
 * Only the similar-artist lookup (a call to ListenBrainz/Deezer over the
 * network) is faked. The database is real.
 */
import { prisma } from "../../../utils/db";
import {
    LibraryHandle,
    PARTY_GENRES,
    FOCUS_GENRES,
    Row,
    TRACK_COUNT,
    loadRows,
    removeSyntheticLibrary,
    seedSyntheticLibrary,
    spanOf,
} from "../../../__tests__/fixtures/syntheticLibrary";
import type { ProgrammaticMix } from "../helpers";
import * as mood from "../moodMixes";
import * as genre from "../genreMixes";
import * as time from "../timeMixes";
import * as discovery from "../discoveryMixes";

jest.mock("../../artistSimilarity", () => ({
    // The one network call: similar artists. The names are set per test below.
    getSimilarArtists: jest.fn(async () => []),
}));
import { getSimilarArtists } from "../../artistSimilarity";

jest.setTimeout(600_000);

const PREFIX = "mxg_";
const CALLS = 40;

let lib: LibraryHandle;
let rows: Row[];
let byId: Map<string, Row>;

beforeAll(async () => {
    lib = await seedSyntheticLibrary(PREFIX);
    rows = await loadRows(PREFIX, lib.user1);
    byId = new Map(rows.map((r) => [r.id, r]));
});

afterAll(async () => {
    await removeSyntheticLibrary(PREFIX);
    await prisma.$disconnect();
});

// ---- clause vocabulary -----------------------------------------------------

const ge = (x: number | null, v: number) => x !== null && x >= v;
const le = (x: number | null, v: number) => x !== null && x <= v;
const within = (x: number | null, lo: number, hi: number) => x !== null && x >= lo && x <= hi;
const done = (r: Row) => r.analysisStatus === "completed";
const inBucket = (m: string) => (r: Row) => r.buckets.includes(m);
const inGenres = (names: string[]) => (r: Row) => r.genreNames.some((n) => names.includes(n.toLowerCase()));
const tagged = (...tags: string[]) => (r: Row) => r.moodTags.some((t) => tags.includes(t));

const dates = Array.from({ length: CALLS }, (_, k) => new Date(Date.UTC(2026, 0, 1 + k)).toISOString().slice(0, 10));

const NOT_DATE: any[] = [
    "hrtime", "nextTick", "performance", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
    "requestIdleCallback", "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval", "clearInterval",
    "setTimeout", "clearTimeout",
];

/** Run `fn` with the clock's date set to a given weekday (0 = Sunday); only Date is faked. */
async function onWeekday<T>(day: number | undefined, fn: () => Promise<T>): Promise<T> {
    if (day === undefined) return fn();
    // 2026-10-18 is a Sunday.
    jest.useFakeTimers({ doNotFake: NOT_DATE, now: Date.UTC(2026, 9, 18 + day, 12) });
    try {
        return await fn();
    } finally {
        jest.useRealTimers();
    }
}

interface Case {
    name: string;
    size: number;
    run: (today: string) => Promise<ProgrammaticMix | null>;
    /** The clause, by hand. Missing files are checked separately. */
    clause: (r: Row, mix: ProgrammaticMix) => boolean;
    /** True when the track draw is repeatable from the date. */
    seeded: boolean;
    /** Weekday the mix exists on (0 = Sunday); the clock is set to it. */
    day?: number;
    /** "repeat": the clause depends on the date, so call 40 times on one date. */
    spread?: "dates" | "repeat";
    /** The id is a timestamp, not a date, so it is not stable for a date. */
    idIsTimestamp?: boolean;
}

const year = (r: Row) => r.album.originalYear ?? r.album.year;

const cases: Case[] = [
    // ---- mood mixes, seeded ----
    { name: "Chill", size: 20, seeded: true, run: (d) => mood.generateChillMix(lib.user1, d),
      clause: (r) => inBucket("chill")(r) && le(r.energy, 0.55) },
    { name: "High Energy", size: 20, seeded: true, run: (d) => mood.generateHighEnergyMix(lib.user1, d),
      clause: (r) => done(r) && ge(r.energy, 0.7) && ge(r.bpm, 120) },
    { name: "Late Night", size: 20, seeded: true, run: (d) => mood.generateLateNightMix(lib.user1, d),
      clause: (r) => inBucket("chill")(r) && le(r.energy, 0.5) && le(r.bpm, 110) },
    { name: "Happy", size: 20, seeded: true, run: (d) => mood.generateHappyMix(lib.user1, d),
      clause: inBucket("happy") },
    { name: "Melancholy", size: 20, seeded: true, run: (d) => mood.generateMelancholyMix(lib.user1, d),
      clause: inBucket("sad") },
    { name: "Dance Floor", size: 20, seeded: true, run: (d) => mood.generateDanceFloorMix(lib.user1, d),
      clause: (r) => done(r) && ge(r.danceability, 0.7) && within(r.bpm, 110, 140) },
    { name: "Acoustic", size: 20, seeded: true, run: (d) => mood.generateAcousticMix(lib.user1, d),
      clause: (r) => done(r) && ge(r.acousticness, 0.6) && within(r.energy, 0.3, 0.6) },
    { name: "Instrumental", size: 20, seeded: true, run: (d) => mood.generateInstrumentalMix(lib.user1, d),
      clause: (r) => done(r) && ge(r.instrumentalness, 0.7) && within(r.energy, 0.3, 0.6) },
    { name: "Road Trip", size: 20, seeded: true, run: (d) => mood.generateRoadTripMix(lib.user1, d),
      clause: tagged("energetic", "upbeat", "happy") },

    // ---- curated daily mixes (10 tracks), the draw is not seeded ----
    { name: "Sad Girl Sundays", size: 10, seeded: false, day: 0, run: (d) => mood.generateSadGirlSundays(lib.user1, d),
      clause: (r) => done(r) && ((le(r.valence, 0.35) && r.keyScale === "minor") || (le(r.valence, 0.3) && le(r.arousal, 0.4))) },
    { name: "Main Character Energy", size: 10, seeded: false, run: (d) => mood.generateMainCharacterEnergy(lib.user1, d),
      clause: (r) => done(r) && ge(r.valence, 0.55) && ge(r.energy, 0.55) && ge(r.danceability, 0.5) },
    { name: "Villain Era", size: 10, seeded: false, run: (d) => mood.generateVillainEra(lib.user1, d),
      clause: (r) => done(r) && ((r.keyScale === "minor" && ge(r.energy, 0.65)) || tagged("aggressive", "dark", "intense")(r)) },
    { name: "3AM Thoughts", size: 10, seeded: false, run: (d) => mood.generate3AMThoughts(lib.user1, d),
      clause: (r) => done(r) && le(r.arousal, 0.4) && le(r.energy, 0.5) && le(r.bpm, 110) && (le(r.valence, 0.5) || ge(r.acousticness, 0.3)) },
    { name: "Hot Girl Walk", size: 10, seeded: false, run: (d) => mood.generateHotGirlWalk(lib.user1, d),
      clause: (r) => done(r) && ((ge(r.danceability, 0.65) && within(r.bpm, 95, 135) && ge(r.energy, 0.55)) || (ge(r.valence, 0.6) && ge(r.energy, 0.6))) },
    { name: "Rage Cleaning", size: 10, seeded: false, run: (d) => mood.generateRageCleaning(lib.user1, d),
      clause: (r) => done(r) && ((ge(r.energy, 0.75) && ge(r.arousal, 0.65) && ge(r.bpm, 125)) || (ge(r.energy, 0.8) && ge(r.danceability, 0.6)) || tagged("aggressive", "energetic")(r)) },
    { name: "Golden Hour", size: 10, seeded: false, run: (d) => mood.generateGoldenHour(lib.user1, d),
      clause: (r) => done(r) && ge(r.valence, 0.45) && ge(r.acousticness, 0.35) && within(r.energy, 0.25, 0.65) },
    { name: "Shower Karaoke", size: 10, seeded: false, run: (d) => mood.generateShowerKaraoke(lib.user1, d),
      clause: (r) => done(r) && le(r.instrumentalness, 0.35) && ge(r.energy, 0.55) && ge(r.valence, 0.45) },
    { name: "In My Feelings", size: 10, seeded: false, run: (d) => mood.generateInMyFeelings(lib.user1, d),
      clause: (r) => done(r) && le(r.valence, 0.4) && le(r.arousal, 0.55) && ge(r.acousticness, 0.25) },
    { name: "Midnight Drive", size: 10, seeded: false, run: (d) => mood.generateMidnightDrive(lib.user1, d),
      clause: (r) => done(r) && within(r.energy, 0.3, 0.65) && within(r.bpm, 80, 130) && (le(r.arousal, 0.6) || within(r.valence, 0.3, 0.7)) },
    { name: "Coffee Shop Vibes", size: 10, seeded: false, run: (d) => mood.generateCoffeeShopVibes(lib.user1, d),
      clause: (r) => done(r) && le(r.energy, 0.55) && le(r.bpm, 120) && (ge(r.acousticness, 0.35) || ge(r.instrumentalness, 0.25)) },
    { name: "Romanticize Your Life", size: 10, seeded: false, run: (d) => mood.generateRomanticizeYourLife(lib.user1, d),
      clause: (r) => done(r) && within(r.valence, 0.35, 0.75) && within(r.arousal, 0.25, 0.65) && ge(r.acousticness, 0.25) },
    { name: "That Girl Era", size: 10, seeded: false, run: (d) => mood.generateThatGirlEra(lib.user1, d),
      clause: (r) => done(r) && ge(r.valence, 0.55) && ge(r.energy, 0.45) && ge(r.danceability, 0.45) },
    { name: "Unhinged", size: 10, seeded: false, run: (d) => mood.generateUnhinged(lib.user1, d),
      clause: (r) => done(r) && (ge(r.energy, 0.85) || le(r.energy, 0.15) || ge(r.valence, 0.9) || le(r.valence, 0.1) || ge(r.bpm, 160) || le(r.bpm, 70) || ge(r.danceability, 0.9)) },

    // ---- weekly mixes (20 tracks) ----
    { name: "Deep Cuts", size: 20, seeded: false, run: (d) => mood.generateDeepCuts(lib.user1, d),
      clause: (r) => r.plays === 0 },
    { name: "Key Journey", size: 20, seeded: true, run: (d) => mood.generateKeyJourney(lib.user1, d),
      clause: (r) => done(r) && r.key !== null },
    { name: "Tempo Flow", size: 20, seeded: false, run: (d) => mood.generateTempoFlow(lib.user1, d),
      clause: (r) => done(r) && r.bpm !== null },
    { name: "Vocal Detox", size: 20, seeded: false, run: (d) => mood.generateVocalDetox(lib.user1, d),
      clause: (r) => done(r) && ge(r.instrumentalness, 0.75) },
    { name: "Minor Key Mondays", size: 20, seeded: false, day: 1, run: (d) => mood.generateMinorKeyMix(lib.user1, d),
      clause: (r) => done(r) && r.keyScale === "minor" && ge(r.energy, 0.45) },

    // ---- genre mixes ----
    { name: "Era (decade)", size: 20, seeded: false, spread: "repeat", run: (d) => genre.generateEraMix(lib.user1, d),
      clause: (r, mix) => {
          const decade = Number(/^era-(\d+)-/.exec(mix.id)![1]);
          const y = year(r);
          return y !== null && y >= decade && y < decade + 10;
      } },
    { name: "Genre", size: 20, seeded: false, spread: "repeat", run: (d) => genre.generateGenreMix(lib.user1, d),
      clause: (r, mix) => r.genreIds.includes(/^genre-(.+)-\d{4}-\d{2}-\d{2}$/.exec(mix.id)![1]) },
    { name: "Party", size: 20, seeded: true, run: (d) => genre.generatePartyMix(lib.user1, d),
      clause: inGenres(PARTY_GENRES) },
    { name: "Workout", size: 20, seeded: true, run: (d) => genre.generateWorkoutMix(lib.user1, d),
      clause: (r) => done(r) && r.analysisMode === "enhanced" && ge(r.arousal, 0.6) && ge(r.energy, 0.6) && ge(r.bpm, 110) },
    { name: "Focus", size: 20, seeded: true, run: (d) => genre.generateFocusMix(lib.user1, d),
      clause: inGenres(FOCUS_GENRES) },

    // ---- day-of-week mix: three days have one ----
    { name: "Day mix, Sunday", size: 20, seeded: false, day: 0, run: () => time.generateDayMix(lib.user1),
      clause: (r) => done(r) && le(r.energy, 0.5) && ge(r.acousticness, 0.5) },
    { name: "Day mix, Monday", size: 20, seeded: false, day: 1, run: () => time.generateDayMix(lib.user1),
      clause: (r) => done(r) && ge(r.energy, 0.6) && ge(r.valence, 0.5) },
    { name: "Day mix, Friday", size: 20, seeded: false, day: 5, run: () => time.generateDayMix(lib.user1),
      clause: (r) => done(r) && ge(r.danceability, 0.7) && ge(r.energy, 0.6) },

    // ---- discovery mixes ----
    { name: "Rediscover", size: 20, seeded: true, run: (d) => discovery.generateRediscoverMix(lib.user1, d),
      clause: (r) => r.album.location === "LIBRARY" && r.playsUser1 <= 2 },
    { name: "Artist Similar", size: 20, seeded: false, spread: "repeat", run: () => discovery.generateArtistSimilarMix(lib.user1),
      clause: (r) => SIMILAR.includes(r.album.artist.normalizedName) },
    { name: "Mood on demand, happy bucket", size: 15, seeded: false, spread: "repeat", idIsTimestamp: true,
      run: () => mood.generateMoodOnDemand(lib.user1, { mood: "happy" }),
      clause: (r) => done(r) && inBucket("happy")(r) },
    { name: "Mood on demand, legacy moodSad param", size: 15, seeded: false, spread: "repeat", idIsTimestamp: true,
      run: () => mood.generateMoodOnDemand(lib.user1, { moodSad: { min: 0.5 } } as any),
      clause: (r) => done(r) && inBucket("sad")(r) },
    { name: "Mood on demand, ranges", size: 20, seeded: false, spread: "repeat", idIsTimestamp: true,
      run: () => mood.generateMoodOnDemand(lib.user1, { valence: { min: 0.6 }, energy: { min: 0.3, max: 0.5 }, limit: 20 }),
      clause: (r) => done(r) && ge(r.valence, 0.6) && within(r.energy, 0.3, 0.5) },
    { name: "Mood on demand, party bucket + ranges + key", size: 15, seeded: false, spread: "repeat", idIsTimestamp: true,
      run: () => mood.generateMoodOnDemand(lib.user1, {
          mood: "party", danceability: { min: 0.5 }, keyScale: "minor", bpm: { min: 80, max: 170 }, arousal: { max: 0.8 },
      }),
      clause: (r) => done(r) && inBucket("party")(r) && ge(r.danceability, 0.5) && r.keyScale === "minor" && within(r.bpm, 80, 170) && le(r.arousal, 0.8) },
    { name: "Mood on demand, acousticness and instrumentalness", size: 15, seeded: false, spread: "repeat", idIsTimestamp: true,
      run: () => mood.generateMoodOnDemand(lib.user1, { acousticness: { min: 0.7 }, instrumentalness: { max: 0.3 } }),
      clause: (r) => done(r) && ge(r.acousticness, 0.7) && le(r.instrumentalness, 0.3) },
];

/** Names of the artists the faked similarity lookup returns: artists 10 to 17. */
const SIMILAR = Array.from({ length: 8 }, (_, i) => `synthetic artist ${10 + i}`);

beforeEach(() => {
    (getSimilarArtists as jest.Mock).mockImplementation(async () =>
        SIMILAR.map((name) => ({ name, mbid: null, match: 0.5 })),
    );
});

describe.each(cases)("$name", (c) => {
    let mixes: ProgrammaticMix[] = [];
    let callDates: string[] = [];

    beforeAll(async () => {
        (getSimilarArtists as jest.Mock).mockImplementation(async () =>
            SIMILAR.map((name) => ({ name, mbid: null, match: 0.5 })),
        );
        callDates = c.spread === "repeat" ? Array(CALLS).fill(dates[0]) : dates;
        mixes = [];
        for (const d of callDates) {
            const mix = await onWeekday(c.day, () => c.run(d));
            if (mix) mixes.push(mix);
        }
    });

    const matching = () =>
        rows.filter((r) => !r.missingSince && c.clause(r, mixes[0])).map((r) => r.id);

    it("returns a mix of the documented size, with no repeated track", () => {
        expect(mixes).toHaveLength(callDates.length);
        for (const mix of mixes) {
            expect(mix.trackIds).toHaveLength(c.size);
            expect(new Set(mix.trackIds).size).toBe(c.size);
            expect(mix.trackCount).toBe(c.size);
            expect(mix.trackIds.every((id) => byId.has(id))).toBe(true);
        }
    });

    it("returns only tracks that satisfy the clause", () => {
        expect(matching().length).toBeGreaterThanOrEqual(c.size * 5);
        const bad = mixes.flatMap((mix) => mix.trackIds.filter((id) => !c.clause(byId.get(id)!, mix)));
        expect(bad).toEqual([]);
    });

    it("never returns a track whose file is missing", () => {
        const missing = mixes.flatMap((mix) => mix.trackIds.filter((id) => byId.get(id)!.missingSince !== null));
        expect(missing).toEqual([]);
    });

    it("draws from the whole match, not the first rows", () => {
        const match = matching();
        const span = spanOf(mixes.flatMap((m) => m.trackIds), match);
        // Tracks outside the clause are the clause test's business.
        expect(span.distinct - span.unknown).toBeGreaterThan(c.size * 3);
        expect(span.lowest).toBeLessThan(1 / 3);
        expect(span.highest).toBeGreaterThanOrEqual(2 / 3);
    });

    if (c.seeded) {
        it("returns identical tracks for the same date and different ones for another", async () => {
            const again = await onWeekday(c.day, () => c.run(dates[0]));
            expect(again!.trackIds).toEqual(mixes[0].trackIds);
            const other = await onWeekday(c.day, () => c.run(dates[1]));
            expect(other!.trackIds).not.toEqual(mixes[0].trackIds);
            expect(new Set(other!.trackIds)).not.toEqual(new Set(mixes[0].trackIds));
        });
    } else {
        it("varies from call to call (the track draw is not seeded)", async () => {
            const draws = new Set<string>();
            for (let k = 0; k < 6; k++) {
                const mix = await onWeekday(c.day, () => c.run(dates[0]));
                draws.add([...mix!.trackIds].sort().join(","));
            }
            expect(draws.size).toBeGreaterThan(1);
        });
    }

    (c.idIsTimestamp ? it.skip : it)("keeps the mix id for a date", async () => {
        const again = await onWeekday(c.day, () => c.run(callDates[0]));
        expect(again!.id).toBe(mixes[0].id);
    });
});

// ---- generators with their own shape ---------------------------------------

describe("Top Tracks", () => {
    it("is the user's 20 most played tracks, most played first", async () => {
        const mix = await discovery.generateTopTracksMix(lib.user1);
        // user1 plays 25 tracks 40..16 times (none of them with a missing file), so the order is unambiguous.
        const expected = [...rows].sort((a, b) => b.playsUser1 - a.playsUser1).slice(0, 20);
        expect(mix!.trackIds).toHaveLength(20);
        expect(mix!.trackIds).toEqual(expected.map((r) => r.id));
        expect(mix!.trackCount).toBe(20);
    });
});

describe("Random Discovery", () => {
    let mixes: ProgrammaticMix[] = [];
    // Consecutive calendar dates hash to neighbouring seeds, so their album windows overlap; spread the dates out.
    const wide = Array.from({ length: CALLS }, (_, k) => `d${k * 7919}`);
    beforeAll(async () => {
        mixes = [];
        for (const d of wide) {
            const mix = await discovery.generateRandomDiscoveryMix(lib.user1, d);
            if (mix) mixes.push(mix);
        }
    });

    it("returns 20 tracks from at most 5 albums, repeating no track", () => {
        expect(mixes).toHaveLength(wide.length);
        for (const mix of mixes) {
            expect(mix.trackIds).toHaveLength(20);
            expect(new Set(mix.trackIds).size).toBe(20);
            expect(new Set(mix.trackIds.map((id) => byId.get(id)!.album.id)).size).toBeLessThanOrEqual(5);
        }
    });

    it("never returns a track whose file is missing", () => {
        const missing = mixes.flatMap((m) => m.trackIds.filter((id) => byId.get(id)!.missingSince !== null));
        expect(missing).toEqual([]);
    });

    it("reaches albums across the whole library over many dates", () => {
        const albumsUsed = new Set(mixes.flatMap((m) => m.trackIds.map((id) => byId.get(id)!.album.id)));
        expect(albumsUsed.size).toBeGreaterThan(60);
        const span = spanOf(mixes.flatMap((m) => m.trackIds), rows.map((r) => r.id));
        expect(span.lowest).toBeLessThan(1 / 3);
        expect(span.highest).toBeGreaterThanOrEqual(2 / 3);
    });

    it("picks the same albums for the same date", async () => {
        const again = await discovery.generateRandomDiscoveryMix(lib.user1, wide[0]);
        const albums = (m: ProgrammaticMix) => new Set(m.trackIds.map((id) => byId.get(id)!.album.id));
        // Both draws are 20 of the same 5 albums' tracks, so every album one drew from the other can also have drawn;
        // the albums that appear in both must be a majority.
        const a = albums(mixes[0]);
        const b = albums(again!);
        expect([...a].filter((x) => b.has(x)).length).toBeGreaterThanOrEqual(3);
    });
});

describe("Key Journey", () => {
    it("takes at most two tracks per key and walks the circle of fifths in order", async () => {
        const order = ["C", "G", "D", "A", "E", "B", "F#", "Db", "Ab", "Eb", "Bb", "F"];
        const spell: Record<string, string> = { "C#": "Db", "G#": "Ab", "D#": "Eb", "A#": "Bb" };
        for (const d of dates.slice(0, 10)) {
            const mix = await mood.generateKeyJourney(lib.user1, d);
            const keys = mix!.trackIds.map((id) => {
                const k = byId.get(id)!.key!;
                return spell[k] ?? k;
            });
            const positions = keys.map((k) => order.indexOf(k));
            expect(positions.every((p) => p >= 0)).toBe(true);
            expect(positions).toEqual([...positions].sort((a, b) => a - b));
            for (const k of new Set(keys)) expect(keys.filter((x) => x === k).length).toBeLessThanOrEqual(2);
        }
    });
});

describe("Tempo Flow", () => {
    it("mixes slow, medium and fast tracks in the documented proportions", async () => {
        const bpm = (id: string) => byId.get(id)!.bpm!;
        const klass = (b: number) => (b < 100 ? "slow" : b < 130 ? "medium" : "fast");
        for (let k = 0; k < 10; k++) {
            const mix = await mood.generateTempoFlow(lib.user1, dates[0]);
            const counts: Record<string, number> = { slow: 0, medium: 0, fast: 0 };
            for (const id of mix!.trackIds) counts[klass(bpm(id))]++;
            expect(counts).toEqual({ slow: 6, medium: 8, fast: 6 });
        }
    });
});

describe("mixes that exist only on certain weekdays", () => {
    it("Day mix is null on a day without one (Wednesday)", async () => {
        expect(await onWeekday(3, () => time.generateDayMix(lib.user1))).toBeNull();
    });
    it("Sad Girl Sundays is null on a Monday; Minor Key Mondays is null on a Sunday", async () => {
        expect(await onWeekday(1, () => mood.generateSadGirlSundays(lib.user1, dates[0]))).toBeNull();
        expect(await onWeekday(0, () => mood.generateMinorKeyMix(lib.user1, dates[0]))).toBeNull();
    });
});

describe("Genre mix", () => {
    it("picks a different genre on different dates", async () => {
        const ids = new Set<string>();
        for (const d of dates) ids.add((await genre.generateGenreMix(lib.user1, d))!.id.replace(/-\d{4}-\d{2}-\d{2}$/, ""));
        expect(ids.size).toBeGreaterThan(3);
    });
});

describe("Era mix", () => {
    it("picks different decades on different dates", async () => {
        const ids = new Set<string>();
        for (const d of dates) ids.add((await genre.generateEraMix(lib.user1, d))!.id.replace(/-\d{4}-\d{2}-\d{2}$/, ""));
        expect(ids.size).toBeGreaterThan(2);
    });
});

it("the library under test is big enough that the first rows and the whole set differ", () => {
    expect(rows).toHaveLength(TRACK_COUNT);
    // Ids run in energy order: the 100 lowest ids hold only the quietest tracks.
    const first100 = rows.slice(0, 100).map((r) => r.energy).filter((e): e is number => e !== null);
    expect(Math.max(...first100)).toBeLessThan(0.1);
});
