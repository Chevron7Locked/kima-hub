/**
 * Times the mix generators and every radio branch on a synthetic 50,000-track library.
 *
 * Writes the test suite's synthetic library at 50,000 songs to the throwaway test database, with learned mood scores
 * and the library's mood statistics, runs generateAllMixes (3 runs), every recipe's member query once, 10 draws of
 * one mix (Chill), 10 Rediscover mixes for one user, 10 mood page mixes per mood, 10 GET
 * /library/radio calls per branch (every mood station, Wildcard among them) and, last,
 * one mood pass after a "moods" re-run, prints the times in milliseconds, then deletes everything it
 * wrote. It uses the test suite's database (kima_v1_test) and refuses any other; do not run it while the suite runs.
 *
 * usage (from backend/): npx tsx scripts/time-mixes-50k.ts
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DATABASE_URL_FALLBACK, REDIS_URL_FALLBACK } = require("../src/__mocks__/test-db-defaults.cjs");

process.env.DATABASE_URL ??= DATABASE_URL_FALLBACK;
process.env.REDIS_URL ??= REDIS_URL_FALLBACK;
if (new URL(process.env.DATABASE_URL!).pathname !== "/kima_v1_test") {
    console.error("Refusing to run: DATABASE_URL must name the test database, kima_v1_test");
    process.exit(1);
}
process.env.JWT_SECRET ??= "test-jwt-secret-for-testing-purposes-only-32chars";
process.env.SESSION_SECRET ??= "test-session-secret-for-testing-purposes-only";
process.env.SETTINGS_ENCRYPTION_KEY ??= "/pqt6ujDwltWiWSK1uSkpQOfwXQpORT0CWScZ8m66Kg=";
process.env.MUSIC_PATH ??= "/music";

const PREFIX = "perf_";
const TRACKS = 50_000;
const RADIO_CALLS = 10;
const MIX_RUNS = 3;

async function main() {
    const { prisma } = await import("../src/utils/db");
    const { seedSyntheticLibrary, seedSyntheticMoods, removeSyntheticLibrary } = await import(
        "../src/__tests__/fixtures/syntheticLibrary"
    );
    const { programmaticPlaylistService } = await import("../src/services/mixes");
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const router = (await import("../src/routes/library/tracks")).default;
    const { buildMoodState, buildMoods } = await import("../src/services/moods/state");
    const { writeMoodTags } = await import("../src/services/moods/tags");
    const { rerunEnrichment } = await import("../src/services/enrichmentRestart");
    const { RECIPES, pickRecipeStationPage } = await import("../src/services/mixes/recipes");
    const { generateChillMix } = await import("../src/services/mixes/moodMixes");
    const { generateRediscoverMix } = await import("../src/services/mixes/discoveryMixes");
    const { moodBucketService, VALID_MOODS } = await import("../src/services/moodBucketService");

    const user1 = `${PREFIX}user1`;

    async function cleanup() {
        await removeSyntheticLibrary(PREFIX);
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
    }

    // The test suite's synthetic library at 50,000 songs, with its learned mood scores and the library's mood
    // statistics, as the mood step leaves them.
    async function seed() {
        await cleanup();
        await seedSyntheticLibrary(PREFIX, TRACKS);
        await seedSyntheticMoods(PREFIX, TRACKS);
        await prisma.$transaction((tx) => buildMoodState(tx), { timeout: 600_000 });
        const [tracks, albums, artists, plays] = await Promise.all([
            prisma.track.count({ where: { id: { startsWith: PREFIX } } }),
            prisma.album.count({ where: { id: { startsWith: PREFIX } } }),
            prisma.artist.count({ where: { id: { startsWith: PREFIX } } }),
            prisma.play.count({ where: { userId: { startsWith: PREFIX } } }),
        ]);
        console.log(`seeded: ${tracks} tracks, ${albums} albums, ${artists} artists, ${plays} plays`);
    }

    const summarize = (label: string, ms: number[]) => {
        const s = [...ms].sort((a, b) => a - b);
        console.log(`${label.padEnd(28)} min ${s[0].toFixed(0).padStart(6)}  median ${s[Math.floor(s.length / 2)].toFixed(0).padStart(6)}  max ${s[s.length - 1].toFixed(0).padStart(6)}  ms  (n=${s.length})`);
    };
    const time = async (fn: () => Promise<unknown>) => {
        const t0 = performance.now();
        await fn();
        return performance.now() - t0;
    };

    try {
        await seed();

        const mixMs: number[] = [];
        let mixCount = 0;
        for (let k = 0; k < MIX_RUNS; k++)
            mixMs.push(await time(async () => (mixCount = (await programmaticPlaylistService.generateAllMixes(user1, true)).length)));
        summarize(`generateAllMixes (${mixCount} mixes)`, mixMs);

        const recipeMs: number[] = [];
        for (const id of RECIPES.keys()) recipeMs.push(await time(() => pickRecipeStationPage(id, { limit: 100 })));
        summarize(`one recipe's members (${RECIPES.size})`, recipeMs);

        const chillMs: number[] = [];
        for (let k = 0; k < RADIO_CALLS; k++) chillMs.push(await time(() => generateChillMix(user1, `2026-10-2${k}`)));
        summarize("one mix (Chill Mix)", chillMs);

        // Rediscover reads every library track's play count for the user before it draws.
        const rediscoverMs: number[] = [];
        for (let k = 0; k < RADIO_CALLS; k++) rediscoverMs.push(await time(() => generateRediscoverMix(user1, `2026-10-2${k}`)));
        summarize("Rediscover (one user)", rediscoverMs);

        for (const mood of VALID_MOODS) {
            const pageMs: number[] = [];
            for (let k = 0; k < RADIO_CALLS; k++) pageMs.push(await time(() => moodBucketService.getMoodMix(mood, 15)));
            summarize(`mood page ${mood}`, pageMs);
        }

        const app = express();
        app.use(express.json());
        app.use("/", router);
        const artist = `${PREFIX}art_5`;
        const branches: [string, Record<string, string | number>][] = [
            ["discovery", { type: "discovery" }],
            ["favorites", { type: "favorites" }],
            ["decade 1990", { type: "decade", value: 1990 }],
            ["genre rock", { type: "genre", value: "rock" }],
            ["mood calm", { type: "mood", value: "calm" }],
            ["mood energy", { type: "mood", value: "energy" }],
            ["mood intense", { type: "mood", value: "intense" }],
            ["mood happy", { type: "mood", value: "happy" }],
            ["mood melancholy", { type: "mood", value: "melancholy" }],
            ["mood focus-calm", { type: "mood", value: "focus-calm" }],
            ["mood focus-energy", { type: "mood", value: "focus-energy" }],
            ["mood feel-good", { type: "mood", value: "feel-good" }],
            ["mood late-night", { type: "mood", value: "late-night" }],
            ["mood romantic", { type: "mood", value: "romantic" }],
            ["mood road-trip", { type: "mood", value: "road-trip" }],
            ["mood nostalgic", { type: "mood", value: "nostalgic" }],
            ["mood epic", { type: "mood", value: "epic" }],
            ["mood wildcard", { type: "mood", value: "wildcard" }],
            ["workout", { type: "workout" }],
            ["artist", { type: "artist", value: artist }],
            ["all", { type: "all" }],
        ];
        for (const [label, query] of branches) {
            const ms: number[] = [];
            for (let k = 0; k < RADIO_CALLS; k++) {
                let status = 0;
                ms.push(await time(async () => (status = (await request(app).get("/radio").query({ ...query, limit: 20 })).status)));
                if (status !== 200) console.log(`  ${label}: call ${k} returned status ${status}`);
            }
            summarize(`radio ${label}`, ms);
        }

        // A rescore, last because it leaves every song the same scores (the seeded vectors are all alike): the
        // moods re-run clears every score and the statistics, then one mood pass scores every vector again, rebuilds
        // the statistics and writes the tags. Until the pass ends, mood mixes, stations and pages are empty for any
        // request the mix cache does not answer.
        const rerunMs = await time(() => rerunEnrichment("moods"));
        let pass = { scored: 0, stateChanged: false };
        const buildMs = await time(async () => (pass = await buildMoods()));
        let tagged = 0;
        const tagMs = await time(async () => (tagged = await writeMoodTags()));
        console.log(`moods re-run (clear)          ${rerunMs.toFixed(0).padStart(6)} ms`);
        console.log(`mood pass: scores + statistics ${buildMs.toFixed(0).padStart(6)} ms  (${pass.scored} scored, statistics rebuilt: ${pass.stateChanged})`);
        console.log(`mood pass: tags                ${tagMs.toFixed(0).padStart(6)} ms  (${tagged} tracks' tags written)`);
        console.log(`mood pass total                ${(buildMs + tagMs).toFixed(0).padStart(6)} ms`);
    } finally {
        await cleanup();
        await prisma.$disconnect();
        console.log("cleaned up");
    }
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
