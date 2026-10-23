/**
 * Every exported mix generator, run against a real Postgres holding a 3,000
 * track synthetic library (see src/__tests__/fixtures/syntheticLibrary.ts;
 * ids are handed out in energy order, so reading "the first N rows" would show
 * as ids bunched at the front) with learned mood scores and the library's mood
 * statistics.
 *
 * Mixes drawn from a recipe are checked against the recipe engine itself: each
 * is the engine's draw for its recipe, day and user, under the mix's own id,
 * title, description and colour, on its weekday only, and a refresh's reroll or
 * another user draws again. The engine's own rules are tested in
 * recipes.integration.test.ts.
 *
 * For every other generator, over 40 different dates (or 40 repeated calls
 * where the mix does not take a date), the suite checks:
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
 * The daily rotation and the refresh path run through the playlist service.
 * Only the similar-artist lookup (a call to ListenBrainz/Deezer over the
 * network) is faked. The database is real.
 */
import { prisma } from "../../../utils/db";
import {
    LibraryHandle,
    Row,
    TRACK_COUNT,
    loadRows,
    removeSyntheticLibrary,
    seedSyntheticLibrary,
    seedSyntheticMoods,
    spanOf,
} from "../../../__tests__/fixtures/syntheticLibrary";
import { buildMoodState } from "../../moods/state";
import { getMixColor, type ProgrammaticMix } from "../helpers";
import { pickRecipeTracks, pickRecipeStation } from "../recipes";
import { programmaticPlaylistService } from "../index";
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
    await seedSyntheticMoods(PREFIX);
    await prisma.$transaction((tx) => buildMoodState(tx));
    rows = await loadRows(PREFIX, lib.user1);
    byId = new Map(rows.map((r) => [r.id, r]));
});

afterAll(async () => {
    await removeSyntheticLibrary(PREFIX);
    await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
    await prisma.$disconnect();
});

// ---- clause vocabulary -----------------------------------------------------

const ge = (x: number | null, v: number) => x !== null && x >= v;
const le = (x: number | null, v: number) => x !== null && x <= v;
const within = (x: number | null, lo: number, hi: number) => x !== null && x >= lo && x <= hi;
const done = (r: Row) => r.analysisStatus === "completed";
const inBucket = (m: string) => (r: Row) => r.buckets.includes(m);
const playable = (r: Row) => r.missingSince === null && !r.corrupt;

/** The library's median arousal over finished, present tracks, interpolated as Postgres's percentile_cont. */
function medianArousal(): number {
    const xs = rows
        .filter((r) => done(r) && r.missingSince === null && r.arousal !== null)
        .map((r) => r.arousal!)
        .sort((a, b) => a - b);
    const at = (xs.length - 1) / 2;
    return xs[Math.floor(at)] + (xs[Math.ceil(at)] - xs[Math.floor(at)]) * (at - Math.floor(at));
}

const dates = Array.from({ length: CALLS }, (_, k) => new Date(Date.UTC(2026, 0, 1 + k)).toISOString().slice(0, 10));

const NOT_DATE: any[] = [
    "hrtime", "nextTick", "performance", "queueMicrotask", "requestAnimationFrame", "cancelAnimationFrame",
    "requestIdleCallback", "cancelIdleCallback", "setImmediate", "clearImmediate", "setInterval", "clearInterval",
    "setTimeout", "clearTimeout",
];

/**
 * Run `fn` with the clock's date set to a given weekday (0 = Sunday) of the `week`th week; only Date is faked.
 * A mix that reads today's date from the clock gets a different date, and so a different seed, each week.
 */
