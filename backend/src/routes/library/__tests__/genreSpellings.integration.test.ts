/**
 * Genre stations treat spellings of one genre that differ only in case, spaces, hyphens, underscores, slashes, dots or
 * apostrophes as one genre (#235: "Hip Hop" and "Hip-Hop" were two stations). GET /genres lists one entry per genre,
 * named by the spelling most of its tracks carry; GET /radio?type=genre plays every spelling. Real Postgres, real
 * router over HTTP, nothing mocked.
 */
import express from "express";
import request from "supertest";
import { prisma } from "../../../utils/db";
import router from "../tracks";

jest.setTimeout(120_000);

const P = "gsp_";
const app = express();
app.use(express.json());
app.use("/", router);

/** Artist number, its one genre as tagged, how many library tracks it has. */
const ARTISTS: [number, string, number][] = [
    [1, "Hip Hop", 20],
    [2, "hip-hop", 12],
    [3, "HipHop", 3],
    [4, "alternative hip hop", 5],
    [5, "ロック", 16],
    [6, "ジャズ", 16],
    [7, "rock", 16],
    // Spellings copied from the web: a Unicode hyphen and a no-break space.
    [8, "hip\u2010hop", 2],
    [9, "hip\u00a0hop", 1],
    // An accent stored as its own mark (as macOS file names do), a soft hyphen and a minus sign.
    [11, "e\u0301lectro", 9],
    [12, "\u00e9lectro", 9],
    [13, "hip\u00adhop", 1],
    [14, "hip\u2212hop", 1],
    // An artist tagged with its own name, spelled another way ("Synth-Wave" tagged "synth wave").
    [10, "synth wave", 16],
];
/** Artists whose name is not "Spelling Artist <n>". */
const NAMES: Record<number, string> = { 10: "Synth-Wave" };
const trackIdsOf = (artist: number) =>
    Array.from({ length: ARTISTS.find(([a]) => a === artist)![2] }, (_, i) => `${P}trk_${artist}_${i}`);
const HIP_HOP = [1, 2, 3, 4, 8, 9, 13, 14].flatMap(trackIdsOf);

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    for (const [a, genre] of ARTISTS) {
        await prisma.artist.create({
            data: {
                id: `${P}art_${a}`,
                name: NAMES[a] ?? `Spelling Artist ${a}`,
                normalizedName: (NAMES[a] ?? `Spelling Artist ${a}`).toLowerCase(),
                identityKey: `${P}ak_${a}`,
                genres: [genre],
            },
        });
        await prisma.album.create({
            data: {
                id: `${P}alb_${a}`,
                rgMbid: `${P}rg_${a}`,
                artistId: `${P}art_${a}`,
                identityKey: `${P}ik_${a}`,
                title: `Spelling Album ${a}`,
                primaryType: "Album",
                location: "LIBRARY",
            },
        });
        await prisma.track.createMany({
            data: trackIdsOf(a).map((id, i) => ({
                id,
                albumId: `${P}alb_${a}`,
                title: `Spelling Track ${a}.${i}`,
                trackNo: i + 1,
                duration: 200,
                filePath: `/tmp/${id}.flac`,
                fileModified: new Date(),
                fileSize: 1000,
            })),
        });
    }
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe("GET /genres", () => {
    let genres: { genre: string; count: number }[];
    beforeAll(async () => {
        const res = await request(app).get("/genres");
        expect(res.status).toBe(200);
        genres = res.body.genres;
    });

    it("lists the spellings of one genre once, under the spelling most of its tracks carry, counting all of them", () => {
        expect(genres.filter((g) => ["hip hop", "hip-hop", "hiphop"].includes(g.genre))).toEqual([{ genre: "hip hop", count: 40 }]);
    });

    it("merges spellings with Unicode hyphens, invisible hyphens, no-break spaces and accents typed as marks", () => {
        expect(genres.filter((g) => g.genre.startsWith("hip"))).toEqual([{ genre: "hip hop", count: 40 }]);
        expect(genres.filter((g) => g.genre.normalize("NFC") === "\u00e9lectro")).toHaveLength(1);
        expect(genres.find((g) => g.genre.normalize("NFC") === "\u00e9lectro")?.count).toBe(18);
    });

    it("leaves out a genre that is an artist's name, however either is spelled", () => {
        expect(genres.find((g) => g.genre === "synth wave")).toBeUndefined();
    });

    it("keeps genres apart that are different words, in any script", () => {
        expect(genres.find((g) => g.genre === "ロック")?.count).toBe(16);
        expect(genres.find((g) => g.genre === "ジャズ")?.count).toBe(16);
        expect(genres.find((g) => g.genre === "rock")?.count).toBe(16);
    });

    it("still leaves out a genre with too few tracks", () => {
        expect(genres.find((g) => g.genre === "alternative hip hop")).toBeUndefined();
    });
});

describe("GET /radio?type=genre", () => {
    const own = async (value: string) => {
        const res = await request(app).get("/radio").query({ type: "genre", value, limit: 100 });
        expect(res.status).toBe(200);
        return new Set((res.body.tracks as { id: string }[]).map((t) => t.id).filter((id) => id.startsWith(P)));
    };

    it.each(["hip hop", "Hip-Hop", "hiphop", "HIP_HOP"])("%s plays every spelling, and genres that contain it", async (value) => {
        expect([...(await own(value))].sort()).toEqual([...HIP_HOP].sort());
    });

    it("reads % and \\ in the name as letters, not as patterns", async () => {
        expect((await own("h%p")).size).toBe(0);
        expect((await own("hip\\")).size).toBe(0);
        expect((await own("\\")).size).toBe(0);
        expect((await own("ロ%")).size).toBe(0);
    });

    it.each(["", "-", "...", " / "])("%p, a name with no letters, plays nothing", async (value) => {
        const res = await request(app).get("/radio").query({ type: "genre", value, limit: 100 });
        expect(res.status).toBe(200);
        expect(res.body.tracks).toEqual([]);
    });

    it("plays a genre in another script by its own name", async () => {
        expect([...(await own("ロック"))].sort()).toEqual(trackIdsOf(5).sort());
    });
});
