/**
 * GET /library/radio, every branch, against a real Postgres holding the 3,000
 * track synthetic library (src/__tests__/fixtures/syntheticLibrary.ts; ids are
 * handed out in energy order, so a "first N rows" draw shows up as ids bunched
 * at the front). The library router is mounted on a real express app and
 * called over HTTP with supertest; the route does not read the signed-in user,
 * so no auth is mounted and nothing is mocked.
 *
 * For each branch, over 10 consecutive calls:
 *   1. size   - each call returns exactly `limit` tracks, no repeats;
 *   2. clause - every track satisfies the branch's clause (written out here
 *               against the stored row) and is playable (file present, not
 *               corrupt);
 *   3. spread - together the calls return more than 3x `limit` distinct
 *               tracks and reach the first and the last third of the ids that
 *               match (the branch has well over 10x `limit` matches).
 *
 * The describe blocks at the end change the library (marking every track
 * pending, deleting plays or genre rows) to reach the fallback stages; they run
 * last and the library is deleted afterwards.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import {
    LibraryHandle,
    Row,
    WORKOUT_GENRES,
    loadRows,
    removeSyntheticLibrary,
    seedSyntheticLibrary,
    spanOf,
} from "../../../__tests__/fixtures/syntheticLibrary";
import router from "../tracks";

jest.setTimeout(600_000);

const PREFIX = "rad_";
const LIMIT = 20;
const CALLS = 10;

let lib: LibraryHandle;
let rows: Row[];
let byId: Map<string, Row>;

const app = express();
app.use(express.json());
app.use("/", router);

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
const done = (r: Row) => r.analysisStatus === "completed";
const playable = (r: Row) => r.missingSince === null && !r.corrupt;
const inBucket = (m: string) => (r: Row) => r.buckets.includes(m);
const year = (r: Row) => r.album.originalYear ?? r.album.year;
const artistGenres = (r: Row) =>
    [...((r.album.artist.genres as string[] | null) ?? []), ...((r.album.artist.userGenres as string[] | null) ?? [])];

interface RadioTrack {
    id: string;
    title: string;
    filePath: string;
    artist: { id: string; name: string };
    album: { id: string; title: string };
}

async function radio(query: Record<string, string | number>) {
    const res = await request(app).get("/radio").query(query);
    return res;
}

async function calls(query: Record<string, string | number>, n = CALLS): Promise<RadioTrack[][]> {
    const out: RadioTrack[][] = [];
    for (let k = 0; k < n; k++) {
        const res = await radio(query);
        expect(res.status).toBe(200);
        out.push(res.body.tracks);
    }
    return out;
}

interface Branch {
    name: string;
    query: Record<string, string | number>;
    /** The branch's clause, by hand (without the playable check, which every branch shares). */
    clause: (r: Row) => boolean;
}

const branches: Branch[] = [
    { name: "discovery", query: { type: "discovery" }, clause: (r) => r.plays === 0 },
    { name: "favorites", query: { type: "favorites" }, clause: (r) => r.plays > 0 },
    { name: "decade 1990", query: { type: "decade", value: 1990 },
      clause: (r) => year(r) !== null && year(r)! >= 1990 && year(r)! < 2000 },
    { name: "decade 1970", query: { type: "decade", value: 1970 },
      clause: (r) => year(r) !== null && year(r)! >= 1970 && year(r)! < 1980 },
    { name: "genre rock", query: { type: "genre", value: "rock" },
      clause: (r) => artistGenres(r).some((g) => g.toLowerCase().includes("rock")) },
    { name: "genre Pop (value is lower-cased)", query: { type: "genre", value: "Pop" },
      clause: (r) => artistGenres(r).some((g) => g.toLowerCase().includes("pop")) },
    { name: "mood happy", query: { type: "mood", value: "happy" }, clause: inBucket("happy") },
    { name: "mood melancholy (sad bucket)", query: { type: "mood", value: "melancholy" }, clause: inBucket("sad") },
    { name: "mood chill", query: { type: "mood", value: "chill" }, clause: inBucket("chill") },
    { name: "mood intense (aggressive bucket)", query: { type: "mood", value: "intense" }, clause: inBucket("aggressive") },
    { name: "mood dance (party bucket)", query: { type: "mood", value: "dance" }, clause: inBucket("party") },
    { name: "mood high-energy", query: { type: "mood", value: "high-energy" },
      clause: (r) => done(r) && ge(r.energy, 0.7) && ge(r.bpm, 120) },
    { name: "mood acoustic", query: { type: "mood", value: "acoustic" },
      clause: (r) => done(r) && ge(r.acousticness, 0.6) },
    { name: "mood instrumental", query: { type: "mood", value: "instrumental" },
      clause: (r) => done(r) && ge(r.instrumentalness, 0.7) },
    { name: "workout", query: { type: "workout" },
      clause: (r) => done(r) && ((ge(r.energy, 0.65) && ge(r.bpm, 115)) || r.moodTags.some((t) => ["workout", "energetic", "upbeat"].includes(t))) },
    { name: "all", query: { type: "all" }, clause: () => true },
];

