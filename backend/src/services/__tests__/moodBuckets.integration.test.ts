/**
 * A track carries a mood when its learned mood score sits at least RECIPE_LINE standard deviations above the library's
 * mean, by the mood statistics the mood step keeps; library rank orders the bucket and picks the dominant label. The
 * old Essentia head columns play no part. Buckets and the mood snapshot fill once the mood step has scored a track,
 * rebuild when the statistics change (a rescore, a re-run, a changed library), and match the vibe map.
 */

const store = new Map<string, string>();
jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(async (k: string) => store.get(k) ?? null),
        del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
        multi: jest.fn(() => {
            const ops: Array<() => void> = [];
            const chain = {
                setex: (k: string, _ttl: number, v: string) => { ops.push(() => store.set(k, v)); return chain; },
                del: (k: string) => { ops.push(() => store.delete(k)); return chain; },
                sadd: () => chain,
                expire: () => chain,
                exec: async () => { ops.forEach((op) => op()); return []; },
            };
            return chain;
        }),
    },
}));

import fs from "fs";
import path from "path";
import { prisma } from "../../utils/db";
import {
    MOODS,
    classifyMoods,
    MoodDistribution,
    MoodField,
    MoodValues,
    moodBucketService,
    moodOutput,
    currentMoodSnapshot,
    NEUTRAL,
    UNANALYZED,
} from "../moodBucketService";
import { syncMoodBuckets } from "../../workers/moodBucketWorker";
import { getVibeMap } from "../vibeMap";
import { MOODS as LEARNED_MOODS, MOOD_HEADS, type Mood } from "../moods/heads";
import { buildMoodState, loadMoodState } from "../moods/state";
import { RECIPE_LINE } from "../mixes/recipes";

jest.setTimeout(60_000);

const FIELDS = MOODS.map((m) => m.field);
const quiet: MoodValues = { moodHappy: 0, moodSad: 0, moodRelaxed: 0, moodAggressive: 0, moodParty: 0 };
const unit = (sd = 1) => Object.fromEntries(FIELDS.map((f) => [f, { mean: 0, sd }])) as Record<MoodField, { mean: number; sd: number }>;

describe("classifyMoods (pure)", () => {
    // 10 tracks: values 0 .. 9 on every mood
    const lib: MoodValues[] = Array.from({ length: 10 }, (_, i) => ({
        moodHappy: i, moodSad: i, moodRelaxed: i, moodAggressive: i, moodParty: i,
    }));
    const dist = new MoodDistribution(lib, unit());

    it("ranks a value by the share of the library below it, ties counted half", () => {
        expect(dist.rank("moodHappy", 9)).toBeCloseTo(0.95);
        expect(dist.rank("moodHappy", 0)).toBeCloseTo(0.05);
        expect(dist.rank("moodHappy", 4.5)).toBeCloseTo(0.5);
    });

    it("gives a mood on the line and above it, not just under it", () => {
        const on = classifyMoods({ ...quiet, moodParty: RECIPE_LINE }, dist);
        expect(on.dominant).toBe("moodParty");
        expect(on.moods).toEqual(["moodParty"]);
        const under = classifyMoods({ ...quiet, moodParty: RECIPE_LINE - 0.001 }, dist);
        expect(under.dominant).toBe(NEUTRAL);
        expect(under.moods).toEqual([]);
    });

    it("judges a score against the library's statistics, not a fixed number", () => {
        const wide = new MoodDistribution(lib, unit(4 * RECIPE_LINE));
        expect(classifyMoods({ ...quiet, moodSad: 2 * RECIPE_LINE }, dist).moods).toEqual(["moodSad"]);
        expect(classifyMoods({ ...quiet, moodSad: 2 * RECIPE_LINE }, wide).moods).toEqual([]);
    });

    it("does not give a mood under the line, however high it ranks", () => {
        const low = new MoodDistribution(lib.map((r) => ({ ...r, moodSad: (r.moodSad as number) / 100 })), unit());
        const v = classifyMoods({ ...quiet, moodSad: 0.09 }, low);
        expect(v.ranks.moodSad).toBeGreaterThan(0.8);
        expect(v.moods).not.toContain("moodSad");
    });

    it("picks the mood the track ranks highest on among its moods, and keeps every mood it has", () => {
        const v = classifyMoods({ ...quiet, moodHappy: 8.5, moodParty: 9.5 }, dist);
        expect(v.dominant).toBe("moodParty");
        expect(v.score).toBeCloseTo(1);
        expect(v.moods.sort()).toEqual(["moodHappy", "moodParty"]);
    });

    it("reports a track with any missing mood as not analysed", () => {
        const v = classifyMoods({ ...quiet, moodSad: null }, dist);
        expect(v.dominant).toBe(UNANALYZED);
        expect(v.ranks).toEqual({});
        expect(v.moods).toEqual([]);
    });
});

