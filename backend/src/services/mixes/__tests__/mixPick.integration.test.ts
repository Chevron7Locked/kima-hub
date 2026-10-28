/**
 * Which decades and genres a day's decade or genre mix may pick: those whose artists can fill a mix at 2 songs each
 * (MIN_MIX_TRACKS), counted the way the per-artist cap counts them, where each song on a Various Artists album is its
 * own artist. A count of artists alone let one artist with many songs and three with one each through, and the draw
 * then fell back to no cap: a mix of one artist. Real database.
 */
import { prisma } from "../../../utils/db";
import { artistIdentityKey } from "../../artistIdentity";
import { VARIOUS_ARTISTS_CANONICAL } from "../../../utils/artistNormalization";
import { mixableDecades, mixableGenres } from "../genreMixes";

jest.setTimeout(120_000);

const P = "zz_mixpick_";
let variousId: string;
let createdVarious = false;

/** An album of `songs` songs by `artistId`, dated `year`, each song tagged with `genre`. */
async function album(key: string, artistId: string, year: number, songs: number, genre: string) {
    await prisma.album.create({
        data: { id: `${P}alb_${key}`, rgMbid: `${P}rg_${key}`, artistId, identityKey: `${P}ik_${key}`, title: `${P}${key}`, primaryType: "Album", displayYear: year },
    });
    for (let i = 0; i < songs; i++) {
        const id = `${P}trk_${key}_${i}`;
        await prisma.track.create({
            data: { id, albumId: `${P}alb_${key}`, title: `${key} ${i}`, trackNo: i + 1, duration: 200, filePath: `/tmp/${id}.flac`, fileModified: new Date(), fileSize: 1000 },
        });
        await prisma.trackGenre.create({ data: { trackId: id, genreId: genre } });
    }
}

async function cleanup() {
    await prisma.track.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.album.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.artist.deleteMany({ where: { id: { startsWith: P } } });
    await prisma.genre.deleteMany({ where: { id: { startsWith: P } } });
}

beforeAll(async () => {
    await cleanup();
    const key = artistIdentityKey(VARIOUS_ARTISTS_CANONICAL);
    const various = await prisma.artist.findUnique({ where: { identityKey: key } });
    variousId = various?.id ?? `${P}various`;
    if (!various) {
        await prisma.artist.create({ data: { id: variousId, name: VARIOUS_ARTISTS_CANONICAL, identityKey: key } });
        createdVarious = true;
    }
    for (const a of ["big", "one1", "one2", "one3"]) {
        await prisma.artist.create({ data: { id: `${P}${a}`, name: `${P}${a}`, identityKey: `${P}${a}` } });
    }
    // Many songs in each genre, so both rank among the 20 largest whatever else the database holds.
    for (const g of ["onebig", "various"]) await prisma.genre.create({ data: { id: `${P}${g}`, name: `${P}${g}` } });

    // The 1610s and its genre: 400 songs by one artist and 1 by each of three others; at 2 each, 5 songs.
    await album("big", `${P}big`, 1612, 400, `${P}onebig`);
    for (const a of ["one1", "one2", "one3"]) await album(a, `${P}${a}`, 1613, 1, `${P}onebig`);
    // The 1620s and its genre: one Various Artists compilation of 400 songs, each its own artist.
    await album("comp", variousId, 1625, 400, `${P}various`);
});

afterAll(async () => {
    await cleanup();
    if (createdVarious) await prisma.artist.deleteMany({ where: { id: variousId } });
    await prisma.$disconnect();
});

describe("the decades and genres a mix may pick", () => {
    it("leaves out a decade four artists share when one holds nearly every song", async () => {
        expect(await mixableDecades()).not.toContain(1610);
    });

    it("leaves out such a genre", async () => {
        expect((await mixableGenres()).map((g) => g.id)).not.toContain(`${P}onebig`);
    });

    it("offers a decade and a genre of compilations, whose songs each count as their own artist", async () => {
        expect(await mixableDecades()).toContain(1620);
        expect((await mixableGenres()).map((g) => g.id)).toContain(`${P}various`);
    });
});