describe.each(branches)("radio: $name", (b) => {
    let results: RadioTrack[][] = [];
    beforeAll(async () => {
        results = await calls({ ...b.query, limit: LIMIT });
    });
    const matching = () => rows.filter((r) => playable(r) && b.clause(r)).map((r) => r.id);

    it(`returns exactly ${LIMIT} distinct tracks on every call`, () => {
        expect(results).toHaveLength(CALLS);
        for (const tracks of results) {
            expect(tracks).toHaveLength(LIMIT);
            expect(new Set(tracks.map((t) => t.id)).size).toBe(LIMIT);
        }
    });

    it("returns only playable tracks that satisfy the clause", () => {
        expect(matching().length).toBeGreaterThanOrEqual(LIMIT * 10);
        const ids = results.flat().map((t) => t.id);
        expect(ids.filter((id) => !byId.has(id))).toEqual([]);
        expect(ids.filter((id) => !playable(byId.get(id)!))).toEqual([]);
        expect(ids.filter((id) => !b.clause(byId.get(id)!))).toEqual([]);
    });

    it("returns each track with its artist, album and file", () => {
        for (const t of results[0]) {
            const r = byId.get(t.id)!;
            expect(t.artist.id).toBe(r.album.artist.id);
            expect(t.album.id).toBe(r.album.id);
            expect(typeof t.filePath).toBe("string");
        }
    });

    it("draws from the whole match: ten calls give well over one pool, across the id range", () => {
        const span = spanOf(results.flat().map((t) => t.id), matching());
        expect(span.distinct).toBeGreaterThan(LIMIT * 3);
        expect(span.lowest).toBeLessThan(1 / 3);
        expect(span.highest).toBeGreaterThanOrEqual(2 / 3);
    });
});

describe("radio: favorites weighting", () => {
    it("leans toward tracks played more, without being limited to the top few", async () => {
        const results = (await calls({ type: "favorites", limit: LIMIT }, 15)).flat();
        const played = rows.filter((r) => playable(r) && r.plays > 0);
        const meanAll = played.reduce((s, r) => s + r.plays, 0) / played.length;
        const meanReturned = results.reduce((s, t) => s + byId.get(t.id)!.plays, 0) / results.length;
        expect(meanReturned).toBeGreaterThan(meanAll);
        const topTen = new Set([...played].sort((a, b) => b.plays - a.plays).slice(0, 10).map((r) => r.id));
        const distinct = new Set(results.map((t) => t.id));
        expect([...distinct].filter((id) => !topTen.has(id)).length).toBeGreaterThan(100);
    });
});

describe("radio: all", () => {
    it("returns 50 by default and at most 100 for a larger limit", async () => {
        const dflt = await radio({ type: "all" });
        expect(dflt.body.tracks).toHaveLength(50);
        const big = await radio({ type: "all", limit: 500 });
        expect(big.body.tracks).toHaveLength(100);
    });

    it("treats a zero or negative limit as a page of at least 1, never as a draw from the end", async () => {
        expect((await radio({ type: "all", limit: 0 })).body.tracks).toHaveLength(50);
        expect((await radio({ type: "all", limit: -5 })).body.tracks).toHaveLength(1);
        expect((await radio({ type: "mood", value: "happy", limit: -5 })).body.tracks).toHaveLength(1);
        expect((await radio({ type: "artist", value: `${PREFIX}art_5`, limit: 1 })).body.tracks).toHaveLength(1);
    });
});

