/**
 * Essentia writes C# where Kima's key tables spell Db. Migration 20261020120000 gives the Camelot table every sharp
 * spelling at its flat's place, so a C# track is no longer scored as C major in the features-only fallback; Key
 * Journey groups C# with Db instead of leaving it out.
 */
import { prisma } from "../../utils/db";
import { generateKeyJourney } from "../mixes/moodMixes";

const P = "ksp";

async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM "Track" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Album" WHERE id LIKE '${P}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "Artist" WHERE id LIKE '${P}%'`);
}

const sim = async (k1: string, s1: string, k2: string, s2: string) => {
    const rows = await prisma.$queryRawUnsafe<{ s: number }[]>(
        `SELECT key_similarity($1, $2, $3, $4)::float8 AS s`, k1, s1, k2, s2,
    );
    return Number(rows[0].s);
};

beforeAll(async () => {
    await cleanup();
    await prisma.artist.create({ data: { id: `${P}art`, name: "Key Artist", identityKey: `${P}-a` } });
    await prisma.album.create({ data: { id: `${P}alb`, artistId: `${P}art`, rgMbid: `${P}-rg`, title: "Keys", primaryType: "Album" } });
    const keys = ["C", "G", "D", "A", "E", "B", "F#", "C#", "Ab", "Eb", "Bb", "F"];
    let n = 0;
    for (const key of keys) {
        for (let i = 0; i < 2; i++) {
            n += 1;
            await prisma.track.create({
                data: {
                    id: `${P}${key.replace("#", "s")}${i}`, albumId: `${P}alb`, title: `${key} ${i}`, trackNo: n,
                    duration: 200, filePath: `/tmp/${P}${n}.flac`, fileModified: new Date(), fileSize: 1,
                    analysisStatus: "completed", key, keyScale: "major",
                },
            });
        }
    }
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("key_similarity reads sharp spellings", () => {
    it("scores C# major as Db major, not as the unknown-key default", async () => {
        expect(await sim("C#", "major", "Db", "major")).toBe(1);
        expect(await sim("C#", "major", "C", "major")).toBeLessThan(1);
    });

    it("places C# minor at 12A beside E major's 12B", async () => {
        expect(await sim("C#", "minor", "E", "major")).toBeCloseTo(0.92, 6);
    });

    it("keeps every sharp at its flat's place", async () => {
        for (const [sharp, flat, scale] of [
            ["G#", "Ab", "minor"], ["D#", "Eb", "minor"], ["A#", "Bb", "minor"], ["Gb", "F#", "major"],
            ["G#", "Ab", "major"], ["D#", "Eb", "major"], ["A#", "Bb", "major"], ["Gb", "F#", "minor"],
        ]) {
            expect(await sim(sharp, scale, flat, scale)).toBe(1);
        }
    });
});

describe("Key Journey", () => {
    it("includes C# tracks in the Db slot", async () => {
        const mix = await generateKeyJourney("u", "2026-10-20");
        expect(mix).not.toBeNull();
        expect(mix!.trackIds).toEqual(expect.arrayContaining([`${P}Cs0`, `${P}Cs1`]));
    });
});
