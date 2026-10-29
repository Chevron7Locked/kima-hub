/**
 * findSimilarTracks returns at most 2 tracks per album and 4 per artist, the
 * seed included, and still fills the requested length. The seed's album and
 * artist sit strictly closest, so an uncapped ranking would be flooded by them.
 */

import { prisma } from "../../utils/db";
import { featureDetection } from "../../services/featureDetection";
import { findSimilarTracks } from "../hybridSimilarity";
import { buildMatching } from "../matching/state";
import { seedEmbedding, unitVectorAt } from "../../__tests__/helpers/embeddingFixtures";

jest.mock("../../services/featureDetection", () => ({
    featureDetection: { getFeatures: jest.fn() },
}));

// The service logs a debug line per call; keep the run output quiet.
jest.mock("../../utils/logger", () => ({
    logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const mockGetFeatures = featureDetection.getFeatures as unknown as jest.Mock;

function setMode(mode: "hybrid" | "featuresOnly") {
    mockGetFeatures.mockResolvedValue({
        musicCNN: true,
        vibeEmbeddings: mode === "hybrid",
        audiobookshelfEnabled: false,
    });
}

async function seedArtist(id: string) {
    await prisma.artist.create({
        data: { id: `art_cap_${id}`, name: `A ${id}`, identityKey: `a_cap_${id}` },
    });
}

async function seedAlbum(id: string, artistId: string, title: string) {
    await prisma.album.create({
        data: {
            id: `alb_cap_${id}`,
            rgMbid: `rg_cap_${id}`,
            artistId: `art_cap_${artistId}`,
            title,
            // Album has @@unique([artistId, identityKey]) with identityKey
            // defaulting to "", so a second album for one artist needs a
            // distinct key.
            identityKey: `i_cap_${id}`,
            primaryType: "Album",
        },
    });
}

/** @returns the created track's id. */
async function seedTrack(
    id: string,
    albumId: string,
    trackNo: number,
    over: Record<string, unknown> = {},
) {
    await prisma.track.create({
        data: {
            id: `trk_cap_${id}`,
            albumId: `alb_cap_${albumId}`,
            title: `T ${id} #${trackNo}`,
            trackNo,
            duration: 180,
            filePath: `/tmp/cap_${id}_${trackNo}.flac`,
            fileModified: new Date(),
            fileSize: 1000,
            ...over,
        },
    });
    return `trk_cap_${id}`;
}

/**
 * Seed `seedTrackId` inside `seedAlbumId`, plus `scatteredAlbums` further
 * albums (2 tracks each) spread over `scatteredArtists` other artists.
 * All ids are prefixed with `cfg.prefix` so the fixtures of two tests in
 * this file cannot collide.
 */
async function seedCrowdedLibrary(cfg: {
    prefix: string;
    seedAlbumId: string;
    seedArtistId: string;
    seedAlbumTracks: number;
    /** Extra albums belonging to the SEED's artist (id, trackCount). */
    seedArtistExtraAlbums?: Array<{ id: string; tracks: number }>;
    scatteredAlbums: number;
    scatteredArtists: number;
    /** Feature profile for the seed's own group vs everything else. */
    seedFeatures: Record<string, unknown>;
    otherFeatures: Record<string, unknown>;
}) {
    await seedArtist(cfg.seedArtistId);
    for (let i = 0; i < cfg.scatteredArtists; i += 1) {
        await seedArtist(`${cfg.prefix}_other${i}`);
    }

    await seedAlbum(cfg.seedAlbumId, cfg.seedArtistId, `Seed album ${cfg.prefix}`);
    for (let i = 0; i < cfg.seedAlbumTracks; i += 1) {
        await seedTrack(`${cfg.prefix}_sa${i}`, cfg.seedAlbumId, i + 1, cfg.seedFeatures);
    }
    for (const extra of cfg.seedArtistExtraAlbums ?? []) {
        await seedAlbum(`${cfg.prefix}_${extra.id}`, cfg.seedArtistId, `Seed-artist album ${extra.id}`);
        for (let i = 0; i < extra.tracks; i += 1) {
            await seedTrack(
                `${cfg.prefix}_${extra.id}_${i}`,
                `${cfg.prefix}_${extra.id}`,
                i + 1,
                cfg.seedFeatures,
            );
        }
    }
    for (let a = 0; a < cfg.scatteredAlbums; a += 1) {
        const artist = `${cfg.prefix}_other${a % cfg.scatteredArtists}`;
        await seedAlbum(`${cfg.prefix}_scat${a}`, artist, `Scattered album ${a}`);
        for (let i = 0; i < 2; i += 1) {
            await seedTrack(
                `${cfg.prefix}_scat${a}_${i}`,
                `${cfg.prefix}_scat${a}`,
                i + 1,
                cfg.otherFeatures,
            );
        }
    }
}

function countsBy<T>(rows: T[], key: (row: T) => string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of rows) {
        const k = key(row);
        counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
}

/** Highest per-group count in `counts` (-Infinity when empty) — the crowding measure. */
function maxCount(counts: Map<string, number>): number {
    return Math.max(...Array.from(counts.values()));
}

beforeEach(async () => {
    // Each test asserts exact counts, so clear leftover rows first, children
    // included.
    await prisma.$executeRawUnsafe(
        `DELETE FROM "track_embeddings" WHERE "track_id" LIKE $1`,
        "trk\\_cap\\_%",
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, "trk\\_cap\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, "alb\\_cap\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `art\\_cap\\_%`);
});

afterAll(async () => {
    await prisma.$executeRawUnsafe(
        `DELETE FROM "track_embeddings" WHERE "track_id" LIKE $1`,
        "trk\\_cap\\_%",
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE $1`, "trk\\_cap\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE $1`, "alb\\_cap\\_%");
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE $1`, `art\\_cap\\_%`);
    await prisma.$disconnect();
});

describe("hybridSimilarity diversification (DB, shipped functions)", () => {
    // ------------------------------------------------------------------
    // Flooding: one big album + scattered tracks.
    // ------------------------------------------------------------------
    it("caps the seed's album at 2 (seed counted => at most 1 more) and still fills 20", async () => {
        setMode("hybrid");
        await seedCrowdedLibrary({
            prefix: "flood",
            seedArtistId: "floodArtist",
            seedAlbumId: "floodBig",
            seedAlbumTracks: 12,
            scatteredAlbums: 12,
            scatteredArtists: 12,
            seedFeatures: {},
            otherFeatures: {},
        });

        const seed = "trk_cap_flood_sa0";
        // Seed + its 11 album-mates are the closest things in the library.
        for (let i = 0; i < 12; i += 1) {
            await seedEmbedding(`trk_cap_flood_sa${i}`, unitVectorAt(1, 1));
        }
        // 24 scattered tracks, each on its own axis at cos 0.80 from the seed.
        for (let a = 0; a < 12; a += 1) {
            for (let i = 0; i < 2; i += 1) {
                await seedEmbedding(`trk_cap_flood_scat${a}_${i}`, unitVectorAt(0.8, 2 + a));
            }
        }

        await buildMatching();
        const rows = await findSimilarTracks(seed, 20);

        // Full requested length is still reachable: 2 (seed's album, capped)
        // + 24 scattered, so 20 is well inside what the library allows.
        expect(rows).toHaveLength(20);
        expect(rows.map((r) => r.id)).not.toContain(seed);

        // At most 2 per album for EVERY album in the list…
        const albumCounts = countsBy(rows, (r) => r.albumId);
        expect(maxCount(albumCounts)).toBeLessThanOrEqual(2);
        // …and at most 4 per artist, for every artist including the seed's.
        const artistCounts = countsBy(rows, (r) => r.artistId);
        expect(maxCount(artistCounts)).toBeLessThanOrEqual(4);

        // The album cap keeps 2 of the seed's album and the seed is one of
        // them, so exactly 1 other remains.
        expect(rows.filter((r) => r.albumId === "alb_cap_floodBig")).toHaveLength(1);
        expect(rows.filter((r) => r.artistId === "art_cap_floodArtist")).toHaveLength(1);

        // The list is not a stub: it reaches well past the seed's album.
        expect(new Set(rows.map((r) => r.albumId)).size).toBeGreaterThanOrEqual(11);
        expect(new Set(rows.map((r) => r.artistId)).size).toBeGreaterThanOrEqual(10);
    });

    // ------------------------------------------------------------------
    // Single-artist library: the artist cap is a hard ceiling, so the list
    // legitimately comes back short.
    // ------------------------------------------------------------------
    it("returns at most 4 rows for a one-artist library (seed counted => 3)", async () => {
        setMode("hybrid");
        await seedCrowdedLibrary({
            prefix: "solo",
            seedArtistId: "soloArtist",
            seedAlbumId: "soloBig",
            seedAlbumTracks: 10,
            seedArtistExtraAlbums: [{ id: "soloSecond", tracks: 6 }],
            scatteredAlbums: 0,
            scatteredArtists: 1,
            seedFeatures: {},
            otherFeatures: {},
        });
        for (let i = 0; i < 10; i += 1) {
            await seedEmbedding(`trk_cap_solo_sa${i}`, unitVectorAt(1, 1));
        }
        for (let i = 0; i < 6; i += 1) {
            await seedEmbedding(`trk_cap_solo_soloSecond_${i}`, unitVectorAt(0.95, 2));
        }

        await buildMatching();
        const rows = await findSimilarTracks("trk_cap_solo_sa0", 10);

        // 15 candidates exist, but only 4 may come from one artist — and
        // the seed already occupies one of those 4, so 3 is the ceiling.
        expect(rows).toHaveLength(3);
        expect(rows.filter((r) => r.albumId === "alb_cap_soloBig")).toHaveLength(1);
        expect(rows.filter((r) => r.albumId === "alb_cap_solo_soloSecond")).toHaveLength(2);
    });

    // The artist cap counts what survives the album cap.
    it("gives the seed's artist exactly 3 tracks across 4 of its albums (4 including the seed)", async () => {
        setMode("hybrid");
        await seedCrowdedLibrary({
            prefix: "exact",
            seedArtistId: "exactArtist",
            seedAlbumId: "exactNear",
            seedAlbumTracks: 10,
            seedArtistExtraAlbums: [
                { id: "exactFar1", tracks: 4 },
                { id: "exactFar2", tracks: 4 },
                { id: "exactFar3", tracks: 4 },
            ],
            scatteredAlbums: 12,
            scatteredArtists: 12,
            seedFeatures: {},
            otherFeatures: {},
        });
        // Seed's nearest album (10 tracks) plus three further albums by the
        // same artist: 12 seed-artist candidates, then scattered material.
        for (let i = 0; i < 10; i += 1) {
            await seedEmbedding(`trk_cap_exact_sa${i}`, unitVectorAt(0.99, 1));
        }
        for (const album of ["exactFar1", "exactFar2", "exactFar3"]) {
            for (let i = 0; i < 4; i += 1) {
                await seedEmbedding(`trk_cap_exact_${album}_${i}`, unitVectorAt(0.95, 2));
            }
        }
        for (let a = 0; a < 12; a += 1) {
            for (let i = 0; i < 2; i += 1) {
                await seedEmbedding(`trk_cap_exact_scat${a}_${i}`, unitVectorAt(0.8, 3 + a));
            }
        }

        await buildMatching();
        const rows = await findSimilarTracks("trk_cap_exact_sa0", 20);

        // Album-thinning alone would leave 2 (nearest album) + 2 + 2 + 2 = 8
        // seed-artist tracks; the artist cap cuts that to 3 (seed counted).
        expect(rows.filter((r) => r.artistId === "art_cap_exactArtist")).toHaveLength(3);
        expect(rows).toHaveLength(20);
        expect(maxCount(countsBy(rows, (r) => r.albumId))).toBeLessThanOrEqual(2);
        expect(maxCount(countsBy(rows, (r) => r.artistId))).toBeLessThanOrEqual(4);
    });

    // 50 = 1 from the seed album + 3 more from its artist + 46 scattered.
    it("fills a 50-track list from one 60-track album plus scattered albums", async () => {
        setMode("hybrid");
        await seedCrowdedLibrary({
            prefix: "fill",
            seedArtistId: "fillArtist",
            seedAlbumId: "fillBig",
            seedAlbumTracks: 60,
            seedArtistExtraAlbums: [{ id: "fillSecond", tracks: 6 }],
            scatteredAlbums: 24,
            scatteredArtists: 12,
            seedFeatures: {},
            otherFeatures: {},
        });
        for (let i = 0; i < 60; i += 1) {
            await seedEmbedding(`trk_cap_fill_sa${i}`, unitVectorAt(1, 1));
        }
        for (let i = 0; i < 6; i += 1) {
            await seedEmbedding(`trk_cap_fill_fillSecond_${i}`, unitVectorAt(0.95, 2));
        }
        for (let a = 0; a < 24; a += 1) {
            for (let i = 0; i < 2; i += 1) {
                await seedEmbedding(`trk_cap_fill_scat${a}_${i}`, unitVectorAt(0.8, 3 + (a % 12)));
            }
        }

        await buildMatching();
        const rows = await findSimilarTracks("trk_cap_fill_sa0", 50);

        expect(rows).toHaveLength(50);
        expect(rows.filter((r) => r.albumId === "alb_cap_fillBig")).toHaveLength(1);
        expect(rows.filter((r) => r.artistId === "art_cap_fillArtist")).toHaveLength(3);
        expect(maxCount(countsBy(rows, (r) => r.albumId))).toBeLessThanOrEqual(2);
        expect(maxCount(countsBy(rows, (r) => r.artistId))).toBeLessThanOrEqual(4);
    }, 60_000);

});