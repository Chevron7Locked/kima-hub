/**
 * The public library export against a real database: only owned, present,
 * mapped tracks are included, each with its nearest such tracks by the matching
 * formula, the ETag holds until the library changes, and readers are served the
 * last finished export while a rebuild runs.
 */
import zlib from "zlib";
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { setLiveHidden } from "../liveListening";
import { latestLibraryExport, refreshLibraryExport } from "../publicLibraryExport";
import { SELF_SCORE, pairScore } from "../matching/formula";
import * as neighbours from "../matching/neighbours";
import { matchingContext } from "../matching/rank";
import { MATCHING_MODEL, buildMatching } from "../matching/state";

jest.setTimeout(60_000);

const DIM = 512;

function axis(...weights: Array<[number, number]>): string {
    const v = new Array(DIM).fill(0);
    for (const [d, w] of weights) v[d] = w;
    return `[${v.join(",")}]`;
}

async function addTrack(
    id: string,
    albumId: string,
    embedding?: string,
    xyz?: [number, number, number],
    missingSince: Date | null = null,
) {
    await prisma.track.create({
        data: {
            id, albumId, title: `T ${id}`, trackNo: 1, duration: 200, energy: 0.71234, valence: 0.2,
            filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000, missingSince,
        },
    });
    if (!embedding) return;
    await prisma.$executeRawUnsafe(
        `INSERT INTO track_embeddings (track_id, embedding, model_version) VALUES ($1, $2::vector, $3)`,
        id, embedding, MATCHING_MODEL,
    );
    if (!xyz) return;
    await prisma.$executeRawUnsafe(
        `INSERT INTO matching_map (track_id, embedded_at, x, y, z, colour, laid_out)
         SELECT track_id, analyzed_at, $2, $3, $4, 0.5, true FROM track_embeddings WHERE track_id = $1`,
        id, ...xyz,
    );
}

/** The formula's score for a pair, scaled to 1 for a track against itself. */
async function formulaMatch(x: string, y: string): Promise<number> {
    const ctx = (await matchingContext([x, y]))!;
    const score = pairScore(ctx.tracks.get(x)!, ctx.tracks.get(y)!, ctx.state.genres, ctx.state.genreWeight ** 2);
    return score / SELF_SCORE;
}

function unpack(gzipped: Buffer) {
    return JSON.parse(zlib.gunzipSync(gzipped).toString());
}

const original = config.publicVibe;

beforeAll(async () => {
    config.publicVibe = { token: "t".repeat(32), username: "Vibe Tester" };
    await prisma.user.create({ data: { id: "usr_pub", username: "Vibe Tester", passwordHash: "x" } });
    await prisma.user.create({ data: { id: "usr_other", username: "Someone Else", passwordHash: "x" } });
    await prisma.artist.create({ data: { id: "art_pub", name: "Pub Artist", identityKey: "a_pub" } });
    await prisma.album.create({
        data: { id: "alb_pub", rgMbid: "rg_pub", artistId: "art_pub", title: "Pub Album", year: 2001, primaryType: "Album" },
    });
    await addTrack("trk_a", "alb_pub", axis([0, 1]), [0.1, 0.2, 0.3]);
    await addTrack("trk_b", "alb_pub", axis([0, 1], [1, 0.6]), [0.11, 0.21, 0.31]);
    await addTrack("trk_c", "alb_pub", axis([1, 1]), [0.9, 0.8, 0.7]);
    await addTrack("trk_unmapped", "alb_pub", axis([0, 1]));
    await addTrack("trk_unanalysed", "alb_pub");
    await prisma.album.create({
        data: { id: "alb_disc", rgMbid: "rg_disc", identityKey: "al_disc", artistId: "art_pub", title: "Suggested", primaryType: "Album", location: "DISCOVER" },
    });
    await addTrack("trk_suggested", "alb_disc", axis([0, 1], [2, 0.01]), [0.1, 0.2, 0.3]);
    await addTrack("trk_missing", "alb_pub", axis([0, 1], [3, 0.01]), [0.1, 0.2, 0.3], new Date());
    await buildMatching();
});

