/**
 * Times the mix generators and every radio branch on a synthetic 50,000-track library.
 *
 * Writes the library to the throwaway test database with learned mood scores and the library's
 * mood statistics, runs generateAllMixes (3 runs), every recipe's member query once, 10 draws of
 * one mix (Chill), 10 Rediscover mixes for one user, 10 mood page mixes per mood, 10 GET
 * /library/radio calls per branch (every mood station, Wildcard among them) and, last,
 * one mood pass after a "moods" re-run, prints the times in milliseconds, then deletes everything it
 * wrote. It refuses to run against any database but the test one.
 *
 * usage (from backend/):
 *   DATABASE_URL=postgresql://test:test@localhost:5433/kima_v1_test npx tsx scripts/time-mixes-50k.ts
 */
import type { Prisma } from "@prisma/client";

const REQUIRED_URL = "postgresql://test:test@localhost:5433/kima_v1_test";

if (process.env.DATABASE_URL !== REQUIRED_URL) {
    console.error(`Refusing to run: DATABASE_URL must be exactly ${REQUIRED_URL}`);
    process.exit(1);
}
process.env.JWT_SECRET ??= "test-jwt-secret-for-testing-purposes-only-32chars";
process.env.SESSION_SECRET ??= "test-session-secret-for-testing-purposes-only";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.SETTINGS_ENCRYPTION_KEY ??= "/pqt6ujDwltWiWSK1uSkpQOfwXQpORT0CWScZ8m66Kg=";
process.env.MUSIC_PATH ??= "/music";

const PREFIX = "perf_";
const TRACKS = 50_000;
const TRACKS_PER_ALBUM = 12;
const ALBUMS = Math.ceil(TRACKS / TRACKS_PER_ALBUM);
const ALBUMS_PER_ARTIST = 4;
const ARTISTS = Math.ceil(ALBUMS / ALBUMS_PER_ARTIST);
const RADIO_CALLS = 10;
const MIX_RUNS = 3;

