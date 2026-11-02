/**
 * Who may be in a night mix: the 2-per-artist cap holds over the listener's own songs and the fallback top-up together,
 * a top-up song is never another copy of one already picked, and a song a scan marked corrupt is never offered (the
 * similar-song fill included). On the synthetic library, as nightPlays.integration.test.ts.
 */
import { prisma } from "../../../utils/db";
import { redisClient, waitForRedisReady } from "../../../utils/redis";
import { buildMatching } from "../../matching/state";
import { matchingContext, topScores } from "../../matching/rank";
import {
    LibraryHandle, removeSyntheticLibrary, seedSyntheticLibrary, seedSyntheticMoods,
} from "../../../__tests__/fixtures/syntheticLibrary";
import { buildMoodState } from "../../moods/state";
import { getRecipe, recipeMembers } from "../recipes";
import { ENERGY_BAND_KEY, nightMixTracks } from "../nightPlays";
import { artistIdentityKey } from "../../artistIdentity";
import { VARIOUS_ARTISTS_CANONICAL } from "../../../utils/artistNormalization";

jest.setTimeout(300_000);
const PREFIX = "nmel_";
let lib: LibraryHandle;
const BASE = new Date();
BASE.setUTCHours(0, 0, 0, 0);
BASE.setUTCDate(BASE.getUTCDate() - 3);
const NIGHT = new Date(BASE.getTime() + 23 * 3600_000);
const play = (userId: string, trackId: string, times: number) =>
    prisma.play.createMany({ data: Array.from({ length: times }, () => ({ userId, trackId, playedAt: NIGHT, heard: true })) });
const spec = { fallbackRecipe: "late-night", ranking: "plays" } as const;

beforeAll(async () => {
    await waitForRedisReady();
    lib = await seedSyntheticLibrary(PREFIX);
    await seedSyntheticMoods(PREFIX);
    await prisma.$transaction((tx) => buildMoodState(tx));
});
afterAll(async () => {
    await removeSyntheticLibrary(PREFIX);
    await prisma.$executeRawUnsafe(`DELETE FROM mood_state`);
    await prisma.$executeRawUnsafe(`DELETE FROM matching_state`);
    await prisma.$disconnect();
});
beforeEach(async () => {
    await prisma.play.deleteMany({ where: { userId: { startsWith: PREFIX } } });
    await redisClient.del(ENERGY_BAND_KEY);
});

it("a night mix holds at most 2 songs by one artist when the fallback recipe tops up the listener's own songs", async () => {
    const members = (await recipeMembers(getRecipe("late-night"), lib.user1))!;
    const byArtist = new Map<string, string[]>();
    for (const m of members) byArtist.set(m.artistId, [...(byArtist.get(m.artistId) ?? []), m.id]);
    const found = [...byArtist.entries()].find(([, v]) => v.length >= 4);
    expect(found).toBeDefined();
    const [artistId, ids] = found!;
    await play(lib.user1, ids[0], 3);
    await play(lib.user1, ids[1], 3);
    const artistOf = new Map(members.map((m) => [m.id, m.artistId]));
    let worst = 0;
    for (let d = 1; d <= 20; d++) {
        const picked = (await nightMixTracks(spec, lib.user1, `2026-05-${String(d).padStart(2, "0")}`, "UTC", 60))!;
        const n = picked.filter((id) => artistOf.get(id) === artistId).length;
        worst = Math.max(worst, n);
    }
    expect(worst).toBeLessThanOrEqual(2);
});

it("the fallback top-up leaves out another copy of a song the listener played at night", async () => {
    const members = (await recipeMembers(getRecipe("late-night"), lib.user1))!;
    const memberIds = new Set(members.map((m) => m.id));
    const candidates = await prisma.track.findMany({
        where: { id: { startsWith: PREFIX }, missingSince: null, corrupt: false, album: { location: "LIBRARY" } },
        select: { id: true, albumId: true, album: { select: { artistId: true } } },
        orderBy: { id: "asc" },
    });
    const member = members.find((m) => candidates.some((c) => c.album.artistId === m.artistId && !memberIds.has(c.id)))!;
    expect(member).toBeDefined();
    const played = candidates.find((c) => c.album.artistId === member.artistId && !memberIds.has(c.id))!;
    // The member is made another copy of the played song: the same title (in another case) by the same artist.
    const title = (await prisma.track.findUniqueOrThrow({ where: { id: played.id }, select: { title: true } })).title;
    await prisma.track.update({ where: { id: member.id }, data: { title: title.toUpperCase() } });
    await play(lib.user1, played.id, 3);
    for (let d = 1; d <= 5; d++) {
        const picked = (await nightMixTracks(spec, lib.user1, `2026-06-${String(d).padStart(2, "0")}`, "UTC", 1000))!;
        expect(picked).toContain(played.id);
        expect(picked).not.toContain(member.id);
    }
});