afterAll(async () => {
    config.publicVibe = original;
    // The test DB is shared by every file in the run; these ids are not
    // prefixed, so they are listed and removed one by one.
    await prisma.$executeRawUnsafe(
        `DELETE FROM track_embeddings WHERE track_id = ANY($1)`,
        ["trk_a", "trk_b", "trk_c", "trk_unmapped", "trk_unanalysed", "trk_suggested", "trk_missing"],
    );
    await prisma.$executeRawUnsafe(
        `DELETE FROM "Track" WHERE id = ANY($1)`,
        ["trk_a", "trk_b", "trk_c", "trk_unmapped", "trk_unanalysed", "trk_suggested", "trk_missing"],
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id = ANY($1)`, ["alb_pub", "alb_disc"]);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id = $1`, "art_pub");
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id = ANY($1)`, ["usr_pub", "usr_other"]);
    await prisma.$executeRawUnsafe(`DELETE FROM matching_state`);
});

/** The map step stamps every write to the map; a test that moves a track does too. */
async function stampMap() {
    await prisma.$executeRawUnsafe(`UPDATE matching_state SET "mapUpdatedAt" = clock_timestamp() WHERE id = 'default'`);
}

describe("public library export", () => {
    it("has nothing to serve until the first build finishes", async () => {
        expect(latestLibraryExport()).toBeNull();
        const built = await refreshLibraryExport();
        expect(latestLibraryExport()).toBe(built);
    });

    it("lists the mapped tracks with their nearest mapped tracks", async () => {
        const doc = unpack((await refreshLibraryExport()).gzipped);
        expect(doc.version).toBe(2);
        expect(doc.library).toEqual({ id: "vibe-tester", name: "Vibe Tester", engine: { analyzer: null, embedding: MATCHING_MODEL } });
        expect(doc.artists).toEqual([{ id: "art_pub", name: "Pub Artist" }]);
        expect(doc.albums).toEqual([{ id: "alb_pub", artistId: "art_pub", title: "Pub Album", year: 2001 }]);
        expect(doc.tracks.map((t: any) => t.id)).toEqual(["trk_a", "trk_b", "trk_c"]);
        expect(doc.excluded).toBe(2);

        const a = doc.tracks[0];
        expect(a).toMatchObject({ xyz: [0.1, 0.2, 0.3], duration: 200, energy: 0.712, valence: 0.2 });
        // trk_a's album also holds trk_b and trk_c; with trk_a counted it has room for one.
        expect(a.neighbours.map(([id]: [string]) => id)).toEqual(["trk_b"]);
        expect(Math.abs(a.neighbours[0][1] - (await formulaMatch("trk_a", "trk_b")))).toBeLessThanOrEqual(5e-5);
    });

    it("counts the public user's listens per track, by the stats page's rule, from every source", async () => {
        const dayAgo = (hours: number) => new Date(Date.now() - 86_400_000 * 2 - hours * 3_600_000);
        await prisma.play.createMany({
            data: [
                // Two rows inside one song's length are one listen.
                { id: "ply_1", userId: "usr_pub", trackId: "trk_a", playedAt: dayAgo(5), heard: true },
                { id: "ply_2", userId: "usr_pub", trackId: "trk_a", playedAt: new Date(dayAgo(5).getTime() + 10_000), heard: true },
                { id: "ply_3", userId: "usr_pub", trackId: "trk_a", playedAt: dayAgo(3), source: "SUBSONIC" },
                { id: "ply_4", userId: "usr_other", trackId: "trk_a", playedAt: dayAgo(4), heard: true },
                { id: "ply_5", userId: "usr_other", trackId: "trk_b", playedAt: dayAgo(4), heard: true },
            ],
        });
        const doc = unpack((await refreshLibraryExport()).gzipped);
        expect(Object.fromEntries(doc.tracks.map((t: any) => [t.id, t.plays]))).toEqual({ trk_a: 2, trk_b: 0, trk_c: 0 });
    });

    it("waits for the day to turn before a new listen rebuilds it, and takes it in then", async () => {
        const before = await refreshLibraryExport();
        await prisma.play.create({ data: { id: "ply_today", userId: "usr_pub", trackId: "trk_c", playedAt: new Date(), heard: true } });
        expect(await refreshLibraryExport()).toBe(before);

        const startOfToday = new Date();
        startOfToday.setUTCHours(0, 0, 0, 0);
        await prisma.play.update({
            where: { id: "ply_today" },
            data: { playedAt: new Date(startOfToday.getTime() - 60_000) },
        });
        const next = await refreshLibraryExport();
        expect(next.etag).not.toBe(before.etag);
        expect(unpack(next.gzipped).tracks.find((t: any) => t.id === "trk_c").plays).toBe(1);
    });

    it("carries no plays while the public user has turned off sharing what they play", async () => {
        setLiveHidden(true);
        // The export built before the switch is not served, not even for the length of the rebuild.
        expect(latestLibraryExport()).toBeNull();
        const hidden = unpack((await refreshLibraryExport()).gzipped);
        expect(latestLibraryExport()).not.toBeNull();
        expect(hidden.tracks.every((t: any) => t.plays === 0)).toBe(true);

        setLiveHidden(false);
        const shown = unpack((await refreshLibraryExport()).gzipped);
        expect(shown.tracks.find((t: any) => t.id === "trk_a").plays).toBe(2);
    });

    it("keeps its ETag and its bytes while nothing changes", async () => {
        const first = await refreshLibraryExport();
        const second = await refreshLibraryExport();
        expect(second.etag).toBe(first.etag);
        expect(second.gzipped).toBe(first.gzipped);
    });

    it("serves the last export without waiting while a rebuild runs", async () => {
        const before = await refreshLibraryExport();
        await prisma.$executeRawUnsafe(`UPDATE matching_map SET z = 0.4 WHERE track_id = 'trk_c'`);
        await stampMap();
        expect(latestLibraryExport()).toBe(before);
        const after = await refreshLibraryExport();
        expect(after.etag).not.toBe(before.etag);
        expect(latestLibraryExport()).toBe(after);
        await refreshLibraryExport();
    });

    it("rebuilds when a track moves on the map", async () => {
        const before = await refreshLibraryExport();
        await prisma.$executeRawUnsafe(`UPDATE matching_map SET x = 0.5 WHERE track_id = 'trk_c'`);
        await stampMap();
        const after = await refreshLibraryExport();
        expect(after.etag).not.toBe(before.etag);
        expect(unpack(after.gzipped).tracks[2].xyz[0]).toBe(0.5);
    });

    it("rebuilds when an album is renamed", async () => {
        const before = await refreshLibraryExport();
        await prisma.album.update({ where: { id: "alb_pub" }, data: { title: "Renamed" } });
        const after = await refreshLibraryExport();
        expect(after.etag).not.toBe(before.etag);
        expect(unpack(after.gzipped).albums[0].title).toBe("Renamed");
    });

    it("gives concurrent callers one build", async () => {
        await prisma.$executeRawUnsafe(`UPDATE matching_map SET y = 0.6 WHERE track_id = 'trk_c'`);
        await stampMap();
        const [x, y] = await Promise.all([refreshLibraryExport(), refreshLibraryExport()]);
        expect(x.gzipped).toBe(y.gzipped);
    });

    it("runs one build at a time, then one build of the newest library for everyone who saw a change", async () => {
        const realWorker = neighbours.neighbourListsInWorker;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let started!: () => void;
        const inBuild = new Promise<void>((resolve) => (started = resolve));
        const spy = jest
            .spyOn(neighbours, "neighbourListsInWorker")
            .mockImplementationOnce(async (...args) => {
                started();
                await gate;
                return realWorker(...args);
            });
        try {
            await prisma.$executeRawUnsafe(`UPDATE matching_map SET x = 0.6 WHERE track_id = 'trk_c'`);
            await stampMap();
            const first = refreshLibraryExport();
            await inBuild;
            await prisma.$executeRawUnsafe(`UPDATE matching_map SET x = 0.7 WHERE track_id = 'trk_c'`);
            await stampMap();
            const second = refreshLibraryExport();
            await prisma.$executeRawUnsafe(`UPDATE matching_map SET x = 0.8 WHERE track_id = 'trk_c'`);
            await stampMap();
            const third = refreshLibraryExport();
            release();
            const [a, b, c] = await Promise.all([first, second, third]);
            expect(unpack(a.gzipped).tracks[2].xyz[0]).toBe(0.6);
            expect(b).toBe(c);
            expect(unpack(c.gzipped).tracks[2].xyz[0]).toBe(0.8);
            expect(spy).toHaveBeenCalledTimes(2);
        } finally {
            spy.mockRestore();
        }
    });

    it("rebuilds when the similarity step rebuilds the library's matching statistics", async () => {
        const before = await refreshLibraryExport();
        await prisma.artist.update({ where: { id: "art_pub" }, data: { genres: ["rock"] } });
        expect((await buildMatching()).rebuilt).toBe(true);
        const after = await refreshLibraryExport();
        expect(after.etag).not.toBe(before.etag);
    });

    it("takes in a suggested album once it is owned, and a missing file once it is found", async () => {
        const before = await refreshLibraryExport();
        await prisma.album.update({ where: { id: "alb_disc" }, data: { location: "LIBRARY" } });
        await prisma.track.update({ where: { id: "trk_missing" }, data: { missingSince: null } });
        await buildMatching();
        const after = await refreshLibraryExport();
        expect(after.etag).not.toBe(before.etag);
        const doc = unpack(after.gzipped);
        expect(doc.tracks.map((t: any) => t.id)).toEqual(["trk_a", "trk_b", "trk_c", "trk_missing", "trk_suggested"]);
        expect(doc.excluded).toBe(2);
        // trk_missing takes the album's one free place from trk_b; trk_suggested is on its own album.
        expect(doc.tracks[0].neighbours.map(([id]: [string]) => id).sort()).toEqual(["trk_missing", "trk_suggested"]);
    });
});
