/**
 * A track whose file is gone (missingSince set) must answer absent from every consumer —
 * similar tracks, mood buckets, song paths, mixes — while streaming already
 * refuses it. Clearing the flag brings it back everywhere, with no work.
 */
import fs from "fs";
import path from "path";
import { prisma } from "../../utils/db";
import { findSimilarTracks } from "../hybridSimilarity";
import { generateSongPath } from "../songPath";
import { generateMoodOnDemand } from "../mixes/moodMixes";
import { getVibeMap } from "../vibeMap";
import { syncMoodBuckets } from "../../workers/moodBucketWorker";
import { MATCHING_MODEL, buildMatching } from "../matching/state";

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(async () => null),
        setex: jest.fn(async () => "OK"),
        del: jest.fn(async () => 1),
        multi: jest.fn(() => {
            const chain: any = {
                setex: () => chain,
                del: () => chain,
                sadd: () => chain,
                expire: () => chain,
                exec: async () => [],
            };
            return chain;
        }),
    },
}));

jest.setTimeout(60_000);

const MISSING = "trk_elig_gone";
const N = 12;

async function seed() {
    // One artist and album per track: the similar-track path caps picks per
    // album and per artist, and the test must not have a track dropped by
    // that cap rather than by the eligibility rule under test.
    for (let i = 0; i < N; i++) {
        const id = i === N - 1 ? MISSING : `trk_elig_${i}`;
        const artist = await prisma.artist.create({
            data: { id: `art_elig_${i}`, name: `Eligibility Artist ${i}`, identityKey: `a_elig_${i}` },
        });
        const album = await prisma.album.create({
            data: { id: `alb_elig_${i}`, rgMbid: `rg_elig_${i}`, artistId: artist.id, title: `Eligibility Album ${i}`, primaryType: "Album" },
        });
        await prisma.track.create({
            data: {
                id,
                albumId: album.id,
                title: `E ${i}`,
                trackNo: i + 1,
                duration: 180,
                filePath: `/tmp/${id}.flac`,
                fileModified: new Date(),
                fileSize: 1000,
                missingSince: id === MISSING ? new Date() : null,
                analysisStatus: "completed",
                analysisMode: "enhanced",
                analysisVersion: "2.1b6-enhanced-v3",
                vibeAnalysisStatus: "completed",
                analyzedAt: new Date(Date.UTC(2026, 9, 1, 0, i)),
                // Low energy, for the custom mix's range.
                energy: 0.3,
                bpm: 90,
                moodRelaxed: 0.9,
                moodHappy: 0.1,
                moodSad: 0.1,
                moodAggressive: 0.05,
                moodParty: i / (N - 1),
            },
        });
        // One-hot 512-d embeddings; the seed and the missing track are the
        // two closest pair, so an unfiltered query finds the missing track.
        const v = Array.from({ length: 512 }, (_, d) => (d === i ? 1 : 0.001));
        await prisma.$executeRawUnsafe(
            `INSERT INTO track_embeddings (track_id, embedding, model_version) VALUES ($1, $2::vector, $3)`,
            id,
            `[${v.join(",")}]`,
            MATCHING_MODEL,
        );
    }
    await buildMatching();
}

/**
 * Grep gate: every raw query over track_embeddings in the recommendation
 * consumers must carry the eligibility fragment in the same template. Seed lookups
 * (a single track by id, chosen by the user) are the allowlisted exception
 * — they read the track the request names, and streaming refuses it.
 */