const ANALYZED_AT = new Date("2026-10-23T00:00:00Z");
const UNIT = `[1${",0".repeat(MOOD_HEADS.dims - 1)}]`;
const SCORED = 30;

/** Scores in [-0.5, 0.5] from the track and mood, so the quiet tracks differ from each other. */
const noise = (i: number, m: number) => (((i * 7919 + m * 104729) % 1000) / 1000 - 0.5);

/** The learned scores of track i: 0-3 stand out on party, 4 on calm, "flat" sits below the mean on everything. */
function learnedScores(i: number | "flat"): Record<Mood, number> {
    const scores = Object.fromEntries(LEARNED_MOODS.map((mood, m) => [mood, i === "flat" ? -2 : noise(i, m)]));
    if (typeof i === "number" && i < 4) scores.party = 5;
    if (i === 4) scores.calm = 5;
    return scores as Record<Mood, number>;
}

const idOf = (i: number | "flat" | "pending" | "unscored") => `trk_mood_${i}`;

async function seed() {
    const artist = await prisma.artist.create({ data: { id: "art_mood", name: "Mood Artist", identityKey: "a_mood" } });
    const album = await prisma.album.create({
        data: { id: "alb_mood", rgMbid: "rg_mood", artistId: artist.id, title: "Mood Album", primaryType: "Album" },
    });
    const scored: (number | "flat")[] = [...Array.from({ length: SCORED }, (_, i) => i), "flat"];
    for (const [n, i] of scored.entries()) {
        const id = idOf(i);
        await prisma.track.create({
            data: {
                id, albumId: album.id, title: `M ${i}`, trackNo: n + 1, duration: 180,
                filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000,
                analysisStatus: "completed", analysisMode: "enhanced", analysisVersion: "2.1b6-enhanced-v3",
                analyzedAt: new Date(Date.UTC(2026, 8, 24, 0, n)),
                arousal: 0.3 + (n % 5) * 0.1, instrumentalness: 0.2 + (n % 3) * 0.3, acousticness: 0.1 + (n % 4) * 0.2,
                // The old heads say the opposite of the learned moods: they must not decide anything.
                moodHappy: 0.99, moodSad: 0.99, moodRelaxed: 0.01, moodAggressive: 0.99, moodParty: 0.01,
            },
        });
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at) VALUES ($1, $2::vector, $3, $4)`,
            id, UNIT, MOOD_HEADS.model, ANALYZED_AT,
        );
        await prisma.$executeRawUnsafe(
            `INSERT INTO matching_map (track_id, embedded_at, x, y, z, colour, laid_out) VALUES ($1, $2, 0.5, 0.5, 0.5, 0.5, true)`,
            id, ANALYZED_AT,
        );
        await prisma.trackMood.create({
            data: { track_id: id, embedded_at: ANALYZED_AT, weights: MOOD_HEADS.version, ...learnedScores(i) },
        });
    }
    // One track still waiting for analysis, one analysed whose sound vector is not scored yet.
    for (const [n, kind] of (["pending", "unscored"] as const).entries()) {
        await prisma.track.create({
            data: {
                id: idOf(kind), albumId: album.id, title: kind, trackNo: 100 + n, duration: 180,
                filePath: `/tmp/${idOf(kind)}.flac`, fileModified: new Date(), fileSize: 1000,
                analysisStatus: kind === "pending" ? "pending" : "completed",
            },
        });
    }
    await prisma.$transaction((tx) => buildMoodState(tx));
}

/** The buckets the rule gives, from the stored scores and statistics: "mood:trackId" -> library rank. */
async function expectedBuckets(): Promise<Map<string, number>> {
    const state = (await loadMoodState())!;
    // The tracks the statistics cover: current scores for the vector and weights, a present readable file, analysed.
    const eligible = await prisma.$queryRawUnsafe<Array<{ id: string } & Record<Mood, number>>>(
        `SELECT m.track_id AS id, ${MOODS.map((m) => `m."${m.learned}"::float8 AS "${m.learned}"`).join(", ")}
         FROM track_moods m
         JOIN track_embeddings te ON te.track_id = m.track_id AND te.analyzed_at = m.embedded_at
         JOIN "Track" t ON t.id = m.track_id
         WHERE m.weights = $1 AND te.model_version = $2
           AND t."missingSince" IS NULL AND t.corrupt = false AND t."analysisStatus" = 'completed'`,
        MOOD_HEADS.version, MOOD_HEADS.model,
    );
    const out = new Map<string, number>();
    for (const m of MOODS) {
        const values = eligible.map((r) => r[m.learned]);
        const { mean, sd } = state.moods[m.learned];
        for (const r of eligible) {
            const v = r[m.learned];
            if ((v - mean) / sd < RECIPE_LINE) continue;
            const below = values.filter((x) => x < v).length;
            const ties = values.filter((x) => x === v).length;
            out.set(`${m.id}:${r.id}`, (below + ties / 2) / values.length);
        }
    }
    return out;
}

async function bucketsNow(): Promise<Map<string, number>> {
    const rows = await prisma.moodBucket.findMany({ where: { trackId: { startsWith: "trk_mood_" } } });
    return new Map(rows.map((b) => [`${b.mood}:${b.trackId}`, b.score]));
}

async function expectBucketsToFollowTheRule() {
    const want = await expectedBuckets();
    const got = await bucketsNow();
    expect([...got.keys()].sort()).toEqual([...want.keys()].sort());
    for (const [key, rank] of want) expect(got.get(key)).toBeCloseTo(rank, 6);
}

async function mapTracks() {
    const state = await getVibeMap();
    if (state.status !== "ready") throw new Error("the map is not laid out");
    return state.data.tracks;
}

describe("mood buckets and the mood snapshot (database)", () => {
    beforeAll(async () => {
        await seed();
    });

    // The worker DB is shared by every suite in this Jest worker: remove our rows.
    afterAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, "trk\\_mood\\_%");
        await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = $1`, "alb_mood");
        await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, "art_mood");
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
        await prisma.$disconnect();
    });

    it("fills every bucket from the learned moods on the first run, by the line on the library's statistics", async () => {
        expect(await syncMoodBuckets()).toBe(true);
        await expectBucketsToFollowTheRule();
        const got = await bucketsNow();
        for (const i of [0, 1, 2, 3]) expect(got.has(`party:${idOf(i)}`)).toBe(true);
        expect(got.has(`chill:${idOf(4)}`)).toBe(true);
        expect([...got.keys()].filter((k) => k.endsWith(idOf("flat")))).toEqual([]);
    });

    it("reads the learned moods, not the old head columns", async () => {
        const got = await bucketsNow();
        // Every track's old heads say happy, sad and aggressive yes, calm and party no.
        expect(got.has(`happy:${idOf(0)}`)).toBe(false);
        expect(got.has(`party:${idOf(0)}`)).toBe(true);
        const snap = await currentMoodSnapshot();
        expect(snap.views.get(idOf(4))!.dominant).toBe("moodRelaxed");
    });

    it("does not rebuild when nothing changed", async () => {
        expect(await syncMoodBuckets()).toBe(false);
    });

    it("counts the tracks waiting for mood scores: analysis running, or a sound vector the mood step has not scored", async () => {
        await syncMoodBuckets();
        const before = (await moodBucketService.getMoodPresets())[0].pendingTracks;
        expect(before).toBeGreaterThanOrEqual(1);

        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version, analyzed_at) VALUES ($1, $2::vector, $3, $4)`,
            idOf("unscored"), UNIT, MOOD_HEADS.model, ANALYZED_AT,
        );
        expect(await syncMoodBuckets()).toBe(false);
        const presets = await moodBucketService.getMoodPresets();
        expect(presets.map((p) => p.name)).toEqual(["Upbeat", "Melancholic", "Calm", "Intense", "Energetic"]);
        expect(presets[0].pendingTracks).toBe(before + 1);

        await prisma.trackMood.create({
            data: { track_id: idOf("unscored"), embedded_at: ANALYZED_AT, weights: MOOD_HEADS.version, ...learnedScores(5) },
        });
        await syncMoodBuckets();
        expect((await moodBucketService.getMoodPresets())[0].pendingTracks).toBe(before);
        expect((await moodBucketService.getMoodPresets()).find((p) => p.id === "party")!.trackCount).toBeGreaterThanOrEqual(4);
    });

    it("serves the same decision on the vibe map", async () => {
        const byId = new Map((await mapTracks()).map((t) => [t.id, t]));
        expect(byId.get(idOf(0))!.dominantMood).toBe("moodParty");
        expect(byId.get(idOf(4))!.dominantMood).toBe("moodRelaxed");
        expect(byId.get(idOf("flat"))!.dominantMood).toBe(NEUTRAL);
        expect(Object.keys(byId.get(idOf(0))!.moods).sort()).toEqual(
            ["moodAggressive", "moodHappy", "moodParty", "moodRelaxed", "moodSad"],
        );
    });

    it("rebuilds after a rescore: a re-run sound vector's new scores move the buckets", async () => {
        const rerun = new Date(ANALYZED_AT.getTime() + 60_000);
        await prisma.$executeRawUnsafe(`UPDATE track_embeddings SET analyzed_at = $2 WHERE track_id = $1`, idOf("flat"), rerun);
        await prisma.$executeRawUnsafe(`UPDATE matching_map SET embedded_at = $2 WHERE track_id = $1`, idOf("flat"), rerun);
        await prisma.trackMood.update({
            where: { track_id: idOf("flat") },
            data: { embedded_at: rerun, ...learnedScores("flat"), party: 6 },
        });
        expect(await prisma.$transaction((tx) => buildMoodState(tx))).toBe(true);

        expect(await syncMoodBuckets()).toBe(true);
        await expectBucketsToFollowTheRule();
        expect((await bucketsNow()).has(`party:${idOf("flat")}`)).toBe(true);
        expect((await mapTracks()).find((t) => t.id === idOf("flat"))!.dominantMood).toBe("moodParty");
    });

    it("a re-run that clears the statistics empties the buckets until the mood step builds them again", async () => {
        const state = await prisma.moodState.findUniqueOrThrow({ where: { id: "default" } });
        await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
        expect(await syncMoodBuckets()).toBe(true);
        expect((await bucketsNow()).size).toBe(0);
        expect(moodOutput((await currentMoodSnapshot()).views.get(idOf(0))).dominantMood).toBe(UNANALYZED);

        await prisma.$transaction((tx) => buildMoodState(tx));
        expect((await prisma.moodState.findUniqueOrThrow({ where: { id: "default" } })).fingerprint).toBe(state.fingerprint);
        expect(await syncMoodBuckets()).toBe(true);
        await expectBucketsToFollowTheRule();
    });

    it("a track whose scores are cleared is 'unanalyzed' and leaves every bucket once the statistics follow", async () => {
        await prisma.trackMood.delete({ where: { track_id: idOf(0) } });
        await prisma.$transaction((tx) => buildMoodState(tx));
        expect(await syncMoodBuckets()).toBe(true);
        expect((await mapTracks()).find((t) => t.id === idOf(0))!.dominantMood).toBe(UNANALYZED);
        expect(await prisma.moodBucket.count({ where: { trackId: idOf(0) } })).toBe(0);
        await expectBucketsToFollowTheRule();
    });

    it("the inverted-heads migration re-queues exactly the rows the broken analyzer wrote", async () => {
        await prisma.track.update({
            where: { id: idOf(5) },
            data: { analysisVersion: "2.1b6-enhanced-v2", danceabilityMl: 0.3, moodAcoustic: 0.4, moodTags: ["happy"], analysisRetryCount: 2 },
        });
        await prisma.track.update({
            where: { id: idOf(6) },
            data: { analysisMode: "standard", analysisVersion: "2.1b6-enhanced-v2", moodTags: ["chill"] },
        });
        const sql = fs.readFileSync(
            path.join(__dirname, "../../../prisma/migrations/20260924120000_reset_inverted_mood_heads/migration.sql"),
            "utf8",
        );
        await prisma.$executeRawUnsafe(sql);

        const reset = await prisma.track.findUniqueOrThrow({ where: { id: idOf(5) } });
        expect(reset.analysisStatus).toBe("pending");
        expect(reset.analysisRetryCount).toBe(0);
        expect([reset.moodHappy, reset.moodSad, reset.moodRelaxed, reset.moodAggressive, reset.moodParty,
            reset.moodAcoustic, reset.moodElectronic, reset.danceabilityMl]).toEqual(Array(8).fill(null));
        expect(reset.moodTags).toEqual([]);

        // Fixed-analyzer rows and standard-mode rows are left alone.
        const fixed = await prisma.track.findUniqueOrThrow({ where: { id: idOf(7) } });
        expect(fixed.analysisStatus).toBe("completed");
        expect(fixed.moodParty).not.toBeNull();
        const standard = await prisma.track.findUniqueOrThrow({ where: { id: idOf(6) } });
        expect(standard.analysisStatus).toBe("completed");
        expect(standard.moodTags).toEqual(["chill"]);
    });
});