async function onWeekday<T>(day: number | undefined, fn: () => Promise<T>, week = 0): Promise<T> {
    if (day === undefined) return fn();
    // 2026-10-18 is a Sunday.
    jest.useFakeTimers({ doNotFake: NOT_DATE, now: Date.UTC(2026, 9, 18 + day + 7 * week, 12) });
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
    // ---- weekly mixes (20 tracks) ----
    { name: "Deep Cuts", size: 20, seeded: false, run: (d) => mood.generateDeepCuts(lib.user1, d),
      clause: (r) => r.plays === 0 },
    { name: "Key Journey", size: 20, seeded: true, run: (d) => mood.generateKeyJourney(lib.user1, d),
      clause: (r) => done(r) && r.key !== null },
    { name: "Tempo Flow", size: 20, seeded: false, run: (d) => mood.generateTempoFlow(lib.user1, d),
      clause: (r) => done(r) && r.bpm !== null && ge(r.bpmConfidence, 2) },
    { name: "Vocal Detox", size: 20, seeded: true, run: (d) => mood.generateVocalDetox(lib.user1, d),
      clause: (r) => done(r) && ge(r.instrumentalness, 0.75) },
    { name: "Minor Key Mondays", size: 20, seeded: true, day: 1, run: (d) => mood.generateMinorKeyMix(lib.user1, d),
      clause: (r) => done(r) && r.keyScale === "minor" && ge(r.arousal, medianArousal()) },

    // ---- genre mixes ----
    { name: "Era (decade)", size: 20, seeded: false, spread: "repeat", run: (d) => genre.generateEraMix(lib.user1, d),
      clause: (r, mix) => {
          const decade = Number(/^era-(\d+)-/.exec(mix.id)![1]);
          const y = year(r);
          return y !== null && y >= decade && y < decade + 10;
      } },
    { name: "Genre", size: 20, seeded: false, spread: "repeat", run: (d) => genre.generateGenreMix(lib.user1, d),
      clause: (r, mix) => r.genreIds.includes(/^genre-(.+)-\d{4}-\d{2}-\d{2}$/.exec(mix.id)![1]) },

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
        for (const [week, d] of callDates.entries()) {
            const mix = await onWeekday(c.day, () => c.run(d), week);
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
            const other = await onWeekday(c.day, () => c.run(dates[1]), 1);
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

// ---- mixes drawn from a recipe ---------------------------------------------

interface RecipeCase {
    name: string;
    run: (userId: string, today: string) => Promise<ProgrammaticMix | null>;
    recipe: string;
    /** What the mix shows: its id prefix, type, title, description and colour key, as before the recipes. */
    id: string;
    type: string;
    title: string;
    description: string;
    colorType: string;
    /** Weekday the mix exists on (0 = Sunday); the clock is set to it. */
    day?: number;
}

const recipeCases: RecipeCase[] = [
    { name: "Chill", run: mood.generateChillMix, recipe: "chill", id: "chill", type: "chill", title: "Chill Mix",
      description: "Relax and unwind with mellow vibes", colorType: "chill" },
    { name: "High Energy", run: mood.generateHighEnergyMix, recipe: "high-energy", id: "high-energy", type: "workout",
      title: "High Energy", description: "Fast-paced tracks to get you moving", colorType: "workout" },
    { name: "Late Night", run: mood.generateLateNightMix, recipe: "late-night", id: "late-night", type: "late-night",
      title: "Late Night", description: "Mellow vibes for the quiet hours", colorType: "late-night" },
    { name: "Happy Vibes", run: mood.generateHappyMix, recipe: "happy", id: "happy", type: "happy", title: "Happy Vibes",
      description: "Feel-good tracks to brighten your day", colorType: "happy" },
    { name: "Melancholy", run: mood.generateMelancholyMix, recipe: "melancholy", id: "melancholy", type: "melancholy",
      title: "Melancholy", description: "Introspective tracks for reflective moments", colorType: "melancholy" },
    { name: "Dance Floor", run: mood.generateDanceFloorMix, recipe: "dance-floor", id: "dance-floor", type: "dance-floor",
      title: "Dance Floor", description: "High danceability tracks with perfect tempo", colorType: "dance-floor" },
    { name: "Acoustic Afternoon", run: mood.generateAcousticMix, recipe: "acoustic", id: "acoustic", type: "acoustic",
      title: "Acoustic Afternoon", description: "Stripped-down, organic sounds", colorType: "acoustic" },
    { name: "Instrumental Focus", run: mood.generateInstrumentalMix, recipe: "instrumental", id: "instrumental",
      type: "instrumental", title: "Instrumental Focus", description: "No vocals, pure concentration",
      colorType: "instrumental" },
    { name: "Road Trip", run: mood.generateRoadTripMix, recipe: "road-trip", id: "road-trip", type: "road-trip",
      title: "Road Trip", description: "Perfect soundtrack for the open road", colorType: "road-trip" },
    { name: "Sad Girl Sundays", run: mood.generateSadGirlSundays, recipe: "sad-girl-sundays", id: "sad-girl-sundays",
      type: "sad-girl-sundays", title: "Sad Girl Sundays", description: "Melancholic introspection and feelings",
      colorType: "sad-girl-sundays", day: 0 },
    { name: "Main Character Energy", run: mood.generateMainCharacterEnergy, recipe: "main-character",
      id: "main-character", type: "main-character", title: "Main Character Energy",
      description: "You're the protagonist today", colorType: "main-character" },
    { name: "Villain Era", run: mood.generateVillainEra, recipe: "villain-era", id: "villain-era", type: "villain-era",
      title: "Villain Era", description: "Embrace your dark side", colorType: "villain-era" },
    { name: "3AM Thoughts", run: mood.generate3AMThoughts, recipe: "3am-thoughts", id: "3am-thoughts",
      type: "3am-thoughts", title: "3AM Thoughts", description: "Late night overthinking companion",
      colorType: "3am-thoughts" },
    { name: "Hot Girl Walk", run: mood.generateHotGirlWalk, recipe: "hot-girl-walk", id: "hot-girl-walk",
      type: "hot-girl-walk", title: "Hot Girl Walk", description: "Confidence boost for your walk",
      colorType: "confidence-boost" },
    { name: "Rage Cleaning", run: mood.generateRageCleaning, recipe: "rage-cleaning", id: "rage-cleaning",
      type: "rage-cleaning", title: "Rage Cleaning", description: "Aggressive productivity fuel", colorType: "workout" },
    { name: "Golden Hour", run: mood.generateGoldenHour, recipe: "golden-hour", id: "golden-hour", type: "golden-hour",
      title: "Golden Hour", description: "Warm sunset vibes", colorType: "golden-hour" },
    { name: "Shower Karaoke", run: mood.generateShowerKaraoke, recipe: "shower-karaoke", id: "shower-karaoke",
      type: "shower-karaoke", title: "Shower Karaoke", description: "Belters you can't help but sing",
      colorType: "happy" },
    { name: "In My Feelings", run: mood.generateInMyFeelings, recipe: "in-my-feelings", id: "in-my-feelings",
      type: "in-my-feelings", title: "In My Feelings", description: "Let it all out", colorType: "heartbreak-hotel" },
    { name: "Midnight Drive", run: mood.generateMidnightDrive, recipe: "midnight-drive", id: "midnight-drive",
      type: "midnight-drive", title: "Midnight Drive", description: "Perfect for late night cruising",
      colorType: "night-drive" },
    { name: "Coffee Shop Vibes", run: mood.generateCoffeeShopVibes, recipe: "coffee-shop", id: "coffee-shop",
      type: "coffee-shop", title: "Coffee Shop Vibes", description: "Cozy background music", colorType: "coffee-shop" },
    { name: "Romanticize Your Life", run: mood.generateRomanticizeYourLife, recipe: "romanticize", id: "romanticize",
      type: "romanticize", title: "Romanticize Your Life", description: "Make every moment aesthetic",
      colorType: "golden-hour" },
    { name: "That Girl Era", run: mood.generateThatGirlEra, recipe: "that-girl-era", id: "that-girl-era",
      type: "that-girl-era", title: "That Girl Era", description: "Self-improvement mode activated",
      colorType: "confidence-boost" },
    { name: "Unhinged", run: mood.generateUnhinged, recipe: "unhinged", id: "unhinged", type: "unhinged",
      title: "Unhinged", description: "Embrace the chaos", colorType: "dance-floor" },
    { name: "Sleep", run: mood.generateSleepMix, recipe: "sleep", id: "sleep", type: "sleep", title: "Sleep",
      description: "Slow, quiet tracks to drift off to", colorType: "late-night" },
    { name: "Summer", run: mood.generateSummerMix, recipe: "summer", id: "summer", type: "summer", title: "Summer",
      description: "Sunny, carefree tracks for warm days", colorType: "summer-vibes" },
    { name: "Epic", run: mood.generateEpicMix, recipe: "epic", id: "epic", type: "epic", title: "Epic",
      description: "Big, soaring tracks that feel like a movie", colorType: "main-character" },
    { name: "Dreamy", run: mood.generateDreamyMix, recipe: "dreamy", id: "dreamy", type: "dreamy", title: "Dreamy",
      description: "Hazy, floating tracks to get lost in", colorType: "3am-thoughts" },
    { name: "Nostalgic", run: mood.generateNostalgicMix, recipe: "nostalgic", id: "nostalgic", type: "nostalgic",
      title: "Nostalgic", description: "Tracks that take you back", colorType: "throwback" },
    { name: "Party Playlist", run: genre.generatePartyMix, recipe: "party", id: "party", type: "dance-floor",
      title: "Party Playlist", description: "High energy dance, EDM, and pop hits", colorType: "dance-floor" },
    { name: "Workout Mix", run: genre.generateWorkoutMix, recipe: "workout", id: "workout", type: "workout",
      title: "Workout Mix", description: "High energy tracks to power your workout", colorType: "workout" },
    { name: "Focus Mix", run: genre.generateFocusMix, recipe: "focus", id: "focus", type: "focus-flow",
      title: "Focus Mix", description: "Concentration music for deep work", colorType: "focus-flow" },
    { name: "Day mix, Sunday Morning", run: time.generateDayMix, recipe: "sunday-morning", id: "sunday",
      type: "sunday-morning", title: "Sunday Morning", description: "Peaceful tunes for a lazy Sunday",
      colorType: "sunday-morning", day: 0 },
    { name: "Day mix, Monday Motivation", run: time.generateDayMix, recipe: "monday-motivation", id: "monday",
      type: "confidence-boost", title: "Monday Motivation", description: "Start your week with energy",
      colorType: "confidence-boost", day: 1 },
    { name: "Day mix, Friday Night", run: time.generateDayMix, recipe: "friday-night", id: "friday",
      type: "dance-floor", title: "Friday Night", description: "Weekend vibes to kick off the party",
      colorType: "dance-floor", day: 5 },
];

const RECIPE_DATES = dates.slice(0, 5);
/** What a refresh appends to the day: the time of the refresh. */
const REROLL = "-1792771200000";

describe.each(recipeCases)("$name (recipe $recipe)", (c) => {
    let members = new Set<string>();
    const mixes: ProgrammaticMix[] = [];

    beforeAll(async () => {
        members = new Set(await pickRecipeStation(c.recipe, { limit: 100_000 }));
        mixes.length = 0;
        for (const d of RECIPE_DATES) {
            const mix = await onWeekday(c.day, () => c.run(lib.user1, d));
            if (mix) mixes.push(mix);
        }
    });

    it("is the engine's draw for its recipe, this day and this user", async () => {
        expect(members.size).toBeGreaterThanOrEqual(8);
        expect(mixes).toHaveLength(RECIPE_DATES.length);
        for (const [k, d] of RECIPE_DATES.entries()) {
            const drawn = await pickRecipeTracks(c.recipe, { userId: lib.user1, date: d });
            expect(mixes[k].trackIds).toEqual(drawn!.trackIds);
            // 125 artists hold the members, so the 2-per-artist cap never shortens a mix here.
            expect(mixes[k].trackIds).toHaveLength(Math.min(20, members.size));
            expect(mixes[k].trackCount).toBe(mixes[k].trackIds.length);
            expect(mixes[k].trackIds.every((id) => members.has(id) && playable(byId.get(id)!))).toBe(true);
        }
    });

    it("keeps the mix's id, type, title, description and colour", () => {
        for (const [k, d] of RECIPE_DATES.entries()) {
            expect(mixes[k]).toMatchObject({
                id: `${c.id}-${d}`,
                type: c.type,
                name: c.title,
                description: c.description,
                color: getMixColor(c.colorType),
            });
            expect(mixes[k].coverUrls.length).toBeGreaterThan(0);
            expect(mixes[k].coverUrls.length).toBeLessThanOrEqual(4);
        }
    });

    it("draws again for a refresh's reroll and for another user, and the same for the same day and user", async () => {
        const d = RECIPE_DATES[0];
        const again = await onWeekday(c.day, () => c.run(lib.user1, d));
        expect(again!.trackIds).toEqual(mixes[0].trackIds);
        const rerolled = await onWeekday(c.day, () => c.run(lib.user1, d + REROLL));
        const otherUser = await onWeekday(c.day, () => c.run(lib.user2, d));
        expect(rerolled!.id).toBe(`${c.id}-${d}${REROLL}`);
        expect(rerolled!.trackIds).not.toEqual(mixes[0].trackIds);
        expect(otherUser!.trackIds).not.toEqual(mixes[0].trackIds);
        // A recipe with 20 members or fewer ships all of them, in another order.
        if (members.size > 20) {
            expect(new Set(rerolled!.trackIds)).not.toEqual(new Set(mixes[0].trackIds));
            expect(new Set(otherUser!.trackIds)).not.toEqual(new Set(mixes[0].trackIds));
        }
    });

    if (c.day !== undefined) {
        it("has no mix on the other days of the week", async () => {
            for (const day of [0, 1, 2, 3, 4, 5, 6].filter((x) => x !== c.day)) {
                const mix = await onWeekday(day, () => c.run(lib.user1, RECIPE_DATES[0]));
                // The day mix has a different recipe on Sunday, Monday and Friday.
                if (mix) expect(mix.id.startsWith(`${c.id}-`)).toBe(false);
            }
        });
    }
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
        expect(await onWeekday(3, () => time.generateDayMix(lib.user1, dates[0]))).toBeNull();
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

describe("Era mix with year overrides", () => {
    afterAll(async () => {
        await prisma.album.updateMany({ where: { id: { startsWith: PREFIX } }, data: { displayYear: null } });
    });

    it("offers a decade that exists only through displayYear and fills it from the re-dated albums", async () => {
        await prisma.album.updateMany({ where: { id: { startsWith: PREFIX } }, data: { displayYear: 1850 } });
        const mix = await genre.generateEraMix(lib.user1, dates[0]);
        expect(mix).not.toBeNull();
        expect(mix!.id).toMatch(/^era-1850-/);
        expect(mix!.trackIds).toHaveLength(20);
    });
});

it("the library under test is big enough that the first rows and the whole set differ", () => {
    expect(rows).toHaveLength(TRACK_COUNT);
    // Ids run in energy order: the 100 lowest ids hold only the quietest tracks.
    const first100 = rows.slice(0, 100).map((r) => r.energy).filter((e): e is number => e !== null);
    expect(Math.max(...first100)).toBeLessThan(0.1);
});

describe("the daily rotation and its refresh (the playlist service)", () => {
    // Wednesday 2026-10-21, noon UTC; only Date is faked, so the picks are the same on every run.
    const NOW = Date.UTC(2026, 9, 21, 12);
    const TODAY = "2026-10-21";
    const atNoon = async <T,>(fn: () => Promise<T>): Promise<T> => {
        jest.useFakeTimers({ doNotFake: NOT_DATE, now: NOW });
        try {
            return await fn();
        } finally {
            jest.useRealTimers();
        }
    };
    const recipeOf = new Map(recipeCases.map((c) => [c.id, c.recipe]));
    /** The recipe behind a mix id `<prefix>-<day><suffix>`, or undefined for a mix without one. */
    const recipeFor = (mixId: string, suffix: string) => recipeOf.get(mixId.slice(0, -`-${TODAY}${suffix}`.length));

    it("offers the five new mixes among the others", async () => {
        const NEW = ["sleep", "summer", "epic", "dreamy", "nostalgic"];
        const seen = new Set<string>();
        for (let u = 0; u < 200 && NEW.some((id) => !seen.has(id)); u++) {
            const mixes = await atNoon(() => programmaticPlaylistService.generateAllMixes(`${PREFIX}rotation_${u}`));
            expect(mixes.length).toBeGreaterThanOrEqual(5);
            for (const mix of mixes) {
                const prefix = mix.id.slice(0, -`-${TODAY}`.length);
                if (NEW.includes(prefix)) seen.add(prefix);
            }
        }
        expect([...seen].sort()).toEqual([...NEW].sort());
    });

    it("draws each recipe mix for the day and user, and a refresh draws them again", async () => {
        const daily = await atNoon(() => programmaticPlaylistService.generateAllMixes(lib.user1));
        for (const mix of daily.filter((m) => recipeFor(m.id, "") !== undefined)) {
            const drawn = await pickRecipeTracks(recipeFor(mix.id, "")!, { userId: lib.user1, date: TODAY });
            expect(mix.trackIds).toEqual(drawn!.trackIds);
        }

        const suffix = `-${NOW}`;
        let rerolled = 0;
        for (let k = 0; k < 3; k++) {
            const refreshed = await atNoon(() => programmaticPlaylistService.generateAllMixes(lib.user1, true));
            for (const mix of refreshed) {
                // Every mix that carries the day carries the refresh's reroll after it.
                if (mix.id.includes(TODAY)) expect(mix.id.endsWith(`${TODAY}${suffix}`)).toBe(true);
                const recipe = recipeFor(mix.id, suffix);
                if (!recipe) continue;
                rerolled++;
                const drawn = await pickRecipeTracks(recipe, { userId: lib.user1, date: TODAY + suffix });
                expect(mix.trackIds).toEqual(drawn!.trackIds);
                const ofTheDay = await pickRecipeTracks(recipe, { userId: lib.user1, date: TODAY });
                expect(mix.trackIds).not.toEqual(ofTheDay!.trackIds);
            }
        }
        expect(rerolled).toBeGreaterThan(0);
    });
});