it("a corrupt song that sounds like the listener's night song is not in the mix", async () => {
    await prisma.$executeRaw`DELETE FROM matching_state`;
    await buildMatching();
    const seedRow = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT t.id FROM "Track" t JOIN "Album" a ON a.id = t."albumId" JOIN track_embeddings te ON te.track_id = t.id
        WHERE t.id LIKE ${PREFIX + "%"} AND t."missingSince" IS NULL AND t.corrupt = false AND a.location = 'LIBRARY' ORDER BY t.id LIMIT 1`;
    const seed = seedRow[0].id;
    const ctx = await matchingContext([seed]);
    expect(ctx).not.toBeNull();
    const near = (await topScores(ctx!, [{ trackId: seed, weight: 1 }], 40, [seed])).map((r) => r.id);
    const doomed = near.slice(0, 10);
    await prisma.track.updateMany({ where: { id: { in: doomed } }, data: { corrupt: true } });
    await play(lib.user1, seed, 5);
    const picked = (await nightMixTracks(spec, lib.user1, "2026-05-02", "UTC", 20))!;
    const leaked = picked.filter((id) => doomed.includes(id));
    expect(picked.length).toBeGreaterThan(0);
    expect(leaked).toEqual([]);
});

/** One played night song and the songs nearest to it (the similar fill's candidates), with each one's album and artist. */
async function seedAndNear() {
    await prisma.$executeRaw`DELETE FROM matching_state`;
    await buildMatching();
    const seedRow = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT t.id FROM "Track" t JOIN "Album" a ON a.id = t."albumId" JOIN track_embeddings te ON te.track_id = t.id
        WHERE t.id LIKE ${PREFIX + "%"} AND t."missingSince" IS NULL AND t.corrupt = false AND a.location = 'LIBRARY' ORDER BY t.id LIMIT 1`;
    const seed = seedRow[0].id;
    const ctx = (await matchingContext([seed]))!;
    const nearIds = (await topScores(ctx, [{ trackId: seed, weight: 1 }], 60, [seed])).map((r) => r.id);
    const rows = await prisma.track.findMany({ where: { id: { in: nearIds } }, select: { id: true, albumId: true, album: { select: { artistId: true } } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    await play(lib.user1, seed, 5);
    return { seed, near: nearIds.map((id) => byId.get(id)!) };
}

it("two similar songs with one title by one artist come out as one song in the mix", async () => {
    const { near } = await seedAndNear();
    const byArtist = new Map<string, typeof near>();
    for (const n of near) byArtist.set(n.album.artistId, [...(byArtist.get(n.album.artistId) ?? []), n]);
    const pair = [...byArtist.values()].find((v) => v.length >= 2)!;
    expect(pair).toBeDefined();
    const [a, b] = pair;
    const before = (await nightMixTracks(spec, lib.user1, "2026-07-01", "UTC", 1000))!;
    expect(before).toContain(a.id);
    expect(before).toContain(b.id);
    const title = (await prisma.track.findUniqueOrThrow({ where: { id: a.id }, select: { title: true } })).title;
    await prisma.track.update({ where: { id: b.id }, data: { title: title.toUpperCase() } });
    const picked = (await nightMixTracks(spec, lib.user1, "2026-07-01", "UTC", 1000))!;
    expect(picked.filter((id) => id === a.id || id === b.id)).toHaveLength(1);
});

it("similar songs on compilations are each their own artist, as the listener's own songs are, so the cap does not pool them", async () => {
    const { near } = await seedAndNear();
    const key = artistIdentityKey(VARIOUS_ARTISTS_CANONICAL);
    const existing = await prisma.artist.findUnique({ where: { identityKey: key } });
    const various = existing ?? (await prisma.artist.create({ data: { id: `${PREFIX}various`, name: VARIOUS_ARTISTS_CANONICAL, identityKey: key } }));
    const moved = near.slice(0, 4);
    const albums: string[] = [];
    try {
        for (const [i, m] of moved.entries()) {
            const id = `${PREFIX}comp${i}`;
            albums.push(id);
            await prisma.album.create({
                data: { id, rgMbid: `${PREFIX}rg_comp${i}`, artistId: various.id, identityKey: `${PREFIX}ik_comp${i}`, title: `nmel comp ${i}`, primaryType: "Album", location: "LIBRARY" },
            });
            await prisma.track.update({ where: { id: m.id }, data: { albumId: id } });
        }
        const picked = (await nightMixTracks(spec, lib.user1, "2026-07-02", "UTC", 1000))!;
        expect(moved.filter((m) => picked.includes(m.id))).toHaveLength(4);
    } finally {
        for (const m of moved) await prisma.track.update({ where: { id: m.id }, data: { albumId: m.albumId } });
        await prisma.album.deleteMany({ where: { id: { in: albums } } });
        if (!existing) await prisma.artist.delete({ where: { id: various.id } });
    }
});