describe("radio: artist", () => {
    const ARTIST = `${PREFIX}art_5`;
    // The fixture makes artist 5 similar to artists 6..15 (SimilarArtist rows, all owned).
    const similarIds = new Set(Array.from({ length: 10 }, (_, i) => `${PREFIX}art_${6 + i}`));
    let results: RadioTrack[][] = [];
    beforeAll(async () => {
        results = await calls({ type: "artist", value: ARTIST, limit: LIMIT });
    });

    it("mixes the artist's own tracks (40%) with tracks of similar artists, all playable", () => {
        for (const tracks of results) {
            const own = tracks.filter((t) => t.artist.id === ARTIST);
            const similar = tracks.filter((t) => similarIds.has(t.artist.id));
            expect(own.length + similar.length).toBe(tracks.length);
            expect(own.length).toBeLessThanOrEqual(Math.ceil(LIMIT * 0.4));
            expect(similar.length).toBeLessThanOrEqual(LIMIT - Math.ceil(LIMIT * 0.4));
            expect(tracks.every((t) => playable(byId.get(t.id)!))).toBe(true);
        }
    });

    it("returns the full limit", () => {
        // The branch keeps only playable tracks (file present, not corrupt) before it splits the answer into the
        // artist's own 40% and similar artists' 60%, so unplayable tracks (6% of the fixture) never take a slot.
        expect(results.map((t) => t.length)).toEqual(Array(CALLS).fill(LIMIT));
    });

    it("varies from call to call", () => {
        const distinct = new Set(results.flat().map((t) => t.id));
        expect(distinct.size).toBeGreaterThan(LIMIT);
    });

    it("answers an artist with no tracks with an empty list", async () => {
        const res = await radio({ type: "artist", value: "no-such-artist" });
        expect(res.status).toBe(200);
        expect(res.body.tracks).toEqual([]);
    });
});

describe("radio: mood weighting", () => {
    const WEIGHT_CALLS = 60;

    it("leans toward higher bucket scores yet reaches the whole bucket, with the right size", async () => {
        const bucket = await prisma.moodBucket.findMany({
            where: { mood: "happy", trackId: { startsWith: PREFIX } },
            select: { trackId: true, score: true },
        });
        const score = new Map(bucket.map((b) => [b.trackId, b.score]));
        const eligible = bucket.filter((b) => playable(byId.get(b.trackId)!));
        const meanEligible = eligible.reduce((sum, b) => sum + b.score, 0) / eligible.length;

        const results = await calls({ type: "mood", value: "happy", limit: LIMIT }, WEIGHT_CALLS);
        for (const tracks of results) {
            expect(tracks).toHaveLength(LIMIT);
            expect(new Set(tracks.map((t) => t.id)).size).toBe(LIMIT);
        }
        const ids = results.flat().map((t) => t.id);
        expect(ids.filter((id) => !score.has(id))).toEqual([]);

        const meanReturned = ids.reduce((sum, id) => sum + score.get(id)!, 0) / ids.length;
        expect(meanReturned).toBeGreaterThan(meanEligible + 0.05);

        // Per song, a top-quarter song comes back more often than a bottom-quarter one.
        const ranked = [...eligible].sort((a, b) => b.score - a.score);
        const quarter = Math.floor(ranked.length / 4);
        const count = new Map<string, number>();
        for (const id of ids) count.set(id, (count.get(id) ?? 0) + 1);
        const perSong = (rs: typeof ranked) => rs.reduce((sum, r) => sum + (count.get(r.trackId) ?? 0), 0) / rs.length;
        expect(perSong(ranked.slice(0, quarter))).toBeGreaterThan(perSong(ranked.slice(-quarter)) * 2);

        // Every song can be reached: songs from the lowest-scoring third come back too.
        const lowestThird = new Set(ranked.slice(-Math.floor(ranked.length / 3)).map((r) => r.trackId));
        expect(ids.filter((id) => lowestThird.has(id)).length).toBeGreaterThan(0);
    });
});

describe("radio: mood bucket read", () => {
    it("reads only limit x 3 bucket rows, with a score above 0", async () => {
        const spy = jest.spyOn(prisma, "$queryRaw");
        try {
            const res = await radio({ type: "mood", value: "happy", limit: LIMIT });
            expect(res.status).toBe(200);
            const reads = spy.mock.calls
                .map((c, i) => ({ sql: (c[0] as unknown as string[]).join?.("") ?? "", out: spy.mock.results[i].value }))
                .filter((c) => c.sql.includes('"MoodBucket"'));
            expect(reads).toHaveLength(1);
            expect(reads[0].sql).toContain("score > 0");
            expect(await reads[0].out).toHaveLength(LIMIT * 3);
        } finally {
            spy.mockRestore();
        }
    });
});

