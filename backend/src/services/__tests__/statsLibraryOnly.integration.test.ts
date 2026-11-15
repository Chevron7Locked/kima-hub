/**
 * The stats overview counts library plays only (Kevin, 2026-11-15): a play of a
 * Discover song appears in no figure, and the sources chart has no Discover
 * part. A play's album location says which it was, not its label. Seeds one
 * library play and two Discover plays, then reads every section of the page.
 */
import { prisma } from "../../utils/db";
import { listeningStats, hourDetail, regionDetail } from "../stats/listening";
import { withListens, type Period } from "../stats/listens";
import { signature } from "../stats/signature";
import { playableSlice } from "../stats/playable";

const P = "slo";
const user = `${P}u`;

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "Play" WHERE "userId" LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE id LIKE '${P}%'`);
}

/** The listening and signature sections, each read from one fold as the stats route reads them. */
const overview = (period: Period = "all") => withListens(user, period, (l) => listeningStats(l, "UTC"));
const signatureOf = () => withListens(user, "all", (l) => signature(l, "UTC"));

const audio = { energy: 0.5, valence: 0.5, bpm: 120, key: "C", keyScale: "major" };

async function seedAlbum(n: string, location: "LIBRARY" | "DISCOVER", year: number) {
    await prisma.artist.create({ data: { id: `${P}art${n}`, name: `Artist ${n}`, identityKey: `${P}-a${n}` } });
    await prisma.album.create({
        data: { id: `${P}alb${n}`, artistId: `${P}art${n}`, rgMbid: `${P}-rg${n}`, title: `Album ${n}`, primaryType: "Album", location, year },
    });
    await prisma.track.create({
        data: {
            id: `${P}t${n}`, albumId: `${P}alb${n}`, title: `Song ${n}`, trackNo: 1, duration: 200,
            filePath: `/tmp/${P}${n}.flac`, fileModified: new Date(), fileSize: 1, ...audio,
        },
    });
}

beforeAll(async () => {
    await cleanup();
    await prisma.user.create({ data: { id: user, username: `${P}-user`, passwordHash: "x" } });
    await seedAlbum("L", "LIBRARY", 2001);
    await seedAlbum("D", "DISCOVER", 2020);
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
    await prisma.play.createMany({
        data: [
            // One library play (a play carries no Discover label: the album says where it was) ...
            { userId: user, trackId: `${P}tL`, playedAt: at(10), source: "LIBRARY" },
            // ... and two Discover plays, a day apart so they are two listens.
            { userId: user, trackId: `${P}tD`, playedAt: at(3), source: "LIBRARY" },
            { userId: user, trackId: `${P}tD`, playedAt: at(2), source: "LIBRARY" },
        ],
    });
});
afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

it("counts only the library play in the totals, top lists, charts and sources", async () => {
    const L = await overview();
    expect(L.plays).toBe(1);
    expect(L.distinctTracks).toBe(1);
    expect(L.distinctArtists).toBe(1);
    expect(L.distinctAlbums).toBe(1);
    expect(L.topArtists.map((a) => a.id)).toEqual([`${P}artL`]);
    expect(L.topTracks.map((t) => t.id)).toEqual([`${P}tL`]);
    expect(L.clock.flat().reduce((a, b) => a + b, 0)).toBe(1);
    expect(L.shape.reduce((a, s) => a + s.plays, 0)).toBe(1);
    expect(L.drift.reduce((a, d) => a + d.plays, 0)).toBe(1);
    // No Discover part.
    expect(L.bySource).toEqual({ LIBRARY: 1 });
});

it("keeps Subsonic plays in the sources chart", async () => {
    const row = await prisma.play.create({
        data: { userId: user, trackId: `${P}tL`, playedAt: new Date(Date.now() - 86_400_000), source: "SUBSONIC" },
    });
    try {
        const L = await overview();
        expect(L.bySource).toEqual({ LIBRARY: 1, SUBSONIC: 1 });
    } finally {
        await prisma.play.delete({ where: { id: row.id } });
    }
});

it("leaves Discover out of the windowed overview too", async () => {
    const L = await overview("30d");
    expect(L.plays).toBe(1);
    expect(L.topTracks.map((t) => t.id)).toEqual([`${P}tL`]);
});

it("leaves Discover out of the signature", async () => {
    const s = await signatureOf();
    expect(s.concentration).toMatchObject({ distinct: 1 });
    expect(s.key?.all.reduce((a, k) => a + k.plays, 0)).toBe(1);
    expect(s.hourly.reduce((a, h) => a + h.plays, 0)).toBe(1);
    expect(s.era?.buckets.reduce((a, b) => a + b.plays, 0)).toBe(1);
});

it("leaves Discover out of a clicked cell and region", async () => {
    const hours = await prisma.$queryRaw<Array<{ dow: number; hour: number }>>`
        SELECT EXTRACT(DOW FROM "playedAt")::int AS dow, EXTRACT(HOUR FROM "playedAt")::int AS hour
        FROM "Play" WHERE "userId" = ${user}`;
    for (const h of hours) {
        const detail = await hourDetail(user, h.dow, h.hour, "UTC");
        expect(detail.tracks.map((t) => t.title)).not.toContain("Song D");
    }

    const region = await regionDetail(user, 13, 13, 1);
    expect(region.listens).toBe(1);
    expect(region.tracks.map((t) => t.title)).toEqual(["Song L"]);
});

it("leaves Discover songs out of the top-songs slice", async () => {
    const top = await playableSlice({ userId: user, slice: "top" });
    expect(top.map((t) => t.id)).toEqual([`${P}tL`]);
    const key = await playableSlice({ userId: user, slice: "key", key: "C major" });
    expect(key.map((t) => t.id)).toEqual([`${P}tL`]);
});