describe("grep gate: no embedding query without the eligibility fragment", () => {
    const CONSUMERS = [
        "services/hybridSimilarity.ts",
        "services/matching/rank.ts",
        "services/textEmbeddingBridge.ts",
        "services/vibeMap.ts",
        "services/matching/map.ts",
        "services/search.ts",
        "routes/vibe.ts",
    ];
    // Seed lookups: the query reads exactly the tracks the request names (by
    // id), which streaming refuses if they are gone.
    const SEED_LOOKUP = /WHERE (te\.|t\.)?(track_id|id) = (ANY\()?\$\{/;
    // Status counters: plain COUNT over the whole table — the counted-and-
    // shown exception of invariant 3, not a consumer of results.
    const STATUS_COUNT = /^\s*SELECT\s+COUNT\(/i;

    it.each(CONSUMERS)("every library query in %s is filtered", (file) => {
        const src = fs.readFileSync(path.join(__dirname, "../..", file), "utf8");
        const templates = [
            ...[...src.matchAll(/\$queryRaw(?:<[^>]*>)?`([\s\S]*?)`/g)].map((m) => m[1]),
            ...[...src.matchAll(/Prisma\.sql`([\s\S]*?)`/g)].map((m) => m[1]),
        ];
        expect(templates.length).toBeGreaterThan(0); // the scan must find the queries
        for (const sql of templates) {
            if (!/FROM (track_embeddings|"Track")/.test(sql)) continue;
            if (SEED_LOOKUP.test(sql) || STATUS_COUNT.test(sql)) continue;
            expect(sql).toMatch(/"missingSince" IS NULL/);
        }
    });
});

describe("library eligibility at the read side", () => {
    beforeAll(seed);
    // The test DB is shared by every file in the run; leaving these rows makes
    // other files' queue sweeps see eleven extra due embeddings.
    afterAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM track_embeddings WHERE track_id LIKE $1`, "trk\\_elig\\_%");
        for (const [table, pattern] of [
            ["Track", "trk\\_elig\\_%"],
            ["Album", "alb\\_elig\\_%"],
            ["Artist", "art\\_elig\\_%"],
        ] as const) {
            await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id LIKE $1`, pattern);
        }
    });

    it("keeps the missing file out of similar tracks", async () => {
        const similar = await findSimilarTracks("trk_elig_0", 20);
        expect(similar.length).toBeGreaterThan(0);
        expect(similar.some((t) => t.id === MISSING)).toBe(false);
    });

    it("keeps it out of the mood buckets", async () => {
        await syncMoodBuckets();
        const rows = await prisma.moodBucket.findMany({ where: { trackId: MISSING } });
        expect(rows).toHaveLength(0);
        // trk_elig_10 has the highest party head (10/11): the bucket the
        // missing track would have ranked into with the same value.
        const kept = await prisma.moodBucket.findMany({ where: { trackId: "trk_elig_10" } });
        expect(kept.length).toBeGreaterThan(0);
    });

    it("keeps it out of song paths between two present tracks", async () => {
        const path = await generateSongPath("trk_elig_0", "trk_elig_1", { length: 10 });
        expect(path.path.length).toBeGreaterThan(0);
        expect(path.path.map((t) => t.id)).not.toContain(MISSING);
    });

    it("keeps it out of a generated mix that reads the track table", async () => {
        const mix = await generateMoodOnDemand("u_elig", { energy: { max: 0.5 } });
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).not.toContain(MISSING);
    });

    it("keeps it out of the vibe map", async () => {
        await prisma.$executeRawUnsafe(
            `INSERT INTO matching_map (track_id, embedded_at, x, y, z, colour, laid_out)
             SELECT track_id, analyzed_at, 0.1, 0.2, 0.3, 0.5, true FROM track_embeddings WHERE track_id = ANY($1)`,
            [MISSING, "trk_elig_0"],
        );
        const state = await getVibeMap();
        expect(state.status).toBe("ready");
        if (state.status !== "ready") return;
        expect(state.data.tracks.map((t) => t.id).filter((id) => id.startsWith("trk_elig_"))).toEqual(["trk_elig_0"]);
    });

    it("brings the track back to everything when the file returns", async () => {
        await prisma.track.update({ where: { id: MISSING }, data: { missingSince: null } });
        const similar = await findSimilarTracks("trk_elig_0", 20);
        expect(similar.some((t) => t.id === MISSING)).toBe(true);
    });
});