describe("radio: artist weighting", () => {
    const ARTIST = `${PREFIX}art_5`;
    const similarIds = new Set(Array.from({ length: 10 }, (_, i) => `${PREFIX}art_${6 + i}`));

    // The closeness score the route ranks similar tracks by, from the artist's average sound.
    function closeness(t: Row, vibe: { bpm: number; energy: number; valence: number; danceability: number }) {
        if (!t.bpm && !t.energy && !t.valence) return 0.5;
        let score = 0;
        let factors = 0;
        if (t.bpm && vibe.bpm) { score += Math.max(0, 1 - Math.abs(t.bpm - vibe.bpm) / 40); factors++; }
        if (t.energy !== null && vibe.energy) { score += 1 - Math.abs((t.energy || 0) - vibe.energy); factors++; }
        if (t.valence !== null && vibe.valence) { score += 1 - Math.abs((t.valence || 0) - vibe.valence); factors++; }
        if (t.danceability !== null && vibe.danceability) { score += 1 - Math.abs((t.danceability || 0) - vibe.danceability); factors++; }
        return factors > 0 ? score / factors : 0.5;
    }

    it("leans toward similar tracks closer to the artist's sound, yet reaches past the top slice", async () => {
        const own = rows.filter((r) => r.album.artistId === ARTIST);
        const analysed = own.filter((r) => r.bpm || r.energy || r.valence);
        const mean = (f: (r: Row) => number) => analysed.reduce((sum, r) => sum + f(r), 0) / analysed.length;
        const vibe = {
            bpm: mean((r) => r.bpm || 0),
            energy: mean((r) => r.energy || 0),
            valence: mean((r) => r.valence || 0),
            danceability: mean((r) => r.danceability || 0),
        };
        const candidates = rows.filter((r) => playable(r) && similarIds.has(r.album.artistId));
        const scoreOf = new Map(candidates.map((r) => [r.id, closeness(r, vibe)]));
        const meanCandidates = [...scoreOf.values()].reduce((a, b) => a + b, 0) / scoreOf.size;

        const results = await calls({ type: "artist", value: ARTIST, limit: LIMIT }, 40);
        const returned = results.flat().filter((t) => scoreOf.has(t.id)).map((t) => t.id);
        expect(returned.length).toBeGreaterThan(0);
        const meanReturned = returned.reduce((sum, id) => sum + scoreOf.get(id)!, 0) / returned.length;
        expect(meanReturned).toBeGreaterThan(meanCandidates);

        // The old draw used only the 24 closest tracks; the weighted draw goes well past them.
        const closest = new Set(
            [...scoreOf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([id]) => id),
        );
        expect(new Set(returned.filter((id) => !closest.has(id))).size).toBeGreaterThan(24);
        for (const tracks of results) expect(tracks).toHaveLength(LIMIT);
    });
});

describe("radio: bad requests", () => {
    it("400 without a type", async () => {
        expect((await radio({})).status).toBe(400);
    });
    it("400 for an unknown mood", async () => {
        expect((await radio({ type: "mood", value: "no-such-mood" })).status).toBe(400);
    });
    it("400 for artist radio without an artist", async () => {
        expect((await radio({ type: "artist" })).status).toBe(400);
    });
});

// ---- fallback stages: these change the library, so they run last -------------

describe("radio: discovery falls back to the least-played tracks when fewer than `limit` are unplayed", () => {
    const BIG = 50;
    beforeAll(async () => {
        const unplayed = rows.filter((r) => r.plays === 0).map((r) => r.id);
        // Leave 30 tracks unplayed (fewer than the 50 asked for); everything else unplayed gets one play.
        const giveOne = unplayed.slice(30);
        await prisma.play.createMany({ data: giveOne.map((trackId) => ({ userId: lib.user2, trackId })) });
        for (const id of giveOne) byId.get(id)!.plays = 1;
        rows = [...byId.values()];
    });

    it("returns the limit, only from the tracks with the fewest plays, from across the library", async () => {
        const results = await calls({ type: "discovery", limit: BIG });
        const fewest = rows.filter((r) => playable(r) && r.plays <= 1);
        expect(fewest.length).toBeGreaterThan(BIG * 10);
        for (const tracks of results) {
            expect(tracks).toHaveLength(BIG);
            expect(new Set(tracks.map((t) => t.id)).size).toBe(BIG);
        }
        const ids = results.flat().map((t) => t.id);
        expect(ids.filter((id) => byId.get(id)!.plays > 1)).toEqual([]);
        const span = spanOf(ids, fewest.map((r) => r.id));
        expect(span.distinct).toBeGreaterThan(BIG * 3);
        expect(span.lowest).toBeLessThan(1 / 3);
        expect(span.highest).toBeGreaterThanOrEqual(2 / 3);
    });
});