async function main() {
    const { prisma } = await import("../src/utils/db");
    const { GENRE_NAMES } = await import("../src/__tests__/fixtures/syntheticLibrary");
    const { gaussian } = await import("../src/__tests__/fixtures/gaussian");
    const { seededRandom } = await import("../src/services/matching/mapLayout");
    const { programmaticPlaylistService } = await import("../src/services/mixes");
    const express = (await import("express")).default;
    const request = (await import("supertest")).default;
    const router = (await import("../src/routes/library/tracks")).default;
    const { MOODS, MOOD_HEADS } = await import("../src/services/moods/heads");
    const { buildMoodState, buildMoods } = await import("../src/services/moods/state");
    const { writeMoodTags } = await import("../src/services/moods/tags");
    const { rerunEnrichment } = await import("../src/services/enrichmentRestart");
    const { RECIPES, pickRecipeStation } = await import("../src/services/mixes/recipes");
    const { generateChillMix } = await import("../src/services/mixes/moodMixes");
    const { generateRediscoverMix } = await import("../src/services/mixes/discoveryMixes");
    const { moodBucketService, VALID_MOODS } = await import("../src/services/moodBucketService");

    const rng = seededRandom(20261021);
    const r4 = (x: number) => Math.round(x * 10000) / 10000;
    const inChunks = async <T>(rows: T[], write: (c: T[]) => Promise<unknown>, size = 2000) => {
        for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
    };
    const user1 = `${PREFIX}user1`;
    const user2 = `${PREFIX}user2`;
    const genreIds = new Map<string, string>();

    async function cleanup() {
        await prisma.play.deleteMany({ where: { userId: { startsWith: PREFIX } } });
        await prisma.track.deleteMany({ where: { id: { startsWith: PREFIX } } });
        await prisma.artist.deleteMany({ where: { id: { startsWith: PREFIX } } });
        await prisma.user.deleteMany({ where: { id: { startsWith: PREFIX } } });
        await prisma.genre.deleteMany({ where: { id: { startsWith: PREFIX } } });
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
    }

    async function seed() {
        await cleanup();
        await prisma.user.createMany({ data: [user1, user2].map((id) => ({ id, username: id, passwordHash: "x" })) });
        const existing = new Set((await prisma.genre.findMany({ select: { name: true } })).map((g) => g.name));
        await prisma.genre.createMany({
            data: GENRE_NAMES.filter((n) => !existing.has(n)).map((name) => ({ id: `${PREFIX}gen_${name}`, name })),
        });
        for (const g of await prisma.genre.findMany({ select: { id: true, name: true } })) genreIds.set(g.name, g.id);
        const lower = GENRE_NAMES.map((g) => g.toLowerCase());
        const some = <T,>(xs: T[], n: number) => {
            const pool = [...xs];
            const out: T[] = [];
            while (out.length < n && pool.length) out.push(...pool.splice(Math.floor(rng() * pool.length), 1));
            return out;
        };

        await inChunks(
            Array.from({ length: ARTISTS }, (_, a) => ({
                id: `${PREFIX}art_${a}`,
                name: `Perf Artist ${a}`,
                normalizedName: `perf artist ${a}`,
                identityKey: `${PREFIX}ak_${a}`,
                genres: some(lower, 1 + Math.floor(rng() * 3)),
            })),
            (data) => prisma.artist.createMany({ data })
        );
        const albums = Array.from({ length: ALBUMS }, (_, b) => {
            const year = 1960 + Math.floor(rng() * 65);
            return {
                id: `${PREFIX}alb_${b}`,
                rgMbid: `${PREFIX}rg_${b}`,
                artistId: `${PREFIX}art_${Math.floor(b / ALBUMS_PER_ARTIST)}`,
                identityKey: `${PREFIX}ik_${b}`,
                title: `Perf Album ${b}`,
                primaryType: "Album",
                year,
                originalYear: rng() >= 0.3 ? year : null,
                location: rng() < 0.04 ? ("DISCOVER" as const) : ("LIBRARY" as const),
                genres: some(lower, 1 + Math.floor(rng() * 2)),
            };
        });
        await inChunks(albums, (data) => prisma.album.createMany({ data }));
        await prisma.ownedAlbum.createMany({
            data: Array.from({ length: ARTISTS }, (_, a) => ({
                artistId: `${PREFIX}art_${a}`,
                rgMbid: `${PREFIX}rg_${a * ALBUMS_PER_ARTIST}`,
                source: "test",
            })),
        });
        const similar = [];
        for (let a = 0; a < ARTISTS - 10; a++)
            for (let k = 1; k <= 10; k++)
                similar.push({ fromArtistId: `${PREFIX}art_${a}`, toArtistId: `${PREFIX}art_${a + k}`, weight: 1 - k / 20 });
        await inChunks(similar, (data) => prisma.similarArtist.createMany({ data }));

        const ids: string[] = [];
        const tracks = Array.from({ length: TRACKS }, (_, i) => {
            const id = `${PREFIX}trk_${String(i).padStart(6, "0")}`;
            ids.push(id);
            const kind = rng();
            const nullReadings = kind >= 0.07 && kind < 0.09;
            const reading = () => (nullReadings ? null : r4(rng()));
            return {
                id,
                albumId: `${PREFIX}alb_${Math.floor(i / TRACKS_PER_ALBUM)}`,
                title: `Perf Track ${i}`,
                trackNo: (i % TRACKS_PER_ALBUM) + 1,
                duration: 200,
                filePath: `/tmp/${PREFIX}${i}.flac`,
                fileModified: new Date(),
                fileSize: 1000,
                energy: reading(),
                valence: reading(),
                arousal: reading(),
                danceability: reading(),
                acousticness: reading(),
                instrumentalness: reading(),
                bpm: nullReadings ? null : Math.round((60 + rng() * 120) * 10) / 10,
                bpmConfidence: nullReadings || rng() < 0.1 ? null : r4(4 * rng()),
                keyScale: nullReadings ? null : rng() < 0.45 ? "minor" : "major",
                key: nullReadings ? null : ["C", "D", "E", "F", "G", "A", "B"][Math.floor(rng() * 7)],
                moodTags: nullReadings ? [] : ["energetic", "calm", "happy", "sad", "dark", "workout"].filter(() => rng() < 0.15),
                analysisMode: nullReadings ? null : "enhanced",
                analysisStatus: kind < 0.04 ? "pending" : "completed",
                missingSince: kind >= 0.09 && kind < 0.12 ? new Date() : null,
                corrupt: kind >= 0.12 && kind < 0.15,
            };
        });
        await inChunks(tracks, (data) => prisma.track.createMany({ data }));

        const trackGenres: { trackId: string; genreId: string }[] = [];
        for (const t of tracks) {
            for (const g of some(GENRE_NAMES, 1 + Math.floor(rng() * 3))) trackGenres.push({ trackId: t.id, genreId: genreIds.get(g)! });
        }
        await inChunks(trackGenres, (data) => prisma.trackGenre.createMany({ data }));

        const plays: { userId: string; trackId: string }[] = [];
        ids.forEach((id, i) => {
            const u = rng();
            const n1 = i < 25 ? 40 - i : u < 0.05 ? 3 : u < 0.3 ? 1 + Math.floor(rng() * 2) : 0;
            for (let k = 0; k < n1; k++) plays.push({ userId: user1, trackId: id });
            if (rng() < 0.35) for (let k = 0, n = 1 + Math.floor(rng() * 8); k < n; k++) plays.push({ userId: user2, trackId: id });
        });
        await inChunks(plays, (data) => prisma.play.createMany({ data }), 5000);

        // A sound vector for every track and its 22 learned mood scores (independent normal logits, mean -1, SD 1.5),
        // then the library's mood statistics, as the mood step leaves them.
        const analyzedAt = new Date("2026-10-23T00:00:00Z");
        const unit = `[1${",0".repeat(MOOD_HEADS.dims - 1)}]`;
        await prisma.$executeRaw`
            INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at)
            SELECT id, ${unit}::vector, ${MOOD_HEADS.model}, ${analyzedAt} FROM unnest(${ids}::text[]) AS id
        `;
        await inChunks(
            ids.map((track_id) => ({
                track_id,
                embedded_at: analyzedAt,
                weights: MOOD_HEADS.version,
                ...Object.fromEntries(MOODS.map((mood) => [mood, r4(-1 + 1.5 * gaussian(rng))])),
            })) as Prisma.TrackMoodCreateManyInput[],
            (data) => prisma.trackMood.createMany({ data })
        );
        await prisma.$transaction((tx) => buildMoodState(tx), { timeout: 600_000 });
        console.log(`seeded: ${TRACKS} tracks, ${ALBUMS} albums, ${ARTISTS} artists, ${buckets.length} mood rows, ${trackGenres.length} track-genre rows, ${plays.length} plays`);
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
        for (const id of RECIPES.keys()) recipeMs.push(await time(() => pickRecipeStation(id, { limit: 100 })));
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