describe("radio: favorites with no plays at all returns random tracks", () => {
    beforeAll(async () => {
        await prisma.play.deleteMany({ where: { userId: { startsWith: PREFIX } } });
        for (const r of rows) r.plays = 0;
    });

    it("returns the limit of playable tracks drawn from the whole library", async () => {
        const results = await calls({ type: "favorites", limit: LIMIT });
        for (const tracks of results) {
            expect(tracks).toHaveLength(LIMIT);
            expect(new Set(tracks.map((t) => t.id)).size).toBe(LIMIT);
        }
        const ids = results.flat().map((t) => t.id);
        expect(ids.filter((id) => !playable(byId.get(id)!))).toEqual([]);
        const span = spanOf(ids, rows.filter(playable).map((r) => r.id));
        expect(span.distinct).toBeGreaterThan(LIMIT * 3);
        expect(span.lowest).toBeLessThan(1 / 3);
        expect(span.highest).toBeGreaterThanOrEqual(2 / 3);
    });
});

describe("radio: workout falls back to the Genre table, then to album genres", () => {
    const workoutNames = WORKOUT_GENRES;
    const inWorkoutGenres = (r: Row) => r.genreNames.some((n) => workoutNames.includes(n.toLowerCase()));

    describe("when no analysed track matches (stage 2: Genre table)", () => {
        beforeAll(async () => {
            // Nothing is "completed", so the audio-analysis stage finds no track.
            await prisma.track.updateMany({ where: { id: { startsWith: PREFIX } }, data: { analysisStatus: "pending" } });
        });

        it("draws the limit from every track in the workout genres", async () => {
            const results = await calls({ type: "workout", limit: LIMIT });
            for (const tracks of results) {
                expect(tracks).toHaveLength(LIMIT);
                expect(new Set(tracks.map((t) => t.id)).size).toBe(LIMIT);
            }
            const ids = results.flat().map((t) => t.id);
            expect(ids.filter((id) => !playable(byId.get(id)!) || !inWorkoutGenres(byId.get(id)!))).toEqual([]);
            const matching = rows.filter((r) => playable(r) && inWorkoutGenres(r)).map((r) => r.id);
            expect(matching.length).toBeGreaterThanOrEqual(LIMIT * 10);
            const span = spanOf(ids, matching);
            expect(span.distinct).toBeGreaterThan(LIMIT * 3);
            expect(span.lowest).toBeLessThan(1 / 3);
            expect(span.highest).toBeGreaterThanOrEqual(2 / 3);
        });
    });

    describe("when the Genre table has nothing either (stage 3: album genres)", () => {
        beforeAll(async () => {
            await prisma.trackGenre.deleteMany({ where: { trackId: { startsWith: PREFIX } } });
            for (const r of rows) {
                r.genreNames = [];
                r.genreIds = [];
            }
            // Album.genres holds lower-case names; stage 3 asks for albums whose genres contain a workout genre.
        });

        it("draws tracks of albums whose genres name a workout genre", async () => {
            const res = await radio({ type: "workout", limit: LIMIT });
            expect(res.status).toBe(200);
            const albumRows = await prisma.album.findMany({ where: { id: { startsWith: PREFIX } }, select: { id: true, genres: true } });
            const workoutAlbums = new Set(
                albumRows
                    .filter((a) => ((a.genres as string[] | null) ?? []).some((g) => workoutNames.some((w) => g.toLowerCase().includes(w))))
                    .map((a) => a.id),
            );
            expect(workoutAlbums.size).toBeGreaterThan(0);
            expect(res.body.tracks.length).toBeGreaterThan(0);
            for (const t of res.body.tracks as RadioTrack[]) {
                expect(workoutAlbums.has(t.album.id)).toBe(true);
                expect(playable(byId.get(t.id)!)).toBe(true);
            }
        });
    });
});

describe("radio: genre with an artist whose genres are not a JSON array", () => {
    let odd: string;
    beforeAll(async () => {
        odd = rows.find((r) => artistGenres(r).some((g) => g.toLowerCase().includes("rock")))!.album.artist.id;
        await prisma.artist.update({ where: { id: odd }, data: { genres: "rock", userGenres: { rock: true } } });
    });

    it("leaves that artist out instead of failing the request", async () => {
        const res = await radio({ type: "genre", value: "rock", limit: LIMIT });
        expect(res.status).toBe(200);
        expect(res.body.tracks).toHaveLength(LIMIT);
        expect((res.body.tracks as RadioTrack[]).filter((t) => t.artist.id === odd)).toEqual([]);
    });
});
